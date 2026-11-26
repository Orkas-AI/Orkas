#!/usr/bin/env node
/** Offline real-window timeline/encoder coverage; --perf adds a bounded 60-second measurement. */
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
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-timeline-gui-canary-'));
const data = path.join(root, 'data');
fs.mkdirSync(data);
const env = { ...process.env, ELECTRON_RUN_AS_NODE: '',
  ORKAS_WORKSPACE_ROOT: data,
  ORKAS_GUI_TEST_USER_DATA_DIR: path.join(root, 'chromium'),
  ORKAS_GUI_TEST_RUNNER: path.join(here, 'video-timeline-canary.ts'),
  ORKAS_VIDEO_TIMELINE_CASE: '',
  ORKAS_VIDEO_TIMELINE_PERF: process.argv.includes('--perf') ? '1' : '',
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
const timeout = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 600_000);
try {
  const code = await new Promise((resolve) => {
    child.once('error', () => resolve(1));
    child.once('close', code => resolve(code ?? 1));
  });
  if (timedOut) process.stderr.write('[video-timeline-canary] GUI host exceeded the 600s deadline\n');
  // All child output stays visible. Only bounded, reviewed operating-system
  // diagnostics receive warning classifications; unknown output fails closed.
  const report = reviewInspectStderr(stderrText);
  if (stderrBytes > 1024 * 1024) report.unexpected++;
  process.stdout.write(`[video-timeline-canary] process log review: ${JSON.stringify(report)}\n`);
  if (report.unexpected) process.stderr.write('[video-timeline-canary] process log review failed: unexpected stderr\n');
  process.exitCode = inspectCanaryExitCode(code, timedOut, report);
} finally {
  clearTimeout(timeout);
  for (const signal of signals) process.off(signal, stop);
  fs.rmSync(root, { recursive: true, force: true });
}
