/**
 * One-shot migration: pre-marketplace `data/builtin/{agents,skills}/` → user cloud.
 *
 * Old model (pre-2026-05): `data/builtin/{agents,skills}/<id>/` was a top-level globally-shared
 * tree synced from `PC/src/builtin/` at startup. Marketplace installs were dropped here too,
 * marked with a `_marketplace.json` sentinel to exempt them from the sync.
 *
 * New model: there is no shipped-builtin tree (`PC/src/builtin/` is gone). Marketplace installs
 * live at `<uid>/local/marketplace/{agents,skills}/<id>/` (per-user, per-machine; reconciled
 * via the cloud-synced installs.json manifest). The old `data/builtin/` tree is dead weight.
 *
 * Migration policy: treat every dir under the legacy `data/builtin/{agents,skills}/` as a
 * **user-custom item** (moves into `<uid>/cloud/{agents,skills}/<id>/`). Rationale: by the
 * time this runs the user has lived with these as if they were their own agents/skills — bumping
 * them into cloud preserves continuity (same id, same content, now showing under "Custom"
 * instead of the gone "Platform" group). Marketplace items will get re-installed via
 * reconcile when the cloud manifest is rebuilt on a fresh install.
 *
 * Idempotent via a marker file at `<container>/data/builtin/.migrated-to-cloud.json`. After
 * migration the legacy `data/builtin/` directory is removed.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';

import { WS_ROOT, userAgentsDir, userSkillsDir } from '../paths';
import { createLogger } from '../logger';

const log = createLogger('migrate-marketplace');

const LEGACY_BUILTIN_ROOT = () => path.join(WS_ROOT, 'builtin');
const MIGRATION_MARKER = () => path.join(LEGACY_BUILTIN_ROOT(), '.migrated-to-cloud.json');

/** Idempotent. Moves any legacy `data/builtin/{agents,skills}/<id>/` dir into the active uid's
 *  cloud tree. Returns counts (zero when there's nothing to do — eg fresh install). */
export async function migrateLegacyBuiltinToCloud(uid: string): Promise<{ moved_agents: number; moved_skills: number }> {
  const root = LEGACY_BUILTIN_ROOT();
  if (!fs.existsSync(root)) return { moved_agents: 0, moved_skills: 0 };
  if (fs.existsSync(MIGRATION_MARKER())) {
    log.info('legacy data/builtin already migrated; skipping');
    return { moved_agents: 0, moved_skills: 0 };
  }

  const movedAgents = await _moveDirChildren(
    path.join(root, 'agents'),
    userAgentsDir(uid),
    'agent',
  );
  const movedSkills = await _moveDirChildren(
    path.join(root, 'skills'),
    userSkillsDir(uid),
    'skill',
  );

  // Write marker BEFORE rm so a crash mid-cleanup doesn't lose the "already migrated" signal.
  await fsp.mkdir(root, { recursive: true });
  await fsp.writeFile(MIGRATION_MARKER(), JSON.stringify({
    migrated_at: Date.now(), to_uid: uid,
    moved_agents: movedAgents, moved_skills: movedSkills,
  }, null, 2));

  // Now wipe the legacy root entirely (including the marker — it's just a crash-safety belt).
  try { await fsp.rm(root, { recursive: true, force: true }); }
  catch (err) { log.warn(`cleanup ${root} failed: ${(err as Error).message}`); }

  log.info(`migrated ${movedAgents} agent(s) + ${movedSkills} skill(s) → uid=${uid}/cloud`);
  return { moved_agents: movedAgents, moved_skills: movedSkills };
}

async function _moveDirChildren(src: string, dst: string, kind: string): Promise<number> {
  if (!fs.existsSync(src)) return 0;
  await fsp.mkdir(dst, { recursive: true });
  let count = 0;
  for (const entry of await fsp.readdir(src, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const from = path.join(src, entry.name);
    const to = path.join(dst, entry.name);
    try {
      // Strip the legacy sentinel before moving — it's about to be meaningless in cloud/.
      const sentinel = path.join(from, '_marketplace.json');
      if (fs.existsSync(sentinel)) {
        try { await fsp.rm(sentinel); } catch { /* ignore */ }
      }
      if (!fs.existsSync(to)) {
        // Clean case: dst is free, single rename.
        await fsp.rename(from, to);
        count++;
        continue;
      }
      // Merge case: dst already exists (typically a stub from an earlier broken delete that
      // left behind only `skills/` or `meta/`). The OLD logic skipped the whole entry, which
      // discarded the source's `agent.json` / `SKILL.md` when `data/builtin/` got wiped right
      // after — that's how this machine lost 4 agents. Now we promote file-level merge: for
      // each child the src dir owns, move it over IFF the dst doesn't already have one with
      // that name. Same-name child collisions are still skipped (we'd rather keep dst's data).
      const moved = await _mergeChildrenInto(from, to);
      if (moved > 0) {
        count++;
        log.info(`merged ${moved} entry(ies) into existing ${kind} ${entry.name}`);
      }
      try { await fsp.rm(from, { recursive: true, force: true }); } catch { /* ignore */ }
    } catch (err) {
      log.warn(`mv ${from} → ${to} failed: ${(err as Error).message}`);
    }
  }
  return count;
}

/** File-level merge helper: move every child of `srcDir` into `dstDir`, skipping names that
 *  dst already has. Returns the count of entries that landed in dst. Used by the migration
 *  when an `<id>/` stub already exists on the cloud side. */
async function _mergeChildrenInto(srcDir: string, dstDir: string): Promise<number> {
  let moved = 0;
  for (const child of await fsp.readdir(srcDir, { withFileTypes: true })) {
    if (child.name.startsWith('.')) continue;
    const childFrom = path.join(srcDir, child.name);
    const childTo = path.join(dstDir, child.name);
    if (fs.existsSync(childTo)) {
      log.warn(`merge skip ${childTo} (dst already has it)`);
      continue;
    }
    try {
      await fsp.rename(childFrom, childTo);
      moved++;
    } catch (err) {
      log.warn(`merge mv ${childFrom} → ${childTo} failed: ${(err as Error).message}`);
    }
  }
  return moved;
}
