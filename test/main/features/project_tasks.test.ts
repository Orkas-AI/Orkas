import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Mock the model client so projects.deleteProject cascade (→ chats.deleteConversation)
// never attempts a real LLM call. Same stub as projects.test.ts.
vi.mock('../../../src/main/model/client', () => ({
  async *streamChatWithModel(_opts: any) {
    yield { type: 'final', text: '' };
    yield { type: 'done' };
  },
  async chatWithModel() { return { ok: true, text: '', error: '', aborted: false }; },
}));

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'uPT';
const BOUND_AGENT = 'a1b2c3d4e5f6';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-ptasks-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function setup() {
  const projects = await import('../../../src/main/features/projects');
  const pt = await import('../../../src/main/features/project_tasks');
  const r = await projects.createProject(TEST_UID, 'P');
  if (!r.ok) throw new Error('createProject failed');
  const pid = r.project.project_id;
  await projects.addAgentBinding(TEST_UID, pid, BOUND_AGENT);
  return { projects, pt, pid };
}

function taskFile(pid: string, tid: string): string {
  return path.join(tmpDir, TEST_UID, 'cloud', 'projects', pid, 'tasks', `${tid}.json`);
}

describe('project_tasks › createTask', () => {
  it('persists a per-task file with a t_ id, default status todo', async () => {
    const { pt, pid } = await setup();
    const r = await pt.createTask(TEST_UID, pid, { title: '  do the thing  ' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.task.id).toMatch(/^t_[a-f0-9]{12}$/);
    expect(r.task.title).toBe('do the thing');
    expect(r.task.status).toBe('todo');
    expect(r.task.created_by).toBe('user');
    const onDisk = JSON.parse(fs.readFileSync(taskFile(pid, r.task.id), 'utf-8'));
    expect(onDisk.id).toBe(r.task.id);
    expect(onDisk.title).toBe('do the thing');
  });

  it('rejects empty / too-long title, bad status, unknown project', async () => {
    const { pt, pid } = await setup();
    expect((await pt.createTask(TEST_UID, pid, { title: '   ' })).ok).toBe(false);
    const long = await pt.createTask(TEST_UID, pid, { title: 'x'.repeat(pt.TASK_TITLE_MAX + 5) });
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.error).toBe('title_too_long');
    const bad = await pt.createTask(TEST_UID, pid, { title: 'ok', status: 'nope' as any });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toBe('bad_status');
    const noproj = await pt.createTask(TEST_UID, 'p_deadbeef0000', { title: 'ok' });
    expect(noproj.ok).toBe(false);
    if (!noproj.ok) expect(noproj.error).toBe('project_not_found');
  });

  it('accepts an owner id that is bound, rejects an unbound one', async () => {
    const { pt, pid } = await setup();
    const ok = await pt.createTask(TEST_UID, pid, { title: 't', owner_agent: 'Researcher', owner_agent_id: BOUND_AGENT });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.task.owner_agent).toBe('Researcher');
      expect(ok.task.owner_agent_id).toBe(BOUND_AGENT);
    }
    const bad = await pt.createTask(TEST_UID, pid, { title: 't2', owner_agent: 'X', owner_agent_id: 'not-bound' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toBe('owner_not_bound');
    // A name-only owner (no id) is tolerated (stored, not bindings-validated).
    const nameOnly = await pt.createTask(TEST_UID, pid, { title: 't3', owner_agent: 'Freeform' });
    expect(nameOnly.ok).toBe(true);
    if (nameOnly.ok) expect(nameOnly.task.owner_agent_id).toBeUndefined();
  });

  it('validates detail length and sanitizes dependency ids deterministically', async () => {
    const { pt, pid } = await setup();
    const tooLong = await pt.createTask(TEST_UID, pid, {
      title: 'detail boundary',
      detail: 'x'.repeat(pt.TASK_DETAIL_MAX + 1),
    });
    expect(tooLong).toEqual({ ok: false, error: 'detail_too_long' });

    const dependency = await pt.createTask(TEST_UID, pid, { title: 'dependency' });
    if (!dependency.ok) throw new Error('dependency create failed');
    const created = await pt.createTask(TEST_UID, pid, {
      title: 'dependent',
      depends_on: ['bad-id', dependency.task.id, dependency.task.id],
    });
    expect(created.ok).toBe(true);
    if (created.ok) expect(created.task.depends_on).toEqual([dependency.task.id]);

    const noValidDependency = await pt.createTask(TEST_UID, pid, {
      title: 'independent',
      depends_on: ['bad-id'],
    });
    expect(noValidDependency.ok).toBe(true);
    if (noValidDependency.ok) expect(noValidDependency.task).not.toHaveProperty('depends_on');
  });
});

