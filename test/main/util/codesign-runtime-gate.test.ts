import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as crypto from 'node:crypto';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const afterPack = require('../../../scripts/codesign-adhoc.cjs') as ((context: any) => Promise<void>) & {
  __test: {
    pruneBetterSqlite3BuildArtifacts(nodeModules: string): void;
  };
};

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-afterpack-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const RUNTIME_SIZES: Record<'python' | 'uv' | 'node', number> = { python: 101, uv: 202, node: 303 };

function writeEntrypointPayload(): string {
  const require = createRequire(import.meta.url);
  const gate = require('../../../bin/packaged-entrypoint-gate.cjs') as {
    PACKAGED_BIN_ENTRYPOINTS: readonly string[];
    PACKAGED_BIN_HELPERS: readonly string[];
    PACKAGED_JS_LOADER_FILES: readonly { packageName: string; entry: string }[];
  };
  const pcRoot = path.join(tmpDir, 'entrypoint-fixture');
  const binRoot = path.join(pcRoot, 'bin');
  fs.mkdirSync(binRoot, { recursive: true });
  for (const name of gate.PACKAGED_BIN_ENTRYPOINTS) {
    fs.copyFileSync(path.join(process.cwd(), 'bin', name), path.join(binRoot, name));
  }
  for (const name of gate.PACKAGED_BIN_HELPERS) {
    fs.copyFileSync(path.join(process.cwd(), 'bin', name), path.join(binRoot, name));
  }
  const lock = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package-lock.json'), 'utf8'));
  for (const spec of gate.PACKAGED_JS_LOADER_FILES) {
    const packageDir = path.join(pcRoot, 'node_modules', ...spec.packageName.split('/'));
    const entry = path.join(packageDir, ...spec.entry.split('/'));
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(path.join(packageDir, 'package.json'), JSON.stringify({
      name: spec.packageName,
      version: lock.packages[`node_modules/${spec.packageName}`].version,
    }));
    fs.writeFileSync(entry, 'module.exports = {};\n');
  }
  return pcRoot;
}

function windowsPe(): Buffer {
  const buf = Buffer.alloc(0x100);
  buf.write('MZ', 0, 'ascii');
  buf.writeUInt32LE(0x80, 0x3c);
  buf.write('PE\0\0', 0x80, 'ascii');
  buf.writeUInt16LE(0x8664, 0x84);
  return buf;
}

function fileRecord(bytes: Buffer): { bytes: number; sha256: string } {
  return {
    bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  };
}

function whisperFixture(key: string): { contract: any; files: Record<string, Buffer> } {
  const files = {
    'bin/whisper-cli.exe': windowsPe(),
    'bin/vcruntime140.dll': windowsPe(),
    'models/ggml-base-q5_1.bin': Buffer.from('test multilingual whisper model'),
    'LICENSE.whisper.cpp': Buffer.from('test whisper license'),
    'LICENSE.model': Buffer.from('test model license'),
  };
  return {
    files,
    contract: {
      schema: 1,
      version: 'test-whisper',
      model: { name: 'base-q5_1', relativePath: 'models/ggml-base-q5_1.bin', ...fileRecord(files['models/ggml-base-q5_1.bin']) },
      licenses: {
        'LICENSE.whisper.cpp': fileRecord(files['LICENSE.whisper.cpp']),
        'LICENSE.model': fileRecord(files['LICENSE.model']),
      },
      targets: {
        [key]: {
          files: { 'bin/whisper-cli.exe': { ...fileRecord(files['bin/whisper-cli.exe']), executable: true } },
          appLocalFiles: { 'bin/vcruntime140.dll': fileRecord(files['bin/vcruntime140.dll']) },
        },
      },
    },
  };
}

function vcFixture(key: string): { contract: any; files: Record<string, Buffer> } {
  const files = { 'vcruntime140.dll': windowsPe() };
  return {
    files,
    contract: {
      schema: 1,
      version: 'test-vc',
      platformKey: key,
      source: { sha256: 'test-vc-source' },
      files: Object.fromEntries(Object.entries(files).map(([name, bytes]) => [name, fileRecord(bytes)])),
    },
  };
}

function writeVcRuntime(key: string, fixture: ReturnType<typeof vcFixture>): void {
  const dir = path.join(tmpDir, 'resources', 'runtime', 'vc', key);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, bytes] of Object.entries(fixture.files)) {
    fs.writeFileSync(path.join(dir, name), bytes);
    fs.writeFileSync(path.join(tmpDir, name), bytes);
  }
  fs.writeFileSync(path.join(dir, 'NOTICE.txt'), 'test notice\n');
  fs.writeFileSync(path.join(dir, '.orkas-vc-runtime.json'), JSON.stringify({
    schema: fixture.contract.schema,
    platformKey: key,
    version: fixture.contract.version,
    sourceSha256: fixture.contract.source.sha256,
    files: Object.fromEntries(Object.entries(fixture.files).map(([name, bytes]) => [name, fileRecord(bytes)])),
  }, null, 2));
}

