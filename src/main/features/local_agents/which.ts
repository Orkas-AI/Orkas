/**
 * Cross-platform binary lookup. Mirrors `exec.LookPath` semantics.
 *
 * Why we don't use the `which` npm package: keeps the dep allow-list
 * tight, and the logic is short. Single source of truth so registry.ts
 * doesn't carry path-search code.
 *
 * POSIX: scan `process.env.PATH` (split by ':'), plus optional
 * caller-provided directories, stat `<dir>/<name>`, accept if it's a
 * regular file with any executable bit set.
 *
 * Windows: scan PATH (split by ';'), multiply each candidate by
 * `process.env.PATHEXT` (e.g. `.COM;.EXE;.BAT;.CMD`); first stat hit
 * wins. The empty extension is tried only as a fallback because npm installs
 * a POSIX shell shim beside the Windows `.cmd` launcher; selecting that bare
 * file makes an otherwise valid CLI fail its version probe.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

const isWindows = process.platform === 'win32';

/** Scan PATH and return every absolute path matching `name`, in search order. */
export async function whichBins(name: string, opts: { extraDirs?: string[] } = {}): Promise<string[]> {
  if (!name) return [];

  // Absolute or relative path with separator → caller already resolved.
  if (path.isAbsolute(name) || name.includes(path.sep) || (isWindows && name.includes('/'))) {
    return (await isExecutableFile(name)) ? [path.resolve(name)] : [];
  }

  const pathEnv = process.env.PATH ?? '';
  const dirs = uniqueDirs([
    ...pathEnv.split(path.delimiter).filter(Boolean),
    ...(opts.extraDirs ?? []),
  ]);
  if (dirs.length === 0) return [];

  const exts = isWindows ? winExtCandidates() : [''];
  const matches: string[] = [];

  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (await isExecutableFile(candidate)) {
        matches.push(candidate);
        // A bare Windows command and its PATHEXT variants represent
        // alternatives in the same directory. Preserve LookPath semantics
        // within that directory and continue with the next directory.
        break;
      }
    }
  }
  return matches;
}

/** Scan PATH and return the first absolute path matching `name`, or null. */
export async function whichBin(name: string, opts: { extraDirs?: string[] } = {}): Promise<string | null> {
  return (await whichBins(name, opts))[0] ?? null;
}

function uniqueDirs(dirs: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    let value = String(dir || '').trim();
    if (isWindows && value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).trim();
    }
    if (!value) continue;
    const resolved = path.resolve(value);
    const key = isWindows ? resolved.toLowerCase() : resolved;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(resolved);
  }
  return out;
}

/**
 * Returns the candidate extensions to try on Windows. Follow PATHEXT first,
 * matching normal Windows command resolution, then retain the empty extension
 * as a fallback for uncommon native/MinGW installs that use a bare filename.
 */
function winExtCandidates(): string[] {
  const raw = process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD';
  const exts = raw
    .split(';')
    .map(s => s.trim())
    .filter(Boolean);
  return [...exts, ''];
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
