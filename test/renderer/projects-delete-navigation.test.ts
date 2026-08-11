import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

function loadProjectsRenderer(options: {
  afterProjects: any[];
  afterConversations: any[];
  createdProject?: any;
  createProjectResult?: Promise<any>;
  listProjectsError?: Error;
  listProjectResults?: Array<Promise<any>>;
}) {
  const setViewCalls: any[] = [];
  const refreshAutoProjectCalls: string[] = [];
  const monitorClicks: any[] = [];
  const monitorEvents: any[] = [];
  const monitorErrors: any[] = [];
  const context: any = {
    console,
    setTimeout,
    clearTimeout,
    performance: { now: () => 1000 },
    currentView: 'project',
    currentCid: null,
    conversations: [],
    _projectDetailPid: '',
    createLogger: () => ({ warn() {}, info() {}, error() {}, debug() {} }),
    Monitor: {
      click: (name: string, payload: any) => monitorClicks.push({ name, payload }),
      event: (name: string, payload: any) => monitorEvents.push({ name, payload }),
      error: (name: string, payload: any) => monitorErrors.push({ name, payload }),
    },
    escapeHtml: (value: unknown) => String(value ?? ''),
    t: (key: string) => key,
    uiConfirmDanger: async () => true,
    uiAlert: async () => undefined,
    setView: (view: string, id?: string | null, opts?: any) => {
      setViewCalls.push({ view, id, opts });
      context.currentView = view;
      context.currentCid = view === 'conversation' ? id : null;
      context._projectDetailPid = view === 'project' ? id : '';
    },
    loadConversations: async () => {
      context.conversations = options.afterConversations;
    },
    localStorage: {
      getItem: () => null,
      setItem() {},
      removeItem() {},
    },
    document: {
      addEventListener() {},
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
    },
    window: {
      addEventListener() {},
      Monitor: true,
      uiIconHtml: () => '',
      refreshAutoProjectOptions: (pid: string) => { refreshAutoProjectCalls.push(pid); },
      orkas: {
        invoke: async (channel: string) => {
          if (channel === 'autoTasks.list') return { tasks: [] };
          if (channel === 'projects.delete') return { ok: true };
          if (channel === 'projects.create') {
            return options.createProjectResult
              ? await options.createProjectResult
              : { ok: true, project: options.createdProject };
          }
          if (channel === 'projects.list') {
            if (options.listProjectsError) throw options.listProjectsError;
            if (options.listProjectResults?.length) return await options.listProjectResults.shift();
            return { ok: true, projects: options.afterProjects };
          }
          throw new Error(`unexpected invoke: ${channel}`);
        },
      },
    },
  };
  context.window.window = context.window;
  context.__setProjectsCache = (projects: any[]) => {
    vm.runInContext(`_projectsCache = ${JSON.stringify(projects)}`, context);
  };
  context.__setViewCalls = setViewCalls;
  context.__refreshAutoProjectCalls = refreshAutoProjectCalls;
  context.__monitorClicks = monitorClicks;
  context.__monitorEvents = monitorEvents;
  context.__monitorErrors = monitorErrors;
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/projects.js'), 'utf8');
  vm.runInContext(source, context);
  return context;
}