function writeWhisperRuntime(key: string, fixture: ReturnType<typeof whisperFixture>): void {
  const dir = path.join(tmpDir, 'resources', 'runtime', 'whisper', key);
  for (const [relativePath, bytes] of Object.entries(fixture.files)) {
    const file = path.join(dir, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  }
  fs.writeFileSync(path.join(dir, 'NOTICE.txt'), 'test notice\n');
  fs.writeFileSync(path.join(dir, '.orkas-whisper-ready.json'), JSON.stringify({
    schema: fixture.contract.schema,
    platformKey: key,
    version: fixture.contract.version,
    model: fixture.contract.model.name,
    files: Object.fromEntries(Object.entries(fixture.files).map(([name, bytes]) => [name, fileRecord(bytes)])),
  }, null, 2));
}

function writeRuntime(kind: 'python' | 'uv' | 'node', key: string, executable: string): void {
  const dir = path.join(tmpDir, 'resources', 'runtime', kind, key);
  const exe = path.join(dir, ...executable.split('/'));
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, windowsPe());
  if (kind === 'python') {
    const scriptsDir = path.join(path.dirname(exe), 'Scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    for (const name of ['pip', 'pip3', 'pip3.12']) {
      fs.writeFileSync(path.join(scriptsDir, `${name}.cmd`), '@echo off\r\n');
    }
  } else if (kind === 'uv') {
    fs.writeFileSync(path.join(path.dirname(exe), 'uvx.exe'), windowsPe());
  } else if (kind === 'node') {
    // The gate verifies npm/npx companions live next to the node executable.
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

function writeManifest(key: string): void {
  const runtimeRoot = path.join(tmpDir, 'resources', 'runtime');
  fs.mkdirSync(runtimeRoot, { recursive: true });
  fs.writeFileSync(path.join(runtimeRoot, 'manifest.json'), JSON.stringify({
    schema: 1,
    python: {
      version: 'test-python',
      source: 'test',
      release: 'test',
      assets: {
        [key]: {
          name: 'python.zip',
          url: 'https://example.invalid/python.zip',
          sha256: 'python-sha',
          size: 101,
          archive: 'zip',
          executable: 'python/python.exe',
        },
      },
    },
    uv: {
      version: 'test-uv',
      source: 'test',
      release: 'test',
      assets: {
        [key]: {
          name: 'uv.zip',
          url: 'https://example.invalid/uv.zip',
          sha256: 'uv-sha',
          size: 202,
          archive: 'zip',
          executable: 'uv.exe',
        },
      },
    },
    node: {
      version: 'test-node',
      source: 'test',
      release: 'test',
      assets: {
        [key]: {
          name: 'node.zip',
          url: 'https://example.invalid/node.zip',
          sha256: 'node-sha',
          size: 303,
          archive: 'zip',
          executable: 'node.exe',
        },
      },
    },
  }, null, 2));
}

function writeFfmpegRuntime(key: string): void {
  const dir = path.join(tmpDir, 'resources', 'runtime', 'ffmpeg', key);
  fs.mkdirSync(dir, { recursive: true });
  const binaries = { ffmpeg: windowsPe(), ffprobe: windowsPe() };
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

function writeEmbeddingModel(): void {
  const source = path.join(process.cwd(), 'resources', 'embedding-model', 'fast-bge-small-zh-v1.5');
  const dest = path.join(tmpDir, 'resources', 'embedding-model', 'fast-bge-small-zh-v1.5');
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(source)) {
    const from = path.join(source, name);
    const to = path.join(dest, name);
    try { fs.linkSync(from, to); }
    catch { fs.copyFileSync(from, to); }
  }
}

describe('codesign-adhoc runtime gate', () => {
  it('removes the better-sqlite3 rebuild-only test extension before closed-world validation', () => {
    const releaseDir = path.join(tmpDir, 'node_modules', 'better-sqlite3', 'build', 'Release');
    fs.mkdirSync(releaseDir, { recursive: true });
    const production = path.join(releaseDir, 'better_sqlite3.node');
    const testExtension = path.join(releaseDir, 'test_extension.node');
    fs.writeFileSync(production, 'production');
    fs.writeFileSync(testExtension, 'test-only');

    afterPack.__test.pruneBetterSqlite3BuildArtifacts(path.join(tmpDir, 'node_modules'));

    expect(fs.existsSync(production)).toBe(true);
    expect(fs.existsSync(testExtension)).toBe(false);
  });

  it('verifies packed runtime payload before signing can continue', async () => {
    const key = 'win32-x64';
    const whisper = whisperFixture(key);
    const vc = vcFixture(key);
    writeManifest(key);
    writeRuntime('python', key, 'python/python.exe');
    writeRuntime('uv', key, 'uv.exe');
    writeRuntime('node', key, 'node.exe');
    writeFfmpegRuntime(key);
    writeWhisperRuntime(key, whisper);
    writeVcRuntime(key, vc);
    writeEmbeddingModel();
    const entrypointRoot = writeEntrypointPayload();

    await afterPack({
      electronPlatformName: 'win32',
      arch: 1,
      appOutDir: tmpDir,
      __orkasTestWhisperContract: whisper.contract,
      __orkasTestWindowsVcContract: vc.contract,
      __orkasTestEntrypointRoot: entrypointRoot,
      __orkasTestBuiltinRoot: path.join(process.cwd(), 'resources', 'builtin'),
      packager: {
        appInfo: { productFilename: 'Orkas' },
        config: {},
      },
    });

    const marker = JSON.parse(fs.readFileSync(path.join(tmpDir, '.orkas-native-deps-verified.json'), 'utf8'));
    expect(marker.status).toBe('passed');
    expect(marker.verified).toContain('runtime:python:win32-x64');
    expect(marker.verified).toContain('runtime:uv:win32-x64');
    expect(marker.verified).toContain('runtime:node:win32-x64');
    expect(marker.verified).toContain('runtime:ffmpeg:win32-x64');
    expect(marker.verified).toContain('runtime:whisper:win32-x64');
    expect(marker.verified).toContain('runtime:vc:win32-x64');
    expect(marker.verified).toContain('runtime:vc-app-local:win32-x64');
    expect(marker.verified).toContain('runtime:vc-import-closure:win32-x64');
    expect(marker.verified).toContain('resource:embedding-model:fast-bge-small-zh-v1.5');
    expect(marker.verified).toContain('resource:builtin:manifest-v1');
    expect(marker.verified).toContain('entrypoint:bin/run-skill.cjs');
    expect(marker.verified).toContain('loader:tsx');
  });

  it('blocks signing when FFmpeg is absent from the packaged app', async () => {
    const key = 'win32-x64';
    const whisper = whisperFixture(key);
    const vc = vcFixture(key);
    writeManifest(key);
    writeRuntime('python', key, 'python/python.exe');
    writeRuntime('uv', key, 'uv.exe');
    writeRuntime('node', key, 'node.exe');
    writeWhisperRuntime(key, whisper);

    await expect(afterPack({
      electronPlatformName: 'win32',
      arch: 1,
      appOutDir: tmpDir,
      __orkasTestWhisperContract: whisper.contract,
      __orkasTestWindowsVcContract: vc.contract,
      packager: {
        appInfo: { productFilename: 'Orkas' },
        config: {},
      },
    })).rejects.toThrow(/missing runtime ffmpeg directory/);
  });

  it('blocks signing when the embedding model is absent from the packaged app', async () => {
    const key = 'win32-x64';
    const whisper = whisperFixture(key);
    const vc = vcFixture(key);
    writeManifest(key);
    writeRuntime('python', key, 'python/python.exe');
    writeRuntime('uv', key, 'uv.exe');
    writeRuntime('node', key, 'node.exe');
    writeFfmpegRuntime(key);
    writeWhisperRuntime(key, whisper);
    writeVcRuntime(key, vc);

    await expect(afterPack({
      electronPlatformName: 'win32',
      arch: 1,
      appOutDir: tmpDir,
      __orkasTestWhisperContract: whisper.contract,
      __orkasTestWindowsVcContract: vc.contract,
      packager: {
        appInfo: { productFilename: 'Orkas' },
        config: {},
      },
    })).rejects.toThrow(/missing embedding-model root/);
  });

  it('blocks signing when the packaged Whisper model is tampered', async () => {
    const key = 'win32-x64';
    const whisper = whisperFixture(key);
    const vc = vcFixture(key);
    writeManifest(key);
    writeRuntime('python', key, 'python/python.exe');
    writeRuntime('uv', key, 'uv.exe');
    writeRuntime('node', key, 'node.exe');
    writeFfmpegRuntime(key);
    writeWhisperRuntime(key, whisper);
    writeEmbeddingModel();
    fs.appendFileSync(path.join(tmpDir, 'resources', 'runtime', 'whisper', key, 'models', 'ggml-base-q5_1.bin'), 'tampered');

    await expect(afterPack({
      electronPlatformName: 'win32',
      arch: 1,
      appOutDir: tmpDir,
      __orkasTestWhisperContract: whisper.contract,
      __orkasTestWindowsVcContract: vc.contract,
      packager: {
        appInfo: { productFilename: 'Orkas' },
        config: {},
      },
    })).rejects.toThrow(/whisper runtime hash\/size mismatch/);
  });
});
