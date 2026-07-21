import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

function loadProjectsRenderer(options: {
  afterProjects: any[];
  afterConversations: any[];
  createdProject?: any;
}) {
  const setViewCalls: any[] = [];
  const refreshAutoProjectCalls: string[] = [];
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
      querySelectorAll: () => [],
    },
    window: {
      addEventListener() {},
      uiIconHtml: () => '',
      refreshAutoProjectOptions: (pid: string) => { refreshAutoProjectCalls.push(pid); },
      orkas: {
        invoke: async (channel: string) => {
          if (channel === 'autoTasks.list') return { tasks: [] };
          if (channel === 'projects.delete') return { ok: true };
          if (channel === 'projects.create') return { ok: true, project: options.createdProject };
          if (channel === 'projects.list') return { ok: true, projects: options.afterProjects };
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
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/projects.js'), 'utf8');
  vm.runInContext(source, context);
  return context;
}

describe('project delete navigation', () => {
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
});

describe('project create navigation', () => {
  it('selects the new project and opens its detail page after creation', async () => {
    const createdProject = { project_id: 'p-new', name: 'Alpha', conv_count: 0 };
    const context = loadProjectsRenderer({
      afterProjects: [createdProject],
      afterConversations: [],
      createdProject,
    });
    context.currentView = 'new-chat';
    context._projectDetailPid = '';

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
});
