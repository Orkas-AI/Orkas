import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import { closeElectronFixture, requestElectronQuit } from '../e2e/fixtures/electron-cleanup';

it('defers graceful quit outside evaluation and waits for the real close event', async () => {
  const app = new EventEmitter() as any;
  app.windows = () => [{}];
  let evaluating = false;
  let requested = false;
  let finished = false;
  app.evaluate = async (callback: any) => {
    evaluating = true;
    callback({ app: { quit: () => { expect(evaluating).toBe(false); requested = true; } } });
    expect(requested).toBe(false);
    evaluating = false;
  };
  const completion = requestElectronQuit(app).then(() => { finished = true; });
  await new Promise(resolve => setImmediate(resolve));
  expect(requested).toBe(true);
  expect(finished).toBe(false);
  app.emit('close');
  await completion;
  expect(app.listenerCount('close')).toBe(0);
});

it('preserves quit request errors and removes the close observer', async () => {
  const app = new EventEmitter() as any;
  app.windows = () => [{}];
  app.evaluate = async () => { throw new Error('inspector unavailable'); };
  await expect(requestElectronQuit(app)).rejects.toThrow('inspector unavailable');
  expect(app.listenerCount('close')).toBe(0);
});

it('waits for real close when quitting destroys the inspector before the close event', async () => {
  const app = new EventEmitter() as any;
  app.windows = () => [{}];
  app.evaluate = async () => { throw new Error('electronApplication.evaluate: Execution context was destroyed, most likely because of a navigation.'); };
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
  app.evaluate = vi.fn();
  const completion = requestElectronQuit(app);
  expect(app.evaluate).not.toHaveBeenCalled();
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
    member.name && ['closeCurrentApp', 'appClosePromises'].includes(member.name.getText(file)));
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
  app.windows = () => [{}];
  app.process = () => ({ exitCode: 0, signalCode: null });
  const stop = vi.fn(() => tracingGate);
  app.context = () => ({ tracing: { stop } });
  app.evaluate = vi.fn(async (callback: any) => {
    if (closeError) throw closeError;
    callback({ app: { quit: () => app.emit('close') } });
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
