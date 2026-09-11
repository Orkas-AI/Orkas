import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { syncBuiltinESMExports } from 'node:module';

const loggerMocks = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
}));
vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: loggerMocks.info,
    warn: loggerMocks.warn,
    error: vi.fn(),
  }),
}));

/**
 * Unit coverage for the conversation task board (task_board.ts).
 *
 * Scenario value: the board is the user's answer to "who is working on what
 * and who is queued" — a row that never terminates, a ghost row after
 * restart, or a lost row after a corrupt write all mislead the user about
 * live work. Oracle: the persisted tasks.json snapshot (independent of the
 * in-memory map), plus returned state transitions.
 */

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'u1';
const TEST_CID = 'cid01';

async function board() {
  return import('../../../../src/main/features/group_chat/task_board');
}

function tasksFilePath(): string {
  return path.join(tmpDir, TEST_UID, 'cloud', 'chats', TEST_CID, 'tasks.json');
}

/** The persisted snapshot after the board's pending end-of-tick write. */
async function readSnapshot(): Promise<any[]> {
  await (await board()).flushBoards();
  return JSON.parse(fs.readFileSync(tasksFilePath(), 'utf8'));
}

beforeEach(async () => {
  loggerMocks.info.mockReset();
  loggerMocks.warn.mockReset();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-taskboard-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../../src/main/features/users');
  users.activateUser(TEST_UID);
  (await board())._resetForTest();
});

