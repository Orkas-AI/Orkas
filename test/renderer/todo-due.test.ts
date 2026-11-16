import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const source = () => fs.readFileSync(path.join(__dirname, '../../src/renderer/modules/todo-due.js'), 'utf8');
function harness(invoke: (...args: any[]) => Promise<any>) {
  const listeners: Record<string, () => void> = {}, pushes: Record<string, (data?: any) => void> = {};
  const marker = (dataset = {}) => ({ dataset, hidden: true, title: '', setAttribute: vi.fn() });
  const entry = marker(), scope = marker({ todoDueScope: 'p' });
  const today = marker({ todoDueDate: '2026-11-07', todoDueStatus: 'todo', todoDueAccount: 'me' });
  const tomorrow = marker({ todoDueDate: '2026-11-08', todoDueStatus: 'review', todoDueAccount: 'me' });
  const warning = vi.fn();
  const context = vm.createContext({ currentUserId: 'me', Date, setTimeout, clearTimeout,
    createLogger: () => ({ warn: warning }), t: (key: string) => key, escapeHtml: String,
    document: { visibilityState: 'visible', addEventListener: (key: string, fn: () => void) => { listeners[key] = fn; },
      getElementById: (id: string) => id === 'todos-due-dot' ? entry : null,
      querySelectorAll: (selector: string) => selector === '[data-todo-due-date]' ? [today, tomorrow] : [scope] },
    window: { addEventListener: (key: string, fn: () => void) => { listeners[key] = fn; },
      orkas: { invoke, onPushEvent: (key: string, fn: (data?: any) => void) => { pushes[key] = fn; } } },
  });
  vm.runInContext(source(), context);
  return { api: context.window.TodoDue, context, listeners, pushes, entry, scope, today, tomorrow, warning };
}
afterEach(() => vi.useRealTimers());
const clock = () => { vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 10, 7, 23, 59)); };

describe('due-day attention', () => {
  it('starts on the local due day, persists when overdue, and excludes completed and invalid local deadlines', () => {
    clock();
    const { api } = harness(async () => ({ tasks: [] }));
    for (const status of ['todo', 'progress', 'review']) {
      expect(api.isDue({ status, due_at: '2026-11-07' })).toBe(true);
      expect(api.isDue({ status, due_at: '2026-11-06' })).toBe(true);
    }
    for (const task of [{ status: 'done', due_at: '2026-11-07' }, { due_at: '2026-11-08' }, {},
      { due_at: '2026-02-30' }]) expect(api.isDue(task)).toBe(false);
  });

  it('updates entry/scope dots after writes, keeps them on viewing, and removes them on completion, clearing or postponing', async () => {
    clock();
    let tasks: any[] = [{ project_id: 'p', status: 'todo', due_at: '2026-11-07' }];
    const invoke = vi.fn(async () => ({ tasks }));
    const h = harness(invoke);
    await h.api.init();
    expect(h.entry.hidden).toBe(false);
    expect(h.scope.hidden).toBe(false);
    h.api.paint();
    expect(h.api.hasScope('p')).toBe(true);
    for (const change of [{ status: 'done', due_at: '2026-11-07' }, { status: 'todo' }, { status: 'todo', due_at: '2026-11-08' }]) {
      tasks = [{ project_id: 'p', ...change }];
      h.pushes['projects:tasks-changed']();
      await vi.advanceTimersByTimeAsync(150);
      expect(h.entry.hidden).toBe(true);
      expect(h.scope.hidden).toBe(true);
    }
    expect(h.warning).not.toHaveBeenCalled();
  });

  it('turns on cached future rows at midnight without polling and rechecks the calendar on foreground', async () => {
    clock();
    const invoke = vi.fn(async () => ({ tasks: [{ project_id: 'p', due_at: '2026-11-08' }] }));
    const h = harness(invoke);
    await h.api.init();
    expect(h.entry.hidden).toBe(true);
    expect(h.today.hidden).toBe(false);
    expect(h.tomorrow.hidden).toBe(true);
    await vi.advanceTimersByTimeAsync(60_100);
    expect(h.entry.hidden).toBe(false);
    expect(h.tomorrow.hidden).toBe(false);
    expect(invoke).toHaveBeenCalledTimes(1);
    vi.setSystemTime(new Date(2026, 10, 6, 12));
    h.listeners.focus();
    expect(h.entry.hidden).toBe(true);
    expect(h.today.hidden).toBe(true);
  });

  it('coalesces event bursts, rejects an old response after a write, and never shows the previous account’s data', async () => {
    clock();
    let resolve!: (value: any) => void;
    const invoke = vi.fn().mockImplementationOnce(() => new Promise(r => { resolve = r; }))
      .mockResolvedValue({ tasks: [] });
    const h = harness(invoke);
    const loading = h.api.init();
    for (let i = 0; i < 50; i++) h.pushes['projects:tasks-changed']();
    h.context.currentUserId = 'other';
    const changed = h.api.init();
    resolve({ tasks: [{ project_id: 'p', due_at: '2026-11-07' }] });
    await Promise.all([loading, changed]);
    expect(h.entry.hidden).toBe(true);
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(h.today.hidden).toBe(true);
    await vi.advanceTimersByTimeAsync(150);
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it('retains the last known attention on a failed read and retries on foreground', async () => {
    clock();
    const invoke = vi.fn().mockResolvedValueOnce({ tasks: [{ project_id: 'p', due_at: '2026-11-07' }] })
      .mockRejectedValueOnce(new Error('unavailable')).mockResolvedValue({ tasks: [] });
    const h = harness(invoke);
    await h.api.init();
    await h.api.refresh();
    expect(h.entry.hidden).toBe(false);
    expect(h.warning).toHaveBeenCalledTimes(1);
    h.listeners.focus();
    await vi.advanceTimersByTimeAsync(150);
    expect(h.entry.hidden).toBe(true);
  });

  it('updates a local project tab from local task changes and clears it when work is removed', async () => {
    clock();
    let tasks: any[] = [{ project_id: 'p', due_at: '2026-11-07' }];
    const h = harness(async () => ({ tasks }));
    const tab = { hidden: true, title: '', setAttribute() {} };
    h.context._projectDetailPid = 'p';
    h.context.document.getElementById = (id: string) => id === 'project-todo-due-dot' ? tab : h.entry;
    await h.api.init();
    expect(tab.hidden).toBe(false);
    tasks = [];
    h.pushes['projects:tasks-changed']();
    await vi.advanceTimersByTimeAsync(150);
    expect(tab.hidden).toBe(true);
    expect(h.entry.hidden).toBe(true);
  });
});
