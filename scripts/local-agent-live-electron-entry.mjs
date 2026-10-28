import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { modelEvalRunnerArgs } from './model-eval-launcher-args.mjs';

import { app, protocol } from 'electron';
import { register } from 'tsx/esm/api';

// Defense in depth for direct/custom launchers: set the hard gate before the
// TypeScript runner imports any production Agent modules.
process.env.ORKAS_METACOGNITION = '0';

function isBrokenPipeError(error) {
  return error?.code === 'EPIPE';
}

let outputPipeExitRequested = false;
function handleOutputError(error) {
  if (!isBrokenPipeError(error)) throw error;
  if (outputPipeExitRequested) return;
  outputPipeExitRequested = true;
  process.exitCode = 1;
  app.exit(1);
}

// The launcher owns stdout/stderr. If it is killed or its terminal closes,
// Windows leaves this Electron child alive while writes begin emitting EPIPE.
// Handle that stream error explicitly so Electron never shows a main-process
// exception dialog for a diagnostic channel failure.
process.stdout?.on('error', handleOutputError);
process.stderr?.on('error', handleOutputError);

const require = createRequire(import.meta.url);
require('tsx/cjs');
const unregisterTsxEsm = register();

const runner = process.env.ORKAS_LOCAL_AGENT_RUNNER;
if (!runner || !path.isAbsolute(runner)) {
  throw new Error('ORKAS_LOCAL_AGENT_RUNNER must be an absolute path');
}

// Production rendering tools use hidden BrowserWindows. Keep the CLI acceptance
// in a real Electron main process without showing a launcher window or Dock
// icon of its own.
// Headless Regression does not need GPU compositing. Disabling it before
// app readiness avoids CI/packaged-runtime GPU crash loops while preserving
// BrowserWindow layout, screenshots, and software-rendered preview evidence.
// Use a fresh Chromium profile as well: a shared default Electron profile can
// retain service-worker/GPU state from another Electron build and make an
// otherwise valid html_preview fail with Mojo schema errors.
const electronUserDataDir = process.env.ORKAS_LOCAL_AGENT_USER_DATA_DIR;
if (!electronUserDataDir || !path.isAbsolute(electronUserDataDir)) {
  throw new Error('ORKAS_LOCAL_AGENT_USER_DATA_DIR must be an absolute path');
}
app.setPath('userData', electronUserDataDir);
// The production host gives SDK app frames a standard secure origin before
// readiness. The CLI acceptance entry bypasses src/main/index.ts, so it must set
// the same existing scheme privileges before loading preview tools.
protocol.registerSchemesAsPrivileged([
  { scheme: 'chat-app', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);
app.disableHardwareAcceleration();
app.dock?.hide();
app.on('window-all-closed', () => {
  // The runner owns the lifetime; a rendering window closing is not terminal.
});

const launcherPid = process.ppid;
const launcherWatch = setInterval(() => {
  try {
    process.kill(launcherPid, 0);
  } catch (error) {
    if (error?.code !== 'ESRCH') return;
    process.exitCode = 1;
    app.exit(1);
  }
}, 1_000);
launcherWatch.unref();

async function run() {
  await app.whenReady();
  // Keep the CLI acceptance runner in the ESM loader. Core Agent providers expose
  // import-only package subpaths (for example pi-ai/compat); requiring the
  // TypeScript entry makes Electron/tsx select CommonJS conditions and fail
  // before registration or any model case can run.
  const module = await import(pathToFileURL(runner).href);
  if (typeof module.main !== 'function') {
    throw new Error(`Local CLI runner does not export main(): ${runner}`);
  }
  const code = await module.main(modelEvalRunnerArgs(process.argv, fileURLToPath(import.meta.url)));
  process.exitCode = Number.isInteger(code) ? code : 1;
}

run()
  .catch((error) => {
    try {
      process.stderr.write(`Local CLI Electron runner failed: ${error?.stack || error}\n`);
    } catch (writeError) {
      if (!isBrokenPipeError(writeError)) throw writeError;
    }
    process.exitCode = 1;
  })
  .finally(() => {
    clearInterval(launcherWatch);
    process.stdout?.off('error', handleOutputError);
    process.stderr?.off('error', handleOutputError);
    void unregisterTsxEsm();
    const exitCode = Number(process.exitCode) || 0;
    const forcedExit = setTimeout(() => process.exit(exitCode), 2_000);
    forcedExit.unref();
    app.exit(Number(process.exitCode) || 0);
  });
