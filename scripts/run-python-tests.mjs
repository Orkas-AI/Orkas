#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { withWindowsGitOnPath } from './test-runtime-env.mjs';

const here = dirname(fileURLToPath(import.meta.url));
// The open-source app and its test virtual environment share this flat root.
const repoRoot = resolve(here, '..');
const localPython = process.platform === 'win32'
  ? resolve(repoRoot, 'venv', 'Scripts', 'python.exe')
  : resolve(repoRoot, 'venv', 'bin', 'python');
const testEnvironment = withWindowsGitOnPath(process.env);
const candidates = [testEnvironment.ORKAS_TEST_PYTHON, localPython, 'python3', 'python']
  .filter((value, index, all) => value && all.indexOf(value) === index);
const python = candidates.find((candidate) => {
  if (candidate.includes('/') || candidate.includes('\\')) {
    if (!existsSync(candidate)) return false;
  }
  const probe = spawnSync(candidate, ['--version'], { stdio: 'ignore', env: testEnvironment });
  return probe.status === 0;
});

if (!python) {
  console.error(`[run-python-tests] Python not found; tried: ${candidates.join(', ')}`);
  process.exit(2);
}
testEnvironment.ORKAS_TEST_PYTHON = python;

const args = process.argv.slice(2);
const cwdFlag = args.findIndex(arg => arg.startsWith('--cwd='));
const cwd = cwdFlag < 0 ? repoRoot : resolve(args.splice(cwdFlag, 1)[0].slice(6));
if (args.length === 0) args.push('resources/builtin');
if (args.some(arg => arg === '--resume' || arg.startsWith('--checkpoint-dir') || arg.startsWith('--batch-count'))) {
  try {
    const { runRunnerCheckpoint } = await import('./runner-checkpoint.mjs');
    process.exitCode = await runRunnerCheckpoint('python', args, { cwd, env: testEnvironment, python });
  } catch (error) {
    console.error(`[run-python-tests] ${error.message}`);
    process.exitCode = 1;
  }
} else {
  const result = spawnSync(python, ['-m', 'pytest', ...args], {
    cwd,
    stdio: 'inherit',
    env: testEnvironment,
  });

  if (result.error) {
    console.error(`[run-python-tests] failed to start pytest: ${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}
