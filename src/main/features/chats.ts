/**
 * Conversations (per-user) — CRUD + message reads.
 *
 * Send paths live in `features/group_chat/` — every conversation is a group
 * chat now (commander + user + N agents). This module owns:
 *
 *   - The per-conversation `<cid>/meta.json` metadata
 *   - The `_index.json` registry of conversations (compat/list cache)
 *   - The on-disk `<cid>.jsonl` (group message log; format: GroupMessage)
 *   - Conversation-level CRUD (create / list / get / update / delete)
 *   - Cascade cleanup on delete (group dir + sessions + attachments)
 *
 * "Processing" state (a turn is currently running) lives in
 * `<cid>/state.json` (`status: 'idle' | 'running' | 'aborted'` +
 * `in_flight: actor_id[]`). Stale-state sweep on boot lives here too.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
  userChatsDir, userLocalConfigDir, userSessionsDir, WS_ROOT,
} from '../paths';
import { evictSession, deleteSessionFileForUser } from '../model/core-agent/session-store';
import {
  nowIso, genConversationId, safeId,
  readJson, writeJson, invalidateLineCount, readJsonl,
} from '../storage';
import { createLogger } from '../logger';
import { t } from '../i18n';
import {
  ZH_FILLER_RE, EN_FILLER_RE, CLAUSE_RE, TITLE_MAX,
} from '../util/auto-title';
import { isExpiredIsoTombstone, pruneExpiredDeletedRecords } from '../util/tombstone_retention';
import {
  RECORD_SYNC_DEVICE_FIELD,
  RECORD_SYNC_REV_FIELD,
  bumpRecordSyncVersion,
  recordSyncRev,
} from '../util/record_sync_fields';
import { limitNameDisplayText } from '../util/name-limit';

const log = createLogger('chats');
import * as search from './search';
import { purgeGroupDir, readState, readMembers, setStatus } from './group_chat/state';
import type { GroupMessage } from './group_chat/visibility';

function conversationIndexName(): string {
  return '_index.json';
}

function conversationMetaName(): string {
  return 'meta.json';
}

const RESERVED_CHAT_DIRS = new Set(['agent', 'skill', 'subagents']);

function isConversationMetaDirName(name: string): boolean {
  return safeId(name) && !RESERVED_CHAT_DIRS.has(name);
}

function buildConversationSessionId(cid: string): string {
  return `gconv-${cid}`;
}

export type ConversationKind = 'normal' | string;

export interface Conversation {
  conversation_id: string;
  title: string;
  kind: ConversationKind;
  /** Optional starting agent — UI can suggest "@<this agent>" on the input
   * draft. The bus does not bind to it; group membership is dynamic. */
  agent_id: string;
  skill_id: string;
  /** Commander session id (`<uid>-gconv-<cid>`). Stored for cleanup;
   * agents in the group have their own per-(conv,agent) session ids derived
   * via state.buildGmemberSessionId. */
  session_id: string;
  /** Optional project membership. Frozen at create time; not mutable after
   *  creation. Empty / absent → conversation lives outside any project (the
   *  default sidebar group). The project itself is just metadata —
   *  `<cid>.jsonl`, `groupChatDir`, `chat_attachments`, and `session_id`
   *  paths stay verbatim, so cid uniqueness + §5 isolation are unaffected. */
  project_id?: string;
  /** Set when this conversation was created by an auto-task fire (sidebar
   *  "Automation" tab). Used by the renderer to render the clock icon next
   *  to the title and to group the conv under its originating task in the
   *  auto-tab expand panel. Stable id; survives task deletion. */
  origin_auto_task_id?: string;
  /** Optional sidebar pin timestamp. Pinned conversations sort to the top of
   *  whichever sidebar list currently contains them (project or unprojected). */
  pinned_at?: string;
  /** Logical clock for pin/unpin state. Unlike `updated_at`, this does not
   *  affect last-activity ordering; it exists so sync/meta merges can tell a
   *  deliberate unpin from an old missing/duplicated `pinned_at` value. */
  pin_state_updated_at?: string;
  /** True after an explicit user rename. Auto-title must never overwrite a
   *  title once the user has named the task, even if they chose default-like
   *  text such as "New conversation". */
  title_manually_set?: boolean;
  /** Record-level sync tombstone. Deleted conversations stay in `_index.json`
   *  long enough to propagate across offline devices; user-facing readers
   *  filter them out. */
  deleted_at?: string;
  /** Record-level conflict clock for aggregate `_index.json` merges. */
  _sync_rev?: number;
  _sync_device_id?: string;
  created_at: string;
  updated_at: string;
  /** Derived from group_chat state.json at read time; never persisted on
   * the index. */
  processing?: boolean;
  processing_since?: string | null;
  /** Derived: max(<cid>.jsonl mtime, updated_at). Drives sidebar
   * last-activity ordering; never persisted. */
  last_active_at?: string;
  /** Derived from group_chat `members.json` at read time; never persisted
   *  on the index. Union of every agent actor that has joined this
   *  conversation, plus `agent_id` for freshly-created convs whose
   *  members file hasn't been seeded yet. Powers the sidebar row's
   *  stacked agent badges so unopened convs render the same icon set as
   *  opened ones (without the renderer fanning out N `/members` calls). */
  agent_ids?: string[];
  /** Derived: true iff `<cid>.jsonl` contains at least one message where
   *  `from === 'commander'`. `members.json` is not a reliable signal —
   *  `seedReservedActors` adds commander on conversation creation
   *  regardless of whether it ever spoke. This flag is the load-bearing
   *  bit the renderer uses to decide whether to slot the commander badge
   *  into the actor stack: an `@<agent>`-started conv where commander
   *  never replied shouldn't show a commander icon. */
  commander_in_chat?: boolean;
}

