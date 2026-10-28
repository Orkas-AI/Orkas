import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { withTestPython, withWindowsGitOnPath, withWindowsPowerShellModules } from '../../../scripts/test-runtime-env.mjs';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

function temporaryRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-test-runtime-env-'));
  temporaryRoots.push(root);
  return root;
}

describe('test runtime environment', () => {
  it.each(['win32', 'darwin', 'linux'])('resolves the flat checkout default Python instead of its parent for %s', platform => {
    const parent = fs.realpathSync(temporaryRoot());
    const root = path.join(parent, 'app');
    const suffix = platform === 'win32' ? ['venv', 'Scripts', 'python.exe'] : ['venv', 'bin', 'python'];
    for (const directory of [parent, root]) {
      const python = path.join(directory, ...suffix);
      fs.mkdirSync(path.dirname(python), { recursive: true });
      fs.writeFileSync(python, '');
    }
    const helper = path.join(root, 'scripts', 'test-runtime-env.mjs');
    fs.mkdirSync(path.dirname(helper), { recursive: true });
    fs.copyFileSync(path.resolve(__dirname, '../../../scripts/test-runtime-env.mjs'), helper);
    const result = spawnSync(process.env.ORKAS_TEST_NODE || process.execPath,
      ['--input-type=module', '-e', 'const { withTestPython } = await import(process.argv[1]); console.log(JSON.stringify(withTestPython({}, undefined, process.argv[2])));', pathToFileURL(helper).href, platform],
      { encoding: 'utf8', timeout: 10_000 });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ORKAS_TEST_PYTHON: path.join(root, ...suffix), ORKAS_EVAL_PYTHON: path.join(root, ...suffix) });
  });

  it.each(['win32', 'darwin', 'linux'])('uses the repository virtual environment for %s fixture subprocesses', platform => {
    const root = temporaryRoot();
    const python = platform === 'win32'
      ? path.join(root, 'venv', 'Scripts', 'python.exe')
      : path.join(root, 'venv', 'bin', 'python');
    fs.mkdirSync(path.dirname(python), { recursive: true });
    fs.writeFileSync(python, '');
    const caller = { PATH: 'unchanged' };
    expect(withTestPython(caller, root, platform)).toEqual({
      PATH: 'unchanged', ORKAS_TEST_PYTHON: python, ORKAS_EVAL_PYTHON: python,
    });
    expect(caller).toEqual({ PATH: 'unchanged' });
  });

  it('preserves explicit interpreter choices and leaves absent runtimes unresolved', () => {
    const root = temporaryRoot();
    expect(withTestPython({ ORKAS_TEST_PYTHON: 'project-python' }, root)).toEqual({
      ORKAS_TEST_PYTHON: 'project-python', ORKAS_EVAL_PYTHON: 'project-python',
    });
    const explicit = { ORKAS_TEST_PYTHON: 'project-python', ORKAS_EVAL_PYTHON: 'eval-python' };
    expect(withTestPython(explicit, root)).toEqual(explicit);
    expect(withTestPython({ PATH: 'unchanged' }, root)).toEqual({ PATH: 'unchanged' });
  });

  it('restores Windows PowerShell system modules ahead of inherited pwsh modules without mutating the caller', () => {
    const systemRoot = temporaryRoot();
    const modules = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');
    fs.mkdirSync(modules, { recursive: true });
    const caller = { SystemRoot: systemRoot, PSModulePath: `core-modules;${modules};user-modules` };
    expect(withWindowsPowerShellModules(caller, 'win32').PSModulePath)
      .toBe(`${modules};core-modules;user-modules`);
    expect(caller.PSModulePath).toBe(`core-modules;${modules};user-modules`);
  });

  it('does not invent module roots or change non-Windows shell environments', () => {
    const caller = { SystemRoot: temporaryRoot(), PSModulePath: 'core-modules' };
    expect(withWindowsPowerShellModules(caller, 'win32')).toEqual(caller);
    expect(withWindowsPowerShellModules(caller, 'darwin')).toEqual(caller);
  });

  it('discovers GitHub Desktop Git when Windows PATH does not expose git', () => {
    const localAppData = temporaryRoot();
    const older = path.join(
      localAppData,
      'GitHubDesktop',
      'app-3.5.0',
      'resources',
      'app',
      'git',
      'cmd',
    );
    const latest = path.join(
      localAppData,
      'GitHubDesktop',
      'app-3.10.0',
      'resources',
      'app',
      'git',
      'cmd',
    );
    fs.mkdirSync(older, { recursive: true });
    fs.mkdirSync(latest, { recursive: true });
    fs.writeFileSync(path.join(older, 'git.exe'), '');
    fs.writeFileSync(path.join(latest, 'git.exe'), '');

    const result = withWindowsGitOnPath({
      Path: 'C:\\Windows\\System32',
      LOCALAPPDATA: localAppData,
    }, 'win32');

    expect(result.Path?.split(path.delimiter)[0]).toBe(latest);
  });

  it('preserves an existing Git PATH and leaves non-Windows environments unchanged', () => {
    const root = temporaryRoot();
    fs.writeFileSync(path.join(root, 'git.exe'), '');
    const windows = { Path: `${root}${path.delimiter}C:\\Windows`, LOCALAPPDATA: 'unused' };
    expect(withWindowsGitOnPath(windows, 'win32')).toEqual(windows);

    const posix = { PATH: '/usr/bin:/bin', LOCALAPPDATA: 'unused' };
    expect(withWindowsGitOnPath(posix, 'darwin')).toEqual(posix);
  });

  it('places Git for Windows bash ahead of the System32 WSL placeholder', () => {
    const programFiles = temporaryRoot();
    const gitCmd = path.join(programFiles, 'Git', 'cmd');
    const gitBin = path.join(programFiles, 'Git', 'bin');
    const system32 = path.join(temporaryRoot(), 'System32');
    fs.mkdirSync(gitCmd, { recursive: true });
    fs.mkdirSync(gitBin, { recursive: true });
    fs.mkdirSync(system32, { recursive: true });
    fs.writeFileSync(path.join(gitCmd, 'git.exe'), '');
    fs.writeFileSync(path.join(gitBin, 'git.exe'), '');
    fs.writeFileSync(path.join(gitBin, 'bash.exe'), '');
    fs.writeFileSync(path.join(system32, 'bash.exe'), '');

    const result = withWindowsGitOnPath({
      Path: system32,
      ProgramFiles: programFiles,
    }, 'win32');
    const entries = result.Path?.split(path.delimiter) || [];

    expect(entries[0]).toBe(gitBin);
    expect(entries[1]).toBe(gitCmd);
    expect(entries.at(-1)).toBe(system32);
    expect(result.ORKAS_TEST_BASH).toBe(path.join(gitBin, 'bash.exe'));
  });
});
