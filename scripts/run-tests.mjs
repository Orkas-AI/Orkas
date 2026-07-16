#!/usr/bin/env node
/**
 * Run Vitest with Electron's embedded Node runtime.
 *
 * The application loads native addons such as better-sqlite3 under Electron.
 * Running tests under the same runtime keeps one native ABI in node_modules and
 * avoids rebuilding the addon before and after every test run.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const electronBin = require_('electron');
const vitestBin = resolve(here, '..', 'node_modules', 'vitest', 'vitest.mjs');

const child = spawn(electronBin, [vitestBin, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    // Test files that need to launch standalone JS helpers must not reuse
    // Electron's process.execPath: if they replace the child environment and
    // drop ELECTRON_RUN_AS_NODE, macOS launches another GUI app. Preserve the
    // outer npm/node executable as the explicit test-helper runtime.
    ORKAS_TEST_NODE: process.execPath,
  },
});

let forwardedSignal = null;
const signalHandlers = new Map();

function removeSignalHandlers() {
  for (const [signal, handler] of signalHandlers) {
    process.off(signal, handler);
  }
  signalHandlers.clear();
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT']) {
  const handler = () => {
    if (forwardedSignal) return;
    forwardedSignal = signal;
    if (!child.killed) child.kill(signal);
  };
  signalHandlers.set(signal, handler);
  process.on(signal, handler);
}

child.once('error', (error) => {
  removeSignalHandlers();
  console.error(`[run-tests] failed to start Electron's Node runtime: ${error.message}`);
  process.exitCode = 1;
});

child.once('exit', (code, signal) => {
  removeSignalHandlers();
  const terminalSignal = forwardedSignal || signal;
  if (terminalSignal) {
    process.kill(process.pid, terminalSignal);
    return;
  }
  process.exit(code ?? 1);
});
