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
  const monitorError = vi.fn();
  const log = { error: vi.fn(), info: vi.fn(), warn: vi.fn() };
  const context: any = {
    AbortController,
    TextDecoder,
    clearTimeout,
    performance,
    setTimeout,
    createLogger: () => log,
    __log: log,
    escapeHtml: (value: unknown) => String(value ?? ''),
    t: (key: string, vars?: Record<string, unknown>) => `${key}:${JSON.stringify(vars || {})}`,
    window: {
      addEventListener: vi.fn(),
      Monitor: { error: monitorError },
    },
    Monitor: { error: monitorError },
    __monitorError: monitorError,
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
  return { root, rootListeners, node, nodeListeners, wrap, wrapListeners };
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
  it.each(['rename-file', 'rename-dir', 'move'])(
    'keeps save, draft and reveal paths current after %s', async (action) => {
      const context = loadContextsScript();
      vm.runInContext(fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/md-view-edit.js'), 'utf8'), context);
      vm.runInContext('_ctxActive = { id: "notes/draft.md" };', context);
      context._prepCtxViewerShell = () => ({ bodyEl: {}, actionsEl: {} });
      context.loadContexts = vi.fn();
      context.revealCtxFile = vi.fn();
      context.apiFetch = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
      context.window.orkas = { invoke: vi.fn(async () => ({ ok: true })) };
      // Only the editor DOM is replaced. Save uses its real source dispatcher.
      let controller: any;
      let callbacks: any;
      context.mountMdViewEdit = (options: any) => {
        let source = options.source;
        callbacks = options.callbacks;
        controller = {
          getSource: () => source,
          setSource: (next: any) => { source = next; },
          save: (content: string) => context._mveWriteSource(source, content),
        };
        return controller;
      };
      context._showCtxTextViewer('notes/draft.md', 'Original');
      callbacks.onDraftChange({ content: 'Before rename', dirty: true });
      const next = action === 'rename-file' ? 'notes/final.md'
        : action === 'rename-dir' ? 'archive/draft.md' : 'archive/notes/draft.md';
      if (action === 'move') context._applyCtxPathChange('notes', 'archive/notes', 'archive');
      else await context._commitInlineRename(action === 'rename-dir' ? 'notes' : 'notes/draft.md', action === 'rename-dir' ? 'archive' : 'final.md');
      expect(vm.runInContext('_ctxActive.id', context)).toBe(next);
      callbacks.onDraftChange({ content: 'After rename', dirty: false });
      expect([...vm.runInContext('_ctxDrafts.entries()', context)]).toEqual([[next, { content: 'After rename', dirty: false }]]);
      callbacks.onReveal();
      expect(context.revealCtxFile).toHaveBeenCalledWith(next);
      expect(await controller.save('After rename')).toEqual({ ok: true });
      expect(context.apiFetch).toHaveBeenCalledWith('/api/contexts/update', expect.objectContaining({ body: JSON.stringify({ path: next, content: 'After rename' }) }));
      callbacks.onDraftChange(null);
      expect(vm.runInContext('_ctxDrafts.size', context)).toBe(0);
    },
  );

  it('accepts the successful KB status snapshot returned by the IPC handler', () => {
    const context = loadContextsScript();

    expect(context._applyKbStatusResult({ summary: { ready: 0 }, files: [] })).toBe(true);
    expect(context._kbUnavailableHtml()).toBe('');
    expect(context.__monitorError).not.toHaveBeenCalled();
  });

  it('keeps files usable and exposes storage-full recovery guidance when KB startup fails', () => {
    const context = loadContextsScript();

    expect(context._applyKbStatusResult({ ok: false, code: 'E_STORAGE_FULL' })).toBe(false);
    expect(context._kbUnavailableHtml()).toContain('contexts.kb.storage_full');
    expect(context._kbUnavailableHtml()).toContain('data-kb-status-retry');
    expect(context._applyKbStatusResult({ ok: true, files: [] })).toBe(true);
    expect(context._kbUnavailableHtml()).toBe('');
  });

  it.each(['ENOSPC', 'SQLITE_FULL'])('normalizes %s status failures to the storage-full recovery code', (rawCode) => {
    const context = loadContextsScript();

    expect(context._applyKbStatusResult({
      ok: false,
      code: rawCode,
      error: '/Users/test/private/vector.db is full',
    })).toBe(false);

    expect(context._kbUnavailableHtml()).toContain('contexts.kb.storage_full');
  });

  it('does not duplicate a rejected invoke already owned by the IPC diagnostic', () => {
    const context = loadContextsScript();

    expect(context._applyKbStatusResult({ ok: false, error: 'ipc request failed' })).toBe(false);

    expect(context._kbUnavailableHtml()).toContain('contexts.kb.unavailable');
    expect(context.__monitorError).not.toHaveBeenCalled();
  });

  it('renders a native vectorization failure as a generic clickable retry action', async () => {
    const context = loadContextsScript();
    const tree = makeTree({ folderPath: 'Research/windows-native.md' });
    if (!tree.wrap) throw new Error('file row fixture missing');
    tree.wrap.dataset.type = 'file';
    context._applyKbEvent({
      relPath: 'Research/windows-native.md',
      status: 'failed',
      stage: 'embed',
      errorCode: 'E_LIBRARY_NATIVE_ONNX_LOAD',
      error: 'onnxruntime native module failed to load',
    });
    const chip = context._kbStatusChipHtml('Research/windows-native.md');

    expect(chip).toContain('data-kb-reprocess');
    expect(chip).toContain('contexts.kb.failed');
    expect(chip).not.toContain('onnxruntime');
    expect(chip).not.toContain('E_LIBRARY_NATIVE_ONNX_LOAD');

    context._updateCtxKbChip = vi.fn();
    context._scheduleKbStatusRefreshIfNeeded = vi.fn();
    context.apiFetch = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
    context._bindCtxTreeHandlers(tree.root);
    const retryTarget = {};
    const click = {
      stopPropagation: vi.fn(),
      target: {
        closest: (selector: string) => (selector === '[data-kb-reprocess]' ? retryTarget : null),
      },
    };

    await tree.nodeListeners.click(click);

    expect(click.stopPropagation).toHaveBeenCalledOnce();
    expect(context.apiFetch).toHaveBeenCalledWith('/api/kb/reprocess', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: 'Research/windows-native.md' }),
    });
    expect(context._kbStatusChipHtml('Research/windows-native.md')).toContain('is-processing');
  });

  it.each([
    [
      'backend rejection',
      async () => ({
        json: async () => ({ ok: false, error: 'C:\\private\\native\\binding.node' }),
      }),
    ],
    [
      'transport rejection',
      async () => {
        throw new Error('network rejected C:\\private\\native\\binding.node');
      },
    ],
  ])('restores the clickable failed state after %s', async (_label, request) => {
    const context = loadContextsScript();
    context._applyKbEvent({
      relPath: 'windows-native.md',
      status: 'failed',
      errorCode: 'E_LIBRARY_NATIVE_ONNX_LOAD',
    });
    context._updateCtxKbChip = vi.fn();
    context._scheduleKbStatusRefreshIfNeeded = vi.fn();
    context.apiFetch = vi.fn(request);
    context.uiAlert = vi.fn(async () => undefined);

    await context.reprocessCtxKbFile('windows-native.md');

    const chip = context._kbStatusChipHtml('windows-native.md');
    expect(chip).toContain('is-failed');
    expect(chip).toContain('data-kb-reprocess');
    expect(context.uiAlert).toHaveBeenCalledWith('contexts.kb.reprocess_failed:{}');
    expect(context.uiAlert.mock.calls[0][0]).not.toContain('binding.node');
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
    expect(context.__log.warn).toHaveBeenCalledWith('library upload failed', expect.objectContaining({ error_code: 'upload_failed', failed_count: 1 }));
    expect(JSON.stringify(context.__log.warn.mock.calls)).not.toContain('private backend path');
    expect(JSON.stringify(context.__log.info.mock.calls)).not.toContain('Incoming');
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

  it('keeps one successful delete result when the post-mutation refresh fails', async () => {
    const context = loadContextsScript();
    const event = vi.fn();
    const error = vi.fn();
    context.window.Monitor = {};
    context.Monitor = { event, error };
    context.uiConfirm = vi.fn(async () => true);
    context.uiAlert = vi.fn(async () => undefined);
    context.apiFetch = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
    context.loadContexts = vi.fn(async () => { throw new Error('refresh failed'); });

    await context.deleteCtxEntry('Research/private-note.md', 'file');

    expect(context.apiFetch).toHaveBeenCalledOnce();
    expect(context.loadContexts).toHaveBeenCalledOnce();
    expect(event).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(context.uiAlert).not.toHaveBeenCalled();
  });

  it('treats a resolved native IPC rejection as failure instead of cancellation', async () => {
    const context = loadContextsScript();
    const event = vi.fn();
    const error = vi.fn();
    context.window.Monitor = {};
    context.Monitor = { click: vi.fn(), event, error };
    context.window.orkas = {
      invoke: vi.fn(async () => ({ ok: false, code: 'E_IPC_REQUEST', error: 'private backend detail' })),
    };
    context.uiAlert = vi.fn(async () => undefined);
    context.loadContexts = vi.fn(async () => undefined);

    await context.handleCtxNativeUpload('Research');

    expect(context.loadContexts).not.toHaveBeenCalled();
    expect(context.uiAlert).toHaveBeenCalledOnce();
    expect(context.__log.warn).toHaveBeenCalledWith('library upload failed', expect.objectContaining({ error_code: 'E_IPC_REQUEST' }));
    expect(JSON.stringify(context.__log.warn.mock.calls)).not.toContain('private backend detail');
    expect(event).not.toHaveBeenCalled();
  });

  it('keeps explicit native picker cancellation free of error feedback outside the upload success denominator', async () => {
    const context = loadContextsScript();
    const event = vi.fn();
    const error = vi.fn();
    context.window.Monitor = {};
    context.Monitor = { click: vi.fn(), event, error };
    context.window.orkas = {
      invoke: vi.fn(async () => ({ ok: true, cancelled: true, files: [] })),
    };
    context.uiAlert = vi.fn(async () => undefined);
    context.loadContexts = vi.fn(async () => undefined);

    await context.handleCtxNativeUpload('Research');

    expect(context.uiAlert).not.toHaveBeenCalled();
    expect(context.loadContexts).not.toHaveBeenCalled();
  });

  it('keeps a successful upload result when the later tree refresh fails', async () => {
    const context = loadContextsScript();
    const event = vi.fn();
    const error = vi.fn();
    const file = { name: 'stable.md', size: 8 };
    context.window.Monitor = {};
    context.Monitor = { click: vi.fn(), event, error };
    context.window.orkas = {
      importLocalFiles: vi.fn(async () => ({ files: [{ ok: true, name: file.name }] })),
    };
    context.loadContexts = vi.fn(async () => { throw new Error('refresh failed'); });
    context.uiAlert = vi.fn(async () => undefined);

    await context.handleCtxUpload([file], 'Research');

    expect(context.uiAlert).not.toHaveBeenCalled();
  });
});


