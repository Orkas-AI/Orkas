/**
 * Platform-aware resolution of the install data root + boot-time env-var
 * initialization. Source-run (dev) and packaged builds resolve to the SAME
 * container — no dev-vs-prod data split.
 *
 * Two responsibilities packed in one file:
 *
 *   1. `resolveInstallContainer()` (exported) — returns the
 *      container directory (without the trailing `/data`); callers append
 *      `/data` and `/userWorkSpace` themselves (the latter is derived
 *      automatically by `paths.ts::DEFAULT_USER_WORKSPACE` via the
 *      `WS_ROOT/../userWorkSpace` sibling convention).
 *
 *      - macOS / Linux: `~/.orkas`
 *      - Windows: drive recorded in `%LOCALAPPDATA%\Orkas\install-pin.json`
 *        (chosen on first launch — lowest-letter verified local non-system drive,
 *        fallback `C:`). The pin file lives in LocalAppData
 *        (machine-private), not Roaming (cross-machine), because it
 *        records a drive choice on THIS machine.
 *
 *   2. **Module-load side effect** — the `_initInstallRoot()` IIFE at the
 *      bottom resolves the container, runs the one-shot source-run
 *      `<repoRoot>/data` → `<container>/data` migration, and sets
 *      `process.env.ORKAS_WORKSPACE_ROOT`. **This MUST be a `.cjs` file
 *      called from `bootstrap.cjs` BEFORE `tsx/cjs` is registered:** any
 *      TypeScript module that touches `paths.ts` reads `WS_ROOT` from the
 *      env var at module-load time, and TS import hoisting would otherwise
 *      let `paths.ts` snapshot an unset env var before `index.ts` body
 *      could set it. CJS require has no hoisting; doing this in
 *      bootstrap.cjs's pre-tsx phase keeps the contract simple.
 *
 *      `ORKAS_WORKSPACE_ROOT` already set → short-circuit, letting tests
 *      (`test/setup-env.ts`) and power users override the whole flow.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

// Early-boot diagnostics buffer. This file runs before logger.ts can be
// loaded (logger imports paths.ts, which depends on the env var THIS file
// sets), so logger calls aren't available yet. Warnings are buffered here
// and `flushEarlyDiagnostics` replays them into the daily log after
// `initLogger()`, so post-mortem on pin / migration decisions doesn't
// require attaching terminal output.
const _earlyDiagnostics = [];
function _earlyWarn(msg) {
  _earlyDiagnostics.push(msg);
  process.stderr.write(msg);
}

function flushEarlyDiagnostics(sink) {
  for (const m of _earlyDiagnostics) sink(m.replace(/\n+$/, ''));
  _earlyDiagnostics.length = 0;
}

function resolveInstallContainer() {
  if (process.platform === 'win32') return resolveWindowsContainer();
  return path.join(os.homedir(), '.orkas');
}

// ── Windows pin file ─────────────────────────────────────────────────────

function localAppDataDir() {
  return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
}
function pinFilePath() {
  return path.join(localAppDataDir(), 'Orkas', 'install-pin.json');
}
function rootError(code) {
  // Never include a private path or the raw filesystem/provider exception.
  return Object.assign(new Error(code), { code });
}
function readPinSnapshot() {
  let stat;
  try {
    stat = fs.lstatSync(pinFilePath());
  }
  catch (error) {
    if (error.code === 'ENOENT')
      return { pin: null, raw: null };
    throw rootError('E_INSTALL_PIN_UNREADABLE');
  }
  try {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65_536) {
      throw rootError('E_INSTALL_PIN_INVALID');
    }
    const raw = fs.readFileSync(pinFilePath(), 'utf8');
    const obj = JSON.parse(raw);
    const container = typeof obj?.container === 'string' && obj.container ? obj.container : null;
    if (!container)
      throw rootError('E_INSTALL_PIN_INVALID');
    return { raw, pin: { container, chosenAt: String(obj.chosenAt || '') } };
  }
  catch (error) {
    throw rootError('E_INSTALL_PIN_UNREADABLE');
  }
}
function containerFor(drive) {
  return path.win32.join(drive + '\\', '.orkas');
}
/** Positive emptiness only. A missing/offline drive is never an empty install. */
function realDataState(container) {
  try {
    const root = fs.lstatSync(path.win32.parse(container).root);
    if (!root.isDirectory() || root.isSymbolicLink())
      return 'unknown';
    let stat;
    try {
      stat = fs.lstatSync(container);
    }
    catch (error) {
      return error.code === 'ENOENT' ? 'empty' : 'unknown';
    }
    if (!stat.isDirectory() || stat.isSymbolicLink())
      return 'unknown';
    const directory = fs.opendirSync(container);
    try {
      let entry;
      // Do not descend into data_test or use test/dev state as user data.
      while ((entry = directory.readSync())) {
        const name = entry.name.toLowerCase();
        if (name === 'data_test' || name === 'devtools-startup.json')
          continue;
        if (name !== 'data' && name !== 'userworkspace')
          return 'present';
        const target = path.join(container, entry.name);
        const childStat = fs.lstatSync(target);
        if (!childStat.isDirectory() || childStat.isSymbolicLink())
          return 'unknown';
        const child = fs.opendirSync(target);
        try {
          if (child.readSync())
            return 'present';
        }
        finally {
          child.closeSync();
        }
      }
      return 'empty';
    }
    finally {
      directory.closeSync();
    }
  }
  catch {
    return 'unknown';
  }
}
/** Empty preparation directories are not evidence of an existing user install. */
function hasExistingInstall(drive) {
  const state = realDataState(containerFor(drive));
  if (state === 'unknown')
    throw rootError('E_INSTALL_DATA_UNREADABLE');
  return state === 'present';
}
function prepareWindowsContainer(container) {
  // Probe actual production directories, never data_test. Leave preexisting
  // files alone, and clean up only the unique files owned by this attempt.
  for (const name of ['data', 'userWorkSpace']) {
    const target = path.join(container, name);
    fs.mkdirSync(target, { recursive: true });
    const temporary = path.join(target, `.orkas-write-probe-${randomUUID()}`);
    const renamed = temporary + '.renamed';
    try {
      fs.writeFileSync(temporary, 'orkas-data-root-probe', { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, renamed);
      if (fs.readFileSync(renamed, 'utf8') !== 'orkas-data-root-probe')
        throw rootError('E_INSTALL_PROBE_FAILED');
    }
    finally {
      for (const file of [temporary, renamed]) {
        try {
          fs.unlinkSync(file);
        }
        catch (error) {
          if (error.code !== 'ENOENT')
            throw rootError('E_INSTALL_PROBE_CLEANUP');
        }
      }
    }
  }
}
function driveKind(drives, container) {
  const id = path.win32.parse(container).root.slice(0, 2).toUpperCase();
  return drives.find(drive => drive.id === id)?.kind || 'unknown';
}
/** Serialized, atomic publication; a competing or damaged pin is never overwritten. */
function writePin(container, before, deadline) {
  const pinPath = pinFilePath(), lock = pinPath + '.lock';
  fs.mkdirSync(path.dirname(pinPath), { recursive: true });
  try {
    fs.mkdirSync(lock);
  }
  catch (error) {
    if (error.code !== 'EEXIST')
      throw rootError('E_INSTALL_PIN_WRITE');
    const winner = readPinSnapshot();
    if (winner.pin && winner.raw !== before.raw)
      return winner.pin.container;
    // Do not steal a lock from a possibly paused or live writer. A crashed
    // publication requires explicit recovery, rather than risking split roots.
    throw rootError('E_INSTALL_PIN_BUSY');
  }
  const temporary = pinPath + '.' + randomUUID() + '.tmp';
  try {
    let current = readPinSnapshot();
    if (current.raw !== before.raw) {
      if (current.pin)
        return current.pin.container;
      throw rootError('E_INSTALL_PIN_CHANGED');
    }
    if (before.pin) {
      // Recheck both independent conditions at the publication boundary.
      const currentDrives = listWindowsDrives(deadline);
      if (driveKind(currentDrives, before.pin.container) !== 'nonlocal'
        || realDataState(before.pin.container) !== 'empty')
        return before.pin.container;
    }
    const body = { container, chosenAt: new Date().toISOString() };
    fs.writeFileSync(temporary, JSON.stringify(body, null, 2), { flag: 'wx', mode: 0o600 });
    const fd = fs.openSync(temporary, 'r+');
    try {
      fs.fsyncSync(fd);
    }
    finally {
      fs.closeSync(fd);
    }
    current = readPinSnapshot();
    if (current.raw !== before.raw) {
      if (current.pin)
        return current.pin.container;
      throw rootError('E_INSTALL_PIN_CHANGED');
    }
    if (before.pin && realDataState(before.pin.container) !== 'empty')
      return before.pin.container;
    fs.renameSync(temporary, pinPath);
    return container;
  }
  catch {
    throw rootError('E_INSTALL_PIN_WRITE');
  }
  finally {
    try {
      fs.unlinkSync(temporary);
    }
    catch { /* only our temporary file */ }
    try {
      fs.rmdirSync(lock);
    }
    catch { /* never recursively remove a lock */ }
  }
}
function resolveWindowsContainer() {
  const before = readPinSnapshot();
  // Common repeat launches avoid PowerShell entirely. Real data or an
  // unreadable/offline root is enough to prohibit any automatic relocation.
  if (before.pin && realDataState(before.pin.container) !== 'empty')
    return before.pin.container;
  const deadline = Date.now() + 5_000;
  const drives = listWindowsDrives(deadline);
  if (before.pin) {
    // Existing local/unknown/unreachable roots are authoritative, even empty
    // or unwritable. Failure to inspect a provider is never relocation consent.
    if (!normalizeWindowsPinnedContainer(before.pin.container) || driveKind(drives, before.pin.container) !== 'nonlocal'
      || realDataState(before.pin.container) !== 'empty')
      return before.pin.container;
  }
  const systemDrive = normalizeWindowsDrive(process.env.SystemDrive || 'C:');
  const local = drives.filter(drive => drive.kind === 'local').map(drive => drive.id);
  const ordered = [...new Set(local)].filter(drive => drive !== systemDrive).sort();
  ordered.push(systemDrive);
  const preferred = chooseWindowsInstallDrive(systemDrive, local, hasExistingInstall);
  const existing = hasExistingInstall(preferred) ? preferred : undefined;
  for (const drive of existing ? [existing] : ordered) {
    const container = containerFor(drive);
    try {
      prepareWindowsContainer(container);
    }
    catch {
      if (existing)
        throw rootError('E_INSTALL_DATA_UNAVAILABLE');
      continue;
    }
    // Persistence failure is terminal: never start durable work at an
    // unrecorded alternate location, or fallback after migration has begun.
    return writePin(container, before, deadline);
  }
  throw rootError('E_INSTALL_DATA_UNAVAILABLE');
}
function normalizeWindowsDrive(s) {
  const m = String(s).toUpperCase().match(/^([A-Z]:)/);
  return m ? m[1] : 'C:';
}
function normalizeWindowsPinnedContainer(value) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim())
    return null;
  const normalized = path.win32.normalize(value);
  const match = /^([A-Z]):\\\.orkas\\?$/i.exec(normalized);
  return match ? `${match[1].toUpperCase()}:\\.orkas` : null;
}
function chooseWindowsInstallDrive(systemDriveRaw, fixedDrivesRaw, hasInstall) {
  const systemDrive = normalizeWindowsDrive(systemDriveRaw);
  const nonSystem = [...new Set(fixedDrivesRaw.map(normalizeWindowsDrive))].filter(drive => drive !== systemDrive).sort();
  return nonSystem.find(hasInstall) || (hasInstall(systemDrive) ? systemDrive : nonSystem[0] || systemDrive);
}
/** @returns {{file: string, args: string[], options: {encoding: 'utf8', timeout: number, windowsHide: true, maxBuffer: number}}} */
function windowsFixedDriveProbe(env = process.env, timeout = 5_000) {
  // Structured OS facts only: a missing partition association is UNKNOWN,
  // not evidence that an existing selection is a cloud/network volume.
  const command = [
    "$ErrorActionPreference='Stop'",
    "$rows=@(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3 OR DriveType=4' | ForEach-Object {",
    "$kind='unknown'",
    "if ($_.DriveType -eq 4 -or $_.ProviderName) { $kind='nonlocal' } else {",
    "try { if (@(Get-CimAssociatedInstance -InputObject $_ -Association Win32_LogicalDiskToPartition -ErrorAction Stop).Count -gt 0) { $kind='local' } } catch { $kind='unknown' }",
    "}",
    "[PSCustomObject]@{id=$_.DeviceID;kind=$kind}",
    '})',
    '[PSCustomObject]@{version=1;drives=$rows} | ConvertTo-Json -Compress -Depth 4',
  ].join('\n');
  return {
    file: path.win32.join(env.SystemRoot || env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
    options: { encoding: 'utf8', timeout: Math.max(1, timeout), windowsHide: true, maxBuffer: 65_536 },
  };
}
function parseWindowsDriveInventory(output) {
  const doc = JSON.parse(output.replace(/^\uFEFF/, ''));
  if (doc?.version !== 1 || !Array.isArray(doc.drives) || doc.drives.length > 26)
    throw rootError('E_INSTALL_DRIVES_INVALID');
  const seen = new Set();
  return doc.drives.map((row) => {
    if (typeof row?.id !== 'string' || !/^[A-Z]:$/i.test(row.id)
      || !['local', 'nonlocal', 'unknown'].includes(String(row.kind)))
      throw rootError('E_INSTALL_DRIVES_INVALID');
    const id = row.id.toUpperCase();
    if (seen.has(id))
      throw rootError('E_INSTALL_DRIVES_INVALID');
    seen.add(id);
    return { id, kind: row.kind };
  });
}
function listWindowsDrives(deadline) {
  if (Date.now() >= deadline)
    return [];
  try {
    const probe = windowsFixedDriveProbe(process.env, deadline - Date.now());
    return parseWindowsDriveInventory(execFileSync(probe.file, probe.args, probe.options));
  }
  catch {
    return [];
  }
}

// ── Module-load setup ────────────────────────────────────────────────────
// IIFE: resolve the container, migrate any pre-unification source-run data
// into it, and set `ORKAS_WORKSPACE_ROOT`. Runs once at require time. The
// `ORKAS_WORKSPACE_ROOT` short-circuit lets tests / power users override
// the whole flow by pre-setting the env var.
(function _initInstallRoot() {
  if (process.env.ORKAS_WORKSPACE_ROOT) return;

  const container = resolveInstallContainer();

  // Migration is best-effort: a failure here should not block boot. The
  // source-run `<repoRoot>/data` is left in place for retry;
  // `<container>/data` is still mkdir'd below so paths.ts has a usable
  // WS_ROOT either way.
  try {
    const { migrateSourceDataRoot } = require('./util/migrate-source-data-root.cjs');
    migrateSourceDataRoot(container);
  } catch (err) {
    _earlyWarn(
      '[install-data-root] source-run data migration failed\n',
    );
  }

  const ws = path.join(container, 'data');
  fs.mkdirSync(ws, { recursive: true });
  process.env.ORKAS_WORKSPACE_ROOT = ws;
})();

module.exports = { resolveInstallContainer, flushEarlyDiagnostics, parseWindowsDriveInventory, windowsFixedDriveProbe };
