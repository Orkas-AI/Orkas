#!/usr/bin/env node
/**
 * Install the pinned whisper.cpp CLI + multilingual base-q5_1 model into
 * resources/runtime/whisper/<platform>-<arch>.
 *
 * Development launch and electron-builder beforePack both call this script.
 * It never downloads at production task time: packaged applications only
 * consume the already-verified payload copied through extraResources.
 */
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const AdmZip = require('adm-zip');
const { WHISPER_RUNTIME_CONTRACT } = require('../bin/runtime-gate.cjs');
const { installWindowsVcRuntime } = require('./fetch-win-vc-runtime.cjs');

const pcRoot = path.resolve(__dirname, '..');
const vendorWhisperRoot = path.join(pcRoot, 'vendor', 'whisper');
const vendorRoot = path.join(vendorWhisperRoot, `v${WHISPER_RUNTIME_CONTRACT.version}`);
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

function runtimeVersion(target) {
  return target.version || WHISPER_RUNTIME_CONTRACT.version;
}

function noticeForTarget(target) {
  const version = runtimeVersion(target);
  const openBlasNotice = target.openBlasVersion ? `
Windows OpenBLAS acceleration:
  https://github.com/OpenMathLib/OpenBLAS/tree/v${target.openBlasVersion}
  BSD-3-Clause; see LICENSE.openblas.
` : '';
  return `Bundled whisper.cpp runtime
===========================

Orkas invokes whisper.cpp as a separate process for local VideoStudio speech
transcription. The runtime version is ${version}.

whisper.cpp source and license:
  https://github.com/ggml-org/whisper.cpp/tree/v${version}
  MIT; see LICENSE.whisper.cpp.

Multilingual Whisper base-q5_1 model:
  https://huggingface.co/ggerganov/whisper.cpp
  Derived from OpenAI Whisper; MIT; see LICENSE.model.

The Windows CLI is the official whisper.cpp x64 release. Its required Microsoft
Visual C++ runtime DLLs are deployed application-locally beside whisper-cli;
Orkas does not install or modify the machine-wide Visual C++ Redistributable.
Microsoft redistributable terms apply:
  https://visualstudio.microsoft.com/license-terms/

${openBlasNotice}
The macOS CLIs are static target-native builds whose pinned source, toolchain,
flags, sizes, and hashes are documented in vendor/whisper/v${WHISPER_RUNTIME_CONTRACT.version}/BUILD.md.
`;
}

const hostTarget = WHISPER_RUNTIME_CONTRACT.targets[`${process.platform}-${process.arch}`]
  || { version: WHISPER_RUNTIME_CONTRACT.version };
const NOTICE = noticeForTarget(hostTarget);

function argValue(flag, argv = process.argv) {
  const i = argv.indexOf(flag);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

function targetOptions(argv = process.argv) {
  return {
    platform: argValue('--platform', argv) || process.platform,
    arch: argValue('--arch', argv) || process.arch,
    force: argv.includes('--force'),
  };
}

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function sha256File(file) {
  return sha256Buffer(fs.readFileSync(file));
}

function fileRecord(file) {
  return { bytes: fs.statSync(file).size, sha256: sha256File(file) };
}

function matchesFile(file, expected) {
  try {
    const actual = fileRecord(file);
    return actual.bytes === expected.bytes && actual.sha256 === expected.sha256;
  } catch {
    return false;
  }
}

const RETRYABLE_WINDOWS_FS_ERRORS = new Set(['EACCES', 'EBUSY', 'ENOTEMPTY', 'EPERM']);

function waitSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function retryFsMutation(operation, options = {}) {
  const retries = options.retries ?? (process.platform === 'win32' ? 6 : 0);
  const retryDelayMs = options.retryDelayMs ?? 50;
  const wait = options.wait || waitSync;
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return operation();
    } catch (err) {
      lastError = err;
      if (attempt === retries || !RETRYABLE_WINDOWS_FS_ERRORS.has(err && err.code)) throw err;
      wait(retryDelayMs * (2 ** attempt));
    }
  }
  throw lastError;
}

