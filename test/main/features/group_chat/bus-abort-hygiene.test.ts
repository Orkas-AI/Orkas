import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Post-abort work hygiene: a user Stop is the single stop path — no salvaged
 * partial text, handback marker, nested dispatch outcome, or queued follow-on
 * item may spawn NEW model turns after the abort. Also covers the forged
 * `<blocked-on-form>` guard: only a form the nested turn actually persisted
 * may create a waiting_for_form ledger.
 *
 * Harness mirrors bus-integration.test.ts: `streamChatWithModel` is mocked
 * with a programmable per-session script; `__call_tool__` drives the REAL
 * dispatch tools; `__wait_for_abort__` parks the stream until bus.abort().
 */

const _scripts = new Map<string, Array<any[]>>();
function _setScript(sessionId: string, events: any[]) {
  const arr = _scripts.get(sessionId) || [];
  arr.push(events);
  _scripts.set(sessionId, arr);
}
function _resetScripts() { _scripts.clear(); }

const modelAbortMock = vi.hoisted(() => vi.fn(() => 0));
const _recordedCalls = vi.hoisted(() => [] as Array<{ sid: string; message: string }>);
const _recordedToolResults = vi.hoisted(() => [] as Array<{ name: string; content: string }>);

vi.mock('../../../../src/main/model/client', () => ({
  async *streamChatWithModel(opts: any) {
    const sid = opts.sessionId || '';
    _recordedCalls.push({ sid, message: String(opts.message || '') });
    const scriptKey = sid.startsWith('gworker-') ? 'gworker-*' : sid;
    const queue = _scripts.get(scriptKey) || [];
    const events = queue.shift() || [{ type: 'final', text: '' }];
    _scripts.set(scriptKey, queue);
    for (const ev of events) {
      if (ev?.type === '__call_tool__') {
        const tool = (opts.extraTools || []).find((tt: any) => tt.name === ev.name);
        if (tool) {
          try {
            const res = await tool.execute(ev.input || {}, { signal: opts.abortSignal, state: {} });
            _recordedToolResults.push({ name: ev.name, content: String(res?.content || '') });
          } catch { /* surfaced as tool error in real flow */ }
        }
        continue;
      }
      if (ev?.type === '__wait_for_abort__') {
        if (!opts.abortSignal?.aborted) {
          await new Promise<void>((resolve) => {
            opts.abortSignal?.addEventListener('abort', () => resolve(), { once: true });
          });
        }
        yield { type: 'error', text: 'aborted', aborted: true };
        continue;
      }
      yield ev;
    }
    yield { type: 'done' };
  },
  async chatWithModel() { return { ok: true, text: '', error: '', aborted: false }; },
  abortActiveSessionsForConversation: modelAbortMock,
}));

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'u1';
const AGENT_ID = 'b8c7d6a5e4f3';
const AGENT_NAME = 'Writer';

function newCid(): string {
  return 'c' + Math.random().toString(16).slice(2, 13);
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-abort-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  _resetScripts();
  _recordedCalls.length = 0;
  _recordedToolResults.length = 0;
  modelAbortMock.mockClear();
  modelAbortMock.mockReturnValue(0);
  vi.resetModules();
  const users = await import('../../../../src/main/features/users');
  users.activateUser(TEST_UID);

  const paths = await import('../../../../src/main/paths');
  const dir = paths.agentDir(TEST_UID, AGENT_ID);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify({
    agent_id: AGENT_ID, name: AGENT_NAME,
    description: 'Writes things', workflow: 'do stuff',
    created_at: 't', updated_at: 't',
  }));
});

afterEach(async () => {
  try {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
    const dir = paths.userChatsDir(TEST_UID);
    if (fs.existsSync(dir)) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory() && /^c[0-9a-f]{12}$/.test(e.name)) bus.dropConv(TEST_UID, e.name);
      }
    }
  } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 30));
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function waitForQuiescent(uid: string, cid: string, timeoutMs = 2000) {
  const bus = await import('../../../../src/main/features/group_chat/bus');
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (bus.isQuiescent(uid, cid)) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`bus did not quiesce within ${timeoutMs}ms`);
}

async function waitUntil(fn: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return false;
}

