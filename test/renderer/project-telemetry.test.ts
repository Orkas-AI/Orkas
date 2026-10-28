import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const source = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/project-detail.js'),
  'utf8',
);

function loadProjectDetailLifecycle(invoke: (channel: string, payload: any) => Promise<any>) {

  const context: any = {
    currentUserId: 'local-user',
    AbortController,
    ArrayBuffer,
    Blob,
    Uint8Array,
    clearTimeout,
    console,
    performance,
    setTimeout,
    btoa: (value: string) => Buffer.from(value, 'binary').toString('base64'),
    createLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
    escapeHtml: (value: unknown) => String(value ?? ''),
    t: (key: string) => key,
    window: {
      addEventListener: vi.fn(),
      orkas: { invoke: vi.fn(invoke) },
    },
    document: {
      readyState: 'loading',
      addEventListener: vi.fn(),
      getElementById: vi.fn(() => null),
      querySelector: vi.fn(() => null),
      querySelectorAll: vi.fn(() => []),
    },
    uiAlert: vi.fn(async () => undefined),
    uiConfirm: vi.fn(async () => true),
    uiConfirmDanger: vi.fn(async () => true),
  };
  vm.createContext(context);
  vm.runInContext(source, context, { filename: 'project-detail.js' });
  vm.runInContext("_projectDetailPid = 'project-private-1'", context);

  return context;
}

