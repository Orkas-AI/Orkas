/**
 * Conversations (per-user) — CRUD + message reads.
 *
 * Send paths live in `features/group_chat/` — every conversation is a group
 * chat now (commander + user + N agents). This module owns:
 *
 *   - The per-conversation `<cid>/meta.json` recovery metadata
 *   - The `_index.json` registry (primary list snapshot for versioned rows)
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
import * as readline from 'node:readline';
import { randomUUID } from 'node:crypto';

import {
  userChatsDir, userLocalConfigDir, projectChatsDir, projectChatIndexFile, WS_ROOT,
} from '../paths';
import {
  conversationLayout,
  conversationMessageFile,
  conversationMessageReadFile,
  listProjectIds,
  projectSessionRoots,
} from '../util/project-layout';
import { evictSession, deleteSessionFileForUser } from '../model/core-agent/session-store';
import {
  nowIso, genConversationId, genId12, safeId,
  readJson, writeJson, invalidateLineCount, readJsonl, readJsonlPage, readJsonlWindow, appendJsonlAtomic,
} from '../storage';
import { createLogger } from '../logger';
import { t } from '../i18n';
import {
  ZH_FILLER_RE, EN_FILLER_RE, TITLE_MAX, findTitleClauseBoundary,
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
// A boot-time stale-state sweep may run twice: once before the first window
// and again as a deferred cross-user maintenance pass. Only a state whose
// activity predates this main-process module can belong to a previous crash.
// Without this cutoff, the deferred pass can wake several minutes later while
// a newly-started long VideoStudio turn is legitimately running and manufacture
// a false "reply interrupted" message in the middle of that live bubble.
const PROCESS_BOOT_CUTOFF_MS = Date.now();
import * as search from './search';
import {
  ensureRunningConversationRegistry,
  purgeGroupDir,
  readMembers,
  readRunningConversationRegistry,
  readState,
  setStatus,
  untrackRunningConversation,
} from './group_chat/state';
import type { ActorKind } from './group_chat/state';
import { appendVisible, type GroupMessage } from './group_chat/visibility';

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
  /** Denormalized sidebar participant summary. Current records persist this
   *  on the index/meta and update it with message activity; legacy records
   *  derive it once from members.json and are backfilled. */
  agent_ids?: string[];
  /** Denormalized true iff the main JSONL contains a commander message.
   *  `members.json` is not a reliable signal because commander is seeded
   *  before it speaks. */
  commander_in_chat?: boolean;
  /** Activity timestamp covered by the participant summary. A record from an
   *  older client can advance `updated_at` without updating the summary; the
   *  mismatch makes the reader fall back to members/history instead of
   *  trusting stale data. */
  participant_summary_updated_at?: string;
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

function conversationMetaFile(userId: string, cid: string, projectId?: string | null): string {
  if (!projectId) ensureUserDir(userId);
  return conversationLayout(userId, cid, projectId).metaFile;
}

function conversationIndexFile(userId: string, projectId?: string | null): string {
  if (projectId) return projectChatIndexFile(userId, projectId);
  return path.join(ensureUserDir(userId), conversationIndexName());
}

function conversationRoots(userId: string): Array<{ projectId: string | null; dir: string; indexFile: string }> {
  const roots: Array<{ projectId: string | null; dir: string; indexFile: string }> = [{
    projectId: null,
    dir: ensureUserDir(userId),
    indexFile: conversationIndexFile(userId),
  }];
  for (const pid of listProjectIds(userId)) {
    roots.push({
      projectId: pid,
      dir: projectChatsDir(userId, pid),
      indexFile: conversationIndexFile(userId, pid),
    });
  }
  return roots;
}

async function _runBounded<T>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
    while (true) {
      if (signal?.aborted) return;
      const index = next++;
      if (index >= items.length) return;
      await fn(items[index]);
    }
  });
  await Promise.all(workers);
}

function _cleanConversation(c: Conversation): Conversation {
  const { processing, processing_since, last_active_at, ...rest } = c;
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
  if (Array.isArray(raw.agent_ids)) out.agent_ids = _normaliseAgentIds(raw.agent_ids);
  if (typeof raw.commander_in_chat === 'boolean') out.commander_in_chat = raw.commander_in_chat;
  if (typeof raw.participant_summary_updated_at === 'string' && raw.participant_summary_updated_at) {
    out.participant_summary_updated_at = raw.participant_summary_updated_at;
  }
  const syncRev = Number(raw[RECORD_SYNC_REV_FIELD]) || 0;
  if (Number.isFinite(syncRev) && syncRev > 0) out._sync_rev = Math.floor(syncRev);
  if (typeof raw[RECORD_SYNC_DEVICE_FIELD] === 'string' && raw[RECORD_SYNC_DEVICE_FIELD]) {
    out._sync_device_id = raw[RECORD_SYNC_DEVICE_FIELD];
  }
  return out;
}

