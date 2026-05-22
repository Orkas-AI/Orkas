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

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

function tryGitTopLevel() {
  try {
    return execSync('git rev-parse --show-toplevel', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return null;
  }
}

const repoRoot = tryGitTopLevel();
if (!repoRoot) {
  // Not a git checkout — npm install from a published tarball, CI install
  // with .git stripped, etc. Silently no-op.
  process.exit(0);
}

const hooksDir = path.join(repoRoot, '.githooks');
if (!fs.existsSync(hooksDir)) {
  // No hooks vendored in this checkout — nothing to wire up.
  process.exit(0);
}

try {
  execSync(`git config core.hooksPath "${hooksDir}"`, { stdio: 'ignore' });
  console.log(`[install-git-hooks] core.hooksPath -> ${hooksDir}`);
} catch (err) {
  console.warn(`[install-git-hooks] skipped: ${(err && err.message) || err}`);
}
