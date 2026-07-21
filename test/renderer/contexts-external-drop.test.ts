import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

type Listener = (event: any) => any;

function fakeClassList() {
  const values = new Set<string>();
  return {
    add: (...names: string[]) => names.forEach((name) => values.add(name)),
    remove: (...names: string[]) => names.forEach((name) => values.delete(name)),
    contains: (name: string) => values.has(name),
    toggle: (name: string, force?: boolean) => {
      const shouldAdd = force == null ? !values.has(name) : force;
      if (shouldAdd) values.add(name);
      else values.delete(name);
      return shouldAdd;
    },
  };
}

function loadContextsScript() {
  const source = fs.readFileSync(
    path.join(__dirname, '../../src/renderer/modules/contexts.js'),
    'utf8',
  );
  const context: any = {
    AbortController,
    TextDecoder,
    clearTimeout,
    performance,
    setTimeout,
    createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
    escapeHtml: (value: unknown) => String(value ?? ''),
    t: (key: string, vars?: Record<string, unknown>) => `${key}:${JSON.stringify(vars || {})}`,
    window: {
      addEventListener: vi.fn(),
    },
    document: {
      addEventListener: vi.fn(),
      body: {},
      getElementById: vi.fn(() => null),
      querySelector: vi.fn(() => null),
      querySelectorAll: vi.fn(() => []),
    },
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'contexts.js' });
  return context;
}

function makeTree({ folderPath }: { folderPath?: string } = {}) {
  const rootListeners: Record<string, Listener> = {};
  const nodeListeners: Record<string, Listener> = {};
  const wrapListeners: Record<string, Listener> = {};
  const node = {
    addEventListener: (name: string, listener: Listener) => { nodeListeners[name] = listener; },
    classList: fakeClassList(),
  };
  const wrap = folderPath ? {
    addEventListener: (name: string, listener: Listener) => { wrapListeners[name] = listener; },
    classList: fakeClassList(),
    dataset: { path: folderPath, type: 'dir' },
    querySelector: () => node,
  } : null;
  const root = {
    addEventListener: (name: string, listener: Listener) => { rootListeners[name] = listener; },
    classList: fakeClassList(),
    dataset: {} as Record<string, string>,
    innerHTML: '',
    querySelectorAll: (selector: string) => {
      if (selector === '.ctx-tree-wrap') return wrap ? [wrap] : [];
      return [];
    },
  };
  return { root, rootListeners, node, nodeListeners, wrapListeners };
}

function makeDropSurface() {
  const listeners: Record<string, Listener> = {};
  const surface = {
    addEventListener: (name: string, listener: Listener) => { listeners[name] = listener; },
    classList: fakeClassList(),
    contains: () => false,
    dataset: {} as Record<string, string>,
  };
  return { listeners, surface };
}

function dropEvent(dataTransfer: any, closestEntry: any = null) {
  return {
    dataTransfer,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    target: { closest: () => closestEntry },
  };
}

