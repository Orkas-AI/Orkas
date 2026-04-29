/**
 * Session store — maps a session_id (one per conversation) to a
 * `PersistentSession` backed by a JSONL file under
 * `data/<user_id>/cloud/sessions/<session_id>.jsonl`.
 *
 * session_id 统一规则（见 CLAUDE.md §5）：
 *   `<uid>-<kind>-<tail>`
 *   uid 必在第一段；不符合格式的 id 一律拒绝，防止 extract/organizer 早期那种
 *   "第一段塞成 feature 名" 的 bug 再复发。
 *   当前在用 kind：gconv（群聊指挥官）/ gmember（群内 agent）/ skill / agent /
 *                 extract-img / reflect / memory-extract / anon
 *   builders：features/group_chat/state.ts 的 buildGconvSessionId / buildGmemberSessionId、
 *             features/agents.ts 的 defaultAgentEditSessionId、features/skills.ts 的 skill chat 同理。
 *   历史品牌前缀在启动期由 features/users.ts 的迁移工具一次性剥掉，
 *   到这里时不应再出现；任何带前缀的 id 都视作非法。
 *
 * session jsonl 仅承载 LLM 视角（含 tool_use / tool_result / compaction），与
 * `<uid>/cloud/chats/<cid>.jsonl`（UI 视角）是两份独立文件。
 */

import * as path from 'node:path';
import * as fs from 'node:fs';

import { userSessionFile } from '../../paths';
import { getActiveUserId } from '../../features/users';
import { createLogger } from '../../logger';

const log = createLogger('model');

/**
 * Build the filesystem path that backs a given session id.
 *
 * Assertion: `sessionId` must start with `<activeUid>-`, i.e. the active
 * user's id sits in the first segment. This blocks the legacy format
 * `<kind>-<uid>-<tail>` (used by extract/organizer before the rewrite)
 * from silently routing user-private jsonl to `data/<kind>/sessions/`.
 *
 * Constructors (chats / group_chat / agents-edit / skills-edit / kb image
 * extract / reflection) must build ids via the feature-layer helpers; never
 * by hand.
 */
export function sessionFileFor(sessionId: string): string {
  const uid = getActiveUserId();
  const prefix = `${uid}-`;
  if (!sessionId.startsWith(prefix)) {
    throw new Error(
      `invalid session id "${sessionId}" — must start with "${prefix}" (active user is ${uid})`,
    );
  }
  // tail must be non-empty (i.e. there's something after the uid segment).
  if (sessionId.length <= prefix.length) {
    throw new Error(`invalid session id "${sessionId}" — missing kind/tail after uid`);
  }
  return userSessionFile(uid, sessionId);
}

/**
 * Lazy cache of loaded `PersistentSession` instances keyed by session_id.
 * Two concurrent calls with the same session_id get the same instance so
 * the in-memory history stays consistent — the per-session Mutex in
 * `util/locks.sessionLock` serializes them upstream anyway.
 */
type PersistentSessionCtor = typeof import('#core-agent').PersistentSession;
type PersistentSessionInstance = InstanceType<PersistentSessionCtor>;

const cache = new Map<string, PersistentSessionInstance>();

let _ctorPromise: Promise<PersistentSessionCtor> | null = null;
async function getCtor(): Promise<PersistentSessionCtor> {
  if (!_ctorPromise) {
    _ctorPromise = import('#core-agent').then((m) => m.PersistentSession);
  }
  return _ctorPromise;
}

/**
 * Load (or reuse a cached) PersistentSession for a session id. The
 * constructor transparently reads any prior jsonl lines into memory.
 */
export async function getSession(sessionId: string): Promise<PersistentSessionInstance> {
  const cached = cache.get(sessionId);
  if (cached) return cached;

  const file = sessionFileFor(sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const Ctor = await getCtor();
  const session = new Ctor({ sessionFile: file });
  cache.set(sessionId, session);
  return session;
}

/** Drop a cached session — used when the underlying conversation is deleted. */
export function evictSession(sessionId: string): void {
  cache.delete(sessionId);
}

/** Delete the on-disk jsonl. Caller is responsible for also evicting. */
export function deleteSessionFile(sessionId: string): void {
  const file = sessionFileFor(sessionId);
  try { fs.unlinkSync(file); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn(`delete failed ${file}: ${(err as Error).message}`);
    }
  }
}

/** Flush all cached sessions — called by `features/users.activateUser()` on uid switch. */
export function _evictAll(): void {
  cache.clear();
}

/** For diagnostics / tests. */
export function _cacheSize(): number {
  return cache.size;
}