function replaceDirectoryTransactional(tempDir, destDir, options = {}) {
  const io = options.fs || fs;
  const backupDir = options.backupDir || `${destDir}.replace-backup`;
  const retryOptions = {
    retries: options.retries,
    retryDelayMs: options.retryDelayMs,
    wait: options.wait,
  };
  const mutate = operation => retryFsMutation(operation, retryOptions);
  const remove = dir => io.rmSync(dir, {
    recursive: true,
    force: true,
    maxRetries: options.retries ?? (process.platform === 'win32' ? 6 : 0),
    retryDelay: options.retryDelayMs ?? 50,
  });

  // Recover a previous interrupted swap before starting a new one. The
  // backup name is stable across PIDs so a killed provisioner cannot strand
  // the only good runtime under an undiscoverable process-specific path.
  if (io.existsSync(backupDir)) {
    if (io.existsSync(destDir)) remove(backupDir);
    else mutate(() => io.renameSync(backupDir, destDir));
  }
  const hadExisting = io.existsSync(destDir);
  if (hadExisting) mutate(() => io.renameSync(destDir, backupDir));
  try {
    mutate(() => io.renameSync(tempDir, destDir));
  } catch (installError) {
    if (hadExisting) {
      try {
        mutate(() => io.renameSync(backupDir, destDir));
      } catch (rollbackError) {
        throw new AggregateError(
          [installError, rollbackError],
          `failed to replace ${destDir} and restore the previous runtime`,
        );
      }
    }
    throw installError;
  }
  try {
    remove(backupDir);
  } catch (cleanupError) {
    // Do not report a successful install while a stale runtime directory is
    // still present (the packaging gate intentionally rejects extras).
    // Restore the previously valid runtime so a later retry starts cleanly.
    try {
      mutate(() => io.renameSync(destDir, tempDir));
      mutate(() => io.renameSync(backupDir, destDir));
    } catch (rollbackError) {
      throw new AggregateError(
        [cleanupError, rollbackError],
        `installed ${destDir}, but failed to remove or restore its previous runtime`,
      );
    }
    throw cleanupError;
  }
}

function rel(root, relativePath) {
  return path.join(root, ...String(relativePath).split('/'));
}

function expectedFiles(target) {
  return {
    ...target.files,
    ...(target.appLocalFiles || {}),
    [WHISPER_RUNTIME_CONTRACT.model.relativePath]: WHISPER_RUNTIME_CONTRACT.model,
    ...WHISPER_RUNTIME_CONTRACT.licenses,
    ...(target.licenses || {}),
  };
}

function ready(destDir, platformKey, target) {
  const version = runtimeVersion(target);
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(destDir, '.orkas-whisper-ready.json'), 'utf8'));
    if (marker.schema !== WHISPER_RUNTIME_CONTRACT.schema
      || marker.platformKey !== platformKey
      || marker.version !== version
      || marker.model !== WHISPER_RUNTIME_CONTRACT.model.name) return false;
    for (const [relativePath, expected] of Object.entries(expectedFiles(target))) {
      const file = rel(destDir, relativePath);
      const recorded = marker.files && marker.files[relativePath];
      if (!matchesFile(file, expected) || !recorded
        || recorded.bytes !== expected.bytes || recorded.sha256 !== expected.sha256) return false;
    }
    return fs.readFileSync(path.join(destDir, 'NOTICE.txt'), 'utf8') === noticeForTarget(target);
  } catch {
    return false;
  }
}

