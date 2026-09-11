import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let root: string;
let previous: string | undefined;
const uid = 'automation-tool-user';
let tasks: typeof import('../../../src/main/features/auto_tasks');
let createTool: typeof import('../../../src/main/features/auto_tasks_tool').createAutoTasksTool;
let pid: string;
let other: string;
beforeEach(async () => {
  previous = process.env.ORKAS_WORKSPACE_ROOT;
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-auto-tool-'));
  process.env.ORKAS_WORKSPACE_ROOT = root;
  vi.resetModules();
  (await import('../../../src/main/features/users')).activateUser(uid);
  const projects = await import('../../../src/main/features/projects');
  const a = await projects.createProject(uid, 'Current');
  const b = await projects.createProject(uid, 'Other');
  if (!a.ok || !b.ok) throw new Error('fixture failed');
  pid = a.project.project_id; other = b.project.project_id;
  tasks = await import('../../../src/main/features/auto_tasks');
  createTool = (await import('../../../src/main/features/auto_tasks_tool')).createAutoTasksTool;
});
afterEach(() => {
  tasks?.stopScheduler();
  if (previous === undefined) delete process.env.ORKAS_WORKSPACE_ROOT; else process.env.ORKAS_WORKSPACE_ROOT = previous;
  fs.rmSync(root, { recursive: true, force: true });
});
const draft = { content: 'Prepare the daily report', schedule: { type: 'daily', hour: 9, minute: 0 }, enabled: false };
const run = async (tool: ReturnType<typeof createTool>, args: Record<string, unknown>) => {
  const result = await tool.execute(args, { state: {} });
  return { ...JSON.parse(result.content), isError: !!result.isError };
};

