#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { assertExecutableArch } = require('./runtime-gate.cjs');

// Single source of truth for native files shipped from node_modules. The gate
// is deliberately closed-world: adding a new .node/.dll/.dylib/.so or esbuild
// executable to the packaged app fails until it is registered here. This keeps
// afterPack and final-artifact validation aligned with the app's real payload.
const TARGETS = new Set(['darwin-arm64', 'darwin-x64', 'win32-x64']);

function targetKey(platform, arch) {
  return `${platform}-${arch}`;
}

function slash(value) {
  return value.split(path.sep).join('/');
}

function joinRelative(...parts) {
  return parts.filter(Boolean).join('/');
}

function isFile(file) {
  return fs.existsSync(file) && fs.statSync(file).isFile();
}

function readJson(label, file) {
  if (!isFile(file)) {
    throw new Error(`[native-package-gate] missing ${label}: ${file}`);
  }
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`[native-package-gate] invalid ${label}: ${file}: ${err.message}`);
  }
}

function firstExistingFile(nodeModules, label, candidates) {
  const existing = candidates.filter((relativePath) => isFile(path.join(nodeModules, ...relativePath.split('/'))));
  if (existing.length !== 1) {
    const detail = existing.length === 0
      ? `none of ${candidates.join(', ')}`
      : `multiple candidates: ${existing.join(', ')}`;
    throw new Error(`[native-package-gate] expected exactly one ${label}; found ${detail}`);
  }
  return existing[0];
}

function onnxRuntimePackage(nodeModules) {
  const packageJson = firstExistingFile(nodeModules, 'FastEmbed onnxruntime-node package.json', [
    'fastembed/node_modules/onnxruntime-node/package.json',
    'onnxruntime-node/package.json',
  ]);
  const pkg = readJson(
    'FastEmbed onnxruntime-node package.json',
    path.join(nodeModules, ...packageJson.split('/')),
  );
  if (!/^\d+\.\d+\.\d+(?:[-+].+)?$/.test(String(pkg.version || ''))) {
    throw new Error(`[native-package-gate] invalid FastEmbed onnxruntime-node version: ${pkg.version || '(missing)'}`);
  }
  return {
    base: packageJson.slice(0, -'/package.json'.length),
    version: String(pkg.version).split(/[-+]/, 1)[0],
  };
}

function nativePackageContract(nodeModules, platform, arch) {
  const key = targetKey(platform, arch);
  if (!TARGETS.has(key)) {
    throw new Error(`[native-package-gate] unsupported packaged native target: ${key}`);
  }

  const mac = platform === 'darwin';
  const esbuildPackage = mac ? `darwin-${arch}` : 'win32-x64';
  const sqlitePackage = mac ? `sqlite-vec-darwin-${arch}` : 'sqlite-vec-windows-x64';
  const canvasPackage = mac ? `canvas-darwin-${arch}` : 'canvas-win32-x64-msvc';
  const tokenizersPackage = mac ? 'tokenizers-darwin-universal' : 'tokenizers-win32-x64-msvc';
  const onnxRuntime = onnxRuntimePackage(nodeModules);
  const onnxBase = `${onnxRuntime.base}/bin/napi-v3/${platform}/${arch}`;
  const onnxVersion = onnxRuntime.version;

  const specs = [
    {
      id: 'esbuild-platform',
      candidates: [mac
        ? `@esbuild/${esbuildPackage}/bin/esbuild`
        : `@esbuild/${esbuildPackage}/esbuild.exe`],
    },
    { id: 'esbuild-launcher', candidates: ['esbuild/bin/esbuild'] },
    {
      id: 'sqlite-vec',
      candidates: [
        `sqlite-vec/node_modules/${sqlitePackage}/${mac ? 'vec0.dylib' : 'vec0.dll'}`,
        `${sqlitePackage}/${mac ? 'vec0.dylib' : 'vec0.dll'}`,
      ],
    },
    {
      id: 'canvas',
      candidates: [
        `@napi-rs/canvas/node_modules/@napi-rs/${canvasPackage}/${mac ? `skia.darwin-${arch}.node` : 'skia.win32-x64-msvc.node'}`,
        `@napi-rs/${canvasPackage}/${mac ? `skia.darwin-${arch}.node` : 'skia.win32-x64-msvc.node'}`,
      ],
    },
    {
      id: 'tokenizers',
      candidates: [
        `@anush008/tokenizers/node_modules/@anush008/${tokenizersPackage}/${mac ? 'tokenizers.darwin-universal.node' : 'tokenizers.win32-x64-msvc.node'}`,
        `@anush008/${tokenizersPackage}/${mac ? 'tokenizers.darwin-universal.node' : 'tokenizers.win32-x64-msvc.node'}`,
      ],
    },
    { id: 'better-sqlite3', candidates: ['better-sqlite3/build/Release/better_sqlite3.node'] },
    { id: 'onnxruntime-binding', candidates: [joinRelative(onnxBase, 'onnxruntime_binding.node')] },
    {
      id: 'onnxruntime-core',
      candidates: [joinRelative(onnxBase, mac ? `libonnxruntime.${onnxVersion}.dylib` : 'onnxruntime.dll')],
    },
  ];

  if (mac) {
    specs.push({ id: 'fsevents', candidates: ['fsevents/fsevents.node'] });
  }
  return specs;
}

