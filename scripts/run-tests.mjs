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
import { dirname, resolve, join } from 'node:path';
import { mkdtempSync, readFileSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createStderrReceipt } from './test-stderr-receipt.mjs';
import { fileURLToPath } from 'node:url';
import { withTestPython, withWindowsGitOnPath, withWindowsPowerShellModules } from './test-runtime-env.mjs';
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
const testEnvironment = withTestPython(withWindowsPowerShellModules(withWindowsGitOnPath(process.env)));
// Nested launcher calls must not overwrite their parent's checkpoint report.
delete testEnvironment.ORKAS_TEST_BATCH_REPORT;
delete testEnvironment.ORKAS_TEST_PROCESS_REPORT;

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
  auditStderr: (suiteMode || args[0] === 'run')
    && !args.some(arg => ['--help', '-h', '--version', '-v'].includes(arg)),
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
  // The worker tap cannot see native writes to FD2 or inherited child FDs.
  // Reconcile the entire process stream with its attributed receipt; do not
  // guess severity/intent from native text or buffer unrestricted raw logs.
  const directory = command.auditStderr ? mkdtempSync(join(tmpdir(), 'orkas-test-stderr-')) : null;
  const reportFile = directory && join(directory, 'receipt.json');
  const receipt = directory && createStderrReceipt();
  const env = reportFile ? { ...command.env, ORKAS_TEST_PROCESS_REPORT: reportFile } : command.env;
  child = spawn(command.executable, command.args, {
    stdio: receipt ? ['inherit', 'inherit', 'pipe'] : 'inherit', env,
  });
  if (receipt) {
    child.stderr.on('data', chunk => receipt.ingest(chunk));
    child.stderr.pipe(process.stderr, { end: false });
  }
  child.once('error', (error) => {
    removeSignalHandlers();
    console.error(`[run-tests] failed to start test runtime: ${error.message}`);
    process.exitCode = 1;
  });
  // A leaked descendant can retain FD2 after Vitest exits. Bound that drain
  // wait and fail coverage instead of hanging or certifying truncated output.
  let drainTimer;
  let drainTimedOut = false;
  child.once('exit', () => {
    if (receipt && !child.stderr.destroyed) drainTimer = setTimeout(() => {
      drainTimedOut = true;
      child.stderr.destroy();
    }, 5000);
  });
  // close follows exit and stderr EOF, including diagnostics during teardown.
  child.once('close', (code, signal) => {
    clearTimeout(drainTimer);
    let stderrGap = false;
    let stderrAudit;
    if (receipt) {
      const actual = receipt.finish();
      let expected = null;
      let expectedStatus = 'missing';
      try {
        if (statSync(reportFile).size > 4096) expectedStatus = 'oversized';
        else {
          expectedStatus = 'invalid';
          const candidate = JSON.parse(readFileSync(reportFile, 'utf8')).stderr;
          if (candidate?.valid === true && Number.isSafeInteger(candidate.bytes) && candidate.bytes >= 0
            && Number.isSafeInteger(candidate.lines) && candidate.lines >= 0
            && typeof candidate.digest === 'string' && /^[a-f0-9]{64}$/.test(candidate.digest)) {
            expected = { valid: true, bytes: candidate.bytes, lines: candidate.lines, digest: candidate.digest };
            expectedStatus = 'valid';
          }
        }
      } catch { /* Missing/corrupt receipt is incomplete coverage, even at zero bytes. */ }
      stderrGap = drainTimedOut || !actual.valid || expected?.valid !== true || actual.bytes !== expected.bytes
        || actual.lines !== expected.lines || actual.digest !== expected.digest;
      // Retain bounded counters/digests before deleting the transient receipt.
      // Never print reporter-controlled extra fields, raw diagnostics or paths.
      stderrAudit = { schema: 1, expectedStatus, drainTimedOut, actual, expected };
      rmSync(directory, { recursive: true, force: true });
    }
    const terminalSignal = forwardedSignal || signal;
    if (terminalSignal) {
      removeSignalHandlers();
      process.kill(process.pid, terminalSignal);
      return;
    }
    if (drainTimedOut) process.stdout.write('[test-process-log-analysis] stderr drain timed out after runtime exit\n');
    if (stderrGap) {
      process.stdout.write('[test-process-log-analysis] FAIL unattributed stderr or missing receipt\n');
      process.stdout.write(`[test-process-log-analysis] receipt ${JSON.stringify(stderrAudit)}\n`);
    }
    if (code !== 0 || stderrGap) {
      removeSignalHandlers();
      process.exitCode = code || 1;
      return;
    }
    runNext();
  });
}

runNext();