describe('Library project switching', () => {
  it('keeps the latest selection when an earlier Library load finishes late', async () => {
    const context = loadContextsScript();
    let finishGlobal: (value: any) => void = () => {};
    context.apiFetch = vi.fn(async (url: string) => ({ json: async () => url.endsWith('/tree')
      ? await new Promise((resolve) => { finishGlobal = resolve; }) : { ok: true, files: [] } }));
    context.apiLibraryFetch = vi.fn(async () => ({ json: async () => ({
      ok: true, tree: [{ type: 'file', name: 'project.md', path: 'project.md' }],
      files: [{ path: 'project.md', status: 'ready' }],
    }) }));
    context._ensureKbEventSubscription = vi.fn();
    const pending = context.loadContexts();
    await Promise.resolve();
    await Promise.resolve();
    await context.switchCtxProject('p1');
    finishGlobal({ ok: true, tree: [{ type: 'file', name: 'global.md', path: 'global.md' }] });
    await pending;
    expect(vm.runInContext('_ctxTree.map(file => file.name)', context)).toEqual(['project.md']);
    context._applyKbEvent({ relPath: 'project.md', status: 'failed' });
    expect(vm.runInContext('_kbStatusByPath["project.md"].status', context)).toBe('ready');
  });

  it('isolates same-named drafts and discards late previews across projects', async () => {
    const context = loadContextsScript();
    context.loadContexts = vi.fn();
    context._showCtxTextViewer = vi.fn();
    let finishRead: (value: any) => void = () => {};
    context.apiFetch = vi.fn(async () => ({ json: () => new Promise((resolve) => { finishRead = resolve; }) }));
    vm.runInContext('_ctxDrafts.set("same.md", { content: "Global draft", dirty: false })', context);
    const read = context.openCtxFile('same.md');
    await Promise.resolve();
    await context.switchCtxProject('p1');
    expect(vm.runInContext('_ctxDrafts.size', context)).toBe(0);
    vm.runInContext('_ctxDrafts.set("same.md", { content: "Project draft", dirty: false })', context);
    finishRead({ ok: true, content: 'Global content' });
    await read;
    expect(context._showCtxTextViewer).not.toHaveBeenCalled();
    await context.switchCtxProject('');
    expect(vm.runInContext('_ctxDrafts.get("same.md").content', context)).toBe('Global draft');
    await context.switchCtxProject('p1');
    expect(vm.runInContext('_ctxDrafts.get("same.md").content', context)).toBe('Project draft');
  });

  it('keeps a confirmed deletion in its original scope until it finishes', async () => {
    const context = loadContextsScript();
    context.loadContexts = vi.fn();
    let confirm: (value: boolean) => void = () => {};
    context.uiConfirm = () => new Promise((resolve) => { confirm = resolve; });
    context.apiFetch = vi.fn(async () => ({ json: async () => ({ ok: true }) }));
    const deletion = context.deleteCtxEntry('same.md', 'file');
    expect(await context.switchCtxProject('p1')).toBe(false);
    confirm(true);
    await deletion;
    expect(context.apiFetch).toHaveBeenCalledWith('/api/contexts/delete?path=same.md', { method: 'DELETE' });
    await context.switchCtxProject('p1');
    expect(vm.runInContext('_ctxProjectId', context)).toBe('p1');
  });
});