describe('project lifecycle ownership and recovery', () => {
  it.each([
    ['project', 'success'], ['project', 'failure'], ['project', 'rejection'],
    ['account', 'success'], ['account', 'failure'], ['account', 'rejection'],
  ])('isolates a late rename %s/%s without changing another scope', async (scope, outcome) => {
    let release!: () => void;
    const response = new Promise((resolve, reject) => {
      release = () => outcome === 'rejection' ? reject(new Error('synthetic rename failure')) : resolve({
        ok: outcome === 'success', error: 'name_dup', project: { project_id: 'project-private-1', name: 'Renamed' },
      });
    });
    const context = loadProjectDetailLifecycle(() => response);
    context.currentUserId = 'first';
    const input = { value: 'New name', style: { display: '' } };
    context.document.getElementById = (id: string) => id === 'project-detail-title-input' ? input : null;
    context._renderProjectDetail = vi.fn(); context._exitRenameMode = vi.fn(); context.loadProjects = vi.fn(async () => {});
    vm.runInContext(`_projectDetailResolvedPid = 'project-private-1'; _projectDetailMeta = { project: {
      project_id: 'project-private-1', name: 'Before', owner_uid: 'first' } };`, context);
    const renaming = context._commitRename('New name');
    expect(context.window.orkas.invoke).toHaveBeenCalledOnce();
    if (scope === 'account') context.currentUserId = 'second';
    else vm.runInContext("_projectDetailPid = 'project-2'; _projectDetailResolvedPid = 'project-2'", context);
    vm.runInContext("_projectDetailMeta = { project: { project_id: 'current-project', name: 'Current project' } }", context);
    input.value = 'Current edit'; release(); await renaming;
    expect(vm.runInContext('_projectDetailMeta.project.name', context)).toBe('Current project');
    expect(input.value).toBe('Current edit');
    expect(context.uiAlert).not.toHaveBeenCalled();
    expect(context._renderProjectDetail).not.toHaveBeenCalled();
    expect(context._exitRenameMode).not.toHaveBeenCalled();
    expect(context.loadProjects).not.toHaveBeenCalled();
    expect(vm.runInContext('_projectRenameCommitInFlight', context)).toBe(false);

  });

  it.each(['project', 'account'])('preserves the new edit when %s changes while rename failure feedback is open', async scope => {
    const context = loadProjectDetailLifecycle(async () => ({ ok: false, error: 'name_dup' }));
    context.currentUserId = 'first';
    const input = { value: 'Next name', style: { display: '' } };
    context.document.getElementById = (id: string) => id === 'project-detail-title-input' ? input : null;
    context._exitRenameMode = vi.fn();
    vm.runInContext("_projectDetailMeta = { project: { project_id: 'project-private-1', name: 'Before' } }", context);
    let release!: () => void, shown!: () => void;
    const waiting = new Promise<void>(resolve => { shown = resolve; });
    context.uiAlert = vi.fn(() => { shown(); return new Promise<void>(resolve => { release = resolve; }); });
    const renaming = context._commitRename('Next name'); await waiting;
    if (scope === 'account') context.currentUserId = 'second';
    else vm.runInContext("_projectDetailPid = 'project-2'", context);
    input.value = 'Current edit'; release(); await renaming;
    expect(input.value).toBe('Current edit');
    expect(context._exitRenameMode).not.toHaveBeenCalled();
    expect(vm.runInContext('_projectRenameCommitInFlight', context)).toBe(false);
  });

  it.each(['detail', 'list-sync', 'list-async'])('preserves one successful rename outcome when %s refresh throws', async owner => {
    const context = loadProjectDetailLifecycle(async () => ({ ok: true,
      project: { project_id: 'project-private-1', name: 'Renamed' } }));
    vm.runInContext("_projectDetailMeta = { project: { project_id: 'project-private-1', name: 'Before' } }", context);
    context.loadProjects = owner === 'list-sync'
      ? vi.fn(() => { throw new Error('synthetic list refresh failure'); })
      : vi.fn(async () => { if (owner === 'list-async') throw new Error('synthetic list refresh rejection'); });
    context._exitRenameMode = vi.fn();
    context._renderProjectDetail = vi.fn(() => { if (owner === 'detail') throw new Error('synthetic presentation failure'); });
    await context._commitRename('Renamed');

    expect(vm.runInContext('_projectDetailMeta.project.name', context)).toBe('Renamed');
    expect(context._exitRenameMode).toHaveBeenCalledOnce();
    expect(context._renderProjectDetail).toHaveBeenCalledOnce();
    expect(context.uiAlert).not.toHaveBeenCalled();
    expect(vm.runInContext('_projectRenameCommitInFlight', context)).toBe(false);
  });

  it.each([
    ['project', 'success'], ['project', 'failure'], ['project', 'rejection'],
    ['account', 'success'], ['account', 'failure'], ['account', 'rejection'],
  ])('isolates late reprocess %s/%s ', async (scope, outcome) => {
    let release!: () => void;
    const response = new Promise((resolve, reject) => {
      release = () => outcome === 'rejection' ? reject(new Error('synthetic reprocess failure')) : resolve({ ok: outcome === 'success' });
    });
    const context = loadProjectDetailLifecycle(() => response);
    context.currentUserId = 'first';
    context._updateProjectFileKbChip = vi.fn(); context._scheduleProjectKbStatusRefreshIfNeeded = vi.fn();
    vm.runInContext(`_projectDetailResolvedPid = 'project-private-1'; _projectDetailMeta = { project: {
      project_id: 'project-private-1', owner_uid: 'first' } };`, context);
    const processing = context._reprocessProjectFile('old.md');
    expect(context.window.orkas.invoke).toHaveBeenCalledOnce();
    if (scope === 'account') context.currentUserId = 'second';
    else vm.runInContext(`_projectDetailPid = 'project-2'; _projectDetailResolvedPid = 'project-2';
      _projectDetailMeta = { project: { project_id: 'project-2',  } };`, context);
    vm.runInContext("_projectKbStatusByName = { 'current.md': { status: 'ready' } }", context);
    release(); await processing;
    expect(context.uiAlert).not.toHaveBeenCalled();
    expect(vm.runInContext("Object.keys(_projectKbStatusByName)", context)).toEqual(['current.md']);

  });

  it.each(['success', 'failure', 'rejection'])('retains current-project reprocess feedback and pending recovery on %s', async outcome => {
    const context = loadProjectDetailLifecycle(async () => {
      if (outcome === 'rejection') throw new Error('synthetic reprocess failure');
      return { ok: outcome === 'success' };
    });
    context._updateProjectFileKbChip = vi.fn(); context._scheduleProjectKbStatusRefreshIfNeeded = vi.fn();
    await context._reprocessProjectFile('notes.md');
    expect(context.window.orkas.invoke).toHaveBeenCalledExactlyOnceWith('projects.files.reprocess', {
      projectId: 'project-private-1', name: 'notes.md',
    });
    expect(vm.runInContext("_projectKbStatusByName['notes.md'].status", context)).toBe('pending');

    if (outcome === 'success') expect(context.uiAlert).not.toHaveBeenCalled();
    else expect(context.uiAlert).toHaveBeenCalledExactlyOnceWith('project.files.reprocess_failed');
  });

  it.each(['name_empty', 'rejection'])('restores the current rename input and permits recovery after %s', async failure => {
    const context = loadProjectDetailLifecycle(async () => {
      if (failure === 'rejection') throw new Error('synthetic rename failure');
      return { ok: false, error: failure };
    });
    const input = { value: 'Next name', style: { display: '' } };
    context.document.getElementById = (id: string) => id === 'project-detail-title-input' ? input : null;
    vm.runInContext("_projectDetailMeta = { project: { name: 'Before' } }", context);
    await context._commitRename('Next name');
    expect(input.value).toBe('Before'); expect(input.style.display).toBe('none');
    expect(context.uiAlert).toHaveBeenCalledExactlyOnceWith(failure === 'name_empty' ? 'project.name_empty' : 'project.error.generic');

    expect(vm.runInContext('_projectRenameCommitInFlight', context)).toBe(false);
  });

  it.each(['   ', ' Before  '])('exits an empty or unchanged rename without a mutation (%j)', async value => {
    const context = loadProjectDetailLifecycle(async () => ({ ok: true }));
    vm.runInContext("_projectDetailMeta = { project: { name: 'Before' } }", context);
    context._exitRenameMode = vi.fn();
    await context._commitRename(value);
    expect(context.window.orkas.invoke).not.toHaveBeenCalled();
     expect(context._exitRenameMode).toHaveBeenCalledOnce();
    expect(vm.runInContext('_projectRenameCommitInFlight', context)).toBe(false);
  });

  it.each(['cancel', 'account-change'])('does not delete after confirmation ends with %s', async (outcome) => {
    const context = loadProjectDetailLifecycle(async () => ({ ok: true }));
    context.currentUserId = 'member-uid';
    let confirm!: (value: boolean) => void;
    context.uiConfirmDanger.mockImplementation(() => new Promise(resolve => { confirm = resolve; }));
    const scope = { pid: 'private-local-id', tasks: [{ id: 'private-task-id', content: 'Keep this work' }] };
    const pending = context._deleteTodoTask('private-task-id', scope);
    expect(context.window.orkas.invoke).not.toHaveBeenCalled();

    if (outcome === 'account-change') context.currentUserId = 'other-uid';
    confirm(outcome === 'account-change');
    await pending;
    expect(context.window.orkas.invoke).not.toHaveBeenCalled();
    expect(context.uiAlert).not.toHaveBeenCalled();

  });

  it.each(['rejected', 'exception'])('preserves a to-do on a %s delete, shows recovery, and permits an explicitly confirmed retry', async (failure) => {
    const task = { id: 'private-task-id', content: 'Delete only this work', status: 'todo' };
    const retained = { id: 'retained-task-id', content: 'Keep this work', status: 'todo' };
    let tasks = [task, retained];
    let fail = true;
    const context = loadProjectDetailLifecycle(async (channel, args) => {
      expect(channel).toBe('projects.tasks.delete');
      expect(args).toEqual({ projectId: 'private-local-id', taskId: task.id });
      if (fail) {
        if (failure === 'exception') throw new Error('delete unavailable');
        return { ok: false, error: 'delete_failed' };
      }
      tasks = tasks.filter(item => item.id !== args.taskId);
      return { ok: true };
    });
    context.currentUserId = 'member-uid';
    const scope = { pid: 'private-local-id', tasks, global: false, project: { project_id: 'private-local-id' } };
    context._refreshGlobalTodos = vi.fn(async () => {});
    await context._deleteTodoTask(task.id, scope);
    expect(tasks).toEqual([task, retained]);
    expect(context.window.orkas.invoke).toHaveBeenCalledTimes(1);
    expect(context.uiAlert.mock.calls).toEqual([['project.todo.failed']]);
    expect(context._refreshGlobalTodos).toHaveBeenCalledWith(scope.pid);

    fail = false;
    context.uiConfirmDanger.mockResolvedValueOnce(false);
    await context._deleteTodoTask(task.id, scope);
    expect(tasks).toEqual([task, retained]);
    expect(context.window.orkas.invoke).toHaveBeenCalledTimes(1);

    await context._deleteTodoTask(task.id, scope);
    expect(tasks).toEqual([retained]);
    expect(context.window.orkas.invoke).toHaveBeenCalledTimes(2);

    expect(context.uiAlert).toHaveBeenCalledTimes(1);

  });

  it('rereads the rules rail when the host reports that a model wrote the open project\'s instructions', async () => {
    const calls: string[] = [];
    const context = loadProjectDetailLifecycle(async (channel: string) => {
      calls.push(channel);
      return channel === 'projects.instructions.get' ? { ok: true, content: 'Ship the launch by March', limit: 4000 } : { ok: true };
    });
    context.currentView = 'project';
    vm.runInContext("_projectDetailPid = 'p1'; _projectDetailMeta = { project: { project_id: 'p1' }, instructions: { content: '', limit: 4000 } }", context);
    // Another project's write, or a page that is not open, reads nothing.
    context._onProjectInstructionsChanged({ projectId: 'p2' });
    context._onProjectInstructionsChanged({ projectId: 'p1' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(calls.filter((channel) => channel === 'projects.instructions.get')).toHaveLength(1);
    expect(vm.runInContext('_projectDetailMeta.instructions.content', context)).toBe('Ship the launch by March');
  });

  it('submits a failed detail rename only once even when blur follows the failure', async () => {
    let releaseRename: ((value: any) => void) | null = null;
    const invoke = vi.fn(() => new Promise((resolve) => { releaseRename = resolve; }));
    const context = loadProjectDetailLifecycle(invoke);
    const input = { value: 'Renamed project', style: { display: '' } };
    context.document.getElementById = (id: string) => (
      id === 'project-detail-title-input' ? input : null
    );
    vm.runInContext(
      "_projectDetailMeta = { project: { project_id: 'project-private-1', name: 'Original project' } }",
      context,
    );

    const first = context._commitRename('Renamed project');
    const concurrentBlur = context._commitRename('Renamed project');
    expect(invoke).toHaveBeenCalledTimes(1);
    releaseRename!({ ok: false, error: 'name_dup' });
    await Promise.all([first, concurrentBlur]);

    // Chromium dispatches blur after display:none; the restored input value
    // must make that callback a no-op instead of a second mutation.
    await context._commitRename(input.value);

    expect(invoke).toHaveBeenCalledTimes(1);

    expect(input.value).toBe('Original project');
  });

  it('reports a self-descendant project move as blocked without synthetic latency', async () => {
    const invoke = vi.fn(async () => ({ ok: true }));
    const context = loadProjectDetailLifecycle(invoke);

    await context._handleProjectLibraryMove('docs', 'docs/archive');

    expect(invoke).not.toHaveBeenCalled();

  });

  it('treats a resolved binding-remove rejection as failure without entity ids or a paired error', async () => {
    const context = loadProjectDetailLifecycle(async () => ({
      ok: false,
      error: 'agent_disabled',
      code: 'E_UNKNOWN',
    }));
    context.loadProjectDetail = vi.fn(async () => undefined);
    context._projectDetailPid = 'project-private-1';

    await context._removeProjectAgent('private-agent-id');

    expect(context.loadProjectDetail).not.toHaveBeenCalled();
  });

  it('keeps a binding-remove success when the presentation refresh fails', async () => {
    const context = loadProjectDetailLifecycle(async () => ({ ok: true }));
    context.loadProjectDetail = vi.fn(async () => { throw new Error('refresh failed'); });
    context._projectDetailPid = 'project-private-1';

    await context._removeProjectAgent('private-agent-id');

    expect(context.loadProjectDetail).toHaveBeenCalledTimes(1);

  });

  it('opens a newly saved text file after its write succeeds', async () => {
    const context = loadProjectDetailLifecycle(async (channel: string) => {
      expect(channel).toBe('projects.files.createText');
      return { ok: true, info: { relPath: 'Untitled.md' } };
    });
    context.loadProjectDetail = vi.fn(async () => undefined);
    context._openProjectFile = vi.fn(async () => undefined);

    await context._createProjectTextFile('');

    expect(context._openProjectFile).toHaveBeenCalledWith('Untitled.md');

  });

  it('records native picker cancellation as cancelled instead of zero-file success', async () => {
    const context = loadProjectDetailLifecycle(async (channel: string) => {
      expect(channel).toBe('projects.files.pickAndUpload');
      return { ok: true, cancelled: true, files: [] };
    });
    context.loadProjectDetail = vi.fn(async () => undefined);

    await context._uploadProjectFilesNative('');

    expect(context.loadProjectDetail).not.toHaveBeenCalled();

  });
});
