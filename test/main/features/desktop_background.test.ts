import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { createDesktopWindowController } from '../../../src/main/features/desktop_windows';

function fixture(canHide = true) {
  const send = vi.fn(), hide = vi.fn(), show = vi.fn(), quit = vi.fn(), write = vi.fn(), read = vi.fn(() => ({ enabled: false, choiceMade: false }));
  const win: any = Object.assign(new EventEmitter(), { isDestroyed: () => false, isFocusable: () => false, hide, show, focus: vi.fn(),
    webContents: Object.assign(new EventEmitter(), { isDestroyed: () => false, send }) });
  let quitting = false, prepared = false;
  const owner = createDesktopWindowController({ canHide: () => canHide, isShutdownComplete: () => prepared,
    read, write, risk: vi.fn(async () => ({ running: true, automation: true, driver: true })), getUser: () => 'fixture', quit, failed: vi.fn() } as any);
  owner.install(win, () => quitting);
  const close = () => { const event = { preventDefault: vi.fn() }; win.emit('close', event); return event; };
  return { owner, win, close, send, hide, show, quit, read, write, prepare: () => { prepared = true; }, exit: () => { quitting = true; } };
}

describe('closing a window always keeps background work alive', () => {
  it('first and repeated closes hide immediately without reading preferences, inspecting work, prompting or quitting', () => {
    const h = fixture();
    for (let i = 0; i < 2; i++) expect(h.close().preventDefault).toHaveBeenCalledOnce();
    expect(h.hide).toHaveBeenCalledTimes(2);
    expect(h.read).not.toHaveBeenCalled(); expect(h.write).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled(); expect(h.quit).not.toHaveBeenCalled(); expect(h.show).not.toHaveBeenCalled();
  });
  it.each(['prepare', 'exit'] as const)('allows windows to be destroyed during %s without hiding again', phase => {
    const h = fixture(); h[phase]();
    expect(h.close().preventDefault).not.toHaveBeenCalled();
    expect(h.hide).not.toHaveBeenCalled(); expect(h.send).not.toHaveBeenCalled();
  });
  it('keeps an existing Windows window recoverable if its tray failed without presenting a warning', () => {
    const h = fixture(false); expect(h.close().preventDefault).toHaveBeenCalledOnce();
    expect(h.hide).not.toHaveBeenCalled(); expect(h.quit).not.toHaveBeenCalled(); expect(h.send).not.toHaveBeenCalled();
  });
  it('restricts startup settings to the live main window and releases ownership on destruction', () => {
    const h = fixture(); expect(h.owner.owns(h.win.webContents)).toBe(true); expect(h.owner.owns({} as any)).toBe(false);
    h.win.emit('closed'); expect(h.owner.owns(h.win.webContents)).toBe(false);
  });
  it('keeps Windows recovery available across tray loss and restoration without starting shutdown', () => {
    let trayAvailable = false;
    const h = fixture();
    const controller = createDesktopWindowController({ canHide: () => trayAvailable, isShutdownComplete: () => false });
    h.win.removeAllListeners('close'); controller.install(h.win);
    for (const available of [false, true, false, true]) {
      trayAvailable = available; h.hide.mockClear();
      expect(h.close().preventDefault).toHaveBeenCalledOnce();
      expect(h.hide).toHaveBeenCalledTimes(available ? 1 : 0);
    }
    expect(h.quit).not.toHaveBeenCalled(); expect(h.send).not.toHaveBeenCalled();
  });
});

// Hidden E2E cannot surface native windows; exercise the shipped restoration
// function with a focusable window here to cover the normal user presentation.
it.each([
  { minimized: true, visible: false },
  { minimized: false, visible: false },
  { minimized: false, visible: true },
])('the shipped Open action preserves the existing window for %j', async ({ minimized, visible }) => {
  const fs = await import('node:fs'), path = await import('node:path'), ts = await import('typescript'), vm = await import('node:vm');
  const source = fs.readFileSync(path.resolve('src/main/index.ts'), 'utf8');
  const tree = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
  const fn = tree.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'showMainWindow');
  expect(fn).toBeDefined();
  const win = { isDestroyed: () => false, isFocusable: () => true, isMinimized: () => minimized, isVisible: () => visible,
    restore: vi.fn(), show: vi.fn(), focus: vi.fn() };
  const createWindow = vi.fn(), target = { exports: undefined as any };
  vm.runInNewContext(ts.transpileModule(`${fn!.getText(tree)};module.exports=showMainWindow;`, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
    { module: target, mainWindows: new Set([win]), createWindow });
  expect(target.exports()).toBe(win); expect(createWindow).not.toHaveBeenCalled();
  expect(win.restore).toHaveBeenCalledTimes(minimized ? 1 : 0); expect(win.show).toHaveBeenCalledTimes(visible ? 0 : 1); expect(win.focus).toHaveBeenCalledOnce();
  win.isFocusable = () => false; win.restore.mockClear(); win.show.mockClear(); win.focus.mockClear();
  expect(target.exports()).toBe(win); expect(win.restore).not.toHaveBeenCalled(); expect(win.show).not.toHaveBeenCalled(); expect(win.focus).not.toHaveBeenCalled();
  // A stale destroyed entry must never prevent recovery through a new window.
  const replacement = { ...win, isFocusable: () => true, restore: vi.fn(), show: vi.fn(), focus: vi.fn() };
  win.isDestroyed = () => true; createWindow.mockReturnValue(replacement);
  expect(target.exports()).toBe(replacement); expect(createWindow).toHaveBeenCalledOnce();
  expect(replacement.focus).toHaveBeenCalledOnce();
});

// Linux has no supported tray: the existing native-close owner must retain
// its close/active-work confirmation while desktop IPC ownership still works.
it('leaves Linux native closes to the existing owner without hiding or losing IPC identity', () => {
  const h = fixture(); h.win.removeAllListeners('close');
  const owner = createDesktopWindowController({ canHide: () => false, nativeClose: () => true, isShutdownComplete: () => false });
  owner.install(h.win);
  expect(owner.owns(h.win.webContents)).toBe(true);
  expect(h.close().preventDefault).not.toHaveBeenCalled();
  expect(h.hide).not.toHaveBeenCalled(); expect(h.quit).not.toHaveBeenCalled();
});

it.each(['linux', 'darwin', 'win32'] as const)('the shipped %s wiring preserves its actual close owner', async platform => {
  const fs = await import('node:fs'), ts = await import('typescript'), vm = await import('node:vm');
  const source = fs.readFileSync('src/main/index.ts', 'utf8');
  const tree = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
  let initializer: any;
  function visit(node: any) {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'desktopWindows') initializer = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(tree); expect(initializer).toBeDefined();
  const target = { exports: undefined as any };
  vm.runInNewContext(ts.transpileModule('module.exports = ' + initializer.getText(tree), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText,
    { module: target, createDesktopWindowController, shutdown: { complete: false }, process: { platform }, appTray: null });
  const h = fixture(); h.win.removeAllListeners('close'); target.exports.install(h.win);
  expect(target.exports.owns(h.win.webContents)).toBe(true);
  const event = h.close();
  expect(event.preventDefault).toHaveBeenCalledTimes(platform === 'linux' ? 0 : 1);
  expect(h.hide).toHaveBeenCalledTimes(platform === 'darwin' ? 1 : 0);
});
