#!/usr/bin/env node
/**
 * Provision the pinned Microsoft VC++ runtime DLLs for application-local
 * deployment. The Windows installer never executes vc_redist.exe: the DLLs
 * are copied into the packaged app and beside whisper-cli instead.
 */
'use strict';

const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  WINDOWS_VC_RUNTIME_CONTRACT,
  assertExecutableArch,
} = require('../bin/runtime-gate.cjs');

const pcRoot = path.resolve(__dirname, '..');
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const NOTICE = `Bundled Microsoft Visual C++ runtime (application-local)
=========================================================

Orkas ships the Microsoft Visual C++ runtime DLLs required by its Windows
ONNX/tokenizer and whisper.cpp binaries beside the application. Orkas does not
install or modify the machine-wide Visual C++ Redistributable.

Source package:
  ${WINDOWS_VC_RUNTIME_CONTRACT.source.url}
  Microsoft Visual C++ v14 x64 Redistributable
  Version ${WINDOWS_VC_RUNTIME_CONTRACT.version}

Microsoft redistributable terms apply:
  https://visualstudio.microsoft.com/license-terms/

Application-local deployment means Orkas must deliver runtime security and
servicing updates through normal Orkas application updates.
`;

function argValue(flag, argv = process.argv) {
  const index = argv.indexOf(flag);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1] : undefined;
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

function fileRecord(file) {
  const bytes = fs.readFileSync(file);
  return { bytes: bytes.length, sha256: sha256Buffer(bytes) };
}

function matchesFile(file, expected) {
  try {
    const actual = fileRecord(file);
    return actual.bytes === expected.bytes && actual.sha256 === expected.sha256;
  } catch {
    return false;
  }
}

function cacheRoot() {
  if (process.env.ORKAS_RUNTIME_CACHE_DIR) {
    return path.join(path.resolve(process.env.ORKAS_RUNTIME_CACHE_DIR), 'vc');
  }
  return path.join(os.homedir(), '.cache', 'orkas-runtime', 'vc');
}

async function downloadOnce(url) {
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

async function downloadBuffer(url) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await downloadOnce(url);
    } catch (err) {
      lastError = err;
      if (attempt === 3) break;
      console.warn(`[fetch-win-vc-runtime] download attempt ${attempt} failed: ${err.message}; retrying`);
      await new Promise(resolve => setTimeout(resolve, attempt * 1000));
    }
  }
  throw lastError;
}

async function cachedSourcePackage(contract = WINDOWS_VC_RUNTIME_CONTRACT) {
  const root = cacheRoot();
  const file = path.join(root, contract.source.name);
  if (matchesFile(file, contract.source)) return file;
  fs.mkdirSync(root, { recursive: true });
  const part = `${file}.${process.pid}.part`;
  try {
    console.log(`[fetch-win-vc-runtime] downloading ${contract.source.name}`);
    const buffer = await downloadBuffer(contract.source.url);
    const actual = { bytes: buffer.length, sha256: sha256Buffer(buffer) };
    if (actual.bytes !== contract.source.bytes || actual.sha256 !== contract.source.sha256) {
      throw new Error(`${contract.source.name} integrity mismatch: expected `
        + `${contract.source.bytes}/${contract.source.sha256}, got ${actual.bytes}/${actual.sha256}`);
    }
    fs.writeFileSync(part, buffer);
    fs.rmSync(file, { force: true });
    fs.renameSync(part, file);
    return file;
  } finally {
    fs.rmSync(part, { force: true });
  }
}

