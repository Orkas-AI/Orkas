import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import AdmZip from 'adm-zip';
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
const _selectedModel = vi.hoisted(() => ({ value: 'model-a' }));
const _streamGates = new Map<string, {
  promise: Promise<void>;
  release: () => void;
}>();
function _holdStream(name: string): void {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  _streamGates.set(name, { promise, release });
}
function _releaseStream(name: string): void {
  const gate = _streamGates.get(name);
  if (!gate) return;
  _streamGates.delete(name);
  gate.release();
}
function _resetStreamGates(): void {
  for (const gate of _streamGates.values()) gate.release();
  _streamGates.clear();
}
// Records every model turn the bus drives, so tests can assert WHAT a given
// session actually received as its turn input (`opts.message`) — e.g. that a
// G8b handback turn carried the worker's full reply, not a summary.
const _recordedCalls = vi.hoisted(() => [] as Array<{
  sid: string;
  message: string;
  model: string;
  // True when the bus asked this call to resume the still-open active turn
  // instead of opening a new one — the in-turn channel retry contract.
  resumeActiveTurn: boolean;
  executionDeadlineAt: number;
  // Tool names offered to this turn. Lets tests assert the Commander/named
  // Agent/anonymous-worker capability split.
  extraToolNames: string[];
  browserTool?: { execute: (input: any, context: any) => Promise<any> };
  extraToolContracts: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
  }>;
  skillListPresent: boolean;
  skillList?: string[];
  toolListPresent: boolean;
  toolList?: string[];
  readOnlyExtraRoots: string[];
  // Keep the shared identity rather than a snapshot: a successful host tool
  // may append run-scoped capabilities after stream construction.
  runtimeReadOnlyRoots: string[];
  runtimeGrantedToolGroups: string[];
  runtimeSkillBindings?: Map<string, unknown>;
  forceOpenSkillRefs: Array<string | { id: string; name?: string; source?: string }>;
  conversationHistory?: {
    source: string;
    messages: unknown[];
    replaceFromTurnId?: number;
    checkpoint?: string;
  };
}>);
// Records the result each tool's execute() returned — lets a test assert that a
// G8d in-process dispatch tool (run_worker) handed its sub-run's full reply back
// synchronously as the tool result, not via an async re-wake.
const _recordedToolResults = vi.hoisted(() => [] as Array<{
  name: string;
  content: string;
  isError?: boolean;
  executionMode?: string;
  executionTimeoutOwner?: string;
}>);

vi.mock('../../../../src/main/model/client', () => ({
  async *streamChatWithModel(opts: any) {
    const sid = opts.sessionId || '';
    const model = _selectedModel.value;
    _recordedCalls.push({
      sid,
      message: String(opts.message || ''),
      model,
      resumeActiveTurn: !!opts.resumeActiveTurn,
      executionDeadlineAt: opts.executionDeadlineAt,
      extraToolNames: (Array.isArray(opts.extraTools) ? opts.extraTools : []).map((t: any) => String(t?.name || '')),
      browserTool: opts.extraTools?.find((tool: any) => tool.name === 'browser'),
      extraToolContracts: (Array.isArray(opts.extraTools) ? opts.extraTools : []).map((tool: any) => ({
        name: String(tool?.name || ''),
        description: String(tool?.description || ''),
        inputSchema: tool?.inputSchema || {},
      })),
      skillListPresent: Object.prototype.hasOwnProperty.call(opts, 'skillList'),
      ...(Array.isArray(opts.skillList) ? { skillList: [...opts.skillList] } : {}),
      toolListPresent: Object.prototype.hasOwnProperty.call(opts, 'toolList'),
      ...(Array.isArray(opts.toolList) ? { toolList: [...opts.toolList] } : {}),
      readOnlyExtraRoots: Array.isArray(opts.readOnlyExtraRoots) ? [...opts.readOnlyExtraRoots] : [],
      runtimeReadOnlyRoots: Array.isArray(opts.runtimeReadOnlyRoots) ? opts.runtimeReadOnlyRoots : [],
      runtimeGrantedToolGroups: Array.isArray(opts.runtimeGrantedToolGroups)
        ? opts.runtimeGrantedToolGroups
        : [],
      ...(opts.runtimeSkillBindings instanceof Map
        ? { runtimeSkillBindings: opts.runtimeSkillBindings }
        : {}),
      forceOpenSkillRefs: Array.isArray(opts.forceOpenSkillRefs)
        ? JSON.parse(JSON.stringify(opts.forceOpenSkillRefs))
        : [],
      ...(opts.conversationHistory
        ? { conversationHistory: JSON.parse(JSON.stringify(opts.conversationHistory)) }
        : {}),
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
            _recordedToolResults.push({
              name: ev.name,
              content: String(res?.content || ''),
              isError: res?.isError === true,
              executionMode: tool.executionMode,
              executionTimeoutOwner: tool.executionTimeoutOwner,
            });
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
      if (ev?.type === '__wait_for_gate__') {
        const gate = _streamGates.get(String(ev.name || ''));
        if (gate) await gate.promise;
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
let prevTestGlobalSkillsRoot: string | undefined;
const TEST_UID = 'u1';
const AGENT_ID = 'b8c7d6a5e4f3';
const AGENT_NAME = 'Writer';
const SECOND_AGENT_ID = 'a1b2c3d4e5f6';
const SECOND_AGENT_NAME = 'Researcher';
const cidsToDrop = new Set<string>();

function newCid(): string {
  const cid = 'c' + Math.random().toString(16).slice(2, 13);
  cidsToDrop.add(cid);
  return cid;
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-int-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  prevTestGlobalSkillsRoot = process.env.ORKAS_TEST_GLOBAL_SKILLS_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  process.env.ORKAS_TEST_GLOBAL_SKILLS_ROOT = path.join(tmpDir, 'global-skills');
  _resetScripts();
  _resetStreamGates();
  _selectedModel.value = 'model-a';
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
  _resetStreamGates();
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
  try {
    const bashPermissions = await import('../../../../src/main/model/core-agent/bash-permissions');
    bashPermissions._setBroadcastForTest(null);
    bashPermissions._resetForTest();
  } catch { /* ignore */ }
  await drainMainRuntimeForTest();
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  if (prevTestGlobalSkillsRoot === undefined) delete process.env.ORKAS_TEST_GLOBAL_SKILLS_ROOT;
  else process.env.ORKAS_TEST_GLOBAL_SKILLS_ROOT = prevTestGlobalSkillsRoot;
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

async function seedDisabledSkill() {
  const paths = await import('../../../../src/main/paths');
  const enabled = await import('../../../../src/main/features/component_enabled');
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
}

describe('group_chat bus integration › unexpected host-turn failure recovery', () => {
  // Cold module transformation is fixture setup, not failure/retry latency.
  // On a loaded host it exceeded this case's 10s business-flow budget before
  // enqueue was reached. Preserve that budget and isolate the import cost.
  beforeEach(async () => {
    await import('../../../../src/main/features/group_chat');
  }, 60_000);

  // Scenario: the user submits an ordinary Commander task, but the host
  // boundary fails before the model turn starts. The transcript must retain
  // the request, surface one structured/retryable failure, and remain usable.
  // A success-only or `turn_silent` assertion would miss the production
  // regression where the spinner cleared but the user received no reply.
  it('persists a visible retry target and accepts the retry after a host exception', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const runtimeContentPublish = await import('../../../../src/main/features/runtime_content_publish');
    const gateSpy = vi.spyOn(runtimeContentPublish, 'enterRuntimeContentTurn')
      .mockRejectedValueOnce(new Error('fault-injected host boundary failure'));
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const groupChat = await import('../../../../src/main/features/group_chat');
    const events: any[] = [];
    const unsubscribe = bus.subscribe(TEST_UID, cid, (event) => events.push(event));

    try {
      await bus.enqueue({
        uid: TEST_UID,
        cid,
        fromActorId: 'user',
        text: 'finish the task',
      });
      await waitForQuiescent(TEST_UID, cid);
    } finally {
      gateSpy.mockRestore();
      unsubscribe();
    }

    let rows = await groupChat.readMessages(TEST_UID, cid);
    const source = rows.find((row: any) => row.from === 'user');
    const failed = rows.find((row: any) => row.failure_code === 'worker_turn_exception');
    expect(source).toBeTruthy();
    expect(failed).toMatchObject({
      from: 'commander',
      failure_kind: 'runtime',
      source_message_id: source.id,
    });
    expect(failed.text).toContain('This reply stopped because of an unexpected app error. Please try again.');
    expect(events.some((event) => event.type === 'message'
      && event.turn_end === true
      && event.msg?.id === failed.id)).toBe(true);
    expect(events.some((event) => event.type === 'turn_silent'
      && event.turn_id === failed.turn_id)).toBe(false);

    const sid = state.buildGconvSessionId(cid);
    _setScript(sid, [{ type: 'final', text: 'finished after retry' }]);
    const retry = await groupChat.retryFailedTurn({
      userId: TEST_UID,
      cid,
      failedMessageId: failed.id,
      visibleText: source.text,
    });
    expect(retry).toMatchObject({ ok: true, mode: 'restart' });
    await waitForQuiescent(TEST_UID, cid);

    rows = await groupChat.readMessages(TEST_UID, cid);
    expect(rows.filter((row: any) => row.failure_code === 'worker_turn_exception')).toHaveLength(1);
    expect(rows.some((row: any) => row.text === 'finished after retry')).toBe(true);
    const members = await state.readMembers(TEST_UID, cid);
    expect(members.actors.find((actor) => actor.id === 'commander')?.in_flight).not.toBe(true);
  }, 10_000);
});

describe('group_chat bus integration › conversation search freshness', () => {
  it('makes committed user and assistant messages searchable without a repair scan', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const search = await import('../../../../src/main/features/search');
    const indexer = await import('../../../../src/main/features/search/indexer');

    await indexer.reconcileChatsIndex(TEST_UID);
    expect(indexer.isChatsIndexTrusted(TEST_UID)).toBe(true);
    _setScript(state.buildGconvSessionId(cid), [
      { type: 'final', text: 'quasarproof assistant response' },
    ]);

    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: 'xylophonic user request',
    });
    await waitForQuiescent(TEST_UID, cid);

    const userResults = await search.searchChats(TEST_UID, 'xylophonic');
    const assistantResults = await search.searchChats(TEST_UID, 'quasarproof');
    expect(userResults.some((result) => result.cid === cid && result.role === 'user')).toBe(true);
    expect(assistantResults.some((result) => result.cid === cid && result.role === 'commander')).toBe(true);
    expect(search.__searchTestHooks.hasPendingChatRepair(TEST_UID)).toBe(false);
  });
});

describe('group_chat bus integration › memory prose does not control execution', () => {
  // The requester removed prose-based memory validation. Neither an explanation
  // nor a completion claim may rewrite the reply, mutate memory, or create a
  // retry target. Tool receipts and runtime errors remain independent evidence.
  it.each([
    ['ordinary explanation', '长期记忆用于保存偏好。'],
    ['project-file delivery', '项目档案已保存到 report.json。'],
    ['Chinese completion claim', '六条全部写入项目长期笔记。\n\n其余分析仍然有效。'],
    ['English completion claim', "I've saved all six rules to the project's persistent memory."],
    ['Japanese completion claim', 'プロジェクトの長期メモリに保存しました。'],
    ['Portuguese completion claim', 'Salvei as regras na memória persistente do projeto.'],
  ])('preserves %s without inferring a memory operation or failure', async (_shape, delivery) => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
    const storage = await import('../../../../src/main/storage');
    const memory = await import('../../../../src/main/features/memory');
    memory.addEntry(TEST_UID, 'user', 'Prefers concise replies.');
    _setScript(state.buildGconvSessionId(cid), [
      { type: 'final', text: delivery },
    ]);

    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: '介绍一下信息如何保存' });
    await waitForQuiescent(TEST_UID, cid);

    const messages = await storage.readJsonl<any>(
      path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`),
    );
    const replies = messages.filter((message: any) => message.from === 'commander');
    expect(replies).toHaveLength(1);
    const reply = replies[0];
    expect(reply.text).toBe(delivery);
    expect(reply.failure_kind).toBeUndefined();
    expect(reply.failure_code).toBeUndefined();
    expect(_recordedCalls).toHaveLength(1);
    expect(_recordedToolResults).toHaveLength(0);
    expect(memory.listEntries(TEST_UID, 'user').entries).toEqual(['Prefers concise replies.']);
    expect(memory.listEntries(TEST_UID, 'memory').entries).toEqual([]);
  });

  it('retains a structured runtime failure after streamed memory prose without replay', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
    const storage = await import('../../../../src/main/storage');
    _setScript(state.buildGconvSessionId(cid), [
      { type: 'delta', text: '六条全部写入项目长期笔记。' },
      {
        type: 'error', text: 'stream interrupted',
        failureKind: 'model', failureCode: 'provider_network', failurePhase: 'provider_wait',
      },
    ]);
    _setScript(state.buildGconvSessionId(cid), [{ type: 'final', text: 'unexpected replay' }]);

    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: '请记住这六条规则' });
    await waitForQuiescent(TEST_UID, cid);

    const messages = await storage.readJsonl<any>(
      path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`),
    );
    const reply = messages.find((message: any) => message.from === 'commander');
    expect(reply).toMatchObject({
      failure_kind: 'model',
      failure_code: 'provider_network',
      source_message_id: messages.find((message: any) => message.from === 'user').id,
    });
    expect(reply.text).toContain('六条全部写入项目长期笔记。');
    expect(reply.text).toContain('color:var(--danger)');
    expect(reply.text).toContain('Model call failed');
    expect(_recordedCalls).toHaveLength(1);
    expect(_recordedToolResults).toHaveLength(0);
    expect(messages.some((message: any) => message.text === 'unexpected replay')).toBe(false);
  });

  it('preserves memory discussion across a visible dispatch without adding a terminal correction', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const groupChat = await import('../../../../src/main/features/group_chat');
    const intro = '长期记忆用于保存偏好。';
    const tail = '下面是协作方式的说明。';
    _setScript(state.buildGconvSessionId(cid), [
      { type: 'delta', text: intro },
      { type: '__call_tool__', name: 'dispatch_to', input: { to: AGENT_NAME, message: 'Explain the collaboration workflow.' } },
      { type: 'delta', text: tail },
      { type: 'final', text: `${intro}\n\n${tail}` },
    ]);
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: 'final', text: 'Writer can contribute to the discussion.' },
    ]);

    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: '介绍记忆和协作方式，并请 Writer 补充。' });
    await waitForQuiescent(TEST_UID, cid);

    const rows = await groupChat.readMessages(TEST_UID, cid);
    const replies = rows.filter((row: any) => row.from === 'commander' && !row.dispatch);
    expect(replies.map((row: any) => row.text)).toEqual([intro, tail]);
    expect(replies.every((row: any) => !row.failure_kind && !row.failure_code)).toBe(true);
    expect(rows.filter((row: any) => row.from === AGENT_ID)).toHaveLength(1);
    expect(_recordedToolResults.filter((result) => result.name === 'dispatch_to')).toHaveLength(1);
    expect(_recordedCalls).toHaveLength(2);
  });

  it.each([false, true])('preserves the memory tool receipt independently of prose (isError=%s)', async (isError) => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
    const storage = await import('../../../../src/main/storage');
    const sid = state.buildGconvSessionId(cid);
    _setScript(sid, [
      {
        type: 'event',
        event: {
          stream: 'tool',
          data: {
            phase: 'start', id: 'memory-1', name: 'cross_session_memory',
            arguments: { action: 'add', target: 'project', content: 'six stable rules' },
          },
        },
      },
      {
        type: 'event',
        event: {
          stream: 'tool',
          data: {
            phase: 'end', id: 'memory-1', name: 'cross_session_memory',
            isError, output: JSON.stringify({ ok: !isError }),
          },
        },
      },
      { type: 'final', text: '六条全部写入项目长期笔记。' },
    ]);

    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: '请记住这六条规则' });
    await waitForQuiescent(TEST_UID, cid);

    const messages = await storage.readJsonl<any>(
      path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`),
    );
    const reply = messages.find((message: any) => message.from === 'commander');
    expect(reply.text).toBe('六条全部写入项目长期笔记。');
    expect(reply.failure_kind).toBeUndefined();
    expect(reply.failure_code).toBeUndefined();
    const receipts = reply.process.filter((item: any) => item.event?.stream === 'tool'
      && item.event.data?.phase === 'end');
    expect(receipts).toHaveLength(1);
    expect(receipts[0].event.data).toMatchObject({
      id: 'memory-1', name: 'cross_session_memory', isError,
    });
    expect(_recordedCalls).toHaveLength(1);
  });
});

describe('group_chat bus integration › delegation prose does not control execution', () => {
  // User-confirmed rollback: ordinary model prose is not a routing protocol.
  // Delegation wording must not manufacture a validation failure, replace a reply, or
  // wake a hidden correction turn. Real tool calls remain the execution path.
  it.each([
    ['host attribution', 'Commander delegated this step to ' + AGENT_NAME + ' (' + AGENT_ID + '):'],
    ['handoff wording', 'Commander handed off to ' + AGENT_NAME + ' (' + AGENT_ID + '):'],
    ['localized claim', '任务已经派给 Writer。'],
    ['quoted example', '> Commander delegated this step to ' + AGENT_NAME + ' (' + AGENT_ID + '):'],
  ])('preserves %s without rewriting, dispatching, or automatically retrying', async (_shape, narration) => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const groupChat = await import('../../../../src/main/features/group_chat');
    const commanderSid = state.buildGconvSessionId(cid);
    _setScript(commanderSid, [
      {
        type: 'event',
        event: {
          stream: 'tool',
          data: { phase: 'start', id: 'list-1', name: 'list_files', arguments: { path: '.' } },
        },
      },
      {
        type: 'event',
        event: {
          stream: 'tool',
          data: { phase: 'end', id: 'list-1', name: 'list_files', isError: false },
        },
      },
      { type: 'final', text: narration },
    ]);

    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'Please have Writer finish the implementation.' });
    await waitForQuiescent(TEST_UID, cid, 10_000);

    expect(_recordedCalls).toHaveLength(1);
    expect(_recordedCalls[0].sid).toBe(commanderSid);
    expect(_recordedToolResults).toHaveLength(0);
    const rows = await groupChat.readMessages(TEST_UID, cid);
    const replies = rows.filter((row: any) => row.from === 'commander' && !row.dispatch);
    expect(replies).toHaveLength(1);
    expect(replies[0].text).toBe(narration);
    expect(replies[0].failure_kind).toBeUndefined();
    expect(replies[0].failure_code).toBeUndefined();
    expect(rows.some((row: any) => row.dispatch || row.from === AGENT_ID)).toBe(false);
  }, 10_000);

  it('applies an explicit automation container once without replaying the accompanying prose', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const groupChat = await import('../../../../src/main/features/group_chat');
    const commanderSid = state.buildGconvSessionId(cid);
    const attribution = 'Commander delegated this step to ' + AGENT_NAME + ' (' + AGENT_ID + '):';
    _setScript(commanderSid, [{
      type: 'final',
      text: [
        'Setting up the review.',
        '<auto-task>',
        '<action>create</action>',
        '<title>Evening review</title>',
        '<content>Summarize the day.</content>',
        '<schedule>{"type":"daily","hour":18,"minute":0}</schedule>',
        '<recipient>{"kind":"commander"}</recipient>',
        '</auto-task>',
        '',
        attribution,
        '',
        '请完成实现。',
      ].join('\n'),
    }]);

    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: '建一个每天傍晚的回顾自动化，然后让 Writer 完成实现' });
    await waitForQuiescent(TEST_UID, cid, 10_000);

    expect(_recordedCalls).toHaveLength(1);
    const rows = await groupChat.readMessages(TEST_UID, cid);
    const reply = rows.find((row: any) => row.from === 'commander' && !row.dispatch);
    expect(reply?.failure_kind).toBeUndefined();
    expect(reply?.text).toContain(attribution);
    expect(reply?.text).toContain('Automation created');
    expect(reply?.text).not.toContain('<auto-task>');
    expect(reply?.app_nav_requests).toEqual([expect.objectContaining({ surface_id: 'auto', action: 'configure' })]);
    const autoTasks = await import('../../../../src/main/features/auto_tasks');
    const created = (await autoTasks.listTasks(TEST_UID)).filter((task: any) => task.title === 'Evening review');
    expect(created).toHaveLength(1);
    expect(rows.some((row: any) => row.dispatch || row.from === AGENT_ID)).toBe(false);
  }, 15_000);

  it('preserves the attribution after dispatch_to actually ran the named Agent', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const groupChat = await import('../../../../src/main/features/group_chat');
    const commanderSid = state.buildGconvSessionId(cid);
    const attribution = `Commander delegated this step to ${AGENT_NAME} (${AGENT_ID}):`;
    _setScript(commanderSid, [
      {
        type: '__call_tool__',
        name: 'dispatch_to',
        input: { to: AGENT_NAME, message: '检查并返回结果。' },
      },
      { type: 'final', text: `${attribution}\n\n已收到 Agent 的执行结果。` },
    ]);
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: 'final', text: 'Agent 已执行检查。' },
    ]);

    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `请让 ${AGENT_NAME} 检查`,
    });
    await waitForQuiescent(TEST_UID, cid, 10_000);

    const rows = await groupChat.readMessages(TEST_UID, cid);
    const synthesis = rows.find((row: any) => (
      row.from === 'commander' && !row.dispatch && row.text.includes('已收到 Agent')
    ));
    expect(synthesis?.text).toContain(attribution);
    expect(synthesis?.failure_kind).toBeUndefined();
    expect(synthesis?.failure_code).toBeUndefined();
    expect(_recordedToolResults.filter((result) => result.name === 'dispatch_to')).toHaveLength(1);
  }, 10_000);
});

describe('group_chat bus integration › generated-media URL freshness', () => {
  it('versions assistant URLs at persistence while preserving user-authored text', async () => {
    const cid = newCid();
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
    const storage = await import('../../../../src/main/storage');
    const mediaUrls = await import('../../../../src/main/util/chat-media-url');
    const imagePath = path.join(tmpDir, 'workspace', 'poster.png');
    fs.mkdirSync(path.dirname(imagePath), { recursive: true });
    fs.writeFileSync(imagePath, 'current-poster');
    const unversioned = mediaUrls.chatMediaLocalUrl(imagePath);

    const assistant = await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'commander',
      text: `![poster](${unversioned})`,
      forceTo: ['user'],
    });
    const user = await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `I am quoting ${unversioned}`,
      forceTo: ['user'],
    });

    expect(assistant.text).toMatch(/\?v=\d+-\d+-14/);
    expect(user.text).toBe(`I am quoting ${unversioned}`);

    const messages = await storage.readJsonl<any>(
      path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`),
    );
    expect(messages[0].text).toBe(assistant.text);
    expect(messages[0].text).not.toBe(`![poster](${unversioned})`);
    expect(messages[1].text).toBe(user.text);
  });

  it('resolves media an agent offered by a path relative to the conversation workspace', async () => {
    // The agent hands over the path it produced in its own cwd. Nothing
    // downstream knew that cwd, so the renderer requested the relative path
    // against the app origin and every offered keyframe rendered as "image
    // missing" while sitting on disk (2026-09-01).
    const cid = newCid();
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const state = await import('../../../../src/main/features/group_chat/state');
    const paths = await import('../../../../src/main/paths');
    const storage = await import('../../../../src/main/storage');
    const mediaUrls = await import('../../../../src/main/util/chat-media-url');

    const userWorkspace = await import('../../../../src/main/features/user_workspace');
    await state.setWorkspaceDirOnce(TEST_UID, cid, 'chat-panda-dogfight');
    // Place the file where the product says this conversation's agents work,
    // so the case cannot pass against a workspace root the app never uses.
    const frame = path.join(
      userWorkspace.getWorkspacePath(TEST_UID), 'chat-panda-dogfight',
      'project', 'composition', 'preview', '01-first-frame.png',
    );
    fs.mkdirSync(path.dirname(frame), { recursive: true });
    fs.writeFileSync(frame, 'frame-bytes');
    const relative = 'project/composition/preview/01-first-frame.png';

    const assistant = await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'commander',
      text: `关键帧：[首帧](${relative})`,
      forceTo: ['user'],
    });
    expect(assistant.text).toContain(mediaUrls.chatMediaLocalUrl(frame));
    expect(assistant.text).toMatch(/\?v=\d+-\d+-11/);

    // A relative destination that names no file in the workspace is prose, not
    // a broken embed: it survives the boundary untouched.
    const missing = await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'commander',
      text: '[gone](project/composition/preview/99-missing.png)',
      forceTo: ['user'],
    });
    expect(missing.text).toBe('[gone](project/composition/preview/99-missing.png)');

    // User-authored text is still never rewritten.
    const user = await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `[首帧](${relative})`,
      forceTo: ['user'],
    });
    expect(user.text).toBe(`[首帧](${relative})`);

    const messages = await storage.readJsonl<any>(
      path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`),
    );
    expect(messages[0].text).toBe(assistant.text);
    expect(messages[2].text).toBe(`[首帧](${relative})`);

    fs.rmSync(path.join(userWorkspace.getWorkspacePath(TEST_UID), 'chat-panda-dogfight'), {
      recursive: true,
      force: true,
    });
  });

  it('resolves the authoring dir only for a reply that carries a Markdown destination', async () => {
    // Resolving the base dir reads state.json and the conversation record on
    // the enqueue serial path; most agent, status, and segment bubbles carry no
    // link or image, so they must not pay those reads.
    const cid = newCid();
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const convWorkspace = await import('../../../../src/main/features/group_chat/conv_workspace');
    const resolveSpy = vi.spyOn(convWorkspace, 'readConversationAuthoringDir');
    try {
      const plain = 'Rendered 3 keyframes under project/composition/preview; see /tmp/build/log.txt';
      const reply = await bus.enqueue({
        uid: TEST_UID,
        cid,
        fromActorId: 'commander',
        text: plain,
        forceTo: ['user'],
      });
      expect(reply.text).toBe(plain);
      expect(resolveSpy).not.toHaveBeenCalled();

      // Positive control: a destination still goes through the resolver.
      await bus.enqueue({
        uid: TEST_UID,
        cid,
        fromActorId: 'commander',
        text: '[首帧](project/composition/preview/01-first-frame.png)',
        forceTo: ['user'],
      });
      expect(resolveSpy).toHaveBeenCalledTimes(1);
      expect(resolveSpy).toHaveBeenCalledWith(TEST_UID, cid);
    } finally {
      resolveSpy.mockRestore();
    }
  });
});

describe('group_chat bus integration › disabled skills', () => {
  it('does not let commander substitute another skill when user explicitly requests a disabled one', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
    const storage = await import('../../../../src/main/storage');
    await seedDisabledSkill();

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

describe('group_chat bus integration › browser task lifetime', () => {
  it.each(['completed', 'failed', 'cancelled'] as const)(
    'cleans explicitly temporary tabs at the %s task boundary and keeps unmarked/handoff/user tabs', async (outcome) => {
      const cid = newCid();
      const state = await import('../../../../src/main/features/group_chat/state');
      const bus = await import('../../../../src/main/features/group_chat/bus');
      const life = await import('../../../../src/main/features/web_assist_lifecycle');
      const gateName = `browser-${outcome}`;
      _holdStream(gateName);
      _setScript(state.buildGconvSessionId(cid), [
        { type: '__wait_for_gate__', name: gateName },
        ...(outcome === 'cancelled' ? [{ type: '__wait_for_abort__' }]
          : outcome === 'failed' ? [{ type: 'error', text: 'Fixture model failure', failureKind: 'config', failureCode: 'model_preflight' }]
            : [{ type: 'final', text: 'Browser task complete.' }]),
      ]);
      const terminals: any[] = [];
      const unsubscribe = bus.subscribeTaskTerminals(event => {
        if (event.conversation_id === cid) terminals.push(event);
      });
      const closed: string[] = [];
      try {
        await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'Inspect the page.' });
        expect(await waitUntil(() => _recordedCalls.some(call => call.sid === state.buildGconvSessionId(cid)))).toBe(true);
        expect(life.browserTaskRunId(TEST_UID, cid)).toBeTruthy();
        life.registerBrowserTab(TEST_UID, cid, 'temp', 'model', () => closed.push('temp'));
        expect(life.retainBrowserTab(TEST_UID, cid, 'temp', 'temporary')).toBe(true);
        life.registerBrowserTab(TEST_UID, cid, 'login', 'model', () => closed.push('login'));
        life.registerBrowserTab(TEST_UID, cid, 'user', 'user', () => closed.push('user'));
        life.registerBrowserTab(TEST_UID, cid, 'handoff', 'model', () => closed.push('handoff'));
        expect(life.retainBrowserTab(TEST_UID, cid, 'handoff', 'handoff')).toBe(true);
        expect(closed).toEqual([]);
        _releaseStream(gateName);
        if (outcome === 'cancelled') await bus.abort(TEST_UID, cid);
        await waitForQuiescent(TEST_UID, cid, 4000);
        expect(await waitUntil(() => terminals.length === 1)).toBe(true);
        expect(terminals[0].status).toBe(outcome);
        expect(closed).toEqual(['temp']);
        expect(life.browserTaskRunId(TEST_UID, cid)).toBeUndefined();
        const browser = _recordedCalls.find(call => call.sid === state.buildGconvSessionId(cid))!.browserTool!;
        const stale = await browser.execute({ operation: 'open', url: 'https://example.com/stale' }, {});
        expect(JSON.parse(stale.content)).toMatchObject({ ok: false, code: 'task_run_ended' });
      } finally {
        _releaseStream(gateName);
        unsubscribe();
        for (const tab of ['temp', 'user', 'handoff', 'login']) life.forgetBrowserTab(TEST_UID, cid, tab);
      }
    },
  );

  it('keeps a worker page until its Commander finishes the shared task round', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const life = await import('../../../../src/main/features/web_assist_lifecycle');
    _holdStream('browser-worker');
    _holdStream('browser-commander');
    _setScript(state.buildGconvSessionId(cid), [
      { type: '__call_tool__', name: 'run_worker', input: { task: 'Read the page.' } },
      { type: '__wait_for_gate__', name: 'browser-commander' },
      { type: 'final', text: 'The findings are ready.' },
    ]);
    _setScript('gworker-*', [
      { type: '__wait_for_gate__', name: 'browser-worker' },
      { type: 'final', text: 'Page findings.' },
    ]);
    const close = vi.fn();
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'Research this page.' });
    expect(await waitUntil(() => _recordedCalls.some(call => call.sid.startsWith('gworker-')))).toBe(true);
    const runId = life.browserTaskRunId(TEST_UID, cid);
    life.registerBrowserTab(TEST_UID, cid, 'worker-page', 'model', close);
    expect(life.retainBrowserTab(TEST_UID, cid, 'worker-page', 'temporary')).toBe(true);
    _releaseStream('browser-worker');
    expect(await waitUntil(() => _recordedToolResults.some(result => result.name === 'run_worker'))).toBe(true);
    expect(close).not.toHaveBeenCalled();
    expect(life.browserTaskRunId(TEST_UID, cid)).toBe(runId);
    _releaseStream('browser-commander');
    await waitForQuiescent(TEST_UID, cid, 4000);
    expect(await waitUntil(() => close.mock.calls.length === 1)).toBe(true);
  });
});

describe('group_chat bus integration › failure taxonomy', () => {
  it('records a post-tool empty-answer failure without inventing reply text and recovers on user retry', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const groupChat = await import('../../../../src/main/features/group_chat');
    const { mapCoreAgentEvents } = await import('../../../../src/main/model/core-agent/event-mapper');
    const sid = state.buildGconvSessionId(cid);
    const preamble = 'I will read the source and deliver the report.';
    // The mapper, settlement, persistence and terminal observer are real.
    // Only the model response is scripted: completed research is not delivery.
    async function* modelEvents(): AsyncGenerator<any> {
      yield { type: 'text_delta', text: preamble };
      yield { type: 'tool_start', id: 'lookup-1', name: 'web_search', input: { query: 'fixture' } };
      yield { type: 'tool_end', id: 'lookup-1', name: 'web_search', result: 'source found' };
      yield { type: 'thinking', phase: 'start', chars: 0 };
      yield { type: 'thinking', phase: 'progress', chars: 16, text: 'Analysis pending' };
      yield { type: 'thinking', phase: 'end', chars: 16 };
      yield { type: 'done', result: { text: '', meta: { error: null } } };
    }
    const mapped = [];
    for await (const event of mapCoreAgentEvents(modelEvents(), { nowMs: () => 0, failureTrackingScope: {} })) mapped.push(event);
    _setScript(sid, mapped);
    const terminals: any[] = [];
    const unsubscribe = bus.subscribeTaskTerminals((event) => {
      if (event.conversation_id === cid) terminals.push(event);
    });
    try {
      await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'Research this and deliver the report.' });
      await waitForQuiescent(TEST_UID, cid, 4000);
      expect(await waitUntil(() => terminals.length === 1)).toBe(true);
      const rows = await groupChat.readMessages(TEST_UID, cid);
      const source = rows.find((row: any) => row.from === 'user')!;
      const failed = rows.find((row: any) => row.failure_code === 'empty_response')!;
      expect(failed).toMatchObject({ from: 'commander', failure_kind: 'model', source_message_id: source.id });
      // Failure presentation belongs to the renderer, not assistant history.
      expect(failed.text).toBe('');
      expect(JSON.stringify(failed.process)).toContain(preamble);
      expect(terminals[0]).toMatchObject({ status: 'failed', failure: { error_code: 'empty_response' } });
      expect(_recordedCalls.filter((call) => call.sid === sid)).toHaveLength(1);

      _setScript(sid, [{ type: 'final', text: 'The requested report is complete.' }]);
      const retry = await groupChat.retryFailedTurn({ userId: TEST_UID, cid, failedMessageId: failed.id, visibleText: source.text });
      expect(retry.ok).toBe(true);
      await waitForQuiescent(TEST_UID, cid, 4000);
      expect(await waitUntil(() => terminals.length === 2)).toBe(true);
      expect(terminals[1].status).toBe('completed');
      expect((await groupChat.readMessages(TEST_UID, cid)).some((row: any) => row.text === 'The requested report is complete.')).toBe(true);
      expect(_recordedCalls.filter((call) => call.sid === sid)).toHaveLength(2);
    } finally {
      unsubscribe();
    }
  });

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

describe('group_chat bus integration › model selection turn boundaries', () => {
  it('keeps the active turn on its snapshot and lets an already queued turn use the latest model', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const sid = state.buildGconvSessionId(cid);

    _selectedModel.value = 'model-a';
    _holdStream('active-turn');
    _setScript(sid, [
      { type: '__wait_for_gate__', name: 'active-turn' },
      { type: 'final', text: 'first turn complete' },
    ]);
    _setScript(sid, [
      { type: 'final', text: 'queued turn complete' },
    ]);

    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'first turn' });
    expect(await waitUntil(() => _recordedCalls.some((call) => call.sid === sid))).toBe(true);
    expect(_recordedCalls.filter((call) => call.sid === sid)).toEqual([
      expect.objectContaining({ model: 'model-a', message: expect.stringContaining('first turn') }),
    ]);

    // Switch once while A is running, queue the next user message, then switch
    // again before that queue item starts. The active call remains A and the
    // queued turn reads the latest selection C at execution time.
    _selectedModel.value = 'model-b';
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'queued turn' });
    _selectedModel.value = 'model-c';

    const live = bus._cidStateForTest(TEST_UID, cid) as any;
    const queued = [...(live?.queue || [])];
    expect(queued).toHaveLength(1);
    expect(queued[0]).not.toHaveProperty('model');
    expect(queued[0]).not.toHaveProperty('modelId');
    expect(_recordedCalls.filter((call) => call.sid === sid)[0].model).toBe('model-a');

    _releaseStream('active-turn');
    await waitForQuiescent(TEST_UID, cid, 4000);

    expect(_recordedCalls.filter((call) => call.sid === sid).map((call) => call.model))
      .toEqual(['model-a', 'model-c']);
  }, 10_000);

  it.each([
    { mode: 'resume' as const, resumeActiveTurn: true },
    { mode: 'restart' as const, resumeActiveTurn: false },
  ])('uses the latest model for a user-initiated $mode retry', async ({
    mode,
    resumeActiveTurn,
  }) => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const sid = state.buildGconvSessionId(cid);

    _selectedModel.value = 'model-a';
    _setScript(sid, [{
      type: 'error',
      text: 'model A failed',
      failureKind: 'model',
      failureCode: 'provider_error',
    }]);
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'original turn' });
    await waitForQuiescent(TEST_UID, cid, 4000);

    _selectedModel.value = 'model-b';
    _setScript(sid, [{ type: 'final', text: `${mode} retry complete` }]);
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `${mode} retry`,
      ...(resumeActiveTurn ? { resumeActiveTurn: true } : {}),
      failedTurnRetryMode: mode,
      retrySourceMessageId: 'original-message',
    });
    await waitForQuiescent(TEST_UID, cid, 4000);

    expect(_recordedCalls.filter((call) => call.sid === sid).map((call) => call.model))
      .toEqual(['model-a', 'model-b']);
  }, 10_000);
});

describe('group_chat bus integration › direct agent handback', () => {
  async function runNamedAgentTurnWithSkillList(skillList: string[] | undefined) {
    const paths = await import('../../../../src/main/paths');
    const agentFile = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
    const raw = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
    if (skillList === undefined) delete raw.skill_list;
    else raw.skill_list = skillList;
    fs.writeFileSync(agentFile, JSON.stringify(raw));
    for (const skillId of skillList || []) {
      const dir = path.join(paths.userSkillsDir(TEST_UID), skillId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: ${skillId}\ndescription: ${skillId}\n---\nbody`);
    }

    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const sid = state.buildGmemberSessionId(cid, AGENT_ID);
    _setScript(sid, [{ type: 'final', text: 'done' }]);
    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `@${AGENT_NAME} write something`,
    });
    await waitForQuiescent(TEST_UID, cid, 5000);
    return _recordedCalls.find((call) => call.sid === sid);
  }

  it('preserves missing Agent skill_list metadata while the registry applies lazy defaults', async () => {
    const call = await runNamedAgentTurnWithSkillList(undefined);
    expect(call).toBeTruthy();
    expect(call!.skillListPresent).toBe(false);
    expect(call!.skillList).toBeUndefined();
  }, 12_000);

  it('preserves an explicit empty Agent skill_list as no shared/public skills', async () => {
    const call = await runNamedAgentTurnWithSkillList([]);
    const paths = await import('../../../../src/main/paths');
    expect(call).toBeTruthy();
    expect(call!.skillListPresent).toBe(true);
    expect(call!.skillList).toEqual([]);
    expect(call!.readOnlyExtraRoots).not.toContain(paths.userSkillsDir(TEST_UID));
    expect(call!.readOnlyExtraRoots).not.toContain(paths.userMarketplaceSkillsDir(TEST_UID));
  }, 12_000);

  it('passes only a configured known Skill for a scoped Agent', async () => {
    const call = await runNamedAgentTurnWithSkillList(['writer-helper']);
    expect(call).toBeTruthy();
    expect(call!.skillListPresent).toBe(true);
    expect(call!.skillList).toEqual(['writer-helper']);
  }, 12_000);

  it('lets a named Agent discover and bind a shared Skill outside skill_list', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
    const skillDir = path.join(paths.userSkillsDir(TEST_UID), 'agent-lazy-analysis');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), [
      '---',
      'name: Agent Lazy Analysis',
      'description: unique cohort variance analysis capability',
      '---',
      'Use the verified analysis workflow.',
    ].join('\n'));

    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: '__call_tool__', name: 'skill_search', input: { query: 'cohort variance' } },
      { type: 'final', text: 'done' },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `@${AGENT_NAME} write something`,
    });
    await waitForQuiescent(TEST_UID, cid, 5000);

    const workerCalls = _recordedCalls.filter((c) => c.sid === state.buildGmemberSessionId(cid, AGENT_ID));
    expect(workerCalls.length).toBeGreaterThan(0);
    for (const call of workerCalls) {
      expect(call.extraToolNames, JSON.stringify(call.extraToolNames)).toContain('skill_search');
      expect(call.extraToolNames, JSON.stringify(call.extraToolNames)).toContain('browser');
    }
    expect(_recordedCalls.filter((c) => c.sid === state.buildGconvSessionId(cid))).toHaveLength(0);
    expect(workerCalls[0].runtimeReadOnlyRoots).toContain(skillDir);
    expect([...workerCalls[0].runtimeSkillBindings!.values()]).toContainEqual(expect.objectContaining({
      id: 'agent-lazy-analysis',
      root: skillDir,
      source: 'custom',
    }));
    const result = _recordedToolResults.find((entry) => entry.name === 'skill_search');
    expect(JSON.parse(result?.content || '{}')).toMatchObject({
      ok: true,
      results: [{ read_path: '@skill/agent-lazy-analysis' }],
    });
  }, 12_000);

  it('keeps invalid and private search results unbound while granting only a returned public Skill', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
    const publicDir = path.join(paths.userSkillsDir(TEST_UID), 'public-risk-helper');
    const privateDir = path.join(paths.userSkillsDir(TEST_UID), 'private-risk-helper');
    fs.mkdirSync(publicDir, { recursive: true });
    fs.mkdirSync(privateDir, { recursive: true });
    fs.writeFileSync(path.join(publicDir, 'SKILL.md'), [
      '---',
      'name: Public Risk Helper',
      'description: publicnebula scenario review capability',
      '---',
      'Public workflow.',
    ].join('\n'));
    fs.writeFileSync(path.join(privateDir, 'SKILL.md'), [
      '---',
      'name: Private Risk Helper',
      'description: privatequasar scenario review capability',
      `ownerAgent: ${AGENT_ID}`,
      '---',
      'Private workflow.',
    ].join('\n'));

    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: '__call_tool__', name: 'skill_search', input: { query: 'scenario review', offset: -1 } },
      { type: '__call_tool__', name: 'skill_search', input: { query: 'privatequasar' } },
      { type: '__call_tool__', name: 'skill_search', input: { query: 'publicnebula' } },
      { type: 'final', text: 'done' },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `@${AGENT_NAME} review the scenario`,
    });
    await waitForQuiescent(TEST_UID, cid, 5000);

    const call = _recordedCalls.find((entry) => entry.sid === state.buildGmemberSessionId(cid, AGENT_ID))!;
    const results = _recordedToolResults
      .filter((entry) => entry.name === 'skill_search')
      .map((entry) => ({ ...entry, parsed: JSON.parse(entry.content) }));
    expect(results).toHaveLength(3);
    expect(results[0].isError).toBe(true);
    expect(results[0].parsed).toMatchObject({ ok: false, error: '`offset` must be a non-negative integer' });
    expect(results[1].parsed).toMatchObject({ ok: true, results: [] });
    expect(results[2].parsed).toMatchObject({
      ok: true,
      results: [{ name: 'Public Risk Helper', read_path: '@skill/public-risk-helper' }],
    });
    expect(call.runtimeReadOnlyRoots).toContain(publicDir);
    expect(call.runtimeReadOnlyRoots).not.toContain(privateDir);
    expect([...call.runtimeSkillBindings!.values()]).toContainEqual(expect.objectContaining({
      id: 'public-risk-helper',
      root: publicDir,
    }));
    expect([...call.runtimeSkillBindings!.values()]).not.toContainEqual(expect.objectContaining({
      id: 'private-risk-helper',
    }));
  }, 12_000);

  it('persists Skill source and forwards same-id tier selections without collapsing them', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
    const storage = await import('../../../../src/main/storage');
    const sid = state.buildGconvSessionId(cid);
    const selections = [
      { kind: 'skill' as const, id: 'same-id', name: 'Shared Skill', source: 'external' as const },
      { kind: 'skill' as const, id: 'same-id', name: 'Shared Skill', source: 'global' as const },
    ];
    _setScript(sid, [{ type: 'final', text: 'Used the selected source.' }]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: '@commander use the selected Skill',
      use_selections: selections,
    });
    await waitForQuiescent(TEST_UID, cid, 5000);

    const call = _recordedCalls.find((entry) => entry.sid === sid);
    expect(call?.forceOpenSkillRefs).toEqual(selections.map(({ kind: _kind, ...selection }) => selection));
    const messages = await storage.readJsonl<any>(
      path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`),
    );
    expect(messages[0].use_selections).toEqual(selections);
  }, 12_000);

  it('grants a directly addressed Agent its user-selected Skill and Connector for this run only', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const selections = [
      { kind: 'skill' as const, id: 'review-helper', name: 'Review helper', source: 'global' as const },
      { kind: 'connector' as const, id: 'notion', name: 'Notion' },
    ];
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: 'final', text: 'Used the selected resources.' },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `@${AGENT_NAME} use the selected resources`,
      use_selections: selections,
    });
    await waitForQuiescent(TEST_UID, cid, 5000);

    const call = _recordedCalls.find((entry) => (
      entry.sid === state.buildGmemberSessionId(cid, AGENT_ID)
    ));
    expect(call?.forceOpenSkillRefs).toEqual([
      { id: 'review-helper', name: 'Review helper', source: 'global' },
    ]);
    expect(call?.runtimeGrantedToolGroups).toEqual(['connectors']);
    expect(call?.runtimeSkillBindings).toBeInstanceOf(Map);
    expect(call?.message).toContain('<runtime-skill-selection source="user">');
    expect(call?.message).toContain('<runtime-connector-selection source="user">');
    expect(call?.message).toContain('list_connector_tools/call_connector_tool');
  }, 12_000);

  it('wakes commander once with the original goal, attachment, and capability report', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
    const storage = await import('../../../../src/main/storage');
    const layout = await import('../../../../src/main/util/project-layout');
    const attachmentDir = layout.chatAttachmentDirForConversation(TEST_UID, cid);
    fs.mkdirSync(attachmentDir, { recursive: true });
    fs.writeFileSync(path.join(attachmentDir, 'brief.txt'), 'school launch video');
    const reference = {
      source_cid: 'source-task',
      source_title: 'Launch notes',
      source_msg_id: 'source-message',
      from_actor: 'user',
      source_ts: '2026-07-22T00:00:00.000Z',
      text: 'Use the quoted school launch requirements.',
    };

    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: 'final', text: 'Video production is outside my declared writing workflow.\n<handback reason="capability_boundary" />' },
    ]);
    _setScript(state.buildGconvSessionId(cid), [
      { type: 'final', text: 'COMMANDER-RECOVERED: I will handle the video workflow.' },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `@${AGENT_NAME} create a school launch video`,
      attachments: ['brief.txt'],
      references: [reference],
    });
    await waitForQuiescent(TEST_UID, cid, 5000);

    const commanderCalls = _recordedCalls.filter((call) => call.sid === state.buildGconvSessionId(cid));
    expect(commanderCalls).toHaveLength(1);
    expect(commanderCalls[0].message).toContain('<agent-handback>');
    expect(commanderCalls[0].message).toContain('"reason": "capability_boundary"');
    expect(commanderCalls[0].message).toContain('create a school launch video');
    expect(commanderCalls[0].message).toContain('outside my declared writing workflow');
    expect(commanderCalls[0].message).toContain('Do not send the unchanged goal back to the same agent');
    expect(commanderCalls[0].message).toContain('Treat the concrete capability report as authoritative');
    expect(commanderCalls[0].message).toContain('do not search for or run shell/process conversion');
    expect(commanderCalls[0].message).toContain('publish an empty or placeholder output');
    expect(commanderCalls[0].message).toContain('brief.txt');
    expect(commanderCalls[0].message).toContain('Use the quoted school launch requirements.');

    const messages = await storage.readJsonl<any>(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`));
    const agentReply = messages.find((message: any) => message.from === AGENT_ID && !message.dispatch);
    const handbackDispatch = messages.find((message: any) => message.from === AGENT_ID && message.dispatch);
    expect(agentReply?.text).toContain('outside my declared writing workflow');
    expect(agentReply?.text).not.toContain('<handback');
    expect(handbackDispatch?.attachments).toEqual(['brief.txt']);
    expect(handbackDispatch?.references).toEqual([reference]);
    expect(messages.some((message: any) => message.from === 'commander'
      && String(message.text || '').includes('COMMANDER-RECOVERED'))).toBe(true);
    // The user picked this agent with an explicit `@` mention, so the capability
    // handback lends the commander THIS turn only. The floor stays with the
    // agent the user chose; their next mention-less message goes back to it.
    const recoveredFloor = await state.readState(TEST_UID, cid);
    expect(recoveredFloor.active_recipient).toBe(AGENT_ID);
    expect(recoveredFloor.active_recipient_source).toBe('user_selection');
  }, 12_000);

  it('does not recursively wake commander when commander sends the same task back to the agent', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const agentSid = state.buildGmemberSessionId(cid, AGENT_ID);
    const commanderSid = state.buildGconvSessionId(cid);

    _setScript(agentSid, [
      { type: 'final', text: 'This needs a different capability.\n<handback reason="capability_boundary" />' },
    ]);
    _setScript(agentSid, [
      { type: 'final', text: 'The capability is still unavailable.\n<handback reason="capability_boundary" />' },
    ]);
    _setScript(commanderSid, [
      { type: '__call_tool__', name: 'hand_off_to', input: { to: AGENT_NAME, message: 'Run the unchanged task again.' } },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: `@${AGENT_NAME} unsupported task` });
    await waitForQuiescent(TEST_UID, cid, 5000);

    expect(_recordedCalls.filter((call) => call.sid === commanderSid)).toHaveLength(1);
    expect(_recordedCalls.filter((call) => call.sid === agentSid)).toHaveLength(2);
    expect(_recordedToolResults.some((result) => result.name === 'hand_off_to')).toBe(true);
  }, 12_000);

  it('coalesces handbacks when one user message directly addresses multiple agents', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
    const secondDir = paths.agentDir(TEST_UID, SECOND_AGENT_ID);
    fs.mkdirSync(secondDir, { recursive: true });
    fs.writeFileSync(path.join(secondDir, 'agent.json'), JSON.stringify({
      agent_id: SECOND_AGENT_ID,
      name: SECOND_AGENT_NAME,
      description: 'Researches things',
      workflow: 'research',
      created_at: 't',
      updated_at: 't',
    }));

    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: 'final', text: 'Writer cannot produce this outcome.\n<handback reason="capability_boundary" />' },
    ]);
    _setScript(state.buildGmemberSessionId(cid, SECOND_AGENT_ID), [
      { type: 'final', text: 'Researcher cannot produce this outcome.\n<handback reason="capability_boundary" />' },
    ]);
    _setScript(state.buildGconvSessionId(cid), [
      { type: 'final', text: 'COMMANDER-COALESCED' },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `@${AGENT_NAME} @${SECOND_AGENT_NAME} unsupported task`,
    });
    await waitForQuiescent(TEST_UID, cid, 5000);

    expect(_recordedCalls.filter((call) => call.sid === state.buildGconvSessionId(cid))).toHaveLength(1);
    expect(_recordedCalls.filter((call) => call.sid === state.buildGmemberSessionId(cid, AGENT_ID))).toHaveLength(1);
    expect(_recordedCalls.filter((call) => call.sid === state.buildGmemberSessionId(cid, SECOND_AGENT_ID))).toHaveLength(1);
  }, 12_000);

  it('does not enqueue another continuation when the user already addressed commander', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');

    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: 'final', text: 'This crosses my capability boundary.\n<handback reason="capability_boundary" />' },
    ]);
    _setScript(state.buildGconvSessionId(cid), [
      { type: 'final', text: 'COMMANDER-ALREADY-ADDRESSED' },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `@${AGENT_NAME} @commander unsupported task`,
    });
    await waitForQuiescent(TEST_UID, cid, 5000);

    expect(_recordedCalls.filter((call) => call.sid === state.buildGconvSessionId(cid))).toHaveLength(1);
    expect(_recordedCalls.filter((call) => call.sid === state.buildGmemberSessionId(cid, AGENT_ID))).toHaveLength(1);
  }, 12_000);

  it.each([
    ['legacy bare marker', '<handback />'],
    ['misapplied completed marker', '<handback reason="completed_handoff" />'],
    ['unknown reason', '<handback reason="done" />'],
    ['conflicting reasons', '<handback reason="capability_boundary" />\n<handback reason="completed_handoff" />'],
  ])('does not fabricate a capability boundary from a direct %s', async (_label, marker) => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
    const storage = await import('../../../../src/main/storage');

    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: 'final', text: `The requested poster is complete.\n${marker}` },
    ]);
    _setScript(state.buildGconvSessionId(cid), [
      { type: 'final', text: 'COMMANDER-HANDLED-EMPTY-REPORT' },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: `@${AGENT_NAME} create the requested poster` });
    await waitForQuiescent(TEST_UID, cid, 5000);

    expect(_recordedCalls.filter((call) => call.sid === state.buildGconvSessionId(cid))).toHaveLength(0);
    const messages = await storage.readJsonl<any>(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`));
    expect(messages.some((message: any) => String(message.text || '').includes('<handback'))).toBe(false);
    expect(messages.some((message: any) => String(message.text || '').includes('The requested poster is complete.'))).toBe(true);
    expect(messages.some((message: any) => String(message.text || '').includes('COMMANDER-HANDLED-EMPTY-REPORT'))).toBe(false);
    expect((await state.readState(TEST_UID, cid)).active_recipient).toBe(AGENT_ID);
    expect((await state.readState(TEST_UID, cid)).active_recipient_source).toBe('user_selection');
  }, 12_000);

  it('does not turn a failed agent runtime into a direct handback continuation', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');

    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: 'final', text: 'The model stream failed.\n<handback reason="capability_boundary" />' },
      { type: 'error', text: 'model stream failed', failureKind: 'model', failureCode: 'stream_failed' },
    ]);
    _setScript(state.buildGconvSessionId(cid), [
      { type: 'final', text: 'WRONG-COMMANDER-CONTINUATION' },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: `@${AGENT_NAME} unsupported task` });
    await waitForQuiescent(TEST_UID, cid, 5000);

    expect(_recordedCalls.filter((call) => call.sid === state.buildGconvSessionId(cid))).toHaveLength(0);
    expect((await state.readState(TEST_UID, cid)).active_recipient).toBe(AGENT_ID);
  }, 12_000);

  it('prefers an input form over handback when a malformed reply contains both controls', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
    const storage = await import('../../../../src/main/storage');
    const formPayload = {
      fields: [{ id: 'topic', label: 'What topic should I write about?', type: 'text', required: true }],
    };

    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      {
        type: 'final',
        text: `I need the topic.\n<handback reason="capability_boundary" />\n<agent-input-form>\n${JSON.stringify(formPayload)}\n</agent-input-form>`,
      },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: `@${AGENT_NAME} write an article` });
    await waitForQuiescent(TEST_UID, cid, 5000);

    expect(_recordedCalls.some((call) => call.sid === state.buildGconvSessionId(cid))).toBe(false);
    const messages = await storage.readJsonl<any>(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`));
    const agentReply = messages.find((message: any) => message.from === AGENT_ID && message.form);
    expect(agentReply?.form?.fields?.[0]?.id).toBe('topic');
    expect(agentReply?.text).not.toContain('<handback');
    expect((await state.readState(TEST_UID, cid)).active_recipient).toBe(AGENT_ID);
  }, 12_000);
});

