import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import nativeFs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';

const taskLogs = vi.hoisted(() => [] as unknown[][]);
vi.mock('../../../src/main/logger', () => ({
  createLogger: (scope: string) => Object.fromEntries(
    ['info', 'warn', 'error', 'debug'].map((level) => [level, (...args: unknown[]) => {
      if (scope === 'project-tasks') taskLogs.push([level, ...args]);
    }]),
  ),
}));

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
  taskLogs.length = 0;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-ptasks-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../src/main/features/users');
  users.activateUser(TEST_UID);
});

afterEach(async () => {
  try {
    // Yield between Windows cleanup retries so pending IO can close its
    // handles. Synchronous retries block those callbacks and fail with EPERM.
    await fs.promises.rm(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  } finally {
    if (prevWs === undefined) delete process.env.ORKAS_WORKSPACE_ROOT;
    else process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  }
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

function globalTaskFile(tid: string): string {
  return path.join(tmpDir, TEST_UID, 'cloud', 'tasks', `${tid}.json`);
}

function globalAttachDir(tid: string): string {
  return path.join(tmpDir, TEST_UID, 'cloud', 'task_attachments', tid);
}

describe('project_tasks › createTask', () => {
  it('persists a per-task file with a t_ id, default status todo', async () => {
    const { pt, pid } = await setup();
    const r = await pt.createTask(TEST_UID, pid, { content: '  do the thing  ' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.task.id).toMatch(/^t_[a-f0-9]{12}$/);
    expect(r.task.content).toBe('do the thing');
    expect(r.task.status).toBe('todo');
    expect(r.task.created_by).toBe('user');
    const onDisk = JSON.parse(fs.readFileSync(taskFile(pid, r.task.id), 'utf-8'));
    expect(onDisk.id).toBe(r.task.id);
    expect(onDisk.content).toBe('do the thing');
  });

  it('reuses an open task with the same normalized content without changing it', async () => {
    const { pt, pid } = await setup();
    const first = await pt.createTask(TEST_UID, pid, {
      content: 'Ship   Payment Webhook\noriginal detail',
      created_by: 'user',
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const before = fs.readFileSync(taskFile(pid, first.task.id), 'utf-8');

    const duplicate = await pt.createTask(TEST_UID, pid, {
      content: '  ship payment webhook  \noriginal detail',
      created_by: 'agent',
    });

    expect(duplicate).toEqual({ ok: true, task: first.task, alreadyExists: true });
    expect(fs.readFileSync(taskFile(pid, first.task.id), 'utf-8')).toBe(before);
    expect((await pt.listTasks(TEST_UID, pid)).map((task) => task.id)).toEqual([first.task.id]);
  });

  it('treats balanced presentation quotes as the same open task content', async () => {
    const { pt, pid } = await setup();
    const first = await pt.createTask(TEST_UID, pid, { content: '本周完成支付 webhook 重试机制' });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    for (const quoted of [
      '“本周完成支付 webhook 重试机制”',
      '「本周完成支付 webhook 重试机制」',
      '"本周完成支付 webhook 重试机制"',
    ]) {
      const duplicate = await pt.createTask(TEST_UID, pid, { content: quoted, created_by: 'agent' });
      expect(duplicate).toEqual({ ok: true, task: first.task, alreadyExists: true });
    }
    expect(await pt.listTasks(TEST_UID, pid)).toHaveLength(1);
  });

  it('serializes concurrent same-content creates and allows reuse after completion', async () => {
    const { pt, pid } = await setup();
    const [left, right] = await Promise.all([
      pt.createTask(TEST_UID, pid, { content: 'Concurrent task' }),
      pt.createTask(TEST_UID, pid, { content: 'concurrent   task' }),
    ]);
    expect(left.ok && right.ok).toBe(true);
    if (!left.ok || !right.ok) return;
    expect(left.task.id).toBe(right.task.id);
    expect([left.alreadyExists, right.alreadyExists].sort()).toEqual([false, true]);
    expect((await pt.listTasks(TEST_UID, pid))).toHaveLength(1);

    await pt.completeTask(TEST_UID, pid, left.task.id);
    const reopened = await pt.createTask(TEST_UID, pid, { content: 'CONCURRENT TASK' });
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;
    expect(reopened.alreadyExists).toBe(false);
    expect(reopened.task.id).not.toBe(left.task.id);
  });

  it('rejects empty / too-long content, bad status, unknown project', async () => {
    const { pt, pid } = await setup();
    expect((await pt.createTask(TEST_UID, pid, { content: '   ' })).ok).toBe(false);
    const long = await pt.createTask(TEST_UID, pid, { content: 'x'.repeat(pt.TASK_CONTENT_MAX + 5) });
    expect(long.ok).toBe(false);
    if (!long.ok) expect(long.error).toBe('content_too_long');
    const bad = await pt.createTask(TEST_UID, pid, { content: 'ok', status: 'nope' as any });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toBe('bad_status');
    const noproj = await pt.createTask(TEST_UID, 'p_deadbeef0000', { content: 'ok' });
    expect(noproj.ok).toBe(false);
    if (!noproj.ok) expect(noproj.error).toBe('project_not_found');
  });

  it('accepts an owner id that is bound, rejects an unbound one', async () => {
    const { pt, pid } = await setup();
    const ok = await pt.createTask(TEST_UID, pid, { content: 't', owner_agent: 'Researcher', owner_agent_id: BOUND_AGENT });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.task.owner_agent).toBe('Researcher');
      expect(ok.task.owner_agent_id).toBe(BOUND_AGENT);
    }
    const bad = await pt.createTask(TEST_UID, pid, { content: 't2', owner_agent: 'X', owner_agent_id: 'not-bound' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toBe('owner_not_bound');
    // A name-only owner (no id) is tolerated (stored, not bindings-validated).
    const nameOnly = await pt.createTask(TEST_UID, pid, { content: 't3', owner_agent: 'Freeform' });
    expect(nameOnly.ok).toBe(true);
    if (nameOnly.ok) expect(nameOnly.task.owner_agent_id).toBeUndefined();
  });

  it('keeps a due day as a local calendar date, clears it on request, drops a malformed one on read, and lists dated work first', async () => {
    const { pt, pid } = await setup();
    const dated = await pt.createTask(TEST_UID, pid, { content: 'Send the launch email', due_at: '2026-10-25' });
    expect(dated.ok).toBe(true);
    if (!dated.ok) return;
    expect(dated.task.due_at).toBe('2026-10-25');
    expect(pt.taskView(dated.task).due_at).toBe('2026-10-25');
    // A day that does not exist, a time, or a non-date is refused up front.
    for (const bad of ['2026-02-30', '2026-10-25T09:00', 'next Friday', '25/10/2026']) {
      expect(await pt.createTask(TEST_UID, pid, { content: `Bad ${bad}`, due_at: bad })).toEqual({ ok: false, error: 'due_invalid' });
    }
    expect((await pt.createTask(TEST_UID, pid, { content: 'No date', due_at: '' })).ok).toBe(true);
    expect((await pt.getTask(TEST_UID, pid, (await pt.listTasks(TEST_UID, pid)).find((task) => task.content === 'No date')!.id))).not.toHaveProperty('due_at');

    // Update moves the day, an empty string or null clears it, a bad one is refused without changing the task.
    expect((await pt.updateTask(TEST_UID, pid, dated.task.id, { due_at: '2026-11-01' }) as { task: { due_at?: string } }).task.due_at).toBe('2026-11-01');
    expect(await pt.updateTask(TEST_UID, pid, dated.task.id, { due_at: 'soon' })).toEqual({ ok: false, error: 'due_invalid' });
    expect((await pt.getTask(TEST_UID, pid, dated.task.id))?.due_at).toBe('2026-11-01');
    expect((await pt.updateTask(TEST_UID, pid, dated.task.id, { due_at: '' }) as { task: object }).task).not.toHaveProperty('due_at');
    expect((await pt.updateTask(TEST_UID, pid, dated.task.id, { due_at: '2026-11-03' })).ok).toBe(true);
    expect((await pt.updateTask(TEST_UID, pid, dated.task.id, { due_at: null }) as { task: object }).task).not.toHaveProperty('due_at');

    // A hand-edited file with a malformed day still reads as a task without one.
    const raw = JSON.parse(fs.readFileSync(taskFile(pid, dated.task.id), 'utf8'));
    fs.writeFileSync(taskFile(pid, dated.task.id), JSON.stringify({ ...raw, due_at: '2026-13-40' }));
    expect(await pt.getTask(TEST_UID, pid, dated.task.id)).not.toHaveProperty('due_at');

    // The account-wide open list puts dated work first, soonest first, and
    // keeps the most recently touched order for the rest.
    const later = await pt.createTask(TEST_UID, '', { content: 'Later', due_at: '2026-12-01' });
    const soon = await pt.createTask(TEST_UID, '', { content: 'Soon', due_at: '2026-10-22' });
    const fresh = await pt.createTask(TEST_UID, '', { content: 'Fresh and undated' });
    if (!later.ok || !soon.ok || !fresh.ok) throw new Error('fixture failed');
    const open = (await pt.listOpenTasks(TEST_UID)).tasks.map((task) => task.content);
    expect(open.slice(0, 2)).toEqual(['Soon', 'Later']);
    expect(open.slice(2)).toEqual(expect.arrayContaining(['Fresh and undated', 'No date', 'Send the launch email']));
    expect(open.slice(2)).not.toContain('Soon');
  });

  it('validates content length and sanitizes dependency ids deterministically', async () => {
    const { pt, pid } = await setup();
    const tooLong = await pt.createTask(TEST_UID, pid, {
      content: 'x'.repeat(pt.TASK_CONTENT_MAX + 1),
    });
    expect(tooLong).toEqual({ ok: false, error: 'content_too_long' });

    const dependency = await pt.createTask(TEST_UID, pid, { content: 'dependency' });
    if (!dependency.ok) throw new Error('dependency create failed');
    const created = await pt.createTask(TEST_UID, pid, {
      content: 'dependent',
      depends_on: ['bad-id', dependency.task.id, dependency.task.id],
    });
    expect(created.ok).toBe(true);
    if (created.ok) expect(created.task.depends_on).toEqual([dependency.task.id]);

    const noValidDependency = await pt.createTask(TEST_UID, pid, {
      content: 'independent',
      depends_on: ['bad-id'],
    });
    expect(noValidDependency.ok).toBe(true);
    if (noValidDependency.ok) expect(noValidDependency.task).not.toHaveProperty('depends_on');
  });
});

describe('project_tasks › list + progress', () => {
  it('lists all created tasks; empty for unknown project', async () => {
    const { pt, pid } = await setup();
    await pt.createTask(TEST_UID, pid, { content: 'first' });
    await pt.createTask(TEST_UID, pid, { content: 'second' });
    // Order-independent: same-ms creates have no defined creation order (the
    // list is deterministically sorted, but not necessarily by insertion).
    const titles = (await pt.listTasks(TEST_UID, pid)).map((task) => task.content).sort();
    expect(titles).toEqual(['first', 'second']);
    expect(await pt.listTasks(TEST_UID, 'p_unknown00000')).toEqual([]);
  });

  it('computeProgress counts by status + open + done', async () => {
    const { pt, pid } = await setup();
    const a = await pt.createTask(TEST_UID, pid, { content: 'a' });
    const b = await pt.createTask(TEST_UID, pid, { content: 'b' });
    await pt.createTask(TEST_UID, pid, { content: 'c', status: 'todo' });
    if (a.ok) await pt.completeTask(TEST_UID, pid, a.task.id);
    if (b.ok) await pt.updateTask(TEST_UID, pid, b.task.id, { status: 'progress' });
    const prog = pt.computeProgress(await pt.listTasks(TEST_UID, pid));
    expect(prog.total).toBe(3);
    expect(prog.done).toBe(1);
    expect(prog.open).toBe(2); // progress + todo
    expect(prog.by_status.done).toBe(1);
    expect(prog.by_status.todo).toBe(1);
    expect(prog.by_status.progress).toBe(1);
  });

  it('skips a malformed task file instead of throwing', async () => {
    const { pt, pid } = await setup();
    const ok = await pt.createTask(TEST_UID, pid, { content: 'good' });
    expect(ok.ok).toBe(true);
    // A hand-edited / corrupt file with a valid-looking name but bad content.
    fs.writeFileSync(taskFile(pid, 't_ffffffffffff'), '{ not json', 'utf-8');
    fs.writeFileSync(taskFile(pid, 't_000000000000'), JSON.stringify({ id: 't_000000000000' }), 'utf-8'); // no content
    const tasks = await pt.listTasks(TEST_UID, pid);
    expect(tasks.map((t) => t.content)).toEqual(['good']);
  });

  it('normalizes hand-edited records and uses id as the stable same-time tiebreaker', async () => {
    const { pt, pid } = await setup();
    const first = await pt.createTask(TEST_UID, pid, { content: 'first' });
    const second = await pt.createTask(TEST_UID, pid, { content: 'second' });
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

describe('project_tasks › review + decideReview', () => {
  it.each(['project', 'global'] as const)('accepts only one concurrent review decision in %s scope and retains it after reload', async (scope) => {
    const { pt, pid } = await setup();
    const reviewPid = scope === 'project' ? pid : '';
    const created = await pt.createTask(TEST_UID, reviewPid, { content: 'Review concurrent decisions', status: 'review' });
    if (!created.ok) throw new Error('review task fixture failed');
    const decisions = await Promise.all([
      pt.decideReview(TEST_UID, reviewPid, created.task.id, 'approved'),
      pt.decideReview(TEST_UID, reviewPid, created.task.id, 'changes_requested'),
    ]);
    expect(decisions.filter(result => result.ok)).toHaveLength(1);
    expect(decisions.filter(result => !result.ok)).toEqual([{ ok: false, error: 'not_in_review' }]);
    const accepted = decisions.find(result => result.ok);
    if (!accepted?.ok) throw new Error('no review decision accepted');
    vi.resetModules();
    const reloaded = await import('../../../src/main/features/project_tasks');
    expect(await reloaded.getTask(TEST_UID, reviewPid, created.task.id)).toEqual(accepted.task);
    expect(await reloaded.decideReview(TEST_UID, reviewPid, created.task.id, 'approved'))
      .toEqual({ ok: false, error: 'not_in_review' });
  });

  it('review counts as open in progress + by_status', async () => {
    const { pt, pid } = await setup();
    const a = await pt.createTask(TEST_UID, pid, { content: 'a' });
    if (a.ok) await pt.updateTask(TEST_UID, pid, a.task.id, { status: 'review' });
    const prog = pt.computeProgress(await pt.listTasks(TEST_UID, pid));
    expect(prog.total).toBe(1);
    expect(prog.done).toBe(0);
    expect(prog.open).toBe(1);
    expect(prog.by_status.review).toBe(1);
  });

  it('approved → done (+done_at); changes_requested → progress (clears done_at)', async () => {
    const { pt, pid } = await setup();
    const a = await pt.createTask(TEST_UID, pid, { content: 'a' });
    if (!a.ok) return;
    await pt.updateTask(TEST_UID, pid, a.task.id, { status: 'review' });
    const approved = await pt.decideReview(TEST_UID, pid, a.task.id, 'approved');
    expect(approved.ok).toBe(true);
    if (approved.ok) {
      expect(approved.task.status).toBe('done');
      expect(approved.task.done_at).toBeTruthy();
    }

    const b = await pt.createTask(TEST_UID, pid, { content: 'b' });
    if (!b.ok) return;
    await pt.updateTask(TEST_UID, pid, b.task.id, { status: 'review' });
    const changes = await pt.decideReview(TEST_UID, pid, b.task.id, 'changes_requested');
    expect(changes.ok).toBe(true);
    if (changes.ok) {
      expect(changes.task.status).toBe('progress');
      expect(changes.task.done_at).toBeUndefined();
    }
  });

  it('rejects a decision unless the task is review, and on missing task/project', async () => {
    const { pt, pid } = await setup();
    const a = await pt.createTask(TEST_UID, pid, { content: 'a' }); // status todo, not review
    if (!a.ok) return;
    const notReview = await pt.decideReview(TEST_UID, pid, a.task.id, 'approved');
    expect(notReview.ok).toBe(false);
    if (!notReview.ok) expect(notReview.error).toBe('not_in_review');
    expect((await pt.decideReview(TEST_UID, pid, 't_ffffffffffff', 'approved')).ok).toBe(false);
    expect((await pt.decideReview(TEST_UID, 'p_ffffffffffff', a.task.id, 'approved')).ok).toBe(false);
  });

});

describe('project_tasks › cascade', () => {
  it('deleteProject drops the tasks directory with the project', async () => {
    const { projects, pt, pid } = await setup();
    await pt.createTask(TEST_UID, pid, { content: 't' });
    const tasksDir = path.join(tmpDir, TEST_UID, 'cloud', 'projects', pid, 'tasks');
    expect(fs.existsSync(tasksDir)).toBe(true);
    const del = await projects.deleteProject(TEST_UID, pid);
    expect(del.ok).toBe(true);
    expect(fs.existsSync(tasksDir)).toBe(false);
    expect(await pt.listTasks(TEST_UID, pid)).toEqual([]);
  });
});

describe('project_tasks › model task view', () => {

  it('exposes conversation context references without reading history', async () => {
    const { pt, pid } = await setup();
    const created = await pt.createTask(TEST_UID, pid, {
      content: 'continue prior implementation',
      origin_cid: 'chat-origin',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const updated = await pt.updateTask(TEST_UID, pid, created.task.id, {
    });
    expect(updated.ok).toBe(true);

    expect(pt.taskView(updated.ok ? updated.task : created.task)).toMatchObject({
      origin_cid: 'chat-origin',
    });
  });

  it('exposes complete task content and dependencies to the model', async () => {
    const { pt, pid } = await setup();
    const first = await pt.createTask(TEST_UID, pid, { content: 'first' });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const second = await pt.createTask(TEST_UID, pid, {
      content: 'second\nOnly start after first is complete.',
      depends_on: [first.task.id],
    });
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(pt.taskView(second.task)).toMatchObject({
      content: 'second\nOnly start after first is complete.',
      depends_on: [first.task.id],
    });
  });

});

describe('project_tasks › onTasksChanged', () => {
  it('notifies listeners on create, update, and delete so the UI can refresh live', async () => {
    const { pt, pid } = await setup();
    const events: Array<{ uid: string; pid: string }> = [];
    pt.onTasksChanged((e) => events.push(e));

    const created = await pt.createTask(TEST_UID, pid, { content: 'x' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await pt.updateTask(TEST_UID, pid, created.task.id, { status: 'progress' });
    await pt.deleteTask(TEST_UID, pid, created.task.id);

    expect(events).toHaveLength(3);
    expect(events.every((e) => e.uid === TEST_UID && e.pid === pid)).toBe(true);
  });
});

function attachDir(pid: string, tid: string): string {
  return path.join(tmpDir, TEST_UID, 'cloud', 'projects', pid, 'task_attachments', tid);
}

describe('project_tasks › attachments', () => {
  it('opens draft attachments only at their exact local account path', async () => {
    const { pt, pid } = await setup();
    const tid = 't_0123456789ab';
    expect(await pt.uploadTaskAttachment(TEST_UID, pid, tid, 'draft.txt', Buffer.from('Draft bytes'))).toEqual({ ok: true, name: 'draft.txt' });
    const expected = path.join(attachDir(pid, tid), 'draft.txt');
    expect(await pt.resolveTaskAttachmentPath(TEST_UID, pid, tid, 'draft.txt')).toBe(expected);
    for (const name of ['../draft.txt', 'sub/draft.txt', '.hidden', 'missing.txt']) {
      expect(await pt.resolveTaskAttachmentPath(TEST_UID, pid, tid, name)).toBeNull();
    }
    expect(await pt.resolveTaskAttachmentPath('other-account', pid, tid, 'draft.txt')).toBeNull();
    const foreign = path.join(tmpDir, 'outside.txt');
    fs.writeFileSync(foreign, 'Outside bytes');
    fs.unlinkSync(expected);
    fs.symlinkSync(foreign, expected);
    expect(await pt.resolveTaskAttachmentPath(TEST_UID, pid, tid, 'draft.txt')).toBeNull();
    expect(fs.readFileSync(foreign, 'utf8')).toBe('Outside bytes');
  });

  it.each(['global', 'project'])('preserves composer order through %s save, reopen, later uploads and removal', async (scope) => {
    const { pt, pid: projectId } = await setup();
    const pid = scope === 'global' ? '' : projectId;
    const tid = 't_eeeeeeeeeeee';
    const names = ['z-first.png', 'a-second.png', 'm-third.txt'];
    for (const name of [...names].reverse()) {
      expect(await pt.uploadTaskAttachment(TEST_UID, pid, tid, name, Buffer.from(name))).toMatchObject({ ok: true });
    }
    const created = await pt.createTask(TEST_UID, pid, { id: tid, content: 'Compare image 1 and image 2', attachment_order: names } as any);
    expect(created).toMatchObject({ ok: true, task: { attachments: names } });
    expect((await pt.getTask(TEST_UID, pid, tid))?.attachments).toEqual(names);
    expect(await pt.listTaskAttachments(TEST_UID, pid, tid)).toEqual(names);
    await pt.uploadTaskAttachment(TEST_UID, pid, tid, '0-later.txt', Buffer.from('later'));
    expect((await pt.getTask(TEST_UID, pid, tid))?.attachments).toEqual([...names, '0-later.txt']);
    await pt.updateTask(TEST_UID, pid, tid, { content: 'Edited', attachment_order: ['0-later.txt', ...names] } as any);
    await pt.deleteTaskAttachment(TEST_UID, pid, tid, 'a-second.png');
    expect((await pt.getTask(TEST_UID, pid, tid))?.attachments).toEqual(['0-later.txt', 'z-first.png', 'm-third.txt']);
  });

  it('uploads a file, caches the name on the task, and lists it', async () => {
    const { pt, pid } = await setup();
    const created = await pt.createTask(TEST_UID, pid, { content: 'with files' });
    if (!created.ok) throw new Error('seed');
    const tid = created.task.id;

    const up = await pt.uploadTaskAttachment(TEST_UID, pid, tid, 'notes.txt', Buffer.from('hello'));
    expect(up).toMatchObject({ ok: true, name: 'notes.txt' });
    // File on disk + cached on the task JSON + listed.
    expect(fs.readFileSync(path.join(attachDir(pid, tid), 'notes.txt'), 'utf-8')).toBe('hello');
    const task = await pt.getTask(TEST_UID, pid, tid);
    expect(task?.attachments).toEqual(['notes.txt']);
    expect(await pt.listTaskAttachments(TEST_UID, pid, tid)).toEqual(['notes.txt']);
  });

  it('rejects an unsupported type and a path-traversal name', async () => {
    const { pt, pid } = await setup();
    const created = await pt.createTask(TEST_UID, pid, { content: 't' });
    if (!created.ok) throw new Error('seed');
    const tid = created.task.id;
    expect(await pt.uploadTaskAttachment(TEST_UID, pid, tid, 'malware.exe', Buffer.from('x'))).toMatchObject({ ok: false, error: 'unsupported_type' });
    expect(await pt.uploadTaskAttachment(TEST_UID, pid, tid, '../escape.txt', Buffer.from('x'))).toMatchObject({ ok: true, name: 'escape.txt' });
    // The traversal was stripped to a basename inside the task's dir.
    expect(fs.existsSync(path.join(attachDir(pid, tid), 'escape.txt'))).toBe(true);
  });

  it('deletes a file and drops it from the cached list', async () => {
    const { pt, pid } = await setup();
    const created = await pt.createTask(TEST_UID, pid, { content: 't' });
    if (!created.ok) throw new Error('seed');
    const tid = created.task.id;
    await pt.uploadTaskAttachment(TEST_UID, pid, tid, 'a.txt', Buffer.from('1'));
    await pt.uploadTaskAttachment(TEST_UID, pid, tid, 'b.txt', Buffer.from('2'));
    expect(await pt.deleteTaskAttachment(TEST_UID, pid, tid, 'a.txt')).toMatchObject({ ok: true });
    expect(fs.existsSync(path.join(attachDir(pid, tid), 'a.txt'))).toBe(false);
    const task = await pt.getTask(TEST_UID, pid, tid);
    expect(task?.attachments).toEqual(['b.txt']);
  });

  it('create adopts a pre-uploaded draft dir (attachments staged before the task existed)', async () => {
    const { pt, pid } = await setup();
    // Editor pre-allocates a tid and uploads before saving (no task JSON yet).
    const draftTid = 't_aaaaaaaaaaaa';
    const up = await pt.uploadTaskAttachment(TEST_UID, pid, draftTid, 'draft.md', Buffer.from('# hi'));
    expect(up.ok).toBe(true);
    // Draft has no task JSON, so nothing is cached yet.
    expect(await pt.getTask(TEST_UID, pid, draftTid)).toBeNull();
    const created = await pt.createTask(TEST_UID, pid, { content: 'adopt', id: draftTid });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.task.id).toBe(draftTid);
    expect(created.task.attachments).toEqual(['draft.md']);
  });

  it('rejects create with an id that is already taken', async () => {
    const { pt, pid } = await setup();
    const first = await pt.createTask(TEST_UID, pid, { content: 'one' });
    if (!first.ok) throw new Error('seed');
    const dup = await pt.createTask(TEST_UID, pid, { content: 'two', id: first.task.id });
    expect(dup).toMatchObject({ ok: false, error: 'id_taken' });
  });

  it('deletes the attachments dir with the task', async () => {
    const { pt, pid } = await setup();
    const created = await pt.createTask(TEST_UID, pid, { content: 't' });
    if (!created.ok) throw new Error('seed');
    const tid = created.task.id;
    await pt.uploadTaskAttachment(TEST_UID, pid, tid, 'a.txt', Buffer.from('1'));
    expect(fs.existsSync(attachDir(pid, tid))).toBe(true);
    await pt.deleteTask(TEST_UID, pid, tid);
    expect(fs.existsSync(attachDir(pid, tid))).toBe(false);
  });

  it('discardTaskAttachmentDraft drops a draft dir but refuses a live task', async () => {
    const { pt, pid } = await setup();
    const draftTid = 't_bbbbbbbbbbbb';
    await pt.uploadTaskAttachment(TEST_UID, pid, draftTid, 'x.txt', Buffer.from('1'));
    expect(await pt.discardTaskAttachmentDraft(TEST_UID, pid, draftTid)).toMatchObject({ ok: true });
    expect(fs.existsSync(attachDir(pid, draftTid))).toBe(false);
    // A saved task's files must not be discardable through this path.
    const created = await pt.createTask(TEST_UID, pid, { content: 't' });
    if (!created.ok) throw new Error('seed');
    await pt.uploadTaskAttachment(TEST_UID, pid, created.task.id, 'y.txt', Buffer.from('1'));
    expect(await pt.discardTaskAttachmentDraft(TEST_UID, pid, created.task.id)).toMatchObject({ ok: false });
    expect(fs.existsSync(path.join(attachDir(pid, created.task.id), 'y.txt'))).toBe(true);
  });
});

describe('project_tasks › concurrent persistence paths', () => {
  it.each(['project', 'global'] as const)('preserves both task edits and attachment metadata during overlapping writes in %s scope', async (scope) => {
    const { pt, pid } = await setup();
    const taskPid = scope === 'project' ? pid : '';
    const created = await pt.createTask(TEST_UID, taskPid, { content: 'Deliver with attachment' });
    if (!created.ok) throw new Error('task fixture failed');
    const results = await Promise.all([
      pt.uploadTaskAttachment(TEST_UID, taskPid, created.task.id, 'brief.txt', Buffer.from('source brief')),
      pt.updateTask(TEST_UID, taskPid, created.task.id, { status: 'done' }),
    ]);
    expect(results.every(result => result.ok)).toBe(true);
    vi.resetModules();
    const reloaded = await import('../../../src/main/features/project_tasks');
    expect(await reloaded.getTask(TEST_UID, taskPid, created.task.id)).toMatchObject({
      status: 'done', attachments: ['brief.txt'],
    });
    expect(await reloaded.listTaskAttachments(TEST_UID, taskPid, created.task.id)).toEqual(['brief.txt']);
  });

  it('does not resurrect a deleted task when an earlier update finishes', async () => {
    const { pt, pid } = await setup();
    const created = await pt.createTask(TEST_UID, pid, { content: 'Delete while updating' });
    if (!created.ok) throw new Error('task fixture failed');
    const storage = await import('../../../src/main/storage');
    const { syncBuiltinESMExports } = await import('node:module');
    const originalRead = storage.readJson;
    let readCaptured!: () => void;
    let releaseRead!: () => void;
    const captured = new Promise<void>(resolve => { readCaptured = resolve; });
    const release = new Promise<void>(resolve => { releaseRead = resolve; });
    const readSpy = vi.spyOn(storage, 'readJson').mockImplementation(async (file) => {
      const value = await originalRead(file);
      if (file === taskFile(pid, created.task.id)) {
        readCaptured();
        await release;
      }
      return value;
    });
    // Exercise a completed real unlink before the suspended read resumes.
    const unlinkSpy = vi.spyOn(fs.promises, 'unlink').mockImplementation(async (file) => { fs.unlinkSync(file); });
    syncBuiltinESMExports();
    try {
      const updating = pt.updateTask(TEST_UID, pid, created.task.id, { status: 'done' });
      await captured;
      const deleting = pt.deleteTask(TEST_UID, pid, created.task.id);
      releaseRead();
      const [updated, deleted] = await Promise.all([updating, deleting]);
      expect(updated.ok).toBe(true);
      expect(deleted).toEqual({ ok: true });
      expect(fs.existsSync(taskFile(pid, created.task.id))).toBe(false);
      expect(await pt.getTask(TEST_UID, pid, created.task.id)).toBeNull();
    } finally {
      releaseRead();
      readSpy.mockRestore();
      unlinkSpy.mockRestore();
      syncBuiltinESMExports();
    }
  });
});

describe('project_tasks › persistence failure recovery', () => {
  it('keeps the last link on a failed association write and can record the next execution after recovery', async () => {
    const { pt, pid } = await setup();
    const created = await pt.createTask(TEST_UID, pid, { content: 'Keep execution reachable', origin_cid: 'prior-execution' });
    if (!created.ok) throw new Error('task fixture failed');
    const file = taskFile(pid, created.task.id);
    const before = fs.readFileSync(file, 'utf8');
    const changes: unknown[] = [];
    pt.onTasksChanged(event => changes.push(event));
    const rename = nativeFs.promises.rename.bind(nativeFs.promises);
    const spy = vi.spyOn(nativeFs.promises, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === file) throw Object.assign(new Error('injected disk full'), { code: 'ENOSPC' });
      await rename(from, to);
    });
    syncBuiltinESMExports();
    try {
      // Dispatch has already succeeded: backlink failure must not report a
      // failed start or discard the previous durable association.
      await expect(pt.recordTaskExecution(TEST_UID, pid, created.task.id, 'unsaved-execution')).resolves.toBeUndefined();
      expect(fs.readFileSync(file, 'utf8')).toBe(before);
      expect(changes).toEqual([]);
    } finally {
      spy.mockRestore();
      syncBuiltinESMExports();
    }
    await pt.recordTaskExecution(TEST_UID, pid, created.task.id, 'next-execution');
    expect(await pt.getTask(TEST_UID, pid, created.task.id)).toMatchObject({ origin_cid: 'next-execution', status: 'todo' });
    expect(changes).toHaveLength(1);
  });

  it('rejects a failed review write without notification, then releases the lock for independent edits and retry', async () => {
    const { pt, pid } = await setup();
    const created = await pt.createTask(TEST_UID, pid, {
      content: 'Release review\nOriginal brief', status: 'progress', origin_cid: 'original-chat',
    });
    if (!created.ok) throw new Error('task fixture failed');
    const tid = created.task.id;
    const file = taskFile(pid, tid);
    const before = fs.readFileSync(file, 'utf8');
    const changes: unknown[] = [];
    pt.onTasksChanged(event => changes.push(event));
    const rename = nativeFs.promises.rename.bind(nativeFs.promises);
    const fault = Object.assign(new Error('injected disk full'), { code: 'ENOSPC' });
    const spy = vi.spyOn(nativeFs.promises, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === file) throw fault;
      await rename(from, to);
    });
    syncBuiltinESMExports();
    try {
      await expect(pt.updateTask(TEST_UID, pid, tid, { status: 'review' }))
        .rejects.toThrow(fault);
      expect(fs.readFileSync(file, 'utf8')).toBe(before);
      expect(changes).toEqual([]);
      expect(fs.readdirSync(path.dirname(file))).toEqual([`${tid}.json`]);
    } finally {
      spy.mockRestore();
      syncBuiltinESMExports();
    }
    const results = await Promise.all([
      pt.updateTask(TEST_UID, pid, tid, { content: 'Release review\nClarified brief' }),
      pt.updateTask(TEST_UID, pid, tid, { status: 'review' }),
    ]);
    expect(results.every(result => result.ok)).toBe(true);
    vi.resetModules();
    const reloaded = await import('../../../src/main/features/project_tasks');
    expect(await reloaded.listTasks(TEST_UID, pid)).toEqual([expect.objectContaining({
      id: tid, content: 'Release review\nClarified brief', status: 'review', origin_cid: 'original-chat',
    })]);
  });
});

describe('project_tasks › retired status compatibility', () => {
  it.each(['global', 'project'])('rejects retired status writes in %s and retains the current task on failure', async (scope) => {
    const setupResult = await setup();
    const { pt } = setupResult;
    const pid = scope === 'global' ? '' : setupResult.pid;
    const created = await pt.createTask(TEST_UID, pid, { content: 'Active delivery', status: 'progress', origin_cid: 'source-chat' });
    if (!created.ok) throw new Error('task fixture failed');
    const changes: unknown[] = [];
    pt.onTasksChanged(event => changes.push(event));
    for (const status of ['blocked', 'cancelled', 'in_progress', 'in_review']) {
      expect(await pt.createTask(TEST_UID, pid, { content: 'Invalid task', status: status as any }))
        .toEqual({ ok: false, error: 'bad_status' });
      expect(await pt.updateTask(TEST_UID, pid, created.task.id, { content: 'Must not replace', status: status as any }))
        .toEqual({ ok: false, error: 'bad_status' });
    }
    expect(changes).toEqual([]);
    expect(await pt.listTasks(TEST_UID, pid)).toEqual([created.task]);
  });

  it.each(['global', 'project'])('preserves legacy stages and context in %s across reads, edits, and restart', async (scope) => {
    const setupResult = await setup();
    const { pt } = setupResult;
    const pid = scope === 'global' ? '' : setupResult.pid;
    for (const [oldStatus, status] of [
      ['blocked', 'todo'], ['cancelled', 'todo'], ['in_progress', 'progress'], ['in_review', 'review'],
    ]) {
      const created = await pt.createTask(TEST_UID, pid, {
        content: `Legacy delivery ${oldStatus}\nWaiting for input`, origin_cid: 'original-chat',
        depends_on: ['t_aaaaaaaaaaaa'],
      });
      if (!created.ok) throw new Error('task fixture failed');
      const file = pid ? taskFile(pid, created.task.id) : globalTaskFile(created.task.id);
      const legacy = { ...created.task, status: oldStatus, result_ref: 'progress.md', attachments: ['brief.txt'],
        done_at: '2026-01-01T00:00:00.000Z' };
      const originalBytes = JSON.stringify(legacy);
      fs.writeFileSync(file, originalBytes);
      vi.resetModules();
      const reloaded = await import('../../../src/main/features/project_tasks');
      const { done_at: _staleTimestamp, result_ref: _retiredReference, ...context } = legacy;
      const expected = { ...context, status };
      expect(await reloaded.getTask(TEST_UID, pid, created.task.id)).toEqual(expected);
      expect(await reloaded.listTasks(TEST_UID, pid)).toContainEqual(expected);
      expect(reloaded.taskView(expected as any)).toMatchObject({ status, origin_cid: 'original-chat' });
      expect(reloaded.computeProgress([expected as any]))
        .toEqual({ total: 1, open: 1, done: 0, by_status: { todo: 0, progress: 0, review: 0, done: 0, [status]: 1 } });
      expect(fs.readFileSync(file, 'utf8')).toBe(originalBytes);
      expect((await reloaded.updateTask(TEST_UID, pid, created.task.id, { content: 'Input received' })).ok).toBe(true);
      const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
      // Editing advances updated_at; legacy content and its other timestamps survive.
      const { updated_at: previousUpdatedAt, content: _previousContent, ...preservedContext } = expected;
      expect(persisted).toMatchObject({ ...preservedContext, content: 'Input received' });
      expect(Date.parse(persisted.updated_at)).toBeGreaterThanOrEqual(Date.parse(previousUpdatedAt));
      expect(persisted).not.toHaveProperty('done_at');
      expect(persisted).not.toHaveProperty('result_ref');
      vi.resetModules();
      expect(await (await import('../../../src/main/features/project_tasks')).getTask(TEST_UID, pid, created.task.id)).toEqual(persisted);
    }
  });

  it('reopens a cancelled dependency and defers dependent work until it is completed', async () => {
    const { pt, pid } = await setup();
    const dependency = await pt.createTask(TEST_UID, pid, { content: 'Migration', origin_cid: 'original-chat' });
    if (!dependency.ok) throw new Error('dependency fixture failed');
    const dependent = await pt.createTask(TEST_UID, pid, { content: 'Release', depends_on: [dependency.task.id] });
    if (!dependent.ok) throw new Error('dependent fixture failed');
    fs.writeFileSync(taskFile(pid, dependency.task.id), JSON.stringify({ ...dependency.task, status: 'cancelled' }));
    const driver = await import('../../../src/main/features/project_driver');
    const tasks = await pt.listTasks(TEST_UID, pid);
    const reopened = tasks.find(task => task.id === dependency.task.id)!;
    expect(reopened).toMatchObject({ status: 'todo', origin_cid: 'original-chat' });
    expect(pt.computeProgress(tasks)).toEqual({ total: 2, done: 0, open: 2, by_status: { todo: 2, progress: 0, review: 0, done: 0 } });
    expect(driver.nextActionableTask([dependent.task, reopened])?.id).toBe(dependency.task.id);
    expect((await pt.completeTask(TEST_UID, pid, dependency.task.id)).ok).toBe(true);
    expect(driver.nextActionableTask(await pt.listTasks(TEST_UID, pid))?.id).toBe(dependent.task.id);
  });
});

// The single editor must expose every legacy requirement, without writing on
// read or resurrecting discarded fields after an edit/restart.
describe('project_tasks › single content compatibility', () => {
  it.each(['global', 'project'])('migrates a legacy brief losslessly in %s when saved', async (scope) => {
    const { pt, pid: projectId } = await setup();
    const pid = scope === 'global' ? '' : projectId;
    const tid = 't_123456abcdef';
    const file = pid ? taskFile(pid, tid) : globalTaskFile(tid);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const legacy = { id: tid, title: '核对发布', detail: '保留链接与验收条件。\n确认后再处理。', status: 'review',
      owner_agent: 'Researcher', owner_agent_id: BOUND_AGENT, origin_cid: 'source-chat',
      attachments: ['brief.txt'], depends_on: ['t_aaaaaaaaaaaa'], result_ref: 'result.md',
      created_by: 'user', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-02T00:00:00Z' };
    const bytes = JSON.stringify(legacy);
    fs.writeFileSync(file, bytes);
    const content = '核对发布\n保留链接与验收条件。\n确认后再处理。';
    const { title: _title, detail: _detail, result_ref: _retiredReference, ...metadata } = legacy;
    const responsibility = {};
    expect(await pt.getTask(TEST_UID, pid, tid)).toEqual({ ...metadata, ...responsibility, content });
    expect(await pt.listTasks(TEST_UID, pid)).toEqual([{ ...metadata, ...responsibility, content }]);
    expect(fs.readFileSync(file, 'utf8')).toBe(bytes);
    expect((await pt.updateTask(TEST_UID, pid, tid, { content: content + '\n补充检查。' })).ok).toBe(true);
    const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(persisted).toEqual({ ...metadata, ...responsibility, content: content + '\n补充检查。', updated_at: expect.any(String) });
    vi.resetModules();
    const reloaded = await import('../../../src/main/features/project_tasks');
    expect(await reloaded.getTask(TEST_UID, pid, tid)).toEqual(persisted);
    expect((await reloaded.updateTask(TEST_UID, pid, tid, { status: 'done' })).ok).toBe(true);
    expect((await reloaded.getTask(TEST_UID, pid, tid))?.content).toBe(content + '\n补充检查。');
  });

  it('prefers canonical content and rejects invalid replacements without changing storage', async () => {
    const { pt, pid } = await setup();
    const created = await pt.createTask(TEST_UID, pid, { content: 'New brief\n' + '文'.repeat(300), title: 'Obsolete', detail: 'Obsolete detail' });
    if (!created.ok) throw new Error('fixture failed');
    const file = taskFile(pid, created.task.id);
    const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(persisted).not.toHaveProperty('title');
    expect(persisted).not.toHaveProperty('detail');
    fs.writeFileSync(file, JSON.stringify({ ...persisted, title: 'Stale title', detail: 'Stale detail' }));
    expect(await pt.getTask(TEST_UID, pid, created.task.id)).toEqual(persisted);
    const before = fs.readFileSync(file, 'utf8');
    for (const content of ['', '  ', null, 12, 'x'.repeat(4001)]) {
      expect((await pt.updateTask(TEST_UID, pid, created.task.id, { content } as any)).ok).toBe(false);
      expect(fs.readFileSync(file, 'utf8')).toBe(before);
    }
    expect(await pt.updateTask(TEST_UID, pid, created.task.id, { detail: 'Partial old edit' }))
      .toEqual({ ok: false, error: 'content_required_for_update' });
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect((await pt.updateTask(TEST_UID, pid, created.task.id, { content: 'x'.repeat(4000) })).ok).toBe(true);
    expect((await pt.getTask(TEST_UID, pid, created.task.id))?.content).toHaveLength(4000);
  });

  it('accepts old creates and preserves the untouched field of an old partial update', async () => {
    const { pt, pid } = await setup();
    const created = await pt.createTask(TEST_UID, pid, { title: 'Old heading', detail: 'Old requirement' });
    if (!created.ok) throw new Error('fixture failed');
    expect(created.task.content).toBe('Old heading\nOld requirement');
    expect(created.task).not.toHaveProperty('title');
    const file = taskFile(pid, created.task.id);
    const { content: _content, ...metadata } = created.task;
    fs.writeFileSync(file, JSON.stringify({ ...metadata, title: 'Old heading', detail: 'Old requirement' }));
    const updated = await pt.updateTask(TEST_UID, pid, created.task.id, { title: undefined, detail: 'Changed requirement' });
    expect(updated.ok && updated.task.content).toBe('Old heading\nChanged requirement');
    const replacement = await pt.updateTask(TEST_UID, pid, created.task.id, { title: 'Replacement', detail: 'Full legacy replacement' });
    expect(replacement.ok && replacement.task.content).toBe('Replacement\nFull legacy replacement');
  });

  it('retains different requirements even when their first line matches', async () => {
    const { pt, pid } = await setup();
    const first = await pt.createTask(TEST_UID, pid, { content: 'Release\nCheck Linux' });
    const second = await pt.createTask(TEST_UID, pid, { content: 'Release\nCheck Windows' });
    expect(first.ok && second.ok && first.task.id !== second.task.id).toBe(true);
    expect(await pt.listTasks(TEST_UID, pid)).toHaveLength(2);
  });
});