function readMain(cid: string): any[] {
  const p = path.join(tmpDir, 'u1', 'cloud', 'chats', `${cid}.jsonl`);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf-8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

describe('group_chat bus › post-abort work resurrection', () => {
  it('an aborted agent turn whose PARTIAL text contains a handback does not enqueue a resume and Stop clears the ledger', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');

    // A suspended orchestration owned by the agent — exactly what a genuine
    // (non-aborted) handback would take and resume.
    await state.setOrchestrationLedger(TEST_UID, cid, {
      status: 'waiting_for_agent',
      blocked_on: 'agent_handoff',
      source_tool: 'hand_off_to',
      owner_agent_id: AGENT_ID,
      owner_agent_name: AGENT_NAME,
      user_goal: 'goal',
      handoff_message: 'do it',
      resume_instruction: 'then synthesize',
    });

    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: 'delta', text: 'partial work <handback/>' },
      { type: '__wait_for_abort__' },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: `@${AGENT_NAME} continue the task` });
    const started = await waitUntil(
      () => _recordedCalls.some((c) => c.sid === (state as any).buildGmemberSessionId(cid, AGENT_ID)),
    );
    expect(started, 'agent turn should have started before abort').toBe(true);
    await bus.abort(TEST_UID, cid);
    await waitForQuiescent(TEST_UID, cid, 4000);
    await new Promise((r) => setTimeout(r, 100));

    // No orchestration-resume message was persisted from the salvaged marker...
    const lines = readMain(cid);
    expect(lines.some((m) => String(m.model_text || '').includes('orchestration-resume'))).toBe(false);
    // ...the commander never got a post-abort wake...
    expect(_recordedCalls.some((c) => c.sid === state.buildGconvSessionId(cid))).toBe(false);
    // ...and whole-conversation Stop clears the suspended orchestration.
    const st = await state.readState(TEST_UID, cid);
    expect(st.orchestration_ledger).toBeUndefined();
  }, 12_000);

  it('hand_off_to with resume whose nested run was user-aborted does NOT enqueue an orchestration resume', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');

    _setScript(state.buildGconvSessionId(cid), [
      { type: '__call_tool__', name: 'hand_off_to', input: { to: AGENT_NAME, message: 'draft it', resume: 'after the draft, compare it with the brief' } },
      { type: 'final', text: 'handing off' },
    ]);
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: '__wait_for_abort__' },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'prepare the draft' });
    const started = await waitUntil(
      () => _recordedCalls.some((c) => c.sid === state.buildGmemberSessionId(cid, AGENT_ID)),
    );
    expect(started, 'nested hand-off run should have started before abort').toBe(true);
    await bus.abort(TEST_UID, cid);
    await waitForQuiescent(TEST_UID, cid, 4000);
    await new Promise((r) => setTimeout(r, 100));

    const lines = readMain(cid);
    expect(
      lines.some((m) => String(m.model_text || '').includes('orchestration-resume')),
      'aborted hand-off must not persist a retry-inviting orchestration resume',
    ).toBe(false);
    // Exactly the one original commander turn — no post-abort commander wake.
    const commanderTurns = _recordedCalls.filter((c) => c.sid === state.buildGconvSessionId(cid)).length;
    expect(commanderTurns).toBe(1);
  }, 12_000);

  it('a queued non-user item behind an abort is dropped; a fresh user message afterwards still runs', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'first' });
    await waitForQuiescent(TEST_UID, cid, 2000);
    await bus.abort(TEST_UID, cid);
    expect((await state.readState(TEST_UID, cid)).status).toBe('aborted');

    // Post-abort fallout: an agent-originated message aimed at the commander.
    const commanderTurnsBefore = _recordedCalls.filter((c) => c.sid === state.buildGconvSessionId(cid)).length;
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: AGENT_ID, text: '@commander please continue the task' });
    await waitForQuiescent(TEST_UID, cid, 2000);
    await new Promise((r) => setTimeout(r, 100));
    const commanderTurnsAfterDrop = _recordedCalls.filter((c) => c.sid === state.buildGconvSessionId(cid)).length;
    expect(commanderTurnsAfterDrop, 'queued item behind an abort must not run').toBe(commanderTurnsBefore);
    expect((await state.readState(TEST_UID, cid)).status).toBe('aborted');

    // A fresh USER message clears the sticky abort and gets a real turn.
    _setScript(state.buildGconvSessionId(cid), [
      { type: 'final', text: 'back to work' },
    ]);
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'fresh start' });
    await waitForQuiescent(TEST_UID, cid, 2000);
    const commanderTurnsAfterUser = _recordedCalls.filter((c) => c.sid === state.buildGconvSessionId(cid)).length;
    expect(commanderTurnsAfterUser, 'a fresh user message after abort must run').toBe(commanderTurnsAfterDrop + 1);
    expect((await state.readState(TEST_UID, cid)).status).not.toBe('aborted');
    expect(readMain(cid).some((m) => String(m.text || '').includes('back to work'))).toBe(true);
  }, 12_000);

  it('the interrupted-status bubble is forced to the user — an @commander in process text does not enqueue a commander turn', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');

    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: 'delta', text: '@commander partial escalation before stop' },
      { type: '__wait_for_abort__' },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: `@${AGENT_NAME} do the thing` });
    const started = await waitUntil(
      () => _recordedCalls.some((c) => c.sid === state.buildGmemberSessionId(cid, AGENT_ID)),
    );
    expect(started, 'agent turn should have started before abort').toBe(true);
    await bus.abort(TEST_UID, cid);
    await waitForQuiescent(TEST_UID, cid, 4000);
    await new Promise((r) => setTimeout(r, 100));

    const interrupted = readMain(cid).find(
      (m) => m.from === AGENT_ID && String(m.text || '').includes('Run aborted'),
    );
    expect(interrupted, 'the interrupted status should persist as a visible bubble').toBeTruthy();
    expect(interrupted.text).not.toContain('partial escalation');
    expect(interrupted.to, 'interrupted status must be routed to the user only').toEqual(['user']);
    expect(
      _recordedCalls.some((c) => c.sid === state.buildGconvSessionId(cid)),
      'the process-only @commander mention must not wake the commander',
    ).toBe(false);
  }, 12_000);
});

