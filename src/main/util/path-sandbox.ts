/**
 * Path containment check for tool-layer sandboxing.
 *
 * File tools (read_file / search_files / grep_files) must refuse paths that
 * fall outside "what the current conversation can see": the active user
 * workspace + the current cid's attachment dir. This util does the pure
 * path math; callers assemble the allowed root list from their context.
 *
 * Why a separate util: layering. `util/` cannot import `features/` (see
 * CLAUDE.md §3), so the roots are passed in rather than looked up. Callers
 * in `features/` or `model/core-agent/` compute `[activeWorkspace,
 * attachmentDir(uid,cid)]` and pass the array to `isPathAllowed`.
 *
 * Symlink handling: uses `fs.realpathSync` on both sides so a symlink
 * planted inside an allowed root cannot exfiltrate to /etc/passwd. If the
 * candidate doesn't exist yet (write path — not our case today), falls
 * back to lexical resolve so the check still works.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

function realOrResolve(p: string): string {
  try { return fs.realpathSync(p); }
  catch {
    // Path doesn't exist — walk up until we hit an existing ancestor, realpath
    // that, then rejoin the missing tail. Needed because macOS tmpdir
    // (/var/folders/...) is itself a symlink to /private/var/..., so plain
    // path.resolve on a nonexistent candidate wouldn't match a realpath-ed
    // existing root.
    const resolved = path.resolve(p);
    let existing = resolved;
    const missing: string[] = [];
    while (existing && existing !== path.dirname(existing)) {
      try { existing = fs.realpathSync(existing); break; }
      catch {
        missing.unshift(path.basename(existing));
        existing = path.dirname(existing);
      }
    }
    return missing.length ? path.join(existing, ...missing) : existing;
  }
}

/**
 * Is `candidate` inside any of `allowedRoots`?
 *
 * Both sides are normalized via realpath to resist symlink escape. A path
 * equal to a root is considered inside (reading the root dir itself is
 * allowed by this function — callers may add a "must be a file" check on
 * top). Containment uses `startsWith(root + sep)` so `/foo/barbaz` is NOT
 * inside `/foo/bar`.
 *
 * Returns false for empty inputs, relative candidate paths, or empty
 * roots list.
 */
export function isPathAllowed(candidate: string, allowedRoots: readonly string[]): boolean {
  if (!candidate || !allowedRoots.length) return false;
  if (!path.isAbsolute(candidate)) return false;

  const realCand = realOrResolve(candidate);
  for (const root of allowedRoots) {
    if (!root || !path.isAbsolute(root)) continue;
    const realRoot = realOrResolve(root);
    if (realCand === realRoot) return true;
    if (realCand.startsWith(realRoot + path.sep)) return true;
  }
  return false;
}
