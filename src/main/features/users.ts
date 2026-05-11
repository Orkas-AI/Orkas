/**
 * Local-machine user registry + active uid lifecycle.
 *
 * `data/users.json` holds
 * `{ current_user_id, users: [{user_id, created_at}, ...] }` — the sole
 * top-level local metadata. All per-uid private data lives under
 * `data/<uid>/{cloud,local}/` (see paths.ts).
 *
 * Boot sequence:
 *   1. Read users.json; if absent, create the first uid (`genUserId`)
 *      and point current_user_id at it.
 *   2. `activateUser(uid)` mkdir's the uid sub-tree, pins
 *      CORE_AGENT_AUTH_DIR, and clears the relevant caches.
 *   3. From there, every feature uses `getActiveUserId()` to obtain the
 *      current uid.
 *
 * Currently only one uid is active at a time (a UI-level switcher is
 * planned for a later iteration). The registry shape already
 * accommodates multi-uid scenarios.
 */

import * as fs from 'node:fs';

import {
  USERS_FILE,
  userLocalConfigDir,
  userToolResultsDir,
  ensureUserLayout,
} from '../paths';
import { nowIso, genUserId, safeId, readJsonSync, writeJsonSync } from '../storage';
import { createLogger } from '../logger';
import { sweepToolResults } from '../util/tool-result-cap';
import { migrateLegacySessionIds } from '../util/migrate-session-ids';
import { migrateAgentLayout } from '../util/migrate-agent-layout';

const log = createLogger('users');

export interface UserRecord {
  user_id: string;
  created_at: string;
}

interface UsersRegistry {
  current_user_id: string;
  users: UserRecord[];
}

// ── In-memory active uid ─────────────────────────────────────────────────

let ACTIVE_UID: string | null = null;

/**
 * Return the currently-activated user id. Throws if `activateUser()` has not
 * been called — every user-scoped feature must go through `activateUser` in
 * the boot sequence before being usable.
 */
export function getActiveUserId(): string {
  if (!ACTIVE_UID) {
    throw new Error('no active user — activateUser() must run before any user-scoped feature');
  }
  return ACTIVE_UID;
}

/** For tests / diagnostics — has `activateUser` been called yet? */
export function hasActiveUser(): boolean {
  return ACTIVE_UID !== null;
}

// ── Registry IO ──────────────────────────────────────────────────────────

function readRegistry(): UsersRegistry | null {
  if (!fs.existsSync(USERS_FILE)) return null;
  const data = readJsonSync<Partial<UsersRegistry>>(USERS_FILE);
  if (!data || typeof data !== 'object') return null;
  const cur = typeof data.current_user_id === 'string' ? data.current_user_id : '';
  const users = Array.isArray(data.users) ? data.users.filter(isValidRecord) : [];
  if (!cur || !users.some((u) => u.user_id === cur)) return null;
  return { current_user_id: cur, users };
}

function isValidRecord(v: unknown): v is UserRecord {
  if (!v || typeof v !== 'object') return false;
  const r = v as Partial<UserRecord>;
  return typeof r.user_id === 'string' && safeId(r.user_id) && typeof r.created_at === 'string';
}

function writeRegistry(reg: UsersRegistry): void {
  writeJsonSync(USERS_FILE, reg);
}

// ── Activation ───────────────────────────────────────────────────────────

/**
 * Activate `uid` as the live user for this process:
 *   - mkdir the full `<uid>/{cloud,local}/*` skeleton.
 *   - Point `CORE_AGENT_AUTH_DIR` at `<uid>/local/config/`. core-agent's
 *     `resolveAuthDir()` reads the env var on every call, so runtime
 *     switching is safe.
 *   - Clear the relevant module-level caches (session-store, auth,
 *     config).
 *   - Write `current_user_id` back to users.json.
 *
 * Callers are typically `boot` and (in a future iteration) the UI
 * switcher.
 */
