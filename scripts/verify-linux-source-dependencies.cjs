#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { verifyEmbeddingModelRoot } = require('../bin/packaged-resource-gate.cjs');
const {
  WHISPER_RUNTIME_CONTRACT,
  verifyFfmpegRuntimeDir,
  verifyRuntimeDir,
  verifyWhisperRuntimeDir,
} = require('../bin/runtime-gate.cjs');

const PC_ROOT = path.resolve(__dirname, '..');
const MINIMUM_NODE_MAJOR = 20;
// The official whisper.cpp v1.9.1 Ubuntu x64/arm64 releases require symbols
// through GLIBC_2.34, so the source bootstrap must reject older hosts before
// downloading runtimes that cannot execute there.
const MINIMUM_GLIBC = WHISPER_RUNTIME_CONTRACT.targets['linux-x64'].minimumGlibc;
if (!MINIMUM_GLIBC
  || WHISPER_RUNTIME_CONTRACT.targets['linux-arm64'].minimumGlibc !== MINIMUM_GLIBC) {
  throw new Error('Linux Whisper targets must declare one shared minimum glibc version');
}
const SUPPORTED_ARCHES = Object.freeze(['x64', 'arm64']);

function versionTuple(value) {
  const match = /^(\d+)\.(\d+)/.exec(String(value || '').trim());
  return match ? [Number(match[1]), Number(match[2])] : null;
}

function versionAtLeast(actual, minimum) {
  const a = versionTuple(actual);
  const b = versionTuple(minimum);
  if (!a || !b) return false;
  return a[0] > b[0] || (a[0] === b[0] && a[1] >= b[1]);
}

function runtimeGlibcVersion(report = process.report) {
  try {
    return String(report?.getReport()?.header?.glibcVersionRuntime || '').trim();
  } catch {
    return '';
  }
}

function assertLinuxHost({
  platform = process.platform,
  arch = process.arch,
  nodeVersion = process.versions.node,
  glibcVersionRuntime = runtimeGlibcVersion(),
} = {}) {
  if (platform !== 'linux') return Object.freeze([]);
  if (!SUPPORTED_ARCHES.includes(arch)) {
    throw new Error(`unsupported Linux architecture ${arch}; Orkas source runs support x64 and arm64`);
  }
  const nodeMajor = Number.parseInt(String(nodeVersion).split('.', 1)[0], 10);
  if (!Number.isFinite(nodeMajor) || nodeMajor < MINIMUM_NODE_MAJOR) {
    throw new Error(`Node.js ${MINIMUM_NODE_MAJOR}+ is required; found ${nodeVersion || 'unknown'}`);
  }
  if (!glibcVersionRuntime) {
    throw new Error('glibc is required; Alpine and other musl-based Linux distributions are not supported');
  }
  if (!versionAtLeast(glibcVersionRuntime, MINIMUM_GLIBC)) {
    throw new Error(`glibc ${MINIMUM_GLIBC}+ is required; found ${glibcVersionRuntime}`);
  }
  return Object.freeze([
    `host:linux-${arch}`,
    `host:node-${nodeMajor}`,
    `host:glibc-${glibcVersionRuntime}`,
  ]);
}

function requiredLinuxPackages(arch) {
  if (!SUPPORTED_ARCHES.includes(arch)) {
    throw new Error(`unsupported Linux architecture ${arch}`);
  }
  return Object.freeze([
    '@anush008/tokenizers',
    `@anush008/tokenizers-linux-${arch}-gnu`,
    `@esbuild/linux-${arch}`,
    '@napi-rs/canvas',
    `@napi-rs/canvas-linux-${arch}-gnu`,
    `@img/sharp-linux-${arch}`,
    `@img/sharp-libvips-linux-${arch}`,
    'better-sqlite3',
    'fastembed',
    'sharp',
    'sqlite-vec',
    `sqlite-vec-linux-${arch}`,
  ]);
}

function readJson(file, label) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`${label} is missing or invalid`);
  }
}

function packageDir(root, packageName) {
  return path.join(root, 'node_modules', ...packageName.split('/'));
}

function verifyPackageContract(root, arch) {
  const lock = readJson(path.join(root, 'package-lock.json'), 'package-lock.json');
  const verified = [];
  for (const packageName of requiredLinuxPackages(arch)) {
    const locked = lock.packages?.[`node_modules/${packageName}`]?.version;
    if (!locked) throw new Error(`package-lock.json does not declare ${packageName}`);
    const installed = readJson(path.join(packageDir(root, packageName), 'package.json'), packageName).version;
    if (installed !== locked) {
      throw new Error(`${packageName} version mismatch: package-lock=${locked}, installed=${installed || 'missing'}`);
    }
    verified.push(`package:${packageName}@${installed}`);
  }

  const onnxCandidates = [
    path.join(root, 'node_modules', 'fastembed', 'node_modules', 'onnxruntime-node'),
    path.join(root, 'node_modules', 'onnxruntime-node'),
  ].filter((candidate) => fs.existsSync(path.join(candidate, 'package.json')));
  if (onnxCandidates.length !== 1) {
    throw new Error(`expected exactly one onnxruntime-node installation; found ${onnxCandidates.length}`);
  }
  const onnxDir = onnxCandidates[0];
  for (const name of ['onnxruntime_binding.node', 'libonnxruntime.so.1']) {
    const file = path.join(onnxDir, 'bin', 'napi-v3', 'linux', arch, name);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      throw new Error(`onnxruntime-node is missing its linux-${arch} ${name}`);
    }
  }
  verified.push(`package:onnxruntime-node:linux-${arch}`);
  return Object.freeze(verified);
}

