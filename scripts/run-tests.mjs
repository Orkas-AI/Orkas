#!/usr/bin/env node
/**
 * Test wrapper that handles better-sqlite3 ABI swapping around vitest.
 *
 * Flow:
 *   1. Swap `better-sqlite3` .node to current Node ABI (vitest can load it)
 *   2. Spawn vitest with user-provided args
 *   3. On ANY exit path (success / failure / SIGINT / SIGTERM / uncaught),
 *      swap .node back to Electron ABI so the app can start afterwards.
 *
 * Why: vitest 4 requires require(ESM), which Electron 32's bundled Node 20.18
 * doesn't support — so we can't run tests under Electron-as-Node. Running
 * them under plain Node means the .node must briefly match Node's ABI.
 * Leaving it in Node ABI would break `./run.sh` / `npm start`.
 *
 * The signal handlers guarantee recovery even when the user hits Ctrl+C.
 * Only `kill -9` and power loss can leave the module in Node ABI — in that
 * case run `npm run rebuild:sqlite:electron` manually.
 */
import { spawn, spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const swapScript = resolve(here, 'swap-sqlite-abi.mjs');

function swap(mode) {
  const r = spawnSync(process.execPath, [swapScript, mode], { stdio: 'inherit' });
  if (r.status !== 0) {
    console.error(`[run-tests] ABI swap to ${mode} failed (exit ${r.status}).`);
    if (mode === 'electron') {
      console.error('[run-tests] Recover manually: npm run rebuild:sqlite:electron');
    }
    return false;
  }
  return true;
}

let restored = false;
function restoreElectron() {
  if (restored) return;
  restored = true;
  swap('electron');
}

// Best-effort recovery on any process-ending event that gives us a tick.
// SIGKILL / power loss / kernel panic will still bypass this — document in
// MEMORY / CLAUDE.md so humans know the manual fallback.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']) {
  process.on(sig, () => {
    restoreElectron();
    process.exit(130);
  });
}
process.on('uncaughtException', (err) => {
  console.error('[run-tests] uncaughtException:', err);
  restoreElectron();
  process.exit(1);
});
process.on('unhandledRejection', (err) => {
  console.error('[run-tests] unhandledRejection:', err);
  restoreElectron();
  process.exit(1);
});

if (!swap('node')) {
  // If we couldn't swap to node ABI, don't pretend to run tests — but also
  // don't leave the module in an unknown state; try to restore electron.
  restoreElectron();
  process.exit(2);
}

const vitestBin = resolve(here, '..', 'node_modules', 'vitest', 'vitest.mjs');
const child = spawn(process.execPath, [vitestBin, ...process.argv.slice(2)], {
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  restoreElectron();
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