/** Persisted record on `<cid>.jsonl`. Aliased for legacy callers; the new
 *  canonical type is `GroupMessage` from `group_chat/visibility`. */
export type MessageRecord = GroupMessage;

// ── CRUD ─────────────────────────────────────────────────────────────────

function isDeletedConversation(c: Pick<Conversation, 'deleted_at'> | null | undefined): boolean {
  return typeof c?.deleted_at === 'string' && c.deleted_at.length > 0;
}

function tsMs(value: unknown): number {
  if (typeof value !== 'string' || !value) return 0;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : 0;
}

function ensureUserDir(userId: string): string {
  const d = userChatsDir(userId);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function conversationMetaFile(userId: string, cid: string): string {
  return path.join(ensureUserDir(userId), cid, conversationMetaName());
}

function _cleanConversation(c: Conversation): Conversation {
  const { processing, processing_since, last_active_at, agent_ids, commander_in_chat, ...rest } = c;
  return rest;
}

function _cleanConversationMeta(c: Conversation): Conversation {
  const out = _cleanConversation(c);
  delete out._sync_rev;
  delete out._sync_device_id;
  return out;
}

function _normaliseConversation(raw: any, fallbackCid = ''): Conversation | null {
  if (!raw || typeof raw !== 'object') return null;
  const cid = typeof raw.conversation_id === 'string' && safeId(raw.conversation_id)
    ? raw.conversation_id
    : (safeId(fallbackCid) ? fallbackCid : '');
  if (!cid) return null;
  const createdAt = typeof raw.created_at === 'string' && raw.created_at
    ? raw.created_at
    : (typeof raw.updated_at === 'string' && raw.updated_at ? raw.updated_at : nowIso());
  const updatedAt = typeof raw.updated_at === 'string' && raw.updated_at ? raw.updated_at : createdAt;
  const out: Conversation = {
    conversation_id: cid,
    title: normaliseConversationTitle(raw.title),
    kind: typeof raw.kind === 'string' && raw.kind ? raw.kind : 'normal',
    agent_id: typeof raw.agent_id === 'string' ? raw.agent_id : '',
    skill_id: typeof raw.skill_id === 'string' ? raw.skill_id : '',
    session_id: typeof raw.session_id === 'string' && raw.session_id ? raw.session_id : buildConversationSessionId(cid),
    created_at: createdAt,
    updated_at: updatedAt,
  };
  if (typeof raw.project_id === 'string' && raw.project_id) out.project_id = raw.project_id;
  if (typeof raw.origin_auto_task_id === 'string' && raw.origin_auto_task_id) out.origin_auto_task_id = raw.origin_auto_task_id;
  if (typeof raw.pinned_at === 'string' && raw.pinned_at) out.pinned_at = raw.pinned_at;
  if (typeof raw.pin_state_updated_at === 'string' && raw.pin_state_updated_at) out.pin_state_updated_at = raw.pin_state_updated_at;
  if (raw.title_manually_set === true) out.title_manually_set = true;
  if (typeof raw.deleted_at === 'string' && raw.deleted_at) out.deleted_at = raw.deleted_at;
  const syncRev = Number(raw[RECORD_SYNC_REV_FIELD]) || 0;
  if (Number.isFinite(syncRev) && syncRev > 0) out._sync_rev = Math.floor(syncRev);
  if (typeof raw[RECORD_SYNC_DEVICE_FIELD] === 'string' && raw[RECORD_SYNC_DEVICE_FIELD]) {
    out._sync_device_id = raw[RECORD_SYNC_DEVICE_FIELD];
  }
  return out;
}

function _lastActionMs(c: Conversation | null | undefined): number {
  if (!c) return 0;
  return Math.max(tsMs(c.deleted_at), tsMs(c.updated_at), tsMs(c.created_at));
}

function _recordDeviceFile(userId: string): string {
  return path.join(userLocalConfigDir(userId), 'record-sync-device.json');
}

function _recordDeviceId(userId: string): string {
  const file = _recordDeviceFile(userId);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const id = typeof raw?.device_id === 'string' ? raw.device_id : '';
    if (id) return id;
  } catch { /* create below */ }
  const id = randomUUID();
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, device_id: id }), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, file);
    try { fs.chmodSync(file, 0o600); } catch { /* best effort */ }
  } catch { /* a missing device id only weakens conflict detection */ }
  return id;
}

function _stampConversationSync(userId: string, c: Conversation): Conversation {
  return bumpRecordSyncVersion(c, _recordDeviceId(userId)) as Conversation;
}

const CLEARABLE_CONVERSATION_FIELDS = [
  'project_id',
  'origin_auto_task_id',
  'pinned_at',
  'pin_state_updated_at',
  'title_manually_set',
  'deleted_at',
] as const satisfies readonly (keyof Conversation)[];

