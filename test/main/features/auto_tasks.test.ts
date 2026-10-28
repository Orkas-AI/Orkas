/**
 * Automation tasks — `isDue` boundary semantics for the 5 schedule types.
 *
 * Locks the contract the in-process scheduler relies on:
 *   - one_time: fires once when `now >= at`, never again after `last_run_at`
 *   - hourly: fires after the configured interval from create / last run
 *   - daily: fires when today's HH:MM boundary is crossed AND we haven't
 *     fired since that boundary
 *   - weekly: same as daily, gated on `now.getDay() === weekday`
 *   - monthly: same as daily, gated on `now.getDate() === target` where
 *     target = min(day, lastDayOfThisMonth) so day=31 falls back to the
 *     last day in shorter months
 *
 * The schedule-math cases stay pure; scheduler-dispatch cases use isolated
 * account storage and fake wall-clock time to verify persisted outcomes.
 */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import nativeFs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import * as path from 'node:path';
import { setTimeout as realDelay } from 'node:timers/promises';
import * as storage from '../../../src/main/storage';

const electronRuntime = vi.hoisted(() => ({
  idleState: 'active' as 'active' | 'idle' | 'locked' | 'unknown',
}));

const automationLogs = vi.hoisted(() => ({ records: [] as unknown[][] }));
vi.mock('../../../src/main/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/main/logger')>();
  return { ...actual, createLogger(scope: string) {
    if (scope !== 'auto-tasks') return actual.createLogger(scope);
    const record = (...args: unknown[]) => { automationLogs.records.push(args); };
    return { info: record, warn: record, error: record, debug: record };
  } };
});

vi.mock('electron', () => ({
  // Headless scheduler cases have no browser window to bind.
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  powerMonitor: {
    getSystemIdleState: vi.fn(() => electronRuntime.idleState),
  },
}));

