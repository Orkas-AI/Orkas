import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/todos.js'), 'utf8');
function fixture() {
  let saved = 'status', busy = false;
  const render = vi.fn(), toast = vi.fn();
  const invoke = vi.fn(async (_channel: string, _args?: any): Promise<any> => ({ ok: true, grouping: saved }));
  const ctx = vm.createContext({ currentUserId: 'account-a', currentView: 'todos', setTimeout, clearTimeout,
    document: { readyState: 'loading', addEventListener() {}, getElementById: (id: string) =>
      id === 'todo-editor-modal' ? { classList: { contains: () => busy } } : null },
    window: { orkas: { invoke } }, _projectDetailLog: { warn: vi.fn() }, uiToast: toast, t: String, setView: vi.fn(),
  });
  vm.runInContext(source, ctx);
  ctx._renderGlobalTodos = render;
  return { ctx, render, toast, invoke, mode: () => vm.runInContext('_globalTodoMode', ctx),
    saved: (value: string) => { saved = value; }, busy: (value: boolean) => { busy = value; } };
}

describe('account todo grouping preference', () => {
  it('restores the saved view and keeps it when following a task shortcut', async () => {
    const f = fixture();
    await f.ctx.refreshTodoGroupingFromMain();
    expect(f.mode()).toBe('status');
    f.ctx.focusTodo('project-a', 't_0123456789ab');
    expect(f.mode()).toBe('status');
    expect(f.invoke.mock.calls.map(call => call[0])).toEqual(['prefs.getTodoGrouping']);
  });

  it('defers a remote regroup during editing until the editor closes', async () => {
    const f = fixture();
    await f.ctx.refreshTodoGroupingFromMain();
    f.busy(true); f.saved('project');
    await f.ctx.refreshTodoGroupingFromMain();
    expect(f.mode()).toBe('status');
    f.busy(false); f.ctx._applyPendingTodoGrouping();
    expect(f.mode()).toBe('project');
  });

  it('keeps a remote choice pending while dragging or mutating a task', async () => {
    const f = fixture();
    await f.ctx.refreshTodoGroupingFromMain();
    vm.runInContext('_todoGroupingDragging = true', f.ctx);
    f.saved('project'); await f.ctx.refreshTodoGroupingFromMain();
    expect(f.mode()).toBe('status');
    vm.runInContext('_todoGroupingDragging = false', f.ctx);
    f.ctx._projectTodoMutating = true;
    f.ctx._applyPendingTodoGrouping();
    expect(f.mode()).toBe('status');
    f.ctx._projectTodoMutating = false;
    f.ctx._applyPendingTodoGrouping();
    expect(f.mode()).toBe('project');
  });

  it('serializes rapid choices and rejects a read started before a newer user choice', async () => {
    const f = fixture();
    let resolveRead!: (value: any) => void, resolveWrite!: (value: any) => void;
    f.invoke.mockImplementation(async channel => channel === 'prefs.getTodoGrouping'
      ? new Promise(resolve => { resolveRead = resolve; }) : new Promise(resolve => { resolveWrite = resolve; }));
    const read = f.ctx.refreshTodoGroupingFromMain();
    const write = f.ctx._chooseTodoGrouping('status');
    resolveRead({ ok: true, grouping: 'project' }); await read;
    expect(f.mode()).toBe('status');
    await Promise.resolve();
    const next = f.ctx._chooseTodoGrouping('project');
    resolveWrite({ ok: true, grouping: 'status' }); await write;
    await Promise.resolve();
    resolveWrite({ ok: true, grouping: 'project' }); await next;
    expect(f.invoke.mock.calls.filter(call => call[0] === 'prefs.setTodoGrouping').map(call => call[1].grouping))
      .toEqual(['status', 'project']);
    expect(f.mode()).toBe('project');
  });

  it('does not apply an old account response or reuse its saved selection', async () => {
    const f = fixture();
    let resolve!: (value: any) => void;
    f.invoke.mockImplementationOnce(async () => new Promise(r => { resolve = r; }));
    const old = f.ctx.refreshTodoGroupingFromMain();
    f.ctx.currentUserId = 'account-b'; f.saved('project');
    await f.ctx.refreshTodoGroupingFromMain();
    resolve({ ok: true, grouping: 'status' }); await old;
    expect(f.mode()).toBe('project');
  });

  it('discards unsent writes after switching accounts', async () => {
    const f = fixture();
    let resolve!: (value: any) => void;
    f.invoke.mockImplementationOnce(async () => new Promise(r => { resolve = r; }));
    const first = f.ctx._chooseTodoGrouping('status');
    await Promise.resolve();
    const queued = f.ctx._chooseTodoGrouping('project');
    f.ctx.currentUserId = 'account-b';
    resolve({ ok: true, grouping: 'status' }); await first; await queued;
    expect(f.invoke.mock.calls.filter(call => call[0] === 'prefs.setTodoGrouping')).toHaveLength(1);
    f.saved('project'); await f.ctx.refreshTodoGroupingFromMain();
    expect(f.mode()).toBe('project');
  });

  it('reports a failed save, restores durable state and lets the user retry', async () => {
    const f = fixture(); f.saved('project');
    await f.ctx.refreshTodoGroupingFromMain();
    f.invoke.mockImplementation(async channel => channel === 'prefs.setTodoGrouping'
      ? { ok: false } : { ok: true, grouping: 'project' });
    await f.ctx._chooseTodoGrouping('status');
    expect(f.toast).toHaveBeenCalledWith('project.todo.failed');
    expect(f.mode()).toBe('project');
    f.invoke.mockResolvedValue({ ok: true, grouping: 'status' });
    await f.ctx._chooseTodoGrouping('status');
    expect(f.mode()).toBe('status');
  });
});