describe('Library unsaved changes before switching projects', () => {
  function setup(save: boolean, saveResult = true) {
    const context = loadContextsScript();
    context.loadContexts = vi.fn();
    context.uiConfirm = vi.fn(async () => save);
    context.uiAlert = vi.fn();
    context.__controller = {
      isDirty: () => true,
      save: vi.fn(async () => saveResult),
      destroy: vi.fn(),
    };
    vm.runInContext(`
      _ctxActive = { id: 'same.md' };
      _ctxMveController = __controller;
      _ctxDrafts.set('same.md', { content: 'Unsaved text', dirty: true });
    `, context);
    return context;
  }

  // Model only the shared editor's persistence boundary. Use the real Library
  // viewer callbacks, file reopening, and switch orchestration under test.
  function setupMultipleDrafts() {
    const context = loadContextsScript();
    const persisted = new Map<string, string>();
    const failedWrites = new Set<string>();
    context.loadContexts = vi.fn();
    context.uiConfirm = vi.fn(async () => true);
    context.uiAlert = vi.fn();
    context.apiFetch = vi.fn(async () => ({ json: async () => ({ ok: true, content: 'Original' }) }));
    context._prepCtxViewerShell = (rel: string) => {
      context.__rel = rel;
      vm.runInContext('_ctxActive = { id: __rel }', context);
      return { bodyEl: {}, actionsEl: {} };
    };
    const write = vi.fn(async (rel: string, content: string) => {
      if (failedWrites.has(rel)) return false;
      persisted.set(rel, content);
      return true;
    });
    context.mountMdViewEdit = ({ source, initialDraft, callbacks }: any) => {
      let dirty = !!initialDraft;
      return {
        isDirty: () => dirty,
        destroy: vi.fn(),
        save: async () => {
          if (!await write(source.rel, initialDraft.content)) return false;
          dirty = false;
          callbacks.onDraftChange(null);
          callbacks.onDirtyChange(false);
          return true;
        },
      };
    };
    vm.runInContext(`
      _ctxDrafts.set('first.md', { content: 'First edit', dirty: true });
      _ctxDrafts.set('second.md', { content: 'Second edit', dirty: true });
      _ctxDrafts.set('third.md', { content: 'Third edit', dirty: true });
    `, context);
    context._showCtxTextViewer('first.md', 'Original');
    return { context, persisted, failedWrites, write };
  }

  it('switches directly when the editor and retained draft have no changes', async () => {
    const context = setup(true);
    context.__controller.isDirty = () => false;
    vm.runInContext('_ctxDrafts.get("same.md").dirty = false', context);
    expect(await context.switchCtxProject('p1')).toBe(true);
    expect(vm.runInContext('_ctxProjectId', context)).toBe('p1');
    expect(context.uiConfirm).not.toHaveBeenCalled();
    expect(context.__controller.save).not.toHaveBeenCalled();
  });

  it('does not prompt, save, or reload when selecting the current project', async () => {
    const context = setup(true);
    expect(await context.switchCtxProject('')).toBe(true);
    expect(context.uiConfirm).not.toHaveBeenCalled();
    expect(context.__controller.save).not.toHaveBeenCalled();
    expect(context.loadContexts).not.toHaveBeenCalled();
    expect(vm.runInContext('_ctxDrafts.get("same.md").content', context)).toBe('Unsaved text');
  });

  it('discards edits without writing and does not restore them on return', async () => {
    const context = setup(false);
    expect(await context.switchCtxProject('p1')).toBe(true);
    expect(context.__controller.save).not.toHaveBeenCalled();
    await context.switchCtxProject('');
    expect(vm.runInContext('_ctxDrafts.size', context)).toBe(0);
  });

  it('waits for saving to finish and rejects a second switch while saving', async () => {
    const context = setup(true);
    let finish: (value: boolean) => void = () => {};
    context.__controller.save = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const pending = context.switchCtxProject('p1');
    await vi.waitFor(() => expect(context.__controller.save).toHaveBeenCalledOnce());
    expect(vm.runInContext('_ctxProjectId', context)).toBe('');
    expect(await context.switchCtxProject('p2')).toBe(false);
    finish(true);
    expect(await pending).toBe(true);
    expect(vm.runInContext('_ctxProjectId', context)).toBe('p1');
  });

  it('keeps the project and draft when saving fails, then permits retry', async () => {
    const context = setup(true, false);
    expect(await context.switchCtxProject('p1')).toBe(false);
    expect(vm.runInContext('_ctxProjectId', context)).toBe('');
    expect(vm.runInContext('_ctxDrafts.get("same.md").content', context)).toBe('Unsaved text');
    expect(context.__controller.destroy).not.toHaveBeenCalled();
    context.__controller.save.mockResolvedValue(true);
    expect(await context.switchCtxProject('p1')).toBe(true);
  });

  it('also persists the contents of files that are no longer open before switching', async () => {
    const { context, persisted } = setupMultipleDrafts();
    expect(await context.switchCtxProject('p1')).toBe(true);
    expect(context.uiConfirm.mock.calls[0][0].message).toContain('"count":3');
    expect(Object.fromEntries(persisted)).toEqual({
      'first.md': 'First edit', 'second.md': 'Second edit', 'third.md': 'Third edit',
    });
    await context.switchCtxProject('');
    expect(vm.runInContext('_ctxDrafts.size', context)).toBe(0);
  });

  it('retains remaining drafts after a partial save and retries only unsaved files', async () => {
    const { context, persisted, failedWrites, write } = setupMultipleDrafts();
    failedWrites.add('second.md');
    expect(await context.switchCtxProject('p1')).toBe(false);
    expect(vm.runInContext('_ctxProjectId', context)).toBe('');
    expect(Object.fromEntries(persisted)).toEqual({ 'first.md': 'First edit' });
    expect(vm.runInContext('Array.from(_ctxDrafts.keys())', context)).toEqual(['second.md', 'third.md']);
    expect(write.mock.calls).toEqual([['first.md', 'First edit'], ['second.md', 'Second edit']]);

    failedWrites.clear();
    expect(await context.switchCtxProject('p1')).toBe(true);
    expect(context.uiConfirm.mock.calls[1][0].message).toContain('"count":2');
    expect(write.mock.calls).toEqual([
      ['first.md', 'First edit'], ['second.md', 'Second edit'],
      ['second.md', 'Second edit'], ['third.md', 'Third edit'],
    ]);
    expect(Object.fromEntries(persisted)).toEqual({
      'first.md': 'First edit', 'second.md': 'Second edit', 'third.md': 'Third edit',
    });
    expect(vm.runInContext('_ctxProjectId', context)).toBe('p1');
  });

  it('keeps hidden drafts and the current scope when reopening a file fails', async () => {
    const { context, persisted, write } = setupMultipleDrafts();
    context.apiFetch.mockResolvedValueOnce({ json: async () => ({ ok: false }) });
    expect(await context.switchCtxProject('p1')).toBe(false);
    expect(context.uiAlert).toHaveBeenCalledWith('contexts.read_failed:{}');
    expect(vm.runInContext('_ctxProjectId', context)).toBe('');
    expect(vm.runInContext('_ctxDrafts.get("second.md").content', context)).toBe('Second edit');
    expect(write.mock.calls).toEqual([['first.md', 'First edit']]);

    expect(await context.switchCtxProject('p1')).toBe(true);
    expect(Object.fromEntries(persisted)).toEqual({
      'first.md': 'First edit', 'second.md': 'Second edit', 'third.md': 'Third edit',
    });
  });
});


