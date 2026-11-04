import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import * as ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { createLoginStartup, shouldHideStartupWindow } from '../../../src/main/features/login_startup';

/** Execute the shipped boot composition, rather than duplicating its adapter or gates. */
function boot(options: { platform?: string; packaged?: boolean; smoke?: boolean; e2e?: boolean;
  background?: boolean; atLogin?: boolean; argv?: string[]; tray?: boolean; failRead?: boolean } = {}) {
  const source = fs.readFileSync(path.resolve('src/main/index.ts'), 'utf8');
  const tree = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
  let block = '';
  function visit(node: ts.Node) {
    if (ts.isBlock(node)) {
      const start = node.statements.findIndex(statement => ts.isVariableStatement(statement)
        && statement.declarationList.declarations.some(declaration => declaration.name.getText(tree) === 'startupAvailable'));
      if (start >= 0) {
        const end = node.statements.findIndex((statement, index) => index > start && ts.isIfStatement(statement)
          && statement.expression.getText(tree) === "process.platform === 'darwin' && appTray");
        if (end < 0) throw new Error('Startup composition boundary missing');
        block = node.statements.slice(start, end).filter(statement => {
          // Independent public lifecycle/callback wiring is verified by its own suites.
          const text = statement.getText(tree);
          return !text.includes('openLifecycleTracking') && !text.includes("'will-quit'") && !text.includes('consumeColdLaunchConnectorCallback');
        }).map(statement => statement.getText(tree)).join('\n');
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(tree); expect(block).not.toBe('');
  let native = { openAtLogin: false, executableWillLaunchAtLogin: false, status: 'not-registered', wasOpenedAtLogin: options.atLogin ?? false };
  const get = vi.fn(() => { if (options.failRead) throw new Error('OS read failed'); return native; });
  const set = vi.fn(settings => { native = { ...native, openAtLogin: settings.openAtLogin,
    executableWillLaunchAtLogin: settings.enabled ?? settings.openAtLogin, status: settings.openAtLogin ? 'enabled' : 'not-registered' }; });
  const install = vi.fn(); const createWindow = vi.fn(); const showMainWindow = vi.fn(); const warn = vi.fn();
  const tasks = vi.fn(async (_uid: string) => [{ enabled: false }, { enabled: true }]);
  const background = vi.fn(() => ({ enabled: options.background ?? true }));
  const executable = 'C:\\Program Files\\Orkas\\Orkas.exe';
  const sandbox = { app: { isPackaged: options.packaged ?? true, getLoginItemSettings: get, setLoginItemSettings: set },
    process: { platform: options.platform ?? 'win32', execPath: executable, argv: options.argv ?? [] },
    IS_PACKAGED_LAUNCH_SMOKE: options.smoke ?? false, E2E_HIDE_WINDOW: options.e2e ?? false,
    createLoginStartup, shouldHideStartupWindow, setLoginStartup: install,
    users: { getActiveUserId: () => 'actual-account' }, autoTasks: { listTasks: tasks },
    readDesktopPreferences: background, createWindow, createAppTray: vi.fn(), appTray: options.tray ?? true,
    showMainWindow, log: { warn } };
  vm.runInNewContext(ts.transpileModule(block, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, sandbox);
  return { service: install.mock.calls[0][0] as ReturnType<typeof createLoginStartup>, get, set, createWindow,
    showMainWindow, warn, executable, background, tasks };
}

describe('shipped startup boot and native adapter composition', () => {
  it.each([{ packaged: false }, { smoke: true }, { e2e: true }])('never accesses or registers host startup for an isolated runtime %j', options => {
    const h = boot(options);
    expect(h.service.read()).toEqual({ enabled: false, available: false, status: 'unavailable' });
    expect(() => h.service.setEnabled(true)).toThrow('E_STARTUP_UNAVAILABLE');
    expect(h.get).not.toHaveBeenCalled(); expect(h.set).not.toHaveBeenCalled(); expect(h.createWindow).toHaveBeenCalledWith(false);
  });
  it('passes the installed Windows executable, startup argument and approval flag to the actual Electron boundary only on consent', () => {
    const h = boot(); expect(h.set).not.toHaveBeenCalled();
    expect(h.service.setEnabled(true).enabled).toBe(true);
    expect(h.set).toHaveBeenLastCalledWith({ path: h.executable, args: ['--orkas-startup'], openAtLogin: true, enabled: true });
    expect(h.get).toHaveBeenLastCalledWith({ path: `"${h.executable}"`, args: ['--orkas-startup'] });
    expect(h.service.setEnabled(false).enabled).toBe(false);
    expect(h.set).toHaveBeenLastCalledWith({ path: h.executable, args: ['--orkas-startup'], openAtLogin: false, enabled: false });
  });
  it('uses the macOS application service without Windows arguments or obsolete openAsHidden', () => {
    const h = boot({ platform: 'darwin' }); expect(h.set).not.toHaveBeenCalled();
    expect(h.service.setEnabled(true).enabled).toBe(true);
    expect(h.set).toHaveBeenCalledWith({ openAtLogin: true }); expect(h.get).toHaveBeenLastCalledWith(undefined);
  });
  it.each([
    { platform: 'darwin', atLogin: true, background: true, hidden: true },
    { platform: 'darwin', atLogin: true, background: false, hidden: true },
    { platform: 'darwin', atLogin: false, background: true, hidden: false },
    { platform: 'win32', argv: ['--orkas-startup'], background: true, hidden: true },
    { platform: 'win32', argv: ['--orkas-startup'], background: false, hidden: true },
    { platform: 'win32', argv: [], background: true, hidden: false },
  ])('system startup is hidden regardless of the retired background choice %j', options => {
    const h = boot(options); expect(h.createWindow).toHaveBeenCalledExactlyOnceWith(options.hidden);
    expect(h.set).not.toHaveBeenCalled(); expect(h.showMainWindow).not.toHaveBeenCalled(); expect(h.background).not.toHaveBeenCalled();
  });
  it('retains window recovery when Windows tray initialization fails', () => {
    const h = boot({ platform: 'win32', argv: ['--orkas-startup'], tray: false });
    expect(h.createWindow).toHaveBeenCalledWith(true); expect(h.showMainWindow).toHaveBeenCalledOnce();
    expect(h.set).not.toHaveBeenCalled();
  });
  it('shows the window on a macOS launch-context read failure without granting startup consent', () => {
    const h = boot({ platform: 'darwin', failRead: true });
    expect(h.createWindow).toHaveBeenCalledWith(false); expect(h.warn).toHaveBeenCalledOnce();
    expect(h.set).not.toHaveBeenCalled(); expect(() => h.service.read()).toThrow('E_STARTUP_READ');
  });
});