describe('Library external file drag-and-drop', () => {
  it('keeps files usable and exposes storage-full recovery guidance when KB startup fails', () => {
    const context = loadContextsScript();

    expect(context._applyKbStatusResult({ ok: false, code: 'E_STORAGE_FULL' })).toBe(false);
    expect(context._kbUnavailableHtml()).toContain('contexts.kb.storage_full');
    expect(context._kbUnavailableHtml()).toContain('data-kb-status-retry');
    expect(context._applyKbStatusResult({ ok: true, files: [] })).toBe(true);
    expect(context._kbUnavailableHtml()).toBe('');
  });

  it('uploads operating-system files into the hovered folder with copy semantics', async () => {
    const context = loadContextsScript();
    const tree = makeTree({ folderPath: 'Research/Notes' });
    const file = { name: 'brief.md', size: 12, arrayBuffer: vi.fn() };
    const dataTransfer = { types: ['Files'], files: [file], getData: () => '' };
    context.handleCtxUpload = vi.fn(async () => undefined);

    context._bindCtxTreeHandlers(tree.root);
    const hover = dropEvent(dataTransfer);
    tree.nodeListeners.dragover(hover);
    expect(hover.preventDefault).toHaveBeenCalledOnce();
    expect(hover.stopPropagation).toHaveBeenCalledOnce();
    expect(dataTransfer.dropEffect).toBe('copy');
    expect(tree.node.classList.contains('is-drag-over')).toBe(true);

    const drop = dropEvent(dataTransfer);
    await tree.nodeListeners.drop(drop);
    expect(context.handleCtxUpload).toHaveBeenCalledWith([file], 'Research/Notes');
    expect(drop.preventDefault).toHaveBeenCalledOnce();
    expect(tree.node.classList.contains('is-drag-over')).toBe(false);
  });

  it('keeps internal Library drags on the existing move path', async () => {
    const context = loadContextsScript();
    const tree = makeTree({ folderPath: 'Archive' });
    const dataTransfer = {
      types: ['application/x-context-path'],
      files: [],
      getData: () => 'draft.md',
    };
    context._handleCtxMove = vi.fn(async () => undefined);
    context.handleCtxUpload = vi.fn(async () => undefined);

    context._bindCtxTreeHandlers(tree.root);
    const hover = dropEvent(dataTransfer);
    tree.nodeListeners.dragover(hover);
    expect(dataTransfer.dropEffect).toBe('move');

    await tree.nodeListeners.drop(dropEvent(dataTransfer));
    expect(context._handleCtxMove).toHaveBeenCalledWith('draft.md', 'Archive');
    expect(context.handleCtxUpload).not.toHaveBeenCalled();
  });

  it('accepts external files at the root when the Library is empty', async () => {
    const context = loadContextsScript();
    const tree = makeTree();
    const file = { name: 'root.txt', size: 4, arrayBuffer: vi.fn() };
    const dataTransfer = { types: ['Files'], files: [file], getData: () => '' };
    context.handleCtxUpload = vi.fn(async () => undefined);
    context.document.getElementById = (id: string) => (id === 'contexts-tree' ? tree.root : null);

    context.renderCtxTree();
    expect(tree.rootListeners.drop).toBeTypeOf('function');
    const hover = dropEvent(dataTransfer);
    tree.rootListeners.dragover(hover);
    expect(dataTransfer.dropEffect).toBe('copy');
    expect(tree.root.classList.contains('is-root-drag-over')).toBe(true);

    await tree.rootListeners.drop(dropEvent(dataTransfer));
    expect(context.handleCtxUpload).toHaveBeenCalledWith([file], '');
    expect(tree.root.classList.contains('is-root-drag-over')).toBe(false);
  });

  it('accepts a drop on first-level folder wrapper space', async () => {
    const context = loadContextsScript();
    const tree = makeTree({ folderPath: 'Research' });
    const folderWrap = { dataset: { path: 'Research', type: 'dir' } };
    const file = { name: 'notes.md', size: 4, arrayBuffer: vi.fn() };
    const dataTransfer = { types: ['Files'], files: [file], getData: () => '' };
    context.handleCtxUpload = vi.fn(async () => undefined);

    context._bindCtxTreeHandlers(tree.root);
    const hover = dropEvent(dataTransfer, folderWrap);
    tree.rootListeners.dragover(hover);
    expect(hover.preventDefault).toHaveBeenCalledOnce();
    expect(dataTransfer.dropEffect).toBe('copy');

    await tree.rootListeners.drop(dropEvent(dataTransfer, folderWrap));
    expect(context.handleCtxUpload).toHaveBeenCalledWith([file], 'Research');
  });

  it('uses the root when an external file is dropped over an existing first-level file', async () => {
    const context = loadContextsScript();
    const tree = makeTree();
    const existingFileWrap = { dataset: { path: 'existing.md', type: 'file' } };
    const file = { name: 'new.md', size: 4, arrayBuffer: vi.fn() };
    const dataTransfer = { types: ['Files'], files: [file], getData: () => '' };
    context.handleCtxUpload = vi.fn(async () => undefined);

    context._bindCtxTreeHandlers(tree.root);
    await tree.rootListeners.drop(dropEvent(dataTransfer, existingFileWrap));

    expect(context.handleCtxUpload).toHaveBeenCalledWith([file], '');
  });

  it('adds detail-pane drops beside the currently open nested file', async () => {
    const context = loadContextsScript();
    const detail = makeDropSurface();
    const file = { name: 'new-reference.pdf', size: 40, arrayBuffer: vi.fn() };
    const dataTransfer = { types: ['Files'], files: [file], getData: () => '' };
    context.handleCtxUpload = vi.fn(async () => undefined);
    context._bindCtxDetailDrop(detail.surface, () => context._ctxParentDir('Research/Notes/current.md'));

    const hover = dropEvent(dataTransfer);
    detail.listeners.dragover(hover);
    expect(hover.preventDefault).toHaveBeenCalledOnce();
    expect(hover.stopPropagation).toHaveBeenCalledOnce();
    expect(dataTransfer.dropEffect).toBe('copy');
    expect(detail.surface.classList.contains('is-external-drag-over')).toBe(true);

    const drop = dropEvent(dataTransfer);
    await detail.listeners.drop(drop);
    expect(context.handleCtxUpload).toHaveBeenCalledWith([file], 'Research/Notes');
    expect(detail.surface.classList.contains('is-external-drag-over')).toBe(false);
  });

  it('resolves a root-level open file to the Library root and ignores internal moves', async () => {
    const context = loadContextsScript();
    const detail = makeDropSurface();
    const file = { name: 'new.md', size: 4, arrayBuffer: vi.fn() };
    const external = { types: ['Files'], files: [file], getData: () => '' };
    const internal = {
      types: ['application/x-context-path'],
      files: [],
      getData: () => 'existing.md',
    };
    context.handleCtxUpload = vi.fn(async () => undefined);
    context._bindCtxDetailDrop(detail.surface, () => context._ctxParentDir('current.md'));

    const internalHover = dropEvent(internal);
    detail.listeners.dragover(internalHover);
    expect(internalHover.preventDefault).not.toHaveBeenCalled();

    await detail.listeners.drop(dropEvent(external));
    expect(context.handleCtxUpload).toHaveBeenCalledWith([file], '');
  });

  it('surfaces the existing unsupported-format prompt for external drops', async () => {
    const context = loadContextsScript();
    const unsupported = { name: 'archive.zip', size: 20, arrayBuffer: vi.fn() };
    const zh = JSON.parse(fs.readFileSync(
      path.join(__dirname, '../../src/renderer/locales/zh.json'),
      'utf8',
    ));
    context.loadContexts = vi.fn(async () => undefined);
    context.uiAlert = vi.fn(async () => undefined);

    await context.handleCtxUpload([unsupported], 'Research');

    expect(unsupported.arrayBuffer).not.toHaveBeenCalled();
    expect(context.uiAlert).toHaveBeenCalledOnce();
    expect(context.uiAlert.mock.calls[0][0]).toContain('contexts.upload_rejected');
    expect(context.uiAlert.mock.calls[0][0]).toContain('archive.zip');
    expect(context.uiAlert.mock.calls[0][0]).not.toContain('.markdown');
    expect(zh['contexts.upload_rejected']).toBe('这些文件暂不支持，未添加到资料库：\n{list}');
  });

  it('bounds and completes a large multi-file upload action', async () => {
    const context = loadContextsScript();
    context.uiAlert = vi.fn(async () => undefined);
    context.apiFetch = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
    context.loadContexts = vi.fn(async () => undefined);
    const files = Array.from({ length: 200 }, (_, index) => ({
      name: `doc-${index}.md`,
      size: 10,
      arrayBuffer: vi.fn(async () => new ArrayBuffer(10)),
    }));

    await context.handleCtxUpload(files, 'Bulk');

    expect(context.apiFetch).toHaveBeenCalledTimes(200);
    expect(context.uiAlert).not.toHaveBeenCalled();
  });

  it('shows only the existing directory for a duplicate upload', async () => {
    const context = loadContextsScript();
    const file = {
      name: 'very-long-content-shaped-filename.md',
      size: 20,
      arrayBuffer: vi.fn(async () => new ArrayBuffer(20)),
    };
    const zh = JSON.parse(fs.readFileSync(
      path.join(__dirname, '../../src/renderer/locales/zh.json'),
      'utf8',
    ));
    context.apiFetch = vi.fn(async () => ({
      json: async () => ({
        ok: false,
        error: 'backend duplicate detail that must stay hidden',
        code: 'duplicate_content',
        existingDir: 'Research/Notes',
      }),
    }));
    context.loadContexts = vi.fn(async () => undefined);
    context.uiAlert = vi.fn(async () => undefined);

    await context.handleCtxUpload([file], 'Incoming');

    expect(context.uiAlert).toHaveBeenCalledOnce();
    const message = context.uiAlert.mock.calls[0][0];
    expect(message).toContain('contexts.upload_duplicate');
    expect(message).toContain('Research/Notes');
    expect(message).not.toContain(file.name);
    expect(message).not.toContain('backend duplicate detail');
    expect(context._ctxLibraryDirectoryLabel('')).toContain('contexts.root_label');
    expect(zh['contexts.upload_duplicate']).toBe('文件已存在\n所在目录：{dirs}');
  });

  it('lists failed filenames without exposing backend details', async () => {
    const context = loadContextsScript();
    const file = {
      name: 'quarterly-plan.md',
      size: 20,
      arrayBuffer: vi.fn(async () => new ArrayBuffer(20)),
    };
    context.apiFetch = vi.fn(async () => ({
      json: async () => ({
        ok: false,
        error: 'EACCES: private backend path must stay hidden',
      }),
    }));
    context.loadContexts = vi.fn(async () => undefined);
    context.uiAlert = vi.fn(async () => undefined);

    await context.handleCtxUpload([file], 'Incoming');

    expect(context.uiAlert).toHaveBeenCalledOnce();
    const message = context.uiAlert.mock.calls[0][0];
    expect(message).toContain('contexts.upload_failed');
    expect(message).toContain(file.name);
    expect(message).not.toContain('EACCES');
    expect(message).not.toContain('private backend path');
  });

  it('confirms deletion with the basename instead of the full Library path', async () => {
    const context = loadContextsScript();
    const zh = JSON.parse(fs.readFileSync(
      path.join(__dirname, '../../src/renderer/locales/zh.json'),
      'utf8',
    ));
    context.uiConfirm = vi.fn(async () => false);
    context.apiFetch = vi.fn();

    await context.deleteCtxEntry('Research/Notes/quarterly-plan.md', 'file');

    expect(context.uiConfirm).toHaveBeenCalledOnce();
    const prompt = context.uiConfirm.mock.calls[0][0];
    expect(prompt).toContain('quarterly-plan.md');
    expect(prompt).not.toContain('Research/Notes');
    expect(context.apiFetch).not.toHaveBeenCalled();
    expect(zh['contexts.file.del_confirm']).toContain('删除后可在回收站恢复');
    expect(zh['contexts.dir.del_confirm']).toContain('删除后可在回收站恢复');
  });
});
