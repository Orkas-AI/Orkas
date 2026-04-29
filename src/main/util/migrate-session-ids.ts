/**
 * 一次性数据迁移：把 session jsonl 文件名上的历史品牌前缀剥掉。
 *
 * 旧版本曾把 session_id 写成 `<brand>-<uid>-<kind>-<tail>` 的形式；当前规范
 * 统一为 `<uid>-<kind>-<tail>`（无品牌前缀，避免任何分叉/改名再断历史）。
 *
 * 迁移策略：
 *   1. 扫 `<uid>/cloud/sessions/*.jsonl`
 *   2. 命中 `^<legacy-prefix>-<uid>-(.+)\.jsonl$` 重命名为 `<uid>-$1.jsonl`
 *   3. 已经是新格式的 → 跳过
 *   4. 同名冲突（极罕见，理论上同一 sid 不会两份）→ log.warn 后跳过，让人工处理
 *   5. `<uid>/local/.migrations` 写一行 `decouple-session-id-from-brand-v1` 防重跑
 *
 * 历史 kind（`organizer` / `sub` / `conv`）不在白名单，但迁移仅看前缀不看 kind，
 * 所以这些老会话也会被一并去前缀。它们的 jsonl 内容仍然有效（用户可以打开
 * 历史群聊看记录），只是新代码不会再生成这种 kind。
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { userSessionsDir, userLocalConfigDir } from '../paths';
import { createLogger } from '../logger';

const log = createLogger('migrate');

const MIGRATION_TAG = 'decouple-session-id-from-brand-v1';
const LEGACY_PREFIX_RE = /^(aiteam|orkas)-/;

function migrationsFile(uid: string): string {
  // userLocalConfigDir = <uid>/local/config; up one to <uid>/local/
  return path.join(path.dirname(userLocalConfigDir(uid)), '.migrations');
}

function alreadyApplied(uid: string): boolean {
  const f = migrationsFile(uid);
  if (!fs.existsSync(f)) return false;
  try {
    const content = fs.readFileSync(f, 'utf8');
    return content.split('\n').some((line) => line.trim() === MIGRATION_TAG);
  } catch {
    return false;
  }
}

function stamp(uid: string): void {
  const f = migrationsFile(uid);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, MIGRATION_TAG + '\n', 'utf8');
}

interface MigrationStats {
  scanned: number;
  renamed: number;
  alreadyMigrated: number;
  conflicts: number;
}

/**
 * Run the migration for one uid. Idempotent: a previously-stamped uid is a
 * no-op. Safe to call on every boot.
 */
export function migrateLegacySessionIds(uid: string): MigrationStats {
  const stats: MigrationStats = { scanned: 0, renamed: 0, alreadyMigrated: 0, conflicts: 0 };
  if (alreadyApplied(uid)) {
    return stats;
  }

  const dir = userSessionsDir(uid);
  if (!fs.existsSync(dir)) {
    stamp(uid);
    return stats;
  }

  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir);
  } catch (err) {
    log.warn(`readdir failed ${dir}: ${(err as Error).message}`);
    return stats;
  }

  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    stats.scanned += 1;
    if (!LEGACY_PREFIX_RE.test(name)) {
      stats.alreadyMigrated += 1;
      continue;
    }
    const newName = name.replace(LEGACY_PREFIX_RE, '');
    const src = path.join(dir, name);
    const dst = path.join(dir, newName);
    if (fs.existsSync(dst)) {
      log.warn(`migration conflict: ${newName} already exists, skipping ${name}`);
      stats.conflicts += 1;
      continue;
    }
    try {
      fs.renameSync(src, dst);
      stats.renamed += 1;
    } catch (err) {
      log.warn(`rename failed ${src} → ${dst}: ${(err as Error).message}`);
    }
  }

  stamp(uid);
  if (stats.renamed || stats.conflicts) {
    log.info(
      `session id migration done uid=${uid} renamed=${stats.renamed} conflicts=${stats.conflicts} alreadyMigrated=${stats.alreadyMigrated}`,
    );
  }
  return stats;
}
