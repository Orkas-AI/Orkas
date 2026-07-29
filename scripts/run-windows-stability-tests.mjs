#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') {
  console.log('[windows-stability-tests] skipped: Windows-only process-tree stability gate');
  process.exit(0);
}

const here = dirname(fileURLToPath(import.meta.url));
const pcRoot = resolve(here, '..');
const runner = resolve(here, 'run-tests.mjs');
const repetitions = 3;
const testNamePattern = [
  'persistent process sessions',
  'times out a Windows command shim and terminates its descendant process tree',
  'rejects a timeout immediately and terminates the entire process tree',
  'terminates a package command and its Windows descendants',
  'terminates the complete Windows FFmpeg process tree',
  'kills a real Windows ffprobe-style process tree',
  'P1 terminates a real Windows video subprocess tree',
].join('|');
const suites = [
  'src/core-agent/test/process-session.test.ts',
  'test/main/features/local_agents/version.test.ts',
  'test/main/features/office/office_engine.test.ts',
  'test/main/features/packages.test.ts',
  'test/main/features/generation_reference_assets.test.ts',
  'test/main/util/media_probe.test.ts',
  'test/main/features/video_studio_native_qa.test.ts',
];

for (let repetition = 1; repetition <= repetitions; repetition++) {
  for (const suite of suites) {
    // Whole-tree termination forcibly closes Windows pipe/job handles. Give
    // every owner a fresh Vitest/Electron process so one suite cannot poison
    // the next owner's IOCP teardown, and the failing owner stays explicit.
    console.log(
      `[windows-stability-tests] repetition=${repetition}/${repetitions}; suite=${suite}`,
    );
    const result = spawnSync(process.execPath, [
      runner,
      'run',
      '--maxWorkers=1',
      '-t',
      testNamePattern,
      suite,
    ], {
      cwd: pcRoot,
      env: { ...process.env, ORKAS_PLATFORM_NATIVE_TEST: '1' },
      stdio: 'inherit',
      windowsHide: true,
    });

    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}

console.log(`[windows-stability-tests] passed ${repetitions}/${repetitions} repetitions`);
