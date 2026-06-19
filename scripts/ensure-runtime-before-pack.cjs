#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

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

module.exports = async function ensureRuntimeBeforePack(context) {
  const pcRoot = path.resolve(__dirname, '..');
  const platform = context && context.electronPlatformName
    ? String(context.electronPlatformName)
    : process.platform;
  const arch = normalizeArch(context && context.arch);
  const arches = arch === 'universal' ? ['x64', 'arm64'] : [arch];

  for (const targetArch of arches) {
    const res = spawnSync(process.execPath, [
      path.join(pcRoot, 'bin', 'ensure-runtime.cjs'),
      '--root', path.join(pcRoot, 'resources', 'runtime'),
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
};
