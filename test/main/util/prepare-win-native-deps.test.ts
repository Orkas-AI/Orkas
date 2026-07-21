import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const prepare = require('../../../scripts/prepare-win-native-deps.cjs') as {
  WINDOWS_RM_OPTIONS: Record<string, unknown>;
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
