/**
 * Local-machine user registry + active uid lifecycle.
 *
 * `data/users.json` holds the local profile registry. The persisted field
 * names (`current_user_id`, `users[].user_id`) are historical; hosted builds
 * store the real account uid there while logged in.
 *
 * Hosted Orkas uses:
 *   - `anonymous` while logged out.
 *   - the server account uid while logged in.
 *
 * OrkasOpen still calls `initActiveUser()` without options, so first boot
 * keeps the original 8-digit local id.
 *
 * Boot sequence:
 *   1. Read users.json; if absent, create the first profile id and point
 *      current_user_id at it.
 *   2. `activateUser(uid)` mkdir's the uid sub-tree, pins
 *      CORE_AGENT_AUTH_DIR, and clears the relevant caches.
 *   3. From there, every feature uses `getActiveUserId()` to obtain the
 *      current profile id.
 *
 * Currently only one profile id is active at a time. The registry shape already
 * accommodates multi-profile scenarios.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  USERS_FILE,
  WS_ROOT,
  userLocalConfigDir,
  userToolResultsDir,
  ensureUserLayout,
} from '../paths';
import { nowIso, genUserId, safeId, readJsonSync, writeJsonSync } from '../storage';
import { createLogger } from '../logger';
import { sweepToolResults } from '../util/tool-result-cap';
import { migrateLegacySessionIds } from '../util/migrate-session-ids';
import { migrateChatsGhostCleanup } from '../util/migrate-chats-ghost-cleanup';
import { migrateAgentLayout } from '../util/migrate-agent-layout';
import { migrateKbToLocalContexts } from '../util/migrate-kb-to-local';
import { rekeyUserLocalSecretsAfterLocalIdChange } from '../util/rekey-user-local-secrets';
import { maskId } from '../util/log-redact';

const log = createLogger('users');
const ACCOUNT_FILE_NAME = 'account.json';

export const ANONYMOUS_LOCAL_ID = 'anonymous';

export interface UserRecord {
  /** Historical persisted field name. Hosted builds store the real account uid here. */
  user_id: string;
  created_at: string;
}

interface UsersRegistry {
  current_user_id: string;
  users: UserRecord[];
}

export interface InitActiveUserOptions {
  /** Hosted Orkas passes `anonymous`; OrkasOpen omits this and gets a generated 8-digit uid. */
  defaultLocalId?: string;
}