function hasOwn(obj: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function _mergeWithWinningConversationFields(
  loser: Conversation,
  winner: Conversation,
  clearMissingWinnerFields = false,
): Conversation {
  const out = { ...loser, ...winner };
  if (clearMissingWinnerFields) {
    for (const field of CLEARABLE_CONVERSATION_FIELDS) {
      if (!hasOwn(winner, field)) delete (out as any)[field];
    }
  }
  return out;
}

function _mergeWithWinningMetaFields(indexRow: Conversation, metaRow: Conversation): Conversation {
  const out = { ...indexRow, ...metaRow };
  const metaPinClock = tsMs(metaRow.pin_state_updated_at);
  const indexPinClock = tsMs(indexRow.pin_state_updated_at);
  if (metaPinClock && metaPinClock >= indexPinClock && !hasOwn(metaRow, 'pinned_at')) {
    delete out.pinned_at;
  }
  return out;
}

function _mergeConversationRecord(indexRow: Conversation | undefined, metaRow: Conversation): Conversation {
  if (!indexRow) return metaRow;
  const indexMs = _lastActionMs(indexRow);
  const metaMs = _lastActionMs(metaRow);
  if (metaMs > indexMs) return _mergeWithWinningMetaFields(indexRow, metaRow);
  if (indexMs > metaMs) return _mergeWithWinningConversationFields(metaRow, indexRow, true);
  if (isDeletedConversation(indexRow) && !isDeletedConversation(metaRow)) {
    return _mergeWithWinningConversationFields(metaRow, indexRow, true);
  }
  // When sync pulls a newer `_index.json` before the matching per-cid
  // `meta.json`, timestamps can tie because pin/unpin intentionally does not
  // bump `updated_at`. In that case the sync-stamped index row is the better
  // authority; otherwise stale meta can resurrect an old `pinned_at`.
  if (recordSyncRev(indexRow) > 0) {
    return _mergeWithWinningConversationFields(metaRow, indexRow, true);
  }
  return _mergeWithWinningMetaFields(indexRow, metaRow);
}

async function _readIndexConversations(userId: string): Promise<Conversation[]> {
  const idx = path.join(ensureUserDir(userId), conversationIndexName());
  if (!fs.existsSync(idx)) return [];
  const data: any = await readJson(idx);
  const rawItems = Array.isArray(data) ? data : (data && Array.isArray(data.items) ? data.items : []);
  return rawItems
    .map((row: any) => _normaliseConversation(row))
    .filter((row: Conversation | null): row is Conversation => !!row);
}

async function _readConversationMetas(userId: string): Promise<Conversation[]> {
  const dir = ensureUserDir(userId);
  let entries: fs.Dirent[] = [];
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
  catch { return []; }
  const out: Conversation[] = [];
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isDirectory() || entry.name.startsWith('.') || !isConversationMetaDirName(entry.name)) return;
    const file = path.join(dir, entry.name, conversationMetaName());
    try {
      const raw = JSON.parse(await fsp.readFile(file, 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
      const hasMetaShape = typeof raw.conversation_id === 'string'
        || typeof raw.title === 'string'
        || typeof raw.created_at === 'string'
        || typeof raw.updated_at === 'string';
      if (!hasMetaShape) return;
      const row = _normaliseConversation(raw, entry.name);
      if (row) out.push(row);
    } catch { /* ignore malformed metadata */ }
  }));
  return out;
}

async function _readRawConversations(userId: string): Promise<Conversation[]> {
  const indexRows = await _readIndexConversations(userId);
  const out: Conversation[] = [...indexRows];
  const positions = new Map<string, number>();
  for (let i = 0; i < out.length; i++) positions.set(out[i].conversation_id, i);
  for (const metaRow of await _readConversationMetas(userId)) {
    const pos = positions.get(metaRow.conversation_id);
    if (pos === undefined) {
      positions.set(metaRow.conversation_id, out.length);
      out.push(metaRow);
    } else {
      out[pos] = _mergeConversationRecord(out[pos], metaRow);
    }
  }
  return out;
}

async function _writeJsonIfChanged(file: string, data: unknown): Promise<void> {
  const next = JSON.stringify(data, null, 2);
  try {
    const cur = await fsp.readFile(file, 'utf8');
    if (cur === next) return;
  } catch { /* missing or unreadable => write */ }
  await writeJson(file, data);
}

async function _saveConversationMetas(userId: string, items: Conversation[]): Promise<void> {
  await Promise.all(items.map(async (c) => {
    if (!safeId(c.conversation_id)) return;
    const file = conversationMetaFile(userId, c.conversation_id);
    if (isDeletedConversation(c)) {
      try { await fsp.unlink(file); } catch { /* missing is fine */ }
      return;
    }
    await _writeJsonIfChanged(file, _cleanConversationMeta(c));
  }));
}

async function _removeConversationMeta(userId: string, cid: string): Promise<void> {
  if (!safeId(cid)) return;
  try { await fsp.unlink(conversationMetaFile(userId, cid)); } catch { /* ignore */ }
}

function _notifyChatIndexDirty(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
    const sync = null as { markDirty?: (domain: string, relPath: string) => void };
    sync?.markDirty?.('chats', `cloud/chats/${conversationIndexName()}`);
  } catch { /* features/sync stripped */ }
}

function _messageText(raw: any): string {
  if (!raw || typeof raw !== 'object') return '';
  if (typeof raw.text === 'string') return raw.text;
  if (typeof raw.content === 'string') return raw.content;
  if (Array.isArray(raw.content)) {
    return raw.content
      .map((part: any) => (typeof part === 'string'
        ? part
        : (part && typeof part.text === 'string' ? part.text : '')))
      .filter(Boolean)
      .join(' ');
  }
  return '';
}

