#!/usr/bin/env node
/**
 * Ensure better-sqlite3's native addon matches the installed Electron ABI.
 *
 * The app and Vitest both load better-sqlite3 through Electron's embedded
 * Node, so node_modules only needs the Electron build. This script is used
 * after install, before packaging, and as the manual repair command.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SQLITE_ABI_PROBE_TIMEOUT_MS = 30_000;
export const SQLITE_ABI_INSTALL_TIMEOUT_MS = 5 * 60_000;

export function describeResult(result) {
  const parts = [];
  if (typeof result.status === 'number') parts.push(`exit ${result.status}`);
  if (result.signal) parts.push(`signal ${result.signal}`);
  if (result.error) parts.push(`error ${result.error.message}`);
  return parts.join(', ') || 'unknown termination';
}

export function firstUsefulLine(value) {
  return String(value || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
}

export function ensureSqliteElectronAbi({
  execPath,
  electronCli,
  electronVersion,
  nativeAddon,
  pcRoot,
  prebuildInstallBin,
  sqliteDir,
  spawn = spawnSync,
  logError = console.error,
}) {
  const probeElectronAbi = ({ quiet = false } = {}) => {
    const requireSnippet = `require(${JSON.stringify(nativeAddon)})`;
    const result = spawn(execPath, [electronCli, '-e', requireSnippet], {
      cwd: pcRoot,
      encoding: 'utf8',
      stdio: 'pipe',
      timeout: SQLITE_ABI_PROBE_TIMEOUT_MS,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
      },
    });

    if (result.status === 0) return true;
    if (!quiet) {
      const detail = describeResult(result);
      const reason = firstUsefulLine(result.stderr) || firstUsefulLine(result.stdout);
      logError(`[ensure-sqlite-electron-abi] Electron ABI probe failed (${detail})${reason ? `: ${reason}` : ''}`);
    }
    return false;
  };

  // Probe in a child process because an incompatible native binary may
  // terminate the process before JavaScript can catch the failure.
  if (probeElectronAbi({ quiet: true })) return 0;

  const result = spawn(execPath, [
    prebuildInstallBin,
    '--runtime', 'electron',
    '--target', electronVersion,
    '--platform', process.platform,
    '--arch', process.arch,
    '--force',
  ], {
    cwd: sqliteDir,
    stdio: 'inherit',
    timeout: SQLITE_ABI_INSTALL_TIMEOUT_MS,
  });

  // The runtime probe is authoritative: prebuild-install can report non-zero
  // after it has already unpacked a usable binary.
  if (probeElectronAbi({ quiet: true })) return 0;

  logError(`[ensure-sqlite-electron-abi] prebuild-install did not produce a loadable Electron ABI (${describeResult(result)})`);
  probeElectronAbi();
  return result.status ?? 1;
}

function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const pcRoot = resolve(here, '..');
  const require_ = createRequire(import.meta.url);
  const prebuildInstallBin = require_.resolve('prebuild-install/bin.js');
  const electronCli = require_.resolve('electron/cli.js');
  const electronPackage = require_.resolve('electron/package.json');
  const sqliteDir = resolve(pcRoot, 'node_modules', 'better-sqlite3');
  const nativeAddon = resolve(sqliteDir, 'build', 'Release', 'better_sqlite3.node');
  const electronVersion = JSON.parse(readFileSync(electronPackage, 'utf8')).version;

  const code = ensureSqliteElectronAbi({
    execPath: process.execPath,
    electronCli,
    electronVersion,
    nativeAddon,
    pcRoot,
    prebuildInstallBin,
    sqliteDir,
  });
  if (code !== 0) process.exit(code);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
