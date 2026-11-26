import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { captureMainLogWorkers } from '../../../helpers/capture-main-log-workers';

let tmpDir: string;
let previousWorkspace: string | undefined;
let closeLogWorkers: () => Promise<void>;

const UID = 'failed-retry-user';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-failed-retry-'));
  previousWorkspace = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  closeLogWorkers = await captureMainLogWorkers();
  const users = await import('../../../../src/main/features/users');
  users.activateUser(UID);
});

afterEach(async () => {
  await closeLogWorkers();
  process.env.ORKAS_WORKSPACE_ROOT = previousWorkspace;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function writeAttempt(cid: string, failure: Record<string, unknown>, actorId = 'commander', modelText = 'Authoritative original request') {
  const layout = await import('../../../../src/main/util/project-layout');
  const file = layout.conversationMessageFile(UID, cid);
  const rows = [
    {
      id: `${cid}-source`,
      ts: '2026-07-20T10:00:00.000Z',
      from: 'user',
      to: [actorId],
      text: 'Visible original request',
      model_text: modelText,
      attachments: ['brief.txt'],
    },
    {
      id: `${cid}-failed`,
      ts: '2026-07-20T10:01:00.000Z',
      from: actorId,
      to: ['user'],
      text: 'The reply failed.',
      failure_kind: 'model',
      failure_code: 'provider_error',
      ...failure,
    },
  ];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);
  return rows;
}

describe('group_chat failed-turn smart retry', () => {
  it('preserves an explicit ImageStudio export on a failed reply retry', async () => {
    const cid = 'native-image-png-retry';
    const { IMAGE_STUDIO_AGENT_ID } = await import('../../../../src/main/model/core-agent/tool-catalog');
    const state = await import('../../../../src/main/features/group_chat/state');
    await state.seedReservedActors(UID, cid);
    await state.ensureAgentMember(UID, cid, IMAGE_STUDIO_AGENT_ID, 'ImageStudio');
    const rows = await writeAttempt(cid, { failure_kind: 'operation', failure_code: 'image_studio_native_png_missing' },
      IMAGE_STUDIO_AGENT_ID, '/export-png Replace the title');
    const layout = await import('../../../../src/main/util/project-layout');
    const [source, failed] = rows;
    fs.writeFileSync(layout.conversationMessageFile(UID, cid),
      [JSON.stringify({ ...source, image_studio_native_png: true }), JSON.stringify(failed)].join('\n') + '\n');

    const api = await import('../../../../src/main/features/group_chat');
    expect(await api.resolveFailedTurnRetry({ userId: UID, cid, failedMessageId: failed.id, visibleText: 'Retry' }))
      .toMatchObject({ ok: true, value: { enqueue: { forceTo: [IMAGE_STUDIO_AGENT_ID], imageStudioNativePng: true } } });
  });

  it.each(['resume', 'restart'] as const)('restores the task owner scope and dependency result on %s', async mode => {
    const cid = `scoped-${mode}`;
    const board = await import('../../../../src/main/features/group_chat/task_board');
    const predecessor = await board.createTask(UID, cid, { assignee: 'researcher', instruction: 'Inspect sales.', createdBy: 'user' });
    await board.claimTask(UID, cid, predecessor.task_id);
    await board.finishTask(UID, cid, predecessor.task_id, 'done', { resultMsgId: 'sales-result' });
    const task = await board.createTask(UID, cid, { assignee: 'commander', instruction: 'Write only the introduction.',
      createdBy: 'user', sourceMsgId: `${cid}-source`, assignmentContext: 'Researcher owns the chart.', after: [predecessor.task_id] });
    await board.claimTask(UID, cid, task.task_id);
    await board.finishTask(UID, cid, task.task_id, 'failed');
    await writeAttempt(cid, { task_id: task.task_id, source_message_id: `${cid}-source` });
    const layout = await import('../../../../src/main/util/project-layout');
    fs.appendFileSync(layout.conversationMessageFile(UID, cid), JSON.stringify({ id: 'sales-result', from: 'researcher', to: ['user'],
      text: 'Verified revenue is 37.', produced: ['verified-sales.csv'] }) + '\n');
    if (mode === 'resume') {
      const sessions = await import('../../../../src/main/model/core-agent/session-store');
      const state = await import('../../../../src/main/features/group_chat/state');
      (await sessions.getSession(state.buildGconvSessionId(cid))).beginUserTurn([{ type: 'text', text: task.instruction }]);
    }
    const api = await import('../../../../src/main/features/group_chat');
    const result = await api.resolveFailedTurnRetry({ userId: UID, cid, failedMessageId: `${cid}-failed`, visibleText: 'Retry' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.mode).toBe(mode);
    expect(result.value.enqueue.model_text).toContain(task.instruction);
    expect(result.value.enqueue.model_text).not.toContain('Authoritative original request');
    expect(result.value.enqueue.assignmentContext).toContain('Researcher owns the chart.');
    expect(result.value.enqueue.predecessorContext).toContain('Verified revenue is 37.');
    expect(result.value.enqueue.predecessorContext).toContain('verified-sales.csv');
    expect(result.value.enqueue.retryOfTaskId).toBeUndefined();
  });

  it('keeps the original delegated assignment when retrying a failed retry', async () => {
    const cid = 'retry-of-delegated-retry';
    const board = await import('../../../../src/main/features/group_chat/task_board');
    const parent = await board.createTask(UID, cid, { assignee: 'commander', instruction: 'Prepare report.', createdBy: 'user' });
    const original = await board.createTask(UID, cid, { assignee: 'commander', instruction: 'Review report.',
      createdBy: 'commander', parentTaskId: parent.task_id });
    await board.finishTask(UID, cid, original.task_id, 'failed');
    const attempt = await board.createTask(UID, cid, { assignee: 'commander', instruction: original.instruction,
      createdBy: 'user', sourceMsgId: `${cid}-source`, retryOfTaskId: original.task_id });
    await board.finishTask(UID, cid, attempt.task_id, 'failed');
    await writeAttempt(cid, { task_id: attempt.task_id, source_message_id: `${cid}-source` });
    const api = await import('../../../../src/main/features/group_chat');
    expect(await api.resolveFailedTurnRetry({ userId: UID, cid, failedMessageId: `${cid}-failed`, visibleText: 'Retry' }))
      .toMatchObject({ ok: true, value: { enqueue: { retryOfTaskId: original.task_id } } });
  });

  it.each(['foreign-owner', 'foreign-source', 'missing-shared-task'])(
    'rejects ambiguous or mismatched recovery provenance: %s', async kind => {
      const cid = `invalid-scope-${kind}`;
      const board = await import('../../../../src/main/features/group_chat/task_board');
      const task = await board.createTask(UID, cid, { assignee: kind === 'foreign-owner' ? 'researcher' : 'commander',
        instruction: 'A separate task.', createdBy: 'user', sourceMsgId: kind === 'foreign-source' ? 'another-source' : `${cid}-source` });
      const rows = await writeAttempt(cid, { task_id: kind === 'missing-shared-task' ? 'unknown-task' : task.task_id,
        source_message_id: `${cid}-source` });
      rows[0].to = ['commander', 'researcher'];
      const layout = await import('../../../../src/main/util/project-layout');
      fs.writeFileSync(layout.conversationMessageFile(UID, cid), rows.map(r => JSON.stringify(r)).join('\n') + '\n');
      const api = await import('../../../../src/main/features/group_chat');
      expect(await api.resolveFailedTurnRetry({ userId: UID, cid, failedMessageId: `${cid}-failed`, visibleText: 'Retry' }))
        .toMatchObject({ ok: false });
    });

  it('preserves the original language request on resume rather than selecting the English recovery prose', async () => {
    const cid = 'language-resume-cid';
    const request = 'Inspect the input and reply in Korean.';
    const config = await import('../../../../src/main/features/config');
    config.setLanguage('zh');
    await writeAttempt(cid, {}, 'commander', request);
    const state = await import('../../../../src/main/features/group_chat/state');
    const sessions = await import('../../../../src/main/model/core-agent/session-store');
    const session = await sessions.getSession(state.buildGconvSessionId(cid));
    session.beginUserTurn([{ type: 'text', text: request }]);
    session.ensureExecutionPlanAnchor();
    const groupChat = await import('../../../../src/main/features/group_chat');
    const result = await groupChat.resolveFailedTurnRetry({ userId: UID, cid,
      failedMessageId: `${cid}-failed`, visibleText: '继续' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.mode).toBe('resume');
    expect(result.value.enqueue.text).toBe('继续');
    expect(result.value.enqueue.model_text).toContain(request);
    expect(result.value.enqueue.model_text).toContain('Preserve the response language established by the original user request');
    expect(result.value.enqueue.model_text).toContain('If no response language was established, use Chinese (简体中文)');
  });

  it('continues the same actor when its persistent session has recoverable task state', async () => {
    const cid = 'resume-cid';
    await writeAttempt(cid, {});
    const state = await import('../../../../src/main/features/group_chat/state');
    const sessions = await import('../../../../src/main/model/core-agent/session-store');
    const session = await sessions.getSession(state.buildGconvSessionId(cid));
    session.beginUserTurn([{ type: 'text', text: 'Visible original request' }]);
    session.ensureExecutionPlanAnchor();
    session.addAssistantMessage([{
      type: 'tool_use',
      id: 'inspect-call',
      name: 'inspect_workspace',
      input: { target: 'report' },
    }]);
    session.addToolResult('inspect-call', 'workspace inspection complete', undefined, false);
    session.recordCompletedWork({
      toolCallId: 'inspect-call',
      tool: 'inspect_workspace',
      inputDigest: 'inspect:report',
      inputSummary: '{"target":"report"}',
      status: 'succeeded',
      resultSummary: 'workspace inspection complete',
    });
    // Force the resolver to reload JSONL + context sidecar instead of seeing
    // the in-memory session created above. This models an application restart.
    sessions._evictAll();

    const groupChat = await import('../../../../src/main/features/group_chat');
    const resolved = await groupChat.resolveFailedTurnRetry({
      userId: UID,
      cid,
      failedMessageId: `${cid}-failed`,
      visibleText: 'Continue',
    });

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.mode).toBe('resume');
    expect(resolved.value.enqueue).toMatchObject({
      uid: UID,
      cid,
      fromActorId: 'user',
      text: 'Continue',
      forceTo: ['commander'],
    });
    expect(resolved.value.enqueue.model_text).toContain('<task-retry mode="resume">');
    expect(resolved.value.enqueue.model_text).toContain('Do not repeat work already verified as successful');
    expect(resolved.value.enqueue.model_text).toContain('Authoritative original request');
    expect(resolved.value.enqueue.model_text).toContain('<recovery-evidence>');
    expect(resolved.value.recovery).toMatchObject({
      active_turn: true,
      completed_work_count: 1,
      succeeded_work_count: 1,
      uncertain_operation_count: 0,
    });
    expect(resolved.value.enqueue.resumeActiveTurn).toBe(true);
    expect(resolved.value.enqueue.failedTurnRetryMode).toBe('resume');
    expect(resolved.value.enqueue.retrySourceMessageId).toBe(`${cid}-source`);
    expect(resolved.value.enqueue.retryUncertainOperationCount).toBe(0);
    expect(resolved.value.enqueue).not.toHaveProperty('attachments');
    const restored = await sessions.getSession(state.buildGconvSessionId(cid));
    expect(restored.getSerializedContextState()?.activeTurn).toBeTruthy();
    expect(restored.getCompletedWorkLedger()).toEqual([
      expect.objectContaining({ tool: 'inspect_workspace', status: 'succeeded' }),
    ]);
  });

  it('continues from a completed turn when its plan and completed-work evidence remain durable', async () => {
    const cid = 'completed-state-cid';
    await writeAttempt(cid, {});
    const state = await import('../../../../src/main/features/group_chat/state');
    const sessions = await import('../../../../src/main/model/core-agent/session-store');
    const session = await sessions.getSession(state.buildGconvSessionId(cid));
    session.beginUserTurn([{ type: 'text', text: 'Visible original request' }]);
    session.updateExecutionPlan({
      steps: [
        { step: 'Inspect inputs', status: 'completed' },
        { step: 'Generate final report', status: 'pending' },
      ],
    });
    session.recordCompletedWork({
      tool: 'inspect_workspace',
      inputDigest: 'inspect:inputs',
      inputSummary: '{"scope":"inputs"}',
      status: 'succeeded',
      resultSummary: 'inputs verified',
    });
    session.addAssistantMessage([{ type: 'text', text: 'Partial result before host failure' }]);
    session.completeActiveTurn('host failed after model output');
    sessions._evictAll();

    const groupChat = await import('../../../../src/main/features/group_chat');
    const resolved = await groupChat.resolveFailedTurnRetry({
      userId: UID,
      cid,
      failedMessageId: `${cid}-failed`,
      visibleText: 'Continue',
    });

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.mode).toBe('resume');
    expect(resolved.value.enqueue.resumeActiveTurn).toBe(true);
    expect(resolved.value.recovery).toMatchObject({
      active_turn: false,
      plan_pending_steps: 1,
      plan_completed_steps: 1,
      completed_work_count: 1,
      succeeded_work_count: 1,
    });
  });

  it('continues an uncertain started tool from persisted process evidence and requires verification', async () => {
    const cid = 'uncertain-tool-cid';
    await writeAttempt(cid, {
      failure_kind: 'config',
      failure_code: 'worker_lost_after_tool_start',
      process: [{
        event: {
          stream: 'tool',
          data: { phase: 'start', tool: 'publish_external_asset' },
        },
      }],
    });
    const groupChat = await import('../../../../src/main/features/group_chat');

    const resolved = await groupChat.resolveFailedTurnRetry({
      userId: UID,
      cid,
      failedMessageId: `${cid}-failed`,
      visibleText: 'Continue',
    });

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.mode).toBe('resume');
    expect(resolved.value.enqueue.resumeActiveTurn).toBe(true);
    expect(resolved.value.enqueue.model_text).toContain('verify its current state');
    expect(resolved.value.enqueue.model_text).toContain('non-idempotent operation');
    expect(resolved.value.recovery).toMatchObject({
      uncertain_operation_count: 1,
      uncertain_operations: ['publish_external_asset'],
    });
    expect(resolved.value.enqueue.retryUncertainOperationCount).toBe(1);
    expect(resolved.value.enqueue.model_text).toContain('"uncertain_operations":["publish_external_asset"]');
  });

  it('does not mark a tool call uncertain once a matching terminal event was persisted', async () => {
    const cid = 'settled-tool-cid';
    await writeAttempt(cid, {
      failure_kind: 'runtime',
      failure_code: 'failure_after_completed_tool',
      process: [
        {
          event: {
            stream: 'tool',
            data: { phase: 'start', tool: 'publish_external_asset', call_id: 'publish-1' },
          },
        },
        {
          event: {
            stream: 'tool',
            data: { phase: 'end', tool: 'publish_external_asset', call_id: 'publish-1' },
          },
        },
      ],
    });
    const groupChat = await import('../../../../src/main/features/group_chat');

    const resolved = await groupChat.resolveFailedTurnRetry({
      userId: UID,
      cid,
      failedMessageId: `${cid}-failed`,
      visibleText: 'Continue',
    });

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.mode).toBe('resume');
    expect(resolved.value.recovery).toMatchObject({
      uncertain_operation_count: 0,
      uncertain_operations: [],
    });
    expect(resolved.value.enqueue.retryUncertainOperationCount).toBe(0);
  });

  it('recognizes CLI tool events as durable retry evidence', async () => {
    const cid = 'uncertain-cli-tool-cid';
    await writeAttempt(cid, {
      failure_kind: 'runtime',
      failure_code: 'cli_failed_after_tool_start',
      process: [{
        event: {
          stream: 'cli',
          data: { type: 'tool-event', phase: 'use', tool: 'exec_command' },
        },
      }],
    });
    const groupChat = await import('../../../../src/main/features/group_chat');

    const resolved = await groupChat.resolveFailedTurnRetry({
      userId: UID,
      cid,
      failedMessageId: `${cid}-failed`,
      visibleText: 'Continue',
    });

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.mode).toBe('resume');
    expect(resolved.value.enqueue).toMatchObject({
      failedTurnRetryMode: 'resume',
      retrySourceMessageId: `${cid}-source`,
      retryUncertainOperationCount: 1,
      resumeActiveTurn: true,
    });
  });

  it('uses a provenance-matched native CLI binding as durable retry state', async () => {
    const cid = 'cli-binding-cid';
    const agentId = 'cli-agent';
    const paths = await import('../../../../src/main/paths');
    const dir = paths.agentDir(UID, agentId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify({
      agent_id: agentId,
      name: 'CLI Agent',
      runtime: { kind: 'cli', cli: 'codex' },
      created_at: 't',
      updated_at: 't',
    }));
    const state = await import('../../../../src/main/features/group_chat/state');
    await state.seedReservedActors(UID, cid);
    await state.ensureAgentMember(UID, cid, agentId, 'CLI Agent');
    await writeAttempt(cid, { failure_kind: 'runtime', failure_code: 'cli_timeout' }, agentId);
    const sessions = await import('../../../../src/main/features/local_agents/sessions');
    await sessions.setSessionId(UID, cid, agentId, 'codex', 'thread-1', {
      sourceMessageId: `${cid}-source`,
      turnId: 'turn-1',
      runId: 'run-1',
      terminalStatus: 'timeout',
    });
    const groupChat = await import('../../../../src/main/features/group_chat');

    const resolved = await groupChat.resolveFailedTurnRetry({
      userId: UID,
      cid,
      failedMessageId: `${cid}-failed`,
      visibleText: 'Continue',
    });

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.mode).toBe('resume');
    expect(resolved.value.enqueue.failedTurnRetryMode).toBe('resume');
  });

  it('does not recover a missing roster entry for a disabled Agent', async () => {
    const cid = 'disabled-agent-retry-cid';
    const agentId = 'disabled-cli-agent';
    const paths = await import('../../../../src/main/paths');
    const dir = paths.agentDir(UID, agentId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify({
      agent_id: agentId,
      name: 'Disabled CLI Agent',
      runtime: { kind: 'cli', cli: 'codex' },
      created_at: 't',
      updated_at: 't',
    }));
    const enabled = await import('../../../../src/main/features/component_enabled');
    enabled.setAgentEnabled(UID, agentId, false);
    await writeAttempt(cid, { failure_kind: 'runtime', failure_code: 'cli_timeout' }, agentId);

    const groupChat = await import('../../../../src/main/features/group_chat');
    const resolved = await groupChat.resolveFailedTurnRetry({
      userId: UID,
      cid,
      failedMessageId: `${cid}-failed`,
      visibleText: 'Continue',
    });

    expect(resolved).toEqual({ ok: false, error: 'retry actor is unavailable' });
  });

  it('replays the authoritative request and attachments when no recoverable state exists', async () => {
    const cid = 'restart-cid';
    await writeAttempt(cid, { failure_kind: 'config', failure_code: 'model_not_configured' });
    const groupChat = await import('../../../../src/main/features/group_chat');

    const resolved = await groupChat.resolveFailedTurnRetry({
      userId: UID,
      cid,
      failedMessageId: `${cid}-failed`,
      visibleText: 'Continue',
    });

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.mode).toBe('restart');
    expect(resolved.value.enqueue).toMatchObject({
      uid: UID,
      cid,
      fromActorId: 'user',
      text: 'Continue',
      model_text: 'Authoritative original request',
      attachments: ['brief.txt'],
      forceTo: ['commander'],
    });
    expect(resolved.value.enqueue).not.toHaveProperty('resumeActiveTurn');
    expect(resolved.value.enqueue.failedTurnRetryMode).toBe('restart');
    expect(resolved.value.enqueue.retrySourceMessageId).toBe(`${cid}-source`);
    expect(resolved.value.recovery).toMatchObject({
      active_turn: false,
      completed_work_count: 0,
      produced_count: 0,
      uncertain_operation_count: 0,
    });
  });

  it('retries the causally linked request when a newer user message was persisted first', async () => {
    const cid = 'interleaved-retry-cid';
    const rows = await writeAttempt(cid, {
      failure_kind: 'config',
      failure_code: 'model_not_configured',
      source_message_id: `${cid}-source`,
    });
    const layout = await import('../../../../src/main/util/project-layout');
    const file = layout.conversationMessageFile(UID, cid);
    const newerUser = {
      id: `${cid}-newer-user`,
      ts: '2026-07-20T10:00:30.000Z',
      from: 'user',
      to: ['commander'],
      text: 'Visible newer queued request',
      model_text: 'Authoritative newer queued request',
      attachments: ['newer.txt'],
    };
    fs.writeFileSync(file, `${[rows[0], newerUser, rows[1]]
      .map((row) => JSON.stringify(row))
      .join('\n')}\n`);

    const groupChat = await import('../../../../src/main/features/group_chat');
    const resolved = await groupChat.resolveFailedTurnRetry({
      userId: UID,
      cid,
      failedMessageId: `${cid}-failed`,
      visibleText: 'Continue',
    });

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.mode).toBe('restart');
    expect(resolved.value.enqueue.model_text).toBe('Authoritative original request');
    expect(resolved.value.enqueue.attachments).toEqual(['brief.txt']);
    expect(resolved.value.enqueue.retrySourceMessageId).toBe(`${cid}-source`);
  });

  it.each([undefined, 'Original bounded goal; final answer in Arabic.', 'x'.repeat(4001)])('uses an explicitly linked internal dispatch and its trusted goal after reload (%s)', async (goal) => {
    const cid = 'dispatch-source-retry-cid';
    const layout = await import('../../../../src/main/util/project-layout');
    const file = layout.conversationMessageFile(UID, cid);
    const rows = [
      {
        id: `${cid}-user`,
        ts: '2026-07-20T10:00:00.000Z',
        from: 'user',
        to: ['commander'],
        text: 'Broad user objective',
        model_text: 'Broad authoritative user objective',
      },
      {
        id: `${cid}-dispatch`,
        ts: '2026-07-20T10:00:30.000Z',
        from: 'specialist-agent',
        to: ['commander'],
        text: 'Internal continuation',
        model_text: 'Exact internal continuation payload',
        dispatch: true,
        ...(goal !== undefined ? { orchestration_goal: goal } : {}),
      },
      {
        id: `${cid}-failed`,
        ts: '2026-07-20T10:01:00.000Z',
        from: 'commander',
        to: ['user'],
        text: 'The continuation failed.',
        failure_kind: 'model',
        failure_code: 'provider_error',
        source_message_id: `${cid}-dispatch`,
      },
    ];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);

    const groupChat = await import('../../../../src/main/features/group_chat');
    const resolved = await groupChat.resolveFailedTurnRetry({
      userId: UID,
      cid,
      failedMessageId: `${cid}-failed`,
      visibleText: 'Continue',
    });

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.mode).toBe('restart');
    expect(resolved.value.enqueue.model_text).toBe('Exact internal continuation payload');
    expect(resolved.value.enqueue.retrySourceMessageId).toBe(`${cid}-dispatch`);
    if (goal === undefined) expect(resolved.value.enqueue).not.toHaveProperty('orchestrationGoal');
    else expect(resolved.value.enqueue.orchestrationGoal).toBe(goal.slice(0, 4000));
  });

  it('restarts an older failed bubble instead of attaching it to a newer actor turn', async () => {
    const cid = 'stale-failure-cid';
    await writeAttempt(cid, {});
    const layout = await import('../../../../src/main/util/project-layout');
    const file = layout.conversationMessageFile(UID, cid);
    fs.appendFileSync(file, [
      JSON.stringify({
        id: `${cid}-newer-user`,
        ts: '2026-07-20T10:02:00.000Z',
        from: 'user',
        to: ['commander'],
        text: 'A newer task',
        model_text: 'Authoritative newer task',
      }),
      JSON.stringify({
        id: `${cid}-newer-failed`,
        ts: '2026-07-20T10:03:00.000Z',
        from: 'commander',
        to: ['user'],
        text: 'The newer reply failed.',
        failure_kind: 'model',
        failure_code: 'provider_error',
      }),
    ].join('\n') + '\n');
    const state = await import('../../../../src/main/features/group_chat/state');
    const sessions = await import('../../../../src/main/model/core-agent/session-store');
    const session = await sessions.getSession(state.buildGconvSessionId(cid));
    session.beginUserTurn([{ type: 'text', text: 'A newer task' }]);
    session.ensureExecutionPlanAnchor();

    const groupChat = await import('../../../../src/main/features/group_chat');
    const resolved = await groupChat.resolveFailedTurnRetry({
      userId: UID,
      cid,
      failedMessageId: `${cid}-failed`,
      visibleText: 'Continue',
    });

    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.value.mode).toBe('restart');
    expect(resolved.value.enqueue.model_text).toBe('Authoritative original request');
    expect(resolved.value.enqueue.attachments).toEqual(['brief.txt']);
    expect(resolved.value.enqueue).not.toHaveProperty('resumeActiveTurn');
  });

  it('accepts persisted user-stop and startup-recovery interruptions as retry targets', async () => {
    const stoppedCid = 'stopped-retry-cid';
    await writeAttempt(stoppedCid, {
      failure_kind: undefined,
      failure_code: undefined,
      text: 'Partial result.\n\n(stopped)',
      process: [{
        type: 'event',
        event: {
          stream: 'runtime',
          data: { phase: 'end', status: 'error', aborted: true, errored: false },
        },
      }],
    });
    const startupCid = 'startup-interruption-retry-cid';
    await writeAttempt(startupCid, {
      failure_kind: undefined,
      failure_code: undefined,
      text: 'The previous reply was interrupted.',
      system_kind: 'reply_interrupted',
    });
    const groupChat = await import('../../../../src/main/features/group_chat');

    for (const cid of [stoppedCid, startupCid]) {
      const resolved = await groupChat.resolveFailedTurnRetry({
        userId: UID,
        cid,
        failedMessageId: `${cid}-failed`,
        visibleText: 'Continue',
      });

      expect(resolved.ok, cid).toBe(true);
      if (!resolved.ok) continue;
      expect(resolved.value.mode, cid).toBe('restart');
      expect(resolved.value.enqueue, cid).toMatchObject({
        model_text: 'Authoritative original request',
        attachments: ['brief.txt'],
        forceTo: ['commander'],
      });
    }
  });

  it('rejects a successful assistant message as a retry target', async () => {
    const cid = 'success-cid';
    await writeAttempt(cid, { failure_kind: undefined, failure_code: undefined, text: 'Done.' });
    const groupChat = await import('../../../../src/main/features/group_chat');

    const resolved = await groupChat.resolveFailedTurnRetry({
      userId: UID,
      cid,
      failedMessageId: `${cid}-failed`,
      visibleText: 'Continue',
    });

    expect(resolved).toEqual({ ok: false, error: 'retry target is not a failed assistant reply' });
  });
});