describe('group_chat bus integration › Commander utility tools', () => {
  it('executes shared Skill search and marketplace boundaries without the retired automation alias', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
    const sid = state.buildGconvSessionId(cid);
    const globalRoot = paths.globalSkillRoots()[0]!;
    const discoveredSkillDir = path.join(globalRoot, 'bus-global-discovery-test');
    const secondSkillDir = path.join(globalRoot, 'zz-bus-global-discovery-test');
    fs.mkdirSync(discoveredSkillDir, { recursive: true });
    fs.writeFileSync(path.join(discoveredSkillDir, 'SKILL.md'), [
      '---',
      'name: Bus Global Discovery Test',
      'description: A unique global Skill used to verify capability admission.',
      '---',
      '',
      '# Private workflow',
    ].join('\n'));
    fs.mkdirSync(secondSkillDir, { recursive: true });
    fs.writeFileSync(path.join(secondSkillDir, 'SKILL.md'), [
      '---',
      'name: ZZ Bus Global Discovery Test',
      'description: A second global Skill used to verify search pagination.',
      '---',
      '',
      '# Second private workflow',
    ].join('\n'));

    _setScript(sid, [
      { type: '__call_tool__', name: 'skill_search', input: { query: '', limit: 1 } },
      { type: '__call_tool__', name: 'skill_search', input: { query: '', limit: 1, offset: 1 } },
      { type: '__call_tool__', name: 'marketplace_search', input: { query: '' } },
      { type: '__call_tool__', name: 'marketplace_request_install', input: { kind: 'invalid' } },
      { type: 'final', text: 'Utility boundaries checked.' },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: '@commander inspect the available utility tools',
    });
    await waitForQuiescent(TEST_UID, cid, 6000);

    const offered = _recordedCalls.find((call) => call.sid === sid)?.extraToolNames ?? [];
    expect(offered).toEqual(expect.arrayContaining([
      'browser',
      'skill_search',
      'marketplace_search',
      'marketplace_request_install',
    ]));
    expect(offered).not.toContain('auto_tasks_list');
    const commanderCall = _recordedCalls.find((call) => call.sid === sid)!;
    expect(commanderCall.readOnlyExtraRoots).not.toContain(globalRoot);
    expect(commanderCall.runtimeReadOnlyRoots).toContain(discoveredSkillDir);
    expect(commanderCall.runtimeReadOnlyRoots).toContain(secondSkillDir);
    const discoveredBindingRoots = Array.from(commanderCall.runtimeSkillBindings?.values() || [])
      .map((binding: any) => binding.root);
    expect(discoveredBindingRoots).toContain(discoveredSkillDir);
    expect(discoveredBindingRoots).toContain(secondSkillDir);
    const contracts = _recordedCalls.find((call) => call.sid === sid)?.extraToolContracts ?? [];
    const byName = (name: string) => contracts.find((tool) => tool.name === name)!;
    expect(byName('skill_search').description).toContain('run-scoped SKILL.md read refs');
    expect(byName('skill_search').description).not.toContain('when available skills');
    expect((byName('skill_search').inputSchema as any).properties.query.description)
      .toContain('English and Chinese');
    expect((byName('skill_search').inputSchema as any).properties.limit.description)
      .toContain('Default: 5');
    expect((byName('skill_search').inputSchema as any).properties.offset.description)
      .toContain('next_offset');
    expect(byName('marketplace_search').description).toContain('without installing');
    expect(byName('marketplace_search').description).not.toContain('only when installed capabilities');
    expect(byName('marketplace_request_install').description).not.toContain('stop and wait');
    expect(byName('dispatch_to').description).not.toContain('canonical conversation history');
    expect(byName('dispatch_to').description).toMatch(/^NON-TERMINAL delegation:/);
    expect(byName('dispatch_to').description).toContain('another dispatch, a tool call, or synthesis across at least two distinct results');
    expect(byName('dispatch_to').description).toContain('summarizing one agent result is not a next action');
    expect((byName('dispatch_to').inputSchema as any).properties.to.description)
      .toContain('Commander and user aliases are invalid');
    expect((byName('dispatch_to').inputSchema as any).properties.message.description)
      .toContain('Omit canonical conversation history');
    expect(byName('hand_off_to').description).not.toContain('Use after any preparation');
    expect(byName('hand_off_to').description).toMatch(/^TERMINAL delegation by default:/);
    expect(byName('hand_off_to').description).toContain('single agent-owned final outcome or interactive experience');
    expect(byName('hand_off_to').description).toContain('ends the commander turn without synthesis');
    expect(byName('hand_off_to').description).toContain('blocks a broader commander-owned task');
    expect((byName('hand_off_to').inputSchema as any).properties.resume.description)
      .toContain('after this agent completes or finishes collecting user input');
    expect(byName('run_worker').description).not.toContain('task must be self-contained');
    expect((byName('run_worker').inputSchema as any).properties.task.description)
      .toContain('Do not assign a coupled milestone chain');
    const results = Object.fromEntries(_recordedToolResults.map((result) => [
      result.name,
      JSON.parse(result.content),
    ]));
    const skillPages = _recordedToolResults
      .filter((result) => result.name === 'skill_search')
      .map((result) => JSON.parse(result.content));
    expect(skillPages).toHaveLength(2);
    expect(skillPages[0]).toMatchObject({
      ok: true,
      has_more: true,
      next_offset: 1,
      results: [{ read_path: '@skill/bus-global-discovery-test' }],
    });
    expect(skillPages[1]).toMatchObject({
      ok: true,
      has_more: false,
      results: [{ read_path: '@skill/zz-bus-global-discovery-test' }],
    });
    expect(skillPages[1]).not.toHaveProperty('next_offset');
    expect(results.skill_search).toMatchObject({
      ok: true,
      results: expect.any(Array),
      has_more: expect.any(Boolean),
    });
    expect(results.skill_search).not.toHaveProperty('query');
    expect(results.skill_search).not.toHaveProperty('rows');
    expect(results.skill_search).not.toHaveProperty('total_matched');
    expect(results.skill_search).not.toHaveProperty('returned');
    for (const row of results.skill_search.results) {
      expect(Object.keys(row).sort()).toEqual(['description', 'name', 'read_path']);
    }
    expect(results.marketplace_search).toMatchObject({ ok: false, error: '`query` is required' });
    expect(results.marketplace_request_install).toMatchObject({
      ok: false,
      error: '`kind` must be agent or skill',
    });
  }, 12_000);

  it('stages open_app_view navigation cards and returns a sanitized app_health snapshot', async () => {
    const cid = newCid();
    const chats = await import('../../../../src/main/features/chats');
    await chats.createConversation(TEST_UID, { conversationId: cid });
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
    const storage = await import('../../../../src/main/storage');
    const sid = state.buildGconvSessionId(cid);

    _setScript(sid, [
      { type: '__call_tool__', name: 'open_app_view', input: { surface_id: 'settings.models' } },
      // A repeated stage of the same surface must not duplicate the card.
      { type: '__call_tool__', name: 'open_app_view', input: { surface_id: 'settings.models' } },
      { type: '__call_tool__', name: 'open_app_view', input: {
        surface_id: 'agents', action: 'configure', target_id: 'agent-123',
      } },
      { type: '__call_tool__', name: 'connector_setup', input: {
        operation: 'start', connector_id: 'xiaohongshu-seller',
      } },
      { type: '__call_tool__', name: 'open_app_view', input: {
        surface_id: 'agents', action: 'configure', target_id: 'agent-123',
      } },
      { type: '__call_tool__', name: 'open_app_view', input: {
        surface_id: 'settings.models', action: 'create',
      } },
      { type: '__call_tool__', name: 'open_app_view', input: {
        surface_id: 'agents', action: 'configure',
      } },
      { type: '__call_tool__', name: 'open_app_view', input: { surface_id: 'not-a-surface' } },
      { type: '__call_tool__', name: 'app_health', input: { domain: 'credentials' } },
      { type: '__call_tool__', name: 'app_health', input: { domain: 'kb' } },
      { type: '__call_tool__', name: 'app_health', input: {} },
      { type: 'final', text: 'Open Models settings from the card below.' },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: '@commander help me set up a model and check app status',
    });
    await waitForQuiescent(TEST_UID, cid, 6000);

    const offered = _recordedCalls.find((call) => call.sid === sid)?.extraToolNames ?? [];
    expect(offered).toEqual(expect.arrayContaining(['browser', 'connector_setup', 'open_app_view', 'app_health']));
    const contracts = _recordedCalls.find((call) => call.sid === sid)?.extraToolContracts ?? [];
    const navContract = contracts.find((tool) => tool.name === 'open_app_view');
    expect(navContract?.description).toContain('Use connector_setup');
    expect(navContract?.inputSchema).toMatchObject({
      type: 'object',
      required: ['surface_id'],
      additionalProperties: false,
      properties: {
        surface_id: { enum: [
          'settings.models', 'settings.general', 'settings.data',
          'connectors', 'library', 'projects', 'agents', 'skills', 'auto', 'apps', 'marketplace',
        ] },
        action: { enum: ['open', 'add_custom', 'configure', 'create'] },
        target_id: { type: 'string', maxLength: 160 },
      },
    });
    expect(contracts.find((tool) => tool.name === 'app_health')?.inputSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      properties: {
        domain: { enum: ['model', 'connectors', 'kb', 'tasks'] },
      },
    });
    expect(contracts.find((tool) => tool.name === 'connector_setup')?.inputSchema).toMatchObject({
      type: 'object',
      required: ['operation'],
      additionalProperties: false,
      properties: {
        operation: { enum: [
          'search', 'inspect', 'start', 'status', 'page_observe', 'page_act', 'page_wait',
        ] },
        query: { type: 'string', maxLength: 160 },
        connector_id: { type: 'string', maxLength: 160 },
      },
    });
    expect(contracts.find((tool) => tool.name === 'browser')?.inputSchema).toMatchObject({
      type: 'object',
      required: ['operation'],
      additionalProperties: false,
      properties: {
        operation: { enum: ['tabs', 'open', 'navigate', 'observe', 'act', 'wait', 'close', 'retain'] },
        url: { type: 'string', maxLength: 2048 },
        page_id: { type: 'string', maxLength: 64 },
      },
    });

    const navResults = _recordedToolResults
      .filter((result) => result.name === 'open_app_view')
      .map((result) => JSON.parse(result.content));
    expect(navResults[0]).toMatchObject({
      ok: true,
      status: 'navigation_card_staged',
      surface_id: 'settings.models',
      action: 'open',
    });
    expect(navResults[1]).toMatchObject({ ok: true, surface_id: 'settings.models', action: 'open' });
    expect(navResults[2]).toMatchObject({
      ok: true, surface_id: 'agents', action: 'configure', target_id: 'agent-123',
    });
    expect(navResults[3]).toMatchObject({
      ok: true, surface_id: 'agents', action: 'configure', target_id: 'agent-123',
    });
    expect(navResults[4]).toMatchObject({ ok: false, error: expect.stringContaining('not supported') });
    expect(navResults[5]).toMatchObject({ ok: false, error: expect.stringContaining('target_id is required') });
    expect(navResults[6]).toMatchObject({ ok: false, error: expect.stringContaining('unknown surface_id') });

    const connectorSetupResults = _recordedToolResults
      .filter((result) => result.name === 'connector_setup')
      .map((result) => JSON.parse(result.content));
    expect(connectorSetupResults).toEqual([expect.objectContaining({
      ok: true,
      operation: 'start',
      connector_id: 'xiaohongshu-seller',
      status: 'setup_card_staged',
    })]);
    expect((await chats.getConversationMetadata(TEST_UID, cid))?.assistance).toEqual({
      kind: 'connector_setup', connector_id: 'xiaohongshu-seller',
    });
    const setupContext = await import('../../../../src/main/features/connector_setup_context');
    expect(connectorSetupResults[0].guidance).toBe(setupContext.connectorSetupGuidance());
    expect(connectorSetupResults[0].connector.setup_guide).toMatchObject({
      available: true, id: 'xiaohongshu-ark',
      entry_url: 'https://ark.xiaohongshu.com/',
      content: expect.stringContaining('production Ark credentials only'),
    });
    expect(await setupContext.formatConnectorSetupForTurn(TEST_UID, cid)).toContain('xiaohongshu-seller');

    const healthResults = _recordedToolResults
      .filter((result) => result.name === 'app_health')
      .map((result) => JSON.parse(result.content));
    // A forged/bypassed enum value must not accidentally widen into a full
    // snapshot. Runtime validation is authoritative even when schema
    // validation did not run.
    expect(healthResults[0]).toEqual({
      ok: false,
      error: 'domain must be one of: model, connectors, kb, tasks',
    });
    // Domain filter returns exactly that probe.
    expect(Object.keys(healthResults[1]).sort()).toEqual(['kb', 'ok']);
    expect(healthResults[1].kb).toMatchObject({ total: expect.any(Number), ready: expect.any(Number) });
    // Full snapshot covers every domain and stays sanitized: no credential or
    // secret-shaped keys may appear anywhere in the payload.
    const full = healthResults[2];
    expect(Object.keys(full).sort()).toEqual(['connectors', 'kb', 'model', 'ok', 'tasks']);
    expect(full.tasks).toMatchObject({
      active_work: expect.any(Boolean),
      active_conversation_count: expect.any(Number),
      other_active_conversation_count: expect.any(Number),
      current_conversation: {
        processing: expect.any(Boolean),
        in_flight_actor_count: expect.any(Number),
        active_turn_count: expect.any(Number),
      },
    });
    expect(JSON.stringify(full)).not.toMatch(/api[_-]?key|authorization|secret|token/i);

    // The deduped card rides the final commander message for the renderer.
    const messages = await storage.readJsonl<any>(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`));
    const finalMsg = messages.find((m: any) => m.from === 'commander' && Array.isArray(m.app_nav_requests));
    expect(finalMsg?.app_nav_requests).toEqual([
      { surface_id: 'settings.models', action: 'open', requested_at: expect.any(String) },
      {
        surface_id: 'agents',
        action: 'configure',
        target_id: 'agent-123',
        requested_at: expect.any(String),
      },
      {
        surface_id: 'connectors',
        action: 'configure',
        target_id: 'xiaohongshu-seller',
        requested_at: expect.any(String),
      },
    ]);
  }, 12_000);

  it('offers the saved Automation for review after the owning workflow succeeds', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const sid = state.buildGconvSessionId(cid);
    _setScript(sid, [{
      type: 'final',
      text: [
        'Automation ready.',
        '<auto-task>',
        '<action>create</action>',
        '<title>Morning review</title>',
        '<content>Summarize yesterday and plan today.</content>',
        '<schedule>{"type":"daily","hour":9,"minute":0}</schedule>',
        '<recipient>{"kind":"commander"}</recipient>',
        '</auto-task>',
      ].join('\n'),
    }]);

    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: 'Create a daily morning review automation',
    });
    await waitForQuiescent(TEST_UID, cid, 6000);

    const rows = await (await import('../../../../src/main/features/group_chat'))
      .readMessages(TEST_UID, cid);
    const reply = rows.find((row: any) => row.from === 'commander' && !row.dispatch);
    expect(reply?.text).not.toContain('<auto-task>');
    expect(reply?.app_nav_requests).toEqual([{
      surface_id: 'auto',
      action: 'configure',
      target_id: expect.stringMatching(/^at_[a-z0-9]+$/),
      requested_at: expect.any(String),
    }]);
  }, 12_000);
});

describe('group_chat bus integration › native Skill package import', () => {
  it('authorizes an attached ZIP from the current turn without requiring its host path in user text', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
    const layout = await import('../../../../src/main/util/project-layout');
    const attachmentName = 'attached-skill.zip';
    const attachmentDir = layout.chatAttachmentDirForConversation(TEST_UID, cid);
    const archive = path.join(attachmentDir, attachmentName);
    fs.mkdirSync(attachmentDir, { recursive: true });
    const zip = new AdmZip();
    zip.addFile('attached-skill/SKILL.md', Buffer.from([
      '---',
      'name: "attached-skill"',
      'description: "Import the attached Skill package"',
      '---',
      '',
      '# Attached Skill',
    ].join('\n')));
    zip.writeZip(archive);

    const sid = state.buildGconvSessionId(cid);
    _setScript(sid, [
      { type: '__call_tool__', name: 'import_skill_package', input: { source_path: archive } },
      { type: 'final', text: 'Imported the attached Skill.' },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: 'Import the attached ZIP as a Skill.',
      attachments: [attachmentName],
    });
    await waitForQuiescent(TEST_UID, cid, 6000);

    expect(_recordedCalls.find((call) => call.sid === sid)?.message).toContain(archive);
    const toolResult = _recordedToolResults.find((result) => result.name === 'import_skill_package');
    expect(JSON.parse(toolResult!.content), toolResult!.content).toMatchObject({
      ok: true,
      installed: [{ skill_id: 'attached-skill' }],
    });
    expect(fs.existsSync(
      path.join(paths.userSkillsDir(TEST_UID), 'attached-skill', 'SKILL.md'),
    )).toBe(true);
  }, 12_000);

  it('imports only the current-turn authorized directory and returns a bounded manifest', async () => {
    const cid = newCid();
    const sourceParent = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-skill-source-'));
    try {
      const source = path.join(sourceParent, 'skill-pack');
      for (const id of ['alpha-skill', 'beta-skill']) {
        const skillDir = path.join(source, id);
        fs.mkdirSync(path.join(skillDir, 'references'), { recursive: true });
        fs.writeFileSync(path.join(skillDir, 'SKILL.md'), [
          '---',
          `name: "${id}"`,
          `description: "Imported ${id}"`,
          '---',
          '',
          `# ${id}`,
        ].join('\n'));
        fs.writeFileSync(path.join(skillDir, 'references', 'large.md'), 'x'.repeat(12_000));
      }

      const state = await import('../../../../src/main/features/group_chat/state');
      const bus = await import('../../../../src/main/features/group_chat/bus');
      const paths = await import('../../../../src/main/paths');
      const storage = await import('../../../../src/main/storage');
      const sid = state.buildGconvSessionId(cid);
      _setScript(sid, [
        { type: '__call_tool__', name: 'import_skill_package', input: { source_path: source } },
        { type: 'final', text: 'Imported both Skills.' },
      ]);

      bus.subscribe(TEST_UID, cid, () => {});
      await bus.enqueue({
        uid: TEST_UID,
        cid,
        fromActorId: 'user',
        text: `Import every Skill from ${source}`,
      });
      await waitForQuiescent(TEST_UID, cid, 6000);

      expect(_recordedCalls.find((call) => call.sid === sid)?.extraToolNames)
        .toContain('import_skill_package');
      const toolResult = _recordedToolResults.find((result) => result.name === 'import_skill_package');
      expect(toolResult).toBeTruthy();
      expect(toolResult!.content.length).toBeLessThan(1500);
      expect(toolResult!.content).not.toContain('x'.repeat(100));
      expect(toolResult!.content).not.toContain('<skill>');
      const parsedToolResult = JSON.parse(toolResult!.content);
      expect(parsedToolResult, toolResult!.content).toMatchObject({
        ok: true,
        installed: [
          { skill_id: 'alpha-skill' },
          { skill_id: 'beta-skill' },
        ],
      });

      for (const id of ['alpha-skill', 'beta-skill']) {
        expect(fs.existsSync(path.join(paths.userSkillsDir(TEST_UID), id, 'SKILL.md'))).toBe(true);
        expect(fs.readFileSync(
          path.join(paths.userSkillsDir(TEST_UID), id, 'references', 'large.md'),
          'utf8',
        )).toHaveLength(12_000);
      }
      const messages = await storage.readJsonl<any>(
        path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`),
      );
      const reply = messages.find((message: any) => message.from === 'commander'
        && String(message.text || '').includes('Imported both Skills.'));
      expect(reply?.created_skills?.map((skill: any) => skill.skill_id).sort())
        .toEqual(['alpha-skill', 'beta-skill']);
    } finally {
      fs.rmSync(sourceParent, { recursive: true, force: true });
    }
  }, 12_000);

  it('rejects a model-selected package path absent as an exact path from the current user turn', async () => {
    const cid = newCid();
    const sourceParent = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-skill-source-'));
    try {
      const source = path.join(sourceParent, 'unauthorized-skill');
      fs.mkdirSync(source, { recursive: true });
      fs.writeFileSync(path.join(source, 'SKILL.md'), [
        '---',
        'name: "unauthorized-skill"',
        'description: "Must not be imported"',
        '---',
        '',
        '# Private',
      ].join('\n'));

      const state = await import('../../../../src/main/features/group_chat/state');
      const bus = await import('../../../../src/main/features/group_chat/bus');
      const paths = await import('../../../../src/main/paths');
      const sid = state.buildGconvSessionId(cid);
      _setScript(sid, [
        { type: '__call_tool__', name: 'import_skill_package', input: { source_path: source } },
        { type: 'final', text: 'Import was not authorized.' },
      ]);

      bus.subscribe(TEST_UID, cid, () => {});
      await bus.enqueue({
        uid: TEST_UID,
        cid,
        fromActorId: 'user',
        text: `Import the different package ${source}-lookalike.`,
      });
      await waitForQuiescent(TEST_UID, cid, 6000);

      const toolResult = _recordedToolResults.find((result) => result.name === 'import_skill_package');
      expect(JSON.parse(toolResult!.content)).toMatchObject({
        ok: false,
        code: 'source_path_not_authorized',
      });
      expect(fs.existsSync(path.join(paths.userSkillsDir(TEST_UID), 'unauthorized-skill'))).toBe(false);
    } finally {
      fs.rmSync(sourceParent, { recursive: true, force: true });
    }
  }, 12_000);

  it('does not authorize a Skill ZIP that was attached only on an earlier turn', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
    const layout = await import('../../../../src/main/util/project-layout');
    const attachmentName = 'earlier-turn-skill.zip';
    const archive = path.join(
      layout.chatAttachmentDirForConversation(TEST_UID, cid),
      attachmentName,
    );
    fs.mkdirSync(path.dirname(archive), { recursive: true });
    const zip = new AdmZip();
    zip.addFile('earlier-turn-skill/SKILL.md', Buffer.from([
      '---',
      'name: "earlier-turn-skill"',
      'description: "Must require a fresh current-turn attachment"',
      '---',
      '',
      '# Earlier turn Skill',
    ].join('\n')));
    zip.writeZip(archive);

    const sid = state.buildGconvSessionId(cid);
    _setScript(sid, [{ type: 'final', text: 'Attachment retained; no import requested.' }]);
    _setScript(sid, [
      { type: '__call_tool__', name: 'import_skill_package', input: { source_path: archive } },
      { type: 'final', text: 'The earlier attachment is not authorized for this turn.' },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: 'Keep this attachment for later; do not import it now.',
      attachments: [attachmentName],
    });
    await waitForQuiescent(TEST_UID, cid, 6000);
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: 'Now import the Skill ZIP from the previous turn.',
    });
    await waitForQuiescent(TEST_UID, cid, 6000);

    const results = _recordedToolResults.filter(
      (result) => result.name === 'import_skill_package',
    );
    expect(results).toHaveLength(1);
    expect(JSON.parse(results[0].content)).toMatchObject({
      ok: false,
      code: 'source_path_not_authorized',
    });
    expect(fs.existsSync(
      path.join(paths.userSkillsDir(TEST_UID), 'earlier-turn-skill'),
    )).toBe(false);
  }, 12_000);

  it('keeps one installed Skill and one created resource when the model retries the same import', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
    const storage = await import('../../../../src/main/storage');
    const sourceParent = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-skill-retry-'));
    try {
      const source = path.join(sourceParent, 'retry-safe-skill');
      fs.mkdirSync(source, { recursive: true });
      fs.writeFileSync(path.join(source, 'SKILL.md'), [
        '---',
        'name: "retry-safe-skill"',
        'description: "A retry-safe native Skill import"',
        '---',
        '',
        '# Retry safe Skill',
      ].join('\n'));

      const sid = state.buildGconvSessionId(cid);
      _setScript(sid, [
        { type: '__call_tool__', name: 'import_skill_package', input: { source_path: source } },
        { type: '__call_tool__', name: 'import_skill_package', input: { source_path: source } },
        { type: 'final', text: 'Imported retry-safe-skill once.' },
      ]);

      bus.subscribe(TEST_UID, cid, () => {});
      await bus.enqueue({
        uid: TEST_UID,
        cid,
        fromActorId: 'user',
        text: `Import the Skill from ${source}`,
      });
      await waitForQuiescent(TEST_UID, cid, 6000);

      const results = _recordedToolResults.filter(
        (result) => result.name === 'import_skill_package',
      );
      expect(results).toHaveLength(2);
      expect(JSON.parse(results[0].content)).toMatchObject({
        ok: true,
        installed: [{ skill_id: 'retry-safe-skill' }],
      });
      expect(JSON.parse(results[1].content)).toMatchObject({
        ok: false,
        code: 'skill_package_import_failed',
      });
      expect(fs.readdirSync(paths.userSkillsDir(TEST_UID)).filter(
        (name) => name.startsWith('retry-safe-skill'),
      )).toEqual(['retry-safe-skill']);
      const messages = await storage.readJsonl<any>(
        path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`),
      );
      const reply = messages.find((message: any) => (
        message.from === 'commander'
        && String(message.text || '').includes('Imported retry-safe-skill once.')
      ));
      expect(reply?.created_skills).toEqual([
        expect.objectContaining({ skill_id: 'retry-safe-skill' }),
      ]);
    } finally {
      fs.rmSync(sourceParent, { recursive: true, force: true });
    }
  }, 12_000);
});

