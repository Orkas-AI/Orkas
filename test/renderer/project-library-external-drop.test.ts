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

function loadProjectDetailScript() {
  const source = fs.readFileSync(
    path.join(__dirname, '../../src/renderer/modules/project-detail.js'),
    'utf8',
  );
  const context: any = {
    AbortController,
    ArrayBuffer,
    Blob,
    clearTimeout,
    performance,
    setTimeout,
    Uint8Array,
    btoa: (value: string) => Buffer.from(value, 'binary').toString('base64'),
    createLogger: () => ({ error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
    escapeHtml: (value: unknown) => String(value ?? ''),
    t: (key: string, vars?: Record<string, unknown>) => `${key}:${JSON.stringify(vars || {})}`,
    window: {
      addEventListener: vi.fn(),
      orkas: { invoke: vi.fn() },
    },
    document: {
      readyState: 'loading',
      addEventListener: vi.fn(),
      getElementById: vi.fn(() => null),
      querySelector: vi.fn(() => null),
      querySelectorAll: vi.fn(() => []),
    },
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'project-detail.js' });
  vm.runInContext("_projectDetailPid = 'project-1'", context);
  return context;
}

function makeRow(kind: 'dir' | 'file', rel: string) {
  const rowListeners: Record<string, Listener> = {};
  const nodeListeners: Record<string, Listener> = {};
  const node = {
    addEventListener: (name: string, listener: Listener) => { nodeListeners[name] = listener; },
    classList: fakeClassList(),
  };
  const row = {
    addEventListener: (name: string, listener: Listener) => { rowListeners[name] = listener; },
    classList: fakeClassList(),
    dataset: kind === 'dir'
      ? { type: 'dir', projectDir: rel }
      : { type: 'file', projectFile: rel, projectFileKind: 'text' },
    querySelector: () => node,
  };
  return { kind, node, nodeListeners, rel, row, rowListeners };
}

function makeTree(rows: ReturnType<typeof makeRow>[] = []) {
  const rootListeners: Record<string, Listener> = {};
  const root = {
    addEventListener: (name: string, listener: Listener) => { rootListeners[name] = listener; },
    classList: fakeClassList(),
    contains: () => false,
    dataset: {} as Record<string, string>,
    innerHTML: '',
    querySelectorAll: (selector: string) => {
      if (selector === '.project-dir-row[data-project-dir]') {
        return rows.filter((entry) => entry.kind === 'dir').map((entry) => entry.row);
      }
      if (selector === '.project-file-row[data-project-file]') {
        return rows.filter((entry) => entry.kind === 'file').map((entry) => entry.row);
      }
      if (selector === '.ctx-tree-wrap[data-type]') return rows.map((entry) => entry.row);
      if (selector === '.skill-tree-node.is-drag-over') {
        return rows.map((entry) => entry.node)
          .filter((node) => node.classList.contains('is-drag-over'));
      }
      return [];
    },
  };
  return { root, rootListeners };
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

function dropEvent(dataTransfer: any, closestRow: any = null) {
  return {
    dataTransfer,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    target: {
      closest: (selector: string) => selector === '.ctx-tree-wrap' ? closestRow : null,
    },
  };
}

describe('Project Library external file drag-and-drop', () => {
  it('uploads operating-system files into the hovered folder with copy semantics', async () => {
    const context = loadProjectDetailScript();
    const folder = makeRow('dir', 'Research/Notes');
    const tree = makeTree([folder]);
    const file = { name: 'brief.md', size: 12, arrayBuffer: vi.fn() };
    const dataTransfer = { types: ['Files'], files: [file], getData: () => '' };
    context.document.getElementById = (id: string) => id === 'project-files-list' ? tree.root : null;
    context._uploadProjectFiles = vi.fn(async () => undefined);

    context._bindProjectFileRows();
    const hover = dropEvent(dataTransfer);
    folder.nodeListeners.dragover(hover);
    expect(hover.preventDefault).toHaveBeenCalledOnce();
    expect(hover.stopPropagation).toHaveBeenCalledOnce();
    expect(dataTransfer.dropEffect).toBe('copy');
    expect(folder.node.classList.contains('is-drag-over')).toBe(true);

    const drop = dropEvent(dataTransfer);
    await folder.nodeListeners.drop(drop);
    expect(context._uploadProjectFiles).toHaveBeenCalledWith([file], 'Research/Notes', 'drop');
    expect(drop.preventDefault).toHaveBeenCalledOnce();
    expect(drop.stopPropagation).toHaveBeenCalledOnce();
    expect(folder.node.classList.contains('is-drag-over')).toBe(false);
  });

  it('keeps internal project Library drags on the move path', async () => {
    const context = loadProjectDetailScript();
    const folder = makeRow('dir', 'Archive');
    const tree = makeTree([folder]);
    const dataTransfer = {
      types: ['application/x-project-library-path'],
      files: [],
      getData: () => 'draft.md',
    };
    context.document.getElementById = (id: string) => id === 'project-files-list' ? tree.root : null;
    context._handleProjectLibraryMove = vi.fn(async () => undefined);
    context._uploadProjectFiles = vi.fn(async () => undefined);

    context._bindProjectFileRows();
    const hover = dropEvent(dataTransfer);
    folder.nodeListeners.dragover(hover);
    expect(dataTransfer.dropEffect).toBe('move');

    await folder.nodeListeners.drop(dropEvent(dataTransfer));
    expect(context._handleProjectLibraryMove).toHaveBeenCalledWith('draft.md', 'Archive');
    expect(context._uploadProjectFiles).not.toHaveBeenCalled();
  });

  it('accepts external files at the root when the project Library is empty', async () => {
    const context = loadProjectDetailScript();
    const tree = makeTree();
    const file = { name: 'root.txt', size: 4, arrayBuffer: vi.fn() };
    const dataTransfer = { types: ['Files'], files: [file], getData: () => '' };
    context.document.getElementById = (id: string) => id === 'project-files-list' ? tree.root : null;
    context._uploadProjectFiles = vi.fn(async () => undefined);

    context._renderProjectFiles([]);
    context._bindProjectFileRows();
    expect(tree.rootListeners.drop).toBeTypeOf('function');

    const hover = dropEvent(dataTransfer);
    tree.rootListeners.dragover(hover);
    expect(hover.preventDefault).toHaveBeenCalledOnce();
    expect(dataTransfer.dropEffect).toBe('copy');
    expect(tree.root.classList.contains('is-root-drag-over')).toBe(true);

    await tree.rootListeners.drop(dropEvent(dataTransfer));
    expect(context._uploadProjectFiles).toHaveBeenCalledWith([file], '', 'drop');
    expect(tree.root.classList.contains('is-root-drag-over')).toBe(false);
  });

  it('drops over an existing nested file into that file parent folder', async () => {
    const context = loadProjectDetailScript();
    const folder = makeRow('dir', 'Research');
    const existing = makeRow('file', 'Research/existing.md');
    const tree = makeTree([folder, existing]);
    const file = { name: 'new.md', size: 4, arrayBuffer: vi.fn() };
    const dataTransfer = { types: ['Files'], files: [file], getData: () => '' };
    context.document.getElementById = (id: string) => id === 'project-files-list' ? tree.root : null;
    context._uploadProjectFiles = vi.fn(async () => undefined);

    context._bindProjectFileRows();
    const hover = dropEvent(dataTransfer, existing.row);
    tree.rootListeners.dragover(hover);
    expect(hover.preventDefault).toHaveBeenCalledOnce();
    expect(folder.node.classList.contains('is-drag-over')).toBe(true);

    await tree.rootListeners.drop(dropEvent(dataTransfer, existing.row));
    expect(context._uploadProjectFiles).toHaveBeenCalledWith([file], 'Research', 'drop');
  });

  it('uploads beside the open nested file when dropped onto the project file viewer', async () => {
    const context = loadProjectDetailScript();
    const viewer = makeDropSurface();
    const file = { name: 'new-reference.pdf', size: 40, arrayBuffer: vi.fn() };
    const dataTransfer = { types: ['Files'], files: [file], getData: () => '' };
    context._uploadProjectFiles = vi.fn(async () => undefined);
    context._bindProjectLibraryDetailDrop(
      viewer.surface,
      () => context._projectLibraryParentDir('Research/Notes/current.md'),
    );

    const hover = dropEvent(dataTransfer);
    viewer.listeners.dragover(hover);
    expect(hover.preventDefault).toHaveBeenCalledOnce();
    expect(hover.stopPropagation).toHaveBeenCalledOnce();
    expect(dataTransfer.dropEffect).toBe('copy');
    expect(viewer.surface.classList.contains('is-external-drag-over')).toBe(true);

    const drop = dropEvent(dataTransfer);
    await viewer.listeners.drop(drop);
    expect(context._uploadProjectFiles).toHaveBeenCalledWith([file], 'Research/Notes', 'drop');
    expect(viewer.surface.classList.contains('is-external-drag-over')).toBe(false);
  });

  it('rejects hidden and unsupported drops while still uploading supported video files', async () => {
    const context = loadProjectDetailScript();
    const hidden = { name: '.secret.md', size: 2, arrayBuffer: vi.fn() };
    const unsupported = { name: 'archive.zip', size: 3, arrayBuffer: vi.fn() };
    const video = {
      name: 'demo.mp4',
      size: 4,
      arrayBuffer: vi.fn(async () => new ArrayBuffer(4)),
    };
    context.window.orkas.invoke = vi.fn(async () => ({ ok: true }));
    context.loadProjectDetail = vi.fn(async () => undefined);
    context.uiAlert = vi.fn(async () => undefined);

    await context._uploadProjectFiles([hidden, unsupported, video], 'References', 'drop');

    expect(hidden.arrayBuffer).not.toHaveBeenCalled();
    expect(unsupported.arrayBuffer).not.toHaveBeenCalled();
    expect(video.arrayBuffer).toHaveBeenCalledOnce();
    expect(context.window.orkas.invoke).toHaveBeenCalledOnce();
    expect(context.window.orkas.invoke).toHaveBeenCalledWith('projects.files.upload', expect.objectContaining({
      projectId: 'project-1',
      name: 'References/demo.mp4',
    }));
    expect(context.loadProjectDetail).toHaveBeenCalledWith('project-1');
    expect(context.uiAlert).toHaveBeenCalledTimes(2);
    expect(context.uiAlert.mock.calls[0][0]).toContain('contexts.upload_rejected');
    expect(context.uiAlert.mock.calls[0][0]).toContain('archive.zip');
    expect(context.uiAlert.mock.calls[1][0]).toContain('contexts.upload_hidden_rejected');
    expect(context.uiAlert.mock.calls[1][0]).toContain('.secret.md');
  });

  it('caps external upload work at three concurrent files', async () => {
    const context = loadProjectDetailScript();
    let active = 0;
    let maxActive = 0;
    const files = Array.from({ length: 7 }, (_, index) => ({
      name: `doc-${index}.md`,
      arrayBuffer: vi.fn(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return new ArrayBuffer(1);
      }),
    }));
    context.window.orkas.invoke = vi.fn(async () => ({ ok: true }));
    context.loadProjectDetail = vi.fn(async () => undefined);

    await context._uploadProjectFiles(files, '', 'drop');

    expect(maxActive).toBe(3);
    expect(context.window.orkas.invoke).toHaveBeenCalledTimes(7);
  });

  it('keeps telemetry and rejection alerts when the post-upload refresh fails', async () => {
    const context = loadProjectDetailScript();
    const file = { name: 'ok.md', arrayBuffer: vi.fn(async () => new ArrayBuffer(1)) };
    const rejected = { name: 'bad.zip', arrayBuffer: vi.fn() };
    context.window.orkas.invoke = vi.fn(async () => ({ ok: true }));
    context.loadProjectDetail = vi.fn(async () => { throw new Error('refresh failed'); });
    context.uiAlert = vi.fn(async () => undefined);
    context._projectTrackEvent = vi.fn();
    context._projectTrackError = vi.fn();

    await expect(context._uploadProjectFiles([file, rejected], '', 'drop')).resolves.toBeUndefined();

    expect(context._projectTrackEvent).toHaveBeenCalledWith('project_file_upload_result', expect.objectContaining({
      result: 'partial_failure',
      uploaded_count: 1,
      rejected_count: 1,
    }));
    expect(context._projectTrackError).toHaveBeenCalled();
    expect(context.uiAlert).toHaveBeenCalledWith(expect.stringContaining('bad.zip'));
  });
});