function _normaliseMessageTs(raw: any): string | null {
  const ts = typeof raw?.ts === 'string' ? raw.ts : (typeof raw?.created_at === 'string' ? raw.created_at : '');
  if (!ts) return null;
  const ms = new Date(ts).getTime();
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

async function _readConversationSeed(file: string): Promise<{ title: string; createdAt: string | null; updatedAt: string | null }> {
  let firstUserText = '';
  let createdMs = 0;
  let updatedMs = 0;
  try {
    const text = await fsp.readFile(file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let msg: any;
      try { msg = JSON.parse(trimmed); } catch { continue; }
      const iso = _normaliseMessageTs(msg);
      if (iso) {
        const ms = new Date(iso).getTime();
        if (!createdMs || ms < createdMs) createdMs = ms;
        if (ms > updatedMs) updatedMs = ms;
      }
      const from = typeof msg?.from === 'string' ? msg.from : (typeof msg?.role === 'string' ? msg.role : '');
      if (!firstUserText && from === 'user') {
        firstUserText = _messageText(msg).trim();
      }
    }
  } catch { /* fall back to stat/default title */ }
  return {
    title: firstUserText ? autoTitle(firstUserText) : t('chat.default_title'),
    createdAt: createdMs ? new Date(createdMs).toISOString() : null,
    updatedAt: updatedMs ? new Date(updatedMs).toISOString() : null,
  };
}

function _repairIndexTails(): Map<string, Promise<Conversation[]>> {
  const g = globalThis as typeof globalThis & { __orkasChatRepairIndexTails?: Map<string, Promise<Conversation[]>> };
  if (!g.__orkasChatRepairIndexTails) g.__orkasChatRepairIndexTails = new Map();
  return g.__orkasChatRepairIndexTails;
}

async function _repairConversationIndexFromDiskUnlocked(userId: string, items: Conversation[]): Promise<Conversation[]> {
  const dir = ensureUserDir(userId);
  let entries: fs.Dirent[] = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return items;
  }
  const existing = new Set(items.map((c) => c.conversation_id).filter(Boolean));
  const recovered: Conversation[] = [];
  let resurrected = 0;
  for (const c of items) {
    if (!isDeletedConversation(c) || !safeId(c.conversation_id)) continue;
    const file = path.join(dir, `${c.conversation_id}.jsonl`);
    let st: fs.Stats | null = null;
    try { st = await fsp.stat(file); } catch {
      await _removeConversationMeta(userId, c.conversation_id);
      continue;
    }
    if (!st.isFile()) {
      await _removeConversationMeta(userId, c.conversation_id);
      continue;
    }
    const deletedMs = tsMs(c.deleted_at);
    if (!deletedMs || st.mtimeMs <= deletedMs) {
      await _removeConversationMeta(userId, c.conversation_id);
      if (isExpiredIsoTombstone(c.deleted_at)) {
        try { await fsp.unlink(file); } catch { /* ignore */ }
        invalidateLineCount(file);
      }
      continue;
    }
    delete c.deleted_at;
    const restoredAt = new Date(Number.isFinite(st.mtimeMs) ? st.mtimeMs : Date.now()).toISOString();
    if (tsMs(c.updated_at) < tsMs(restoredAt)) c.updated_at = restoredAt;
    _stampConversationSync(userId, c);
    resurrected += 1;
  }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.jsonl') || e.name.startsWith('.')) continue;
    const cid = e.name.slice(0, -'.jsonl'.length);
    if (!safeId(cid) || existing.has(cid)) continue;
    const file = path.join(dir, e.name);
    let st: fs.Stats | null = null;
    try { st = await fsp.stat(file); } catch { continue; }
    if (!st.isFile()) continue;
    const seed = await _readConversationSeed(file);
    const fallbackTs = new Date(Number.isFinite(st.mtimeMs) ? st.mtimeMs : Date.now()).toISOString();
    const createdAt = seed.createdAt || fallbackTs;
    const updatedAt = seed.updatedAt || createdAt;
    recovered.push(_stampConversationSync(userId, {
      conversation_id: cid,
      title: seed.title,
      kind: 'normal',
      agent_id: '',
      skill_id: '',
      session_id: buildConversationSessionId(cid),
      created_at: createdAt,
      updated_at: updatedAt,
    }));
    existing.add(cid);
  }
  const compacted = pruneExpiredDeletedRecords(items) as Conversation[];
  const expiredTombstoneCount = items.length - compacted.length;
  items = compacted;
  if (!recovered.length && !resurrected && !expiredTombstoneCount) return items;
  const repaired = [...items, ...recovered];
  await saveConversations(userId, repaired);
  _notifyChatIndexDirty();
  try {
    createLogger('chats').info(
      `repaired conversation index user=${userId} recovered=${recovered.length} resurrected=${resurrected} pruned_tombstones=${expiredTombstoneCount}`,
    );
  } catch { /* early circular init */ }
  return repaired;
}

async function _repairConversationIndexFromDisk(userId: string): Promise<Conversation[]> {
  const tails = _repairIndexTails();
  const prev = tails.get(userId) || Promise.resolve([]);
  const next = prev.catch(() => []).then(async () => {
    const latest = await _readRawConversations(userId);
    return _repairConversationIndexFromDiskUnlocked(userId, latest);
  });
  tails.set(userId, next);
  try {
    return await next;
  } finally {
    if (tails.get(userId) === next) tails.delete(userId);
  }
}

