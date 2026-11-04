#!/usr/bin/env node
/** Deterministic GUI coverage for isolated product page layout and capture. */
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
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-product-gui-canary-'));
const data = path.join(root, 'data');
fs.mkdirSync(data);
const env = { ...process.env, ELECTRON_RUN_AS_NODE: '',
  ORKAS_WORKSPACE_ROOT: data,
  ORKAS_GUI_TEST_USER_DATA_DIR: path.join(root, 'chromium'),
  ORKAS_GUI_TEST_RUNNER: path.join(here, 'video-studio-product-capture-canary.ts'),
};
const child = spawn(require('electron'), [path.join(here, 'electron-main.mjs')], {
  cwd: pcDir, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
});
let stdoutText = '';
let stderrBytes = 0;
let stderrText = '';
let timedOut = false;
child.stdout.on('data', chunk => { stdoutText += chunk.toString(); process.stdout.write(chunk); });
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
  if (timedOut) process.stderr.write('[product-capture-canary] GUI host exceeded the 180s deadline\n');
  // All child output stays visible. Only bounded, reviewed Linux baseline
  // diagnostics receive warning classifications; unknown output fails closed.
  let reviewed = stderrText;
  const expected = [];
  const endpoint = stdoutText.match(/\[product-capture-canary\] expected closed endpoint (http:\/\/127\.0\.0\.1:\d+\/)/)?.[1];
  if (endpoint && stdoutText.includes('ok   an unreachable page fails cleanly without leaving files')) {
    const rows = reviewed.split(/\r?\n/);
    reviewed = rows.filter(line => {
      const warning = /^\(node:\d+\) electron: Failed to load URL: (http:\/\/127\.0\.0\.1:\d+\/) with error: ERR_CONNECTION_REFUSED$/.exec(line);
      if (warning && warning[1] === endpoint && !expected.includes('closed-loopback')) { expected.push('closed-loopback'); return false; }
      if (expected.includes('closed-loopback') && /^\(Use `[^`]+ --trace-warnings \.\.\.` to show where the warning was created\)$/.test(line) && !expected.includes('node-warning-hint')) { expected.push('node-warning-hint'); return false; }
      return true;
    }).join('\n');
  }
  const report = { ...reviewInspectStderr(reviewed), expected };
  const reportDir = process.env.ORKAS_PRODUCT_CAPTURE_REPORT_DIR;
  if (reportDir) { fs.mkdirSync(reportDir, { recursive: true }); fs.writeFileSync(path.join(reportDir,'stdout.log'),stdoutText); fs.writeFileSync(path.join(reportDir,'stderr.log'),stderrText); fs.writeFileSync(path.join(reportDir,'analysis.json'),JSON.stringify(report,null,2)); }
  if (stderrBytes > 1024 * 1024) report.unexpected++;
  process.stdout.write(`[product-capture-canary] process log review: ${JSON.stringify(report)}\n`);
  if (report.unexpected) process.stderr.write('[product-capture-canary] process log review failed: unexpected stderr\n');
  process.exitCode = inspectCanaryExitCode(code, timedOut, report);
} finally {
  clearTimeout(timeout);
  for (const signal of signals) process.off(signal, stop);
  fs.rmSync(root, { recursive: true, force: true });
}
