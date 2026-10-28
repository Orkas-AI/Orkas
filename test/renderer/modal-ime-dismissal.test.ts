import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';

const root = join(__dirname, '../../src/renderer/modules');
const specs = [
  ['library-transfer', 'openLibraryTransfer', 'variable'],
  ['conversation', '_openReferenceTargetPicker', 'listener'],
  ['memory', '_memOpenModal', 'variable'],
  ['search', '_bindGlobalSearch', 'listener'],
  ['chat-artifact', '_openViewer', 'assignment:_viewerKeyHandler'],
  ['chat-artifact', '_ensureMenuEl', 'listener'],
  ['saved-apps', '_openAppViewer', 'assignment:_appViewerKeyHandler'],
] as const;
function keyboardHandler(file: string, owner: string, kind: string) {
  const source = ts.createSourceFile(file, readFileSync(join(root, `${file}.js`), 'utf8'), ts.ScriptTarget.Latest, true);
  let parent: ts.FunctionDeclaration | undefined;
  const findOwner = (node: ts.Node) => { if (ts.isFunctionDeclaration(node) && node.name?.text === owner) parent = node; else ts.forEachChild(node, findOwner); };
  findOwner(source); if (!parent) throw new Error(`Missing owner ${owner}`);
  const handlers: ts.Expression[] = [];
  const find = (node: ts.Node) => {
    if (kind.startsWith('assignment:') && ts.isBinaryExpression(node)
      && node.left.getText(source) === kind.slice('assignment:'.length)) handlers.push(node.right);
    if (kind === 'variable' && ts.isVariableDeclaration(node) && node.name.getText(source) === 'onKey' && node.initializer) handlers.push(node.initializer);
    if (kind === 'listener' && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'addEventListener' && node.arguments[0]?.getText(source) === "'keydown'"
      && node.arguments[1] && ts.isArrowFunction(node.arguments[1])) handlers.push(node.arguments[1]);
    ts.forEachChild(node, find);
  };
  find(parent); if (handlers.length !== 1) throw new Error(`Ambiguous key handler ${owner}: ${handlers.length}`);
  const close = vi.fn(), open = vi.fn();
  const context = vm.createContext({ close, _closeReferenceTargetPicker: close, _memCloseModal: close, _closeViewer: close, _closeAppViewer: close, _closeMenu: close,
    _appViewerEl: { classList: { contains: () => true } }, el: { style: { display: '' } }, closeGlobalSearch: close, openGlobalSearch: open,
    document: { removeEventListener: vi.fn(), getElementById: () => ({ style: { display: '' } }), querySelector: () => null } });
  return { close, open, context, run: vm.runInContext(`const onKey = (${handlers[0].getText(source)}); onKey`, context) };
}

describe('modal Escape preserves active IME composition', () => {
  for (const [file, owner, kind] of specs) {
    it.each([{ isComposing: true, keyCode: 27 }, { isComposing: false, keyCode: 229 }])(
      `${file} leaves the modal open while composing (%j)`, fields => {
        const h = keyboardHandler(file, owner, kind);
        h.run({ key: 'Escape', ...fields, preventDefault: vi.fn(), stopPropagation: vi.fn() });
        expect(h.close).not.toHaveBeenCalled();
      },
    );
    it(`${file} retains ordinary Escape dismissal and ignores other keys`, () => {
      const h = keyboardHandler(file, owner, kind);
      h.run({ key: 'a', isComposing: false, keyCode: 65, preventDefault: vi.fn(), stopPropagation: vi.fn() });
      expect(h.close).not.toHaveBeenCalled();
      h.run({ key: 'Escape', isComposing: false, keyCode: 27, preventDefault: vi.fn(), stopPropagation: vi.fn() });
      expect(h.close).toHaveBeenCalledOnce();
    });
  }
});

describe('global search shortcut preserves IME composition', () => {
  it.each([
    { key: 'k', metaKey: true, isComposing: true, keyCode: 75 },
    { key: 'K', ctrlKey: true, isComposing: true, keyCode: 75 },
    { key: 'k', metaKey: true, isComposing: false, keyCode: 229 },
    { key: 'K', ctrlKey: true, isComposing: false, keyCode: 229 },
  ])('does not toggle the search panel for a composing shortcut %j', fields => {
    const h = keyboardHandler('search', '_bindGlobalSearch', 'listener');
    h.run({ ...fields, preventDefault: vi.fn(), stopPropagation: vi.fn() });
    expect(h.close).not.toHaveBeenCalled(); expect(h.open).not.toHaveBeenCalled();
  });
});


function memoryShell() {
  const listeners = new Set<(event: any) => void>();
  let attached: any = null, peak = 0;
  const context: any = {
    window: { addEventListener: vi.fn() }, createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
    document: {
      readyState: 'loading',
      addEventListener(type: string, listener: (event: any) => void) { if (type === 'keydown') { listeners.add(listener); peak = Math.max(peak, listeners.size); } },
      removeEventListener(type: string, listener: (event: any) => void) { if (type === 'keydown') listeners.delete(listener); },
      getElementById: (id: string) => id === 'memory-modal-host' ? attached : null,
      createElement: () => ({ remove() { attached = null; } }),
      body: { appendChild(node: any) { attached = node; } },
    },
  };
  vm.createContext(context); vm.runInContext(readFileSync(join(root, 'memory.js'), 'utf8'), context);
  return { context, listeners, open: () => context._memOpenModal(560, '<p>Fixture</p>'),
    close: () => context._memCloseModal(), peak: () => peak, attached: () => attached };
}

describe('memory modal listener lifetime', () => {
  it('releases the document key handler on ordinary close across repeated use', () => {
    const h = memoryShell();
    for (let index = 0; index < 100; index++) { h.open(); h.close(); }
    expect(h.listeners.size).toBe(0); expect(h.peak()).toBe(1); expect(h.attached()).toBeNull();
  });
  it('replaces the old shell without stacking listeners and supports Escape cleanup', () => {
    const h = memoryShell(); h.open(); const first = h.attached(); h.open();
    expect(h.attached()).not.toBe(first); expect(h.listeners.size).toBe(1);
    for (const run of [...h.listeners]) run({ key: 'Escape', isComposing: false, keyCode: 27 });
    expect(h.attached()).toBeNull(); expect(h.listeners.size).toBe(0);
  });
});
