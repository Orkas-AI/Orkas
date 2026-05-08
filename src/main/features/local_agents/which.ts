/**
 * Cross-platform binary lookup. Mirrors `exec.LookPath` semantics.
 *
 * Why we don't use the `which` npm package: keeps the dep allow-list
 * tight, and the logic is short. Single source of truth so registry.ts
 * doesn't carry path-search code.
 *
 * POSIX: scan `process.env.PATH` (split by ':'), stat `<dir>/<name>`,
 * accept if it's a regular file with any executable bit set.
 *
 * Windows: scan PATH (split by ';'), multiply each candidate by
 * `process.env.PATHEXT` (e.g. `.COM;.EXE;.BAT;.CMD`); first stat hit
 * wins. The empty extension is also tried first because some installs
 * drop bare names (PowerShell shims, MinGW, etc.).
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const isWindows = process.platform === 'win32';

/** Scan PATH and return the first absolute path matching `name`, or null. */
export async function whichBin(name: string): Promise<string | null> {
  if (!name) return null;

  // Absolute or relative path with separator → caller already resolved.
  if (path.isAbsolute(name) || name.includes(path.sep) || (isWindows && name.includes('/'))) {
    return (await isExecutableFile(name)) ? path.resolve(name) : null;
  }

  const pathEnv = process.env.PATH ?? '';
  const dirs = pathEnv.split(path.delimiter).filter(Boolean);
  if (dirs.length === 0) return null;

  const exts = isWindows ? winExtCandidates() : [''];

  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (await isExecutableFile(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

/**
 * Returns the candidate extensions to try on Windows, with the empty
 * extension first so an exact-name hit (rare but possible) short-circuits.
 */
function winExtCandidates(): string[] {
  const raw = process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD';
  const exts = raw
    .split(';')
    .map(s => s.trim())
    .filter(Boolean);
  // Always try the bare name first.
  return ['', ...exts];
}

/**
 * stat-and-check; resolves to false on any error (ENOENT, EACCES, etc.)
 * so callers don't need to wrap.
 *
 * On POSIX we additionally require the executable bit; on Windows the
 * extension match is enough (NTFS doesn't carry a unix-style x bit and
 * fs.stat's `mode` is synthesized).
 */
async function isExecutableFile(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    if (!st.isFile()) return false;
    if (isWindows) return true;
    // 0o111 = any of user/group/other execute.
    return (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}
