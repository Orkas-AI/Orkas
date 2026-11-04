import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/todos.js'), 'utf8');
const projectSource = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/project-detail.js'), 'utf8');

function harness(invoke: (channel: string, args: any) => Promise<any>) {
  const error = { hidden: true };
  const busy: string[] = [];
  const warnings: string[] = [];
  const context = vm.createContext({
    currentView: 'todos', setTimeout, clearTimeout,
    document: {
      readyState: 'loading', addEventListener() {},
      getElementById: (id: string) => id === 'todos-error' ? error : { setAttribute: (_: string, value: string) => busy.push(value) },
    },
    window: { orkas: { invoke } },
    t: (key: string) => key,
    _bindProjectTodos() {},
    _projectDetailLog: { warn: (message: string) => warnings.push(message) },
  });
  vm.runInContext(source, context);
  // This layer owns request ordering/state; real rendering and IPC are covered
  // by todos_e2e_board. Do not let the fixture supply computed task data.
  vm.runInContext('_renderGlobalTodos = () => {}', context);
  return { context, error, warnings, busy, groups: () => JSON.parse(vm.runInContext('JSON.stringify(_globalTodoGroups)', context)) };
}

/** An account with two projects whose task lists the test mutates between
 *  refreshes; every IPC call is recorded as `channel:projectId`. */
function backlogFixture(options: { gate?: (channel: string, args: any) => Promise<void> | void } = {}) {
  const calls: string[] = [];
  const tasks: Record<string, any[]> = {
    '': [],
    a: [{ id: 'a1', title: 'a', status: 'todo' }],
    b: [{ id: 'b1', title: 'b', status: 'todo' }],
  };
  const failing = new Set<string>();
  const h = harness(async (channel, args) => {
    const pid = args?.projectId ?? '';
    calls.push(`${channel}:${pid || '-'}`);
    await options.gate?.(channel, args);
    if (channel === 'projects.list') {
      return { ok: true, projects: [{ project_id: 'a', name: 'Alpha' }, { project_id: 'b', name: 'Beta' }] };
    }
    if (channel === 'agents.list') return { agents: [] };
    if (channel === 'projects.bindings.list') return { ok: true, agentDetails: [{ agent_id: `agent-${pid}` }] };
    if (channel === 'projects.driver.get') return { config: { enabled: false } };
    if (channel === 'projects.tasks.list') {
      if (failing.has(pid)) return { ok: false };
      return { ok: true, tasks: tasks[pid] || [] };
    }
    return { ok: true };
  });
  const sections = () => h.groups().map((group: any) => [group.project.name, group.tasks.map((task: any) => task.status).join(',')]);
  return { ...h, calls, tasks, failing, sections };
}

const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

describe('creating a to-do from the account page', () => {
  it('follows the selected project on each open but uses global in status grouping', async () => {
    const h = backlogFixture();
    await h.context.loadGlobalTodos();
    const opened: any[] = [];
    const listeners: Record<string, () => void> = {};
    h.context.document.getElementById = (id: string) => ({ addEventListener: (_: string, fn: () => void) => { listeners[id] = fn; } });
    h.context.document.querySelectorAll = () => [];
    h.context.window.addEventListener = () => {};
    h.context._bindTodoListActions = () => {};
    h.context._openProjectTodoEditor = (_: any, context: any) => opened.push(context);
    h.context._initGlobalTodos();
    vm.runInContext("_globalTodoActiveScope = 'a'", h.context);
    listeners['todos-add-btn']();
    vm.runInContext("_globalTodoMode = 'status'", h.context);
    listeners['todos-add-btn']();
    vm.runInContext("_globalTodoMode = 'project'", h.context);
    listeners['todos-add-btn']();
    vm.runInContext("_globalTodoActiveScope = 'b'", h.context);
    listeners['todos-add-btn']();
    expect(opened.map(context => context.pid)).toEqual(['a', '', 'a', 'b']);
    expect(opened[0]).toMatchObject({ global: false, agents: [{ agent_id: 'agent-a' }], project: { project_id: 'a', name: 'Alpha' } });
    expect(opened[0].projects.map((project: any) => project.project_id)).toEqual(['a', 'b']);
  });

  it.each([null, '', 'removed'])('falls back to global for unavailable selection %s', async (scope) => {
    const h = backlogFixture();
    await h.context.loadGlobalTodos();
    h.context.selection = scope;
    vm.runInContext(`_globalTodoActiveScope = selection;
      _globalTodoGroups.push({ project: { project_id: 'removed', name: 'Stale' }, tasks: [], agents: [] });`, h.context);
    expect(h.context._globalTodoCreateContext()).toMatchObject({ pid: '', global: true });
  });
});

