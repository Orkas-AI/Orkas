/**
 * Per-conversation CLI session bindings.
 *
 * Each resumable (cid, aid, cli) tuple gets a CLI-reported session id so the
 * next dispatch can pass the backend's continuation handle. The CLI keeps its
 * own conversation memory, while Orkas supplies bounded canonical history on
 * first contact and bounded canonical deltas after the last successful reply.
 *
 * Storage: `<uid>/local/cli-sessions/<cid>.json`, shape:
 *   { "<aid>": { "cli": "claude", "sessionId": "...", "updatedAt": "...",
 *                  "sourceMessageId": "...", "turnId": "..." } }
 *
 * Why under `local/` instead of `cloud/`: session ids reference
 * machine-local CLI state (e.g. `~/.claude/projects/...`); a synced
 * id from another device wouldn't resolve and would fail-noisy.
 *
 * `cli` is captured alongside the id so a runtime swap (the user
 * picks a different CLI from the detail page selector) treats the
 * old binding as stale — fresh dispatch, fresh CLI session. The runner
 * persists a new id once the new CLI emits one.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import { localCliSessionsFile, userLocalCliSessionsDir } from '../../paths.js';
import { writeJson } from '../../storage.js';
import { createLogger } from '../../logger.js';
import { logErrorRef, maskId } from '../../util/log-redact.js';
import type { LocalCliPermissionPolicy } from './registry.js';

const log = createLogger('local-agents:sessions');

export interface CliSessionRecord {
  cli: string;
  sessionId: string;
  updatedAt: string;
  /** Hash of the low-churn CLI instruction bundle applied to this session.
   * Missing on v1 records; native-instruction adapters can safely refresh it,
   * while user-message-only adapters treat the record as a fresh boundary. */
  durableContextHash?: string;
  /** Hash of the canonical private Agent-memory block represented in this
   * native session. Missing legacy markers are intentionally incompatible
   * for Claude/Codex so stale deleted memory cannot survive a resume. */
  agentMemoryHash?: string;
  /** Sorted fingerprints of the Agent-memory entries this native session has
   * seen. Present on bindings written after 2026-09-08; a binding that has it
   * resumes across appends and resets only when one of these entries was
   * removed or edited. Older bindings fall back to the block hash. */
  agentMemoryEntryHashes?: string[];
  /** Hash of the effective cwd. Session stores for some CLIs are cwd-scoped,
   * so a mismatch must never suppress the one-time recovery context. */
  cwdFingerprint?: string;
  contextProtocolVersion?: number;
  /** Effective per-Agent policy used to create/resume this native session.
   * A mismatch starts a fresh session so sticky CLI-side settings cannot
   * retain a previous Orkas override. */
  permissionPolicy?: LocalCliPermissionPolicy;
  /** User/group message that launched the most recently persisted CLI run.
   * Failed-turn retry uses this to avoid attaching an older bubble to a newer
   * native CLI session. Missing on legacy records, which remain resumable for
   * ordinary continuation. */
  sourceMessageId?: string;
  turnId?: string;
  runId?: string;
  terminalStatus?: string;
  /** Canonical visible reply through which this CLI session was successfully
   * synchronized. Updated only after that reply is durably appended. */
  historySyncedThroughMessageId?: string;
}

interface CliSessionsFile {
  [aid: string]: CliSessionRecord;
}

async function read(uid: string, cid: string): Promise<CliSessionsFile> {
  const file = localCliSessionsFile(uid, cid);
  try {
    const raw = await fsp.readFile(file, 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {};
    return data as CliSessionsFile;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      log.warn('read failed', { user_id: maskId(uid), cid: maskId(cid), error: logErrorRef(err) });
    }
    return {};
  }
}

async function write(uid: string, cid: string, data: CliSessionsFile): Promise<void> {
  const file = localCliSessionsFile(uid, cid);
  // Atomic tmp+rename: a torn write parses as garbage and read() falls back to
  // {}, silently dropping the CLI --resume binding (next dispatch loses the
  // CLI-side conversation continuity).
  await writeJson(file, data);
}

/**
 * Return the bound CLI session id for the (cid, aid, cli) tuple, or
 * null if no binding exists OR the binding is for a different CLI
 * (runtime swapped). Caller treats null as a fresh CLI session.
 */
export async function getSessionId(uid: string, cid: string, aid: string, cli: string): Promise<string | null> {
  return (await getBinding(uid, cid, aid, cli))?.sessionId || null;
}

/** Return the full binding when provenance is needed for failed-turn retry. */
export async function getBinding(uid: string, cid: string, aid: string, cli: string): Promise<CliSessionRecord | null> {
  const file = await read(uid, cid);
  const r = file[aid];
  if (!r || r.cli !== cli) return null;
  return r.sessionId ? { ...r } : null;
}

// One file holds every agent's binding for the conversation, and parallel
// CLI actors finish independently: two unserialized read-modify-writes let
// the later writer overwrite the earlier one's fresh session id / history
// cursor (2026-08-28 review D-5). Chain writers per (uid, cid).
const _writeChains = new Map<string, Promise<unknown>>();
function _serialized<T>(uid: string, cid: string, fn: () => Promise<T>): Promise<T> {
  const key = `${uid}\u0000${cid}`;
  const previous = _writeChains.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(fn);
  _writeChains.set(key, next);
  void next.catch(() => undefined).finally(() => {
    if (_writeChains.get(key) === next) _writeChains.delete(key);
  });
  return next;
}

