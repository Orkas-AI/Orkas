import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

function loadProjectDetailScript() {
  const source = fs.readFileSync(
    path.join(__dirname, '../../src/renderer/modules/project-detail.js'),
    'utf8',
  );
  const invoke = vi.fn(async (channel: string) => {
    if (channel === 'projects.files.reconcile') {
      return { ok: true, recoveredProcessing: 1 };
    }
    if (channel === 'projects.files.status') {
      return {
        ok: true,
        files: [{
          name: 'poster.png',
          kind: 'image',
          status: 'ready',
          chunks: 1,
        }],
      };
    }
    throw new Error(`unexpected channel: ${channel}`);
  });
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
    t: (key: string) => key,
    window: {
      addEventListener: vi.fn(),
      orkas: { invoke },
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
  vm.runInContext(`
    _projectDetailPid = 'project-1';
    _projectDetailMeta = {
      files: [{ type: 'file', name: 'poster.png', relPath: 'poster.png', kind: 'image' }]
    };
    _projectKbStatusByName = {
      'poster.png': { status: 'processing', kind: 'image' }
    };
  `, context);
  return { context, invoke };
}

describe('Project Library indexing recovery', () => {
  it.each(['project', 'account', 'reload'])('ignores a late status snapshot after %s changes', async scope => {
    const { context, invoke } = loadProjectDetailScript(); context.currentUserId = 'first';
    let release!: (value: any) => void;
    invoke.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const pending = context._refreshProjectKbStatusSnapshot('project-1');
    if (scope === 'project') vm.runInContext("_projectDetailPid = 'project-2'", context);
    if (scope === 'account') context.currentUserId = 'second';
    if (scope === 'reload') vm.runInContext('_projectDetailLoadSeq += 1', context);
    vm.runInContext("_projectKbStatusByName = { 'current.md': { status: 'ready' } }", context);
    release({ ok: true, files: [{ name: 'old.md', status: 'failed', kind: 'text' }] }); await pending;
    expect(vm.runInContext('Object.keys(_projectKbStatusByName)', context)).toEqual(['current.md']);
  });

  it.each(['project', 'account', 'reload'])('does not continue an old reconcile into the %s scope', async scope => {
    const { context, invoke } = loadProjectDetailScript(); context.currentUserId = 'first';
    let release!: (value: any) => void;
    const response = new Promise(resolve => { release = resolve; });
    invoke.mockImplementation(async channel => channel === 'projects.files.reconcile' ? response : { ok: true, files: [] });
    const schedule = vi.fn(); context._scheduleProjectKbStatusRefreshIfNeeded = schedule;
    context._kickProjectKbReconcileIfNeeded();
    expect(invoke).toHaveBeenCalledExactlyOnceWith('projects.files.reconcile', { projectId: 'project-1' });
    if (scope === 'project') vm.runInContext("_projectDetailPid = 'project-2'", context);
    if (scope === 'account') context.currentUserId = 'second';
    if (scope === 'reload') vm.runInContext('_projectDetailLoadSeq += 1', context);
    vm.runInContext("_projectKbStatusByName = { 'current.md': { status: 'ready' } }", context);
    release({ ok: true }); await vi.waitFor(() => expect(vm.runInContext('_projectKbReconcileInFlight', context)).toBe(false));
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(vm.runInContext('Object.keys(_projectKbStatusByName)', context)).toEqual(['current.md']);
  });

  it.each(['project', 'account', 'reload'])('keeps current ready rows after an old polling tick across %s', async scope => {
    const { context, invoke } = loadProjectDetailScript(); context.currentUserId = 'first';
    let tick!: () => Promise<void>, release!: (value: any) => void;
    context.setTimeout = vi.fn((run: () => Promise<void>) => { tick = run; return 1; });
    invoke.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    context._scheduleProjectKbStatusRefreshIfNeeded();
    expect(context.setTimeout).toHaveBeenCalledExactlyOnceWith(expect.any(Function), 2000);
    const running = tick();
    if (scope === 'project') vm.runInContext("_projectDetailPid = 'project-2'", context);
    if (scope === 'account') context.currentUserId = 'second';
    if (scope === 'reload') vm.runInContext('_projectDetailLoadSeq += 1', context);
    vm.runInContext(`_projectKbStatusByName = { 'current.md': { status: 'ready' } };
      _projectDetailMeta.files = [{ type: 'file', name: 'current.md', kind: 'text' }];`, context);
    release({ ok: true, files: [{ name: 'old.md', status: 'failed', kind: 'text' }] }); await running;
    expect(vm.runInContext('Object.keys(_projectKbStatusByName)', context)).toEqual(['current.md']);
    expect(vm.runInContext("_projectKbStatusByName['current.md'].status", context)).toBe('ready');
    expect(invoke).toHaveBeenCalledTimes(1); expect(context.setTimeout).toHaveBeenCalledTimes(1);
  });

  it('keeps polling current pending rows and releases a transient reconcile failure for retry', async () => {
    const { context, invoke } = loadProjectDetailScript();
    invoke.mockRejectedValueOnce(new Error('synthetic reconcile failure'));
    context._scheduleProjectKbStatusRefreshIfNeeded = vi.fn();
    context._kickProjectKbReconcileIfNeeded();
    await vi.waitFor(() => expect(vm.runInContext('_projectKbReconcileInFlight', context)).toBe(false));
    expect(vm.runInContext('_projectKbReconciledLoadSeq', context)).toBe(-1);
    context._kickProjectKbReconcileIfNeeded();
    await vi.waitFor(() => expect(invoke.mock.calls.filter(([channel]) => channel === 'projects.files.status')).toHaveLength(1));
    await vi.waitFor(() => expect(vm.runInContext('_projectKbReconcileInFlight', context)).toBe(false));
    expect(vm.runInContext("_projectKbStatusByName['poster.png'].status", context)).toBe('ready');
    expect(context._scheduleProjectKbStatusRefreshIfNeeded).toHaveBeenCalledTimes(2);
  });

  it('continues the polling loop for a current pending snapshot', async () => {
    const { context } = loadProjectDetailScript();
    let tick!: () => Promise<void>;
    context.setTimeout = vi.fn((run: () => Promise<void>) => { tick = run; return 1; });
    context._refreshProjectKbStatusSnapshot = vi.fn(async () => undefined);
    const reconcile = vi.fn(); context._kickProjectKbReconcileIfNeeded = reconcile;
    context._scheduleProjectKbStatusRefreshIfNeeded(); await tick();
    expect(reconcile).toHaveBeenCalledOnce(); expect(context.setTimeout).toHaveBeenCalledTimes(2);
  });

  it.each(['account', 'project'])('rejects a late event from a previous %s subscription', async scope => {
    const { context } = loadProjectDetailScript(); context.currentUserId = 'first';
    context._scheduleProjectKbStatusRefreshIfNeeded = vi.fn();
    let deliver!: (msg: any) => void;
    context.window.orkas.stream = vi.fn((_channel: string, _payload: any, onEvent: (msg: any) => void) => {
      deliver = onEvent; return { promise: new Promise(() => {}), cancel: vi.fn() };
    });
    context._ensureProjectKbEventSubscription('project-1');
    if (scope === 'account') context.currentUserId = 'second';
    else vm.runInContext("_projectDetailPid = 'project-2'", context);
    vm.runInContext("_projectKbStatusByName = { 'current.md': { status: 'ready' } }", context);
    deliver({ type: 'event', event: { projectId: 'project-1', name: 'old.md', status: 'failed' } });
    expect(vm.runInContext('Object.keys(_projectKbStatusByName)', context)).toEqual(['current.md']);
  });

  it('replaces the same-project subscription after an account change', () => {
    const { context } = loadProjectDetailScript(); context.currentUserId = 'first';
    const handles = Array.from({ length: 2 }, () => ({ promise: new Promise(() => {}), cancel: vi.fn() }));
    context.window.orkas.stream = vi.fn().mockReturnValueOnce(handles[0]).mockReturnValueOnce(handles[1]);
    context._ensureProjectKbEventSubscription('project-1');
    context.currentUserId = 'second'; context._ensureProjectKbEventSubscription('project-1');
    expect(context.window.orkas.stream).toHaveBeenCalledTimes(2); expect(handles[0].cancel).toHaveBeenCalledOnce();
  });

  it('keeps the replacement stream active when its cancelled predecessor finishes', async () => {
    const { context } = loadProjectDetailScript(); context.currentUserId = 'first';
    context._scheduleProjectKbStatusRefreshIfNeeded = vi.fn();
    let finish!: () => void;
    const old = { promise: new Promise<void>(resolve => { finish = resolve; }), cancel: vi.fn() };
    const current = { promise: new Promise(() => {}), cancel: vi.fn() };
    const deliver: Array<(msg: any) => void> = [];
    context.window.orkas.stream = vi.fn((_channel: string, _payload: any, onEvent: (msg: any) => void) => {
      deliver.push(onEvent); return deliver.length === 1 ? old : current;
    });
    context._ensureProjectKbEventSubscription('project-1'); context._stopProjectKbEventSubscription();
    context._ensureProjectKbEventSubscription('project-1'); finish();
    await old.promise; await Promise.resolve(); await Promise.resolve();
    expect(vm.runInContext('_projectKbEventsHandle', context)).toBe(current);
    deliver[0]({ type: 'event', event: { projectId: 'project-1', name: 'old.md', status: 'failed' } });
    expect(vm.runInContext("_projectKbStatusByName['old.md']", context)).toBeUndefined();
    deliver[1]({ type: 'event', event: { projectId: 'project-1', name: 'poster.png', status: 'ready' } });
    expect(vm.runInContext("_projectKbStatusByName['poster.png'].status", context)).toBe('ready');
  });

  it('accepts synchronous current events, reuses the subscription and rejects cancellation callbacks', () => {
    const { context } = loadProjectDetailScript(); context.currentUserId = 'first';
    context._scheduleProjectKbStatusRefreshIfNeeded = vi.fn();
    const handle = { promise: new Promise(() => {}), cancel: vi.fn() };
    context.window.orkas.stream = vi.fn((_channel: string, _payload: any, deliver: (msg: any) => void) => {
      deliver({ type: 'event', event: { projectId: 'project-1', name: 'poster.png', status: 'ready' } });
      handle.cancel.mockImplementation(() => deliver({ type: 'event', event: {
        projectId: 'project-1', name: 'cancelled.md', status: 'failed',
      } }));
      return handle;
    });
    context._ensureProjectKbEventSubscription('project-1'); context._ensureProjectKbEventSubscription('project-1');
    expect(context.window.orkas.stream).toHaveBeenCalledOnce();
    expect(vm.runInContext("_projectKbStatusByName['poster.png'].status", context)).toBe('ready');
    context._stopProjectKbEventSubscription();
    expect(handle.cancel).toHaveBeenCalledOnce();
    expect(vm.runInContext("_projectKbStatusByName['cancelled.md']", context)).toBeUndefined();
    expect(vm.runInContext('_projectKbEventsHandle', context)).toBeNull();
  });

  it('allows subscription retry after synchronous startup failure', () => {
    const { context } = loadProjectDetailScript();
    const handle = { promise: new Promise(() => {}), cancel: vi.fn() };
    context.window.orkas.stream = vi.fn().mockImplementationOnce(() => { throw new Error('synthetic startup failure'); }).mockReturnValue(handle);
    expect(() => context._ensureProjectKbEventSubscription('project-1')).not.toThrow();
    expect(vm.runInContext('_projectKbEventsHandle', context)).toBeNull();
    context._ensureProjectKbEventSubscription('project-1');
    expect(context.window.orkas.stream).toHaveBeenCalledTimes(2);
    expect(vm.runInContext('_projectKbEventsHandle', context)).toBe(handle);
  });

  it('releases a closed current stream so a later render can resubscribe', async () => {
    const { context } = loadProjectDetailScript();
    let fail!: (reason: Error) => void;
    const old = { promise: new Promise((_, reject) => { fail = reject; }), cancel: vi.fn() };
    const current = { promise: new Promise(() => {}), cancel: vi.fn() };
    context.window.orkas.stream = vi.fn().mockReturnValueOnce(old).mockReturnValueOnce(current);
    context._ensureProjectKbEventSubscription('project-1'); fail(new Error('synthetic closed stream'));
    await vi.waitFor(() => expect(vm.runInContext('_projectKbEventsHandle', context)).toBeNull());
    context._ensureProjectKbEventSubscription('project-1');
    expect(context.window.orkas.stream).toHaveBeenCalledTimes(2);
    expect(vm.runInContext('_projectKbEventsHandle', context)).toBe(current);
  });

  it('labels failed images with an accessible retry control in both Library views until recovery', () => {
    const { context } = loadProjectDetailScript();
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/contexts.js'), 'utf8'), context);
    const row = { path: 'poster.png', name: 'poster.png', kind: 'image', status: 'failed', error: 'private error' };
    context.globalSnapshot = context._buildKbStatusMap([], [row]);
    context.projectSnapshot = context._buildProjectKbStatusMap([], [row]);
    vm.runInContext('_kbStatusByPath = globalSnapshot; _projectKbStatusByName = projectSnapshot;', context);
    for (const render of [context._kbStatusChipHtml, context._projectKbStatusChipHtml]) {
      const html = render('poster.png');
      expect(html).toContain('<button');
      expect(html).toContain('contexts.kb.image_failed');
      expect(html).toContain('aria-label=');
      expect(html).not.toContain('private error');
    }
    context._applyKbEvent({ relPath: 'poster.png', kind: 'image', status: 'ready' });
    context._applyProjectKbEvent({ projectId: 'project-1', name: 'poster.png', kind: 'image', status: 'ready' });
    expect(context._kbStatusChipHtml('poster.png')).toBe('');
    expect(context._projectKbStatusChipHtml('poster.png')).toBe('');
  });

  it('keeps available files usable without per-file background download notices', () => {
    const { context } = loadProjectDetailScript();
    const html = context._renderProjectFileNodes([
      { type: 'file', name: 'available.txt', relPath: 'available.txt', kind: 'text' },
      { type: 'file', name: 'incoming.txt', relPath: 'incoming.txt', kind: 'text', pending: true },
    ]);
    expect(html).toContain('data-project-file="available.txt"');
    expect(html).toContain('data-action="project-file-menu"');
    expect(html).toContain('incoming.txt');
    expect(html).not.toContain('common.loading');
    expect(html).not.toContain('data-project-file="incoming.txt"');
  });

  it('explains oversized saved text after an event and a status refresh without offering a futile retry', () => {
    const { context } = loadProjectDetailScript();
    const status = {
      name: 'large.txt', kind: 'text', status: 'failed',
      errorCode: 'E_LIBRARY_FILE_TOO_LARGE',
      error: 'File saved. Text files over 5 MB are not indexed for search.',
    };
    context._applyProjectKbEvent({ ...status, projectId: 'project-1' });
    const eventChip = context._projectKbStatusChipHtml('large.txt');
    expect(eventChip).toContain(status.error);
    expect(eventChip).not.toContain('project-file-reprocess');
    context.snapshot = context._buildProjectKbStatusMap([], [status]);
    vm.runInContext('_projectKbStatusByName = snapshot', context);
    expect(context._projectKbStatusChipHtml('large.txt')).toBe(eventChip);

    context._applyProjectKbEvent({ ...status, errorCode: 'E_LIBRARY_EMBED_FAILED', error: 'Internal failure', projectId: 'project-1' });
    expect(context._projectKbStatusChipHtml('large.txt')).toContain('project-file-reprocess');
    expect(context._projectKbStatusChipHtml('large.txt')).not.toContain('Internal failure');
  });

  it('reconciles a processing row left behind by a previous app process', async () => {
    const { context, invoke } = loadProjectDetailScript();

    context._kickProjectKbReconcileIfNeeded();

    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('projects.files.reconcile', {
        projectId: 'project-1',
      });
    });
    await vi.waitFor(() => {
      expect(invoke).toHaveBeenCalledWith('projects.files.status', {
        projectId: 'project-1',
        skipReconcile: true,
      });
    });
    await vi.waitFor(() => {
      const status = vm.runInContext("_projectKbStatusByName['poster.png']", context);
      expect(status).toMatchObject({
        status: 'ready',
        chunks: 1,
      });
    });

    context._kickProjectKbReconcileIfNeeded();
    expect(invoke.mock.calls.filter(([channel]) => channel === 'projects.files.reconcile')).toHaveLength(1);
  });
});
