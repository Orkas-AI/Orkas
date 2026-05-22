/**
 * Conversations (per-user) — CRUD + message reads.
 *
 * Send paths live in `features/group_chat/` — every conversation is a group
 * chat now (commander + user + N agents). This module owns:
 *
 *   - The `_index.json` registry of conversations
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

import {
  userChatsDir, userSessionFile, WS_ROOT,
} from '../paths';
import { evictSession } from '../model/core-agent/session-store';
import {
  nowIso, genConversationId, safeId,
  readJson, writeJson, invalidateLineCount, readJsonl,
} from '../storage';
import { createLogger } from '../logger';
import { t } from '../i18n';

const log = createLogger('chats');
import * as search from './search';
import * as groupChat from './group_chat';
import { buildGconvSessionId, buildGmemberSessionId, readMembers, readState, setStatus } from './group_chat/state';
import type { GroupMessage } from './group_chat/visibility';

const CONVERSATION_INDEX_NAME = '_index.json';

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
  created_at: string;
  updated_at: string;
  /** Derived from group_chat state.json at read time; never persisted on
   * the index. */
  processing?: boolean;
  processing_since?: string | null;
  /** Derived: max(<cid>.jsonl mtime, updated_at). Drives sidebar
   * last-activity ordering; never persisted. */
  last_active_at?: string;
}

/** Persisted record on `<cid>.jsonl`. Aliased for legacy callers; the new
 *  canonical type is `GroupMessage` from `group_chat/visibility`. */
export type MessageRecord = GroupMessage;

// ── CRUD ─────────────────────────────────────────────────────────────────

function ensureUserDir(userId: string): string {
  const d = userChatsDir(userId);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

async function _readRawConversations(userId: string): Promise<Conversation[]> {
  const idx = path.join(ensureUserDir(userId), CONVERSATION_INDEX_NAME);
  if (!fs.existsSync(idx)) return [];
  const data: any = await readJson(idx);
  if (Array.isArray(data)) return data as Conversation[];
  if (data && Array.isArray(data.items)) return data.items as Conversation[];
  return [];
}

export async function listConversations(userId: string): Promise<Conversation[]> {
  const items = await _readRawConversations(userId);
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
  const out: Conversation[] = [];
  for (const c of items) {
    let processing = false;
    let since: string | null = null;
    try {
      const s = await readState(userId, c.conversation_id);
      const busBusy = !groupChat.busIsQuiescent(userId, c.conversation_id);
      processing = s.status === 'running' || busBusy;
      since = processing ? s.last_active_at : null;
    } catch { /* missing state file = idle */ }
    // Last-activity = max(updated_at, created_at). `updated_at` is bumped
    // by `bumpConversationActivity` on every message append (group_chat/
    // bus.ts::appendMain), so it tracks the real per-conversation timeline
    // and survives sync (the _index.json array merge unions by id with
    // updated_at tiebreak). We deliberately do NOT consult `<cid>.jsonl`
    // mtime: sync rewrites mtime when pulling, and any file-system tool
    // that touches the bytes (backup restore, IDE, tar, manual edit) would
    // falsify the sort.
    //
    // CAREFUL: `nowIso()` returns local-time ISO without `Z` suffix
    // ("2026-05-07T15:00:00") while ISO with `Z` is UTC. Compare on
    // numeric ms and emit a UTC ISO so the downstream sort can
    // string-compare safely across both shapes.
    const updatedMs = c.updated_at ? new Date(c.updated_at).getTime() : 0;
    const createdMs = c.created_at ? new Date(c.created_at).getTime() : 0;
    const lastActiveMs = Math.max(updatedMs || 0, createdMs || 0);
    const lastActiveAt = lastActiveMs ? new Date(lastActiveMs).toISOString() : (c.updated_at || c.created_at || '');
    out.push({ ...c, processing, processing_since: since, last_active_at: lastActiveAt });
  }
  out.sort((a, b) => (b.last_active_at || '').localeCompare(a.last_active_at || ''));
  return out;
}

export async function saveConversations(userId: string, items: Conversation[]): Promise<void> {
  const cleaned = items.map((c) => {
    const { processing, processing_since, last_active_at, ...rest } = c;
    return rest;
  });
  await writeJson(path.join(ensureUserDir(userId), CONVERSATION_INDEX_NAME), cleaned);
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
}

export async function createConversation(userId: string, {
  kind = 'normal', agentId = '', skillId = '', title = '', projectId = '',
}: CreateConversationOptions = {}): Promise<Conversation> {
  const cid = genConversationId();
  const conv: Conversation = {
    conversation_id: cid,
    title: title || t('chat.default_title'),
    kind,
    agent_id: agentId || '',
    skill_id: skillId || '',
    session_id: buildGconvSessionId(userId, cid),
    ...(projectId ? { project_id: projectId } : {}),
    created_at: nowIso(),
    updated_at: nowIso(),
  };
  const items = await listConversations(userId);
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
  const items = await listConversations(userId);
  const i = items.findIndex((c) => c.conversation_id === cid);
  if (i < 0) return null;
  items[i] = { ...items[i], ...updates, updated_at: nowIso() };
  await saveConversations(userId, items);
  return items[i];
}

/** Drop a session jsonl + its in-memory cache entry. */
async function purgeSession(userId: string, sessionId: string): Promise<void> {
  if (!sessionId) return;
  try { evictSession(sessionId); } catch { /* not in cache */ }
  const f = userSessionFile(userId, sessionId);
  try { await fsp.unlink(f); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn(`session unlink user=${userId} session=${sessionId}: ${(err as Error).message}`);
    }
  }
}

export async function deleteConversation(userId: string, cid: string): Promise<boolean> {
  const items = await listConversations(userId);
  const removed = items.find((c) => c.conversation_id === cid);
  const kept = items.filter((c) => c.conversation_id !== cid);
  if (kept.length === items.length) return false;
  await saveConversations(userId, kept);

  // Purge group dir (members.json / state.json / plan.md / visibility/) + bus state.
  try { await groupChat.dropConv(userId, cid); }
  catch (err) { log.warn(`group_chat dropConv failed user=${userId} cid=${cid}: ${(err as Error).message}`); }

  // Purge main jsonl.
  const msgFile = path.join(ensureUserDir(userId), `${cid}.jsonl`);
  try { await fsp.unlink(msgFile); } catch { /* ignore missing */ }
  invalidateLineCount(msgFile);
  search.dropChatConversation(userId, cid);

  // Purge commander session + every per-agent member session.
  await purgeSession(userId, removed?.session_id || buildGconvSessionId(userId, cid));
  try {
    const m = await readMembers(userId, cid);
    for (const a of m.actors) {
      if (a.kind !== 'agent') continue;
      await purgeSession(userId, buildGmemberSessionId(userId, cid, a.id));
    }
  } catch { /* members may already be gone */ }

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

export function autoTitle(content: string): string {
  let text = (content || '').trim().replace(/\n/g, ' ');
  if (text.length > 40) text = text.slice(0, 40) + '…';
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
