#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

const pcRoot = path.resolve(__dirname, '..');

function run(label, script, args = []) {
  const result = spawnSync(process.execPath, [path.join(pcRoot, script), ...args], {
    cwd: pcRoot,
    env: process.env,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed with status ${result.status}`);
}

function main() {
  console.log(`[dev-deps] preparing built-in dependencies for ${process.platform}-${process.arch}`);
  run('notification permission addon', 'scripts/build-notification-permission-addon.cjs', [
    '--platform', process.platform,
    '--arch', process.arch,
  ]);
  run('SQLite Electron ABI', 'scripts/ensure-sqlite-electron-abi.mjs');
  run('runtime ensure', 'bin/ensure-runtime.cjs', [
    '--root', path.join(pcRoot, 'resources', 'runtime'),
    '--platform', process.platform,
    '--arch', process.arch,
  ]);
  run('embedding model', 'scripts/fetch-embedding-model.mjs');
  run('OfficeCLI', 'scripts/fetch-officecli.cjs');
  run('FFmpeg', 'scripts/fetch-ffmpeg.cjs', ['--platform', process.platform, '--arch', process.arch]);
  if (process.platform === 'win32') {
    run('Windows VC runtime', 'scripts/fetch-win-vc-runtime.cjs', [
      '--platform', process.platform,
      '--arch', process.arch,
    ]);
  }
  run('Whisper', 'scripts/fetch-whisper.cjs', [
    '--platform', process.platform,
    '--arch', process.arch,
  ]);
  console.log('[dev-deps] built-in dependencies ready');
}

try {
  main();
} catch (err) {
  console.error(`[dev-deps] failed: ${err.message}`);
  process.exit(1);
}