export async function listConversations(userId: string): Promise<Conversation[]> {
  const items = (await _repairConversationIndexFromDisk(userId))
    .filter((c) => !isDeletedConversation(c));
  if (!items.length) return items;
  // Derive `processing` from each cid's state.json AND the bus's in-memory
  // quiescence. Two cases mean "renderer should keep watching":
  //   1. state.status === 'running' — the obvious one
  //   2. bus is mid-flush — e.g. user clicked abort while a tool was in
  //      flight; state.json flips to 'aborted' immediately but the worker's
  //      runTurn still has to unwind (await tool finish → outcome → enqueue
  //      the "(stopped)" + processItems message). On-disk status looks
  //      terminal but jsonl is still growing. If the renderer reloads in
  //      this window (Cmd+R right after stop) and we say processing=false,
  //      it stops polling and never picks up the late abort message — user
  //      sees only their own msg, "everything I watched stream is gone".
  // Parallelize the per-conversation enrichment. The previous serial
  // `for ... await readState` loop was already O(N) on small JSON reads;
  // adding two more per-conv reads (members.json + a quick scan of
  // <cid>.jsonl) on top of that would multiply the wall time. Promise.all
  // collapses everything into one tick per conv. The bus module is loaded
  // once outside the map so we don't re-enter the module cache N times.
  //
  // CJS require (not dynamic `import()`) so bus.ts resolves through the
  // same module cache as the static-import chain. Node's dynamic `import()`
  // is always ESM, which would load bus.ts as a SECOND module instance with
  // its own _cids Map — splitting the bus state into two and silently
  // losing every event that's emitted on the wrong half (see bus.ts comment
  // at planExecutor.bindBusHooks for why ESM-vs-CJS duplication corrupts
  // plan_executor's hooks).
  const bus = require('./group_chat/bus') as typeof import('./group_chat/bus');
  const chatsDir = userChatsDir(userId);
  // 15-minute fast-path for the `processing` derivation only: any conv
  // whose last_active_at is older than the renderer's `processingFresh`
  // window (`conversation.js`: 15 * 60 * 1000) CAN'T surface a
  // `processing: true` chip in the UI even if state.json still says
  // `running` (crashed prior session, stuck flag) — the renderer filters
  // it out. So we skip the `readState` IO for stale convs entirely.
  // The in-memory `bus.isQuiescent` Map lookup still applies to ALL
  // convs, including stale ones whose clock skewed past 15min.
  // Members + commander scan do NOT take the fast-path — they feed the
  // sidebar badge stack (`agent_ids`) and commander badge gate
  // (`commander_in_chat`), which must render correctly on old convs too.
  const STALE_MS = 15 * 60 * 1000;
  const now = Date.now();
  const out: Conversation[] = await Promise.all(items.map(async (c) => {
    let processing = false;
    let since: string | null = null;
    let agentIds: string[] = [];
    let commanderInChat = false;
    const updatedMs = c.updated_at ? new Date(c.updated_at).getTime() : 0;
    const createdMs = c.created_at ? new Date(c.created_at).getTime() : 0;
    const lastActiveMs = Math.max(updatedMs || 0, createdMs || 0);
    const busBusy = !bus.isQuiescent(userId, c.conversation_id);
    const stale = lastActiveMs > 0 && (now - lastActiveMs) > STALE_MS;
    const [stateRes, membersRes, commRes] = await Promise.allSettled([
      stale ? Promise.resolve(null) : readState(userId, c.conversation_id),
      readMembers(userId, c.conversation_id),
      // Substring scan of `<cid>.jsonl` for any `from:"commander"` line.
      // Cheaper than per-line JSON.parse and good enough — `commander` is
      // an actor id, never legitimately a free-form value of any other
      // field. False positives would require a user message containing
      // that exact quoted pattern (and even then the read returns true,
      // which is the conservative outcome: show commander when in doubt).
      (async () => {
        const file = path.join(chatsDir, `${c.conversation_id}.jsonl`);
        if (!fs.existsSync(file)) return false;
        try {
          const text = await fsp.readFile(file, 'utf8');
          return /"from"\s*:\s*"commander"/.test(text);
        } catch { return false; }
      })(),
    ]);
    if (stale) {
      // Stale: state.json was skipped, only bus quiescence drives processing.
      processing = busBusy;
    } else if (stateRes.status === 'fulfilled' && stateRes.value) {
      const s = stateRes.value;
      processing = s.status === 'running' || busBusy;
      since = processing ? s.last_active_at : null;
    }
    if (commRes.status === 'fulfilled') {
      commanderInChat = commRes.value;
    }
    if (membersRes.status === 'fulfilled') {
      const seen = new Set<string>();
      for (const a of membersRes.value.actors) {
        if (a && a.kind === 'agent' && a.id && !seen.has(a.id)) {
          seen.add(a.id);
          agentIds.push(a.id);
        }
      }
      // Union in the starting `agent_id` defensively — `members.json` is
      // populated by the bus once a turn runs, so a freshly-created conv
      // can have agent_id set before its members file lands.
      if (c.agent_id && !seen.has(c.agent_id)) {
        agentIds.push(c.agent_id);
      }
    } else if (c.agent_id) {
      agentIds = [c.agent_id];
    }
    // Last-activity = max(updated_at, created_at). `updated_at` is bumped
    // by `bumpConversationActivity` on every message append (group_chat/
    // bus.ts::appendMain), so it tracks the real per-conversation timeline
    // and survives sync. The _index.json array merge now prefers the
    // record-level `_sync_rev` written by local index mutations, falling
    // back to updated_at only for legacy rows. We deliberately do NOT
    // consult `<cid>.jsonl` mtime: sync rewrites mtime when pulling, and any
    // file-system tool
    // that touches the bytes (backup restore, IDE, tar, manual edit) would
    // falsify the sort.
    //
    // CAREFUL: `nowIso()` returns local-time ISO without `Z` suffix
    // ("2026-05-07T15:00:00") while ISO with `Z` is UTC. Compare on
    // numeric ms and emit a UTC ISO so the downstream sort can
    // string-compare safely across both shapes.
    const lastActiveAt = lastActiveMs ? new Date(lastActiveMs).toISOString() : (c.updated_at || c.created_at || '');
    return { ...c, processing, processing_since: since, last_active_at: lastActiveAt, agent_ids: agentIds, commander_in_chat: commanderInChat };
  }));
  out.sort((a, b) => {
    const ap = a.pinned_at || '';
    const bp = b.pinned_at || '';
    if (ap && !bp) return -1;
    if (!ap && bp) return 1;
    if (ap && bp) {
      const pinCmp = bp.localeCompare(ap);
      if (pinCmp) return pinCmp;
    }
    return (b.last_active_at || '').localeCompare(a.last_active_at || '');
  });
  return out;
}

