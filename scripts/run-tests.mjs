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
import { withTestPython, withWindowsGitOnPath } from './test-runtime-env.mjs';
import { formatDriftReport, installedDependencyDrift } from './check-installed-dependencies.mjs';

// A merge that advanced the lockfile leaves stale packages installed, and the
// resulting failures name the wrong culprit. Say so before Vitest starts.
const { drifted } = installedDependencyDrift();
if (drifted.length) {
  process.stderr.write(formatDriftReport(drifted));
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const electronBin = require_('electron');
const vitestBin = resolve(here, '..', 'node_modules', 'vitest', 'vitest.mjs');
const testEnvironment = withTestPython(withWindowsGitOnPath(process.env));
// Nested launcher calls must not overwrite their parent's checkpoint report.
delete testEnvironment.ORKAS_TEST_BATCH_REPORT;

// npm appends arguments to the final shell command of a compound script.
// Own the suite here so filters reach Vitest without first running every JS
// test or being interpreted by npm/pytest. No arguments retains the full suite.
const suiteMode = process.argv[2] === 'suite';
let args = process.argv.slice(suiteMode ? 3 : 2);
let checkpoint;
let runCheckpoint;
if (args.some(arg => arg === '--resume' || arg.startsWith('--checkpoint-dir') || arg.startsWith('--batch-count'))) {
  try {
    const helper = await import('./test-checkpoint.mjs');
    checkpoint = helper.checkpointOptions(!suiteMode && args[0] === 'run' ? args.slice(1) : args);
    if (!suiteMode && args[0] !== 'run') throw new Error('Checkpoint mode requires run or suite');
    args = suiteMode ? checkpoint.args : ['run', ...checkpoint.args];
    runCheckpoint = helper.runCheckpoint;
  } catch (error) {
    console.error(`[run-tests] ${error.message}`);
    process.exit(2);
  }
}
const commands = [{
  executable: electronBin,
  args: [vitestBin, ...(suiteMode ? ['run', ...args] : args)],
  env: {
    ...testEnvironment,
    ELECTRON_RUN_AS_NODE: '1',
    // Test files that need to launch standalone JS helpers must not reuse
    // Electron's process.execPath: if they replace the child environment and
    // drop ELECTRON_RUN_AS_NODE, macOS launches another GUI app. Preserve the
    // outer npm/node executable as the explicit test-helper runtime.
    ORKAS_TEST_NODE: process.execPath,
  },
  checkpoint,
}];
if (suiteMode && args.length === 0) {
  commands.push({
    executable: process.execPath,
    args: [resolve(here, 'run-python-tests.mjs'), 'resources/builtin', 'resources/test', '-q',
      ...(checkpoint?.directory ? [`--checkpoint-dir=${resolve(checkpoint.directory)}`, `--batch-count=${checkpoint.batches}`,
        ...(checkpoint.resume ? ['--resume'] : [])] : [])],
    env: testEnvironment,
  });
}

let child;
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
    if (child && !child.killed) child.kill(signal);
  };
  signalHandlers.set(signal, handler);
  process.on(signal, handler);
}

async function runNext() {
  const command = commands.shift();
  if (!command) {
    removeSignalHandlers();
    return;
  }
  if (command.checkpoint?.directory) {
    let code;
    try {
      code = await runCheckpoint({ ...command.checkpoint, executable: electronBin, vitestBin,
        env: command.env, onChild: active => { child = active; }, cancelled: () => forwardedSignal });
    } catch (error) {
      if (error.signal) forwardedSignal ||= error.signal;
      else console.error(`[run-tests] ${error.message}`);
      code = 1;
    }
    if (forwardedSignal) {
      removeSignalHandlers();
      process.kill(process.pid, forwardedSignal);
      return;
    }
    if (code !== 0) {
      removeSignalHandlers();
      process.exit(code);
    }
    return runNext();
  }
  child = spawn(command.executable, command.args, { stdio: 'inherit', env: command.env });
  child.once('error', (error) => {
    removeSignalHandlers();
    console.error(`[run-tests] failed to start test runtime: ${error.message}`);
    process.exitCode = 1;
  });
  child.once('exit', (code, signal) => {
    const terminalSignal = forwardedSignal || signal;
    if (terminalSignal) {
      removeSignalHandlers();
      process.kill(process.pid, terminalSignal);
      return;
    }
    if (code !== 0) {
      removeSignalHandlers();
      process.exit(code ?? 1);
    }
    runNext();
  });
}

runNext();
