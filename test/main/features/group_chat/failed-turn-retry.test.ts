import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

let tmpDir: string;
let previousWorkspace: string | undefined;

const UID = 'failed-retry-user';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-failed-retry-'));
  previousWorkspace = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  const users = await import('../../../../src/main/features/users');
  users.activateUser(UID);
});

afterEach(() => {
  process.env.ORKAS_WORKSPACE_ROOT = previousWorkspace;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function writeAttempt(cid: string, failure: Record<string, unknown>) {
  const layout = await import('../../../../src/main/util/project-layout');
  const file = layout.conversationMessageFile(UID, cid);
  const rows = [
    {
      id: `${cid}-source`,
      ts: '2026-07-20T10:00:00.000Z',
      from: 'user',
      to: ['commander'],
      text: 'Visible original request',
      model_text: 'Authoritative original request',
      attachments: ['brief.txt'],
    },
    {
      id: `${cid}-failed`,
      ts: '2026-07-20T10:01:00.000Z',
      from: 'commander',
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
    expect(resolved.value.enqueue.resumeActiveTurn).toBe(true);
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
