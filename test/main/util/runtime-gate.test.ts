import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as crypto from 'node:crypto';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const {
  verifyFfmpegRuntimeDir,
  verifyRuntimeRoot,
  verifyWhisperRuntimeDir,
  verifyWindowsVcImportClosure,
} = require('../../../bin/runtime-gate.cjs') as {
  verifyFfmpegRuntimeDir: (root: string, platform: string, arch: string, options?: Record<string, unknown>) => string[];
  verifyRuntimeRoot: (root: string, platform: string, arch: string, options?: {
    allowedKeys?: string[];
    whisperContract?: any;
    windowsVcContract?: any;
  }) => string[];
  verifyWhisperRuntimeDir: (root: string, platform: string, arch: string, options?: Record<string, unknown>) => string;
  verifyWindowsVcImportClosure: (root: string, arch: string) => string;
};

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-runtime-gate-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const RUNTIME_SIZES: Record<'python' | 'uv' | 'node', number> = { python: 101, uv: 202, node: 303 };

function writeManifest(root: string, keys: string[]): void {
  const assets = Object.fromEntries(keys.map((key) => [key, {
    python: {
      name: 'python.zip',
      url: 'https://example.invalid/python.zip',
      sha256: 'python-sha',
      size: RUNTIME_SIZES.python,
      archive: 'zip',
      executable: 'python/python.exe',
    },
    uv: {
      name: 'uv.zip',
      url: 'https://example.invalid/uv.zip',
      sha256: 'uv-sha',
      size: RUNTIME_SIZES.uv,
      archive: 'zip',
      executable: 'uv.exe',
    },
    node: {
      name: 'node.zip',
      url: 'https://example.invalid/node.zip',
      sha256: 'node-sha',
      size: RUNTIME_SIZES.node,
      archive: 'zip',
      executable: 'node.exe',
    },
  }]));
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({
    schema: 1,
    python: {
      version: 'test-python',
      source: 'test',
      release: 'test',
      assets: Object.fromEntries(keys.map((key) => [key, assets[key].python])),
    },
    uv: {
      version: 'test-uv',
      source: 'test',
      release: 'test',
      assets: Object.fromEntries(keys.map((key) => [key, assets[key].uv])),
    },
    node: {
      version: 'test-node',
      source: 'test',
      release: 'test',
      assets: Object.fromEntries(keys.map((key) => [key, assets[key].node])),
    },
  }, null, 2));
}

function writeRuntime(root: string, kind: 'python' | 'uv' | 'node', key: string, withNodeCompanions = true): void {
  const executable = kind === 'python' ? 'python/python.exe' : kind === 'uv' ? 'uv.exe' : 'node.exe';
  const dir = path.join(root, kind, key);
  const exe = path.join(dir, ...executable.split('/'));
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, '');
  if (kind === 'python') {
    const scriptsDir = path.join(path.dirname(exe), 'Scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    for (const name of ['pip', 'pip3']) fs.writeFileSync(path.join(scriptsDir, `${name}.cmd`), '@echo off\r\n');
  } else if (kind === 'uv') {
    fs.writeFileSync(path.join(path.dirname(exe), 'uvx.exe'), '');
  } else if (withNodeCompanions) {
    fs.writeFileSync(path.join(path.dirname(exe), 'npm.cmd'), '');
    fs.writeFileSync(path.join(path.dirname(exe), 'npx.cmd'), '');
  }
  fs.writeFileSync(path.join(dir, '.orkas-runtime.json'), JSON.stringify({
    schema: 1,
    kind,
    platformKey: key,
    version: `test-${kind}`,
    source: 'test',
    release: 'test',
    asset: `${kind}.zip`,
    sha256: `${kind}-sha`,
    size: RUNTIME_SIZES[kind],
  }, null, 2));
}

