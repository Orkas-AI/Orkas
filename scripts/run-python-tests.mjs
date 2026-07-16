#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
// The open-source app is a flat repository (unlike the private monorepo, which
// nests the desktop app under PC/), so resolve both the test venv and pytest
// working directory from this repository root.
const appRoot = resolve(here, '..');
const localPython = process.platform === 'win32'
  ? resolve(appRoot, 'venv', 'Scripts', 'python.exe')
  : resolve(appRoot, 'venv', 'bin', 'python');
const candidates = [process.env.ORKAS_TEST_PYTHON, localPython, 'python3', 'python']
  .filter((value, index, all) => value && all.indexOf(value) === index);
const python = candidates.find((candidate) => {
  if (candidate.includes('/') || candidate.includes('\\')) {
    if (!existsSync(candidate)) return false;
  }
  const probe = spawnSync(candidate, ['--version'], { stdio: 'ignore' });
  return probe.status === 0;
});

if (!python) {
  console.error(`[run-python-tests] Python not found; tried: ${candidates.join(', ')}`);
  process.exit(2);
}

const args = process.argv.slice(2);
if (args.length === 0) args.push('resources/builtin');
const result = spawnSync(python, ['-m', 'pytest', ...args], {
  cwd: appRoot,
  stdio: 'inherit',
});

if (result.error) {
  console.error(`[run-python-tests] failed to start pytest: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