describe('group_chat bus integration › abort sticky across worker post-cleanup', () => {
  it('abort also targets active core-agent sessions by conversation id', async () => {
    const cid = newCid();
    const bus = await import('../../../../src/main/features/group_chat/bus');

    await bus.abort(TEST_UID, cid);

    expect(modelAbortMock).toHaveBeenCalledWith(cid, TEST_UID);
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
      return live ? [...live.executions.values()].find((wk) => wk.running && wk.actor.id === id) : undefined;
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
  it.each(['dispatch_to', 'hand_off_to'])('%s reports a real named execution for the bound backlog id and clears it on settlement', async (toolName) => {
    const projects = await import('../../../../src/main/features/projects');
    const tasks = await import('../../../../src/main/features/project_tasks');
    const chats = await import('../../../../src/main/features/chats');
    const tb = await import('../../../../src/main/features/group_chat/task_board');
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const project = await projects.createProject(TEST_UID, 'Execution visibility');
    if (!project.ok) throw new Error('project fixture failed');
    const pid = project.project.project_id;
    await projects.addAgentBinding(TEST_UID, pid, AGENT_ID);
    const task = await tasks.createTask(TEST_UID, pid, { title: 'Draft announcement', status: 'progress' });
    if (!task.ok) throw new Error('backlog fixture failed');
    const conversation = await chats.createConversation(TEST_UID, { kind: 'normal', projectId: pid });
    const cid = conversation.conversation_id;
    cidsToDrop.add(cid);
    _holdStream('backlog-execution');
    _setScript(state.buildGconvSessionId(cid), [
      { type: '__call_tool__', name: toolName, input: { to: AGENT_NAME, message: 'Draft the announcement.', todo_task_id: task.task.id } },
      { type: 'final', text: toolName === 'dispatch_to' ? 'Ready.' : '' },
    ]);
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: '__wait_for_gate__', name: 'backlog-execution' },
      { type: 'final', text: 'Announcement draft.' },
    ]);
    bus.subscribe(TEST_UID, cid, () => {});
    try {
      await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'Draft the announcement.' });
      expect(await waitUntil(() => tb.backlogExecutionSnapshot(TEST_UID, pid).get(task.task.id)?.is_running === true, 4000)).toBe(true);
      expect(tb.backlogExecutionSnapshot(TEST_UID, pid, cid, { actorId: AGENT_ID }).get(task.task.id)?.is_current_run).toBe(true);
      expect(tb.backlogExecutionSnapshot(TEST_UID, 'other-project').has(task.task.id)).toBe(false);
      _releaseStream('backlog-execution');
      await waitForQuiescent(TEST_UID, cid, 4000);
      expect(tb.backlogExecutionSnapshot(TEST_UID, pid).get(task.task.id)?.is_running).toBe(false);
      expect((await tasks.getTask(TEST_UID, pid, task.task.id))?.status).toBe('progress');
    } finally { _releaseStream('backlog-execution'); }
  }, 12_000);

  it.each(['dispatch_to', 'hand_off_to'])('%s rejects a foreign backlog association before starting an Agent', async (toolName) => {
    const projects = await import('../../../../src/main/features/projects');
    const tasks = await import('../../../../src/main/features/project_tasks');
    const chats = await import('../../../../src/main/features/chats');
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const project = await projects.createProject(TEST_UID, 'Current');
    const foreign = await projects.createProject(TEST_UID, 'Foreign');
    if (!project.ok || !foreign.ok) throw new Error('project fixture failed');
    await projects.addAgentBinding(TEST_UID, project.project.project_id, AGENT_ID);
    const task = await tasks.createTask(TEST_UID, foreign.project.project_id, { title: 'Private work' });
    if (!task.ok) throw new Error('backlog fixture failed');
    const { conversation_id: cid } = await chats.createConversation(TEST_UID, { kind: 'normal', projectId: project.project.project_id });
    cidsToDrop.add(cid);
    _setScript(state.buildGconvSessionId(cid), [
      { type: '__call_tool__', name: toolName, input: { to: AGENT_NAME, message: 'Execute.', todo_task_id: task.task.id } },
      { type: 'final', text: 'Task not found in this project.' },
    ]);
    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'Process the task.' });
    await waitForQuiescent(TEST_UID, cid, 4000);
    expect(_recordedToolResults.find((result) => result.name === toolName)).toMatchObject({ isError: true });
    expect(_recordedCalls.some((call) => call.sid === state.buildGmemberSessionId(cid, AGENT_ID))).toBe(false);
    expect((await tasks.getTask(TEST_UID, foreign.project.project_id, task.task.id))?.status).toBe('todo');
  }, 12_000);

  // A roster mention copied into a structured tool target must reach the
  // same enabled Agent exactly once. Exercise the real executors and durable
  // delivery, not a second implementation of the target parser.
  describe.each(['dispatch_to', 'hand_off_to'] as const)('%s target compatibility', (toolName) => {
    it.each([
      { label: 'plain name', to: AGENT_NAME, name: AGENT_NAME },
      { label: 'canonical ID', to: AGENT_ID, name: AGENT_NAME },
      { label: 'mention with case and outer whitespace', to: '  @wRiTeR  ', name: AGENT_NAME },
      { label: 'ID mention', to: `@${AGENT_ID}`, name: AGENT_NAME },
      { label: 'legacy multi-word name mention', to: '@Writing Helper', name: 'Writing Helper' },
    ])('delivers once for $label', async ({ to, name }) => {
      const cid = newCid();
      const paths = await import('../../../../src/main/paths');
      const specFile = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
      const spec = JSON.parse(fs.readFileSync(specFile, 'utf8'));
      fs.writeFileSync(specFile, JSON.stringify({ ...spec, name }));
      const state = await import('../../../../src/main/features/group_chat/state');
      const bus = await import('../../../../src/main/features/group_chat/bus');
      const brief = 'Draft a short launch announcement.';
      const reply = 'TARGET-COMPATIBILITY: the requested launch announcement.';
      const agentSid = state.buildGmemberSessionId(cid, AGENT_ID);
      _setScript(state.buildGconvSessionId(cid), [
        { type: '__call_tool__', name: toolName, input: { to, message: brief } },
        ...(toolName === 'dispatch_to' ? [{ type: 'final', text: 'The draft is ready.' }] : []),
      ]);
      _setScript(agentSid, [{ type: 'final', text: reply }]);

      bus.subscribe(TEST_UID, cid, () => {});
      await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'Have the writer draft a launch announcement.' });
      await waitForQuiescent(TEST_UID, cid, 4000);

      expect(_recordedToolResults).toHaveLength(1);
      expect(_recordedToolResults[0].isError).toBe(false);
      const agentCalls = _recordedCalls.filter((call) => call.sid === agentSid);
      expect(agentCalls).toHaveLength(1);
      expect(agentCalls[0].message).toContain(brief);
      const messages = fs.readFileSync(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`), 'utf8')
        .split('\n').filter(Boolean).map((line) => JSON.parse(line));
      expect(messages.filter((message: any) => message.dispatch && message.to?.includes(AGENT_ID))).toHaveLength(1);
      expect(messages.filter((message: any) => message.from === AGENT_ID && message.text === reply)).toHaveLength(1);
      if (toolName === 'hand_off_to') {
        expect(JSON.parse(_recordedToolResults[0].content)).toEqual({ ok: true, handed_off_to: AGENT_ID });
      } else {
        expect(_recordedToolResults[0].content).toContain(reply);
      }
    }, 12_000);

    it.each([
      { label: 'unknown mention', to: '@missing-agent', disabled: false },
      { label: 'disabled name mention', to: `@${AGENT_NAME}`, disabled: true },
      { label: 'disabled canonical ID', to: AGENT_ID, disabled: true },
      { label: 'repeated prefix', to: `@@${AGENT_NAME}`, disabled: false },
      { label: 'empty mention', to: '@', disabled: false },
      { label: 'embedded prefix', to: `send@${AGENT_NAME}`, disabled: false },
      { label: 'mention embedded in prose', to: `@${AGENT_NAME} please draft this`, disabled: false },
      { label: 'multiple mentions', to: `@${AGENT_NAME} @${SECOND_AGENT_NAME}`, disabled: false },
      { label: 'Commander mention', to: '@Commander', disabled: false },
      { label: 'user mention', to: '@用户', disabled: false },
    ])('rejects $label without dispatch side effects', async ({ to, disabled }) => {
      const cid = newCid();
      const state = await import('../../../../src/main/features/group_chat/state');
      const bus = await import('../../../../src/main/features/group_chat/bus');
      const paths = await import('../../../../src/main/paths');
      if (disabled) {
        const enabled = await import('../../../../src/main/features/component_enabled');
        enabled.setAgentEnabled(TEST_UID, AGENT_ID, false);
      }
      _setScript(state.buildGconvSessionId(cid), [
        { type: '__call_tool__', name: toolName, input: { to, message: 'Draft the announcement.' } },
        { type: 'final', text: 'The selected target could not be started.' },
      ]);

      bus.subscribe(TEST_UID, cid, () => {});
      await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'Have the selected specialist draft the announcement.' });
      await waitForQuiescent(TEST_UID, cid, 4000);

      expect(_recordedToolResults).toHaveLength(1);
      expect(_recordedToolResults[0].isError).toBe(true);
      expect(JSON.parse(_recordedToolResults[0].content)).toMatchObject({ ok: false, error: expect.any(String) });
      expect(_recordedCalls).toHaveLength(1);
      const members = await state.readMembers(TEST_UID, cid);
      expect(members.actors.some((actor) => actor.kind === 'agent')).toBe(false);
      const messages = fs.readFileSync(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`), 'utf8')
        .split('\n').filter(Boolean).map((line) => JSON.parse(line));
      expect(messages.some((message: any) => message.dispatch)).toBe(false);
    }, 12_000);
  });

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
    expect(workerCall!.skillListPresent).toBe(true);
    expect(workerCall!.skillList).toEqual([]);
    expect(workerCall!.extraToolNames).not.toContain('skill_search');
    expect(workerCall!.extraToolNames).toContain('browser');
    expect(workerCall!.readOnlyExtraRoots).not.toContain(paths.userSkillsDir(TEST_UID));
    expect(workerCall!.readOnlyExtraRoots).not.toContain(paths.userMarketplaceSkillsDir(TEST_UID));

    const commanderCall = _recordedCalls.find((c) => c.sid === state.buildGconvSessionId(cid));
    expect(commanderCall, 'the commander should retain its bounded trusted Skill surface').toBeTruthy();
    expect(commanderCall!.skillListPresent).toBe(false);
    expect(commanderCall!.readOnlyExtraRoots).toContain(paths.userSkillsDir(TEST_UID));
    expect(commanderCall!.readOnlyExtraRoots).toContain(paths.userMarketplaceSkillsDir(TEST_UID));

    // 2) Its FULL result came back SYNCHRONOUSLY as the run_worker tool result,
    //    wrapped as <worker-result> — the handback IS the tool result.
    const toolResult = _recordedToolResults.find((r) => r.name === 'run_worker');
    expect(toolResult, 'run_worker should return its result synchronously').toBeTruthy();
    expect(toolResult!.content).toContain('<worker-result');
    expect(toolResult!.content).toContain(WORKER_RESULT);
    // G4 wiring (step 3b-tail): run_worker is parallel-safe so independent
    // fan-out in one turn runs concurrently (bounded by workerSlots (the anonymous-worker gate)).
    expect(toolResult!.executionMode, 'run_worker must be G4-parallel-safe').toBe('parallel');
    expect(toolResult!.executionTimeoutOwner, 'run_worker child runtime must own its timeout').toBe('executor');

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
    const lingering = live ? [...live.executions.values()].some((wk: any) => wk.actor.kind === 'worker') : false;
    expect(lingering, 'no ephemeral worker should appear in the worker map').toBe(false);
  }, 12_000);

  it('run_worker rejects a legacy named target and directs the caller to dispatch_to', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');

    _setScript(state.buildGconvSessionId(cid), [
      { type: '__call_tool__', name: 'run_worker', input: { to: AGENT_NAME, task: 'make a draft' } },
      { type: 'final', text: 'I corrected the route.' },
    ]);
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: 'final', text: 'SHOULD-NOT-RUN' },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'route this to the named specialist' });
    await waitForQuiescent(TEST_UID, cid, 4000);

    const toolResult = _recordedToolResults.find((result) => result.name === 'run_worker');
    expect(toolResult?.content).toContain('anonymous-only');
    expect(toolResult?.content).toContain('dispatch_to');
    expect(_recordedCalls.some((call) => call.sid === state.buildGmemberSessionId(cid, AGENT_ID))).toBe(false);
    expect(_recordedCalls.some((call) => call.sid.startsWith('gworker-'))).toBe(false);

    const members = await state.readMembers(TEST_UID, cid);
    expect(members.actors.some((actor) => actor.kind === 'worker' || actor.id === AGENT_ID)).toBe(false);
    const messages = fs.readFileSync(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`), 'utf8')
      .split('\n').filter(Boolean).map((line) => JSON.parse(line));
    expect(messages.some((message: any) => String(message.text || '').includes('SHOULD-NOT-RUN'))).toBe(false);
  }, 12_000);

  it.each(['dispatch_to', 'hand_off_to'] as const)(
    '%s identifies an installed Skill target and stops the invalid Agent retry loop',
    async (toolName) => {
      const cid = newCid();
      const state = await import('../../../../src/main/features/group_chat/state');
      const bus = await import('../../../../src/main/features/group_chat/bus');
      const paths = await import('../../../../src/main/paths');
      const skillDir = path.join(paths.userSkillsDir(TEST_UID), 'material-organizer');
      fs.mkdirSync(skillDir, { recursive: true });
      fs.writeFileSync(path.join(skillDir, 'SKILL.md'), [
        '---',
        'name: material-organizer',
        'description: Organize supplied source material.',
        '---',
        '',
        '# Material Organizer',
      ].join('\n'));

      _setScript(state.buildGconvSessionId(cid), [
        {
          type: '__call_tool__',
          name: toolName,
          input: { to: 'material-organizer', message: 'Use this capability.' },
        },
        { type: 'final', text: '请提供需要整理的材料和期望产出。' },
      ]);

      bus.subscribe(TEST_UID, cid, () => {});
      await bus.enqueue({
        uid: TEST_UID,
        cid,
        fromActorId: 'user',
        text: 'material-organizer 技能',
      });
      await waitForQuiescent(TEST_UID, cid, 4000);

      const result = _recordedToolResults.find((entry) => entry.name === toolName);
      expect(result).toBeTruthy();
      expect(JSON.parse(result!.content)).toMatchObject({ ok: false });
      expect(result!.content).toContain('matches an installed Skill, not an Agent');
      expect(result!.content).toContain('Do not retry dispatch_to or hand_off_to');
      expect(result!.content).toContain('ask what they want it to do');
      expect(_recordedCalls.some((call) => call.sid.startsWith('gmember-'))).toBe(false);
    },
    12_000,
  );

  it('resolves an invalid dispatch target against the turn account during an account switch', async () => {
    const paths = await import('../../../../src/main/paths');
    const users = await import('../../../../src/main/features/users');
    const skillDir = path.join(paths.userSkillsDir(TEST_UID), 'account-scoped-skill');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), [
      '---',
      'name: account-scoped-skill',
      'description: Account-scoped test capability.',
      '---',
      '',
      '# Account-scoped Skill',
    ].join('\n'));

    users.activateUser('other-account');
    try {
      const bus = await import('../../../../src/main/features/group_chat/bus');
      const error = await bus._unknownDispatchTargetErrorForTest(TEST_UID, 'account-scoped-skill');
      expect(error).toContain('matches an installed Skill, not an Agent');
    } finally {
      users.activateUser(TEST_UID);
    }
  });

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

    const terminals: any[] = [];
    const unsubscribeTerminal = bus.subscribeTaskTerminals((event) => terminals.push(event));
    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'summarise my workspace' });
    await waitForQuiescent(TEST_UID, cid, 4000);
    expect(await waitUntil(() => terminals.length === 1)).toBe(true);

    const toolResult = _recordedToolResults.find((r) => r.name === 'run_worker');
    expect(toolResult, 'run_worker should return a tool result even when the worker fails').toBeTruthy();
    expect(toolResult!.content).toContain('<worker-error');
    expect(toolResult!.content).toContain('nested worker blew &lt;up&gt; &amp; quit');
    expect(toolResult!.content).not.toContain('<worker-result');
    expect(toolResult!.content).not.toContain('(no textual reply)');
    expect(terminals[0]).toMatchObject({
      status: 'completed',
      recovered: true,
    });
    unsubscribeTerminal();
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
    expect(toolResult!.executionTimeoutOwner, 'dispatch_to child runtime must own its timeout').toBe('executor');

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

  it('an Agent retry restored after app restart wakes Commander for the lost dispatch_to continuation', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const groupChat = await import('../../../../src/main/features/group_chat');
    const paths = await import('../../../../src/main/paths');
    const commanderSid = state.buildGconvSessionId(cid);
    const agentSid = state.buildGmemberSessionId(cid, AGENT_ID);
    const originalGoal = 'RESTART-DISPATCH-GOAL: produce the specialist result and then finish the user task';

    _setScript(commanderSid, [
      {
        type: '__call_tool__',
        name: 'dispatch_to',
        input: {
          to: AGENT_NAME,
          message: 'Run the specialist operation that may need a manual retry.',
          resume: 'After the retried specialist finishes, validate its result and close the original goal.',
        },
      },
      { type: 'final', text: 'The first specialist attempt failed.' },
    ]);
    _setScript(agentSid, [
      {
        type: 'error',
        text: 'specialist process crashed',
        failureKind: 'model',
        failureCode: 'provider_unavailable',
      },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: originalGoal });
    await waitForQuiescent(TEST_UID, cid, 5000);

    let rows = fs.readFileSync(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`), 'utf8')
      .split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const failedAgentReply = rows.find((row: any) => (
      row.from === AGENT_ID && row.failure_code === 'provider_unavailable'
    ));
    expect(failedAgentReply, 'the failed Agent bubble must remain manually retryable').toBeTruthy();
    const dispatchSource = rows.find((row: any) => row.id === failedAgentReply.source_message_id);
    expect(dispatchSource?.commander_retry).toEqual({
      source_tool: 'dispatch_to',
      resume_instruction: 'After the retried specialist finishes, validate its result and close the original goal.',
    });

    // Drop every in-memory worker/listener to model an application restart.
    // Only JSONL/session state remains when the user clicks Retry.
    await bus.dropConv(TEST_UID, cid);
    _setScript(agentSid, [
      { type: 'final', text: 'RETRIED-AGENT-SUCCESS: specialist operation completed and verified.' },
    ]);
    _setScript(commanderSid, [
      { type: 'final', text: 'RESTART-RESUMED-COMMANDER: validated the retried result and closed the goal.' },
    ]);

    const retried = await groupChat.retryFailedTurn({
      userId: TEST_UID,
      cid,
      failedMessageId: failedAgentReply.id,
      visibleText: 'Retry Agent',
      client_msg_id: `retry-${cid}`,
    });
    expect(retried.ok).toBe(true);
    await waitForQuiescent(TEST_UID, cid, 5000);

    const resumeCalls = _recordedCalls.filter((call) => (
      call.sid === commanderSid && call.message.includes('<orchestration-resume>')
    ));
    expect(resumeCalls, 'the retried Agent must wake one new Commander turn').toHaveLength(1);
    expect(resumeCalls[0]?.message).toContain('RETRIED-AGENT-SUCCESS');
    expect(resumeCalls[0]?.message).toContain(originalGoal);
    expect(resumeCalls[0]?.message).toContain('validate its result and close the original goal');

    rows = fs.readFileSync(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`), 'utf8')
      .split('\n').filter(Boolean).map((line) => JSON.parse(line));
    expect(rows.filter((row: any) => row.from === 'commander'
      && String(row.text || '').includes('RESTART-RESUMED-COMMANDER'))).toHaveLength(1);
    const retrySource = rows.find((row: any) => row.client_msg_id === `retry-${cid}`);
    expect(retrySource?.commander_retry?.source_tool).toBe('dispatch_to');
  }, 15_000);

  it('a failed restored Agent retry wakes Commander and preserves continuation for another restart retry', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const groupChat = await import('../../../../src/main/features/group_chat');
    const paths = await import('../../../../src/main/paths');
    const commanderSid = state.buildGconvSessionId(cid);
    const agentSid = state.buildGmemberSessionId(cid, AGENT_ID);
    const originalGoal = 'REPEATED-RETRY-GOAL: finish even if the delegated operation needs two retries';
    const resumeInstruction = 'Inspect every retried terminal result and finish the original goal without losing context.';

    _setScript(commanderSid, [
      {
        type: '__call_tool__',
        name: 'dispatch_to',
        input: {
          to: AGENT_NAME,
          message: 'Run the restart-sensitive delegated operation.',
          resume: resumeInstruction,
        },
      },
      { type: 'final', text: 'The initial delegated attempt failed.' },
    ]);
    _setScript(agentSid, [
      {
        type: 'error',
        text: 'initial delegated provider failure',
        failureKind: 'model',
        failureCode: 'provider_unavailable',
      },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: originalGoal });
    await waitForQuiescent(TEST_UID, cid, 5000);

    let rows = fs.readFileSync(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`), 'utf8')
      .split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const initialFailure = rows.find((row: any) => (
      row.from === AGENT_ID && String(row.text || '').includes('initial delegated provider failure')
    ));
    expect(initialFailure).toBeTruthy();

    await bus.dropConv(TEST_UID, cid);
    _setScript(agentSid, [
      {
        type: 'error',
        text: 'first manual retry still unavailable',
        failureKind: 'model',
        failureCode: 'provider_unavailable',
      },
    ]);
    _setScript(commanderSid, [
      { type: 'final', text: 'FIRST-RETRY-FAILURE-COMMANDER: retained ownership after Agent failure.' },
    ]);

    const firstRetryClientId = `retry-first-${cid}`;
    const firstRetry = await groupChat.retryFailedTurn({
      userId: TEST_UID,
      cid,
      failedMessageId: initialFailure.id,
      visibleText: 'Retry Agent first time',
      client_msg_id: firstRetryClientId,
    });
    expect(firstRetry.ok).toBe(true);
    await waitForQuiescent(TEST_UID, cid, 5000);

    let resumeCalls = _recordedCalls.filter((call) => (
      call.sid === commanderSid && call.message.includes('<orchestration-resume>')
    ));
    expect(resumeCalls, 'a failed retry is still a terminal result Commander must receive').toHaveLength(1);
    expect(resumeCalls[0]?.message).toContain('<worker-error');
    expect(resumeCalls[0]?.message).toContain('Retried Agent execution failed before producing a completed result.');
    expect(resumeCalls[0]?.message).toContain('"status": "failed"');
    expect(resumeCalls[0]?.message).toContain('"error_code": "provider_unavailable"');
    expect(resumeCalls[0]?.message).toContain(originalGoal);
    expect(resumeCalls[0]?.message).toContain(resumeInstruction);

    rows = fs.readFileSync(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`), 'utf8')
      .split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const repeatedFailure = rows.find((row: any) => (
      row.from === AGENT_ID && String(row.text || '').includes('first manual retry still unavailable')
    ));
    expect(repeatedFailure, 'the first manual retry failure must remain retryable').toBeTruthy();
    const firstRetrySource = rows.find((row: any) => row.id === repeatedFailure.source_message_id);
    expect(firstRetrySource?.client_msg_id).toBe(firstRetryClientId);
    expect(firstRetrySource?.commander_retry).toEqual({
      source_tool: 'dispatch_to',
      resume_instruction: resumeInstruction,
    });

    await bus.dropConv(TEST_UID, cid);
    _setScript(agentSid, [
      { type: 'final', text: 'SECOND-MANUAL-RETRY-SUCCESS: delegated operation finally completed.' },
    ]);
    _setScript(commanderSid, [
      { type: 'final', text: 'SECOND-RETRY-SUCCESS-COMMANDER: original goal completed.' },
    ]);

    const secondRetry = await groupChat.retryFailedTurn({
      userId: TEST_UID,
      cid,
      failedMessageId: repeatedFailure.id,
      visibleText: 'Retry Agent second time',
      client_msg_id: `retry-second-${cid}`,
    });
    expect(secondRetry.ok).toBe(true);
    await waitForQuiescent(TEST_UID, cid, 5000);

    resumeCalls = _recordedCalls.filter((call) => (
      call.sid === commanderSid && call.message.includes('<orchestration-resume>')
    ));
    expect(resumeCalls, 'each manual retry terminal result should wake Commander exactly once').toHaveLength(2);
    expect(resumeCalls[1]?.message).toContain('<worker-result');
    expect(resumeCalls[1]?.message).toContain('SECOND-MANUAL-RETRY-SUCCESS');
    expect(resumeCalls[1]?.message).toContain(originalGoal);
    expect(resumeCalls[1]?.message).toContain(resumeInstruction);

    rows = fs.readFileSync(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`), 'utf8')
      .split('\n').filter(Boolean).map((line) => JSON.parse(line));
    expect(rows.filter((row: any) => row.from === 'commander'
      && String(row.text || '').includes('SECOND-RETRY-SUCCESS-COMMANDER'))).toHaveLength(1);
  }, 20_000);

  it('a restored dispatch_to retry that asks for a form resumes Commander only after submission', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const groupChat = await import('../../../../src/main/features/group_chat');
    const paths = await import('../../../../src/main/paths');
    const commanderSid = state.buildGconvSessionId(cid);
    const agentSid = state.buildGmemberSessionId(cid, AGENT_ID);
    const originalGoal = 'RETRY-FORM-GOAL: obtain the missing scope and complete the report';
    const resumeInstruction = 'After the retried Agent receives the form, verify the report and finish the original goal.';
    const formPayload = {
      fields: [{ id: 'scope', label: '范围', type: 'text', required: true }],
    };

    _setScript(commanderSid, [
      {
        type: '__call_tool__',
        name: 'dispatch_to',
        input: {
          to: AGENT_NAME,
          message: 'Prepare the scoped report.',
          resume: resumeInstruction,
        },
      },
      { type: 'final', text: 'The initial report attempt failed.' },
    ]);
    _setScript(agentSid, [
      {
        type: 'error',
        text: 'report provider unavailable',
        failureKind: 'model',
        failureCode: 'provider_unavailable',
      },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: originalGoal });
    await waitForQuiescent(TEST_UID, cid, 5000);

    let rows = fs.readFileSync(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`), 'utf8')
      .split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const initialFailure = rows.find((row: any) => (
      row.from === AGENT_ID && row.failure_code === 'provider_unavailable'
    ));
    expect(initialFailure).toBeTruthy();

    await bus.dropConv(TEST_UID, cid);
    _setScript(agentSid, [
      { type: 'final', text: `请补充报告范围。\n<agent-input-form>\n${JSON.stringify(formPayload)}\n</agent-input-form>` },
    ]);

    const retry = await groupChat.retryFailedTurn({
      userId: TEST_UID,
      cid,
      failedMessageId: initialFailure.id,
      visibleText: 'Retry Agent and provide scope',
      client_msg_id: `retry-form-${cid}`,
    });
    expect(retry.ok).toBe(true);
    await waitForQuiescent(TEST_UID, cid, 5000);

    let orchestration = await state.readState(TEST_UID, cid);
    expect(orchestration.orchestration_ledger).toMatchObject({
      status: 'waiting_for_form',
      blocked_on: 'agent_form',
      source_tool: 'dispatch_to',
      owner_agent_id: AGENT_ID,
      user_goal: originalGoal,
      resume_instruction: resumeInstruction,
    });
    expect(_recordedCalls.filter((call) => (
      call.sid === commanderSid && call.message.includes('<orchestration-resume>')
    )), 'a form is not a terminal Agent result and must not wake Commander yet').toHaveLength(0);

    rows = fs.readFileSync(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`), 'utf8')
      .split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const agentForm = rows.find((row: any) => row.from === AGENT_ID && row.form);
    expect(agentForm).toBeTruthy();
    expect(agentForm.form.form_id).toBe(orchestration.orchestration_ledger?.form_id);

    _setScript(agentSid, [
      { type: 'final', text: 'RETRY-FORM-AGENT-COMPLETE: scoped report produced.' },
    ]);
    _setScript(commanderSid, [
      { type: 'final', text: 'RETRY-FORM-COMMANDER-COMPLETE: verified and delivered the report.' },
    ]);

    const submitRes = await groupChat.markFormSubmittedAndDispatch({
      userId: TEST_UID,
      cid,
      msgId: agentForm.id,
      formId: agentForm.form.form_id,
      values: { scope: 'current release' },
    });
    expect(submitRes.ok).toBe(true);
    await groupChat.send({ userId: TEST_UID, cid, text: submitRes.submission!.text });
    await waitForQuiescent(TEST_UID, cid, 5000);

    orchestration = await state.readState(TEST_UID, cid);
    expect(orchestration.orchestration_ledger).toBeUndefined();
    const resumeCalls = _recordedCalls.filter((call) => (
      call.sid === commanderSid && call.message.includes('<orchestration-resume>')
    ));
    expect(resumeCalls, 'form completion must consume the ledger and wake Commander once').toHaveLength(1);
    expect(resumeCalls[0]?.message).toContain('RETRY-FORM-AGENT-COMPLETE');
    expect(resumeCalls[0]?.message).toContain(originalGoal);
    expect(resumeCalls[0]?.message).toContain(resumeInstruction);

    rows = fs.readFileSync(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`), 'utf8')
      .split('\n').filter(Boolean).map((line) => JSON.parse(line));
    expect(rows.filter((row: any) => row.from === 'commander'
      && String(row.text || '').includes('RETRY-FORM-COMMANDER-COMPLETE'))).toHaveLength(1);
  }, 20_000);

  it('retrying a directly addressed Agent after restart does not invent a Commander continuation', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const groupChat = await import('../../../../src/main/features/group_chat');
    const paths = await import('../../../../src/main/paths');
    const commanderSid = state.buildGconvSessionId(cid);
    const agentSid = state.buildGmemberSessionId(cid, AGENT_ID);

    _setScript(agentSid, [
      {
        type: 'error',
        text: 'direct Agent request failed',
        failureKind: 'model',
        failureCode: 'provider_unavailable',
      },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `@${AGENT_NAME} handle this direct request without Commander`,
    });
    await waitForQuiescent(TEST_UID, cid, 5000);

    let rows = fs.readFileSync(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`), 'utf8')
      .split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const directFailure = rows.find((row: any) => (
      row.from === AGENT_ID && String(row.text || '').includes('direct Agent request failed')
    ));
    expect(directFailure).toBeTruthy();
    const directSource = rows.find((row: any) => row.id === directFailure.source_message_id);
    expect(directSource?.commander_retry).toBeUndefined();

    await bus.dropConv(TEST_UID, cid);
    _setScript(agentSid, [
      { type: 'final', text: 'DIRECT-AGENT-RETRY-SUCCESS: answered the user directly.' },
    ]);

    const retryClientId = `retry-direct-${cid}`;
    const retry = await groupChat.retryFailedTurn({
      userId: TEST_UID,
      cid,
      failedMessageId: directFailure.id,
      visibleText: 'Retry direct Agent request',
      client_msg_id: retryClientId,
    });
    expect(retry.ok).toBe(true);
    await waitForQuiescent(TEST_UID, cid, 5000);

    expect(_recordedCalls.filter((call) => call.sid === commanderSid),
      'ordinary direct-Agent retries must remain outside Commander').toHaveLength(0);
    rows = fs.readFileSync(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`), 'utf8')
      .split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const retrySource = rows.find((row: any) => row.client_msg_id === retryClientId);
    expect(retrySource?.commander_retry).toBeUndefined();
    expect(rows.filter((row: any) => row.from === AGENT_ID
      && String(row.text || '').includes('DIRECT-AGENT-RETRY-SUCCESS'))).toHaveLength(1);
    expect(rows.some((row: any) => String(row.model_text || '').includes('<orchestration-resume>'))).toBe(false);
  }, 15_000);

  it('restores a missing Agent roster entry before persisting and dispatching a failed-turn retry', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const groupChat = await import('../../../../src/main/features/group_chat');
    const paths = await import('../../../../src/main/paths');
    const agentSid = state.buildGmemberSessionId(cid, AGENT_ID);
    const sourceId = `${cid}-source`;
    const failedId = `${cid}-failed`;
    const retryClientId = `retry-missing-roster-${cid}`;

    // A synced/legacy task can retain its authoritative message history while
    // the derived members.json contains only the reserved actors.
    await state.seedReservedActors(TEST_UID, cid);
    const messageFile = path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`);
    fs.writeFileSync(messageFile, [
      JSON.stringify({
        id: sourceId,
        ts: '2026-08-25T09:00:00.000Z',
        from: 'user',
        to: [AGENT_ID],
        text: 'Run the original task.',
        model_text: 'Run the authoritative original task.',
      }),
      JSON.stringify({
        id: failedId,
        ts: '2026-08-25T09:01:00.000Z',
        from: AGENT_ID,
        to: ['user'],
        text: 'The Agent timed out.',
        failure_kind: 'runtime',
        failure_code: 'cli_timeout',
        source_message_id: sourceId,
        turn_id: `${cid}-turn`,
      }),
    ].join('\n') + '\n');
    expect((await state.readMembers(TEST_UID, cid)).actors.some((actor) => actor.id === AGENT_ID))
      .toBe(false);

    _setScript(agentSid, [
      { type: 'final', text: 'MISSING-ROSTER-RETRY-SUCCESS: original task resumed.' },
    ]);

    const retry = await groupChat.retryFailedTurn({
      userId: TEST_UID,
      cid,
      failedMessageId: failedId,
      visibleText: 'Continue',
      client_msg_id: retryClientId,
    });
    expect(retry.ok).toBe(true);
    await waitForQuiescent(TEST_UID, cid, 5000);

    const members = await state.readMembers(TEST_UID, cid);
    expect(members.actors).toContainEqual(expect.objectContaining({
      id: AGENT_ID,
      kind: 'agent',
    }));
    const rows = fs.readFileSync(messageFile, 'utf8')
      .split('\n').filter(Boolean).map((line) => JSON.parse(line));
    expect(rows.find((row: any) => row.client_msg_id === retryClientId)).toMatchObject({
      from: 'user',
      text: 'Continue',
      to: [AGENT_ID],
    });
    expect(rows.some((row: any) => (
      row.from === AGENT_ID
      && String(row.text || '').includes('MISSING-ROSTER-RETRY-SUCCESS')
    ))).toBe(true);
  }, 15_000);

  it.each(['dispatch_to', 'hand_off_to'] as const)(
    '%s relies on canonical history for an unresolved “above” reference without duplicating source snapshots',
    async (sourceTool) => {
      const cid = newCid();
      const state = await import('../../../../src/main/features/group_chat/state');
      const bus = await import('../../../../src/main/features/group_chat/bus');
      const paths = await import('../../../../src/main/paths');

      const ORIGINAL_COPY = [
        'SOURCE-COPY-ASTER-47',
        `A complete article body: ${'tulip-market-detail '.repeat(80)}`,
        'The exact closing sentence is: bubbles end when buyers stop believing.',
      ].join('\n');
      expect(ORIGINAL_COPY.length).toBeGreaterThan(1_600);
      _setScript(state.buildGconvSessionId(cid), [
        { type: 'final', text: 'I have the complete source copy and can route the next task.' },
      ]);
      bus.subscribe(TEST_UID, cid, () => {});
      await bus.enqueue({
        uid: TEST_UID,
        cid,
        fromActorId: 'user',
        text: ORIGINAL_COPY,
      });
      await waitForQuiescent(TEST_UID, cid, 4000);

      const triggerText = sourceTool === 'hand_off_to'
        ? '用上述文案，做一个适合孩子观看的竖版讲解视频。'
        : 'Use the above copy to make a child-friendly vertical explainer.';
      const delegatedTask = sourceTool === 'hand_off_to'
        ? '请基于用户上一条提供的完整文案制作竖版视频，保留原文事实。'
        : 'Use the user\'s previous complete copy; keep its facts and make the tone child-friendly.';
      const toolInput = { to: AGENT_NAME, message: delegatedTask };
      _setScript(state.buildGconvSessionId(cid), [
        { type: '__call_tool__', name: sourceTool, input: toolInput },
        { type: 'final', text: sourceTool === 'dispatch_to' ? 'I incorporated the specialist result.' : 'Handing this to the specialist.' },
      ]);
      _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
        { type: 'final', text: `SPECIALIST-${sourceTool}: source received.` },
      ]);
      const triggerMessage = await bus.enqueue({
        uid: TEST_UID,
        cid,
        fromActorId: 'user',
        text: triggerText,
      });
      await waitForQuiescent(TEST_UID, cid, 4000);

      const agentSid = state.buildGmemberSessionId(cid, AGENT_ID);
      const agentCall = _recordedCalls.filter((call) => call.sid === agentSid).at(-1);
      expect(agentCall, 'the named agent should receive a nested turn').toBeTruthy();
      expect(agentCall!.message).toContain(delegatedTask);
      expect(agentCall!.message).not.toContain('<referenced-messages>');
      expect(agentCall!.message).not.toContain('SOURCE-COPY-ASTER-47');
      expect(agentCall!.message).not.toContain('bubbles end when buyers stop believing.');
      expect(agentCall!.message).not.toContain(triggerText);
      const canonicalHistory = JSON.stringify(agentCall!.conversationHistory);
      expect(canonicalHistory).toContain('SOURCE-COPY-ASTER-47');
      expect(canonicalHistory).toContain('bubbles end when buyers stop believing.');
      expect(canonicalHistory).toContain(triggerText);

      const lines = fs.readFileSync(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`), 'utf-8')
        .split('\n').filter(Boolean).map((line) => JSON.parse(line));
      const dispatch = lines.find((message: any) => (
        message.from === 'commander'
        && message.dispatch === true
        && message.text === delegatedTask
      ));
      expect(dispatch, 'the hidden dispatch source should be persisted').toBeTruthy();
      expect(dispatch.source_message_id).toBe(triggerMessage.id);
      expect(dispatch.references).toBeUndefined();
    },
    20_000,
  );

  it.each(['dispatch_to', 'hand_off_to'] as const)(
    '%s preserves an explicit cross-conversation reference snapshot without adding the trigger as a reference',
    async (sourceTool) => {
      const cid = newCid();
      const state = await import('../../../../src/main/features/group_chat/state');
      const bus = await import('../../../../src/main/features/group_chat/bus');
      const paths = await import('../../../../src/main/paths');

      const triggerText = 'Create the requested deliverable from my quoted source.';
      const delegatedTask = 'Produce the final two-sentence deliverable from the explicit quoted reference.';
      const explicitReference = {
        source_cid: 'other-conversation-47',
        source_title: 'Archived source conversation',
        source_msg_id: 'quoted-message-88',
        from_actor: 'user',
        source_ts: '2026-07-30T08:00:00.000Z',
        text: 'CROSS-CONVERSATION-SNAPSHOT-51: preserve this exact quoted requirement.',
      };
      const toolInput = { to: AGENT_NAME, message: delegatedTask };
      _setScript(state.buildGconvSessionId(cid), [
        { type: '__call_tool__', name: sourceTool, input: toolInput },
        { type: 'final', text: 'The referenced deliverable is ready.' },
      ]);
      _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
        { type: 'final', text: `SPECIALIST-${sourceTool}: explicit reference received.` },
      ]);
      bus.subscribe(TEST_UID, cid, () => {});
      const triggerMessage = await bus.enqueue({
        uid: TEST_UID,
        cid,
        fromActorId: 'user',
        text: triggerText,
        references: [explicitReference],
      });
      await waitForQuiescent(TEST_UID, cid, 4000);

      const agentSid = state.buildGmemberSessionId(cid, AGENT_ID);
      const agentCall = _recordedCalls.filter((call) => call.sid === agentSid).at(-1);
      expect(agentCall).toBeTruthy();
      expect(agentCall!.message).toContain(delegatedTask);
      expect(agentCall!.message).toContain('<referenced-messages>');
      expect(agentCall!.message).toContain('CROSS-CONVERSATION-SNAPSHOT-51');
      expect(agentCall!.message).not.toContain(triggerText);

      const lines = fs.readFileSync(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`), 'utf-8')
        .split('\n').filter(Boolean).map((line) => JSON.parse(line));
      const dispatch = lines.find((message: any) => (
        message.from === 'commander'
        && message.dispatch === true
        && message.text === delegatedTask
      ));
      expect(dispatch, 'the hidden dispatch source should be persisted').toBeTruthy();
      expect(dispatch.source_message_id).toBe(triggerMessage.id);
      expect(dispatch.references).toHaveLength(1);
      expect(dispatch.references[0]).toMatchObject(explicitReference);
      expect(dispatch.references[0].source_msg_id).not.toBe(triggerMessage.id);
    },
    20_000,
  );

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

    const events: any[] = [];
    bus.subscribe(TEST_UID, cid, (event) => events.push(event));
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

    // Live UX must match persisted chronology even when Commander emitted no
    // prose before the parallel tool batch. A dispatch boundary with nothing to
    // persist still closes its segment, so the synthesis belongs to a LATER
    // segment than the turn started in — that is what makes the renderer open
    // it as a new row below the agent replies instead of reusing the row the
    // turn opened above them. (This replaced a live-only `segment_boundary`
    // event that asked the renderer to hide and re-create that row.)
    const synthesisMsg = lines.find((m: any) => m.from === 'commander'
      && String(m.text || '').includes('combined handoff'));
    expect(synthesisMsg?.seg, 'synthesis after an empty dispatch boundary starts a new segment')
      .toBeGreaterThan(0);
    const writerIndex = events.findIndex((event) => (
      event.type === 'message'
      && event.msg?.from === AGENT_ID
      && String(event.msg?.text || '').includes(WRITER_REPLY)
    ));
    const reviewerIndex = events.findIndex((event) => (
      event.type === 'message'
      && event.msg?.from === otherId
      && String(event.msg?.text || '').includes(REVIEWER_REPLY)
    ));
    const synthesisIndex = events.findIndex((event) => (
      event.type === 'message'
      && event.msg?.from === 'commander'
      && String(event.msg?.text || '').includes('combined handoff')
    ));
    expect(writerIndex).toBeGreaterThanOrEqual(0);
    expect(reviewerIndex).toBeGreaterThanOrEqual(0);
    expect(synthesisIndex).toBeGreaterThan(writerIndex);
    expect(synthesisIndex).toBeGreaterThan(reviewerIndex);
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
    _holdStream('segment-agent-delay');
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: '__wait_for_gate__', name: 'segment-agent-delay' },
      { type: 'final', text: AGENT_REPLY },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'make me a draft' });
    // Start the measured delay only after enqueue admission. Starting this
    // timer before enqueue made a busy full-suite run consume part of the
    // intended delegated-agent delay in setup and occasionally report 29 ms.
    setTimeout(() => _releaseStream('segment-agent-delay'), 50);
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
    const preDispatchRuntime = segs[0].process?.find(
      (item: any) => item.event?.stream === 'runtime',
    );
    const synthesisRuntime = segs[1].process?.find(
      (item: any) => item.event?.stream === 'runtime',
    );
    expect(preDispatchRuntime?.event?.data).toMatchObject({
      phase: 'segment_end',
      segment_index: 0,
      duration_ms: expect.any(Number),
    });
    expect(synthesisRuntime?.event?.data).toMatchObject({
      phase: 'end',
      duration_ms: expect.any(Number),
      bubble_duration_ms: expect.any(Number),
    });
    expect(
      synthesisRuntime.event.data.duration_ms - synthesisRuntime.event.data.bubble_duration_ms,
      'delegated-agent wall time must not be charged to the Commander synthesis bubble',
    ).toBeGreaterThanOrEqual(30);

    // Persisted (= reload) order: pre-dispatch seg → agent bubble → synthesis seg.
    const agentMsg = lines.find((m: any) => m.from === AGENT_ID && String(m.text || '').includes(AGENT_REPLY));
    expect(agentMsg, 'agent bubble should persist').toBeTruthy();
    expect(lines.indexOf(segs[0])).toBeLessThan(lines.indexOf(agentMsg));
    expect(lines.indexOf(agentMsg)).toBeLessThan(lines.indexOf(segs[1]));
  }, 12_000);

  // Streaming events must carry the SAME segment identity as the message that
  // later persists that segment. The renderer attributes deltas by
  // `${turn_id}:${seg}`; if a delta lands on the wrong segment (or on none),
  // one segment's text gets split across two bubbles — the long-standing
  // "commander says the same thing twice" defect. The oracle here is
  // independent of the fixture: live delta text is regrouped by the event's own
  // `seg` and compared against what the bus independently persisted.
  it('streaming process events carry the segment identity of the message that persists them', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');

    const PRE = 'Handing this to the writer first.';
    const SYN = 'Here is the summary of that draft.';

    _setScript(state.buildGconvSessionId(cid), [
      { type: 'delta', text: PRE },
      { type: '__call_tool__', name: 'dispatch_to', input: { to: AGENT_NAME, message: 'draft it' } },
      { type: 'delta', text: SYN },
      { type: 'final', text: SYN },
    ]);
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: 'final', text: 'AGENT-SEG-IDENTITY: draft body.' },
    ]);

    const events: any[] = [];
    bus.subscribe(TEST_UID, cid, (ev: any) => { events.push(ev); });
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'make me a draft' });
    await waitForQuiescent(TEST_UID, cid, 4000);

    const commanderDeltas = events.filter((ev) => (
      ev.type === 'process'
      && ev.actor === 'commander'
      && ev.data?.type === 'delta'
      && typeof ev.data?.text === 'string'
    ));
    expect(commanderDeltas.length, 'commander should stream text on both sides of the dispatch').toBeGreaterThan(0);
    // Every streamed token must be attributable — an absent `seg` is exactly the
    // state that forced the renderer to guess which bubble owns the text.
    for (const ev of commanderDeltas) {
      expect(ev.seg, 'every commander delta must carry a segment index').toBeTypeOf('number');
    }

    const streamedBySeg = new Map<number, string>();
    for (const ev of commanderDeltas) {
      streamedBySeg.set(ev.seg, (streamedBySeg.get(ev.seg) || '') + ev.data.text);
    }

    const segMessages = events.filter((ev) => (
      ev.type === 'message'
      && ev.msg?.from === 'commander'
      && ev.msg?.seg !== undefined
    ));
    expect(segMessages.length, 'a visible dispatch splits the turn into two persisted segments').toBe(2);
    for (const ev of segMessages) {
      const seg = ev.msg.seg;
      expect(
        (streamedBySeg.get(seg) || '').trim(),
        `segment ${seg} text streamed live must match what the bus persisted for it`,
      ).toBe(String(ev.msg.text || '').trim());
    }
    // The two segments must not be attributed to the same index, otherwise the
    // renderer would fold the synthesis into the pre-dispatch bubble.
    expect(new Set(segMessages.map((ev) => ev.msg.seg)).size).toBe(2);
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

    const commanderMsgs = lines.filter((m: any) => m.from === 'commander' && !m.dispatch);
    expect(commanderMsgs.length, 'anonymous worker turn stays a single commander bubble').toBe(1);
    // An unsplit turn is segment 0, not "no segment": the renderer addresses a
    // live row by `${turn_id}:${seg}` from the first streamed token, so a reply
    // that omitted `seg` could not resolve the row its own stream wrote to and
    // would render a second bubble beside it.
    expect(commanderMsgs[0].seg, 'an unsplit turn closes segment 0').toBe(0);
  }, 12_000);

  // hand_off_to an INTERACTIVE agent: the agent answers the user, the commander
  // does NOT synthesize (no second commander bubble), and the floor moves to the
  // agent so the user's next no-@ message routes to it.
  it('hand_off_to releases the Commander turn before the scheduled Agent finishes', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');

    _holdStream('terminal-handoff-agent');
    _setScript(state.buildGconvSessionId(cid), [
      { type: '__call_tool__', name: 'hand_off_to', input: { to: AGENT_NAME, message: 'finish independently' } },
    ]);
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: '__wait_for_gate__', name: 'terminal-handoff-agent' },
      { type: 'final', text: 'ASYNC-HANDOFF-COMPLETE' },
    ]);

    const events: any[] = [];
    bus.subscribe(TEST_UID, cid, (event) => events.push(event));
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'delegate this terminally' });

    const agentSid = state.buildGmemberSessionId(cid, AGENT_ID);
    expect(await waitUntil(() => _recordedCalls.some((call) => call.sid === agentSid), 2000),
      'the scheduled Agent should start').toBe(true);

    const live = bus._cidStateForTest(TEST_UID, cid)!;
    const running = [...live.executions.values()].filter((worker) => worker.running);
    expect(running.map((worker) => worker.actor.id),
      'the conversation FIFO cannot start Agent until Commander has released the turn')
      .toEqual([AGENT_ID]);
    expect(live.nestedTurns.size,
      'terminal hand-off must not keep a nested child inside the Commander tool call').toBe(0);
    expect(_recordedToolResults.find((result) => result.name === 'hand_off_to')?.content)
      .toContain('"ok":true');
    expect(events.some((event) => event.type === 'turn_silent'
      && event.actor === 'commander'
      && event.reason === 'terminal_handoff'),
    'the renderer should already have closed the Commander placeholder').toBe(true);
    const agentActive = events.filter((event) => event.type === 'state_changed'
      && Array.isArray(event.active_turns)
      && event.active_turns.some((turn: any) => turn.actor === AGENT_ID));
    expect(agentActive.length).toBeGreaterThan(0);
    expect(agentActive.every((event: any) => event.active_turns
      .filter((turn: any) => turn.actor === AGENT_ID)
      .every((turn: any) => turn.steerable === false)),
    'follow-up user input stays FIFO instead of mutating the admitted hand-off run').toBe(true);

    _releaseStream('terminal-handoff-agent');
    await waitForQuiescent(TEST_UID, cid, 4000);
  }, 12_000);

  it.each(['single', 'manual-commander', 'manual-agent', 'multiple', 'another-waiting-agent'] as const)(
    'interactive automatic selection respects the %s origin and newer user choices', async (scenario) => {
      const cid = newCid();
      const state = await import('../../../../src/main/features/group_chat/state');
      const bus = await import('../../../../src/main/features/group_chat/bus');
      const paths = await import('../../../../src/main/paths');
      const agentFile = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
      const agent = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
      fs.writeFileSync(agentFile, JSON.stringify({ ...agent, interactive: true }));
      const commanderSid = state.buildGconvSessionId(cid);
      const agentSid = state.buildGmemberSessionId(cid, AGENT_ID);
      if (scenario === 'another-waiting-agent') {
        const board = await import('../../../../src/main/features/group_chat/task_board');
        const waiting = await board.createTask(TEST_UID, cid, {
          assignee: SECOND_AGENT_ID, instruction: 'need an answer', createdBy: 'user',
        });
        await board.finishTask(TEST_UID, cid, waiting.task_id, 'waiting_input');
      }
      _holdStream('recipient-choice');
      _setScript(commanderSid, [
        { type: '__wait_for_gate__', name: 'recipient-choice' },
        { type: '__call_tool__', name: 'hand_off_to', input: { to: AGENT_NAME, message: 'ask the user for details' } },
      ]);
      _setScript(agentSid, [{ type: 'final', text: 'What details should I use?' }]);
      await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user',
        text: scenario === 'multiple' ? `@commander coordinate @${AGENT_NAME} inspect` : 'help with this' });
      expect(await waitUntil(() => _recordedCalls.some((c) => c.sid === commanderSid))).toBe(true);
      if (scenario === 'manual-commander' || scenario === 'manual-agent') {
        await state.setActiveRecipient(TEST_UID, cid,
          scenario === 'manual-agent' ? AGENT_ID : 'commander', 'user_selection');
      }
      _releaseStream('recipient-choice');
      await waitForQuiescent(TEST_UID, cid, 6000);
      expect(_recordedToolResults.some((r) => r.name === 'hand_off_to' && r.content.includes('"ok":true'))).toBe(true);
      const floor = await state.readState(TEST_UID, cid);
      expect(floor.active_recipient).toBe(scenario === 'single' || scenario === 'manual-agent' ? AGENT_ID : undefined);
      if (scenario === 'single' || scenario === 'manual-agent') {
        _setScript(agentSid, [{ type: 'final', text: 'Finished. <handback />' }]);
        await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'those are all the details' });
        await waitForQuiescent(TEST_UID, cid, 6000);
        expect((await state.readState(TEST_UID, cid)).active_recipient)
          .toBe(scenario === 'manual-agent' ? AGENT_ID : undefined);
      }
    }, 15_000,
  );

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

    // Gap-B "thinking placeholder" signal: after Commander releases its turn,
    // the queued tutor must surface in `active_turns` before its first token.
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
      'the delegated turn must expose a stable execution start for elapsed-time recovery',
    ).toBe(true);
    expect(
      tutorActive.every((e: any) => e.active_turns
        .filter((t: any) => t.actor === tutorId)
        .every((t: any) => t.steerable === false)),
      'terminal hand-offs must never advertise active-turn user ingress',
    ).toBe(true);
    expect(
      tutorActive.every((e: any) => !e.active_turns.some((t: any) => t.actor === 'commander')),
      'the released commander must not co-appear in active_turns while the tutor runs',
    ).toBe(true);
    // Commander narrated its prep but did NOT synthesize on top (no "已完成"-style
    // second bubble). The only commander message is the pre-handoff narration —
    // and it must be NON-EMPTY: a trailing empty commander bubble (e.g. one that
    // only carried a produced-file chip) is the regression we are guarding.
    const dispatchMsgs = lines.filter((m: any) => m.from === 'commander' && m.dispatch);
    expect(dispatchMsgs).toHaveLength(1);
    expect(dispatchMsgs[0].text).toBe('teach the user this paper');
    const tutorReply = lines.find((m: any) => m.from === tutorId && String(m.text || '').includes(TUTOR_REPLY));
    expect(tutorReply?.source_message_id).toBe(dispatchMsgs[0].id);
    const commanderMsgs = lines.filter((m: any) => m.from === 'commander' && !m.dispatch);
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
    const commanderRows = rows.filter((row: any) => row.from === 'commander' && !row.dispatch);
    expect(commanderRows, 'only the narrated pre-dispatch segment should persist').toHaveLength(1);
    expect(commanderRows[0].text).toContain('资料搜集已基本完备');
    expect(commanderRows[0].process.some((item: any) => item.event?.stream === 'compaction'),
      'pre-dispatch compaction belongs to the pre-dispatch segment').toBe(true);
    expect(commanderRows[0].process.some((item: any) => item.event?.data?.name === 'manage_execution_plan'),
      'pre-dispatch planning attempts belong to the pre-dispatch segment').toBe(true);
    const commanderRuntime = commanderRows[0].process.find(
      (item: any) => item.event?.stream === 'runtime'
        && item.event?.data?.phase === 'segment_end'
        && item.event?.data?.segment_index === 0,
    );
    expect(commanderRuntime?.event?.data?.duration_ms,
      'the visible pre-handoff commander bubble must persist its own runtime')
      .toEqual(expect.any(Number));
    expect(commanderRows.some((row: any) => !String(row.text || '').trim()),
      'terminal delivery must not persist an empty commander process/runtime record').toBe(false);
    expect(events.some((ev) => ev.type === 'process'
      && ev.actor === 'commander'
      && ev.data?.event?.stream === 'runtime'
      && ev.data?.event?.data?.phase === 'segment_end'),
    'renderer must receive the segment runtime before the bubble finalizes').toBe(true);
    const commanderSegmentIndex = events.findIndex((ev) => ev.type === 'message'
      && ev.msg?.from === 'commander'
      && String(ev.msg?.text || '').includes('资料搜集已基本完备'));
    const segmentBoundaryIndex = events.findIndex((ev, index) => index > commanderSegmentIndex
      && ev.type === 'segment_boundary'
      && ev.actor === 'commander');
    const specialistActiveIndex = events.findIndex((ev) => ev.type === 'state_changed'
      && Array.isArray(ev.active_turns)
      && ev.active_turns.some((turn: any) => turn.actor === AGENT_ID));
    expect(commanderSegmentIndex,
      'the narrated pre-handoff segment must reach the renderer').toBeGreaterThanOrEqual(0);
    expect(segmentBoundaryIndex,
      'the finalized segment must suppress a second live Commander placeholder')
      .toBeGreaterThan(commanderSegmentIndex);
    expect(specialistActiveIndex,
      'the delegated agent should become active after Commander is suppressed')
      .toBeGreaterThan(segmentBoundaryIndex);
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
    expect(rows.filter((row: any) => row.from === 'commander' && !row.dispatch),
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
    const manualFloor = await state.readState(TEST_UID, cid);
    expect(manualFloor.active_recipient).toBe(AGENT_ID);
    expect(manualFloor.active_recipient_source).toBe('user_selection');

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
    expect((await state.readState(TEST_UID, cid)).active_recipient_source).toBe('user_selection');
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

  it('aborting a scheduled interactive hand-off cancels the Agent and clears Commander-owned resume state', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');

    const agentId = 'acab12344321';
    const agentName = 'SlowCoach';
    const agentDir = paths.agentDir(TEST_UID, agentId);
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'agent.json'), JSON.stringify({
      agent_id: agentId,
      name: agentName,
      description: 'waits for a bounded external operation',
      workflow: 'work until complete or cancelled',
      interactive: true,
      created_at: 't',
      updated_at: 't',
    }));

    _setScript(state.buildGconvSessionId(cid), [
      {
        type: '__call_tool__',
        name: 'hand_off_to',
        input: {
          to: agentName,
          message: 'run the long operation',
          resume: 'After the operation, finish the original request.',
        },
      },
    ]);
    _setScript(state.buildGmemberSessionId(cid, agentId), [
      { type: '__wait_for_abort__' },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'start the long operation' });
    expect(await waitUntil(() => _recordedCalls.some((call) => (
      call.sid === state.buildGmemberSessionId(cid, agentId)
    )), 2000), 'the Agent should own the live turn before cancellation').toBe(true);

    let current = await state.readState(TEST_UID, cid);
    expect(current.active_recipient).toBe(agentId);
    expect(current.orchestration_ledger?.owner_agent_id).toBe(agentId);

    await bus.abort(TEST_UID, cid);
    await waitForQuiescent(TEST_UID, cid, 4000);

    current = await state.readState(TEST_UID, cid);
    expect(current.status).toBe('aborted');
    expect(current.active_recipient).toBeUndefined();
    expect(current.orchestration_ledger).toBeUndefined();
    expect(_recordedCalls.filter((call) => (
      call.sid === state.buildGconvSessionId(cid)
      && call.message.includes('<orchestration-resume>')
    ))).toHaveLength(0);
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
      { type: 'final', text: 'The user wants normal chat prompts to trigger specialist routing when quality improves.\n<handback reason="completed_handoff" />' },
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
    expect(resumeCall?.message).toContain('"handback_reason": "completed_handoff"');

    const lines = fs.readFileSync(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`), 'utf-8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    expect(lines.some((m: any) => m.dispatch === true && m.to.includes('commander')
      && String(m.model_text || '').includes('<orchestration-resume>'))).toBe(true);
    expect(lines.some((m: any) => m.from === 'commander'
      && String(m.text || '').includes('RESUMED-COMMANDER'))).toBe(true);
  }, 15_000);

  // A form submission parks the ledger in `waiting_for_form`, so the agent-side
  // take returns null even though an orchestration IS pending. That used to fall
  // through to the direct-handback wake WHILE the form branch also resumed —
  // Commander ran twice and persisted two identical syntheses. Exactly one wake.
  it('wakes commander once when a form submission and a handback land in the same agent turn', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');

    const coachId = 'aa11bb22cc33';
    const coachName = 'FormCoach';
    const coachDir = paths.agentDir(TEST_UID, coachId);
    fs.mkdirSync(coachDir, { recursive: true });
    fs.writeFileSync(path.join(coachDir, 'agent.json'), JSON.stringify({
      agent_id: coachId, name: coachName, description: 'collects scope through a form', workflow: 'coach',
      interactive: true, created_at: 't', updated_at: 't',
    }));

    const commanderSid = state.buildGconvSessionId(cid);
    _setScript(commanderSid, [
      {
        type: '__call_tool__',
        name: 'hand_off_to',
        input: {
          to: coachName,
          message: 'Collect the research scope first.',
          resume: 'After FormCoach hands back, summarize the confirmed scope.',
        },
      },
      { type: 'final', text: 'Handing this to FormCoach.' },
    ]);
    _setScript(state.buildGmemberSessionId(cid, coachId), [
      {
        type: 'final',
        text: [
          'I need the research question first.',
          '<agent-input-form>',
          JSON.stringify({
            agent_id: coachId,
            fields: [{ id: 'question', label: 'Research question', type: 'textarea', required: true }],
          }),
          '</agent-input-form>',
          '<plan-interaction status="open" />',
        ].join('\n'),
      },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'Plan the research, ask me what you need' });
    await waitForQuiescent(TEST_UID, cid, 4000);

    let st = await state.readState(TEST_UID, cid);
    expect(st.orchestration_ledger?.status, 'the form parks the ledger').toBe('waiting_for_form');
    expect(st.orchestration_ledger?.owner_agent_id).toBe(coachId);
    const formId = String(st.orchestration_ledger?.form_id || '');
    expect(formId).toBeTruthy();

    // The submission turn: the agent answers AND hands back in one reply.
    _setScript(state.buildGmemberSessionId(cid, coachId), [
      { type: 'final', text: 'Scope confirmed: enterprise adoption risk.\n<handback />' },
    ]);
    _setScript(commanderSid, [
      { type: 'final', text: 'RESUMED-ONCE: the confirmed scope is enterprise adoption risk.' },
    ]);

    const submission = [
      '- Research question：enterprise adoption risk',
      '',
      `<agent-input-submission form_id="${formId}" agent_id="${coachId}">`,
      JSON.stringify({ question: 'enterprise adoption risk' }),
      '</agent-input-submission>',
    ].join('\n');
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: submission });
    await waitForQuiescent(TEST_UID, cid, 4000);

    st = await state.readState(TEST_UID, cid);
    expect(st.orchestration_ledger, 'the ledger is consumed exactly once').toBeUndefined();

    const lines = fs.readFileSync(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`), 'utf-8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    // Count the WAKES, not the replies: a scripted model stops producing text
    // once its script is consumed, so a second commander turn would leave no
    // second bubble here even though it really ran and burned a model call.
    const commanderWakes = lines.filter((m: any) => m.dispatch === true
      && Array.isArray(m.to) && m.to.includes('commander'));
    expect(
      commanderWakes.length,
      'the form resume and the hand-back must not both wake commander',
    ).toBe(1);
    expect(String(commanderWakes[0]?.model_text || '')).toContain('<orchestration-resume>');
    expect(String(commanderWakes[0]?.model_text || '')).toContain('"handback_reason": "legacy_unspecified"');
    const resumedReplies = lines.filter((m: any) => m.from === 'commander'
      && !m.dispatch
      && String(m.text || '').includes('RESUMED-ONCE'));
    expect(resumedReplies.length, 'commander synthesizes once').toBe(1);
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

  it.each(['dispatch_to', 'hand_off_to'] as const)(
    'Commander-owned recovery resumes after an interactive Agent form independently of source tool: %s',
    async (sourceTool) => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const groupChat = await import('../../../../src/main/features/group_chat');
    const paths = await import('../../../../src/main/paths');

    const builderId = 'cafe11112222';
    const builderName = 'RecoveryBuilder';
    const builderDir = paths.agentDir(TEST_UID, builderId);
    fs.mkdirSync(builderDir, { recursive: true });
    fs.writeFileSync(path.join(builderDir, 'agent.json'), JSON.stringify({
      agent_id: builderId,
      name: builderName,
      description: 'repairs and validates artifact manifests',
      workflow: 'repair the known artifact and return the completed result',
      interactive: true,
      created_at: 't',
      updated_at: 't',
    }));

    const commanderSid = state.buildGconvSessionId(cid);
    const builderSid = state.buildGmemberSessionId(cid, builderId);
    _setScript(commanderSid, [
      {
        type: '__call_tool__',
        name: sourceTool,
        input: {
          to: builderName,
          message: 'Repair the known manifest blocker and continue the original export.',
          resume: 'Consume the completed repair, verify it, and close the original export goal as Commander.',
        },
      },
      { type: 'final', text: '' },
    ]);
    _setScript(builderSid, [
      {
        type: 'final',
        text: [
          '需要确认唯一的恢复范围。',
          '<agent-input-form>',
          JSON.stringify({
            fields: [{
              id: 'repair_scope',
              label: '恢复范围',
              type: 'select',
              required: true,
              default: 'manifest_only',
              options: [{ value: 'manifest_only', label: '仅修复登记并继续导出' }],
            }],
          }),
          '</agent-input-form>',
        ].join('\n'),
      },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `RECOVERY_OWNERSHIP_TEST_${sourceTool} 你修复上一个 Agent 报告的问题，然后继续完成原任务`,
    });
    await waitForQuiescent(TEST_UID, cid, 4000);

    let st = await state.readState(TEST_UID, cid);
    if (sourceTool === 'hand_off_to') {
      expect(st.active_recipient,
        'an explicit interactive hand-off may temporarily give the Agent the floor').toBe(builderId);
    } else {
      expect(st.active_recipient,
        'an in-loop specialist execution must not move the Commander floor').toBeUndefined();
    }
    expect(st.orchestration_ledger?.status).toBe('waiting_for_form');
    expect(st.orchestration_ledger?.source_tool).toBe(sourceTool);
    expect(st.orchestration_ledger?.user_goal).toContain(`RECOVERY_OWNERSHIP_TEST_${sourceTool}`);
    expect(st.orchestration_ledger?.resume_instruction).toContain('close the original export goal');

    let rows = fs.readFileSync(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`), 'utf8')
      .split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const builderForm = rows.find((row: any) => row.from === builderId && row.form);
    expect(builderForm).toBeTruthy();

    _setScript(builderSid, [
      {
        type: 'final',
        text: [
          'RECOVERY-BUILDER-COMPLETE: manifest repaired, validated, and original export completed.',
          ...(sourceTool === 'hand_off_to' ? ['<handback reason="completed_handoff" />'] : []),
        ].join('\n'),
      },
    ]);
    _setScript(commanderSid, [
      { type: 'final', text: 'RECOVERY-COMMANDER-COMPLETE: verified the repair result and closed the original goal.' },
    ]);

    const submitRes = await groupChat.markFormSubmittedAndDispatch({
      userId: TEST_UID,
      cid,
      msgId: builderForm.id,
      formId: builderForm.form.form_id,
      values: { repair_scope: 'manifest_only' },
    });
    expect(submitRes.ok).toBe(true);
    await groupChat.send({ userId: TEST_UID, cid, text: submitRes.submission!.text });
    await waitForQuiescent(TEST_UID, cid, 4000);

    st = await state.readState(TEST_UID, cid);
    expect(st.active_recipient,
      'once the Agent result resumes Commander, the prior execution tool must not leave the floor behind').toBeUndefined();
    expect(st.orchestration_ledger).toBeUndefined();
    const resumeCalls = _recordedCalls.filter((call) => (
      call.sid === commanderSid && call.message.includes('<orchestration-resume>')
    ));
    expect(resumeCalls,
      'a submitted form plus completed_handoff must consume one ledger and wake Commander once')
      .toHaveLength(1);
    const resumeCall = resumeCalls[0];
    expect(resumeCall?.message).toContain('RECOVERY-BUILDER-COMPLETE');
    expect(resumeCall?.message).toContain('close the original export goal');

    rows = fs.readFileSync(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`), 'utf8')
      .split('\n').filter(Boolean).map((line) => JSON.parse(line));
    expect(rows.filter((row: any) => row.from === 'commander'
      && String(row.text || '').includes('RECOVERY-COMMANDER-COMPLETE'))).toHaveLength(1);
    },
    15_000,
  );

  it.each(['dispatch_to', 'hand_off_to'] as const)(
    'Commander can close an Agent runtime failure independently of execution shape: %s',
    async (sourceTool) => {
      const cid = newCid();
      const state = await import('../../../../src/main/features/group_chat/state');
      const bus = await import('../../../../src/main/features/group_chat/bus');
      const paths = await import('../../../../src/main/paths');
      const commanderSid = state.buildGconvSessionId(cid);
      const agentSid = state.buildGmemberSessionId(cid, AGENT_ID);
      const completion = `COMMANDER-RUNTIME-RECOVERY-${sourceTool}`;

      _setScript(commanderSid, [
        {
          type: '__call_tool__',
          name: sourceTool,
          input: {
            to: AGENT_NAME,
            message: 'Attempt the bounded specialist operation.',
            resume: 'If the Agent cannot run, keep the original goal with Commander and close it through a viable fallback.',
          },
        },
        { type: 'final', text: sourceTool === 'hand_off_to' ? 'terminal hand-off placeholder' : completion },
      ]);
      if (sourceTool === 'hand_off_to') {
        _setScript(commanderSid, [
          { type: 'final', text: completion },
        ]);
      }
      _setScript(agentSid, [
        {
          type: 'error',
          text: 'specialist provider unavailable',
          failureKind: 'model',
          failureCode: 'provider_unavailable',
        },
      ]);

      bus.subscribe(TEST_UID, cid, () => {});
      await bus.enqueue({
        uid: TEST_UID,
        cid,
        fromActorId: 'user',
        text: `RUNTIME_RECOVERY_${sourceTool} complete this goal even if the specialist cannot run`,
      });
      await waitForQuiescent(TEST_UID, cid, 5000);

      const rows = fs.readFileSync(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`), 'utf8')
        .split('\n').filter(Boolean).map((line) => JSON.parse(line));
      expect(rows.some((row: any) => row.from === 'commander'
        && String(row.text || '').includes(completion))).toBe(true);
      const st = await state.readState(TEST_UID, cid);
      expect(st.active_recipient).toBeUndefined();
      expect(st.orchestration_ledger).toBeUndefined();
      if (sourceTool === 'hand_off_to') {
        const wake = rows.find((row: any) => row.dispatch === true
          && Array.isArray(row.to)
          && row.to.includes('commander')
          && String(row.model_text || '').includes('<orchestration-resume>'));
        expect(String(wake?.model_text || '')).toContain('"agent_terminal"');
        expect(String(wake?.model_text || '')).toContain('"status": "failed"');
        expect(String(wake?.model_text || '')).toContain('"error_code": "provider_unavailable"');
      }
    },
    15_000,
  );

});

describe('group_chat bus integration › task terminal boundary', () => {
  it('denies pending approvals when the active account changes', async () => {
    const users = await import('../../../../src/main/features/users');
    // Loading the bus mirrors the real runtime and exposes the synchronous
    // account-switch cleanup hook used by activateUser.
    await import('../../../../src/main/features/group_chat/bus');
    const bashPermissions = await import('../../../../src/main/model/core-agent/bash-permissions');
    const pushes: Array<{ channel: string; payload: any }> = [];
    bashPermissions._resetForTest();
    bashPermissions._setBroadcastForTest((channel, payload) => {
      pushes.push({ channel, payload });
    });

    const decision = bashPermissions.requestBashDecision({
      uid: TEST_UID,
      cid: 'account-switch-cid',
      agentId: 'commander',
      agentName: 'Commander',
      command: 'rm protected.txt',
      reasons: ['destructive'],
    });
    const requestId = pushes.find((item) => item.channel === 'bash:permission')?.payload.request_id;
    expect(requestId).toBeTruthy();

    users.activateUser('u2-account-switch');
    await expect(decision).resolves.toBe('deny');
    expect(bashPermissions.respond(requestId, 'allow_run')).toBe(false);
    expect(pushes).toContainEqual(expect.objectContaining({
      channel: 'bash:permission_cancelled',
      payload: expect.objectContaining({ uid: TEST_UID }),
    }));
    users.activateUser(TEST_UID);
  });

  it('emits one completed event only after the whole user-triggered run is quiescent', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
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

  it('preserves a convergence stop instead of promoting its persisted fallback to completed', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const taskBoard = await import('../../../../src/main/features/group_chat/task_board');
    const paths = await import('../../../../src/main/paths');
    const terminals: any[] = [];
    const unsubscribe = bus.subscribeTaskTerminals((event) => terminals.push(event));

    _setScript(state.buildGconvSessionId(cid), [
      {
        type: 'event',
        event: {
          stream: 'agent_run_result',
          data: {
            run_kind: 'top_level',
            terminal_status: 'stopped',
            convergence_signals: ['no_progress_stop'],
          },
        },
      },
      { type: 'final', text: 'Execution stopped after a bounded no-progress window.' },
    ]);
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'finish this task' });
    await waitForQuiescent(TEST_UID, cid, 3000);
    expect(await waitUntil(() => terminals.length === 1)).toBe(true);

    expect(terminals[0]).toMatchObject({
      user_id: TEST_UID,
      conversation_id: cid,
      status: 'stopped',
    });
    expect(terminals[0].failure).toBeUndefined();
    expect((await taskBoard.listTasks(TEST_UID, cid)).at(-1)?.status).toBe('stopped');
    const stats = JSON.parse(fs.readFileSync(paths.commanderRuntimeStatsFile(TEST_UID), 'utf8'));
    expect(stats).toMatchObject({
      attempts: 1,
      successes: 0,
      execution_failures: 0,
      failures: 0,
      errors: 0,
    });
    unsubscribe();
  }, 10_000);

  it('attaches retry mode and uncertainty count to the actual post-retry terminal result', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
    const terminals: any[] = [];
    const unsubscribe = bus.subscribeTaskTerminals((event) => terminals.push(event));

    _setScript(state.buildGconvSessionId(cid), [
      { type: 'final', text: 'retry completed' },
    ]);
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: 'continue',
      failedTurnRetryMode: 'resume',
      retrySourceMessageId: 'source-message',
      retryUncertainOperationCount: 2,
    });
    await waitForQuiescent(TEST_UID, cid, 3000);
    expect(await waitUntil(() => terminals.length === 1)).toBe(true);

    expect(terminals[0]).toMatchObject({
      status: 'completed',
      retry_mode: 'resume',
      uncertain_operation_count: 2,
    });
    unsubscribe();
  }, 10_000);

  it('classifies model errors as failed', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
    const terminals: any[] = [];
    const unsubscribe = bus.subscribeTaskTerminals((event) => terminals.push(event));

    _setScript(state.buildGconvSessionId(cid), [
      {
        type: 'error',
        text: 'provider unavailable',
        failureKind: 'model',
        failureCode: 'provider_unavailable',
        failurePhase: 'provider_wait',
      },
    ]);
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'finish this task' });
    await waitForQuiescent(TEST_UID, cid, 3000);
    expect(await waitUntil(() => terminals.length === 1)).toBe(true);

    expect(terminals[0]).toMatchObject({
      status: 'failed',
      failure: {
        failure_reason: 'model_error',
        failure_kind: 'model',
        error_code: 'provider_unavailable',
        failure_phase: 'provider_wait',
      },
    });
    const stats = JSON.parse(fs.readFileSync(paths.commanderRuntimeStatsFile(TEST_UID), 'utf8'));
    expect(stats).toMatchObject({
      attempts: 1,
      successes: 0,
      execution_failures: 1,
      failures: 0,
      errors: 1,
    });
    unsubscribe();
  }, 10_000);

  it.each([
    { agentFails: false, commanderFails: true, expectedStatus: 'failed' },
    { agentFails: true, commanderFails: false, expectedStatus: 'completed' },
  ])('settles the final visible outcome after dispatch: $expectedStatus', async ({ agentFails, commanderFails, expectedStatus }) => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const groupChat = await import('../../../../src/main/features/group_chat');
    const terminals: any[] = [];
    const unsubscribe = bus.subscribeTaskTerminals((event) => {
      if (event.conversation_id === cid) terminals.push(event);
    });
    const failure = {
      type: 'error', text: 'provider unavailable', failureKind: 'model',
      failureCode: 'provider_unavailable', failurePhase: 'provider_wait',
    };
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      agentFails ? failure : { type: 'final', text: 'Draft prepared for review.' },
    ]);
    _setScript(state.buildGconvSessionId(cid), [
      { type: '__call_tool__', name: 'dispatch_to', input: { to: AGENT_NAME, message: 'Prepare the draft.' } },
      commanderFails ? failure : { type: 'final', text: 'Recovered and finished the review.' },
    ]);
    try {
      await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'Prepare and review the draft.' });
      await waitForQuiescent(TEST_UID, cid, 4000);
      expect(await waitUntil(() => terminals.length === 1)).toBe(true);
      const replies = (await groupChat.readMessages(TEST_UID, cid))
        .filter((m: any) => m.from !== 'user' && !m.dispatch);
      expect(replies.some((m: any) => m.from === AGENT_ID)).toBe(true);
      expect(replies.at(-1)?.from).toBe('commander');
      expect(terminals).toHaveLength(1);
      expect(terminals[0].status).toBe(expectedStatus);
      if (commanderFails) {
        expect(replies.at(-1)?.failure_code).toBe('provider_unavailable');
        expect(terminals[0].failure).toMatchObject({
          failure_kind: 'model', error_code: 'provider_unavailable', failure_phase: 'provider_wait',
        });
        expect(terminals[0].recovered).not.toBe(true);
      } else {
        expect(terminals[0]).toMatchObject({ recovered: true });
        expect(terminals[0].failure).toBeUndefined();
      }
    } finally {
      unsubscribe();
    }
  }, 12_000);

  it('does not classify actor failure prose as an execution failure', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
    const terminals: any[] = [];
    const unsubscribe = bus.subscribeTaskTerminals((event) => terminals.push(event));

    _setScript(state.buildGconvSessionId(cid), [
      { type: 'final', text: 'Could not complete the requested task.' },
    ]);
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'finish this task' });
    await waitForQuiescent(TEST_UID, cid, 3000);
    expect(await waitUntil(() => terminals.length === 1)).toBe(true);

    expect(terminals[0]).toMatchObject({
      status: 'completed',
    });
    expect(terminals[0].failure).toBeUndefined();
    const stats = JSON.parse(fs.readFileSync(paths.commanderRuntimeStatsFile(TEST_UID), 'utf8'));
    expect(stats).toMatchObject({
      attempts: 1,
      successes: 1,
      execution_failures: 0,
      failures: 0,
      errors: 0,
    });
    unsubscribe();
  }, 10_000);

  it('does not classify a missing delivered-media target as an execution failure', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const mediaUrls = await import('../../../../src/main/util/chat-media-url');
    const paths = await import('../../../../src/main/paths');
    const terminals: any[] = [];
    const unsubscribe = bus.subscribeTaskTerminals((event) => terminals.push(event));
    const missingUrl = mediaUrls.chatMediaLocalUrl(path.join(tmpDir, 'workspace', 'missing-output.mp4'));

    _setScript(state.buildGconvSessionId(cid), [
      { type: 'final', text: `[video](${missingUrl})` },
    ]);
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'finish this task' });
    await waitForQuiescent(TEST_UID, cid, 3000);
    expect(await waitUntil(() => terminals.length === 1)).toBe(true);

    expect(terminals[0]).toMatchObject({ status: 'completed' });
    expect(terminals[0].failure).toBeUndefined();
    const stats = JSON.parse(fs.readFileSync(paths.commanderRuntimeStatsFile(TEST_UID), 'utf8'));
    expect(stats).toMatchObject({
      attempts: 1,
      successes: 1,
      execution_failures: 0,
      failures: 0,
      errors: 0,
    });
    unsubscribe();
  }, 10_000);

  it('counts a named Agent model error as an explicit execution failure', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
    const terminals: any[] = [];
    const unsubscribe = bus.subscribeTaskTerminals((event) => terminals.push(event));

    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [{
      type: 'error',
      text: 'provider unavailable',
      failureKind: 'model',
      failureCode: 'provider_unavailable',
      failurePhase: 'provider_wait',
    }]);
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `@${AGENT_NAME} finish this task`,
    });
    await waitForQuiescent(TEST_UID, cid, 3000);
    expect(await waitUntil(() => terminals.length === 1)).toBe(true);

    expect(terminals[0]).toMatchObject({
      status: 'failed',
      failure: {
        failure_reason: 'model_error',
        failure_kind: 'model',
        error_code: 'provider_unavailable',
        failure_phase: 'provider_wait',
      },
    });
    const stats = JSON.parse(fs.readFileSync(paths.agentRuntimeStatsFile(TEST_UID, AGENT_ID), 'utf8'));
    expect(stats).toMatchObject({
      attempts: 1,
      successes: 0,
      execution_failures: 1,
      failures: 0,
      errors: 1,
    });
    unsubscribe();
  }, 10_000);

  it.each(['commander', 'agent'] as const)('keeps a %s host user-input boundary neutral and durable', async (kind) => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const groupChat = await import('../../../../src/main/features/group_chat');
    const actorId = kind === 'agent' ? AGENT_ID : 'commander';
    const sid = kind === 'agent' ? state.buildGmemberSessionId(cid, AGENT_ID) : state.buildGconvSessionId(cid);
    const terminals: any[] = [];
    const unsubscribe = bus.subscribeTaskTerminals((event) => {
      if (event.conversation_id === cid) terminals.push(event);
    });
    _setScript(sid, [{ type: 'event', event: { stream: 'agent_run_result', data: {
      result: 'success', terminal_status: 'waiting_input', duration_ms: 20, run_kind: 'top_level',
    } } }]);
    try {
      await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user',
        text: kind === 'agent' ? `@${AGENT_NAME} start` : 'Open the user input panel',
      });
      await waitForQuiescent(TEST_UID, cid, 4000);
      expect(await waitUntil(() => terminals.length === 1)).toBe(true);
      expect(terminals[0]).toMatchObject({ status: 'waiting_input' });
      expect(terminals[0]).not.toHaveProperty('failure');
      const replies = (await groupChat.readMessages(TEST_UID, cid)).filter((row: any) => row.from === actorId);
      expect(replies).toHaveLength(1);
      expect(replies[0].text).toBe('');
      expect(replies[0]).not.toHaveProperty('failure_kind');
      expect(_recordedCalls.filter((call) => call.sid === sid)).toHaveLength(1);
    } finally {
      unsubscribe();
    }
  });

  it('classifies a persisted input form as waiting_input', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
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
    const stats = JSON.parse(fs.readFileSync(paths.agentRuntimeStatsFile(TEST_UID, AGENT_ID), 'utf8'));
    expect(stats).toMatchObject({
      attempts: 1,
      successes: 0,
      execution_failures: 0,
      failures: 0,
      errors: 0,
    });
    unsubscribe();
  }, 10_000);

  it('emits cancelled after a live run is stopped', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
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
    const stats = JSON.parse(fs.readFileSync(paths.agentRuntimeStatsFile(TEST_UID, AGENT_ID), 'utf8'));
    expect(stats).toMatchObject({
      attempts: 1,
      successes: 0,
      execution_failures: 0,
      failures: 0,
      errors: 0,
    });
    unsubscribe();
  }, 10_000);

  it('emits one cancelled terminal synchronously when an account switch owns teardown', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const terminals: any[] = [];
    const unsubscribe = bus.subscribeTaskTerminals((event) => {
      if (event.conversation_id === cid) terminals.push(event);
    });

    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: '__wait_for_abort__' },
    ]);
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `@${AGENT_NAME} long task before switching account`,
    });
    expect(await waitUntil(() => !bus.isQuiescent(TEST_UID, cid))).toBe(true);

    bus.cancelForUserSwitch(TEST_UID);

    expect(terminals).toHaveLength(1);
    expect(terminals[0]).toMatchObject({
      user_id: TEST_UID,
      conversation_id: cid,
      status: 'cancelled',
    });
    expect(await waitUntil(() => bus._cidStateForTest(TEST_UID, cid) === null)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(terminals).toHaveLength(1);
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

describe('group_chat bus integration › cost backstop', () => {
  it('resets the cost meter when a new user message starts a task', async () => {
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const meter = await import('../../../../src/main/util/conversation-cost-meter');
    const cid = newCid();

    // Pre-load the meter as if a previous task had spent tokens.
    meter.recordUsageTokens(cid, { inputTokens: 999_999 });
    expect(meter.taskTokens(cid)).toBeGreaterThan(0);

    _setScript(state.buildGconvSessionId(cid), [{ type: 'final', text: 'ok' }]);
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'hi' });
    await waitForQuiescent(TEST_UID, cid, 2000);

    // A new user message is a new task → the meter is reset in _enqueueBody.
    expect(meter.taskTokens(cid)).toBe(0);
  });
});

describe('group_chat bus integration › agent-mutation rejection feedback (W5-1)', () => {
  // MetaBot case (2026-08 weekly review): the platform rejected an agent name,
  // the commander had already claimed success, and the rejection reason only
  // reached the model when the user hand-pasted the visible warning. The bus
  // now feeds the rejection back as one hidden commander turn carrying the
  // violated constraint, so the model corrects itself in the same round.
  it('feeds a platform rejection back to the commander and the correction lands', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const agentsFeat = await import('../../../../src/main/features/agents');
    const sid = state.buildGconvSessionId(cid);
    _setScript(sid, [{
      type: 'final',
      text: '已创建 MetaBot。\n<agent>\n<operation>create</operation>\n<name>Meta Bot!</name>\n<description>Builds team agents</description>\n<workflow>coordinate the build</workflow>\n<tools></tools>\n</agent>',
    }]);
    _setScript(sid, [{
      type: 'final',
      text: '<agent>\n<operation>create</operation>\n<name>MetaBot</name>\n<description>Builds team agents</description>\n<workflow>coordinate the build</workflow>\n<tools></tools>\n</agent>\n命名已按平台规则修正并创建。',
    }]);

    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: '帮我建一个 MetaBot' });
    await waitForQuiescent(TEST_UID, cid);

    const commanderCalls = _recordedCalls.filter((c) => c.sid === sid);
    expect(commanderCalls).toHaveLength(2);
    // The feedback turn carries the exact violated constraint, not a bare
    // "failed" — the model needs the legal charset to comply.
    const feedback = commanderCalls[1].message;
    expect(feedback).toContain('agent-mutation-feedback');
    expect(feedback).toContain('unsupported characters');
    const all = await agentsFeat.listAgents();
    expect(all.some((a) => a.name === 'MetaBot')).toBe(true);
  }, 10_000);

  it('keeps create intent when the model mistakenly includes an agent id', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const agentsFeat = await import('../../../../src/main/features/agents');
    const sid = state.buildGconvSessionId(cid);
    _setScript(sid, [{
      type: 'final',
      text: [
        'Agent created successfully.',
        '<agent>',
        '<operation>create</operation>',
        '<agent_id>missing-production-agent</agent_id>',
        '<name>ProductionRecovery</name>',
        '<description>Exercises missing-target recovery.</description>',
        '<workflow>Recover from an invalid edit target.</workflow>',
        '<tools></tools>',
        '</agent>',
      ].join('\n'),
    }]);
    _setScript(sid, [{
      type: 'final',
      text: [
        '<agent>',
        '<operation>create</operation>',
        '<name>ProductionRecovery</name>',
        '<description>Exercises missing-target recovery.</description>',
        '<workflow>Recover from an invalid edit target.</workflow>',
        '<tools></tools>',
        '</agent>',
        'Created after correcting the rejected configuration.',
      ].join('\n'),
    }]);

    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: 'Create a new ProductionRecovery Agent',
    });
    await waitForQuiescent(TEST_UID, cid);

    const commanderCalls = _recordedCalls.filter((call) => call.sid === sid);
    expect(commanderCalls).toHaveLength(2);
    expect(commanderCalls[1].message).toContain('agent-mutation-feedback');
    expect(commanderCalls[1].message).toContain('operation=create');
    expect(commanderCalls[1].message).toContain('Remove agent_id');
    const rows = await (await import('../../../../src/main/features/group_chat')).readMessages(TEST_UID, cid);
    const visibleCommanderReplies = rows.filter((row: any) => (
      row.from === 'commander' && !row.dispatch
    ));
    expect(visibleCommanderReplies).toHaveLength(2);
    expect(visibleCommanderReplies[0].text).toContain(
      'The Agent operation was not completed. Correcting it automatically.',
    );
    expect(visibleCommanderReplies[0].text).not.toContain('created successfully');
    expect(visibleCommanderReplies[0].text).not.toContain('agent_id');
    expect(visibleCommanderReplies[0].text).not.toContain('canonical ID');
    const created = (await agentsFeat.listAgents()).filter((agent) => (
      agent.name === 'ProductionRecovery'
    ));
    expect(created).toHaveLength(1);
  }, 10_000);

  it('creates one runnable Agent from Commander chat and forwards its fixed tool list on the first turn', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const agentsFeat = await import('../../../../src/main/features/agents');
    const commanderSid = state.buildGconvSessionId(cid);
    _setScript(commanderSid, [{
      type: 'final',
      text: [
        '已创建。',
        '<agent>',
        '<operation>create</operation>',
        '<name>WebResearcher</name>',
        '<description>Researches public sources and returns cited findings.</description>',
        '<workflow>Inspect supplied files, research the web, and deliver findings.</workflow>',
        '<tools>workspace.read\nweb</tools>',
        '<category>data</category>',
        '</agent>',
      ].join('\n'),
    }]);

    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: '创建一个网页研究 Agent' });
    await waitForQuiescent(TEST_UID, cid);

    const created = (await agentsFeat.listAgents()).find((agent) => agent.name === 'WebResearcher');
    expect(created?.tool_list).toEqual(['workspace.read', 'web']);
    const paths = await import('../../../../src/main/paths');
    const conversation = fs.readFileSync(
      path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`),
      'utf8',
    ).trim().split('\n').map((line) => JSON.parse(line));
    const creationReply = conversation.find((message) => (
      message.from === 'commander'
      && Array.isArray(message.created_agents)
      && message.created_agents.length > 0
    ));
    expect(creationReply?.text).toBe('已创建。');
    expect(creationReply?.text).not.toContain('<agent>');
    expect(creationReply?.created_agents).toEqual([{
      agent_id: created?.agent_id,
      name: 'WebResearcher',
      kind: 'created',
    }]);
    const memberSid = state.buildGmemberSessionId(cid, created?.agent_id || 'missing');
    _setScript(memberSid, [{ type: 'final', text: '完成。' }]);

    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: '@WebResearcher 调研这个主题',
    });
    await waitForQuiescent(TEST_UID, cid);

    const runtimeCall = _recordedCalls.find((call) => call.sid === memberSid);
    expect(runtimeCall?.toolListPresent).toBe(true);
    expect(runtimeCall?.toolList).toEqual(['workspace.read', 'web']);
  }, 10_000);

  it('persists the Connector group when Commander creates an Agent from an explicit Connector selection', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const agentsFeat = await import('../../../../src/main/features/agents');
    _setScript(state.buildGconvSessionId(cid), [{
      type: 'final',
      text: [
        '已创建。',
        '<agent>',
        '<operation>create</operation>',
        '<name>ConnectorReporter</name>',
        '<description>Reads the selected Connector and returns a report.</description>',
        '<workflow>Use the user-selected Connector and report the result.</workflow>',
        '<tools>workspace.read</tools>',
        '<category>data</category>',
        '</agent>',
      ].join('\n'),
    }]);

    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: '创建一个使用 Notion 的 Agent',
      use_selections: [{ kind: 'connector', id: 'notion', name: 'Notion' }],
    });
    await waitForQuiescent(TEST_UID, cid);

    const created = (await agentsFeat.listAgents())
      .find((agent) => agent.name === 'ConnectorReporter');
    expect(created?.tool_list).toEqual(['workspace.read', 'connectors']);
  }, 10_000);

  it('does not copy one message-level Connector selection onto every Agent in a batch', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const agentsFeat = await import('../../../../src/main/features/agents');
    _setScript(state.buildGconvSessionId(cid), [{
      type: 'final',
      text: [
        '已创建两个 Agent。',
        '<agent>',
        '<operation>create</operation>',
        '<name>SelectedConnectorReporter</name>',
        '<description>Reports from an explicitly selected Connector.</description>',
        '<workflow>Call `list_connector_tools` for the selected Connector, then report.</workflow>',
        '<tools>workspace.read</tools>',
        '<category>data</category>',
        '</agent>',
        '<agent>',
        '<operation>create</operation>',
        '<name>PlainSummarizer</name>',
        '<description>Summarizes supplied workspace files.</description>',
        '<workflow>Read the supplied files and summarize them.</workflow>',
        '<tools>workspace.read</tools>',
        '<category>data</category>',
        '</agent>',
      ].join('\n'),
    }]);

    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: '创建一个使用 Notion 的报告 Agent，再创建一个普通摘要 Agent',
      use_selections: [{ kind: 'connector', id: 'notion', name: 'Notion' }],
    });
    await waitForQuiescent(TEST_UID, cid);

    const agents = await agentsFeat.listAgents();
    expect(agents.find((agent) => agent.name === 'SelectedConnectorReporter')?.tool_list)
      .toEqual(['workspace.read', 'connectors']);
    expect(agents.find((agent) => agent.name === 'PlainSummarizer')?.tool_list)
      .toEqual(['workspace.read']);
  }, 10_000);

  it('keeps a successful batch item while correcting only the rejected create', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const agentsFeat = await import('../../../../src/main/features/agents');
    const sid = state.buildGconvSessionId(cid);
    _setScript(sid, [{
      type: 'final',
      text: [
        'Created both Agents.',
        '<agent>',
        '<operation>create</operation>',
        '<name>BatchKept</name>',
        '<description>First batch Agent.</description>',
        '<workflow>Complete the first task.</workflow>',
        '<tools></tools>',
        '</agent>',
        '<agent>',
        '<operation>create</operation>',
        '<agent_id>accidental-id</agent_id>',
        '<name>BatchRecovered</name>',
        '<description>Second batch Agent.</description>',
        '<workflow>Complete the second task.</workflow>',
        '<tools></tools>',
        '</agent>',
      ].join('\n'),
    }]);
    _setScript(sid, [{
      type: 'final',
      text: '<agent>\n<operation>create</operation>\n<name>BatchRecovered</name>\n<description>Second batch Agent.</description>\n<workflow>Complete the second task.</workflow>\n<tools></tools>\n</agent>',
    }]);

    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'Create both batch Agents' });
    await waitForQuiescent(TEST_UID, cid);

    const rows = await (await import('../../../../src/main/features/group_chat')).readMessages(TEST_UID, cid);
    const replies = rows.filter((row: any) => row.from === 'commander' && !row.dispatch);
    expect(replies).toHaveLength(2);
    expect(replies[0].text).toContain(
      'Some Agent changes were completed. Correcting the remaining changes automatically.',
    );
    expect(replies[0].text).not.toContain('Created both Agents.');
    expect(replies[0].created_agents).toHaveLength(1);
    const names = (await agentsFeat.listAgents()).map((agent) => agent.name);
    expect(names.filter((name) => name === 'BatchKept')).toHaveLength(1);
    expect(names.filter((name) => name === 'BatchRecovered')).toHaveLength(1);
  }, 10_000);

  it('recovers a missing edit target without creating a replacement', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const agentsFeat = await import('../../../../src/main/features/agents');
    const sid = state.buildGconvSessionId(cid);
    _setScript(sid, [{
      type: 'final',
      text: '<agent>\n<operation>edit</operation>\n<agent_id>missing-writer</agent_id>\n<description>Updated writer</description>\n<workflow>write and verify</workflow>\n</agent>',
    }]);
    _setScript(sid, [{
      type: 'final',
      text: `<agent>\n<operation>edit</operation>\n<agent_id>${AGENT_ID}</agent_id>\n<description>Updated writer</description>\n<workflow>write and verify</workflow>\n</agent>`,
    }]);

    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'Update the Writer Agent' });
    await waitForQuiescent(TEST_UID, cid);

    const commanderCalls = _recordedCalls.filter((call) => call.sid === sid);
    expect(commanderCalls).toHaveLength(2);
    expect(commanderCalls[1].message).toContain('"action": "edit"');
    const all = await agentsFeat.listAgents();
    expect(all.filter((agent) => agent.name === AGENT_NAME)).toHaveLength(1);
    expect(all.find((agent) => agent.agent_id === AGENT_ID)).toMatchObject({
      workflow: 'write and verify',
    });
  }, 10_000);

  it('rejects a correction that switches an edit into create', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const agentsFeat = await import('../../../../src/main/features/agents');
    const sid = state.buildGconvSessionId(cid);
    _setScript(sid, [{
      type: 'final',
      text: '<agent>\n<operation>edit</operation>\n<agent_id>missing-agent</agent_id>\n<name>RetryRecovery</name>\n<description>d</description>\n<workflow>w</workflow>\n<tools></tools>\n</agent>',
    }]);
    _setScript(sid, [{
      type: 'final',
      text: '<agent>\n<operation>create</operation>\n<name>RetryRecovery</name>\n<description>d</description>\n<workflow>w</workflow>\n<tools></tools>\n</agent>',
    }]);

    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'Update the RetryRecovery Agent' });
    await waitForQuiescent(TEST_UID, cid);

    // Exactly two commander turns: original + ONE feedback round. The second
    // rejection stays a visible warning instead of looping.
    expect(_recordedCalls.filter((c) => c.sid === sid)).toHaveLength(2);
    const rows = await (await import('../../../../src/main/features/group_chat')).readMessages(TEST_UID, cid);
    const visibleCommanderReplies = rows.filter((row: any) => (
      row.from === 'commander' && !row.dispatch
    ));
    expect(visibleCommanderReplies).toHaveLength(2);
    expect(visibleCommanderReplies[0].text).toContain(
      'The Agent operation was not completed. Correcting it automatically.',
    );
    expect(visibleCommanderReplies[1].text).toContain(
      'The Agent operation could not be completed. Please try again.',
    );
    expect(visibleCommanderReplies[1].text).not.toContain('agent_id');
    expect(visibleCommanderReplies[1].text).not.toContain('canonical ID');
    const all = await agentsFeat.listAgents();
    expect(all.some((a) => a.name === 'RetryRecovery')).toBe(false);
  }, 10_000);

  it('reports an unresolved edit target without creating a replacement', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const agentsFeat = await import('../../../../src/main/features/agents');
    const sid = state.buildGconvSessionId(cid);
    _setScript(sid, [{
      type: 'final',
      text: '<agent>\n<operation>edit</operation>\n<agent_id>missing-one</agent_id>\n<name>NeverCreated</name>\n</agent>',
    }]);
    _setScript(sid, [{
      type: 'final',
      text: '<agent>\n<operation>edit</operation>\n<agent_id>missing-two</agent_id>\n<name>NeverCreated</name>\n</agent>',
    }]);

    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'Edit NeverCreated' });
    await waitForQuiescent(TEST_UID, cid);

    expect(_recordedCalls.filter((call) => call.sid === sid)).toHaveLength(2);
    const rows = await (await import('../../../../src/main/features/group_chat')).readMessages(TEST_UID, cid);
    const replies = rows.filter((row: any) => row.from === 'commander' && !row.dispatch);
    expect(replies[1].text).toContain(
      'The Agent to edit could not be found. It may have been deleted. Confirm the target and try again.',
    );
    expect(replies[1].text).not.toContain('agent_id');
    expect((await agentsFeat.listAgents()).some((agent) => agent.name === 'NeverCreated')).toBe(false);
  }, 10_000);

  it('fails closed without retrying when an unbound mutation omits operation', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const agentsFeat = await import('../../../../src/main/features/agents');
    const sid = state.buildGconvSessionId(cid);
    _setScript(sid, [{
      type: 'final',
      text: '<agent>\n<name>AmbiguousAgent</name>\n<description>d</description>\n<workflow>w</workflow>\n<tools></tools>\n</agent>',
    }]);

    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'Create AmbiguousAgent' });
    await waitForQuiescent(TEST_UID, cid);

    expect(_recordedCalls.filter((call) => call.sid === sid)).toHaveLength(1);
    const rows = await (await import('../../../../src/main/features/group_chat')).readMessages(TEST_UID, cid);
    const reply = rows.find((row: any) => row.from === 'commander' && !row.dispatch);
    expect(reply?.text).toContain('The Agent operation could not be completed. Please try again.');
    expect(reply?.text).not.toContain('<operation>');
    expect(reply?.text).not.toContain('agent_id');
    expect((await agentsFeat.listAgents()).some((agent) => agent.name === 'AmbiguousAgent')).toBe(false);
  }, 10_000);
});

