import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const driverLogs = vi.hoisted(() => [] as unknown[][]);
vi.mock('../../../src/main/logger', () => ({
  createLogger: (scope: string) => Object.fromEntries(
    ['info', 'warn', 'error', 'debug'].map((level) => [level, (...args: unknown[]) => {
      if (scope === 'project-driver-runner') driverLogs.push([level, ...args]);
    }]),
  ),
}));

import type { TaskStatus } from '../../../src/main/features/project_tasks';

// runTaskNow dispatches through the real conversation/bus modules (no injection
// seam like advanceProjectIfDue), so mock those; todo_tasks runs for real
// against a tmp workspace so the status transition + guards are exercised.
vi.mock('../../../src/main/features/chats', () => ({
  createConversation: vi.fn(async () => ({ conversation_id: 'c_run' })),
  deleteConversation: vi.fn(async () => {}),
}));
vi.mock('../../../src/main/features/group_chat', () => ({
  send: vi.fn(async () => ({ ok: true })),
  busIsQuiescent: () => true,
}));
vi.mock('../../../src/main/features/projects', () => ({
  projectExists: vi.fn(async () => true),
  getBindings: vi.fn(async () => ({ agents: ['a_owner'], skills: [] })),
  listProjects: vi.fn(async () => []),
}));

import * as chats from '../../../src/main/features/chats';
import * as groupChat from '../../../src/main/features/group_chat';
import * as runner from '../../../src/main/features/project_driver_runner';
import * as projectTasks from '../../../src/main/features/project_tasks';
import * as driver from '../../../src/main/features/project_driver';
import { projectDir, userTasksDir } from '../../../src/main/paths';

let tmpDir: string;
let prevWs: string | undefined;
const UID = 'uRUNNOW';
const PID = 'p_112233445566';

beforeEach(() => {
  driverLogs.length = 0;
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-runnow-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  // paths.ts captures the suite workspace root at module load, so changing the
  // env above cannot isolate this statically imported feature. Clear the real
  // project fixture instead; otherwise a prior test's progress task is
  // title-deduplicated into the next test.
  fs.rmSync(projectDir(UID, PID), { recursive: true, force: true });
  fs.rmSync(userTasksDir(UID), { recursive: true, force: true });
  vi.mocked(chats.createConversation).mockResolvedValue({ conversation_id: 'c_run' } as never);
  vi.mocked(chats.deleteConversation).mockResolvedValue(undefined as never);
  vi.mocked(groupChat.send).mockResolvedValue({ ok: true } as never);
});
afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(projectDir(UID, PID), { recursive: true, force: true });
  fs.rmSync(userTasksDir(UID), { recursive: true, force: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });
  vi.clearAllMocks();
});

async function seedTask(over: {
  owner?: string; ownerId?: string; status?: TaskStatus; title?: string; originCid?: string;
} = {}) {
  const r = await projectTasks.createTask(UID, PID, {
    title: over.title || 'Ship the thing',
    created_by: 'user',
    ...(over.owner ? { owner_agent: over.owner } : {}),
    ...(over.ownerId ? { owner_agent_id: over.ownerId } : {}),
    ...(over.status ? { status: over.status } : {}),
    ...(over.originCid ? { origin_cid: over.originCid } : {}),
  });
  if (!r.ok) throw new Error('seed failed: ' + (r as { error: string }).error);
  return r.task;
}