describe('Library drafts before moving or copying', () => {
  function setup(projectId = '') {
    const context = loadContextsScript();
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/library-transfer.js'), 'utf8'), context);
    const writes = new Map<string, string>();
    const failed = new Set<string>();
    context.__pid = projectId;
    vm.runInContext('_ctxProjectId = __pid', context);
    context.uiConfirm = vi.fn(async () => true);
    context.uiAlert = vi.fn();
    context.loadContexts = vi.fn();
    context.window.LibraryTransfer = { ...context.window.LibraryTransfer, open: vi.fn(async () => ({})) };
    context.apiFetch = context.apiLibraryFetch = vi.fn(async () => ({ json: async () => ({ ok: true, content: 'Original' }) }));
    context._prepCtxViewerShell = (rel: string) => {
      context.__rel = rel;
      vm.runInContext('_ctxActive = { id: __rel }', context);
      return { bodyEl: {}, actionsEl: {} };
    };
    context.mountMdViewEdit = ({ source, initialDraft, callbacks }: any) => {
      let dirty = initialDraft?.dirty === true;
      return {
        isDirty: () => dirty, destroy: vi.fn(), getSource: () => source,
        save: vi.fn(async () => {
          const rel = source.name || source.rel;
          if (failed.has(rel)) return false;
          writes.set(rel, initialDraft.content);
          dirty = false;
          callbacks.onDraftChange(null);
          return true;
        }),
      };
    };
    vm.runInContext(`
      _ctxDrafts.set('notes/one.md', { content: 'First edit', dirty: true });
      _ctxDrafts.set('notes/two.md', { content: 'Second edit', dirty: true });
      _ctxDrafts.set('notes-extra.md', { content: 'Unrelated edit', dirty: true });
    `, context);
    context._showCtxTextViewer('notes/one.md', 'Original');
    return { context, writes, failed };
  }

  it.each(['', 'project-a'])('saves selected folder drafts before opening transfer in scope "%s"', async (pid) => {
    const { context, writes } = setup(pid);
    context.window.LibraryTransfer.open.mockImplementation(async () => {
      expect(Object.fromEntries(writes)).toEqual({ 'notes/one.md': 'First edit', 'notes/two.md': 'Second edit' });
    });
    await context._openCtxTransfer(['notes', 'notes/one.md'], 'batch');
    expect(context.uiConfirm).toHaveBeenCalledOnce();
    expect(context.uiConfirm.mock.calls[0][0]).toMatchObject({
      message: 'contexts.transfer.save_changes:{}', okLabel: 'contexts.switch_save:{}', cancelLabel: 'contexts.switch_discard:{}',
    });
    expect(context.window.LibraryTransfer.open).toHaveBeenCalledOnce();
    expect(vm.runInContext('Array.from(_ctxDrafts.keys())', context)).toEqual(['notes-extra.md']);
  });

  it.each(['move', 'copy'])('retains drafts until a successful %s after choosing not to save', async (mode) => {
    const { context, writes } = setup();
    context.uiConfirm.mockResolvedValue(false);
    await context._openCtxTransfer(['notes'], 'menu');
    expect(context.uiConfirm).toHaveBeenCalledOnce();
    expect(writes.size).toBe(0);
    expect(vm.runInContext('_ctxDrafts.size', context)).toBe(3);
    const options = context.window.LibraryTransfer.open.mock.calls[0][0];
    await options.onComplete({ mode, destination: { scope: 'project', projectId: 'p2' }, results: [{ source: 'notes', destination: 'notes', ok: true }] });
    expect(vm.runInContext('Array.from(_ctxDrafts.keys())', context)).toEqual(mode === 'copy'
      ? ['notes/one.md', 'notes/two.md', 'notes-extra.md'] : ['notes-extra.md']);
  });

  it('does not ask about or save unrelated drafts', async () => {
    const { context, writes } = setup();
    await context._openCtxTransfer(['clean.md'], 'menu');
    expect(context.uiConfirm).not.toHaveBeenCalled();
    expect(writes.size).toBe(0);
    expect(context.window.LibraryTransfer.open).toHaveBeenCalledOnce();
  });

  it('stops transfer after a failed save and retains the remaining drafts for retry', async () => {
    const { context, writes, failed } = setup();
    failed.add('notes/two.md');
    await context._openCtxTransfer(['notes'], 'batch');
    expect(context.window.LibraryTransfer.open).not.toHaveBeenCalled();
    expect(Object.fromEntries(writes)).toEqual({ 'notes/one.md': 'First edit' });
    expect(vm.runInContext('Array.from(_ctxDrafts.keys())', context)).toEqual(['notes/two.md', 'notes-extra.md']);
    failed.clear();
    await context._openCtxTransfer(['notes'], 'batch');
    expect(context.window.LibraryTransfer.open).toHaveBeenCalledOnce();
    expect(writes.get('notes/two.md')).toBe('Second edit');
  });

  it('stops transfer when a hidden draft cannot be reopened', async () => {
    const { context, writes } = setup();
    context.apiFetch.mockResolvedValue({ json: async () => ({ ok: false }) });
    await context._openCtxTransfer(['notes'], 'batch');
    expect(context.window.LibraryTransfer.open).not.toHaveBeenCalled();
    expect(writes.get('notes/one.md')).toBe('First edit');
    expect(vm.runInContext('_ctxDrafts.get("notes/two.md").content', context)).toBe('Second edit');
    expect(context.uiAlert).toHaveBeenCalledWith('contexts.read_failed:{}');
  });

  it('blocks a duplicate transfer and project switch while the save choice is pending', async () => {
    const { context } = setup();
    let resolve: (value: boolean) => void = () => {};
    context.uiConfirm.mockImplementation(() => new Promise<boolean>((done) => { resolve = done; }));
    const pending = context._openCtxTransfer(['notes'], 'menu');
    await vi.waitFor(() => expect(context.uiConfirm).toHaveBeenCalledOnce());
    await context._openCtxTransfer(['notes'], 'batch');
    expect(await context.switchCtxProject('p2')).toBe(false);
    expect(context.window.LibraryTransfer.open).not.toHaveBeenCalled();
    resolve(true);
    await pending;
    expect(context.window.LibraryTransfer.open).toHaveBeenCalledOnce();
    expect(context.uiConfirm).toHaveBeenCalledOnce();
  });

  it('does not continue after the source scope changes while confirming', async () => {
    const { context, writes } = setup();
    context.uiConfirm.mockImplementation(async () => {
      vm.runInContext('_ctxScopeGeneration++', context);
      return true;
    });
    await context._openCtxTransfer(['notes'], 'menu');
    expect(writes.size).toBe(0);
    expect(context.window.LibraryTransfer.open).not.toHaveBeenCalled();
  });
});