function isNativePayloadFile(name) {
  return name === 'esbuild'
    || name === 'esbuild.exe'
    || /\.node$/i.test(name)
    || /\.dll$/i.test(name)
    || /\.dylib$/i.test(name)
    || /\.so(?:\.|$)/i.test(name);
}

function collectNativePayloadFiles(root, current = root, out = []) {
  if (!fs.existsSync(current)) return out;
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      collectNativePayloadFiles(root, absolute, out);
    } else if (entry.isFile() && isNativePayloadFile(entry.name)) {
      out.push(slash(path.relative(root, absolute)));
    }
  }
  return out;
}

function requiredNativeVerificationEntries(platform, arch) {
  const key = targetKey(platform, arch);
  if (!TARGETS.has(key)) {
    throw new Error(`[native-package-gate] unsupported packaged native target: ${key}`);
  }
  const ids = [
    'esbuild-platform',
    'esbuild-launcher',
    'sqlite-vec',
    'canvas',
    'tokenizers',
    'better-sqlite3',
    'onnxruntime-binding',
    'onnxruntime-core',
    ...(platform === 'darwin' ? ['fsevents'] : []),
  ];
  return ids.map((id) => `native:${id}:${key}`);
}

function verifyNativePackagePayload(nodeModules, platform, arch, options = {}) {
  if (!fs.existsSync(nodeModules) || !fs.statSync(nodeModules).isDirectory()) {
    throw new Error(`[native-package-gate] missing packaged node_modules: ${nodeModules}`);
  }
  const key = targetKey(platform, arch);
  const declared = new Set();
  const verified = [];
  for (const spec of nativePackageContract(nodeModules, platform, arch)) {
    const relativePath = firstExistingFile(nodeModules, spec.id, spec.candidates);
    const absolute = path.join(nodeModules, ...relativePath.split('/'));
    assertExecutableArch(absolute, platform, arch, options);
    declared.add(relativePath);
    verified.push(`native:${spec.id}:${key}`);
  }

  const actual = collectNativePayloadFiles(nodeModules).sort();
  const unexpected = actual.filter((relativePath) => !declared.has(relativePath));
  if (unexpected.length > 0) {
    throw new Error('[native-package-gate] unregistered native package payload(s): '
      + `${unexpected.join(', ')}. Register each real runtime dependency in native-package-gate.cjs.`);
  }

  const missingResults = requiredNativeVerificationEntries(platform, arch)
    .filter((entry) => !verified.includes(entry));
  if (missingResults.length > 0) {
    throw new Error(`[native-package-gate] verifier has no result for: ${missingResults.join(', ')}`);
  }
  return verified;
}

module.exports = {
  TARGETS,
  collectNativePayloadFiles,
  nativePackageContract,
  requiredNativeVerificationEntries,
  targetKey,
  verifyNativePackagePayload,
};
