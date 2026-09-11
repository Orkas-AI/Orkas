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

function globalTaskFile(tid: string): string {
  return path.join(tmpDir, TEST_UID, 'cloud', 'tasks', `${tid}.json`);
}

function globalAttachDir(tid: string): string {
  return path.join(tmpDir, TEST_UID, 'cloud', 'task_attachments', tid);
}

describe('project_tasks › global scope', () => {
  it('records attachment success and disk failure without disclosing the local identity or filename', async () => {
    const pt = await import('../../../src/main/features/project_tasks');
    const tid = 't_aabbccddeeff';
    const filename = 'private-client-brief.txt';
    expect(await pt.uploadTaskAttachment(TEST_UID, '', tid, filename, Buffer.from('private content')))
      .toEqual({ ok: true, name: filename });
    fs.unlinkSync(path.join(globalAttachDir(tid), filename));
    fs.mkdirSync(path.join(globalAttachDir(tid), filename));
    expect(await pt.uploadTaskAttachment(TEST_UID, '', tid, filename, Buffer.from('private content')))
      .toEqual({ ok: false, error: 'write_failed' });
    expect(taskLogs).toEqual([
      ['info', 'attachment uploaded', expect.objectContaining({
        bytes: 15, attachment: expect.objectContaining({ path_hash: expect.stringMatching(/^[a-f0-9]{12}$/) }),
      })],
      ['warn', 'attachment upload', expect.objectContaining({
        error: expect.objectContaining({ message_hash: expect.stringMatching(/^[a-f0-9]{12}$/), message_chars: expect.any(Number) }),
      })],
    ]);
    const output = JSON.stringify(taskLogs);
    for (const secret of [TEST_UID, tid, filename, tmpDir, 'private content']) expect(output).not.toContain(secret);
  });

  it('isolates identical task ids and attachment names across accounts and scopes after reload', async () => {
    const { pt, projects, pid } = await setup();
    const other = await projects.createProject(TEST_UID, 'Other project');
    if (!other.ok) throw new Error('project fixture failed');
    const tid = 't_aabbccddeeff';
    const scopes = [
      { uid: TEST_UID, pid: '', title: 'Global reminder' },
      { uid: TEST_UID, pid, title: 'Project reminder' },
      { uid: TEST_UID, pid: other.project.project_id, title: 'Other project reminder' },
      { uid: 'other-account', pid: '', title: 'Private reminder' },
    ];
    for (const scope of scopes) {
      expect((await pt.uploadTaskAttachment(scope.uid, scope.pid, tid, 'brief.txt', Buffer.from(scope.title))).ok).toBe(true);
      expect((await pt.createTask(scope.uid, scope.pid, { id: tid, title: scope.title })).ok).toBe(true);
    }

    vi.resetModules();
    const reloaded = await import('../../../src/main/features/project_tasks');
    const paths = await import('../../../src/main/paths');
    expect((await reloaded.updateTask(TEST_UID, pid, tid, { status: 'done' })).ok).toBe(true);
    expect((await reloaded.deleteTask(TEST_UID, '', tid)).ok).toBe(true);
    expect(await reloaded.listTasks(TEST_UID, '')).toEqual([]);
    expect(await reloaded.listTaskAttachments(TEST_UID, '', tid)).toEqual([]);
    for (const scope of scopes.slice(1)) {
      expect(await reloaded.listTasks(scope.uid, scope.pid)).toEqual([
        expect.objectContaining({ id: tid, title: scope.title,
          status: scope.pid === pid ? 'done' : 'todo', attachments: ['brief.txt'] }),
      ]);
      const dir = scope.pid
        ? paths.projectTaskAttachmentsDir(scope.uid, scope.pid, tid)
        : paths.userTaskAttachmentsDir(scope.uid, tid);
      expect(fs.readFileSync(path.join(dir, 'brief.txt'), 'utf8')).toBe(scope.title);
    }
  });

  it('persists, updates, attaches, and deletes a to-do without any project', async () => {
    const pt = await import('../../../src/main/features/project_tasks');
    const deletedPaths: string[] = [];
    const events: Array<{ uid: string; pid: string }> = [];
    pt._setSyncDeletedNotifierForTest((relPath) => deletedPaths.push(relPath));
    pt.onTasksChanged((event) => events.push(event));

    // The editor can stage files before the task JSON exists, even for users
    // who have no projects at all.
    const tid = 't_aaaaaaaaaaaa';
    expect(await pt.uploadTaskAttachment(TEST_UID, '', tid, 'brief.txt', Buffer.from('global')))
      .toMatchObject({ ok: true, name: 'brief.txt' });
    const created = await pt.createTask(TEST_UID, '', { id: tid, title: 'Account-wide reminder' });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.task.attachments).toEqual(['brief.txt']);
    expect(fs.existsSync(globalTaskFile(tid))).toBe(true);
    expect(fs.readFileSync(path.join(globalAttachDir(tid), 'brief.txt'), 'utf-8')).toBe('global');
    expect((await pt.listTasks(TEST_UID, '')).map((task) => task.id)).toEqual([tid]);

    const updated = await pt.updateTask(TEST_UID, '', tid, { status: 'progress' });
    expect(updated.ok && updated.task.status).toBe('progress');
    expect(await pt.createTask(TEST_UID, '', { title: 'Cannot assign globally', owner_agent: 'Agent' }))
      .toEqual({ ok: false, error: 'owner_not_bound' });

    expect(await pt.deleteTask(TEST_UID, '', tid)).toEqual({ ok: true });
    expect(fs.existsSync(globalTaskFile(tid))).toBe(false);
    expect(fs.existsSync(globalAttachDir(tid))).toBe(false);
    expect(deletedPaths).toEqual([`cloud/tasks/${tid}.json`]);
    expect(events).toEqual([
      { uid: TEST_UID, pid: '' },
      { uid: TEST_UID, pid: '' },
      { uid: TEST_UID, pid: '' },
    ]);
  });
});

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

  it('reuses an open task with the same normalized title without changing it', async () => {
    const { pt, pid } = await setup();
    const first = await pt.createTask(TEST_UID, pid, {
      title: 'Ship   Payment Webhook',
      detail: 'original detail',
      created_by: 'user',
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const before = fs.readFileSync(taskFile(pid, first.task.id), 'utf-8');

    const duplicate = await pt.createTask(TEST_UID, pid, {
      title: '  ship payment webhook  ',
      detail: 'must not overwrite the original',
      created_by: 'agent',
    });

    expect(duplicate).toEqual({ ok: true, task: first.task, alreadyExists: true });
    expect(fs.readFileSync(taskFile(pid, first.task.id), 'utf-8')).toBe(before);
    expect((await pt.listTasks(TEST_UID, pid)).map((task) => task.id)).toEqual([first.task.id]);
  });

  it('treats balanced presentation quotes as the same open task title', async () => {
    const { pt, pid } = await setup();
    const first = await pt.createTask(TEST_UID, pid, { title: '本周完成支付 webhook 重试机制' });
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    for (const quoted of [
      '“本周完成支付 webhook 重试机制”',
      '「本周完成支付 webhook 重试机制」',
      '"本周完成支付 webhook 重试机制"',
    ]) {
      const duplicate = await pt.createTask(TEST_UID, pid, { title: quoted, created_by: 'agent' });
      expect(duplicate).toEqual({ ok: true, task: first.task, alreadyExists: true });
    }
    expect(await pt.listTasks(TEST_UID, pid)).toHaveLength(1);
  });

  it('serializes concurrent same-title creates and allows reuse after completion', async () => {
    const { pt, pid } = await setup();
    const [left, right] = await Promise.all([
      pt.createTask(TEST_UID, pid, { title: 'Concurrent task' }),
      pt.createTask(TEST_UID, pid, { title: 'concurrent   task' }),
    ]);
    expect(left.ok && right.ok).toBe(true);
    if (!left.ok || !right.ok) return;
    expect(left.task.id).toBe(right.task.id);
    expect([left.alreadyExists, right.alreadyExists].sort()).toEqual([false, true]);
    expect((await pt.listTasks(TEST_UID, pid))).toHaveLength(1);

    await pt.completeTask(TEST_UID, pid, left.task.id);
    const reopened = await pt.createTask(TEST_UID, pid, { title: 'CONCURRENT TASK' });
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;
    expect(reopened.alreadyExists).toBe(false);
    expect(reopened.task.id).not.toBe(left.task.id);
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
    await pt.createTask(TEST_UID, pid, { title: 'c', status: 'todo' });
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
  it('rejects a stale status transition without changing the newer result or notifying a false update', async () => {
    const { pt, pid } = await setup();
    const created = await pt.createTask(TEST_UID, pid, { title: 'Already reviewed' });
    if (!created.ok) throw new Error('task fixture failed');
    const completed = await pt.completeTask(TEST_UID, pid, created.task.id, 'verified-result');
    if (!completed.ok) throw new Error('completion fixture failed');
    const events: unknown[] = [];
    pt.onTasksChanged((event) => events.push(event));
    const rejected = await pt.updateTask(TEST_UID, pid, created.task.id,
      { status: 'progress', result_ref: '' }, { expectedStatus: 'todo' });
    expect(rejected).toEqual({ ok: false, error: 'status_conflict' });
    expect(await pt.getTask(TEST_UID, pid, created.task.id)).toEqual(completed.task);
    expect(events).toEqual([]);
    // A deliberate manual reopen still works; only the stale conditional
    // operation is rejected, not the user's ordinary status control.
    expect((await pt.updateTask(TEST_UID, pid, created.task.id, { status: 'todo' })).ok).toBe(true);
    expect(await pt.getTask(TEST_UID, pid, created.task.id)).toMatchObject({ status: 'todo', result_ref: 'verified-result' });
    expect(events).toHaveLength(1);
  });

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

  it('serializes competing status updates and keeps the first associated task conversation', async () => {
    const { pt, pid } = await setup();
    const created = await pt.createTask(TEST_UID, pid, { title: 'Conversation-owned task' });
    if (!created.ok) throw new Error('create failed');

    const [first, later] = await Promise.all([
      pt.updateTask(TEST_UID, pid, created.task.id, {
        status: 'progress',
        origin_cid: 'conv_first',
      }),
      pt.updateTask(TEST_UID, pid, created.task.id, {
        status: 'review',
        origin_cid: 'conv_later',
      }),
    ]);
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.task.origin_cid).toBe('conv_first');
    expect(later.ok).toBe(true);
    if (later.ok) {
      expect(later.task.status).toBe('review');
      expect(later.task.origin_cid).toBe('conv_first');
    }
    expect(JSON.parse(fs.readFileSync(taskFile(pid, created.task.id), 'utf-8')).origin_cid)
      .toBe('conv_first');
  });
});

describe('project_tasks › review + decideReview', () => {
  it.each(['project', 'global'] as const)('accepts only one concurrent review decision in %s scope and retains it after reload', async (scope) => {
    const { pt, pid } = await setup();
    const reviewPid = scope === 'project' ? pid : '';
    const created = await pt.createTask(TEST_UID, reviewPid, { title: 'Review concurrent decisions', status: 'review' });
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
    const a = await pt.createTask(TEST_UID, pid, { title: 'a' });
    if (a.ok) await pt.updateTask(TEST_UID, pid, a.task.id, { status: 'review' });
    const prog = pt.computeProgress(await pt.listTasks(TEST_UID, pid));
    expect(prog.total).toBe(1);
    expect(prog.done).toBe(0);
    expect(prog.open).toBe(1);
    expect(prog.by_status.review).toBe(1);
  });

  it('approved → done (+done_at); changes_requested → progress (clears done_at)', async () => {
    const { pt, pid } = await setup();
    const a = await pt.createTask(TEST_UID, pid, { title: 'a' });
    if (!a.ok) return;
    await pt.updateTask(TEST_UID, pid, a.task.id, { status: 'review' });
    const approved = await pt.decideReview(TEST_UID, pid, a.task.id, 'approved');
    expect(approved.ok).toBe(true);
    if (approved.ok) {
      expect(approved.task.status).toBe('done');
      expect(approved.task.done_at).toBeTruthy();
    }

    const b = await pt.createTask(TEST_UID, pid, { title: 'b' });
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
    const a = await pt.createTask(TEST_UID, pid, { title: 'a' }); // status todo, not review
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
    await pt.createTask(TEST_UID, pid, { title: 't' });
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
      title: 'continue prior implementation',
      origin_cid: 'chat-origin',
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const updated = await pt.updateTask(TEST_UID, pid, created.task.id, {
      result_ref: 'chat-result',
    });
    expect(updated.ok).toBe(true);

    expect(pt.taskView(updated.ok ? updated.task : created.task)).toMatchObject({
      origin_cid: 'chat-origin',
      result_ref: 'chat-result',
    });
  });

  it('exposes task detail and dependencies to the model', async () => {
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
  });

});

describe('project_tasks › onTasksChanged', () => {
  it('notifies listeners on create, update, and delete so the UI can refresh live', async () => {
    const { pt, pid } = await setup();
    const events: Array<{ uid: string; pid: string }> = [];
    pt.onTasksChanged((e) => events.push(e));

    const created = await pt.createTask(TEST_UID, pid, { title: 'x' });
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
  it('uploads a file, caches the name on the task, and lists it', async () => {
    const { pt, pid } = await setup();
    const created = await pt.createTask(TEST_UID, pid, { title: 'with files' });
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
    const created = await pt.createTask(TEST_UID, pid, { title: 't' });
    if (!created.ok) throw new Error('seed');
    const tid = created.task.id;
    expect(await pt.uploadTaskAttachment(TEST_UID, pid, tid, 'malware.exe', Buffer.from('x'))).toMatchObject({ ok: false, error: 'unsupported_type' });
    expect(await pt.uploadTaskAttachment(TEST_UID, pid, tid, '../escape.txt', Buffer.from('x'))).toMatchObject({ ok: true, name: 'escape.txt' });
    // The traversal was stripped to a basename inside the task's dir.
    expect(fs.existsSync(path.join(attachDir(pid, tid), 'escape.txt'))).toBe(true);
  });

  it('deletes a file and drops it from the cached list', async () => {
    const { pt, pid } = await setup();
    const created = await pt.createTask(TEST_UID, pid, { title: 't' });
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
    const created = await pt.createTask(TEST_UID, pid, { title: 'adopt', id: draftTid });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.task.id).toBe(draftTid);
    expect(created.task.attachments).toEqual(['draft.md']);
  });

  it('rejects create with an id that is already taken', async () => {
    const { pt, pid } = await setup();
    const first = await pt.createTask(TEST_UID, pid, { title: 'one' });
    if (!first.ok) throw new Error('seed');
    const dup = await pt.createTask(TEST_UID, pid, { title: 'two', id: first.task.id });
    expect(dup).toMatchObject({ ok: false, error: 'id_taken' });
  });

  it('deletes the attachments dir with the task', async () => {
    const { pt, pid } = await setup();
    const created = await pt.createTask(TEST_UID, pid, { title: 't' });
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
    const created = await pt.createTask(TEST_UID, pid, { title: 't' });
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
    const created = await pt.createTask(TEST_UID, taskPid, { title: 'Deliver with attachment' });
    if (!created.ok) throw new Error('task fixture failed');
    const results = await Promise.all([
      pt.uploadTaskAttachment(TEST_UID, taskPid, created.task.id, 'brief.txt', Buffer.from('source brief')),
      pt.updateTask(TEST_UID, taskPid, created.task.id, { status: 'done', result_ref: 'artifact:delivery' }),
    ]);
    expect(results.every(result => result.ok)).toBe(true);
    vi.resetModules();
    const reloaded = await import('../../../src/main/features/project_tasks');
    expect(await reloaded.getTask(TEST_UID, taskPid, created.task.id)).toMatchObject({
      status: 'done', result_ref: 'artifact:delivery', attachments: ['brief.txt'],
    });
    expect(await reloaded.listTaskAttachments(TEST_UID, taskPid, created.task.id)).toEqual(['brief.txt']);
  });

  it('does not resurrect a deleted task when an earlier update finishes', async () => {
    const { pt, pid } = await setup();
    const created = await pt.createTask(TEST_UID, pid, { title: 'Delete while updating' });
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
  it('rejects a failed review write without notification, then releases the lock for independent edits and retry', async () => {
    const { pt, pid } = await setup();
    const created = await pt.createTask(TEST_UID, pid, {
      title: 'Release review', status: 'progress', origin_cid: 'original-chat', detail: 'Original brief',
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
      await expect(pt.updateTask(TEST_UID, pid, tid, { status: 'review', result_ref: 'delivery.md' }))
        .rejects.toThrow(fault);
      expect(fs.readFileSync(file, 'utf8')).toBe(before);
      expect(changes).toEqual([]);
      expect(fs.readdirSync(path.dirname(file))).toEqual([`${tid}.json`]);
    } finally {
      spy.mockRestore();
      syncBuiltinESMExports();
    }
    const results = await Promise.all([
      pt.updateTask(TEST_UID, pid, tid, { detail: 'Clarified brief', origin_cid: 'later-chat' }),
      pt.updateTask(TEST_UID, pid, tid, { status: 'review', result_ref: 'delivery.md' }),
    ]);
    expect(results.every(result => result.ok)).toBe(true);
    vi.resetModules();
    const reloaded = await import('../../../src/main/features/project_tasks');
    expect(await reloaded.listTasks(TEST_UID, pid)).toEqual([expect.objectContaining({
      id: tid, detail: 'Clarified brief', status: 'review', result_ref: 'delivery.md', origin_cid: 'original-chat',
    })]);
  });
});


describe('project_tasks › retired status compatibility', () => {
  it.each(['global', 'project'])('rejects retired status writes in %s and retains the current task on failure', async (scope) => {
    const setupResult = await setup();
    const { pt } = setupResult;
    const pid = scope === 'global' ? '' : setupResult.pid;
    const created = await pt.createTask(TEST_UID, pid, { title: 'Active delivery', status: 'progress', origin_cid: 'source-chat' });
    if (!created.ok) throw new Error('task fixture failed');
    const changes: unknown[] = [];
    pt.onTasksChanged(event => changes.push(event));
    for (const status of ['blocked', 'cancelled', 'in_progress', 'in_review']) {
      expect(await pt.createTask(TEST_UID, pid, { title: 'Invalid task', status: status as any }))
        .toEqual({ ok: false, error: 'bad_status' });
      expect(await pt.updateTask(TEST_UID, pid, created.task.id, { title: 'Must not replace', status: status as any }))
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
        title: `Legacy delivery ${oldStatus}`, detail: 'Waiting for input', origin_cid: 'original-chat',
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
      const { done_at: _staleTimestamp, ...context } = legacy;
      const expected = { ...context, status };
      expect(await reloaded.getTask(TEST_UID, pid, created.task.id)).toEqual(expected);
      expect(await reloaded.listTasks(TEST_UID, pid)).toContainEqual(expected);
      expect(reloaded.taskView(expected as any)).toMatchObject({ status, origin_cid: 'original-chat' });
      expect(reloaded.computeProgress([expected as any]))
        .toEqual({ total: 1, open: 1, done: 0, by_status: { todo: 0, progress: 0, review: 0, done: 0, [status]: 1 } });
      expect(fs.readFileSync(file, 'utf8')).toBe(originalBytes);
      expect((await reloaded.updateTask(TEST_UID, pid, created.task.id, { detail: 'Input received' })).ok).toBe(true);
      const persisted = JSON.parse(fs.readFileSync(file, 'utf8'));
      // Editing advances updated_at; legacy content and its other timestamps survive.
      const { updated_at: previousUpdatedAt, ...preservedContext } = expected;
      expect(persisted).toMatchObject({ ...preservedContext, detail: 'Input received' });
      expect(Date.parse(persisted.updated_at)).toBeGreaterThanOrEqual(Date.parse(previousUpdatedAt));
      expect(persisted).not.toHaveProperty('done_at');
      vi.resetModules();
      expect(await (await import('../../../src/main/features/project_tasks')).getTask(TEST_UID, pid, created.task.id)).toEqual(persisted);
    }
  });

  it('reopens a cancelled dependency and defers dependent work until it is completed', async () => {
    const { pt, pid } = await setup();
    const dependency = await pt.createTask(TEST_UID, pid, { title: 'Migration', origin_cid: 'original-chat' });
    if (!dependency.ok) throw new Error('dependency fixture failed');
    const dependent = await pt.createTask(TEST_UID, pid, { title: 'Release', depends_on: [dependency.task.id] });
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