describe('todo auto-advance device names', () => {
  it.each([['', 'throw'], ['p', 'throw'], ['', 'rejected'], ['p', 'rejected']])(
    'keeps the device name through scope %s loading, regrouping and toggling, retaining it on %s failure', async (pid, failure) => {
    let config: any = { enabled: true, device_id: 'remote', device_name: '<Office Mac>' };
    const device = { id: 'local', name: 'Laptop' };
    let fail = false;
    const writes: any[] = [], buttons: any[] = [], alerts: string[] = [];
    const element = () => ({ dataset: {}, attributes: {} as Record<string, string>, innerHTML: '', textContent: '', disabled: false,
      setAttribute(key: string, value: string) { this.attributes[key] = value; }, addEventListener() {} });
    const context = vm.createContext({
      currentView: 'todos', createLogger: () => ({ warn() {} }),
      document: { readyState: 'loading', addEventListener() {}, createElement: element,
        querySelectorAll: () => buttons, getElementById: () => null },
      window: { addEventListener() {}, orkas: { async invoke(channel: string, args: any) {
        if (channel === 'projects.tasks.list') return { ok: true, tasks: [{ id: 't_one', status: 'todo' }] };
        if (channel === 'projects.bindings.list') return { ok: true, agentDetails: [] };
        if (channel === 'agents.list') return { agents: [] };
        if (channel === 'projects.driver.set') {
          writes.push(args);
          if (fail) {
            if (failure === 'rejected') return { ok: false, config: { enabled: false } };
            throw new Error('fixture write unavailable');
          }
          config = { enabled: args.enabled, ...(args.enabled ? { device_id: device.id, device_name: device.name } : {}) };
        }
        return { config, device };
      } } }, t: String, uiAlert: (message: string) => alerts.push(message),
      escapeHtml: (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    });
    vm.runInContext(projectSource + '\n' + source, context);
    const group = await context._loadGlobalTodoGroup({ project_id: pid, name: 'Scope' });
    const byProject = context._renderGlobalTodoDriverToggle(group, false);
    const byStatus = context._renderGlobalTodoDriverToggle(group, true);
    buttons.push(byProject, byStatus);
    expect(byProject.attributes['aria-label']).toBe('project.driver.toggle · <Office Mac>');
    expect(byStatus.innerHTML).toContain(pid ? 'Scope' : 'todo.global');
    expect(byStatus.innerHTML).toContain('&lt;Office Mac&gt;');
    expect(byStatus.innerHTML).not.toContain('<Office Mac>');
    fail = true;
    await context._toggleGlobalTodoDriver(group);
    expect(byProject.attributes['aria-label']).toBe('project.driver.toggle · <Office Mac>');
    expect(byProject.attributes['aria-pressed']).toBe('true');
    expect(byProject.disabled).toBe(false);
    expect(alerts).toEqual(['project.todo.failed']);
    fail = false;
    await context._toggleGlobalTodoDriver(group);
    expect(byProject.attributes['aria-label']).toBe('project.driver.toggle');
    expect(byStatus.innerHTML).not.toContain('Office Mac');
    await context._toggleGlobalTodoDriver(group);
    expect(byProject.attributes['aria-label']).toBe('project.driver.toggle · auto.device_current');
    expect(byStatus.innerHTML).toContain('auto.device_current');
    expect(byStatus.innerHTML).not.toContain('Laptop');
    expect(byProject.attributes['aria-pressed']).toBe('true');
    expect(writes).toEqual([{ projectId: pid, enabled: false }, { projectId: pid, enabled: false }, { projectId: pid, enabled: true }]);
  });
});

describe('global backlog scope refresh', () => {
  it('reloads only the changed project after a tasks-changed push and keeps the other sections', async () => {
    const f = backlogFixture();
    await f.context.loadGlobalTodos();
    expect(f.sections()).toEqual([['Alpha', 'todo'], ['Beta', 'todo']]);
    f.calls.length = 0;
    f.tasks.b = [{ id: 'b1', title: 'b', status: 'review' }];

    f.context._scheduleGlobalTodosRefresh('b');
    await tick(200);

    expect(f.calls).toEqual(['projects.tasks.list:b', 'projects.bindings.list:b', 'projects.driver.get:b']);
    expect(f.sections()).toEqual([['Alpha', 'todo'], ['Beta', 'review']]);
    expect(f.groups()[1].agents).toEqual([{ agent_id: 'agent-b' }]);
    expect(f.busy.at(-1)).toBe('false');
    expect(f.error.hidden).toBe(true);
  });

  it('splices a new global section first and drops a project whose last task went away', async () => {
    const f = backlogFixture();
    await f.context.loadGlobalTodos();
    f.tasks[''] = [{ id: 'g1', title: 'g', status: 'todo' }];
    await f.context._refreshGlobalTodos('');
    expect(f.sections()).toEqual([['todo.global', 'todo'], ['Alpha', 'todo'], ['Beta', 'todo']]);

    f.tasks.a = [];
    await f.context._refreshGlobalTodos('a');
    expect(f.sections()).toEqual([['todo.global', 'todo'], ['Beta', 'todo']]);
  });

  it.each([
    ['a project the page has not loaded', 'c'],
    ['an account-wide refresh', undefined],
  ])('reloads the whole page for %s', async (_name, scope) => {
    const f = backlogFixture();
    await f.context.loadGlobalTodos();
    f.calls.length = 0;

    if (scope === undefined) await f.context._refreshGlobalTodos();
    else { f.context._scheduleGlobalTodosRefresh(scope); await tick(200); }

    expect(f.calls[0]).toBe('projects.list:-');
    expect(f.sections()).toEqual([['Alpha', 'todo'], ['Beta', 'todo']]);
  });

  it('does not narrow the page to one scope when a push lands before the first full load commits', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let gated = false;
    const f = backlogFixture({
      gate: async (channel, args) => {
        if (channel === 'projects.tasks.list' && args?.projectId === 'a' && !gated) { gated = true; await gate; }
      },
    });
    const first = f.context.loadGlobalTodos();
    await tick();
    f.context._scheduleGlobalTodosRefresh('a');
    release();
    await first;
    await tick(200);

    expect(f.calls.filter((call) => call === 'projects.list:-')).toHaveLength(2);
    expect(f.sections()).toEqual([['Alpha', 'todo'], ['Beta', 'todo']]);
  });

  it('repaints a scope whose reload was superseded by another mutation', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let armed = false;
    const f = backlogFixture({
      gate: async (channel, args) => {
        if (armed && channel === 'projects.tasks.list' && args?.projectId === 'a') { armed = false; await gate; }
      },
    });
    await f.context.loadGlobalTodos();
    armed = true;
    f.tasks.a = [{ id: 'a1', title: 'a', status: 'done' }];
    f.tasks.b = [{ id: 'b1', title: 'b', status: 'progress' }];
    const stalled = f.context._refreshGlobalTodos('a');
    await tick();
    // A mutation elsewhere invalidates the stalled reload, then paints its own scope.
    f.context._invalidateGlobalTodoLoad();
    await f.context._refreshGlobalTodos('b');
    expect(f.sections()).toEqual([['Alpha', 'todo'], ['Beta', 'progress']]);

    release();
    await stalled;
    await tick(20);

    expect(f.sections()).toEqual([['Alpha', 'done'], ['Beta', 'progress']]);
    expect(f.calls.filter((call) => call === 'projects.list:-')).toHaveLength(1);
  });

  it.each(['rejected IPC', 'unsuccessful response'])(
    'recovers a superseded scope after its %s without dropping the other project', async (failure) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let armed = false;
      const f = backlogFixture({
        gate: async (channel, args) => {
          if (!armed || channel !== 'projects.tasks.list' || args?.projectId !== 'a') return;
          armed = false;
          await gate;
          if (failure === 'rejected IPC') throw new Error('transient IPC failure');
        },
      });
      await f.context.loadGlobalTodos();
      armed = true;
      f.tasks.a = [{ id: 'a1', title: 'a', status: 'done' }];
      f.tasks.b = [{ id: 'b1', title: 'b', status: 'progress' }];
      const stalled = f.context._refreshGlobalTodos('a');
      await tick();
      await f.context._refreshGlobalTodos('b');
      expect(f.sections()).toEqual([['Alpha', 'todo'], ['Beta', 'progress']]);

      f.failing.add('a');
      release();
      await stalled;
      f.failing.clear();
      await expect.poll(() => f.sections()).toEqual([['Alpha', 'done'], ['Beta', 'progress']]);
      expect(f.error.hidden).toBe(true);
      expect(f.busy.at(-1)).toBe('false');
      expect(f.calls.filter((call) => call === 'projects.list:-')).toHaveLength(1);
    },
  );

  it('keeps the last painted view when a scope reload fails, then reloads everything on the next change', async () => {
    const f = backlogFixture();
    await f.context.loadGlobalTodos();
    f.failing.add('b');
    await f.context._refreshGlobalTodos('b');
    expect(f.error.hidden).toBe(false);
    expect(f.warnings).toEqual(['load global todos failed']);
    expect(f.sections()).toEqual([['Alpha', 'todo'], ['Beta', 'todo']]);
    expect(f.busy.at(-1)).toBe('false');

    f.failing.clear();
    f.calls.length = 0;
    await f.context._refreshGlobalTodos('b');
    expect(f.calls[0]).toBe('projects.list:-');
    expect(f.error.hidden).toBe(true);
  });
});

