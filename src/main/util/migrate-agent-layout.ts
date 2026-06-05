/**
 * One-shot data migration: move each agent's spec (was
 * `<uid>/cloud/agents/<aid>.json`) plus its metacognition output (was
 * `<uid>/cloud/meta/<aid>/{COMPETENCE,LEARNING_STRATEGIES}.md`) into the
 * unified agent directory `<uid>/cloud/agents/<aid>/`:
 *
 *   <uid>/cloud/agents/<aid>/
 *   ├── agent.json                           ← from <uid>/cloud/agents/<aid>.json
 *   └── meta/
 *       ├── COMPETENCE.md                    ← from <uid>/cloud/meta/<aid>/COMPETENCE.md
 *       └── LEARNING_STRATEGIES.md           ← same
 *
 * Finally remove the now-empty top-level `meta/` directory.
 *
 * See docs/plans/agent-as-directory.md for the full design.
 *
 * Design notes:
 *   - Idempotent at startup: stamps `<uid>/local/.migrations` with
 *     `agent-as-directory-v1` to prevent re-runs.
 *   - When the old `<aid>.json` coexists with the new `<aid>/agent.json`
 *     (last run was interrupted), the new format wins.
 *   - A missing meta sub-directory for an agent emits log.warn but does not
 *     block the migration.
 *   - Per-item failures don't block the rest; the stamp is only written
 *     after the whole flow completes.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { userAgentsDir, userCloudRoot, userLocalConfigDir } from '../paths';
import { createLogger } from '../logger';

const log = createLogger('migrate');

const MIGRATION_TAG = 'agent-as-directory-v1';

function migrationsFile(uid: string): string {
  // userLocalConfigDir = <uid>/local/config; one level up is <uid>/local/.
  // Shares the .migrations file with migrate-session-ids — one tag per line.
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
  agentsConverted: number;
  metaMoved: number;
  warnings: number;
}

interface MigrationOptions {
  /** Ignore the startup migration stamp and scan for late-arriving legacy
   *  files. Used after cloud sync pulls agents from an older device. */
  force?: boolean;
}

/**
 * Migrate one user's agent layout in place. Idempotent — already-stamped uids
 * return zero stats without touching disk. Safe to call on every boot.
 */
export function migrateAgentLayout(uid: string, opts: MigrationOptions = {}): MigrationStats {
  const stats: MigrationStats = { agentsConverted: 0, metaMoved: 0, warnings: 0 };
  const applied = alreadyApplied(uid);
  if (applied && !opts.force) return stats;

  const agentsRoot = userAgentsDir(uid);
  const oldMetaRoot = path.join(userCloudRoot(uid), 'meta');

  // 1. Scan agents/<aid>.json and move it to agents/<aid>/agent.json
  if (fs.existsSync(agentsRoot)) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(agentsRoot, { withFileTypes: true });
    } catch (err) {
      log.warn(`readdir failed ${agentsRoot}: ${(err as Error).message}`);
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.json') || e.name.startsWith('.')) continue;
      const aid = e.name.replace(/\.json$/, '');
      const oldFile = path.join(agentsRoot, e.name);
      const newDir = path.join(agentsRoot, aid);
      const newFile = path.join(newDir, 'agent.json');
      if (fs.existsSync(newFile)) {
        // Previous run was interrupted, or the user hand-created the new
        // format → keep the new format, drop the old flat file.
        try {
          fs.unlinkSync(oldFile);
          log.info(`migrate: dropped redundant flat ${oldFile} (new agent.json already exists)`);
        } catch (err) {
          log.warn(`migrate: unlink redundant ${oldFile} failed: ${(err as Error).message}`);
          stats.warnings += 1;
        }
        continue;
      }
      try {
        fs.mkdirSync(newDir, { recursive: true });
        fs.renameSync(oldFile, newFile);
        stats.agentsConverted += 1;
      } catch (err) {
        log.warn(`migrate: agent ${aid} flat→dir failed: ${(err as Error).message}`);
        stats.warnings += 1;
      }
    }
  }

  // 2. Scan the old cloud/meta/<aid>/ tree and move it to
  //    cloud/agents/<aid>/meta/.
  if (fs.existsSync(oldMetaRoot)) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(oldMetaRoot, { withFileTypes: true });
    } catch (err) {
      log.warn(`readdir failed ${oldMetaRoot}: ${(err as Error).message}`);
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith('.')) continue;
      const aid = e.name;
      const srcDir = path.join(oldMetaRoot, aid);
      const targetDir = path.join(agentsRoot, aid, 'meta');
      try {
        fs.mkdirSync(targetDir, { recursive: true });
        for (const f of fs.readdirSync(srcDir)) {
          const src = path.join(srcDir, f);
          const dst = path.join(targetDir, f);
          if (fs.existsSync(dst)) {
            log.warn(`migrate: meta target exists, skipping ${dst}`);
            stats.warnings += 1;
            continue;
          }
          fs.renameSync(src, dst);
          stats.metaMoved += 1;
        }
        // src is now empty → remove the src directory.
        try { fs.rmdirSync(srcDir); }
        catch { /* leave the leftover for the next run to clean up */ }
      } catch (err) {
        log.warn(`migrate: meta agent ${aid} failed: ${(err as Error).message}`);
        stats.warnings += 1;
      }
    }
    // Remove the top-level meta/ directory wholesale (rmdirSync only succeeds
    // when empty; leftovers are kept silently — fine).
    try { fs.rmdirSync(oldMetaRoot); }
    catch { /* keep */ }
  }

  if (!applied) stamp(uid);
  if (stats.agentsConverted || stats.metaMoved || stats.warnings) {
    log.info(
      `agent-layout migration done uid=${uid} agents=${stats.agentsConverted} meta=${stats.metaMoved} warnings=${stats.warnings}`,
    );
  }
  return stats;
}
