import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/todos.js'), 'utf8');

function harness() {
  const element = (): any => ({
    children: [], dataset: {}, attributes: {}, handlers: {}, value: '', scrollTop: 0,
    set innerHTML(_: string) { this.children = []; },
    appendChild(child: any) { this.children.push(child); return child; },
    setAttribute(key: string, value: string) { this.attributes[key] = value; },
    addEventListener(key: string, fn: any) { this.handlers[key] = fn; },
    querySelector() { return null; },
  });
  const host = element(), input = element(), invoke = vi.fn();
  const buttons = ['project', 'status'].map(mode => Object.assign(element(), { dataset: { todoGroup: mode } }));
  const context = vm.createContext({
    currentView: 'todos', currentUserId: 'me', setTimeout, clearTimeout, setView() {},
    document: { readyState: 'loading', addEventListener() {}, createElement: element,
      getElementById: (id: string) => id === 'todos-content' ? host : id === 'todos-search' ? input : null,
      querySelectorAll: () => buttons },
    window: { addEventListener() {}, orkas: { invoke } },
    t: (key: string, args?: any) => args?.query ? `${key}: ${args.query}` : key,
    _closeProjectDriverHint() {}, _bindTodoListActions() {},
    _captureTodoScroll: () => ({}), _captureTodoScrollTrack: () => null, _restoreTodoScroll() {},
    _renderTodoCard: (task: any, scope: any) => ({ dataset: { tid: task.id, pid: scope.pid },
      textContent: task.content, scope, status: task.status }),
    _renderGlobalTodoScopeSwitcher: () => element(), _renderGlobalTodoDriverControl: () => element(),
    _mountTodoScrollTrack() {}, _renderTodoBoard: (_: any, scope: any) => ({ normalBoard: true, scope }),
  });
  vm.runInContext(source, context);
  context._renderGlobalTodoScopeSwitcher = () => element();
  context._renderGlobalTodoDriverControl = () => element();
  context._mountTodoScrollTrack = () => {};
  vm.runInContext(`_globalTodoNeedsFullLoad = false;
    _globalTodoActiveScope = 'a';
    _globalTodoGroups = [
      {project:{project_id:'',name:'Global'},tasks:[{id:'same',content:'INVOICE [Q1]',status:'todo'}],agents:[]},
      {project:{project_id:'a',name:'Alpha'},tasks:[{id:'other',content:'Ship release',status:'progress'}],agents:[]},
      {project:{project_id:'b',name:'Beta'},tasks:[{id:'same',content:'invoice [Q1] 已完成',status:'done'}],agents:[]}
    ];`, context);
  context._initGlobalTodos();
  const type = (value: string, event: any = {}) => { input.value = value; input.handlers.input(event); };
  const rows = () => host.children.find((node: any) => node.className?.includes('todo-search-results'))?.children || [];
  return { context, host, input, buttons, invoke, type, rows };
}

describe('To-dos tab keyword search', () => {
  it('finds literal content across projects and global scope, including completed tasks with duplicate ids', () => {
    const h = harness();
    h.type('  Invoice [Q1]  ');
    expect(h.rows().map((row: any) => [row.dataset.pid, row.dataset.tid, row.status]))
      .toEqual([['', 'same', 'todo'], ['b', 'same', 'done']]);
    expect(h.rows().every((row: any) => row.scope.showProject && row.scope.tasks.some((task: any) => task.id === row.dataset.tid))).toBe(true);
    expect(h.buttons.every(button => button.disabled)).toBe(true);
    expect(h.invoke).not.toHaveBeenCalled();
    h.type('已完成');
    expect(h.rows().map((row: any) => row.dataset.pid)).toEqual(['b']);
  });

  it('shows safe no-match feedback and clears back to the prior project board without changing records', () => {
    const h = harness();
    const before = vm.runInContext('JSON.stringify(_globalTodoGroups)', h.context);
    h.type('<missing>');
    expect(h.rows()).toEqual([]);
    expect(h.host.children[0].textContent).toBe('search.no_results: <missing>');
    h.type('');
    const descendants = (node: any): any[] => [node, ...(node.children || []).flatMap(descendants)];
    expect(descendants(h.host).some((node: any) => node.normalBoard && node.scope.pid === 'a')).toBe(true);
    expect(h.buttons.every(button => !button.disabled)).toBe(true);
    expect(vm.runInContext('JSON.stringify(_globalTodoGroups)', h.context)).toBe(before);
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it('waits for IME composition and supports Escape without dropping focus', () => {
    const h = harness();
    h.type('invoice', { isComposing: true });
    expect(h.rows()).toEqual([]);
    h.input.handlers.compositionend();
    expect(h.rows()).toHaveLength(2);
    const preventDefault = vi.fn();
    h.input.handlers.keydown({ key: 'Escape', preventDefault, isComposing: false });
    expect(h.input.value).toBe('');
    expect(h.rows()).toEqual([]);
    expect(preventDefault).toHaveBeenCalledOnce();
  });

  it('refreshes matching task data and bounds each result page while allowing more results', () => {
    const h = harness();
    vm.runInContext(`_globalTodoGroups[1].tasks = Array.from({length:101},(_,i)=>({id:String(i),content:'invoice '+i,status:'review'}));`, h.context);
    h.type('invoice');
    expect(h.rows()).toHaveLength(100);
    h.host.children.find((node: any) => node.textContent === 'search.show_more').handlers.click();
    expect(h.rows()).toHaveLength(103);
    vm.runInContext(`_globalTodoGroups[1].tasks = [{id:'new',content:'invoice refreshed',status:'todo'}];`, h.context);
    h.context._renderGlobalTodos();
    expect(h.rows().map((row: any) => row.textContent)).toContain('invoice refreshed');
    expect(h.rows()).toHaveLength(3);
    h.type('no match');
    h.type('invoice');
    expect(h.invoke).not.toHaveBeenCalled();
  });

  it('distinguishes an unloaded backlog from a verified empty result', () => {
    const h = harness();
    vm.runInContext('_globalTodoGroups = []; _globalTodoNeedsFullLoad = true;', h.context);
    h.type('invoice');
    expect(h.host.children).toEqual([]);
    vm.runInContext('_globalTodoNeedsFullLoad = false;', h.context);
    h.context._renderGlobalTodos();
    expect(h.host.children[0].textContent).toBe('search.no_results: invoice');
  });

  it('clears a stale query when another entry point focuses a specific to-do', () => {
    const h = harness();
    h.type('invoice');
    h.context.focusTodo('a', 'other');
    expect(h.input.value).toBe('');
    expect(vm.runInContext('_globalTodoSearchQuery', h.context)).toBe('');
    expect(JSON.parse(vm.runInContext('JSON.stringify(_globalTodoPendingFocus)', h.context)))
      .toEqual({ pid: 'a', id: 'other' });
  });
});
