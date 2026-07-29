import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const addonBuilder = require('../../../scripts/build-notification-permission-addon.cjs') as {
  NOTIFICATION_ADDON_BUILD_TIMEOUT_MS: number;
  build(options: {
    platform: NodeJS.Platform;
    arch: string;
    force?: boolean;
    keepOtherArches?: boolean;
    buildScript?: string;
    log?: (message: string) => void;
    nodeHeaders?: string;
    outputRoot?: string;
    root?: string;
    sourceFile?: string;
    spawn?: (
      command: string,
      args: string[],
      options: Record<string, unknown>,
    ) => {
      status: number | null;
      error?: Error;
      stdout?: string;
      stderr?: string;
    };
  }): string | null;
  outputPath(arch: string, outputRoot?: string): string;
};

let root = '';
let sourceFile = '';
let buildScript = '';
let outputRoot = '';

function writeThinMach(file: string, cpuType: number): void {
  const data = Buffer.alloc(32);
  data.writeUInt32LE(0xfeedfacf, 0);
  data.writeUInt32LE(cpuType, 4);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}

function buildOptions(overrides: Record<string, unknown> = {}) {
  return {
    platform: 'darwin' as NodeJS.Platform,
    arch: 'arm64',
    buildScript,
    log: vi.fn(),
    nodeHeaders: path.join(root, 'node-headers'),
    outputRoot,
    root,
    sourceFile,
    ...overrides,
  };
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-notification-addon-'));
  sourceFile = path.join(root, 'notification_permissions.mm');
  buildScript = path.join(root, 'build-notification-permission-addon.cjs');
  outputRoot = path.join(root, 'native', 'build');
  fs.writeFileSync(sourceFile, '// source');
  fs.writeFileSync(buildScript, '// build script');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('notification permission native addon build', () => {
  it('removes stale macOS payloads when the target platform does not use the addon', () => {
    const arm = addonBuilder.outputPath('arm64', outputRoot);
    const x64 = addonBuilder.outputPath('x64', outputRoot);
    const unrelated = path.join(outputRoot, 'keep.txt');
    writeThinMach(arm, 0x0100000c);
    writeThinMach(x64, 0x01000007);
    fs.writeFileSync(unrelated, 'keep');

    expect(addonBuilder.build(buildOptions({
      platform: 'win32',
      arch: 'x64',
    }))).toBeNull();
    expect(fs.existsSync(arm)).toBe(false);
    expect(fs.existsSync(x64)).toBe(false);
    expect(fs.readFileSync(unrelated, 'utf8')).toBe('keep');
  });

  it('reuses a fresh cache only when its Mach-O architecture matches the target', () => {
    const output = addonBuilder.outputPath('arm64', outputRoot);
    writeThinMach(output, 0x0100000c);
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(output, future, future);
    const spawn = vi.fn();

    expect(addonBuilder.build(buildOptions({ spawn }))).toBe(output);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('rebuilds a fresh wrong-architecture cache with a bounded compiler and replaces it atomically', () => {
    const output = addonBuilder.outputPath('arm64', outputRoot);
    const otherArch = addonBuilder.outputPath('x64', outputRoot);
    writeThinMach(output, 0x01000007);
    writeThinMach(otherArch, 0x01000007);
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(output, future, future);
    const spawn = vi.fn((_command: string, args: string[]) => {
      const tempOutput = args[args.indexOf('-o') + 1];
      writeThinMach(tempOutput, 0x0100000c);
      return { status: 0, stdout: '', stderr: '' };
    });

    expect(addonBuilder.build(buildOptions({ spawn }))).toBe(output);
    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn.mock.calls[0][0]).toBe('xcrun');
    expect(spawn.mock.calls[0][1]).toEqual(expect.arrayContaining([
      'clang++',
      '-arch',
      'arm64',
      sourceFile,
      '-o',
    ]));
    expect(spawn.mock.calls[0][2]).toMatchObject({
      cwd: root,
      timeout: addonBuilder.NOTIFICATION_ADDON_BUILD_TIMEOUT_MS,
    });
    expect(fs.existsSync(otherArch)).toBe(false);
    expect(fs.readdirSync(outputRoot).some((entry) => entry.endsWith('.tmp'))).toBe(false);
    expect(fs.readFileSync(output).readUInt32LE(4)).toBe(0x0100000c);
  });

  it('rejects a successful compiler exit that did not produce the requested architecture', () => {
    const output = addonBuilder.outputPath('arm64', outputRoot);
    writeThinMach(output, 0x01000007);
    const before = fs.readFileSync(output);
    const spawn = vi.fn((_command: string, args: string[]) => {
      const tempOutput = args[args.indexOf('-o') + 1];
      writeThinMach(tempOutput, 0x01000007);
      return { status: 0, stdout: '', stderr: '' };
    });

    expect(() => addonBuilder.build(buildOptions({ force: true, spawn })))
      .toThrow('compiler produced an invalid arm64 Mach-O addon');
    expect(fs.readFileSync(output)).toEqual(before);
    expect(fs.readdirSync(outputRoot).some((entry) => entry.endsWith('.tmp'))).toBe(false);
  });

  it('cleans a partial temporary payload when the bounded compiler fails', () => {
    const spawn = vi.fn((_command: string, args: string[]) => {
      const tempOutput = args[args.indexOf('-o') + 1];
      fs.writeFileSync(tempOutput, 'partial');
      return {
        status: null,
        error: Object.assign(new Error('compiler timed out'), { code: 'ETIMEDOUT' }),
      };
    });

    expect(() => addonBuilder.build(buildOptions({ spawn }))).toThrow('compiler timed out');
    expect(fs.readdirSync(outputRoot).some((entry) => entry.endsWith('.tmp'))).toBe(false);
  });
});
