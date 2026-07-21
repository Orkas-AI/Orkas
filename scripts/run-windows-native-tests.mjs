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
const result = spawnSync(process.execPath, [
  runner,
  'run',
  '--maxWorkers=1',
  '-t',
  'Windows real bundled whisper transcribes within the performance budget',
  'test/main/features/video_studio_native_qa.test.ts',
], {
  cwd: resolve(here, '..'),
  env: { ...process.env, ORKAS_REAL_WHISPER_TEST: '1' },
  stdio: 'inherit',
  windowsHide: true,
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
