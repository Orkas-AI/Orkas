import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import * as ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

function relaunchSource(): string {
  const source = fs.readFileSync(path.resolve('src/main/index.ts'), 'utf8');
  const start = source.indexOf("ipcMain.handle('orkas.relaunch'");
  const end = source.indexOf('\n    });', start);
  if (start < 0 || end < 0) throw new Error('Main relaunch handler is missing');
  return source.slice(start, end + '\n    });'.length);
}

function relaunchHarness(prepareShutdown: () => Promise<void>, isShutdownQuiescent: () => boolean, platform = 'linux') {
  const child = Object.assign(new EventEmitter(), {
    exitCode: null, signalCode: null as string | null,
    unref: vi.fn(), kill: vi.fn(() => { child.signalCode = 'SIGTERM'; return true; }),
  });
  const spawn = vi.fn((_command: string, _args: string[], _options: any) => child);
  const exit = vi.fn();
  const statSync = vi.fn(() => ({ isFile: () => true }));
  const resolveCliCommand = vi.fn(() => ({ command: 'cmd.exe', args: ['/d', '/s', '/c', 'synthetic quoted launcher'], windowsVerbatimArguments: true }));
  let invoke!: () => Promise<unknown>;
  vm.runInNewContext(ts.transpileModule(relaunchSource(), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, {
    ipcMain: { handle: (_channel: string, handler: typeof invoke) => { invoke = handler; } },
    path: platform === 'win32' ? path.win32 : path.posix,
    paths: { PC_ROOT: platform === 'win32' ? 'C:\\public repo & fixture' : '/public repo & fixture' },
    process: { platform, pid: 12345, env: { ORKAS_WORKSPACE_ROOT: '/old workspace', CORE_AGENT_AUTH_DIR: '/old auth', SYNTHETIC_KEEP: 'kept' } },
    fs: { statSync }, resolveCliCommand, spawn, app: { exit }, prepareShutdown, isShutdownQuiescent,
    log: { info() {} }, setTimeout, clearTimeout,
  });
  return { child, spawn, exit, invoke, resolveCliCommand, statSync };
}

describe('main process child-process ownership', () => {
  it('keeps unpackaged E2E launches isolated and hidden by default', () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), 'src/main/index.ts'),
      'utf8',
    );

    expect(source).toContain('process.env.ORKAS_E2E_USER_DATA_DIR');
    expect(source).toContain('process.env.ORKAS_E2E_HIDE_WINDOW');
    expect(source).toMatch(
      /else if \(E2E_USER_DATA_DIR\)[\s\S]*app\.setPath\('userData', path\.resolve\(E2E_USER_DATA_DIR\)\)/,
    );
    expect(source).toContain(
      'show: !IS_PACKAGED_LAUNCH_SMOKE && !E2E_HIDE_WINDOW',
    );
  });

  it('passes the exact old-process owner before launching the replacement', () => {
    const source = fs.readFileSync(
      path.resolve(process.cwd(), 'src/main/index.ts'),
      'utf8',
    );
    const relaunchBlock = relaunchSource();

    expect(relaunchBlock).toContain('resolveCliCommand');
    expect(relaunchBlock).toContain('delete childEnv.ORKAS_WORKSPACE_ROOT');
    expect(relaunchBlock).toContain('delete childEnv.CORE_AGENT_AUTH_DIR');
    expect(relaunchBlock).toContain(
      'childEnv.ORKAS_RELAUNCH_OWNER_PID = String(process.pid)',
    );
    expect(relaunchBlock).toContain('detached: true');
    expect(relaunchBlock).toContain("stdio: 'ignore'");
    expect(relaunchBlock).toContain('windowsHide: true');
    expect(relaunchBlock).toContain('windowsVerbatimArguments: resolved.windowsVerbatimArguments');
    expect(relaunchBlock).toContain('env: childEnv');
    expect(relaunchBlock).toContain('launcher.unref()');
    expect(relaunchBlock).toContain("prepareShutdown('relaunch')");
    // The shared coordinator owns the awaitable local drain, including the
    // public lifecycle receipt. Its behavior is covered by shutdown/lifecycle cases.
    expect(source).toMatch(/name: 'open-lifecycle',\s*run: async \(\) => \{ await openLifecycleTracking\?\.flushQuit\(\); \}/);

    const shellLauncher = fs.readFileSync(
      path.resolve(process.cwd(), 'run.sh'),
      'utf8',
    );
    const windowsLauncher = fs.readFileSync(
      path.resolve(process.cwd(), 'run.cmd'),
      'utf8',
    );
    expect(shellLauncher).toContain('ORKAS_RELAUNCH_OWNER_PID');
    expect(shellLauncher).toContain('scripts/stop-source-instance.cjs');
    expect(shellLauncher).not.toMatch(/pkill[^\n]+electron\/dist/i);
    expect(windowsLauncher).toContain('ORKAS_RELAUNCH_OWNER_PID');
    expect(windowsLauncher).toContain('scripts\\stop-source-instance.cjs');
    expect(windowsLauncher).not.toMatch(/taskkill[^\n]+electron\.exe/i);
  });
});

