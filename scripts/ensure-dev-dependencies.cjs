#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');

const { WHISPER_RUNTIME_CONTRACT } = require('../bin/runtime-gate.cjs');

const pcRoot = path.resolve(__dirname, '..');

function run(label, script, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(pcRoot, script), ...args], {
      cwd: pcRoot,
      env: process.env,
      stdio: 'inherit',
    });
    let launchError;
    child.once('error', (error) => { launchError = error; });
    // Wait for close even after a launch error: readiness/failure must not
    // leave a provisioning child or its inherited output behind.
    child.once('close', (code, signal) => {
      if (launchError) reject(launchError);
      else if (code !== 0) reject(new Error(`${label} failed with ${signal ? `signal ${signal}` : `status ${code}`}`));
      else resolve();
    });
  });
}

function shouldProvisionWhisper(platform = process.platform, arch = process.arch) {
  return Boolean(WHISPER_RUNTIME_CONTRACT.targets[`${platform}-${arch}`]);
}

async function main() {
  require('./media-transfer-policy.cjs').verifyMediaTransferPolicy(pcRoot);
  require('../bin/packaged-resource-gate.cjs').verifyXlsReaderRoot(path.join(pcRoot, 'resources', 'xls-reader'));
  await run('Node bootstrap', 'scripts/verify-native-dependencies.cjs', ['--host-only']);
  if (process.platform === 'linux') {
    await run('Linux host preflight', 'scripts/verify-linux-source-dependencies.cjs', ['--host-only']);
  }
  require('../bin/packaged-entrypoint-gate.cjs').verifyBridgeSdkRuntime(pcRoot);
  console.log(`[dev-deps] preparing built-in dependencies for ${process.platform}-${process.arch}`);
  if (process.platform === 'win32') {
    await run('Windows VC runtime', 'scripts/fetch-win-vc-runtime.cjs', [
      '--platform', process.platform,
      '--arch', process.arch,
    ]);
  }
  // Native preparation and asset preparation own disjoint output directories.
  // Keep their dependencies ordered within two lanes, bounding child count and
  // I/O concurrency without skipping any readiness or self-repair checks.
  let stopped = false;
  async function step(...args) {
    if (stopped) return;
    try { await run(...args); }
    catch (error) { stopped = true; throw error; }
  }
  async function prepareNative() {
    await step('notification permission addon', 'scripts/build-notification-permission-addon.cjs', [
      '--platform', process.platform,
      '--arch', process.arch,
    ]);
    await step('SQLite Electron ABI', 'scripts/ensure-sqlite-electron-abi.mjs');
    await step('phone passkey helper', 'scripts/build-phone-passkey.cjs', ['--platform', process.platform, '--arch', process.arch]);
    await step('runtime ensure', 'bin/ensure-runtime.cjs', [
      '--root', path.join(pcRoot, 'resources', 'runtime'),
      '--platform', process.platform,
      '--arch', process.arch,
    ]);
    await step('native dependencies', 'scripts/verify-native-dependencies.cjs');
  }
  async function prepareAssets() {
    await step('embedding model', 'scripts/fetch-embedding-model.mjs');
    await step('OfficeCLI', 'scripts/fetch-officecli.cjs');
    await step('FFmpeg', 'scripts/fetch-ffmpeg.cjs', ['--platform', process.platform, '--arch', process.arch]);
    if (shouldProvisionWhisper()) await step('Whisper', 'scripts/fetch-whisper.cjs', [
      '--platform', process.platform,
      '--arch', process.arch,
    ]);
    if (require('../bin/runtime-gate.cjs').LIBRAW_RUNTIME_CONTRACT.targets[`${process.platform}-${process.arch}`]) {
      await step('LibRaw', 'scripts/fetch-libraw.cjs', ['--platform', process.platform, '--arch', process.arch]);
    }
  }
  const results = await Promise.allSettled([prepareNative(), prepareAssets()]);
  const failure = results.find(result => result.status === 'rejected');
  if (failure) throw failure.reason;
  if (process.platform === 'linux') {
    await run('Linux source dependencies', 'scripts/verify-linux-source-dependencies.cjs');
  }
  console.log('[dev-deps] built-in dependencies ready');
}

module.exports = Object.freeze({ shouldProvisionWhisper });

if (require.main === module) main().catch((err) => {
  console.error(`[dev-deps] failed: ${err.message}`);
  process.exit(1);
});
