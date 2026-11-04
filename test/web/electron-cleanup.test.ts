import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, unlinkSync, rmSync, existsSync } from 'node:fs';

import { tmpdir } from 'node:os';

import { randomUUID } from 'node:crypto';

import path from 'node:path';

import ts from 'typescript';

import { spawn } from 'node:child_process';

import { EventEmitter } from 'node:events';

import { expect, it, vi } from 'vitest';

import { closeElectronFixture, requestElectronQuit } from '../e2e/fixtures/electron-cleanup';

import { analyzeWebAppLogs } from '../e2e/fixtures/web-app-log-analysis';


function evaluateQuit(callback: (electron: any) => void, electron: any,
  inspector: { close(): void } | (() => never) = { close: vi.fn() }): void {
  // Playwright serializes the callback into the application's Node context.
  // Keep its inspector isolated from the Vitest process in this control.
  new Function('process', 'setImmediate', 'electron', `return (${callback.toString()})(electron);`)(
    { mainModule: { require: (name: string) => {
      expect(name).toBe('node:inspector');
      return typeof inspector === 'function' ? inspector() : inspector;
    } } }, setImmediate, electron,
  );
}


it.each([false, true])('isolates Chromium stub traffic while preserving explicit proxy coverage (proxy: %s)', async systemProxyRouting => {
  const source = ts.createSourceFile('orkas.ts', readFileSync(
    path.join(__dirname, '../e2e/fixtures/orkas.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
  const owner = source.statements.find((node): node is ts.ClassDeclaration =>
    ts.isClassDeclaration(node) && node.name?.text === 'OrkasTestApp');
  const launch = owner?.members.find(member => member.name?.getText(source) === 'launch');
  if (!launch) throw new Error('Missing fixture launch owner');
  const code = ts.transpileModule(`class LaunchOwner { ${launch.getText(source)} }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const reachedLaunch = new Error('launch boundary reached');
  const launchApplication = vi.fn(async (_options: { args: string[]; env: Record<string, string> }) => { throw reachedLaunch; });
  const Owner = new Function('electron', 'PC_ROOT', 'path', '__dirname', 'process', `${code}; return LaunchOwner;`)(
    { launch: launchApplication }, '/fixture/pc', path, '/fixture', { platform: process.platform, env: {} });
  const fixture = Object.assign(new Owner(), {
    root: '/fixture', options: {}, enableSystemProxy: systemProxyRouting, apiBaseUrl: 'http://127.0.0.1:12345/api',
    workspaceRoot: '/fixture/workspace', userDataRoot: '/fixture/user-data', authRoot: '/fixture/auth',
    ensureStubServer: async () => {},
  });
  await expect(fixture.launch()).rejects.toBe(reachedLaunch);
  const invocation = launchApplication.mock.calls[0][0] as { args: string[]; env: Record<string, string> };
  expect(invocation.args.includes('--no-proxy-server')).toBe(!systemProxyRouting);
  expect(invocation.env.ORKAS_NO_AUTO_PROXY).toBe(systemProxyRouting ? '0' : '1');
});


it('defers graceful quit outside evaluation and waits for the real close event', async () => {
  const app = new EventEmitter() as any;
  app.windows = () => [{ isClosed: () => false, evaluate: vi.fn(async () => {}) }];
  app.close = vi.fn(async () => {});
  let evaluating = false;
  let requested = false;
  let finished = false;
  app.evaluate = async (callback: any) => {
    evaluating = true;
    evaluateQuit(callback, { app: { quit: () => { expect(evaluating).toBe(false); requested = true; } } });
    expect(requested).toBe(false);
    evaluating = false;
  };
  const completion = requestElectronQuit(app).then(() => { finished = true; });
  await vi.waitFor(() => expect(requested).toBe(true));
  expect(finished).toBe(false);
  app.emit('close');
  await completion;
  expect(app.listenerCount('close')).toBe(0);
});


it('preserves quit request errors and removes the close observer', async () => {
  const app = new EventEmitter() as any;
  app.windows = () => [{ isClosed: () => false, evaluate: vi.fn(async () => {}) }];
  app.evaluate = async () => { throw new Error('inspector unavailable'); };
  await expect(requestElectronQuit(app)).rejects.toThrow('inspector unavailable');
  expect(app.listenerCount('close')).toBe(0);
});


it('detaches the inspector before one deferred quit without asking Playwright to quit again', async () => {
  const app = new EventEmitter() as any;
  app.windows = () => [{ isClosed: () => false, evaluate: vi.fn(async () => {}) }];
  let quit!: () => void;
  const quitting = new Promise<void>(resolve => { quit = resolve; });
  const steps: string[] = [];
  const inspector = { close: vi.fn(() => { steps.push('detach'); }) };
  app.evaluate = async (callback: any) => {
    evaluateQuit(callback, { app: { quit: () => { steps.push('quit'); quit(); app.emit('close'); } } }, inspector);
  };
  app.close = vi.fn(async () => { await quitting; app.emit('close'); });
  await requestElectronQuit(app);
  expect(steps).toEqual(['detach', 'quit']);
  expect(inspector.close).toHaveBeenCalledTimes(1);
  expect(app.close).not.toHaveBeenCalled();
  expect(app.listenerCount('close')).toBe(0);
});


it('preserves inspector setup failures instead of reporting graceful shutdown', async () => {
  const app = new EventEmitter() as any;
  const failure = new Error('inspector detach failed');
  app.windows = () => [{ isClosed: () => false, evaluate: vi.fn(async () => {}) }];
  const quit = vi.fn();
  app.evaluate = async (callback: any) => evaluateQuit(callback, { app: { quit } }, () => { throw failure; });
  app.close = vi.fn();
  await expect(requestElectronQuit(app)).rejects.toBe(failure);
  expect(quit).not.toHaveBeenCalled();
  expect(app.close).not.toHaveBeenCalled();
  expect(app.listenerCount('close')).toBe(0);
});


it.each([
  'electronApplication.evaluate: Execution context was destroyed, most likely because of a navigation.',
  'electronApplication.evaluate: Target page, context or browser has been closed',
])('waits for real process close after an inspector-disposal race: %s', async message => {
  const app = new EventEmitter() as any;
  app.windows = () => [{ isClosed: () => false, evaluate: vi.fn(async () => {}) }];
  app.close = vi.fn(async () => {});
  app.evaluate = async () => { throw new Error(message); };
  let finished = false;
  const completion = requestElectronQuit(app).then(() => { finished = true; });
  // Observe rejection immediately as well, so the negative control is bounded.
  const observed = completion.catch(error => error);
  await new Promise(resolve => setImmediate(resolve));
  expect(finished).toBe(false);
  app.emit('close');
  expect(await observed).toBeUndefined();
  expect(finished).toBe(true);
  expect(app.listenerCount('close')).toBe(0);
});


it.skipIf(process.platform === 'darwin')('waits for natural shutdown after the final window closes', async () => {
  const app = new EventEmitter() as any;
  const child = new EventEmitter() as any;
  child.exitCode = null;
  child.signalCode = null;
  app.windows = () => [];
  app.process = () => child;
  app.close = vi.fn(async () => {});
  app.evaluate = vi.fn();
  const completion = requestElectronQuit(app);
  expect(app.evaluate).not.toHaveBeenCalled();
  expect(app.close).toHaveBeenCalledTimes(1);
  child.exitCode = 0;
  child.emit('exit', 0);
  await expect(completion).resolves.toBeUndefined();
  expect(child.listenerCount('exit')).toBe(0);
});


it('captures ownership before a successful close disposes the application object', async () => {
  let closed = false;
  const child = { exitCode: 0, signalCode: null } as any;
  await expect(closeElectronFixture({
    process: () => { if (closed) throw new Error('Disposed application'); return child; },
    close: async () => { closed = true; },
    context: () => ({ tracing: { stop: async () => {} } }),
  }, 'unused-trace.zip')).resolves.toBeUndefined();
  expect(closed).toBe(true);
});


it('bounds stuck tracing and shutdown, stops only the owned process and preserves the failure', async () => {
  const node = process.env.ORKAS_TEST_NODE || process.execPath;
  const start = () => spawn(node, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: process.platform !== 'win32', windowsHide: true, stdio: 'ignore',
  });
  const owned = start();
  const unrelated = start();
  const phase = vi.fn();
  try {
    await expect(closeElectronFixture({ process: () => owned,
      close: () => new Promise(() => {}),
      context: () => ({ tracing: { stop: () => new Promise(() => {}) } }),
    }, 'unused-trace.zip', { phase, traceTimeoutMs: 20, closeTimeoutMs: 20 }))
      .rejects.toThrow('trace-stop, application-close');
    expect(owned.exitCode !== null || owned.signalCode !== null).toBe(true);
    expect(unrelated.exitCode).toBeNull();
    expect(phase).toHaveBeenCalledWith('owned-process-cleanup', 'completed');
  } finally {
    for (const child of [owned, unrelated]) {
      if (child.exitCode === null && child.signalCode === null) {
        const exit = new Promise(resolve => child.once('exit', resolve));
        child.kill('SIGKILL');
        await exit;
      }
    }
  }
});


it('retains the original application-close error as the cleanup failure cause', async () => {
  const original = new Error('injected inspector close failure');
  const result = closeElectronFixture({
    process: () => ({ exitCode: 0, signalCode: null }) as any,
    close: async () => { throw original; },
    context: () => ({ tracing: { stop: async () => {} } }),
  }, 'unused-trace.zip');
  await expect(result).rejects.toMatchObject({
    message: 'Electron fixture cleanup failed: application-close', cause: original,
  });
});


// Exercise the actual owner method without loading Playwright's fixture runner.
// A timeout may overlap relaunch with teardown; neither may duplicate trace/quit
// or clear an application that has since replaced the captured instance.
function createCleanupOwner(app: any) {
  const file = ts.createSourceFile('orkas.ts', readFileSync(
    path.join(__dirname, '../e2e/fixtures/orkas.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
  const owner = file.statements.find((node): node is ts.ClassDeclaration =>
    ts.isClassDeclaration(node) && node.name?.text === 'OrkasTestApp');
  if (!owner) throw new Error('Missing fixture owner');
  const members = owner.members.filter(member =>
    member.name && ['closeCurrentApp', 'appClosePromises', 'appTraceStops', 'appProcesses', 'nativeShutdownProcesses', 'stopAppTrace', 'prepareForNativeShutdown', 'launchAfterNativeExit', 'launchAfterCrash'].includes(member.name.getText(file)));
  const code = ts.transpileModule(`class CleanupOwner { ${members.map(m => m.getText(file)).join('\n')} }`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const Owner = new Function('closeElectronFixture', 'requestElectronQuit', `${code}; return CleanupOwner;`)(
    closeElectronFixture, requestElectronQuit);
  return Object.assign(new Owner(), {
    electronApp: app, page: {}, traceNumber: 0, tracePaths: [],
    testInfo: { outputPath: (name: string) => name }, recordCleanupPhase: vi.fn(),
  });
}


function controlledCleanupApp(closeError?: Error) {
  let release!: () => void;
  const tracingGate = new Promise<void>(resolve => { release = resolve; });
  const app = new EventEmitter() as any;
  const child = Object.assign(new EventEmitter(), { exitCode: null as number | null, signalCode: null as string | null,
    kill: (signal: string) => { child.signalCode = signal; child.emit('exit', null, signal); return true; } });
  app.windows = () => [{ isClosed: () => false, evaluate: vi.fn(async () => {}) }];
  app.close = vi.fn(async () => { child.exitCode = 0; });
  app.process = () => child;
  const stop = vi.fn(() => tracingGate);
  app.context = () => ({ tracing: { stop } });
  app.evaluate = vi.fn(async (callback: any) => {
    if (closeError) throw closeError;
    evaluateQuit(callback, { app: { quit: () => { child.exitCode = 0; child.emit('exit', 0); app.emit('close'); } } });
  });
  return { app, stop, release };
}


it('shares one trace and graceful shutdown when relaunch and teardown overlap', async () => {
  const { app, stop, release } = controlledCleanupApp();
  const owner = createCleanupOwner(app);
  const first = owner.closeCurrentApp();
  const second = owner.closeCurrentApp();
  release();
  await Promise.all([first, second]);
  expect(stop).toHaveBeenCalledTimes(1);
  expect(app.evaluate).toHaveBeenCalledTimes(1);
  expect(owner.tracePaths).toEqual(['trace-1.zip']);
  expect(owner.electronApp).toBeNull();
  expect(owner.page).toBeNull();
});


it('exports tracing before native shutdown and reuses that export during teardown', async () => {
  const { app, stop, release } = controlledCleanupApp();
  const owner = createCleanupOwner(app);
  release();
  await owner.prepareForNativeShutdown();
  expect(stop).toHaveBeenCalledTimes(1);
  app.context = () => { throw new Error('Native shutdown disposed the browser context'); };
  await owner.closeCurrentApp();
  expect(stop).toHaveBeenCalledTimes(1);
  expect(owner.tracePaths).toEqual(['trace-1.zip']);
  expect(app.evaluate).toHaveBeenCalledTimes(1);
});


it('uses launch-time process ownership after a user exit disposes the Playwright application', async () => {
  const { app, release } = controlledCleanupApp();
  const owner = createCleanupOwner(app);
  const child = { exitCode: 0, signalCode: null } as any;
  owner.appProcesses = new WeakMap([[app, child]]);
  release(); await owner.prepareForNativeShutdown();
  app.process = () => { throw new Error('Application object already disposed'); };
  app.context = () => { throw new Error('Browser context already disposed'); };
  await expect(owner.closeCurrentApp()).resolves.toBeUndefined();
  expect(app.evaluate).not.toHaveBeenCalled();
  expect(app.close).not.toHaveBeenCalled();
  expect(owner.electronApp).toBeNull();
});


it('delivers the same cleanup failure and original cause to both overlapping callers', async () => {
  const cause = new Error('injected owner close failure');
  const { app, release } = controlledCleanupApp(cause);
  const owner = createCleanupOwner(app);
  const results = Promise.allSettled([owner.closeCurrentApp(), owner.closeCurrentApp()]);
  release();
  const [first, second] = await results;
  expect(first.status).toBe('rejected');
  expect(second.status).toBe('rejected');
  if (first.status !== 'rejected' || second.status !== 'rejected') throw new Error('Missing cleanup rejection');
  expect(first.reason).toBe(second.reason);
  expect(first.reason).toMatchObject({ message: 'Electron fixture cleanup failed: application-close', cause });
  expect(owner.electronApp).toBeNull();
});


it('leaves a replacement application and page owned after the old close finishes', async () => {
  const { app, release } = controlledCleanupApp();
  const owner = createCleanupOwner(app);
  const completion = owner.closeCurrentApp();
  const replacement = controlledCleanupApp();
  const replacementPage = {};
  owner.electronApp = replacement.app;
  owner.page = replacementPage;
  release();
  await completion;
  expect(owner.electronApp).toBe(replacement.app);
  expect(owner.page).toBe(replacementPage);
  expect(replacement.stop).not.toHaveBeenCalled();
  expect(replacement.app.evaluate).not.toHaveBeenCalled();
});


it.each(['success', 'application-error', 'cleanup-error'] as const)(
  'retains the canonical complete log for downstream analyzers after %s in checkpoint mode', async scenario => {
    const file = ts.createSourceFile('orkas.ts', readFileSync(
      path.join(__dirname, '../e2e/fixtures/orkas.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
    const owner = file.statements.find((node): node is ts.ClassDeclaration =>
      ts.isClassDeclaration(node) && node.name?.text === 'OrkasTestApp');
    const dispose = owner?.members.find(member => member.name?.getText(file) === 'dispose');
    if (!dispose) throw new Error('Missing fixture disposal owner');
    const code = ts.transpileModule(`class DisposalOwner { ${dispose.getText(file)} }`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const dependencies = { mkdirSync, writeFileSync, unlinkSync, rmSync, randomUUID, path, Buffer,
      analyzeWebAppLogs, collectLogFiles: () => '[fixture-cleanup] complete\n', expect };
    const Owner = new Function(...Object.keys(dependencies), `${code}; return DisposalOwner;`)(...Object.values(dependencies));
    const root = mkdtempSync(path.join(tmpdir(), 'electron-log-retention-'));
    const fixtureRoot = path.join(root, 'fixture');
    const outputDir = path.join(root, 'output');
    mkdirSync(fixtureRoot);
    const raw = scenario === 'application-error'
      ? '[main:stderr] [12:00:00.000] [error] [(fixture)] controlled failure'
      : '[main:stdout] complete application evidence';
    const failure = new Error('controlled cleanup failure');
    const testInfo = { status: 'passed', expectedStatus: 'passed', outputDir,
      outputPath: (name: string) => path.join(outputDir, name), attach: vi.fn(async () => {}) };
    const app = Object.assign(new Owner(), { testInfo, root: fixtureRoot, page: null,
      resourceDenials: new Map(), browserDenials: new Map(), rendererPageErrors: [],
      recoveredRendererErrors: new Set(), diagnostics: [raw], tracePaths: [],
      expectedInvokeFailures: [], expectedRendererFailures: new Map(), expectedApiFailures: [], apiResponses: [],
      recoveredDiagnosticRanges: () => [],
      closeCurrentApp: async () => { if (scenario === 'cleanup-error') throw failure; },
      closeStubServer: async () => {},
    });
    vi.stubEnv('ORKAS_TEST_BATCH_REPORT', 'controlled-checkpoint.json');
    try {
      if (scenario === 'application-error') await expect(app.dispose()).rejects.toThrow('Unexpected Electron diagnostics');
      else if (scenario === 'cleanup-error') await expect(app.dispose()).rejects.toBe(failure);
      else await app.dispose();
      const canonical = testInfo.outputPath('electron-main.log');
      expect(existsSync(canonical), 'A failure must retain the same canonical path as success').toBe(true);
      expect(readFileSync(canonical, 'utf8')).toBe(`${raw}\n[fixture-cleanup] complete\n`);
      expect(existsSync(fixtureRoot), 'Owned resources are cleaned even when evidence fails').toBe(false);
      const analysis = JSON.parse(readFileSync(testInfo.outputPath('electron-log-analysis.json'), 'utf8'));
      expect(analysis.passed).toBe(scenario !== 'application-error');
      expect(analysis.coveragePassed).toBe(true);
      expect(testInfo.attach).toHaveBeenCalledWith('electron-logs', expect.objectContaining({ path: expect.any(String) }));
    } finally {
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    }
  });



it('reopens through fixture ownership after prepared clean native exit without a fallback quit', async () => {
  const { app, stop, release } = controlledCleanupApp();
  const owner = createCleanupOwner(app);
  const child = app.process();
  child.exitCode = 0;
  app.process = vi.fn(() => child);
  release();
  await owner.prepareForNativeShutdown();
  app.process = vi.fn(() => { throw new Error('Disposed native application'); });
  app.context = vi.fn(() => { throw new Error('Disposed native browser context'); });
  const replacement = {};
  const replacementPage = {};
  owner.launch = vi.fn(async () => {
    expect(owner.electronApp).toBeNull();
    expect(owner.page).toBeNull();
    owner.electronApp = replacement;
    owner.page = replacementPage;
  });
  expect(await owner.launchAfterNativeExit(app)).toBe(replacementPage);
  expect(stop).toHaveBeenCalledTimes(1);
  expect(app.process).not.toHaveBeenCalled();
  expect(app.context).not.toHaveBeenCalled();
  expect(app.evaluate).not.toHaveBeenCalled();
  expect(app.close).not.toHaveBeenCalled();
  expect(owner.launch).toHaveBeenCalledTimes(1);
  expect(owner.electronApp).toBe(replacement);
  expect(owner.page).toBe(replacementPage);
});


it.each([
  { exitCode: null, signalCode: null },
  { exitCode: 2, signalCode: null },
  { exitCode: null, signalCode: 'SIGKILL' },
])('does not replace an unclean or still-running native owner: %j', async terminal => {
  const { app, release } = controlledCleanupApp();
  app.process = () => terminal;
  const owner = createCleanupOwner(app);
  const page = owner.page;
  owner.launch = vi.fn();
  release();
  await owner.prepareForNativeShutdown();
  await expect(owner.launchAfterNativeExit(app)).rejects.toThrow('has not exited cleanly');
  expect(owner.electronApp).toBe(app);
  expect(owner.page).toBe(page);
  expect(owner.launch).not.toHaveBeenCalled();
  expect(app.evaluate).not.toHaveBeenCalled();
  expect(app.close).not.toHaveBeenCalled();
});


it('requires native trace preparation and preserves its export failure', async () => {
  const { app } = controlledCleanupApp();
  app.process().exitCode = 0;
  const owner = createCleanupOwner(app);
  const page = owner.page;
  owner.launch = vi.fn();
  await expect(owner.launchAfterNativeExit(app)).rejects.toThrow('was not prepared');
  const failure = new Error('controlled trace export failure');
  app.context = () => ({ tracing: { stop: () => Promise.reject(failure) } });
  await expect(owner.prepareForNativeShutdown()).rejects.toBe(failure);
  await expect(owner.launchAfterNativeExit(app)).rejects.toBe(failure);
  expect(owner.electronApp).toBe(app);
  expect(owner.page).toBe(page);
  expect(owner.launch).not.toHaveBeenCalled();
  expect(app.evaluate).not.toHaveBeenCalled();
  expect(app.close).not.toHaveBeenCalled();
});


it('preserves a replacement owner when native trace export settles late', async () => {
  const { app, release } = controlledCleanupApp();
  app.process().exitCode = 0;
  const owner = createCleanupOwner(app);
  owner.launch = vi.fn();
  const exporting = owner.prepareForNativeShutdown();
  const reopening = owner.launchAfterNativeExit(app);
  const rejected = expect(reopening).rejects.toThrow('ownership changed');
  const replacement = {};
  const replacementPage = {};
  owner.electronApp = replacement;
  owner.page = replacementPage;
  release();
  await exporting;
  await rejected;
  expect(owner.electronApp).toBe(replacement);
  expect(owner.page).toBe(replacementPage);
  expect(owner.launch).not.toHaveBeenCalled();
  expect(app.evaluate).not.toHaveBeenCalled();
  expect(app.close).not.toHaveBeenCalled();
});


it('does not bypass cleanup already owned by teardown after native exit', async () => {
  const { app, release } = controlledCleanupApp();
  app.process().exitCode = 0;
  const owner = createCleanupOwner(app);
  owner.launch = vi.fn();
  release();
  await owner.prepareForNativeShutdown();
  owner.appClosePromises.set(app, Promise.resolve());
  await expect(owner.launchAfterNativeExit(app)).rejects.toThrow('cleanup already started');
  expect(owner.electronApp).toBe(app);
  expect(owner.launch).not.toHaveBeenCalled();
});


it('reopens only the prepared SIGKILL owner without querying its disposed channels or issuing quit', async () => {
  const { app, stop, release } = controlledCleanupApp();
  const child = { exitCode: null, signalCode: null as string | null };
  app.process = () => child;
  const owner = createCleanupOwner(app);
  release();
  await owner.prepareForNativeShutdown();
  child.signalCode = 'SIGKILL';
  app.process = vi.fn(() => { throw new Error('Disposed application process channel'); });
  app.context = vi.fn(() => { throw new Error('Disposed tracing channel'); });
  const replacement = {}, replacementPage = {};
  owner.launch = vi.fn(async () => {
    expect(owner.electronApp).toBeNull();
    expect(owner.page).toBeNull();
    owner.electronApp = replacement;
    owner.page = replacementPage;
  });
  expect(await owner.launchAfterCrash(app)).toBe(replacementPage);
  expect(stop).toHaveBeenCalledTimes(1);
  expect(owner.launch).toHaveBeenCalledTimes(1);
  expect(owner.electronApp).toBe(replacement);
  expect(owner.page).toBe(replacementPage);
  for (const operation of [app.process, app.context, app.evaluate, app.close]) expect(operation).not.toHaveBeenCalled();
});


it.each([
  { exitCode: null, signalCode: null },
  { exitCode: 0, signalCode: null },
  { exitCode: 2, signalCode: null },
  { exitCode: null, signalCode: 'SIGTERM' },
  { exitCode: 1, signalCode: 'SIGKILL' },
])('refuses crash reopen for any other native terminal state: %j', async terminal => {
  const { app, release } = controlledCleanupApp();
  app.process = () => terminal;
  const owner = createCleanupOwner(app);
  const page = owner.page;
  owner.launch = vi.fn();
  release();
  await owner.prepareForNativeShutdown();
  await expect(owner.launchAfterCrash(app)).rejects.toThrow('has not exited with SIGKILL');
  expect(owner.electronApp).toBe(app);
  expect(owner.page).toBe(page);
  expect(owner.launch).not.toHaveBeenCalled();
  expect(app.evaluate).not.toHaveBeenCalled();
  expect(app.close).not.toHaveBeenCalled();
});


it('requires captured crash ownership and retains trace export failures without clearing the app', async () => {
  const { app } = controlledCleanupApp();
  app.process = () => ({ exitCode: null, signalCode: 'SIGKILL' });
  const owner = createCleanupOwner(app);
  const page = owner.page;
  owner.launch = vi.fn();
  await expect(owner.launchAfterCrash({})).rejects.toThrow('no longer owned');
  await expect(owner.launchAfterCrash(app)).rejects.toThrow('was not prepared');
  const failure = new Error('controlled crash trace failure');
  app.context = () => ({ tracing: { stop: () => Promise.reject(failure) } });
  await expect(owner.prepareForNativeShutdown()).rejects.toBe(failure);
  await expect(owner.launchAfterCrash(app)).rejects.toBe(failure);
  expect(owner.electronApp).toBe(app);
  expect(owner.page).toBe(page);
  expect(owner.launch).not.toHaveBeenCalled();
  expect(app.evaluate).not.toHaveBeenCalled();
  expect(app.close).not.toHaveBeenCalled();
});


it('preserves a replacement owner while the crashed app trace export settles', async () => {
  const { app, release } = controlledCleanupApp();
  app.process = () => ({ exitCode: null, signalCode: 'SIGKILL' });
  const owner = createCleanupOwner(app);
  owner.launch = vi.fn();
  const exporting = owner.prepareForNativeShutdown();
  const reopening = owner.launchAfterCrash(app);
  const rejected = expect(reopening).rejects.toThrow('ownership changed');
  const replacement = {}, replacementPage = {};
  owner.electronApp = replacement;
  owner.page = replacementPage;
  release();
  await exporting;
  await rejected;
  expect(owner.electronApp).toBe(replacement);
  expect(owner.page).toBe(replacementPage);
  expect(owner.launch).not.toHaveBeenCalled();
  expect(app.evaluate).not.toHaveBeenCalled();
  expect(app.close).not.toHaveBeenCalled();
});


it.each(['before', 'during'])('preserves teardown ownership acquired %s crash trace completion', async when => {
  const { app, release } = controlledCleanupApp();
  app.process = () => ({ exitCode: null, signalCode: 'SIGKILL' });
  const owner = createCleanupOwner(app);
  owner.launch = vi.fn();
  const exporting = owner.prepareForNativeShutdown();
  if (when === 'before') owner.appClosePromises.set(app, Promise.resolve());
  const reopening = owner.launchAfterCrash(app);
  const rejected = expect(reopening).rejects.toThrow(when === 'before' ? 'cleanup already started' : 'ownership changed');
  if (when === 'during') owner.appClosePromises.set(app, Promise.resolve());
  release();
  await exporting;
  await rejected;
  expect(owner.electronApp).toBe(app);
  expect(owner.launch).not.toHaveBeenCalled();
  expect(app.evaluate).not.toHaveBeenCalled();
  expect(app.close).not.toHaveBeenCalled();
});


it('allows at most one concurrent crash reopen after the same trace export', async () => {
  const { app, release } = controlledCleanupApp();
  app.process = () => ({ exitCode: null, signalCode: 'SIGKILL' });
  const owner = createCleanupOwner(app);
  const exporting = owner.prepareForNativeShutdown();
  const replacement = {}, replacementPage = {};
  owner.launch = vi.fn(async () => { owner.electronApp = replacement; owner.page = replacementPage; });
  const outcomes = Promise.allSettled([owner.launchAfterCrash(app), owner.launchAfterCrash(app)]);
  release();
  await exporting;
  const results = await outcomes;
  expect(results.filter(result => result.status === 'fulfilled')).toEqual([{ status: 'fulfilled', value: replacementPage }]);
  expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
  expect(owner.launch).toHaveBeenCalledTimes(1);
  expect(owner.electronApp).toBe(replacement);
  expect(owner.page).toBe(replacementPage);
  expect(app.evaluate).not.toHaveBeenCalled();
  expect(app.close).not.toHaveBeenCalled();
});