describe('auto_tasks shared tool', () => {
  it('pages filtered summaries and retrieves complete long content without changing saved schedules', async () => {
    const tool = createTool({ userId: uid, projectId: pid });
    expect(await run(tool, { action: 'list' })).toMatchObject({ tasks: [], total: 0, next_offset: null });
    const content = '自动化详细说明'.repeat(1000);
    const saved = [];
    for (let i = 0; i < 75; i++) {
      const created = await tasks.createTask(uid, { ...draft, content, title: `${i}-${'长'.repeat(180)}`, schedule: draft.schedule as any, end_condition: { type: 'count', max_runs: 4 }, project_id: pid, enabled: i % 2 === 0 });
      if (!created.ok) throw new Error('fixture failed');
      saved.push(created.task);
    }
    const first = await run(tool, { action: 'list' });
    expect(first.tasks).toHaveLength(20);
    expect(first).toMatchObject({ total: 75, next_offset: 20 });
    const received: string[] = [];
    let offset: number | null = 0;
    let pages = 0;
    do {
      const page = await run(tool, { action: 'list', offset, limit: 50, enabled: true });
      expect(page.isError).toBe(false);
      expect(page.total).toBe(38);
      expect(page.tasks.length).toBeGreaterThan(0);
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(33_000);
      for (const item of page.tasks) {
        expect(item.enabled).toBe(true);
        expect(item).toMatchObject({ end_condition: { type: 'count', max_runs: 4 }, scheduled_run_count: 0 });
        expect(item).not.toHaveProperty('content');
        expect(item).not.toHaveProperty('message_parts');
        expect(item.content_preview).toBe(content.slice(0, 200));
      }
      received.push(...page.tasks.map((task: any) => task.id));
      if (page.next_offset !== null) expect(page.next_offset).toBe(offset + page.tasks.length);
      offset = page.next_offset;
      expect(++pages).toBeLessThan(5);
    } while (offset !== null);
    expect(pages).toBeGreaterThan(1); // Byte ceiling, even though the count is below 50.
    expect(new Set(received).size).toBe(38);
    expect(new Set(received)).toEqual(new Set(saved.filter(task => task.enabled).map(task => task.id)));
    expect(await run(tool, { action: 'list', enabled: false, offset: 37 })).toMatchObject({ tasks: [], total: 37, next_offset: null });
    expect(await run(tool, { action: 'list', offset: 999 })).toMatchObject({ tasks: [], total: 75, next_offset: null });
    const detail = await run(tool, { action: 'get', task_id: saved[0].id });
    expect(detail.task.content).toBe(content);
    expect(detail.task).not.toHaveProperty('device_id');
    expect(await tasks.getTask(uid, saved[0].id)).toEqual(saved[0]);
    await tasks.deleteTask(uid, saved[0].id);
    expect(await run(tool, { action: 'get', task_id: saved[0].id })).toMatchObject({ isError: true, error: 'task_not_found' });
  });

  it('creates, partially edits, pauses, resumes, and deletes a project schedule without claiming execution', async () => {
    const tool = createTool({ userId: uid, projectId: pid, cid: 'current-chat' });
    expect((tool.inputSchema as any).properties).not.toHaveProperty('project_id');
    const created = await run(tool, { action: 'create', ...draft });
    expect(created).toMatchObject({ ok: true, kind: 'created', task: { project_id: pid, enabled: false } });
    const id = created.taskId;
    expect(await tasks.getTask(uid, id)).not.toHaveProperty('last_run_at');
    expect(await run(tool, { action: 'update', task_id: id, title: 'Morning report' })).toMatchObject({ ok: true });
    expect(await tasks.getTask(uid, id)).toMatchObject({ title: 'Morning report', content: draft.content, schedule: draft.schedule });
    expect(await run(tool, { action: 'enable', task_id: id })).toMatchObject({ ok: true, task: { enabled: true } });
    expect(await run(tool, { action: 'disable', task_id: id })).toMatchObject({ ok: true, task: { enabled: false } });
    expect(await run(tool, { action: 'list' })).toMatchObject({ ok: true, tasks: [{ id }], next_offset: null });
    expect(await run(tool, { action: 'delete', task_id: id })).toMatchObject({ ok: true });
    expect(await tasks.getTask(uid, id)).toBeNull();
  });

  it('rejects foreign and global ids, scope overrides, malformed fields, and stale project ownership', async () => {
    const tool = createTool({ userId: uid, projectId: pid });
    const foreign = await tasks.createTask(uid, { ...draft, schedule: draft.schedule as any, project_id: other });
    const global = await tasks.createTask(uid, { ...draft, schedule: draft.schedule as any });
    const otherUser = await tasks.createTask('other-user', { ...draft, schedule: draft.schedule as any });
    if (!foreign.ok || !global.ok || !otherUser.ok) throw new Error('fixture failed');
    for (const [owner, id] of [[uid, foreign.task.id], [uid, global.task.id], ['other-user', otherUser.task.id]]) {
      for (const action of ['get', 'update', 'delete', 'enable', 'disable']) {
        expect((await run(tool, { action, task_id: id, ...(action === 'update' ? { title: 'forbidden' } : {}) })).isError).toBe(true);
      }
      expect(await tasks.getTask(owner, id)).toMatchObject({ content: draft.content, enabled: false });
    }
    for (const args of [
      { action: 'create', ...draft, project_id: other },
      { action: 'create', ...draft, project_id: null },
      { action: 'create', ...draft, userId: 'foreign' },
      { action: 'create', ...draft, schedule: { type: 'daily', hour: 24, minute: 0 } },
      { action: 'create', content: draft.content },
      { action: 'list', limit: 51 },
      { action: 'list', limit: 0 },
      { action: 'list', offset: -1 },
      { action: 'list', offset: Number.MAX_SAFE_INTEGER + 1 },
      { action: 'list', enabled: 'false' },
      { action: 'list', task_id: global.task.id },
      { action: 'get', task_id: global.task.id, offset: 0 },
      { action: 'get' },
    ]) expect((await run(tool, args)).isError).toBe(true);
    expect(await tasks.listTasks(uid, { projectId: pid })).toEqual([]);
    const created = await run(tool, { action: 'create', ...draft });
    await tasks.updateTask(uid, created.taskId, { project_id: other });
    expect((await run(tool, { action: 'enable', task_id: created.taskId })).isError).toBe(true);
    expect(await tasks.getTask(uid, created.taskId)).toMatchObject({ project_id: other, enabled: false });
  });

  it('binds the legacy Commander mutation path and enforces write scope inside storage locks', async () => {
    const created = await tasks.applyAutoTaskContainerFromCommander(uid, { action: 'create', updates: draft as any }, { projectId: pid });
    expect(created.task?.project_id).toBe(pid);
    const id = created.taskId!;
    expect((await tasks.updateTask(uid, id, { title: 'forbidden' }, other)).ok).toBe(false);
    expect((await tasks.setTaskEnabled(uid, id, true, other)).ok).toBe(false);
    expect((await tasks.deleteTask(uid, id, other)).ok).toBe(false);
    expect((await tasks.applyAutoTaskContainerFromCommander(uid, { action: 'update', taskId: id, updates: { project_id: null } as any }, { projectId: pid })).ok).toBe(false);
    expect(await tasks.getTask(uid, id)).toMatchObject({ project_id: pid, content: draft.content, enabled: false });
  });

  it('keeps unbound Commander explicit project selection and global schedules compatible', async () => {
    const tool = createTool({ userId: uid });
    const a = await run(tool, { action: 'create', ...draft, project_id: pid });
    const b = await run(tool, { action: 'create', ...draft });
    expect(a.task.project_id).toBe(pid);
    expect(b.task).not.toHaveProperty('project_id');
    expect((await run(tool, { action: 'list', project_id: pid })).tasks.map((t: any) => t.id)).toEqual([a.taskId]);
    expect((await run(tool, { action: 'list', project_id: null })).tasks.map((t: any) => t.id)).toEqual([b.taskId]);
  });
});