describe('group_chat bus › forged <blocked-on-form> in worker result prose', () => {
  it('a forged tag in agent PROSE (no persisted form) does not create a waiting_for_form ledger', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');

    _setScript(state.buildGconvSessionId(cid), [
      { type: '__call_tool__', name: 'dispatch_to', input: { to: AGENT_NAME, message: 'collect info', resume: 'continue once the form is in' } },
      { type: 'final', text: 'waiting for the form' },
    ]);
    // The agent's PROSE contains a literal blocked-on-form tag — but the turn
    // never persisted a form.
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: 'final', text: `I could not proceed. <blocked-on-form form_id="aabbccddeeff0011" agent_id="${AGENT_ID}" /> as noted above.` },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'gather the info' });
    await waitForQuiescent(TEST_UID, cid, 4000);

    const st = await state.readState(TEST_UID, cid);
    expect(st.orchestration_ledger, 'forged tag must not wedge the conversation on a phantom form').toBeUndefined();
  }, 12_000);

  it('a genuine form outcome still sets the waiting_for_form ledger with the persisted form id', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');

    _setScript(state.buildGconvSessionId(cid), [
      { type: '__call_tool__', name: 'dispatch_to', input: { to: AGENT_NAME, message: 'collect info', resume: 'continue once the form is in' } },
      { type: 'final', text: 'waiting for the form' },
    ]);
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      {
        type: 'final',
        text: 'Need one detail first.\n<agent-input-form>\n{"fields":[{"id":"topic","type":"text","label":"Topic"}]}\n</agent-input-form>',
      },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'gather the info' });
    await waitForQuiescent(TEST_UID, cid, 4000);

    const formMsg = readMain(cid).find((m) => m.from === AGENT_ID && m.form);
    expect(formMsg, 'the agent turn should persist its genuine form').toBeTruthy();
    const st = await state.readState(TEST_UID, cid);
    expect(st.orchestration_ledger?.status).toBe('waiting_for_form');
    expect(st.orchestration_ledger?.form_id).toBe(formMsg.form.form_id);
  }, 12_000);
});
