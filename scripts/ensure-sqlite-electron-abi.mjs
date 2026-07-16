#!/usr/bin/env node
/**
 * Ensure better-sqlite3's native addon matches the installed Electron ABI.
 *
 * The app and Vitest both load better-sqlite3 through Electron's embedded Node,
 * so node_modules only needs the Electron build. This script is used after
 * install, before packaging, and as the manual repair command.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pcRoot = resolve(here, '..');
const require_ = createRequire(import.meta.url);

const prebuildInstallBin = require_.resolve('prebuild-install/bin.js');
const electronCli = require_.resolve('electron/cli.js');
const electronPackage = require_.resolve('electron/package.json');
const sqliteDir = resolve(pcRoot, 'node_modules', 'better-sqlite3');
const nativeAddon = resolve(sqliteDir, 'build', 'Release', 'better_sqlite3.node');

function describeResult(result) {
  const parts = [];
  if (typeof result.status === 'number') parts.push(`exit ${result.status}`);
  if (result.signal) parts.push(`signal ${result.signal}`);
  if (result.error) parts.push(`error ${result.error.message}`);
  return parts.join(', ') || 'unknown termination';
}

function firstUsefulLine(value) {
  return String(value || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
}

function probeElectronAbi({ quiet = false } = {}) {
  const requireSnippet = `require(${JSON.stringify(nativeAddon)})`;
  const result = spawnSync(process.execPath, [electronCli, '-e', requireSnippet], {
    cwd: pcRoot,
    encoding: 'utf8',
    stdio: 'pipe',
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
    },
  });

  if (result.status === 0) return true;
  if (!quiet) {
    const detail = describeResult(result);
    const reason = firstUsefulLine(result.stderr) || firstUsefulLine(result.stdout);
    console.error(`[ensure-sqlite-electron-abi] Electron ABI probe failed (${detail})${reason ? `: ${reason}` : ''}`);
  }
  return false;
}

// Avoid downloading or rebuilding when the currently installed addon already
// loads under Electron. Probe in a child process because an incompatible native
// binary may terminate the process before JavaScript can catch the failure.
if (probeElectronAbi({ quiet: true })) {
  process.exit(0);
}

const electronVersion = JSON.parse(readFileSync(electronPackage, 'utf8')).version;
const result = spawnSync(process.execPath, [
  prebuildInstallBin,
  '-r', 'electron',
  '-t', electronVersion,
], {
  cwd: sqliteDir,
  stdio: 'inherit',
});

// Treat the runtime probe as authoritative: prebuild-install can occasionally
// report a non-zero status after it has already unpacked a usable binary.
if (probeElectronAbi({ quiet: true })) {
  process.exit(0);
}

console.error(`[ensure-sqlite-electron-abi] prebuild-install did not produce a loadable Electron ABI (${describeResult(result)})`);
probeElectronAbi();
process.exit(result.status ?? 1);
