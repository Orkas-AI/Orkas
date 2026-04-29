/**
 * 本机用户注册表 + 活跃 uid 生命周期。
 *
 * `data/users.json` 存 `{ current_user_id, users: [{user_id, created_at}, ...] }`，
 * 是唯一的顶层本机元数据。所有 uid 私域数据都在 `data/<uid>/{cloud,local}/` 下
 * （见 paths.ts）。
 *
 * 启动流程：
 *   1. 读 users.json；不存在 → 创建首个 uid（`genUserId`），current_user_id 指向它
 *   2. `activateUser(uid)` 建 uid 子目录骨架 + pin CORE_AGENT_AUTH_DIR + 清相关缓存
 *   3. 之后所有 feature 调用用 `getActiveUserId()` 拿当前 uid
 *
 * 本期仅支持单活跃 uid（UI 级切换下期另起 plan）。但注册表结构已预留多 uid 场景。
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
 *   - mkdir 完整的 `<uid>/{cloud,local}/*` 骨架
 *   - 把 `CORE_AGENT_AUTH_DIR` 指向 `<uid>/local/config/`（core-agent 的
 *     `resolveAuthDir()` 每次调用读 env，运行时切换安全）
 *   - 清相关模块的内存缓存（session-store、auth、config）
 *   - 把 `current_user_id` 写回 users.json
 *
 * 调用方通常是 `boot` 与（下一期的）UI 切换入口。
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

  // 历史 session_id 上的品牌前缀一次性剥掉。idempotent：盖章后再
  // 启动直接 no-op。详见 util/migrate-session-ids.ts。
  try { migrateLegacySessionIds(uid); }
  catch (err) { log.warn(`migrateLegacySessionIds uid=${uid}: ${(err as Error).message}`); }

  // Agent 布局迁移:`agents/<aid>.json` → `agents/<aid>/agent.json`,
  // `meta/<aid>/*` → `agents/<aid>/meta/*`。同样 idempotent + 盖章。
  // 详见 util/migrate-agent-layout.ts + docs/plans/agent-as-directory.md。
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