describe('group_chat bus integration › transparent in-turn channel retry (W2-4/W3-4)', () => {
  // Chemistry-PPT case: an idle timeout left an intact breakpoint, but the
  // user had to type "continue" by hand; a dispatched agent hit by channel
  // failures was silently ghost-written by the commander. A recoverable
  // channel-class failure with no visible content now retries ONCE inside
  // the same turn: one turnId, one bubble, no failure message persisted on
  // success, so observers never see the transient failure.
  it.each([
    { code: 'provider_no_first_event', label: 'provider never started' },
    // W2-2: a mid-stream network death re-enters candidate rotation via the
    // same in-turn retry instead of hard-failing the turn.
    { code: 'provider_network', label: 'stream died mid-turn' },
  ])('retries once inside the same turn after a channel-class failure ($code)', async ({ code, label }) => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const sid = state.buildGconvSessionId(cid);
    _setScript(sid, [
      { type: 'error', text: label, failureKind: 'model', failureCode: code },
    ]);
    _setScript(sid, [{ type: 'final', text: 'resumed and finished the deck' }]);

    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: '把 PPT 做完' });
    await waitForQuiescent(TEST_UID, cid);

    const commanderCalls = _recordedCalls.filter((c) => c.sid === sid);
    expect(commanderCalls).toHaveLength(2);
    // The retry must resume the still-open turn, not open a second one —
    // that is what keeps tool state current and the user message single.
    expect(commanderCalls[0].resumeActiveTurn).toBe(false);
    expect(commanderCalls[1].resumeActiveTurn).toBe(true);
    expect(commanderCalls[0].executionDeadlineAt).toBeGreaterThan(Date.now());
    expect(commanderCalls[1].executionDeadlineAt).toBe(commanderCalls[0].executionDeadlineAt);
    const rows = await (await import('../../../../src/main/features/group_chat')).readMessages(TEST_UID, cid);
    // ONE assistant reply, no persisted failure, no synthetic trigger
    // message: the retry is invisible at the conversation level.
    expect(rows.some((r: any) => r.text === 'resumed and finished the deck')).toBe(true);
    expect(rows.some((r: any) => r.failure_code)).toBe(false);
    expect(rows.filter((r: any) => r.from === 'user')).toHaveLength(1);
    expect(rows.filter((r: any) => r.from === 'commander' && !r.dispatch)).toHaveLength(1);
  }, 10_000);

  it('surfaces exhausted rate limiting without starting a misleading second bus run', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const sid = state.buildGconvSessionId(cid);
    _setScript(sid, [
      {
        type: 'error',
        text: 'too many requests',
        failureKind: 'model',
        failureCode: 'provider_rate_limit',
        failurePhase: 'provider_wait',
      },
    ]);
    // This reply is a negative control: it becomes visible only if the bus
    // incorrectly launches another full model run after lower-layer 429
    // rotation/backoff/cooldown has already reached its terminal outcome.
    _setScript(sid, [{ type: 'final', text: 'misleading retry succeeded' }]);

    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: '继续完成任务' });
    await waitForQuiescent(TEST_UID, cid);

    expect(_recordedCalls.filter((c) => c.sid === sid)).toHaveLength(1);
    const rows = await (await import('../../../../src/main/features/group_chat')).readMessages(TEST_UID, cid);
    expect(rows.filter((r: any) => r.failure_code === 'provider_rate_limit')).toHaveLength(1);
    expect(rows.some((r: any) => r.text === 'misleading retry succeeded')).toBe(false);
  }, 10_000);

  it('persists the honest failure bubble when the in-turn retry fails again', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const sid = state.buildGconvSessionId(cid);
    _setScript(sid, [
      { type: 'error', text: 'idle timeout', failureKind: 'model', failureCode: 'idle_timeout' },
    ]);
    _setScript(sid, [
      { type: 'error', text: 'idle timeout', failureKind: 'model', failureCode: 'idle_timeout' },
    ]);

    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: '继续做' });
    await waitForQuiescent(TEST_UID, cid);

    expect(_recordedCalls.filter((c) => c.sid === sid)).toHaveLength(2);
    const rows = await (await import('../../../../src/main/features/group_chat')).readMessages(TEST_UID, cid);
    expect(rows.filter((r: any) => r.failure_code === 'idle_timeout')).toHaveLength(1);
  }, 10_000);

  it.each(['tool', 'tool_input'] as const)(
    'does not retry a %s-phase idle timeout — an earlier tool may have executed a side effect',
    async (failurePhase) => {
      const cid = newCid();
      const state = await import('../../../../src/main/features/group_chat/state');
      const bus = await import('../../../../src/main/features/group_chat/bus');
      const sid = state.buildGconvSessionId(cid);
      _setScript(sid, [
        { type: 'error', text: 'tool input or execution hung', failureKind: 'model', failureCode: 'idle_timeout', failurePhase },
      ]);
      _setScript(sid, [{ type: 'final', text: 'must not run' }]);

      await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: '发部署邮件' });
      await waitForQuiescent(TEST_UID, cid);

      // One call: an earlier completed tool may already have produced the side
      // effect, so a silent full-turn replay is unsafe. Keep the manual retry.
      expect(_recordedCalls.filter((c) => c.sid === sid)).toHaveLength(1);
      const rows = await (await import('../../../../src/main/features/group_chat')).readMessages(TEST_UID, cid);
      expect(rows.filter((r: any) => r.failure_code === 'idle_timeout')).toHaveLength(1);
    },
    10_000,
  );

  it('does not retry when visible content already streamed before the failure', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const sid = state.buildGconvSessionId(cid);
    _setScript(sid, [
      { type: 'delta', text: '前半段结论已经写出来了。' },
      { type: 'error', text: 'stream died mid-turn', failureKind: 'model', failureCode: 'provider_network' },
    ]);

    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: '分析一下' });
    await waitForQuiescent(TEST_UID, cid);

    // A silent re-run would duplicate the on-screen text: keep the honest
    // failure + salvaged partial instead.
    expect(_recordedCalls.filter((c) => c.sid === sid)).toHaveLength(1);
    const rows = await (await import('../../../../src/main/features/group_chat')).readMessages(TEST_UID, cid);
    const failed = rows.find((r: any) => r.failure_code === 'provider_network');
    expect(String(failed?.text || '')).toContain('前半段结论');
  }, 10_000);

  it('honors a stop that lands between the failed attempt and its retry', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const sid = state.buildGconvSessionId(cid);
    _setScript(sid, [
      { type: 'error', text: 'provider never started', failureKind: 'model', failureCode: 'provider_no_first_event' },
    ]);
    _setScript(sid, [{ type: 'final', text: 'should never run' }]);

    // Fire the stop inside the retry gap: attempt 0 has failed (its
    // controller is already null) and the in-turn retry has not started.
    // That gap's state_changed is the first one where the commander turn is
    // present but no longer steerable while the model ran exactly once.
    let fired = false;
    const unsub = bus.subscribe(TEST_UID, cid, (ev: any) => {
      if (fired || ev.type !== 'state_changed') return;
      const turn = (ev.active_turns || []).find((t2: any) => t2.actor === 'commander');
      if (!turn || turn.steerable) return;
      if (_recordedCalls.filter((c) => c.sid === sid).length !== 1) return;
      fired = true;
      void bus.abort(TEST_UID, cid);
    });
    try {
      await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: '做个东西' });
      await waitForQuiescent(TEST_UID, cid);
    } finally { unsub(); }

    expect(fired).toBe(true);
    // The stop suppressed the retry: one model call only...
    expect(_recordedCalls.filter((c) => c.sid === sid)).toHaveLength(1);
    const rows = await (await import('../../../../src/main/features/group_chat')).readMessages(TEST_UID, cid);
    // ...and the honest channel failure is what persisted (a mid-stream
    // abort would have produced a "(stopped)" stub instead), proving the
    // stop really landed in the gap rather than during the stream.
    expect(rows.some((r: any) => r.failure_code === 'provider_no_first_event')).toBe(true);
  }, 10_000);

  it('leaves non-channel failures alone', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const sid = state.buildGconvSessionId(cid);
    _setScript(sid, [
      { type: 'error', text: 'invalid request', failureKind: 'model', failureCode: 'provider_request' },
    ]);

    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: '做点什么' });
    await waitForQuiescent(TEST_UID, cid);

    expect(_recordedCalls.filter((c) => c.sid === sid)).toHaveLength(1);
  }, 10_000);
});