function burnAttachedContainer(archive) {
  if (archive.length < 0x40 || archive.toString('ascii', 0, 2) !== 'MZ') {
    throw new Error('Microsoft VC Redistributable is not a PE executable');
  }
  const peOffset = archive.readUInt32LE(0x3c);
  if (peOffset + 24 > archive.length || archive.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') {
    throw new Error('Microsoft VC Redistributable has no PE header');
  }
  const sectionCount = archive.readUInt16LE(peOffset + 6);
  const optionalHeaderBytes = archive.readUInt16LE(peOffset + 20);
  const optionalHeaderOffset = peOffset + 24;
  const optionalMagic = archive.readUInt16LE(optionalHeaderOffset);
  const dataDirectoryOffset = optionalHeaderOffset + (optionalMagic === 0x10b ? 96 : 112);
  if (![0x10b, 0x20b].includes(optionalMagic) || dataDirectoryOffset + 40 > archive.length) {
    throw new Error('Microsoft VC Redistributable has an unsupported PE optional header');
  }
  const currentSignatureOffset = archive.readUInt32LE(dataDirectoryOffset + 32);
  const currentSignatureBytes = archive.readUInt32LE(dataDirectoryOffset + 36);
  let sectionOffset = peOffset + 24 + optionalHeaderBytes;
  let burnOffset = -1;
  for (let index = 0; index < sectionCount; index += 1, sectionOffset += 40) {
    if (sectionOffset + 40 > archive.length) {
      throw new Error('Microsoft VC Redistributable has a truncated PE section table');
    }
    const name = archive.subarray(sectionOffset, sectionOffset + 8).toString('ascii').replace(/\0.*$/, '');
    if (name === '.wixburn') {
      burnOffset = archive.readUInt32LE(sectionOffset + 20);
      break;
    }
  }
  if (burnOffset < 0 || burnOffset + 56 > archive.length) {
    throw new Error('Microsoft VC Redistributable has no complete WiX Burn section');
  }
  const magic = archive.readUInt32LE(burnOffset);
  const version = archive.readUInt32LE(burnOffset + 4);
  const originalSignatureOffset = archive.readUInt32LE(burnOffset + 32);
  const originalSignatureBytes = archive.readUInt32LE(burnOffset + 36);
  const format = archive.readUInt32LE(burnOffset + 40);
  const containerCount = archive.readUInt32LE(burnOffset + 44);
  const attachedBytes = archive.readUInt32LE(burnOffset + 52);
  if (magic !== 0x00F14300 || version !== 2 || format !== 1 || containerCount !== 2) {
    throw new Error('Microsoft VC Redistributable uses an unsupported WiX Burn layout');
  }
  const attachedOffset = originalSignatureOffset + originalSignatureBytes;
  const attachedEnd = attachedOffset + attachedBytes;
  const unsignedEnd = currentSignatureOffset || archive.length;
  const signatureIsValid = currentSignatureOffset
    ? currentSignatureOffset + currentSignatureBytes === archive.length
    : currentSignatureBytes === 0;
  const padding = archive.subarray(attachedEnd, unsignedEnd);
  if (!originalSignatureOffset || !originalSignatureBytes || !attachedBytes || !signatureIsValid
    || attachedEnd > unsignedEnd || padding.length > 7 || padding.some((byte) => byte !== 0)) {
    throw new Error('Microsoft VC Redistributable has an invalid attached container boundary');
  }
  const container = archive.subarray(attachedOffset, attachedOffset + attachedBytes);
  if (container.toString('ascii', 0, 4) !== 'MSCF') {
    throw new Error('Microsoft VC Redistributable attached payload is not a CAB');
  }
  return Buffer.from(container);
}