function windowsPe(arch: 'x64' | 'arm64' = 'x64'): Buffer {
  const buf = Buffer.alloc(0x100);
  buf.write('MZ', 0, 'ascii');
  buf.writeUInt32LE(0x80, 0x3c);
  buf.write('PE\0\0', 0x80, 'ascii');
  buf.writeUInt16LE(arch === 'arm64' ? 0xaa64 : 0x8664, 0x84);
  return buf;
}

function peImage(dataDirectory: 'import' | 'export'): Buffer {
  const bytes = Buffer.alloc(0x900);
  bytes.write('MZ', 0, 'ascii');
  bytes.writeUInt32LE(0x80, 0x3c);
  bytes.write('PE\0\0', 0x80, 'ascii');
  bytes.writeUInt16LE(0x8664, 0x84);
  bytes.writeUInt16LE(1, 0x86);
  bytes.writeUInt16LE(0xF0, 0x94);
  const optional = 0x98;
  bytes.writeUInt16LE(0x20b, optional);
  bytes.writeUInt32LE(0x200, optional + 60);
  bytes.writeUInt32LE(16, optional + 108);
  const directory = optional + 112 + (dataDirectory === 'import' ? 8 : 0);
  bytes.writeUInt32LE(0x1100, directory);
  bytes.writeUInt32LE(0x200, directory + 4);
  const section = optional + 0xF0;
  bytes.write('.rdata\0\0', section, 'ascii');
  bytes.writeUInt32LE(0x700, section + 8);
  bytes.writeUInt32LE(0x1000, section + 12);
  bytes.writeUInt32LE(0x700, section + 16);
  bytes.writeUInt32LE(0x200, section + 20);
  return bytes;
}

function peImport(dll: string, symbol: string): Buffer {
  const bytes = peImage('import');
  const descriptor = 0x300;
  bytes.writeUInt32LE(0x1200, descriptor);
  bytes.writeUInt32LE(0x1300, descriptor + 12);
  bytes.writeUInt32LE(0x1200, descriptor + 16);
  bytes.writeBigUInt64LE(0x1400n, 0x400);
  bytes.write(dll, 0x500, 'ascii');
  bytes.writeUInt16LE(0, 0x600);
  bytes.write(symbol, 0x602, 'ascii');
  return bytes;
}

function peExport(symbol: string): Buffer {
  const bytes = peImage('export');
  const directory = 0x300;
  bytes.writeUInt32LE(1, directory + 16);
  bytes.writeUInt32LE(1, directory + 20);
  bytes.writeUInt32LE(1, directory + 24);
  bytes.writeUInt32LE(0x1200, directory + 28);
  bytes.writeUInt32LE(0x1210, directory + 32);
  bytes.writeUInt32LE(0x1220, directory + 36);
  bytes.writeUInt32LE(0x1500, 0x400);
  bytes.writeUInt32LE(0x1300, 0x410);
  bytes.writeUInt16LE(0, 0x420);
  bytes.write(symbol, 0x500, 'ascii');
  return bytes;
}

function writeFfmpegRuntime(root: string, key: string): void {
  const arch = key.endsWith('-arm64') ? 'arm64' : 'x64';
  const dir = path.join(root, 'ffmpeg', key);
  fs.mkdirSync(dir, { recursive: true });
  const binaries = {
    ffmpeg: windowsPe(arch),
    ffprobe: windowsPe(arch),
  };
  for (const [name, bytes] of Object.entries(binaries)) {
    fs.writeFileSync(path.join(dir, `${name}.exe`), bytes);
  }
  fs.writeFileSync(path.join(dir, 'NOTICE.txt'), 'test notice\n');
  fs.writeFileSync(path.join(dir, '.orkas-ffmpeg-ready.json'), JSON.stringify({
    schema: 1,
    platformKey: key,
    verification: 'pinned-sha256',
    capabilities: ['libass', 'ass', 'subtitles'],
    binaries: Object.fromEntries(Object.entries(binaries).map(([name, bytes]) => [name, {
      bytes: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    }])),
  }, null, 2));
}

