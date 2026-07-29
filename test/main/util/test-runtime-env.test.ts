import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { withWindowsGitOnPath } from '../../../scripts/test-runtime-env.mjs';

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
});
