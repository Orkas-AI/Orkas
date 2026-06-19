import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

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
      assets: {},
    },
  };
  const file = path.join(tmpDir, 'manifest.json');
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
  return file;
}

function runEnsure(root: string, manifest: string, key: string) {
  const [platform, arch] = key.split('-');
  return spawnSync(process.execPath, [
    path.join(process.cwd(), 'bin', 'ensure-runtime.cjs'),
    '--root', root,
    '--manifest', manifest,
    '--platform', platform,
    '--arch', arch,
    '--kind', 'python',
    '--check',
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
    fs.writeFileSync(path.join(dir, '.orkas-runtime.json'), JSON.stringify({
      schema: 1,
      kind: 'python',
      platformKey: key,
      version: 'test-python',
      source: 'test',
      release: 'test',
      asset: 'python-test.tar.gz',
      sha256: 'abc123',
      size: 123,
    }, null, 2));

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
    fs.writeFileSync(path.join(dir, '.orkas-runtime.json'), JSON.stringify({
      schema: 1,
      kind: 'python',
      platformKey: key,
      version: 'test-python',
      source: 'test',
      release: 'test',
      asset: 'python-test.tar.gz',
      sha256: 'abc123',
      size: 123,
    }, null, 2));

    const r = runEnsure(root, manifest, key);

    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.ok).toBe(true);
    expect(out.results[0].status).toBe('ready');
    expect(out.results[0].dir).toBe(dir);
  });
});