describe('global backlog refresh and recovery', () => {
  it('retains the last complete view when one project fails, then retries without duplicating tasks', async () => {
    let fail = false;
    const h = harness(async (channel, args) => {
      if (channel === 'projects.list') return { ok: true, projects: [{ project_id: 'a', name: 'Alpha' }, { project_id: 'b', name: 'Beta' }] };
      if (channel === 'agents.list') return { agents: [] };
      if (channel === 'projects.bindings.list') return { ok: true, agentDetails: [] };
      if (channel === 'projects.tasks.list' && !args.projectId) return { ok: true, tasks: [] };
      if (args.projectId === 'b' && fail) return { ok: false };
      return { ok: true, tasks: [{ id: 'same-id', title: args.projectId, status: fail ? 'review' : 'todo' }] };
    });
    await h.context.loadGlobalTodos();
    expect(h.groups().map((group: any) => [group.project.name, group.tasks[0].title])).toEqual([['Alpha', 'a'], ['Beta', 'b']]);
    fail = true;
    await h.context.loadGlobalTodos();
    expect(h.error.hidden).toBe(false);
    expect(h.warnings).toEqual(['load global todos failed']);
    expect(h.groups().map((group: any) => group.tasks[0].status)).toEqual(['todo', 'todo']);
    fail = false;
    await h.context.loadGlobalTodos();
    expect(h.error.hidden).toBe(true);
    expect(h.groups().flatMap((group: any) => group.tasks)).toHaveLength(2);
    expect(h.busy.at(-1)).toBe('false');
  });

  it('does not let a delayed pre-delete response restore a task after a successful reload', async () => {
    let resolveOld!: (value: any) => void;
    const old = new Promise((resolve) => { resolveOld = resolve; });
    let calls = 0;
    let started!: () => void;
    const firstReadStarted = new Promise<void>((resolve) => { started = resolve; });
    const h = harness(async (channel, args) => {
      if (channel === 'projects.list') return { ok: true, projects: [{ project_id: 'a', name: 'Alpha' }] };
      if (channel === 'agents.list') return { agents: [] };
      if (channel === 'projects.bindings.list') return { ok: true, agentDetails: [] };
      if (channel === 'projects.tasks.list' && !args.projectId) return { ok: true, tasks: [] };
      if (++calls === 1) { started(); return old; }
      return { ok: true, tasks: [] };
    });
    const pending = h.context.loadGlobalTodos();
    await firstReadStarted;
    h.context._invalidateGlobalTodoLoad();
    await h.context.loadGlobalTodos();
    resolveOld({ ok: true, tasks: [{ id: 'removed', title: 'Deleted task' }] });
    await pending;
    expect(h.groups()).toEqual([]);
    expect(h.warnings).toEqual([]);
  });
});

