import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/todos.js'), 'utf8');

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
      return { ok: true, projects: [{ project_id: 'b', name: 'Beta' }, { project_id: 'a', name: 'Alpha' }] };
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
      if (channel === 'projects.list') return { ok: true, projects: [{ project_id: 'b', name: 'Beta' }, { project_id: 'a', name: 'Alpha' }] };
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
