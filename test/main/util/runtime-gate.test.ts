import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const require = createRequire(import.meta.url);
const { verifyRuntimeRoot } = require('../../../bin/runtime-gate.cjs') as {
  verifyRuntimeRoot: (root: string, platform: string, arch: string, options?: { allowedKeys?: string[] }) => string[];
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

function writeAllRuntimes(root: string, key: string, withNodeCompanions = true): void {
  writeRuntime(root, 'python', key);
  writeRuntime(root, 'uv', key);
  writeRuntime(root, 'node', key, withNodeCompanions);
}

describe('runtime-gate', () => {
  it('verifies all bundled runtimes and their companion commands before signing', () => {
    const root = path.join(tmpDir, 'runtime');
    const key = 'win32-x64';
    writeManifest(root, [key]);
    writeAllRuntimes(root, key);

    expect(verifyRuntimeRoot(root, 'win32', 'x64')).toEqual([
      'runtime:python:win32-x64',
      'runtime:uv:win32-x64',
      'runtime:node:win32-x64',
    ]);
  });

  it('fails when bundled Node is missing npm/npx companions', () => {
    const root = path.join(tmpDir, 'runtime');
    const key = 'win32-x64';
    writeManifest(root, [key]);
    writeAllRuntimes(root, key, false);

    expect(() => verifyRuntimeRoot(root, 'win32', 'x64')).toThrow(/node runtime companion/);
  });

  it('allows explicitly whitelisted dual-arch runtime dirs for universal builds', () => {
    const root = path.join(tmpDir, 'runtime');
    const keys = ['win32-x64', 'win32-arm64'];
    writeManifest(root, keys);
    for (const key of keys) writeAllRuntimes(root, key);

    expect(verifyRuntimeRoot(root, 'win32', 'x64', { allowedKeys: keys })).toContain('runtime:node:win32-x64');
    expect(verifyRuntimeRoot(root, 'win32', 'arm64', { allowedKeys: keys })).toContain('runtime:node:win32-arm64');
  });
});