// Scheduler cases run without a host window; exercise the supported unbound
// browser path instead of failing an unrelated Electron module import.
vi.mock('../../../src/main/features/web_assist', () => ({
  bindHostStartedWebAssistConversation: () => false,
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
  AUTO_TASK_CATCH_UP_DELAY_MS,
  AUTO_TASK_CATCH_UP_WINDOW_MS,
  armedDueAtForTest,
  catchUpBoundaryForTest,
  createTask,
  deleteTask,
  deleteAttachment,
  applyAutoTaskMutation,
  getCurrentDevice,
  getTask,
  handoffNotePath,
  isDue,
  listAttachments,
  listTasks,
  recordRunTerminal,
  nextDueAfterRestoreForTest,
  nextDueAtForTest,
  pruneFireBoundaryClaimsForTest,
  rescheduleAllAfterSyncForTest,
  rescheduleAllForTest,
  resumeSchedulerForTest,
  runTaskNow,
  startScheduler,
  setTaskEnabled,
  stopScheduler,
  subscribeFires,
  subscribeFiresForUser,
  suspendSchedulerForTest,
  updateTask,
  uploadAttachment,
  _buildSeedTextForTest,
  _onTimerFireForTest,
  _setMarkRanFailureForTest,
  type AutoFireEvent,
  type AutoTask,
  type Schedule,
} from '../../../src/main/features/auto_tasks';
import { readState } from '../../../src/main/features/group_chat/state';
import { setCurrentLang } from '../../../src/main/i18n';
import { _setDeviceFingerprintForTests } from '../../../src/main/util/device';
import { activateUser } from '../../../src/main/features/users';

const autoRuntime = vi.hoisted(() => ({
  createConversation: vi.fn(),
  deleteConversation: vi.fn(),
  send: vi.fn(),
  getAgent: vi.fn(),
  terminalListeners: new Set<(event: Record<string, unknown>) => void>(),
}));

vi.mock('../../../src/main/features/chats', () => ({
  createConversation: autoRuntime.createConversation,
  deleteConversation: autoRuntime.deleteConversation,
}));

vi.mock('../../../src/main/features/group_chat', () => ({
  send: autoRuntime.send,
  subscribeTaskTerminals: (listener: (event: Record<string, unknown>) => void) => {
    autoRuntime.terminalListeners.add(listener);
    return () => { autoRuntime.terminalListeners.delete(listener); };
  },
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

async function waitForSchedulerOutcome(
  condition: () => boolean,
  description: string,
): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    await Promise.resolve();
    if (condition()) return;
    await realDelay(10);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function settleSchedulerWork(): Promise<void> {
  stopScheduler();
  // Stopping timers does not cancel already-admitted filesystem work. Drain
  // those turns before removing the account, as the switch fixture does.
  for (let index = 0; index < 12; index += 1) {
    await Promise.resolve();
    await realDelay(0);
  }
}

beforeEach(async () => {
  await settleSchedulerWork();
  automationLogs.records.length = 0;
  _setDeviceFingerprintForTests(null);
  electronRuntime.idleState = 'active';
  _setMarkRanFailureForTest(null);
  vi.useRealTimers();
  fs.rmSync(userRoot(TEST_UID), { recursive: true, force: true });
  autoRuntime.createConversation.mockReset();
  autoRuntime.deleteConversation.mockReset();
  autoRuntime.send.mockReset();
  autoRuntime.terminalListeners.clear();
  autoRuntime.createConversation.mockResolvedValue({ conversation_id: 'cid_auto' });
  autoRuntime.deleteConversation.mockResolvedValue(true);
  autoRuntime.send.mockImplementation(async input => {
    await input.beforeDispatch?.();
    return { ok: true };
  });
  autoRuntime.getAgent.mockResolvedValue(null);
});

afterEach(async () => {
  await settleSchedulerWork();
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
  it('persists hourly schedules and optional date/count cutoffs', async () => {
    const created = await createTask(TEST_UID, {
      id: 'at_18181818',
      content: 'poll the service',
      schedule: { type: 'hourly', interval_hours: 6 },
      end_condition: { type: 'count', max_runs: 3 },
    });

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.task.schedule).toEqual({ type: 'hourly', interval_hours: 6 });
    expect(created.task.end_condition).toEqual({ type: 'count', max_runs: 3 });
    expect(created.task.scheduled_run_count).toBe(0);

    const withDate = await updateTask(TEST_UID, created.task.id, {
      end_condition: { type: 'date', date: '2026-12-31' },
    });
    expect(withDate.ok).toBe(true);
    if (!withDate.ok) return;
    expect(withDate.task.end_condition).toEqual({ type: 'date', date: '2026-12-31' });
    expect(withDate.task.scheduled_run_count).toBeUndefined();

    const oneTime = await updateTask(TEST_UID, created.task.id, {
      schedule: { type: 'one_time', at: '2027-01-01T00:00:00.000Z' },
    });
    expect(oneTime.ok).toBe(true);
    if (!oneTime.ok) return;
    expect(oneTime.task.end_condition).toBeUndefined();
    expect(oneTime.task.scheduled_run_count).toBeUndefined();
  });

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
    expect(await createTask(TEST_UID, {
      id: 'at_35353535',
      content: 'hello',
      schedule: { type: 'hourly', interval_hours: 0 },
    })).toEqual({ ok: false, error: 'invalid_schedule' });
    expect(await createTask(TEST_UID, {
      id: 'at_36363636',
      content: 'hello',
      schedule: { type: 'daily', hour: 9, minute: 0 },
      end_condition: { type: 'date', date: '2026-02-31' },
    })).toEqual({ ok: false, error: 'invalid_end_condition' });
    expect(await createTask(TEST_UID, {
      id: 'at_37373737',
      content: 'hello',
      schedule: { type: 'daily', hour: 9, minute: 0 },
      end_condition: { type: 'count', max_runs: 0 },
    })).toEqual({ ok: false, error: 'invalid_end_condition' });

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

describe('automation mutations', () => {
  it('applies create, update, disable, and delete through the shared applier', async () => {
    const created = await applyAutoTaskMutation(TEST_UID, {
      action: 'create',
      updates: {
        title: 'Morning review',
        content: 'Summarize yesterday and plan today.',
        schedule: { type: 'daily', hour: 9, minute: 0 },
        recipient: { kind: 'commander' },
      } as any,
    });
    expect(created.ok).toBe(true);
    expect(created.kind).toBe('created');
    expect(created.task?.title).toBe('Morning review');
    expect(created.task?.schedule).toEqual({ type: 'daily', hour: 9, minute: 0 });

    const taskId = created.taskId!;
    const updated = await applyAutoTaskMutation(TEST_UID, {
      action: 'update',
      taskId,
      updates: {
        schedule: { type: 'hourly', interval_hours: 6 },
        end_condition: { type: 'count', max_runs: 10 },
        skill: { id: 'research', name: 'Research' },
      } as any,
    });
    expect(updated.ok).toBe(true);
    expect(updated.kind).toBe('updated');
    expect(updated.task?.schedule).toEqual({ type: 'hourly', interval_hours: 6 });
    expect(updated.task?.end_condition).toEqual({ type: 'count', max_runs: 10 });
    expect(updated.task?.scheduled_run_count).toBe(0);
    expect(updated.task?.skill).toEqual({ id: 'research', name: 'Research' });

    const disabled = await applyAutoTaskMutation(TEST_UID, { action: 'disable', taskId, updates: {} });
    expect(disabled.ok).toBe(true);
    expect(disabled.kind).toBe('disabled');
    expect(disabled.task?.enabled).toBe(false);

    const deleted = await applyAutoTaskMutation(TEST_UID, { action: 'delete', taskId, updates: {} });
    expect(deleted.ok).toBe(true);
    expect(deleted.kind).toBe('deleted');
    expect(await getTask(TEST_UID, taskId)).toBeNull();
  });

  it('stages current conversation attachments named by a mutation', async () => {
    const sourceCid = 'cid_auto_source';
    const sourceDir = chatAttachmentDir(TEST_UID, sourceCid);
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'brief.md'), 'brief body');

    const created = await applyAutoTaskMutation(TEST_UID, {
      action: 'create',
      updates: {
        content: 'Use the attached brief every morning.',
        schedule: { type: 'daily', hour: 8, minute: 0 },
        attachments: ['brief.md'],
      } as any,
    }, { sourceAttachmentCid: sourceCid });

    expect(created.ok).toBe(true);
    const taskId = created.taskId!;
    expect(created.task?.attachments).toEqual(['brief.md']);
    expect(fs.readFileSync(path.join(autoTaskAttachmentsDir(TEST_UID, taskId), 'brief.md'), 'utf8')).toBe('brief body');
  });

  // Retired 2026-09-13 (review P3-2): the commander's reply used to be parsed
  // for `<auto-task>` blocks. The module must expose no text parser, so markup
  // quoted into a reply can no longer mutate automations; `bus.test.ts` pins
  // the same thing end to end.
  it('exposes no container text parser at all', async () => {
    const mod = await import('../../../src/main/features/auto_tasks');
    expect(Object.keys(mod).filter((name) => /container/i.test(name))).toEqual([]);
    expect((mod as Record<string, unknown>).extractAutoTaskContainers).toBeUndefined();
  });
});

describe('private automation diagnostics', () => {
  it('persists the chosen file and device without including their names in logs', async () => {
    const taskId = 'at_56565656';
    const name = 'Private salary forecast.txt';
    _setDeviceFingerprintForTests({ id: '00:11:22:33:44:55', name: 'Private client workstation' });
    expect(await uploadAttachment(TEST_UID, taskId, name, Buffer.from('private bytes'))).toEqual({ ok: true, name });
    const created = await createTask(TEST_UID, {
      id: taskId, content: 'Private task instructions', attachments: [name],
      schedule: { type: 'daily', hour: 9, minute: 0 },
    });
    expect(created.ok && created.task.device_name).toBe('Private client workstation');
    expect(fs.readFileSync(path.join(autoTaskAttachmentsDir(TEST_UID, taskId), name), 'utf8')).toBe('private bytes');
    expect(automationLogs.records).toHaveLength(2);
    const output = JSON.stringify(automationLogs.records);
    for (const value of [name, 'Private client workstation', 'Private task instructions', 'private bytes']) expect(output).not.toContain(value);
  });

  it('retains a failed upload and successful retry while keeping filesystem messages out of logs', async () => {
    const taskId = 'at_56565656';
    const name = 'Private salary forecast.txt';
    const target = path.join(autoTaskAttachmentsDir(TEST_UID, taskId), name);
    const message = `Private filesystem context: ${target}`;
    const original = nativeFs.writeFileSync;
    const spy = vi.spyOn(nativeFs, 'writeFileSync').mockImplementation((...args: Parameters<typeof nativeFs.writeFileSync>) => {
      if (String(args[0]) === target) throw Object.assign(new Error(message), { code: 'EACCES' });
      return original(...args);
    });
    syncBuiltinESMExports();
    try {
      expect(await uploadAttachment(TEST_UID, taskId, name, Buffer.from('private bytes'))).toEqual({ ok: false, error: message });
      expect(fs.existsSync(target)).toBe(false);
      expect(automationLogs.records).toHaveLength(1);
      const output = JSON.stringify(automationLogs.records);
      for (const value of [name, message, 'Private filesystem context', userRoot(TEST_UID)]) expect(output).not.toContain(value);
    } finally { spy.mockRestore(); syncBuiltinESMExports(); }
    expect(await uploadAttachment(TEST_UID, taskId, name, Buffer.from('private bytes'))).toEqual({ ok: true, name });
    expect(fs.readFileSync(target, 'utf8')).toBe('private bytes');
  });
});

describe('attachments', () => {
  it.each(['file', 'directory'])('scope migration preserves attachments when a destination %s conflicts', async (conflict) => {
    const projectId = 'p_auto_move';
    const taskId = 'at_56565656';
    writeProject(TEST_UID, projectId);
    expect((await createTask(TEST_UID, {
      id: taskId, content: 'Keep both original files', project_id: projectId,
      schedule: { type: 'daily', hour: 9, minute: 0 }, attachments: ['alpha.txt', 'beta.txt'],
    })).ok).toBe(true);
    for (const name of ['alpha.txt', 'beta.txt']) await uploadAttachment(TEST_UID, taskId, name, Buffer.from(`original ${name}`));
    const sourceDir = projectAutoTaskAttachmentsDir(TEST_UID, projectId, taskId);
    const sourceConfig = fs.readFileSync(projectAutoTaskConfigFile(TEST_UID, projectId, taskId), 'utf8');
    const targetDir = autoTaskAttachmentsDir(TEST_UID, taskId);
    fs.mkdirSync(targetDir, { recursive: true });
    if (conflict === 'file') fs.writeFileSync(path.join(targetDir, 'beta.txt'), 'modified beta.txt');
    else fs.mkdirSync(path.join(targetDir, 'beta.txt'));
    let rejected = false;
    try { await updateTask(TEST_UID, taskId, { project_id: null }); } catch { rejected = true; }
    expect({ rejected, sourcePresent: fs.existsSync(sourceDir), newConfig: fs.existsSync(autoTaskConfigFile(TEST_UID, taskId)) })
      .toEqual({ rejected: true, sourcePresent: true, newConfig: false });
    expect(fs.readFileSync(projectAutoTaskConfigFile(TEST_UID, projectId, taskId), 'utf8')).toBe(sourceConfig);
    for (const name of ['alpha.txt', 'beta.txt']) expect(fs.readFileSync(path.join(sourceDir, name), 'utf8')).toBe(`original ${name}`);
    expect(fs.readdirSync(targetDir)).toEqual(['beta.txt']);
    if (conflict === 'file') expect(fs.readFileSync(path.join(targetDir, 'beta.txt'), 'utf8')).toBe('modified beta.txt');
    else expect(fs.statSync(path.join(targetDir, 'beta.txt')).isDirectory()).toBe(true);
    // Resolve only the conflicting draft entry, then retry the exact move.
    fs.rmSync(path.join(targetDir, 'beta.txt'), { recursive: true });
    expect((await updateTask(TEST_UID, taskId, { project_id: null })).ok).toBe(true);
    expect((await getTask(TEST_UID, taskId))?.project_id).toBeUndefined();
    for (const name of ['alpha.txt', 'beta.txt']) expect(fs.readFileSync(path.join(targetDir, name), 'utf8')).toBe(`original ${name}`);
    expect(fs.existsSync(sourceDir)).toBe(false);
  });

  it.each(['copy', 'config', 'activation', 'source-handoff'])(
    'scope migration preserves both directories after a %s failure and retries', async (phase) => {
      const projectId = 'p_auto_move';
      const taskId = 'at_56565656';
      writeProject(TEST_UID, projectId);
      expect((await createTask(TEST_UID, {
        id: taskId, content: 'Preserve on failure', project_id: projectId,
        schedule: { type: 'daily', hour: 9, minute: 0 }, attachments: ['source.txt'],
      })).ok).toBe(true);
      await uploadAttachment(TEST_UID, taskId, 'source.txt', Buffer.from('source bytes'));
      const sourceConfigPath = projectAutoTaskConfigFile(TEST_UID, projectId, taskId);
      const sourceRoot = path.dirname(sourceConfigPath);
      const before = fs.readFileSync(sourceConfigPath, 'utf8');
      const due = armedDueAtForTest(taskId);
      const targetRoot = autoTaskDir(TEST_UID, taskId);
      const targetAttachments = autoTaskAttachmentsDir(TEST_UID, taskId);
      fs.mkdirSync(targetAttachments, { recursive: true });
      fs.writeFileSync(path.join(targetAttachments, 'draft.txt'), 'draft bytes');
      const fault = Object.assign(new Error('injected migration failure'), { code: 'ENOSPC' });
      const copy = nativeFs.copyFileSync;
      const renameSync = nativeFs.renameSync;
      const rename = nativeFs.promises.rename.bind(nativeFs.promises);
      let injected = false;
      const copySpy = vi.spyOn(nativeFs, 'copyFileSync').mockImplementation((from, to, mode) => {
        if (phase === 'copy' && String(from).startsWith(sourceRoot + path.sep)) { injected = true; throw fault; }
        copy(from, to, mode);
      });
      const renameSpy = vi.spyOn(nativeFs.promises, 'rename').mockImplementation(async (from, to) => {
        const stagedConfig = path.basename(String(to)) === 'config.json' && String(to).includes('.install-');
        if ((phase === 'config' && stagedConfig) || (phase === 'activation' && String(to) === targetRoot)) {
          if (!injected) { injected = true; throw fault; }
        }
        await rename(from, to);
      });
      const sourceSpy = vi.spyOn(nativeFs, 'renameSync').mockImplementation((from, to) => {
        if (phase === 'source-handoff' && String(from) === sourceRoot) { injected = true; throw fault; }
        renameSync(from, to);
      });
      syncBuiltinESMExports();
      try {
        await expect(updateTask(TEST_UID, taskId, { project_id: null })).rejects.toThrow(fault);
        expect(injected).toBe(true);
        expect(fs.readFileSync(sourceConfigPath, 'utf8')).toBe(before);
        expect(fs.readFileSync(path.join(sourceRoot, 'attachments', 'source.txt'), 'utf8')).toBe('source bytes');
        expect(fs.readdirSync(targetRoot)).toEqual(['attachments']);
        expect(fs.readdirSync(targetAttachments)).toEqual(['draft.txt']);
        expect(fs.readFileSync(path.join(targetAttachments, 'draft.txt'), 'utf8')).toBe('draft bytes');
        expect(armedDueAtForTest(taskId)).toBe(due);
        expect(autoRuntime.send).not.toHaveBeenCalled();
      } finally {
        copySpy.mockRestore(); renameSpy.mockRestore(); sourceSpy.mockRestore(); syncBuiltinESMExports();
      }
      expect((await updateTask(TEST_UID, taskId, { project_id: null })).ok).toBe(true);
      expect(await listTasks(TEST_UID)).toHaveLength(1);
      expect(fs.existsSync(sourceRoot)).toBe(false);
      expect(fs.readFileSync(path.join(targetAttachments, 'source.txt'), 'utf8')).toBe('source bytes');
      expect(fs.readFileSync(path.join(targetAttachments, 'draft.txt'), 'utf8')).toBe('draft bytes');
    },
  );

  it('scope migration reuses equal-byte attachments and retains unrelated draft files', async () => {
    const taskId = 'at_56565656';
    const projectId = 'p_auto_move';
    writeProject(TEST_UID, projectId);
    await createTask(TEST_UID, { id: taskId, project_id: projectId, content: 'Preserve all bytes',
      schedule: { type: 'daily', hour: 9, minute: 0 }, attachments: ['same.txt'] });
    await uploadAttachment(TEST_UID, taskId, 'same.txt', Buffer.from('identical bytes'));
    const target = autoTaskAttachmentsDir(TEST_UID, taskId);
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'same.txt'), 'identical bytes');
    fs.writeFileSync(path.join(target, 'draft.txt'), 'unrelated draft');
    expect((await updateTask(TEST_UID, taskId, { project_id: null })).ok).toBe(true);
    expect(await listTasks(TEST_UID)).toHaveLength(1);
    expect(fs.readFileSync(path.join(target, 'same.txt'), 'utf8')).toBe('identical bytes');
    expect(fs.readFileSync(path.join(target, 'draft.txt'), 'utf8')).toBe('unrelated draft');
    expect(fs.existsSync(projectAutoTaskConfigFile(TEST_UID, projectId, taskId))).toBe(false);
  });

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

describe('run facts and handoff', () => {
  const daily = { type: 'daily', hour: 9, minute: 0 } as const;
  const emitTerminal = (event: Record<string, unknown>) => {
    for (const listener of [...autoRuntime.terminalListeners]) listener(event);
  };
  const untilStatus = async (taskId: string, status: string) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if ((await getTask(TEST_UID, taskId))?.last_run?.status === status) return;
      await realDelay(10);
    }
    throw new Error(`run status never became ${status}`);
  };

  it.each(['during-send', 'during-start-save'])('retains a terminal received %s before fire preparation finishes', async timing => {
    const taskId = 'at_61616161';
    expect((await createTask(TEST_UID, { id: taskId, content: 'quick job', schedule: daily })).ok).toBe(true);
    const endedAt = Date.now();
    const terminal = () => emitTerminal({ user_id: TEST_UID, conversation_id: 'cid_auto',
      status: 'failed', finished_at_ms: endedAt });
    const writeJson = storage.writeJson;
    let emitted = false;
    const writing = vi.spyOn(storage, 'writeJson').mockImplementation(async (file, value) => {
      await writeJson(file, value);
      if (timing === 'during-start-save' && !emitted && (value as AutoTask)?.last_run?.status === 'running') {
        emitted = true;
        terminal();
      }
    });
    if (timing === 'during-send') autoRuntime.send.mockImplementationOnce(async () => {
      terminal();
      return { ok: true };
    });
    try {
      expect(await runTaskNow(TEST_UID, taskId)).toEqual({ ok: true, cid: 'cid_auto' });
      await untilStatus(taskId, 'failed');
      expect(await getTask(TEST_UID, taskId)).toMatchObject({ run_count: 1,
        last_run: { cid: 'cid_auto', status: 'failed', ended_at: new Date(endedAt).toISOString() } });
      expect(autoRuntime.terminalListeners.size).toBe(0);
    } finally { writing.mockRestore(); }
  });

  it.each(['rejected', 'thrown'])('discards an early terminal when send is %s without counting a run', async outcome => {
    const taskId = 'at_62626262';
    expect((await createTask(TEST_UID, { id: taskId, content: 'not admitted', schedule: daily })).ok).toBe(true);
    autoRuntime.send.mockImplementationOnce(async () => {
      emitTerminal({ user_id: TEST_UID, conversation_id: 'cid_auto', status: 'failed', finished_at_ms: Date.now() });
      if (outcome === 'thrown') throw new Error('dispatch unavailable');
      return { ok: false, error: 'dispatch unavailable' };
    });
    expect(await runTaskNow(TEST_UID, taskId)).toMatchObject({ ok: false });
    expect(await getTask(TEST_UID, taskId)).not.toHaveProperty('last_run');
    expect(await getTask(TEST_UID, taskId)).not.toHaveProperty('run_count');
    expect(autoRuntime.terminalListeners.size).toBe(0);
  });

  it('records each run it starts, keeps the one before it, and closes it on its own bus terminal', async () => {
    const taskId = 'at_60606060';
    expect((await createTask(TEST_UID, { id: taskId, content: 'weekly digest', schedule: daily })).ok).toBe(true);

    expect(await runTaskNow(TEST_UID, taskId)).toEqual({ ok: true, cid: 'cid_auto' });
    const first = await getTask(TEST_UID, taskId);
    expect(first?.run_count).toBe(1);
    expect(first?.last_run).toMatchObject({ cid: 'cid_auto', status: 'running' });
    expect(first?.previous_run).toBeUndefined();
    // The run's conversation may write the task's handoff directory and
    // nothing else of the task: config.json stays behind the tool.
    const handoffDir = path.dirname(handoffNotePath(TEST_UID, first!));
    expect(path.basename(handoffDir)).toBe('handoff');
    expect(fs.existsSync(handoffDir)).toBe(true);
    expect((await readState(TEST_UID, 'cid_auto')).tool_extra_roots).toEqual([handoffDir]);

    // Terminals from another account or conversation cannot settle this run.
    emitTerminal({ user_id: TEST_UID, conversation_id: 'cid_other', status: 'failed', finished_at_ms: Date.now() });
    emitTerminal({ user_id: 'another-account', conversation_id: 'cid_auto', status: 'failed', finished_at_ms: Date.now() });
    await realDelay(20);
    expect((await getTask(TEST_UID, taskId))?.last_run?.status).toBe('running');
    const endedAt = Date.UTC(2026, 4, 22, 9, 5, 0);
    emitTerminal({ user_id: TEST_UID, conversation_id: 'cid_auto', status: 'completed', finished_at_ms: endedAt });
    await untilStatus(taskId, 'completed');
    const closed = await getTask(TEST_UID, taskId);
    expect(closed?.last_run).toEqual({
      cid: 'cid_auto', started_at: first!.last_run!.started_at, ended_at: new Date(endedAt).toISOString(), status: 'completed',
    });
    expect(autoRuntime.terminalListeners.size).toBe(0);
    // A later chat in the same conversation has no remaining run listener.
    emitTerminal({ user_id: TEST_UID, conversation_id: 'cid_auto', status: 'failed', finished_at_ms: Date.now() });
    expect((await getTask(TEST_UID, taskId))?.last_run?.status).toBe('completed');

    autoRuntime.createConversation.mockResolvedValue({ conversation_id: 'cid_auto_2' });
    expect(await runTaskNow(TEST_UID, taskId)).toEqual({ ok: true, cid: 'cid_auto_2' });
    const second = await getTask(TEST_UID, taskId);
    expect(second?.run_count).toBe(2);
    expect(second?.previous_run).toEqual(closed?.last_run);
    expect(second?.last_run).toMatchObject({ cid: 'cid_auto_2', status: 'running' });
    // A late terminal for a run no longer on record changes nothing.
    await recordRunTerminal(TEST_UID, taskId, 'cid_auto', 'failed', new Date().toISOString());
    expect((await getTask(TEST_UID, taskId))?.previous_run?.status).toBe('completed');
    expect((await getTask(TEST_UID, taskId))?.last_run?.status).toBe('running');
  });

  it('preserves handoff files and drops malformed run facts on read', async () => {
    try {
      const taskId = 'at_61616161';
      expect((await createTask(TEST_UID, { id: taskId, content: 'weekly digest', schedule: daily })).ok).toBe(true);
      const notePath = handoffNotePath(TEST_UID, (await getTask(TEST_UID, taskId))!);
      const handoffDir = path.dirname(notePath);
      fs.mkdirSync(handoffDir, { recursive: true });
      const stale = path.join(handoffDir, 'older.csv');
      fs.writeFileSync(stale, 'a,b\n');
      const earlier = new Date(Date.now() - 60_000);
      fs.utimesSync(stale, earlier, earlier);

      expect(await runTaskNow(TEST_UID, taskId)).toEqual({ ok: true, cid: 'cid_auto' });
      fs.writeFileSync(notePath, '# handoff\nlast total 42\n');
      await recordRunTerminal(TEST_UID, taskId, 'cid_auto', 'completed', new Date().toISOString());

      // Malformed run facts are dropped on read; the task itself stays usable.
      const raw = JSON.parse(fs.readFileSync(autoTaskConfigFile(TEST_UID, taskId), 'utf8'));
      fs.writeFileSync(autoTaskConfigFile(TEST_UID, taskId), JSON.stringify({
        ...raw, run_count: -1, last_run: 'yesterday', previous_run: { cid: '../x', status: 'completed', started_at: 'now' },
      }));
      const task = await getTask(TEST_UID, taskId);
      expect(task?.content).toBe('weekly digest');
      expect(task).not.toHaveProperty('run_count');
      expect(task).not.toHaveProperty('last_run');
      expect(task).not.toHaveProperty('previous_run');
    } finally {
      }
  });
});

describe('scheduler dispatch', () => {
  it('stops after the configured scheduled-run count and ignores manual runs for that count', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 22, 8, 0, 0));
    const taskId = 'at_54545454';
    const created = await createTask(TEST_UID, {
      id: taskId,
      content: 'run twice on schedule',
      schedule: { type: 'hourly', interval_hours: 1 },
      end_condition: { type: 'count', max_runs: 2 },
    });
    expect(created.ok).toBe(true);

    expect(await runTaskNow(TEST_UID, taskId)).toEqual({ ok: true, cid: 'cid_auto' });
    expect((await getTask(TEST_UID, taskId))?.scheduled_run_count).toBe(0);

    vi.setSystemTime(new Date(2026, 4, 22, 9, 0, 0));
    await _onTimerFireForTest(TEST_UID, taskId);
    expect((await getTask(TEST_UID, taskId))?.scheduled_run_count).toBe(1);

    vi.setSystemTime(new Date(2026, 4, 22, 10, 0, 0));
    await _onTimerFireForTest(TEST_UID, taskId);
    expect((await getTask(TEST_UID, taskId))?.scheduled_run_count).toBe(2);
    expect((await getTask(TEST_UID, taskId))?.enabled).toBe(true);
    expect(armedDueAtForTest(taskId)).toBeNull();

    vi.setSystemTime(new Date(2026, 4, 22, 11, 0, 0));
    await _onTimerFireForTest(TEST_UID, taskId);
    expect(autoRuntime.createConversation).toHaveBeenCalledTimes(3);
    expect(autoRuntime.send).toHaveBeenCalledTimes(3);
  });

  it('runs a boundary crossed during sleep once after wake, labeled as a catch-up, then keeps the next occurrence', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 22, 8, 30, 0));
    activateUser(TEST_UID);
    setCurrentLang('en');
    const events: AutoFireEvent[] = [];
    const unsubscribe = subscribeFires((ev) => events.push(ev));
    const taskId = 'at_59595959';
    const created = await createTask(TEST_UID, {
      id: taskId,
      title: 'Reply check',
      content: 'check replies every morning',
      schedule: { type: 'daily', hour: 9, minute: 0 },
    });
    expect(created.ok).toBe(true);

    // The lid is closed across 09:00 and opened at 10:00.
    suspendSchedulerForTest();
    const wokeAt = new Date(2026, 4, 22, 10, 0, 0);
    vi.setSystemTime(wokeAt);
    await resumeSchedulerForTest(TEST_UID);
    await vi.advanceTimersByTimeAsync(0);
    // The late run waits for the settle delay instead of racing the network.
    expect(autoRuntime.createConversation).not.toHaveBeenCalled();
    expect((await getTask(TEST_UID, taskId))?.last_run_at).toBeUndefined();

    const nextBoundary = new Date(2026, 4, 23, 9, 0, 0);
    await vi.advanceTimersByTimeAsync(AUTO_TASK_CATCH_UP_DELAY_MS);
    await waitForSchedulerOutcome(
      () => armedDueAtForTest(taskId) === nextBoundary.getTime(),
      'the missed occurrence to run after wake and re-arm',
    );
    expect(autoRuntime.createConversation).toHaveBeenCalledTimes(1);
    expect(autoRuntime.send).toHaveBeenCalledTimes(1);
    expect(autoRuntime.createConversation.mock.calls[0][1]).toMatchObject({ title: 'Reply check (catch-up)' });
    expect((await getTask(TEST_UID, taskId))?.last_run_at)
      .toBe(new Date(wokeAt.getTime() + AUTO_TASK_CATCH_UP_DELAY_MS).toISOString());

    await vi.advanceTimersByTimeAsync(nextBoundary.getTime() - Date.now());
    await waitForSchedulerOutcome(
      () => events.length === 2,
      'the next occurrence to run on time',
    );
    unsubscribe();

    expect(autoRuntime.createConversation).toHaveBeenCalledTimes(2);
    expect(autoRuntime.createConversation.mock.calls[1][1]).toMatchObject({ title: 'Reply check' });
    expect((await getTask(TEST_UID, taskId))?.last_run_at).toBe(nextBoundary.toISOString());
    expect(events.map((ev) => [ev.type, ev.catch_up === true])).toEqual([
      ['conv_created', true],
      ['conv_created', false],
    ]);
  });

  it('skips an occurrence missed more than 12 hours before wake without running or persisting it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 22, 8, 30, 0));
    activateUser(TEST_UID);
    const taskId = 'at_59595960';
    const created = await createTask(TEST_UID, {
      id: taskId,
      content: 'missed too long ago',
      schedule: { type: 'daily', hour: 9, minute: 0 },
    });
    expect(created.ok).toBe(true);
    const configBefore = fs.readFileSync(autoTaskConfigFile(TEST_UID, taskId), 'utf8');

    suspendSchedulerForTest();
    const missedAt = new Date(2026, 4, 22, 9, 0, 0).getTime();
    vi.setSystemTime(new Date(missedAt + AUTO_TASK_CATCH_UP_WINDOW_MS + 1000));
    await resumeSchedulerForTest(TEST_UID);
    await vi.advanceTimersByTimeAsync(AUTO_TASK_CATCH_UP_DELAY_MS);

    expect(autoRuntime.createConversation).not.toHaveBeenCalled();
    expect(autoRuntime.send).not.toHaveBeenCalled();
    expect(fs.readFileSync(autoTaskConfigFile(TEST_UID, taskId), 'utf8')).toBe(configBefore);
    expect(armedDueAtForTest(taskId)).toBe(new Date(2026, 4, 23, 9, 0, 0).getTime());
  });

  it('runs an evening occurrence missed overnight the next morning, titled in the app language', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 22, 22, 30, 0));
    activateUser(TEST_UID);
    setCurrentLang('zh');
    const taskId = 'at_59595961';
    const created = await createTask(TEST_UID, {
      id: taskId,
      title: '晚间汇总',
      content: 'summarize the day',
      schedule: { type: 'daily', hour: 23, minute: 0 },
    });
    expect(created.ok).toBe(true);

    suspendSchedulerForTest();
    const wokeAt = new Date(2026, 4, 23, 7, 0, 0);
    vi.setSystemTime(wokeAt);
    await resumeSchedulerForTest(TEST_UID);
    const tonight = new Date(2026, 4, 23, 23, 0, 0);
    await vi.advanceTimersByTimeAsync(AUTO_TASK_CATCH_UP_DELAY_MS);
    await waitForSchedulerOutcome(
      () => armedDueAtForTest(taskId) === tonight.getTime(),
      'the overnight miss to run and tonight to stay armed',
    );

    expect(autoRuntime.createConversation).toHaveBeenCalledTimes(1);
    expect(autoRuntime.createConversation.mock.calls[0][1]).toMatchObject({ title: '晚间汇总（补跑）' });
    expect((await getTask(TEST_UID, taskId))?.last_run_at)
      .toBe(new Date(wokeAt.getTime() + AUTO_TASK_CATCH_UP_DELAY_MS).toISOString());
  });

  it('on startup runs only the occurrence missed within 12 hours while Orkas was closed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 22, 8, 30, 0));
    setCurrentLang('en');
    const recentId = 'at_59595962';
    const staleId = 'at_59595963';
    expect((await createTask(TEST_UID, {
      id: recentId,
      title: 'Morning brief',
      content: 'morning',
      schedule: { type: 'daily', hour: 9, minute: 0 },
    })).ok).toBe(true);
    expect((await createTask(TEST_UID, {
      id: staleId,
      title: 'Evening digest',
      content: 'evening',
      schedule: { type: 'daily', hour: 20, minute: 30 },
    })).ok).toBe(true);
    const staleConfig = fs.readFileSync(autoTaskConfigFile(TEST_UID, staleId), 'utf8');

    // Orkas stays closed until 09:30 the next day: the 09:00 brief was missed
    // 30 minutes ago, the 20:30 digest 13 hours ago.
    stopScheduler();
    vi.setSystemTime(new Date(2026, 4, 23, 9, 30, 0));
    activateUser(TEST_UID);
    startScheduler();
    await waitForSchedulerOutcome(
      () => armedDueAtForTest(recentId) !== null && armedDueAtForTest(staleId) !== null,
      'startup to arm both tasks',
    );
    await vi.advanceTimersByTimeAsync(AUTO_TASK_CATCH_UP_DELAY_MS);
    await waitForSchedulerOutcome(
      () => armedDueAtForTest(recentId) === new Date(2026, 4, 24, 9, 0, 0).getTime(),
      'the recent miss to run and re-arm',
    );

    expect(autoRuntime.createConversation).toHaveBeenCalledTimes(1);
    expect(autoRuntime.createConversation.mock.calls[0][1]).toMatchObject({ title: 'Morning brief (catch-up)' });
    expect(fs.readFileSync(autoTaskConfigFile(TEST_UID, staleId), 'utf8')).toBe(staleConfig);
    expect(armedDueAtForTest(staleId)).toBe(new Date(2026, 4, 23, 20, 30, 0).getTime());
  });

  it('runs a missed occurrence once even when the computer sleeps during the delay and wakes again', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 22, 8, 30, 0));
    activateUser(TEST_UID);
    const taskId = 'at_59595964';
    expect((await createTask(TEST_UID, {
      id: taskId,
      content: 'run the miss once',
      schedule: { type: 'daily', hour: 9, minute: 0 },
    })).ok).toBe(true);
    const tomorrow = new Date(2026, 4, 23, 9, 0, 0).getTime();

    suspendSchedulerForTest();
    vi.setSystemTime(new Date(2026, 4, 22, 10, 0, 0));
    await resumeSchedulerForTest(TEST_UID);
    // The lid closes again before the settle delay ends.
    await vi.advanceTimersByTimeAsync(AUTO_TASK_CATCH_UP_DELAY_MS / 2);
    suspendSchedulerForTest();
    await vi.advanceTimersByTimeAsync(AUTO_TASK_CATCH_UP_DELAY_MS);
    expect(autoRuntime.createConversation).not.toHaveBeenCalled();

    vi.setSystemTime(new Date(2026, 4, 22, 10, 5, 0));
    await resumeSchedulerForTest(TEST_UID);
    await vi.advanceTimersByTimeAsync(AUTO_TASK_CATCH_UP_DELAY_MS);
    await waitForSchedulerOutcome(
      () => armedDueAtForTest(taskId) === tomorrow,
      'the missed occurrence to run once',
    );

    // A later sleep and wake inside the window has nothing left to catch up.
    suspendSchedulerForTest();
    vi.setSystemTime(new Date(2026, 4, 22, 10, 10, 0));
    await resumeSchedulerForTest(TEST_UID);
    await vi.advanceTimersByTimeAsync(AUTO_TASK_CATCH_UP_DELAY_MS);

    expect(autoRuntime.createConversation).toHaveBeenCalledTimes(1);
    expect(autoRuntime.send).toHaveBeenCalledTimes(1);
    expect(armedDueAtForTest(taskId)).toBe(tomorrow);
  });

  it('runs a one-time task missed during sleep once after wake and then disables it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 22, 8, 30, 0));
    activateUser(TEST_UID);
    const taskId = 'at_59595965';
    expect((await createTask(TEST_UID, {
      id: taskId,
      content: 'one reminder',
      schedule: { type: 'one_time', at: new Date(2026, 4, 22, 9, 0, 0).toISOString() },
    })).ok).toBe(true);

    suspendSchedulerForTest();
    vi.setSystemTime(new Date(2026, 4, 22, 10, 0, 0));
    await resumeSchedulerForTest(TEST_UID);
    await vi.advanceTimersByTimeAsync(AUTO_TASK_CATCH_UP_DELAY_MS);
    await waitForSchedulerOutcome(
      () => autoRuntime.send.mock.calls.length === 1,
      'the missed reminder to run',
    );

    expect(autoRuntime.createConversation).toHaveBeenCalledTimes(1);
    expect(await getTask(TEST_UID, taskId)).toMatchObject({
      enabled: false,
      last_run_at: new Date(2026, 4, 22, 10, 1, 0).toISOString(),
    });
    expect(armedDueAtForTest(taskId)).toBeNull();
  });

  it('keeps a pending catch-up when sync rebuilds timers during the settle delay', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 22, 8, 30, 0));
    activateUser(TEST_UID);
    setCurrentLang('en');
    const taskId = 'at_59595966';
    expect((await createTask(TEST_UID, {
      id: taskId,
      title: 'Sync safe',
      content: 'still late after sync',
      schedule: { type: 'daily', hour: 9, minute: 0 },
    })).ok).toBe(true);

    suspendSchedulerForTest();
    const wokeAt = new Date(2026, 4, 22, 10, 0, 0);
    vi.setSystemTime(wokeAt);
    await resumeSchedulerForTest(TEST_UID);
    const lateRunAt = wokeAt.getTime() + AUTO_TASK_CATCH_UP_DELAY_MS;
    expect(armedDueAtForTest(taskId)).toBe(lateRunAt);

    await vi.advanceTimersByTimeAsync(AUTO_TASK_CATCH_UP_DELAY_MS / 2);
    await rescheduleAllAfterSyncForTest(TEST_UID);
    expect(armedDueAtForTest(taskId)).toBe(lateRunAt);

    await vi.advanceTimersByTimeAsync(AUTO_TASK_CATCH_UP_DELAY_MS);
    await waitForSchedulerOutcome(
      () => autoRuntime.send.mock.calls.length === 1,
      'the preserved catch-up to run',
    );
    expect(autoRuntime.createConversation).toHaveBeenCalledTimes(1);
    expect(autoRuntime.createConversation.mock.calls[0][1]).toMatchObject({ title: 'Sync safe (catch-up)' });
  });

  it('retries a late run after the settle delay when recording it fails', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 22, 8, 30, 0));
    activateUser(TEST_UID);
    setCurrentLang('en');
    const events: AutoFireEvent[] = [];
    const unsubscribe = subscribeFiresForUser(TEST_UID, (ev) => events.push(ev));
    const taskId = 'at_59595967';
    expect((await createTask(TEST_UID, {
      id: taskId,
      title: 'Retry late',
      content: 'retry the late run',
      schedule: { type: 'daily', hour: 9, minute: 0 },
    })).ok).toBe(true);

    suspendSchedulerForTest();
    const wokeAt = new Date(2026, 4, 22, 10, 0, 0);
    vi.setSystemTime(wokeAt);
    await resumeSchedulerForTest(TEST_UID);
    _setMarkRanFailureForTest(new Error('injected persistence failure'));
    await vi.advanceTimersByTimeAsync(AUTO_TASK_CATCH_UP_DELAY_MS);
    await waitForSchedulerOutcome(
      () => armedDueAtForTest(taskId) === wokeAt.getTime() + 2 * AUTO_TASK_CATCH_UP_DELAY_MS,
      'the failed late run to be re-armed',
    );
    _setMarkRanFailureForTest(null);
    expect(autoRuntime.createConversation).not.toHaveBeenCalled();
    expect(events).toEqual([expect.objectContaining({
      type: 'fire_failed',
      source: 'scheduled',
      catch_up: true,
      error_code: 'mark_ran_failed',
    })]);

    await vi.advanceTimersByTimeAsync(AUTO_TASK_CATCH_UP_DELAY_MS);
    await waitForSchedulerOutcome(() => events.length === 2, 'the retried late run');
    unsubscribe();
    expect(events[1]).toMatchObject({ type: 'conv_created', catch_up: true });
    expect(autoRuntime.createConversation).toHaveBeenCalledTimes(1);
    expect(autoRuntime.createConversation.mock.calls[0][1]).toMatchObject({ title: 'Retry late (catch-up)' });
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
    // Live sync must retain that exact boundary instead of shifting it to the
    // rebuild time.
    vi.setSystemTime(new Date(2026, 4, 22, 9, 0, 1));
    await rescheduleAllAfterSyncForTest(TEST_UID);
    expect(armedDueAtForTest(taskId)).toBe(new Date(2026, 4, 22, 9, 0, 0).getTime());
    await _onTimerFireForTest(TEST_UID, taskId);

    expect(autoRuntime.createConversation).toHaveBeenCalledTimes(1);
    expect(autoRuntime.send).toHaveBeenCalledTimes(1);
    expect((await getTask(TEST_UID, taskId))?.last_run_at)
      .toBe(new Date(2026, 4, 22, 9, 0, 1).toISOString());
  });

  it('keeps a restored hourly boundary across repeated live syncs and fires it automatically', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 22, 8, 0, 0));
    const taskId = 'at_57585858';
    const created = await createTask(TEST_UID, {
      id: taskId,
      content: 'keep the recovered hourly cadence stable',
      schedule: { type: 'hourly', interval_hours: 6 },
    });
    expect(created.ok).toBe(true);

    // The 14:00 boundary was missed while this account was inactive. Restore
    // without catch-up (an account switch) starts a fresh six-hour interval.
    vi.setSystemTime(new Date(2026, 4, 22, 20, 0, 0));
    await rescheduleAllForTest(TEST_UID);
    const recoveredDueAt = new Date(2026, 4, 23, 2, 0, 0).getTime();
    expect(armedDueAtForTest(taskId)).toBe(recoveredDueAt);

    // Sync updates the task's content without changing its schedule. The
    // already recovered boundary must stay fixed, and dispatch must use the
    // latest persisted content when that boundary arrives.
    const firstSyncAt = new Date(2026, 4, 22, 21, 0, 0);
    vi.setSystemTime(firstSyncAt);
    const syncedTask = await getTask(TEST_UID, taskId);
    expect(syncedTask).not.toBeNull();
    fs.writeFileSync(autoTaskConfigFile(TEST_UID, taskId), `${JSON.stringify({
      ...syncedTask,
      content: 'use the latest synced instructions',
      updated_at: firstSyncAt.toISOString(),
    }, null, 2)}\n`);
    await rescheduleAllAfterSyncForTest(TEST_UID);
    expect(armedDueAtForTest(taskId)).toBe(recoveredDueAt);

    // Repeated sync notifications used to restart the six-hour interval each
    // time, so frequent sync traffic could postpone the task indefinitely.
    for (const syncAt of [
      new Date(2026, 4, 22, 22, 0, 0),
      new Date(2026, 4, 22, 23, 0, 0),
    ]) {
      vi.setSystemTime(syncAt);
      await rescheduleAllAfterSyncForTest(TEST_UID);
      expect(armedDueAtForTest(taskId)).toBe(recoveredDueAt);
    }

    await vi.advanceTimersByTimeAsync(3 * 60 * 60 * 1000);
    await waitForSchedulerOutcome(
      // Conversation creation precedes dispatch completion and timer rearming.
      () => armedDueAtForTest(taskId) === new Date(2026, 4, 23, 8, 0, 0).getTime(),
      'the sync-stable hourly occurrence to dispatch and rearm',
    );

    expect(autoRuntime.createConversation).toHaveBeenCalledTimes(1);
    expect(autoRuntime.send).toHaveBeenCalledTimes(1);
    expect(autoRuntime.send).toHaveBeenCalledWith(expect.objectContaining({
      text: 'use the latest synced instructions',
    }));
    expect((await getTask(TEST_UID, taskId))?.last_run_at)
      .toBe(new Date(recoveredDueAt).toISOString());
    expect(armedDueAtForTest(taskId))
      .toBe(new Date(2026, 4, 23, 8, 0, 0).getTime());
  });

  it('starts a changed daily schedule at the next boundary instead of back-filling today', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 4, 8, 30, 0));
    const taskId = 'at_57575757';
    const created = await createTask(TEST_UID, {
      id: taskId,
      content: 'run once per scheduled day',
      schedule: { type: 'daily', hour: 9, minute: 0 },
    });
    expect(created.ok).toBe(true);

    vi.setSystemTime(new Date(2026, 7, 4, 9, 0, 0));
    await _onTimerFireForTest(TEST_UID, taskId);
    const firstRunAt = new Date(2026, 7, 4, 9, 0, 0).toISOString();
    expect(autoRuntime.createConversation).toHaveBeenCalledTimes(1);
    expect(autoRuntime.send).toHaveBeenCalledTimes(1);
    expect((await getTask(TEST_UID, taskId))?.last_run_at).toBe(firstRunAt);

    vi.setSystemTime(new Date(2026, 7, 4, 12, 32, 27));
    const updated = await updateTask(TEST_UID, taskId, {
      schedule: { type: 'daily', hour: 10, minute: 0 },
    });
    expect(updated.ok).toBe(true);

    expect(autoRuntime.createConversation).toHaveBeenCalledTimes(1);
    expect(autoRuntime.send).toHaveBeenCalledTimes(1);
    expect((await getTask(TEST_UID, taskId))?.last_run_at).toBe(firstRunAt);
    expect(armedDueAtForTest(taskId))
      .toBe(new Date(2026, 7, 5, 10, 0, 0).getTime());

    vi.setSystemTime(new Date(2026, 7, 4, 13, 0, 0));
    const renamed = await updateTask(TEST_UID, taskId, {
      title: 'Renamed after the schedule change',
      schedule: { type: 'daily', hour: 10, minute: 0 },
    });
    expect(renamed.ok).toBe(true);
    expect((await getTask(TEST_UID, taskId))?.last_run_at).toBe(firstRunAt);
    expect(armedDueAtForTest(taskId))
      .toBe(new Date(2026, 7, 5, 10, 0, 0).getTime());
  });

  it('starts a changed hourly schedule one full interval after the edit', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 4, 8, 0, 0));
    const taskId = 'at_53535353';
    const created = await createTask(TEST_UID, {
      id: taskId,
      content: 'switch to an elapsed cadence',
      schedule: { type: 'daily', hour: 18, minute: 0 },
    });
    expect(created.ok).toBe(true);

    const editedAt = new Date(2026, 7, 4, 12, 30, 0);
    vi.setSystemTime(editedAt);
    const updated = await updateTask(TEST_UID, taskId, {
      schedule: { type: 'hourly', interval_hours: 6 },
    });
    expect(updated.ok).toBe(true);
    expect(armedDueAtForTest(taskId)).toBe(editedAt.getTime() + 6 * 60 * 60 * 1000);
    if (!updated.ok) return;
    expect(updated.task.schedule_anchor_at).toBe(editedAt.toISOString());
    expect(nextDueAtForTest(updated.task, new Date(2026, 7, 4, 13, 0, 0))?.getTime())
      .toBe(editedAt.getTime() + 6 * 60 * 60 * 1000);
  });

  it('keeps a changed daily schedule on the same day when its boundary is still ahead', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 4, 8, 30, 0));
    const taskId = 'at_56575757';
    const created = await createTask(TEST_UID, {
      id: taskId,
      content: 'run at the newly selected future time',
      schedule: { type: 'daily', hour: 9, minute: 0 },
    });
    expect(created.ok).toBe(true);

    vi.setSystemTime(new Date(2026, 7, 4, 8, 45, 0));
    const updated = await updateTask(TEST_UID, taskId, {
      schedule: { type: 'daily', hour: 10, minute: 0 },
    });
    expect(updated.ok).toBe(true);
    expect(armedDueAtForTest(taskId))
      .toBe(new Date(2026, 7, 4, 10, 0, 0).getTime());

    vi.setSystemTime(new Date(2026, 7, 4, 10, 0, 0));
    await _onTimerFireForTest(TEST_UID, taskId);

    expect(autoRuntime.createConversation).toHaveBeenCalledTimes(1);
    expect(autoRuntime.send).toHaveBeenCalledTimes(1);
    expect((await getTask(TEST_UID, taskId))?.last_run_at)
      .toBe(new Date(2026, 7, 4, 10, 0, 0).toISOString());
  });

  it('preserves an already-due occurrence when a normal edit resubmits the same schedule', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 4, 8, 30, 0));
    const taskId = 'at_55575757';
    const created = await createTask(TEST_UID, {
      id: taskId,
      content: 'keep the pending occurrence',
      schedule: { type: 'daily', hour: 9, minute: 0 },
    });
    expect(created.ok).toBe(true);

    const editAt = new Date(2026, 7, 4, 9, 0, 1);
    vi.setSystemTime(editAt);
    const updated = await updateTask(TEST_UID, taskId, {
      title: 'Renamed without changing the schedule',
      schedule: { minute: 0, type: 'daily', hour: 9 },
    });
    expect(updated.ok).toBe(true);
    expect(armedDueAtForTest(taskId)).toBe(editAt.getTime());

    await _onTimerFireForTest(TEST_UID, taskId);

    expect(autoRuntime.createConversation).toHaveBeenCalledTimes(1);
    expect(autoRuntime.send).toHaveBeenCalledTimes(1);
    expect((await getTask(TEST_UID, taskId))?.last_run_at).toBe(editAt.toISOString());
  });

  it('fires a runnable due task while the screen is locked', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 22, 8, 30, 0));
    let finishConversation!: (conversation: { conversation_id: string }) => void;
    autoRuntime.createConversation.mockReturnValueOnce(new Promise(resolve => {
      finishConversation = resolve;
    }));
    const taskId = 'at_60606060';
    const created = await createTask(TEST_UID, {
      id: taskId,
      content: 'run while the screen is locked',
      schedule: { type: 'daily', hour: 9, minute: 0 },
    });
    expect(created.ok).toBe(true);

    electronRuntime.idleState = 'locked';
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    await waitForSchedulerOutcome(
      () => autoRuntime.createConversation.mock.calls.length === 1,
      'the locked-screen occurrence to dispatch',
    );
    expect(autoRuntime.send).not.toHaveBeenCalled();
    finishConversation({ conversation_id: 'cid_auto' });
    // Creation starts before handoff preparation and dispatch. Wait for the
    // completed occurrence and its next boundary before inspecting or cleaning it.
    await waitForSchedulerOutcome(
      () => armedDueAtForTest(taskId) === new Date(2026, 4, 23, 9, 0, 0).getTime(),
      'the locked-screen occurrence to finish and rearm',
    );

    expect(autoRuntime.createConversation).toHaveBeenCalledTimes(1);
    expect(autoRuntime.send).toHaveBeenCalledTimes(1);
    expect((await getTask(TEST_UID, taskId))?.last_run_at)
      .toBe(new Date(2026, 4, 22, 9, 0, 0).toISOString());
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

  it('does not persist state or create a conversation for an overdue task restored without catch-up (account switch)', async () => {
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

  it('does not disable or mutate an expired one-time task during a restore without catch-up (account switch)', async () => {
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

      beforeDispatch: expect.any(Function), notificationKind: 'automation',
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'conv_created',
      source: 'manual',
      user_id: TEST_UID,
      cid: 'cid_auto',
      task_id: taskId,
    });
    // The admitted run is counted and remembered; everything else in the
    // record, including the scheduled-occurrence stamp, is untouched.
    const { run_count, last_run, ...untouched } = JSON.parse(fs.readFileSync(autoTaskConfigFile(TEST_UID, taskId), 'utf8'));
    expect(untouched).toEqual(JSON.parse(configBefore));
    expect(run_count).toBe(1);
    expect(last_run).toMatchObject({ cid: 'cid_auto', status: 'running' });
    expect(await getTask(TEST_UID, taskId)).toMatchObject({
      enabled: false,
      device_id: '11:22:33:44:55:66',
      last_run_at: '2026-05-21T09:00:00.000Z',
      schedule: { type: 'one_time', at: '2099-05-22T09:00:00.000Z' },
    });
  });

  it('emits one manual failure terminal when the requested task is invalid or stale', async () => {
    const events: any[] = [];
    const unsubscribe = subscribeFiresForUser(TEST_UID, (ev) => events.push(ev));

    expect(await runTaskNow(TEST_UID, 'not-a-task-id')).toEqual({
      ok: false,
      error: 'invalid_id',
    });
    expect(await runTaskNow(TEST_UID, 'at_12121212')).toEqual({
      ok: false,
      error: 'not_found',
    });
    unsubscribe();

    expect(events).toEqual([
      expect.objectContaining({
        type: 'fire_failed',
        source: 'manual',
        error_code: 'invalid_id',
      }),
      expect.objectContaining({
        type: 'fire_failed',
        source: 'manual',
        error_code: 'not_found',
      }),
    ]);
  });

  it.each(['delete', 'disable', 'reschedule', 'edit'] as const)(
    'uses the committed task after a concurrent %s before scheduled admission', async mutation => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-22T09:00:00.000Z'));
      const taskId = 'at_61616161';
      expect((await createTask(TEST_UID, {
        id: taskId, content: 'old report',
        schedule: { type: 'one_time', at: '2026-05-22T08:59:00.000Z' },
      })).ok).toBe(true);
      const configFile = autoTaskConfigFile(TEST_UID, taskId);
      const readJson = storage.readJson;
      let release!: () => void;
      let captured = false;
      const barrier = new Promise<void>(resolve => { release = resolve; });
      const spy = vi.spyOn(storage, 'readJson').mockImplementation(async (...args) => {
        const result = await readJson(...args);
        if (!captured && args[0] === configFile) {
          captured = true;
          await barrier;
        }
        return result;
      });
      const firing = _onTimerFireForTest(TEST_UID, taskId);
      try {
        await waitForSchedulerOutcome(() => captured, 'the scheduler task read');
        if (mutation === 'delete') expect(await deleteTask(TEST_UID, taskId)).toEqual({ ok: true });
        if (mutation === 'disable') expect((await setTaskEnabled(TEST_UID, taskId, false)).ok).toBe(true);
        if (mutation === 'reschedule') expect((await updateTask(TEST_UID, taskId, {
          schedule: { type: 'one_time', at: '2026-05-23T09:00:00.000Z' },
        })).ok).toBe(true);
        if (mutation === 'edit') expect((await updateTask(TEST_UID, taskId, { content: 'new report' })).ok).toBe(true);
        expect(autoRuntime.send).not.toHaveBeenCalled();
        release();
        await firing;
        const saved = await getTask(TEST_UID, taskId);
        if (mutation === 'edit') {
          expect(autoRuntime.send).toHaveBeenCalledExactlyOnceWith({
            userId: TEST_UID, cid: 'cid_auto', text: 'new report',
            beforeDispatch: expect.any(Function), notificationKind: 'automation',
          });
          expect(saved?.last_run_at).toBe('2026-05-22T09:00:00.000Z');
        } else {
          expect(autoRuntime.createConversation).not.toHaveBeenCalled();
          expect(autoRuntime.send).not.toHaveBeenCalled();
          expect(saved?.last_run_at).toBeUndefined();
          if (mutation === 'delete') expect(saved).toBeNull();
        }
      } finally {
        release();
        await firing;
        spy.mockRestore();
      }
    },
  );

  it('fires a due one-time task, copies attachments, emits an event, and disables the task', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-22T09:00:00.000Z'));

    const events: any[] = [];
    const unsubscribe = subscribeFires((ev) => events.push(ev));
    const taskId = 'at_66666666';
    writeProject(TEST_UID, 'p_auto_project', ['agent_codex']);
    await uploadAttachment(TEST_UID, taskId, '../brief.md', Buffer.from('brief'));
    await uploadAttachment(TEST_UID, taskId, 'z-first.txt', Buffer.from('first'));
    await uploadAttachment(TEST_UID, taskId, 'a-last.txt', Buffer.from('last'));

    const created = await createTask(TEST_UID, {
      id: taskId,
      title: 'Morning run',
      content: 'send the morning report',
      project_id: 'p_auto_project',
      attachments: ['z-first.txt', 'brief.md', 'missing.md', 'a-last.txt'],
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

      beforeDispatch: expect.any(Function), notificationKind: 'automation',
      attachments: ['z-first.txt', 'brief.md', 'a-last.txt'],
    });
    expect(autoRuntime.deleteConversation).not.toHaveBeenCalled();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'conv_created',
      source: 'scheduled',
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

      beforeDispatch: expect.any(Function), notificationKind: 'automation',
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
      source: 'scheduled',
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
        source: 'manual',
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
    const events: any[] = [];
    const unsubscribe = subscribeFiresForUser(TEST_UID, (ev) => events.push(ev));

    _setMarkRanFailureForTest(new Error('injected persistence failure'));
    await _onTimerFireForTest(TEST_UID, taskId);
    _setMarkRanFailureForTest(null);

    expect(autoRuntime.createConversation).not.toHaveBeenCalled();
    expect(autoRuntime.send).not.toHaveBeenCalled();
    expect(events).toEqual([
      expect.objectContaining({
        type: 'fire_failed',
        source: 'scheduled',
        task_id: taskId,
        error_code: 'mark_ran_failed',
      }),
    ]);
    expect(fs.existsSync(claimFile)).toBe(false);
    let task = await getTask(TEST_UID, taskId);
    expect(task?.last_run_at).toBeUndefined();

    stopScheduler();
    await _onTimerFireForTest(TEST_UID, taskId);

    expect(autoRuntime.createConversation).toHaveBeenCalledTimes(1);
    expect(autoRuntime.send).toHaveBeenCalledTimes(1);
    unsubscribe();
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      type: 'conv_created',
      source: 'scheduled',
      task_id: taskId,
    });
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

