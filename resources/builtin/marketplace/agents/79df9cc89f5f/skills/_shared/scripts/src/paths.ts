/**
 * Where the bundled runtimes are, for the skill scripts: `runtimeResourcesDir` as in
 * PC/src/main/paths.ts, and the PC root found from where a script runs, since a built core
 * does not sit where the host's paths.ts does. The scripts read no other host path, so this
 * is not a copy of the host's data layout.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

function scriptPathIsFile(p: string): boolean {
  try { return fs.statSync(p).isFile(); }
  catch { return false; }
}

function scriptPathIsDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory(); }
  catch { return false; }
}

function looksLikePcRoot(dir: string): boolean {
  return scriptPathIsFile(path.join(dir, 'package.json'))
    && scriptPathIsDir(path.join(dir, 'resources'))
    && scriptPathIsDir(path.join(dir, 'src'));
}

function resolvePcRoot(): string {
  if (process.env.ORKAS_PC_DIR) return path.resolve(process.env.ORKAS_PC_DIR);
  if (looksLikePcRoot(process.cwd())) return process.cwd();
  const cwdPc = path.join(process.cwd(), 'PC');
  if (looksLikePcRoot(cwdPc)) return cwdPc;

  let dir = __dirname;
  for (;;) {
    if (looksLikePcRoot(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(__dirname, '..', '..');
}

const PC_ROOT = resolvePcRoot();

/** Runtime binaries shipped via electron-builder `extraResources`.
 *
 *   dev:    PC/resources/runtime/
 *   packed: <app>/Contents/Resources/runtime/      (darwin)
 *           <app>/resources/runtime/               (win/linux)
 */
export function runtimeResourcesDir(): string {
  const rp = (process as unknown as { resourcesPath?: string }).resourcesPath;
  if (rp && !rp.includes(`${path.sep}node_modules${path.sep}electron${path.sep}`)) {
    return path.join(rp, 'runtime');
  }
  return path.join(PC_ROOT, 'resources', 'runtime');
}