describe('Main relaunch lifecycle outcomes', () => {
  it.each(['linux', 'win32'].flatMap(platform => ['missing', 'directory'].map(kind => ({ platform, kind }))))(
    'retains the current app when the $platform launcher is $kind', async ({ platform, kind }) => {
      const prepare = vi.fn(async () => {});
      const fixture = relaunchHarness(prepare, () => true, platform);
      if (kind === 'missing') fixture.statSync.mockImplementation(() => { throw Object.assign(new Error('synthetic missing launcher'), { code: 'ENOENT' }); });
      else fixture.statSync.mockReturnValue({ isFile: () => false });
      const pending = fixture.invoke().then(() => 'exited', error => error);
      // A shell can launch successfully even when its script is absent.
      fixture.child.emit('spawn');
      expect(await pending).toMatchObject({ code: 'E_RELAUNCH_START_FAILED', message: 'Relaunch could not start' });
      expect(fixture.spawn).not.toHaveBeenCalled();
      expect(prepare).not.toHaveBeenCalled();
      expect(fixture.exit).not.toHaveBeenCalled();
    },
  );

  it.each(['synchronous', 'asynchronous'])('retains the app and reports a bounded error on a %s native replacement failure', async failure => {
    const prepare = vi.fn(async () => {});
    const fixture = relaunchHarness(prepare, () => true);
    if (failure === 'synchronous') fixture.spawn.mockImplementationOnce(() => { throw new Error('synthetic private launcher path'); });
    const pending = fixture.invoke().then(() => 'exited', error => error);
    if (failure === 'asynchronous') fixture.child.emit('error', new Error('synthetic private launcher path'));
    const result = await pending;
    expect(result).toMatchObject({ code: 'E_RELAUNCH_START_FAILED', message: 'Relaunch could not start' });
    expect(prepare).not.toHaveBeenCalled();
    expect(fixture.child.unref).not.toHaveBeenCalled();
    expect(fixture.exit).not.toHaveBeenCalled();
  });

  it('cancels the replacement launcher and retains the app when active-task archival fails', async () => {
    const failure = Object.assign(new Error('synthetic archival failure'), { code: 'E_SHUTDOWN_ARCHIVE_FAILED' });
    const fixture = relaunchHarness(vi.fn(async () => { throw failure; }), () => false);
    const pending = fixture.invoke().then(() => 'exited', error => error);
    fixture.child.emit('spawn');
    expect(await pending).toBe(failure);
    expect(fixture.child.kill).toHaveBeenCalledOnce();
    expect(fixture.exit).not.toHaveBeenCalled();
  });

  it.each([false, true])('bounds slow cleanup only after archival has quiesced=%s', async quiescent => {
    vi.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fixture = relaunchHarness(() => gate, () => quiescent);
    let result: any = 'pending';
    const pending = fixture.invoke().then(value => { result = value; }, error => { result = error; });
    try {
      fixture.child.emit('spawn');
      await vi.advanceTimersByTimeAsync(10_001);
      if (quiescent) {
        expect(fixture.exit).toHaveBeenCalledWith(0);
        expect(fixture.child.kill).not.toHaveBeenCalled();
      } else {
        expect(result).toMatchObject({ code: 'E_SHUTDOWN_ARCHIVE_FAILED' });
        expect(fixture.child.kill).toHaveBeenCalledOnce();
        expect(fixture.exit).not.toHaveBeenCalled();
      }
    } finally { release(); await pending; vi.useRealTimers(); }
  });

  it('retains the app when the archival phase is unavailable at the shutdown deadline', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fixture = relaunchHarness(() => gate, () => { throw new Error('synthetic unknown phase'); });
    const pending = fixture.invoke().then(() => 'exited', error => error);
    try {
      fixture.child.emit('spawn');
      await vi.advanceTimersByTimeAsync(10_001);
      expect(await pending).toMatchObject({ code: 'E_SHUTDOWN_ARCHIVE_FAILED' });
      expect(fixture.child.kill).toHaveBeenCalledOnce();
      expect(fixture.exit).not.toHaveBeenCalled();
    } finally { release(); await pending; vi.useRealTimers(); }
  });

  it.each(['linux', 'win32'])('preserves the public %s launcher contract and clears the successful cleanup deadline', async platform => {
    vi.useFakeTimers();
    const prepare = vi.fn(async () => {});
    const fixture = relaunchHarness(prepare, () => true, platform);
    try {
      const pending = fixture.invoke();
      expect(prepare).not.toHaveBeenCalled();
      fixture.child.emit('spawn');
      await pending;
      expect(prepare).toHaveBeenCalledWith('relaunch');
      expect(fixture.child.unref).toHaveBeenCalledOnce();
      expect(fixture.exit).toHaveBeenCalledOnce();
      expect(fixture.spawn.mock.calls[0][2]).toMatchObject({ detached: true, stdio: 'ignore', windowsHide: true,
        env: { ORKAS_RELAUNCH_OWNER_PID: '12345', SYNTHETIC_KEEP: 'kept' } });
      expect(fixture.spawn.mock.calls[0][2].env).not.toHaveProperty('ORKAS_WORKSPACE_ROOT');
      expect(fixture.spawn.mock.calls[0][2].env).not.toHaveProperty('CORE_AGENT_AUTH_DIR');
      if (platform === 'win32') expect(fixture.resolveCliCommand).toHaveBeenCalledWith('C:\\public repo & fixture\\run.cmd', [], 'win32', expect.any(Object));
      else expect(fixture.spawn.mock.calls[0].slice(0, 2)).toEqual(['bash', ['/public repo & fixture/run.sh']]);
      await vi.advanceTimersByTimeAsync(15_001);
      expect(fixture.child.kill).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});