describe('project_driver_runner › runTaskNow', () => {
  it('keeps conversation-creation failures actionable without logging private error text or identities', async () => {
    const task = await seedTask();
    const detail = `${tmpDir}/private-deliverable.txt cannot be created`;
    vi.mocked(chats.createConversation).mockRejectedValueOnce(new Error(detail));
    expect(await runner.runTaskNow(UID, PID, task.id)).toEqual({ ok: false, error: 'create_failed' });
    expect(driverLogs).toEqual([['error', 'runTaskNow conv-create failed', expect.objectContaining({
      error: expect.objectContaining({ message_hash: expect.stringMatching(/^[a-f0-9]{12}$/), message_chars: detail.length }),
    })]]);
    const output = JSON.stringify(driverLogs);
    for (const secret of [UID, PID, tmpDir, 'private-deliverable.txt']) expect(output).not.toContain(secret);
    expect(groupChat.send).not.toHaveBeenCalled();
  });

  it.each(['manual', 'automatic'])('%s run associates the exact new execution without replacing its original conversation', async (mode) => {
    const tb = await import('../../../src/main/features/group_chat/task_board');
    tb._resetForTest();
    const cid = `c_execution_${mode}`;
    vi.mocked(chats.createConversation).mockResolvedValue({ conversation_id: cid } as never);
    const task = await seedTask({ originCid: 'c_original' });
    vi.mocked(groupChat.send).mockImplementationOnce(async () => {
      await tb.createTask(UID, cid, {
        assignee: 'commander', instruction: 'Execute', createdBy: 'user', running: true,
        sourceMsgId: `m_${mode}`,
      });
      return { ok: true, msg: { id: `m_${mode}` } } as never;
    });
    try {
      const result = mode === 'manual' ? await runner.runTaskNow(UID, PID, task.id) : await runner.advance(UID, PID, task);
      expect(result.ok).toBe(true);
      expect(tb.backlogExecutionSnapshot(UID, PID).get(task.id)?.is_running).toBe(true);
      expect((await projectTasks.getTask(UID, PID, task.id))?.origin_cid).toBe('c_original');
    } finally { tb._resetForTest(); }
  });

  it('routes an assigned task through the Commander and requires an explicit verified review transition', async () => {
    const task = await seedTask({ owner: 'Owner', ownerId: 'a_owner' });
    const res = await runner.runTaskNow(UID, PID, task.id);

    expect(res.ok).toBe(true);
    expect(res.cid).toBe('c_run');
    expect(res.conversation).toBeDefined();

    expect(chats.createConversation).toHaveBeenCalledWith(
      UID,
      expect.objectContaining({ kind: 'normal', title: 'Ship the thing', projectId: PID }),
    );
    const sendArg = vi.mocked(groupChat.send).mock.calls[0][0] as {
      cid: string; text: string; title_text?: string; model_text?: string;
    };
    expect(sendArg.cid).toBe('c_run');
    expect(sendArg.text).toBe('Ship the thing');
    expect(sendArg.title_text).toBe('Ship the thing');
    expect(sendArg.model_text).toContain(`Execute project task ${task.id} now: "Ship the thing"`);
    expect(sendArg.model_text).toContain('dispatch the work to @Owner');
    expect(sendArg.model_text).toContain('fully complete and verified');
    expect(sendArg.model_text).toContain('update this exact task to review with todo_tasks');
    expect(sendArg.model_text).toContain('incomplete, interrupted, or fails');
    expect(sendArg.model_text).toContain('it must remain progress');
    expect(sendArg.model_text).toContain('never set it to blocked or done');
    expect(sendArg.model_text).toContain('Only a later explicit user instruction or manual action may set it to done');

    const after = await projectTasks.getTask(UID, PID, task.id);
    expect(after?.status).toBe('progress');
    expect(after?.origin_cid).toBe('c_run');
  });

  it('keeps the review status explicitly written by the Commander during execution', async () => {
    const task = await seedTask();
    vi.mocked(groupChat.send).mockImplementationOnce(async () => {
      expect((await projectTasks.getTask(UID, PID, task.id))?.status).toBe('progress');
      expect((await projectTasks.updateTask(UID, PID, task.id, { status: 'review' })).ok).toBe(true);
      return { ok: true } as never;
    });

    expect((await runner.runTaskNow(UID, PID, task.id)).ok).toBe(true);
    expect((await projectTasks.getTask(UID, PID, task.id))?.status).toBe('review');
  });

  it.each([PID, ''])('can resume an in-progress task in scope %s without completing it prematurely', async (pid) => {
    const created = await projectTasks.createTask(UID, pid, {
      title: 'Resume unfinished work', status: 'progress', origin_cid: 'c_original',
    });
    if (!created.ok) throw new Error('task fixture failed');
    expect(await runner.runTaskNow(UID, pid, created.task.id)).toMatchObject({ ok: true, cid: 'c_run' });
    expect(vi.mocked(groupChat.send).mock.calls[0][0].model_text).toContain('to review with todo_tasks');
    expect(await projectTasks.getTask(UID, pid, created.task.id)).toMatchObject({
      status: 'progress', origin_cid: 'c_original',
    });
    await projectTasks.updateTask(UID, pid, created.task.id, { status: 'review' });
    expect((await projectTasks.getTask(UID, pid, created.task.id))?.status).toBe('review');
  });

  it.each(['progress', 'review'] as const)('admits only one overlapping retry of an %s task', async (status) => {
    const task = await seedTask({ status });
    let release!: () => void;
    const bothArrived = new Promise<void>((resolve) => { release = resolve; });
    let arrivals = 0;
    vi.mocked(chats.createConversation).mockImplementation(async () => {
      const cid = `c_retry_${++arrivals}`;
      if (arrivals === 2) release();
      await bothArrived;
      return { conversation_id: cid } as never;
    });
    const results = await Promise.all([
      runner.runTaskNow(UID, PID, task.id), runner.runTaskNow(UID, PID, task.id),
    ]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(groupChat.send).toHaveBeenCalledTimes(1);
    const cid = results.find((result) => result.ok)!.cid;
    expect(await projectTasks.getTask(UID, PID, task.id)).toMatchObject({ status, origin_cid: cid });
    expect(chats.deleteConversation).toHaveBeenCalledTimes(1);
    expect(vi.mocked(chats.deleteConversation).mock.calls[0][1]).not.toBe(cid);
  });

  it('routes an unassigned task to the project commander and flips it progress', async () => {
    const task = await seedTask();
    const res = await runner.runTaskNow(UID, PID, task.id);
    expect(res).toMatchObject({ ok: true, cid: 'c_run' });
    expect(chats.createConversation).toHaveBeenCalledWith(
      UID,
      expect.objectContaining({ kind: 'normal', title: 'Ship the thing', projectId: PID }),
    );
    const sendArg = vi.mocked(groupChat.send).mock.calls[0][0] as { text: string; model_text?: string };
    expect(sendArg.text).toBe('Ship the thing');
    expect(sendArg.model_text).toContain(`Execute project task ${task.id} now: "Ship the thing"`);
    expect(sendArg.model_text).toContain('choose and dispatch the right Agent');
    expect((await projectTasks.getTask(UID, PID, task.id))?.status).toBe('progress');
  });

  it('routes a global task to the default assistant without a project conversation', async () => {
    const seeded = await projectTasks.createTask(UID, '', {
      title: 'Follow up globally',
      created_by: 'user',
    });
    if (!seeded.ok) throw new Error('global seed failed');

    const res = await runner.runTaskNow(UID, '', seeded.task.id);

    expect(res).toMatchObject({ ok: true, cid: 'c_run' });
    expect(chats.createConversation).toHaveBeenCalledWith(
      UID,
      { kind: 'normal', title: 'Follow up globally' },
    );
    const sendArg = vi.mocked(groupChat.send).mock.calls[0][0] as { text: string; model_text?: string };
    expect(sendArg.text).toBe('Follow up globally');
    expect(sendArg.model_text).toContain(`Execute account-global todo ${seeded.task.id} now: "Follow up globally"`);
    expect(sendArg.model_text).toContain('project "__global__"');
    expect(sendArg.model_text).toContain('update this exact todo to review');
    expect(sendArg.model_text).toContain('it must remain progress');
    expect(sendArg.model_text).toContain('never set it to blocked or done');
    expect(await projectTasks.getTask(UID, '', seeded.task.id)).toMatchObject({
      status: 'progress',
      origin_cid: 'c_run',
    });
  });

  it('auto-advances a global task through a normal global conversation', async () => {
    const seeded = await projectTasks.createTask(UID, '', {
      title: 'Advance globally',
      created_by: 'user',
    });
    if (!seeded.ok) throw new Error('global seed failed');

    const res = await runner.advance(UID, '', seeded.task);

    expect(res).toMatchObject({ ok: true, cid: 'c_run' });
    expect(chats.createConversation).toHaveBeenCalledWith(
      UID,
      { kind: 'normal', title: 'Advance globally' },
    );
    const sendArg = vi.mocked(groupChat.send).mock.calls[0][0] as { text: string; model_text?: string };
    expect(sendArg.text).toBe('Advance globally');
    expect(sendArg.model_text).toContain('project "__global__"');
    expect(sendArg.model_text).toContain('started by auto-advance');
    expect(sendArg.model_text).toContain('update this exact todo to review');
    expect(sendArg.model_text).toContain('it must remain progress');
    expect(await projectTasks.getTask(UID, '', seeded.task.id)).toMatchObject({
      status: 'progress',
      origin_cid: 'c_run',
    });
  });

  it('refuses to run a done task', async () => {
    const task = await seedTask({ owner: 'Owner', ownerId: 'a_owner', status: 'done' });
    const res = await runner.runTaskNow(UID, PID, task.id);
    expect(res).toMatchObject({ ok: false, error: 'not_runnable' });
    expect(chats.createConversation).not.toHaveBeenCalled();
    expect(groupChat.send).not.toHaveBeenCalled();
  });

  it.each([PID, ''])('requests verified completion when processing a review task in scope %s', async (pid) => {
    const created = await projectTasks.createTask(UID, pid, {
      title: 'Verify the delivery', status: 'review', origin_cid: 'c_original',
    });
    if (!created.ok) throw new Error('task fixture failed');

    expect(await runner.runTaskNow(UID, pid, created.task.id)).toMatchObject({ ok: true, cid: 'c_run' });
    const sent = vi.mocked(groupChat.send).mock.calls[0][0];
    expect(sent.text).toBe('Verify the delivery');
    expect(sent.model_text).toContain('fully complete and verified');
    expect(sent.model_text).toContain('to done with todo_tasks');
    expect(sent.model_text).toContain('When work starts, mark it progress with todo_tasks');
    expect(sent.model_text).toContain('it must remain progress');
    expect(sent.model_text).not.toContain('never set it to blocked or done');
    expect(sent.model_text).not.toContain('Only a later explicit user instruction');
    if (!pid) expect(sent.model_text).toContain('project "__global__"');
    // Enqueuing is not verification. Pending input, interruption, and failure
    // must not be mistaken for a completed deliverable.
    expect(await projectTasks.getTask(UID, pid, created.task.id)).toMatchObject({
      status: 'review', origin_cid: 'c_original',
    });
    expect((await projectTasks.getTask(UID, pid, created.task.id))?.done_at).toBeUndefined();
  });

  it.each([PID, ''])('preserves the executor completion of a review task in scope %s', async (pid) => {
    const created = await projectTasks.createTask(UID, pid, { title: 'Delivery ready', status: 'review' });
    if (!created.ok) throw new Error('task fixture failed');
    // Simulate the executor's explicit tool write, not a successful send as a
    // substitute for work. The runner must preserve its durable result.
    vi.mocked(groupChat.send).mockImplementationOnce(async () => {
      expect((await projectTasks.getTask(UID, pid, created.task.id))?.status).toBe('review');
      expect((await projectTasks.updateTask(UID, pid, created.task.id, { status: 'progress' })).ok).toBe(true);
      expect((await projectTasks.completeTask(UID, pid, created.task.id, 'verified-delivery')).ok).toBe(true);
      return { ok: true } as never;
    });
    expect((await runner.runTaskNow(UID, pid, created.task.id)).ok).toBe(true);
    expect(await projectTasks.getTask(UID, pid, created.task.id)).toMatchObject({
      status: 'done', result_ref: 'verified-delivery', origin_cid: 'c_run', done_at: expect.any(String),
    });
  });

  it.each([PID, ''])('preserves an unsent review task and allows retry in scope %s', async (pid) => {
    const created = await projectTasks.createTask(UID, pid, { title: 'Retry review', status: 'review' });
    if (!created.ok) throw new Error('task fixture failed');
    vi.mocked(groupChat.send).mockResolvedValueOnce({ ok: false, error: 'no_model' } as never);
    expect(await runner.runTaskNow(UID, pid, created.task.id)).toMatchObject({ ok: false, error: 'no_model' });
    expect(await projectTasks.getTask(UID, pid, created.task.id)).toMatchObject({ status: 'review' });
    expect((await projectTasks.getTask(UID, pid, created.task.id))?.origin_cid).toBeUndefined();
    expect(chats.deleteConversation).toHaveBeenCalledWith(UID, 'c_run', pid || null);
    expect((await runner.runTaskNow(UID, pid, created.task.id)).ok).toBe(true);
    expect(vi.mocked(groupChat.send).mock.calls[1][0].model_text).toContain('to done with todo_tasks');
  });

  it('does not roll back an executor status when a review dispatch reports failure late', async () => {
    const task = await seedTask({ status: 'review' });
    vi.mocked(groupChat.send).mockImplementationOnce(async () => {
      expect((await projectTasks.updateTask(UID, PID, task.id, { status: 'progress' })).ok).toBe(true);
      return { ok: false, error: 'send_failed' } as never;
    });
    expect((await runner.runTaskNow(UID, PID, task.id)).ok).toBe(false);
    expect((await projectTasks.getTask(UID, PID, task.id))?.status).toBe('progress');
  });

  it('rolls back the empty conversation and leaves status untouched when the send fails', async () => {
    vi.mocked(groupChat.send).mockResolvedValue({ ok: false, error: 'no_model' } as never);
    const task = await seedTask({ owner: 'Owner', ownerId: 'a_owner' });
    const res = await runner.runTaskNow(UID, PID, task.id);

    expect(res).toMatchObject({ ok: false, error: 'no_model' });
    expect(chats.deleteConversation).toHaveBeenCalledWith(UID, 'c_run', PID);
    const after = await projectTasks.getTask(UID, PID, task.id);
    expect(after?.status).toBe('todo');
    expect(after?.origin_cid).toBeUndefined();
  });

  it('never replaces an existing task-conversation association on a later run', async () => {
    const task = await seedTask({ originCid: 'c_original' });
    const res = await runner.runTaskNow(UID, PID, task.id);

    expect(res.ok).toBe(true);
    expect(await projectTasks.getTask(UID, PID, task.id)).toMatchObject({
      status: 'progress',
      origin_cid: 'c_original',
    });
  });
});

describe('project_driver_runner › advance de-duplication', () => {
  it('does not regress a stale task that already advanced before dispatch', async () => {
    const stale = await seedTask();
    expect((await projectTasks.updateTask(UID, PID, stale.id, { status: 'done' })).ok).toBe(true);

    const res = await runner.advance(UID, PID, stale);

    expect(res.ok).toBe(false);
    expect(groupChat.send).not.toHaveBeenCalled();
    expect(chats.deleteConversation).toHaveBeenCalledWith(UID, 'c_run', PID);
    expect((await projectTasks.getTask(UID, PID, stale.id))?.status).toBe('done');
  });

  it('moves the advanced task out of todo so the loop stops re-selecting it', async () => {
    await seedTask();
    await seedTask({ title: 'Ship the other thing' });
    // The driver advances the first actionable (todo) task.
    const picked = driver.nextActionableTask(await projectTasks.listTasks(UID, PID));
    expect(picked).not.toBeNull();

    const res = await runner.advance(UID, PID, picked!);
    expect(res.ok).toBe(true);

    // It left `todo`, so the next tick selects a DIFFERENT task instead of
    // re-firing the same one and piling up duplicate conversations.
    const after = await projectTasks.getTask(UID, PID, picked!.id);
    expect(after?.status).toBe('progress');
    const nextPick = driver.nextActionableTask(await projectTasks.listTasks(UID, PID));
    expect(nextPick?.id).toBeDefined();
    expect(nextPick?.id).not.toBe(picked!.id);
  });

  it('leaves the task in todo when the advance send fails (no premature flip)', async () => {
    vi.mocked(groupChat.send).mockResolvedValue({ ok: false, error: 'no_model' } as never);
    const task = await seedTask();
    const res = await runner.advance(UID, PID, task);

    expect(res.ok).toBe(false);
    expect(chats.deleteConversation).toHaveBeenCalled();
    const after = await projectTasks.getTask(UID, PID, task.id);
    expect(after?.status).toBe('todo');
    expect(after?.origin_cid).toBeUndefined();
  });

  it('seeds the commander (no @mention) to dispatch, verify, and explicitly request review', async () => {
    const task = await seedTask({ owner: 'Owner', ownerId: 'a_owner' });
    await runner.advance(UID, PID, task);
    const sendArg = vi.mocked(groupChat.send).mock.calls[0][0] as { text: string; model_text?: string };
    // No leading @mention → routes to the commander, which (unlike a worker
    // agent) can write task status; it names the exact progress task so the
    // commander advances that one and moves its status forward.
    expect(sendArg.text.trimStart().startsWith('@')).toBe(false);
    expect(sendArg.text).toContain('Ship the thing');
    expect(sendArg.model_text).toContain('fully complete and verified');
    expect(sendArg.model_text).toContain('update this exact task to review with todo_tasks');
    expect(sendArg.model_text).toContain('it must remain progress');
    expect(sendArg.model_text).toContain('never set it to blocked or done');
  });
});
