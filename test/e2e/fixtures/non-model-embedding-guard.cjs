'use strict';

// Explicit test-only policy: retain missing-fixture failures, never fake vectors.
if (process.env.ORKAS_E2E_FORBID_REAL_EMBEDDING === '1') {
  if (!process.versions.electron || process.env.ELECTRON_RUN_AS_NODE === '1') {
    throw new Error('The non-model guard requires an Electron application preload');
  }
  const fs = require('node:fs');
  const path = require('node:path');
  const { app, utilityProcess } = require('electron');
  const { randomUUID } = require('node:crypto');
  const directory = process.env.ORKAS_E2E_MODEL_GUARD_LOG_DIR;
  if (!app || typeof app.once !== 'function'
    || !Number.isSafeInteger(process.ppid) || process.ppid <= 0
    || !utilityProcess || typeof utilityProcess.fork !== 'function'
    || !directory || !path.isAbsolute(directory)) {
    throw new Error('The non-model embedding guard cannot establish its execution boundary');
  }
  const original = utilityProcess.fork;
  const launchId = randomUUID();
  const receipt = path.join(directory, `embedding-guard-${process.pid}-${launchId}.json`);
  const state = { version: 2, pid: process.pid, parent_pid: process.ppid,
    launch_id: launchId, installed: true, denied: 0, quit_observed: false };
  const record = (initial = false) => {
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(receipt, JSON.stringify(state) + '\n', { flag: initial ? 'wx' : 'w' });
  };
  function guardedFork(script, ...args) {
    if (typeof script === 'string'
      && path.basename(script.replaceAll('\\', '/')).toLowerCase() === 'kb-embed-worker.cjs') {
      state.denied++;
      // One bounded denial receipt is enough to withhold this case's origin.
      // The in-memory count is exact; the persisted count is a lower bound.
      if (state.denied === 1) { state.denied_count_is_lower_bound = true; record(); }
      const error = new Error('Real embedding is prohibited in this non-model test');
      error.code = 'ORKAS_NON_MODEL_EMBEDDING_DENIED';
      throw error;
    }
    return Reflect.apply(original, this, [script, ...args]);
  }
  record(true);
  utilityProcess.fork = guardedFork;
  if (utilityProcess.fork !== guardedFork) throw new Error('The non-model embedding guard was not installed');
  // Electron's real parent identifies Playwright's Windows command wrapper.
  // A missing terminal receipt remains incomplete evidence; do not infer exit.
  app.once('quit', (_event, exitCode) => {
    state.quit_observed = true;
    state.exit_code = Number.isSafeInteger(exitCode) ? exitCode : null;
    record();
  });
  Object.defineProperty(globalThis, '__ORKAS_NON_MODEL_GUARD', { value: state });
}