describe('opening a to-do from a shortcut', () => {
  function todoRow(tid: string, columnHidden = false) {
    const classes = new Set<string>();
    const toggle = { expanded: '', setAttribute: (_: string, value: string) => { toggle.expanded = value; } };
    const body = { hidden: columnHidden, parentElement: { querySelector: () => toggle } };
    return {
      dataset: { tid },
      classes,
      toggle,
      body,
      scrolled: 0,
      classList: { add: (name: string) => classes.add(name), remove: (name: string) => classes.delete(name) },
      closest: (selector: string) => (selector === '.todo-column-body' ? body : null),
      scrollIntoView() { this.scrolled += 1; },
    };
  }

  it.each(['project', 'status'])('switches from %s grouping to the to-do scope, reveals and highlights the row once after loading', async (mode) => {
    const f = backlogFixture();
    vm.runInContext(`_globalTodoMode = '${mode}'; _globalTodoActiveScope = 'a'`, f.context);
    const views: any[] = [];
    const other = todoRow('a1');
    const target = todoRow('b1', true);
    const host = {
      setAttribute() {},
      querySelectorAll: (selector: string) => (selector === '.project-todo-item[data-tid]' ? [other, target] : []),
    };
    f.context.setView = (...args: any[]) => { views.push(JSON.parse(JSON.stringify(args))); };
    f.context.document.getElementById = (id: string) => (id === 'todos-error' ? f.error : host);

    f.context.focusTodo('b', 'b1', { entryPoint: 'home' });
    expect(views).toEqual([['todos', null, { entryPoint: 'home' }]]);
    expect(vm.runInContext('_globalTodoMode', f.context)).toBe('project');
    expect(vm.runInContext('_globalTodoActiveScope', f.context)).toBe('b');
    expect(target.classes.size).toBe(0);

    await f.context.loadGlobalTodos();
    expect(target.classes.has('is-highlighted')).toBe(true);
    expect(target.scrolled).toBe(1);
    expect(target.body.hidden).toBe(false);
    expect(target.toggle.expanded).toBe('true');
    expect(other.classes.size).toBe(0);

    // Applied once: a later reload of the page does not jump back to it.
    target.classes.clear();
    await f.context.loadGlobalTodos();
    expect(target.classes.size).toBe(0);
    expect(target.scrolled).toBe(1);
  });

  it('just opens the page when the to-do is gone by the time it loads', async () => {
    const f = backlogFixture();
    const host = { setAttribute() {}, querySelectorAll: () => [] };
    f.context.setView = () => {};
    f.context.document.getElementById = (id: string) => (id === 'todos-error' ? f.error : host);
    f.context.focusTodo('a', 'missing', { entryPoint: 'home' });
    await f.context.loadGlobalTodos();
    expect(f.error.hidden).toBe(true);
    expect(vm.runInContext('_globalTodoPendingFocus', f.context)).toBe(null);
  });

  it('reports a notification target removed between validation and page load', async () => {
    const f = backlogFixture();
    const notices: string[] = [];
    const host = { setAttribute() {}, querySelectorAll: () => [] };
    f.context.setView = () => {};
    f.context.uiToast = (message: string) => notices.push(message);
    f.context.document.getElementById = (id: string) => (id === 'todos-error' ? f.error : host);
    f.context.focusTodo('a', 'missing', { entryPoint: 'todo_notification', reportMissing: true });
    await f.context.loadGlobalTodos();
    expect(notices).toEqual(['todo.notification.unavailable']);
    expect(f.error.hidden).toBe(true);
    await f.context.loadGlobalTodos();
    expect(notices).toHaveLength(1);
  });
});