/** Persist the session id reported by the CLI after any terminal run. */
export async function setSessionId(
  uid: string,
  cid: string,
  aid: string,
  cli: string,
  sessionId: string,
  provenance: Partial<Pick<CliSessionRecord,
    | 'sourceMessageId'
    | 'turnId'
    | 'runId'
    | 'terminalStatus'
    | 'durableContextHash'
    | 'agentMemoryHash'
    | 'agentMemoryEntryHashes'
    | 'cwdFingerprint'
    | 'contextProtocolVersion'
    | 'permissionPolicy'
  >> = {},
): Promise<void> {
  if (!sessionId) return;
  return _serialized(uid, cid, async () => {
  const file = await read(uid, cid);
  const previous = file[aid];
  const preservedHistoryCursor = previous?.cli === cli
    && previous.sessionId === sessionId
    ? previous.historySyncedThroughMessageId
    : undefined;
  file[aid] = {
    cli,
    sessionId,
    updatedAt: new Date().toISOString(),
    ...(provenance.sourceMessageId ? { sourceMessageId: provenance.sourceMessageId } : {}),
    ...(provenance.turnId ? { turnId: provenance.turnId } : {}),
    ...(provenance.runId ? { runId: provenance.runId } : {}),
    ...(provenance.terminalStatus ? { terminalStatus: provenance.terminalStatus } : {}),
    ...(provenance.durableContextHash ? { durableContextHash: provenance.durableContextHash } : {}),
    ...(provenance.agentMemoryHash ? { agentMemoryHash: provenance.agentMemoryHash } : {}),
    ...(provenance.agentMemoryEntryHashes ? { agentMemoryEntryHashes: [...provenance.agentMemoryEntryHashes] } : {}),
    ...(provenance.cwdFingerprint ? { cwdFingerprint: provenance.cwdFingerprint } : {}),
    ...(provenance.contextProtocolVersion
      ? { contextProtocolVersion: provenance.contextProtocolVersion }
      : {}),
    ...(provenance.permissionPolicy ? { permissionPolicy: provenance.permissionPolicy } : {}),
    ...(preservedHistoryCursor
      ? { historySyncedThroughMessageId: preservedHistoryCursor }
      : {}),
  };
  try { await write(uid, cid, file); }
  catch (err) {
    log.warn('setSessionId failed', { user_id: maskId(uid), cid: maskId(cid), agent_id: maskId(aid), error: logErrorRef(err) });
  }
  });
}

/** Advance canonical-history delivery only after a successful visible CLI
 * reply has been persisted. Failed, cancelled, timed-out, and slash-command
 * turns deliberately leave the prior cursor untouched. */
export async function markHistorySyncedThrough(
  uid: string,
  cid: string,
  aid: string,
  cli: string,
  messageId: string,
): Promise<void> {
  if (!messageId) return;
  return _serialized(uid, cid, async () => {
  const file = await read(uid, cid);
  const current = file[aid];
  if (!current || current.cli !== cli || !current.sessionId) return;
  file[aid] = {
    ...current,
    historySyncedThroughMessageId: messageId,
    updatedAt: new Date().toISOString(),
  };
  try { await write(uid, cid, file); }
  catch (err) {
    log.warn('markHistorySyncedThrough failed', { user_id: maskId(uid), cid: maskId(cid), agent_id: maskId(aid), error: logErrorRef(err) });
  }
  });
}

/** Drop the binding for a single (cid, aid). Used when the agent is
 *  removed from the conversation or the user explicitly resets it. */
export async function clearForAgent(uid: string, cid: string, aid: string): Promise<void> {
  return _serialized(uid, cid, async () => {
  const file = await read(uid, cid);
  if (!(aid in file)) return;
  delete file[aid];
  try {
    if (Object.keys(file).length === 0) {
      await fsp.unlink(localCliSessionsFile(uid, cid)).catch(() => { /* */ });
    } else {
      await write(uid, cid, file);
    }
  } catch (err) {
    log.warn('clearForAgent failed', { user_id: maskId(uid), cid: maskId(cid), agent_id: maskId(aid), error: logErrorRef(err) });
  }
  });
}

/** Drop ALL bindings for a conversation. Called from
 *  `chats.deleteConversation` so a hard reset of the chat also drops
 *  any CLI session pointers we'd otherwise keep dangling. The CLI's
 *  own session files (e.g. `~/.claude/...`) are NOT touched — we
 *  don't have a portable / safe way to invoke CLI-side cleanup, and
 *  the CLI is expected to GC stale sessions itself. */
export async function clearForConversation(uid: string, cid: string): Promise<void> {
  const file = localCliSessionsFile(uid, cid);
  try { await fsp.unlink(file); }
  catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      log.warn('clearForConversation failed', { user_id: maskId(uid), cid: maskId(cid), error: logErrorRef(err) });
    }
  }
}

/** Synchronous best-effort variant of clearForConversation for
 *  contexts where async isn't available (e.g. inside synchronous
 *  delete cascades). */
export function clearForConversationSync(uid: string, cid: string): void {
  const file = localCliSessionsFile(uid, cid);
  try { fs.unlinkSync(file); }
  catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      log.warn('clearForConversationSync failed', { user_id: maskId(uid), cid: maskId(cid), error: logErrorRef(err) });
    }
  }
}

/** Test helper — confirms the dir exists / is empty for assertions. */
export function _sessionsDirForTest(uid: string): string {
  return userLocalCliSessionsDir(uid);
}
