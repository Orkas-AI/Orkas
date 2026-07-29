#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') {
  console.log('[windows-native-tests] skipped: Windows-only native runtime gate');
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const runner = resolve(here, 'run-tests.mjs');
const pcRoot = resolve(here, '..');

function run(command, args, options) {
  const result = spawnSync(command, args, options);
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run('powershell.exe', [
  '-NoLogo',
  '-NoProfile',
  '-NonInteractive',
  '-ExecutionPolicy', 'Bypass',
  '-File', resolve(pcRoot, 'test', 'windows', 'windows-node-bootstrap.integration.ps1'),
  '-NodeExe', process.execPath,
], {
  cwd: pcRoot,
  env: process.env,
  stdio: 'inherit',
  timeout: 5 * 60_000,
  windowsHide: true,
});

run(process.execPath, [
  runner,
  'run',
  '--maxWorkers=1',
  '-t',
  'Windows real bundled whisper transcribes within the performance budget',
  'test/main/features/video_studio_native_qa.test.ts',
], {
  cwd: pcRoot,
  env: { ...process.env, ORKAS_REAL_WHISPER_TEST: '1' },
  stdio: 'inherit',
  timeout: 2 * 60_000,
  windowsHide: true,
});