function writeDarwinFfmpegRuntime(root: string, key: string): Record<'ffmpeg' | 'ffprobe', string> {
  const dir = path.join(root, 'ffmpeg', key);
  fs.mkdirSync(dir, { recursive: true });
  const binaries = {
    ffmpeg: Buffer.from('original ffmpeg Mach-O fixture'),
    ffprobe: Buffer.from('original ffprobe Mach-O fixture'),
  };
  const files = {} as Record<'ffmpeg' | 'ffprobe', string>;
  for (const [name, bytes] of Object.entries(binaries) as Array<[keyof typeof binaries, Buffer]>) {
    files[name] = path.join(dir, name);
    fs.writeFileSync(files[name], bytes);
  }
  fs.writeFileSync(path.join(dir, 'NOTICE.txt'), 'test notice\n');
  fs.writeFileSync(path.join(dir, '.orkas-ffmpeg-ready.json'), JSON.stringify({
    schema: 1,
    platformKey: key,
    verification: 'pinned-sha256',
    capabilities: ['libass', 'ass', 'subtitles'],
    binaries: Object.fromEntries(Object.entries(binaries).map(([name, bytes]) => [name, record(bytes)])),
  }, null, 2));
  return files;
}

function record(bytes: Buffer): { bytes: number; sha256: string } {
  return { bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
}

function whisperContract(keys: string[]): any {
  const model = Buffer.from('test whisper model');
  const cliByKey = Object.fromEntries(keys.map(key => [key, windowsPe(key.endsWith('arm64') ? 'arm64' : 'x64')]));
  const licenseCpp = Buffer.from('whisper license');
  const licenseModel = Buffer.from('model license');
  return {
    schema: 1,
    version: 'test-whisper',
    model: { name: 'test-model', relativePath: 'models/test.bin', ...record(model), testBytes: model },
    licenses: {
      'LICENSE.whisper.cpp': { ...record(licenseCpp), testBytes: licenseCpp },
      'LICENSE.model': { ...record(licenseModel), testBytes: licenseModel },
    },
    targets: Object.fromEntries(keys.map(key => [key, {
      source: 'test',
      files: {
        'bin/whisper-cli.exe': { ...record(cliByKey[key]), executable: true, testBytes: cliByKey[key] },
      },
      appLocalFiles: {
        'bin/vcruntime140.dll': {
          ...record(windowsPe(key.endsWith('arm64') ? 'arm64' : 'x64')),
          testBytes: windowsPe(key.endsWith('arm64') ? 'arm64' : 'x64'),
        },
      },
    }])),
  };
}

function windowsVcContract(key: string): any {
  const bytes = windowsPe(key.endsWith('arm64') ? 'arm64' : 'x64');
  return {
    schema: 1,
    version: 'test-vc',
    platformKey: key,
    source: { sha256: 'test-vc-source' },
    files: {
      'vcruntime140.dll': { ...record(bytes), testBytes: bytes },
    },
  };
}

function writeVcRuntime(root: string, key: string, contract: any): void {
  const dir = path.join(root, 'vc', key);
  fs.mkdirSync(dir, { recursive: true });
  const files: Record<string, { bytes: number; sha256: string }> = {};
  for (const [name, spec] of Object.entries(contract.files) as Array<[string, any]>) {
    fs.writeFileSync(path.join(dir, name), spec.testBytes);
    files[name] = { bytes: spec.bytes, sha256: spec.sha256 };
  }
  fs.writeFileSync(path.join(dir, 'NOTICE.txt'), 'test notice');
  fs.writeFileSync(path.join(dir, '.orkas-vc-runtime.json'), JSON.stringify({
    schema: contract.schema,
    platformKey: key,
    version: contract.version,
    sourceSha256: contract.source.sha256,
    files,
  }, null, 2));
}

function writeWhisperRuntime(root: string, key: string, contract: any): void {
  const dir = path.join(root, 'whisper', key);
  fs.mkdirSync(dir, { recursive: true });
  const target = contract.targets[key];
  const expected = {
    ...target.files,
    ...(target.appLocalFiles || {}),
    [contract.model.relativePath]: contract.model,
    ...contract.licenses,
  };
  const files: Record<string, { bytes: number; sha256: string }> = {};
  for (const [relativePath, spec] of Object.entries(expected) as Array<[string, any]>) {
    const file = path.join(dir, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, spec.testBytes);
    files[relativePath] = { bytes: spec.bytes, sha256: spec.sha256 };
  }
  fs.writeFileSync(path.join(dir, 'NOTICE.txt'), 'test notice');
  fs.writeFileSync(path.join(dir, '.orkas-whisper-ready.json'), JSON.stringify({
    schema: contract.schema,
    platformKey: key,
    version: target.version || contract.version,
    model: contract.model.name,
    source: 'test',
    files,
  }, null, 2));
}

function darwinWhisperContract(key: string): any {
  const cli = Buffer.from('original whisper Mach-O fixture');
  const model = Buffer.from('test whisper model');
  const license = Buffer.from('test license');
  return {
    schema: 1,
    version: 'test-whisper-darwin',
    model: { name: 'test-model', relativePath: 'models/test.bin', ...record(model), testBytes: model },
    licenses: { 'LICENSE.whisper.cpp': { ...record(license), testBytes: license } },
    targets: {
      [key]: {
        source: 'test',
        files: { 'bin/whisper-cli': { ...record(cli), executable: true, testBytes: cli } },
      },
    },
  };
}

function writeAllRuntimes(root: string, key: string, contract: any, withNodeCompanions = true): void {
  writeRuntime(root, 'python', key);
  writeRuntime(root, 'uv', key);
  writeRuntime(root, 'node', key, withNodeCompanions);
  writeFfmpegRuntime(root, key);
  writeWhisperRuntime(root, key, contract);
  writeVcRuntime(root, key, windowsVcContract(key));
}

describe('runtime-gate', () => {
  it('verifies a target-specific Whisper version independently of the shared contract version', () => {
    const root = path.join(tmpDir, 'runtime');
    const key = 'win32-x64';
    const contract = whisperContract([key]);
    contract.targets[key].version = 'test-whisper-windows';
    writeWhisperRuntime(root, key, contract);

    expect(verifyWhisperRuntimeDir(root, 'win32', 'x64', {
      checkArch: false,
      whisperContract: contract,
    })).toBe(path.join(root, 'whisper', key, 'bin', 'whisper-cli.exe'));

    const markerFile = path.join(root, 'whisper', key, '.orkas-whisper-ready.json');
    const marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
    marker.version = contract.version;
    fs.writeFileSync(markerFile, JSON.stringify(marker));
    expect(() => verifyWhisperRuntimeDir(root, 'win32', 'x64', {
      checkArch: false,
      whisperContract: contract,
    })).toThrow(/whisper runtime marker mismatch/);
  });

  it('verifies all bundled runtimes and their companion commands before signing', () => {
    const root = path.join(tmpDir, 'runtime');
    const key = 'win32-x64';
    const contract = whisperContract([key]);
    writeManifest(root, [key]);
    writeAllRuntimes(root, key, contract);

    expect(verifyRuntimeRoot(root, 'win32', 'x64', {
      whisperContract: contract,
      windowsVcContract: windowsVcContract(key),
    })).toEqual([
      'runtime:python:win32-x64',
      'runtime:uv:win32-x64',
      'runtime:node:win32-x64',
      'runtime:ffmpeg:win32-x64',
      'runtime:whisper:win32-x64',
      'runtime:vc:win32-x64',
    ]);
  });

  it('fails when the target FFmpeg runtime is missing', () => {
    const root = path.join(tmpDir, 'runtime');
    const key = 'win32-x64';
    const contract = whisperContract([key]);
    writeManifest(root, [key]);
    writeRuntime(root, 'python', key);
    writeRuntime(root, 'uv', key);
    writeRuntime(root, 'node', key);
    writeWhisperRuntime(root, key, contract);

    expect(() => verifyRuntimeRoot(root, 'win32', 'x64', {
      whisperContract: contract,
      windowsVcContract: windowsVcContract(key),
    })).toThrow(/missing runtime ffmpeg directory/);
  });

  it('fails when a packaged FFmpeg binary no longer matches its ready marker', () => {
    const root = path.join(tmpDir, 'runtime');
    const key = 'win32-x64';
    const contract = whisperContract([key]);
    writeManifest(root, [key]);
    writeAllRuntimes(root, key, contract);
    fs.appendFileSync(path.join(root, 'ffmpeg', key, 'ffmpeg.exe'), 'tampered');

    expect(() => verifyRuntimeRoot(root, 'win32', 'x64', {
      whisperContract: contract,
      windowsVcContract: windowsVcContract(key),
    })).toThrow(/ffmpeg runtime hash\/size mismatch/);
  });

  it('accepts signed Darwin FFmpeg mutations only after expected-team signature verification', () => {
    const root = path.join(tmpDir, 'runtime');
    const key = 'darwin-arm64';
    const files = writeDarwinFfmpegRuntime(root, key);
    fs.appendFileSync(files.ffmpeg, 'Developer ID signature');
    fs.appendFileSync(files.ffprobe, 'Developer ID signature');
    const verified: string[] = [];

    expect(verifyFfmpegRuntimeDir(root, 'darwin', 'arm64', {
      checkArch: false,
      allowSignedDarwinRuntime: true,
      expectedTeamIdentifier: 'TEAM123',
      verifySignedDarwinBinary(file: string, team: string) {
        expect(team).toBe('TEAM123');
        verified.push(path.basename(file));
      },
    })).toHaveLength(2);
    expect(verified.sort()).toEqual(['ffmpeg', 'ffprobe']);
  });

  it('rejects signed Darwin FFmpeg mutations when signature verification fails', () => {
    const root = path.join(tmpDir, 'runtime');
    const key = 'darwin-arm64';
    const files = writeDarwinFfmpegRuntime(root, key);
    fs.appendFileSync(files.ffmpeg, 'untrusted mutation');

    expect(() => verifyFfmpegRuntimeDir(root, 'darwin', 'arm64', {
      checkArch: false,
      allowSignedDarwinRuntime: true,
      expectedTeamIdentifier: 'TEAM123',
      verifySignedDarwinBinary() {
        throw new Error('wrong signing team');
      },
    })).toThrow(/wrong signing team/);
  });

  it('keeps non-executable Whisper assets byte-exact after Darwin signing', () => {
    const root = path.join(tmpDir, 'runtime');
    const key = 'darwin-arm64';
    const contract = darwinWhisperContract(key);
    writeWhisperRuntime(root, key, contract);
    const cli = path.join(root, 'whisper', key, 'bin', 'whisper-cli');
    fs.appendFileSync(cli, 'Developer ID signature');

    expect(verifyWhisperRuntimeDir(root, 'darwin', 'arm64', {
      checkArch: false,
      whisperContract: contract,
      allowSignedDarwinRuntime: true,
      expectedTeamIdentifier: 'TEAM123',
      verifySignedDarwinBinary: () => undefined,
    })).toBe(cli);

    fs.appendFileSync(path.join(root, 'whisper', key, 'models', 'test.bin'), 'tampered');
    expect(() => verifyWhisperRuntimeDir(root, 'darwin', 'arm64', {
      checkArch: false,
      whisperContract: contract,
      allowSignedDarwinRuntime: true,
      expectedTeamIdentifier: 'TEAM123',
      verifySignedDarwinBinary: () => undefined,
    })).toThrow(/whisper runtime hash\/size mismatch/);
  });

  it('fails when a foreign-platform FFmpeg payload remains in the package', () => {
    const root = path.join(tmpDir, 'runtime');
    const key = 'win32-x64';
    const contract = whisperContract([key]);
    writeManifest(root, [key]);
    writeAllRuntimes(root, key, contract);
    fs.mkdirSync(path.join(root, 'ffmpeg', 'darwin-arm64'), { recursive: true });

    expect(() => verifyRuntimeRoot(root, 'win32', 'x64', {
      whisperContract: contract,
      windowsVcContract: windowsVcContract(key),
    })).toThrow(/unexpected runtime ffmpeg payload/);
  });

  it('fails when a packaged runtime dependency has not been registered', () => {
    const root = path.join(tmpDir, 'runtime');
    const key = 'win32-x64';
    const contract = whisperContract([key]);
    writeManifest(root, [key]);
    writeAllRuntimes(root, key, contract);
    fs.mkdirSync(path.join(root, 'undeclared-runtime', key), { recursive: true });

    expect(() => verifyRuntimeRoot(root, 'win32', 'x64', {
      whisperContract: contract,
      windowsVcContract: windowsVcContract(key),
    })).toThrow(/unregistered packaged runtime dependency/);
  });

  it('fails when bundled Node is missing npm/npx companions', () => {
    const root = path.join(tmpDir, 'runtime');
    const key = 'win32-x64';
    const contract = whisperContract([key]);
    writeManifest(root, [key]);
    writeAllRuntimes(root, key, contract, false);

    expect(() => verifyRuntimeRoot(root, 'win32', 'x64', {
      whisperContract: contract,
      windowsVcContract: windowsVcContract(key),
    })).toThrow(/node runtime companion/);
  });

  it('allows explicitly whitelisted dual-arch runtime dirs for universal builds', () => {
    const root = path.join(tmpDir, 'runtime');
    const keys = ['win32-x64', 'win32-arm64'];
    const contract = whisperContract(keys);
    writeManifest(root, keys);
    for (const key of keys) writeAllRuntimes(root, key, contract);

    expect(verifyRuntimeRoot(root, 'win32', 'x64', {
      allowedKeys: keys,
      whisperContract: contract,
      windowsVcContract: windowsVcContract(keys[0]),
    })).toContain('runtime:node:win32-x64');
    expect(verifyRuntimeRoot(root, 'win32', 'arm64', {
      allowedKeys: keys,
      whisperContract: contract,
      windowsVcContract: windowsVcContract(keys[1]),
    })).toContain('runtime:node:win32-arm64');
  });

  it('fails when a bundled Whisper model no longer matches its pinned contract', () => {
    const root = path.join(tmpDir, 'runtime');
    const key = 'win32-x64';
    const contract = whisperContract([key]);
    writeManifest(root, [key]);
    writeAllRuntimes(root, key, contract);
    fs.appendFileSync(path.join(root, 'whisper', key, 'models', 'test.bin'), 'tampered');

    expect(() => verifyRuntimeRoot(root, 'win32', 'x64', {
      whisperContract: contract,
      windowsVcContract: windowsVcContract(key),
    }))
      .toThrow(/whisper runtime hash\/size mismatch/);
  });

  it('verifies that every imported VC symbol resolves from the packaged application-local DLL', () => {
    const app = path.join(tmpDir, 'app');
    fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(path.join(app, 'Orkas.exe'), peImport('VCRUNTIME140.dll', '__CxxFrameHandler3'));
    fs.writeFileSync(path.join(app, 'vcruntime140.dll'), peExport('__CxxFrameHandler3'));

    expect(verifyWindowsVcImportClosure(app, 'x64')).toBe('runtime:vc-import-closure:win32-x64');
  });

  it('fails the Windows package when a VC DLL or required symbol is absent', () => {
    const app = path.join(tmpDir, 'app');
    fs.mkdirSync(app, { recursive: true });
    fs.writeFileSync(path.join(app, 'Orkas.exe'), peImport('VCRUNTIME140.dll', '__CxxFrameHandler3'));

    expect(() => verifyWindowsVcImportClosure(app, 'x64')).toThrow(/unresolved application-local VC dependency/);
    fs.writeFileSync(path.join(app, 'vcruntime140.dll'), peExport('__different_symbol'));
    expect(() => verifyWindowsVcImportClosure(app, 'x64')).toThrow(/does not export __CxxFrameHandler3/);
  });
});