function sevenZipExtract(archiveFile, destination) {
  const { path7za } = require('7zip-bin');
  fs.mkdirSync(destination, { recursive: true });
  if (process.platform !== 'win32') fs.chmodSync(path7za, 0o755);
  execFileSync(path7za, ['x', '-y', `-o${destination}`, archiveFile], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

function windowsExpandExtract(archiveFile, destination, options = {}) {
  fs.mkdirSync(destination, { recursive: true });
  const systemRoot = String(options.systemRoot || process.env.SystemRoot || 'C:\\Windows');
  const expand = path.join(systemRoot, 'System32', 'expand.exe');
  const execute = options.execFileSync || execFileSync;
  execute(expand, [archiveFile, '-F:*', destination], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

function defaultArchiveExtract(archiveFile, destination) {
  if (process.platform === 'win32') {
    windowsExpandExtract(archiveFile, destination);
    return;
  }
  sevenZipExtract(archiveFile, destination);
}

function assertRecord(label, file, expected) {
  const actual = fileRecord(file);
  if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
    throw new Error(`${label} integrity mismatch: expected ${expected.bytes}/${expected.sha256}, `
      + `got ${actual.bytes}/${actual.sha256}`);
  }
  return actual;
}

function extractPackage(archiveFile, destination, contract = WINDOWS_VC_RUNTIME_CONTRACT, options = {}) {
  assertRecord('pinned Microsoft VC Redistributable', archiveFile, contract.source);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-vc-redist-'));
  const extract = options.extractArchive || options.sevenZipExtract || defaultArchiveExtract;
  try {
    const attachedFile = path.join(work, 'attached.cab');
    fs.writeFileSync(attachedFile, burnAttachedContainer(fs.readFileSync(archiveFile)));
    assertRecord('Microsoft VC Redistributable attached CAB', attachedFile, contract.source.attachedCab);

    const attachedDir = path.join(work, 'attached');
    extract(attachedFile, attachedDir);
    const runtimeCab = path.join(attachedDir, contract.source.x64RuntimeCab.embeddedName);
    assertRecord('Microsoft VC Redistributable x64 runtime CAB', runtimeCab, contract.source.x64RuntimeCab);

    const runtimeDir = path.join(work, 'runtime');
    extract(runtimeCab, runtimeDir);
    const files = {};
    for (const [name, expected] of Object.entries(contract.files)) {
      const source = path.join(runtimeDir, expected.sourceName);
      const actual = assertRecord(`Microsoft VC Redistributable entry ${name}`, source, expected);
      fs.copyFileSync(source, path.join(destination, name));
      files[name] = actual;
    }
    return files;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

function ready(destination, contract = WINDOWS_VC_RUNTIME_CONTRACT) {
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(destination, '.orkas-vc-runtime.json'), 'utf8'));
    if (marker.schema !== contract.schema
      || marker.platformKey !== contract.platformKey
      || marker.version !== contract.version
      || marker.sourceSha256 !== contract.source.sha256) return false;
    for (const [name, expected] of Object.entries(contract.files)) {
      const recorded = marker.files && marker.files[name];
      if (!matchesFile(path.join(destination, name), expected)
        || !recorded || recorded.bytes !== expected.bytes || recorded.sha256 !== expected.sha256) return false;
    }
    return fs.readFileSync(path.join(destination, 'NOTICE.txt'), 'utf8') === NOTICE;
  } catch {
    return false;
  }
}

async function installWindowsVcRuntime(options = targetOptions()) {
  const key = `${options.platform}-${options.arch}`;
  const contract = options.contract || WINDOWS_VC_RUNTIME_CONTRACT;
  if (key !== contract.platformKey) {
    throw new Error(`application-local VC runtime is not configured for ${key}`);
  }
  const destination = options.destination
    || path.join(pcRoot, 'resources', 'runtime', 'vc', key);
  if (!options.force && ready(destination, contract)) {
    console.log(`[fetch-win-vc-runtime] Microsoft VC runtime already ready for ${key}`);
    return destination;
  }

  const archiveFile = options.archiveFile || await cachedSourcePackage(contract);
  const parent = path.dirname(destination);
  const temporary = path.join(parent, `.${key}.${process.pid}.tmp`);
  fs.rmSync(temporary, { recursive: true, force: true });
  fs.mkdirSync(temporary, { recursive: true });
  try {
    const files = extractPackage(archiveFile, temporary, contract, {
      ...(options.sevenZipExtract ? { sevenZipExtract: options.sevenZipExtract } : {}),
    });
    for (const name of Object.keys(contract.files)) {
      assertExecutableArch(path.join(temporary, name), 'win32', 'x64');
    }
    fs.writeFileSync(path.join(temporary, 'NOTICE.txt'), NOTICE);
    fs.writeFileSync(path.join(temporary, '.orkas-vc-runtime.json'), `${JSON.stringify({
      schema: contract.schema,
      platformKey: contract.platformKey,
      version: contract.version,
      source: contract.source.name,
      sourceSha256: contract.source.sha256,
      deployment: 'application-local',
      files,
    }, null, 2)}\n`);
    fs.mkdirSync(parent, { recursive: true });
    fs.rmSync(destination, { recursive: true, force: true });
    fs.renameSync(temporary, destination);
    console.log(`[fetch-win-vc-runtime] installed Microsoft VC runtime ${contract.version} for ${key}`);
    return destination;
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

if (require.main === module) {
  installWindowsVcRuntime().catch((err) => {
    console.error(`[fetch-win-vc-runtime] failed: ${err.message}`);
    process.exit(1);
  });
}

module.exports = {
  NOTICE,
  burnAttachedContainer,
  extractPackage,
  installWindowsVcRuntime,
  matchesFile,
  ready,
  sevenZipExtract,
  windowsExpandExtract,
  targetOptions,
};