function firstUsefulLine(value) {
  return String(value || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) || '';
}

function processFailureReason(result) {
  const output = `${result.stderr || ''}\n${result.stdout || ''}`;
  const sharedLibrary = /error while loading shared libraries:\s*([^:\s]+)[^\n]*/i.exec(output);
  if (sharedLibrary) {
    return `missing Linux shared library ${sharedLibrary[1]}; install the Electron runtime library from your distribution and retry`;
  }
  return result.error?.message
    || firstUsefulLine(result.stderr)
    || firstUsefulLine(result.stdout)
    || `exit ${result.status}`;
}

function runChecked(label, command, args, options = {}) {
  const result = (options.spawn || spawnSync)(command, args, {
    cwd: options.cwd || PC_ROOT,
    encoding: 'utf8',
    env: options.env || process.env,
    timeout: options.timeout || 30_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`${label} failed: ${processFailureReason(result)}`);
  }
  return result;
}

function verifyRuntimeContract(root, arch) {
  const runtimeRoot = path.join(root, 'resources', 'runtime');
  const manifest = readJson(path.join(runtimeRoot, 'manifest.json'), 'runtime manifest');
  const key = `linux-${arch}`;
  const verified = [];
  for (const kind of ['python', 'uv', 'node']) {
    const spec = manifest[kind];
    const asset = spec?.assets?.[key];
    if (!spec || !asset) throw new Error(`runtime manifest does not declare ${kind} for ${key}`);
    const dir = path.join(runtimeRoot, kind, key);
    const executable = verifyRuntimeDir(kind, dir, key, spec, asset, 'linux', arch);
    runChecked(`${kind} runtime`, executable, ['--version']);
    verified.push(`runtime:${kind}:${key}`);
  }
  verifyFfmpegRuntimeDir(runtimeRoot, 'linux', arch);
  verified.push(`runtime:ffmpeg:${key}`);
  verifyWhisperRuntimeDir(runtimeRoot, 'linux', arch);
  verified.push(`runtime:whisper:${key}`);
  return Object.freeze(verified);
}

function verifyOfficeCli(root, arch) {
  runChecked(
    'OfficeCLI policy gate',
    process.execPath,
    [path.join(root, 'bin', 'officecli-policy-gate.cjs'), `--root=${root}`, '--require-host-binary'],
    { cwd: root, timeout: 60_000 },
  );
  return Object.freeze([`runtime:officecli:linux-${arch}`]);
}

function runNativeProbe(root, { fullEmbedding = false } = {}) {
  const electronCli = require.resolve('electron/cli.js', { paths: [root] });
  const args = [electronCli, path.join(root, 'scripts', 'linux-native-dependency-probe.cjs')];
  if (fullEmbedding) args.push('--full-embedding');
  runChecked('Electron native dependency probe', process.execPath, args, {
    cwd: root,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    timeout: fullEmbedding ? 2 * 60_000 : 60_000,
  });
  return Object.freeze([fullEmbedding ? 'native:embedding-inference' : 'native:load-probe']);
}

function runElectronSmoke(root) {
  const electronCli = require.resolve('electron/cli.js', { paths: [root] });
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  runChecked(
    'Electron GUI smoke',
    process.execPath,
    [electronCli, path.join(root, 'scripts', 'linux-electron-smoke.cjs')],
    { cwd: root, env, timeout: 60_000 },
  );
  return Object.freeze(['electron:hidden-window']);
}

function parseArgs(argv) {
  const options = { fullEmbedding: false, gui: false, hostOnly: false, root: PC_ROOT };
  for (const arg of argv) {
    if (arg === '--full-embedding') options.fullEmbedding = true;
    else if (arg === '--gui') options.gui = true;
    else if (arg === '--host-only') options.hostOnly = true;
    else if (arg.startsWith('--root=')) options.root = path.resolve(arg.slice('--root='.length));
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (process.platform !== 'linux') {
    console.log(`[linux-deps] skipped on ${process.platform}-${process.arch}`);
    return;
  }
  const verified = [...assertLinuxHost()];
  if (!options.hostOnly) {
    verified.push(...verifyPackageContract(options.root, process.arch));
    verified.push(verifyEmbeddingModelRoot(path.join(options.root, 'resources', 'embedding-model')));
    verified.push(...verifyRuntimeContract(options.root, process.arch));
    verified.push(...verifyOfficeCli(options.root, process.arch));
    verified.push(...runNativeProbe(options.root, { fullEmbedding: options.fullEmbedding }));
    if (options.gui) verified.push(...runElectronSmoke(options.root));
  }
  console.log(`[linux-deps] verified ${verified.join(', ')}`);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`[linux-deps] failed: ${err.message}`);
    process.exit(1);
  }
}

module.exports = {
  MINIMUM_GLIBC,
  MINIMUM_NODE_MAJOR,
  SUPPORTED_ARCHES,
  assertLinuxHost,
  firstUsefulLine,
  parseArgs,
  processFailureReason,
  requiredLinuxPackages,
  runtimeGlibcVersion,
  verifyPackageContract,
  versionAtLeast,
};
