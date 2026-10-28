import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

type Task = { id: string; project_id?: string | null; enabled?: boolean };
type Project = { project_id: string; name: string };
type Group = { projectId: string; name: string; tasks: Task[] };
const { _autoGroupTasks: groupTasks } = require('../../src/renderer/modules/auto.js') as {
  _autoGroupTasks: (tasks: readonly Task[], projects: readonly Project[]) => Group[];
};

/** The Auto tab against the real list renderer, with the sidebar project cache
 *  and view state controlled by the test. Rows are stubbed: the cases assert
 *  the project switcher and the selected card scope. */
function loadAutoTab(options: { projects: Project[] | null; view: string }) {
  let scopes: any[] = [];
  let selectedGroup: any = null;
  const rows = () => selectedGroup?.children.find((child: any) => child.className === 'auto-scope-cards')?.children || [];
  const list: any = {
    clears: 0,
    querySelectorAll: (selector: string) => rows().filter((row: any) => !selector.includes('.is-highlighted') || row.classList.contains('is-highlighted')),
    appendChild(child: any) {
      if (child.className.includes('auto-scope-switcher')) scopes = child.children;
      if (child.className === 'auto-scope-group') selectedGroup = child;
    },
  };
  Object.defineProperty(list, 'innerHTML', { set() { list.clears += 1; scopes = []; selectedGroup = null; }, get() { return ''; } });
  const elements: Record<string, any> = {
    'auto-add-btn': {
      dataset: {}, click() {},
      addEventListener(name: string, fn: () => void) { if (name === 'click') this.click = fn; },
    },
    'auto-list': list,
    'auto-empty': { style: {} },
    'auto-row-project': { hidden: false },
    'auto-header-count': { textContent: '' },
  };
  const sidebarLoads: unknown[] = [];
  const context: any = {
    console, setTimeout, clearTimeout, Map, Set, Array, Promise, Date, Math, JSON, String, Number, Object, RegExp,
    createLogger: () => ({ warn() {}, info() {}, error() {} }),
    t: (key: string) => key,
    escapeHtml: (value: unknown) => String(value ?? ''),
    uiAlert() {},
    currentView: options.view,
    renderTaskRow: (task: Task) => {
      const classes = new Set<string>();
      return { task, dataset: { taskId: task.id }, scrollIntoView: vi.fn(), classList: {
        add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name),
        contains: (name: string) => classes.has(name),
      } };
    },
    _projectsCache: options.projects,
    loadProjects: async (force?: boolean) => {
      sidebarLoads.push(force);
      context._projectsCache = [{ project_id: 'a', name: 'Loaded later' }];
      return context._projectsCache;
    },
    document: {
      readyState: 'complete',
      addEventListener() {},
      getElementById: (id: string) => elements[id] || null,
      querySelectorAll: () => [],
      createElement: () => ({
        className: '', dataset: {}, innerHTML: '', children: [] as any[], attributes: {} as Record<string, string>,
        click: () => {},
        appendChild(child: any) { this.children.push(child); },
        setAttribute(name: string, value: string) { this.attributes[name] = value; },
        addEventListener(name: string, fn: () => void) { if (name === 'click') this.click = fn; },
      }),
    },
    window: {
      addEventListener() {},
      orkas: { invoke: async () => ({ ok: true, tasks: [{ id: 't1', project_id: 'a' }, { id: 't2' }] }) },
    },
  };
  context.window.window = context.window;
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/icons.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/auto.js'), 'utf8'), context, { filename: 'auto.js' });
  // Device, sync notice, per-task counts and row markup are owned by other cases.
  vm.runInContext(`
    _ensureAutoCurrentDevice = async () => {};
    _refreshAutoSyncNotice = async () => {};
    _autoLoadTaskConversationCounts = async () => {};
    _closeAutoRowMenu = () => {};
    _autoRenderRow = renderTaskRow;
  `, context);
  return {
    context,
    rows,
    create: () => elements['auto-add-btn'].click(),
    sidebarLoads,
    scopeNames: () => scopes.map((scope) => /todo-scope-chip-name">([^<]*)</.exec(scope.innerHTML)?.[1] || ''),
    scopeIcons: () => scopes.map((scope) => /\bis-(folder|globe)\b/.exec(scope.innerHTML)?.[1]),
    activeScope: () => selectedGroup?.dataset.projectId,
    selectScope: (id: string) => scopes.find((scope) => scope.dataset.projectId === id)?.click(),
    clears: () => list.clears,
  };
}

function deferredList() {
  let respond!: (value: { ok: boolean; tasks: Task[] }) => void;
  let notify!: () => void;
  const response = new Promise<{ ok: boolean; tasks: Task[] }>(resolve => { respond = resolve; });
  const started = new Promise<void>(resolve => { notify = resolve; });
  return { started, respond, invoke: () => { notify(); return response; } };
}

