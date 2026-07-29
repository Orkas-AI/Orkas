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

const electronRuntime = vi.hoisted(() => ({
  idleState: 'active' as 'active' | 'idle' | 'locked' | 'unknown',
}));

vi.mock('electron', () => ({
  powerMonitor: {
    getSystemIdleState: vi.fn(() => electronRuntime.idleState),
  },
}));

import {
  autoTaskAttachmentsDir,
  autoTaskDir,
  autoTaskConfigFile,
  chatAttachmentDir,
  projectAutoTaskAttachmentsDir,
  projectAutoTaskConfigFile,
  projectBindingsFile,
  projectChatAttachmentDir,
  projectMetaFile,
  userLocalRoot,
  userRoot,
} from '../../../src/main/paths';
import {
  armedDueAtForTest,
  createTask,
  deleteAttachment,
  applyAutoTaskContainerFromCommander,
  extractAutoTaskContainers,
  getCurrentDevice,
  getTask,
  isDue,
  listAttachments,
  listTasks,
  nextDueAfterRestoreForTest,
  nextDueAtForTest,
  rescheduleAllAfterSyncForTest,
  rescheduleAllForTest,
  resumeSchedulerForTest,
  runTaskNow,
  stopScheduler,
  subscribeFires,
  subscribeFiresForUser,
  suspendSchedulerForTest,
  updateTask,
  uploadAttachment,
  _buildSeedTextForTest,
  _onTimerFireForTest,
  _setMarkRanFailureForTest,
  type AutoTask,
  type Schedule,
} from '../../../src/main/features/auto_tasks';
import { setCurrentLang } from '../../../src/main/i18n';
import { _setDeviceFingerprintForTests } from '../../../src/main/util/device';

const autoRuntime = vi.hoisted(() => ({
  createConversation: vi.fn(),
  deleteConversation: vi.fn(),
  send: vi.fn(),
  getAgent: vi.fn(),
}));

vi.mock('../../../src/main/features/chats', () => ({
  createConversation: autoRuntime.createConversation,
  deleteConversation: autoRuntime.deleteConversation,
}));

vi.mock('../../../src/main/features/group_chat', () => ({
  send: autoRuntime.send,
}));

