#!/usr/bin/env node
/**
 * Auto-install the repo-local git hooks directory.
 *
 * Wired into PC/package.json `prepare`, which `npm install` runs whenever
 * a contributor sets up the repo. Effect:
 *
 *   git config core.hooksPath <repo-root>/.githooks
 *
 * so the commit-msg hook (the one that enforces `Prompt audit:` on
 * prompt-facing commits) is on by default — no per-machine ceremony.
 *
 * Best-effort: silently no-ops when
 *   - cwd isn't inside a git checkout (e.g. tarball install)
 *   - the .githooks/ directory isn't present
 *   - `git` isn't on PATH
 * so a botched local setup never blocks `npm install`.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export function tryGitTopLevel({
  cwd = process.cwd(),
  execFile = execFileSync,
} = {}) {
  try {
    return execFile('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

export function installGitHooks({
  cwd = process.cwd(),
  execFile = execFileSync,
  fileSystem = fs,
  log = console.log,
  warn = console.warn,
} = {}) {
  const repoRoot = tryGitTopLevel({ cwd, execFile });
  if (!repoRoot) {
    // Not a git checkout — npm install from a published tarball, CI install
    // with .git stripped, etc. Silently no-op.
    return { status: 'no_repository' };
  }

  const hooksDir = path.join(repoRoot, '.githooks');
  if (!fileSystem.existsSync(hooksDir)) {
    // No hooks vendored in this checkout — nothing to wire up.
    return { status: 'no_hooks', repoRoot, hooksDir };
  }

  try {
    execFile('git', ['config', 'core.hooksPath', hooksDir], {
      cwd: repoRoot,
      stdio: 'ignore',
    });
    log('[install-git-hooks] repository hooks configured');
    return { status: 'installed', repoRoot, hooksDir };
  } catch {
    warn('[install-git-hooks] skipped: git config failed');
    return { status: 'config_failed', repoRoot, hooksDir };
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  installGitHooks();
}
