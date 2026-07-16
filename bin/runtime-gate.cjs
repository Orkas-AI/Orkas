#!/usr/bin/env node
'use strict';

const { execFileSync, spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

// Single source of truth for resources/runtime packaging. Provisioners may be
// different, but pruning, post-pack verification, release validation, and cache
// isolation must all consume these exported lists instead of copying them.
const MANIFEST_RUNTIME_KINDS = ['python', 'uv', 'node'];
const PACKAGED_RUNTIME_KINDS = [...MANIFEST_RUNTIME_KINDS, 'ffmpeg', 'whisper', 'vc'];
const FFMPEG_CAPABILITIES = ['libass', 'ass', 'subtitles'];
const WINDOWS_VC_RUNTIME_CONTRACT = Object.freeze({
  schema: 1,
  version: '14.51.36247.0',
  platformKey: 'win32-x64',
  source: Object.freeze({
    name: 'VC_redist.x64-14.51.36247.exe',
    url: 'https://download.visualstudio.microsoft.com/download/pr/ebdab8e5-1d7b-4d9f-a11b-cbb1720c3b12/843068991DAAA1F73AD9F6239BCE4D0F6A07A51F18C37EA2A867E9BECA71295C/VC_redist.x64.exe',
    bytes: 18_731_856,
    sha256: '843068991daaa1f73ad9f6239bce4d0f6a07a51f18c37ea2a867e9beca71295c',
    attachedCab: Object.freeze({
      bytes: 18_091_661,
      sha256: '8b1595b5d0001e0747371ecfc2dccb604dc836fba0a778566e97a6bdb0816bb8',
    }),
    x64RuntimeCab: Object.freeze({
      embeddedName: 'a4',
      bytes: 1_065_893,
      sha256: '6e8ee73933678c55973e83366e48e948b394c7a36743a36b7224c95de979b13f',
    }),
  }),
  files: Object.freeze({
    'msvcp140.dll': Object.freeze({ sourceName: 'msvcp140.dll_amd64', bytes: 643_512, sha256: '7c26614e1d733892c2deac7e245ce115504b1d80592dd0a01b08e3e5a55f89ca' }),
    'msvcp140_1.dll': Object.freeze({ sourceName: 'msvcp140_1.dll_amd64', bytes: 35_768, sha256: '206c931bf90fdad8816de3b5e2ef80b2bcaa9406c89ecc05fe6fddffe251e982' }),
    'vcruntime140.dll': Object.freeze({ sourceName: 'vcruntime140.dll_amd64', bytes: 178_616, sha256: 'd1f4225df2cd877dbf130d5668a021dce3f94118455ff5ec952061c30afc9ce7' }),
    'vcruntime140_1.dll': Object.freeze({ sourceName: 'vcruntime140_1.dll_amd64', bytes: 50_112, sha256: 'a7146c08f89fe5b04541ab507cdb59ff7b44534d4ba3c668a426c6450a03434e' }),
    'vcomp140.dll': Object.freeze({ sourceName: 'vcomp140.dll_amd64', bytes: 212_920, sha256: '95d4ce4a6802d1e18b5e0e1722cc30ea72ca7e033f83828f05c0b7b993fe7cbf' }),
  }),
});

function appLocalVcFiles(dir = '') {
  return Object.freeze(Object.fromEntries(
    Object.entries(WINDOWS_VC_RUNTIME_CONTRACT.files).map(([name, spec]) => [
      dir ? `${dir}/${name}` : name,
      spec,
    ]),
  ));
}

const WHISPER_RUNTIME_CONTRACT = Object.freeze({
  schema: 1,
  version: '1.8.6',
  model: Object.freeze({
    name: 'base-q5_1',
    relativePath: 'models/ggml-base-q5_1.bin',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base-q5_1.bin',
    bytes: 59_707_625,
    sha256: '422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898',
  }),
  licenses: Object.freeze({
    'LICENSE.whisper.cpp': Object.freeze({ bytes: 1_078, sha256: '94f29bbed6a22c35b992c5c6ebf0e7c92f13b836b90f36f461c9cf2f0f1d010d' }),
    'LICENSE.model': Object.freeze({ bytes: 1_063, sha256: 'b5d65a59060e68c4ff940e1eddfa6f94b2d68fdf58ed7f4dd57721c997e35e9d' }),
  }),
  targets: Object.freeze({
    'darwin-arm64': Object.freeze({
      source: 'vendored-static-cli',
      files: Object.freeze({
        'bin/whisper-cli': Object.freeze({ bytes: 3_239_016, sha256: '5e378558f90a2d9f883d38f14477798eb64689cf6d57a832c8d72e4dd14f5f38', executable: true }),
      }),
    }),
    'darwin-x64': Object.freeze({
      source: 'vendored-static-cli',
      files: Object.freeze({
        'bin/whisper-cli': Object.freeze({ bytes: 3_734_536, sha256: '290a3827cd9227b0e4033adbc8c147738776ded6068479abf620816af5b69167', executable: true }),
      }),
    }),
    'win32-x64': Object.freeze({
      source: 'official-release-archive',
      archive: Object.freeze({
        url: 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.8.6/whisper-bin-x64.zip',
        bytes: 4_093_849,
        sha256: 'b07ea0b1b4115a38e1a7b07debf581f0b77d999925f8acb8f39d322b0ba0a822',
      }),
      files: Object.freeze({
        'bin/whisper-cli.exe': Object.freeze({ archivePath: 'Release/whisper-cli.exe', bytes: 489_472, sha256: '111bd344b7bf0356818f2795a525cb5240ed0a99028fa9f3f1c68b4ff5b17b91', executable: true }),
        'bin/whisper.dll': Object.freeze({ archivePath: 'Release/whisper.dll', bytes: 484_864, sha256: 'aecc185550327461d74a7c89436e13a62e12cc408c05719e7a677e1586a9cda3', executable: true }),
        'bin/ggml.dll': Object.freeze({ archivePath: 'Release/ggml.dll', bytes: 67_072, sha256: '722ff1350efe25a1bffa048bef2a8aa7fe7552fce3c38d2c1505f99beb0fb1f7', executable: true }),
        'bin/ggml-base.dll': Object.freeze({ archivePath: 'Release/ggml-base.dll', bytes: 636_416, sha256: '017cd9c859d0da3c6d0e8da120ec5641db7c8d1f266df7ce1f9eca42029186ba', executable: true }),
        'bin/ggml-cpu.dll': Object.freeze({ archivePath: 'Release/ggml-cpu.dll', bytes: 782_848, sha256: 'cb5bfd79c0255e282982527fee42d8aa8407b63ae46ef1acd395c3e21d1f52f9', executable: true }),
      }),
      appLocalFiles: appLocalVcFiles('bin'),
    }),
  }),
});

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

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

function verifyDarwinCodeSignature(file, expectedTeamIdentifier) {
  const codesign = '/usr/bin/codesign';
  const verify = spawnSync(codesign, ['--verify', '--strict', file], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (verify.error || verify.status !== 0) {
    const detail = `${verify.stderr || ''}${verify.stdout || ''}`.trim();
    throw new Error(`[native-deps-gate] signed Darwin runtime signature is invalid: ${file}`
      + `${detail ? `: ${detail}` : verify.error ? `: ${verify.error.message}` : ''}`);
  }

  const describe = spawnSync(codesign, ['-dv', '--verbose=2', file], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (describe.error || describe.status !== 0) {
    throw new Error(`[native-deps-gate] cannot read signed Darwin runtime identity: ${file}`
      + `${describe.error ? `: ${describe.error.message}` : ''}`);
  }
  const output = `${describe.stderr || ''}\n${describe.stdout || ''}`;
  const team = /^TeamIdentifier=(.+)$/m.exec(output)?.[1]?.trim() || '';
  if (!team || team === 'not set' || team !== expectedTeamIdentifier) {
    throw new Error(`[native-deps-gate] signed Darwin runtime TeamIdentifier mismatch: expected `
      + `${expectedTeamIdentifier}, got ${team || 'missing'}: ${file}`);
  }
}

function acceptSignedDarwinRuntimeMutation(file, targetPlatform, options = {}) {
  if (targetPlatform !== 'darwin' || options.allowSignedDarwinRuntime !== true) return false;
  const expectedTeamIdentifier = String(options.expectedTeamIdentifier || '').trim();
  if (!expectedTeamIdentifier || expectedTeamIdentifier === 'not set') {
    throw new Error('[native-deps-gate] signed Darwin runtime validation requires an expected TeamIdentifier');
  }
  const verifier = options.verifySignedDarwinBinary || verifyDarwinCodeSignature;
  verifier(file, expectedTeamIdentifier);
  return true;
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

function requireOnlyPackagedRuntimeKinds(runtimeRoot) {
  const allowed = new Set(PACKAGED_RUNTIME_KINDS);
  for (const kind of listDirs(runtimeRoot)) {
    if (!allowed.has(kind)) {
      throw new Error(`[native-deps-gate] unregistered packaged runtime dependency: ${path.join(runtimeRoot, kind)}. `
        + 'Register it in PACKAGED_RUNTIME_KINDS and add its verifier before packaging.');
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

function assertWindowsExecutableArch(file, targetArch) {
  const expectedMachine = {
    ia32: 0x014c,
    x64: 0x8664,
    arm64: 0xaa64,
  }[targetArch];
  if (!expectedMachine) {
    throw new Error(`[native-deps-gate] unsupported Windows runtime arch: ${targetArch}`);
  }
  const buf = fs.readFileSync(file);
  if (buf.length < 0x40 || buf.toString('ascii', 0, 2) !== 'MZ') {
    throw new Error(`[native-deps-gate] runtime binary is not Windows PE: ${file}`);
  }
  const peOffset = buf.readUInt32LE(0x3c);
  if (peOffset <= 0 || peOffset + 6 > buf.length || buf.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') {
    throw new Error(`[native-deps-gate] runtime binary has invalid Windows PE header: ${file}`);
  }
  const actualMachine = buf.readUInt16LE(peOffset + 4);
  if (actualMachine !== expectedMachine) {
    throw new Error(`[native-deps-gate] runtime binary arch mismatch: expected ${targetArch}, file=${file}, `
      + `PE machine=0x${actualMachine.toString(16)}`);
  }
}

function assertLinuxExecutableArch(file, targetArch) {
  const expectedMachine = { ia32: 3, x64: 62, arm64: 183 }[targetArch];
  if (!expectedMachine) {
    throw new Error(`[native-deps-gate] unsupported Linux runtime arch: ${targetArch}`);
  }
  const buf = fs.readFileSync(file);
  if (buf.length < 20 || !buf.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    throw new Error(`[native-deps-gate] runtime binary is not ELF: ${file}`);
  }
  const littleEndian = buf[5] === 1;
  const actualMachine = littleEndian ? buf.readUInt16LE(18) : buf.readUInt16BE(18);
  if (actualMachine !== expectedMachine) {
    throw new Error(`[native-deps-gate] runtime binary arch mismatch: expected ${targetArch}, file=${file}, `
      + `ELF machine=${actualMachine}`);
  }
}

function assertExecutableArch(file, targetPlatform, targetArch, options = {}) {
  if (options.checkArch === false) return;
  if (targetPlatform === 'darwin') assertDarwinExecutableArch(file, targetArch);
  else if (targetPlatform === 'win32') assertWindowsExecutableArch(file, targetArch);
  else if (targetPlatform === 'linux') assertLinuxExecutableArch(file, targetArch);
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

function verifyFfmpegRuntimeDir(runtimeRoot, targetPlatform, targetArch, options = {}) {
  const key = runtimeKey(targetPlatform, targetArch);
  const allowedKeys = options.allowedKeys || [key];
  requireOnlyRuntimeDirs(runtimeRoot, 'ffmpeg', allowedKeys);
  const dir = path.join(runtimeRoot, 'ffmpeg', key);
  const suffix = targetPlatform === 'win32' ? '.exe' : '';
  const binaries = {
    ffmpeg: path.join(dir, `ffmpeg${suffix}`),
    ffprobe: path.join(dir, `ffprobe${suffix}`),
  };
  const markerFile = path.join(dir, '.orkas-ffmpeg-ready.json');
  const marker = readJsonFile('ffmpeg runtime marker', markerFile);
  if (marker.schema !== 1 || marker.platformKey !== key) {
    throw new Error(`[native-deps-gate] ffmpeg runtime marker target mismatch for ${key}: ${markerFile}`);
  }
  if (!['executed-capabilities', 'pinned-sha256'].includes(marker.verification)) {
    throw new Error(`[native-deps-gate] ffmpeg runtime marker has invalid verification mode: ${markerFile}`);
  }
  const capabilities = new Set(Array.isArray(marker.capabilities) ? marker.capabilities.map(String) : []);
  for (const capability of FFMPEG_CAPABILITIES) {
    if (!capabilities.has(capability)) {
      throw new Error(`[native-deps-gate] ffmpeg runtime marker is missing capability ${capability}: ${markerFile}`);
    }
  }
  for (const [name, file] of Object.entries(binaries)) {
    requiredFile(`${name} runtime executable`, file);
    const expected = marker.binaries && marker.binaries[name];
    const stat = fs.statSync(file);
    const rawHashMatches = expected
      && expected.bytes === stat.size
      && expected.sha256 === sha256File(file);
    if (!rawHashMatches && (!expected || !acceptSignedDarwinRuntimeMutation(file, targetPlatform, options))) {
      throw new Error(`[native-deps-gate] ${name} runtime hash/size mismatch: ${file}`);
    }
    assertExecutableArch(file, targetPlatform, targetArch, options);
  }
  requiredFile('ffmpeg runtime notice', path.join(dir, 'NOTICE.txt'));
  return Object.values(binaries);
}

function verifyWhisperRuntimeDir(runtimeRoot, targetPlatform, targetArch, options = {}) {
  const contract = options.whisperContract || WHISPER_RUNTIME_CONTRACT;
  const key = runtimeKey(targetPlatform, targetArch);
  const allowedKeys = options.allowedKeys || [key];
  requireOnlyRuntimeDirs(runtimeRoot, 'whisper', allowedKeys);
  const target = contract.targets[key];
  if (!target) {
    throw new Error(`[native-deps-gate] whisper runtime is not configured for ${key}`);
  }
  const dir = path.join(runtimeRoot, 'whisper', key);
  const markerFile = path.join(dir, '.orkas-whisper-ready.json');
  const marker = readJsonFile('whisper runtime marker', markerFile);
  if (marker.schema !== contract.schema
    || marker.platformKey !== key
    || marker.version !== contract.version
    || marker.model !== contract.model.name) {
    throw new Error(`[native-deps-gate] whisper runtime marker mismatch for ${key}: ${markerFile}`);
  }

  const expectedFiles = {
    ...target.files,
    ...(target.appLocalFiles || {}),
    [contract.model.relativePath]: contract.model,
    ...contract.licenses,
  };
  for (const [relativePath, expected] of Object.entries(expectedFiles)) {
    const file = relPath(dir, relativePath);
    requiredFile(`whisper runtime file ${relativePath}`, file);
    const actual = { bytes: fs.statSync(file).size, sha256: sha256File(file) };
    const recorded = marker.files && marker.files[relativePath];
    const markerMatchesContract = recorded
      && recorded.bytes === expected.bytes
      && recorded.sha256 === expected.sha256;
    const rawHashMatches = actual.bytes === expected.bytes && actual.sha256 === expected.sha256;
    const acceptedSignedMutation = !rawHashMatches
      && expected.executable === true
      && markerMatchesContract
      && acceptSignedDarwinRuntimeMutation(file, targetPlatform, options);
    if (!markerMatchesContract || (!rawHashMatches && !acceptedSignedMutation)) {
      throw new Error(`[native-deps-gate] whisper runtime hash/size mismatch: ${file}`);
    }
    if (expected.executable) {
      assertExecutableArch(file, targetPlatform, targetArch, options);
    }
  }
  requiredFile('Whisper runtime notice', path.join(dir, 'NOTICE.txt'));
  return path.join(dir, targetPlatform === 'win32' ? 'bin/whisper-cli.exe' : 'bin/whisper-cli');
}

function verifyWindowsVcRuntimeDir(runtimeRoot, targetPlatform, targetArch, options = {}) {
  const contract = options.windowsVcContract || WINDOWS_VC_RUNTIME_CONTRACT;
  const key = runtimeKey(targetPlatform, targetArch);
  const allowedKeys = options.allowedKeys || [key];
  requireOnlyRuntimeDirs(runtimeRoot, 'vc', allowedKeys);
  if (key !== contract.platformKey) {
    throw new Error(`[native-deps-gate] VC runtime is not configured for ${key}`);
  }
  const dir = path.join(runtimeRoot, 'vc', key);
  const markerFile = path.join(dir, '.orkas-vc-runtime.json');
  const marker = readJsonFile('VC runtime marker', markerFile);
  if (marker.schema !== contract.schema
    || marker.platformKey !== key
    || marker.version !== contract.version
    || marker.sourceSha256 !== contract.source.sha256) {
    throw new Error(`[native-deps-gate] VC runtime marker mismatch for ${key}: ${markerFile}`);
  }
  for (const [name, expected] of Object.entries(contract.files)) {
    const file = path.join(dir, name);
    requiredFile(`VC runtime file ${name}`, file);
    const actual = { bytes: fs.statSync(file).size, sha256: sha256File(file) };
    const recorded = marker.files && marker.files[name];
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256
      || !recorded || recorded.bytes !== actual.bytes || recorded.sha256 !== actual.sha256) {
      throw new Error(`[native-deps-gate] VC runtime hash/size mismatch: ${file}`);
    }
    assertExecutableArch(file, targetPlatform, targetArch, options);
  }
  requiredFile('VC runtime notice', path.join(dir, 'NOTICE.txt'));
  return dir;
}

function verifyWindowsVcAppLocalFiles(appDir, targetArch = 'x64', options = {}) {
  const contract = options.windowsVcContract || WINDOWS_VC_RUNTIME_CONTRACT;
  if (runtimeKey('win32', targetArch) !== contract.platformKey) {
    throw new Error(`[native-deps-gate] VC app-local runtime is not configured for win32-${targetArch}`);
  }
  for (const [name, expected] of Object.entries(contract.files)) {
    const file = path.join(appDir, name);
    requiredFile(`app-local VC runtime file ${name}`, file);
    const actual = { bytes: fs.statSync(file).size, sha256: sha256File(file) };
    if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256) {
      throw new Error(`[native-deps-gate] app-local VC runtime hash/size mismatch: ${file}`);
    }
    assertExecutableArch(file, 'win32', targetArch, options);
  }
  return `runtime:vc-app-local:win32-${targetArch}`;
}

function peLayout(file, options = {}) {
  const buffer = fs.readFileSync(file);
  if (buffer.length < 0x40 || buffer.toString('ascii', 0, 2) !== 'MZ') {
    throw new Error(`[native-deps-gate] Windows native file is not PE: ${file}`);
  }
  const peOffset = buffer.readUInt32LE(0x3c);
  if (peOffset <= 0 || peOffset + 24 > buffer.length || buffer.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') {
    throw new Error(`[native-deps-gate] Windows native file has an invalid PE header: ${file}`);
  }
  const sectionCount = buffer.readUInt16LE(peOffset + 6);
  const optionalSize = buffer.readUInt16LE(peOffset + 20);
  if (optionalSize === 0 && options.allowMinimalPe) return { buffer, minimal: true };
  const optionalOffset = peOffset + 24;
  if (optionalSize < 96 || optionalOffset + optionalSize > buffer.length) {
    throw new Error(`[native-deps-gate] Windows native file has an invalid optional header: ${file}`);
  }
  const magic = buffer.readUInt16LE(optionalOffset);
  const is64 = magic === 0x20b;
  if (!is64 && magic !== 0x10b) {
    throw new Error(`[native-deps-gate] Windows native file has an unsupported PE optional header: ${file}`);
  }
  const dataDirectoryOffset = optionalOffset + (is64 ? 112 : 96);
  const sectionOffset = optionalOffset + optionalSize;
  if (dataDirectoryOffset + 16 > optionalOffset + optionalSize || sectionOffset + sectionCount * 40 > buffer.length) {
    throw new Error(`[native-deps-gate] Windows native file has truncated PE metadata: ${file}`);
  }
  const sections = [];
  for (let index = 0; index < sectionCount; index += 1) {
    const offset = sectionOffset + index * 40;
    sections.push({
      virtualSize: buffer.readUInt32LE(offset + 8),
      virtualAddress: buffer.readUInt32LE(offset + 12),
      rawSize: buffer.readUInt32LE(offset + 16),
      rawOffset: buffer.readUInt32LE(offset + 20),
    });
  }
  return {
    buffer,
    file,
    is64,
    dataDirectoryOffset,
    sizeOfHeaders: buffer.readUInt32LE(optionalOffset + 60),
    sections,
  };
}

function peRvaOffset(layout, rva, size = 1) {
  if (rva < layout.sizeOfHeaders && rva + size <= layout.buffer.length) return rva;
  for (const section of layout.sections) {
    const extent = Math.max(section.virtualSize, section.rawSize);
    if (rva < section.virtualAddress || rva + size > section.virtualAddress + extent) continue;
    const offset = section.rawOffset + (rva - section.virtualAddress);
    if (offset >= 0 && offset + size <= layout.buffer.length) return offset;
  }
  throw new Error(`[native-deps-gate] PE RVA 0x${rva.toString(16)} is outside file sections: ${layout.file}`);
}

function peCString(layout, rva) {
  const offset = peRvaOffset(layout, rva);
  let end = offset;
  while (end < layout.buffer.length && layout.buffer[end] !== 0) end += 1;
  if (end >= layout.buffer.length) {
    throw new Error(`[native-deps-gate] unterminated PE string at RVA 0x${rva.toString(16)}: ${layout.file}`);
  }
  return layout.buffer.toString('utf8', offset, end);
}

function readPeImports(file, options = {}) {
  const layout = peLayout(file, options);
  if (layout.minimal) return new Map();
  const directoryRva = layout.buffer.readUInt32LE(layout.dataDirectoryOffset + 8);
  const directorySize = layout.buffer.readUInt32LE(layout.dataDirectoryOffset + 12);
  const imports = new Map();
  if (!directoryRva || !directorySize) return imports;
  let descriptorOffset = peRvaOffset(layout, directoryRva, 20);
  const descriptorEnd = Math.min(layout.buffer.length, descriptorOffset + directorySize);
  for (let count = 0; descriptorOffset + 20 <= descriptorEnd && count < 4096; count += 1, descriptorOffset += 20) {
    const originalThunkRva = layout.buffer.readUInt32LE(descriptorOffset);
    const nameRva = layout.buffer.readUInt32LE(descriptorOffset + 12);
    const firstThunkRva = layout.buffer.readUInt32LE(descriptorOffset + 16);
    if (!originalThunkRva && !nameRva && !firstThunkRva) break;
    const dll = peCString(layout, nameRva);
    const symbols = [];
    const thunkRva = originalThunkRva || firstThunkRva;
    const stride = layout.is64 ? 8 : 4;
    let thunkOffset = peRvaOffset(layout, thunkRva, stride);
    for (let index = 0; index < 1_000_000; index += 1, thunkOffset += stride) {
      if (thunkOffset + stride > layout.buffer.length) {
        throw new Error(`[native-deps-gate] truncated PE import thunk table: ${file}`);
      }
      const value = layout.is64
        ? layout.buffer.readBigUInt64LE(thunkOffset)
        : BigInt(layout.buffer.readUInt32LE(thunkOffset));
      if (value === 0n) break;
      const ordinalFlag = layout.is64 ? (1n << 63n) : (1n << 31n);
      if (value & ordinalFlag) {
        symbols.push({ ordinal: Number(value & 0xFFFFn) });
      } else {
        const nameOffset = peRvaOffset(layout, Number(value), 3);
        let end = nameOffset + 2;
        while (end < layout.buffer.length && layout.buffer[end] !== 0) end += 1;
        if (end >= layout.buffer.length) throw new Error(`[native-deps-gate] unterminated PE import name: ${file}`);
        symbols.push({ name: layout.buffer.toString('utf8', nameOffset + 2, end) });
      }
    }
    imports.set(dll, symbols);
  }
  return imports;
}

function readPeExports(file, options = {}) {
  const layout = peLayout(file, options);
  if (layout.minimal) return { names: new Set(), ordinals: new Set() };
  const directoryRva = layout.buffer.readUInt32LE(layout.dataDirectoryOffset);
  const directorySize = layout.buffer.readUInt32LE(layout.dataDirectoryOffset + 4);
  const names = new Set();
  const ordinals = new Set();
  if (!directoryRva || directorySize < 40) return { names, ordinals };
  const directoryOffset = peRvaOffset(layout, directoryRva, 40);
  const ordinalBase = layout.buffer.readUInt32LE(directoryOffset + 16);
  const functionCount = layout.buffer.readUInt32LE(directoryOffset + 20);
  const nameCount = layout.buffer.readUInt32LE(directoryOffset + 24);
  const functionsRva = layout.buffer.readUInt32LE(directoryOffset + 28);
  const namesRva = layout.buffer.readUInt32LE(directoryOffset + 32);
  for (let index = 0; index < functionCount; index += 1) {
    const offset = peRvaOffset(layout, functionsRva + index * 4, 4);
    if (layout.buffer.readUInt32LE(offset) !== 0) ordinals.add(ordinalBase + index);
  }
  for (let index = 0; index < nameCount; index += 1) {
    const offset = peRvaOffset(layout, namesRva + index * 4, 4);
    names.add(peCString(layout, layout.buffer.readUInt32LE(offset)));
  }
  return { names, ordinals };
}

function windowsNativeFiles(root, current = root, out = []) {
  if (!fs.existsSync(current)) return out;
  for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) windowsNativeFiles(root, absolute, out);
    else if (entry.isFile() && /\.(?:exe|dll|node|pyd)$/i.test(entry.name)) out.push(absolute);
  }
  return out;
}

function vcRuntimeDll(name) {
  return /^(?:msvcp|vcruntime|vcomp|concrt|mfc|mfcm|vcamp|vccorlib)\d[^/\\]*\.dll$/i.test(name);
}

function caseInsensitiveFile(dir, name, cache) {
  let entries = cache.get(dir);
  if (!entries) {
    try {
      entries = new Map(fs.readdirSync(dir).map((entry) => [entry.toLowerCase(), entry]));
    } catch {
      entries = new Map();
    }
    cache.set(dir, entries);
  }
  const actual = entries.get(name.toLowerCase());
  return actual ? path.join(dir, actual) : null;
}

function resolvePackagedVcDll(appDir, importer, dll, directoryCache) {
  const importerDir = path.dirname(importer);
  const candidates = [importerDir];
  if (!/\.exe$/i.test(importer)) {
    let current = importerDir;
    const appRoot = path.resolve(appDir);
    while (path.resolve(current) !== appRoot) {
      const parent = path.dirname(current);
      const relativeToRoot = path.relative(appRoot, parent);
      if (parent === current || relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)) break;
      current = parent;
      let entries = directoryCache.get(current);
      if (!entries) {
        try { entries = new Map(fs.readdirSync(current).map((entry) => [entry.toLowerCase(), entry])); }
        catch { entries = new Map(); }
        directoryCache.set(current, entries);
      }
      if ([...entries.keys()].some((name) => name.endsWith('.exe'))) {
        candidates.push(current);
        break;
      }
    }
    candidates.push(appRoot);
  }
  for (const dir of candidates) {
    const resolved = caseInsensitiveFile(dir, dll, directoryCache);
    if (resolved) return resolved;
  }
  return null;
}

function verifyWindowsVcImportClosure(appDir, targetArch = 'x64', options = {}) {
  const files = windowsNativeFiles(appDir);
  const directoryCache = new Map();
  const exportsCache = new Map();
  let vcImporters = 0;
  for (const file of files) {
    const imports = readPeImports(file, options);
    for (const [dll, symbols] of imports) {
      if (!vcRuntimeDll(dll)) continue;
      vcImporters += 1;
      const runtime = resolvePackagedVcDll(appDir, file, dll, directoryCache);
      if (!runtime) {
        throw new Error(`[native-deps-gate] unresolved application-local VC dependency ${dll}: ${file}`);
      }
      let available = exportsCache.get(runtime);
      if (!available) {
        available = readPeExports(runtime, options);
        exportsCache.set(runtime, available);
      }
      if (options.allowMinimalPe && available.names.size === 0 && available.ordinals.size === 0) continue;
      for (const symbol of symbols) {
        if (symbol.name && !available.names.has(symbol.name)) {
          throw new Error(`[native-deps-gate] ${dll} does not export ${symbol.name} required by ${file}; resolved=${runtime}`);
        }
        if (symbol.ordinal && !available.ordinals.has(symbol.ordinal)) {
          throw new Error(`[native-deps-gate] ${dll} does not export ordinal ${symbol.ordinal} required by ${file}; resolved=${runtime}`);
        }
      }
    }
  }
  if (!options.allowNoVcImports && vcImporters === 0) {
    throw new Error(`[native-deps-gate] packaged Windows app has no detected VC runtime imports: ${appDir}`);
  }
  return `runtime:vc-import-closure:win32-${targetArch}`;
}

function verifyWindowsVcExtraFilesConfig(winConfig) {
  const entries = Array.isArray(winConfig && winConfig.extraFiles)
    ? winConfig.extraFiles
    : (winConfig && winConfig.extraFiles ? [winConfig.extraFiles] : []);
  const matches = entries.filter((entry) => entry && typeof entry === 'object'
    && String(entry.from || '').replace(/\\/g, '/') === 'resources/runtime/vc/win32-x64');
  if (matches.length !== 1) {
    throw new Error('[native-deps-gate] Windows build must copy exactly one application-local VC runtime into the app root');
  }
  const entry = matches[0];
  const filters = Array.isArray(entry.filter) ? entry.filter.map(String) : [];
  if (entry.to !== '.' || filters.length !== 1 || filters[0] !== '*.dll') {
    throw new Error('[native-deps-gate] Windows VC extraFiles must target app root and copy only *.dll');
  }
  return true;
}

function requiredRuntimeVerificationEntries(targetPlatform, targetArch) {
  const key = runtimeKey(targetPlatform, targetArch);
  const kinds = targetPlatform === 'win32'
    ? PACKAGED_RUNTIME_KINDS
    : PACKAGED_RUNTIME_KINDS.filter(kind => kind !== 'vc');
  return kinds.map(kind => `runtime:${kind}:${key}`);
}

function requiredWindowsVcAppLocalVerificationEntries(targetPlatform, targetArch) {
  return targetPlatform === 'win32' ? [
    `runtime:vc-app-local:${runtimeKey(targetPlatform, targetArch)}`,
    `runtime:vc-import-closure:${runtimeKey(targetPlatform, targetArch)}`,
  ] : [];
}

function verifyRuntimeRoot(runtimeRoot, targetPlatform, targetArch, options = {}) {
  const manifest = readJsonFile('runtime manifest', path.join(runtimeRoot, 'manifest.json'));
  const key = runtimeKey(targetPlatform, targetArch);
  const allowedKeys = options.allowedKeys || [key];
  const verified = [];

  requireOnlyPackagedRuntimeKinds(runtimeRoot);
  for (const kind of MANIFEST_RUNTIME_KINDS) {
    const { spec, asset } = runtimeAsset(manifest, kind, key);
    requireOnlyRuntimeDirs(runtimeRoot, kind, allowedKeys);
    const dir = path.join(runtimeRoot, kind, key);
    verifyRuntimeDir(kind, dir, key, spec, asset, targetPlatform, targetArch, options);
    verified.push(`runtime:${kind}:${key}`);
  }
  verifyFfmpegRuntimeDir(runtimeRoot, targetPlatform, targetArch, { ...options, allowedKeys });
  verified.push(`runtime:ffmpeg:${key}`);
  verifyWhisperRuntimeDir(runtimeRoot, targetPlatform, targetArch, { ...options, allowedKeys });
  verified.push(`runtime:whisper:${key}`);
  if (targetPlatform === 'win32') {
    verifyWindowsVcRuntimeDir(runtimeRoot, targetPlatform, targetArch, { ...options, allowedKeys });
    verified.push(`runtime:vc:${key}`);
  }

  const required = requiredRuntimeVerificationEntries(targetPlatform, targetArch);
  for (const item of required) {
    if (!verified.includes(item)) {
      throw new Error(`[native-deps-gate] packaged runtime contract has no verifier result for ${item}`);
    }
  }

  return verified;
}

module.exports = {
  FFMPEG_CAPABILITIES,
  WHISPER_RUNTIME_CONTRACT,
  WINDOWS_VC_RUNTIME_CONTRACT,
  MANIFEST_RUNTIME_KINDS,
  PACKAGED_RUNTIME_KINDS,
  RUNTIME_KINDS: MANIFEST_RUNTIME_KINDS,
  assertExecutableArch,
  requiredRuntimeVerificationEntries,
  requiredWindowsVcAppLocalVerificationEntries,
  runtimeKey,
  runtimeKeysForTarget,
  verifyFfmpegRuntimeDir,
  verifyWhisperRuntimeDir,
  verifyWindowsVcAppLocalFiles,
  verifyWindowsVcExtraFilesConfig,
  verifyWindowsVcImportClosure,
  verifyWindowsVcRuntimeDir,
  verifyRuntimeDir,
  verifyRuntimeRoot,
};
