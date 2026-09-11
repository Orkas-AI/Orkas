#!/usr/bin/env node
/** Deterministic GUI coverage for composition inspection and frame capture. */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reviewInspectStderr, inspectCanaryExitCode } from './inspect-canary-logs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const pcDir = path.resolve(here, '../..');
const require = createRequire(import.meta.url);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-gui-canary-'));
const data = path.join(root, 'data');
fs.mkdirSync(data);
const env = { ...process.env, ELECTRON_RUN_AS_NODE: '',
  ORKAS_WORKSPACE_ROOT: data,
  ORKAS_GUI_TEST_USER_DATA_DIR: path.join(root, 'chromium'),
  ORKAS_GUI_TEST_RUNNER: path.join(here, 'video-studio-inspect-canary.ts'),
};
const child = spawn(require('electron'), [path.join(here, 'electron-main.mjs')], {
  cwd: pcDir, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
});
let stderrBytes = 0;
let stderrText = '';
let timedOut = false;
child.stdout.on('data', chunk => process.stdout.write(chunk));
child.stderr.setEncoding('utf8');
child.stderr.on('data', chunk => {
  stderrBytes += Buffer.byteLength(chunk);
  if (stderrBytes <= 1024 * 1024) stderrText += chunk;
  process.stderr.write(chunk);
});
const stop = () => child.kill('SIGTERM');
const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
for (const signal of signals) process.on(signal, stop);
const timeout = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 180_000);
try {
  const code = await new Promise((resolve) => {
    child.once('error', () => resolve(1));
    child.once('close', code => resolve(code ?? 1));
  });
  if (timedOut) process.stderr.write('[inspect-canary] GUI host exceeded the 180s deadline\n');
  // All child output stays visible. Only bounded, reviewed Linux baseline
  // diagnostics receive warning classifications; unknown output fails closed.
  const report = reviewInspectStderr(stderrText);
  if (stderrBytes > 1024 * 1024) report.unexpected++;
  process.stdout.write(`[inspect-canary] process log review: ${JSON.stringify(report)}\n`);
  if (report.unexpected) process.stderr.write('[inspect-canary] process log review failed: unexpected stderr\n');
  process.exitCode = inspectCanaryExitCode(code, timedOut, report);
} finally {
  clearTimeout(timeout);
  for (const signal of signals) process.off(signal, stop);
  fs.rmSync(root, { recursive: true, force: true });
}
