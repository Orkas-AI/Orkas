import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  installGitHooks,
  tryGitTopLevel,
} from '../../../scripts/install-git-hooks.mjs';

describe('install-git-hooks', () => {
  it('passes a repository path with shell metacharacters as one literal Git argument', () => {
    const repoRoot = '/tmp/Orkas \"release\" $(touch should-not-run)';
    const hooksDir = path.join(repoRoot, '.githooks');
    const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
    const execFile = (
      command: string,
      args: string[],
      options: { cwd?: string },
    ) => {
      calls.push({ command, args, cwd: options.cwd });
      if (args[0] === 'rev-parse') return Buffer.from(`${repoRoot}\n`);
      return Buffer.alloc(0);
    };
    const log = vi.fn();

    expect(installGitHooks({
      cwd: '/tmp/worktree',
      execFile,
      fileSystem: { existsSync: (candidate: string) => candidate === hooksDir },
      log,
      warn: vi.fn(),
    })).toEqual({ status: 'installed', repoRoot, hooksDir });
    expect(calls).toEqual([
      {
        command: 'git',
        args: ['rev-parse', '--show-toplevel'],
        cwd: '/tmp/worktree',
      },
      {
        command: 'git',
        args: ['config', 'core.hooksPath', hooksDir],
        cwd: repoRoot,
      },
    ]);
    expect(log).toHaveBeenCalledWith('[install-git-hooks] repository hooks configured');
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining(repoRoot));
  });

  it('quietly skips tarballs and repositories without vendored hooks', () => {
    const repoRoot = '/tmp/repository';

    expect(tryGitTopLevel({
      execFile: () => {
        throw new Error('git missing');
      },
    })).toBeNull();

    expect(installGitHooks({
      execFile: () => {
        throw new Error('git missing');
      },
      fileSystem: { existsSync: () => false },
      log: vi.fn(),
      warn: vi.fn(),
    })).toEqual({ status: 'no_repository' });

    expect(installGitHooks({
      execFile: () => Buffer.from(`${repoRoot}\n`),
      fileSystem: { existsSync: () => false },
      log: vi.fn(),
      warn: vi.fn(),
    })).toEqual({
      status: 'no_hooks',
      repoRoot,
      hooksDir: path.join(repoRoot, '.githooks'),
    });
  });

  it('keeps npm setup recoverable when git config fails', () => {
    const warn = vi.fn();
    const result = installGitHooks({
      execFile: (_command: string, args: string[]) => {
        if (args[0] === 'rev-parse') return Buffer.from('/tmp/repository\n');
        throw new Error('config is locked');
      },
      fileSystem: { existsSync: () => true },
      log: vi.fn(),
      warn,
    });

    expect(result).toMatchObject({
      status: 'config_failed',
      repoRoot: '/tmp/repository',
    });
    expect(warn).toHaveBeenCalledWith(
      '[install-git-hooks] skipped: git config failed',
    );
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('config is locked'));
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('/tmp/repository'));
  });
});