describe('group_chat bus integration › conversation task board (P1)', () => {
  /**
   * Scenario value: the task board must mirror real execution — "who is
   * working / queued / done" — with deterministic host-driven transitions
   * only. Oracles: the persisted tasks.json snapshot, the persisted message
   * task_id link, captured bus task events, and the recorded model calls
   * (a cancelled queued task must never reach the model).
   */
  async function boardRows(cid: string): Promise<any[]> {
    const paths = await import('../../../../src/main/paths');
    await (await import('../../../../src/main/features/group_chat/task_board')).flushBoards();
    const file = path.join(paths.userChatsDir(TEST_UID), cid, 'tasks.json');
    if (!fs.existsSync(file)) return [];
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }

  beforeEach(async () => {
    const tb = await import('../../../../src/main/features/group_chat/task_board');
    tb._resetForTest();
  });

  it('a direct @agent message runs through queued → running → done with message linkage', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const storage = await import('../../../../src/main/storage');
    const paths = await import('../../../../src/main/paths');

    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: 'final', text: 'article ready' },
    ]);
    const taskEvents: any[] = [];
    bus.subscribe(TEST_UID, cid, (ev: any) => {
      if (ev.type === 'task_created' || ev.type === 'task_state') taskEvents.push(ev);
    });

    const userMsg = await bus.enqueue({
      uid: TEST_UID, cid, fromActorId: 'user', text: `@${AGENT_NAME} write an article`,
    });
    await waitForQuiescent(TEST_UID, cid, 5000);

    const rows = await boardRows(cid);
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toMatchObject({
      assignee: AGENT_ID,
      status: 'done',
      created_by: 'user',
      source_msg_id: userMsg.id,
    });
    expect(row.turn_id).toBeTruthy();
    expect(row.started_at).toBeTruthy();
    expect(row.ended_at).toBeTruthy();

    // The agent's end-of-turn reply carries the settling task_id, and the
    // task links back to that reply.
    const messages = await storage.readJsonl<any>(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`));
    const reply = messages.find((m: any) => m.from === AGENT_ID);
    expect(reply?.task_id).toBe(row.task_id);
    expect(row.result_msg_id).toBe(reply?.id);

    // Deterministic event order for this task: created(queued) → running → done.
    const forTask = taskEvents.filter((ev) => ev.task.task_id === row.task_id);
    expect(forTask.map((ev) => [ev.type, ev.task.status])).toEqual([
      ['task_created', 'queued'],
      ['task_state', 'running'],
      ['task_state', 'done'],
    ]);
  }, 12_000);

  it('cancelling a queued task removes it before it ever reaches the model', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const sid = state.buildGconvSessionId(cid);

    _holdStream('board-cancel');
    _setScript(sid, [
      { type: '__wait_for_gate__', name: 'board-cancel' },
      { type: 'final', text: 'first done' },
    ]);
    _setScript(sid, [{ type: 'final', text: 'second done (must never run)' }]);

    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'first job' });
    expect(await waitUntil(() => _recordedCalls.some((c) => c.sid === sid))).toBe(true);
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'second job' });

    const queuedRow = (await boardRows(cid)).find((r) => r.status === 'queued');
    expect(queuedRow).toBeTruthy();
    const res = await bus.cancelConversationTask(TEST_UID, cid, queuedRow.task_id);
    expect(res.ok).toBe(true);

    _releaseStream('board-cancel');
    await waitForQuiescent(TEST_UID, cid, 5000);

    // Only the first turn reached the model; the board shows done + cancelled.
    expect(_recordedCalls.filter((c) => c.sid === sid)).toHaveLength(1);
    const byStatus = (await boardRows(cid)).map((r) => r.status).sort();
    expect(byStatus).toEqual(['cancelled', 'done']);
    // The cancelled row never started.
    const cancelled = (await boardRows(cid)).find((r) => r.status === 'cancelled');
    expect(cancelled.started_at).toBeUndefined();
  }, 12_000);

  it('conversation abort cancels the running task and every queued task', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const sid = state.buildGmemberSessionId(cid, AGENT_ID);

    _setScript(sid, [{ type: '__wait_for_abort__' }]);
    _setScript(sid, [{ type: 'final', text: 'queued (must never run)' }]);

    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: `@${AGENT_NAME} long job` });
    expect(await waitUntil(() => _recordedCalls.some((c) => c.sid === sid))).toBe(true);
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: `@${AGENT_NAME} follow-up` });

    await bus.abort(TEST_UID, cid);
    await waitForQuiescent(TEST_UID, cid, 5000);

    const rows = await boardRows(cid);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === 'cancelled')).toBe(true);
    // Only the first (aborted) turn reached the model.
    expect(_recordedCalls.filter((c) => c.sid === sid)).toHaveLength(1);
  }, 12_000);

  it('a steer send creates no task at push; an unfolded leftover is task-ified at claim', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const sid = state.buildGconvSessionId(cid);

    _holdStream('board-steer');
    _setScript(sid, [
      { type: '__wait_for_gate__', name: 'board-steer' },
      { type: 'final', text: 'long turn done' },
    ]);

    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'long job' });
    expect(await waitUntil(() => _recordedCalls.some((c) => c.sid === sid))).toBe(true);
    // "Send now" while the commander turn runs: steer messages fold into the
    // live turn and must NOT appear on the board.
    await bus.enqueue({
      uid: TEST_UID, cid, fromActorId: 'user', text: 'also mention the deadline',
      steerActiveTurn: true,
    });
    expect(await boardRows(cid)).toHaveLength(1);

    _releaseStream('board-steer');
    await waitForQuiescent(TEST_UID, cid, 5000);

    // The mock stream never drains steer, so the leftover became its own turn
    // — the claim path must have task-ified it (running-created, then done).
    const rows = await boardRows(cid);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === 'done')).toBe(true);
    const lazy = rows.find((r) => r.instruction.includes('deadline'));
    expect(lazy).toMatchObject({ created_by: 'user', assignee: 'commander' });
    expect(lazy.started_at).toBeTruthy();
  }, 12_000);

  it('a form-blocked turn parks the task; the matching submission RESUMES the same task, a new instruction supersedes it', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const router = await import('../../../../src/main/features/group_chat/router');
    const paths = await import('../../../../src/main/paths');
    const storage = await import('../../../../src/main/storage');
    const sid = state.buildGmemberSessionId(cid, AGENT_ID);
    const formPayload = {
      fields: [{ id: 'topic', label: 'Which topic?', type: 'text', required: true }],
    };
    _setScript(sid, [{
      type: 'final',
      text: `Need input.\n<agent-input-form>\n${JSON.stringify(formPayload)}\n</agent-input-form>`,
    }]);
    _setScript(sid, [{ type: 'final', text: 'article about the topic' }]);

    const taskEvents: any[] = [];
    bus.subscribe(TEST_UID, cid, (ev: any) => {
      if (ev.type === 'task_state') taskEvents.push(ev);
    });

    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: `@${AGENT_NAME} write an article` });
    await waitForQuiescent(TEST_UID, cid, 5000);

    const parked = (await boardRows(cid)).find((r) => r.status === 'waiting_input');
    expect(parked).toBeTruthy();
    expect(parked.ended_at).toBeUndefined();
    // The settlement recorded the blocking form id for resume matching.
    expect(parked.resume?.form_id).toBeTruthy();

    // True resume (P3): the ENCODED submission re-enters the SAME task —
    // one board row through waiting_input → running → done, never a second.
    const messages = await storage.readJsonl<any>(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`));
    const formMsg = messages.find((m: any) => m.from === AGENT_ID && m.form);
    const encoded = router.encodeSubmission(
      { form_id: formMsg.form.form_id, agent_id: AGENT_ID, fields: formMsg.form.fields },
      { topic: 'task boards' },
    );
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: `@${AGENT_NAME}\n${encoded}` });
    await waitForQuiescent(TEST_UID, cid, 5000);

    const rows = await boardRows(cid);
    expect(rows).toHaveLength(1);
    expect(rows[0].task_id).toBe(parked.task_id);
    expect(rows[0].status).toBe('done');
    const parkedStates = taskEvents
      .filter((ev) => ev.task.task_id === parked.task_id)
      .map((ev) => ev.task.status);
    expect(parkedStates).toContain('waiting_input');
    expect(parkedStates[parkedStates.length - 1]).toBe('done');
    // The resume passed back through running (same task, second execution).
    expect(parkedStates.filter((s) => s === 'running').length).toBeGreaterThanOrEqual(1);
  }, 15_000);

  it('a NEW instruction (not a submission) supersedes the actor\'s form-parked task as cancelled', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const sid = state.buildGmemberSessionId(cid, AGENT_ID);
    const formPayload = {
      fields: [{ id: 'topic', label: 'Which topic?', type: 'text', required: true }],
    };
    _setScript(sid, [{
      type: 'final',
      text: `Need input.\n<agent-input-form>\n${JSON.stringify(formPayload)}\n</agent-input-form>`,
    }]);
    _setScript(sid, [{ type: 'final', text: 'did the new thing instead' }]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: `@${AGENT_NAME} write an article` });
    await waitForQuiescent(TEST_UID, cid, 5000);
    const parked = (await boardRows(cid)).find((r) => r.status === 'waiting_input');
    expect(parked).toBeTruthy();

    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'forget the form — summarize the doc instead' });
    await waitForQuiescent(TEST_UID, cid, 5000);

    const byId = new Map((await boardRows(cid)).map((r: any) => [r.task_id, r]));
    expect(byId.get(parked.task_id)?.status).toBe('cancelled'); // bypassed, visibly
    const fresh = [...byId.values()].find((r: any) => r.task_id !== parked.task_id);
    expect(fresh?.status).toBe('done');
  }, 15_000);
});

