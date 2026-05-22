/**
 * Plan recovery — covers the plan-rail's user-initiated state actions
 * (`retryStep`, `skipStep`) and the executor's transient-error auto-retry
 * safety net (the `maybeRetryTransient` guard inside `transitionStepFailed`
 * and `applyTermination`).
 *
 * These are the two recovery paths the rail exposes; together they unlock
 * the "step failed → plan deadlock" scenario that originally motivated the
 * rail. See `docs/plans/plan-rail.md` (deleted on acceptance) and CLAUDE.md
 * §5 Group-chat for the spec.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// LLM mock — same pattern as plan_executor.test.ts, only triggered for
// transient-retry redispatch tests.
const _scripts = new Map<string, Array<any[]>>();
function _setScript(sessionId: string, events: any[]) {
  const arr = _scripts.get(sessionId) || [];
  arr.push(events);
  _scripts.set(sessionId, arr);
}
function _resetScripts() { _scripts.clear(); }

vi.mock('../../../../src/main/model/client', () => ({
  async *streamChatWithModel(opts: any) {
    const sid = opts.sessionId || '';
    const queue = _scripts.get(sid) || [];
    const events = queue.shift() || [{ type: 'final', text: '' }];
    _scripts.set(sid, queue);
    for (const ev of events) yield ev;
    yield { type: 'done' };
  },
  async chatWithModel() { return { ok: true, text: '', error: '', aborted: false }; },
}));

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'u1';
const A_ID = 'a1a1a1a1a1a1';
const A_NAME = 'Alpha';

function newCid(): string { return 'c' + Math.random().toString(16).slice(2, 13); }

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-plan-recovery-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  _resetScripts();
  vi.resetModules();
  const users = await import('../../../../src/main/features/users');
  users.activateUser(TEST_UID);

  const paths = await import('../../../../src/main/paths');
  const aDir = paths.agentDir(TEST_UID, A_ID);
  fs.mkdirSync(aDir, { recursive: true });
  fs.writeFileSync(path.join(aDir, 'agent.json'), JSON.stringify({
    agent_id: A_ID, name: A_NAME, description: 'Alpha agent', workflow: 'do work',
    created_at: 't', updated_at: 't',
  }));
});

afterEach(async () => {
  try {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
    const dir = paths.userChatsDir(TEST_UID);
    if (fs.existsSync(dir)) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory() && /^c[0-9a-f]{12}$/.test(e.name)) bus.dropConv(TEST_UID, e.name);
      }
    }
  } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 30));
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function seedPlan(uid: string, cid: string, planInput: any) {
  // Importing bus binds executor hooks (module side effect).
  await import('../../../../src/main/features/group_chat/bus');
  const plan = await import('../../../../src/main/features/group_chat/plan');
  const state = await import('../../../../src/main/features/group_chat/state');
  await plan.setPlan(uid, cid, planInput);
  await state.seedReservedActors(uid, cid);
}

// ─────────────────────────────────────────────────────────────────────────
//  retryStep
// ─────────────────────────────────────────────────────────────────────────

describe('plan recovery › retryStep', () => {
  it('flips a failed step back to pending, clears reason, resets transient_attempts', async () => {
    const cid = newCid();
    await seedPlan(TEST_UID, cid, {
      steps: [
        { title: 'Step 1', assignee: A_NAME, input: 'do step 1', wait_for: [] },
        { title: 'Step 2', assignee: A_NAME, input: 'do step 2' },
      ],
    });
    const plan = await import('../../../../src/main/features/group_chat/plan');
    await plan.updateStep(TEST_UID, cid, 1, 'failed', {
      failure_reason: 'something exploded',
      transient_attempts: 2,
    });

    const planExecutor = await import('../../../../src/main/features/group_chat/plan_executor');
    const r = await planExecutor.retryStep(TEST_UID, cid, 1);
    expect(r.ok).toBe(true);

    const fresh = await plan.readPlan(TEST_UID, cid);
    // Retry returns AFTER reconcileAfterStepTransition runs, which immediately
    // dispatches the now-ready step. So observed state is "in_progress" once
    // dispatch fires (or "pending" briefly if the assignee was unresolvable).
    // What we care about: the step is no longer in failed state, and the
    // failure marker / transient counter were cleared.
    expect(fresh?.steps[0].status).not.toBe('failed');
    expect(fresh?.steps[0].status).not.toBe('skipped');
    expect(fresh?.steps[0].failure_reason).toBeUndefined();
    expect(fresh?.steps[0].transient_attempts).toBeUndefined();
  });

  it('rejects terminal states that are not retry results', async () => {
    const cid = newCid();
    await seedPlan(TEST_UID, cid, {
      steps: [{ title: 'Step 1', assignee: A_NAME, wait_for: [] }],
    });
    const plan = await import('../../../../src/main/features/group_chat/plan');
    await plan.updateStep(TEST_UID, cid, 1, 'skipped', { failure_reason: 'user skipped it' });

    const planExecutor = await import('../../../../src/main/features/group_chat/plan_executor');
    const r = await planExecutor.retryStep(TEST_UID, cid, 1);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not in failed state/);
  });

  it('treats repeated retry after recovery starts as idempotent for mid-recovery states (pending / in_progress / blocked)', async () => {
    const cid = newCid();
    await seedPlan(TEST_UID, cid, {
      steps: [
        { title: 'Step 1', assignee: A_NAME, wait_for: [] },
        { title: 'Step 2', assignee: A_NAME },
        { title: 'Step 3', assignee: A_NAME },
      ],
    });
    const plan = await import('../../../../src/main/features/group_chat/plan');
    await plan.updateStep(TEST_UID, cid, 1, 'in_progress');
    await plan.updateStep(TEST_UID, cid, 2, 'pending');
    await plan.updateStep(TEST_UID, cid, 3, 'blocked');

    const planExecutor = await import('../../../../src/main/features/group_chat/plan_executor');
    const inProgress = await planExecutor.retryStep(TEST_UID, cid, 1);
    const pending = await planExecutor.retryStep(TEST_UID, cid, 2);
    const blocked = await planExecutor.retryStep(TEST_UID, cid, 3);
    expect(inProgress.ok).toBe(true);
    expect(pending.ok).toBe(true);
    expect(blocked.ok).toBe(true);

    const fresh = await plan.readPlan(TEST_UID, cid);
    expect(fresh?.steps[0].status).toBe('in_progress');
    expect(fresh?.steps[1].status).toBe('pending');
    expect(fresh?.steps[2].status).toBe('blocked');
  });

  it('clears pending_form_id when a failed user step is retried (so the re-dispatch stamps a fresh form_id)', async () => {
    const cid = newCid();
    await seedPlan(TEST_UID, cid, {
      steps: [{ title: 'ask user', assignee: 'user', input: 'pick one', wait_for: [] }],
    });
    const plan = await import('../../../../src/main/features/group_chat/plan');
    // Simulate a previously-dispatched-then-failed user step: pending_form_id
    // is set (from the original dispatch), status is failed.
    await plan.updateStep(TEST_UID, cid, 1, 'failed', {
      failure_reason: 'user replied with an unrelated message',
      pending_form_id: 'a1b2c3d4e5f60001',
    });
    let fresh = await plan.readPlan(TEST_UID, cid);
    expect(fresh?.steps[0].pending_form_id).toBe('a1b2c3d4e5f60001');

    const planExecutor = await import('../../../../src/main/features/group_chat/plan_executor');
    const r = await planExecutor.retryStep(TEST_UID, cid, 1);
    expect(r.ok).toBe(true);

    fresh = await plan.readPlan(TEST_UID, cid);
    // Retry re-arms the step and reconcile may have re-dispatched it (which
    // would stamp a NEW pending_form_id). What we lock here is the
    // invariant: the stale form_id from the failed run must NOT survive.
    // Either the field is absent (no re-dispatch yet) OR it differs from
    // the old one (re-dispatched with a fresh id) — never the old value.
    expect(fresh?.steps[0].pending_form_id).not.toBe('a1b2c3d4e5f60001');
  });

  it('rejects retry on a done step (rail never shows retry button on done; reaching here would mis-attribute a retry signal)', async () => {
    const cid = newCid();
    await seedPlan(TEST_UID, cid, {
      steps: [{ title: 'Step 1', assignee: A_NAME, wait_for: [] }],
    });
    const plan = await import('../../../../src/main/features/group_chat/plan');
    await plan.updateStep(TEST_UID, cid, 1, 'done');

    const planExecutor = await import('../../../../src/main/features/group_chat/plan_executor');
    const r = await planExecutor.retryStep(TEST_UID, cid, 1);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not in failed state/);

    // Step remains done — retry must NOT silently mutate a completed step.
    const fresh = await plan.readPlan(TEST_UID, cid);
    expect(fresh?.steps[0].status).toBe('done');
  });

  it('cascade-unblocks downstream skipped via `aborted by step N failure` reason', async () => {
    const cid = newCid();
    await seedPlan(TEST_UID, cid, {
      steps: [
        { title: 'Step 1', assignee: A_NAME, wait_for: [] },
        { title: 'Step 2', assignee: A_NAME },
        { title: 'Step 3', assignee: A_NAME },
      ],
    });
    const plan = await import('../../../../src/main/features/group_chat/plan');
    await plan.updateStep(TEST_UID, cid, 1, 'failed', { failure_reason: 'fatal' });
    await plan.updateStep(TEST_UID, cid, 2, 'skipped', { failure_reason: 'aborted by step 1 failure' });
    await plan.updateStep(TEST_UID, cid, 3, 'skipped', { failure_reason: 'user did not want this' });

    const planExecutor = await import('../../../../src/main/features/group_chat/plan_executor');
    await planExecutor.retryStep(TEST_UID, cid, 1);

    const fresh = await plan.readPlan(TEST_UID, cid);
    // Step 1: retry path — out of failed; reconcile may have dispatched.
    expect(fresh?.steps[0].status).not.toBe('failed');
    // Step 2: cascade unblocked. wait_for defaults to [previous step], so it
    // won't dispatch until step 1 completes — should sit at pending.
    expect(fresh?.steps[1].status).toBe('pending');
    // Step 3: skipped for an unrelated reason — preserved.
    expect(fresh?.steps[2].status).toBe('skipped');
    expect(fresh?.steps[2].failure_reason).toBe('user did not want this');
  });
});

// ─────────────────────────────────────────────────────────────────────────
//  skipStep
// ─────────────────────────────────────────────────────────────────────────

describe('plan recovery › skipStep', () => {
  it('moves failed → skipped while preserving failure_reason', async () => {
    const cid = newCid();
    await seedPlan(TEST_UID, cid, {
      steps: [{ title: 'Step 1', assignee: A_NAME, wait_for: [] }],
    });
    const plan = await import('../../../../src/main/features/group_chat/plan');
    await plan.updateStep(TEST_UID, cid, 1, 'failed', { failure_reason: 'reason X' });

    const planExecutor = await import('../../../../src/main/features/group_chat/plan_executor');
    const r = await planExecutor.skipStep(TEST_UID, cid, 1);
    expect(r.ok).toBe(true);

    const fresh = await plan.readPlan(TEST_UID, cid);
    expect(fresh?.steps[0].status).toBe('skipped');
    expect(fresh?.steps[0].failure_reason).toBe('reason X');
  });

  it('rejects when not in failed state', async () => {
    const cid = newCid();
    await seedPlan(TEST_UID, cid, {
      steps: [{ title: 'Step 1', assignee: A_NAME, wait_for: [] }],
    });
    const planExecutor = await import('../../../../src/main/features/group_chat/plan_executor');
    const r = await planExecutor.skipStep(TEST_UID, cid, 1);
    expect(r.ok).toBe(false);
  });

  it('does NOT touch other cascade-skipped steps', async () => {
    const cid = newCid();
    await seedPlan(TEST_UID, cid, {
      steps: [
        { title: 'Step 1', assignee: A_NAME, wait_for: [] },
        { title: 'Step 2', assignee: A_NAME },
      ],
    });
    const plan = await import('../../../../src/main/features/group_chat/plan');
    await plan.updateStep(TEST_UID, cid, 1, 'failed', { failure_reason: 'boom' });
    await plan.updateStep(TEST_UID, cid, 2, 'skipped', { failure_reason: 'aborted by step 1 failure' });

    const planExecutor = await import('../../../../src/main/features/group_chat/plan_executor');
    await planExecutor.skipStep(TEST_UID, cid, 1);

    const fresh = await plan.readPlan(TEST_UID, cid);
    expect(fresh?.steps[0].status).toBe('skipped');
    expect(fresh?.steps[1].status).toBe('skipped');
    expect(fresh?.steps[1].failure_reason).toBe('aborted by step 1 failure');
  });
});

// ─────────────────────────────────────────────────────────────────────────
//  Transient auto-retry (A safety-net)
// ─────────────────────────────────────────────────────────────────────────

describe('plan recovery › transient auto-retry', () => {
  async function buildEvtForStep(stepIndex: number, errText: string) {
    const planExecutor = await import('../../../../src/main/features/group_chat/plan_executor');
    return {
      actor: { id: A_ID, kind: 'agent' as const },
      finalText: '',
      errText,
      aborted: false,
      produced: [] as string[],
      trigger: { kind: 'plan_step' as const, step_index: stepIndex },
      activityEvents: 0,
    } as Parameters<typeof planExecutor.onTurnFinished>[2];
  }

  it('folds a step back to pending on undici "terminated" and increments transient_attempts', async () => {
    const cid = newCid();
    await seedPlan(TEST_UID, cid, {
      steps: [{ title: 'Step 1', assignee: A_NAME, wait_for: [] }],
    });
    const plan = await import('../../../../src/main/features/group_chat/plan');
    await plan.updateStep(TEST_UID, cid, 1, 'in_progress');

    const planExecutor = await import('../../../../src/main/features/group_chat/plan_executor');
    const evt = await buildEvtForStep(1, 'TypeError: terminated');
    await planExecutor.onTurnFinished(TEST_UID, cid, evt);

    const fresh = await plan.readPlan(TEST_UID, cid);
    // After transient retry + reconcileAfterStepTransition, the step gets
    // re-dispatched right away → in_progress. The invariant is that the step
    // is NOT in failed state and the attempts counter was bumped.
    expect(fresh?.steps[0].status).not.toBe('failed');
    expect(fresh?.steps[0].transient_attempts).toBe(1);
    expect(fresh?.steps[0].failure_reason).toBeUndefined();
  });

  it('respects the MAX_TRANSIENT_RETRIES cap (2) and falls through to failed', async () => {
    const cid = newCid();
    await seedPlan(TEST_UID, cid, {
      steps: [{ title: 'Step 1', assignee: A_NAME, wait_for: [] }],
    });
    const plan = await import('../../../../src/main/features/group_chat/plan');
    await plan.updateStep(TEST_UID, cid, 1, 'in_progress', { transient_attempts: 2 });

    const planExecutor = await import('../../../../src/main/features/group_chat/plan_executor');
    const evt = await buildEvtForStep(1, 'TypeError: terminated');
    await planExecutor.onTurnFinished(TEST_UID, cid, evt);

    const fresh = await plan.readPlan(TEST_UID, cid);
    expect(fresh?.steps[0].status).toBe('failed');
    expect(fresh?.steps[0].failure_reason).toMatch(/terminated/);
  });

  it('does NOT retry on user-initiated abort (errText="aborted by user")', async () => {
    const cid = newCid();
    await seedPlan(TEST_UID, cid, {
      steps: [{ title: 'Step 1', assignee: A_NAME, wait_for: [] }],
    });
    const plan = await import('../../../../src/main/features/group_chat/plan');
    await plan.updateStep(TEST_UID, cid, 1, 'in_progress');

    const planExecutor = await import('../../../../src/main/features/group_chat/plan_executor');
    // The aborted=true path uses literal 'aborted by user' inside applyPlanStepTurn.
    const evt = await buildEvtForStep(1, '');
    (evt as any).aborted = true;
    await planExecutor.onTurnFinished(TEST_UID, cid, evt);

    const fresh = await plan.readPlan(TEST_UID, cid);
    expect(fresh?.steps[0].status).toBe('failed');
    expect(fresh?.steps[0].transient_attempts).toBeUndefined();
  });

  it('does NOT retry on non-transient errors (e.g. auth)', async () => {
    const cid = newCid();
    await seedPlan(TEST_UID, cid, {
      steps: [{ title: 'Step 1', assignee: A_NAME, wait_for: [] }],
    });
    const plan = await import('../../../../src/main/features/group_chat/plan');
    await plan.updateStep(TEST_UID, cid, 1, 'in_progress');

    const planExecutor = await import('../../../../src/main/features/group_chat/plan_executor');
    const evt = await buildEvtForStep(1, 'auth invalid: missing api key');
    await planExecutor.onTurnFinished(TEST_UID, cid, evt);

    const fresh = await plan.readPlan(TEST_UID, cid);
    expect(fresh?.steps[0].status).toBe('failed');
    expect(fresh?.steps[0].transient_attempts).toBeUndefined();
  });

  it('clears transient_attempts when a step ultimately completes', async () => {
    const cid = newCid();
    await seedPlan(TEST_UID, cid, {
      steps: [{ title: 'Step 1', assignee: A_NAME, wait_for: [] }],
    });
    const plan = await import('../../../../src/main/features/group_chat/plan');
    await plan.updateStep(TEST_UID, cid, 1, 'in_progress', { transient_attempts: 1 });

    const planExecutor = await import('../../../../src/main/features/group_chat/plan_executor');
    const evt = await buildEvtForStep(1, '');
    (evt as any).finalText = 'done!';
    await planExecutor.onTurnFinished(TEST_UID, cid, evt);

    const fresh = await plan.readPlan(TEST_UID, cid);
    expect(fresh?.steps[0].status).toBe('done');
    expect(fresh?.steps[0].transient_attempts).toBeUndefined();
  });
});
