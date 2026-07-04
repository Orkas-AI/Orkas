import * as os from 'node:os';
import * as path from 'node:path';

export interface TccSensitivePathResult {
  blocked: true;
  reason: string;
  protectedRoot: string;
}

function enabled(): boolean {
  return process.platform === 'darwin' || process.env.ORKAS_TCC_GUARD_FORCE === '1';
}

function norm(p: string): string {
  return path.resolve(p || '');
}

function sameOrInside(candidate: string, root: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function sameOrParentOf(candidate: string, child: string): boolean {
  const rel = path.relative(candidate, child);
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function protectedRoots(): Array<{ path: string; reason: string }> {
  const home = norm(os.homedir());
  return [
    { path: path.join(home, 'Desktop'), reason: 'desktop' },
    { path: path.join(home, 'Documents'), reason: 'documents' },
    { path: path.join(home, 'Downloads'), reason: 'downloads' },
    { path: path.join(home, 'Pictures'), reason: 'photos' },
    { path: path.join(home, 'Movies'), reason: 'movies' },
    { path: path.join(home, 'Music'), reason: 'music' },
    { path: path.join(home, 'Library'), reason: 'library' },
  ];
}

/**
 * macOS privacy prompts can be triggered by ordinary stat/readdir calls under
 * Desktop, Documents, Downloads, Photos/Pictures, and personal-data stores in
 * Library (Contacts/Calendars/Reminders). Use this before background scans.
 *
 * `recursive` also blocks ancestors such as the home directory because walking
 * them would inevitably descend into one of the protected roots.
 */
export function macosTccSensitivePath(
  targetPath: string,
  opts: { recursive?: boolean } = {},
): TccSensitivePathResult | null {
  if (!enabled() || !targetPath || !path.isAbsolute(targetPath)) return null;

  const target = norm(targetPath);
  const home = norm(os.homedir());
  const homeParent = path.dirname(home);
  if (target === home) {
    return { blocked: true, reason: 'home', protectedRoot: home };
  }
  if (target === path.parse(target).root || target === homeParent) {
    return { blocked: true, reason: 'home-parent', protectedRoot: target };
  }

  for (const root of protectedRoots()) {
    const protectedRoot = norm(root.path);
    if (sameOrInside(target, protectedRoot)) {
      return { blocked: true, reason: root.reason, protectedRoot };
    }
    if (opts.recursive && sameOrParentOf(target, protectedRoot)) {
      return { blocked: true, reason: root.reason, protectedRoot };
    }
  }
  return null;
}

/**
 * Workspaces are long-lived execution roots: agents create, stat, list, and
 * reveal files there across turns. Even if each individual scan is guarded,
 * placing the workspace under a macOS TCC root can still trigger privacy
 * prompts during normal writes or shell commands. Treat these paths as
 * ineligible workspace/default-picker roots.
 */
export function macosTccWorkspaceBlockedPath(targetPath: string): TccSensitivePathResult | null {
  return macosTccSensitivePath(targetPath, { recursive: true });
}
