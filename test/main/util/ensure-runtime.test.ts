import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const TEST_NODE = process.env.ORKAS_TEST_NODE || process.execPath;

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-runtime-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeManifest(key: string, executable: string): string {
  const manifest = {
    schema: 1,
    python: {
      version: 'test-python',
      source: 'test',
      release: 'test',
      assets: {
        [key]: {
          name: 'python-test.tar.gz',
          url: 'https://example.invalid/python-test.tar.gz',
          sha256: 'abc123',
          size: 123,
          archive: 'tar.gz',
          executable,
        },
      },
    },
    uv: {
      version: 'test-uv',
      source: 'test',
      release: 'test',
      assets: {
        [key]: {
          name: 'uv-test.tar.gz',
          url: 'https://example.invalid/uv-test.tar.gz',
          sha256: 'uv123',
          size: 234,
          archive: 'tar.gz',
          executable: process.platform === 'win32' ? 'uv.exe' : 'uv',
        },
      },
    },
    node: {
      version: 'test-node',
      source: 'test',
      release: 'test',
      assets: {
        [key]: {
          name: 'node-test.tar.gz',
          url: 'https://example.invalid/node-test.tar.gz',
          sha256: 'node123',
          size: 456,
          archive: 'tar.gz',
          executable: process.platform === 'win32' ? 'node.exe' : 'bin/node',
        },
      },
    },
  };
  const file = path.join(tmpDir, 'manifest.json');
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
  return file;
}

function writeMarker(dir: string, kind: 'python' | 'uv' | 'node', key: string, asset: string, sha256: string, size: number): void {
  fs.writeFileSync(path.join(dir, '.orkas-runtime.json'), JSON.stringify({
    schema: 1,
    kind,
    platformKey: key,
    version: `test-${kind}`,
    source: 'test',
    release: 'test',
    asset,
    sha256,
    size,
  }, null, 2));
}

function writePythonPipShims(exe: string): void {
  const shimDir = process.platform === 'win32'
    ? path.join(path.dirname(exe), 'Scripts')
    : path.dirname(exe);
  fs.mkdirSync(shimDir, { recursive: true });
  for (const name of ['pip', 'pip3']) {
    fs.writeFileSync(path.join(shimDir, process.platform === 'win32' ? `${name}.cmd` : name), '');
  }
}

