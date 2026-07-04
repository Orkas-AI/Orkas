/**
 * Per-conversation CLI session bindings.
 *
 * Each (cid, aid, cli) tuple gets a CLI-reported session id so the
 * next dispatch can pass `--resume <id>`. The CLI keeps its own
 * conversation memory; we only persist the handle. Host prompts stay
 * current-turn-only while this handle is valid; if the handle is absent
 * after prior visible turns (for example cwd changed), group_chat may
 * bridge that transcript once into the fresh CLI session.
 *
 * Storage: `<uid>/local/cli-sessions/<cid>.json`, shape:
 *   { "<aid>": { "cli": "claude", "sessionId": "...", "updatedAt": "..." } }
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
import { createLogger } from '../../logger.js';
import { logErrorRef, maskId } from '../../util/log-redact.js';

const log = createLogger('local-agents:sessions');

interface CliSessionRecord {
  cli: string;
  sessionId: string;
  updatedAt: string;
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
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * Return the bound CLI session id for the (cid, aid, cli) tuple, or
 * null if no binding exists OR the binding is for a different CLI
 * (runtime swapped). Caller treats null as a fresh CLI session.
 */
export async function getSessionId(uid: string, cid: string, aid: string, cli: string): Promise<string | null> {
  const file = await read(uid, cid);
  const r = file[aid];
  if (!r || r.cli !== cli) return null;
  return r.sessionId || null;
}

/** Persist the session id reported by the CLI after a successful run. */
export async function setSessionId(uid: string, cid: string, aid: string, cli: string, sessionId: string): Promise<void> {
  if (!sessionId) return;
  const file = await read(uid, cid);
  file[aid] = { cli, sessionId, updatedAt: new Date().toISOString() };
  try { await write(uid, cid, file); }
  catch (err) {
    log.warn('setSessionId failed', { user_id: maskId(uid), cid: maskId(cid), agent_id: maskId(aid), error: logErrorRef(err) });
  }
}

/** Drop the binding for a single (cid, aid). Used when the agent is
 *  removed from the conversation or the user explicitly resets it. */
export async function clearForAgent(uid: string, cid: string, aid: string): Promise<void> {
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