export async function saveConversations(userId: string, items: Conversation[]): Promise<void> {
  const rawCleaned = items.map(_cleanConversation);
  const cleaned = pruneExpiredDeletedRecords(rawCleaned) as Conversation[];
  await writeJson(path.join(ensureUserDir(userId), conversationIndexName()), cleaned);
  await _saveConversationMetas(userId, rawCleaned);
  _notifyChatIndexDirty();
}

/** Stamp `updated_at` on the cid's index row to the timestamp of the message
 *  just written. Called by `group_chat/bus.ts::appendMain` after every
 *  `<cid>.jsonl` append. listConversations sorts by `updated_at` (rather than
 *  file mtime) so cross-device sync is well-behaved — manifest-merge of the
 *  index array is a union-by-id with `updated_at` tiebreak, so both devices
 *  converge on the actual last-activity time. No-op when the row doesn't
 *  exist (the conv may have been deleted between message-write and bump). */
export async function bumpConversationActivity(userId: string, cid: string, tsIso: string): Promise<void> {
  if (!cid || !tsIso) return;
  const items = await _readRawConversations(userId);
  let changed = false;
  for (const c of items) {
    if (c.conversation_id === cid) {
      if (c.updated_at !== tsIso) {
        c.updated_at = tsIso;
        _stampConversationSync(userId, c);
        changed = true;
      }
      break;
    }
  }
  if (changed) await saveConversations(userId, items);
}

export async function getConversation(userId: string, cid: string): Promise<Conversation | null> {
  if (!safeId(cid)) return null;
  const list = await listConversations(userId);
  return list.find((c) => c.conversation_id === cid) || null;
}

export interface CreateConversationOptions {
  kind?: ConversationKind;
  agentId?: string;
  skillId?: string;
  title?: string;
  /** Optional project membership. Caller (IPC layer) is responsible for
   *  validating the projectId exists for this user — chats.ts persists it
   *  verbatim. */
  projectId?: string;
  /** Optional explicit conversation id. Used when an external source already
   *  minted the id. Must be a `safeId`; if it collides with an existing conv,
   *  that conv is returned unchanged. Defaults to a fresh generated id. */
  conversationId?: string;
  /** Set by `features/auto_tasks.ts::_fireTask` so the conversation carries
   *  a back-link to the task that spawned it. Used by the renderer for the
   *  clock-icon prefix and the auto-tab expand-panel grouping. */
  originAutoTaskId?: string;
}

function normaliseConversationTitle(raw: unknown): string {
  let title = typeof raw === 'string' ? raw.trim() : '';
  title = limitNameDisplayText(title);
  return title || t('chat.default_title');
}

export async function createConversation(userId: string, {
  kind = 'normal', agentId = '', skillId = '', title = '', projectId = '', conversationId = '', originAutoTaskId = '',
}: CreateConversationOptions = {}): Promise<Conversation> {
  const items = await _readRawConversations(userId);
  if (conversationId && safeId(conversationId)) {
    const i = items.findIndex((c) => c.conversation_id === conversationId);
    if (i >= 0 && !isDeletedConversation(items[i])) return items[i];
    if (i >= 0) {
      const now = nowIso();
      const revived: Conversation = _stampConversationSync(userId, {
        ...items[i],
        title: title ? normaliseConversationTitle(title) : (items[i].title || t('chat.default_title')),
        kind,
        agent_id: agentId || items[i].agent_id || '',
        skill_id: skillId || items[i].skill_id || '',
        session_id: items[i].session_id || buildConversationSessionId(conversationId),
        ...(projectId ? { project_id: projectId } : {}),
        ...(originAutoTaskId ? { origin_auto_task_id: originAutoTaskId } : {}),
        updated_at: now,
      });
      delete revived.deleted_at;
      items[i] = revived;
      await saveConversations(userId, items);
      await fsp.writeFile(path.join(ensureUserDir(userId), `${conversationId}.jsonl`), '', { flag: 'a' });
      log.info(`revived user=${userId} cid=${conversationId} kind=${kind} agent=${agentId || '-'} skill=${skillId || '-'} project=${projectId || '-'}`);
      return revived;
    }
  }
  const cid = (conversationId && safeId(conversationId)) ? conversationId : genConversationId();
  const now = nowIso();
  const conv: Conversation = _stampConversationSync(userId, {
    conversation_id: cid,
    title: normaliseConversationTitle(title),
    kind,
    agent_id: agentId || '',
    skill_id: skillId || '',
    session_id: buildConversationSessionId(cid),
    ...(projectId ? { project_id: projectId } : {}),
    ...(originAutoTaskId ? { origin_auto_task_id: originAutoTaskId } : {}),
    created_at: now,
    updated_at: now,
  });
  items.unshift(conv);
  await saveConversations(userId, items);
  // Touch jsonl so subsequent reads don't 404.
  await fsp.writeFile(path.join(ensureUserDir(userId), `${cid}.jsonl`), '', { flag: 'a' });
  log.info(`created user=${userId} cid=${cid} kind=${kind} agent=${agentId || '-'} skill=${skillId || '-'} project=${projectId || '-'}`);
  return conv;
}

