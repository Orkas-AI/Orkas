import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const source = fs.readFileSync(
  path.join(__dirname, '../../src/renderer/modules/project-detail.js'),
  'utf8',
);

describe('project to-do refresh ordering', () => {
  it('does not let a pre-delete list response restore a deleted task', async () => {
    let resolveOldList: ((value: unknown) => void) | null = null;
    let listCalls = 0;
    const oldList = new Promise((resolve) => { resolveOldList = resolve; });
    const elements: Record<string, any> = {
      'project-todo-list': { innerHTML: '', style: {}, appendChild() {} },
      'project-todo-empty': { style: {} },
      'project-todo-count': { textContent: '' },
    };
    const context = vm.createContext({
      console,
      createLogger: () => ({ warn() {}, info() {}, error() {} }),
      document: {
        readyState: 'loading',
        addEventListener() {},
        getElementById(id: string) { return elements[id] || null; },
        createElement() { return { appendChild() {}, className: '', dataset: {}, style: {} }; },
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
      t: (key: string) => key,
      uiAlert() {},
      setTimeout,
      clearTimeout,
    });
    vm.runInContext(source, context, { filename: 'project-detail.js' });
    vm.runInContext("_projectDetailPid = 'p_test'", context);

    const initialLoad = vm.runInContext("_loadProjectTodos('p_test')", context);
    const mutation = vm.runInContext("_todoMutate(async () => ({ ok: true }))", context);
    await mutation;

    resolveOldList?.({
      ok: true,
      tasks: [{ id: 't_123456789abc', title: 'stale', status: 'todo' }],
    });
    await initialLoad;

    expect(vm.runInContext('_projectTodos.length', context)).toBe(0);
    expect(elements['project-todo-count'].textContent).toBe('');
    expect(elements['project-todo-empty'].style.display).toBe('');
  });
});
