import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const prepare = require('../../../scripts/prepare-win-native-deps.cjs') as {
  WINDOWS_RM_OPTIONS: Record<string, unknown>;
  extractTarballInTarget: (
    targetDir: string,
    tarball: string,
    deps: {
      fsImpl: {
        copyFileSync: (source: string, target: string) => void;
        rmSync: (target: string, options: Record<string, unknown>) => void;
      };
      runImpl: (cwd: string, command: string, args: string[]) => void;
    },
  ) => void;
  npmCmd: (platform?: NodeJS.Platform) => string;
  removeDirectories: (parent: string, predicate: (name: string) => boolean) => void;
  removeTree: (target: string, fsImpl?: { rmSync: (target: string, options: Record<string, unknown>) => void }) => void;
};

const fixtureDirs: string[] = [];

afterEach(() => {
  for (const dir of fixtureDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

describe('prepare-win-native-deps Windows filesystem behavior', () => {
  it('selects npm.cmd only for a Windows host', () => {
    expect(prepare.npmCmd('win32')).toBe('npm.cmd');
    expect(prepare.npmCmd('darwin')).toBe('npm');
  });

  it('uses retrying recursive removal for transient Windows locks', () => {
    const rmSync = vi.fn();
    prepare.removeTree('D:\\temp\\native-package', { rmSync });
    expect(rmSync).toHaveBeenCalledWith('D:\\temp\\native-package', {
      recursive: true,
      force: true,
      maxRetries: 6,
      retryDelay: 100,
    });
  });

  it('extracts a Windows tarball by local basename for GNU tar compatibility', () => {
    const copyFileSync = vi.fn();
    const rmSync = vi.fn();
    const runImpl = vi.fn();
    prepare.extractTarballInTarget(
      'D:\\Code\\Orkas\\PC\\node_modules\\@img\\sharp-win32-x64',
      'C:\\Users\\tester\\AppData\\Local\\Temp\\sharp-win32-x64-0.35.3.tgz',
      { fsImpl: { copyFileSync, rmSync }, runImpl },
    );

    const localArchive = 'D:\\Code\\Orkas\\PC\\node_modules\\@img\\sharp-win32-x64\\sharp-win32-x64-0.35.3.tgz';
    expect(copyFileSync).toHaveBeenCalledWith(
      'C:\\Users\\tester\\AppData\\Local\\Temp\\sharp-win32-x64-0.35.3.tgz',
      localArchive,
    );
    expect(runImpl).toHaveBeenCalledWith(
      'D:\\Code\\Orkas\\PC\\node_modules\\@img\\sharp-win32-x64',
      'tar',
      ['-xzf', 'sharp-win32-x64-0.35.3.tgz', '--strip-components=1'],
    );
    expect(rmSync).toHaveBeenCalledWith(localArchive, { force: true });
  });

  it('prunes only matching native package directories', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-win-native-prune-'));
    fixtureDirs.push(root);
    for (const name of ['win32-x64', 'darwin-x64', 'linux-x64']) {
      fs.mkdirSync(path.join(root, name), { recursive: true });
      fs.writeFileSync(path.join(root, name, 'binding.node'), name);
    }

    prepare.removeDirectories(root, (name) => name !== 'win32-x64');

    expect(fs.readdirSync(root)).toEqual(['win32-x64']);
  });
});