describe('group_chat bus integration › ConversationScheduler parallelism (P2)', () => {
  /**
   * Scenario value: two agents the user direct-assigned must actually run at
   * the same time (the point of the task board), while the hard rules hold —
   * same-actor serial and the per-conversation Agent cap (D10). Oracles:
   * live execution snapshots (runtimeSnapshot /
   * _cidStateForTest), recorded model-call interleaving, the persisted
   * canonical jsonl, and the board snapshot.
   */
  async function seedSecondAgent() {
    const paths = await import('../../../../src/main/paths');
    const dir = paths.agentDir(TEST_UID, SECOND_AGENT_ID);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify({
      agent_id: SECOND_AGENT_ID, name: SECOND_AGENT_NAME,
      description: 'Researches things', workflow: 'do research',
      created_at: 't', updated_at: 't',
    }));
  }

  beforeEach(async () => {
    (await import('../../../../src/main/features/group_chat/task_board'))._resetForTest();
  });

  it('runs two different agents concurrently and persists both replies intact', async () => {
    await seedSecondAgent();
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
    const storage = await import('../../../../src/main/storage');
    const sidA = state.buildGmemberSessionId(cid, AGENT_ID);
    const sidB = state.buildGmemberSessionId(cid, SECOND_AGENT_ID);

    _holdStream('parallel-a');
    _holdStream('parallel-b');
    _setScript(sidA, [
      { type: '__wait_for_gate__', name: 'parallel-a' },
      { type: 'final', text: 'writer done' },
    ]);
    _setScript(sidB, [
      { type: '__wait_for_gate__', name: 'parallel-b' },
      { type: 'final', text: 'researcher done' },
    ]);

    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: `@${AGENT_NAME} write the draft` });
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: `@${SECOND_AGENT_NAME} research the topic` });

    // BOTH model streams must be live at once — true parallelism, not FIFO.
    expect(await waitUntil(() => _recordedCalls.some((c) => c.sid === sidA)
      && _recordedCalls.some((c) => c.sid === sidB))).toBe(true);
    const snapshot = bus.runtimeSnapshot(TEST_UID, cid);
    expect(snapshot.activeTurns.map((t) => t.actor).sort())
      .toEqual([AGENT_ID, SECOND_AGENT_ID].sort());

    _releaseStream('parallel-a');
    _releaseStream('parallel-b');
    await waitForQuiescent(TEST_UID, cid, 5000);

    // Completion order is persistence order; both replies land intact.
    const messages = await storage.readJsonl<any>(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`));
    const texts = messages.filter((m: any) => m.from !== 'user').map((m: any) => m.text).sort();
    expect(texts).toEqual(['researcher done', 'writer done']);
    const live = bus._cidStateForTest(TEST_UID, cid) as any;
    expect(live.executions.size).toBe(0);
  }, 15_000);

  it('keeps the same actor strictly serial even with free cap', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const sid = state.buildGmemberSessionId(cid, AGENT_ID);

    _holdStream('serial-first');
    _setScript(sid, [
      { type: '__wait_for_gate__', name: 'serial-first' },
      { type: 'final', text: 'first' },
    ]);
    _setScript(sid, [{ type: 'final', text: 'second' }]);

    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: `@${AGENT_NAME} first job` });
    expect(await waitUntil(() => _recordedCalls.filter((c) => c.sid === sid).length === 1)).toBe(true);
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: `@${AGENT_NAME} second job` });

    // The second turn must NOT start while the first runs — hard rule: the
    // per-actor stateful session cannot hold two turns.
    await new Promise((r) => setTimeout(r, 60));
    expect(_recordedCalls.filter((c) => c.sid === sid)).toHaveLength(1);
    const live = bus._cidStateForTest(TEST_UID, cid) as any;
    expect(live.queue).toHaveLength(1);

    _releaseStream('serial-first');
    await waitForQuiescent(TEST_UID, cid, 5000);
    expect(_recordedCalls.filter((c) => c.sid === sid).map((c) => c.message))
      .toEqual([
        expect.stringContaining('first job'),
        expect.stringContaining('second job'),
      ]);
  }, 15_000);

  it('honors the session agent cap (ORKAS_MAX_CONVERSATION_TASKS=1 keeps the second agent queued)', async () => {
    const prevCap = process.env.ORKAS_MAX_CONVERSATION_TASKS;
    process.env.ORKAS_MAX_CONVERSATION_TASKS = '1';
    try {
      await seedSecondAgent();
      const cid = newCid();
      const state = await import('../../../../src/main/features/group_chat/state');
      const bus = await import('../../../../src/main/features/group_chat/bus');
      const sidA = state.buildGmemberSessionId(cid, AGENT_ID);
      const sidB = state.buildGmemberSessionId(cid, SECOND_AGENT_ID);

      _holdStream('cap-first');
      _setScript(sidA, [
        { type: '__wait_for_gate__', name: 'cap-first' },
        { type: 'final', text: 'a done' },
      ]);
      _setScript(sidB, [{ type: 'final', text: 'b done' }]);

      await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: `@${AGENT_NAME} slow job` });
      expect(await waitUntil(() => _recordedCalls.some((c) => c.sid === sidA))).toBe(true);
      await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: `@${SECOND_AGENT_NAME} other job` });

      await new Promise((r) => setTimeout(r, 60));
      expect(_recordedCalls.some((c) => c.sid === sidB)).toBe(false);

      _releaseStream('cap-first');
      await waitForQuiescent(TEST_UID, cid, 5000);
      expect(_recordedCalls.some((c) => c.sid === sidB)).toBe(true);
    } finally {
      if (prevCap === undefined) delete process.env.ORKAS_MAX_CONVERSATION_TASKS;
      else process.env.ORKAS_MAX_CONVERSATION_TASKS = prevCap;
    }
  }, 15_000);

  it('runs four Agents in one conversation, queues the fifth, then admits it when one slot frees', async () => {
    await seedSecondAgent();
    const extraAgents = [
      { id: 'c1d2e3f4a5b6', name: 'Planner' },
      { id: 'd1e2f3a4b5c6', name: 'Reviewer' },
      { id: 'e1f2a3b4c5d6', name: 'Tester' },
    ];
    const paths = await import('../../../../src/main/paths');
    for (const agent of extraAgents) {
      const dir = paths.agentDir(TEST_UID, agent.id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify({
        agent_id: agent.id,
        name: agent.name,
        description: `${agent.name} work`,
        workflow: `perform ${agent.name} work`,
        created_at: 't',
        updated_at: 't',
      }));
    }

    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const tb = await import('../../../../src/main/features/group_chat/task_board');
    const messageFile = path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`);
    const agents = [
      { id: AGENT_ID, name: AGENT_NAME },
      { id: SECOND_AGENT_ID, name: SECOND_AGENT_NAME },
      ...extraAgents,
    ];
    const gates = agents.map((_, index) => `session-cap-${cid}-${index}`);
    for (let index = 0; index < agents.length; index += 1) {
      const agent = agents[index];
      _holdStream(gates[index]);
      _setScript(state.buildGmemberSessionId(cid, agent.id), [
        { type: '__wait_for_gate__', name: gates[index] },
        { type: 'final', text: `${agent.name} done` },
      ]);
    }

    for (let index = 0; index < agents.length; index += 1) {
      await bus.enqueue({
        uid: TEST_UID,
        cid,
        fromActorId: 'user',
        text: `@${agents[index].name} job ${index + 1}`,
      });
    }

    const firstFourSids = agents.slice(0, 4).map((agent) => state.buildGmemberSessionId(cid, agent.id));
    const fifthSid = state.buildGmemberSessionId(cid, agents[4].id);
    expect(await waitUntil(() => firstFourSids.every(
      (sid) => _recordedCalls.some((call) => call.sid === sid),
    ))).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(_recordedCalls.some((call) => call.sid === fifthSid)).toBe(false);

    let rows = await tb.listTasks(TEST_UID, cid);
    expect(rows.filter((task) => task.status === 'running')).toHaveLength(4);
    const fifthQueued = rows.find((task) => task.assignee === agents[4].id);
    expect(fifthQueued).toMatchObject({
      status: 'queued',
      instruction: `@${agents[4].name} job 5`,
    });
    expect(fifthQueued?.started_at).toBeUndefined();
    let userHistory = fs.readFileSync(messageFile, 'utf8')
      .split('\n').filter(Boolean).map((line) => JSON.parse(line))
      .filter((row: any) => row.from === 'user')
      .map((row: any) => row.text);
    expect(userHistory).toEqual(agents.slice(0, 4).map((agent, index) => `@${agent.name} job ${index + 1}`));
    expect(userHistory).not.toContain(`@${agents[4].name} job 5`);

    // Any one terminal frees this conversation's next slot. Keep the fifth
    // stream open long enough to observe queued → running deterministically.
    _releaseStream(gates[0]);
    expect(await waitUntil(() => _recordedCalls.some((call) => call.sid === fifthSid))).toBe(true);
    let fifthRunning = false;
    const runningDeadline = Date.now() + 2000;
    while (Date.now() < runningDeadline) {
      const latest = await tb.listTasks(TEST_UID, cid);
      if (latest.find((task) => task.assignee === agents[4].id)?.status === 'running') {
        fifthRunning = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(fifthRunning).toBe(true);
    userHistory = fs.readFileSync(messageFile, 'utf8')
      .split('\n').filter(Boolean).map((line) => JSON.parse(line))
      .filter((row: any) => row.from === 'user')
      .map((row: any) => row.text);
    expect(userHistory).toContain(`@${agents[4].name} job 5`);

    for (const gate of gates.slice(1)) _releaseStream(gate);
    await waitForQuiescent(TEST_UID, cid, 5000);
    rows = await tb.listTasks(TEST_UID, cid);
    expect(rows).toHaveLength(5);
    expect(rows.every((task) => task.status === 'done')).toBe(true);
  }, 20_000);

  it('parks Agent tasks while this conversation\'s pool is full and admits on release (D10)', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const sid = state.buildGmemberSessionId(cid, AGENT_ID);
    _setScript(sid, [{ type: 'final', text: 'gated job done' }]);

    // Fill only this conversation's Agent pool.
    const holds: Array<() => void> = [];
    for (;;) {
      const release = bus._reserveAgentSlotForTest(TEST_UID, cid);
      if (!release) break;
      holds.push(release);
    }

    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: `@${AGENT_NAME} gated job` });
    await new Promise((r) => setTimeout(r, 60));
    // Conversation pool full: not admitted, no model call, row still queued.
    expect(_recordedCalls.some((c) => c.sid === sid)).toBe(false);
    const tb = await import('../../../../src/main/features/group_chat/task_board');
    expect((await tb.listTasks(TEST_UID, cid)).map((t) => t.status)).toEqual(['queued']);

    // Releasing one slot from this conversation must kick its admission.
    holds.pop()!();
    await waitForQuiescent(TEST_UID, cid, 5000);
    expect(_recordedCalls.some((c) => c.sid === sid)).toBe(true);
    expect((await tb.listTasks(TEST_UID, cid)).map((t) => t.status)).toEqual(['done']);
    holds.forEach((r) => r());
  }, 15_000);

  it('does not let a full Agent pool in one conversation block another conversation', async () => {
    const saturatedCid = newCid();
    const targetCid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const tb = await import('../../../../src/main/features/group_chat/task_board');
    const targetSid = state.buildGmemberSessionId(targetCid, AGENT_ID);
    _setScript(targetSid, [{ type: 'final', text: 'OTHER-CONVERSATION-RAN' }]);

    const saturatedHolds: Array<() => void> = [];
    for (;;) {
      const release = bus._reserveAgentSlotForTest(TEST_UID, saturatedCid);
      if (!release) break;
      saturatedHolds.push(release);
    }

    try {
      await bus.enqueue({
        uid: TEST_UID,
        cid: targetCid,
        fromActorId: 'user',
        text: `@${AGENT_NAME} run independently`,
      });
      await waitForQuiescent(TEST_UID, targetCid, 5000);

      expect(_recordedCalls.filter((call) => call.sid === targetSid)).toHaveLength(1);
      expect((await tb.listTasks(TEST_UID, targetCid)).map((task) => task.status))
        .toEqual(['done']);
      const slots = bus._agentSlotsForTest(TEST_UID, saturatedCid);
      expect(slots.inUse).toBe(slots.cap);
    } finally {
      saturatedHolds.forEach((release) => release());
    }
  }, 15_000);

  // S6-OWN-3 (2026-09-08 decision): one failed bubble owns at most one pending
  // retry. A repeated Retry while that retry is still queued/running is a
  // no-op at the owning boundary (no second board row, no second "Continue"
  // row, no second model turn) and is reported as `already_pending` rather
  // than as an error. A different failed bubble is never deduped, and the
  // same bubble can be retried again once its pending retry finished.
  it('dedupes a repeated Retry of one failed bubble while its retry is pending, keeps other bubbles independent, and accepts it again after completion', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const groupChat = await import('../../../../src/main/features/group_chat');
    const paths = await import('../../../../src/main/paths');
    const tb = await import('../../../../src/main/features/group_chat/task_board');
    const sid = state.buildGmemberSessionId(cid, AGENT_ID);
    const firstSourceId = `${cid}-source-1`;
    const firstFailedId = `${cid}-failed-1`;
    const otherSourceId = `${cid}-source-2`;
    const otherFailedId = `${cid}-failed-2`;

    await state.seedReservedActors(TEST_UID, cid);
    const messageFile = path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`);
    fs.writeFileSync(messageFile, [
      JSON.stringify({
        id: firstSourceId,
        ts: '2026-08-31T01:00:00.000Z',
        from: 'user',
        to: [AGENT_ID],
        text: 'Run the first queued-retry task.',
        model_text: 'Run the authoritative first queued-retry task.',
      }),
      JSON.stringify({
        id: firstFailedId,
        ts: '2026-08-31T01:01:00.000Z',
        from: AGENT_ID,
        to: ['user'],
        text: 'The first attempt was interrupted.',
        failure_kind: 'runtime',
        failure_code: 'cli_timeout',
        source_message_id: firstSourceId,
        turn_id: `${cid}-turn-1`,
      }),
      JSON.stringify({
        id: otherSourceId,
        ts: '2026-08-31T01:02:00.000Z',
        from: 'user',
        to: [AGENT_ID],
        text: 'Run the other queued-retry task.',
        model_text: 'Run the authoritative other queued-retry task.',
      }),
      JSON.stringify({
        id: otherFailedId,
        ts: '2026-08-31T01:03:00.000Z',
        from: AGENT_ID,
        to: ['user'],
        text: 'The other attempt was interrupted.',
        failure_kind: 'runtime',
        failure_code: 'cli_timeout',
        source_message_id: otherSourceId,
        turn_id: `${cid}-turn-2`,
      }),
    ].join('\n') + '\n');

    _setScript(sid, [{ type: 'final', text: 'FIRST-BUBBLE-RETRY-DONE' }]);
    _setScript(sid, [{ type: 'final', text: 'OTHER-BUBBLE-RETRY-DONE' }]);
    _setScript(sid, [{ type: 'final', text: 'FIRST-BUBBLE-RETRIED-AGAIN-DONE' }]);

    // Reproduce a legitimate queue: other named Agents in THIS conversation
    // occupy its pool, so every accepted retry waits on the board.
    const holds: Array<() => void> = [];
    for (;;) {
      const release = bus._reserveAgentSlotForTest(TEST_UID, cid);
      if (!release) break;
      holds.push(release);
    }
    const retry = (failedMessageId: string, clientMsgId: string) => groupChat.retryFailedTurn({
      userId: TEST_UID,
      cid,
      failedMessageId,
      visibleText: 'Continue',
      client_msg_id: clientMsgId,
    });

    try {
      // Double-click: the second call lands before the first reached the board.
      const [first, second] = await Promise.all([
        retry(firstFailedId, `retry-first-${cid}`),
        retry(firstFailedId, `retry-second-${cid}`),
      ]);
      expect(first).toMatchObject({ ok: true, mode: 'restart' });
      expect(first.msg?.id).toBeTruthy();
      expect(second).toEqual({ ok: true, already_pending: true });
      // A later click while the accepted retry is still queued.
      expect(await retry(firstFailedId, `retry-third-${cid}`)).toEqual({ ok: true, already_pending: true });
      // A different failed bubble is not deduped against the first one.
      const other = await retry(otherFailedId, `retry-other-${cid}`);
      expect(other).toMatchObject({ ok: true, mode: 'restart' });
      expect(other.already_pending).toBeUndefined();

      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(_recordedCalls.filter((call) => call.sid === sid)).toHaveLength(0);
      expect((await tb.listTasks(TEST_UID, cid)).map((task) => task.status))
        .toEqual(['queued', 'queued']);
      let rows = fs.readFileSync(messageFile, 'utf8')
        .split('\n').filter(Boolean).map((line) => JSON.parse(line));
      expect(rows.filter((row: any) => row.from === 'user').map((row: any) => row.text))
        .toEqual(['Run the first queued-retry task.', 'Run the other queued-retry task.']);
      expect(rows.some((row: any) => String(row.client_msg_id || '').startsWith('retry-')))
        .toBe(false);

      // One released slot is enough: each completed retry hands the same
      // slot to the next queued retry for this stateful Agent session.
      const releaseOne = holds.pop();
      expect(releaseOne).toBeTruthy();
      releaseOne!();
      await waitForQuiescent(TEST_UID, cid, 5000);

      let calls = _recordedCalls.filter((call) => call.sid === sid);
      expect(calls.map((call) => call.message)).toEqual([
        expect.stringContaining('authoritative first queued-retry task'),
        expect.stringContaining('authoritative other queued-retry task'),
      ]);
      expect((await tb.listTasks(TEST_UID, cid)).map((task) => task.status))
        .toEqual(['done', 'done']);
      rows = fs.readFileSync(messageFile, 'utf8')
        .split('\n').filter(Boolean).map((line) => JSON.parse(line));
      expect(rows.filter((row: any) => row.from === 'user').map((row: any) => row.client_msg_id))
        .toEqual([undefined, undefined, `retry-first-${cid}`, `retry-other-${cid}`]);
      expect(rows.filter((row: any) => row.from === AGENT_ID).map((row: any) => row.text))
        .toEqual([
          'The first attempt was interrupted.',
          'The other attempt was interrupted.',
          'FIRST-BUBBLE-RETRY-DONE',
          'OTHER-BUBBLE-RETRY-DONE',
        ]);

      // The pending retry finished: the same bubble is retryable again.
      const again = await retry(firstFailedId, `retry-again-${cid}`);
      expect(again).toMatchObject({ ok: true, mode: 'restart' });
      expect(again.already_pending).toBeUndefined();
      await waitForQuiescent(TEST_UID, cid, 5000);

      calls = _recordedCalls.filter((call) => call.sid === sid);
      expect(calls).toHaveLength(3);
      expect((await tb.listTasks(TEST_UID, cid)).map((task) => task.status))
        .toEqual(['done', 'done', 'done']);
      rows = fs.readFileSync(messageFile, 'utf8')
        .split('\n').filter(Boolean).map((line) => JSON.parse(line));
      expect(rows.filter((row: any) => row.from === AGENT_ID).map((row: any) => row.text).at(-1))
        .toBe('FIRST-BUBBLE-RETRIED-AGAIN-DONE');
    } finally {
      holds.forEach((release) => release());
    }
  }, 20_000);

  it('commander occupies neither the cap nor the gate: an agent task runs beside a live commander turn', async () => {
    const prevCap = process.env.ORKAS_MAX_CONVERSATION_TASKS;
    process.env.ORKAS_MAX_CONVERSATION_TASKS = '1';
    try {
      const cid = newCid();
      const state = await import('../../../../src/main/features/group_chat/state');
      const bus = await import('../../../../src/main/features/group_chat/bus');
      const sidCmd = state.buildGconvSessionId(cid);
      const sidA = state.buildGmemberSessionId(cid, AGENT_ID);

      _holdStream('cmd-live');
      _setScript(sidCmd, [
        { type: '__wait_for_gate__', name: 'cmd-live' },
        { type: 'final', text: 'commander done' },
      ]);
      _setScript(sidA, [{ type: 'final', text: 'agent done' }]);

      await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'plan something' });
      expect(await waitUntil(() => _recordedCalls.some((c) => c.sid === sidCmd))).toBe(true);
      // Even at cap=1, the agent task is admitted beside the commander turn.
      await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: `@${AGENT_NAME} side job` });
      expect(await waitUntil(() => _recordedCalls.some((c) => c.sid === sidA))).toBe(true);

      _releaseStream('cmd-live');
      await waitForQuiescent(TEST_UID, cid, 5000);
    } finally {
      if (prevCap === undefined) delete process.env.ORKAS_MAX_CONVERSATION_TASKS;
      else process.env.ORKAS_MAX_CONVERSATION_TASKS = prevCap;
    }
  }, 15_000);
});

describe('group_chat bus integration › P4 reorder + reassign', () => {
  /**
   * Scenario value: the queued scan order the user rearranges must be the
   * order work actually starts in, a reorder must never jump the `after`
   * gate (scan order ≠ priority, §4.5), and a reassigned task must run as
   * the new agent under the same task id. Oracles: recorded model-call
   * order per session, the persisted canonical jsonl, and the board
   * snapshot — independent of the reorder/reassign return values.
   */
  async function seedSecondAgent() {
    const paths = await import('../../../../src/main/paths');
    const dir = paths.agentDir(TEST_UID, SECOND_AGENT_ID);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify({
      agent_id: SECOND_AGENT_ID, name: SECOND_AGENT_NAME,
      description: 'Researches things', workflow: 'do research',
      created_at: 't', updated_at: 't',
    }));
  }

  beforeEach(async () => {
    (await import('../../../../src/main/features/group_chat/task_board'))._resetForTest();
  });

  it('reorder changes which queued task starts first (same-actor backlog)', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const tb = await import('../../../../src/main/features/group_chat/task_board');
    const sid = state.buildGmemberSessionId(cid, AGENT_ID);

    _holdStream('reorder-first');
    _setScript(sid, [
      { type: '__wait_for_gate__', name: 'reorder-first' },
      { type: 'final', text: 'first done' },
    ]);
    _setScript(sid, [{ type: 'final', text: 'a reply' }]);
    _setScript(sid, [{ type: 'final', text: 'a reply' }]);

    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: `@${AGENT_NAME} first job` });
    expect(await waitUntil(() => _recordedCalls.some((c) => c.sid === sid))).toBe(true);
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: `@${AGENT_NAME} second job` });
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: `@${AGENT_NAME} third job` });

    // Board writes ride the per-cid chain, so rows created by the awaited
    // enqueues are visible to this listTasks (same pattern as the D10 case).
    const tasks = await tb.listTasks(TEST_UID, cid);
    expect(tasks).toHaveLength(3);
    const second = tasks.find((t) => t.instruction.includes('second job'))!;
    const third = tasks.find((t) => t.instruction.includes('third job'))!;
    expect((await bus.reorderConversationTask(TEST_UID, cid, third.task_id, second.task_id)).ok).toBe(true);

    _releaseStream('reorder-first');
    await waitForQuiescent(TEST_UID, cid, 5000);

    // Actual start order is the oracle: third overtook second.
    const messages = _recordedCalls.filter((c) => c.sid === sid).map((c) => c.message);
    expect(messages[0]).toContain('first job');
    expect(messages[1]).toContain('third job');
    expect(messages[2]).toContain('second job');
    // Every row terminated; the moved rows carry their rewritten scan order.
    expect((await tb.listTasks(TEST_UID, cid)).map((t) => t.status)).toEqual(['done', 'done', 'done']);
  }, 15_000);

  it('reorder is scan order, not priority: a front-moved task still waits for its after gate', async () => {
    await seedSecondAgent();
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const tb = await import('../../../../src/main/features/group_chat/task_board');
    const sidCmd = state.buildGconvSessionId(cid);
    const sidB = state.buildGmemberSessionId(cid, SECOND_AGENT_ID);

    _holdStream('reorder-cmd');
    _setScript(sidCmd, [
      { type: '__wait_for_gate__', name: 'reorder-cmd' },
      { type: 'final', text: 'commander done' },
    ]);
    _setScript(sidB, [{ type: 'final', text: 'b reply' }]);
    _setScript(sidB, [{ type: 'final', text: 'b reply' }]);

    // Commander runs (gate-exempt) while the full named gate parks both
    // agent tasks in queued state.
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'plan the work' });
    expect(await waitUntil(() => _recordedCalls.some((c) => c.sid === sidCmd))).toBe(true);
    const holds: Array<() => void> = [];
    for (;;) {
      const release = bus._reserveAgentSlotForTest(TEST_UID, cid);
      if (!release) break;
      holds.push(release);
    }
    try {
      await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: `@${SECOND_AGENT_NAME} early job` });
      await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: `@${SECOND_AGENT_NAME} chained job` });
      let tasks = await tb.listTasks(TEST_UID, cid);
      const cmdTask = tasks.find((t) => t.assignee === 'commander')!;
      const early = tasks.find((t) => t.instruction.includes('early job'))!;
      const chained = tasks.find((t) => t.instruction.includes('chained job'))!;
      expect((await bus.setConversationTaskAfter(TEST_UID, cid, chained.task_id, cmdTask.task_id)).ok).toBe(true);
      // Move the gated task to the FRONT of the scan order …
      expect((await bus.reorderConversationTask(TEST_UID, cid, chained.task_id, early.task_id)).ok).toBe(true);

      // … then free one slot: the front task is SKIPPED (unfinished after)
      // and the later one starts instead.
      holds.pop()!();
      expect(await waitUntil(() => _recordedCalls.some((c) => c.sid === sidB))).toBe(true);
      await new Promise((r) => setTimeout(r, 60));
      const bCalls = _recordedCalls.filter((c) => c.sid === sidB);
      expect(bCalls).toHaveLength(1);
      expect(bCalls[0].message).toContain('early job');

      // Only the predecessor's terminal releases the chained task.
      _releaseStream('reorder-cmd');
      await waitForQuiescent(TEST_UID, cid, 5000);
      const bMessages = _recordedCalls.filter((c) => c.sid === sidB).map((c) => c.message);
      expect(bMessages).toHaveLength(2);
      expect(bMessages[1]).toContain('chained job');
      tasks = await tb.listTasks(TEST_UID, cid);
      expect(tasks.find((t) => t.task_id === chained.task_id)?.status).toBe('done');
    } finally {
      holds.forEach((r) => r());
    }
  }, 15_000);

  it('reassign hands a queued task to another agent under the same task id', async () => {
    await seedSecondAgent();
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const tb = await import('../../../../src/main/features/group_chat/task_board');
    const paths = await import('../../../../src/main/paths');
    const storage = await import('../../../../src/main/storage');
    const sidA = state.buildGmemberSessionId(cid, AGENT_ID);
    const sidB = state.buildGmemberSessionId(cid, SECOND_AGENT_ID);

    _holdStream('reassign-first');
    _setScript(sidA, [
      { type: '__wait_for_gate__', name: 'reassign-first' },
      { type: 'final', text: 'writer done' },
    ]);
    _setScript(sidB, [{ type: 'final', text: 'researcher took it' }]);

    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: `@${AGENT_NAME} long job` });
    expect(await waitUntil(() => _recordedCalls.some((c) => c.sid === sidA))).toBe(true);
    // Same-actor serial keeps the follow-up queued behind the held turn.
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: `@${AGENT_NAME} handover job` });
    const queuedRow = (await tb.listTasks(TEST_UID, cid)).find((t) => t.instruction.includes('handover job'))!;
    expect(queuedRow.status).toBe('queued');

    // Reassigning to a bogus agent is rejected before any state changes.
    expect((await bus.reassignConversationTask(TEST_UID, cid, queuedRow.task_id, 'no-such-agent')).error).toBe('unknown_agent');
    expect((await bus.reassignConversationTask(TEST_UID, cid, queuedRow.task_id, SECOND_AGENT_ID)).ok).toBe(true);

    // The freed Researcher picks the task up immediately — Writer still held.
    expect(await waitUntil(() => _recordedCalls.some((c) => c.sid === sidB))).toBe(true);
    const handedOver = _recordedCalls.find((c) => c.sid === sidB)?.message || '';
    expect(handedOver).toContain('handover job');
    // The envelope names the new assignee; a `to="<old agent>"` header would
    // tell the Researcher the turn belongs to someone else.
    expect(handedOver).toContain(`to="${SECOND_AGENT_ID}"`);
    expect(handedOver).not.toContain(`to="${AGENT_ID}"`);
    const row = (await tb.listTasks(TEST_UID, cid)).find((t) => t.task_id === queuedRow.task_id)!;
    expect(row.assignee).toBe(SECOND_AGENT_ID);

    _releaseStream('reassign-first');
    await waitForQuiescent(TEST_UID, cid, 5000);
    // The reply is persisted from the NEW assignee; a running row is frozen.
    const messages = await storage.readJsonl<any>(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`));
    expect(messages.find((m: any) => m.text === 'researcher took it')?.from).toBe(SECOND_AGENT_ID);
    const writerRow = (await tb.listTasks(TEST_UID, cid)).find((t) => t.instruction.includes('long job'))!;
    expect((await bus.reassignConversationTask(TEST_UID, cid, writerRow.task_id, SECOND_AGENT_ID)).error).toBe('not_queued');
  }, 15_000);
});