vi.mock('../../../src/main/features/agents', () => ({
  getAgent: autoRuntime.getAgent,
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
  _setDeviceFingerprintForTests(null);
  electronRuntime.idleState = 'active';
  _setMarkRanFailureForTest(null);
  vi.useRealTimers();
  fs.rmSync(userRoot(TEST_UID), { recursive: true, force: true });
  autoRuntime.createConversation.mockReset();
  autoRuntime.deleteConversation.mockReset();
  autoRuntime.send.mockReset();
  autoRuntime.createConversation.mockResolvedValue({ conversation_id: 'cid_auto' });
  autoRuntime.deleteConversation.mockResolvedValue(true);
  autoRuntime.send.mockResolvedValue({ ok: true });
  autoRuntime.getAgent.mockResolvedValue(null);
});

afterEach(() => {
  stopScheduler();
  _setDeviceFingerprintForTests(null);
  _setMarkRanFailureForTest(null);
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

  it('preserves ordered text with multiple inline skills and connectors', () => {
    setCurrentLang('zh');
    const task = makeTask(
      { type: 'daily', hour: 9, minute: 0 },
      {
        content: '鸟 水电费',
        skill: { id: 'brand-research', name: 'brand-research' },
        connector: { id: 'github', name: 'GitHub' },
        message_parts: [
          { type: 'use', kind: 'skill', id: 'brand-research', name: 'brand-research' },
          { type: 'text', text: ' 鸟 ' },
          { type: 'use', kind: 'skill', id: 'content-writer', name: 'content-writer' },
          { type: 'text', text: ' 水电费 ' },
          { type: 'use', kind: 'connector', id: 'github', name: 'GitHub' },
        ],
      },
    );

    expect(_buildSeedTextForTest(task)).toBe(
      'brand-research 技能 鸟 content-writer 技能 水电费 GitHub 连接器',
    );
  });
});

describe('task CRUD normalization', () => {
  it('normalizes drafts and clears optional fields on update', async () => {
    writeProject(TEST_UID, 'p_auto_project', ['agent_a']);
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
    expect(fs.existsSync(autoTaskConfigFile(TEST_UID, 'at_11111111'))).toBe(true);
    expect(fs.existsSync(
      projectAutoTaskConfigFile(TEST_UID, 'p_auto_project', 'at_11111111'),
    )).toBe(false);
    expect((await getTask(TEST_UID, 'at_11111111'))?.project_id).toBeUndefined();
  });

  it('rejects nonexistent project scopes without creating an orphan task directory', async () => {
    const missingProjectId = 'p_missing_project';
    const taskId = 'at_10101010';
    const rejected = await createTask(TEST_UID, {
      id: taskId,
      content: 'run inside a project that does not exist',
      project_id: missingProjectId,
      schedule: { type: 'daily', hour: 9, minute: 0 },
    });

    expect(rejected).toEqual({ ok: false, error: 'invalid_project' });
    expect(fs.existsSync(projectAutoTaskConfigFile(TEST_UID, missingProjectId, taskId))).toBe(false);
    expect(await listTasks(TEST_UID)).toEqual([]);

    const global = await createTask(TEST_UID, {
      id: taskId,
      content: 'start as a valid global task',
      schedule: { type: 'daily', hour: 9, minute: 0 },
    });
    expect(global.ok).toBe(true);

    const moved = await updateTask(TEST_UID, taskId, { project_id: missingProjectId });
    expect(moved).toEqual({ ok: false, error: 'invalid_project' });
    expect(await getTask(TEST_UID, taskId)).toMatchObject({
      id: taskId,
      content: 'start as a valid global task',
    });
    expect(fs.existsSync(projectAutoTaskConfigFile(TEST_UID, missingProjectId, taskId))).toBe(false);
  });

  it('persists ordered message parts and derives clean legacy content', async () => {
    const messageParts = [
      { type: 'use' as const, kind: 'skill' as const, id: 'brand-research', name: 'Brand Research' },
      { type: 'text' as const, text: ' bird ' },
      { type: 'use' as const, kind: 'skill' as const, id: 'content-writer', name: 'Content Writer' },
      { type: 'text' as const, text: '  utility bill ' },
      { type: 'use' as const, kind: 'connector' as const, id: 'github', name: 'GitHub' },
    ];
    const created = await createTask(TEST_UID, {
      id: 'at_14141414',
      content: 'stale fallback text',
      message_parts: messageParts,
      skill: { id: 'brand-research', name: 'Brand Research' },
      connector: { id: 'github', name: 'GitHub' },
      schedule: { type: 'daily', hour: 9, minute: 0 },
    });

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.task.content).toBe('bird utility bill');
    expect(created.task.message_parts).toEqual(messageParts);
    expect((await getTask(TEST_UID, 'at_14141414'))?.message_parts).toEqual(messageParts);

    const metadataOnly = await updateTask(TEST_UID, 'at_14141414', { title: 'Renamed' });
    expect(metadataOnly.ok && metadataOnly.task.message_parts).toEqual(messageParts);

    const legacyMessageEdit = await updateTask(TEST_UID, 'at_14141414', {
      content: 'edited by a legacy client',
    });
    expect(legacyMessageEdit.ok && legacyMessageEdit.task.content).toBe('edited by a legacy client');
    expect(legacyMessageEdit.ok && legacyMessageEdit.task.message_parts).toBeUndefined();
  });

  it('preserves the assigned device on ordinary edits and explicitly rebinds to the current device', async () => {
    const created = await createTask(TEST_UID, {
      id: 'at_16161616',
      content: 'run on the assigned device',
      schedule: { type: 'daily', hour: 9, minute: 0 },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const remoteTask = {
      ...created.task,
      device_id: '11:22:33:44:55:66',
      device_name: 'Remote workstation',
    };
    fs.writeFileSync(autoTaskConfigFile(TEST_UID, remoteTask.id), JSON.stringify(remoteTask));

    const ordinaryEdit = await updateTask(TEST_UID, remoteTask.id, { title: 'Still remote' });
    expect(ordinaryEdit.ok).toBe(true);
    if (!ordinaryEdit.ok) return;
    expect(ordinaryEdit.task.device_id).toBe(remoteTask.device_id);
    expect(ordinaryEdit.task.device_name).toBe(remoteTask.device_name);

    const rebound = await updateTask(TEST_UID, remoteTask.id, { run_on_current_device: true });
    expect(rebound.ok).toBe(true);
    if (!rebound.ok) return;
    const current = getCurrentDevice();
    expect(rebound.task.device_id).toBe(current.id || undefined);
    expect(rebound.task.device_name).toBe(current.name);
    expect((await getTask(TEST_UID, remoteTask.id))?.device_id).toBe(current.id || undefined);
    expect((await getTask(TEST_UID, remoteTask.id))?.device_name).toBe(current.name);
  });

  it('uses the persistent installation id when no network fingerprint is available', async () => {
    _setDeviceFingerprintForTests({ id: '', name: 'No stable NIC' });
    try {
      const created = await createTask(TEST_UID, {
        id: 'at_17171717',
        content: 'run on the assigned device',
        schedule: { type: 'daily', hour: 9, minute: 0 },
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      expect(created.task.device_id).toMatch(/^[0-9a-f]{32}$/i);
      expect(created.task.device_name).toBe('No stable NIC');

      const remoteTask = {
        ...created.task,
        device_id: '11:22:33:44:55:66',
        device_name: 'Remote workstation',
      };
      fs.writeFileSync(autoTaskConfigFile(TEST_UID, remoteTask.id), JSON.stringify(remoteTask));

      const rebound = await updateTask(TEST_UID, remoteTask.id, { run_on_current_device: true });
      expect(rebound.ok).toBe(true);
      if (!rebound.ok) return;
      expect(rebound.task.device_id).toBe(created.task.device_id);
      expect(rebound.task.device_name).toBe('No stable NIC');
    } finally {
      _setDeviceFingerprintForTests(null);
    }
  });

  it('migrates a locally claimed legacy MAC binding after the adapter changes', async () => {
    _setDeviceFingerprintForTests({
      id: 'aa:bb:cc:dd:ee:ff',
      name: 'Test workstation',
    });
    const taskId = 'at_18181818';
    const created = await createTask(TEST_UID, {
      id: taskId,
      content: 'keep running after adapter changes',
      schedule: { type: 'daily', hour: 9, minute: 0 },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const persistentId = created.task.device_id;
    expect(persistentId).toBeTruthy();
    expect(persistentId).not.toBe('11:22:33:44:55:66');

    const legacyTask = {
      ...created.task,
      device_id: '11:22:33:44:55:66',
      device_name: 'Test workstation',
    };
    fs.writeFileSync(autoTaskConfigFile(TEST_UID, taskId), JSON.stringify(legacyTask));
    const claimDir = path.join(userLocalRoot(TEST_UID), 'auto_task_claims', taskId);
    fs.mkdirSync(claimDir, { recursive: true });
    fs.writeFileSync(path.join(claimDir, '1.json'), JSON.stringify({
      task_id: taskId,
      device_id: legacyTask.device_id,
    }));
    stopScheduler();
    _setDeviceFingerprintForTests({
      id: '66:55:44:33:22:11',
      name: 'Test workstation',
    });

    await rescheduleAllForTest(TEST_UID);

    expect(await getTask(TEST_UID, taskId)).toMatchObject({
      device_id: persistentId,
      device_name: 'Test workstation',
    });
    expect(armedDueAtForTest(taskId)).not.toBeNull();
  });

  it('does not migrate a remote legacy MAC binding without local evidence', async () => {
    _setDeviceFingerprintForTests({
      id: 'aa:bb:cc:dd:ee:ff',
      name: 'Local workstation',
    });
    const taskId = 'at_19191919';
    const created = await createTask(TEST_UID, {
      id: taskId,
      content: 'stay on the remote device',
      schedule: { type: 'daily', hour: 9, minute: 0 },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const remoteTask = {
      ...created.task,
      device_id: '11:22:33:44:55:66',
      device_name: 'Remote workstation',
    };
    fs.writeFileSync(autoTaskConfigFile(TEST_UID, taskId), JSON.stringify(remoteTask));
    stopScheduler();

    await rescheduleAllForTest(TEST_UID);

    expect(await getTask(TEST_UID, taskId)).toMatchObject({
      device_id: remoteTask.device_id,
      device_name: remoteTask.device_name,
    });
    expect(armedDueAtForTest(taskId)).toBeNull();
  });

  it('continues to read legacy configs without message parts', async () => {
    const config = {
      id: 'at_15151515',
      enabled: true,
      content: 'legacy task',
      skill: { id: 'reader', name: 'Reader' },
      connector: { id: 'github', name: 'GitHub' },
      schedule: { type: 'daily', hour: 9, minute: 0 },
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
    };
    fs.mkdirSync(path.dirname(autoTaskConfigFile(TEST_UID, config.id)), { recursive: true });
    fs.writeFileSync(autoTaskConfigFile(TEST_UID, config.id), JSON.stringify(config));

    expect(await getTask(TEST_UID, config.id)).toEqual(config);
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
    expect(await createTask(TEST_UID, {
      id: 'at_34343434',
      content: 'hello',
      message_parts: [{ type: 'text', text: 'hello' }],
      schedule: { type: 'daily', hour: 9, minute: 0 },
    })).toEqual({ ok: false, error: 'invalid_message_parts' });

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
    // Directory components are discarded with the same semantics on every host.
    expect(nested).toEqual({ ok: true, name: 'brief.md' });
    const browserFakePath = await uploadAttachment(
      TEST_UID,
      taskId,
      'C:\\fakepath\\windows-brief.md',
      Buffer.from('windows'),
    );
    expect(browserFakePath).toEqual({ ok: true, name: 'windows-brief.md' });
    const escaped = await uploadAttachment(TEST_UID, taskId, '../escape.md', Buffer.from('escape'));
    expect(escaped).toEqual({ ok: true, name: 'escape.md' });

    const dir = autoTaskAttachmentsDir(TEST_UID, taskId);
    fs.writeFileSync(path.join(dir, '.DS_Store'), 'metadata');
    fs.mkdirSync(path.join(dir, 'not-a-file'));
    expect((await listAttachments(TEST_UID, taskId)).sort()).toEqual([
      'brief.md',
      'escape.md',
      'windows-brief.md',
    ]);

    expect((await deleteAttachment(TEST_UID, taskId, '../escape.md')).ok).toBe(true);
    expect(fs.existsSync(path.join(dir, 'escape.md'))).toBe(false);
    expect((await deleteAttachment(TEST_UID, taskId, 'nested\\brief.md')).ok).toBe(true);
    expect(fs.existsSync(path.join(dir, 'brief.md'))).toBe(false);
    expect(await listAttachments(TEST_UID, 'bad-id')).toEqual([]);
  });

  it('adopts config-less draft attachments when creating a project task', async () => {
    const projectId = 'p_auto_draft';
    const taskId = 'at_56565656';
    writeProject(TEST_UID, projectId);

    expect((await uploadAttachment(TEST_UID, taskId, 'brief.md', Buffer.from('draft brief'))).ok).toBe(true);
    const created = await createTask(TEST_UID, {
      id: taskId,
      content: 'use the project brief',
      project_id: projectId,
      attachments: ['brief.md'],
      schedule: { type: 'daily', hour: 9, minute: 0 },
    });

    expect(created.ok).toBe(true);
    expect(fs.existsSync(projectAutoTaskConfigFile(TEST_UID, projectId, taskId))).toBe(true);
    expect(fs.readFileSync(path.join(projectAutoTaskAttachmentsDir(TEST_UID, projectId, taskId), 'brief.md'), 'utf8'))
      .toBe('draft brief');
    expect(fs.existsSync(autoTaskDir(TEST_UID, taskId))).toBe(false);
  });
});

describe('scheduler dispatch', () => {
  it('skips a boundary crossed while the process is suspended and never back-fills it on resume', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 22, 8, 30, 0));
    const taskId = 'at_59595959';
    const created = await createTask(TEST_UID, {
      id: taskId,
      content: 'skip the sleeping boundary',
      schedule: { type: 'daily', hour: 9, minute: 0 },
    });
    expect(created.ok).toBe(true);

    suspendSchedulerForTest();
    vi.setSystemTime(new Date(2026, 4, 22, 10, 0, 0));
    await resumeSchedulerForTest(TEST_UID);
    await vi.advanceTimersByTimeAsync(0);

    expect(autoRuntime.createConversation).not.toHaveBeenCalled();
    expect(autoRuntime.send).not.toHaveBeenCalled();
    expect(await getTask(TEST_UID, taskId)).toMatchObject({ enabled: true });
    expect((await getTask(TEST_UID, taskId))?.last_run_at).toBeUndefined();
  });

  it('preserves an already-armed due boundary when live sync rebuilds timers before its callback', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 22, 8, 30, 0));
    const taskId = 'at_58585858';
    const created = await createTask(TEST_UID, {
      id: taskId,
      content: 'run the armed occurrence',
      schedule: { type: 'daily', hour: 9, minute: 0 },
    });
    expect(created.ok).toBe(true);

    // setSystemTime moves the wall clock without first draining the 09:00
    // timer, reproducing sync winning the event-loop race after the boundary.
    vi.setSystemTime(new Date(2026, 4, 22, 9, 0, 1));
    await rescheduleAllAfterSyncForTest(TEST_UID);
    expect(armedDueAtForTest(taskId)).toBe(new Date(2026, 4, 22, 9, 0, 1).getTime());
    await _onTimerFireForTest(TEST_UID, taskId);

    expect(autoRuntime.createConversation).toHaveBeenCalledTimes(1);
    expect(autoRuntime.send).toHaveBeenCalledTimes(1);
    expect((await getTask(TEST_UID, taskId))?.last_run_at)
      .toBe(new Date(2026, 4, 22, 9, 0, 1).toISOString());
  });

  it('ignores a due task when the computer is sleeping without mutating it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 22, 8, 30, 0));
    const taskId = 'at_60606060';
    const created = await createTask(TEST_UID, {
      id: taskId,
      content: 'run after the computer wakes',
      schedule: { type: 'daily', hour: 9, minute: 0 },
    });
    expect(created.ok).toBe(true);

    vi.setSystemTime(new Date(2026, 4, 22, 9, 0, 0));
    electronRuntime.idleState = 'locked';
    const configBefore = fs.readFileSync(autoTaskConfigFile(TEST_UID, taskId), 'utf8');
    await _onTimerFireForTest(TEST_UID, taskId);

    expect(autoRuntime.createConversation).not.toHaveBeenCalled();
    expect(autoRuntime.send).not.toHaveBeenCalled();
    expect(await getTask(TEST_UID, taskId)).toMatchObject({
      enabled: true,
    });
    expect((await getTask(TEST_UID, taskId))?.last_run_at).toBeUndefined();
    expect(fs.readFileSync(autoTaskConfigFile(TEST_UID, taskId), 'utf8')).toBe(configBefore);
  });

  it('fires normally when the computer is idle but not locked', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 22, 8, 30, 0));
    const taskId = 'at_62626262';
    const created = await createTask(TEST_UID, {
      id: taskId,
      content: 'idle is still awake',
      schedule: { type: 'daily', hour: 9, minute: 0 },
    });
    expect(created.ok).toBe(true);

    vi.setSystemTime(new Date(2026, 4, 22, 9, 0, 0));
    electronRuntime.idleState = 'idle';
    await _onTimerFireForTest(TEST_UID, taskId);

    expect(autoRuntime.createConversation).toHaveBeenCalledTimes(1);
    expect(autoRuntime.send).toHaveBeenCalledTimes(1);
    expect((await getTask(TEST_UID, taskId))?.last_run_at)
      .toBe(new Date(2026, 4, 22, 9, 0, 0).toISOString());
  });

  it('does not persist state or create a conversation for an overdue restored task', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 22, 8, 30, 0));
    const taskId = 'at_61616161';
    const created = await createTask(TEST_UID, {
      id: taskId,
      content: 'do not catch this up',
      schedule: { type: 'daily', hour: 9, minute: 0 },
    });
    expect(created.ok).toBe(true);

    const configBefore = fs.readFileSync(autoTaskConfigFile(TEST_UID, taskId), 'utf8');
    vi.setSystemTime(new Date(2026, 4, 22, 10, 0, 0));
    await rescheduleAllForTest(TEST_UID);

    expect(autoRuntime.createConversation).not.toHaveBeenCalled();
    expect(autoRuntime.send).not.toHaveBeenCalled();
    expect(await getTask(TEST_UID, taskId)).toMatchObject({ enabled: true });
    expect((await getTask(TEST_UID, taskId))?.last_run_at).toBeUndefined();
    expect(fs.readFileSync(autoTaskConfigFile(TEST_UID, taskId), 'utf8')).toBe(configBefore);
  });

  it('does not mistake the one-hour cap wake-up for the restored task due time', async () => {
    vi.useFakeTimers();
    const restoredAt = new Date(2026, 4, 22, 18, 57, 59);
    vi.setSystemTime(restoredAt);
    const taskId = 'at_64646464';
    const created = await createTask(TEST_UID, {
      id: taskId,
      content: 'run at seven tomorrow',
      schedule: { type: 'daily', hour: 7, minute: 0 },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const priorRunAt = new Date(2026, 4, 19, 7, 0, 0).toISOString();
    fs.writeFileSync(autoTaskConfigFile(TEST_UID, taskId), JSON.stringify({
      ...created.task,
      last_run_at: priorRunAt,
    }));
    await rescheduleAllForTest(TEST_UID);

    const actualDueAt = new Date(2026, 4, 23, 7, 0, 0);
    expect(armedDueAtForTest(taskId)).toBe(actualDueAt.getTime());

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);

    expect(autoRuntime.createConversation).not.toHaveBeenCalled();
    expect(autoRuntime.send).not.toHaveBeenCalled();
    expect((await getTask(TEST_UID, taskId))?.last_run_at).toBe(priorRunAt);
    expect(armedDueAtForTest(taskId)).toBe(actualDueAt.getTime());
  });

  it('does not disable or mutate an expired one-time task during restore', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-22T08:30:00.000Z'));
    const taskId = 'at_63636363';
    const created = await createTask(TEST_UID, {
      id: taskId,
      content: 'do not restore this occurrence',
      schedule: { type: 'one_time', at: '2026-05-22T09:00:00.000Z' },
    });
    expect(created.ok).toBe(true);

    const configBefore = fs.readFileSync(autoTaskConfigFile(TEST_UID, taskId), 'utf8');
    vi.setSystemTime(new Date('2026-05-22T10:00:00.000Z'));
    await rescheduleAllForTest(TEST_UID);

    expect(autoRuntime.createConversation).not.toHaveBeenCalled();
    expect(await getTask(TEST_UID, taskId)).toMatchObject({ enabled: true });
    expect((await getTask(TEST_UID, taskId))?.last_run_at).toBeUndefined();
    expect(fs.readFileSync(autoTaskConfigFile(TEST_UID, taskId), 'utf8')).toBe(configBefore);
  });

  it('runs manually without changing schedule state, enabled state, device binding, or last run', async () => {
    const events: any[] = [];
    const unsubscribe = subscribeFires((ev) => events.push(ev));
    const taskId = 'at_65656565';
    const created = await createTask(TEST_UID, {
      id: taskId,
      content: 'run on demand',
      enabled: false,
      schedule: { type: 'one_time', at: '2099-05-22T09:00:00.000Z' },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const persisted = {
      ...created.task,
      device_id: '11:22:33:44:55:66',
      device_name: 'Remote workstation',
      last_run_at: '2026-05-21T09:00:00.000Z',
    };
    fs.writeFileSync(autoTaskConfigFile(TEST_UID, taskId), JSON.stringify(persisted));
    const configBefore = fs.readFileSync(autoTaskConfigFile(TEST_UID, taskId), 'utf8');

    const result = await runTaskNow(TEST_UID, taskId);
    unsubscribe();

    expect(result).toEqual({ ok: true, cid: 'cid_auto' });
    expect(autoRuntime.createConversation).toHaveBeenCalledWith(TEST_UID, {
      kind: 'normal',
      title: 'run on demand',
      originAutoTaskId: taskId,
    });
    expect(autoRuntime.send).toHaveBeenCalledWith({
      userId: TEST_UID,
      cid: 'cid_auto',
      text: 'run on demand',
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'conv_created',
      user_id: TEST_UID,
      cid: 'cid_auto',
      task_id: taskId,
    });
    expect(fs.readFileSync(autoTaskConfigFile(TEST_UID, taskId), 'utf8')).toBe(configBefore);
    expect(await getTask(TEST_UID, taskId)).toMatchObject({
      enabled: false,
      device_id: '11:22:33:44:55:66',
      last_run_at: '2026-05-21T09:00:00.000Z',
      schedule: { type: 'one_time', at: '2099-05-22T09:00:00.000Z' },
    });
  });

  it('fires a due one-time task, copies attachments, emits an event, and disables the task', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-22T09:00:00.000Z'));

    const events: any[] = [];
    const unsubscribe = subscribeFires((ev) => events.push(ev));
    const taskId = 'at_66666666';
    writeProject(TEST_UID, 'p_auto_project', ['agent_codex']);
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
    expect(events[0]).toMatchObject({
      type: 'conv_created',
      user_id: TEST_UID,
      cid: 'cid_auto',
      task_id: taskId,
    });
    expect(events[0].duration_ms).toEqual(expect.any(Number));
    expect(fs.readFileSync(path.join(projectChatAttachmentDir(TEST_UID, 'p_auto_project', 'cid_auto'), 'brief.md'), 'utf8')).toBe('brief');

    const task = await getTask(TEST_UID, taskId);
    expect(task?.enabled).toBe(false);
    expect(task?.last_run_at).toBe('2026-05-22T09:00:00.000Z');
  });

  it('resolves the current Agent name by stable id when a scheduled task fires after a rename', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-22T09:00:00.000Z'));
    autoRuntime.getAgent.mockResolvedValue({
      agent_id: 'agent_codex',
      name: 'Codex Renamed',
    });

    const taskId = 'at_67676767';
    const created = await createTask(TEST_UID, {
      id: taskId,
      content: 'send the renamed-agent report',
      recipient: { kind: 'agent', id: 'agent_codex', name: 'Old Codex Name' },
      schedule: { type: 'one_time', at: '2026-05-22T08:59:00.000Z' },
    });
    expect(created.ok).toBe(true);

    await _onTimerFireForTest(TEST_UID, taskId);

    expect(autoRuntime.getAgent).toHaveBeenCalledWith('agent_codex');
    expect(autoRuntime.send).toHaveBeenCalledWith({
      userId: TEST_UID,
      cid: 'cid_auto',
      text: '@Codex Renamed send the renamed-agent report',
    });
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
    expect(autoRuntime.deleteConversation).toHaveBeenCalledWith(TEST_UID, 'cid_auto', null);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'fire_failed',
      user_id: TEST_UID,
      cid: 'cid_auto',
      task_id: taskId,
      error_code: 'send_not_ok',
    });
    expect(events[0].duration_ms).toEqual(expect.any(Number));
    const task = await getTask(TEST_UID, taskId);
    expect(task?.enabled).toBe(false);
    expect(task?.last_run_at).toBe('2026-05-22T09:00:00.000Z');
  });

  it('delivers fire events only to listeners for the owning account', async () => {
    const ownEvents: any[] = [];
    const foreignEvents: any[] = [];
    const unsubscribeOwn = subscribeFiresForUser(TEST_UID, (ev) => ownEvents.push(ev));
    const unsubscribeForeign = subscribeFiresForUser('another-account', (ev) => foreignEvents.push(ev));
    const taskId = 'at_78787878';
    const created = await createTask(TEST_UID, {
      id: taskId,
      content: 'account scoped delivery',
      enabled: false,
      schedule: { type: 'one_time', at: '2099-05-22T09:00:00.000Z' },
    });
    expect(created.ok).toBe(true);

    await runTaskNow(TEST_UID, taskId);
    unsubscribeOwn();
    unsubscribeForeign();

    expect(ownEvents).toEqual([
      expect.objectContaining({
        type: 'conv_created',
        user_id: TEST_UID,
        task_id: taskId,
        cid: 'cid_auto',
      }),
    ]);
    expect(foreignEvents).toEqual([]);
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

  it('releases a claim and retries when marking last_run_at fails before dispatch', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 22, 8, 30, 0));

    const taskId = 'at_99999999';
    const created = await createTask(TEST_UID, {
      id: taskId,
      content: 'daily retry',
      schedule: { type: 'daily', hour: 9, minute: 0 },
    });
    expect(created.ok).toBe(true);
    stopScheduler();

    vi.setSystemTime(new Date(2026, 4, 22, 9, 0, 0));
    const boundary = new Date(2026, 4, 22, 9, 0, 0);
    const claimFile = path.join(userLocalRoot(TEST_UID), 'auto_task_claims', taskId, `${boundary.getTime()}.json`);

    _setMarkRanFailureForTest(new Error('injected persistence failure'));
    await _onTimerFireForTest(TEST_UID, taskId);
    _setMarkRanFailureForTest(null);

    expect(autoRuntime.createConversation).not.toHaveBeenCalled();
    expect(autoRuntime.send).not.toHaveBeenCalled();
    expect(fs.existsSync(claimFile)).toBe(false);
    let task = await getTask(TEST_UID, taskId);
    expect(task?.last_run_at).toBeUndefined();

    stopScheduler();
    await _onTimerFireForTest(TEST_UID, taskId);

    expect(autoRuntime.createConversation).toHaveBeenCalledTimes(1);
    expect(autoRuntime.send).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(claimFile)).toBe(true);
    task = await getTask(TEST_UID, taskId);
    expect(task?.last_run_at).toBe(boundary.toISOString());
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