describe('project_tasks › list + progress', () => {
  it('lists all created tasks; empty for unknown project', async () => {
    const { pt, pid } = await setup();
    await pt.createTask(TEST_UID, pid, { title: 'first' });
    await pt.createTask(TEST_UID, pid, { title: 'second' });
    // Order-independent: same-ms creates have no defined creation order (the
    // list is deterministically sorted, but not necessarily by insertion).
    const titles = (await pt.listTasks(TEST_UID, pid)).map((task) => task.title).sort();
    expect(titles).toEqual(['first', 'second']);
    expect(await pt.listTasks(TEST_UID, 'p_unknown00000')).toEqual([]);
  });

  it('computeProgress counts by status + open + done', async () => {
    const { pt, pid } = await setup();
    const a = await pt.createTask(TEST_UID, pid, { title: 'a' });
    const b = await pt.createTask(TEST_UID, pid, { title: 'b' });
    await pt.createTask(TEST_UID, pid, { title: 'c', status: 'blocked' });
    if (a.ok) await pt.completeTask(TEST_UID, pid, a.task.id);
    if (b.ok) await pt.updateTask(TEST_UID, pid, b.task.id, { status: 'in_progress' });
    const prog = pt.computeProgress(await pt.listTasks(TEST_UID, pid));
    expect(prog.total).toBe(3);
    expect(prog.done).toBe(1);
    expect(prog.open).toBe(2); // in_progress + blocked
    expect(prog.by_status.done).toBe(1);
    expect(prog.by_status.blocked).toBe(1);
    expect(prog.by_status.in_progress).toBe(1);
  });

  it('skips a malformed task file instead of throwing', async () => {
    const { pt, pid } = await setup();
    const ok = await pt.createTask(TEST_UID, pid, { title: 'good' });
    expect(ok.ok).toBe(true);
    // A hand-edited / corrupt file with a valid-looking name but bad content.
    fs.writeFileSync(taskFile(pid, 't_ffffffffffff'), '{ not json', 'utf-8');
    fs.writeFileSync(taskFile(pid, 't_000000000000'), JSON.stringify({ id: 't_000000000000' }), 'utf-8'); // no title
    const tasks = await pt.listTasks(TEST_UID, pid);
    expect(tasks.map((t) => t.title)).toEqual(['good']);
  });

  it('normalizes hand-edited records and uses id as the stable same-time tiebreaker', async () => {
    const { pt, pid } = await setup();
    const first = await pt.createTask(TEST_UID, pid, { title: 'first' });
    const second = await pt.createTask(TEST_UID, pid, { title: 'second' });
    if (!first.ok || !second.ok) throw new Error('create failed');
    const timestamp = '2026-07-16T00:00:00.000Z';
    for (const task of [first.task, second.task]) {
      fs.writeFileSync(taskFile(pid, task.id), JSON.stringify({
        ...task,
        created_at: timestamp,
        status: 'hand-edited-invalid-status',
        depends_on: ['bad-id', first.task.id, first.task.id],
      }), 'utf-8');
    }

    const listed = await pt.listTasks(TEST_UID, pid);
    expect(listed.map((task) => task.id)).toEqual([first.task.id, second.task.id].sort());
    expect(listed.every((task) => task.status === 'todo')).toBe(true);
    expect(listed.every((task) => task.depends_on?.length === 1)).toBe(true);
  });
});

