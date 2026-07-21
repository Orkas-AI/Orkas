import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  bin: '',
  spawn: vi.fn(),
  spawnSync: vi.fn(),
  killProcessTree: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: mocks.spawn,
  spawnSync: mocks.spawnSync,
}));
vi.mock('../../../../src/main/paths', () => ({ officeCliBinaryPath: () => mocks.bin || null }));
vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../../src/core-agent/src/sandbox/executor', () => ({
  killProcessTree: mocks.killProcessTree,
}));

import {
  OfficeCliError,
  _resetOfficeCliAvailableForTest,
  closeAllOfficeResidents,
  officeCliAvailable,
  runOfficeCli,
} from '../../../../src/main/features/office/office_engine';

class FakeStream extends EventEmitter {
  write = vi.fn();
  end = vi.fn();
}

class FakeChild extends EventEmitter {
  pid = 4242;
  stdout = new FakeStream();
  stderr = new FakeStream();
  stdin = new FakeStream();
  kill = vi.fn();
}

describe('OfficeCLI engine', () => {
  let tmpDir = '';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-office-engine-'));
    mocks.bin = path.join(tmpDir, process.platform === 'win32' ? 'officecli.exe' : 'officecli');
    mocks.spawn.mockReset();
    mocks.spawnSync.mockReset();
    mocks.killProcessTree.mockReset();
    _resetOfficeCliAvailableForTest();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('does not cache a missing binary but retains a positive availability result', () => {
    expect(officeCliAvailable()).toBe(false);
    fs.writeFileSync(mocks.bin, 'binary');
    expect(officeCliAvailable()).toBe(true);
    fs.rmSync(mocks.bin, { force: true });
    expect(officeCliAvailable()).toBe(true);
  });

  it('spawns hidden with piped stdio, closes stdin, and captures output', async () => {
    const child = new FakeChild();
    mocks.spawn.mockReturnValue(child);
    vi.stubEnv('OFFICECLI_SKIP_UPDATE', '0');

    const resultPromise = runOfficeCli(['batch', 'book.xlsx'], { cwd: tmpDir, stdin: '{"ops":[]}' });
    expect(mocks.spawn).toHaveBeenCalledWith(mocks.bin, ['batch', 'book.xlsx'], {
      cwd: tmpDir,
      detached: process.platform !== 'win32',
      env: expect.objectContaining({ OFFICECLI_SKIP_UPDATE: '1' }),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    expect(child.stdin.write).toHaveBeenCalledWith('{"ops":[]}');
    expect(child.stdin.end).toHaveBeenCalledOnce();

    child.stdout.emit('data', Buffer.from('done'));
    child.stderr.emit('data', Buffer.from('warning'));
    child.emit('close', 0);

    await expect(resultPromise).resolves.toEqual({ code: 0, stdout: 'done', stderr: 'warning' });
  });

  it('rejects a timeout immediately and terminates the entire process tree', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    mocks.spawn.mockReturnValue(child);

    const resultPromise = runOfficeCli(['view', 'slow.docx'], { cwd: tmpDir, timeoutMs: 25 });
    const rejection = expect(resultPromise).rejects.toMatchObject({ code: 'E_OFFICE_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(25);
    await rejection;

    expect(mocks.killProcessTree).toHaveBeenCalledWith(child, 'SIGKILL');
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('uses the same tree termination path for cancellation and handles pre-aborted calls', async () => {
    const child = new FakeChild();
    mocks.spawn.mockReturnValue(child);
    const controller = new AbortController();
    const resultPromise = runOfficeCli(['create', 'deck.pptx'], { cwd: tmpDir, signal: controller.signal });

    controller.abort();
    await expect(resultPromise).rejects.toMatchObject({ code: 'E_OFFICE_ABORTED' });
    expect(mocks.killProcessTree).toHaveBeenCalledWith(child, 'SIGKILL');

    const preAborted = new AbortController();
    preAborted.abort();
    await expect(runOfficeCli(['create'], { cwd: tmpDir, signal: preAborted.signal }))
      .rejects.toBeInstanceOf(OfficeCliError);
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  });

  it('bounds combined stdout and stderr memory and kills a noisy process', async () => {
    const child = new FakeChild();
    mocks.spawn.mockReturnValue(child);
    const resultPromise = runOfficeCli(['view', 'noisy.docx'], { cwd: tmpDir, maxOutputBytes: 8 });

    child.stdout.emit('data', Buffer.from('12345'));
    child.stderr.emit('data', Buffer.from('6789'));

    await expect(resultPromise).rejects.toMatchObject({ code: 'E_OFFICE_OUTPUT_LIMIT' });
    expect(mocks.killProcessTree).toHaveBeenCalledWith(child, 'SIGKILL');
  });

  it('uses a hidden absolute taskkill tree command for the Windows resident sweep', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    vi.stubEnv('SystemRoot', 'D:\\Windows');
    mocks.bin = 'D:\\Orkas\\resources\\officecli\\officecli-win-x64.exe';

    closeAllOfficeResidents();

    expect(mocks.spawnSync).toHaveBeenCalledWith(
      'D:\\Windows\\System32\\taskkill.exe',
      ['/F', '/T', '/IM', 'officecli-win-x64.exe'],
      { timeout: 5_000, stdio: 'ignore', windowsHide: true },
    );
  });
});