async function downloadBuffer(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(url, { redirect: 'follow', signal: controller.signal });
    if (!response.ok) throw new Error(`download ${url} -> HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new Error(`download timed out after ${DOWNLOAD_TIMEOUT_MS / 1000}s: ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

function cacheRoot() {
  if (process.env.ORKAS_RUNTIME_CACHE_DIR) return path.resolve(process.env.ORKAS_RUNTIME_CACHE_DIR);
  return path.join(os.homedir(), '.cache', 'orkas-runtime', 'whisper');
}

async function cachedDownload(name, spec) {
  const root = cacheRoot();
  const file = path.join(root, name);
  if (matchesFile(file, spec)) return file;
  fs.mkdirSync(root, { recursive: true });
  const part = `${file}.${process.pid}.part`;
  try {
    console.log(`[fetch-whisper] downloading ${name}`);
    const buffer = await downloadBuffer(spec.url);
    const actual = { bytes: buffer.length, sha256: sha256Buffer(buffer) };
    if (actual.bytes !== spec.bytes || actual.sha256 !== spec.sha256) {
      throw new Error(`${name} integrity mismatch: expected ${spec.bytes}/${spec.sha256}, got ${actual.bytes}/${actual.sha256}`);
    }
    fs.writeFileSync(part, buffer);
    // rename-over-existing is not consistently atomic on Windows. A stale or
    // corrupt cache entry has already failed matchesFile(), so remove it first.
    fs.rmSync(file, { force: true });
    fs.renameSync(part, file);
    return file;
  } finally {
    fs.rmSync(part, { force: true });
  }
}

function copyPinned(source, destination, expected, executable = false) {
  if (!matchesFile(source, expected)) {
    throw new Error(`pinned Whisper source mismatch: ${source}`);
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
  if (executable) fs.chmodSync(destination, 0o755);
}

function writeWindowsFiles(archiveFile, tempDir, target) {
  const zip = new AdmZip(archiveFile);
  for (const [relativePath, expected] of Object.entries(target.files)) {
    const entry = zip.getEntry(expected.archivePath);
    if (!entry) throw new Error(`whisper.cpp archive missing ${expected.archivePath}`);
    const buffer = entry.getData();
    if (buffer.length !== expected.bytes || sha256Buffer(buffer) !== expected.sha256) {
      throw new Error(`whisper.cpp archive entry mismatch: ${expected.archivePath}`);
    }
    const destination = rel(tempDir, relativePath);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, buffer);
  }
}

function writeWindowsAppLocalFiles(vcRuntimeDir, tempDir, target) {
  for (const [relativePath, expected] of Object.entries(target.appLocalFiles || {})) {
    copyPinned(path.join(vcRuntimeDir, path.basename(relativePath)), rel(tempDir, relativePath), expected, true);
  }
}

function writeMacFiles(tempDir, platformKey, target) {
  for (const [relativePath, expected] of Object.entries(target.files)) {
    const source = path.join(vendorRoot, platformKey, path.basename(relativePath));
    copyPinned(source, rel(tempDir, relativePath), expected, true);
  }
}

function writeLicenses(tempDir, target) {
  for (const [relativePath, expected] of Object.entries(WHISPER_RUNTIME_CONTRACT.licenses)) {
    copyPinned(path.join(vendorRoot, relativePath), rel(tempDir, relativePath), expected);
  }
  for (const [relativePath, expected] of Object.entries(target.licenses || {})) {
    copyPinned(rel(vendorWhisperRoot, expected.vendorPath), rel(tempDir, relativePath), expected);
  }
  fs.writeFileSync(path.join(tempDir, 'NOTICE.txt'), noticeForTarget(target));
}

function writeMarker(tempDir, platformKey, target) {
  const files = {};
  for (const relativePath of Object.keys(expectedFiles(target))) {
    files[relativePath] = fileRecord(rel(tempDir, relativePath));
  }
  fs.writeFileSync(path.join(tempDir, '.orkas-whisper-ready.json'), `${JSON.stringify({
    schema: WHISPER_RUNTIME_CONTRACT.schema,
    platformKey,
    version: runtimeVersion(target),
    model: WHISPER_RUNTIME_CONTRACT.model.name,
    source: target.source,
    capability: { status: 'ready' },
    files,
  }, null, 2)}\n`);
}

function writeCapabilityState(destDir, capability) {
  const markerFile = path.join(destDir, '.orkas-whisper-ready.json');
  const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
  marker.capability = capability;
  fs.writeFileSync(markerFile, `${JSON.stringify(marker, null, 2)}\n`);
}

function isWindowsIllegalInstruction(status) {
  return Number.isInteger(status) && (status >>> 0) === 0xC000001D;
}

function smokeCli(destDir, platform) {
  const cli = path.join(destDir, 'bin', platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli');
  const result = spawnSync(cli, ['-h'], { encoding: 'utf8', timeout: 20_000, maxBuffer: 2 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (platform === 'win32' && isWindowsIllegalInstruction(result.status)) {
    console.warn('[fetch-whisper] pinned whisper-cli requires CPU instructions unavailable on this machine; local transcription is disabled');
    return { status: 'disabled', reason: 'unsupported_cpu' };
  }
  if (result.status !== 0 || !`${result.stdout || ''}${result.stderr || ''}`.includes('--output-json-full')) {
    throw new Error(`whisper-cli capability smoke failed: ${cli}`);
  }
  return { status: 'ready' };
}

async function installWhisper(options = targetOptions()) {
  const platformKey = `${options.platform}-${options.arch}`;
  const target = WHISPER_RUNTIME_CONTRACT.targets[platformKey];
  if (!target) {
    throw new Error(`Whisper runtime is not configured for ${platformKey}; supported targets: ${Object.keys(WHISPER_RUNTIME_CONTRACT.targets).join(', ')}`);
  }
  const version = runtimeVersion(target);
  const vcRuntimeDir = options.platform === 'win32'
    ? await installWindowsVcRuntime({ platform: options.platform, arch: options.arch, force: options.force })
    : undefined;
  const kindRoot = path.join(pcRoot, 'resources', 'runtime', 'whisper');
  const destDir = path.join(kindRoot, platformKey);
  if (!options.force && ready(destDir, platformKey, target)) {
    console.log(`[fetch-whisper] Whisper already ready for ${platformKey}`);
    return destDir;
  }

  fs.mkdirSync(kindRoot, { recursive: true });
  const tempDir = path.join(kindRoot, `.${platformKey}.${process.pid}.tmp`);
  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.mkdirSync(tempDir, { recursive: true });
  try {
    if (options.platform === 'darwin') {
      writeMacFiles(tempDir, platformKey, target);
    } else if (options.platform === 'win32') {
      const archive = await cachedDownload(target.archive.cacheName || `whisper-bin-x64-v${version}.zip`, target.archive);
      writeWindowsFiles(archive, tempDir, target);
      writeWindowsAppLocalFiles(vcRuntimeDir, tempDir, target);
    }

    const model = await cachedDownload('ggml-base-q5_1.bin', WHISPER_RUNTIME_CONTRACT.model);
    copyPinned(model, rel(tempDir, WHISPER_RUNTIME_CONTRACT.model.relativePath), WHISPER_RUNTIME_CONTRACT.model);
    writeLicenses(tempDir, target);
    writeMarker(tempDir, platformKey, target);

    replaceDirectoryTransactional(tempDir, destDir);
    if (options.platform === process.platform && options.arch === process.arch) {
      writeCapabilityState(destDir, smokeCli(destDir, options.platform));
    }
    console.log(`[fetch-whisper] installed whisper.cpp ${version} + ${WHISPER_RUNTIME_CONTRACT.model.name} for ${platformKey}`);
    return destDir;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

if (require.main === module) {
  installWhisper().catch(err => {
    console.error(`[fetch-whisper] failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  NOTICE,
  expectedFiles,
  installWhisper,
  isWindowsIllegalInstruction,
  matchesFile,
  noticeForTarget,
  replaceDirectoryTransactional,
  retryFsMutation,
  runtimeVersion,
  targetOptions,
  writeCapabilityState,
  writeWindowsAppLocalFiles,
};