export function activateUser(uid: string): void {
  if (!safeId(uid)) throw new Error(`invalid user id: ${String(uid)}`);

  ensureUserLayout(uid);

  // Purge tool-results/ entries older than 7 days. Best-effort (nothrow);
  // failure here should not block uid activation. See util/tool-result-cap.ts
  // — these are oversized tool outputs persisted to disk with a
  // <persisted-output> reference in the tool_result that went to the LLM.
  // We only clean on activate (not on session end) because the individual
  // files are small and the 7-day window is comfortably above typical
  // conversation lifetimes.
  try { sweepToolResults(userToolResultsDir(uid), 7); }
  catch (err) { log.warn(`sweepToolResults uid=${uid}: ${(err as Error).message}`); }

  // Strip legacy session_id brand prefixes once.
  // Idempotent: after the stamp lands, subsequent startups are no-ops.
  // See util/migrate-session-ids.ts for details.
  try { migrateLegacySessionIds(uid); }
  catch (err) { log.warn(`migrateLegacySessionIds uid=${uid}: ${(err as Error).message}`); }

  // Agent layout migration: `agents/<aid>.json` →
  // `agents/<aid>/agent.json`, and `meta/<aid>/*` →
  // `agents/<aid>/meta/*`. Likewise idempotent + stamped. See
  // util/migrate-agent-layout.ts + docs/plans/agent-as-directory.md.
  try { migrateAgentLayout(uid); }
  catch (err) { log.warn(`migrateAgentLayout uid=${uid}: ${(err as Error).message}`); }

  // Pin core-agent's auth/state dir to this uid's local/config/.
  // `resolveAuthDir()` re-reads this env var on every call (see
  // core-agent/src/auth/store.ts::resolveAuthDir), so switching at runtime is
  // safe — we just need to flush any downstream in-memory caches after.
  process.env.CORE_AGENT_AUTH_DIR = userLocalConfigDir(uid);

  // Invalidate downstream caches (best-effort; modules may not be loaded yet).
  try {
    const store = require('../model/core-agent/session-store');
    if (typeof store?._evictAll === 'function') store._evictAll();
  } catch { /* not loaded yet */ }
  try {
    const runner = require.cache[require.resolve('../model/core-agent/runner')];
    if (runner && typeof (runner.exports as any)?.invalidateConfig === 'function') {
      (runner.exports as any).invalidateConfig();
    }
  } catch { /* not loaded yet */ }

  ACTIVE_UID = uid;

  // Persist the current_user_id flip.
  const reg = readRegistry();
  if (reg) {
    if (reg.current_user_id !== uid) {
      reg.current_user_id = uid;
      if (!reg.users.some((u) => u.user_id === uid)) {
        reg.users.push({ user_id: uid, created_at: nowIso() });
      }
      writeRegistry(reg);
    }
  } else {
    writeRegistry({
      current_user_id: uid,
      users: [{ user_id: uid, created_at: nowIso() }],
    });
  }

  log.info(`active user_id=${uid}`);
}

/**
 * Boot-time entrypoint — read users.json and activate current_user_id; if
 * none, generate a new uid and activate that. Returns the record.
 */
export function initActiveUser(): UserRecord {
  const reg = readRegistry();
  if (reg) {
    const rec = reg.users.find((u) => u.user_id === reg.current_user_id) || {
      user_id: reg.current_user_id,
      created_at: nowIso(),
    };
    activateUser(rec.user_id);
    return rec;
  }
  // First boot — no registry yet.
  const rec: UserRecord = { user_id: genUserId(), created_at: nowIso() };
  activateUser(rec.user_id);
  log.info(`first-boot: created user_id=${rec.user_id}`);
  return rec;
}

/**
 * Back-compat shim for callers still on the old name. New code should
 * use `initActiveUser()` in the boot path and `getActiveUserId()` elsewhere.
 */
export async function getOrCreateSelfUser(): Promise<UserRecord> {
  if (hasActiveUser()) {
    const reg = readRegistry();
    const rec = reg?.users.find((u) => u.user_id === getActiveUserId());
    return rec || { user_id: getActiveUserId(), created_at: nowIso() };
  }
  return initActiveUser();
}