describe('group_chat bus integration › per-task running cancel (P2)', () => {
  /**
   * Scenario value: stopping ONE running task must not become a
   * whole-conversation stop — the sibling execution finishes, follow-up
   * messages still run (no sticky 'aborted'), and only the cancelled task's
   * board row ends cancelled. Oracles: recorded model calls, board snapshot,
   * conversation status, sibling completion.
   */
  async function seedSecondAgent() {
    const paths = await import('../../../../src/main/paths');
    const dir = paths.agentDir(TEST_UID, SECOND_AGENT_ID);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify({
      agent_id: SECOND_AGENT_ID, name: SECOND_AGENT_NAME,
      description: 'Researches things', workflow: 'do research',
      created_at: 't', updated_at: 't',
    }));
  }

  beforeEach(async () => {
    (await import('../../../../src/main/features/group_chat/task_board'))._resetForTest();
  });

  it('stops only the targeted running execution; the sibling finishes and the conversation stays usable', async () => {
    await seedSecondAgent();
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const tb = await import('../../../../src/main/features/group_chat/task_board');
    const sidA = state.buildGmemberSessionId(cid, AGENT_ID);
    const sidB = state.buildGmemberSessionId(cid, SECOND_AGENT_ID);

    _holdStream('cancel-sibling');
    _setScript(sidA, [{ type: '__wait_for_abort__' }]);
    _setScript(sidB, [
      { type: '__wait_for_gate__', name: 'cancel-sibling' },
      { type: 'final', text: 'sibling finished' },
    ]);

    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: `@${AGENT_NAME} long doomed job` });
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: `@${SECOND_AGENT_NAME} sibling job` });
    expect(await waitUntil(() => _recordedCalls.some((c) => c.sid === sidA)
      && _recordedCalls.some((c) => c.sid === sidB))).toBe(true);

    const runningA = (await tb.listTasks(TEST_UID, cid))
      .find((t) => t.assignee === AGENT_ID && t.status === 'running');
    expect(runningA).toBeTruthy();
    const res = await bus.cancelConversationTask(TEST_UID, cid, runningA!.task_id);
    expect(res).toMatchObject({ ok: true, scope: 'running' });

    // A settles cancelled while B is STILL running.
    let aCancelled = false;
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const probe = await tb.listTasks(TEST_UID, cid);
      if (probe.some((t) => t.task_id === runningA!.task_id && t.status === 'cancelled')) {
        aCancelled = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(aCancelled).toBe(true);
    const midRows = await tb.listTasks(TEST_UID, cid);
    expect(midRows.find((t) => t.assignee === SECOND_AGENT_ID)?.status).toBe('running');

    _releaseStream('cancel-sibling');
    await waitForQuiescent(TEST_UID, cid, 5000);

    const rows = new Map((await tb.listTasks(TEST_UID, cid)).map((t) => [t.assignee, t.status]));
    expect(rows.get(AGENT_ID)).toBe('cancelled');
    expect(rows.get(SECOND_AGENT_ID)).toBe('done');
    // No sticky conversation abort: a fresh message still runs.
    expect((await state.readState(TEST_UID, cid)).status).not.toBe('aborted');
    _setScript(sidA, [{ type: 'final', text: 'post-cancel job done' }]);
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: `@${AGENT_NAME} fresh job` });
    await waitForQuiescent(TEST_UID, cid, 5000);
    expect(_recordedCalls.filter((c) => c.sid === sidA)).toHaveLength(2);
  }, 20_000);

  it('cancelling a running commander task stops only that turn', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const tb = await import('../../../../src/main/features/group_chat/task_board');
    const sidCmd = state.buildGconvSessionId(cid);
    _setScript(sidCmd, [{ type: '__wait_for_abort__' }]);

    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'endless planning' });
    expect(await waitUntil(() => _recordedCalls.some((c) => c.sid === sidCmd))).toBe(true);
    const running = (await tb.listTasks(TEST_UID, cid)).find((t) => t.status === 'running');
    expect(running?.assignee).toBe('commander');

    const res = await bus.cancelConversationTask(TEST_UID, cid, running!.task_id);
    expect(res).toMatchObject({ ok: true, scope: 'running' });
    await waitForQuiescent(TEST_UID, cid, 5000);
    expect((await tb.listTasks(TEST_UID, cid)).find((t) => t.task_id === running!.task_id)?.status)
      .toBe('cancelled');
    expect((await state.readState(TEST_UID, cid)).status).not.toBe('aborted');
  }, 15_000);
});

describe('group_chat bus integration › D11 floor write-order under parallelism', () => {
  it('an orchestration resume does not yank the floor away from the agent the user switched to', async () => {
    // Scenario: commander hands off to Writer (creating a resume ledger);
    // while Writer grinds, the user switches to Researcher (@B moves the
    // floor). Writer's handback then fires the orchestration resume — which
    // must NOT reset the floor to commander while it points at Researcher
    // (D11), or the user's live conversation target silently changes.
    const paths = await import('../../../../src/main/paths');
    const dir = paths.agentDir(TEST_UID, SECOND_AGENT_ID);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify({
      agent_id: SECOND_AGENT_ID, name: SECOND_AGENT_NAME,
      description: 'Researches things', workflow: 'do research',
      created_at: 't', updated_at: 't',
    }));
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const storage = await import('../../../../src/main/storage');

    _holdStream('d11-writer');
    _setScript(state.buildGconvSessionId(cid), [
      { type: '__call_tool__', name: 'hand_off_to', input: { to: AGENT_NAME, message: 'draft it', resume: 'compare the draft with the brief' } },
      { type: 'final', text: 'handing off' },
    ]);
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: '__wait_for_gate__', name: 'd11-writer' },
      { type: 'final', text: 'draft ready\n<handback />' },
    ]);
    _setScript(state.buildGmemberSessionId(cid, SECOND_AGENT_ID), [
      { type: 'final', text: 'quick answer' },
    ]);
    _setScript(state.buildGconvSessionId(cid), [
      { type: 'final', text: 'resumed synthesis' },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'prepare the draft' });
    expect(await waitUntil(
      () => _recordedCalls.some((c) => c.sid === state.buildGmemberSessionId(cid, AGENT_ID)),
    )).toBe(true);

    // User switches to Researcher mid-flight; the floor follows.
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: `@${SECOND_AGENT_NAME} quick question` });
    expect(await waitUntil(
      () => _recordedCalls.some((c) => c.sid === state.buildGmemberSessionId(cid, SECOND_AGENT_ID)),
    )).toBe(true);

    _releaseStream('d11-writer');
    await waitForQuiescent(TEST_UID, cid, 6000);
    await new Promise((r) => setTimeout(r, 100));

    // The resume really fired (the rule was exercised, not skipped) …
    const messages = await storage.readJsonl<any>(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`));
    expect(messages.some((m: any) => String(m.model_text || '').includes('orchestration-resume'))).toBe(true);
    // … and the floor still belongs to the agent the user chose.
    expect((await state.readState(TEST_UID, cid)).active_recipient).toBe(SECOND_AGENT_ID);
  }, 15_000);
});

describe('group_chat bus integration › after chain (P2, §4.8)', () => {
  /**
   * Scenario value: "B may not start before A finishes" must hold exactly —
   * released only by A's done, parked as blocked (user's decision) when A
   * fails, and never silently released or cascade-cancelled. Oracles: model
   * call absence/presence, board snapshots, and the queue/blocked state.
   * Setup fills the current conversation's pool to keep tasks queued long enough to attach
   * the dependency deterministically.
   */
  async function seedSecondAgent() {
    const paths = await import('../../../../src/main/paths');
    const dir = paths.agentDir(TEST_UID, SECOND_AGENT_ID);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify({
      agent_id: SECOND_AGENT_ID, name: SECOND_AGENT_NAME,
      description: 'Researches things', workflow: 'do research',
      created_at: 't', updated_at: 't',
    }));
  }

  beforeEach(async () => {
    (await import('../../../../src/main/features/group_chat/task_board'))._resetForTest();
  });

  it('releases the dependent task only when its predecessor reaches done', async () => {
    await seedSecondAgent();
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const tb = await import('../../../../src/main/features/group_chat/task_board');
    const sidA = state.buildGmemberSessionId(cid, AGENT_ID);
    const sidB = state.buildGmemberSessionId(cid, SECOND_AGENT_ID);

    _holdStream('after-a');
    _setScript(sidA, [
      { type: '__wait_for_gate__', name: 'after-a' },
      { type: 'final', text: 'a done' },
    ]);
    _setScript(sidB, [{ type: 'final', text: 'b done' }]);

    // Park both tasks by filling this conversation's pool, attach B→A, then
    // release the gate: A starts, B must keep waiting on the chain even
    // though cap and gate are free.
    const holds: Array<() => void> = [];
    for (;;) {
      const r = bus._reserveAgentSlotForTest(TEST_UID, cid);
      if (!r) break;
      holds.push(r);
    }
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: `@${AGENT_NAME} do a` });
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: `@${SECOND_AGENT_NAME} do b based on the result above` });
    const rows = await tb.listTasks(TEST_UID, cid);
    const taskA = rows.find((t) => t.assignee === AGENT_ID)!;
    const taskB = rows.find((t) => t.assignee === SECOND_AGENT_ID)!;
    expect((await bus.setConversationTaskAfter(TEST_UID, cid, taskB.task_id, taskA.task_id)).ok).toBe(true);

    holds.forEach((r) => r());
    expect(await waitUntil(() => _recordedCalls.some((c) => c.sid === sidA))).toBe(true);
    await new Promise((r) => setTimeout(r, 60));
    // A runs; B is chain-gated despite free capacity.
    expect(_recordedCalls.some((c) => c.sid === sidB)).toBe(false);

    _releaseStream('after-a');
    await waitForQuiescent(TEST_UID, cid, 6000);
    expect(_recordedCalls.some((c) => c.sid === sidB)).toBe(true);
    const finalRows = new Map((await tb.listTasks(TEST_UID, cid)).map((t) => [t.assignee, t.status]));
    expect(finalRows.get(AGENT_ID)).toBe('done');
    expect(finalRows.get(SECOND_AGENT_ID)).toBe('done');
  }, 15_000);

  it('parks the dependent task as blocked when the predecessor fails, and "run anyway" releases it', async () => {
    await seedSecondAgent();
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const tb = await import('../../../../src/main/features/group_chat/task_board');
    const sidA = state.buildGmemberSessionId(cid, AGENT_ID);
    const sidB = state.buildGmemberSessionId(cid, SECOND_AGENT_ID);

    _setScript(sidA, [{ type: 'error', text: 'boom', failureKind: 'model', failureCode: 'provider_error' }]);
    _setScript(sidB, [{ type: 'final', text: 'b ran anyway' }]);

    const holds: Array<() => void> = [];
    for (;;) {
      const r = bus._reserveAgentSlotForTest(TEST_UID, cid);
      if (!r) break;
      holds.push(r);
    }
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: `@${AGENT_NAME} doomed job` });
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: `@${SECOND_AGENT_NAME} dependent job` });
    const rows = await tb.listTasks(TEST_UID, cid);
    const taskA = rows.find((t) => t.assignee === AGENT_ID)!;
    const taskB = rows.find((t) => t.assignee === SECOND_AGENT_ID)!;
    expect((await bus.setConversationTaskAfter(TEST_UID, cid, taskB.task_id, taskA.task_id)).ok).toBe(true);

    holds.forEach((r) => r());
    await waitForQuiescent(TEST_UID, cid, 6000);
    await new Promise((r) => setTimeout(r, 100));

    // A failed; B is parked blocked — neither run nor cancelled (§4.8).
    expect(_recordedCalls.some((c) => c.sid === sidB)).toBe(false);
    const mid = new Map((await tb.listTasks(TEST_UID, cid)).map((t) => [t.assignee, t.status]));
    expect(mid.get(AGENT_ID)).toBe('failed');
    expect(mid.get(SECOND_AGENT_ID)).toBe('blocked');

    // The user decides: run anyway.
    expect((await bus.resumeBlockedTask(TEST_UID, cid, taskB.task_id)).ok).toBe(true);
    await waitForQuiescent(TEST_UID, cid, 6000);
    expect(_recordedCalls.some((c) => c.sid === sidB)).toBe(true);
    expect((await tb.listTasks(TEST_UID, cid)).find((t) => t.assignee === SECOND_AGENT_ID)?.status).toBe('done');
  }, 15_000);
});

describe('group_chat bus integration › D9 mention segmentation dispatch', () => {
  it('dispatches each described recipient once per group and keeps the surviving single default', async () => {
    const paths = await import('../../../../src/main/paths');
    const dir = paths.agentDir(TEST_UID, SECOND_AGENT_ID);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify({
      agent_id: SECOND_AGENT_ID, name: SECOND_AGENT_NAME,
      description: 'Reviewer', workflow: 'Review', created_at: 't', updated_at: 't',
    }));
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const tb = await import('../../../../src/main/features/group_chat/task_board');
    const cid = newCid();
    const sid = state.buildGmemberSessionId(cid, AGENT_ID);
    _setScript(sid, [{ type: 'final', text: 'checked' }]);
    const msg = await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user',
      text: `@${AGENT_NAME} @${AGENT_NAME} inspect @${SECOND_AGENT_NAME}` });
    await waitForQuiescent(TEST_UID, cid, 6000);
    expect(msg.to).toEqual([AGENT_ID]);
    const tasks = await tb.listTasks(TEST_UID, cid);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ assignee: AGENT_ID, instruction: 'inspect' });
    expect((await state.readState(TEST_UID, cid)).active_recipient).toBe(AGENT_ID);

    const callsBefore = _recordedCalls.length;
    const empty = await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: `@${SECOND_AGENT_NAME}` });
    await waitForQuiescent(TEST_UID, cid, 6000);
    expect(empty.to).toEqual([]);
    expect(await tb.listTasks(TEST_UID, cid)).toHaveLength(1);
    expect(_recordedCalls.length).toBe(callsBefore);
  }, 15_000);

  it.each([AGENT_ID, 'commander'])('sends unknown names and code examples to default %s without accidental dispatch', async (recipient) => {
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const cid = newCid();
    const sid = recipient === 'commander' ? state.buildGconvSessionId(cid) : state.buildGmemberSessionId(cid, recipient);
    _setScript(sid, [{ type: 'final', text: 'explained' }]);
    await state.setActiveRecipient(TEST_UID, cid, recipient, 'user_selection');
    const msg = await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user',
      text: '@missing-agent explain `@commander` and this example:\n```xml\n@commander\n```' });
    await waitForQuiescent(TEST_UID, cid, 6000);
    expect(msg.to).toEqual([recipient]);
    expect(msg.text).toContain('`@commander`');
    expect(msg.text).toContain('```xml\n@commander\n```');
    expect(_recordedCalls.filter((call) => call.sid === sid)).toHaveLength(1);
    expect(_recordedCalls.every((call) => call.sid === sid)).toBe(true);
    expect((await state.readState(TEST_UID, cid)).active_recipient).toBe(recipient === 'commander' ? undefined : recipient);
  }, 15_000);

  it('assigns an unaddressed first instruction to Commander and chains the explicit Agent segments', async () => {
    // The first unaddressed instruction belongs to the current Commander.
    // Later mentions open distinct instructions in the existing serial order.
    const paths = await import('../../../../src/main/paths');
    const dir = paths.agentDir(TEST_UID, SECOND_AGENT_ID);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify({
      agent_id: SECOND_AGENT_ID, name: SECOND_AGENT_NAME,
      description: 'Researches things', workflow: 'do research',
      created_at: 't', updated_at: 't',
    }));
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const tb = await import('../../../../src/main/features/group_chat/task_board');
    const storage = await import('../../../../src/main/storage');
    const sidA = state.buildGmemberSessionId(cid, AGENT_ID);
    const sidB = state.buildGmemberSessionId(cid, SECOND_AGENT_ID);
    const sidCmd = state.buildGconvSessionId(cid);
    _setScript(sidCmd, [{ type: 'final', text: 'noted the deadline' }]);
    _setScript(sidA, [{ type: 'final', text: 'draft done' }]);
    _setScript(sidB, [{ type: 'final', text: 'research done' }]);

    const userMsg = await bus.enqueue({
      uid: TEST_UID, cid, fromActorId: 'user',
      text: `before tomorrow: @${AGENT_NAME} WRITE_THE_DRAFT in docs. @${SECOND_AGENT_NAME} RESEARCH_THE_TOPIC deeply.`,
    });
    await waitForQuiescent(TEST_UID, cid, 6000);

    expect(_recordedCalls.some((c) => c.sid === sidCmd)).toBe(true);
    const callA = _recordedCalls.find((c) => c.sid === sidA)!;
    const callB = _recordedCalls.find((c) => c.sid === sidB)!;
    expect(_recordedCalls.find((c) => c.sid === sidCmd)?.message).toContain('before tomorrow:');
    expect(callA.message).toContain('WRITE_THE_DRAFT');
    expect(callA.message).not.toContain('RESEARCH_THE_TOPIC');
    expect(callB.message).toContain('RESEARCH_THE_TOPIC');
    expect(callB.message).not.toContain('WRITE_THE_DRAFT');

    // Three board tasks share the one source message; instructions are
    // per-segment and the serial default chains written order.
    const rows = await tb.listTasks(TEST_UID, cid);
    expect(rows).toHaveLength(3);
    expect(rows.every((t) => t.source_msg_id === userMsg.id && t.status === 'done')).toBe(true);
    const byAssignee = new Map(rows.map((t) => [t.assignee, t.instruction]));
    expect(byAssignee.get('commander')).toBe('before tomorrow:');
    expect(byAssignee.get(AGENT_ID)).toContain('WRITE_THE_DRAFT');
    expect(byAssignee.get(AGENT_ID)).not.toContain('RESEARCH_THE_TOPIC');
    expect(byAssignee.get(AGENT_ID)).not.toContain('before tomorrow:');
    expect(byAssignee.get(SECOND_AGENT_ID)).toContain('RESEARCH_THE_TOPIC');
    const byId = new Map(rows.map((t) => [t.assignee, t]));
    expect(byId.get(AGENT_ID)?.after).toBe(byId.get('commander')?.task_id);
    expect(byId.get(SECOND_AGENT_ID)?.after).toBe(byId.get(AGENT_ID)?.task_id);

    // Still exactly ONE user bubble with the full text.
    const messages = await storage.readJsonl<any>(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`));
    const userRows = messages.filter((m: any) => m.from === 'user');
    expect(userRows).toHaveLength(1);
    expect(userRows[0].text).toContain('WRITE_THE_DRAFT');
    expect(userRows[0].text).toContain('RESEARCH_THE_TOPIC');
    expect(new Set(userRows[0].to)).toEqual(new Set(['commander', AGENT_ID, SECOND_AGENT_ID]));
  }, 15_000);

  it('D23: an adjacent group defaults to parallel but chains when the user flips the order to serial', async () => {
    // Scenario value: the composer now surfaces the order choice for EVERY
    // multi-agent send. `@A @B do X` stays a parallel unit by default; the
    // explicit serial flip must really chain the shared-span segments in
    // written order instead of silently staying parallel.
    const paths = await import('../../../../src/main/paths');
    const dir = paths.agentDir(TEST_UID, SECOND_AGENT_ID);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify({
      agent_id: SECOND_AGENT_ID, name: SECOND_AGENT_NAME,
      description: 'Researches things', workflow: 'do research',
      created_at: 't', updated_at: 't',
    }));
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const tb = await import('../../../../src/main/features/group_chat/task_board');

    // Default: one adjacent group → no chain (both start-eligible at once).
    const cidParallel = newCid();
    _setScript(state.buildGmemberSessionId(cidParallel, AGENT_ID), [{ type: 'final', text: 'a done' }]);
    _setScript(state.buildGmemberSessionId(cidParallel, SECOND_AGENT_ID), [{ type: 'final', text: 'b done' }]);
    await bus.enqueue({
      uid: TEST_UID, cid: cidParallel, fromActorId: 'user',
      text: `@${AGENT_NAME} @${SECOND_AGENT_NAME} ADJACENT_CHECK_THIS`,
    });
    await waitForQuiescent(TEST_UID, cidParallel, 6000);
    const parallelRows = await tb.listTasks(TEST_UID, cidParallel);
    expect(parallelRows).toHaveLength(2);
    expect(parallelRows.every((t) => !t.after)).toBe(true);

    // Explicit serial: same text, flipped order → written-order chain.
    const cidSerial = newCid();
    _setScript(state.buildGmemberSessionId(cidSerial, AGENT_ID), [{ type: 'final', text: 'a done' }]);
    _setScript(state.buildGmemberSessionId(cidSerial, SECOND_AGENT_ID), [{ type: 'final', text: 'b done' }]);
    await bus.enqueue({
      uid: TEST_UID, cid: cidSerial, fromActorId: 'user',
      text: `@${AGENT_NAME} @${SECOND_AGENT_NAME} ADJACENT_CHECK_THIS`,
      multiDispatch: 'serial',
    });
    await waitForQuiescent(TEST_UID, cidSerial, 6000);
    const serialRows = await tb.listTasks(TEST_UID, cidSerial);
    const first = serialRows.find((t) => t.assignee === AGENT_ID);
    const second = serialRows.find((t) => t.assignee === SECOND_AGENT_ID);
    expect(first?.after).toBeUndefined();
    expect(second?.after).toBe(first?.task_id);
    expect(serialRows.every((t) => t.status === 'done')).toBe(true);
  }, 20_000);
});