describe('isDue: hourly and end conditions', () => {
  it('uses create / last-run time as the hourly interval baseline', () => {
    const createdAt = new Date(2026, 4, 22, 8, 0, 0);
    const task = makeTask(
      { type: 'hourly', interval_hours: 6 },
      { created_at: createdAt.toISOString(), updated_at: createdAt.toISOString() },
    );
    expect(isDue(task, new Date(2026, 4, 22, 13, 59, 59), createdAt)).toBe(false);
    expect(isDue(task, new Date(2026, 4, 22, 14, 0, 0), createdAt)).toBe(true);
    expect(nextDueAtForTest(task, createdAt)?.getTime())
      .toBe(new Date(2026, 4, 22, 14, 0, 0).getTime());
  });

  it('includes the local end date and blocks later dates or exhausted counts', () => {
    const schedule: Schedule = { type: 'daily', hour: 9, minute: 0 };
    const dateLimited = makeTask(schedule, {
      end_condition: { type: 'date', date: '2026-05-22' },
    });
    expect(isDue(dateLimited, new Date(2026, 4, 22, 9, 0, 0), null)).toBe(true);
    expect(isDue(dateLimited, new Date(2026, 4, 23, 9, 0, 0), null)).toBe(false);
    expect(nextDueAtForTest(dateLimited, new Date(2026, 4, 23, 8, 0, 0))).toBeNull();

    const countLimited = makeTask(schedule, {
      end_condition: { type: 'count', max_runs: 2 },
      scheduled_run_count: 2,
    });
    expect(isDue(countLimited, new Date(2026, 4, 22, 9, 0, 0), null)).toBe(false);
    expect(nextDueAtForTest(countLimited, new Date(2026, 4, 22, 8, 0, 0))).toBeNull();
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

// The no-backfill baseline still applies whenever no catch-up is owed: account
// switches, sync, edits, and misses outside the catch-up window.
describe('scheduler restore without catch-up starts at the next boundary', () => {
  it('starts a fresh hourly interval instead of back-filling missed intervals', () => {
    const now = new Date(2026, 4, 27, 20, 0, 0);
    const next = nextDueAfterRestoreForTest(
      makeTask(
        { type: 'hourly', interval_hours: 6 },
        {
          created_at: new Date(2026, 4, 27, 8, 0, 0).toISOString(),
          updated_at: new Date(2026, 4, 27, 8, 0, 0).toISOString(),
        },
      ),
      now,
    );

    expect(next?.getTime()).toBe(new Date(2026, 4, 28, 2, 0, 0).getTime());
  });

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

describe('catch-up eligibility after wake or startup', () => {
  const daily9 = (overrides: Partial<AutoTask> = {}) => makeTask(
    { type: 'daily', hour: 9, minute: 0 },
    { last_run_at: new Date(2026, 4, 21, 9, 0, 0).toISOString(), ...overrides },
  );

  it('finds the latest missed occurrence across midnight, week, and month ends', () => {
    expect(catchUpBoundaryForTest(
      makeTask({ type: 'daily', hour: 23, minute: 0 }, {
        last_run_at: new Date(2026, 4, 21, 23, 0, 0).toISOString(),
      }),
      new Date(2026, 4, 23, 7, 0, 0),
    )?.getTime()).toBe(new Date(2026, 4, 22, 23, 0, 0).getTime());

    // Friday 18:15 missed, checked early Saturday.
    expect(catchUpBoundaryForTest(
      makeTask({ type: 'weekly', weekday: 5, hour: 18, minute: 15 }, {
        last_run_at: new Date(2026, 4, 15, 18, 15, 0).toISOString(),
      }),
      new Date(2026, 4, 23, 5, 0, 0),
    )?.getTime()).toBe(new Date(2026, 4, 22, 18, 15, 0).getTime());

    // day=31 falls on April 30; the miss is found from May 1.
    expect(catchUpBoundaryForTest(
      makeTask({ type: 'monthly', day: 31, hour: 23, minute: 0 }, {
        last_run_at: new Date(2026, 2, 31, 23, 0, 0).toISOString(),
      }),
      new Date(2026, 4, 1, 6, 0, 0),
    )?.getTime()).toBe(new Date(2026, 3, 30, 23, 0, 0).getTime());

    // Only the latest of several missed hourly intervals runs.
    expect(catchUpBoundaryForTest(
      makeTask({ type: 'hourly', interval_hours: 2 }, {
        created_at: new Date(2026, 4, 22, 8, 0, 0).toISOString(),
        updated_at: new Date(2026, 4, 22, 8, 0, 0).toISOString(),
      }),
      new Date(2026, 4, 22, 13, 30, 0),
    )?.getTime()).toBe(new Date(2026, 4, 22, 12, 0, 0).getTime());
  });

  it('includes an occurrence exactly 12 hours old and skips anything older', () => {
    const missed = new Date(2026, 4, 22, 9, 0, 0).getTime();
    expect(catchUpBoundaryForTest(daily9(), new Date(missed + AUTO_TASK_CATCH_UP_WINDOW_MS))?.getTime())
      .toBe(missed);
    expect(catchUpBoundaryForTest(daily9(), new Date(missed + AUTO_TASK_CATCH_UP_WINDOW_MS + 1))).toBeNull();
  });

  it('does not resurrect an occurrence already covered by a run, creation, or later edit', () => {
    const wokeAt = new Date(2026, 4, 22, 10, 0, 0);
    const afterBoundary = new Date(2026, 4, 22, 9, 30, 0).toISOString();
    expect(catchUpBoundaryForTest(daily9(), wokeAt)).not.toBeNull();
    expect(catchUpBoundaryForTest(daily9({ last_run_at: new Date(2026, 4, 22, 9, 0, 5).toISOString() }), wokeAt))
      .toBeNull();
    expect(catchUpBoundaryForTest(daily9({ last_run_at: undefined, created_at: afterBoundary }), wokeAt))
      .toBeNull();
    // A schedule edit or re-enable after 09:00 never scheduled that occurrence.
    expect(catchUpBoundaryForTest(daily9({ updated_at: afterBoundary }), wokeAt)).toBeNull();
  });

  it('respects end conditions, the enabled switch, and device ownership', () => {
    const wokeAt = new Date(2026, 4, 22, 10, 0, 0);
    expect(catchUpBoundaryForTest(
      daily9({ end_condition: { type: 'count', max_runs: 3 }, scheduled_run_count: 3 }),
      wokeAt,
    )).toBeNull();
    expect(catchUpBoundaryForTest(daily9({ enabled: false }), wokeAt)).toBeNull();
    expect(catchUpBoundaryForTest(daily9({ device_id: 'another-installation' }), wokeAt)).toBeNull();
    // The last allowed day's occurrence still runs late the next morning.
    expect(catchUpBoundaryForTest(
      makeTask({ type: 'daily', hour: 23, minute: 0 }, {
        last_run_at: new Date(2026, 4, 21, 23, 0, 0).toISOString(),
        end_condition: { type: 'date', date: '2026-05-22' },
      }),
      new Date(2026, 4, 23, 7, 0, 0),
    )?.getTime()).toBe(new Date(2026, 4, 22, 23, 0, 0).getTime());
  });

  it('runs a missed one-time task once and only if it was scheduled ahead of time', () => {
    const at = new Date(2026, 4, 22, 9, 0, 0);
    const oneTime = (overrides: Partial<AutoTask> = {}) => makeTask(
      { type: 'one_time', at: at.toISOString() },
      { created_at: new Date(2026, 4, 22, 8, 0, 0).toISOString(), ...overrides },
    );
    const wokeAt = new Date(2026, 4, 22, 10, 0, 0);
    expect(catchUpBoundaryForTest(oneTime(), wokeAt)?.getTime()).toBe(at.getTime());
    expect(catchUpBoundaryForTest(oneTime({ last_run_at: at.toISOString() }), wokeAt)).toBeNull();
    expect(catchUpBoundaryForTest(
      oneTime({ created_at: new Date(2026, 4, 22, 9, 30, 0).toISOString() }),
      wokeAt,
    )).toBeNull();
    expect(catchUpBoundaryForTest(oneTime(), new Date(at.getTime() + AUTO_TASK_CATCH_UP_WINDOW_MS + 1)))
      .toBeNull();
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

describe('fire-boundary claim retention', () => {
  const claimsRoot = () => path.join(userLocalRoot(TEST_UID), 'auto_task_claims');

  function writeClaim(taskId: string, boundaryMs: number) {
    const dir = path.join(claimsRoot(), taskId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${boundaryMs}.json`), '{}', 'utf8');
  }

  it('deleteTask removes the task\'s local claim directory with it', async () => {
    const created = await createTask(TEST_UID, {
      id: 'at_77777771',
      content: 'x',
      schedule: { type: 'daily', hour: 9, minute: 0 },
    });
    expect(created.ok).toBe(true);
    writeClaim('at_77777771', Date.now());
    expect(fs.existsSync(path.join(claimsRoot(), 'at_77777771'))).toBe(true);

    const res = await deleteTask(TEST_UID, 'at_77777771');
    expect(res.ok).toBe(true);
    // Without this, a deleted task orphaned its claim files forever.
    expect(fs.existsSync(path.join(claimsRoot(), 'at_77777771'))).toBe(false);
  });

  it('prunes claims older than the retention window and keeps recent ones', () => {
    const now = Date.now();
    const old = now - 8 * 24 * 60 * 60 * 1000;   // > 7d: dead — boundary can never recur
    const recent = now - 60 * 60 * 1000;         // same-day: still guards double-fire
    writeClaim('at_88888881', old);
    writeClaim('at_88888881', recent);
    writeClaim('at_88888882', old);            // all-old dir → removed entirely

    pruneFireBoundaryClaimsForTest(TEST_UID);

    const dir1 = path.join(claimsRoot(), 'at_88888881');
    expect(fs.readdirSync(dir1)).toEqual([`${recent}.json`]);
    expect(fs.existsSync(path.join(claimsRoot(), 'at_88888882'))).toBe(false);
  });
});

describe('automation › failed enable recovery', () => {
  it('keeps a failed enable disabled and unarmed, then preserves concurrent edits on retry', async () => {
    const created = await createTask(TEST_UID, {
      title: 'Release reminder', content: 'Check release', enabled: false,
      schedule: { type: 'daily', hour: 9, minute: 0 },
    });
    if (!created.ok) throw new Error('automation fixture failed');
    const id = created.task.id;
    const file = autoTaskConfigFile(TEST_UID, id);
    const before = fs.readFileSync(file, 'utf8');
    const rename = nativeFs.promises.rename.bind(nativeFs.promises);
    const fault = Object.assign(new Error('injected disk full'), { code: 'ENOSPC' });
    const spy = vi.spyOn(nativeFs.promises, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === file) throw fault;
      await rename(from, to);
    });
    syncBuiltinESMExports();
    try {
      await expect(updateTask(TEST_UID, id, { enabled: true })).rejects.toThrow(fault);
      expect(fs.readFileSync(file, 'utf8')).toBe(before);
      expect((await getTask(TEST_UID, id))?.enabled).toBe(false);
      expect(armedDueAtForTest(id)).toBeNull();
      expect(autoRuntime.send).not.toHaveBeenCalled();
      expect(fs.readdirSync(path.dirname(file))).toEqual(['config.json']);
    } finally {
      spy.mockRestore();
      syncBuiltinESMExports();
    }
    const results = await Promise.all([
      updateTask(TEST_UID, id, { content: 'Check release and owner' }),
      updateTask(TEST_UID, id, { enabled: true }),
    ]);
    expect(results.every(result => result.ok)).toBe(true);
    expect(await getTask(TEST_UID, id)).toMatchObject({ enabled: true, content: 'Check release and owner' });
    expect(armedDueAtForTest(id)).not.toBeNull();
    expect(autoRuntime.send).not.toHaveBeenCalled();
    stopScheduler();
    await rescheduleAllForTest(TEST_UID);
    expect(armedDueAtForTest(id)).not.toBeNull();
    expect(await listTasks(TEST_UID)).toHaveLength(1);
  });
});

describe('automation › daylight-saving calendar boundaries', () => {
  const priorTimezone = process.env.TZ;
  beforeEach(() => { process.env.TZ = 'America/New_York'; });
  afterEach(() => {
    if (priorTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = priorTimezone;
  });

  it.each([
    ['spring', '2026-03-07T14:00:00Z', '2026-03-08T13:00:00.000Z', 23],
    ['fall', '2026-10-31T13:00:00Z', '2026-11-01T14:00:00.000Z', 25],
  ])('keeps daily 09:00 local across the %s transition', (_season, previous, expected, hours) => {
    const now = new Date(previous);
    expect(now.getHours()).toBe(9);
    const task = makeTask({ type: 'daily', hour: 9, minute: 0 }, { last_run_at: previous });
    const next = nextDueAtForTest(task, now)!;
    expect(next.toISOString()).toBe(expected);
    expect(next.getHours()).toBe(9);
    expect(next.getTime() - now.getTime()).toBe(Number(hours) * 60 * 60 * 1000);
  });

  it('does not execute the repeated 01:30 twice after a fall-back or restoration', () => {
    const task = makeTask({ type: 'daily', hour: 1, minute: 30 }, {
      last_run_at: '2026-11-01T05:30:00.000Z',
    });
    const repeated = new Date('2026-11-01T06:30:00Z');
    expect(repeated.getHours()).toBe(1);
    expect(isDue(task, repeated, new Date(task.last_run_at!))).toBe(false);
    expect(nextDueAtForTest(task, repeated)?.toISOString()).toBe('2026-11-02T06:30:00.000Z');
    expect(nextDueAfterRestoreForTest(task, repeated)?.toISOString()).toBe('2026-11-02T06:30:00.000Z');
  });
});

describe('automation › recovery discovery sequences', () => {
  it.each(['success', 'failure'] as const)('preserves the claimed occurrence across restoration before a late %s', async outcome => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 4, 22, 8, 30));
    const taskId = 'at_18181818';
    expect((await createTask(TEST_UID, { id: taskId, content: 'Recovery discovery',
      schedule: { type: 'daily', hour: 9, minute: 0 } })).ok).toBe(true);
    stopScheduler();
    let complete!: (value: {ok: boolean; error?: string}) => void;
    autoRuntime.send.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
    const events: AutoFireEvent[] = [];
    const unsubscribe = subscribeFiresForUser(TEST_UID, event => events.push(event));
    try {
      vi.setSystemTime(new Date(2026, 4, 22, 9, 0));
      const firing = _onTimerFireForTest(TEST_UID, taskId);
      await waitForSchedulerOutcome(() => !!complete, 'pending admitted send');
      const persisted = fs.readFileSync(autoTaskConfigFile(TEST_UID, taskId));
      expect((await getTask(TEST_UID, taskId))?.last_run_at).toBe(new Date(2026, 4, 22, 9, 0).toISOString());
      expect(events).toEqual([]);
      stopScheduler();
      await rescheduleAllForTest(TEST_UID);
      expect(armedDueAtForTest(taskId)).toBe(new Date(2026, 4, 23, 9, 0).getTime());
      expect(autoRuntime.send).toHaveBeenCalledTimes(1);
      complete(outcome === 'success' ? {ok:true} : {ok:false,error:'injected late refusal'});
      await firing;
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe(outcome === 'success' ? 'conv_created' : 'fire_failed');
      expect(autoRuntime.deleteConversation).toHaveBeenCalledTimes(outcome === 'success' ? 0 : 1);
      // Only an admitted run adds run facts; the claimed occurrence and the
      // rest of the record survive restoration either way.
      const withoutRunFacts = (buffer: Buffer) => {
        const { run_count, last_run, previous_run, ...rest } = JSON.parse(buffer.toString('utf8'));
        return rest;
      };
      expect(withoutRunFacts(fs.readFileSync(autoTaskConfigFile(TEST_UID, taskId)))).toEqual(withoutRunFacts(persisted));
      expect((await getTask(TEST_UID, taskId))?.run_count).toBe(outcome === 'success' ? 1 : undefined);
      stopScheduler();
      await rescheduleAllForTest(TEST_UID);
      await _onTimerFireForTest(TEST_UID, taskId);
      expect(autoRuntime.send).toHaveBeenCalledTimes(1);
      vi.setSystemTime(new Date(2026, 4, 23, 9, 0));
      await _onTimerFireForTest(TEST_UID, taskId);
      expect(autoRuntime.send).toHaveBeenCalledTimes(2);
      expect(events).toHaveLength(2);
      expect(events[1].type).toBe('conv_created');
      expect((await getTask(TEST_UID, taskId))?.last_run_at).toBe(new Date(2026, 4, 23, 9, 0).toISOString());
    } finally { unsubscribe(); }
  });

  it.each([false, true])('retries a failed migration from the latest source and rejects obsolete scoped mutations (rollback failure: %s)', async rollbackFails => {
    const taskId='at_18181819', projectId='p_daily_recovery';
    writeProject(TEST_UID, projectId);
    expect((await createTask(TEST_UID, {id:taskId,project_id:projectId,content:'Original briefing',enabled:false,
      schedule:{type:'daily',hour:18,minute:0},attachments:['source.txt']})).ok).toBe(true);
    await uploadAttachment(TEST_UID,taskId,'source.txt',Buffer.from('revision one'));
    const source=projectAutoTaskConfigFile(TEST_UID,projectId,taskId), target=autoTaskDir(TEST_UID,taskId);
    const targetAttachments=autoTaskAttachmentsDir(TEST_UID,taskId);
    fs.mkdirSync(targetAttachments,{recursive:true});
    fs.writeFileSync(path.join(targetAttachments,'draft.txt'),'unrelated draft');
    const initial=fs.readFileSync(source);
    const rename=nativeFs.promises.rename.bind(nativeFs.promises);
    const fault=Object.assign(new Error('injected activation failure'),{code:'ENOSPC'});
    const spy=vi.spyOn(nativeFs.promises,'rename').mockImplementation(async(from,to)=>{
      if(String(to)===target && (rollbackFails || !String(from).endsWith('.previous')))throw fault;
      return rename(from,to);
    });
    syncBuiltinESMExports();
    try {
      await expect(updateTask(TEST_UID,taskId,{project_id:null})).rejects.toThrow(fault);
      expect(fs.readFileSync(source)).toEqual(initial);
      expect(fs.existsSync(autoTaskConfigFile(TEST_UID,taskId))).toBe(false);
      if (rollbackFails) {
        expect(fs.existsSync(target)).toBe(false);
        const backups=fs.readdirSync(path.dirname(target)).filter(name=>name.startsWith(`.${taskId}.install-`)&&name.endsWith('.previous'));
        expect(backups).toHaveLength(1);
        expect(fs.readFileSync(path.join(path.dirname(target),backups[0],'attachments','draft.txt'),'utf8')).toBe('unrelated draft');
      } else expect(fs.readdirSync(targetAttachments)).toEqual(['draft.txt']);
    } finally {spy.mockRestore();syncBuiltinESMExports();}
    expect((await updateTask(TEST_UID,taskId,{content:'Accepted revised briefing'},projectId)).ok).toBe(true);
    await uploadAttachment(TEST_UID,taskId,'source.txt',Buffer.from('revision two'));
    expect((await updateTask(TEST_UID,taskId,{project_id:null})).ok).toBe(true);
    const durable=fs.readFileSync(autoTaskConfigFile(TEST_UID,taskId));
    expect(await setTaskEnabled(TEST_UID,taskId,true,projectId)).toEqual({ok:false,error:'not_found'});
    expect(await deleteTask(TEST_UID,taskId,projectId)).toEqual({ok:false});
    expect(fs.readFileSync(autoTaskConfigFile(TEST_UID,taskId))).toEqual(durable);
    stopScheduler();await rescheduleAllForTest(TEST_UID);
    expect(await listTasks(TEST_UID)).toMatchObject([{id:taskId,content:'Accepted revised briefing',enabled:false}]);
    expect(await listTasks(TEST_UID)).toHaveLength(1);
    expect(fs.existsSync(source)).toBe(false);
    expect(fs.readFileSync(path.join(targetAttachments,'source.txt'),'utf8')).toBe('revision two');
    expect(fs.readFileSync(path.join(targetAttachments,'draft.txt'),'utf8')).toBe('unrelated draft');
    expect(fs.readdirSync(path.dirname(target)).filter(name=>name.includes('.install-')||name.includes('.old-'))).toEqual([]);
    expect(autoRuntime.send).not.toHaveBeenCalled();
    expect(armedDueAtForTest(taskId)).toBeNull();
  });

  it('preserves the original task and destination draft when migration commit and rollback deletion fail', async () => {
    const taskId='at_19191919', projectId='p_rollback_cleanup';
    writeProject(TEST_UID,projectId);
    expect((await createTask(TEST_UID,{id:taskId,project_id:projectId,content:'Keep this schedule',enabled:false,
      schedule:{type:'daily',hour:18,minute:0},attachments:['source.txt']})).ok).toBe(true);
    await uploadAttachment(TEST_UID,taskId,'source.txt',Buffer.from('source attachment'));
    const source=path.dirname(projectAutoTaskConfigFile(TEST_UID,projectId,taskId));
    const target=autoTaskDir(TEST_UID,taskId), attachments=autoTaskAttachmentsDir(TEST_UID,taskId);
    fs.mkdirSync(attachments,{recursive:true});fs.writeFileSync(path.join(attachments,'draft.txt'),'only draft');
    const rename=nativeFs.renameSync.bind(nativeFs),rm=nativeFs.promises.rm.bind(nativeFs.promises);
    const renameSpy=vi.spyOn(nativeFs,'renameSync').mockImplementation((from,to)=>{
      if(String(from)===source)throw new Error('source retirement denied');
      return rename(from,to);
    });
    const rmSpy=vi.spyOn(nativeFs.promises,'rm').mockImplementation(async(file,options)=>{
      if(String(file)===target)throw new Error('rollback cleanup denied');
      return rm(file,options);
    });
    syncBuiltinESMExports();
    try {await expect(updateTask(TEST_UID,taskId,{project_id:null})).rejects.toThrow('source retirement denied');}
    finally {renameSpy.mockRestore();rmSpy.mockRestore();syncBuiltinESMExports();}
    expect(await getTask(TEST_UID,taskId)).toMatchObject({project_id:projectId,enabled:false});
    expect(fs.existsSync(autoTaskConfigFile(TEST_UID,taskId))).toBe(false);
    expect(fs.readFileSync(path.join(attachments,'draft.txt'),'utf8')).toBe('only draft');
    expect((await updateTask(TEST_UID,taskId,{project_id:null})).ok).toBe(true);
    stopScheduler();await rescheduleAllForTest(TEST_UID);
    expect(await listTasks(TEST_UID)).toMatchObject([{id:taskId,enabled:false}]);
    expect(await listTasks(TEST_UID)).toHaveLength(1);
    expect(fs.readFileSync(path.join(attachments,'draft.txt'),'utf8')).toBe('only draft');
    expect(fs.readFileSync(path.join(attachments,'source.txt'),'utf8')).toBe('source attachment');
    expect(fs.existsSync(source)).toBe(false);expect(autoRuntime.send).not.toHaveBeenCalled();
  });
});
