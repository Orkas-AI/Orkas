/**
 * Plan-executor integration tests — exercises bus + plan_executor as a
 * single unit, with a script-driven `streamChatWithModel` mock so we can
 * deterministically drive each turn's LLM output.
 *
 * Coverage matrix:
 *   1. Sequential pipeline + variable substitution between steps
 *   2. Parallel fork (same parallel_group) + synthesis step waiting on all
 *   3. Failure policy: abort_plan / continue / ask_commander
 *   4. user-assignee step renders a form, blocks until submit, then resumes
 *   5. Auto plan_update on agent reply (no LLM plan_update tool call)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Script-driven mock: per-session-id queue of event arrays.
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

// Three pre-seeded agents reused across tests.
const A_ID = 'a1a1a1a1a1a1';
const A_NAME = 'Alpha';
const B_ID = 'b2b2b2b2b2b2';
const B_NAME = 'Beta';
const C_ID = 'c3c3c3c3c3c3';
const C_NAME = 'Gamma';

function newCid(): string { return 'c' + Math.random().toString(16).slice(2, 13); }

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-pe-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  _resetScripts();
  vi.resetModules();
  const users = await import('../../../../src/main/features/users');
  users.activateUser(TEST_UID);

  const paths = await import('../../../../src/main/paths');
  for (const [id, name] of [[A_ID, A_NAME], [B_ID, B_NAME], [C_ID, C_NAME]] as const) {
    const aDir = paths.agentDir(TEST_UID, id);
    fs.mkdirSync(aDir, { recursive: true });
    fs.writeFileSync(path.join(aDir, 'agent.json'), JSON.stringify({
      agent_id: id, name, description: `${name} agent`, workflow: 'do work',
      created_at: 't', updated_at: 't',
    }));
  }
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

async function waitForQuiescent(uid: string, cid: string, timeoutMs = 4000) {
  const bus = await import('../../../../src/main/features/group_chat/bus');
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (bus.isQuiescent(uid, cid)) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`bus did not quiesce within ${timeoutMs}ms`);
}

async function readJsonl(uid: string, cid: string): Promise<any[]> {
  const paths = await import('../../../../src/main/paths');
  const file = path.join(paths.userChatsDir(uid), `${cid}.jsonl`);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

async function waitForPlan(
  uid: string,
  cid: string,
  predicate: (snapshot: any) => boolean,
  timeoutMs = 5000,
): Promise<any> {
  const plan = await import('../../../../src/main/features/group_chat/plan');
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const snapshot = await plan.readPlan(uid, cid);
    if (snapshot && predicate(snapshot)) return snapshot;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`plan did not reach expected state within ${timeoutMs}ms`);
}

// ── Helpers to assemble a plan_set tool-call inside a commander turn ─────
//
// The LLM mock yields `{type:'tool_use', name, input}` events to invoke a
// tool, the runner executes it, then we yield `{type:'final', text}`. To
// keep tests focused on plan_executor (not the tool-call plumbing), we
// instead drive plan setup directly via `setPlan` + `onPlanSet` — bypasses
// the LLM round-trip but exercises the same downstream code path.

async function setupPlanAndKick(
  uid: string, cid: string, planInput: any,
): Promise<void> {
  // Importing bus first triggers its module-load side-effect that binds
  // executor hooks. Without this, plan_executor's `_hooks` stays null and
  // every reconcile early-exits silently.
  await import('../../../../src/main/features/group_chat/bus');
  const plan = await import('../../../../src/main/features/group_chat/plan');
  const planExecutor = await import('../../../../src/main/features/group_chat/plan_executor');
  await plan.setPlan(uid, cid, planInput);
  // Bus's enqueue path normally seeds reserved actors; do it explicitly here.
  const state = await import('../../../../src/main/features/group_chat/state');
  await state.seedReservedActors(uid, cid);
  await planExecutor.onPlanSet(uid, cid);
}

// ─────────────────────────────────────────────────────────────────────────
//  Test 1 — sequential pipeline with variable substitution
// ─────────────────────────────────────────────────────────────────────────

describe('plan_executor › sequential pipeline + variable substitution', () => {
  it('A → B → C with templates referencing {{user_initial_message}} and {{step_N.output_summary}}', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');

    // Each agent yields a final text we'll later assert appears in downstream
    // step input (verifies template substitution worked).
    _setScript(state.buildGmemberSessionId(cid, A_ID), [
      { type: 'final', text: '需求摘要: 做一个 markdown 笔记软件' },
    ]);
    _setScript(state.buildGmemberSessionId(cid, B_ID), [
      { type: 'final', text: '设计要点: 使用 Electron + Markdown-it' },
    ]);
    _setScript(state.buildGmemberSessionId(cid, C_ID), [
      { type: 'final', text: '代码已落地: 主框架 + 编辑器组件' },
    ]);

    await setupPlanAndKick(TEST_UID, cid, {
      initial_message: '我想做一个 markdown 笔记软件',
      steps: [
        {
          title: '需求', assignee: A_NAME,
          input: '请整理需求：{{user_initial_message}}',
          wait_for: [],
        },
        {
          title: '设计', assignee: B_NAME,
          input: '基于需求做设计。需求摘要：{{step_1.output_summary}}',
        },
        {
          title: '实现', assignee: C_NAME,
          input: '基于设计实现。设计摘要：{{step_2.output_summary}}',
        },
      ],
    });

    await waitForQuiescent(TEST_UID, cid, 5000);

    const lines = await readJsonl(TEST_UID, cid);
    // Expected message thread: 3 dispatches (commander → A/B/C) + 3 replies.
    const dispatchToA = lines.find((l) => l.from === 'commander' && l.to.includes(A_ID));
    const dispatchToB = lines.find((l) => l.from === 'commander' && l.to.includes(B_ID));
    const dispatchToC = lines.find((l) => l.from === 'commander' && l.to.includes(C_ID));

    expect(dispatchToA).toBeTruthy();
    expect(dispatchToA.text).toContain('我想做一个 markdown 笔记软件'); // {{user_initial_message}}

    expect(dispatchToB).toBeTruthy();
    expect(dispatchToB.text).toContain('需求摘要: 做一个 markdown 笔记软件'); // {{step_1.output_summary}}

    expect(dispatchToC).toBeTruthy();
    expect(dispatchToC.text).toContain('设计要点: 使用 Electron'); // {{step_2.output_summary}}

    // Plan all done.
    const plan = await import('../../../../src/main/features/group_chat/plan');
    const finalPlan = await plan.readPlan(TEST_UID, cid);
    expect(finalPlan?.steps.map((s) => s.status)).toEqual(['done', 'done', 'done']);
  }, 15_000);
});

describe('plan_executor › plan-triggered agent live events', () => {
  it('emits agent process/delta events before the plan-step final message', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');

    _setScript(state.buildGmemberSessionId(cid, A_ID), [
      { type: 'progress', text: 'searching sources' },
      {
        type: 'event',
        event: {
          stream: 'tool',
          data: { phase: 'start', id: 'tool-1', name: 'web_search', arguments: { query: 'education' } },
        },
      },
      { type: 'delta', text: 'partial answer' },
      { type: 'final', text: 'final answer' },
    ]);

    const events: any[] = [];
    const unsubscribe = bus.subscribe(TEST_UID, cid, (ev) => events.push(ev));
    try {
      await setupPlanAndKick(TEST_UID, cid, {
        initial_message: 'research education',
        steps: [
          { title: 'research', assignee: A_NAME, input: 'go', wait_for: [] },
        ],
      });
      await waitForQuiescent(TEST_UID, cid, 5000);
    } finally {
      unsubscribe();
    }

    const agentProcessIdx = events.findIndex((e) => e.type === 'process' && e.actor === A_ID);
    const agentMessageIdx = events.findIndex((e) => e.type === 'message' && e.turn_end === true && e.msg?.from === A_ID);
    expect(agentProcessIdx).toBeGreaterThanOrEqual(0);
    expect(agentMessageIdx).toBeGreaterThan(agentProcessIdx);

    const agentProcessEvents = events.filter((e) => e.type === 'process' && e.actor === A_ID);
    expect(agentProcessEvents.some((e) => e.data?.type === 'progress' && e.data.text === 'searching sources')).toBe(true);
    expect(agentProcessEvents.some((e) => e.data?.type === 'event' && e.data.event?.stream === 'tool')).toBe(true);
    expect(agentProcessEvents.some((e) => e.data?.type === 'delta' && e.data.text === 'partial answer')).toBe(true);
  }, 15_000);
});

// ─────────────────────────────────────────────────────────────────────────
//  Test 2 — parallel fork + synthesis
// ─────────────────────────────────────────────────────────────────────────

describe('plan_executor › parallel fork + synthesis', () => {
  it('three agents in same parallel_group all dispatch at once; commander synth runs once they finish', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');

    _setScript(state.buildGmemberSessionId(cid, A_ID), [
      { type: 'final', text: 'Alpha 视角: 看好' },
    ]);
    _setScript(state.buildGmemberSessionId(cid, B_ID), [
      { type: 'final', text: 'Beta 视角: 风险大' },
    ]);
    _setScript(state.buildGmemberSessionId(cid, C_ID), [
      { type: 'final', text: 'Gamma 视角: 折衷' },
    ]);
    // Commander synthesis turn.
    _setScript(state.buildGconvSessionId(cid), [
      { type: 'final', text: '综合三方观点：可行但需谨慎。' },
    ]);

    await setupPlanAndKick(TEST_UID, cid, {
      initial_message: '要不要辞职？',
      steps: [
        {
          title: '乐观', assignee: A_NAME,
          input: '从乐观角度评估：{{user_initial_message}}',
          wait_for: [], parallel_group: 'analyze',
        },
        {
          title: '悲观', assignee: B_NAME,
          input: '从悲观角度评估：{{user_initial_message}}',
          wait_for: [], parallel_group: 'analyze',
        },
        {
          title: '全面', assignee: C_NAME,
          input: '全面评估：{{user_initial_message}}',
          wait_for: [], parallel_group: 'analyze',
        },
        {
          title: '综合', assignee: 'commander',
          input: '请综合三方观点：A={{step_1.output_summary}} / B={{step_2.output_summary}} / C={{step_3.output_summary}}',
          wait_for: [1, 2, 3],
        },
      ],
    });

    await waitForQuiescent(TEST_UID, cid, 5000);

    const lines = await readJsonl(TEST_UID, cid);

    // Three parallel dispatches commander → A/B/C should all be present.
    expect(lines.filter((l) => l.from === 'commander' && l.to.length === 1
      && [A_ID, B_ID, C_ID].includes(l.to[0]))).toHaveLength(3);

    // Three agent replies.
    expect(lines.filter((l) => [A_ID, B_ID, C_ID].includes(l.from))).toHaveLength(3);

    // Commander synthesis was triggered (its final text was '综合三方观点：可行但需谨慎。').
    const synth = lines.find((l) => l.from === 'commander' && l.text.includes('综合三方观点'));
    expect(synth).toBeTruthy();

    const plan = await import('../../../../src/main/features/group_chat/plan');
    const finalPlan = await plan.readPlan(TEST_UID, cid);
    expect(finalPlan?.steps.map((s) => s.status)).toEqual(['done', 'done', 'done', 'done']);
  }, 15_000);
});

// ─────────────────────────────────────────────────────────────────────────
//  Test 3 — failure policies
// ─────────────────────────────────────────────────────────────────────────

describe('plan_executor › failure policies', () => {
  it('on_failure=continue: failed step skipped, downstream still runs', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');

    // A returns an error (we route this through the bus's stream-error path).
    _setScript(state.buildGmemberSessionId(cid, A_ID), [
      { type: 'error', text: 'A failed for testing', aborted: false },
    ]);
    _setScript(state.buildGmemberSessionId(cid, B_ID), [
      { type: 'final', text: 'B succeeded despite A failing' },
    ]);

    await setupPlanAndKick(TEST_UID, cid, {
      initial_message: 'q',
      steps: [
        { title: 'a', assignee: A_NAME, input: 'work', wait_for: [], on_failure: 'continue' },
        { title: 'b', assignee: B_NAME, input: 'work', wait_for: [1] },
      ],
    });

    await waitForQuiescent(TEST_UID, cid, 5000);

    const plan = await import('../../../../src/main/features/group_chat/plan');
    const finalPlan = await plan.readPlan(TEST_UID, cid);
    expect(finalPlan?.steps[0].status).toBe('skipped'); // continue policy → skipped not failed
    expect(finalPlan?.steps[1].status).toBe('done');     // B still ran (skipped counts as terminal for wait_for)
  }, 15_000);

  it('on_failure=abort_plan: failed step blocks all downstream pending steps', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');

    _setScript(state.buildGmemberSessionId(cid, A_ID), [
      { type: 'error', text: 'A failed', aborted: false },
    ]);
    // B's script — should never get consumed since plan aborts.
    _setScript(state.buildGmemberSessionId(cid, B_ID), [
      { type: 'final', text: 'B should not run' },
    ]);

    await setupPlanAndKick(TEST_UID, cid, {
      initial_message: 'q',
      steps: [
        { title: 'a', assignee: A_NAME, input: 'work', wait_for: [], on_failure: 'abort_plan' },
        { title: 'b', assignee: B_NAME, input: 'work', wait_for: [1] },
      ],
    });

    await waitForQuiescent(TEST_UID, cid, 5000);

    const plan = await import('../../../../src/main/features/group_chat/plan');
    const finalPlan = await plan.readPlan(TEST_UID, cid);
    expect(finalPlan?.steps[0].status).toBe('failed');
    expect(finalPlan?.steps[1].status).toBe('skipped'); // abort swept it

    const lines = await readJsonl(TEST_UID, cid);
    // No dispatch to B should have been persisted.
    expect(lines.find((l) => l.from === 'commander' && l.to.includes(B_ID))).toBeUndefined();
  }, 15_000);
});

// ─────────────────────────────────────────────────────────────────────────
//  Test 4 — assignee=user blocks until user replies
// ─────────────────────────────────────────────────────────────────────────

describe('plan_executor › user-assignee step', () => {
  it('user step dispatches a form to user, plan waits, then continues on form submit without waking commander', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const groupChat = await import('../../../../src/main/features/group_chat');

    _setScript(state.buildGmemberSessionId(cid, A_ID), [
      { type: 'final', text: '收到 user 的补充：' },
    ]);

    await setupPlanAndKick(TEST_UID, cid, {
      initial_message: '帮我写代码',
      steps: [
        {
          title: '问 user 用什么语言', assignee: 'user',
          input: '请告诉我目标语言：Python / TypeScript / Rust？',
          wait_for: [],
        },
        {
          title: '让 A 实现', assignee: A_NAME,
          input: '用户选择: {{step_1.output_summary}}。请实现。',
          wait_for: [1],
        },
      ],
    });

    // After kick: step 1 should have dispatched a question commander → user;
    // step 2 still pending. Plan reaches a stable point (waiting for user).
    await waitForQuiescent(TEST_UID, cid, 3000);

    const plan = await import('../../../../src/main/features/group_chat/plan');
    let snapshot = await plan.readPlan(TEST_UID, cid);
    expect(snapshot?.steps[0].status).toBe('in_progress'); // question dispatched, waiting
    expect(snapshot?.steps[1].status).toBe('pending');

    let lines = await readJsonl(TEST_UID, cid);
    const question = lines.find((l) => l.from === 'commander' && l.to.includes('user'));
    expect(question).toBeTruthy();
    expect(question.text).toContain('Python');
    expect(question.form).toMatchObject({
      agent_id: 'user',
      plan_step_index: 1,
      submitted: false,
      fields: [
        expect.objectContaining({
          id: 'response',
          label: '问 user 用什么语言',
          type: 'textarea',
          required: true,
        }),
      ],
    });
    // Dispatch must stamp `pending_form_id` on the step itself so that
    // `acceptsUserStepCompletion` can match the user reply in O(1) instead
    // of re-scanning the conversation jsonl. If this regresses, the gate
    // silently falls back to "accept any user reply" (legacy mode).
    expect(snapshot?.steps[0].pending_form_id).toBe(question.form.form_id);

    // A regular chat message is allowed to start a commander discussion,
    // but it must not be mistaken for the pending user-form answer.
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: '我不清楚啊，要讨论下' });
    await waitForQuiescent(TEST_UID, cid, 5000);

    snapshot = await plan.readPlan(TEST_UID, cid);
    expect(snapshot?.steps[0].status).toBe('in_progress');
    expect(snapshot?.steps[1].status).toBe('pending');

    lines = await readJsonl(TEST_UID, cid);
    expect(lines.find((l) => l.from === 'commander' && l.to.includes(A_ID))).toBeUndefined();
    const stillWaitingQuestion = lines.find((l) => l.id === question.id);
    expect(stillWaitingQuestion?.form.submitted).toBe(false);

    // User answers through the rendered form. The facade returns a replay
    // payload addressed to @user; after the bus strips that mention, the
    // message stays user-visible but does not wake commander as a side turn.
    const submit = await groupChat.markFormSubmittedAndDispatch({
      userId: TEST_UID,
      cid,
      msgId: question.id,
      formId: question.form.form_id,
      values: { response: 'TypeScript' },
    });
    expect(submit.ok).toBe(true);
    expect(submit.submission?.agent_id).toBe('user');
    expect(submit.submission?.text).toContain('@user');
    expect(submit.submission?.text).toContain('agent-input-submission');

    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: submit.submission!.text });
    snapshot = await waitForPlan(
      TEST_UID,
      cid,
      (p) => p.steps[0].status === 'done' && p.steps[1].status === 'done',
      5000,
    );
    await waitForQuiescent(TEST_UID, cid, 5000);

    expect(snapshot?.steps[0].status).toBe('done');     // user replied → step 1 closed
    expect(snapshot?.steps[1].status).toBe('done');     // A then ran with substituted user answer

    lines = await readJsonl(TEST_UID, cid);
    const updatedQuestion = lines.find((l) => l.id === question.id);
    expect(updatedQuestion?.form.submitted).toBe(true);
    expect(updatedQuestion?.form.values).toEqual({ response: 'TypeScript' });

    const userReplay = lines.find((l) => l.from === 'user' && l.text.includes('agent-input-submission'));
    expect(userReplay).toBeTruthy();
    expect(userReplay.to).toEqual(['user']);
    expect(userReplay.text).not.toContain('@user');

    const dispatchToA = lines.find((l) => l.from === 'commander' && l.to.includes(A_ID));
    expect(dispatchToA).toBeTruthy();
    expect(dispatchToA.text).toContain('TypeScript'); // {{step_1.output_summary}} got user's reply
  }, 15_000);
});

// ─────────────────────────────────────────────────────────────────────────
//  Test 5 — agent emits form → step blocked, downstream stays pending
// ─────────────────────────────────────────────────────────────────────────

describe('plan_executor › agent form pauses the step (not "done")', () => {
  it('agent reply with form → step blocked, next step stays pending; on user form submit + agent real reply, step done + downstream advances', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');

    // First A turn: emit a form (no real work yet).
    _setScript(state.buildGmemberSessionId(cid, A_ID), [
      {
        type: 'final',
        text: '需要你确认几个字段：\n\n```agent-input-form\n{"fields":[{"id":"goal","label":"目标","type":"text"}]}\n```',
      },
    ]);

    await setupPlanAndKick(TEST_UID, cid, {
      initial_message: '我想做个东西',
      steps: [
        { title: 'a', assignee: A_NAME, input: '请挖需求：{{user_initial_message}}', wait_for: [] },
        { title: 'b', assignee: B_NAME, input: '基于：{{step_1.output_summary}}', wait_for: [1] },
      ],
    });

    await waitForQuiescent(TEST_UID, cid, 4000);

    // After A's form, plan should pause: step 1 = blocked, step 2 = pending.
    const plan = await import('../../../../src/main/features/group_chat/plan');
    let snapshot = await plan.readPlan(TEST_UID, cid);
    expect(snapshot?.steps[0].status).toBe('blocked');
    expect(snapshot?.steps[1].status).toBe('pending');

    const lines = await readJsonl(TEST_UID, cid);
    // No dispatch to B yet (form pause prevents downstream).
    expect(lines.find((l) => l.from === 'commander' && l.to.includes(B_ID))).toBeUndefined();

    // Now A's NEXT turn (after user submits form): real work, no form.
    _setScript(state.buildGmemberSessionId(cid, A_ID), [
      { type: 'final', text: '需求已整理：目标是 X' },
    ]);
    _setScript(state.buildGmemberSessionId(cid, B_ID), [
      { type: 'final', text: 'B 完成' },
    ]);

    // Simulate user form submit by enqueuing a follow-up message to A.
    // (In the real app this goes through markFormSubmittedAndDispatch,
    // but for the test we emulate the resulting bus.enqueue directly.)
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: '@Alpha 目标是 X' });
    await waitForQuiescent(TEST_UID, cid, 5000);

    snapshot = await plan.readPlan(TEST_UID, cid);
    expect(snapshot?.steps[0].status).toBe('done');     // unblocked + done
    expect(snapshot?.steps[1].status).toBe('done');     // B ran
    expect(snapshot?.steps[0].output_summary).toContain('需求已整理');
  }, 15_000);
});

// ─────────────────────────────────────────────────────────────────────────
//  Test 6 — bus auto-marks step done without LLM plan_update
// ─────────────────────────────────────────────────────────────────────────

describe('plan_executor › auto plan_update', () => {
  it('agent reply auto-flips its step from in_progress → done; LLM never called plan_update', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');

    _setScript(state.buildGmemberSessionId(cid, A_ID), [
      { type: 'final', text: 'A done' },
    ]);

    await setupPlanAndKick(TEST_UID, cid, {
      initial_message: 'q',
      steps: [{ title: 'a', assignee: A_NAME, input: 'do', wait_for: [] }],
    });

    await waitForQuiescent(TEST_UID, cid, 4000);

    const plan = await import('../../../../src/main/features/group_chat/plan');
    const finalPlan = await plan.readPlan(TEST_UID, cid);
    expect(finalPlan?.steps[0].status).toBe('done');
    expect(finalPlan?.steps[0].output_summary).toBe('A done');
    expect(finalPlan?.completed_signaled).toBe(true); // single-step plan terminal → signal fired
  }, 10_000);

  it('manual commander dispatch still completes the matching in_progress step', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const plan = await import('../../../../src/main/features/group_chat/plan');

    _setScript(state.buildGmemberSessionId(cid, A_ID), [
      { type: 'final', text: 'manual dispatch result' },
    ]);

    await plan.setPlan(TEST_UID, cid, {
      initial_message: 'q',
      steps: [{ title: 'a', assignee: A_NAME, input: 'do', wait_for: [] }],
    });
    await state.seedReservedActors(TEST_UID, cid);
    await state.ensureAgentMember(TEST_UID, cid, A_ID, A_NAME);
    await plan.updateStep(TEST_UID, cid, 1, 'in_progress');

    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'commander',
      text: `@${A_NAME} 请继续执行第 1 步`,
      forceTo: [A_ID],
      dispatch: true,
    });
    await waitForQuiescent(TEST_UID, cid, 4000);

    const finalPlan = await plan.readPlan(TEST_UID, cid);
    expect(finalPlan?.steps[0].status).toBe('done');
    expect(finalPlan?.steps[0].output_summary).toBe('manual dispatch result');
  }, 10_000);
});

// ─────────────────────────────────────────────────────────────────────────
//  Test 6 — plan inherits user-turn attachments and forwards to workers
//
//  Regression guard for "commander sees the image, worker doesn't" — workers
//  read images via ChatOptions.images, which is populated from
//  item.attachments → buildAttachmentManifest. plan-step dispatches live
//  across turn boundaries, so the source must be persisted on the plan.
//
//  Two fixtures pinned:
//    A) initial_attachments set on plan → both forwarded dispatches carry
//       the same attachments list (so worker's turnImages populates).
//    B) initial_attachments unset → no attachments leak onto dispatches
//       (verifies the optional path doesn't accidentally add an empty key).
// ─────────────────────────────────────────────────────────────────────────

describe('plan_executor › attachment inheritance', () => {
  it('plan.initial_attachments propagates onto every step dispatch', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');

    _setScript(state.buildGmemberSessionId(cid, A_ID), [{ type: 'final', text: 'A done' }]);
    _setScript(state.buildGmemberSessionId(cid, B_ID), [{ type: 'final', text: 'B done' }]);

    await setupPlanAndKick(TEST_UID, cid, {
      initial_message: '解这道题',
      initial_attachments: ['problem.png', 'extra.jpg'],
      steps: [
        { title: '识图', assignee: A_NAME, input: '看附件中的题', wait_for: [] },
        { title: '求解', assignee: B_NAME, input: '解题: {{step_1.output_summary}}', wait_for: [1] },
      ],
    });

    await waitForQuiescent(TEST_UID, cid, 5000);

    const lines = await readJsonl(TEST_UID, cid);
    const toA = lines.find((l) => l.from === 'commander' && l.to.includes(A_ID));
    const toB = lines.find((l) => l.from === 'commander' && l.to.includes(B_ID));

    expect(toA?.attachments).toEqual(['problem.png', 'extra.jpg']);
    expect(toB?.attachments).toEqual(['problem.png', 'extra.jpg']);

    // Plan still records the source so retries / replan inherit.
    const plan = await import('../../../../src/main/features/group_chat/plan');
    const persisted = await plan.readPlan(TEST_UID, cid);
    expect(persisted?.initial_attachments).toEqual(['problem.png', 'extra.jpg']);
  }, 15_000);

  it('no initial_attachments → dispatch messages omit the attachments key', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');

    _setScript(state.buildGmemberSessionId(cid, A_ID), [{ type: 'final', text: 'A done' }]);

    await setupPlanAndKick(TEST_UID, cid, {
      initial_message: 'no image case',
      steps: [{ title: '只是文字', assignee: A_NAME, input: '回答', wait_for: [] }],
    });

    await waitForQuiescent(TEST_UID, cid, 5000);

    const lines = await readJsonl(TEST_UID, cid);
    const toA = lines.find((l) => l.from === 'commander' && l.to.includes(A_ID));
    // Persisted GroupMessage shape: `attachments` is only present when non-empty
    // (see _enqueueBody at bus.ts:612). Asserting omission catches a regression
    // where we'd accidentally pass `attachments: []` and pollute the file.
    expect(toA).toBeTruthy();
    expect('attachments' in toA).toBe(false);

    const plan = await import('../../../../src/main/features/group_chat/plan');
    const persisted = await plan.readPlan(TEST_UID, cid);
    expect(persisted?.initial_attachments).toBeUndefined();
  }, 15_000);
});
