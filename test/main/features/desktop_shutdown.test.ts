import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import * as ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { createDesktopWindowController } from '../../../src/main/features/desktop_windows';

describe('prepared shutdown bypasses background close without changing preferences', () => {
  it.each(['darwin', 'win32'])('closes for the installer only after shutdown preparation completes on %s', async platform => {
    const source = fs.readFileSync(path.resolve('src/main/index.ts'), 'utf8');
    const tree = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
    let composition = '';
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && node.expression.getText(tree) === 'createDesktopWindowController') composition = node.getText(tree);
      ts.forEachChild(node, visit);
    }
    visit(tree); expect(composition).not.toBe('');
    const shutdown = { complete: false };
    const writes = vi.fn(), risk = vi.fn(), hide = vi.fn(), quit = vi.fn();
    const target = { exports: undefined as ReturnType<typeof createDesktopWindowController> | undefined };
    vm.runInNewContext(ts.transpileModule(`module.exports = ${composition}`, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
      module: target, createDesktopWindowController, shutdown, readDesktopPreferences: () => { throw new Error('Retired preference read'); },
      writeDesktopPreferences: writes, readDesktopWorkRisk: risk, users: { getActiveUserId: () => 'fixture' },
      process: { platform }, appTray: {}, app: { quit }, setImmediate: (run: () => void) => run(),
    });
    const owner = target.exports!;
    const win = Object.assign(new EventEmitter(), { isDestroyed: () => false, isFocusable: () => false, hide,
      webContents: Object.assign(new EventEmitter(), { isDestroyed: () => false, send: vi.fn() }) });
    owner.install(win as any, () => false);
    const duringPreparation = { preventDefault: vi.fn() }; win.emit('close', duringPreparation);
    expect(duringPreparation.preventDefault).toHaveBeenCalledOnce(); hide.mockClear();
    shutdown.complete = true;
    const installerClose = { preventDefault: vi.fn() }; win.emit('close', installerClose);
    expect(installerClose.preventDefault, 'native shutdown closes windows before the ordinary before-quit event').not.toHaveBeenCalled();
    expect(hide).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled(); expect(risk).not.toHaveBeenCalled();
  });
});

function quitComposition() {
  const source = fs.readFileSync(path.resolve('src/main/index.ts'), 'utf8');
  const tree = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
  let body = '';
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === 'app.on'
      && node.arguments[0]?.getText(tree) === "'before-quit'" && ts.isArrowFunction(node.arguments[1])
      && node.arguments[1].getText(tree).includes('flushForShutdown')) body = node.arguments[1].getText(tree);
    ts.forEachChild(node, visit);
  }
  visit(tree); expect(body).not.toBe('');
  const shutdown = { complete: false }, app = { quit: vi.fn() }, reveal = vi.fn(), error = vi.fn();
  const flush = vi.fn(async () => { shutdown.complete = true; });
  const sandbox: any = { module: { exports: undefined }, shutdown, app, isQuitting: false,
    flushForShutdown: flush, showMainWindow: reveal,
    log: { error }, logErrorSummary: () => ({ code: 'fixture-failure' }) };
  vm.runInNewContext(ts.transpileModule(`module.exports = ${body}`, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, sandbox);
  return { request: () => { const event = { preventDefault: vi.fn() }; return { event, completion: sandbox.module.exports(event) }; },
    shutdown, app, flush, reveal, error, sandbox };
}

describe('native quit prepares complete shutdown directly', () => {
  it('coalesces repeated quit requests, cleans up once and then allows native window destruction', async () => {
    const h = quitComposition();
    let release!: () => void;
    h.flush.mockImplementationOnce(() => new Promise<void>(resolve => { release = () => { h.shutdown.complete = true; resolve(); }; }));
    const first = h.request(); expect(first.event.preventDefault).toHaveBeenCalledOnce();
    const duplicate = h.request(); await duplicate.completion;
    expect(h.flush).toHaveBeenCalledOnce(); expect(h.app.quit).not.toHaveBeenCalled();
    release(); await first.completion;
    expect(h.app.quit).toHaveBeenCalledOnce();
    const terminal = h.request(); await terminal.completion;
    expect(terminal.event.preventDefault).not.toHaveBeenCalled(); expect(h.flush).toHaveBeenCalledOnce();
  });
  it('restores a recoverable window after cleanup fails and permits an explicit retry', async () => {
    const h = quitComposition(); h.flush.mockRejectedValueOnce(new Error('controlled archive failure'));
    await h.request().completion;
    expect(h.app.quit).not.toHaveBeenCalled(); expect(h.reveal).toHaveBeenCalledOnce(); expect(h.error).toHaveBeenCalledOnce();
    expect(h.sandbox.isQuitting).toBe(false);
    await h.request().completion; expect(h.flush).toHaveBeenCalledTimes(2); expect(h.app.quit).toHaveBeenCalledOnce();
  });
});
