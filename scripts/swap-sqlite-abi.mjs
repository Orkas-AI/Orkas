#!/usr/bin/env node
/**
 * Switch `better-sqlite3`'s native .node binary between:
 *   - Electron runtime ABI (for running the app via `electron .`)
 *   - System Node runtime ABI (for running vitest under plain node)
 *
 * Why: better-sqlite3 is a C++ addon. Its .node file must match the
 * NODE_MODULE_VERSION of the runtime that loads it. Electron 32 ships
 * Node 20.18 (v128); our host Node (see @types/node dev dep) is newer
 * (v141+). A single .node file can't serve both — vitest 4 requires
 * require(ESM) which Electron's Node 20.18 lacks, so we can't just run
 * tests under Electron-as-Node. We swap per-context instead.
 *
 * Usage:
 *   node scripts/swap-sqlite-abi.mjs electron
 *   node scripts/swap-sqlite-abi.mjs node
 *
 * Relies on prebuild-install (already a transitive dep of better-sqlite3)
 * — cache hits take ~1-2s. Invoked via the package's JS entry instead of
 * the .bin stub to stay cross-platform (Windows .bin dir holds .cmd / .ps1
 * that can't be spawned without shell: true).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pcRoot = resolve(here, '..');
const require_ = createRequire(import.meta.url);

const mode = process.argv[2];
if (mode !== 'electron' && mode !== 'node') {
  console.error('usage: node scripts/swap-sqlite-abi.mjs <electron|node>');
  process.exit(2);
}

const prebuildInstallBin = require_.resolve('prebuild-install/bin.js');
const sqliteDir = resolve(pcRoot, 'node_modules', 'better-sqlite3');

// Fast-path: when target is `node`, the swap script itself runs under Node,
// so a successful `require()` of the .node file proves it already matches
// current Node's ABI — no need to invoke prebuild-install. Saves 1-2s on
// repeat runs and dodges environments where spawning a grandchild Node
// process is blocked (e.g. sandboxed shells that SIGKILL nested execve).
//
// `electron` mode has no symmetric check (current process is Node, can't
// verify Electron ABI without spawning Electron-as-Node) — fall through.
if (mode === 'node') {
  try {
    require_(resolve(sqliteDir, 'build', 'Release', 'better_sqlite3.node'));
    process.exit(0);
  } catch {
    /* mismatch / missing → run prebuild-install below */
  }
}

const args = [prebuildInstallBin];
if (mode === 'electron') {
  // Read electron version from PC/package.json devDependencies so we don't
  // drift when the app upgrades Electron.
  const pkg = JSON.parse(readFileSync(resolve(pcRoot, 'package.json'), 'utf8'));
  const spec = pkg.devDependencies?.electron ?? '';
  const major = spec.match(/\d+/)?.[0];
  if (!major) {
    console.error('[swap-sqlite-abi] cannot derive Electron major version from package.json devDependencies.electron');
    process.exit(2);
  }
  args.push('-r', 'electron', '-t', `${major}.0.0`);
}
// `node` mode: no args → prebuild-install defaults to current Node ABI.

const result = spawnSync(process.execPath, args, {
  cwd: sqliteDir,
  stdio: 'inherit',
});

if (result.status !== 0) {
  console.error(`[swap-sqlite-abi] prebuild-install exited with ${result.status}`);
  process.exit(result.status ?? 1);
}