function _normaliseAgentIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of raw) {
    const id = typeof value === 'string' ? value : '';
    if (!safeId(id) || id === 'commander' || id === 'user' || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function _hasFreshParticipantSummary(c: Conversation): boolean {
  if (!Array.isArray(c.agent_ids) || typeof c.commander_in_chat !== 'boolean') return false;
  if (!c.participant_summary_updated_at || c.participant_summary_updated_at !== c.updated_at) return false;
  return !c.agent_id || c.agent_ids.includes(c.agent_id);
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

async function _readConversationIndexRoot(
  userId: string,
  projectId?: string | null,
): Promise<Conversation[]> {
  const indexFile = conversationIndexFile(userId, projectId);
  const data: any = await readJson(indexFile);
  const rawItems = Array.isArray(data)
    ? data : (data && Array.isArray(data.items) ? data.items : []);
  const rows: Conversation[] = [];
  for (const raw of rawItems) {
    const row = _normaliseConversation(raw);
    if (!row) continue;
    if (projectId && !row.project_id) row.project_id = projectId;
    rows.push(row);
  }
  return rows;
}

async function _readIndexConversations(userId: string): Promise<Conversation[]> {
  const cached = _conversationIndexCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return _cloneConversationList(cached.items);
  const existing = _conversationIndexInFlight.get(userId);
  if (existing) return _cloneConversationList(await existing);

  const generation = _conversationIndexGeneration.get(userId) || 0;
  const run = (async () => {
    const roots = conversationRoots(userId);
    const rowsByRoot: Conversation[][] = roots.map(() => []);
    await _runBounded(
      roots.map((root, index) => ({ root, index })),
      8,
      async ({ root, index }) => {
        rowsByRoot[index] = await _readConversationIndexRoot(userId, root.projectId);
      },
    );
    return rowsByRoot.flat();
  })();
  _conversationIndexInFlight.set(userId, run);
  try {
    const items = await run;
    if ((_conversationIndexGeneration.get(userId) || 0) === generation) {
      _conversationIndexCache.set(userId, {
        expiresAt: Date.now() + CONVERSATION_INDEX_CACHE_TTL_MS,
        items: _cloneConversationList(items),
      });
    }
    return _cloneConversationList(items);
  } finally {
    if (_conversationIndexInFlight.get(userId) === run) {
      _conversationIndexInFlight.delete(userId);
    }
  }
}

/** Compact project counts derived from the same parsed index snapshot the
 * Stage B conversation list consumes. Stage A can call this first without
 * causing every project `_index.json` to be reopened moments later. */
export async function getProjectConversationCounts(userId: string): Promise<Map<string, number>> {
  const liveByProject = new Map<string, Map<string, boolean>>();
  for (const row of await _readIndexConversations(userId)) {
    const pid = typeof row.project_id === 'string' && safeId(row.project_id)
      ? row.project_id : '';
    if (!pid) continue;
    let liveByCid = liveByProject.get(pid);
    if (!liveByCid) {
      liveByCid = new Map();
      liveByProject.set(pid, liveByCid);
    }
    liveByCid.set(row.conversation_id, !isDeletedConversation(row));
  }
  const counts = new Map<string, number>();
  for (const [pid, liveByCid] of liveByProject) {
    let count = 0;
    for (const live of liveByCid.values()) if (live) count += 1;
    counts.set(pid, count);
  }
  return counts;
}

/** Compact maintenance reader for session ownership. It opens only aggregate
 * conversation indexes and skips runtime/member/history enrichment. */
export async function listActiveConversationIds(userId: string): Promise<string[]> {
  const ids = new Set<string>();
  for (const row of await _readIndexConversations(userId)) {
    if (!isDeletedConversation(row) && safeId(row.conversation_id)) ids.add(row.conversation_id);
  }
  return Array.from(ids);
}

export interface ConversationDisplayRow {
  conversation_id: string;
  title: string;
  project_id: string;
}

/** Compact search/display catalog. Reuses the central parsed index snapshot
 * and deliberately excludes runtime, participants, history, and metadata. */
export async function listConversationDisplayRows(userId: string): Promise<ConversationDisplayRow[]> {
  const { items } = _mergeNormalizedConversationRows(await _readIndexConversations(userId));
  return items
    .filter((row) => !isDeletedConversation(row))
    .map((row) => ({
      conversation_id: row.conversation_id,
      title: row.title || '',
      project_id: typeof row.project_id === 'string' ? row.project_id : '',
    }));
}

async function _readConversationMetas(
  userId: string,
  authoritativeIndexCids: ReadonlySet<string>,
  signal?: AbortSignal,
): Promise<Conversation[]> {
  const out: Conversation[] = [];
  await Promise.all(conversationRoots(userId).map(async (root) => {
    if (signal?.aborted) return;
    let entries: fs.Dirent[] = [];
    try { entries = await fsp.readdir(root.dir, { withFileTypes: true }); }
    catch { return; }
    await _runBounded(entries, 32, async (entry) => {
      if (!entry.isDirectory() || entry.name.startsWith('.') || !isConversationMetaDirName(entry.name)) return;
      // Current writers persist the complete record to the aggregate index
      // and stamp it with a record-level sync revision. Its duplicate
      // meta.json is a recovery copy, not a routine list dependency. Legacy
      // rows (no revision) and cids absent from the index still take the
      // compatibility path below.
      if (authoritativeIndexCids.has(entry.name)) return;
      const file = path.join(root.dir, entry.name, conversationMetaName());
      try {
        const raw = JSON.parse(await fsp.readFile(file, 'utf8'));
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
        const hasMetaShape = typeof raw.conversation_id === 'string'
          || typeof raw.title === 'string'
          || typeof raw.created_at === 'string'
          || typeof raw.updated_at === 'string';
        if (!hasMetaShape) return;
        const row = _normaliseConversation(raw, entry.name);
        if (row) {
          if (root.projectId && !row.project_id) row.project_id = root.projectId;
          out.push(row);
        }
      } catch { /* ignore malformed metadata */ }
    }, signal);
  }));
  return out;
}

/** Read recovery metadata only for revisionless rows already present in an
 * aggregate index. This preserves legacy timestamp merging without listing
 * every conversation directory on the routine startup path. Discovery of
 * metadata that is missing from all indexes remains an explicit repair job. */
async function _readKnownConversationMetas(
  userId: string,
  indexRows: readonly Conversation[],
): Promise<Conversation[]> {
  const out: Conversation[] = [];
  const legacyRows = indexRows.filter((row) => recordSyncRev(row) <= 0 && safeId(row.conversation_id));
  await _runBounded(legacyRows, 32, async (row) => {
    const root = row.project_id ? projectChatsDir(userId, row.project_id) : userChatsDir(userId);
    const file = path.join(root, row.conversation_id, conversationMetaName());
    try {
      const raw = JSON.parse(await fsp.readFile(file, 'utf8'));
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
      const metaRow = _normaliseConversation(raw, row.conversation_id);
      if (!metaRow) return;
      if (row.project_id && !metaRow.project_id) metaRow.project_id = row.project_id;
      out.push(metaRow);
    } catch { /* missing/malformed recovery copy is non-authoritative */ }
  });
  return out;
}

interface ReadRawConversationOptions {
  /** Enumerate conversation directories to discover recovery rows absent
   * from aggregate indexes. Expensive; routine startup deliberately opts out. */
  discoverUnindexedMetas?: boolean;
  signal?: AbortSignal;
}

async function _mergeConversationIndexRows(
  userId: string,
  indexRows: Conversation[],
  discoverUnindexedMetas: boolean,
  signal?: AbortSignal,
): Promise<Conversation[]> {
  const { items: out, positions } = _mergeNormalizedConversationRows(indexRows);
  const authoritativeIndexCids = new Set(
    out.filter((row) => recordSyncRev(row) > 0).map((row) => row.conversation_id),
  );
  const metaRows = discoverUnindexedMetas
    ? await _readConversationMetas(userId, authoritativeIndexCids, signal)
    : await _readKnownConversationMetas(userId, out);
  for (const metaRow of metaRows) {
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

/** Merge duplicate normalized index rows without opening recovery metadata. */
function _mergeNormalizedConversationRows(
  indexRows: readonly Conversation[],
): { items: Conversation[]; positions: Map<string, number> } {
  const out: Conversation[] = [];
  const positions = new Map<string, number>();
  for (const row of indexRows) {
    const pos = positions.get(row.conversation_id);
    if (pos === undefined) {
      positions.set(row.conversation_id, out.length);
      out.push(row);
    } else {
      out[pos] = _mergeConversationRecord(out[pos], row);
    }
  }
  return { items: out, positions };
}

async function _readRawConversations(
  userId: string,
  { discoverUnindexedMetas = true, signal }: ReadRawConversationOptions = {},
): Promise<Conversation[]> {
  const indexRows = await _readIndexConversations(userId);
  return _mergeConversationIndexRows(userId, indexRows, discoverUnindexedMetas, signal);
}

/** Read one physical conversation root. A warm startup snapshot can satisfy
 * this without disk I/O; once it expires, project/old-bucket interactions open
 * only their owning compact index instead of reconstructing every root. */
async function _readScopedRawConversations(
  userId: string,
  projectId?: string | null,
): Promise<Conversation[]> {
  const cached = _conversationIndexCache.get(userId);
  const rows = cached && cached.expiresAt > Date.now()
    ? _cloneConversationList(cached.items).filter((row) => (
        projectId ? row.project_id === projectId : !row.project_id
      ))
    : await _readConversationIndexRoot(userId, projectId);
  return _mergeConversationIndexRows(userId, rows, false);
}

/** Resolve one conversation from its physical index root. `projectIdHint` is
 * supplied by the renderer's already-loaded sidebar row: string = project
 * root, null = global root, undefined = no trustworthy hint. Main validates
 * the hint by finding the cid in that root; stale hints fall back to the
 * shared all-root index snapshot so project moves and sync races stay correct.
 * Only the selected row is passed into legacy-meta and runtime enrichment. */
async function _readTargetRawConversation(
  userId: string,
  cid: string,
  projectIdHint?: string | null,
): Promise<Conversation[]> {
  const cached = _conversationIndexCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    const matches = _cloneConversationList(cached.items)
      .filter((row) => row.conversation_id === cid);
    if (projectIdHint === null || (typeof projectIdHint === 'string' && safeId(projectIdHint))) {
      const hintedMatches = matches.filter((row) => (
        projectIdHint === null ? !row.project_id : row.project_id === projectIdHint
      ));
      if (hintedMatches.length) {
        return _mergeConversationIndexRows(userId, hintedMatches, false);
      }
    }
    return _mergeConversationIndexRows(userId, matches, false);
  }

  if (projectIdHint === null || (typeof projectIdHint === 'string' && safeId(projectIdHint))) {
    const hintedRows = (await _readConversationIndexRoot(userId, projectIdHint))
      .filter((row) => row.conversation_id === cid);
    if (hintedRows.length) {
      return _mergeConversationIndexRows(userId, hintedRows, false);
    }
  }

  const matches = (await _readIndexConversations(userId))
    .filter((row) => row.conversation_id === cid);
  return _mergeConversationIndexRows(userId, matches, false);
}

async function _writeJsonIfChanged(file: string, data: unknown): Promise<void> {
  const next = JSON.stringify(data, null, 2);
  try {
    const cur = await fsp.readFile(file, 'utf8');
    if (cur === next) return;
  } catch { /* missing or unreadable => write */ }
  await writeJson(file, data);
}

async function _saveConversationMetas(
  userId: string,
  items: Conversation[],
  changedCids?: ReadonlySet<string>,
): Promise<void> {
  const selected = changedCids
    ? items.filter((c) => changedCids.has(c.conversation_id))
    : items;
  await _runBounded(selected, 32, async (c) => {
    if (!safeId(c.conversation_id)) return;
    const file = conversationMetaFile(userId, c.conversation_id, c.project_id);
    if (isDeletedConversation(c)) {
      try { await fsp.unlink(file); } catch { /* missing is fine */ }
      return;
    }
    await _writeJsonIfChanged(file, _cleanConversationMeta(c));
  });
}

async function _removeConversationMeta(userId: string, cid: string): Promise<void> {
  if (!safeId(cid)) return;
  for (const root of conversationRoots(userId)) {
    try { await fsp.unlink(path.join(root.dir, cid, conversationMetaName())); } catch { /* ignore */ }
  }
}

function _notifyChatIndexDirty(projectId?: string | null): void {
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

const REPAIR_SEED_MAX_LINES = 200;

async function _readConversationSeed(
  file: string,
  signal?: AbortSignal,
): Promise<{ title: string; createdAt: string | null; updatedAt: string | null } | null> {
  let firstUserText = '';
  let createdMs = 0;
  let stream: fs.ReadStream | null = null;
  let lines: readline.Interface | null = null;
  try {
    stream = fs.createReadStream(file, { encoding: 'utf8', signal });
    lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let inspected = 0;
    for await (const line of lines) {
      if (signal?.aborted) return null;
      inspected += 1;
      const trimmed = line.trim();
      if (!trimmed) continue;
      let msg: any;
      try { msg = JSON.parse(trimmed); } catch { continue; }
      const iso = _normaliseMessageTs(msg);
      if (iso) {
        const ms = new Date(iso).getTime();
        if (!createdMs || ms < createdMs) createdMs = ms;
      }
      const from = typeof msg?.from === 'string' ? msg.from : (typeof msg?.role === 'string' ? msg.role : '');
      if (!firstUserText && from === 'user') {
        firstUserText = _messageText(msg).trim();
      }
      if (firstUserText || inspected >= REPAIR_SEED_MAX_LINES) break;
    }
  } catch (err) {
    if (signal?.aborted || (err as NodeJS.ErrnoException).name === 'AbortError') return null;
    // Fall back to stat/default title for unreadable recovery candidates.
  } finally {
    lines?.close();
    stream?.destroy();
  }
  return {
    title: firstUserText ? autoTitle(firstUserText) : t('chat.default_title'),
    createdAt: createdMs ? new Date(createdMs).toISOString() : null,
    // File mtime is the bounded recovery source for latest activity; scanning
    // an entire multi-year JSONL only to rediscover its tail is not justified.
    updatedAt: null,
  };
}

interface ConversationRepairRun {
  items: Conversation[];
  cancelled: boolean;
}

function _repairIndexTails(): Map<string, Promise<ConversationRepairRun>> {
  const g = globalThis as typeof globalThis & { __orkasChatRepairIndexTails?: Map<string, Promise<ConversationRepairRun>> };
  if (!g.__orkasChatRepairIndexTails) g.__orkasChatRepairIndexTails = new Map();
  return g.__orkasChatRepairIndexTails;
}

function _conversationWriteTails(): Map<string, Promise<void>> {
  const g = globalThis as typeof globalThis & { __orkasChatWriteTails?: Map<string, Promise<void>> };
  if (!g.__orkasChatWriteTails) g.__orkasChatWriteTails = new Map();
  return g.__orkasChatWriteTails;
}

async function _withConversationWrite<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const tails = _conversationWriteTails();
  const previous = tails.get(userId) || Promise.resolve();
  const result = previous.catch(() => undefined).then(fn);
  const tail = result.then(() => undefined, () => undefined);
  tails.set(userId, tail);
  try {
    return await result;
  } finally {
    if (tails.get(userId) === tail) tails.delete(userId);
  }
}

async function _repairConversationIndexFromDiskUnlocked(
  userId: string,
  items: Conversation[],
  discoveredMetaRows = 0,
  signal?: AbortSignal,
): Promise<ConversationRepairRun> {
  if (signal?.aborted) return { items, cancelled: true };
  const existing = new Set(items.map((c) => c.conversation_id).filter(Boolean));
  const recovered: Conversation[] = [];
  let resurrected = 0;
  for (let index = 0; index < items.length; index++) {
    if (index > 0 && index % 100 === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const c = items[index];
    if (!isDeletedConversation(c) || !safeId(c.conversation_id)) continue;
    const file = conversationMessageReadFile(userId, c.conversation_id, c.project_id ?? null);
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
  const compacted = pruneExpiredDeletedRecords(items) as Conversation[];
  const expiredTombstoneCount = items.length - compacted.length;
  items = compacted;

  const finish = async (cancelled: boolean, includeRecovered: boolean): Promise<ConversationRepairRun> => {
    const acceptedRecovered = includeRecovered ? recovered : [];
    if (!acceptedRecovered.length && !resurrected && !expiredTombstoneCount && !discoveredMetaRows) {
      return { items, cancelled };
    }
    const repaired = [...items, ...acceptedRecovered];
    // Once a repair commit begins it runs to completion. Stopping between
    // physical root writes could leave project/global indexes inconsistent.
    await saveConversations(userId, repaired);
    _notifyChatIndexDirty();
    try {
      createLogger('chats').info(
        `repaired conversation index user=${userId} recovered=${acceptedRecovered.length} recovered_meta=${discoveredMetaRows} resurrected=${resurrected} pruned_tombstones=${expiredTombstoneCount} cancelled=${cancelled}`,
      );
    } catch { /* early circular init */ }
    return { items: repaired, cancelled };
  };

  if (signal?.aborted) return finish(true, false);
  for (const root of conversationRoots(userId)) {
    if (signal?.aborted) return finish(true, false);
    let entries: fs.Dirent[] = [];
    try {
      entries = await fsp.readdir(root.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (let index = 0; index < entries.length; index++) {
      if (index > 0 && index % 100 === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (signal?.aborted) return finish(true, false);
      }
      const e = entries[index];
      if (!e.isFile() || !e.name.endsWith('.jsonl') || e.name.startsWith('.')) continue;
      const cid = e.name.slice(0, -'.jsonl'.length);
      if (!safeId(cid) || existing.has(cid)) continue;
      const file = path.join(root.dir, e.name);
      let st: fs.Stats | null = null;
      try { st = await fsp.stat(file); } catch { continue; }
      if (!st.isFile()) continue;
      const seed = await _readConversationSeed(file, signal);
      if (!seed && signal?.aborted) return finish(true, false);
      const fallbackTs = new Date(Number.isFinite(st.mtimeMs) ? st.mtimeMs : Date.now()).toISOString();
      const createdAt = seed?.createdAt || fallbackTs;
      const updatedAt = seed?.updatedAt || fallbackTs;
      recovered.push(_stampConversationSync(userId, {
        conversation_id: cid,
        title: seed?.title || t('chat.default_title'),
        kind: 'normal',
        agent_id: '',
        skill_id: '',
        session_id: buildConversationSessionId(cid),
        ...(root.projectId ? { project_id: root.projectId } : {}),
        created_at: createdAt,
        updated_at: updatedAt,
      }));
      existing.add(cid);
    }
  }
  return finish(false, true);
}

async function _repairConversationIndexFromDisk(
  userId: string,
  signal?: AbortSignal,
): Promise<ConversationRepairRun> {
  const tails = _repairIndexTails();
  const prev = tails.get(userId) || Promise.resolve({ items: [], cancelled: false });
  const next = prev.catch(() => ({ items: [], cancelled: false })).then(async () => {
    const indexed = await _readIndexConversations(userId);
    if (signal?.aborted) return { items: indexed, cancelled: true };
    const indexedCids = new Set(indexed.map((row) => row.conversation_id));
    const latest = await _readRawConversations(userId, { signal });
    if (signal?.aborted) return { items: indexed, cancelled: true };
    const discoveredMetaRows = latest.reduce(
      (count, row) => count + (indexedCids.has(row.conversation_id) ? 0 : 1),
      0,
    );
    return _repairConversationIndexFromDiskUnlocked(userId, latest, discoveredMetaRows, signal);
  });
  tails.set(userId, next);
  try {
    return await next;
  } finally {
    if (tails.get(userId) === next) tails.delete(userId);
  }
}

/** Full recovery hook for maintenance / explicit repair. Unlike the routine
 * sidebar list, this enumerates metadata directories and JSONLs so files
 * dropped in out-of-band are promoted back into aggregate indexes. */
export async function repairConversationIndex(
  userId: string,
  signal?: AbortSignal,
): Promise<{ conversations: number; cancelled?: boolean }> {
  const run = await _repairConversationIndexFromDisk(userId, signal);
  _invalidateConversationListCache(userId);
  return {
    conversations: run.items.filter((c) => !isDeletedConversation(c)).length,
    ...(run.cancelled ? { cancelled: true } : {}),
  };
}

// Covers the complete renderer Stage A → Stage B handoff even on a slow disk.
// Normal writes and sync pulls invalidate eagerly, so this is not a freshness
// delay for supported mutation paths.
const CONVERSATION_INDEX_CACHE_TTL_MS = 10_000;
const _conversationIndexCache = new Map<string, { expiresAt: number; items: Conversation[] }>();
const _conversationIndexInFlight = new Map<string, Promise<Conversation[]>>();
const _conversationIndexGeneration = new Map<string, number>();

function _invalidateConversationIndexCache(userId: string): void {
  _conversationIndexCache.delete(userId);
  _conversationIndexInFlight.delete(userId);
  _conversationIndexGeneration.set(userId, (_conversationIndexGeneration.get(userId) || 0) + 1);
  search.invalidateChatDisplayCatalog(userId);
}

const CONVERSATION_LIST_CACHE_TTL_MS = 2_000;
const _conversationListCache = new Map<string, { expiresAt: number; items: Conversation[] }>();
const _conversationListInFlight = new Map<string, Promise<Conversation[]>>();
const _conversationListGeneration = new Map<string, number>();

function _cloneConversationList(items: Conversation[]): Conversation[] {
  return items.map((c) => ({ ...c, ...(c.agent_ids ? { agent_ids: [...c.agent_ids] } : {}) }));
}

function _invalidateConversationListCache(userId: string): void {
  _invalidateConversationIndexCache(userId);
  _conversationListCache.delete(userId);
  _conversationListInFlight.delete(userId);
  _conversationListGeneration.set(userId, (_conversationListGeneration.get(userId) || 0) + 1);
}

/** Sync pulls bypass normal conversation writers, so their data-changed hook
 * uses this public invalidation before the renderer asks for fresh rows. */
export function invalidateConversationCaches(userId: string): void {
  _invalidateConversationListCache(userId);
}

async function _listConversationsUncached(
  userId: string,
  shouldPersistBackfill: () => boolean,
  selectItems?: (items: Conversation[]) => Conversation[],
  readRawItems: () => Promise<Conversation[]> = () => (
    _readRawConversations(userId, { discoverUnindexedMetas: false })
  ),
): Promise<Conversation[]> {
  // First paint trusts aggregate indexes and directly opens recovery metadata
  // only for revisionless legacy rows. Directory/JSONL discovery is deferred
  // to `repairConversationIndex` outside the startup interaction window.
  const rawItems = (await readRawItems())
    .filter((c) => !isDeletedConversation(c));
  const items = selectItems ? selectItems(rawItems) : rawItems;
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
  // Parallelize the remaining per-conversation enrichment. Current records
  // carry a participant summary, so they need at most the recent state read;
  // legacy records additionally read members.json + <cid>.jsonl once and
  // backfill the summary. The bus module is loaded once outside the map so
  // we don't re-enter the module cache N times.
  //
  // CJS require (not dynamic `import()`) so bus.ts resolves through the
  // same module cache as the static-import chain. Node's dynamic `import()`
  // is always ESM, which would load bus.ts as a SECOND module instance with
  // its own _cids Map — splitting the bus state into two and silently
  // losing every event that's emitted on the wrong half (see bus.ts comment
  // at planExecutor.bindBusHooks for why ESM-vs-CJS duplication corrupts
  // plan_executor's hooks).
  const bus = require('./group_chat/bus') as typeof import('./group_chat/bus');
  // 15-minute fast-path for the `processing` derivation only: any conv
  // whose last_active_at is older than the renderer's `processingFresh`
  // window (`conversation.js`: 15 * 60 * 1000) CAN'T surface a
  // `processing: true` chip in the UI even if state.json still says
  // `running` (crashed prior session, stuck flag) — the renderer filters
  // it out. So we skip the `readState` IO for stale convs entirely.
  // The in-memory `bus.isQuiescent` Map lookup still applies to ALL
  // convs, including stale ones whose clock skewed past 15min.
  // A fresh participant summary removes members/history IO for all age
  // buckets. Legacy rows still take the compatibility scan once so their
  // sidebar badges remain correct before the summary is persisted.
  const STALE_MS = 15 * 60 * 1000;
  const now = Date.now();
  const summariesToBackfill: Conversation[] = [];
  const out: Conversation[] = await Promise.all(items.map(async (c) => {
    let processing = false;
    let since: string | null = null;
    const summaryFresh = _hasFreshParticipantSummary(c);
    let agentIds: string[] = summaryFresh ? _normaliseAgentIds(c.agent_ids) : [];
    let commanderInChat = summaryFresh ? c.commander_in_chat === true : false;
    const updatedMs = c.updated_at ? new Date(c.updated_at).getTime() : 0;
    const createdMs = c.created_at ? new Date(c.created_at).getTime() : 0;
    const lastActiveMs = Math.max(updatedMs || 0, createdMs || 0);
    const busBusy = !bus.isQuiescent(userId, c.conversation_id);
    const stale = lastActiveMs > 0 && (now - lastActiveMs) > STALE_MS;
    const [stateRes, membersRes, commRes] = await Promise.allSettled([
      stale ? Promise.resolve(null) : readState(userId, c.conversation_id, c.project_id ?? null),
      summaryFresh ? Promise.resolve(null) : readMembers(userId, c.conversation_id, c.project_id ?? null),
      // Substring scan of `<cid>.jsonl` for any `from:"commander"` line.
      // Cheaper than per-line JSON.parse and good enough — `commander` is
      // an actor id, never legitimately a free-form value of any other
      // field. False positives would require a user message containing
      // that exact quoted pattern (and even then the read returns true,
      // which is the conservative outcome: show commander when in doubt).
      summaryFresh ? Promise.resolve(null) : (async () => {
        const file = conversationMessageReadFile(userId, c.conversation_id, c.project_id ?? null);
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
    if (!summaryFresh && commRes.status === 'fulfilled') {
      commanderInChat = commRes.value;
    }
    if (!summaryFresh && membersRes.status === 'fulfilled' && membersRes.value) {
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
    } else if (!summaryFresh && c.agent_id) {
      agentIds = [c.agent_id];
    }
    if (!summaryFresh) {
      c.agent_ids = _normaliseAgentIds(agentIds);
      c.commander_in_chat = commanderInChat;
      c.participant_summary_updated_at = c.updated_at;
      summariesToBackfill.push(c);
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
    return {
      ...c,
      processing,
      processing_since: since,
      last_active_at: lastActiveAt,
      agent_ids: _normaliseAgentIds(agentIds),
      commander_in_chat: commanderInChat,
    };
  }));
  if (summariesToBackfill.length && shouldPersistBackfill()) {
    await _withConversationWrite(userId, async () => {
      // Recheck after waiting for the user's write queue. A normal mutation
      // invalidates this list generation before it queues its own write, so
      // an older startup snapshot can never commit after a newer mutation.
      if (!shouldPersistBackfill()) return;
      const deviceId = _recordDeviceId(userId);
      for (const c of summariesToBackfill) bumpRecordSyncVersion(c, deviceId);
      const cleaned = pruneExpiredDeletedRecords(items.map(_cleanConversation)) as Conversation[];
      const writtenRoots = await _writeConversationIndexes(userId, cleaned);
      for (const root of writtenRoots) _notifyChatIndexDirty(root || undefined);
      log.info(`backfilled participant summaries user=${userId} conversations=${summariesToBackfill.length}`);
    });
  }
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

export async function listConversations(userId: string): Promise<Conversation[]> {
  const cached = _conversationListCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return _cloneConversationList(cached.items);
  const existing = _conversationListInFlight.get(userId);
  if (existing) return _cloneConversationList(await existing);

  const generation = _conversationListGeneration.get(userId) || 0;
  const run = _listConversationsUncached(
    userId,
    () => (_conversationListGeneration.get(userId) || 0) === generation,
  );
  _conversationListInFlight.set(userId, run);
  try {
    const items = await run;
    if ((_conversationListGeneration.get(userId) || 0) === generation) {
      _conversationListCache.set(userId, {
        expiresAt: Date.now() + CONVERSATION_LIST_CACHE_TTL_MS,
        items: _cloneConversationList(items),
      });
    }
    return _cloneConversationList(items);
  } finally {
    if (_conversationListInFlight.get(userId) === run) _conversationListInFlight.delete(userId);
  }
}

export interface StartupConversationList {
  conversations: Conversation[];
  deferred_unprojected: { last30: number; older: number };
  loaded_project_ids: string[];
  project_pagination: Record<string, ConversationPageInfo>;
}

export interface ConversationPageInfo {
  total: number;
  next_offset: number | null;
}

export interface ConversationPage extends ConversationPageInfo {
  conversations: Conversation[];
}

export const CONVERSATION_LIST_PAGE_SIZE = 10;

function _conversationActivityMs(c: Conversation): number {
  return Math.max(tsMs(c.updated_at), tsMs(c.created_at));
}

function _compareConversationIndexRows(a: Conversation, b: Conversation): number {
  const ap = a.pinned_at || '';
  const bp = b.pinned_at || '';
  if (ap && !bp) return -1;
  if (!ap && bp) return 1;
  if (ap && bp) {
    const pinCmp = bp.localeCompare(ap);
    if (pinCmp) return pinCmp;
  }
  const activityCmp = _conversationActivityMs(b) - _conversationActivityMs(a);
  if (activityCmp) return activityCmp;
  return String(a.conversation_id || '').localeCompare(String(b.conversation_id || ''));
}

function _pageOffset(value: unknown): number {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
}

async function _enrichConversationPage(
  userId: string,
  rows: Conversation[],
  offset: number,
): Promise<ConversationPage> {
  const start = _pageOffset(offset);
  const sorted = rows
    .filter((c) => !isDeletedConversation(c))
    .sort(_compareConversationIndexRows);
  const pageRows = sorted.slice(start, start + CONVERSATION_LIST_PAGE_SIZE);
  const conversations = await _listConversationsUncached(
    userId,
    () => false,
    undefined,
    () => Promise.resolve(pageRows),
  );
  const next = start + pageRows.length;
  return {
    conversations,
    total: sorted.length,
    next_offset: next < sorted.length ? next : null,
  };
}

function _startupOldBucket(c: Conversation, now = new Date()): 'last30' | 'older' | null {
  if (c.pinned_at) return null;
  const activityMs = _conversationActivityMs(c);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const dayMs = 24 * 60 * 60 * 1000;
  if (activityMs >= today.getTime() - 7 * dayMs) return null;
  if (activityMs >= today.getTime() - 30 * dayMs) return 'last30';
  return 'older';
}

/** Startup-only sidebar slice. Aggregate indexes are still the authority, but
 * per-conversation state/member/history enrichment is limited to rows that can
 * actually appear on first paint. Collapsed project rows and old unprojected
 * buckets are fetched through the scoped readers below when opened. */
export async function listStartupConversations(
  userId: string,
  options: { activeConversationId?: string; expandedProjectIds?: string[] } = {},
): Promise<StartupConversationList> {
  const requestedProjects = new Set(
    (options.expandedProjectIds || []).filter((id) => typeof id === 'string' && safeId(id)),
  );
  const activeCid = safeId(options.activeConversationId || '') ? options.activeConversationId! : '';
  const deferred = { last30: 0, older: 0 };
  let loadedProjects: string[] = [];
  const projectPagination: Record<string, ConversationPageInfo> = {};
  const conversations = await _listConversationsUncached(userId, () => false, (all) => {
    const visibleProjects = new Set(requestedProjects);
    const active = activeCid ? all.find((c) => c.conversation_id === activeCid) : undefined;
    if (active?.project_id && safeId(active.project_id)) visibleProjects.add(active.project_id);
    loadedProjects = Array.from(visibleProjects);
    const selectedProjectCids = new Set<string>();
    for (const projectId of visibleProjects) {
      const rows = all
        .filter((c) => c.project_id === projectId)
        .sort(_compareConversationIndexRows);
      for (const row of rows.slice(0, CONVERSATION_LIST_PAGE_SIZE)) {
        selectedProjectCids.add(row.conversation_id);
      }
      projectPagination[projectId] = {
        total: rows.length,
        next_offset: rows.length > CONVERSATION_LIST_PAGE_SIZE
          ? CONVERSATION_LIST_PAGE_SIZE
          : null,
      };
    }
    if (active?.project_id) selectedProjectCids.add(active.conversation_id);
    for (const c of all) {
      if (c.project_id || c.pinned_at) continue;
      const bucket = _startupOldBucket(c);
      if (bucket) deferred[bucket] += 1;
    }
    return all.filter((c) => {
      if (c.conversation_id === activeCid) return true;
      if (c.project_id) return selectedProjectCids.has(c.conversation_id);
      if (c.pinned_at) return true;
      return _startupOldBucket(c) === null;
    });
  });
  return {
    conversations,
    deferred_unprojected: deferred,
    loaded_project_ids: loadedProjects,
    project_pagination: projectPagination,
  };
}

/** Read and enrich one 10-row page from exactly one project's compact index. */
export async function listProjectConversationPage(
  userId: string,
  projectId: string,
  offset = 0,
): Promise<ConversationPage> {
  if (!safeId(projectId)) return { conversations: [], total: 0, next_offset: null };
  return _enrichConversationPage(
    userId,
    await _readScopedRawConversations(userId, projectId),
    offset,
  );
}

/** Read one 10-row execution-history page for an automation task.
 *
 * Automation runs may live in the global conversation root or in any
 * project root, so this intentionally reads the compact aggregate indexes
 * once and filters before enrichment. It must not reuse the renderer's
 * startup slice: that cache only contains the first visible project page and
 * would make both the total and the pagination cursor incorrect. */
export async function listAutoTaskConversationPage(
  userId: string,
  taskId: string,
  offset = 0,
): Promise<ConversationPage> {
  if (!safeId(taskId)) return { conversations: [], total: 0, next_offset: null };
  const rows = (await _readRawConversations(userId, { discoverUnindexedMetas: false }))
    .filter((c) => c.origin_auto_task_id === taskId);
  return _enrichConversationPage(userId, rows, offset);
}

/** Count execution conversations for many automation tasks with one index
 * scan. The task list uses this before rendering so its labels show the real
 * total instead of the number currently present in the bounded sidebar
 * cache. */
export async function countAutoTaskConversations(
  userId: string,
  taskIds: string[],
): Promise<Record<string, number>> {
  const ids = Array.from(new Set(
    (Array.isArray(taskIds) ? taskIds : [])
      .filter((id) => typeof id === 'string' && safeId(id))
      .slice(0, 500),
  ));
  const counts: Record<string, number> = Object.fromEntries(ids.map((id) => [id, 0]));
  if (!ids.length) return counts;
  const wanted = new Set(ids);
  const rows = await _readRawConversations(userId, { discoverUnindexedMetas: false });
  for (const row of rows) {
    if (isDeletedConversation(row)) continue;
    const taskId = row.origin_auto_task_id || '';
    if (wanted.has(taskId)) counts[taskId] += 1;
  }
  return counts;
}

/** Read and enrich one 10-row page from one old unprojected age bucket. */
export async function listOldUnprojectedConversationPage(
  userId: string,
  bucket: 'last30' | 'older',
  offset = 0,
): Promise<ConversationPage> {
  if (bucket !== 'last30' && bucket !== 'older') {
    return { conversations: [], total: 0, next_offset: null };
  }
  const rows = (await _readScopedRawConversations(userId))
    .filter((c) => !c.project_id && _startupOldBucket(c) === bucket);
  return _enrichConversationPage(userId, rows, offset);
}

/** Load one expanded project's rows without touching other collapsed projects. */
export async function listProjectConversations(userId: string, projectId: string): Promise<Conversation[]> {
  if (!safeId(projectId)) return [];
  return _listConversationsUncached(
    userId,
    () => false,
    undefined,
    () => _readScopedRawConversations(userId, projectId),
  );
}

/** Load the two collapsed age buckets for the unprojected sidebar only. */
export async function listOldUnprojectedConversations(userId: string): Promise<Conversation[]> {
  return _listConversationsUncached(
    userId,
    () => false,
    (all) => all.filter((c) => !c.project_id && _startupOldBucket(c) !== null),
    () => _readScopedRawConversations(userId),
  );
}

function _conversationRootKey(projectId?: string | null): string {
  return typeof projectId === 'string' && safeId(projectId) ? projectId : '';
}

function _conversationMetaFileForRoot(userId: string, cid: string, rootKey: string): string {
  const dir = rootKey ? projectChatsDir(userId, rootKey) : userChatsDir(userId);
  return path.join(dir, cid, conversationMetaName());
}

interface ConversationIndexTarget {
  rootKey: string;
  rows: Conversation[];
  index: number;
  conversation: Conversation;
}

/** Internal source-of-truth adapter for normal one-conversation mutations.
 * It owns physical-root reads, target legacy-meta merge, root selection and
 * atomic root commits. Full collection persistence below remains reserved for
 * repair/migration. Instances live only inside the per-user write queue. */
class ConversationIndexStore {
  private readonly roots = new Map<string, Conversation[]>();

  constructor(private readonly userId: string) {}

  async readRoot(rootKey: string): Promise<Conversation[]> {
    const key = _conversationRootKey(rootKey);
    const cached = this.roots.get(key);
    if (cached) return cached;
    const raw = await _readConversationIndexRoot(this.userId, key || null);
    const rows = _mergeNormalizedConversationRows(raw).items;
    this.roots.set(key, rows);
    return rows;
  }

  private async targetInRoot(rootKey: string, cid: string): Promise<ConversationIndexTarget | null> {
    const rows = await this.readRoot(rootKey);
    const index = rows.findIndex((row) => row.conversation_id === cid);
    if (index < 0) return null;
    let conversation = rows[index];
    // Current sync-stamped rows are complete. Only a legacy target needs its
    // recovery copy; unrelated legacy rows in the same root stay unopened.
    if (recordSyncRev(conversation) <= 0) {
      try {
        const raw = JSON.parse(await fsp.readFile(
          _conversationMetaFileForRoot(this.userId, cid, rootKey), 'utf8'));
        const meta = _normaliseConversation(raw, cid);
        if (meta) {
          if (rootKey && !meta.project_id) meta.project_id = rootKey;
          conversation = _mergeConversationRecord(conversation, meta);
          rows[index] = conversation;
        }
      } catch { /* index row remains authoritative enough for mutation */ }
    }
    return { rootKey, rows, index, conversation };
  }

  async findTarget(
    cid: string,
    projectIdHint?: string | null,
    fallbackAcrossRoots = true,
  ): Promise<ConversationIndexTarget | null> {
    if (projectIdHint === null || (typeof projectIdHint === 'string' && safeId(projectIdHint))) {
      const hinted = await this.targetInRoot(_conversationRootKey(projectIdHint), cid);
      if (hinted) return hinted;
      if (!fallbackAcrossRoots) return null;
    }

    // Hintless and stale-hint calls retain correctness by locating the record
    // across compact indexes. Normal UI and message-write paths provide a
    // validated hint, so they never enter this fallback.
    const rootKeys = ['', ...listProjectIds(this.userId)];
    await _runBounded(rootKeys, 8, async (rootKey) => { await this.readRoot(rootKey); });
    const candidates: Conversation[] = [];
    for (const rows of this.roots.values()) {
      const row = rows.find((item) => item.conversation_id === cid);
      if (row) candidates.push(row);
    }
    const winner = _mergeNormalizedConversationRows(candidates).items[0];
    if (!winner) return null;
    const winnerRoot = _conversationRootKey(winner.project_id);
    return this.targetInRoot(winnerRoot, cid);
  }

  async persistTarget(target: ConversationIndexTarget, next: Conversation): Promise<void> {
    const oldRoot = target.rootKey;
    const newRoot = _conversationRootKey(next.project_id);
    const changedRoots = new Set<string>([oldRoot, newRoot]);
    const oldRows = await this.readRoot(oldRoot);
    const oldIndex = oldRows.findIndex((row) => row.conversation_id === next.conversation_id);
    if (oldRoot === newRoot) {
      if (oldIndex >= 0) oldRows[oldIndex] = next;
      else oldRows.unshift(next);
    } else {
      for (let i = oldRows.length - 1; i >= 0; i -= 1) {
        if (oldRows[i].conversation_id === next.conversation_id) oldRows.splice(i, 1);
      }
      const newRows = await this.readRoot(newRoot);
      for (let i = newRows.length - 1; i >= 0; i -= 1) {
        if (newRows[i].conversation_id === next.conversation_id) newRows.splice(i, 1);
      }
      newRows.unshift(next);
    }
    await this.commitRoots(changedRoots);
    if (isDeletedConversation(next)) {
      try { await fsp.unlink(_conversationMetaFileForRoot(this.userId, next.conversation_id, newRoot)); }
      catch { /* missing is fine */ }
    } else {
      await _writeJsonIfChanged(
        _conversationMetaFileForRoot(this.userId, next.conversation_id, newRoot),
        _cleanConversationMeta(next),
      );
    }
    if (oldRoot !== newRoot) {
      try { await fsp.unlink(_conversationMetaFileForRoot(this.userId, next.conversation_id, oldRoot)); }
      catch { /* missing is fine */ }
    }
  }

  async insert(rootKey: string, conversation: Conversation): Promise<void> {
    const key = _conversationRootKey(rootKey);
    const rows = await this.readRoot(key);
    for (let i = rows.length - 1; i >= 0; i -= 1) {
      if (rows[i].conversation_id === conversation.conversation_id) rows.splice(i, 1);
    }
    rows.unshift(conversation);
    await this.commitRoots(new Set([key]));
    await _writeJsonIfChanged(
      _conversationMetaFileForRoot(this.userId, conversation.conversation_id, key),
      _cleanConversationMeta(conversation),
    );
  }

  private async commitRoots(rootKeys: ReadonlySet<string>): Promise<void> {
    await Promise.all(Array.from(rootKeys, async (rootKey) => {
      const rows = await this.readRoot(rootKey);
      const cleaned = pruneExpiredDeletedRecords(rows.map(_cleanConversation)) as Conversation[];
      await writeJson(conversationIndexFile(this.userId, rootKey || null), cleaned);
      _notifyChatIndexDirty(rootKey || undefined);
    }));
  }
}

async function _withConversationIndexStore<T>(
  userId: string,
  fn: (store: ConversationIndexStore) => Promise<T>,
): Promise<T> {
  _invalidateConversationListCache(userId);
  try {
    return await _withConversationWrite(userId, () => fn(new ConversationIndexStore(userId)));
  } finally {
    // Readers may race the multi-file commit; never retain a partial view.
    _invalidateConversationListCache(userId);
  }
}

async function _writeConversationIndexes(
  userId: string,
  cleaned: Conversation[],
  affectedRoots?: ReadonlySet<string>,
): Promise<Set<string>> {
  _invalidateConversationIndexCache(userId);
  const globalRows: Conversation[] = [];
  const projectRows = new Map<string, Conversation[]>();
  for (const c of cleaned) {
    const pid = _conversationRootKey(c.project_id);
    if (affectedRoots && !affectedRoots.has(pid)) continue;
    if (pid) {
      if (!projectRows.has(pid)) projectRows.set(pid, []);
      projectRows.get(pid)!.push(c);
    } else {
      globalRows.push(c);
    }
  }
  const roots = affectedRoots
    ? new Set(Array.from(affectedRoots, (root) => _conversationRootKey(root)))
    : new Set(['', ...listProjectIds(userId), ...projectRows.keys()]);
  try {
    await Promise.all(Array.from(roots, async (root) => {
      await writeJson(
        conversationIndexFile(userId, root || undefined),
        root ? (projectRows.get(root) || []) : globalRows,
      );
    }));
  } finally {
    // A reader could have started while multiple roots were being committed;
    // never retain that partial snapshot.
    _invalidateConversationIndexCache(userId);
  }
  return roots;
}

async function _saveConversations(
  userId: string,
  items: Conversation[],
): Promise<void> {
  _invalidateConversationListCache(userId);
  try {
    await _withConversationWrite(userId, async () => {
      const rawCleaned = items.map(_cleanConversation);
      const cleaned = pruneExpiredDeletedRecords(rawCleaned) as Conversation[];
      const writtenRoots = await _writeConversationIndexes(userId, cleaned);
      await _saveConversationMetas(userId, rawCleaned);
      for (const root of writtenRoots) _notifyChatIndexDirty(root || undefined);
    });
  } finally {
    // A list can start while the index/meta writes above are in flight. Bump
    // the generation again after commit so that partial snapshot cannot land
    // in the short-lived cache after this save returns.
    _invalidateConversationListCache(userId);
  }
}

/** Full-snapshot persistence for repair/migration callers. Routine CRUD uses
 * `ConversationIndexStore` so it never enters this all-root path. */
export async function saveConversations(userId: string, items: Conversation[]): Promise<void> {
  await _saveConversations(userId, items);
}

export interface ConversationParticipantActivity {
  senderKind: ActorKind;
  senderId: string;
  agentIds?: string[];
}

/** Stamp `updated_at` on the cid's index row to the timestamp of the message
 *  just written. Called by `group_chat/bus.ts::appendMain` after every
 *  `<cid>.jsonl` append. listConversations sorts by `updated_at` (rather than
 *  file mtime) so cross-device sync is well-behaved — manifest-merge of the
 *  index array is a union-by-id with `updated_at` tiebreak, so both devices
 *  converge on the actual last-activity time. No-op when the row doesn't
 *  exist (the conv may have been deleted between message-write and bump). */
export async function bumpConversationActivity(
  userId: string,
  cid: string,
  tsIso: string,
  participantActivity?: ConversationParticipantActivity,
  projectIdHint?: string | null,
): Promise<void> {
  if (!cid || !tsIso) return;
  await _withConversationIndexStore(userId, async (store) => {
    const target = await store.findTarget(cid, projectIdHint);
    if (!target || isDeletedConversation(target.conversation)) return;
    const c = { ...target.conversation };
    let changed = false;
    const summaryWasFresh = _hasFreshParticipantSummary(c);
    if (c.updated_at !== tsIso) {
      c.updated_at = tsIso;
      changed = true;
    }
    if (summaryWasFresh && participantActivity) {
      const nextAgentIds = _normaliseAgentIds([
        ...(c.agent_ids || []),
        ...(c.agent_id ? [c.agent_id] : []),
        ...(participantActivity.agentIds || []),
        ...(participantActivity.senderKind === 'agent' ? [participantActivity.senderId] : []),
      ]);
      const commanderInChat = c.commander_in_chat === true
        || participantActivity.senderKind === 'commander';
      if (JSON.stringify(nextAgentIds) !== JSON.stringify(c.agent_ids || [])) {
        c.agent_ids = nextAgentIds;
        changed = true;
      }
      if (commanderInChat !== c.commander_in_chat) {
        c.commander_in_chat = commanderInChat;
        changed = true;
      }
      if (c.participant_summary_updated_at !== tsIso) {
        c.participant_summary_updated_at = tsIso;
        changed = true;
      }
    }
    if (!changed) return;
    _stampConversationSync(userId, c);
    await store.persistTarget(target, c);
  });
}

export async function getConversation(
  userId: string,
  cid: string,
  projectIdHint?: string | null,
): Promise<Conversation | null> {
  if (!safeId(cid)) return null;
  // Preserve the short-lived enriched-list fast path when the sidebar just
  // loaded, but never construct that full list merely to resolve one cid.
  const cached = _conversationListCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) {
    const found = cached.items.find((c) => c.conversation_id === cid);
    const hintMatches = projectIdHint === undefined
      || (projectIdHint === null ? !found?.project_id : found?.project_id === projectIdHint);
    if (!found || hintMatches) return found ? _cloneConversationList([found])[0] : null;
  }
  const target = await _listConversationsUncached(
    userId,
    () => false,
    undefined,
    () => _readTargetRawConversation(userId, cid, projectIdHint),
  );
  return target.find((c) => c.conversation_id === cid) || null;
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
  const explicitCid = conversationId && safeId(conversationId) ? conversationId : '';
  const outcome = await _withConversationIndexStore(userId, async (store) => {
    if (explicitCid) {
      // Externally supplied ids must retain global collision semantics. This
      // rare path may inspect all compact roots; generated ids below do not.
      const existing = await store.findTarget(explicitCid);
      if (existing && !isDeletedConversation(existing.conversation)) {
        return { conversation: existing.conversation, action: 'existing' as const };
      }
      if (existing) {
        const current = existing.conversation;
        const previousProjectId = current.project_id;
        const now = nowIso();
        const revived: Conversation = _stampConversationSync(userId, {
          ...current,
          title: title ? normaliseConversationTitle(title) : (current.title || t('chat.default_title')),
          kind,
          agent_id: agentId || current.agent_id || '',
          skill_id: skillId || current.skill_id || '',
          session_id: current.session_id || buildConversationSessionId(explicitCid),
          ...(projectId ? { project_id: projectId } : {}),
          ...(originAutoTaskId ? { origin_auto_task_id: originAutoTaskId } : {}),
          updated_at: now,
        });
        delete revived.deleted_at;
        await store.persistTarget(existing, revived);
        return {
          conversation: revived,
          action: 'revived' as const,
          previousProjectId,
        };
      }
    }

    let cid = explicitCid || genConversationId();
    const destinationHint = projectId ? projectId : null;
    // Collision avoidance stays root-local for random ids. Cross-root random
    // collisions are cryptographically negligible; explicit ids above keep
    // the stronger all-root contract needed by future migrations.
    while (!explicitCid && await store.findTarget(cid, destinationHint, false)) {
      cid = genConversationId();
    }
    const now = nowIso();
    const created: Conversation = _stampConversationSync(userId, {
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
      agent_ids: _normaliseAgentIds(agentId ? [agentId] : []),
      commander_in_chat: false,
      participant_summary_updated_at: now,
    });
    await store.insert(_conversationRootKey(created.project_id), created);
    return { conversation: created, action: 'created' as const };
  });

  const conv = outcome.conversation;
  if (outcome.action === 'existing') return conv;

  // Touch jsonl so subsequent reads don't 404.
  const msgFile = conversationMessageFile(userId, conv.conversation_id, conv.project_id ?? null);
  await fsp.mkdir(path.dirname(msgFile), { recursive: true });
  await fsp.writeFile(msgFile, '', { flag: 'a' });
  if (outcome.action === 'revived') {
    log.info(`revived user=${userId} cid=${conv.conversation_id} kind=${kind} agent=${agentId || '-'} skill=${skillId || '-'} project=${projectId || outcome.previousProjectId || '-'}`);
  } else {
    log.info(`created user=${userId} cid=${conv.conversation_id} kind=${kind} agent=${agentId || '-'} skill=${skillId || '-'} project=${projectId || '-'}`);
  }
  return conv;
}

export async function updateConversation(
  userId: string,
  cid: string,
  updates: Partial<Conversation>,
  projectIdHint?: string | null,
): Promise<Conversation | null> {
  return _withConversationIndexStore(userId, async (store) => {
    const target = await store.findTarget(cid, projectIdHint);
    if (!target || isDeletedConversation(target.conversation)) return null;
    const previous = target.conversation;
    const updatedAt = nowIso();
    const summaryWasFresh = _hasFreshParticipantSummary(previous);
    const next = _stampConversationSync(userId, {
      ...previous,
      ...updates,
      updated_at: updatedAt,
      ...(summaryWasFresh ? { participant_summary_updated_at: updatedAt } : {}),
    });
    delete next.deleted_at;
    await store.persistTarget(target, next);
    return next;
  });
}

export async function renameConversation(
  userId: string,
  cid: string,
  title: unknown,
  projectIdHint?: string | null,
): Promise<Conversation | null> {
  if (!safeId(cid)) return null;
  return updateConversation(userId, cid, {
    title: normaliseConversationTitle(title),
    title_manually_set: true,
  }, projectIdHint);
}

export async function setConversationPinned(
  userId: string,
  cid: string,
  pinned: boolean,
  projectIdHint?: string | null,
): Promise<Conversation | null> {
  if (!safeId(cid)) return null;
  return _withConversationIndexStore(userId, async (store) => {
    const target = await store.findTarget(cid, projectIdHint);
    if (!target || isDeletedConversation(target.conversation)) return null;
    const next = { ...target.conversation };
    const pinStateUpdatedAt = nowIso();
    let changed = false;
    if (pinned && !next.pinned_at) {
      next.pinned_at = pinStateUpdatedAt;
      next.pin_state_updated_at = pinStateUpdatedAt;
      changed = true;
    } else if (!pinned && next.pinned_at) {
      delete next.pinned_at;
      next.pin_state_updated_at = pinStateUpdatedAt;
      changed = true;
    }
    if (changed) {
      _stampConversationSync(userId, next);
      await store.persistTarget(target, next);
    }
    return next;
  });
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
    await bus.dropConv(userId, cid);
    await purgeGroupDir(userId, cid);
  }
  catch (err) { log.warn(`group_chat dropConv failed user=${userId} cid=${cid}: ${(err as Error).message}`); }

  // Purge main jsonl.
  const msgFile = conversationMessageFile(userId, cid, removed?.project_id ?? null);
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
  for (const sessionsDir of projectSessionRoots(userId, cid)) {
    try {
      const names = await fsp.readdir(sessionsDir);
      for (const n of names) {
        if (!n.startsWith(gmemberPrefix) || !n.endsWith('.jsonl')) continue;
        purgeSession(userId, n.slice(0, -'.jsonl'.length));
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn(`gmember sweep user=${userId} cid=${cid}: ${(err as Error).message}`);
      }
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

export async function deleteConversation(
  userId: string,
  cid: string,
  projectIdHint?: string | null,
): Promise<boolean> {
  let removed: Conversation | null = null;
  const found = await _withConversationIndexStore(userId, async (store) => {
    const target = await store.findTarget(cid, projectIdHint);
    if (!target) return false;
    removed = target.conversation;
    if (!isDeletedConversation(target.conversation)) {
      const deletedAt = nowIso();
      const tombstone = _stampConversationSync(userId, {
        ...target.conversation,
        deleted_at: deletedAt,
        updated_at: deletedAt,
      });
      await store.persistTarget(target, tombstone);
    } else {
      try {
        await fsp.unlink(_conversationMetaFileForRoot(userId, cid, target.rootKey));
      } catch { /* missing is fine */ }
    }
    return true;
  });
  if (!found || !removed) return false;
  await _purgeDeletedConversationFiles(userId, cid, removed);
  return true;
}

/** Read raw group messages from `<cid>.jsonl`. UI uses this for initial
 *  history load; subsequent updates flow through group_chat.streamEvents. */
export async function getMessages(userId: string, cid: string, limit = 200): Promise<MessageRecord[]> {
  return (await getMessagesPage(userId, cid, limit)).history;
}

/** Bounded, cursor-paged message reads for the conversation detail view.
 *  The cursor is an opaque JSONL byte offset returned by the previous page. */
export async function getMessagesPage(
  userId: string,
  cid: string,
  limit = 10,
  before?: number | null,
  projectIdHint?: string | null,
): Promise<{ history: MessageRecord[]; nextCursor: number | null }> {
  const file = conversationMessageReadFile(userId, cid, projectIdHint);
  const wanted = Math.max(1, Math.floor(Number(limit) || 1));
  let cursor = before;
  let nextCursor: number | null = before ?? null;
  let history: MessageRecord[] = [];
  while (history.length < wanted) {
    const page = await readJsonlPage<MessageRecord>(file, wanted - history.length, cursor);
    const visible = page.records.filter((message) => !message.deleted_at);
    history = visible.concat(history);
    nextCursor = page.nextCursor;
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  return { history, nextCursor };
}

/** Load from the fixed-size page containing a search hit through the newest
 * record. The search index gives us the absolute record index, so this is one
 * direct forward read rather than a renderer-driven chain of older-page IPC
 * requests. `nextCursor` still points immediately before the target page so
 * normal upward pagination remains available. */
export async function getMessagesPageAtIndex(
  userId: string,
  cid: string,
  messageIndex: number,
  limit = 10,
  projectIdHint?: string | null,
): Promise<{
  history: MessageRecord[];
  historyIndexes: number[];
  nextCursor: number | null;
  pageStart: number;
}> {
  const file = conversationMessageReadFile(userId, cid, projectIdHint);
  const wanted = Math.max(1, Math.floor(Number(limit) || 1));
  const index = Math.max(0, Math.floor(Number(messageIndex) || 0));
  const pageStart = Math.floor(index / wanted) * wanted;
  const page = await readJsonlWindow<MessageRecord>(file, pageStart, Number.MAX_SAFE_INTEGER);
  const visible = page.records
    .map((message, offset) => ({ message, index: pageStart + offset }))
    .filter(({ message }) => !message.deleted_at);
  return {
    history: visible.map(({ message }) => message),
    // Keep the source JSONL indexes aligned with `history`. The renderer uses
    // this as the final navigation identity for old records that predate
    // stable message ids/timestamps; filtering a tombstone must not shift the
    // remaining page-relative offsets.
    historyIndexes: visible.map(({ index: recordIndex }) => recordIndex),
    nextCursor: page.previousCursor,
    pageStart,
  };
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
      if (await deleteConversation(userId, c.conversation_id, c.project_id || null)) deleted++;
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
      await deleteConversation(uid, c.conversation_id, c.project_id || null);
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
  const clauseIdx = findTitleClauseBoundary(text);
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

interface ConversationStateCandidate {
  uid: string;
  cid: string;
  file: string;
}

async function _conversationStateCandidates(uid: string): Promise<ConversationStateCandidate[]> {
  const out: ConversationStateCandidate[] = [];
  for (const root of conversationRoots(uid)) {
    let entries: fs.Dirent[] = [];
    try { entries = await fsp.readdir(root.dir, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory() || !isConversationMetaDirName(entry.name)) continue;
      out.push({
        uid,
        cid: entry.name,
        file: conversationLayout(uid, entry.name, root.projectId).stateFile,
      });
    }
  }
  return out;
}

async function _indexedConversationStateCandidates(uid: string): Promise<ConversationStateCandidate[]> {
  const rows = await _readIndexConversations(uid);
  const seen = new Set<string>();
  const out: ConversationStateCandidate[] = [];
  for (const row of rows) {
    if (!safeId(row.conversation_id) || seen.has(row.conversation_id)) continue;
    seen.add(row.conversation_id);
    out.push({
      uid,
      cid: row.conversation_id,
      file: conversationLayout(uid, row.conversation_id, row.project_id ?? null).stateFile,
    });
  }
  return out;
}

/**
 * Any group whose state.json says `running` when the app starts was
 * interrupted by a crash or hard quit. Flip them to `idle` (not aborted —
 * abort is a deliberate user action) and persist one actor-owned interruption
 * bubble so a reload cannot silently erase the live assistant placeholder.
 * The next user message kicks off a fresh worker from durable state.
 */
export async function sweepStaleProcessing(activeUserId?: string): Promise<{ swept: number }> {
  if (!fs.existsSync(WS_ROOT)) return { swept: 0 };
  let swept = 0;
  let pruneJournalRows = false;
  const candidates: ConversationStateCandidate[] = [];
  if (activeUserId) {
    const tracked = await readRunningConversationRegistry(activeUserId);
    if (tracked.valid) {
      pruneJournalRows = true;
      // Normal pre-window path: one compact read, then only the handful of
      // conversations that were actually running when the process stopped.
      for (const item of tracked.items) {
        candidates.push({
          uid: activeUserId,
          cid: item.conversation_id,
          file: conversationLayout(
            activeUserId, item.conversation_id, item.project_id,
          ).stateFile,
        });
      }
    } else {
      // One-time upgrade/corruption fallback. Establish the marker first so
      // future boots stay O(running), without overwriting a concurrent start.
      await ensureRunningConversationRegistry(activeUserId);
      candidates.push(...await _indexedConversationStateCandidates(activeUserId));
    }
  } else {
    // Maintenance/recovery path: retain full discovery for unindexed state
    // directories and inactive users, but run it after the startup window.
    for (const entry of await fsp.readdir(WS_ROOT, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const uid = entry.name;
      const chatsDir = userChatsDir(uid);
      if (!fs.existsSync(chatsDir)) continue;
      candidates.push(...await _conversationStateCandidates(uid));
    }
  }
  // Loaded lazily to avoid the chats ↔ bus module cycle during startup. The
  // CJS path deliberately shares the same in-memory runtime map as send().
  const bus = require('./group_chat/bus') as typeof import('./group_chat/bus');
  await _runBounded(candidates, 32, async ({ uid, cid, file }) => {
    try {
      const raw = JSON.parse(await fsp.readFile(file, 'utf8'));
      if (raw?.status !== 'running') {
        if (pruneJournalRows) await untrackRunningConversation(uid, cid);
        return;
      }
      const lastActiveMs = Date.parse(String(raw.last_active_at || ''));
      if (Number.isFinite(lastActiveMs) && lastActiveMs >= PROCESS_BOOT_CUTOFF_MS) {
        // This state was created or refreshed by the current process. It is
        // never stale startup residue, even if this deferred sweep was queued
        // before the user started the turn.
        return;
      }
      if (!bus.isQuiescent(uid, cid)) {
        // Belt-and-braces for legacy/malformed timestamps and turn-start races:
        // live in-memory work always wins over disk maintenance.
        return;
      }
      await setStatus(uid, cid, 'idle');
      const interruptedActors = Array.isArray(raw.in_flight)
        ? raw.in_flight.filter((actorId: unknown): actorId is string => safeId(actorId))
        : [];
      const members = await readMembers(uid, cid);
      const memberIds = members.actors.map((actor) => actor.id).filter(safeId);
      const senderId = interruptedActors.find((actorId) => memberIds.includes(actorId))
        || interruptedActors[0]
        || 'commander';
      const ts = new Date().toISOString();
      const interruptedMessage: GroupMessage = {
        id: genId12(),
        ts,
        from: senderId,
        to: ['user'],
        system_kind: 'reply_interrupted',
        text: t('chat.reply_interrupted'),
        model_text: 'The previous assistant run was interrupted by an application exit or crash before it produced a complete reply. Do not assume the interrupted operation completed; recover durable state before continuing.',
      };
      const layout = conversationLayout(uid, cid);
      await appendJsonlAtomic<GroupMessage>(layout.messageFile, interruptedMessage);
      await appendVisible(uid, cid, interruptedMessage, [...new Set([...memberIds, senderId, 'commander'])]);
      const senderKind = members.actors.find((actor) => actor.id === senderId)?.kind
        || (senderId === 'commander' ? 'commander' : 'agent');
      await bumpConversationActivity(uid, cid, ts, {
        senderKind,
        senderId,
        ...(senderKind === 'agent' ? { agentIds: [senderId] } : {}),
      }, layout.projectId);
      swept += 1;
    } catch {
      // Missing/malformed state is idle; prune any stale journal row.
      if (pruneJournalRows) await untrackRunningConversation(uid, cid);
    }
  });
  if (swept) log.info(`cleared ${swept} stale running conversations`);
  return { swept };
}