function runEnsure(root: string, manifest: string, key: string, kind = 'python') {
  const [platform, arch] = key.split('-');
  return spawnSync(TEST_NODE, [
    path.join(process.cwd(), 'bin', 'ensure-runtime.cjs'),
    '--root', root,
    '--manifest', manifest,
    '--platform', platform,
    '--arch', arch,
    '--kind', kind,
    '--check',
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

function runEnsureMutable(root: string, manifest: string, key: string) {
  const [platform, arch] = key.split('-');
  return spawnSync(TEST_NODE, [
    path.join(process.cwd(), 'bin', 'ensure-runtime.cjs'),
    '--root', root,
    '--manifest', manifest,
    '--platform', platform,
    '--arch', arch,
    '--kind', 'python',
    '--no-download',
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

describe('ensure-runtime.cjs', () => {
  it('accepts a runtime dir with a matching marker and executable', () => {
    const key = `${process.platform}-${process.arch}`;
    const executable = process.platform === 'win32' ? 'python/python.exe' : 'python/bin/python3';
    const manifest = writeManifest(key, executable);
    const root = path.join(tmpDir, 'runtime');
    const dir = path.join(root, 'python', key);
    const exe = path.join(dir, ...executable.split('/'));
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.writeFileSync(exe, '');
    writePythonPipShims(exe);
    writeMarker(dir, 'python', key, 'python-test.tar.gz', 'abc123', 123);

    const r = runEnsure(root, manifest, key);

    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.ok).toBe(true);
    expect(out.results[0].status).toBe('ready');
    expect(out.results[0].verified).toBe(true);
  });

  it('reports an executable without a marker as unverified in check mode', () => {
    const key = `${process.platform}-${process.arch}`;
    const executable = process.platform === 'win32' ? 'python/python.exe' : 'python/bin/python3';
    const manifest = writeManifest(key, executable);
    const root = path.join(tmpDir, 'runtime');
    const exe = path.join(root, 'python', key, ...executable.split('/'));
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.writeFileSync(exe, '');

    const r = runEnsure(root, manifest, key);

    expect(r.status).toBe(1);
    const out = JSON.parse(r.stdout);
    expect(out.ok).toBe(false);
    expect(out.results[0].status).toBe('unverified');
  });

  it('prefers a verified platform directory over an unverified current directory', () => {
    const key = `${process.platform}-${process.arch}`;
    const executable = process.platform === 'win32' ? 'python/python.exe' : 'python/bin/python3';
    const manifest = writeManifest(key, executable);
    const root = path.join(tmpDir, 'runtime');
    const currentExe = path.join(root, 'python', 'current', ...executable.split('/'));
    fs.mkdirSync(path.dirname(currentExe), { recursive: true });
    fs.writeFileSync(currentExe, '');

    const dir = path.join(root, 'python', key);
    const exe = path.join(dir, ...executable.split('/'));
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.writeFileSync(exe, '');
    writePythonPipShims(exe);
    writeMarker(dir, 'python', key, 'python-test.tar.gz', 'abc123', 123);

    const r = runEnsure(root, manifest, key);

    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.ok).toBe(true);
    expect(out.results[0].status).toBe('ready');
    expect(out.results[0].dir).toBe(dir);
  });

  it('repairs ready Windows Python runtimes with pip command shims', () => {
    const key = 'win32-x64';
    const executable = 'python/python.exe';
    const manifest = writeManifest(key, executable);
    const root = path.join(tmpDir, 'runtime');
    const dir = path.join(root, 'python', key);
    const exe = path.join(dir, ...executable.split('/'));
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.writeFileSync(exe, '');
    writeMarker(dir, 'python', key, 'python-test.tar.gz', 'abc123', 123);

    const r = runEnsureMutable(root, manifest, key);

    expect(r.status).toBe(0);
    for (const name of ['pip', 'pip3']) {
      const shim = path.join(dir, 'python', 'Scripts', `${name}.cmd`);
      expect(fs.readFileSync(shim, 'utf8')).toContain('-m pip');
    }
  });

  it('accepts a verified Node runtime and keeps npm/npx beside node', () => {
    const key = `${process.platform}-${process.arch}`;
    const pythonExecutable = process.platform === 'win32' ? 'python/python.exe' : 'python/bin/python3';
    const nodeExecutable = process.platform === 'win32' ? 'node.exe' : 'bin/node';
    const manifest = writeManifest(key, pythonExecutable);
    const root = path.join(tmpDir, 'runtime');
    const dir = path.join(root, 'node', key);
    const exe = path.join(dir, ...nodeExecutable.split('/'));
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.writeFileSync(exe, '');
    if (process.platform === 'win32') {
      fs.writeFileSync(path.join(dir, 'npm.cmd'), '');
      fs.writeFileSync(path.join(dir, 'npx.cmd'), '');
    } else {
      fs.writeFileSync(path.join(dir, 'bin', 'npm'), '');
      fs.writeFileSync(path.join(dir, 'bin', 'npx'), '');
    }
    writeMarker(dir, 'node', key, 'node-test.tar.gz', 'node123', 456);

    const r = runEnsure(root, manifest, key, 'node');

    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.ok).toBe(true);
    expect(out.results[0].status).toBe('ready');
    expect(out.results[0].executable).toBe(exe);
    expect(fs.existsSync(process.platform === 'win32' ? path.join(dir, 'npm.cmd') : path.join(dir, 'bin', 'npm'))).toBe(true);
    expect(fs.existsSync(process.platform === 'win32' ? path.join(dir, 'npx.cmd') : path.join(dir, 'bin', 'npx'))).toBe(true);
  });

  it('reports a verified uv marker without uvx as unverified in check mode', () => {
    const key = `${process.platform}-${process.arch}`;
    const executable = process.platform === 'win32' ? 'uv.exe' : 'uv';
    const manifest = writeManifest(key, process.platform === 'win32' ? 'python/python.exe' : 'python/bin/python3');
    const root = path.join(tmpDir, 'runtime');
    const dir = path.join(root, 'uv', key);
    const exe = path.join(dir, executable);
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.writeFileSync(exe, '');
    writeMarker(dir, 'uv', key, 'uv-test.tar.gz', 'uv123', 234);

    const r = runEnsure(root, manifest, key, 'uv');

    expect(r.status).toBe(1);
    const out = JSON.parse(r.stdout);
    expect(out.ok).toBe(false);
    expect(out.results[0].status).toBe('unverified');
    expect(out.results[0].reason).toContain('uv runtime companion');
  });
});
