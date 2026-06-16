/**
 * CLI-package companion skills — read-side accessor for the
 * `<uid>/local/package_skills/` domain.
 *
 * When a CLI-only external package is installed (registry `kind: "cli"`), the
 * commander auto-authors a usage SKILL.md so it has curated instructions for
 * the package's binaries instead of only a bare name list in `$env_summary`.
 * That companion lives here, OUTSIDE the verbatim `local/packages/<pkg>/` tree
 * (which orkas-pkg.cjs must never write Orkas files into) and OUTSIDE cloud/
 * (a machine-specific CLI wrapper must not sync to a device that lacks the
 * package). See `Common/docs/plans/cli-package-companion-skill.md`.
 *
 * Write-side lives in `bin/orkas-pkg.cjs` (`skill-write` / pruned on `remove`),
 * symmetric with the `_registry.json` split. This module is READ-only: it
 * never creates, edits, or deletes companion files.
 *
 * Layout: `<uid>/local/package_skills/<pkg>/SKILL.md`. The dir name IS the
 * package name, so the SkillLoader root is the parent dir and each child is a
 * skill with `id == <pkg>` (the same `"."`-style root shape package skills use).
 *
 * This module deliberately imports ONLY paths.ts: the registry join (deciding
 * which companions belong to a live/enabled package) is the caller's job
 * (`packages.ts`, `skill-registry.ts`), which keeps this module free of an
 * import cycle with `packages.ts`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { userPackageSkillsDir, userPackageSkillDir } from '../paths';

function isFile(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/** True when a companion SKILL.md exists on disk for this package. */
export function companionSkillFileExists(uid: string, pkg: string): boolean {
  return isFile(path.join(userPackageSkillDir(uid, pkg), 'SKILL.md'));
}

/**
 * The companion-skills parent dir as a SkillLoader root, or null when no
 * companion exists yet. Returning the parent (not the per-package dir) matches
 * the loader's `<root>/<id>/SKILL.md` shape: each child dir becomes a skill
 * whose id is the package name. Callers add this to the open-tier `external`
 * dir set; per-package enable/orphan gating happens via the registry join in
 * `packageMetaForSkillDir`.
 */
export function companionSkillsRootIfPopulated(uid: string): string | null {
  const root = userPackageSkillsDir(uid);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return null; // dir absent → no companions
  }
  for (const e of entries) {
    if (e.isDirectory() && isFile(path.join(root, e.name, 'SKILL.md'))) return path.resolve(root);
  }
  return null;
}

/**
 * If `skillDir` is a companion package dir (`<package_skills>/<pkg>`), return
 * the package name; otherwise null. Pure path math — does NOT check the
 * registry or disk, so the caller decides whether the package is live/enabled.
 */
export function companionPackageForDir(uid: string, skillDir: string): string | null {
  const parent = path.resolve(userPackageSkillsDir(uid));
  const resolved = path.resolve(skillDir);
  if (resolved === parent) return null;
  const rel = path.relative(parent, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  const segments = rel.split(path.sep);
  return segments.length === 1 ? segments[0] : null;
}