describe('scheduler restore skips missed boundaries', () => {
  it('schedules the next day instead of back-filling a missed daily task', () => {
    const now = new Date(2026, 4, 27, 10, 30, 0);
    const next = nextDueAfterRestoreForTest(
      makeTask(
        { type: 'daily', hour: 9, minute: 0 },
        { last_run_at: new Date(2026, 4, 26, 9, 0, 0).toISOString() },
      ),
      now,
    );

    expect(next?.getDate()).toBe(28);
    expect(next?.getHours()).toBe(9);
    expect(next?.getMinutes()).toBe(0);
  });

  it('keeps a future same-day boundary when the app opens before it', () => {
    const now = new Date(2026, 4, 27, 8, 30, 0);
    const next = nextDueAfterRestoreForTest(
      makeTask({ type: 'daily', hour: 9, minute: 0 }),
      now,
    );

    expect(next?.getDate()).toBe(27);
    expect(next?.getHours()).toBe(9);
    expect(next?.getMinutes()).toBe(0);
  });

  it('does not back-fill an expired one-time task', () => {
    const now = new Date(2026, 4, 27, 10, 30, 0);
    expect(nextDueAfterRestoreForTest(
      makeTask({ type: 'one_time', at: new Date(2026, 4, 27, 9, 0, 0).toISOString() }),
      now,
    )).toBeNull();
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
