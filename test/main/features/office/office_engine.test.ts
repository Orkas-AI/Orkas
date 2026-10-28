import { EventEmitter, once } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  bin: '',
  spawn: vi.fn(),
  spawnSync: vi.fn(),
  killProcessTree: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  spawn: mocks.spawn,
  spawnSync: mocks.spawnSync,
}));
vi.mock('../../../../src/main/paths', () => ({ officeCliBinaryPath: () => mocks.bin || null }));
vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ warn: mocks.warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../../src/core-agent/src/sandbox/executor', () => ({
  killProcessTree: mocks.killProcessTree,
}));

import {
  MAC_OFFICECLI_SANDBOX_PROFILE,
  OfficeCliError,
  _resetOfficeCliAvailableForTest,
  closeAllOfficeResidents,
  closeOfficeFile,
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
    fs.writeFileSync(mocks.bin, 'binary');
    mocks.spawn.mockReset();
    mocks.spawnSync.mockReset();
    mocks.killProcessTree.mockReset();
    mocks.warn.mockReset();
    _resetOfficeCliAvailableForTest();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it('does not cache a missing binary but retains a positive availability result', () => {
    fs.rmSync(mocks.bin);
    expect(officeCliAvailable()).toBe(false);
    expect(mocks.warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain(tmpDir);
    fs.writeFileSync(mocks.bin, 'binary');
    expect(officeCliAvailable()).toBe(true);
    fs.rmSync(mocks.bin, { force: true });
    expect(officeCliAvailable()).toBe(true);
  });

  it.each(['darwin', 'win32', 'linux'] as const)('spawns hidden with piped stdio, closes stdin, and captures output on %s', async (platform) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform);
    const child = new FakeChild();
    mocks.spawn.mockReturnValue(child);
    vi.stubEnv('OFFICECLI_SKIP_UPDATE', '0');

    const resultPromise = runOfficeCli(['batch', 'book.xlsx'], { cwd: tmpDir, stdin: '{"ops":[]}' });
    const expectedCommand = process.platform === 'darwin' ? '/usr/bin/sandbox-exec' : mocks.bin;
    const expectedArgs = process.platform === 'darwin'
      ? ['-D', `OFFICECLI_BINARY=${fs.realpathSync(mocks.bin)}`, '-p', MAC_OFFICECLI_SANDBOX_PROFILE, mocks.bin, 'batch', 'book.xlsx']
      : ['batch', 'book.xlsx'];
    expect(mocks.spawn).toHaveBeenCalledWith(expectedCommand, expectedArgs, {
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

  it('prevents macOS OfficeCLI children from executing installed app bundles', async () => {
    expect(MAC_OFFICECLI_SANDBOX_PROFILE)
      .toBe(require('../../../../bin/officecli-policy-gate.cjs').MAC_OFFICECLI_SANDBOX_PROFILE);
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    const child = new FakeChild();
    mocks.spawn.mockReturnValue(child);

    const resultPromise = runOfficeCli(['view', 'deck.pptx', 'html'], { cwd: tmpDir });
    expect(mocks.spawn).toHaveBeenCalledWith(
      '/usr/bin/sandbox-exec',
      ['-D', `OFFICECLI_BINARY=${fs.realpathSync(mocks.bin)}`, '-p', MAC_OFFICECLI_SANDBOX_PROFILE, mocks.bin,
        'view', 'deck.pptx', 'html'],
      expect.any(Object),
    );
    child.emit('close', 0);
    await expect(resultPromise).resolves.toMatchObject({ code: 0 });
  });

  it.skipIf(process.platform !== 'darwin')('starts the installed binary and its resident through a symlink while denying sibling executables', async () => {
    const native = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    const installRoot = fs.mkdtempSync('/Applications/orkas-office-engine-test-');
    try {
      const bundle = path.join(installRoot, 'Orkas Test ".app', 'Contents', 'Resources', 'officecli');
      fs.mkdirSync(bundle, { recursive: true });
      const binary = path.join(bundle, 'officecli');
      const sibling = path.join(bundle, 'officecli-other');
      // Compile an inert native fixture: copied Apple platform binaries cannot
      // execute from arbitrary locations on every macOS release.
      const compiled = native.spawnSync('/usr/bin/clang', ['-x', 'c', '-', '-o', binary], {
        input: '#include <stdio.h>\n#include <unistd.h>\n'
          + 'int main(int argc,char **argv){if(argc>1){execv(argv[1],argv+1);'
          + 'perror("exec");return 70;}puts("started");return 0;}\n',
        encoding: 'utf8', timeout: 30_000,
      });
      expect(compiled.error).toBeUndefined();
      expect(compiled.status, compiled.stderr).toBe(0);
      expect(compiled.stderr).toBe('');
      fs.copyFileSync(binary, sibling);
      fs.chmodSync(sibling, 0o755);
      mocks.bin = path.join(installRoot, 'officecli-link');
      fs.symlinkSync(binary, mocks.bin);
      mocks.spawn.mockImplementation(native.spawn);

      await expect(runOfficeCli([], { cwd: tmpDir, timeoutMs: 10_000 }))
        .resolves.toEqual({ code: 0, stdout: 'started\n', stderr: '' });
      await expect(runOfficeCli([binary], { cwd: tmpDir, timeoutMs: 10_000 }))
        .resolves.toEqual({ code: 0, stdout: 'started\n', stderr: '' });
      const denied = await runOfficeCli([sibling], { cwd: tmpDir, timeoutMs: 10_000 });
      expect(denied.code).toBe(70);
      expect(denied.stdout).toBe('');
      expect(denied.stderr).toContain('Operation not permitted');
    } finally {
      fs.rmSync(installRoot, { recursive: true, force: true });
    }
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

  it.each(['close', 'sweep'] as const)('keeps %s failure diagnostics without leaking private file or error contents', async (operation) => {
    const file = path.join(tmpDir, 'confidential-acquisition.docx');
    const privateMessage = 'private document text and credentials from a failed native process';
    const failure = new Error(privateMessage);
    mocks.spawn.mockImplementation(() => { throw failure; });
    mocks.spawnSync.mockImplementation(() => { throw failure; });

    if (operation === 'close') await expect(closeOfficeFile(file, tmpDir)).resolves.toBeUndefined();
    else expect(() => closeAllOfficeResidents()).not.toThrow();

    expect(mocks.warn).toHaveBeenCalledOnce();
    const diagnostic = mocks.warn.mock.calls[0][1];
    expect(diagnostic).toMatchObject({
      error: {
        message_hash: expect.stringMatching(/^[a-f0-9]{12}$/),
        message_chars: privateMessage.length,
      },
    });
    const serialized = JSON.stringify(mocks.warn.mock.calls);
    expect(serialized).not.toContain(privateMessage);
    expect(serialized).not.toContain(tmpDir);
    expect(serialized).not.toContain(path.basename(file));
  });

  it('bounds the Windows resident helper, uses an absolute system executable and passes paths as data', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    vi.stubEnv('SystemRoot', 'D:\\Windows');
    mocks.bin = 'D:\\Orkas\\resources\\officecli\\officecli-win-x64.exe';
    mocks.spawnSync.mockReturnValue({ status: 0 });

    closeAllOfficeResidents();

    expect(mocks.spawnSync).toHaveBeenCalledWith(
      'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', expect.any(String)],
      { env: expect.objectContaining({ ORKAS_OFFICECLI_SWEEP_BINARY: mocks.bin }), timeout: 5_000, stdio: 'ignore', windowsHide: true },
    );
    const source = Buffer.from(mocks.spawnSync.mock.calls[0][1].at(-1), 'base64').toString('utf16le');
    expect(source).not.toContain(mocks.bin);
    expect(mocks.warn).not.toHaveBeenCalled();
  });

  it.each([{ status: 1 }, { status: null, error: new Error('timeout') }])('surfaces an unsuccessful Windows resident sweep without broadening its target: %j', result => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    mocks.spawnSync.mockReturnValue(result);
    closeAllOfficeResidents();
    expect(mocks.spawnSync).toHaveBeenCalledTimes(1);
    expect(mocks.warn).toHaveBeenCalledOnce();
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain(tmpDir);
  });

  it.runIf(process.platform === 'win32')('stops only this installation\'s Windows residents, preserving same-name and active commands', async () => {
    const native = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    const binaryName = `orkas-office-fixture-${process.pid}-${Date.now()}.exe`;
    const own = path.join(tmpDir, "Orkas Office 测试 '", binaryName);
    const other = path.join(tmpDir, 'Orkas-other', binaryName);
    for (const binary of [own, other]) {
      fs.mkdirSync(path.dirname(binary), { recursive: true });
      fs.copyFileSync(process.env.ORKAS_TEST_NODE!, binary);
    }
    for (const command of ['__resident-serve__', 'create']) {
      fs.writeFileSync(path.join(tmpDir, command), "console.log('ready');setTimeout(() => {}, 30000);");
    }
    mocks.bin = own;
    mocks.spawnSync.mockImplementation(native.spawnSync);
    const children: import('node:child_process').ChildProcess[] = [];
    const diagnostics: string[] = [];
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    try {
      for (const [binary, command] of [[own, '__resident-serve__'], [other, '__resident-serve__'], [own, 'create']]) {
        // A resident-mode word later in a document command must not select it.
        const child = native.spawn(binary, [command, '__resident-serve__'], {
          cwd: tmpDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
        });
        children.push(child);
        child.stderr!.on('data', bytes => diagnostics.push(String(bytes)));
        await once(child.stdout!, 'data', { signal: AbortSignal.timeout(3000) });
      }
      closeAllOfficeResidents();
      expect(alive(children[0].pid!)).toBe(false);
      expect(alive(children[1].pid!), 'another installation with the same executable name must survive').toBe(true);
      expect(alive(children[2].pid!), 'a live document command is not a stale resident').toBe(true);
      closeAllOfficeResidents();
      expect(alive(children[1].pid!)).toBe(true);
      expect(alive(children[2].pid!)).toBe(true);
      expect(mocks.warn).not.toHaveBeenCalled();
    } finally {
      await Promise.all(children.map(async child => {
        if (child.exitCode !== null || child.signalCode !== null) return;
        const closed = once(child, 'close', { signal: AbortSignal.timeout(3000) });
        child.kill();
        await closed;
      }));
    }
    expect(diagnostics).toEqual([]);
  }, 15000);
});
