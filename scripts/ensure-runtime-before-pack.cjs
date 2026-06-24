#!/usr/bin/env node
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { slimRuntimeRoot } = require('./slim-runtime.cjs');
const { runtimeKey, verifyRuntimeRoot } = require('../bin/runtime-gate.cjs');

const ARCH_MAP = new Map([
  ['0', 'ia32'],
  ['1', 'x64'],
  ['2', 'armv7l'],
  ['3', 'arm64'],
  ['4', 'universal'],
  ['ia32', 'ia32'],
  ['x64', 'x64'],
  ['armv7l', 'armv7l'],
  ['arm64', 'arm64'],
  ['universal', 'universal'],
]);

function normalizeArch(value) {
  return ARCH_MAP.get(String(value)) || String(value || process.arch);
}

function pruneRuntimeRoot(root, keys) {
  const allowed = new Set(keys);
  for (const kind of ['python', 'uv', 'node']) {
    const kindDir = path.join(root, kind);
    if (!fs.existsSync(kindDir) || !fs.statSync(kindDir).isDirectory()) {
      continue;
    }
    for (const entry of fs.readdirSync(kindDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || allowed.has(entry.name)) {
        continue;
      }
      fs.rmSync(path.join(kindDir, entry.name), { recursive: true, force: true });
    }
  }
}

module.exports = async function ensureRuntimeBeforePack(context) {
  const pcRoot = path.resolve(__dirname, '..');
  const runtimeRoot = path.join(pcRoot, 'resources', 'runtime');
  const platform = context && context.electronPlatformName
    ? String(context.electronPlatformName)
    : process.platform;
  const arch = normalizeArch(context && context.arch);
  const arches = arch === 'universal' ? ['x64', 'arm64'] : [arch];

  for (const targetArch of arches) {
    const res = spawnSync(process.execPath, [
      path.join(pcRoot, 'bin', 'ensure-runtime.cjs'),
      '--root', runtimeRoot,
      '--platform', platform,
      '--arch', targetArch,
    ], {
      cwd: pcRoot,
      encoding: 'utf8',
      stdio: 'inherit',
      env: process.env,
    });
    if (res.error) throw res.error;
    if (res.status !== 0) {
      throw new Error(`ensure-runtime failed for ${platform}-${targetArch} with status ${res.status}`);
    }
  }

  slimRuntimeRoot(runtimeRoot, { platform, arch });
  const allowedKeys = arches.map(targetArch => runtimeKey(platform, targetArch));
  pruneRuntimeRoot(runtimeRoot, allowedKeys);

  const verified = [];
  for (const targetArch of arches) {
    verified.push(...verifyRuntimeRoot(runtimeRoot, platform, targetArch, { allowedKeys }));
  }
  console.log(`[runtime-gate] pre-pack verified: ${verified.join(', ')}`);
};