describe('automation tab and the sidebar project cache', () => {
  afterEach(() => vi.useRealTimers());

  it('keeps the newer saved automation selected when the earlier lookup finishes last', async () => {
    vi.useFakeTimers();
    const tab = loadAutoTab({ projects: [{ project_id: 'a', name: 'Alpha' }], view: 'auto' });
    await tab.context.loadAutoList(true);
    const older = deferredList();
    const newer = deferredList();
    const requests = [older, newer];
    tab.context.window.orkas.invoke = vi.fn(() => requests.shift()!.invoke());
    const pendingOlder = tab.context.window.focusAutoTaskById('t1');
    await older.started;
    const pendingNewer = tab.context.window.focusAutoTaskById('t2');
    await newer.started;
    const snapshot = { ok: true, tasks: [{ id: 't1', project_id: 'a' }, { id: 't2' }] };
    newer.respond(snapshot);
    expect(await pendingNewer).toBe(true);
    expect(tab.activeScope()).toBe('');
    const highlighted = () => tab.rows().filter((row: any) => row.classList.contains('is-highlighted')).map((row: any) => row.task.id);
    expect(highlighted()).toEqual(['t2']);
    vi.advanceTimersByTime(1000);
    older.respond(snapshot);
    // The existing app-nav caller interprets false as an unavailable-target
    // error. A superseded click is consumed without undoing the newer action.
    expect(await pendingOlder).toBe(true);
    expect(tab.activeScope()).toBe('');
    expect(highlighted()).toEqual(['t2']);
    vi.advanceTimersByTime(1500);
    expect(highlighted()).toEqual([]);
  });

  it.each(['away', 'returned'] as const)('does not focus an old shortcut after navigation is %s', async state => {
    vi.useFakeTimers();
    const tab = loadAutoTab({ projects: [{ project_id: 'a', name: 'Alpha' }], view: 'auto' });
    tab.context._composerNavigationEpoch = 10;
    await tab.context.loadAutoList(true);
    const request = deferredList();
    tab.context.window.orkas.invoke = request.invoke;
    const pending = tab.context.window.focusAutoTaskById('t1');
    await request.started;
    tab.context.currentView = 'project';
    tab.context._composerNavigationEpoch++;
    if (state === 'returned') {
      tab.context.currentView = 'auto';
      tab.context._composerNavigationEpoch++;
    }
    request.respond({ ok: true, tasks: [{ id: 't1', project_id: 'a' }, { id: 't2' }] });
    expect(await pending).toBe(true);
    expect(tab.context.currentView).toBe(state === 'returned' ? 'auto' : 'project');
    expect(tab.activeScope()).toBe('');
    expect(tab.rows().some((row: any) => row.classList.contains('is-highlighted'))).toBe(false);
  });

  it.each([
    ['first visit', null, 't1', 'a'],
    ['another project selected', [{ project_id: 'a', name: 'Alpha' }], 't2', ''],
    ['global scope selected', [{ project_id: 'a', name: 'Alpha' }], 't1', 'a'],
  ] as const)('reveals a saved automation without editing on %s and retains its cue across refresh', async (_name, projects, taskId, scope) => {
    vi.useFakeTimers();
    const tab = loadAutoTab({ projects: projects ? [...projects] : null, view: 'auto' });
    tab.context.recordEditor = vi.fn();
    vm.runInContext('openAutoTaskDialog = recordEditor', tab.context);
    if (projects) {
      await tab.context.loadAutoList(true);
      tab.selectScope(scope ? '' : 'a');
    }

    expect(await tab.context.window.focusAutoTaskById(taskId)).toBe(true);
    expect(tab.activeScope()).toBe(scope);
    expect(tab.rows().filter((row: any) => row.classList.contains('is-highlighted')).map((row: any) => row.task.id)).toEqual([taskId]);
    expect(tab.rows().find((row: any) => row.task.id === taskId).scrollIntoView).toHaveBeenCalledWith({ block: 'center' });
    expect(tab.context.recordEditor).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2000);
    await tab.context.loadAutoList(true);
    const refreshed = tab.rows().find((row: any) => row.task.id === taskId);
    expect(refreshed.classList.contains('is-highlighted')).toBe(true);
    vi.advanceTimersByTime(500);
    expect(refreshed.classList.contains('is-highlighted')).toBe(false);
  });

  it('follows the current assignment and safely handles a removed automation', async () => {
    vi.useFakeTimers();
    const tab = loadAutoTab({ projects: [{ project_id: 'a', name: 'Alpha' }, { project_id: 'b', name: 'Beta' }], view: 'auto' });
    await tab.context.loadAutoList(true);
    tab.context.window.orkas.invoke = async () => ({ ok: true, tasks: [{ id: 't1', project_id: 'b' }, { id: 't2' }] });
    expect(await tab.context.window.focusAutoTaskById('t1')).toBe(true);
    expect(tab.activeScope()).toBe('b');
    expect(await tab.context.window.focusAutoTaskById('missing')).toBe(false);
    expect(await tab.context.window.focusAutoTaskById('')).toBe(false);
    expect(tab.activeScope()).toBe('b');
    vi.advanceTimersByTime(2500);
    expect(tab.rows().some((row: any) => row.classList.contains('is-highlighted'))).toBe(false);
  });

  it('initializes each new draft from the currently selected scope without locking its project', async () => {
    const tab = loadAutoTab({ projects: [{ project_id: 'a', name: 'Alpha' }], view: 'auto' });
    const opened: any[] = [];
    tab.context.recordEditor = (opts: any) => opened.push(JSON.parse(JSON.stringify(opts)));
    vm.runInContext('openAutoTaskDialog = opts => recordEditor(opts)', tab.context);
    await tab.context.loadAutoList(true);
    tab.selectScope('a');
    tab.create();
    tab.selectScope('');
    tab.create();
    tab.selectScope('a');
    await tab.context.loadAutoList(true);
    tab.create();
    expect(opened).toEqual([
      { initialProjectId: 'a' }, { initialProjectId: '' }, { initialProjectId: 'a' },
    ]);
  });

  it('defaults creation to global when the selected automation project is unavailable', async () => {
    const tab = loadAutoTab({ projects: [{ project_id: 'a', name: 'Alpha' }], view: 'auto' });
    tab.context.window.orkas.invoke = async () => ({ ok: true, tasks: [{ id: 'orphan', project_id: 'removed' }] });
    let selected: string | null = null;
    tab.context.projectPicker = { setOptions() {}, setValue(value: string) { selected = value; }, getValue() { return selected; } };
    // Keep the real create entry, dialog initialization and scope validation;
    // unrelated composer, localization and modal painting are covered by E2E.
    vm.runInContext(`
      _autoFormMounted = true;
      _autoProjectSel = projectPicker;
      _autoResetForm = () => {};
      _autoRepaintLabels = () => {};
      _showAutoDialog = () => {};
    `, tab.context);
    await tab.context.loadAutoList(true);
    tab.selectScope('removed');
    expect(tab.activeScope()).toBe('removed');
    tab.create();
    expect(selected).toBe('');
    expect(vm.runInContext('_autoSelectedProjectId()', tab.context)).toBe('');
  });

  it.each([
    ['first visit', null, 't1', 'a'],
    ['another project selected', [{ project_id: 'a', name: 'Alpha' }], 't2', ''],
    ['global scope selected', [{ project_id: 'a', name: 'Alpha' }], 't1', 'a'],
  ] as const)('selects the saved automation scope on %s before opening its editor', async (_name, projects, taskId, scope) => {
    const tab = loadAutoTab({ projects: projects ? [...projects] : null, view: 'auto' });
    const opened: any[] = [];
    tab.context.recordEditor = (task: Task) => opened.push({ task, scope: tab.activeScope() });
    vm.runInContext('openAutoTaskDialog = ({ task }) => recordEditor(task)', tab.context);
    if (projects) {
      await tab.context.loadAutoList(true);
      tab.selectScope(scope ? '' : 'a');
    }

    expect(await tab.context.window.openAutoTaskById(taskId)).toBe(true);

    expect(tab.activeScope()).toBe(scope);
    expect(opened).toEqual([{ task: taskId === 't1' ? { id: 't1', project_id: 'a' } : { id: 't2' }, scope }]);
    await tab.context.loadAutoList(true);
    expect(tab.activeScope()).toBe(scope);
  });

  it('uses the current project assignment and leaves the selection intact for a deleted automation', async () => {
    const tab = loadAutoTab({ projects: [{ project_id: 'a', name: 'Alpha' }, { project_id: 'b', name: 'Beta' }], view: 'auto' });
    const opened: Task[] = [];
    tab.context.recordEditor = (task: Task) => opened.push(task);
    vm.runInContext('openAutoTaskDialog = ({ task }) => recordEditor(task)', tab.context);
    await tab.context.loadAutoList(true);
    tab.selectScope('a');
    tab.context.window.orkas.invoke = async () => ({ ok: true, tasks: [{ id: 't1', project_id: 'b' }, { id: 't2' }] });

    expect(await tab.context.window.openAutoTaskById('t1')).toBe(true);
    expect(tab.activeScope()).toBe('b');
    expect(opened).toEqual([{ id: 't1', project_id: 'b' }]);
    expect(await tab.context.window.openAutoTaskById('missing')).toBe(false);
    expect(tab.activeScope()).toBe('b');
    expect(opened).toHaveLength(1);
  });

  it('groups from the warm project cache without asking the sidebar to repaint', async () => {
    const tab = loadAutoTab({ projects: [{ project_id: 'a', name: 'Alpha' }], view: 'auto' });

    await tab.context.loadAutoList(true);

    expect(tab.sidebarLoads).toEqual([]);
    expect(tab.scopeNames()).toEqual(['auto.global', 'Alpha']);
    expect(tab.activeScope()).toBe('');
    tab.selectScope('a');
    expect(tab.activeScope()).toBe('a');
  });

  it('loads projects through the sidebar once when nothing is cached yet', async () => {
    const tab = loadAutoTab({ projects: null, view: 'auto' });

    await tab.context.loadAutoList(true);

    expect(tab.sidebarLoads).toEqual([undefined]);
    expect(tab.scopeNames()).toEqual(['auto.global', 'Loaded later']);
  });

  it('defers a projects-driven rebuild while the tab is hidden and paints it on the next visit', async () => {
    const tab = loadAutoTab({ projects: [{ project_id: 'a', name: 'Alpha' }], view: 'auto' });
    await tab.context.loadAutoList(true);
    const paintsBefore = tab.clears();

    tab.context.currentView = 'project';
    tab.context._projectsCache[0].name = 'Renamed';
    tab.context.window.refreshAutoProjectGroups();
    expect(tab.clears()).toBe(paintsBefore);
    expect(tab.scopeNames()).toEqual(['auto.global', 'Alpha']);

    tab.context.currentView = 'auto';
    await tab.context.loadAutoList(false);
    expect(tab.clears()).toBe(paintsBefore + 1);
    expect(tab.scopeNames()).toEqual(['auto.global', 'Renamed']);
  });

  it('relabels a group at once when a project is renamed while the tab is visible', async () => {
    const tab = loadAutoTab({ projects: [{ project_id: 'a', name: 'Alpha' }], view: 'auto' });
    await tab.context.loadAutoList(true);

    tab.context._projectsCache[0].name = 'Renamed';
    tab.context.window.refreshAutoProjectGroups();

    expect(tab.scopeNames()).toEqual(['auto.global', 'Renamed']);
  });
});

