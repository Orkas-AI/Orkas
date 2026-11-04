import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import * as ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

/** Execute the shipped IPC handlers while controlling device I/O and sender ownership. */
function fixture() {
  const source = fs.readFileSync(path.resolve('src/main/ipc/index.ts'), 'utf8');
  const tree = ts.createSourceFile('ipc.ts', source, ts.ScriptTarget.Latest, true);
  const properties: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && ts.isStringLiteral(node.name) && node.name.text.startsWith('desktop.')) properties.push(node.getText(tree));
    ts.forEachChild(node, visit);
  };
  visit(tree);
  const owner = {};
  let prefs = { enabled: true, choiceMade: false };
  const write = vi.fn(next => { prefs = next; return next; });
  const cancel = vi.fn();
  const resolve = vi.fn(async () => ({ ok: true }));
  const startup = { read: vi.fn(() => ({ enabled: false, available: true, status: 'disabled' })),
    setEnabled: vi.fn(enabled => ({ enabled })), claimPrompt: vi.fn(async () => 'claim'),
    markPromptShown: vi.fn(() => true), releasePrompt: vi.fn() };
  const sandbox: any = {
    module: { exports: {} },
    readDesktopPreferences: () => prefs, writeDesktopPreferences: write,
    getDesktopWindowController: () => ({ owns: sender => sender === owner, cancel, resolve }),
    getLoginStartup: () => startup, startupOperation: async run => run(),
  };
  vm.runInNewContext(ts.transpileModule(`module.exports = {${properties.join(',')}};`, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, sandbox);
  return { handlers: sandbox.module.exports, owner, write, cancel, resolve, startup, prefs: () => prefs };
}
describe('device-local settings IPC authority', () => {
  it('rejects startup control from auxiliary windows and never coerces consent values', async () => {
    const h = fixture();
    for (const name of ['getStartup', 'setStartup', 'claimStartupPrompt', 'markStartupPromptShown', 'releaseStartupPrompt', 'openStartupSettings']) {
      expect(await h.handlers[`desktop.${name}`]({ enabled: true }, { sender: {} })).toMatchObject({ ok: false, code: 'E_IPC_SENDER' });
    }
    for (const enabled of ['true', 1, null, {}, undefined]) {
      expect(await h.handlers['desktop.setStartup']({ enabled }, { sender: h.owner })).toMatchObject({ ok: false, code: 'E_STARTUP_INPUT' });
    }
    expect(h.startup.setEnabled).not.toHaveBeenCalled();
    await h.handlers['desktop.setStartup']({ enabled: true, userId: 'forged' }, { sender: h.owner, userId: 'real' });
    expect(h.startup.setEnabled).toHaveBeenCalledWith(true);
    expect(h.write).not.toHaveBeenCalled();
    await h.handlers['desktop.claimStartupPrompt']({ userId: 'forged' }, { sender: { ...h.owner }, userId: 'real' });
    expect(h.startup.claimPrompt).not.toHaveBeenCalled();
  });
  it('removes obsolete background preference and close-decision channels entirely', () => {
    const h = fixture();
    for (const name of ['getPreferences', 'setBackground', 'resolveClose']) expect(h.handlers[`desktop.${name}`]).toBeUndefined();
  });
});