export interface LegacyAccountLocalIdMigrationResult {
  migrated: boolean;
  from?: string;
  to?: string;
  accountUserId?: string;
  reason?:
    | 'no_registry'
    | 'no_migration_needed'
    | 'no_stored_account'
    | 'target_exists'
    | 'rename_failed';
  error?: string;
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

function recordForLocalId(localId: string): UserRecord {
  const reg = readRegistry();
  return reg?.users.find((u) => u.user_id === localId) || { user_id: localId, created_at: nowIso() };
}

function replaceCurrentLocalId(reg: UsersRegistry, from: string, to: string): UsersRegistry {
  const fromRecord = reg.users.find((u) => u.user_id === from);
  const existingTarget = reg.users.find((u) => u.user_id === to);
  const nextUsers = reg.users.filter((u) => u.user_id !== from && u.user_id !== to);
  nextUsers.push(existingTarget || { user_id: to, created_at: fromRecord?.created_at || nowIso() });
  return { current_user_id: to, users: nextUsers };
}

function localRoot(localId: string): string {
  return path.join(WS_ROOT, localId);
}

export function localIdRootExists(localId: string): boolean {
  if (!safeId(localId)) return false;
  return fs.existsSync(localRoot(localId));
}

export function accountUserIdToLocalId(accountUserId: string): string {
  const localId = String(accountUserId || '');
  if (!safeId(localId)) throw new Error(`invalid account user id: ${String(accountUserId)}`);
  return localId;
}

export function isAnonymousLocalId(localId?: string): boolean {
  return (localId ?? ACTIVE_UID ?? '') === ANONYMOUS_LOCAL_ID;
}

export function readStoredAccountUserIdForLocalId(localId: string): string | null {
  if (!safeId(localId)) return null;
  try {
    const file = path.join(userLocalConfigDir(localId), ACCOUNT_FILE_NAME);
    const obj = JSON.parse(fs.readFileSync(file, 'utf8'));
    const accountUserId = obj && typeof obj === 'object' && typeof obj.user_id === 'string'
      ? obj.user_id
      : '';
    if (!accountUserId) return null;
    accountUserIdToLocalId(accountUserId);
    return accountUserId;
  } catch {
    return null;
  }
}

/**
 * Compatibility for hosted builds shipped before account uid directories:
 * if users.json points at any old local id and that directory has a stored
 * logged-in account, rename the directory to the real account uid before
 * account bootstrap reads account.json.
 */
export function migrateLegacyLoggedInLocalIdToAccountLocalId(): LegacyAccountLocalIdMigrationResult {
  const reg = readRegistry();
  if (!reg) return { migrated: false, reason: 'no_registry' };

  const from = reg.current_user_id;
  const accountUserId = readStoredAccountUserIdForLocalId(from);
  if (!accountUserId) return { migrated: false, from, reason: 'no_stored_account' };

  let to: string;
  try {
    to = accountUserIdToLocalId(accountUserId);
  } catch (err) {
    return { migrated: false, from, accountUserId, reason: 'no_stored_account', error: (err as Error).message };
  }
  if (to === from) {
    writeRegistry(replaceCurrentLocalId(reg, from, to));
    return { migrated: false, from, to, accountUserId, reason: 'no_migration_needed' };
  }

  const fromRoot = localRoot(from);
  const toRoot = localRoot(to);
  if (fs.existsSync(toRoot)) {
    writeRegistry(replaceCurrentLocalId(reg, from, to));
    log.warn('legacy logged-in uid target already exists; switched registry without rename', { from: maskId(from), to: maskId(to) });
    return { migrated: false, from, to, accountUserId, reason: 'target_exists' };
  }

  try {
    fs.renameSync(fromRoot, toRoot);
    rekeyUserLocalSecretsAfterLocalIdChange({ fromLocalId: from, toLocalId: to, accountUserId });
    writeRegistry(replaceCurrentLocalId(reg, from, to));
    log.info('legacy logged-in directory migrated to account uid', { from: maskId(from), to: maskId(to) });
    return { migrated: true, from, to, accountUserId };
  } catch (err) {
    log.warn('legacy logged-in uid migration failed', { from: maskId(from), to: maskId(to), error: (err as Error).message });
    return { migrated: false, from, to, accountUserId, reason: 'rename_failed', error: (err as Error).message };
  }
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
 * Callers are typically `boot` and account login/logout transitions.
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
  catch (err) { log.warn('sweepToolResults failed', { uid: maskId(uid), error: (err as Error).message }); }

  // Sessions GC: clean cid-orphan / legacy-kind / leaked-ephemeral in
  // cloud/sessions/, and mtime>7d in local/sessions/. Fire-and-forget — the
  // file scan is bounded by the size of sessions/ and shouldn't gate startup.
  // See features/sessions_sweep.ts for what it does and doesn't touch.
  (async () => {
    try {
      const mod = await import('./sessions_sweep');
      await mod.sweepSessions(uid);
    } catch (err) { log.warn('sweepSessions failed', { uid: maskId(uid), error: (err as Error).message }); }
  })();

  // Strip legacy session_id prefixes (aiteam- / orkas-) once.
  // Idempotent: after the stamp lands, subsequent startups are no-ops.
  // See util/migrate-session-ids.ts for details.
  try { migrateLegacySessionIds(uid); }
  catch (err) { log.warn('migrateLegacySessionIds failed', { uid: maskId(uid), error: (err as Error).message }); }

  // Convert old sync ghosts (index row exists, jsonl already gone) into
  // record-level tombstones so the new merge logic can propagate the delete.
  try { migrateChatsGhostCleanup(uid); }
  catch (err) { log.warn('migrateChatsGhostCleanup failed', { uid: maskId(uid), error: (err as Error).message }); }

  // Agent layout migration: `agents/<aid>.json` →
  // `agents/<aid>/agent.json`, and `meta/<aid>/*` →
  // `agents/<aid>/meta/*`. Likewise idempotent + stamped. See
  // util/migrate-agent-layout.ts + docs/plans/agent-as-directory.md.
  try { migrateAgentLayout(uid); }
  catch (err) { log.warn('migrateAgentLayout failed', { uid: maskId(uid), error: (err as Error).message }); }

  // KB vector store moved from cloud/contexts/.kb → local/contexts/.kb
  // (multi-device-sync batch 2 — index is machine-private, never crosses
  // devices). Idempotent + stamped. See util/migrate-kb-to-local.ts.
  try { migrateKbToLocalContexts(uid); }
  catch (err) { log.warn('migrateKbToLocalContexts failed', { uid: maskId(uid), error: (err as Error).message }); }

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

  log.info('active user changed', { userId: maskId(uid) });
}

/**
 * Boot-time entrypoint — read users.json and activate current_user_id. If
 * none exists, activate `defaultLocalId` (hosted: anonymous) or generate the
 * legacy 8-digit uid (OrkasOpen).
 */
export function initActiveUser(opts: InitActiveUserOptions = {}): UserRecord {
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
  const firstLocalId = opts.defaultLocalId || genUserId();
  if (!safeId(firstLocalId)) throw new Error(`invalid default local id: ${String(firstLocalId)}`);
  const rec: UserRecord = { user_id: firstLocalId, created_at: nowIso() };
  activateUser(rec.user_id);
  log.info('first-boot: created user', { userId: maskId(rec.user_id) });
  return rec;
}

export function switchToAccountLocalId(accountUserId: string): UserRecord {
  const localId = accountUserIdToLocalId(accountUserId);
  const current = ACTIVE_UID;
  if (current && current !== localId && isAnonymousLocalId(current) && !localIdRootExists(localId)) {
    const reg = readRegistry();
    const fromRoot = localRoot(current);
    const toRoot = localRoot(localId);
    try {
      if (fs.existsSync(fromRoot)) {
        fs.renameSync(fromRoot, toRoot);
        rekeyUserLocalSecretsAfterLocalIdChange({ fromLocalId: current, toLocalId: localId, accountUserId });
        if (reg) writeRegistry(replaceCurrentLocalId(reg, current, localId));
        log.info('anonymous directory adopted by account uid', { from: maskId(current), to: maskId(localId) });
      }
    } catch (err) {
      log.warn('anonymous directory adoption failed; falling back to account uid activation', {
        from: maskId(current),
        to: maskId(localId),
        error: (err as Error).message,
      });
    }
  }
  activateUser(localId);
  return recordForLocalId(localId);
}

export function switchToAnonymousLocalId(): UserRecord {
  const current = ACTIVE_UID;
  if (current && current !== ANONYMOUS_LOCAL_ID) {
    const anonymousRoot = localRoot(ANONYMOUS_LOCAL_ID);
    try {
      fs.rmSync(anonymousRoot, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 50,
      });
    } catch (err) {
      log.warn('fresh anonymous directory reset failed; reusing existing directory', {
        root: anonymousRoot,
        error: (err as Error).message,
      });
    }
  }
  activateUser(ANONYMOUS_LOCAL_ID);
  return recordForLocalId(ANONYMOUS_LOCAL_ID);
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