export async function updateConversation(
  userId: string, cid: string, updates: Partial<Conversation>,
): Promise<Conversation | null> {
  const items = await _readRawConversations(userId);
  const i = items.findIndex((c) => c.conversation_id === cid);
  if (i < 0) return null;
  if (isDeletedConversation(items[i])) return null;
  items[i] = _stampConversationSync(userId, { ...items[i], ...updates, updated_at: nowIso() });
  delete items[i].deleted_at;
  await saveConversations(userId, items);
  return items[i];
}

export async function renameConversation(
  userId: string, cid: string, title: unknown,
): Promise<Conversation | null> {
  if (!safeId(cid)) return null;
  return updateConversation(userId, cid, {
    title: normaliseConversationTitle(title),
    title_manually_set: true,
  });
}

export async function setConversationPinned(
  userId: string, cid: string, pinned: boolean,
): Promise<Conversation | null> {
  if (!safeId(cid)) return null;
  const items = await _readRawConversations(userId);
  const i = items.findIndex((c) => c.conversation_id === cid);
  if (i < 0) return null;
  if (isDeletedConversation(items[i])) return null;
  const pinStateUpdatedAt = nowIso();
  if (pinned) {
    if (!items[i].pinned_at) {
      items[i].pinned_at = pinStateUpdatedAt;
      items[i].pin_state_updated_at = pinStateUpdatedAt;
      _stampConversationSync(userId, items[i]);
    }
  } else {
    if (items[i].pinned_at) {
      delete items[i].pinned_at;
      items[i].pin_state_updated_at = pinStateUpdatedAt;
      _stampConversationSync(userId, items[i]);
    }
  }
  await saveConversations(userId, items);
  return getConversation(userId, cid);
}

/** Drop a session jsonl + its in-memory cache entry. Routes through
 *  resolveSessionPath so kind (cloud vs local) is respected. */
function purgeSession(userId: string, sessionId: string): void {
  if (!sessionId) return;
  try { evictSession(sessionId); } catch { /* not in cache */ }
  deleteSessionFileForUser(userId, sessionId);
}

async function _purgeDeletedConversationFiles(userId: string, cid: string, removed?: Conversation): Promise<void> {
  // Purge group dir (members.json / state.json / plan.md / visibility/) + bus state.
  // CJS require (same reason as listConversations above) — dynamic `import()`
  // would load bus.ts as a second ESM module and dropConv would clear the
  // wrong _cids.
  try {
    const bus = require('./group_chat/bus') as typeof import('./group_chat/bus');
    bus.dropConv(userId, cid);
    await purgeGroupDir(userId, cid);
  }
  catch (err) { log.warn(`group_chat dropConv failed user=${userId} cid=${cid}: ${(err as Error).message}`); }

  // Purge main jsonl.
  const msgFile = path.join(ensureUserDir(userId), `${cid}.jsonl`);
  try { await fsp.unlink(msgFile); } catch { /* ignore missing */ }
  invalidateLineCount(msgFile);
  search.dropChatConversation(userId, cid);

  // Purge commander session + every per-agent member session.
  purgeSession(userId, removed?.session_id || buildConversationSessionId(cid));
  // gmember sessions: glob the sessions dir for `<uid>-gmember-<cid>-*` —
  // we can't rely on readMembers() because `groupChat.dropConv` above has
  // already removed members.json (the historical cause of the 50+ orphan
  // gmember files we found on the dev box: readMembers returns {actors:[]}
  // → the for-loop never ran → every per-agent worker session leaked).
  // Scanning the actual filesystem is the truth source.
  const gmemberPrefix = `gmember-${cid}-`;
  try {
    const names = await fsp.readdir(userSessionsDir(userId));
    for (const n of names) {
      if (!n.startsWith(gmemberPrefix) || !n.endsWith('.jsonl')) continue;
      purgeSession(userId, n.slice(0, -'.jsonl'.length));
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn(`gmember sweep user=${userId} cid=${cid}: ${(err as Error).message}`);
    }
  }

  // Purge attachments + their extract caches.
  try {
    const att = require('./chat_attachments');
    if (typeof att?.purgeByCid === 'function') await att.purgeByCid(userId, cid);
  } catch (err) { log.warn(`purge attachments user=${userId} cid=${cid}: ${(err as Error).message}`); }

  // Purge interactive web-app artifacts (chat_artifacts/<cid>/).
  try {
    const art = require('./chat_artifacts');
    if (typeof art?.purgeByCid === 'function') await art.purgeByCid(userId, cid);
  } catch (err) { log.warn(`purge artifacts user=${userId} cid=${cid}: ${(err as Error).message}`); }

  // Drop CLI session bindings — the next time this cid is reused (or
  // a same-id collision, defensive), CLI agents start fresh. Their
  // own machine-local session files (~/.claude/...) are left alone;
  // claude self-GCs.
  try {
    const cliSessions = require('./local_agents/sessions');
    if (typeof cliSessions?.clearForConversation === 'function') {
      await cliSessions.clearForConversation(userId, cid);
    }
  } catch (err) { log.warn(`purge cli sessions user=${userId} cid=${cid}: ${(err as Error).message}`); }

  log.info(`deleted user=${userId} cid=${cid}`);
}

