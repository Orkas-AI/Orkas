#!/usr/bin/env node

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { checkpointOptions } from './test-checkpoint.mjs';
import { withWindowsGitOnPath } from './test-runtime-env.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let checkpointArgs;
try {
  const checkpoint = checkpointOptions(process.argv.slice(2));
  if (checkpoint.args.length) throw new Error('Only --checkpoint-dir, --batch-count and --resume are supported; run coverage independently');
  checkpointArgs = checkpoint.directory ? [
    `--checkpoint-dir=${resolve(checkpoint.directory)}`,
    `--batch-count=${checkpoint.batches}`,
    ...(checkpoint.resume ? ['--resume'] : []),
  ] : [];
} catch (error) {
  console.error(`[non-model] ${error.message}`);
  process.exit(2);
}

const testEnvironment = withWindowsGitOnPath(process.env);
function npmInvocation() {
  if (process.platform !== 'win32') return { command: 'npm', prefix: [] };
  const candidates = [testEnvironment.npm_execpath];
  const where = spawnSync('where.exe', ['npm.cmd'], { encoding: 'utf8', env: testEnvironment });
  if (where.status === 0) {
    for (const launcher of where.stdout.split(/\r?\n/).map(line => line.trim()).filter(Boolean)) {
      candidates.push(resolve(dirname(launcher), 'node_modules', 'npm', 'bin', 'npm-cli.js'));
    }
  }
  const cli = candidates.find(candidate => candidate && existsSync(candidate));
  if (!cli) throw new Error('npm CLI not found; install npm or invoke this runner from npm');
  // Node cannot directly spawn a .cmd launcher on Windows. Keep arguments out
  // of a command shell and execute the same installed npm JavaScript entry.
  return { command: process.execPath, prefix: [cli] };
}

let npm;
try { npm = npmInvocation(); }
catch (error) {
  console.error(`[non-model] ${error.message}`);
  process.exit(2);
}

const reportPath = resolve(repoRoot, 'test-results', `non-model-${randomUUID()}.json`);
const stages = [];
console.log(`[non-model] stage timing report: ${reportPath}`);

// Preserve the flat repository's existing six-stage shell chain. In particular,
// npm test already owns both the JS and builtin Python suites. Their launchers
// and the E2E launcher own checkpoint discovery, reuse and log certification.
// Native Office/Electron lanes share host resources and must remain serial.
for (const script of ['typecheck', 'test', 'test:e2e:typecheck', 'test:e2e', 'test:platform-native', 'smoke']) {
  const args = [...npm.prefix, ...(script === 'test' ? ['test'] : ['run', script]),
    ...(['test', 'test:e2e'].includes(script) && checkpointArgs.length ? ['--', ...checkpointArgs] : [])];
  const started = performance.now();
  const result = spawnSync(npm.command, args, { cwd: repoRoot, stdio: 'inherit', env: testEnvironment });
  const durationMs = Math.round(performance.now() - started);
  const execution = result.error ? 'unavailable' : result.signal ? 'interrupted' : 'completed';
  stages.push({ script, command: npm.command, args, durationMs, exitCode: result.status, signal: result.signal, execution });
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify({ schema: 1, stages,
    logReview: 'Inspect each owning runner report and all emitted logs' }, null, 2)}\n`);
  console.log(`[non-model] ${script} duration=${durationMs}ms exit=${result.status ?? 'unavailable'} execution=${execution}`);
  if (result.error) console.error(`[non-model] failed to start ${script}: ${result.error.message}`);
  if (result.error || result.signal || result.status !== 0) process.exit(result.status || 1);
}