describe('project delete navigation', () => {
  it('renders a running-count mount beside each idle Project title', () => {
    const context = loadProjectsRenderer({
      afterProjects: [],
      afterConversations: [],
    });

    const html = context._renderProjectRow(
      { project_id: 'p1', name: 'Alpha' },
      [],
    );

    expect(html).toContain('class="sidebar-btn-running-chip project-running-chip"');
    expect(html).toContain('data-project-running-chip="p1" hidden');
  });

  it('moves from the deleted detail page to the next project', async () => {
    const context = loadProjectsRenderer({
      afterProjects: [
        { project_id: 'p2', name: 'Beta', conv_count: 0 },
        { project_id: 'p3', name: 'Gamma', conv_count: 0 },
      ],
      afterConversations: [
        { conversation_id: 'c-global', project_id: '', last_active_at: '2026-06-01T00:00:00.000Z' },
      ],
    });
    context._projectDetailPid = 'p1';
    context.conversations = [
      { conversation_id: 'c-deleted', project_id: 'p1' },
      { conversation_id: 'c-global', project_id: '' },
    ];
    context.__setProjectsCache([
      { project_id: 'p1', name: 'Alpha', conv_count: 1 },
      { project_id: 'p2', name: 'Beta', conv_count: 0 },
      { project_id: 'p3', name: 'Gamma', conv_count: 0 },
    ]);

    await context._confirmDeleteProject('p1');

    expect(context.__setViewCalls).toEqual([
      {
        view: 'project',
        id: 'p2',
        opts: { entryPoint: 'project_delete_fallback' },
      },
    ]);
    expect(context.__refreshAutoProjectCalls).toEqual(['p1']);
  });

  it('moves from the deleted detail page to a remaining task when no projects remain', async () => {
    const context = loadProjectsRenderer({
      afterProjects: [],
      afterConversations: [
        { conversation_id: 'c-global', project_id: '', last_active_at: '2026-06-01T00:00:00.000Z' },
      ],
    });
    context._projectDetailPid = 'p1';
    context.conversations = [
      { conversation_id: 'c-deleted', project_id: 'p1' },
      { conversation_id: 'c-global', project_id: '' },
    ];
    context.__setProjectsCache([
      { project_id: 'p1', name: 'Alpha', conv_count: 1 },
    ]);

    await context._confirmDeleteProject('p1');

    expect(context.__setViewCalls).toEqual([
      {
        view: 'conversation',
        id: 'c-global',
        opts: { entryPoint: 'project_delete_fallback' },
      },
    ]);
    expect(context.__refreshAutoProjectCalls).toEqual(['p1']);
  });

  it('keeps a successful delete authoritative when post-mutation refresh fails without PC telemetry', async () => {
    const context = loadProjectsRenderer({
      afterProjects: [],
      afterConversations: [],
    });
    context.__setProjectsCache([{ project_id: 'p-private', name: 'Private', conv_count: 0 }]);
    context.loadConversations = async () => { throw new Error('refresh failed'); };

    await context._confirmDeleteProject('p-private', 'detail');

    expect(context.__monitorEvents).toEqual([]);
    expect(context.__monitorErrors).toEqual([]);
  });
});

