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
 * candidate does not exist yet, resolves known links and its nearest existing
 * ancestor. Truly unresolvable entries fail closed at authorization.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

function realOrResolve(p: string, identityOnly = false, seenLinks?: Set<string>): string | null {
  try { return fs.realpathSync(p); }
  catch {
    // Missing descendants inherit the real existing ancestor. Existing links
    // retain their actual target even when that target has not been created.
    const resolved = path.resolve(p);
    let existing = resolved;
    const missing: string[] = [];
    while (existing && existing !== path.dirname(existing)) {
      try { existing = fs.realpathSync(existing); break; }
      catch {
        if (!identityOnly) {
          let entry: fs.Stats | undefined;
          try { entry = fs.lstatSync(existing); }
          catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== 'ENOENT' && code !== 'ENOTDIR') return null;
          }
          if (entry) {
            // Only a known symlink target can resolve an existing entry here.
            // Cycles, inaccessible entries and non-directory ancestors deny.
            const links = seenLinks ?? new Set<string>();
            if (!entry.isSymbolicLink() || links.has(existing) || links.size >= 40) return null;
            links.add(existing);
            try {
              const target = path.resolve(path.dirname(existing), fs.readlinkSync(existing), ...missing);
              return realOrResolve(target, false, links);
            } catch { return null; }
          }
        }
        missing.unshift(path.basename(existing));
        existing = path.dirname(existing);
      }
    }
    return missing.length ? path.join(existing, ...missing) : existing;
  }
}

function comparisonKey(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

/**
 * Resolve a root exactly the way `isPathAllowed` resolves it, so a caller
 * that checks many candidates against one fixed root can pay the root's
 * realpath walk once and pass `{ rootsResolved: true }` afterwards.
 */
export function resolveSandboxRoot(root: string): string {
  // Keep best-effort identity compatibility for an unresolvable root; the
  // authorization check still resolves each candidate and rejects unknowns.
  return realOrResolve(root) ?? realOrResolve(root, true) ?? path.resolve(root);
}

/** Resolve an unlink operand without following its final directory entry. */
export function resolveSandboxEntry(candidate: string): string {
  const parent = path.dirname(candidate);
  return path.join(realOrResolve(parent) ?? realOrResolve(parent, true) ?? path.resolve(parent), path.basename(candidate));
}

export interface PathAllowedOptions {
  /** Every entry of `allowedRoots` came from `resolveSandboxRoot`, so the
   *  per-call root realpath walk is skipped. Candidates are always resolved;
   *  an unresolved symlinked root therefore fails closed. */
  rootsResolved?: boolean;
  /** Only for operations that unlink the final entry. Ancestor symlinks still
   * resolve normally; reads, writes and traversals must keep the default. */
  followFinalSymlink?: boolean;
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
export function isPathAllowed(
  candidate: string,
  allowedRoots: readonly string[],
  options: PathAllowedOptions = {},
): boolean {
  if (!candidate || !allowedRoots.length) return false;
  if (!path.isAbsolute(candidate)) return false;

  if (options.followFinalSymlink === false) {
    const parts = candidate.split(path.sep);
    if (!parts.at(-1) || parts.at(-1) === '.' || parts.includes('..')) return false;
  }
  const realParent = options.followFinalSymlink === false
    ? realOrResolve(path.dirname(candidate)) : null;
  const realCand = options.followFinalSymlink === false
    ? (realParent ? path.join(realParent, path.basename(candidate)) : null)
    : realOrResolve(candidate);
  if (!realCand) return false;
  const candidateKey = comparisonKey(realCand);
  for (const root of allowedRoots) {
    if (!root || !path.isAbsolute(root)) continue;
    const realRoot = options.rootsResolved ? root : realOrResolve(root);
    if (!realRoot) continue;
    const rootKey = comparisonKey(realRoot);
    if (candidateKey === rootKey) return true;
    const prefix = rootKey.endsWith(path.sep) ? rootKey : rootKey + path.sep;
    if (candidateKey.startsWith(prefix)) return true;
  }
  return false;
}