afterEach(async () => {
  (await board())._resetForTest();
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('task_board › lifecycle', () => {
  it('preserves pending admission through sync, confirms only waiting rows, and cancels it on restart', async () => {
    const tb = await board();
    const create = () => tb.createTask(TEST_UID, TEST_CID, {
      assignee: 'commander', instruction: 'Ordinary send', createdBy: 'user', admissionPending: true,
    });
    const waiting = await create();
    const running = await create();
    const cancelled = await create();
    const pending = await create();
    expect((await readSnapshot()).every((row) => row.admission_pending === true)).toBe(true);
    tb.dropBoard(TEST_UID, TEST_CID, { persistPending: false });
    expect((await tb.listTasks(TEST_UID, TEST_CID)).every((row) => row.admission_pending === true)).toBe(true);
    await tb.claimTask(TEST_UID, TEST_CID, running.task_id);
    await tb.cancelPending(TEST_UID, TEST_CID, cancelled.task_id);
    const ids = [waiting.task_id, running.task_id, cancelled.task_id];
    expect((await tb.confirmQueued(TEST_UID, TEST_CID, ids)).map((row) => row.task_id)).toEqual([waiting.task_id]);
    expect(await tb.confirmQueued(TEST_UID, TEST_CID, ids)).toEqual([]);
    const rows = await readSnapshot();
    expect(rows.find((row) => row.task_id === waiting.task_id).admission_pending).toBeUndefined();
    expect(rows.find((row) => row.task_id === running.task_id).status).toBe('running');
    expect(rows.find((row) => row.task_id === cancelled.task_id).status).toBe('cancelled');
    expect(rows.find((row) => row.task_id === pending.task_id).admission_pending).toBe(true);
    tb._resetForTest();
    expect((await tb.listTasks(TEST_UID, TEST_CID)).every((row) => row.status === 'cancelled' && !row.admission_pending)).toBe(true);
  });

  it('reports only associated execution activity, with independent project/account and current-actor scope', async () => {
    const tb = await board();
    const taskId = 't_123456789abc';
    const root = await tb.createTask(TEST_UID, TEST_CID, {
      assignee: 'commander', instruction: `Process ${taskId}`, createdBy: 'user',
      sourceMsgId: 'source1', turnId: 'turn1', running: true,
    });
    // A title/id in prose and a busy conversation are not an association.
    expect(tb.backlogExecutionSnapshot(TEST_UID, 'p1').has(taskId)).toBe(false);
    expect(await tb.associateBacklogTask(TEST_UID, TEST_CID, 'p1', taskId, { sourceMessageId: 'missing' })).toBe(false);
    expect(await tb.associateBacklogTask(TEST_UID, TEST_CID, 'p1', taskId, { sourceMessageId: 'source1' })).toBe(true);
    expect(tb.backlogExecutionSnapshot(TEST_UID, 'p1', TEST_CID, { actorId: 'commander' }).get(taskId))
      .toEqual({ is_running: true, is_current_run: true });
    expect(tb.backlogExecutionSnapshot(TEST_UID, 'p1', TEST_CID, { actorId: 'other-agent' }).get(taskId))
      .toEqual({ is_running: true, is_current_run: false });
    expect(tb.backlogExecutionSnapshot(TEST_UID, 'other-project').has(taskId)).toBe(false);
    expect(tb.backlogExecutionSnapshot('other-account', 'p1').has(taskId)).toBe(false);
    await tb.finishTask(TEST_UID, TEST_CID, root.task_id, 'done');
    await tb.createTask(TEST_UID, TEST_CID, { assignee: 'other-agent', instruction: 'Unrelated work', createdBy: 'user', running: true });
    expect(tb.backlogExecutionSnapshot(TEST_UID, 'p1').get(taskId)?.is_running).toBe(false);
  });

  it.each(['waiting_input', 'done', 'stopped', 'failed', 'cancelled'] as const)(
    'does not report %s as active work and publishes the activity change', async (status) => {
      const tb = await board();
      const taskId = 't_123456789abc';
      const notifications: unknown[] = [];
      const unsubscribe = tb.onBacklogExecutionChanged((event) => notifications.push(event));
      const run = await tb.createTask(TEST_UID, TEST_CID, {
        assignee: 'agentA', instruction: 'Execute', createdBy: 'commander',
        backlogTask: { project_id: 'p1', task_id: taskId },
      });
      expect(tb.backlogExecutionSnapshot(TEST_UID, 'p1').get(taskId)?.is_running).toBe(false);
      await tb.claimTask(TEST_UID, TEST_CID, run.task_id);
      expect(tb.backlogExecutionSnapshot(TEST_UID, 'p1').get(taskId)?.is_running).toBe(true);
      const count = notifications.length;
      await tb.finishTask(TEST_UID, TEST_CID, run.task_id, status);
      expect(tb.backlogExecutionSnapshot(TEST_UID, 'p1').get(taskId)?.is_running).toBe(false);
      expect(notifications.slice(count)).toEqual([{ uid: TEST_UID, pid: 'p1' }]);
      if (status === 'waiting_input') {
        await tb.claimTask(TEST_UID, TEST_CID, run.task_id);
        expect(tb.backlogExecutionSnapshot(TEST_UID, 'p1', TEST_CID, { actorId: 'agentA' }).get(taskId))
          .toEqual({ is_running: true, is_current_run: true });
      }
      unsubscribe();
    },
  );

  it('retains activity through terminal handoff and through overlapping executions of the same backlog item', async () => {
    const tb = await board();
    const taskId = 't_123456789abc';
    const parent = await tb.createTask(TEST_UID, TEST_CID, {
      assignee: 'commander', instruction: 'Process', createdBy: 'user', running: true,
      backlogTask: { project_id: 'p1', task_id: taskId },
    });
    const child = await tb.createTask(TEST_UID, TEST_CID, {
      assignee: 'cli-agent', instruction: 'Implement', createdBy: 'commander',
      parentTaskId: parent.task_id, running: true,
    });
    await tb.finishTask(TEST_UID, TEST_CID, parent.task_id, 'done');
    expect(tb.backlogExecutionSnapshot(TEST_UID, 'p1', TEST_CID, { actorId: 'cli-agent' }).get(taskId))
      .toEqual({ is_running: true, is_current_run: true });
    const parallel = await tb.createTask(TEST_UID, 'other-cid', {
      assignee: 'agentA', instruction: 'Another run', createdBy: 'user', running: true,
      backlogTask: { project_id: 'p1', task_id: taskId },
    });
    await tb.finishTask(TEST_UID, TEST_CID, child.task_id, 'failed');
    expect(tb.backlogExecutionSnapshot(TEST_UID, 'p1').get(taskId)?.is_running).toBe(true);
    await tb.finishTask(TEST_UID, 'other-cid', parallel.task_id, 'done');
    expect(tb.backlogExecutionSnapshot(TEST_UID, 'p1').get(taskId)?.is_running).toBe(false);
  });

  it('does not inherit a different backlog item when a child has an explicit association', async () => {
    const tb = await board();
    const parent = await tb.createTask(TEST_UID, TEST_CID, {
      assignee: 'commander', instruction: 'Process', createdBy: 'user',
      backlogTask: { project_id: 'p1', task_id: 't_123456789abc' },
    });
    await tb.createTask(TEST_UID, TEST_CID, {
      assignee: 'agentA', instruction: 'Different item', createdBy: 'commander', running: true,
      parentTaskId: parent.task_id, backlogTask: { project_id: 'p1', task_id: 't_abcdef123456' },
    });
    const snapshot = tb.backlogExecutionSnapshot(TEST_UID, 'p1');
    expect(snapshot.get('t_123456789abc')?.is_running).toBe(false);
    expect(snapshot.get('t_abcdef123456')?.is_running).toBe(true);
  });

  it('never revives a persisted running association after a host restart', async () => {
    const tb = await board();
    await tb.createTask(TEST_UID, TEST_CID, {
      assignee: 'agentA', instruction: 'Execute', createdBy: 'user', running: true,
      backlogTask: { project_id: 'p1', task_id: 't_123456789abc' },
    });
    expect((await readSnapshot())[0].backlog_tasks).toEqual([{ project_id: 'p1', task_id: 't_123456789abc' }]);
    tb._resetForTest();
    expect(tb.backlogExecutionSnapshot(TEST_UID, 'p1').has('t_123456789abc')).toBe(false);
    await tb.listTasks(TEST_UID, TEST_CID);
    expect(tb.backlogExecutionSnapshot(TEST_UID, 'p1').get('t_123456789abc')?.is_running).toBe(false);
  });

  it('preserves a running child association when its late-linked, completed parent is pruned', async () => {
    const tb = await board();
    const parent = await tb.createTask(TEST_UID, TEST_CID, {
      assignee: 'commander', instruction: 'Start', createdBy: 'user', sourceMsgId: 'late-link',
    });
    await tb.createTask(TEST_UID, TEST_CID, {
      assignee: 'agentA', instruction: 'Continue', createdBy: 'commander', running: true,
      parentTaskId: parent.task_id,
    });
    await tb.associateBacklogTask(TEST_UID, TEST_CID, 'p1', 't_123456789abc', { sourceMessageId: 'late-link' });
    await tb.finishTask(TEST_UID, TEST_CID, parent.task_id, 'done');
    for (let index = 0; index < 200; index++) {
      const old = await tb.createTask(TEST_UID, TEST_CID, { assignee: 'other', instruction: 'Unrelated', createdBy: 'user' });
      await tb.finishTask(TEST_UID, TEST_CID, old.task_id, 'done');
    }
    expect((await tb.listTasks(TEST_UID, TEST_CID)).some((task) => task.task_id === parent.task_id)).toBe(false);
    expect(tb.backlogExecutionSnapshot(TEST_UID, 'p1').get('t_123456789abc')?.is_running).toBe(true);
  });

  it('create → claim → finish persists each transition to tasks.json', async () => {
    const tb = await board();
    const t = await tb.createTask(TEST_UID, TEST_CID, {
      assignee: 'agentA', instruction: 'do x', createdBy: 'user',
      sourceMsgId: 'm1', turnId: 'turn1', attachments: ['a.txt'],
    });
    expect(t.status).toBe('queued');
    const created = (await readSnapshot())[0];
    expect(created).toMatchObject({
      task_id: t.task_id, assignee: 'agentA', instruction: 'do x',
      status: 'queued', created_by: 'user', source_msg_id: 'm1',
      turn_id: 'turn1', attachments: ['a.txt'],
      _sync_rev: 1,
    });
    expect(created.updated_at).toBeTruthy();
    expect(created._sync_device_id).toBeTruthy();

    const claim = await tb.claimTask(TEST_UID, TEST_CID, t.task_id);
    expect(claim.running?.status).toBe('running');
    expect(claim.running?.started_at).toBeTruthy();
    const running = (await readSnapshot())[0];
    expect(running.status).toBe('running');
    expect(running._sync_rev).toBe(2);
    expect(running._sync_device_id).toBe(created._sync_device_id);

    const done = await tb.finishTask(TEST_UID, TEST_CID, t.task_id, 'done', { resultMsgId: 'm2' });
    expect(done?.status).toBe('done');
    const snap = (await readSnapshot())[0];
    expect(snap.status).toBe('done');
    expect(snap.result_msg_id).toBe('m2');
    expect(snap.ended_at).toBeTruthy();
    expect(snap._sync_rev).toBe(3);
    expect(snap._sync_device_id).toBe(created._sync_device_id);
  });

  it('finishTask is idempotent — a terminal row is never re-transitioned', async () => {
    const tb = await board();
    const t = await tb.createTask(TEST_UID, TEST_CID, {
      assignee: 'agentA', instruction: 'x', createdBy: 'user',
    });
    await tb.claimTask(TEST_UID, TEST_CID, t.task_id);
    await tb.finishTask(TEST_UID, TEST_CID, t.task_id, 'cancelled');
    // The loop's catch path may double-report a failure after an abort landed.
    const second = await tb.finishTask(TEST_UID, TEST_CID, t.task_id, 'failed');
    expect(second).toBeNull();
    expect((await readSnapshot())[0].status).toBe('cancelled');
  });

  it('persists the live-turn absorption link when a queued task is claimed by Send now', async () => {
    const tb = await board();
    const task = await tb.createTask(TEST_UID, TEST_CID, {
      assignee: 'agentA', instruction: 'fold this update in', createdBy: 'user',
      turnId: 'queued-turn',
    });
    const claim = await tb.claimTask(TEST_UID, TEST_CID, task.task_id, {
      absorbedIntoTurnId: 'live-turn',
      absorbedIntoTaskId: 'live-task',
    });

    expect(claim.running).toMatchObject({
      status: 'running',
      absorbed_into_turn_id: 'live-turn',
      absorbed_into_task_id: 'live-task',
    });
    expect((await readSnapshot())[0]).toMatchObject({
      absorbed_into_turn_id: 'live-turn',
      absorbed_into_task_id: 'live-task',
    });
  });

  it('waiting_input is not terminal: the form-blocked task keeps no ended_at and can later finish', async () => {
    const tb = await board();
    const t = await tb.createTask(TEST_UID, TEST_CID, {
      assignee: 'agentA', instruction: 'x', createdBy: 'user',
    });
    await tb.claimTask(TEST_UID, TEST_CID, t.task_id);
    const waiting = await tb.finishTask(TEST_UID, TEST_CID, t.task_id, 'waiting_input');
    expect(waiting?.status).toBe('waiting_input');
    expect((await readSnapshot())[0].ended_at).toBeUndefined();
    const done = await tb.finishTask(TEST_UID, TEST_CID, t.task_id, 'done');
    expect(done?.status).toBe('done');
  });

  it('true form resume: claiming the waiting task itself returns it to running (same task_id)', async () => {
    const tb = await board();
    const parked = await tb.createTask(TEST_UID, TEST_CID, {
      assignee: 'agentA', instruction: 'form step', createdBy: 'user',
    });
    await tb.claimTask(TEST_UID, TEST_CID, parked.task_id);
    await tb.finishTask(TEST_UID, TEST_CID, parked.task_id, 'waiting_input', { resume: { form_id: 'f'.repeat(12) } });

    // The matching submission re-claims the SAME task — no new row, and a
    // resume supersedes nothing.
    const resumed = await tb.claimTask(TEST_UID, TEST_CID, parked.task_id);
    expect(resumed.running?.task_id).toBe(parked.task_id);
    expect(resumed.running?.status).toBe('running');
    expect(resumed.superseded).toHaveLength(0);
    expect((await readSnapshot())).toHaveLength(1);
    const done = await tb.finishTask(TEST_UID, TEST_CID, parked.task_id, 'done');
    expect(done?.status).toBe('done');
  });

  it('a NEW instruction for the actor supersedes (cancels) its form-parked task; other actors\' claims do not', async () => {
    const tb = await board();
    const parked = await tb.createTask(TEST_UID, TEST_CID, {
      assignee: 'agentA', instruction: 'form step', createdBy: 'user',
    });
    await tb.claimTask(TEST_UID, TEST_CID, parked.task_id);
    await tb.finishTask(TEST_UID, TEST_CID, parked.task_id, 'waiting_input');

    const otherActor = await tb.createTask(TEST_UID, TEST_CID, {
      assignee: 'agentB', instruction: 'unrelated', createdBy: 'user',
    });
    const claimB = await tb.claimTask(TEST_UID, TEST_CID, otherActor.task_id);
    // A different actor's claim must NOT touch agentA's pending form.
    expect(claimB.superseded).toHaveLength(0);

    const fresh = await tb.createTask(TEST_UID, TEST_CID, {
      assignee: 'agentA', instruction: 'forget the form, do this instead', createdBy: 'user',
    });
    const claimA = await tb.claimTask(TEST_UID, TEST_CID, fresh.task_id);
    expect(claimA.superseded.map((x) => x.task_id)).toEqual([parked.task_id]);
    const byId = new Map((await readSnapshot()).map((r: any) => [r.task_id, r]));
    // Superseded = visibly cancelled (the form was bypassed, not answered).
    expect(byId.get(parked.task_id).status).toBe('cancelled');
  });

  it('cancelPending cancels queued and waiting_input rows but never a running row', async () => {
    const tb = await board();
    const queued = await tb.createTask(TEST_UID, TEST_CID, {
      assignee: 'agentA', instruction: 'q', createdBy: 'user',
    });
    const running = await tb.createTask(TEST_UID, TEST_CID, {
      assignee: 'agentB', instruction: 'r', createdBy: 'user',
    });
    await tb.claimTask(TEST_UID, TEST_CID, running.task_id);

    expect((await tb.cancelPending(TEST_UID, TEST_CID, queued.task_id))?.status).toBe('cancelled');
    expect(await tb.cancelPending(TEST_UID, TEST_CID, running.task_id)).toBeNull();
    const byId = new Map((await readSnapshot()).map((r: any) => [r.task_id, r]));
    expect(byId.get(running.task_id).status).toBe('running');
  });
});

describe('task_board › restart reconcile and compatible reader', () => {
  it('keeps conversation ids and parser details out of board recovery logs', async () => {
    const file = tasksFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{private invalid task snapshot');
    const tb = await board();

    expect(await tb.listTasks(TEST_UID, TEST_CID)).toEqual([]);
    expect(loggerMocks.warn).toHaveBeenCalledWith('tasks.json unreadable', {
      cid: 'ci***01',
      error: expect.objectContaining({ message_hash: expect.any(String) }),
    });
    const error = loggerMocks.warn.mock.calls[0]?.[1]?.error;
    expect(error).not.toHaveProperty('message');
    const serialized = JSON.stringify(loggerMocks.warn.mock.calls);
    expect(serialized).not.toContain(TEST_CID);
    expect(serialized).not.toContain('private invalid task snapshot');
    expect(serialized).not.toContain(tmpDir);
  });

  it('queued/running/blocked rows from a dead process reconcile to cancelled; waiting_input and terminal rows survive', async () => {
    const file = tasksFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify([
      { task_id: 't1', assignee: 'a', instruction: 'x', status: 'queued', created_by: 'user', created_at: 't' },
      { task_id: 't2', assignee: 'a', instruction: 'x', status: 'running', created_by: 'user', created_at: 't' },
      { task_id: 't3', assignee: 'a', instruction: 'x', status: 'waiting_input', created_by: 'user', created_at: 't' },
      { task_id: 't4', assignee: 'a', instruction: 'x', status: 'done', created_by: 'user', created_at: 't' },
      { task_id: 't5', assignee: 'a', instruction: 'x', status: 'blocked', created_by: 'user', created_at: 't' },
    ]));
    const tb = await board();
    const byId = new Map((await tb.listTasks(TEST_UID, TEST_CID)).map((t) => [t.task_id, t]));
    expect(byId.get('t1')?.status).toBe('cancelled');
    expect(byId.get('t2')?.status).toBe('cancelled');
    expect(byId.get('t3')?.status).toBe('waiting_input');
    expect(byId.get('t4')?.status).toBe('done');
    expect(byId.get('t5')?.status).toBe('cancelled');
  });

  it('tolerates unknown fields, skips invalid rows, and maps unknown status to cancelled', async () => {
    const file = tasksFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify([
      {
        task_id: 't1', assignee: 'a', instruction: 'x', status: 'done', created_by: 'user',
        created_at: 't', updated_at: '2026-05-12T10:00:00Z', _sync_rev: 4,
        _sync_device_id: 'device-a', future_field: { nested: true },
      },
      { assignee: 'missing-id', status: 'done' },
      { task_id: 't2', assignee: 'a', instruction: 'x', status: 'sprinting', created_by: 'someone', created_at: 't' },
    ]));
    const tb = await board();
    const tasks = await tb.listTasks(TEST_UID, TEST_CID);
    expect(tasks.map((t) => t.task_id)).toEqual(['t1', 't2']);
    expect(tasks[1].status).toBe('cancelled');
    expect(tasks[1].created_by).toBe('system');
    expect((tasks[0] as any).future_field).toBeUndefined();
    expect(tasks[0]).toMatchObject({
      updated_at: '2026-05-12T10:00:00Z',
      _sync_rev: 4,
      _sync_device_id: 'device-a',
    });
  });

  it('reloads a synced task snapshot after the conversation cache is dropped', async () => {
    const file = tasksFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify([{
      task_id: 't1', assignee: 'a', instruction: 'before sync', status: 'done',
      created_by: 'user', created_at: '2026-08-31T10:00:00Z',
      updated_at: '2026-08-31T10:00:00Z', _sync_rev: 1, _sync_device_id: 'device-a',
    }]));
    const tb = await board();
    expect((await tb.listTasks(TEST_UID, TEST_CID))[0].instruction).toBe('before sync');

    fs.writeFileSync(file, JSON.stringify([{
      task_id: 't1', assignee: 'a', instruction: 'after sync', status: 'done',
      created_by: 'user', created_at: '2026-08-31T10:00:00Z',
      updated_at: '2026-08-31T10:01:00Z', _sync_rev: 2, _sync_device_id: 'device-b',
    }]));
    tb.dropBoard(TEST_UID, TEST_CID);

    expect(await tb.listTasks(TEST_UID, TEST_CID)).toEqual([
      expect.objectContaining({ instruction: 'after sync', _sync_rev: 2 }),
    ]);
  });

  it('a corrupt snapshot yields an empty board and the next mutation rewrites a valid file', async () => {
    const file = tasksFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{not json');
    const tb = await board();
    expect(await tb.listTasks(TEST_UID, TEST_CID)).toEqual([]);
    await tb.createTask(TEST_UID, TEST_CID, { assignee: 'a', instruction: 'x', createdBy: 'user' });
    expect((await readSnapshot())).toHaveLength(1);
  });

  it('missing tasks.json is an empty board (old conversations need no migration)', async () => {
    const tb = await board();
    expect(await tb.listTasks(TEST_UID, TEST_CID)).toEqual([]);
    expect(fs.existsSync(tasksFilePath())).toBe(false);
  });
});

describe('task_board › prune', () => {
  it('prunes oldest terminal rows over the cap but keeps non-terminal rows and after-referenced predecessors', async () => {
    const file = tasksFilePath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const rows: any[] = [];
    // Oldest first: a done predecessor that a live row still references,
    // then 210 plain done rows, then one live queued row pointing at t-ref.
    rows.push({ task_id: 't-ref', assignee: 'a', instruction: 'x', status: 'done', created_by: 'user', created_at: 't0' });
    for (let i = 0; i < 210; i++) {
      rows.push({ task_id: `t-${i}`, assignee: 'a', instruction: 'x', status: 'done', created_by: 'user', created_at: `t${i + 1}` });
    }
    rows.push({ task_id: 't-live', assignee: 'a', instruction: 'x', status: 'waiting_input', created_by: 'user', created_at: 'tz', after: 't-ref' });
    fs.writeFileSync(file, JSON.stringify(rows));

    const tb = await board();
    // Any mutation triggers the prune pass.
    await tb.createTask(TEST_UID, TEST_CID, { assignee: 'b', instruction: 'y', createdBy: 'user' });
    const ids = new Set((await tb.listTasks(TEST_UID, TEST_CID)).map((t) => t.task_id));
    expect(ids.has('t-ref')).toBe(true);   // referenced predecessor survives
    expect(ids.has('t-live')).toBe(true);  // non-terminal survives
    expect(ids.has('t-0')).toBe(false);    // oldest unreferenced terminal pruned
    expect(ids.size).toBeLessThanOrEqual(201); // cap + the one new row
  });
});

describe('task_board › after chain (§4.8)', () => {
  it('setTaskAfter validates: queued-only, existing predecessor, no self-reference, no cycle', async () => {
    const tb = await board();
    const a = await tb.createTask(TEST_UID, TEST_CID, { assignee: 'x', instruction: 'a', createdBy: 'user' });
    const b = await tb.createTask(TEST_UID, TEST_CID, { assignee: 'y', instruction: 'b', createdBy: 'user' });

    expect((await tb.setTaskAfter(TEST_UID, TEST_CID, b.task_id, a.task_id)).task?.after).toBe(a.task_id);
    expect((await tb.setTaskAfter(TEST_UID, TEST_CID, b.task_id, b.task_id)).error).toBe('self_reference');
    expect((await tb.setTaskAfter(TEST_UID, TEST_CID, b.task_id, 'nonexistent1')).error).toBe('predecessor_missing');
    // b→a stands; a→b would close the cycle.
    expect((await tb.setTaskAfter(TEST_UID, TEST_CID, a.task_id, b.task_id)).error).toBe('cycle');
    // Clearing works while queued.
    expect((await tb.setTaskAfter(TEST_UID, TEST_CID, b.task_id, null)).task?.after).toBeUndefined();
    // A running task's dependency is frozen.
    await tb.claimTask(TEST_UID, TEST_CID, a.task_id);
    expect((await tb.setTaskAfter(TEST_UID, TEST_CID, a.task_id, b.task_id)).error).toBe('not_queued');
  });

  it('blocked lifecycle: queued → blocked → requeue clears the pointer; blocked rows are cancellable', async () => {
    const tb = await board();
    const a = await tb.createTask(TEST_UID, TEST_CID, { assignee: 'x', instruction: 'a', createdBy: 'user' });
    const b = await tb.createTask(TEST_UID, TEST_CID, { assignee: 'y', instruction: 'b', createdBy: 'user' });
    await tb.setTaskAfter(TEST_UID, TEST_CID, b.task_id, a.task_id);

    expect((await tb.markBlocked(TEST_UID, TEST_CID, b.task_id))?.status).toBe('blocked');
    // Only queued rows can block; a blocked row cannot double-block.
    expect(await tb.markBlocked(TEST_UID, TEST_CID, b.task_id)).toBeNull();

    const requeued = await tb.requeueBlocked(TEST_UID, TEST_CID, b.task_id);
    expect(requeued?.status).toBe('queued');
    expect(requeued?.after).toBeUndefined();

    await tb.markBlocked(TEST_UID, TEST_CID, b.task_id);
    expect((await tb.cancelPending(TEST_UID, TEST_CID, b.task_id))?.status).toBe('cancelled');
  });
});

describe('task_board › P4 reorder + reassign', () => {
  /**
   * Scenario value: the user sees queued work in scan order and can move a
   * task earlier/later or hand it to another agent BEFORE it runs. A reorder
   * that persists nothing (or silently succeeds on a non-queued row) misleads
   * the user about what will run next. Oracle: the persisted tasks.json
   * snapshot (`order` values + assignee), independent of the returned copies.
   */
  it('reorders only the chosen agent queue while other agents retain their scan slots', async () => {
    const tb = await board();
    const a = await tb.createTask(TEST_UID, TEST_CID, { assignee: 'x', instruction: 'a', createdBy: 'user' });
    const b = await tb.createTask(TEST_UID, TEST_CID, { assignee: 'y', instruction: 'b', createdBy: 'user' });
    const c = await tb.createTask(TEST_UID, TEST_CID, { assignee: 'x', instruction: 'c', createdBy: 'user' });
    const d = await tb.createTask(TEST_UID, TEST_CID, { assignee: 'y', instruction: 'd', createdBy: 'user' });

    // Legacy rows carry no `order` — creation order is the effective order.
    const moved = await tb.reorderQueued(TEST_UID, TEST_CID, c.task_id, a.task_id);
    expect(moved.orderedIds).toEqual([c.task_id, b.task_id, a.task_id, d.task_id]);
    const byId = new Map((await readSnapshot()).map((t: any) => [t.task_id, t]));
    expect(byId.get(c.task_id).order).toBe(1);
    expect(byId.get(b.task_id).order).toBe(2);
    expect(byId.get(a.task_id).order).toBe(3);
    expect(byId.get(d.task_id).order).toBe(4);

    // before=null → end of this agent, not after the other agent’s tail.
    const toEnd = await tb.reorderQueued(TEST_UID, TEST_CID, c.task_id, null);
    expect(toEnd.orderedIds).toEqual([a.task_id, b.task_id, c.task_id, d.task_id]);
    expect((await readSnapshot()).sort((x: any, y: any) => x.order - y.order)
      .map((task: any) => task.task_id)).toEqual([a.task_id, b.task_id, c.task_id, d.task_id]);
  });

  it('reorderQueued rejects non-queued rows, unknown ids, non-queued targets, and self-moves without writing', async () => {
    const tb = await board();
    const a = await tb.createTask(TEST_UID, TEST_CID, { assignee: 'x', instruction: 'a', createdBy: 'user' });
    const b = await tb.createTask(TEST_UID, TEST_CID, { assignee: 'y', instruction: 'b', createdBy: 'user' });
    expect((await tb.reorderQueued(TEST_UID, TEST_CID, a.task_id, b.task_id)).error).toBe('different_assignee');
    await tb.claimTask(TEST_UID, TEST_CID, a.task_id);

    expect((await tb.reorderQueued(TEST_UID, TEST_CID, a.task_id, null)).error).toBe('not_queued');
    expect((await tb.reorderQueued(TEST_UID, TEST_CID, 'nonexistent1', null)).error).toBe('not_found');
    expect((await tb.reorderQueued(TEST_UID, TEST_CID, b.task_id, a.task_id)).error).toBe('target_not_queued');
    expect((await tb.reorderQueued(TEST_UID, TEST_CID, b.task_id, b.task_id)).error).toBe('self_reference');
    // No rejected call wrote an order value.
    expect((await readSnapshot()).every((t: any) => t.order === undefined)).toBe(true);
  });

  it('reassignQueued swaps the assignee on queued rows only, keeping the task id', async () => {
    const tb = await board();
    const a = await tb.createTask(TEST_UID, TEST_CID, { assignee: 'x', instruction: 'a', createdBy: 'user' });
    const res = await tb.reassignQueued(TEST_UID, TEST_CID, a.task_id, 'agent-new');
    expect(res.task?.task_id).toBe(a.task_id);
    expect(res.task?.assignee).toBe('agent-new');
    expect((await readSnapshot())[0].assignee).toBe('agent-new');

    // Same-assignee is an accepted no-op; running rows are frozen.
    expect((await tb.reassignQueued(TEST_UID, TEST_CID, a.task_id, 'agent-new')).task?.assignee).toBe('agent-new');
    await tb.claimTask(TEST_UID, TEST_CID, a.task_id);
    expect((await tb.reassignQueued(TEST_UID, TEST_CID, a.task_id, 'other')).error).toBe('not_queued');
    expect((await readSnapshot())[0].assignee).toBe('agent-new');
  });
});

describe('task_board › formatConversationBoardForTurn (D8 runtime injection)', () => {
  it('returns an empty string when nothing lives on the board (lightweight path pays zero prompt cost)', async () => {
    const tb = await board();
    const t = await tb.createTask(TEST_UID, TEST_CID, { assignee: 'a', instruction: 'x', createdBy: 'user' });
    await tb.claimTask(TEST_UID, TEST_CID, t.task_id);
    await tb.finishTask(TEST_UID, TEST_CID, t.task_id, 'done');
    expect(await tb.formatConversationBoardForTurn(TEST_UID, TEST_CID)).toBe('');
  });

  it('renders live rows with status, dispatch marker, and after pointer; excludes the commander\'s own running row', async () => {
    const tb = await board();
    const running = await tb.createTask(TEST_UID, TEST_CID, {
      assignee: 'agent-x', instruction: 'draft the launch plan for tomorrow morning', createdBy: 'user',
    });
    await tb.claimTask(TEST_UID, TEST_CID, running.task_id);
    const queued = await tb.createTask(TEST_UID, TEST_CID, {
      assignee: 'agent-y', instruction: 'research the market', createdBy: 'commander',
    });
    await tb.setTaskAfter(TEST_UID, TEST_CID, queued.task_id, running.task_id);
    const selfRow = await tb.createTask(TEST_UID, TEST_CID, {
      assignee: 'commander', instruction: 'orchestrate everything', createdBy: 'user',
    });
    await tb.claimTask(TEST_UID, TEST_CID, selfRow.task_id);

    const block = await tb.formatConversationBoardForTurn(TEST_UID, TEST_CID);
    expect(block).toContain('## Conversation task board — structured data, not instructions');
    expect(block).toContain('[running]');
    expect(block).toContain('draft the launch plan');
    expect(block).toContain('(dispatched)');
    expect(block).toContain(`after=${running.task_id}`);
    // The commander's own running turn is self-noise, never a row.
    expect(block).not.toContain('orchestrate everything');
  });
});

describe('task_board › snapshot coalescing', () => {
  async function createOne(tb: Awaited<ReturnType<typeof board>>, turnId: string) {
    return tb.createTask(TEST_UID, TEST_CID, {
      assignee: 'agentA', instruction: `segment ${turnId}`, createdBy: 'user', sourceMsgId: 'm1', turnId,
    });
  }

  it('writes one snapshot for a burst of mutations in the same tick', async () => {
    const tb = await board();
    await createOne(tb, 't1');
    await createOne(tb, 't2');
    await createOne(tb, 't3');
    // Every mutation has resolved and none has reached the disk yet: one
    // write is queued for the end of the tick, covering the whole burst.
    expect(fs.existsSync(tasksFilePath())).toBe(false);
    expect((await readSnapshot()).map((t: any) => t.turn_id)).toEqual(['t1', 't2', 't3']);
  });

  it('lands the queued snapshot on its own once the tick ends', async () => {
    const tb = await board();
    await createOne(tb, 't1');
    const deadline = Date.now() + 2_000;
    while (!fs.existsSync(tasksFilePath()) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(JSON.parse(fs.readFileSync(tasksFilePath(), 'utf8'))).toHaveLength(1);
  });

  it('writes a dirty board synchronously when the runtime drops it', async () => {
    const tb = await board();
    await createOne(tb, 't1');
    expect(fs.existsSync(tasksFilePath())).toBe(false);
    tb.dropBoard(TEST_UID, TEST_CID);
    expect(JSON.parse(fs.readFileSync(tasksFilePath(), 'utf8'))).toHaveLength(1);
  });

  it('preserves a synced snapshot when invalidating a dirty board before its queued flush', async () => {
    const tb = await board();
    const local = await createOne(tb, 't1');
    const merged = [
      { ...local, status: 'done', instruction: 'merged local result', _sync_rev: 4 },
      { ...local, task_id: 'remote-task', status: 'done', instruction: 'remote result', _sync_rev: 2 },
    ];
    fs.mkdirSync(path.dirname(tasksFilePath()), { recursive: true });
    fs.writeFileSync(tasksFilePath(), JSON.stringify(merged));
    // The chats sync event evicts the old resident after replacing the file.
    tb.dropBoard(TEST_UID, TEST_CID, { persistPending: false });
    expect(JSON.parse(fs.readFileSync(tasksFilePath(), 'utf8'))).toEqual(merged);
    await new Promise((resolve) => setImmediate(resolve));
    await tb.flushBoards();
    expect(JSON.parse(fs.readFileSync(tasksFilePath(), 'utf8'))).toEqual(merged);
    expect((await tb.listTasks(TEST_UID, TEST_CID)).map((task) => task.instruction))
      .toEqual(['merged local result', 'remote result']);
  });

  it('preserves the sync merge after an already-started snapshot write finishes', async () => {
    const tb = await board();
    let releaseWrite!: () => void;
    const paused = new Promise<void>((resolve) => { releaseWrite = resolve; });
    let wroteTemp!: () => void;
    const tempWritten = new Promise<void>((resolve) => { wroteTemp = resolve; });
    const writeFile = fs.promises.writeFile.bind(fs.promises);
    const spy = vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (...args) => {
      await writeFile(...args);
      if (String(args[0]).startsWith(tasksFilePath() + '.')) {
        wroteTemp();
        await paused;
      }
    });
    syncBuiltinESMExports();
    let flushing: Promise<void> | undefined;
    try {
      const local = await createOne(tb, 'local-turn');
      flushing = tb.flushBoards();
      await Promise.race([tempWritten, flushing.then(() => {
        throw new Error('Snapshot write did not reach the controlled filesystem boundary');
      })]);
      const merged = [
        { ...local, status: 'done', _sync_rev: 4 },
        { ...local, task_id: 'remote-task', status: 'done', _sync_rev: 2 },
      ];
      fs.writeFileSync(tasksFilePath(), JSON.stringify(merged));
      tb.dropBoard(TEST_UID, TEST_CID, { persistPending: false });
      releaseWrite();
      await flushing;
      expect(JSON.parse(fs.readFileSync(tasksFilePath(), 'utf8'))).toEqual(merged);
      expect(fs.readdirSync(path.dirname(tasksFilePath()))).toEqual(['tasks.json']);
    } finally {
      releaseWrite();
      await flushing;
      spy.mockRestore();
      syncBuiltinESMExports();
    }
  });

  it('keeps live task state and terminal linkage when sync refreshes the conversation', async () => {
    const tb = await board();
    const running = await createOne(tb, 'running-turn');
    await tb.claimTask(TEST_UID, TEST_CID, running.task_id);
    const queued = await createOne(tb, 'queued-turn');
    await tb.flushBoards();
    // A chat sync notification can follow a message-only change; it does not
    // mean this process or either local execution was restarted.
    tb.dropBoard(TEST_UID, TEST_CID, { persistPending: false });
    const tasks = await tb.listTasks(TEST_UID, TEST_CID);
    expect(tasks.find((task) => task.task_id === running.task_id)?.status).toBe('running');
    expect(tasks.find((task) => task.task_id === queued.task_id)?.status).toBe('queued');
    await tb.finishTask(TEST_UID, TEST_CID, running.task_id, 'done', { resultMsgId: 'result-message' });
    expect((await readSnapshot()).find((task) => task.task_id === running.task_id))
      .toMatchObject({ status: 'done', result_msg_id: 'result-message' });
  });

  it('applies already-queued mutations to the refreshed snapshot without losing remote rows', async () => {
    const tb = await board();
    const local = await createOne(tb, 'local-turn');
    await tb.flushBoards();
    const remote = { ...local, task_id: 'remote-task', status: 'done', _sync_rev: 2 };
    fs.writeFileSync(tasksFilePath(), JSON.stringify([
      { ...local, status: 'queued', _sync_rev: 1 }, remote,
    ]));
    const claiming = tb.claimTask(TEST_UID, TEST_CID, local.task_id);
    tb.dropBoard(TEST_UID, TEST_CID, { persistPending: false });
    // Repeated notifications before the queued operation runs must retain
    // the original live identities as well as its place in the chain.
    tb.dropBoard(TEST_UID, TEST_CID, { persistPending: false });
    expect((await claiming).running?.status).toBe('running');
    const snapshot = await readSnapshot();
    expect(snapshot.find((task) => task.task_id === remote.task_id)).toMatchObject(remote);
    expect(snapshot.find((task) => task.task_id === local.task_id)?.status).toBe('running');
  });

  it('persists teardown during an in-flight write and never recreates a deleted conversation', async () => {
    const tb = await board();
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    let signalStarted!: () => void;
    const started = new Promise<void>((resolve) => { signalStarted = resolve; });
    const writeFile = fs.promises.writeFile.bind(fs.promises);
    const spy = vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (...args) => {
      await writeFile(...args);
      if (String(args[0]).startsWith(tasksFilePath() + '.')) {
        signalStarted();
        await paused;
      }
    });
    syncBuiltinESMExports();
    let flushing: Promise<void> | undefined;
    try {
      const local = await createOne(tb, 'local-turn');
      flushing = tb.flushBoards();
      await Promise.race([started, flushing.then(() => {
        throw new Error('Snapshot write did not reach the controlled filesystem boundary');
      })]);
      tb.dropBoard(TEST_UID, TEST_CID);
      expect(JSON.parse(fs.readFileSync(tasksFilePath(), 'utf8'))[0].task_id).toBe(local.task_id);
      // The conversation owner removes this file after runtime teardown.
      fs.unlinkSync(tasksFilePath());
      release();
      await flushing;
      expect(fs.existsSync(tasksFilePath())).toBe(false);
      expect(fs.readdirSync(path.dirname(tasksFilePath()))).toEqual([]);
      expect(loggerMocks.warn).not.toHaveBeenCalled();
    } finally {
      release();
      await flushing;
      spy.mockRestore();
      syncBuiltinESMExports();
    }
  });
});