export async function deleteConversation(userId: string, cid: string): Promise<boolean> {
  const items = await _readRawConversations(userId);
  const i = items.findIndex((c) => c.conversation_id === cid);
  if (i < 0) return false;
  const removed = items[i];
  if (!isDeletedConversation(removed)) {
    const deletedAt = nowIso();
    items[i] = _stampConversationSync(userId, { ...removed, deleted_at: deletedAt, updated_at: deletedAt });
    await saveConversations(userId, items);
  } else {
    await _removeConversationMeta(userId, cid);
  }
  await _purgeDeletedConversationFiles(userId, cid, removed);
  return true;
}

/** Read raw group messages from `<cid>.jsonl`. UI uses this for initial
 *  history load; subsequent updates flow through group_chat.streamEvents. */
export async function getMessages(userId: string, cid: string, limit = 200): Promise<MessageRecord[]> {
  return readJsonl<MessageRecord>(path.join(ensureUserDir(userId), `${cid}.jsonl`), limit);
}

/** Drop every conversation belonging to `userId`. Loops `deleteConversation`
 *  so the full cascade (group dir / main jsonl / sessions / attachments / CLI
 *  / search index) runs per cid; one cid's failure doesn't abort the rest.
 *  Returns the number actually removed. Used by Settings → "Clear all
 *  conversations". */
export async function deleteAllConversations(userId: string): Promise<number> {
  const items = await listConversations(userId);
  if (!items.length) return 0;
  let deleted = 0;
  for (const c of items) {
    try {
      if (await deleteConversation(userId, c.conversation_id)) deleted++;
    } catch (err) {
      log.warn(`bulk-delete failed user=${userId} cid=${c.conversation_id}: ${(err as Error).message}`);
    }
  }
  log.info(`deleted-all user=${userId} count=${deleted}`);
  return deleted;
}

/** Drop every conversation tied to `agentId` across every user. Called when
 *  a custom agent is deleted. */
export async function deleteConversationsByAgent(agentId: string): Promise<number> {
  let total = 0;
  if (!fs.existsSync(WS_ROOT)) return 0;

  for (const entry of await fsp.readdir(WS_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const uid = entry.name;
    const chatsDir = userChatsDir(uid);
    if (!fs.existsSync(chatsDir)) continue;

    const items = await listConversations(uid);
    if (!items.length) continue;
    const removed = items.filter((c) => (c.agent_id || '') === agentId);
    if (!removed.length) continue;
    for (const c of removed) {
      await deleteConversation(uid, c.conversation_id);
    }
    log.info(`deleted ${removed.length} conversation(s) for user=${uid} agent=${agentId}`);
    total += removed.length;
  }
  return total;
}

// Filler-word prefixes commonly written before the actual ask. Ordered
// longest-first within each regex so JS regex alternation (left-biased)
// doesn't match a shorter prefix when a longer one is also valid. Single-
// character fillers (e.g. bare `请`) are intentionally NOT listed — too
// likely to clip real content like `请教...`.
// Heuristic auto-title regex/constants — see top-of-file import.

export function autoTitle(content: string): string {
  const raw = (content || '').trim().replace(/\s+/g, ' ');
  if (!raw) return t('chat.default_title');
  let text = raw;
  // Strip stacked fillers ("请帮我看下..." → "请帮我" first, then "看下");
  // cap iterations so a pathological self-similar prefix can't loop.
  for (let i = 0; i < 5; i++) {
    const before = text;
    text = text.replace(ZH_FILLER_RE, '').replace(EN_FILLER_RE, '');
    if (text === before) break;
  }
  text = text.trim();
  // Take the first clause IF it's long enough on its own — guards against
  // clipping "AI，怎么样" down to bare "AI" which loses all signal.
  const clauseIdx = text.search(CLAUSE_RE);
  if (clauseIdx >= 4) text = text.slice(0, clauseIdx);
  text = text.trim();
  // If stripping killed everything (input was pure filler), fall back to
  // the original trimmed input so the sidebar still shows what the user
  // actually typed.
  if (!text) text = raw;
  if (text.length > TITLE_MAX) text = text.slice(0, TITLE_MAX) + '…';
  return text || t('chat.default_title');
}

// ── Boot-time stale state sweep ──────────────────────────────────────────

/**
 * Any group whose state.json says `running` when the app starts was
 * interrupted by a crash or hard quit. Flip them to `idle` (not aborted —
 * abort is a deliberate user action; on restart we just want a clean
 * slate). The next user message kicks off a fresh worker.
 */
export async function sweepStaleProcessing(): Promise<{ swept: number }> {
  if (!fs.existsSync(WS_ROOT)) return { swept: 0 };
  let swept = 0;
  for (const entry of await fsp.readdir(WS_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const uid = entry.name;
    const chatsDir = userChatsDir(uid);
    if (!fs.existsSync(chatsDir)) continue;

    const items = await _readRawConversations(uid).catch(() => [] as Conversation[]);
    for (const c of items) {
      if (isDeletedConversation(c)) continue;
      const cid = c.conversation_id;
      if (!cid) continue;
      try {
        const s = await readState(uid, cid);
        if (s.status === 'running') {
          await setStatus(uid, cid, 'idle');
          swept += 1;
        }
      } catch { /* no state file = idle */ }
    }
  }
  if (swept) log.info(`cleared ${swept} stale running conversations`);
  return { swept };
}
