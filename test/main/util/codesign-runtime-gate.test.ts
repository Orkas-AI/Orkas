import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const afterPack = require('../../../scripts/codesign-adhoc.cjs') as (context: any) => Promise<void>;

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-afterpack-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const RUNTIME_SIZES: Record<'python' | 'uv' | 'node', number> = { python: 101, uv: 202, node: 303 };

function writeRuntime(kind: 'python' | 'uv' | 'node', key: string, executable: string): void {
  const dir = path.join(tmpDir, 'resources', 'runtime', kind, key);
  const exe = path.join(dir, ...executable.split('/'));
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, '');
  if (kind === 'python') {
    const scriptsDir = path.join(path.dirname(exe), 'Scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });
    for (const name of ['pip', 'pip3', 'pip3.12']) {
      fs.writeFileSync(path.join(scriptsDir, `${name}.cmd`), '@echo off\r\n');
    }
  } else if (kind === 'uv') {
    fs.writeFileSync(path.join(path.dirname(exe), 'uvx.exe'), '');
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

describe('codesign-adhoc runtime gate', () => {
  it('verifies packed runtime payload before signing can continue', async () => {
    const key = 'win32-x64';
    writeManifest(key);
    writeRuntime('python', key, 'python/python.exe');
    writeRuntime('uv', key, 'uv.exe');
    writeRuntime('node', key, 'node.exe');

    await afterPack({
      electronPlatformName: 'win32',
      arch: 1,
      appOutDir: tmpDir,
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
  });
});
