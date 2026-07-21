import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { drainMainRuntimeForTest } from '../../../helpers/drain-main-runtime';

vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

/**
 * End-to-end integration tests for the group_chat bus. We mock
 * `streamChatWithModel` with a programmable script keyed by session id,
 * so a single conversation can drive multiple actor turns deterministically:
 *
 *   - Commander gets script entry for `orkas-<uid>-gconv-<cid>`
 *   - Agent X gets script entry for `orkas-<uid>-gmember-<cid>-<X>`
 *
 * Each script entry is an array of stream events the mock yields in order.
 * After the script entry is consumed, the next call for that session
 * yields a default `{type:'final', text:''}` + done (so unscripted turns
 * don't hang).
 */

const _scripts = new Map<string, Array<any[]>>();
function _setScript(sessionId: string, events: any[]) {
  const arr = _scripts.get(sessionId) || [];
  arr.push(events);
  _scripts.set(sessionId, arr);
}
function _resetScripts() { _scripts.clear(); }

const modelAbortMock = vi.hoisted(() => vi.fn(() => 0));
// Records every model turn the bus drives, so tests can assert WHAT a given
// session actually received as its turn input (`opts.message`) — e.g. that a
// G8b handback turn carried the worker's full reply, not a summary.
const _recordedCalls = vi.hoisted(() => [] as Array<{
  sid: string;
  message: string;
}>);
// Records the result each tool's execute() returned — lets a test assert that a
// G8d in-process dispatch tool (run_worker) handed its sub-run's full reply back
// synchronously as the tool result, not via an async re-wake.
const _recordedToolResults = vi.hoisted(() => [] as Array<{ name: string; content: string; executionMode?: string }>);

