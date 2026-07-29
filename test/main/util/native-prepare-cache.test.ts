import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const cache = require('../../../scripts/native-prepare-cache.cjs') as {
  isMachArch(file: string, arch: string): boolean;
  isPeX64(file: string): boolean;
  markerMatches(
    pcDir: string,
    state: Record<string, unknown>,
    requiredFiles: string[],
    validateFiles?: () => boolean,
  ): boolean;
  readElectronVersion(pcDir: string): string;
  writeMarker(pcDir: string, state: Record<string, unknown>): void;
};
const macPrepare = require('../../../scripts/prepare-mac-native-deps.cjs') as {
  npmCmd(platform?: NodeJS.Platform): string;
  removeDirectories(parent: string, predicate: (name: string) => boolean): void;
};

let root = '';

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-native-cache-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function writeThinMach(file: string, cpuType: number, bytes = 32): void {
  const data = Buffer.alloc(bytes);
  if (bytes >= 4) data.writeUInt32LE(0xfeedfacf, 0);
  if (bytes >= 8) data.writeUInt32LE(cpuType, 4);
  fs.writeFileSync(file, data);
}

function writeFatMach(file: string, cpuTypes: number[]): void {
  const data = Buffer.alloc(8 + cpuTypes.length * 20);
  data.writeUInt32BE(0xcafebabe, 0);
  data.writeUInt32BE(cpuTypes.length, 4);
  cpuTypes.forEach((cpuType, index) => {
    data.writeUInt32BE(cpuType, 8 + index * 20);
  });
  fs.writeFileSync(file, data);
}

function writePe(file: string, machine: number, truncateAt?: number): void {
  const peOffset = 64;
  const data = Buffer.alloc(truncateAt ?? peOffset + 24);
  data.write('MZ', 0, 'ascii');
  data.writeUInt32LE(peOffset, 0x3c);
  if (data.length >= peOffset + 6) {
    data.write('PE\0\0', peOffset, 'ascii');
    data.writeUInt16LE(machine, peOffset + 4);
  }
  fs.writeFileSync(file, data);
}

describe('native payload architecture detection', () => {
  it('accepts matching thin/fat Mach-O payloads and rejects wrong or truncated binaries', () => {
    const arm = path.join(root, 'arm.node');
    const x64 = path.join(root, 'x64.node');
    const universal = path.join(root, 'universal.node');
    const truncated = path.join(root, 'truncated.node');
    writeThinMach(arm, 0x0100000c);
    writeThinMach(x64, 0x01000007);
    writeFatMach(universal, [0x0100000c, 0x01000007]);
    writeThinMach(truncated, 0x0100000c, 8);

    expect(cache.isMachArch(arm, 'arm64')).toBe(true);
    expect(cache.isMachArch(arm, 'x64')).toBe(false);
    expect(cache.isMachArch(x64, 'x64')).toBe(true);
    expect(cache.isMachArch(universal, 'arm64')).toBe(true);
    expect(cache.isMachArch(universal, 'x64')).toBe(true);
    expect(cache.isMachArch(truncated, 'arm64')).toBe(false);
  });

  it('accepts only a complete PE x64 header', () => {
    const x64 = path.join(root, 'x64.node');
    const arm64 = path.join(root, 'arm64.node');
    const truncated = path.join(root, 'truncated.node');
    writePe(x64, 0x8664);
    writePe(arm64, 0xaa64);
    writePe(truncated, 0x8664, 70);

    expect(cache.isPeX64(x64)).toBe(true);
    expect(cache.isPeX64(arm64)).toBe(false);
    expect(cache.isPeX64(truncated)).toBe(false);
  });
});

describe('native preparation cache', () => {
  it('invalidates on state, file, validator, or marker corruption', () => {
    const required = path.join(root, 'binding.node');
    fs.writeFileSync(required, 'native bytes');
    const state = {
      schema: 1,
      platform: 'darwin',
      arch: 'arm64',
      packages: { native: '1.0.0' },
      scriptHashes: { prepare: 'abc' },
    };
    cache.writeMarker(root, state);

    expect(cache.markerMatches(root, state, [required], () => true)).toBe(true);
    expect(cache.markerMatches(root, { ...state, arch: 'x64' }, [required], () => true)).toBe(false);
    expect(cache.markerMatches(root, state, [required], () => false)).toBe(false);
    fs.rmSync(required);
    expect(cache.markerMatches(root, state, [required], () => true)).toBe(false);

    fs.writeFileSync(
      path.join(root, '.orkas-native-prepared', 'darwin-arm64.json'),
      '{broken',
    );
    expect(cache.markerMatches(root, state, [], () => true)).toBe(false);
  });

  it('uses the installed Electron version, then the lockfile, before a range spec', () => {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      devDependencies: { electron: '^41.7.1' },
    }));
    fs.writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({
      packages: { 'node_modules/electron': { version: '41.9.0' } },
    }));

    expect(cache.readElectronVersion(root)).toBe('41.9.0');
    const electronDir = path.join(root, 'node_modules', 'electron');
    fs.mkdirSync(electronDir, { recursive: true });
    fs.writeFileSync(path.join(electronDir, 'package.json'), JSON.stringify({
      version: '41.10.2',
    }));
    expect(cache.readElectronVersion(root)).toBe('41.10.2');
  });

  it('lets macOS preparation reuse host npm and prune only selected package directories', () => {
    expect(macPrepare.npmCmd('darwin')).toBe('npm');
    expect(macPrepare.npmCmd('win32')).toBe('npm.cmd');
    for (const name of ['darwin-arm64', 'darwin-x64', 'linux-x64']) {
      fs.mkdirSync(path.join(root, name));
    }

    macPrepare.removeDirectories(root, (name) => name !== 'darwin-arm64');
    expect(fs.readdirSync(root)).toEqual(['darwin-arm64']);
  });
});
