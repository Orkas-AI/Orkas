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
 *     (last run was interrupted), identical content is deduplicated and
 *     divergent content is preserved under `migration_conflicts/`.
 *   - A missing meta sub-directory for an agent emits log.warn but does not
 *     block the migration.
 *   - Per-item failures don't block the rest; the stamp is only written
 *     after the whole flow completes.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import { userAgentsDir, userCloudRoot, userLocalConfigDir } from '../paths';
import { createLogger } from '../logger';
import { logErrorSummary, maskId } from './log-redact';

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

function shortDigest(contents: Buffer): string {
  return createHash('sha256').update(contents).digest('hex').slice(0, 12);
}

function uniqueConflictPath(base: string, contents: Buffer): string {
  if (!fs.existsSync(base)) return base;
  try {
    if (fs.readFileSync(base).equals(contents)) return base;
  } catch { /* choose a unique path below */ }
  for (let index = 1; index < 1_000; index += 1) {
    const candidate = `${base}-${index}`;
    if (!fs.existsSync(candidate)) return candidate;
    try {
      if (fs.readFileSync(candidate).equals(contents)) return candidate;
    } catch { /* keep searching */ }
  }
  return `${base}-${Date.now()}`;
}

function preserveConflictFile(
  source: string,
  current: string,
  conflictDir: string,
  label: string,
): 'deduplicated' | 'preserved' {
  const sourceContents = fs.readFileSync(source);
  const currentContents = fs.readFileSync(current);
  if (sourceContents.equals(currentContents)) {
    fs.unlinkSync(source);
    return 'deduplicated';
  }
  fs.mkdirSync(conflictDir, { recursive: true });
  const extension = path.extname(label);
  const baseName = extension ? label.slice(0, -extension.length) : label;
  const destination = uniqueConflictPath(
    path.join(
      conflictDir,
      `${baseName}.legacy-${shortDigest(sourceContents)}${extension}`,
    ),
    sourceContents,
  );
  if (fs.existsSync(destination)) fs.unlinkSync(source);
  else fs.renameSync(source, destination);
  return 'preserved';
}

/**
 * Migrate one user's agent layout in place. Idempotent — already-stamped uids
 * return zero stats without touching disk. Safe to call on every boot.
 */
export function migrateAgentLayout(uid: string, opts: MigrationOptions = {}): MigrationStats {
  const stats: MigrationStats = { agentsConverted: 0, metaMoved: 0, warnings: 0 };
  const applied = alreadyApplied(uid);
  if (applied && !opts.force) return stats;
  let retryRequired = false;

  const agentsRoot = userAgentsDir(uid);
  const oldMetaRoot = path.join(userCloudRoot(uid), 'meta');

  // 1. Scan agents/<aid>.json and move it to agents/<aid>/agent.json
  if (fs.existsSync(agentsRoot)) {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(agentsRoot, { withFileTypes: true });
    } catch (err) {
      log.warn('agent-layout migration scan failed', {
        userId: maskId(uid),
        error: logErrorSummary(err),
      });
      retryRequired = true;
    }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.json') || e.name.startsWith('.')) continue;
      const aid = e.name.replace(/\.json$/, '');
      const oldFile = path.join(agentsRoot, e.name);
      const newDir = path.join(agentsRoot, aid);
      const newFile = path.join(newDir, 'agent.json');
      if (fs.existsSync(newFile)) {
        try {
          const outcome = preserveConflictFile(
            oldFile,
            newFile,
            path.join(newDir, 'migration_conflicts'),
            'agent.json',
          );
          if (outcome === 'preserved') {
            stats.warnings += 1;
            log.warn('agent-layout migration preserved a divergent flat agent', {
              userId: maskId(uid),
              agentId: maskId(aid),
            });
          }
        } catch (err) {
          log.warn('agent-layout migration could not reconcile a flat agent', {
            userId: maskId(uid),
            agentId: maskId(aid),
            error: logErrorSummary(err),
          });
          stats.warnings += 1;
          retryRequired = true;
        }
        continue;
      }
      try {
        fs.mkdirSync(newDir, { recursive: true });
        fs.renameSync(oldFile, newFile);
        stats.agentsConverted += 1;
      } catch (err) {
        log.warn('agent-layout migration could not move a flat agent', {
          userId: maskId(uid),
          agentId: maskId(aid),
          error: logErrorSummary(err),
        });
        stats.warnings += 1;
        retryRequired = true;
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
      log.warn('agent-layout legacy metadata scan failed', {
        userId: maskId(uid),
        error: logErrorSummary(err),
      });
      retryRequired = true;
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
            const outcome = preserveConflictFile(
              src,
              dst,
              path.join(agentsRoot, aid, 'migration_conflicts', 'meta'),
              f,
            );
            if (outcome === 'preserved') {
              stats.warnings += 1;
              log.warn('agent-layout migration preserved divergent metadata', {
                userId: maskId(uid),
                agentId: maskId(aid),
              });
            }
            continue;
          }
          fs.renameSync(src, dst);
          stats.metaMoved += 1;
        }
        // src is now empty → remove the src directory.
        try { fs.rmdirSync(srcDir); }
        catch { /* leave the leftover for the next run to clean up */ }
      } catch (err) {
        log.warn('agent-layout metadata migration failed', {
          userId: maskId(uid),
          agentId: maskId(aid),
          error: logErrorSummary(err),
        });
        stats.warnings += 1;
        retryRequired = true;
      }
    }
    // Remove the top-level meta/ directory wholesale (rmdirSync only succeeds
    // when empty; leftovers are kept silently — fine).
    try { fs.rmdirSync(oldMetaRoot); }
    catch { /* keep */ }
  }

  if (!applied && !retryRequired) stamp(uid);
  if (stats.agentsConverted || stats.metaMoved || stats.warnings) {
    log.info('agent-layout migration completed', {
      userId: maskId(uid),
      agents: stats.agentsConverted,
      metadata: stats.metaMoved,
      warnings: stats.warnings,
      retryRequired,
    });
  }
  return stats;
}
