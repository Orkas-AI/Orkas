import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-slim-runtime-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function writeManifest(root: string, key: string): void {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({
    schema: 1,
    python: {
      version: '3.12.13+test',
      source: 'test',
      release: 'test',
      assets: {
        [key]: {
          name: 'python-test.tar.gz',
          url: 'https://example.invalid/python-test.tar.gz',
          sha256: 'abc123',
          size: 123,
          archive: 'tar.gz',
          executable: 'python/bin/python3',
        },
      },
    },
  }, null, 2));
}

function runSlim(root: string, key: string) {
  const [platform, arch] = key.split('-');
  return spawnSync(process.execPath, [
    path.join(process.cwd(), 'scripts', 'slim-runtime.cjs'),
    '--root', root,
    '--platform', platform,
    '--arch', arch,
    '--json',
  ], {
    cwd: process.cwd(),
    encoding: 'utf8',
  });
}

describe('slim-runtime.cjs', () => {
  it.skipIf(process.platform === 'win32')('compacts duplicate Python launchers into relative symlinks', () => {
    const key = 'darwin-arm64';
    const root = path.join(tmpDir, 'runtime');
    writeManifest(root, key);
    const binDir = path.join(root, 'python', key, 'python', 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    for (const name of ['python', 'python3', 'python3.12']) {
      fs.writeFileSync(path.join(binDir, name), 'same executable bytes');
    }

    const r = runSlim(root, key);

    expect(r.status).toBe(0);
    expect(fs.lstatSync(path.join(binDir, 'python3')).isFile()).toBe(true);
    for (const name of ['python', 'python3.12']) {
      const alias = path.join(binDir, name);
      expect(fs.lstatSync(alias).isSymbolicLink()).toBe(true);
      expect(fs.readlinkSync(alias)).toBe('python3');
      expect(fs.readFileSync(alias, 'utf8')).toBe('same executable bytes');
    }
  });

  it.skipIf(process.platform === 'win32')('does not replace the real target when canonical python is a symlink', () => {
    const key = 'darwin-arm64';
    const root = path.join(tmpDir, 'runtime');
    writeManifest(root, key);
    const binDir = path.join(root, 'python', key, 'python', 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'python3.12'), 'real executable bytes');
    fs.symlinkSync('python3.12', path.join(binDir, 'python3'));
    fs.symlinkSync('python3.12', path.join(binDir, 'python'));

    const r = runSlim(root, key);

    expect(r.status).toBe(0);
    expect(fs.lstatSync(path.join(binDir, 'python3.12')).isFile()).toBe(true);
    expect(fs.readlinkSync(path.join(binDir, 'python3'))).toBe('python3.12');
    expect(fs.readFileSync(path.join(binDir, 'python3'), 'utf8')).toBe('real executable bytes');
  });

  it.skipIf(process.platform === 'win32')('leaves non-identical launchers untouched', () => {
    const key = 'darwin-arm64';
    const root = path.join(tmpDir, 'runtime');
    writeManifest(root, key);
    const binDir = path.join(root, 'python', key, 'python', 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    fs.writeFileSync(path.join(binDir, 'python3'), 'canonical executable bytes');
    fs.writeFileSync(path.join(binDir, 'python'), 'different executable bytes');

    const r = runSlim(root, key);

    expect(r.status).toBe(0);
    expect(fs.lstatSync(path.join(binDir, 'python')).isFile()).toBe(true);
    expect(fs.readFileSync(path.join(binDir, 'python'), 'utf8')).toBe('different executable bytes');
  });
});