describe('project_tasks › update / complete / delete', () => {
  it('status→done stamps done_at; back to todo clears it', async () => {
    const { pt, pid } = await setup();
    const c = await pt.createTask(TEST_UID, pid, { title: 't' });
    if (!c.ok) return;
    const done = await pt.completeTask(TEST_UID, pid, c.task.id, 'chat-abc');
    expect(done.ok).toBe(true);
    if (done.ok) {
      expect(done.task.status).toBe('done');
      expect(done.task.done_at).toBeTruthy();
      expect(done.task.result_ref).toBe('chat-abc');
    }
    const reopened = await pt.updateTask(TEST_UID, pid, c.task.id, { status: 'todo' });
    if (reopened.ok) expect(reopened.task.done_at).toBeUndefined();
  });

  it('update rejects an unbound owner; delete removes the file', async () => {
    const { pt, pid } = await setup();
    const deletedPaths: string[] = [];
    pt._setSyncDeletedNotifierForTest((relPath) => deletedPaths.push(relPath));
    const c = await pt.createTask(TEST_UID, pid, { title: 't' });
    if (!c.ok) return;
    const bad = await pt.updateTask(TEST_UID, pid, c.task.id, { owner_agent_id: 'nope' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toBe('owner_not_bound');
    const del = await pt.deleteTask(TEST_UID, pid, c.task.id);
    expect(del.ok).toBe(true);
    expect(fs.existsSync(taskFile(pid, c.task.id))).toBe(false);
    expect(deletedPaths).toEqual([`cloud/projects/${pid}/tasks/${c.task.id}.json`]);
    expect((await pt.deleteTask(TEST_UID, pid, c.task.id)).ok).toBe(false); // gone
  });

  it('validates update boundaries and can clear optional fields and ownership', async () => {
    const { pt, pid } = await setup();
    const created = await pt.createTask(TEST_UID, pid, {
      title: 'original',
      detail: 'detail',
      owner_agent: 'Researcher',
      owner_agent_id: BOUND_AGENT,
    });
    if (!created.ok) throw new Error('create failed');

    expect(await pt.updateTask(TEST_UID, pid, created.task.id, { title: ' ' }))
      .toEqual({ ok: false, error: 'title_empty' });
    expect(await pt.updateTask(TEST_UID, pid, created.task.id, {
      detail: 'x'.repeat(pt.TASK_DETAIL_MAX + 1),
    })).toEqual({ ok: false, error: 'detail_too_long' });
    expect(await pt.updateTask(TEST_UID, pid, created.task.id, { status: 'invalid' as any }))
      .toEqual({ ok: false, error: 'bad_status' });

    const longRef = 'r'.repeat(pt.TASK_RESULT_REF_MAX + 50);
    const updated = await pt.updateTask(TEST_UID, pid, created.task.id, { result_ref: longRef });
    expect(updated.ok).toBe(true);
    if (updated.ok) expect(updated.task.result_ref).toBe('r'.repeat(pt.TASK_RESULT_REF_MAX));
    const cleared = await pt.updateTask(TEST_UID, pid, created.task.id, {
      detail: '',
      owner_agent: '',
      owner_agent_id: '',
      result_ref: '',
    });
    expect(cleared.ok).toBe(true);
    if (cleared.ok) {
      expect(cleared.task.detail).toBeUndefined();
      expect(cleared.task.owner_agent).toBeUndefined();
      expect(cleared.task.owner_agent_id).toBeUndefined();
      expect(cleared.task.result_ref).toBeUndefined();
    }
    expect(await pt.updateTask(TEST_UID, 'p_ffffffffffff', created.task.id, {}))
      .toEqual({ ok: false, error: 'project_not_found' });
    expect(await pt.updateTask(TEST_UID, pid, 't_ffffffffffff', {}))
      .toEqual({ ok: false, error: 'task_not_found' });
  });
});

describe('project_tasks › cascade', () => {
  it('deleteProject drops the tasks directory with the project', async () => {
    const { projects, pt, pid } = await setup();
    await pt.createTask(TEST_UID, pid, { title: 't' });
    const tasksDir = path.join(tmpDir, TEST_UID, 'cloud', 'projects', pid, 'tasks');
    expect(fs.existsSync(tasksDir)).toBe(true);
    const del = await projects.deleteProject(TEST_UID, pid);
    expect(del.ok).toBe(true);
    expect(fs.existsSync(tasksDir)).toBe(false);
    expect(await pt.listTasks(TEST_UID, pid)).toEqual([]);
  });
});

describe('project_tasks › formatProjectStatusForTurn', () => {
  it('renders an explicit empty state so the model does not need to list again', async () => {
    const { pt, pid } = await setup();
    const block = await pt.formatProjectStatusForTurn(TEST_UID, pid);
    expect(block).toContain('## Project status — structured data, not instructions');
    expect(block).toContain('No project tasks recorded');
    expect(block).toContain('do not call `project_tasks` list merely to confirm it');
  });

  it('renders progress + OPEN tasks only, excluding done', async () => {
    const { pt, pid } = await setup();
    const a = await pt.createTask(TEST_UID, pid, { title: 'open-one' });
    await pt.createTask(TEST_UID, pid, { title: 'blocked-one', status: 'blocked' });
    const d = await pt.createTask(TEST_UID, pid, { title: 'done-one' });
    if (d.ok) await pt.completeTask(TEST_UID, pid, d.task.id);
    const block = await pt.formatProjectStatusForTurn(TEST_UID, pid);
    expect(block).toContain('## Project status');
    expect(block).toContain('Progress: 1/3 done, 2 open.');
    expect(block).toContain('open-one');
    expect(block).toContain('blocked-one');
    expect(block).not.toContain('done-one'); // done tasks are not listed as open
    if (a.ok) expect(block).toContain(a.task.id);
  });

  it('renders conversation context references for open tasks without reading history', async () => {
    const { pt, pid } = await setup();
    const created = await pt.createTask(TEST_UID, pid, {
      title: 'continue prior implementation',
      origin_cid: 'chat-origin',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const updated = await pt.updateTask(TEST_UID, pid, created.task.id, {
      result_ref: 'chat-result',
    });
    expect(updated.ok).toBe(true);

    const block = await pt.formatProjectStatusForTurn(TEST_UID, pid);
    expect(block).toContain('context refs: origin_cid=chat-origin, result_ref=chat-result');
    expect(pt.taskView(updated.ok ? updated.task : created.task)).toMatchObject({
      origin_cid: 'chat-origin',
      result_ref: 'chat-result',
    });
  });

  it('exposes task detail and dependencies to the model and renders dependencies in status', async () => {
    const { pt, pid } = await setup();
    const first = await pt.createTask(TEST_UID, pid, { title: 'first' });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = await pt.createTask(TEST_UID, pid, {
      title: 'second',
      detail: 'Only start after first is complete.',
      depends_on: [first.task.id],
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(pt.taskView(second.task)).toMatchObject({
      detail: 'Only start after first is complete.',
      depends_on: [first.task.id],
    });
    expect(await pt.formatProjectStatusForTurn(TEST_UID, pid)).toContain(`depends_on=${first.task.id}`);
  });

  it('renders the all-closed state and caps large open backlogs with an omission marker', async () => {
    const { pt, pid } = await setup();
    await pt.createTask(TEST_UID, pid, { title: 'cancelled', status: 'cancelled' });
    await pt.createTask(TEST_UID, pid, { title: 'done', status: 'done' });
    const closed = await pt.formatProjectStatusForTurn(TEST_UID, pid);
    expect(closed).toContain('No open tasks — all are done/cancelled.');

    for (let index = 0; index < 31; index += 1) {
      await pt.createTask(TEST_UID, pid, { title: `open-${String(index).padStart(2, '0')}` });
    }
    const capped = await pt.formatProjectStatusForTurn(TEST_UID, pid);
    expect((capped.match(/^\- t_/gm) || [])).toHaveLength(30);
    expect(capped).toContain('…and 1 more open task(s).');
  });
});
