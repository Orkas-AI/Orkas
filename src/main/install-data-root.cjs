/**
 * Platform-aware resolution of the install data root + boot-time env-var
 * initialization. Source-run (dev) and packaged builds resolve to the SAME
 * container — no dev-vs-prod data split.
 *
 * Two responsibilities packed in one file:
 *
 *   1. `resolveInstallContainer()` (exported, pure) — returns the
 *      container directory (without the trailing `/data`); callers append
 *      `/data` and `/userWorkSpace` themselves (the latter is derived
 *      automatically by `paths.ts::DEFAULT_USER_WORKSPACE` via the
 *      `WS_ROOT/../userWorkSpace` sibling convention).
 *
 *      - macOS / Linux: `~/.orkas`
 *      - Windows: drive recorded in `%LOCALAPPDATA%\Orkas\install-pin.json`
 *        (chosen on first launch — lowest-letter non-system fixed drive,
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
  // %LOCALAPPDATA% is set on Win 7+; fallback constructs the canonical path.
  return process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
}

function pinFilePath() {
  return path.join(localAppDataDir(), 'Orkas', 'install-pin.json');
}

function readPin() {
  try {
    const raw = fs.readFileSync(pinFilePath(), 'utf8');
    const obj = JSON.parse(raw);
    if (obj && typeof obj.container === 'string' && obj.container) {
      return { container: obj.container, chosenAt: String(obj.chosenAt || '') };
    }
  } catch {
    /* missing or malformed → null */
  }
  return null;
}

/**
 * Write the pin atomically (`wx` flag = exclusive create). If another
 * process raced and won, defer to its decision when the pinned container
 * is live; overwrite when the existing pin is dead (drive unreachable).
 * Returns the container the caller should actually use.
 *
 * Why: install-data-root.cjs runs at boot, BEFORE
 * `app.requestSingleInstanceLock()` can take effect. Two simultaneous
 * launches both decide a container, both `writePin`, then both `mkdir +
 * migrate` — picking different drives is rare but destructive (user data
 * lands on the wrong drive). `wx` makes the first writer the authority.
 */
function writePin(container) {
  const pinPath = pinFilePath();
  const body = { container, chosenAt: new Date().toISOString() };
  fs.mkdirSync(path.dirname(pinPath), { recursive: true });
  try {
    fs.writeFileSync(pinPath, JSON.stringify(body, null, 2), { flag: 'wx' });
    return container;
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      const winner = readPin();
      if (winner && pinIsLive(winner)) {
        _earlyWarn(
          `[install-data-root] pin race: deferring to existing pin ${winner.container}\n`,
        );
        return winner.container;
      }
      // Stale / dead / unreadable pin — overwrite with our decision.
      try {
        fs.writeFileSync(pinPath, JSON.stringify(body, null, 2), 'utf8');
      } catch (err2) {
        _earlyWarn(
          `[install-data-root] failed to overwrite stale pin: ${err2.message}\n`,
        );
      }
      return container;
    }
    _earlyWarn(`[install-data-root] failed to write pin: ${err.message}\n`);
    return container;
  }
}

function pinIsLive(pin) {
  // The pin records a container path like "D:\.orkas". Consider it live
  // if the drive root is reachable. The container directory itself may
  // not yet exist (first-launch race: pin written, process killed before
  // mkdir of <container>/data) — drive-level reachability is the right
  // signal.
  try {
    const driveRoot = path.parse(pin.container).root;
    if (!driveRoot) return false;
    return fs.existsSync(driveRoot);
  } catch {
    return false;
  }
}

function resolveWindowsContainer() {
  // 1. Pin present + drive reachable → use it.
  const pin = readPin();
  if (pin && pinIsLive(pin)) return pin.container;
  if (pin) {
    _earlyWarn(
      `[install-data-root] pinned container ${pin.container} unreachable; re-deciding\n`,
    );
  }

  // 2. Pin missing / dead → first-launch decision.
  const systemDrive = normalizeDrive(process.env.SystemDrive || 'C:');
  const fixed = listFixedDrivesWin();
  const nonSystem = fixed.filter((d) => d !== systemDrive).sort();

  // 2a. Existing install present → keep it in place.
  for (const d of nonSystem) {
    if (hasExistingInstall(d)) return writePin(containerFor(d));
  }
  if (hasExistingInstall(systemDrive)) return writePin(containerFor(systemDrive));

  // 2b. Fresh install: lowest-letter non-system fixed drive; system drive
  //     fallback when only one fixed drive exists.
  const chosen =
    nonSystem.length > 0 ? containerFor(nonSystem[0]) : containerFor(systemDrive);
  return writePin(chosen);
}

function containerFor(drive) {
  return path.join(drive + '\\', '.orkas');
}

function hasExistingInstall(drive) {
  try {
    return fs.existsSync(path.join(drive + '\\', '.orkas', 'data'));
  } catch {
    return false;
  }
}

function normalizeDrive(s) {
  const m = String(s).toUpperCase().match(/^([A-Z]:)/);
  return m ? m[1] : 'C:';
}

function listFixedDrivesWin() {
  // First choice is PowerShell's Win32_LogicalDisk (built into Win7+);
  // DriveType=3 = DRIVE_FIXED. On failure we'd rather fall back to "system
  // drive only" than use fsutil to list every drive — fsutil can't
  // distinguish fixed / removable / network drives, and we explicitly want
  // the latter two excluded.
  try {
    const out = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | Select-Object -ExpandProperty DeviceID",
      ],
      { encoding: 'utf8', timeout: 5000, windowsHide: true },
    );
    const drives = out
      .split(/\r?\n/)
      .map((s) => s.trim().toUpperCase())
      .filter((s) => /^[A-Z]:$/.test(s));
    if (drives.length > 0) return drives;
  } catch {
    /* fall through */
  }
  return [normalizeDrive(process.env.SystemDrive || 'C:')];
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
      `[install-data-root] source-run data migration failed: ${err.message}\n`,
    );
  }

  const ws = path.join(container, 'data');
  fs.mkdirSync(ws, { recursive: true });
  process.env.ORKAS_WORKSPACE_ROOT = ws;
})();

module.exports = { resolveInstallContainer, flushEarlyDiagnostics };
