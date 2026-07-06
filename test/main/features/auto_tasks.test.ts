/**
 * Automation tasks — `isDue` boundary semantics for the 4 schedule types.
 *
 * Locks the contract the in-process scheduler relies on:
 *   - one_time: fires once when `now >= at`, never again after `last_run_at`
 *   - daily: fires when today's HH:MM boundary is crossed AND we haven't
 *     fired since that boundary
 *   - weekly: same as daily, gated on `now.getDay() === weekday`
 *   - monthly: same as daily, gated on `now.getDate() === target` where
 *     target = min(day, lastDayOfThisMonth) so day=31 falls back to the
 *     last day in shorter months
 *
 * Pure time math — no IO involved — keeping coverage tight on the seam the
 * scheduler tick uses every 30s.
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  autoTaskAttachmentsDir,
  autoTaskConfigFile,
  chatAttachmentDir,
  projectBindingsFile,
  projectMetaFile,
  userRoot,
} from '../../../src/main/paths';
import {
  createTask,
  deleteAttachment,
  applyAutoTaskContainerFromCommander,
  extractAutoTaskContainers,
  getTask,
  isDue,
  listAttachments,
  listTasks,
  nextDueAtForTest,
  stopScheduler,
  subscribeFires,
  updateTask,
  uploadAttachment,
  _buildSeedTextForTest,
  _onTimerFireForTest,
  type AutoTask,
  type Schedule,
} from '../../../src/main/features/auto_tasks';
import { setCurrentLang } from '../../../src/main/i18n';

const autoRuntime = vi.hoisted(() => ({
  createConversation: vi.fn(),
  deleteConversation: vi.fn(),
  send: vi.fn(),
}));

vi.mock('../../../src/main/features/chats', () => ({
  createConversation: autoRuntime.createConversation,
  deleteConversation: autoRuntime.deleteConversation,
}));

vi.mock('../../../src/main/features/group_chat', () => ({
  send: autoRuntime.send,
}));

const TEST_UID = 'auto-unit-user';

function makeTask(schedule: Schedule, overrides: Partial<AutoTask> = {}): AutoTask {
  return {
    id: 'at_00000001',
    enabled: true,
    content: 'hello',
    schedule,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function writeProject(uid: string, projectId: string, agentIds: string[] = []) {
  const now = '2026-01-01T00:00:00';
  fs.mkdirSync(path.dirname(projectMetaFile(uid, projectId)), { recursive: true });
  fs.writeFileSync(projectMetaFile(uid, projectId), JSON.stringify({
    project_id: projectId,
    name: 'Scoped project',
    owner_uid: uid,
    created_at: now,
    updated_at: now,
  }));
  fs.writeFileSync(projectBindingsFile(uid, projectId), JSON.stringify({
    agents: agentIds,
    skills: [],
  }));
}

beforeEach(() => {
  stopScheduler();
  vi.useRealTimers();
  fs.rmSync(userRoot(TEST_UID), { recursive: true, force: true });
  autoRuntime.createConversation.mockReset();
  autoRuntime.deleteConversation.mockReset();
  autoRuntime.send.mockReset();
  autoRuntime.createConversation.mockResolvedValue({ conversation_id: 'cid_auto' });
  autoRuntime.deleteConversation.mockResolvedValue(true);
  autoRuntime.send.mockResolvedValue({ ok: true });
});

afterEach(() => {
  stopScheduler();
  vi.useRealTimers();
  setCurrentLang('en');
  fs.rmSync(userRoot(TEST_UID), { recursive: true, force: true });
});

describe('seed text composition', () => {
  it('expands skill and connector chips instead of emitting raw i18n keys', () => {
    setCurrentLang('zh');
    const task = makeTask(
      { type: 'daily', hour: 9, minute: 0 },
      {
        content: '查看 Orkas 项目最近 24h 新增的 issue。包括新建和回复。',
        recipient: { kind: 'agent', id: 'agent_codex', name: 'Codex' },
        skill: { id: 'deep-research', name: '深度研究' },
        connector: { id: 'github', name: 'GitHub' },
      },
    );
    const text = _buildSeedTextForTest(task);
    expect(text).toBe('@Codex 使用 GitHub 连接器：使用 深度研究 技能：查看 Orkas 项目最近 24h 新增的 issue。包括新建和回复。');
    expect(text).not.toContain('connectors.use_prefix');
    expect(text).not.toContain('skills.use_prefix');
  });
});

describe('task CRUD normalization', () => {
  it('normalizes drafts and clears optional fields on update', async () => {
    const created = await createTask(TEST_UID, {
      id: 'at_11111111',
      title: '  Project report  ',
      content: '  run the report  ',
      project_id: 'p_auto_project',
      attachments: ['brief.md', '', 42 as any],
      recipient: { kind: 'agent', id: 'agent_a', name: 'Agent A' },
      skill: { id: 'skill_a', name: 'Skill A' },
      connector: { id: 'connector_a', name: 'Connector A' },
      schedule: { type: 'daily', hour: 9, minute: 0 },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.task.content).toBe('run the report');
    expect(created.task.title).toBe('Project report');
    expect(created.task.project_id).toBe('p_auto_project');
    expect(created.task.attachments).toEqual(['brief.md']);

    const updated = await updateTask(TEST_UID, 'at_11111111', {
      title: '   ',
      project_id: null,
      attachments: [],
      skill: null as any,
      connector: null as any,
      schedule: { type: 'monthly', day: 31, hour: 10, minute: 30 },
      content: '  updated  ',
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.task.content).toBe('updated');
    expect(updated.task.title).toBeUndefined();
    expect(updated.task.project_id).toBeUndefined();
    expect(updated.task.attachments).toBeUndefined();
    expect(updated.task.skill).toBeUndefined();
    expect(updated.task.connector).toBeUndefined();
    expect(updated.task.schedule).toEqual({ type: 'monthly', day: 31, hour: 10, minute: 30 });
    expect(await listTasks(TEST_UID, { projectId: null })).toHaveLength(1);
  });

  it('rejects project-scoped tasks whose recipient agent is not bound to the project', async () => {
    writeProject(TEST_UID, 'p_auto_scoped', ['agent_allowed']);

    const denied = await createTask(TEST_UID, {
      id: 'at_12121212',
      content: 'run project automation',
      project_id: 'p_auto_scoped',
      recipient: { kind: 'agent', id: 'agent_denied', name: 'Denied' },
      schedule: { type: 'daily', hour: 9, minute: 0 },
    });
    expect(denied).toEqual({ ok: false, error: 'invalid_recipient' });

    const allowed = await createTask(TEST_UID, {
      id: 'at_13131313',
      content: 'run project automation',
      project_id: 'p_auto_scoped',
      recipient: { kind: 'agent', id: 'agent_allowed', name: 'Allowed' },
      schedule: { type: 'daily', hour: 9, minute: 0 },
    });
    expect(allowed.ok).toBe(true);

    const updated = await updateTask(TEST_UID, 'at_13131313', {
      recipient: { kind: 'agent', id: 'agent_denied', name: 'Denied' },
    });
    expect(updated).toEqual({ ok: false, error: 'invalid_recipient' });
  });

  it('rejects invalid drafts and ignores malformed on-disk configs', async () => {
    expect((await createTask(TEST_UID, {
      id: 'not-safe',
      content: 'hello',
      schedule: { type: 'daily', hour: 9, minute: 0 },
    })).ok).toBe(false);
    expect((await createTask(TEST_UID, {
      id: 'at_22222222',
      content: 'hello',
      recipient: { kind: 'agent', id: 'agent_a', name: '' },
      schedule: { type: 'daily', hour: 9, minute: 0 },
    })).ok).toBe(false);
    expect((await createTask(TEST_UID, {
      id: 'at_33333333',
      content: 'hello',
      schedule: { type: 'monthly', day: 0, hour: 9, minute: 0 },
    })).ok).toBe(false);

    fs.mkdirSync(path.dirname(autoTaskConfigFile(TEST_UID, 'at_44444444')), { recursive: true });
    fs.writeFileSync(autoTaskConfigFile(TEST_UID, 'at_44444444'), JSON.stringify({
      id: 'at_44444444',
      enabled: true,
      content: 'bad schedule',
      schedule: { type: 'weekly', weekday: 9, hour: 9, minute: 0 },
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    }));
    expect(await getTask(TEST_UID, 'at_44444444')).toBeNull();
    expect(await listTasks(TEST_UID)).toEqual([]);
  });
});

describe('commander auto-task container', () => {
  it('extracts and applies create, update, disable, and delete containers', async () => {
    const createdBlock = [
      '<auto-task>',
      '<action>create</action>',
      '<title>Morning review</title>',
      '<content>Summarize yesterday and plan today.</content>',
      '<schedule>{"type":"daily","hour":9,"minute":0}</schedule>',
      '<recipient>{"kind":"commander"}</recipient>',
      '</auto-task>',
    ].join('\n');
    const createExtract = extractAutoTaskContainers(`done\n${createdBlock}\nvisible`);
    expect(createExtract.cleanText).toBe('done\n\nvisible');
    expect(createExtract.containers).toHaveLength(1);

    const created = await applyAutoTaskContainerFromCommander(TEST_UID, createExtract.containers[0]);
    expect(created.ok).toBe(true);
    expect(created.kind).toBe('created');
    expect(created.task?.title).toBe('Morning review');
    expect(created.task?.schedule).toEqual({ type: 'daily', hour: 9, minute: 0 });

    const taskId = created.taskId!;
    const updateExtract = extractAutoTaskContainers([
      '<auto-task>',
      '<action>update</action>',
      `<task_id>${taskId}</task_id>`,
      '<schedule>{"type":"weekly","weekday":5,"hour":10,"minute":30}</schedule>',
      '<skill>{"id":"research","name":"Research"}</skill>',
      '</auto-task>',
    ].join('\n'));
    const updated = await applyAutoTaskContainerFromCommander(TEST_UID, updateExtract.containers[0]);
    expect(updated.ok).toBe(true);
    expect(updated.kind).toBe('updated');
    expect(updated.task?.schedule).toEqual({ type: 'weekly', weekday: 5, hour: 10, minute: 30 });
    expect(updated.task?.skill).toEqual({ id: 'research', name: 'Research' });

    const disabled = await applyAutoTaskContainerFromCommander(TEST_UID, {
      action: 'disable',
      taskId,
      updates: {},
    });
    expect(disabled.ok).toBe(true);
    expect(disabled.kind).toBe('disabled');
    expect(disabled.task?.enabled).toBe(false);

    const deleted = await applyAutoTaskContainerFromCommander(TEST_UID, {
      action: 'delete',
      taskId,
      updates: {},
    });
    expect(deleted.ok).toBe(true);
    expect(deleted.kind).toBe('deleted');
    expect(await getTask(TEST_UID, taskId)).toBeNull();
  });

  it('stages current conversation attachments referenced by a container', async () => {
    const sourceCid = 'cid_auto_source';
    const sourceDir = chatAttachmentDir(TEST_UID, sourceCid);
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'brief.md'), 'brief body');

    const extracted = extractAutoTaskContainers([
      '<auto-task>',
      '<action>create</action>',
      '<content>Use the attached brief every morning.</content>',
      '<schedule>{"type":"daily","hour":8,"minute":0}</schedule>',
      '<attachments>["brief.md"]</attachments>',
      '</auto-task>',
    ].join('\n'));
    const created = await applyAutoTaskContainerFromCommander(TEST_UID, extracted.containers[0], {
      sourceAttachmentCid: sourceCid,
    });

    expect(created.ok).toBe(true);
    const taskId = created.taskId!;
    expect(created.task?.attachments).toEqual(['brief.md']);
    expect(fs.readFileSync(path.join(autoTaskAttachmentsDir(TEST_UID, taskId), 'brief.md'), 'utf8')).toBe('brief body');
  });

  it('does not extract literal auto-task examples in non-xml code fences or inline mentions', () => {
    const fenced = 'Format:\n```\n<auto-task><action>delete</action></auto-task>\n```\nreal text';
    expect(extractAutoTaskContainers(fenced).containers).toEqual([]);
    const inline = 'Use `<auto-task>` after reading the system skill.';
    expect(extractAutoTaskContainers(inline).containers).toEqual([]);
  });
});

describe('attachments', () => {
  it('sanitizes uploaded names, filters non-files, and deletes by sanitized name', async () => {
    const taskId = 'at_55555555';
    expect((await uploadAttachment(TEST_UID, taskId, '.env', Buffer.from('secret'))).ok).toBe(false);
    expect((await uploadAttachment(TEST_UID, 'bad-id', 'brief.md', Buffer.from('brief'))).ok).toBe(false);

    const nested = await uploadAttachment(TEST_UID, taskId, 'nested\\brief.md', Buffer.from('nested'));
    expect(nested).toEqual({ ok: true, name: 'nested_brief.md' });
    const escaped = await uploadAttachment(TEST_UID, taskId, '../escape.md', Buffer.from('escape'));
    expect(escaped).toEqual({ ok: true, name: 'escape.md' });

    const dir = autoTaskAttachmentsDir(TEST_UID, taskId);
    fs.writeFileSync(path.join(dir, '.DS_Store'), 'metadata');
    fs.mkdirSync(path.join(dir, 'not-a-file'));
    expect((await listAttachments(TEST_UID, taskId)).sort()).toEqual(['escape.md', 'nested_brief.md']);

    expect((await deleteAttachment(TEST_UID, taskId, '../escape.md')).ok).toBe(true);
    expect(fs.existsSync(path.join(dir, 'escape.md'))).toBe(false);
    expect(await listAttachments(TEST_UID, 'bad-id')).toEqual([]);
  });
});

describe('scheduler dispatch', () => {
  it('fires a due one-time task, copies attachments, emits an event, and disables the task', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-22T09:00:00.000Z'));

    const events: any[] = [];
    const unsubscribe = subscribeFires((ev) => events.push(ev));
    const taskId = 'at_66666666';
    await uploadAttachment(TEST_UID, taskId, '../brief.md', Buffer.from('brief'));

    const created = await createTask(TEST_UID, {
      id: taskId,
      title: 'Morning run',
      content: 'send the morning report',
      project_id: 'p_auto_project',
      attachments: ['brief.md', 'missing.md'],
      recipient: { kind: 'agent', id: 'agent_codex', name: 'Codex' },
      schedule: { type: 'one_time', at: '2026-05-22T08:59:00.000Z' },
    });
    expect(created.ok).toBe(true);

    await _onTimerFireForTest(TEST_UID, taskId);
    unsubscribe();

    expect(autoRuntime.createConversation).toHaveBeenCalledWith(TEST_UID, {
      kind: 'normal',
      title: 'Morning run',
      projectId: 'p_auto_project',
      originAutoTaskId: taskId,
    });
    expect(autoRuntime.send).toHaveBeenCalledWith({
      userId: TEST_UID,
      cid: 'cid_auto',
      text: '@Codex send the morning report',
      attachments: ['brief.md'],
    });
    expect(autoRuntime.deleteConversation).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'conv_created', cid: 'cid_auto', task_id: taskId });
    expect(events[0].duration_ms).toEqual(expect.any(Number));
    expect(fs.readFileSync(path.join(chatAttachmentDir(TEST_UID, 'cid_auto'), 'brief.md'), 'utf8')).toBe('brief');

    const task = await getTask(TEST_UID, taskId);
    expect(task?.enabled).toBe(false);
    expect(task?.last_run_at).toBe('2026-05-22T09:00:00.000Z');
  });

  it('rolls back the empty conversation and emits a failure fire event when dispatch fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-22T09:00:00.000Z'));
    autoRuntime.send.mockResolvedValue({ ok: false, error: 'model unavailable' });

    const events: any[] = [];
    const unsubscribe = subscribeFires((ev) => events.push(ev));
    const taskId = 'at_77777777';
    const created = await createTask(TEST_UID, {
      id: taskId,
      content: 'run once',
      schedule: { type: 'one_time', at: '2026-05-22T08:59:00.000Z' },
    });
    expect(created.ok).toBe(true);

    await _onTimerFireForTest(TEST_UID, taskId);
    unsubscribe();

    expect(autoRuntime.createConversation).toHaveBeenCalledTimes(1);
    expect(autoRuntime.deleteConversation).toHaveBeenCalledWith(TEST_UID, 'cid_auto');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'fire_failed',
      cid: 'cid_auto',
      task_id: taskId,
      error_code: 'send_not_ok',
    });
    expect(events[0].duration_ms).toEqual(expect.any(Number));
    const task = await getTask(TEST_UID, taskId);
    expect(task?.enabled).toBe(false);
    expect(task?.last_run_at).toBe('2026-05-22T09:00:00.000Z');
  });

  it('claims a due boundary so concurrent schedulers cannot double-fire it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 22, 8, 30, 0));
    autoRuntime.createConversation
      .mockResolvedValueOnce({ conversation_id: 'cid_auto_1' })
      .mockResolvedValueOnce({ conversation_id: 'cid_auto_2' });

    const taskId = 'at_88888888';
    const created = await createTask(TEST_UID, {
      id: taskId,
      content: 'daily run',
      schedule: { type: 'daily', hour: 9, minute: 0 },
    });
    expect(created.ok).toBe(true);

    vi.setSystemTime(new Date(2026, 4, 22, 9, 0, 0));
    await Promise.all([
      _onTimerFireForTest(TEST_UID, taskId),
      _onTimerFireForTest(TEST_UID, taskId),
    ]);

    expect(autoRuntime.createConversation).toHaveBeenCalledTimes(1);
    expect(autoRuntime.send).toHaveBeenCalledTimes(1);
    let task = await getTask(TEST_UID, taskId);
    expect(task?.last_run_at).toBe(new Date(2026, 4, 22, 9, 0, 0).toISOString());

    vi.setSystemTime(new Date(2026, 4, 23, 9, 0, 0));
    await _onTimerFireForTest(TEST_UID, taskId);

    expect(autoRuntime.createConversation).toHaveBeenCalledTimes(2);
    expect(autoRuntime.send).toHaveBeenCalledTimes(2);
    task = await getTask(TEST_UID, taskId);
    expect(task?.last_run_at).toBe(new Date(2026, 4, 23, 9, 0, 0).toISOString());
  });
});

describe('isDue: one_time', () => {
  it('fires when now >= at and no prior run', () => {
    const task = makeTask({ type: 'one_time', at: '2026-05-22T09:00:00.000Z' });
    expect(isDue(task, new Date('2026-05-22T09:00:00.000Z'), null)).toBe(true);
    expect(isDue(task, new Date('2026-05-22T09:00:30.000Z'), null)).toBe(true);
  });

  it('does not fire before `at`', () => {
    const task = makeTask({ type: 'one_time', at: '2026-05-22T09:00:00.000Z' });
    expect(isDue(task, new Date('2026-05-22T08:59:00.000Z'), null)).toBe(false);
  });

  it('never re-fires after a prior run', () => {
    const task = makeTask({ type: 'one_time', at: '2026-05-22T09:00:00.000Z' });
    const lastRun = new Date('2026-05-22T09:00:30.000Z');
    expect(isDue(task, new Date('2026-05-22T09:01:00.000Z'), lastRun)).toBe(false);
    expect(isDue(task, new Date('2026-05-23T09:00:00.000Z'), lastRun)).toBe(false);
  });

  it('disabled task does not fire even when due', () => {
    const task = makeTask({ type: 'one_time', at: '2026-05-22T09:00:00.000Z' }, { enabled: false });
    expect(isDue(task, new Date('2026-05-22T09:00:00.000Z'), null)).toBe(false);
  });
});

describe('isDue: daily', () => {
  // Use local-time fixed values: the boundary is computed in local time by
  // _crossedTodayBoundary. Build Date objects via Date(year, m, d, h, m).
  const sched: Schedule = { type: 'daily', hour: 9, minute: 0 };

  it('fires at the boundary on first run', () => {
    const task = makeTask(sched);
    const now = new Date(2026, 4, 22, 9, 0, 0); // local 09:00
    expect(isDue(task, now, null)).toBe(true);
  });

  it('does not fire before the boundary', () => {
    const task = makeTask(sched);
    const now = new Date(2026, 4, 22, 8, 59, 0);
    expect(isDue(task, now, null)).toBe(false);
  });

  it('does not re-fire after firing past the boundary', () => {
    const task = makeTask(sched);
    const now = new Date(2026, 4, 22, 9, 30, 0);
    const lastRun = new Date(2026, 4, 22, 9, 0, 30); // already ran at boundary
    expect(isDue(task, now, lastRun)).toBe(false);
  });

  it('fires the next day after the new boundary is crossed', () => {
    const task = makeTask(sched);
    const now = new Date(2026, 4, 23, 9, 0, 0);
    const lastRun = new Date(2026, 4, 22, 9, 0, 30);
    expect(isDue(task, now, lastRun)).toBe(true);
  });
});

describe('scheduler next due: recurring creation baseline', () => {
  it('does not schedule disabled tasks or completed one-time tasks', () => {
    const now = new Date(2026, 4, 27, 8, 30, 0);
    expect(nextDueAtForTest(
      makeTask({ type: 'daily', hour: 9, minute: 0 }, { enabled: false }),
      now,
    )).toBeNull();
    expect(nextDueAtForTest(
      makeTask(
        { type: 'one_time', at: new Date(2026, 4, 27, 9, 0, 0).toISOString() },
        { last_run_at: new Date(2026, 4, 27, 9, 0, 1).toISOString() },
      ),
      now,
    )).toBeNull();
  });

  it('does not immediately run a daily task created after today boundary', () => {
    const task = makeTask(
      { type: 'daily', hour: 9, minute: 0 },
      {
        created_at: new Date(2026, 4, 27, 20, 7, 50).toISOString(),
        updated_at: new Date(2026, 4, 27, 20, 7, 50).toISOString(),
      },
    );
    const now = new Date(2026, 4, 27, 20, 7, 51);
    const next = nextDueAtForTest(task, now);
    expect(next?.getFullYear()).toBe(2026);
    expect(next?.getMonth()).toBe(4);
    expect(next?.getDate()).toBe(28);
    expect(next?.getHours()).toBe(9);
    expect(next?.getMinutes()).toBe(0);
  });

  it('still runs a daily task created before today boundary at the boundary', () => {
    const task = makeTask(
      { type: 'daily', hour: 9, minute: 0 },
      {
        created_at: new Date(2026, 4, 27, 8, 30, 0).toISOString(),
        updated_at: new Date(2026, 4, 27, 8, 30, 0).toISOString(),
      },
    );
    const now = new Date(2026, 4, 27, 8, 30, 1);
    const next = nextDueAtForTest(task, now);
    expect(next?.getDate()).toBe(27);
    expect(next?.getHours()).toBe(9);
    expect(next?.getMinutes()).toBe(0);
  });

  it('projects weekly tasks to the matching weekday and then the next week after a run', () => {
    const task = makeTask(
      { type: 'weekly', weekday: 5, hour: 9, minute: 0 },
      {
        created_at: new Date(2026, 4, 18, 8, 0, 0).toISOString(), // Monday
        updated_at: new Date(2026, 4, 18, 8, 0, 0).toISOString(),
      },
    );
    const next = nextDueAtForTest(task, new Date(2026, 4, 18, 10, 0, 0));
    expect(next?.getDay()).toBe(5);
    expect(next?.getDate()).toBe(22);
    expect(next?.getHours()).toBe(9);

    const afterRun = nextDueAtForTest(
      { ...task, last_run_at: new Date(2026, 4, 22, 9, 0, 1).toISOString() },
      new Date(2026, 4, 22, 10, 0, 0),
    );
    expect(afterRun?.getDate()).toBe(29);
    expect(afterRun?.getHours()).toBe(9);
  });

  it('projects day=31 monthly tasks to the next month last day after a run', () => {
    const task = makeTask(
      { type: 'monthly', day: 31, hour: 9, minute: 0 },
      {
        created_at: new Date(2026, 0, 31, 8, 0, 0).toISOString(),
        updated_at: new Date(2026, 0, 31, 8, 0, 0).toISOString(),
        last_run_at: new Date(2026, 0, 31, 9, 0, 1).toISOString(),
      },
    );
    const next = nextDueAtForTest(task, new Date(2026, 0, 31, 10, 0, 0));
    expect(next?.getMonth()).toBe(1);
    expect(next?.getDate()).toBe(28);
    expect(next?.getHours()).toBe(9);
  });
});

describe('isDue: weekly', () => {
  const sched: Schedule = { type: 'weekly', weekday: 5, hour: 18, minute: 15 }; // Friday 18:15

  it('does not fire on a non-matching weekday', () => {
    const task = makeTask(sched);
    const monday = new Date(2026, 4, 18, 18, 15, 0); // 2026-05-18 was a Monday
    expect(isDue(task, monday, null)).toBe(false);
  });

  it('fires on the matching weekday past the boundary', () => {
    const task = makeTask(sched);
    const friday = new Date(2026, 4, 22, 18, 15, 0); // 2026-05-22 is a Friday
    expect(friday.getDay()).toBe(5);
    expect(isDue(task, friday, null)).toBe(true);
  });

  it('does not fire on the matching weekday before the boundary', () => {
    const task = makeTask(sched);
    const fridayMorning = new Date(2026, 4, 22, 9, 0, 0);
    expect(isDue(task, fridayMorning, null)).toBe(false);
  });
});

describe('isDue: monthly', () => {
  it('fires on the specified day of month past the boundary', () => {
    const task = makeTask({ type: 'monthly', day: 15, hour: 12, minute: 0 });
    const now = new Date(2026, 4, 15, 12, 0, 0);
    expect(isDue(task, now, null)).toBe(true);
  });

  it('does not fire on the wrong day of month', () => {
    const task = makeTask({ type: 'monthly', day: 15, hour: 12, minute: 0 });
    const now = new Date(2026, 4, 14, 12, 0, 0);
    expect(isDue(task, now, null)).toBe(false);
  });

  it('day=31 falls back to last day of shorter months', () => {
    const task = makeTask({ type: 'monthly', day: 31, hour: 9, minute: 0 });
    // April 2026 has 30 days. Last day is the 30th.
    const apr30 = new Date(2026, 3, 30, 9, 0, 0);
    expect(isDue(task, apr30, null)).toBe(true);
    // April 29 should NOT fire.
    const apr29 = new Date(2026, 3, 29, 9, 0, 0);
    expect(isDue(task, apr29, null)).toBe(false);
  });

  it('day=31 fires on the 31st of months that have one', () => {
    const task = makeTask({ type: 'monthly', day: 31, hour: 9, minute: 0 });
    const may31 = new Date(2026, 4, 31, 9, 0, 0);
    expect(isDue(task, may31, null)).toBe(true);
  });

  it('day=31 falls back to Feb 28 (non-leap year)', () => {
    const task = makeTask({ type: 'monthly', day: 31, hour: 9, minute: 0 });
    // 2026 is not a leap year → Feb has 28 days.
    const feb28 = new Date(2026, 1, 28, 9, 0, 0);
    expect(isDue(task, feb28, null)).toBe(true);
  });

  it('does not re-fire after firing past the boundary on the same day', () => {
    const task = makeTask({ type: 'monthly', day: 15, hour: 12, minute: 0 });
    const now = new Date(2026, 4, 15, 12, 30, 0);
    const lastRun = new Date(2026, 4, 15, 12, 0, 30);
    expect(isDue(task, now, lastRun)).toBe(false);
  });
});