describe('automation project groups', () => {
  it('puts global tasks first and follows sidebar order without reordering tasks inside a project', () => {
    // The sidebar is the ordering authority, even if its input is not an
    // alphabetic order guessed independently by the automation renderer.
    const projects = Object.freeze([
      { project_id: 'z', name: 'Zulu' },
      { project_id: 'a', name: 'Alpha' },
      { project_id: 'empty', name: 'No automations' },
    ]);
    const tasks = Object.freeze([
      { id: 'a1', project_id: 'a', enabled: false },
      { id: 'global1' },
      { id: 'z2', project_id: 'z' },
      { id: 'global2', project_id: null },
      { id: 'z1', project_id: 'z' },
      { id: 'global3', project_id: '' },
    ]);
    const groups = groupTasks(tasks, projects);
    expect(groups.map(group => group.projectId)).toEqual(['', 'z', 'a']);
    expect(groups.map(group => group.tasks.map(task => task.id))).toEqual([
      ['global1', 'global2', 'global3'], ['z2', 'z1'], ['a1'],
    ]);
    expect(groups[1].name).toBe('Zulu');
    expect(groups[2].tasks[0].enabled).toBe(false);
    expect(groups[1].tasks[0]).toBe(tasks[2]);
  });

  it('keeps unresolved project tasks distinct and moves them into sidebar order when metadata arrives', () => {
    const tasks = [{ id: 'unknown', project_id: 'later' }, { id: 'known', project_id: 'ready' }];
    const partial = groupTasks(tasks, [{ project_id: 'ready', name: 'Project 10' }]);
    expect(partial.map(group => group.projectId)).toEqual(['', 'ready', 'later']);
    expect(partial[0].tasks).toEqual([]);
    expect(partial[2].tasks).toEqual([tasks[0]]);
    const complete = groupTasks(tasks, [
      { project_id: 'later', name: 'Project 2' }, { project_id: 'ready', name: 'Project 10' },
    ]);
    expect(complete.map(group => group.name)).toEqual(['', 'Project 2', 'Project 10']);
    expect(complete.flatMap(group => group.tasks.map(task => task.id))).toEqual(['unknown', 'known']);
    expect(groupTasks([], [])).toEqual([{ projectId: '', name: '', tasks: [] }]);
  });
});
