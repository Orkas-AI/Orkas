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
import { delimiter, dirname, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SQLITE_ABI_PROBE_TIMEOUT_MS = 30_000;
export const SQLITE_ABI_INSTALL_TIMEOUT_MS = 5 * 60_000;
export const SQLITE_ABI_REBUILD_TIMEOUT_MS = 10 * 60_000;
export const ELECTRON_BINARY_INSTALL_TIMEOUT_MS = 10 * 60_000;

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

export function nativeBuildEnvironment({
  env = process.env,
  platform = process.platform,
  sdkRoot = '',
} = {}) {
  const next = { ...env };
  // The rebuild CLI itself is a Node program. Do not let a parent app's
  // Electron-as-Node marker leak into any helper process it launches.
  delete next.ELECTRON_RUN_AS_NODE;
  if (platform !== 'darwin' || !sdkRoot) return next;

  next.SDKROOT = sdkRoot;
  // `platform` may deliberately differ from the host while preparing a target
  // build. Keep a macOS SDK path POSIX-shaped even when this helper is tested
  // or orchestrated from Windows.
  const libcxx = posix.join(sdkRoot, 'usr', 'include', 'c++', 'v1');
  next.CPLUS_INCLUDE_PATH = [libcxx, env.CPLUS_INCLUDE_PATH]
    .filter(Boolean)
    .join(delimiter);
  return next;
}

export function ensureElectronBinary({
  electronInstall,
  electronVersion,
  electronVersionFile,
  execPath,
  pcRoot,
  spawn = spawnSync,
  readVersion = () => readFileSync(electronVersionFile, 'utf8'),
  logError = console.error,
}) {
  const installedVersion = () => {
    try {
      return String(readVersion()).trim().replace(/^v/, '');
    } catch {
      return '';
    }
  };
  if (installedVersion() === electronVersion) return 0;

  const result = spawn(execPath, [electronInstall], {
    cwd: pcRoot,
    stdio: 'inherit',
    timeout: ELECTRON_BINARY_INSTALL_TIMEOUT_MS,
  });
  // The version file is authoritative. An installer may report a late cleanup
  // failure after atomically installing the complete requested binary.
  if (installedVersion() === electronVersion) return 0;

  logError(
    `[ensure-sqlite-electron-abi] Electron ${electronVersion} binary install failed `
    + `(${describeResult(result)})`,
  );
  return typeof result.status === 'number' && result.status !== 0 ? result.status : 1;
}

export function ensureSqliteElectronAbi({
  execPath,
  electronCli,
  electronRebuildBin,
  electronVersion,
  nativeAddon,
  pcRoot,
  prebuildInstallBin,
  rebuildEnv = process.env,
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

  // Some Electron majors intentionally have no published better-sqlite3
  // prebuild. Compile only this module from source against Electron's exact
  // headers instead of leaving npm's host-Node binary in place.
  const rebuildResult = spawn(execPath, [
    electronRebuildBin,
    '--version', electronVersion,
    '--module-dir', pcRoot,
    '--which-module', 'better-sqlite3',
    '--force',
    '--build-from-source',
  ], {
    cwd: pcRoot,
    env: rebuildEnv,
    stdio: 'inherit',
    timeout: SQLITE_ABI_REBUILD_TIMEOUT_MS,
  });
  if (probeElectronAbi({ quiet: true })) return 0;

  logError(
    `[ensure-sqlite-electron-abi] prebuild-install did not produce a loadable Electron ABI `
    + `(${describeResult(result)}); source rebuild also failed (${describeResult(rebuildResult)})`,
  );
  probeElectronAbi();
  return rebuildResult.status ?? result.status ?? 1;
}

function main() {
  const here = dirname(fileURLToPath(import.meta.url));
  const pcRoot = resolve(here, '..');
  const require_ = createRequire(import.meta.url);
  const prebuildInstallBin = require_.resolve('prebuild-install/bin.js');
  const electronCli = require_.resolve('electron/cli.js');
  const electronInstall = require_.resolve('electron/install.js');
  const electronRebuildBin = resolve(dirname(require_.resolve('@electron/rebuild')), 'cli.js');
  const electronPackage = require_.resolve('electron/package.json');
  const electronVersionFile = resolve(dirname(electronPackage), 'dist', 'version');
  const sqliteDir = resolve(pcRoot, 'node_modules', 'better-sqlite3');
  const nativeAddon = resolve(sqliteDir, 'build', 'Release', 'better_sqlite3.node');
  const electronVersion = JSON.parse(readFileSync(electronPackage, 'utf8')).version;
  const sdkProbe = process.platform === 'darwin'
    ? spawnSync('xcrun', ['--sdk', 'macosx', '--show-sdk-path'], { encoding: 'utf8' })
    : null;
  const rebuildEnv = nativeBuildEnvironment({
    sdkRoot: sdkProbe?.status === 0 ? String(sdkProbe.stdout || '').trim() : '',
  });

  const electronCode = ensureElectronBinary({
    electronInstall,
    electronVersion,
    electronVersionFile,
    execPath: process.execPath,
    pcRoot,
  });
  if (electronCode !== 0) {
    process.exit(electronCode);
  }

  const code = ensureSqliteElectronAbi({
    execPath: process.execPath,
    electronCli,
    electronRebuildBin,
    electronVersion,
    nativeAddon,
    pcRoot,
    prebuildInstallBin,
    rebuildEnv,
    sqliteDir,
  });
  if (code !== 0) process.exit(code);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
