#!/usr/bin/env node
'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const RUNTIME_KINDS = ['python', 'uv', 'node'];

function runtimeKey(platform, arch) {
  return `${platform}-${arch}`;
}

function runtimeKeysForTarget(platform, arch) {
  return arch === 'universal'
    ? [runtimeKey(platform, 'x64'), runtimeKey(platform, 'arm64')]
    : [runtimeKey(platform, arch)];
}

function requiredFile(label, file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error(`[native-deps-gate] missing ${label}: ${file}`);
  }
}

function listDirs(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function readJsonFile(label, file) {
  requiredFile(label, file);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`[native-deps-gate] invalid ${label}: ${file}: ${err.message}`);
  }
}

function relPath(root, rel) {
  return path.join(root, ...String(rel || '').split(/[\\/]/).filter(Boolean));
}

function runtimeAsset(manifest, kind, platformKey) {
  const spec = manifest[kind];
  const asset = spec && spec.assets && spec.assets[platformKey];
  if (!spec || !asset) {
    throw new Error(`[native-deps-gate] missing runtime manifest entry for ${kind}/${platformKey}`);
  }
  return { spec, asset };
}

function markerMatches(marker, kind, platformKey, spec, asset) {
  return marker
    && marker.kind === kind
    && marker.platformKey === platformKey
    && marker.version === spec.version
    && marker.asset === asset.name
    && marker.sha256 === asset.sha256
    && marker.size === asset.size;
}

function pythonVersionSuffix(spec) {
  const m = /^(\d+)\.(\d+)/.exec(String(spec.version || ''));
  return m ? `${m[1]}.${m[2]}` : '';
}

function pythonPipShimFiles(executable, targetPlatform, spec) {
  const suffix = pythonVersionSuffix(spec);
  const names = ['pip', 'pip3', ...(suffix ? [`pip${suffix}`] : [])];
  const shimDir = targetPlatform === 'win32'
    ? path.join(path.dirname(executable), 'Scripts')
    : path.dirname(executable);
  return names.map((name) => path.join(shimDir, targetPlatform === 'win32' ? `${name}.cmd` : name));
}

function uvCompanionFiles(executable, targetPlatform) {
  return [path.join(path.dirname(executable), targetPlatform === 'win32' ? 'uvx.exe' : 'uvx')];
}

function nodeCompanionFiles(executable, targetPlatform) {
  const dir = path.dirname(executable);
  return targetPlatform === 'win32'
    ? [path.join(dir, 'npm.cmd'), path.join(dir, 'npx.cmd')]
    : [path.join(dir, 'npm'), path.join(dir, 'npx')];
}

function runtimeCompanionFiles(kind, executable, targetPlatform, spec) {
  if (kind === 'python') return pythonPipShimFiles(executable, targetPlatform, spec);
  if (kind === 'uv') return uvCompanionFiles(executable, targetPlatform);
  if (kind === 'node') return nodeCompanionFiles(executable, targetPlatform);
  return [];
}

function requireOnlyRuntimeDirs(runtimeRoot, kind, allowedKeys) {
  const kindDir = path.join(runtimeRoot, kind);
  if (!fs.existsSync(kindDir) || !fs.statSync(kindDir).isDirectory()) {
    throw new Error(`[native-deps-gate] missing runtime ${kind} directory: ${kindDir}`);
  }
  const allowed = new Set(allowedKeys);
  for (const dirName of listDirs(kindDir)) {
    if (!allowed.has(dirName)) {
      throw new Error(`[native-deps-gate] unexpected runtime ${kind} payload for target: ${path.join(kindDir, dirName)}`);
    }
  }
}

function assertDarwinExecutableArch(file, targetArch) {
  const expected = targetArch === 'x64' ? 'x86_64' : targetArch;
  if (!expected || !fs.existsSync('/usr/bin/file')) return;
  const out = execFileSync('/usr/bin/file', [file], { encoding: 'utf8' });
  if (!out.includes(expected)) {
    throw new Error(`[native-deps-gate] runtime binary arch mismatch: expected ${expected}, file=${file}, output=${out.trim()}`);
  }
}

function verifyRuntimeDir(kind, dir, key, spec, asset, targetPlatform, targetArch, options = {}) {
  const executable = relPath(dir, asset.executable);
  const marker = readJsonFile(`${kind} runtime marker`, path.join(dir, '.orkas-runtime.json'));
  if (!markerMatches(marker, kind, key, spec, asset)) {
    throw new Error(`[native-deps-gate] runtime marker mismatch for ${kind}/${key}: ${path.join(dir, '.orkas-runtime.json')}`);
  }
  requiredFile(`${kind} runtime executable`, executable);
  for (const companion of runtimeCompanionFiles(kind, executable, targetPlatform, spec)) {
    requiredFile(`${kind} runtime companion`, companion);
  }
  if (options.checkArch !== false && targetPlatform === 'darwin') {
    assertDarwinExecutableArch(executable, targetArch);
  }
  return executable;
}

function verifyRuntimeRoot(runtimeRoot, targetPlatform, targetArch, options = {}) {
  const manifest = readJsonFile('runtime manifest', path.join(runtimeRoot, 'manifest.json'));
  const key = runtimeKey(targetPlatform, targetArch);
  const allowedKeys = options.allowedKeys || [key];
  const verified = [];

  for (const kind of RUNTIME_KINDS) {
    const { spec, asset } = runtimeAsset(manifest, kind, key);
    requireOnlyRuntimeDirs(runtimeRoot, kind, allowedKeys);
    const dir = path.join(runtimeRoot, kind, key);
    verifyRuntimeDir(kind, dir, key, spec, asset, targetPlatform, targetArch, options);
    verified.push(`runtime:${kind}:${key}`);
  }

  return verified;
}

module.exports = {
  RUNTIME_KINDS,
  runtimeKey,
  runtimeKeysForTarget,
  verifyRuntimeDir,
  verifyRuntimeRoot,
};
