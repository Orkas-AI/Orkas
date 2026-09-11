import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const source = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/project-detail.js'),
  'utf8',
);

describe('project to-do refresh ordering', () => {
  it('counts every status including collapsed completed tasks and resets for an empty scope', async () => {
    const count = { textContent: '' };
    const list = { innerHTML: '', style: {}, appendChild() {} };
    const context = vm.createContext({
      console,
      createLogger: () => ({ warn() {}, info() {}, error() {} }),
      document: {
        readyState: 'loading',
        addEventListener() {},
        getElementById(id: string) {
          if (id === 'project-todo-count') return count;
          if (id === 'project-todo-list') return list;
          return null;
        },
        createElement() {
          return {
            appendChild() {}, className: '', dataset: {}, style: {},
            setAttribute() {}, addEventListener() {}, classList: { add() {} },
          };
        },
      },
      window: {
        addEventListener() {},
        orkas: {
          async invoke() {
            return { ok: true, tasks: [
              { id: 't_pending', title: 'Plan', status: 'todo' },
              { id: 't_running', title: 'Build', status: 'progress' },
              { id: 't_review', title: 'Review', status: 'review' },
              { id: 't_done', title: 'Delivered', status: 'done' },
            ] };
          },
        },
      },
      escapeHtml: (value: string) => value,
      t: (key: string) => key,
    });
    vm.runInContext(source, context, { filename: 'project-detail.js' });
    vm.runInContext("_projectDetailPid = 'p_test'", context);
    await context._loadProjectTodos('p_test');
    expect(count.textContent).toBe('4');
    vm.runInContext("_todoCollapsed.set('project:p_test:todo', true); _renderProjectTodosList()", context);
    expect(count.textContent).toBe('4');
    await context._loadProjectTodos('');
    expect(count.textContent).toBe('0');
  });

  it('does not let a pre-delete list response restore a deleted task', async () => {
    let resolveOldList: ((value: unknown) => void) | null = null;
    let listCalls = 0;
    const oldList = new Promise((resolve) => { resolveOldList = resolve; });
    const elements: Record<string, any> = {
      'project-todo-list': { innerHTML: '', style: {}, appendChild() {} },
      'project-todo-count': { textContent: '1' },
    };
    const context = vm.createContext({
      console,
      createLogger: () => ({ warn() {}, info() {}, error() {} }),
      document: {
        readyState: 'loading',
        addEventListener() {},
        getElementById(id: string) { return elements[id] || null; },
        createElement() { return { appendChild() {}, className: '', dataset: {}, style: {}, setAttribute() {}, addEventListener() {} }; },
      },
      window: {
        addEventListener() {},
        orkas: {
          invoke(channel: string) {
            if (channel !== 'projects.tasks.list') return Promise.resolve({ ok: true });
            listCalls += 1;
            return listCalls === 1 ? oldList : Promise.resolve({ ok: true, tasks: [] });
          },
        },
      },
      escapeHtml: (value: string) => value,
      t: (key: string) => key,
      uiAlert() {},
      setTimeout,
      clearTimeout,
    });
    vm.runInContext(source, context, { filename: 'project-detail.js' });
    vm.runInContext("_projectDetailPid = 'p_test'", context);
    // Every board paint records the task ids it shows; the fixture elements
    // are inert, so this is the only user-visible trace of a repaint.
    const paints: string[][] = [];
    context.__paints = paints;
    vm.runInContext('_renderTodoBoard = (tasks) => { __paints.push(tasks.map((task) => task.id)); return {}; }', context);

    const initialLoad = vm.runInContext("_loadProjectTodos('p_test')", context);
    const mutation = vm.runInContext("_todoMutate(async () => ({ ok: true }))", context);
    await mutation;

    resolveOldList?.({
      ok: true,
      tasks: [{ id: 't_123456789abc', title: 'stale', status: 'todo' }],
    });
    await initialLoad;

    expect(vm.runInContext('_projectTodos.length', context)).toBe(0);
    // One paint, from the post-mutation reload, showing no task; the stale
    // pre-delete payload never reached the board.
    expect(paints).toEqual([[]]);
    expect(elements['project-todo-count'].textContent).toBe('0');
  });

  it('coalesces a burst of tasks-changed pushes into one list reload', async () => {
    // Main emits one push per task file write; a burst used to reload the
    // full list once per push (2026-08-28 review E1-7).
    let listCalls = 0;
    const context = vm.createContext({
      console,
      createLogger: () => ({ warn() {}, info() {}, error() {} }),
      document: {
        readyState: 'loading',
        addEventListener() {},
        getElementById() { return { innerHTML: '', style: {}, textContent: '', appendChild() {} }; },
        createElement() { return { appendChild() {}, className: '', dataset: {}, style: {}, setAttribute() {}, addEventListener() {} }; },
      },
      window: {
        addEventListener() {},
        orkas: {
          invoke(channel: string) {
            if (channel === 'projects.tasks.list') listCalls += 1;
            return Promise.resolve({ ok: true, tasks: [] });
          },
        },
      },
      currentView: 'project',
      escapeHtml: (value: string) => value,
      t: (key: string) => key,
      uiAlert() {},
      setTimeout,
      clearTimeout,
    });
    vm.runInContext(source, context, { filename: 'project-detail.js' });
    vm.runInContext("_projectDetailPid = 'p_test'; _projectDetailMeta = { project_id: 'p_test' }", context);

    for (let i = 0; i < 4; i += 1) {
      vm.runInContext("_onProjectTasksChanged({ projectId: 'p_test' })", context);
    }
    await new Promise((resolve) => setTimeout(resolve, 260));
    expect(listCalls).toBe(1);
  });
});
