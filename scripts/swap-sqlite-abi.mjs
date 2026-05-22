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
const nativeAddon = resolve(sqliteDir, 'build', 'Release', 'better_sqlite3.node');

function describeResult(result) {
  const parts = [];
  if (typeof result.status === 'number') parts.push(`exit ${result.status}`);
  if (result.signal) parts.push(`signal ${result.signal}`);
  if (result.error) parts.push(`error ${result.error.message}`);
  return parts.join(', ') || 'unknown termination';
}

function firstUsefulLine(text) {
  return String(text || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean) || '';
}

function probeAbi(targetMode, { quiet = false } = {}) {
  const requireSnippet = `require(${JSON.stringify(nativeAddon)})`;
  const args = targetMode === 'electron'
    ? [require_.resolve('electron/cli.js'), '-e', requireSnippet]
    : ['-e', requireSnippet];
  const result = spawnSync(process.execPath, args, {
    cwd: pcRoot,
    encoding: 'utf8',
    stdio: 'pipe',
    env: targetMode === 'electron'
      ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
      : process.env,
  });
  if (result.status === 0) return true;
  if (!quiet) {
    const detail = describeResult(result);
    const reason = firstUsefulLine(result.stderr) || firstUsefulLine(result.stdout);
    console.error(`[swap-sqlite-abi] ${targetMode} ABI probe failed (${detail})${reason ? `: ${reason}` : ''}`);
  }
  return false;
}

function rebuildNodeFromSource() {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return spawnSync(npm, ['rebuild', 'better-sqlite3'], {
    cwd: pcRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      npm_config_build_from_source: 'better-sqlite3',
    },
  });
}

// Fast-path: probe the target runtime before touching the binary. Probe in a
// child process instead of `require()`ing in this process: a bad native addon
// can be killed by the OS before JS can catch an exception, and the wrapper
// would only see `exit null`.
if (probeAbi(mode, { quiet: true })) {
  process.exit(0);
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

// Some local environments have killed `prebuild-install` after the tarball was
// already unpacked. Treat the post-install ABI probe as authoritative.
if (probeAbi(mode, { quiet: true })) {
  process.exit(0);
}

if (mode === 'node') {
  console.error(`[swap-sqlite-abi] prebuild-install did not produce a loadable node ABI (${describeResult(result)}); rebuilding better-sqlite3 from source...`);
  const rebuild = rebuildNodeFromSource();
  if (probeAbi('node', { quiet: true })) {
    process.exit(0);
  }
  console.error(`[swap-sqlite-abi] source rebuild did not produce a loadable node ABI (${describeResult(rebuild)})`);
  probeAbi('node');
  process.exit(rebuild.status ?? result.status ?? 1);
}

console.error(`[swap-sqlite-abi] prebuild-install did not produce a loadable ${mode} ABI (${describeResult(result)})`);
probeAbi(mode);
process.exit(result.status ?? 1);
