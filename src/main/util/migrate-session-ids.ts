/**
 * One-shot data migration: strip the legacy brand prefix from session jsonl
 * filenames.
 *
 * Older builds wrote session_ids as `<brand>-<uid>-<kind>-<tail>`; the
 * current canonical form is `<uid>-<kind>-<tail>` (no brand prefix, so any
 * future fork or rename can't break history again).
 *
 * Migration strategy:
 *   1. Scan `<uid>/cloud/sessions/*.jsonl`
 *   2. Match `^<legacy-prefix>-<uid>-(.+)\.jsonl$` and rename to
 *      `<uid>-$1.jsonl`
 *   3. Already-new-format files are skipped
 *   4. Same-name conflicts (extremely rare — in theory there should not
 *      be two copies of one sid) are log.warn'd and skipped for manual
 *      handling
 *   5. `<uid>/local/.migrations` is stamped with a single line
 *      `decouple-session-id-from-brand-v1` to prevent re-runs
 *
 * Legacy kinds (`organizer` / `sub` / `conv`) aren't on the whitelist, but
 * since the migration only looks at the prefix and not the kind, those
 * sessions also get the prefix stripped. Their jsonl content is still
 * valid (users can open old group-chat history); new code just no
 * longer generates those kinds.
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