vi.mock('../../../../src/main/model/client', () => ({
  async *streamChatWithModel(opts: any) {
    const sid = opts.sessionId || '';
    _recordedCalls.push({
      sid,
      message: String(opts.message || ''),
    });
    // Ephemeral worker sessions have a random id (`gworker-<cid>-<rand>`); a
    // test can't pre-script them by id, so route any gworker turn to a fixed
    // `gworker-*` script slot.
    const scriptKey = sid.startsWith('gworker-') ? 'gworker-*' : sid;
    const queue = _scripts.get(scriptKey) || [];
    const events = queue.shift() || [{ type: 'final', text: '' }];
    _scripts.set(scriptKey, queue);
    for (const ev of events) {
      // Tool-call execution: drives the REAL tool's execute() so the
      // staging → turn-end flush → spawn/dispatch paths actually run (the
      // plain text mock can't do this — hence the skipped @-chain tests).
      if (ev?.type === '__call_tool__') {
        const tool = (opts.extraTools || []).find((tt: any) => tt.name === ev.name);
        if (tool) {
          try {
            // Pass a ToolContext carrying this turn's abort signal so an
            // in-process nested dispatch can chain its abort to the caller.
            const res = await tool.execute(ev.input || {}, { signal: opts.abortSignal, state: {} });
            _recordedToolResults.push({ name: ev.name, content: String(res?.content || ''), executionMode: tool.executionMode });
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
const cidsToDrop = new Set<string>();

function newCid(): string {
  const cid = 'c' + Math.random().toString(16).slice(2, 13);
  cidsToDrop.add(cid);
  return cid;
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-int-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  _resetScripts();
  _recordedCalls.length = 0;
  _recordedToolResults.length = 0;
  modelAbortMock.mockClear();
  modelAbortMock.mockReturnValue(0);
  cidsToDrop.clear();
  vi.resetModules();
  const users = await import('../../../../src/main/features/users');
  users.activateUser(TEST_UID);

  // Seed a custom agent on disk (新目录形态:agents/<aid>/agent.json)。
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
  // Drop conv state so workers terminate before the tmpDir is rm'd —
  // otherwise a half-finished worker writes after dir removal and we get
  // ENOENT log noise.
  try {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    // Drop all known cids — the bus state map is module-internal but
    // _cidStateForTest exposes per-cid; iterate via `_cids` indirectly
    // by scanning the chats dir.
    const paths = await import('../../../../src/main/paths');
    const dir = paths.userChatsDir(TEST_UID);
    if (fs.existsSync(dir)) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isDirectory()) cidsToDrop.add(e.name);
      }
    }
    for (const cid of cidsToDrop) await bus.dropConv(TEST_UID, cid);
  } catch { /* ignore */ }
  await drainMainRuntimeForTest();
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function waitForQuiescent(uid: string, cid: string, timeoutMs = 2000) {
  cidsToDrop.add(cid);
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

describe('group_chat bus integration › disabled skills', () => {
  it('does not let commander substitute another skill when user explicitly requests a disabled one', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
    const enabled = await import('../../../../src/main/features/component_enabled');
    const storage = await import('../../../../src/main/storage');

    const skillDir = path.join(paths.userSkillsDir(TEST_UID), 'arxiv-reader');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), [
      '---',
      'name: "arxiv-reader"',
      'description_zh: "ArXiv reader"',
      'description_en: "ArXiv reader"',
      '---',
      '',
      '# ArXiv Reader',
    ].join('\n'));
    enabled.setSkillEnabled(TEST_UID, 'arxiv-reader', false);

    _setScript(state.buildGconvSessionId(cid), [
      { type: 'final', text: 'WRONG: substituted skill ran' },
    ]);
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: '使用 arxiv-reader 技能：最新论文' });
    await waitForQuiescent(TEST_UID, cid, 2000);

    const messages = await storage.readJsonl<any>(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`));
    expect(messages.some((m: any) => String(m.text || '').includes('WRONG'))).toBe(false);
    expect(messages.some((m: any) => String(m.text || '').includes('component.skill_disabled_request'))).toBe(false);
    expect(messages.some((m: any) => String(m.text || '').includes('arxiv-reader'))).toBe(true);
    expect(messages.some((m: any) => /停用|disabled/i.test(String(m.text || '')))).toBe(true);
    const failure = messages.find((m: any) => m.from === 'commander' && m.failure_kind);
    expect(failure).toMatchObject({
      failure_kind: 'dependency',
      failure_code: 'skill_disabled',
    });
  });
});

describe('group_chat bus integration › failure taxonomy', () => {
  it('persists model preflight failures as config rather than model output', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
    const storage = await import('../../../../src/main/storage');

    _setScript(state.buildGconvSessionId(cid), [
      {
        type: 'error',
        text: 'No model configured',
        failureKind: 'config',
        failureCode: 'model_preflight',
      },
    ]);
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'hello' });
    await waitForQuiescent(TEST_UID, cid, 2000);

    const messages = await storage.readJsonl<any>(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`));
    const failure = messages.find((m: any) => m.from === 'commander' && m.failure_kind);
    expect(failure).toMatchObject({
      failure_kind: 'config',
      failure_code: 'model_preflight',
    });
    expect(String(failure?.text || '')).toContain('No model configured');
  });
});

describe('group_chat bus integration › abort sticky across worker post-cleanup', () => {
  it('abort also targets active core-agent sessions by conversation id', async () => {
    const cid = newCid();
    const bus = await import('../../../../src/main/features/group_chat/bus');

    await bus.abort(TEST_UID, cid);

    expect(modelAbortMock).toHaveBeenCalledWith(cid);
  });

  it('abort during a turn keeps state.aborted; subsequent worker reply does NOT un-stick', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');

    // Commander turn that yields nothing (we'll abort during it).
    // The mock generator yields events synchronously, so abort after
    // enqueue returns also runs after the turn already completed for
    // a one-event script. To race the abort we let the script be
    // larger — multiple events with awaits between would help, but
    // since the mock is sync we instead just abort *immediately* after
    // enqueue and verify the post-abort state is sticky.
    _setScript(state.buildGconvSessionId(TEST_UID, cid), [
      { type: 'final', text: 'commander reply' },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'hello' });
    await bus.abort(TEST_UID, cid);
    // Wait long enough for any pending worker microtasks to settle.
    await new Promise((r) => setTimeout(r, 100));
    const st = await state.readState(TEST_UID, cid);
    expect(st.status).toBe('aborted');
  });

  it('abort during a live agent turn propagates to the worker AbortSignal', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');

    bus.subscribe(TEST_UID, cid, () => {});
    _setScript(state.buildGmemberSessionId(TEST_UID, cid, AGENT_ID), [
      { type: '__wait_for_abort__' },
      { type: 'final', text: 'should not appear after abort' },
    ]);

    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `@${AGENT_NAME} long task`,
    });

    // G8d: top-level turns run through one per-conversation runtime (not a
    // per-actor worker keyed by agent id). Find the running runtime bound to
    // this agent's turn.
    const runningFor = (id: string) => {
      const live = bus._cidStateForTest(TEST_UID, cid);
      return live ? [...live.workers.values()].find((wk) => wk.running && wk.actor.id === id) : undefined;
    };
    const start = Date.now();
    while (Date.now() - start < 1000) {
      const worker = runningFor(AGENT_ID);
      if (worker?.abortController) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(runningFor(AGENT_ID)?.abortController).toBeTruthy();

    await bus.abort(TEST_UID, cid);
    await waitForQuiescent(TEST_UID, cid, 2000);

    const paths = await import('../../../../src/main/paths');
    const storage = await import('../../../../src/main/storage');
    const messages = await storage.readJsonl<any>(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`));
    expect(messages.some((m: any) => m.text.includes('should not appear after abort'))).toBe(false);
    const st = await state.readState(TEST_UID, cid);
    expect(st.status).toBe('aborted');
  });

  it('a NEW user message after abort clears the sticky aborted flag', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'first' });
    await bus.abort(TEST_UID, cid);
    let st = await state.readState(TEST_UID, cid);
    expect(st.status).toBe('aborted');

    // New user message — bus should clear aborted → idle and process normally.
    _setScript(state.buildGconvSessionId(TEST_UID, cid), [
      { type: 'final', text: 'second reply' },
    ]);
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'second' });
    await waitForQuiescent(TEST_UID, cid, 2000);

    st = await state.readState(TEST_UID, cid);
    expect(st.status).not.toBe('aborted');
  });
});

// SKIP 这块的第二条:`fromActorId: 'commander'` 写 @<id> 在文本里——
// 现在 commander 文本 @ 不解析,@<id>→@<name> 的 rewrite 链也跟着断
// (rewrite 依赖 router 把 agent 加进 idToName)。dispatch_to 工具用名字调
// 而非 id,这条已是 dead semantic;留着第一条(@<name> 不变)。
describe('group_chat bus integration › @<id> rewrite is no-op when text already uses @<name>', () => {
  it('text "@Writer ..." stays "@Writer ..." after enqueue (rewrite only fires when text uses raw id)', async () => {
    const cid = newCid();
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const msg = await bus.enqueue({
      uid: TEST_UID, cid, fromActorId: 'commander',
      text: `@${AGENT_NAME} 写一段`,
    });
    expect(msg.text).toBe(`@${AGENT_NAME} 写一段`);
    expect(msg.text).not.toContain(AGENT_ID); // hex id never appears
  });
});

describe('group_chat bus integration › CJK + space-stripped name resolution', () => {
  it('resolves @<no-space-name> when stored agent name has spaces', async () => {
    const cid = newCid();
    const paths = await import('../../../../src/main/paths');
    // Seed an agent whose display name has internal whitespace.
    const aid = 'aaa1bbb2ccc3';
    const pmDir = paths.agentDir(TEST_UID, aid);
    fs.mkdirSync(pmDir, { recursive: true });
    fs.writeFileSync(path.join(pmDir, 'agent.json'), JSON.stringify({
      agent_id: aid, name: '产品 经理',
      description: 'PM', workflow: '...',
      created_at: 't', updated_at: 't',
    }));

    const bus = await import('../../../../src/main/features/group_chat/bus');
    // User types `@产品经理` (no space) — bus should resolve to the agent
    // even though the stored name has a space.
    const msg = await bus.enqueue({
      uid: TEST_UID, cid, fromActorId: 'user',
      text: '@产品经理 帮我做需求文档',
    });
    expect(msg.to).toEqual([aid]);
  });
});

describe('group_chat bus integration › conversation delete cascade', () => {
  it('chats.deleteConversation removes ALL per-conv on-disk artifacts', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const chats = await import('../../../../src/main/features/chats');
    const paths = await import('../../../../src/main/paths');

    // Create the conv via the chats facade so the index gets a row.
    const conv = await chats.createConversation(TEST_UID, { title: '测试' });
    // Hijack the cid since chats.createConversation generates its own.
    const realCid = conv.conversation_id;

    _setScript(state.buildGconvSessionId(TEST_UID, realCid), [
      { type: 'final', text: `@${AGENT_NAME} 干活` },
    ]);
    _setScript(state.buildGmemberSessionId(TEST_UID, realCid, AGENT_ID), [
      { type: 'final', text: 'done' },
    ]);
    _setScript(state.buildGconvSessionId(TEST_UID, realCid), [
      { type: 'final', text: 'ack' },
    ]);

    bus.subscribe(TEST_UID, realCid, () => {});
    await bus.enqueue({ uid: TEST_UID, cid: realCid, fromActorId: 'user', text: 'go' });
    await waitForQuiescent(TEST_UID, realCid, 3000);

    // Sanity — all the expected files exist before delete.
    const mainJsonl = path.join(paths.userChatsDir(TEST_UID), `${realCid}.jsonl`);
    const groupDir = paths.groupChatDir(TEST_UID, realCid);
    const cmdSession = paths.userSessionFile(TEST_UID, state.buildGconvSessionId(TEST_UID, realCid));
    const agentSession = paths.userSessionFile(TEST_UID, state.buildGmemberSessionId(TEST_UID, realCid, AGENT_ID));
    expect(fs.existsSync(mainJsonl)).toBe(true);
    expect(fs.existsSync(groupDir)).toBe(true);
    // Note: session jsonls are created lazily by core-agent's PersistentSession;
    // they may or may not exist depending on whether the session got opened.
    // That's covered by the eviction behaviour rather than by file existence
    // here. We only assert they're CLEANED UP if they did exist.
    const cmdSessionExisted = fs.existsSync(cmdSession);
    const agentSessionExisted = fs.existsSync(agentSession);

    await chats.deleteConversation(TEST_UID, realCid);

    expect(fs.existsSync(mainJsonl)).toBe(false);
    expect(fs.existsSync(groupDir)).toBe(false);
    if (cmdSessionExisted) expect(fs.existsSync(cmdSession)).toBe(false);
    if (agentSessionExisted) expect(fs.existsSync(agentSession)).toBe(false);
    // Bus state for this cid must also be gone.
    expect(bus._cidStateForTest(TEST_UID, realCid)).toBeNull();
  }, 10_000);
});

describe('group_chat bus integration › G8d in-process dispatch (run_worker / dispatch_to)', () => {
  // G8d step 3: dispatch tools run their target's turn in-process and hand the
  // result back as the tool result — no staging, no turn-end flush, no re-wake.
  // The commander reads the result and synthesises within the SAME turn. The
  // mock's `__call_tool__` drives the real tool execute() so the nested run
  // actually streams (routed by its gworker/gmember session id).
  it('run_worker (anonymous) runs the worker IN-PROCESS and hands its full result back as the tool result — no roster member, no worker bubble, no lingering worker', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');

    const WORKER_RESULT = 'WORKER-INTERNAL-OUTPUT-7c1d: scanned 42 files, here is the full structured summary the commander needs.';

    // Commander's SINGLE turn: call run_worker with NO `to` (anonymous worker),
    // then synthesise for the user in the SAME turn. G8d removed the re-wake —
    // the worker's result returns as the tool result, in-process, so the
    // commander reads it and continues without a second scheduled turn.
    _setScript(state.buildGconvSessionId(cid), [
      { type: '__call_tool__', name: 'run_worker', input: { task: 'scan the workspace and summarise' } },
      { type: 'final', text: 'Done — summarised the workspace for you.' },
    ]);
    // The in-process worker sub-run (matched via the gworker wildcard).
    _setScript('gworker-*', [
      { type: 'final', text: WORKER_RESULT },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'summarise my workspace' });
    await waitForQuiescent(TEST_UID, cid, 4000);

    // 1) The worker actually ran in-process: a gworker session turn fired.
    const workerCall = _recordedCalls.find((c) => c.sid.startsWith('gworker-'));
    expect(workerCall, 'an in-process worker sub-run should have streamed').toBeTruthy();

    // 2) Its FULL result came back SYNCHRONOUSLY as the run_worker tool result,
    //    wrapped as <worker-result> — the handback IS the tool result.
    const toolResult = _recordedToolResults.find((r) => r.name === 'run_worker');
    expect(toolResult, 'run_worker should return its result synchronously').toBeTruthy();
    expect(toolResult!.content).toContain('<worker-result');
    expect(toolResult!.content).toContain(WORKER_RESULT);
    // G4 wiring (step 3b-tail): run_worker is parallel-safe so independent
    // fan-out in one turn runs concurrently (bounded by dispatchSlots).
    expect(toolResult!.executionMode, 'run_worker must be G4-parallel-safe').toBe('parallel');

    // 3) The worker is NOT a roster member.
    const members = await state.readMembers(TEST_UID, cid);
    expect(members.actors.some((a) => a.kind === 'worker')).toBe(false);

    // 4) The worker's raw output NEVER becomes a user-visible bubble — only the
    //    commander's synthesis is persisted.
    const lines = fs.readFileSync(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`), 'utf-8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(lines.some((m: any) => String(m.text || '').includes(WORKER_RESULT))).toBe(false);
    expect(lines.some((m: any) => String(m.text || '').includes('summarised the workspace'))).toBe(true);

    // 5) The nested sub-run used a synthetic, unregistered WorkerState — no
    //    worker-kind entry ever appears in the in-memory worker map.
    const live = bus._cidStateForTest(TEST_UID, cid);
    const lingering = live ? [...live.workers.values()].some((wk: any) => wk.actor.kind === 'worker') : false;
    expect(lingering, 'no ephemeral worker should appear in the worker map').toBe(false);
  }, 12_000);

  it('run_worker returns an explicit worker-error when the nested worker stream fails', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');

    _setScript(state.buildGconvSessionId(cid), [
      { type: '__call_tool__', name: 'run_worker', input: { task: 'scan the workspace and summarise' } },
      { type: 'final', text: 'I handled the worker failure.' },
    ]);
    _setScript('gworker-*', [
      { type: 'error', text: 'nested worker blew <up> & quit' },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'summarise my workspace' });
    await waitForQuiescent(TEST_UID, cid, 4000);

    const toolResult = _recordedToolResults.find((r) => r.name === 'run_worker');
    expect(toolResult, 'run_worker should return a tool result even when the worker fails').toBeTruthy();
    expect(toolResult!.content).toContain('<worker-error');
    expect(toolResult!.content).toContain('nested worker blew &lt;up&gt; &amp; quit');
    expect(toolResult!.content).not.toContain('<worker-result');
    expect(toolResult!.content).not.toContain('(no textual reply)');
  }, 12_000);

  it('run_worker marks a nested user abort as non-retryable worker-error', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');

    _setScript(state.buildGconvSessionId(cid), [
      { type: '__call_tool__', name: 'run_worker', input: { task: 'scan slowly' } },
      { type: 'final', text: 'should not matter after abort' },
    ]);
    _setScript('gworker-*', [
      { type: '__wait_for_abort__' },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'scan it slowly' });

    const started = await waitUntil(() => _recordedCalls.some((c) => c.sid.startsWith('gworker-')), 2000);
    expect(started, 'nested worker should have started before abort').toBe(true);
    await bus.abort(TEST_UID, cid);
    await waitForQuiescent(TEST_UID, cid, 4000);

    const toolResult = _recordedToolResults.find((r) => r.name === 'run_worker');
    expect(toolResult, 'run_worker should return an abort-marked tool result').toBeTruthy();
    expect(toolResult!.content).toContain('<worker-error');
    expect(toolResult!.content).toContain('aborted="true"');
    expect(toolResult!.content).toContain('Task was stopped by the user.');
    expect(toolResult!.content).not.toContain('<worker-result');
  }, 12_000);

  it('dispatch_to (named) runs the agent IN-PROCESS, keeps the agent\'s visible bubble, and the commander synthesises (Option B) — no re-wake', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');

    const AGENT_REPLY = 'AGENT-DRAFT-9f2a: here is the full draft the user asked for.';

    // Commander's SINGLE turn: dispatch_to the named agent, then synthesise in
    // the SAME turn — the agent's result returns as the tool result (handback),
    // so there is no second scheduled commander turn.
    _setScript(state.buildGconvSessionId(cid), [
      { type: '__call_tool__', name: 'dispatch_to', input: { to: AGENT_NAME, message: 'draft the thing' } },
      { type: 'final', text: 'Synthesised: the draft is ready.' },
    ]);
    // The dispatched agent's in-process turn (its own persistent gmember session).
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: 'final', text: AGENT_REPLY },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'make me a draft' });
    await waitForQuiescent(TEST_UID, cid, 4000);

    // 1) The agent ran in-process (its gmember session turn fired).
    const agentSid = state.buildGmemberSessionId(cid, AGENT_ID);
    expect(_recordedCalls.some((c) => c.sid === agentSid), 'the dispatched agent should run in-process').toBe(true);

    // 2) Its FULL result came back synchronously as the dispatch_to tool result.
    const toolResult = _recordedToolResults.find((r) => r.name === 'dispatch_to');
    expect(toolResult, 'dispatch_to should return its result synchronously').toBeTruthy();
    expect(toolResult!.content).toContain('<worker-result');
    expect(toolResult!.content).toContain(AGENT_REPLY);
    expect(toolResult!.executionMode, 'dispatch_to must be G4-parallel-safe').toBe('parallel');

    // 3) The agent was auto-added to the roster (so its bubble has attribution).
    const members = await state.readMembers(TEST_UID, cid);
    expect(members.actors.some((a) => a.id === AGENT_ID && a.kind === 'agent')).toBe(true);

    // 4) Option B — BOTH bubbles persist: the agent's own reply AND the
    //    commander's synthesis.
    const lines = fs.readFileSync(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`), 'utf-8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(lines.some((m: any) => m.from === AGENT_ID && String(m.text || '').includes(AGENT_REPLY)),
      'the agent should keep its own visible bubble').toBe(true);
    expect(lines.some((m: any) => String(m.text || '').includes('the draft is ready')),
      'the commander should persist its synthesis').toBe(true);

    // 5) Exactly ONE commander turn — the handback was in-process, not a re-wake.
    const commanderTurns = _recordedCalls.filter((c) => c.sid === state.buildGconvSessionId(cid)).length;
    expect(commanderTurns, 'commander should run exactly one turn (no re-wake)').toBe(1);
  }, 12_000);

  it('dispatch_to can fan out to multiple named agents in one commander turn and keep both visible replies', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');

    const otherId = 'a1a2a3a4a5a6';
    const otherName = 'Reviewer';
    const otherDir = paths.agentDir(TEST_UID, otherId);
    fs.mkdirSync(otherDir, { recursive: true });
    fs.writeFileSync(path.join(otherDir, 'agent.json'), JSON.stringify({
      agent_id: otherId, name: otherName,
      description: 'Reviews things', workflow: 'review',
      created_at: 't', updated_at: 't',
    }));

    const WRITER_REPLY = 'WRITER-FANOUT-31a2: draft is ready.';
    const REVIEWER_REPLY = 'REVIEWER-FANOUT-41b3: checklist is ready.';
    _setScript(state.buildGconvSessionId(cid), [
      { type: '__call_tool__', name: 'dispatch_to', input: { to: AGENT_NAME, message: 'draft the copy' } },
      { type: '__call_tool__', name: 'dispatch_to', input: { to: otherName, message: 'review the copy' } },
      { type: 'final', text: 'Both agents responded; here is the combined handoff.' },
    ]);
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: 'final', text: WRITER_REPLY },
    ]);
    _setScript(state.buildGmemberSessionId(cid, otherId), [
      { type: 'final', text: REVIEWER_REPLY },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'prepare and review this draft' });
    await waitForQuiescent(TEST_UID, cid, 4000);

    const dispatchResults = _recordedToolResults.filter((r) => r.name === 'dispatch_to');
    expect(dispatchResults, 'both dispatch_to calls should synchronously return worker results').toHaveLength(2);
    expect(dispatchResults[0].content).toContain(WRITER_REPLY);
    expect(dispatchResults[1].content).toContain(REVIEWER_REPLY);
    expect(dispatchResults.every((r) => r.executionMode === 'parallel'), 'dispatch_to must stay parallel-safe').toBe(true);

    const members = await state.readMembers(TEST_UID, cid);
    expect(members.actors.some((a) => a.id === AGENT_ID && a.kind === 'agent')).toBe(true);
    expect(members.actors.some((a) => a.id === otherId && a.kind === 'agent')).toBe(true);

    const lines = fs.readFileSync(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`), 'utf-8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(lines.some((m: any) => m.from === AGENT_ID && String(m.text || '').includes(WRITER_REPLY))).toBe(true);
    expect(lines.some((m: any) => m.from === otherId && String(m.text || '').includes(REVIEWER_REPLY))).toBe(true);
    expect(lines.some((m: any) => m.from === 'commander'
      && String(m.text || '').includes('combined handoff'))).toBe(true);
  }, 12_000);

  // Entry 2 (G8d §1 / step 5): the user can talk to an agent directly — a user
  // message addressed to an agent runs that agent's top-level turn and the agent
  // delivers to the user, without the commander in the loop. This is runtime
  // routing (router default: user→commander, but an explicit @agent → that
  // agent), not a commander tool.
  it('user → agent direct (entry 2): a user @-addressed message runs the agent\'s top-level turn, the agent answers the user, and the commander never runs', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');

    const AGENT_REPLY = 'DIRECT-AGENT-REPLY-3c8e: delivered straight to you, no commander involved.';
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: 'final', text: AGENT_REPLY },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    // User addresses the agent directly (entry 2).
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: `@${AGENT_NAME} handle this yourself` });
    await waitForQuiescent(TEST_UID, cid, 4000);

    // 1) The agent ran a top-level turn (its persistent gmember session).
    const agentSid = state.buildGmemberSessionId(cid, AGENT_ID);
    expect(_recordedCalls.some((c) => c.sid === agentSid), 'the agent should run a top-level turn').toBe(true);
    // 2) The agent answered the USER directly — its reply is a visible bubble.
    const lines = fs.readFileSync(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`), 'utf-8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(lines.some((m: any) => m.from === AGENT_ID && String(m.text || '').includes(AGENT_REPLY)),
      'the agent should post a visible reply to the user').toBe(true);

    // 3) The commander was NEVER involved — entry 2 bypasses it.
    const commanderSid = state.buildGconvSessionId(cid);
    expect(_recordedCalls.some((c) => c.sid === commanderSid),
      'the commander must not run for a direct user→agent message').toBe(false);

    // 4) The agent auto-joined the roster (so its bubble has attribution).
    const members = await state.readMembers(TEST_UID, cid);
    expect(members.actors.some((a) => a.id === AGENT_ID && a.kind === 'agent')).toBe(true);
  }, 12_000);

  // Commander loop bubbles: a turn that dispatches a VISIBLE agent is split at
  // the dispatch boundary — pre-dispatch reasoning persists as its own `seg`
  // bubble, the agent's reply lands after it, and the post-handback synthesis is
  // a fresh `seg` bubble (so the loop reads correctly live AND on reload).
  it('commander loop bubbles: a visible dispatch splits the turn into seg bubbles ordered around the agent', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');

    const PRE = 'Running the writer to draft this for you.';
    const SYN = 'Based on the draft, here is my summary.';
    const AGENT_REPLY = 'AGENT-SEG-7b1c: the full draft body.';

    _setScript(state.buildGconvSessionId(cid), [
      { type: 'delta', text: PRE },
      { type: '__call_tool__', name: 'dispatch_to', input: { to: AGENT_NAME, message: 'draft it' } },
      { type: 'delta', text: SYN },
      { type: 'final', text: SYN },
    ]);
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: 'final', text: AGENT_REPLY },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'make me a draft' });
    await waitForQuiescent(TEST_UID, cid, 4000);

    const lines = fs.readFileSync(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`), 'utf-8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));

    const segs = lines.filter((m: any) => m.from === 'commander' && m.seg !== undefined)
      .sort((a: any, b: any) => a.seg - b.seg);
    expect(segs.length, 'commander turn should split into two seg bubbles').toBe(2);
    expect(segs[0].seg).toBe(0);
    expect(segs[0].text).toContain(PRE);
    expect(segs[1].seg).toBe(1);
    expect(segs[1].text).toContain(SYN);
    // The synthesis segment must NOT duplicate the pre-dispatch text on reload.
    expect(segs[1].text).not.toContain(PRE);

    // Persisted (= reload) order: pre-dispatch seg → agent bubble → synthesis seg.
    const agentMsg = lines.find((m: any) => m.from === AGENT_ID && String(m.text || '').includes(AGENT_REPLY));
    expect(agentMsg, 'agent bubble should persist').toBeTruthy();
    expect(lines.indexOf(segs[0])).toBeLessThan(lines.indexOf(agentMsg));
    expect(lines.indexOf(agentMsg)).toBeLessThan(lines.indexOf(segs[1]));
  }, 12_000);

  // The inverse: an anonymous worker is the commander's invisible hands, so the
  // turn must NOT segment (no second bubble with nothing visible between).
  it('commander loop bubbles: an anonymous run_worker does NOT split the commander bubble', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');

    _setScript(state.buildGconvSessionId(cid), [
      { type: 'delta', text: 'Let me scan that.' },
      { type: '__call_tool__', name: 'run_worker', input: { task: 'scan the workspace' } },
      { type: 'delta', text: ' Done — nothing notable.' },
      { type: 'final', text: 'Let me scan that. Done — nothing notable.' },
    ]);
    _setScript('gworker-*', [
      { type: 'final', text: 'worker scanned: empty.' },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'scan it' });
    await waitForQuiescent(TEST_UID, cid, 4000);

    const lines = fs.readFileSync(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`), 'utf-8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));

    const commanderMsgs = lines.filter((m: any) => m.from === 'commander');
    expect(commanderMsgs.length, 'anonymous worker turn stays a single commander bubble').toBe(1);
    expect(commanderMsgs[0].seg, 'no seg marker when nothing visible was dispatched').toBeUndefined();
  }, 12_000);

  // hand_off_to an INTERACTIVE agent: the agent answers the user, the commander
  // does NOT synthesize (no second commander bubble), and the floor moves to the
  // agent so the user's next no-@ message routes to it.
  it('hand_off_to interactive agent: agent answers user, commander does not synthesize, floor moves to agent', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');

    // Seed an interactive tutor agent.
    const tutorId = 'cafe12345678';
    const tutorName = 'LearningTutor';
    const tutorDir = paths.agentDir(TEST_UID, tutorId);
    fs.mkdirSync(tutorDir, { recursive: true });
    fs.writeFileSync(path.join(tutorDir, 'agent.json'), JSON.stringify({
      agent_id: tutorId, name: tutorName, description: 'teaches', workflow: 'teach',
      interactive: true, created_at: 't', updated_at: 't',
    }));

    const TUTOR_REPLY = 'TUTOR-7a2b: Lesson 1 — let us start with the core idea.';
    // Commander: narrate prep, then hand_off_to the tutor (terminal — NO synthesis script entry).
    _setScript(state.buildGconvSessionId(cid), [
      { type: 'delta', text: 'I prepared the material; handing you to the tutor.' },
      { type: '__call_tool__', name: 'hand_off_to', input: { to: tutorName, message: 'teach the user this paper' } },
      { type: 'final', text: 'I prepared the material; handing you to the tutor.' },
    ]);
    _setScript(state.buildGmemberSessionId(cid, tutorId), [
      { type: 'final', text: TUTOR_REPLY },
    ]);

    const events: any[] = [];
    bus.subscribe(TEST_UID, cid, (ev) => events.push(ev));
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'teach me this paper' });
    await waitForQuiescent(TEST_UID, cid, 4000);

    const lines = fs.readFileSync(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`), 'utf-8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));

    // The tutor answered the user directly.
    expect(lines.some((m: any) => m.from === tutorId && String(m.text || '').includes(TUTOR_REPLY)),
      'tutor should post a visible reply to the user').toBe(true);

    // Gap-B "thinking placeholder" signal: the hand-off runs the tutor's turn
    // in-process (bypassing runTurn's start-of-turn state_changed), so without
    // surfacing it the renderer had nothing to paint between the commander's
    // narration and the tutor's first token. The nested dispatch must emit a
    // state_changed listing the tutor in `active_turns` — and the suspended
    // commander must be EXCLUDED from that same event (else the renderer seeds a
    // stray empty commander bubble above the tutor's reply).
    const tutorActive = events.filter(
      (e) => e.type === 'state_changed'
        && Array.isArray(e.active_turns)
        && e.active_turns.some((t: any) => t.actor === tutorId),
    );
    expect(tutorActive.length, 'tutor must surface in active_turns for the thinking placeholder').toBeGreaterThan(0);
    expect(
      tutorActive.every((e: any) => e.active_turns
        .filter((t: any) => t.actor === tutorId)
        .every((t: any) => Number.isFinite(t.started_at_ms) && t.started_at_ms > 0)),
      'nested active turns must expose a stable execution start for elapsed-time recovery',
    ).toBe(true);
    expect(
      tutorActive.every((e: any) => !e.active_turns.some((t: any) => t.actor === 'commander')),
      'the suspended commander must not co-appear in active_turns while the tutor runs',
    ).toBe(true);
    // Commander narrated its prep but did NOT synthesize on top (no "已完成"-style
    // second bubble). The only commander message is the pre-handoff narration —
    // and it must be NON-EMPTY: a trailing empty commander bubble (e.g. one that
    // only carried a produced-file chip) is the regression we are guarding.
    const commanderMsgs = lines.filter((m: any) => m.from === 'commander');
    expect(commanderMsgs.length, 'commander must not synthesize after hand-off').toBeLessThanOrEqual(1);
    expect(commanderMsgs.every((m: any) => String(m.text || '').trim().length > 0),
      'no empty trailing commander bubble after hand-off').toBe(true);
    // The floor moved to the tutor.
    const st = await state.readState(TEST_UID, cid);
    expect(st.active_recipient).toBe(tutorId);

    // A follow-up no-@ user message now routes to the tutor (not the commander).
    _setScript(state.buildGmemberSessionId(cid, tutorId), [
      { type: 'final', text: 'TUTOR-followup: good question about part 2.' },
    ]);
    const commanderCallsBefore = _recordedCalls.filter((c) => c.sid === state.buildGconvSessionId(cid)).length;
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'I did not get part 2' });
    await waitForQuiescent(TEST_UID, cid, 4000);
    const tutorSid = state.buildGmemberSessionId(cid, tutorId);
    expect(_recordedCalls.some((c) => c.sid === tutorSid), 'follow-up should run the tutor again').toBe(true);
    const commanderCallsAfter = _recordedCalls.filter((c) => c.sid === state.buildGconvSessionId(cid)).length;
    expect(commanderCallsAfter, 'commander must NOT run for the no-@ follow-up while handed off').toBe(commanderCallsBefore);
  }, 15_000);

  it('hand_off_to after failed planning attempts leaves no empty commander tail', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
    const specialistReply = 'VIDEO-STUDIO-RESULT: review form is ready.';
    const toolEvent = (id: string, name: string, phase: 'start' | 'end', isError?: boolean) => ({
      type: 'event',
      event: {
        stream: 'tool',
        data: { id, name, phase, ...(isError === undefined ? {} : { isError }) },
      },
    });
    const contextProgress = (stream: 'context' | 'compaction', phase: string, text: string) => ({
      type: 'progress',
      text,
      event: { stream, data: { phase } },
    });

    // Mirrors d33b828f234c from the reported run: research triggered context
    // compaction, the commander narrated a visible pre-dispatch segment, three
    // execution-plan calls failed, and hand_off_to delivered the final answer.
    // The old whole-turn process array was attached again to an empty tail;
    // the generic compaction-visibility rule forced that tail to persist.
    _setScript(state.buildGconvSessionId(cid), [
      contextProgress('context', 'active_process_compaction_start', '正在整理当前轮工具上下文...'),
      contextProgress('context', 'active_process_compaction_done', '当前轮工具上下文整理完成'),
      contextProgress('compaction', 'done', 'compacted 19480→2442 tokens'),
      toolEvent('plan-1', 'manage_execution_plan', 'start'),
      toolEvent('plan-1', 'manage_execution_plan', 'end', true),
      toolEvent('plan-2', 'manage_execution_plan', 'start'),
      toolEvent('plan-2', 'manage_execution_plan', 'end', true),
      { type: 'delta', text: '资料搜集已基本完备，我来整合素材并交给 @Writer。' },
      toolEvent('plan-3', 'manage_execution_plan', 'start'),
      toolEvent('plan-3', 'manage_execution_plan', 'end', true),
      toolEvent('handoff-1', 'hand_off_to', 'start'),
      { type: '__call_tool__', name: 'hand_off_to', input: { to: AGENT_NAME, message: 'compose the video' } },
      toolEvent('handoff-1', 'hand_off_to', 'end', false),
    ]);
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: 'final', text: specialistReply },
    ]);

    const events: any[] = [];
    bus.subscribe(TEST_UID, cid, (ev) => events.push(ev));
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'make the video' });
    await waitForQuiescent(TEST_UID, cid, 4000);

    const rows = fs.readFileSync(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`), 'utf8')
      .split('\n').filter(Boolean).map((line) => JSON.parse(line));
    expect(rows.some((row: any) => row.from === AGENT_ID && row.text === specialistReply)).toBe(true);
    const commanderRows = rows.filter((row: any) => row.from === 'commander');
    expect(commanderRows, 'only the narrated pre-dispatch segment should persist').toHaveLength(1);
    expect(commanderRows[0].text).toContain('资料搜集已基本完备');
    expect(commanderRows[0].process.some((item: any) => item.event?.stream === 'compaction'),
      'pre-dispatch compaction belongs to the pre-dispatch segment').toBe(true);
    expect(commanderRows[0].process.some((item: any) => item.event?.data?.name === 'manage_execution_plan'),
      'pre-dispatch planning attempts belong to the pre-dispatch segment').toBe(true);
    expect(commanderRows.some((row: any) => !String(row.text || '').trim()),
      'terminal delivery must not persist an empty commander process/runtime record').toBe(false);
    expect(events.some((ev) => ev.type === 'turn_silent'
      && ev.actor === 'commander'
      && ev.reason === 'terminal_handoff'),
    'renderer must receive an explicit terminal-handoff cleanup signal').toBe(true);
  }, 15_000);

  it('terminal hand_off_to without narration is not resurrected by context compaction', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');

    _setScript(state.buildGconvSessionId(cid), [
      {
        type: 'progress',
        text: 'compacted 19480→2442 tokens',
        event: { stream: 'compaction', data: { tokensBefore: 19480, tokensAfter: 2442 } },
      },
      { type: '__call_tool__', name: 'hand_off_to', input: { to: AGENT_NAME, message: 'compose the video' } },
    ]);
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: 'final', text: 'VIDEO-STUDIO-RESULT: ready.' },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'make the video' });
    await waitForQuiescent(TEST_UID, cid, 4000);

    const rows = fs.readFileSync(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`), 'utf8')
      .split('\n').filter(Boolean).map((line) => JSON.parse(line));
    expect(rows.some((row: any) => row.from === AGENT_ID)).toBe(true);
    expect(rows.filter((row: any) => row.from === 'commander'),
      'compaction observability must not override an explicit terminal delivery').toEqual([]);
  }, 15_000);

  it('manual @ to another agent while handed off makes that agent the sticky floor', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');

    const tutorId = 'a11122223333';
    const tutorName = 'TutorA';
    const tutorDir = paths.agentDir(TEST_UID, tutorId);
    fs.mkdirSync(tutorDir, { recursive: true });
    fs.writeFileSync(path.join(tutorDir, 'agent.json'), JSON.stringify({
      agent_id: tutorId, name: tutorName, description: 'interactive tutor', workflow: 'teach',
      interactive: true, created_at: 't', updated_at: 't',
    }));

    _setScript(state.buildGconvSessionId(cid), [
      { type: '__call_tool__', name: 'hand_off_to', input: { to: tutorName, message: 'teach this' } },
      { type: 'final', text: 'Over to TutorA.' },
    ]);
    _setScript(state.buildGmemberSessionId(cid, tutorId), [
      { type: 'final', text: 'TutorA: ready.' },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'teach me' });
    await waitForQuiescent(TEST_UID, cid, 4000);
    expect((await state.readState(TEST_UID, cid)).active_recipient).toBe(tutorId);

    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: 'final', text: 'Writer: switching context.' },
    ]);
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: `@${AGENT_NAME} quick aside` });
    await waitForQuiescent(TEST_UID, cid, 4000);
    expect((await state.readState(TEST_UID, cid)).active_recipient).toBe(AGENT_ID);

    const tutorCallsBefore = _recordedCalls.filter((c) => c.sid === state.buildGmemberSessionId(cid, tutorId)).length;
    const writerCallsBefore = _recordedCalls.filter((c) => c.sid === state.buildGmemberSessionId(cid, AGENT_ID)).length;
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: 'final', text: 'Writer: still here.' },
    ]);
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'continue with that' });
    await waitForQuiescent(TEST_UID, cid, 4000);

    const tutorCallsAfter = _recordedCalls.filter((c) => c.sid === state.buildGmemberSessionId(cid, tutorId)).length;
    const writerCallsAfter = _recordedCalls.filter((c) => c.sid === state.buildGmemberSessionId(cid, AGENT_ID)).length;
    expect(writerCallsAfter, 'no-@ follow-up should stay with the manually selected agent').toBe(writerCallsBefore + 1);
    expect(tutorCallsAfter, 'no-@ follow-up must not snap back to the previous hand-off agent').toBe(tutorCallsBefore);
  }, 15_000);

  // hand_off_to a NON-interactive agent: it answers the user (one-shot, saving the
  // commander's synthesis call), but the floor stays with the commander.
  it('hand_off_to non-interactive agent: one-shot answer, floor stays commander', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');

    const SPECIALIST_REPLY = 'SPECIALIST-3c: here is the finished translation.';
    _setScript(state.buildGconvSessionId(cid), [
      { type: 'delta', text: 'Handing this to the specialist.' },
      { type: '__call_tool__', name: 'hand_off_to', input: { to: AGENT_NAME, message: 'translate this' } },
      { type: 'final', text: 'Handing this to the specialist.' },
    ]);
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: 'final', text: SPECIALIST_REPLY },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'translate this for me' });
    await waitForQuiescent(TEST_UID, cid, 4000);

    const lines = fs.readFileSync(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`), 'utf-8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(lines.some((m: any) => m.from === AGENT_ID && String(m.text || '').includes(SPECIALIST_REPLY)),
      'specialist should answer the user directly').toBe(true);
    // Non-interactive → floor stays with the commander (absent).
    const st = await state.readState(TEST_UID, cid);
    expect(st.active_recipient, 'non-interactive hand-off must not stick the floor').toBeUndefined();
  }, 12_000);

  // While an interactive agent holds the floor, emitting <handback /> returns the
  // floor to the commander and the marker is stripped from the visible reply.
  it('agent <handback /> while holding the floor returns control to the commander', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');

    const tutorId = 'beef98765432';
    const tutorName = 'CoachBot';
    const tutorDir = paths.agentDir(TEST_UID, tutorId);
    fs.mkdirSync(tutorDir, { recursive: true });
    fs.writeFileSync(path.join(tutorDir, 'agent.json'), JSON.stringify({
      agent_id: tutorId, name: tutorName, description: 'coaches', workflow: 'coach',
      interactive: true, created_at: 't', updated_at: 't',
    }));

    // 1) Commander hands off → floor = tutor.
    _setScript(state.buildGconvSessionId(cid), [
      { type: '__call_tool__', name: 'hand_off_to', input: { to: tutorName, message: 'coach the user' } },
      { type: 'final', text: 'Over to the coach.' },
    ]);
    _setScript(state.buildGmemberSessionId(cid, tutorId), [
      { type: 'final', text: 'Welcome! What is your goal?' },
    ]);
    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'coach me' });
    await waitForQuiescent(TEST_UID, cid, 4000);
    expect((await state.readState(TEST_UID, cid)).active_recipient).toBe(tutorId);

    // 2) User follow-up (no @) routes to the tutor, which finishes + hands back.
    _setScript(state.buildGmemberSessionId(cid, tutorId), [
      { type: 'final', text: 'Great, you are all set. Good luck!\n<handback />' },
    ]);
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'thanks, that is all' });
    await waitForQuiescent(TEST_UID, cid, 4000);

    // Floor is back to the commander (absent).
    expect((await state.readState(TEST_UID, cid)).active_recipient,
      'handback should return the floor to the commander').toBeUndefined();
    // The marker is stripped from the visible bubble.
    const lines = fs.readFileSync(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`), 'utf-8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const tutorMsgs = lines.filter((m: any) => m.from === tutorId);
    expect(tutorMsgs.some((m: any) => String(m.text || '').includes('<handback')),
      'the handback marker must not leak into the visible text').toBe(false);
  }, 15_000);

  it('interactive hand-off with resume wakes commander from a lightweight orchestration ledger', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');

    const coachId = 'face55556666';
    const coachName = 'ScenarioCoach';
    const coachDir = paths.agentDir(TEST_UID, coachId);
    fs.mkdirSync(coachDir, { recursive: true });
    fs.writeFileSync(path.join(coachDir, 'agent.json'), JSON.stringify({
      agent_id: coachId, name: coachName, description: 'elicits scenario details', workflow: 'coach',
      interactive: true, created_at: 't', updated_at: 't',
    }));

    const commanderSid = state.buildGconvSessionId(cid);
    _setScript(commanderSid, [
      { type: 'delta', text: 'I need the coach to gather the scenario first.' },
      {
        type: '__call_tool__',
        name: 'hand_off_to',
        input: {
          to: coachName,
          message: 'Ask the user for the missing scenario details.',
          resume: 'After ScenarioCoach hands back, synthesize the final multi-agent routing recommendation and mention any remaining risk.',
        },
      },
      { type: 'final', text: 'I need the coach to gather the scenario first.' },
    ]);
    _setScript(state.buildGmemberSessionId(cid, coachId), [
      { type: 'final', text: 'What scenario should I optimize for?' },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: '帮我优化这个多 agent 调度，但先确认场景' });
    await waitForQuiescent(TEST_UID, cid, 4000);

    let st = await state.readState(TEST_UID, cid);
    expect(st.active_recipient).toBe(coachId);
    expect(st.orchestration_ledger?.owner_agent_id).toBe(coachId);
    expect(st.orchestration_ledger?.resume_instruction).toContain('routing recommendation');

    _setScript(state.buildGmemberSessionId(cid, coachId), [
      { type: 'final', text: 'The user wants normal chat prompts to trigger specialist routing when quality improves.\n<handback />' },
    ]);
    _setScript(commanderSid, [
      { type: 'final', text: 'RESUMED-COMMANDER: based on the scenario, keep routing quality-first and resume remaining synthesis.' },
    ]);

    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: '场景是普通用户自然发消息，不会点名 agent' });
    await waitForQuiescent(TEST_UID, cid, 4000);

    st = await state.readState(TEST_UID, cid);
    expect(st.active_recipient).toBeUndefined();
    expect(st.orchestration_ledger).toBeUndefined();

    const resumeCall = _recordedCalls.find((c) => (
      c.sid === commanderSid && c.message.includes('<orchestration-resume>')
    ));
    expect(resumeCall?.message).toContain('normal chat prompts to trigger specialist routing');
    expect(resumeCall?.message).toContain('routing recommendation');

    const lines = fs.readFileSync(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`), 'utf-8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(lines.some((m: any) => m.dispatch === true && m.to.includes('commander')
      && String(m.model_text || '').includes('<orchestration-resume>'))).toBe(true);
    expect(lines.some((m: any) => m.from === 'commander'
      && String(m.text || '').includes('RESUMED-COMMANDER'))).toBe(true);
  }, 15_000);

  it('user explicitly returning to commander consumes an interrupted orchestration ledger', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');

    const coachId = 'feed77778888';
    const coachName = 'InterruptCoach';
    const coachDir = paths.agentDir(TEST_UID, coachId);
    fs.mkdirSync(coachDir, { recursive: true });
    fs.writeFileSync(path.join(coachDir, 'agent.json'), JSON.stringify({
      agent_id: coachId, name: coachName, description: 'interactive coach', workflow: 'coach',
      interactive: true, created_at: 't', updated_at: 't',
    }));

    const commanderSid = state.buildGconvSessionId(cid);
    _setScript(commanderSid, [
      {
        type: '__call_tool__',
        name: 'hand_off_to',
        input: {
          to: coachName,
          message: 'Gather the user scenario.',
          resume: 'After InterruptCoach hands back, continue the commander synthesis.',
        },
      },
      { type: 'final', text: 'Over to the coach.' },
    ]);
    _setScript(state.buildGmemberSessionId(cid, coachId), [
      { type: 'final', text: 'Tell me the scenario.' },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: '先让 coach 了解一下背景，然后你继续' });
    await waitForQuiescent(TEST_UID, cid, 4000);
    expect((await state.readState(TEST_UID, cid)).orchestration_ledger?.status).toBe('waiting_for_agent');

    _setScript(commanderSid, [
      { type: 'final', text: 'INTERRUPTED-COMMANDER: paused the hand-off and handled your change.' },
    ]);
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: '@commander 先暂停，直接说结论' });
    await waitForQuiescent(TEST_UID, cid, 4000);

    const st = await state.readState(TEST_UID, cid);
    expect(st.active_recipient).toBeUndefined();
    expect(st.orchestration_ledger).toBeUndefined();
  }, 15_000);

  it('non-interactive dispatch that blocks on an agent form resumes commander after submission', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const groupChat = await import('../../../../src/main/features/group_chat');
    const paths = await import('../../../../src/main/paths');

    const commanderSid = state.buildGconvSessionId(cid);
    const formPayload = {
      fields: [
        { id: 'topic', label: '主题', type: 'text', required: true },
        {
          id: 'depth', label: '深度', type: 'select',
          options: [{ value: 'q', label: '快速' }, { value: 'd', label: '深度' }],
          default: 'q',
        },
      ],
    };

    _setScript(commanderSid, [
      {
        type: '__call_tool__',
        name: 'dispatch_to',
        input: {
          to: AGENT_NAME,
          message: 'Draft the report, asking for required inputs if missing.',
          resume: 'After Writer completes the report from the submitted form, synthesize final recommendations.',
        },
      },
      { type: 'final', text: '' },
    ]);
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: 'final', text: `请确认参数。\n<agent-input-form>\n${JSON.stringify(formPayload)}\n</agent-input-form>` },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: '帮我写报告，缺参数就问' });
    await waitForQuiescent(TEST_UID, cid, 4000);

    let st = await state.readState(TEST_UID, cid);
    expect(st.orchestration_ledger?.status).toBe('waiting_for_form');
    expect(st.orchestration_ledger?.blocked_on).toBe('agent_form');
    expect(st.orchestration_ledger?.source_tool).toBe('dispatch_to');
    expect(st.orchestration_ledger?.resume_instruction).toContain('synthesize final recommendations');

    let lines = fs.readFileSync(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`), 'utf-8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const agentReply = lines.find((m: any) => m.from === AGENT_ID && m.form);
    expect(agentReply).toBeTruthy();
    expect(agentReply.form.form_id).toBe(st.orchestration_ledger?.form_id);

    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: 'final', text: 'FORM-COMPLETE: report drafted for topic=Orkas, depth=deep.' },
    ]);
    _setScript(commanderSid, [
      { type: 'final', text: 'RESUMED-FORM-COMMANDER: final recommendations synthesized.' },
    ]);

    const submitRes = await groupChat.markFormSubmittedAndDispatch({
      userId: TEST_UID,
      cid,
      msgId: agentReply.id,
      formId: agentReply.form.form_id,
      values: { topic: 'Orkas', depth: 'd' },
    });
    expect(submitRes.ok).toBe(true);
    await groupChat.send({ userId: TEST_UID, cid, text: submitRes.submission!.text });
    await waitForQuiescent(TEST_UID, cid, 4000);

    st = await state.readState(TEST_UID, cid);
    expect(st.orchestration_ledger).toBeUndefined();
    const resumeCall = _recordedCalls.find((c) => (
      c.sid === commanderSid && c.message.includes('<orchestration-resume>')
    ));
    expect(resumeCall?.message).toContain('FORM-COMPLETE');
    expect(resumeCall?.message).toContain('synthesize final recommendations');

    lines = fs.readFileSync(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`), 'utf-8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(lines.some((m: any) => m.dispatch === true && m.to.includes('commander')
      && String(m.model_text || '').includes('<orchestration-resume>'))).toBe(true);
    expect(lines.some((m: any) => m.from === 'commander'
      && String(m.text || '').includes('RESUMED-FORM-COMMANDER'))).toBe(true);
  }, 15_000);

});

describe('group_chat bus integration › task terminal boundary', () => {
  it('emits one completed event only after the whole user-triggered run is quiescent', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const terminals: any[] = [];
    const unsubscribe = bus.subscribeTaskTerminals((event) => terminals.push(event));

    _setScript(state.buildGconvSessionId(cid), [
      { type: 'final', text: 'done' },
    ]);
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'finish this task' });
    await waitForQuiescent(TEST_UID, cid, 3000);
    expect(await waitUntil(() => terminals.length === 1)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({
      user_id: TEST_UID,
      conversation_id: cid,
      status: 'completed',
    });
    expect(terminals[0].finished_at_ms).toBeGreaterThanOrEqual(terminals[0].started_at_ms);
    unsubscribe();
  }, 10_000);

  it('classifies model errors as failed', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const terminals: any[] = [];
    const unsubscribe = bus.subscribeTaskTerminals((event) => terminals.push(event));

    _setScript(state.buildGconvSessionId(cid), [
      { type: 'error', text: 'provider unavailable', failureKind: 'provider', failureCode: 'upstream' },
    ]);
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'finish this task' });
    await waitForQuiescent(TEST_UID, cid, 3000);
    expect(await waitUntil(() => terminals.length === 1)).toBe(true);

    expect(terminals[0].status).toBe('failed');
    unsubscribe();
  }, 10_000);

  it('classifies a persisted input form as waiting_input', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const terminals: any[] = [];
    const unsubscribe = bus.subscribeTaskTerminals((event) => terminals.push(event));
    const formPayload = { fields: [{ id: 'topic', label: 'Topic', type: 'text', required: true }] };

    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: 'final', text: `Need one detail.\n<agent-input-form>\n${JSON.stringify(formPayload)}\n</agent-input-form>` },
    ]);
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `@${AGENT_NAME} start`,
    });
    await waitForQuiescent(TEST_UID, cid, 3000);
    expect(await waitUntil(() => terminals.length === 1)).toBe(true);

    expect(terminals[0].status).toBe('waiting_input');
    unsubscribe();
  }, 10_000);

  it('emits cancelled after a live run is stopped', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const terminals: any[] = [];
    const unsubscribe = bus.subscribeTaskTerminals((event) => terminals.push(event));

    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: '__wait_for_abort__' },
    ]);
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `@${AGENT_NAME} long task`,
    });
    expect(await waitUntil(() => !bus.isQuiescent(TEST_UID, cid))).toBe(true);
    await bus.abort(TEST_UID, cid);
    await waitForQuiescent(TEST_UID, cid, 3000);
    expect(await waitUntil(() => terminals.length === 1)).toBe(true);

    expect(terminals[0].status).toBe('cancelled');
    unsubscribe();
  }, 10_000);
});

describe('group_chat bus integration › direct agent reply routing', () => {
  it('agent reply with explicit @user reaches subscribers and keeps the agent in-flight signal', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');

    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: 'final', text: '@user 好的，我来帮你梳理需求。' },
    ]);

    const events: any[] = [];
    bus.subscribe(TEST_UID, cid, (ev) => events.push(ev));
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: `@${AGENT_NAME} 我想要开发一个软件` });
    await waitForQuiescent(TEST_UID, cid, 3000);

    const messageEvents = events.filter((e) => e.type === 'message');
    expect(messageEvents).toHaveLength(2);
    const fromAgent = messageEvents.find((e) => e.msg.from === AGENT_ID);
    expect(fromAgent).toBeTruthy();
    expect(fromAgent.msg.to).toEqual(['user']);
    expect(fromAgent.msg.text.startsWith('@user')).toBe(false);
    expect(fromAgent.msg.text).toContain('好的');

    const stateChanges = events.filter((e) => e.type === 'state_changed');
    const sawAgentInFlight = stateChanges.some(
      (e) => Array.isArray(e.state.in_flight) && e.state.in_flight.includes(AGENT_ID),
    );
    expect(sawAgentInFlight).toBe(true);
  }, 10_000);

  it('agent reply "@user 好的..." persists as "好的..."', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');

    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: 'final', text: '@user 好的，我来帮你梳理需求。😊' },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: `@${AGENT_NAME} 开始` });
    await waitForQuiescent(TEST_UID, cid, 3000);

    const paths = await import('../../../../src/main/paths');
    const lines = fs.readFileSync(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`), 'utf-8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const agentMsg = lines.find((m) => m.from === AGENT_ID);
    expect(agentMsg).toBeTruthy();
    expect(agentMsg.to).toEqual(['user']);
    expect(agentMsg.text).toBe('好的，我来帮你梳理需求。😊');
    expect(agentMsg.text.startsWith('@')).toBe(false);
  }, 10_000);

  it('mid-prose @user is stripped from agent replies because routing already lives in `to`', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');

    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: 'final', text: '收到 @user，我会同步给 @user' },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: `@${AGENT_NAME} 开始` });
    await waitForQuiescent(TEST_UID, cid, 3000);

    const paths = await import('../../../../src/main/paths');
    const lines = fs.readFileSync(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`), 'utf-8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const agentMsg = lines.find((m) => m.from === AGENT_ID);
    expect(agentMsg.text).not.toContain('@user');
    expect(agentMsg.text).toBe('收到，我会同步给');
  }, 10_000);

  it('agent reply with no @-mention routes to [user]', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');

    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: 'final', text: '已完成。' },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: `@${AGENT_NAME} 开始` });
    await waitForQuiescent(TEST_UID, cid, 3000);

    const paths = await import('../../../../src/main/paths');
    const lines = fs.readFileSync(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`), 'utf-8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const agentMsg = lines.find((m) => m.from === AGENT_ID);
    expect(agentMsg).toBeTruthy();
    expect(agentMsg.to).toEqual(['user']);
  }, 10_000);

  it('agent reply with `@指挥官` routes to commander and wakes a commander turn', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');

    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: 'final', text: '@指挥官 我这边卡住了，需要你协调。' },
    ]);
    _setScript(state.buildGconvSessionId(cid), [
      { type: 'final', text: '收到。' },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: `@${AGENT_NAME} 开始` });
    await waitForQuiescent(TEST_UID, cid, 3000);

    const paths = await import('../../../../src/main/paths');
    const lines = fs.readFileSync(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`), 'utf-8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const agentMsg = lines.find((m) => m.from === AGENT_ID);
    expect(agentMsg).toBeTruthy();
    expect(agentMsg.to).toEqual(['commander']);
    expect(lines.some((m) => m.from === 'commander' && String(m.text || '').includes('收到'))).toBe(true);
  }, 10_000);

  it('non-plan agent → user reply does NOT wake commander', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');

    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: 'final', text: '已完成。' },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: `@${AGENT_NAME} 开始` });
    await waitForQuiescent(TEST_UID, cid, 3000);

    const paths = await import('../../../../src/main/paths');
    const lines = fs.readFileSync(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`), 'utf-8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatchObject({ from: AGENT_ID, to: ['user'] });
    expect(_recordedCalls.some((c) => c.sid === state.buildGconvSessionId(cid))).toBe(false);
    expect(lines.find((l: any) => l.text === '(no reply)')).toBeUndefined();
  }, 10_000);
});