describe('project create navigation', () => {
  it('keeps the last successful project list when a background refresh fails', async () => {
    const cached = [{ project_id: 'p-existing', name: 'Alpha', conv_count: 0 }];
    const context = loadProjectsRenderer({
      afterProjects: [],
      afterConversations: [],
      listProjectsError: new Error('temporary IPC failure'),
    });
    context.__setProjectsCache(cached);

    await expect(context.loadProjects(true)).resolves.toEqual(cached);
    expect(vm.runInContext('_projectsCache', context)).toEqual(cached);
  });

  it('does not let an older project-list response replace a newer refresh', async () => {
    let resolveOlder!: (result: any) => void;
    let resolveNewer!: (result: any) => void;
    const older = new Promise<any>((resolve) => { resolveOlder = resolve; });
    const newer = new Promise<any>((resolve) => { resolveNewer = resolve; });
    const context = loadProjectsRenderer({
      afterProjects: [],
      afterConversations: [],
      listProjectResults: [older, newer],
    });
    context.__setProjectsCache([
      { project_id: 'p-initial', name: 'Initial', conv_count: 0 },
    ]);

    const olderRefresh = context.loadProjects(true);
    const newerRefresh = context.loadProjects(true);
    resolveNewer({
      ok: true,
      projects: [{ project_id: 'p-newer', name: 'Newer', conv_count: 0 }],
    });
    await newerRefresh;
    resolveOlder({
      ok: true,
      projects: [{ project_id: 'p-older', name: 'Older', conv_count: 0 }],
    });
    await olderRefresh;

    expect(vm.runInContext('_projectsCache', context)).toEqual([
      { project_id: 'p-newer', name: 'Newer', conv_count: 0 },
    ]);
  });

  it('selects the new project and opens its detail page after creation', async () => {
    const createdProject = { project_id: 'p-new', name: 'Alpha', conv_count: 0 };
    const context = loadProjectsRenderer({
      afterProjects: [createdProject],
      afterConversations: [],
      createdProject,
    });
    context.currentView = 'new-chat';
    context._projectDetailPid = '';
    context._startProjectInlineCreate();

    const listeners = new Map<string, (...args: any[]) => any>();
    const input = {
      value: 'Alpha',
      addEventListener(type: string, listener: (...args: any[]) => any) {
        listeners.set(type, listener);
      },
    };
    context._bindInlineCreateInput(input);

    await listeners.get('blur')?.();

    expect(context.__setViewCalls).toEqual([
      {
        view: 'project',
        id: 'p-new',
        opts: { entryPoint: 'project_create' },
      },
    ]);
    expect(context.currentView).toBe('project');
    expect(context._projectDetailPid).toBe('p-new');
  });

  it('keeps the create draft and duplicate error across a background rerender', async () => {
    let resolveCreate!: (result: any) => void;
    const createProjectResult = new Promise<any>((resolve) => {
      resolveCreate = resolve;
    });
    const context = loadProjectsRenderer({
      afterProjects: [{ project_id: 'p-existing', name: 'Alpha', conv_count: 0 }],
      afterConversations: [],
      createProjectResult,
    });
    context._startProjectInlineCreate();

    const listeners = new Map<string, (...args: any[]) => any>();
    const input = {
      value: 'Alpha',
      disabled: false,
      addEventListener(type: string, listener: (...args: any[]) => any) {
        listeners.set(type, listener);
      },
    };
    context._bindInlineCreateInput(input);
    const pendingCreate = listeners.get('blur')?.();

    context.renderProjectsSection();
    resolveCreate({ ok: false, error: 'name_dup' });
    await pendingCreate;

    const html = context._renderInlineCreateRow();
    expect(html).toContain('value="Alpha"');
    expect(html).toContain('project-rename-input is-error');
    expect(html).toContain('project-inline-error');
    expect(html).toContain('project.name_dup_inline');
    expect(context.__monitorEvents).toEqual([]);
    expect(context.__monitorErrors).toEqual([]);
  });

  it('freezes an in-flight create and does not discard its result by starting a rename', async () => {
    let resolveCreate!: (result: any) => void;
    const createProjectResult = new Promise<any>((resolve) => {
      resolveCreate = resolve;
    });
    const createdProject = { project_id: 'p-new', name: 'Alpha', conv_count: 0 };
    const context = loadProjectsRenderer({
      afterProjects: [createdProject],
      afterConversations: [],
      createdProject,
      createProjectResult,
    });
    context._startProjectInlineCreate();

    const listeners = new Map<string, (...args: any[]) => any>();
    const input = {
      value: 'Alpha',
      disabled: false,
      addEventListener(type: string, listener: (...args: any[]) => any) {
        listeners.set(type, listener);
      },
    };
    context._bindInlineCreateInput(input);
    const pendingCreate = listeners.get('blur')?.();

    expect(input.disabled).toBe(true);
    expect(context._renderInlineCreateRow()).toContain('disabled');
    context._startProjectInlineRename('p-existing');
    expect(vm.runInContext('_projectsInlineCreate', context)).toBe(true);
    expect(vm.runInContext('_projectsInlineRenamePid', context)).toBeNull();

    resolveCreate({ ok: true, project: createdProject });
    await pendingCreate;
    expect(context.__setViewCalls).toEqual([
      {
        view: 'project',
        id: 'p-new',
        opts: { entryPoint: 'project_create' },
      },
    ]);
  });
});