describe('group_chat bus integration › chip-set floor before first dispatch', () => {
  it('returns to Commander immediately after accepting multiple recipients and keeps later single choices', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
    const storage = await import('../../../../src/main/storage');
    const dir = paths.agentDir(TEST_UID, SECOND_AGENT_ID);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify({
      agent_id: SECOND_AGENT_ID, name: SECOND_AGENT_NAME,
      description: 'Reviewer', workflow: 'Review the request', created_at: 't', updated_at: 't',
    }));
    const sidA = state.buildGmemberSessionId(cid, AGENT_ID);
    const sidB = state.buildGmemberSessionId(cid, SECOND_AGENT_ID);
    _setScript(sidA, [{ type: 'final', text: 'first answer' }]);
    _setScript(sidB, [{ type: 'final', text: 'second answer' }]);
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: `@${AGENT_NAME} @${SECOND_AGENT_NAME} review this` });
    expect((await state.readState(TEST_UID, cid)).active_recipient).toBeUndefined();
    expect((await state.readState(TEST_UID, cid)).active_recipients).toBeUndefined();
    await waitForQuiescent(TEST_UID, cid, 6000);
    _setScript(state.buildGconvSessionId(cid), [{ type: 'final', text: 'Commander follow-up' }]);
    const callsBefore = _recordedCalls.length;
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'also check the sources' });
    await waitForQuiescent(TEST_UID, cid, 6000);
    expect(_recordedCalls.slice(callsBefore).map((call) => call.sid).sort()).toEqual([state.buildGconvSessionId(cid)]);
    const rows = await storage.readJsonl<any>(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`));
    expect(rows.filter((row) => row.from === AGENT_ID)).toHaveLength(1);
    expect(rows.filter((row) => row.from === SECOND_AGENT_ID)).toHaveLength(1);
    const lastCalls = _recordedCalls.length;
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: `@${SECOND_AGENT_NAME} summarize` });
    await waitForQuiescent(TEST_UID, cid, 6000);
    expect(_recordedCalls.slice(lastCalls).map((call) => call.sid)).toEqual([sidB]);
    const floor = await state.readState(TEST_UID, cid);
    expect(floor.active_recipient).toBe(SECOND_AGENT_ID);
    expect(floor.active_recipients).toBeUndefined();

    // Repeated mentions of one Agent remain a single default recipient.
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: `@${SECOND_AGENT_NAME} first @${SECOND_AGENT_NAME} second` });
    expect((await state.readState(TEST_UID, cid)).active_recipient).toBe(SECOND_AGENT_ID);
    await waitForQuiescent(TEST_UID, cid, 6000);
  }, 20_000);

  it('a mention-less user message reaches the chip-selected agent that never spoke here; a dead floor still falls to commander', async () => {
    // Scenario value: the composer chip sets the floor WITHOUT synthesizing a
    // mention (D9 UI half) — so a freshly selected agent has no roster row
    // until its first dispatch auto-adds it, and the router's member gate
    // silently rerouted that first message to the commander ("给：Claude Code"
    // answered by 指挥官, on-device 2026-08-23). Oracles: the agent's model
    // session receives the turn, its reply persists, and it lands on the
    // roster; the dead-route fallback keeps its own oracle.
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
    const storage = await import('../../../../src/main/storage');
    const sid = state.buildGmemberSessionId(cid, AGENT_ID);
    _setScript(sid, [{ type: 'final', text: 'floor agent reporting' }]);

    await state.setActiveRecipient(TEST_UID, cid, AGENT_ID, 'user_selection');
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: '你好' });
    await waitForQuiescent(TEST_UID, cid, 6000);

    expect(_recordedCalls.some((c) => c.sid === sid), 'chip-selected agent must get the turn').toBe(true);
    const messages = await storage.readJsonl<any>(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`));
    expect(messages.some((m: any) => m.text === 'floor agent reporting')).toBe(true);
    const members = await state.readMembers(TEST_UID, cid);
    expect(members.actors.some((a) => a.id === AGENT_ID), 'first dispatch auto-adds the roster row').toBe(true);

    // Dead-route protection intact: a floor naming a nonexistent agent is
    // cleared and the message defaults to the commander.
    const cid2 = newCid();
    const commanderSid = state.buildGconvSessionId(cid2);
    _setScript(commanderSid, [{ type: 'final', text: 'commander took it' }]);
    await state.setActiveRecipient(TEST_UID, cid2, 'nosuchagent99', 'user_selection');
    await bus.enqueue({ uid: TEST_UID, cid: cid2, fromActorId: 'user', text: 'hello' });
    await waitForQuiescent(TEST_UID, cid2, 6000);
    expect(_recordedCalls.some((c) => c.sid === commanderSid)).toBe(true);
  }, 15_000);
});

describe('group_chat bus integration › D9 cross-group serial default (2026-08-23 adjudication)', () => {
  /**
   * Scenario value: "@A 写介绍 然后 @B 做成ppt" written as ONE message means
   * B consumes A's output — starting B in parallel produced a PPT from
   * nothing (observed on-device 2026-08-23). Written order is the ordering
   * signal (no connective-word parsing); `parallel` is the explicit opt-out;
   * a pure adjacent-mention group stays parallel. Oracles: recorded model
   * calls (start interleaving + exact turn input), board rows (`after`
   * pointer + terminals), and live execution snapshots.
   */
  async function seedSecondAgent() {
    const paths = await import('../../../../src/main/paths');
    const dir = paths.agentDir(TEST_UID, SECOND_AGENT_ID);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify({
      agent_id: SECOND_AGENT_ID, name: SECOND_AGENT_NAME,
      description: 'Researches things', workflow: 'do research',
      created_at: 't', updated_at: 't',
    }));
  }

  beforeEach(async () => {
    (await import('../../../../src/main/features/group_chat/task_board'))._resetForTest();
  });

  it('a two-group message runs the later agent only AFTER the earlier one, handing over its result', async () => {
    await seedSecondAgent();
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const tb = await import('../../../../src/main/features/group_chat/task_board');
    const sidA = state.buildGmemberSessionId(cid, AGENT_ID);
    const sidB = state.buildGmemberSessionId(cid, SECOND_AGENT_ID);

    _holdStream('serial-chain-a');
    _setScript(sidA, [
      { type: '__wait_for_gate__', name: 'serial-chain-a' },
      { type: 'final', text: 'INTRO_DRAFT_RESULT ready' },
    ]);
    _setScript(sidB, [{ type: 'final', text: 'ppt made' }]);

    await bus.enqueue({
      uid: TEST_UID, cid, fromActorId: 'user',
      text: `@${AGENT_NAME} WRITE_THE_INTRO now. @${SECOND_AGENT_NAME} MAKE_THE_PPT from it.`,
    });

    // While A runs, B must not have started: queued behind the after gate,
    // NOT merely behind a busy cap (the board row names the dependency).
    expect(await waitUntil(() => _recordedCalls.some((c) => c.sid === sidA))).toBe(true);
    await new Promise((r) => setTimeout(r, 60));
    expect(_recordedCalls.some((c) => c.sid === sidB)).toBe(false);
    const rowsWhileRunning = await tb.listTasks(TEST_UID, cid);
    const rowA = rowsWhileRunning.find((t) => t.assignee === AGENT_ID)!;
    const rowB = rowsWhileRunning.find((t) => t.assignee === SECOND_AGENT_ID)!;
    expect(rowA.status).toBe('running');
    expect(rowB.status).toBe('queued');
    expect(rowB.after).toBe(rowA.task_id);

    _releaseStream('serial-chain-a');
    await waitForQuiescent(TEST_UID, cid, 6000);

    // B's turn input = its own segment + the predecessor hand-off block
    // (A's persisted reply), never A's instruction text.
    const callB = _recordedCalls.find((c) => c.sid === sidB)!;
    expect(callB.message).toContain('MAKE_THE_PPT');
    expect(callB.message).toContain('<predecessor-task-result');
    expect(callB.message).toContain('INTRO_DRAFT_RESULT ready');
    expect(callB.message).not.toContain('WRITE_THE_INTRO');
    const rows = await tb.listTasks(TEST_UID, cid);
    expect(rows).toHaveLength(2);
    expect(rows.every((t) => t.status === 'done')).toBe(true);
  }, 15_000);

  it('the chain handover never reports a quiescent bus (stream-close regression)', async () => {
    // Scenario value: the IPC send/event streams break out on isQuiescent.
    // Between the predecessor's turn ending and the successor's execution
    // registering, the admission loop awaits IO with the item in neither
    // `queue` nor `executions` — a false idle there closes the streams and
    // the successor's ENTIRE turn (task_state running, placeholder, process
    // events) runs invisibly. On-device 2026-08-23: the board kept showing
    // the auto-released task as queued and the user cancelled a running
    // turn believing the chain was stuck. Oracle: a setImmediate poller —
    // the gap's fs awaits yield the macrotask queue, so a false idle IS
    // observed by this probe on the unfixed code (verified via negative
    // control: removing the admittedInFlight guard fails this test).
    await seedSecondAgent();
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const sidA = state.buildGmemberSessionId(cid, AGENT_ID);
    const sidB = state.buildGmemberSessionId(cid, SECOND_AGENT_ID);
    _setScript(sidA, [{ type: 'final', text: 'first result' }]);
    _setScript(sidB, [{ type: 'final', text: 'second result' }]);

    let sawIdleMidChain = false;
    let stopPolling = false;
    const poll = () => {
      if (stopPolling) return;
      if (_recordedCalls.some((c) => c.sid === sidB)) { stopPolling = true; return; }
      if (bus.isQuiescent(TEST_UID, cid)) sawIdleMidChain = true;
      setImmediate(poll);
    };

    const sendPromise = bus.enqueue({
      uid: TEST_UID, cid, fromActorId: 'user',
      text: `@${AGENT_NAME} do the first part. @${SECOND_AGENT_NAME} finish from it.`,
    });
    poll();
    await sendPromise;
    await waitForQuiescent(TEST_UID, cid, 6000);
    stopPolling = true;

    expect(_recordedCalls.some((c) => c.sid === sidB), 'successor must run').toBe(true);
    expect(sawIdleMidChain, 'bus must never look idle before the successor starts').toBe(false);
  }, 15_000);

  it('a chained successor admitted after a Stop landed is dropped, not started (GC-1)', async () => {
    // Scenario value: an `after`-gated task's admission fires at the
    // predecessor's terminal, an arbitrary time after the user's send — so a
    // whole-conversation Stop can land in the admission-latch window where
    // the item is already out of the queue (abort's queue-clear misses it)
    // but not yet a registered execution. The sticky-abort gate used to skip
    // user-origin items entirely; a successor slipping through would spawn a
    // fresh model turn AFTER the user pressed Stop. Construction: write the
    // sticky 'aborted' status directly (the exact state the race produces)
    // while the predecessor still runs, then let it finish and release the
    // gate. Oracle: the successor's model session is never called and its
    // board row ends cancelled.
    await seedSecondAgent();
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const tb = await import('../../../../src/main/features/group_chat/task_board');
    const sidA = state.buildGmemberSessionId(cid, AGENT_ID);
    const sidB = state.buildGmemberSessionId(cid, SECOND_AGENT_ID);
    _holdStream('gc1-a');
    _setScript(sidA, [
      { type: '__wait_for_gate__', name: 'gc1-a' },
      { type: 'final', text: 'first done' },
    ]);
    _setScript(sidB, [{ type: 'final', text: 'must never run' }]);

    await bus.enqueue({
      uid: TEST_UID, cid, fromActorId: 'user',
      text: `@${AGENT_NAME} slow first. @${SECOND_AGENT_NAME} dependent second.`,
    });
    expect(await waitUntil(() => _recordedCalls.some((c) => c.sid === sidA))).toBe(true);
    // Stop's status write lands while A still runs (sticky until a fresh
    // user enqueue) — the successor must observe it at admission.
    await state.setStatus(TEST_UID, cid, 'aborted');
    _releaseStream('gc1-a');
    await waitForQuiescent(TEST_UID, cid, 6000);

    expect(_recordedCalls.some((c) => c.sid === sidB), 'successor must not start after Stop').toBe(false);
    const rows = await tb.listTasks(TEST_UID, cid);
    expect(rows.find((t) => t.assignee === SECOND_AGENT_ID)?.status).toBe('cancelled');
  }, 15_000);

  it('parking a blocked successor publishes the blocked task_state BEFORE the bus can look idle', async () => {
    // Scenario value: cancelling the running predecessor blocks the successor
    // for the user's §4.8 decision — but the blocked write used to be
    // fire-and-forget, so the bus looked idle first, the IPC streams closed,
    // and the `task_state: blocked` had no subscriber: the board kept the row
    // painted queued with no run-anyway affordance (live-app probe
    // 2026-08-23). Oracle: a setImmediate poller must never observe a
    // quiescent bus after the cancel until the blocked event has been
    // delivered to a subscriber.
    await seedSecondAgent();
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const tb = await import('../../../../src/main/features/group_chat/task_board');
    const sidA = state.buildGmemberSessionId(cid, AGENT_ID);
    const sidB = state.buildGmemberSessionId(cid, SECOND_AGENT_ID);
    _setScript(sidA, [{ type: '__wait_for_abort__' }]);
    _setScript(sidB, [{ type: 'final', text: 'ran after decision' }]);

    let blockedSeen = false;
    bus.subscribe(TEST_UID, cid, (ev: any) => {
      if (ev.type === 'task_state' && ev.task?.status === 'blocked') blockedSeen = true;
    });
    await bus.enqueue({
      uid: TEST_UID, cid, fromActorId: 'user',
      text: `@${AGENT_NAME} doomed first step. @${SECOND_AGENT_NAME} dependent second step.`,
    });
    expect(await waitUntil(() => _recordedCalls.some((c) => c.sid === sidA))).toBe(true);
    const rows = await tb.listTasks(TEST_UID, cid);
    const taskA = rows.find((t) => t.assignee === AGENT_ID)!;
    const taskB = rows.find((t) => t.assignee === SECOND_AGENT_ID)!;

    let sawIdleBeforeBlocked = false;
    let stopPolling = false;
    const poll = () => {
      if (stopPolling || blockedSeen) return;
      if (bus.isQuiescent(TEST_UID, cid)) sawIdleBeforeBlocked = true;
      setImmediate(poll);
    };
    poll();
    const cancelRes = await bus.cancelConversationTask(TEST_UID, cid, taskA.task_id);
    expect(cancelRes.ok).toBe(true);
    expect(await waitUntil(() => blockedSeen, 6000)).toBe(true);
    stopPolling = true;
    expect(sawIdleBeforeBlocked, 'bus must not look idle before the blocked state is published').toBe(false);

    // The user's run-anyway decision releases the successor.
    const resume = await bus.resumeBlockedTask(TEST_UID, cid, taskB.task_id);
    expect(resume.ok).toBe(true);
    await waitForQuiescent(TEST_UID, cid, 6000);
    const end = await tb.listTasks(TEST_UID, cid);
    expect(end.find((t) => t.task_id === taskA.task_id)?.status).toBe('cancelled');
    expect(end.find((t) => t.task_id === taskB.task_id)?.status).toBe('done');
  }, 15_000);

  it('multiDispatch=parallel opts a two-group message back into concurrent dispatch with no chain', async () => {
    await seedSecondAgent();
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const tb = await import('../../../../src/main/features/group_chat/task_board');
    const sidA = state.buildGmemberSessionId(cid, AGENT_ID);
    const sidB = state.buildGmemberSessionId(cid, SECOND_AGENT_ID);

    _holdStream('par-a');
    _holdStream('par-b');
    _setScript(sidA, [
      { type: '__wait_for_gate__', name: 'par-a' },
      { type: 'final', text: 'a done' },
    ]);
    _setScript(sidB, [
      { type: '__wait_for_gate__', name: 'par-b' },
      { type: 'final', text: 'b done' },
    ]);

    await bus.enqueue({
      uid: TEST_UID, cid, fromActorId: 'user',
      multiDispatch: 'parallel',
      text: `@${AGENT_NAME} do part one. @${SECOND_AGENT_NAME} do part two.`,
    });

    // Both streams live at once — the explicit opt-out restores D9 parallel.
    expect(await waitUntil(() => _recordedCalls.some((c) => c.sid === sidA)
      && _recordedCalls.some((c) => c.sid === sidB))).toBe(true);
    const rows = await tb.listTasks(TEST_UID, cid);
    expect(rows.every((t) => !t.after)).toBe(true);

    _releaseStream('par-a');
    _releaseStream('par-b');
    await waitForQuiescent(TEST_UID, cid, 6000);
    const callB = _recordedCalls.find((c) => c.sid === sidB)!;
    expect(callB.message).not.toContain('<predecessor-task-result');
  }, 15_000);

  it('a pure adjacent-mention send (one group) stays parallel under the serial default', async () => {
    await seedSecondAgent();
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const tb = await import('../../../../src/main/features/group_chat/task_board');
    const sidA = state.buildGmemberSessionId(cid, AGENT_ID);
    const sidB = state.buildGmemberSessionId(cid, SECOND_AGENT_ID);

    _holdStream('adj-a');
    _holdStream('adj-b');
    _setScript(sidA, [
      { type: '__wait_for_gate__', name: 'adj-a' },
      { type: 'final', text: 'a checked' },
    ]);
    _setScript(sidB, [
      { type: '__wait_for_gate__', name: 'adj-b' },
      { type: 'final', text: 'b checked' },
    ]);

    await bus.enqueue({
      uid: TEST_UID, cid, fromActorId: 'user',
      text: `@${AGENT_NAME} @${SECOND_AGENT_NAME} CHECK_THE_REPORT together`,
    });

    expect(await waitUntil(() => _recordedCalls.some((c) => c.sid === sidA)
      && _recordedCalls.some((c) => c.sid === sidB))).toBe(true);
    const rows = await tb.listTasks(TEST_UID, cid);
    expect(rows).toHaveLength(2);
    expect(rows.every((t) => !t.after)).toBe(true);

    _releaseStream('adj-a');
    _releaseStream('adj-b');
    await waitForQuiescent(TEST_UID, cid, 6000);
  }, 15_000);
});

describe('group_chat bus integration › P3 scheduled dispatch_to sub-tasks', () => {
  /**
   * Scenario value: the commander's decomposition is now ON the board — each
   * dispatch_to child is a visible, individually cancellable task — and a
   * user cancel must reach the commander as a structured aborted result it
   * can gracefully wind down from, never as a hang or a whole-conversation
   * stop. Oracles: board rows (created_by/parent linkage/terminals), the
   * recorded dispatch tool result payloads, and conversation status.
   */
  beforeEach(async () => {
    (await import('../../../../src/main/features/group_chat/task_board'))._resetForTest();
  });

  it('a dispatch_to child lands on the board with commander parentage and settles the tool with its result', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const tb = await import('../../../../src/main/features/group_chat/task_board');
    _setScript(state.buildGconvSessionId(cid), [
      { type: '__call_tool__', name: 'dispatch_to', input: { to: AGENT_NAME, message: 'draft the summary' } },
      { type: 'final', text: 'synthesized' },
    ]);
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: 'final', text: 'summary drafted' },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'summarize it' });
    await waitForQuiescent(TEST_UID, cid, 6000);

    const rows = await tb.listTasks(TEST_UID, cid);
    const commanderTask = rows.find((t) => t.assignee === 'commander')!;
    const child = rows.find((t) => t.created_by === 'commander')!;
    expect(child).toMatchObject({
      assignee: AGENT_ID,
      status: 'done',
      instruction: 'draft the summary',
      parent_task_id: commanderTask.task_id,
    });
    expect(commanderTask.status).toBe('done');
    // The tool result carried the child's full reply back to the commander.
    const dispatchResult = _recordedToolResults.find((r) => r.name === 'dispatch_to');
    expect(dispatchResult?.content).toContain('summary drafted');
  }, 15_000);

  it('user-cancelling a RUNNING child settles the tool with a structured aborted result and the commander winds down', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const tb = await import('../../../../src/main/features/group_chat/task_board');
    _setScript(state.buildGconvSessionId(cid), [
      { type: '__call_tool__', name: 'dispatch_to', input: { to: AGENT_NAME, message: 'long doomed sub-task' } },
      { type: 'final', text: 'acknowledged the cancelled sub-task' },
    ]);
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: '__wait_for_abort__' },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'do the long thing' });

    // Wait for the child to be RUNNING on the board, then cancel just it.
    let child: any = null;
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const rows = await tb.listTasks(TEST_UID, cid);
      child = rows.find((t) => t.created_by === 'commander' && t.status === 'running') || null;
      if (child) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(child).toBeTruthy();
    const res = await bus.cancelConversationTask(TEST_UID, cid, child.task_id);
    expect(res).toMatchObject({ ok: true, scope: 'running' });

    await waitForQuiescent(TEST_UID, cid, 6000);

    // Structured aborted payload reached the commander; it finished its turn.
    const dispatchResult = _recordedToolResults.find((r) => r.name === 'dispatch_to');
    expect(dispatchResult?.content).toContain('aborted="true"');
    const rows = await tb.listTasks(TEST_UID, cid);
    expect(rows.find((t) => t.task_id === child.task_id)?.status).toBe('cancelled');
    expect(rows.find((t) => t.assignee === 'commander')?.status).toBe('done');
    // A single sub-task cancel is NOT a conversation stop.
    expect((await state.readState(TEST_UID, cid)).status).not.toBe('aborted');
  }, 15_000);

  it('user-cancelling a QUEUED child (gate full) settles the tool without the child ever running', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const tb = await import('../../../../src/main/features/group_chat/task_board');
    const sidA = state.buildGmemberSessionId(cid, AGENT_ID);
    _setScript(state.buildGconvSessionId(cid), [
      { type: '__call_tool__', name: 'dispatch_to', input: { to: AGENT_NAME, message: 'never runs' } },
      { type: 'final', text: 'wound down after queued cancel' },
    ]);

    // Fill the named gate so the child parks queued.
    const holds: Array<() => void> = [];
    for (;;) {
      const r = bus._reserveAgentSlotForTest(TEST_UID, cid);
      if (!r) break;
      holds.push(r);
    }
    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'queue then cancel' });

    let child: any = null;
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      const rows = await tb.listTasks(TEST_UID, cid);
      child = rows.find((t) => t.created_by === 'commander' && t.status === 'queued') || null;
      if (child) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(child).toBeTruthy();
    expect((await bus.cancelConversationTask(TEST_UID, cid, child.task_id)).ok).toBe(true);
    holds.forEach((r) => r());
    await waitForQuiescent(TEST_UID, cid, 6000);

    expect(_recordedCalls.some((c) => c.sid === sidA)).toBe(false); // never reached the model
    const dispatchResult = _recordedToolResults.find((r) => r.name === 'dispatch_to');
    expect(dispatchResult?.content).toContain('aborted="true"');
    expect((await tb.listTasks(TEST_UID, cid)).find((t) => t.task_id === child.task_id)?.status).toBe('cancelled');
  }, 15_000);
});

describe('group_chat bus integration › P3 scheduled hand_off_to', () => {
  it('a hand_off_to child lands on the board with commander parentage and keeps final delivery semantics', async () => {
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const tb = await import('../../../../src/main/features/group_chat/task_board');
    (tb as any)._resetForTest();
    _setScript(state.buildGconvSessionId(cid), [
      { type: '__call_tool__', name: 'hand_off_to', input: { to: AGENT_NAME, message: 'deliver the final report' } },
      { type: 'final', text: 'handing off' },
    ]);
    _setScript(state.buildGmemberSessionId(cid, AGENT_ID), [
      { type: 'final', text: 'final report delivered' },
    ]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'get me the report' });
    await waitForQuiescent(TEST_UID, cid, 6000);

    const rows = await tb.listTasks(TEST_UID, cid);
    const commanderTask = rows.find((t) => t.assignee === 'commander')!;
    const child = rows.find((t) => t.created_by === 'commander')!;
    expect(child).toMatchObject({
      assignee: AGENT_ID,
      status: 'done',
      instruction: 'deliver the final report',
      parent_task_id: commanderTask.task_id,
    });
    // Hand-off delivery semantics preserved: the agent bubble is the answer;
    // no commander synthesis message after it.
    const paths = await import('../../../../src/main/paths');
    const storage = await import('../../../../src/main/storage');
    const messages = await storage.readJsonl<any>(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`));
    expect(messages.some((m: any) => m.from === AGENT_ID && m.text === 'final report delivered')).toBe(true);
    const commanderMsgs = messages.filter((m: any) => m.from === 'commander' && !m.dispatch);
    expect(commanderMsgs.map((m: any) => m.text)).toEqual(['handing off']);
  }, 15_000);
});

describe('group_chat bus integration › P3 parallel form-wait redemption', () => {
  it('two dispatched agents can block on forms in parallel; each submission wakes the commander with ITS OWN resume account', async () => {
    // Scenario value: the cut-over's whole point — the single state.json
    // ledger field self-overwrote when a second dispatch parked on a form,
    // losing the first account. Task-row redemption keeps one account per
    // parked sub-task. Oracles: both board rows park with their own form_id,
    // and each submission produces an orchestration resume carrying its own
    // resume instruction.
    const paths = await import('../../../../src/main/paths');
    const dir = paths.agentDir(TEST_UID, SECOND_AGENT_ID);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify({
      agent_id: SECOND_AGENT_ID, name: SECOND_AGENT_NAME,
      description: 'Researches things', workflow: 'do research',
      created_at: 't', updated_at: 't',
    }));
    (await import('../../../../src/main/features/group_chat/task_board'))._resetForTest();
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const router = await import('../../../../src/main/features/group_chat/router');
    const storage = await import('../../../../src/main/storage');
    const tb = await import('../../../../src/main/features/group_chat/task_board');
    const sidA = state.buildGmemberSessionId(cid, AGENT_ID);
    const sidB = state.buildGmemberSessionId(cid, SECOND_AGENT_ID);
    const formOf = (id: string) => ({ fields: [{ id, label: `Need ${id}`, type: 'text', required: true }] });

    _setScript(state.buildGconvSessionId(cid), [
      { type: '__call_tool__', name: 'dispatch_to', input: { to: AGENT_NAME, message: 'collect requirement A', resume: 'RESUME_ALPHA: fold in the A answer' } },
      { type: '__call_tool__', name: 'dispatch_to', input: { to: SECOND_AGENT_NAME, message: 'collect requirement B', resume: 'RESUME_BETA: fold in the B answer' } },
      { type: 'final', text: 'both dispatched' },
    ]);
    _setScript(sidA, [{
      type: 'final',
      text: `A needs input.\n<agent-input-form>\n${JSON.stringify(formOf('alpha'))}\n</agent-input-form>`,
    }]);
    _setScript(sidB, [{
      type: 'final',
      text: `B needs input.\n<agent-input-form>\n${JSON.stringify(formOf('beta'))}\n</agent-input-form>`,
    }]);
    _setScript(sidA, [{ type: 'final', text: 'A done with the answer' }]);
    _setScript(sidB, [{ type: 'final', text: 'B done with the answer' }]);
    _setScript(state.buildGconvSessionId(cid), [{ type: 'final', text: 'resumed after B' }]);
    _setScript(state.buildGconvSessionId(cid), [{ type: 'final', text: 'resumed after A' }]);

    bus.subscribe(TEST_UID, cid, () => {});
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'collect both requirements' });
    await waitForQuiescent(TEST_UID, cid, 8000);

    // BOTH sub-tasks are parked with their own account — the second dispatch
    // did not overwrite the first.
    const parked = (await tb.listTasks(TEST_UID, cid)).filter((t) => t.status === 'waiting_input');
    expect(parked).toHaveLength(2);
    const parkedA = parked.find((t) => t.assignee === AGENT_ID)!;
    const parkedB = parked.find((t) => t.assignee === SECOND_AGENT_ID)!;
    expect(parkedA.resume?.resume_instruction).toContain('RESUME_ALPHA');
    expect(parkedB.resume?.resume_instruction).toContain('RESUME_BETA');
    expect(parkedA.resume?.form_id && parkedB.resume?.form_id
      && parkedA.resume.form_id !== parkedB.resume.form_id).toBe(true);

    const mainFile = path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`);
    const readMsgs = async () => storage.readJsonl<any>(mainFile);
    const submit = async (agentId: string, agentName: string, fieldId: string) => {
      const messages = await readMsgs();
      const formMsg = messages.find((m: any) => m.from === agentId && m.form && !m.form.submitted);
      const encoded = router.encodeSubmission(
        { form_id: formMsg.form.form_id, agent_id: agentId, fields: formMsg.form.fields },
        { [fieldId]: `${fieldId} value` },
      );
      await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: `@${agentName}\n${encoded}` });
      await waitForQuiescent(TEST_UID, cid, 8000);
    };

    // Submit B first, then A — each wakes the commander with ITS resume.
    await submit(SECOND_AGENT_ID, SECOND_AGENT_NAME, 'beta');
    await submit(AGENT_ID, AGENT_NAME, 'alpha');

    const finalMsgs = await readMsgs();
    const resumes = finalMsgs.filter((m: any) => String(m.model_text || '').includes('orchestration-resume'));
    expect(resumes).toHaveLength(2);
    expect(resumes[0].model_text).toContain('RESUME_BETA');
    expect(resumes[1].model_text).toContain('RESUME_ALPHA');
    const rows = await tb.listTasks(TEST_UID, cid);
    expect(rows.find((t) => t.task_id === parkedA.task_id)?.status).toBe('done');
    expect(rows.find((t) => t.task_id === parkedB.task_id)?.status).toBe('done');
  }, 25_000);
});

describe('group_chat bus integration › D9 same-agent multi-segment (on-device regression)', () => {
  it('mentioning the same agent twice creates two serial tasks, each carrying only its own segment', async () => {
    // Caught on-device: the eligibility gate keyed on the DEDUPED recipient
    // count, so "@A first @A second" (one recipient, two spans) silently
    // took the legacy full-text path instead of §4.2.1 rule 4.
    const cid = newCid();
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const tb = await import('../../../../src/main/features/group_chat/task_board');
    (tb as any)._resetForTest();
    const sid = state.buildGmemberSessionId(cid, AGENT_ID);
    _setScript(sid, [{ type: 'final', text: 'first done' }]);
    _setScript(sid, [{ type: 'final', text: 'second done' }]);

    await bus.enqueue({
      uid: TEST_UID, cid, fromActorId: 'user',
      text: `@${AGENT_NAME} DELTA_FIRST do this @${AGENT_NAME} EPSILON_SECOND then this`,
    });
    await waitForQuiescent(TEST_UID, cid, 6000);

    const rows = await tb.listTasks(TEST_UID, cid);
    expect(rows).toHaveLength(2);
    expect(rows.every((t) => t.assignee === AGENT_ID && t.status === 'done')).toBe(true);
    const instructions = rows.map((t) => t.instruction);
    expect(instructions.some((i) => i.includes('DELTA_FIRST') && !i.includes('EPSILON_SECOND'))).toBe(true);
    expect(instructions.some((i) => i.includes('EPSILON_SECOND') && !i.includes('DELTA_FIRST'))).toBe(true);
    // Same-actor serial preserved order: two model calls, first then second.
    const calls = _recordedCalls.filter((c) => c.sid === sid).map((c) => c.message);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('DELTA_FIRST');
    expect(calls[1]).toContain('EPSILON_SECOND');
  }, 15_000);
});
