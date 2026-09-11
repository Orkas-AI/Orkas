import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { drainMainRuntimeForTest } from '../../../helpers/drain-main-runtime';

function collectStringLeaves(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(collectStringLeaves);
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).flatMap(collectStringLeaves);
  }
  return [];
}

const loggerMocks = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(), info: loggerMocks.info, warn: loggerMocks.warn, error: vi.fn(),
  }),
}));

const streamGate = vi.hoisted(() => ({
  releaseActiveTurn: null as null | (() => void),
}));
const streamProbe = vi.hoisted(() => ({
  messages: [] as string[],
  slowGate: null as Promise<void> | null,
  conversationHistories: [] as any[],
  readOnlyRoots: [] as string[][],
  historyResources: [] as any[][],
  dispatchResults: [] as string[],
  maxToolLoops: [] as Array<number | undefined>,
  toolLists: [] as Array<string[] | undefined>,
}));

// Mock the model client so `runTurn` doesn't try to do a real LLM call.
// `streamChatWithModel` returns an async iterator that yields one final
// event with empty text + a done event; bus interprets that as "done,
// no reply" and emits a "(no reply)" message. Good enough for the
// integration assertions here — we're testing routing / persistence /
// state, not actual model output.
vi.mock('../../../../src/main/model/client', () => ({
  async *streamChatWithModel(_opts: any) {
    const rawMessage = String(_opts?.message || '');
    const isCommanderTurn = String(_opts?.sessionId || '').startsWith('gconv-');
    streamProbe.messages.push(rawMessage);
    streamProbe.conversationHistories.push(_opts?.conversationHistory);
    streamProbe.readOnlyRoots.push(Array.isArray(_opts?.readOnlyExtraRoots) ? [..._opts.readOnlyExtraRoots] : []);
    streamProbe.historyResources.push(Array.isArray(_opts?.historyResources) ? [..._opts.historyResources] : []);
    streamProbe.maxToolLoops.push(typeof _opts?.maxToolLoops === 'number' ? _opts.maxToolLoops : undefined);
    streamProbe.toolLists.push(Array.isArray(_opts?.toolList) ? [..._opts.toolList] : undefined);
    const message = rawMessage;
    const reasoningMarker = 'REASONING_PROCESS_PERSISTENCE_TEST:';
    const reasoningIdx = message.indexOf(reasoningMarker);
    if (isCommanderTurn && reasoningIdx >= 0) {
      const encoded = message.slice(reasoningIdx + reasoningMarker.length).split(/\s/, 1)[0];
      const summary = Buffer.from(encoded, 'base64').toString('utf8');
      const splitAt = Math.floor(summary.length / 2);
      yield {
        type: 'event',
        event: {
          stream: 'reasoning',
          data: {
            phase: 'progress', id: 'reasoning-complete', chars: splitAt,
            summary_from: 0, summary_delta: summary.slice(0, splitAt), heartbeat: true,
          },
        },
      };
      yield {
        type: 'event',
        event: {
          stream: 'reasoning',
          data: {
            phase: 'progress', id: 'reasoning-complete', chars: summary.length,
            summary_from: splitAt, summary_delta: summary.slice(splitAt), heartbeat: true,
          },
        },
      };
      yield {
        type: 'event',
        event: {
          stream: 'reasoning',
          data: {
            phase: 'end', id: 'reasoning-complete', chars: summary.length, summary,
          },
        },
      };
      yield { type: 'final', text: 'Reasoning complete.' };
      yield { type: 'done' };
      return;
    }
    if (isCommanderTurn && message.includes('COMMANDER_BLOCKER_HANDOFF_TEST')) {
      const tool = (Array.isArray(_opts?.extraTools) ? _opts.extraTools : [])
        .find((candidate: any) => candidate?.name === 'hand_off_to');
      if (!tool) throw new Error('missing hand_off_to');
      const result = await tool.execute(
        { to: AGENT_NAME, message: 'AGENT_BLOCKER_RESULT_TEST' },
        { signal: new AbortController().signal },
      );
      streamProbe.dispatchResults.push(String(result?.content || ''));
      yield { type: 'final', text: '' };
      yield { type: 'done' };
      return;
    }
    if (isCommanderTurn && message.includes('COMMANDER_CLI_LEDGER_ROUTE_TEST')
      && !message.includes('<orchestration-resume>')) {
      const tool = (Array.isArray(_opts?.extraTools) ? _opts.extraTools : [])
        .find((candidate: any) => candidate?.name === 'hand_off_to');
      if (!tool) throw new Error('missing hand_off_to');
      const result = await tool.execute(
        {
          to: AGENT_NAME,
          message: 'CLI_LEDGER_TASK_TEST',
          resume: 'Continue the broader Commander workflow.',
        },
        { signal: new AbortController().signal },
      );
      streamProbe.dispatchResults.push(String(result?.content || ''));
      yield { type: 'final', text: '' };
      yield { type: 'done' };
      return;
    }
    if (message.includes('AGENT_BLOCKER_RESULT_TEST')) {
      yield {
        type: 'final',
        text: '当前不能继续：E_NARRATION_REPAIR_AUTHORIZATION_NOT_PERSISTED',
      };
      yield { type: 'done' };
      return;
    }
    if (isCommanderTurn && message.includes('COMMANDER_BLOCKER_FOLLOWUP_TEST')) {
      const history = JSON.stringify(_opts?.conversationHistory || null);
      if (
        history.includes(AGENT_NAME)
        && history.includes('E_NARRATION_REPAIR_AUTHORIZATION_NOT_PERSISTED')
      ) {
        yield {
          type: 'final',
          text: 'recognized the exact blocker from canonical history and chose the recovery independently of the prior dispatch shape',
        };
        yield { type: 'done' };
        return;
      }
      const tool = (Array.isArray(_opts?.extraTools) ? _opts.extraTools : [])
        .find((candidate: any) => candidate?.name === 'hand_off_to');
      if (!tool) throw new Error('missing hand_off_to');
      const result = await tool.execute(
        { to: AGENT_NAME, message: 'AGENT_BLOCKER_RESULT_TEST' },
        { signal: new AbortController().signal },
      );
      streamProbe.dispatchResults.push(String(result?.content || ''));
      yield { type: 'final', text: 'redispatched because blocker context was missing' };
      yield { type: 'done' };
      return;
    }
    if (message.includes('ARTIFACT_EVENT_TEST')) {
      _opts?.onArtifactCreated?.({ id: 'art-live-1', title: 'Live App' });
    }
    const nestedOutputMarker = 'NESTED_OUTPUT_VISIBILITY_TEST:';
    const nestedOutputIdx = message.indexOf(nestedOutputMarker);
    if (isCommanderTurn && nestedOutputIdx >= 0) {
      const encoded = message.slice(nestedOutputIdx + nestedOutputMarker.length).split(/\s/, 1)[0];
      const data = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
      const tool = (Array.isArray(_opts?.extraTools) ? _opts.extraTools : [])
        .find((candidate: any) => candidate?.name === data.tool);
      if (!tool) throw new Error(`missing nested tool ${data.tool}`);
      const task = `PRODUCED_FILTER_TEST:${Buffer.from(JSON.stringify({ paths: [data.path] })).toString('base64')}`;
      const result = await tool.execute(
        data.tool === 'run_worker'
          ? { to: AGENT_NAME, task }
          : { to: AGENT_NAME, message: task },
        { signal: new AbortController().signal },
      );
      streamProbe.dispatchResults.push(String(result?.content || ''));
      yield { type: 'final', text: data.tool === 'hand_off_to' ? '' : 'commander synthesis ok' };
      yield { type: 'done' };
      return;
    }
    if (message.includes('AGENT_RESULT_FAILURE_TEST')) {
      yield { type: 'final', text: '没有完成交付。' };
      yield { type: 'done' };
      return;
    }
    const localMediaMarker = 'LOCAL_MEDIA_REPLY_TEST:';
    const localMediaIdx = message.indexOf(localMediaMarker);
    if (localMediaIdx >= 0) {
      const encoded = message.slice(localMediaIdx + localMediaMarker.length).split(/\s/, 1)[0];
      const data = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
      yield { type: 'final', text: data.text };
      yield { type: 'done' };
      return;
    }
    if (message.includes('COMMANDER_RESULT_FAILURE_TEST')) {
      yield { type: 'final', text: '没有完成调度。' };
      yield { type: 'done' };
      return;
    }
    if (message.includes('AGENT_MARKERLESS_SUCCESS_TEST')) {
      yield { type: 'final', text: '已完成交付。' };
      yield { type: 'done' };
      return;
    }
    const xmlMarker = 'SYNC_CONFLICT_XML_RESULT:';
    const xmlIdx = message.indexOf(xmlMarker);
    if (xmlIdx >= 0) {
      const encoded = message.slice(xmlIdx + xmlMarker.length).split(/\s/, 1)[0];
      const esc = (value: string) => String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      const data = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
      const idName = data.attributeStyle === 'aliases' ? 'id' : 'conflict_id';
      const relName = data.attributeStyle === 'aliases' ? 'relative_path' : 'rel_path';
      const targetName = data.attributeStyle === 'aliases' ? 'current_path' : 'target_path';
      yield {
        type: 'final',
        text: `<sync-conflict-result ${idName}="${esc(data.conflictId)}" ${relName}="${esc(data.relPath)}" ${targetName}="${esc(data.targetPath)}" status="${esc(data.status || 'resolved')}" action="${esc(data.action || 'use_current')}" />`,
      };
      yield { type: 'done' };
      return;
    }
    const runFactsMarker = 'RUN_FACTS_TEST:';
    const runFactsIdx = message.indexOf(runFactsMarker);
    if (runFactsIdx >= 0) {
      const encoded = message.slice(runFactsIdx + runFactsMarker.length).split(/\s/, 1)[0];
      const data = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
      for (let i = 0; i < (data.calls || 0); i++) {
        yield { type: 'event', event: { stream: 'tool', data: { name: data.tool || 'read_files', phase: 'start' } } };
        yield { type: 'event', event: { stream: 'tool', data: { name: data.tool || 'read_files', phase: 'end' } } };
      }
      yield { type: 'final', text: 'done and verified' };
      yield { type: 'done' };
      return;
    }
    const producedMarker = 'PRODUCED_FILTER_TEST:';
    const producedIdx = message.indexOf(producedMarker);
    if (producedIdx >= 0) {
      const encoded = message.slice(producedIdx + producedMarker.length).split(/\s/, 1)[0];
      const data = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
      for (const p of data.paths || []) _opts?.onFileWritten?.(p);
      const interaction = data.planInteraction === 'open' || data.planInteraction === 'closed'
        ? `\n<plan-interaction status="${data.planInteraction}" />`
        : '';
      const form = data.withForm
        ? `\n<agent-input-form>\n${JSON.stringify({ fields: [{ id: 'decision', label: 'Decision', type: 'text' }] })}\n</agent-input-form>`
        : '';
      yield { type: 'final', text: `produced filter ok${form}${interaction}` };
      yield { type: 'done' };
      return;
    }
    const publishedMarker = 'PUBLISHED_OUTPUT_TEST:';
    const publishedIdx = message.indexOf(publishedMarker);
    if (publishedIdx >= 0) {
      const encoded = message.slice(publishedIdx + publishedMarker.length).split(/\s/, 1)[0];
      const data = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
      for (const p of data.paths || []) await _opts?.onFileWritten?.(p);
      const publications = Array.isArray(data.publications)
        ? data.publications
        : [data.published || []];
      for (const publication of publications) {
        await _opts?.onOutputsPublished?.(publication);
      }
      const interaction = data.planInteraction === 'open' || data.planInteraction === 'closed'
        ? `\n<plan-interaction status="${data.planInteraction}" />`
        : '';
      const form = data.withForm
        ? `\n<agent-input-form>\n${JSON.stringify({ fields: [{ id: 'decision', label: 'Decision', type: 'text' }] })}\n</agent-input-form>`
        : '';
      yield { type: 'final', text: `published output ok${form}${interaction}` };
      yield { type: 'done' };
      return;
    }
    if (message.includes('CLI_COMMANDER_AUTOMATION_HANDOFF_TEST')) {
      yield {
        type: 'final',
        text: [
          'Created the requested automation.',
          '<auto-task>',
          '<action>create</action>',
          '<title>Daily benchmark repair</title>',
          '<content>Run all Agent benchmarks, repair safe failures, and list decisions that require user confirmation.</content>',
          '<schedule>{"type":"daily","hour":8,"minute":0}</schedule>',
          '<recipient>{"kind":"commander"}</recipient>',
          '</auto-task>',
        ].join('\n'),
      };
      yield { type: 'done' };
      return;
    }
    if (message.includes('ACTIVE_TURN_TEST')) {
      yield { type: 'progress', text: 'active turn started' };
      await new Promise<void>((resolve) => { streamGate.releaseActiveTurn = resolve; });
    }
    if (message.includes('ABORT_WITHOUT_PHASED_OUTPUT_TEST')) {
      const signal = _opts?.abortSignal as AbortSignal | undefined;
      await new Promise<void>((resolve) => {
        if (!signal || signal.aborted) resolve();
        else signal.addEventListener('abort', () => resolve(), { once: true });
      });
      yield { type: 'error', text: 'aborted', aborted: true };
      return;
    }
    if (message.includes('COMPACTION_EVENT_TEST')) {
      yield {
        type: 'progress',
        text: 'compacted 20000→3000 tokens',
        event: {
          stream: 'compaction',
          data: { tokensBefore: 20000, tokensAfter: 3000 },
        },
      };
      yield { type: 'final', text: 'compaction recorded' };
      yield { type: 'done' };
      return;
    }
    if (message.includes('TIMING_EVENT_TEST')) {
      yield {
        type: 'event',
        event: {
          stream: 'agent_run_result',
          data: {
            provider_ms: 40,
            tool_ms: 20,
            compaction_ms: 10,
            retry_wait_ms: 5,
            other_ms: 3,
            failure_phase: 'tool',
          },
        },
      };
      yield { type: 'final', text: 'timing recorded' };
      yield { type: 'done' };
      return;
    }
    if (message.includes('NON_CLI_PHASED_TEXT_TEST')) {
      yield { type: 'delta', text: 'Inspect the code.', phase: 'commentary' };
      yield {
        type: 'event',
        event: {
          stream: 'tool',
          data: { phase: 'start', id: 'read-non-cli', name: 'read_file' },
        },
      };
      yield { type: 'delta', text: 'Final answer.', phase: 'final_answer' };
      yield { type: 'final', text: 'Final answer.' };
      yield { type: 'done' };
      return;
    }
    if (message.includes('CLI_COMMANDER_AUTOMATION_HANDOFF_TEST')) {
      yield {
        type: 'final',
        text: [
          'Created the requested automation.',
          '<auto-task>',
          '<action>create</action>',
          '<title>Daily benchmark repair</title>',
          '<content>Run all Agent benchmarks, repair safe failures, and list decisions that require user confirmation.</content>',
          '<schedule>{"type":"daily","hour":8,"minute":0}</schedule>',
          '<recipient>{"kind":"commander"}</recipient>',
          '</auto-task>',
        ].join('\n'),
      };
      yield { type: 'done' };
      return;
    }
    if (message.includes('DEFERRED_SLOW_TURN_TEST')) {
      if (streamProbe.slowGate) await streamProbe.slowGate;
      yield { type: 'final', text: 'slow turn finished' };
      yield { type: 'done' };
      return;
    }
    yield { type: 'final', text: '' };
    yield { type: 'done' };
  },
  async chatWithModel() { return { ok: true, text: '', error: '', aborted: false }; },
  abortActiveSessionsForConversation: vi.fn(() => 0),
}));

const cliRunMock = vi.hoisted(() => ({
  calls: [] as any[],
  nextResult: null as any,
  nextEvents: [] as any[],
  activeIngress: null as any,
  releaseActiveIngressRun: null as null | (() => void),
  submittedSteers: [] as any[],
}));
vi.mock('../../../../src/main/features/local_agents/runner', () => ({
  sanitizePublicCliError: (value: unknown) => String(value ?? '')
    .replace(/\/Users\/[^\s;]+/g, '<path>')
    .trim(),
  run: vi.fn(async (opts: any) => {
    cliRunMock.calls.push(opts);
    if (cliRunMock.activeIngress) {
      const ingress = cliRunMock.activeIngress;
      opts.onActiveRunIngress?.(ingress);
      await new Promise<void>((resolve) => { cliRunMock.releaseActiveIngressRun = resolve; });
      opts.onActiveRunIngress?.(null);
    }
    const result = cliRunMock.nextResult || { runId: 'mock-run', status: 'completed', output: 'ok' };
    for (const event of cliRunMock.nextEvents) opts.onEvent(event);
    opts.onEvent({
      type: 'done',
      status: result.status,
      ...(result.output ? { output: result.output } : {}),
      ...(result.error ? { error: result.error } : {}),
      ...(result.sessionId ? { sessionId: result.sessionId } : {}),
    });
    return result;
  }),
}));

let tmpDir: string;
let prevWs: string | undefined;
const TEST_UID = 'u1';
const TEST_CID = 'cidbus';
const AGENT_ID = 'a83d30d995fd';
const cidsToDrop = new Set<string>();
const AGENT_NAME = '软件工程师';

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-bus-'));
  prevWs = process.env.ORKAS_WORKSPACE_ROOT;
  process.env.ORKAS_WORKSPACE_ROOT = tmpDir;
  vi.resetModules();
  loggerMocks.info.mockReset();
  loggerMocks.warn.mockReset();
  cliRunMock.calls.length = 0;
  cliRunMock.nextResult = null;
  cliRunMock.nextEvents.length = 0;
  cliRunMock.activeIngress = null;
  cliRunMock.releaseActiveIngressRun = null;
  cliRunMock.submittedSteers.length = 0;
  streamProbe.messages.length = 0;
  streamProbe.conversationHistories.length = 0;
  streamProbe.readOnlyRoots.length = 0;
  streamProbe.historyResources.length = 0;
  streamProbe.dispatchResults.length = 0;
  streamProbe.maxToolLoops.length = 0;
  streamProbe.toolLists.length = 0;
  streamGate.releaseActiveTurn = null;
  cidsToDrop.clear();
  const users = await import('../../../../src/main/features/users');
  users.activateUser(TEST_UID);

  // Point the workspace at the `<tmpDir>/workspace` path these fixtures
  // already assume. Produced-file finalization is scoped to the roots Orkas
  // manages, so deliverables must live somewhere the workspace actually
  // resolves to — otherwise the gate assertions below pass because the files
  // sit outside the boundary rather than because a review gate held them.
  const userWorkspace = await import('../../../../src/main/features/user_workspace');
  const wsDir = path.join(tmpDir, 'workspace');
  fs.mkdirSync(wsDir, { recursive: true });
  userWorkspace.setWorkspacePath(TEST_UID, wsDir);

  // Seed a custom agent on disk so listAgents / getAgent can resolve it.
  // Agent 目录形态: agents/<aid>/agent.json (详见 docs/plans/agent-as-directory.md)
  const paths = await import('../../../../src/main/paths');
  const dir = paths.agentDir(TEST_UID, AGENT_ID);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent.json'), JSON.stringify({
    agent_id: AGENT_ID,
    name: AGENT_NAME,
    description: '交付高质量的软件产品',
    workflow: '收需求 → 出方案 → 实现',
    created_at: 't', updated_at: 't',
  }));
});

afterEach(async () => {
  cidsToDrop.add(TEST_CID);
  try {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    for (const cid of cidsToDrop) {
      await bus.abort(TEST_UID, cid);
      await bus.dropConv(TEST_UID, cid);
    }
  } catch {
    // Some skipped/failed setup paths may not have loaded the bus module yet.
  }
  await drainMainRuntimeForTest();
  process.env.ORKAS_WORKSPACE_ROOT = prevWs;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function waitForQuiescent(uid: string, cid: string, timeoutMs = 2000) {
  cidsToDrop.add(cid);
  const bus = await import('../../../../src/main/features/group_chat/bus');
  const state = await import('../../../../src/main/features/group_chat/state');
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (bus.isQuiescent(uid, cid)) {
      // The bus deliberately reconciles durable status in a tracked
      // background write after the final worker releases its running claim.
      // Do not let tests capture the transient `running` + empty `in_flight`
      // snapshot between those two lifecycle boundaries.
      const durable = await state.readState(uid, cid);
      if (durable.status !== 'running' && durable.in_flight.length === 0) return;
    }
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`bus did not quiesce for ${uid}/${cid}`);
}

describe('group_chat bus › enqueue routing + persistence', () => {
  it.each([
    ['preserve', '@指挥官 DISPLAY_PROVENANCE_TEST', '@指挥官 DISPLAY_PROVENANCE_TEST'],
    ['hide_generated_prefix', '@commander first @指挥官 DISPLAY_PROVENANCE_TEST', 'first @指挥官 DISPLAY_PROVENANCE_TEST'],
    [undefined, '@commander DISPLAY_PROVENANCE_TEST', undefined],
  ] as const)('persists Commander display provenance %s without changing execution text', async (mode, text, displayText) => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
    const cid = `cid-display-${mode || 'legacy'}`;
    const events: any[] = [];
    bus.subscribe(TEST_UID, cid, (event) => events.push(event));
    const msg = await bus.enqueue({
      uid: TEST_UID, cid, fromActorId: 'user', text,
      ...(mode ? { commander_mention_display: mode } : {}),
    });
    await waitForQuiescent(TEST_UID, cid);
    expect(msg.display_text).toBe(displayText);
    expect(msg.text).toBe(mode === 'hide_generated_prefix' ? 'first DISPLAY_PROVENANCE_TEST' : 'DISPLAY_PROVENANCE_TEST');
    expect(msg.to).toEqual(['commander']);
    const rows = fs.readFileSync(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line));
    expect(rows.find((row) => row.id === msg.id)?.display_text).toBe(displayText);
    expect(events.find((event) => event.type === 'message' && event.msg?.id === msg.id)?.msg?.display_text)
      .toBe(displayText);
    const visibility = await import('../../../../src/main/features/group_chat/visibility');
    const history = visibility.buildCommanderConversationHistory([msg], 'later-user-message');
    expect(JSON.stringify(history)).not.toContain('@指挥官');
    expect(JSON.stringify(history)).not.toContain('@commander');
  });

  it('keeps CLI and model-reasoning heartbeats live-only', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');

    expect(bus.isEphemeralProcessHeartbeat({
      stream: 'cli',
      data: { type: 'thinking', heartbeat: true },
    })).toBe(true);
    expect(bus.isEphemeralProcessHeartbeat({
      stream: 'reasoning',
      data: { phase: 'progress', heartbeat: true, summary: 'Reviewing constraints' },
    })).toBe(true);
    expect(bus.isEphemeralProcessHeartbeat({
      stream: 'reasoning',
      data: { phase: 'end', chars: 123, summary: 'Reviewing constraints' },
    })).toBe(false);
    // Runner idle ticks repeat every 30 s of CLI silence and are folded into one
    // visible wait; the background-task status that explains the wait is a
    // real event and stays in history.
    expect(bus.isEphemeralProcessHeartbeat({
      stream: 'cli',
      data: { type: 'idle', stalledMs: 95_000, waitingOn: [{ taskId: 't1', label: 'dev server' }] },
    })).toBe(true);
    expect(bus.isEphemeralProcessHeartbeat({
      stream: 'cli',
      data: { type: 'status', status: 'background-started', taskId: 't1', message: 'dev server' },
    })).toBe(false);
  });

  it('persists adjacent commentary chunks together without crossing intervening tools', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const items: any[] = [];

    bus.appendChronologicalCommentary(items, 'Inspect ');
    bus.appendChronologicalCommentary(items, 'the code');
    items.push({
      type: 'event',
      event: { stream: 'tool', data: { phase: 'start', id: 'read-1', name: 'read_file' } },
    });
    bus.appendChronologicalCommentary(items, 'Verify the result');

    expect(items).toEqual([
      {
        type: 'progress',
        text: 'Inspect the code',
        event: { stream: 'assistant', data: { phase: 'commentary' } },
      },
      {
        type: 'event',
        event: { stream: 'tool', data: { phase: 'start', id: 'read-1', name: 'read_file' } },
      },
      {
        type: 'progress',
        text: 'Verify the result',
        event: { stream: 'assistant', data: { phase: 'commentary' } },
      },
    ]);
  });

  it('keeps non-CLI commentary in process history and final-answer text in the body', async () => {
    const cid = 'cid-non-cli-phased-text';
    const live: any[] = [];
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
    bus.subscribe(TEST_UID, cid, (event) => live.push(event));

    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: 'NON_CLI_PHASED_TEXT_TEST',
    });
    await waitForQuiescent(TEST_UID, cid);

    const liveDeltas = live
      .filter((event) => event?.type === 'process')
      .map((event) => event.data)
      .filter((data) => data?.type === 'delta');
    expect(liveDeltas).toEqual([
      { type: 'delta', text: 'Inspect the code.', phase: 'commentary' },
      { type: 'delta', text: 'Final answer.', phase: 'final_answer' },
    ]);

    const rows = fs.readFileSync(
      path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`),
      'utf8',
    ).trim().split('\n').map((line) => JSON.parse(line));
    const reply = rows.find((row) => row.from === 'commander');
    expect(reply?.text).toBe('Final answer.');
    expect(reply?.text).not.toContain('Inspect the code.');
    expect((reply?.process || []).some((item: any) => (
      item?.type === 'progress'
      && item.text === 'Inspect the code.'
      && item.event?.stream === 'assistant'
      && item.event.data?.phase === 'commentary'
    ))).toBe(true);
  });

  it('keeps Claude commentary and tool events chronologically aligned live and after reload', async () => {
    const paths = await import('../../../../src/main/paths');
    const agentFile = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
    const spec = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
    spec.runtime = { kind: 'cli', cli: 'claude' };
    fs.writeFileSync(agentFile, JSON.stringify(spec));

    cliRunMock.nextEvents.push(
      { type: 'text-delta', text: 'Inspect the code. ' },
      {
        type: 'tool-event', phase: 'use', tool: 'Read', callId: 'read-chronology',
        input: { file_path: 'src/app.ts' },
      },
      { type: 'text-delta', text: 'Verify the result.' },
    );
    cliRunMock.nextResult = {
      runId: 'claude-chronological-process',
      status: 'completed',
      output: 'Final answer.',
    };

    const cid = 'cid-claude-chronological-process';
    const live: any[] = [];
    const bus = await import('../../../../src/main/features/group_chat/bus');
    bus.subscribe(TEST_UID, cid, (event) => live.push(event));
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `@${AGENT_NAME} inspect and verify`,
    });
    await waitForQuiescent(TEST_UID, cid);

    const liveProcess = live
      .filter((event) => event?.type === 'process' && event.actor === AGENT_ID)
      .map((event) => event.data)
      .filter((data) => data?.type === 'delta' || data?.event?.stream === 'cli');
    expect(liveProcess.map((data) => (
      data.type === 'delta'
        ? `commentary:${data.text}`
        : `tool:${data.event.data.tool}`
    ))).toEqual([
      'commentary:Inspect the code. ',
      'tool:Read',
      'commentary:Verify the result.',
    ]);
    expect(liveProcess.filter((data) => data.type === 'delta')
      .every((data) => data.phase === 'commentary')).toBe(true);

    const rows = fs.readFileSync(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line));
    const reply = rows.find((row) => row.from === AGENT_ID);
    const persisted = (reply?.process || [])
      .filter((item: any) => item?.event?.stream === 'assistant' || item?.event?.stream === 'cli')
      .map((item: any) => item.event.stream === 'assistant'
        ? `commentary:${item.text}`
        : `tool:${item.event.data.tool}`);
    expect(persisted).toEqual([
      'commentary:Inspect the code. ',
      'tool:Read',
      'commentary:Verify the result.',
    ]);
  });

  it('flushes unterminated Codex commentary before the following command', async () => {
    const paths = await import('../../../../src/main/paths');
    const agentFile = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
    const spec = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
    spec.runtime = { kind: 'cli', cli: 'codex' };
    fs.writeFileSync(agentFile, JSON.stringify(spec));

    // Codex commentary items commonly end without a newline. The file-citation
    // filter therefore still owns an incomplete line when the next command
    // starts; that item boundary must flush the prose before the tool event.
    cliRunMock.nextEvents.push(
      { type: 'text-delta', text: 'Inspect the code.', phase: 'commentary' },
      {
        type: 'tool-event', phase: 'use', tool: 'exec_command', callId: 'codex-command',
        input: { command: 'rg process src' },
      },
      { type: 'text-delta', text: 'Verify the result.', phase: 'commentary' },
      { type: 'text-delta', text: 'Final answer.', phase: 'final_answer' },
    );
    cliRunMock.nextResult = {
      runId: 'codex-chronological-process',
      status: 'completed',
      output: 'Final answer.',
    };

    const cid = 'cid-codex-chronological-process';
    const live: any[] = [];
    const bus = await import('../../../../src/main/features/group_chat/bus');
    bus.subscribe(TEST_UID, cid, (event) => live.push(event));
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `@${AGENT_NAME} inspect and verify`,
    });
    await waitForQuiescent(TEST_UID, cid);

    const liveProcess = live
      .filter((event) => event?.type === 'process' && event.actor === AGENT_ID)
      .map((event) => event.data)
      .filter((data) => data?.type === 'delta' || data?.event?.stream === 'cli');
    expect(liveProcess.map((data) => (
      data.type === 'delta'
        ? `${data.phase}:${data.text}`
        : `tool:${data.event.data.tool}`
    ))).toEqual([
      'commentary:Inspect the code.',
      'tool:exec_command',
      'commentary:Verify the result.',
      'final_answer:Final answer.',
    ]);

    const rows = fs.readFileSync(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line));
    const reply = rows.find((row) => row.from === AGENT_ID);
    expect(reply?.text).toBe('Final answer.');
    expect(reply?.text).not.toContain('Inspect the code.');
    expect(reply?.text).not.toContain('Verify the result.');
    expect((reply?.process || [])
      .filter((item: any) => item?.event?.stream === 'assistant' || item?.event?.stream === 'cli')
      .map((item: any) => item.event.stream === 'assistant'
        ? `commentary:${item.text}`
        : `tool:${item.event.data.tool}`))
      .toEqual([
        'commentary:Inspect the code.',
        'tool:exec_command',
        'commentary:Verify the result.',
      ]);
  });

  it.each([
    { status: 'cancelled', expectedCode: '', expectedBody: 'Run aborted' },
    { status: 'failed', expectedCode: 'cli_failed', expectedBody: 'Agent run failed' },
    { status: 'timeout', expectedCode: 'cli_timeout', expectedBody: 'Agent run failed' },
  ] as const)(
    'keeps commentary in process history but out of the $status terminal body',
    async ({ status, expectedCode, expectedBody }) => {
      const paths = await import('../../../../src/main/paths');
      const agentFile = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
      const spec = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
      spec.runtime = { kind: 'cli', cli: 'codex' };
      fs.writeFileSync(agentFile, JSON.stringify(spec));

      const commentary = `COMMENTARY_ONLY_${status}`;
      cliRunMock.nextEvents.push({
        type: 'text-delta',
        text: commentary,
        phase: 'commentary',
      });
      cliRunMock.nextResult = {
        runId: `codex-${status}-commentary`,
        status,
        error: status === 'cancelled' ? '' : 'internal terminal detail',
      };

      const i18n = await import('../../../../src/main/i18n');
      const previousLang = i18n.getCurrentLang();
      i18n.setCurrentLang('en');
      try {
        const cid = `cid-codex-${status}-commentary`;
        const bus = await import('../../../../src/main/features/group_chat/bus');
        await bus.enqueue({
          uid: TEST_UID,
          cid,
          fromActorId: 'user',
          text: `@${AGENT_NAME} inspect and report`,
        });
        await waitForQuiescent(TEST_UID, cid);

        const rows = fs.readFileSync(
          path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`),
          'utf8',
        ).trim().split('\n').map((line) => JSON.parse(line));
        const reply = rows.find((row) => row.from === AGENT_ID);
        expect(reply?.text).toContain(expectedBody);
        expect(reply?.text).not.toContain(commentary);
        if (expectedCode) expect(reply?.failure_code).toBe(expectedCode);
        else expect(reply?.failure_code).toBeUndefined();
        expect((reply?.process || []).some((item: any) => (
          item?.type === 'progress'
          && item?.event?.stream === 'assistant'
          && item.event.data?.phase === 'commentary'
          && item.text === commentary
        ))).toBe(true);
      } finally {
        i18n.setCurrentLang(previousLang);
      }
    },
  );

  it('streams complete reasoning live and persists only its complete terminal event', async () => {
    const summary = `BEGIN_${'x'.repeat(10_000)}_END`;
    const encoded = Buffer.from(summary, 'utf8').toString('base64');
    const cid = 'cid-complete-reasoning-process';
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const events: any[] = [];
    bus.subscribe(TEST_UID, cid, (event) => events.push(event));

    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `REASONING_PROCESS_PERSISTENCE_TEST:${encoded}`,
    });
    await waitForQuiescent(TEST_UID, cid);

    const liveReasoning = events
      .filter(event => event?.type === 'process')
      .map(event => event?.data)
      .filter(data => data?.type === 'event' && data?.event?.stream === 'reasoning')
      .map(data => data.event.data);
    expect(liveReasoning).toEqual([
      {
        phase: 'progress', id: 'reasoning-complete', chars: Math.floor(summary.length / 2),
        summary_from: 0,
        summary_delta: summary.slice(0, Math.floor(summary.length / 2)),
        heartbeat: true,
      },
      {
        phase: 'progress', id: 'reasoning-complete', chars: summary.length,
        summary_from: Math.floor(summary.length / 2),
        summary_delta: summary.slice(Math.floor(summary.length / 2)),
        heartbeat: true,
      },
      {
        phase: 'end', id: 'reasoning-complete', chars: summary.length, summary,
      },
    ]);

    const paths = await import('../../../../src/main/paths');
    const rows = fs.readFileSync(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line));
    const reply = rows.find(row => row.from === 'commander');
    const persistedReasoning = (reply?.process || [])
      .filter((item: any) => item?.type === 'event'
        && item?.event?.stream === 'reasoning')
      .map((item: any) => item.event.data);
    expect(persistedReasoning).toEqual([{
      phase: 'end', id: 'reasoning-complete', chars: summary.length, summary,
    }]);
  });

  it('user → commander default route persists with to=["commander"]', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const events: any[] = [];
    bus.subscribe(TEST_UID, TEST_CID, (ev) => events.push(ev));

    const msg = await bus.enqueue({
      uid: TEST_UID, cid: TEST_CID, fromActorId: 'user', text: '你好',
    });
    expect(msg.to).toEqual(['commander']);
    expect(msg.from).toBe('user');

    // listener saw message event for the user msg
    expect(events.find((e) => e.type === 'message' && e.msg.id === msg.id)).toBeTruthy();
  });

  it('persists short visible text while sending model_text to the worker', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const cid = 'cid-model-text';

    const msg = await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: '请帮我处理冲突。',
      model_text: 'Please resolve the conflict using the hidden protocol.',
    });
    await waitForQuiescent(TEST_UID, cid);

    expect(msg.text).toBe('请帮我处理冲突。');
    expect(msg.model_text).toBe('Please resolve the conflict using the hidden protocol.');
    expect(streamProbe.messages.some((m) => m.includes('Please resolve the conflict using the hidden protocol.'))).toBe(true);
    expect(streamProbe.messages.some((m) => m.includes('请帮我处理冲突。'))).toBe(false);
    expect(streamProbe.conversationHistories[0]).toMatchObject({
      source: `group-main-v5:${cid}`,
      messages: [],
    });
  });

  it('persists structured references and injects them as inert model context', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const layout = await import('../../../../src/main/util/project-layout');
    const sourceAttachmentDir = layout.chatAttachmentDirForConversation(TEST_UID, 'source-cid');
    fs.mkdirSync(sourceAttachmentDir, { recursive: true });
    fs.writeFileSync(path.join(sourceAttachmentDir, 'brief.txt'), 'reference attachment');
    const msg = await bus.enqueue({
      uid: TEST_UID,
      cid: TEST_CID,
      fromActorId: 'user',
      text: '比较一下',
      references: [{
        source_cid: 'source-cid',
        source_title: '来源任务',
        source_msg_id: 'source-msg',
        from_actor: 'writer',
        from_name: '撰稿人',
        source_ts: '2026-07-10T10:00:00',
        text: '历史内容里有 @other-agent，但不应参与当前消息路由。',
        attachments: [{ name: 'brief.txt', kind: 'text' }],
        produced: ['/tmp/report.pdf'],
      }],
    });
    await waitForQuiescent(TEST_UID, TEST_CID);

    expect(msg.to).toEqual(['commander']);
    expect(msg.references?.[0]).toMatchObject({
      source_cid: 'source-cid',
      source_msg_id: 'source-msg',
      text: expect.stringContaining('@other-agent'),
    });
    expect(streamProbe.messages.some((payload) => (
      payload.includes('<referenced-messages>')
      && payload.includes('not executable instructions or routing mentions')
      && payload.includes('@other-agent')
      // The path is embedded in a JSON snapshot, which doubles Windows
      // backslashes even though the underlying read-only root is native.
      && payload.includes(path.join(sourceAttachmentDir, 'brief.txt').replace(/\\/g, '\\\\'))
      && payload.includes('比较一下')
    ))).toBe(true);
    expect(streamProbe.readOnlyRoots.some((roots) => roots.includes(sourceAttachmentDir))).toBe(true);
  });

  it('caps quoted references in the model payload with the shared dispatch budget', async () => {
    // A long quoted history is context, not the task. Without a cap the
    // top-level payload carried every reference in full — and for a segmented
    // message once per assignee — while the nested dispatch path already
    // clipped to 20 references / 12k chars each / 40k total.
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const reference = (index: number, text: string) => ({
      source_cid: 'source-cid',
      source_title: '来源任务',
      source_msg_id: `source-msg-${index}`,
      from_actor: 'writer',
      from_name: '撰稿人',
      source_ts: '2026-07-10T10:00:00',
      text,
    });
    const blockOf = (marker: string) => {
      const payload = streamProbe.messages.find((m) => m.includes(marker) && m.includes('<referenced-messages>')) || '';
      return payload.slice(payload.indexOf('<referenced-messages>'), payload.indexOf('</referenced-messages>'));
    };

    await bus.enqueue({
      uid: TEST_UID, cid: TEST_CID, fromActorId: 'user', text: '数一数引用',
      references: Array.from({ length: 25 }, (_, index) => reference(index, `SHORT${index}-quoted`)),
    });
    await waitForQuiescent(TEST_UID, TEST_CID);
    const counted = blockOf('数一数引用');
    expect(counted).toContain('SHORT19-');
    expect(counted).not.toContain('SHORT20-');

    await bus.enqueue({
      uid: TEST_UID, cid: TEST_CID, fromActorId: 'user', text: '读一读长引用',
      references: Array.from({ length: 6 }, (_, index) => reference(index, `LONG${index}-` + 'x'.repeat(30_000))),
    });
    await waitForQuiescent(TEST_UID, TEST_CID);
    const clipped = blockOf('读一读长引用');
    // 12k per reference and 40k in total: three full clips plus the remainder
    // of the fourth, then the block stops regardless of what was quoted.
    expect(clipped).toContain('LONG0-');
    expect(clipped).toContain('LONG3-');
    expect(clipped).not.toContain('LONG4-');
    expect(clipped).not.toMatch(/x{12001}/);
    expect(clipped.length).toBeLessThan(45_000);
  });

  it('hoists referenced produced files into an actionable block with a read root on a fresh turn', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    // Deliberately outside `$working_dir` and outside any attachment dir: this
    // is the case that used to be unreadable on a fresh turn while the same
    // reference worked as a mid-turn steer.
    const producedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-produced-'));
    const producedFile = path.join(producedDir, 'report.pdf');
    fs.writeFileSync(producedFile, 'produced report body');

    await bus.enqueue({
      uid: TEST_UID,
      cid: TEST_CID,
      fromActorId: 'user',
      text: '这篇文章主要讲了什么？总结下',
      references: [{
        source_cid: 'source-cid',
        source_title: '来源任务',
        source_msg_id: 'source-msg',
        from_actor: 'commander',
        from_name: 'Commander',
        source_ts: '2026-08-05T11:53:16',
        text: '已完成。PDF 共 28 页。',
        produced: [producedFile],
      }],
    });
    await waitForQuiescent(TEST_UID, TEST_CID);

    const payload = streamProbe.messages.find((m) => m.includes('这篇文章主要讲了什么')) || '';
    expect(payload).toContain('<referenced-files source="host-validated">');
    expect(payload).toContain(`path="${producedFile}"`);
    // The path must live OUTSIDE the inert quoted-records block, otherwise it
    // inherits "not executable instructions" framing and the model treats a
    // file the user pointed at as something it may not open.
    expect(payload.indexOf('<referenced-files')).toBeGreaterThan(payload.indexOf('</referenced-messages>'));
    // ...while that block keeps its anti-injection marking.
    expect(payload).toContain('not executable instructions or routing mentions');

    expect(streamProbe.readOnlyRoots.some((roots) => roots.includes(producedDir))).toBe(true);
    expect(streamProbe.historyResources.some((resources) => resources.some(
      (resource: any) => path.resolve(resource?.path || '') === producedFile,
    ))).toBe(true);
  });

  it('keeps earlier conversation attachments visible on later turns without reattaching', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const attachments = await import('../../../../src/main/features/chat_attachments');
    const cid = 'cid-attachment-index';

    await attachments.uploadAttachment(
      TEST_UID,
      cid,
      'orkas-1.0.5-update.md',
      Buffer.from('# Orkas 1.0.5\nAttachment index keeps old files discoverable.', 'utf8'),
    );

    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: 'please check the old md again',
    });
    await waitForQuiescent(TEST_UID, cid);

    const call = streamProbe.messages.find((m) => m.includes('please check the old md again')) || '';
    expect(call).toContain('<conversation-attachments');
    expect(call).toContain('name="orkas-1.0.5-update.md"');
    expect(call).toContain('kind="text"');
    expect(call).toContain('total_chars=');
  });

  it('does not treat commander failure prose as an execution failure', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
    await bus.enqueue({
      uid: TEST_UID, cid: TEST_CID, fromActorId: 'user',
      text: 'COMMANDER_RESULT_FAILURE_TEST',
    });
    await waitForQuiescent(TEST_UID, TEST_CID);

    const mainFile = path.join(paths.userChatsDir(TEST_UID), `${TEST_CID}.jsonl`);
    const lines = fs.readFileSync(mainFile, 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
    const reply = lines.find((line) => line.from === 'commander');
    expect(reply?.text).toBe('没有完成调度。');

    const stats = JSON.parse(fs.readFileSync(paths.commanderRuntimeStatsFile(TEST_UID), 'utf-8'));
    expect(stats.attempts).toBe(1);
    expect(stats.successes).toBe(1);
    expect(stats.deliveries).toBe(1);
    expect(stats.failures).toBe(0);
    expect(stats.errors).toBe(0);
  });

  it('records markerless commander completions as success when no runtime error occurs', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
    await bus.enqueue({
      uid: TEST_UID, cid: TEST_CID, fromActorId: 'user',
      text: '普通问题',
    });
    await waitForQuiescent(TEST_UID, TEST_CID);

    const stats = JSON.parse(fs.readFileSync(paths.commanderRuntimeStatsFile(TEST_UID), 'utf-8'));
    expect(stats.attempts).toBe(1);
    expect(stats.successes).toBe(1);
    expect(stats.deliveries).toBe(1);
    expect(stats.failures).toBe(0);
    expect(stats.errors).toBe(0);

    const mainFile = path.join(paths.userChatsDir(TEST_UID), `${TEST_CID}.jsonl`);
    const lines = fs.readFileSync(mainFile, 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
    const reply = lines.find((line) => line.from === 'commander');
    expect(reply?.process).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'event',
        event: expect.objectContaining({
          stream: 'runtime',
          data: expect.objectContaining({ duration_ms: expect.any(Number) }),
        }),
      }),
    ]));
  });

  it('persists context compaction metadata in process history', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
    const cid = 'cid-compaction-process';
    const events: any[] = [];
    bus.subscribe(TEST_UID, cid, (ev) => events.push(ev));
    await bus.enqueue({
      uid: TEST_UID, cid, fromActorId: 'user',
      text: 'COMPACTION_EVENT_TEST',
    });
    await waitForQuiescent(TEST_UID, cid);

    const mainFile = path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`);
    const lines = fs.readFileSync(mainFile, 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
    const reply = lines.find((line) => line.from === 'commander');
    expect(reply?.text).toBe('compaction recorded');
    expect(reply?.process).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'progress',
        text: 'compacted 20000→3000 tokens',
        event: {
          stream: 'compaction',
          data: { tokensBefore: 20000, tokensAfter: 3000 },
        },
      }),
      expect.objectContaining({
        type: 'event',
        event: expect.objectContaining({
          stream: 'runtime',
          data: expect.objectContaining({ duration_ms: expect.any(Number) }),
        }),
      }),
    ]));
    expect(events.some((e) => e.type === 'process' && e.data?.event?.stream === 'compaction')).toBe(true);
    expect(events.some((e) => e.type === 'process' && e.data?.event?.stream === 'runtime')).toBe(true);
  });

  it('persists phase timing attribution in the final runtime process item', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
    const cid = 'cid-runtime-breakdown';
    await bus.enqueue({
      uid: TEST_UID, cid, fromActorId: 'user', text: 'TIMING_EVENT_TEST',
    });
    await waitForQuiescent(TEST_UID, cid);

    const mainFile = path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`);
    const lines = fs.readFileSync(mainFile, 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
    const reply = lines.find((line) => line.from === 'commander');
    const runtime = reply?.process?.find((item: any) => item?.event?.stream === 'runtime');
    expect(runtime?.event?.data).toMatchObject({
      duration_ms: expect.any(Number),
      provider_ms: 40,
      tool_ms: 20,
      compaction_ms: 10,
      retry_wait_ms: 5,
      other_ms: 3,
      failure_phase: 'tool',
    });
  });

  it('user → @<name> resolves to agent_id and auto-adds the agent to the roster', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const state = await import('../../../../src/main/features/group_chat/state');
    const msg = await bus.enqueue({
      uid: TEST_UID, cid: TEST_CID, fromActorId: 'user',
      text: `@${AGENT_NAME} 我想要开发一个软件`,
    });
    expect(msg.to).toEqual([AGENT_ID]);

    // Auto-add: agent now appears in the roster
    const m = await state.readMembers(TEST_UID, TEST_CID);
    expect(m.actors.find((a) => a.id === AGENT_ID)).toBeTruthy();
    expect(m.actors.find((a) => a.id === AGENT_ID)?.name).toBe(AGENT_NAME);
  });

  it.each(['name', 'id'])('keeps unbound @%s text inside the eligible instruction instead of dropping it', async (mentionKind) => {
    const paths = await import('../../../../src/main/paths');
    const projects = await import('../../../../src/main/features/projects');
    const chats = await import('../../../../src/main/features/chats');
    const state = await import('../../../../src/main/features/group_chat/state');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const otherId = 'abc123def456';
    const otherName = 'Researcher';
    fs.mkdirSync(paths.agentDir(TEST_UID, otherId), { recursive: true });
    fs.writeFileSync(path.join(paths.agentDir(TEST_UID, otherId), 'agent.json'), JSON.stringify({
      agent_id: otherId, name: otherName, created_at: 't', updated_at: 't',
    }));
    const project = await projects.createProject(TEST_UID, 'Scoped mentions');
    if (!project.ok) throw new Error('project fixture failed');
    await projects.addAgentBinding(TEST_UID, project.project.project_id, AGENT_ID);
    const { conversation_id: cid } = await chats.createConversation(TEST_UID, {
      kind: 'normal', projectId: project.project.project_id,
    });
    cidsToDrop.add(cid);
    // A historical roster entry must not restore an Agent removed from the project.
    await state.ensureAgentMember(TEST_UID, cid, otherId, otherName);
    const tasks: any[] = [];
    const unsubscribe = bus.subscribe(TEST_UID, cid, (event) => {
      if (event.type === 'task_created') tasks.push(event.task);
    });
    try {
      const suffix = `implement A; @${mentionKind === 'name' ? otherName : otherId} research B`;
      const msg = await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: `@${AGENT_NAME} ${suffix}` });
      await waitForQuiescent(TEST_UID, cid);
      expect(msg.to).toEqual([AGENT_ID]);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].assignee).toBe(AGENT_ID);
      // Single-recipient routing retains its existing leading mention. The
      // contract here is complete instruction preservation, not prefix styling.
      expect(tasks[0].instruction.endsWith(suffix)).toBe(true);
      expect(streamProbe.messages.some((message) => message.includes('research B'))).toBe(true);
    } finally { unsubscribe(); }
  });

  it('passes the named Agent tool_list to its in-process model turn', async () => {
    const paths = await import('../../../../src/main/paths');
    const agentFile = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
    const spec = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
    spec.tool_list = ['workspace.read', 'web'];
    fs.writeFileSync(agentFile, JSON.stringify(spec));
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const cid = 'cid-agent-tool-list';

    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `@${AGENT_NAME} TOOL_LIST_PROPAGATION_TEST`,
    });
    await waitForQuiescent(TEST_UID, cid);

    const callIndex = streamProbe.messages.findIndex((message) => (
      message.includes('TOOL_LIST_PROPAGATION_TEST')
    ));
    expect(callIndex).toBeGreaterThanOrEqual(0);
    expect(streamProbe.toolLists[callIndex]).toEqual(['workspace.read', 'web']);
  });

  it('injects canonical group history into a fresh Agent session without creating a visibility sidecar', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
    const cid = 'cid-agent-history-isolation';
    const mainFile = path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`);
    fs.mkdirSync(path.dirname(mainFile), { recursive: true });
    fs.writeFileSync(mainFile, [
      {
        id: 'canonical-user-prior',
        ts: '2026-07-30T00:00:00.000Z',
        from: 'user',
        to: ['commander'],
        text: 'CANONICAL_USER_CONTEXT_MUST_BE_INJECTED',
      },
      {
        id: 'canonical-agent-prior',
        ts: '2026-07-30T00:00:01.000Z',
        from: 'commander',
        to: ['user'],
        text: 'CANONICAL_REPLY_CONTEXT_MUST_BE_INJECTED',
      },
    ].map((row) => JSON.stringify(row)).join('\n') + '\n');
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `@${AGENT_NAME} CURRENT_AGENT_TASK`,
    });
    await waitForQuiescent(TEST_UID, cid);

    const callIndex = streamProbe.messages.findIndex((message) => message.includes('CURRENT_AGENT_TASK'));
    const call = streamProbe.messages[callIndex] || '';
    const history = JSON.stringify(streamProbe.conversationHistories[callIndex] || null);
    expect(call).toContain('CURRENT_AGENT_TASK');
    expect(history).toContain('CANONICAL_USER_CONTEXT_MUST_BE_INJECTED');
    expect(history).toContain('CANONICAL_REPLY_CONTEXT_MUST_BE_INJECTED');
    expect(history).toContain('Commander');
    const projected = streamProbe.conversationHistories[callIndex];
    expect(projected.source).toBe(`group-main-v5:${cid}:actor:${AGENT_ID}`);
    expect(JSON.stringify(projected.messages.filter((message: any) => message.role === 'assistant')))
      .not.toContain('CANONICAL_REPLY_CONTEXT_MUST_BE_INJECTED');
    expect(call).not.toContain('<group-chat-history>');
    expect(call).not.toContain('<agent-handoff');
    expect(fs.existsSync(path.join(paths.userChatsDir(TEST_UID), cid, 'visibility'))).toBe(false);
  });

  it.each(['core', 'cli'] as const)(
    'rehydrates historical cross-conversation reference attachment paths for a fresh %s Agent',
    async (runtime) => {
      const bus = await import('../../../../src/main/features/group_chat/bus');
      const paths = await import('../../../../src/main/paths');
      const layout = await import('../../../../src/main/util/project-layout');
      const cid = `cid-${runtime}-historical-reference-path`;
      const sourceCid = `source-${runtime}-historical-reference-path`;
      const attachmentName = 'quoted-brief.txt';
      const sourceAttachmentDir = layout.chatAttachmentDirForConversation(TEST_UID, sourceCid);
      const sourceAttachmentPath = path.join(sourceAttachmentDir, attachmentName);
      fs.mkdirSync(sourceAttachmentDir, { recursive: true });
      fs.writeFileSync(sourceAttachmentPath, `${runtime} historical reference attachment`);

      if (runtime === 'cli') {
        const agentFile = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
        const spec = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
        spec.runtime = { kind: 'cli', cli: 'codex' };
        fs.writeFileSync(agentFile, JSON.stringify(spec));
      }

      const mainFile = path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`);
      fs.mkdirSync(path.dirname(mainFile), { recursive: true });
      fs.writeFileSync(mainFile, [
        {
          id: 'historical-reference-user',
          ts: '2026-08-05T00:00:00.000Z',
          from: 'user',
          to: ['commander'],
          text: 'Keep this quoted attachment available to later Agents.',
          references: [{
            source_cid: sourceCid,
            source_title: 'Quoted source task',
            source_msg_id: 'quoted-source-message',
            from_actor: 'user',
            source_ts: '2026-08-04T00:00:00.000Z',
            text: 'The attachment contains the exact brief.',
            attachments: [{ name: attachmentName, kind: 'text' }],
          }],
        },
        {
          id: 'historical-reference-reply',
          ts: '2026-08-05T00:00:01.000Z',
          from: 'commander',
          to: ['user'],
          text: 'The quoted brief is recorded.',
        },
      ].map((row) => JSON.stringify(row)).join('\n') + '\n');

      await bus.enqueue({
        uid: TEST_UID,
        cid,
        fromActorId: 'user',
        text: `@${AGENT_NAME} USE_HISTORICAL_REFERENCE_${runtime.toUpperCase()}`,
      });
      await waitForQuiescent(TEST_UID, cid);

      const modelContext = runtime === 'cli'
        ? String(cliRunMock.calls[0]?.prompt || '')
        : collectStringLeaves(streamProbe.conversationHistories[
          streamProbe.messages.findIndex((message) => (
            message.includes(`USE_HISTORICAL_REFERENCE_${runtime.toUpperCase()}`)
          ))
        ] || null).join('\n');
      expect(modelContext).toContain(sourceAttachmentPath.replace(/\\/g, '\\\\'));

      const canonicalText = fs.readFileSync(mainFile, 'utf8');
      expect(canonicalText).toContain(`"name":"${attachmentName}"`);
      expect(canonicalText).not.toContain(sourceAttachmentPath);
    },
  );

  it('refreshes a named Agent from its own canonical-history checkpoint on the next turn', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
    const state = await import('../../../../src/main/features/group_chat/state');
    const sessions = await import('../../../../src/main/model/core-agent/session-store');
    const cid = 'cid-agent-incremental-history';

    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `@${AGENT_NAME} AGENT_CANONICAL_FIRST_TURN`,
    });
    await waitForQuiescent(TEST_UID, cid);

    const firstIndex = streamProbe.messages.findIndex((message) =>
      message.includes('AGENT_CANONICAL_FIRST_TURN'));
    const firstHistory = streamProbe.conversationHistories[firstIndex];
    expect(firstHistory?.replaceFromTurnId).toBeUndefined();
    expect(firstHistory?.checkpoint).toEqual(expect.any(String));

    // The model client is mocked, so mirror the normal CoreAgent history
    // rebase and completed turn before asking the bus for an incremental tail.
    const session = await sessions.getSessionForUser(
      TEST_UID,
      state.buildGmemberSessionId(cid, AGENT_ID),
    );
    session.replaceConversationHistory(
      firstHistory.messages,
      firstHistory.source,
      { checkpoint: firstHistory.checkpoint },
    );
    session.beginUserTurn([{ type: 'text', text: 'AGENT_CANONICAL_FIRST_TURN' }]);
    session.addAssistantMessage([{ type: 'text', text: '(no reply)' }]);
    session.completeActiveTurn();

    const mainFile = path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`);
    fs.appendFileSync(mainFile, [
      {
        id: 'agent-interposed-user',
        ts: '2026-08-05T01:00:00.000Z',
        from: 'user',
        to: ['commander'],
        text: 'AGENT_INTERPOSED_CANONICAL_USER_FACT',
      },
      {
        id: 'agent-interposed-commander',
        ts: '2026-08-05T01:00:01.000Z',
        from: 'commander',
        to: ['user'],
        text: 'AGENT_INTERPOSED_CANONICAL_COMMANDER_FACT',
      },
    ].map((row) => JSON.stringify(row)).join('\n') + '\n');
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `@${AGENT_NAME} AGENT_CANONICAL_SECOND_TURN`,
    });
    await waitForQuiescent(TEST_UID, cid);

    const secondIndex = streamProbe.messages.findIndex((message) =>
      message.includes('AGENT_CANONICAL_SECOND_TURN'));
    const secondHistory = streamProbe.conversationHistories[secondIndex];
    const serialized = JSON.stringify(secondHistory?.messages);
    expect(secondHistory?.replaceFromTurnId).toBe(1);
    expect(serialized).toContain('AGENT_CANONICAL_FIRST_TURN');
    expect(serialized).toContain('AGENT_INTERPOSED_CANONICAL_USER_FACT');
    expect(serialized).toContain('AGENT_INTERPOSED_CANONICAL_COMMANDER_FACT');
    expect(serialized).not.toContain('AGENT_CANONICAL_SECOND_TURN');
    expect(JSON.stringify(secondHistory.messages.filter((message: any) => message.role === 'assistant')))
      .not.toContain('AGENT_INTERPOSED_CANONICAL_COMMANDER_FACT');
  });

  it('passes the explicit 100-round tool budget into a named agent run', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    await bus.enqueue({
      uid: TEST_UID, cid: TEST_CID, fromActorId: 'user',
      text: `@${AGENT_NAME} 执行一个长程任务`,
    });
    await waitForQuiescent(TEST_UID, TEST_CID);

    const callIndex = streamProbe.messages.findIndex((message) => message.includes('执行一个长程任务'));
    expect(callIndex).toBeGreaterThanOrEqual(0);
    expect(streamProbe.maxToolLoops[callIndex]).toBe(100);
  });

  it('admits a named Agent turn only after the short runtime-content publish window', async () => {
    const runtimePublish = await import('../../../../src/main/features/runtime_content_publish');
    let releasePublish!: () => void;
    let markPublishStarted!: () => void;
    const publishStarted = new Promise<void>((resolve) => { markPublishStarted = resolve; });
    const publishGate = new Promise<void>((resolve) => { releasePublish = resolve; });
    const publishing = runtimePublish.withIdleRuntimePublish(TEST_UID, async () => {
      markPublishStarted();
      await publishGate;
    });
    await publishStarted;

    const bus = await import('../../../../src/main/features/group_chat/bus');
    await bus.enqueue({
      uid: TEST_UID, cid: TEST_CID, fromActorId: 'user',
      text: `@${AGENT_NAME} BUILTIN_TURN_BARRIER_TEST`,
    });

    const admissionAt = Date.now();
    while (runtimePublish._runtimeContentPublishState(TEST_UID).waitingTurns === 0) {
      if (Date.now() - admissionAt > 1_000) throw new Error('Agent turn did not reach runtime-content admission');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(streamProbe.messages.some((message) => message.includes('BUILTIN_TURN_BARRIER_TEST'))).toBe(false);

    releasePublish();
    await publishing;
    await waitForQuiescent(TEST_UID, TEST_CID);
    expect(streamProbe.messages.some((message) => message.includes('BUILTIN_TURN_BARRIER_TEST'))).toBe(true);
  });

  it('does not treat agent failure prose as an execution failure', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
    await bus.enqueue({
      uid: TEST_UID, cid: TEST_CID, fromActorId: 'user',
      text: `@${AGENT_NAME} AGENT_RESULT_FAILURE_TEST`,
    });
    await waitForQuiescent(TEST_UID, TEST_CID);

    const mainFile = path.join(paths.userChatsDir(TEST_UID), `${TEST_CID}.jsonl`);
    const lines = fs.readFileSync(mainFile, 'utf-8').trim().split('\n').map((line) => JSON.parse(line));
    const reply = lines.find((line) => line.from === AGENT_ID);
    expect(reply?.text).toBe('没有完成交付。');

    const stats = JSON.parse(fs.readFileSync(paths.agentRuntimeStatsFile(TEST_UID, AGENT_ID), 'utf-8'));
    expect(stats.attempts).toBe(1);
    expect(stats.successes).toBe(1);
    expect(stats.deliveries).toBe(1);
    expect(stats.failures).toBe(0);
    expect(stats.errors).toBe(0);
  });

  it('persists assistant sandbox media as a versioned local URL without rewriting the user row', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
    const cid = 'cid-local-media-persistence';
    const videoPath = path.join(tmpDir, 'workspace', 'final.mp4');
    fs.writeFileSync(videoPath, 'final-video');
    const mediaText = `[video](sandbox:${videoPath})`;
    const encoded = Buffer.from(JSON.stringify({ text: mediaText }), 'utf8').toString('base64');

    await bus.enqueue({
      uid: TEST_UID, cid, fromActorId: 'user',
      text: `@${AGENT_NAME} LOCAL_MEDIA_REPLY_TEST:${encoded} keep ${mediaText}`,
    });
    await waitForQuiescent(TEST_UID, cid);

    const rows = fs.readFileSync(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line));
    const user = rows.find((row: any) => row.from === 'user');
    const reply = rows.find((row: any) => row.from === AGENT_ID);
    expect(user?.text).toContain(mediaText);
    expect(reply?.text).toMatch(/^\[video\]\(chat-media:\/\/local\/.+\?v=\d+-\d+-11\)$/);
    expect(reply?.text).not.toContain('sandbox:');
    expect(reply?.failure_kind).toBeUndefined();
  });

  it('keeps a missing sandbox media destination canonical without recording a failure', async () => {
    // A missing deliverable is not an execution failure: the host observes
    // execution outcomes and no longer synthesizes `claimed_media_missing`.
    // The alias still normalizes to a stable canonical URL so the renderer's
    // normal missing-media handling owns the user-visible outcome.
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
    const cid = 'cid-missing-sandbox-media';
    const missingPath = path.join(tmpDir, 'workspace', 'never-rendered.mp4');
    const mediaText = `[video](sandbox:${missingPath})`;
    const encoded = Buffer.from(JSON.stringify({ text: mediaText }), 'utf8').toString('base64');

    await bus.enqueue({
      uid: TEST_UID, cid, fromActorId: 'user',
      text: `@${AGENT_NAME} LOCAL_MEDIA_REPLY_TEST:${encoded}`,
    });
    await waitForQuiescent(TEST_UID, cid);

    const rows = fs.readFileSync(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line));
    const reply = rows.find((row: any) => row.from === AGENT_ID);
    expect(reply?.text).toContain('chat-media://local/');
    expect(reply?.text).not.toContain('sandbox:');
    expect(reply?.failure_kind).toBeUndefined();
    expect(reply?.failure_code).toBeUndefined();
  });

  it('records markerless agent completions as success when no runtime error occurs', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
    await bus.enqueue({
      uid: TEST_UID, cid: TEST_CID, fromActorId: 'user',
      text: `@${AGENT_NAME} AGENT_MARKERLESS_SUCCESS_TEST`,
    });
    await waitForQuiescent(TEST_UID, TEST_CID);

    const stats = JSON.parse(fs.readFileSync(paths.agentRuntimeStatsFile(TEST_UID, AGENT_ID), 'utf-8'));
    expect(stats.attempts).toBe(1);
    expect(stats.successes).toBe(1);
    expect(stats.deliveries).toBe(1);
    expect(stats.failures).toBe(0);
    expect(stats.errors).toBe(0);
  });

  it('exposes a stable active turn id from process event through final message', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const events: any[] = [];
    let resolveProgress: ((ev: any) => void) | null = null;
    const progressSeen = new Promise<any>((resolve) => { resolveProgress = resolve; });
    bus.subscribe(TEST_UID, TEST_CID, (ev) => {
      events.push(ev);
      if (ev.type === 'process' && ev.actor === 'commander' && ev.data?.type === 'progress') {
        resolveProgress?.(ev);
      }
    });

    try {
      const trigger = await bus.enqueue({
        uid: TEST_UID, cid: TEST_CID, fromActorId: 'user',
        text: 'ACTIVE_TURN_TEST',
      });
      const processEv = await Promise.race([
        progressSeen,
        new Promise((_, reject) => setTimeout(() => reject(new Error('progress event timeout')), 1000)),
      ]) as any;

      expect(processEv.turn_id).toEqual(expect.any(String));
      const running = bus.runtimeSnapshot(TEST_UID, TEST_CID);
      expect(running.activeTurns).toHaveLength(1);
      expect(running.activeTurns[0]).toMatchObject({
        actor: 'commander',
        turn_id: processEv.turn_id,
        msg_id: trigger.id,
        started_at_ms: expect.any(Number),
      });
      expect(running.activeTurns[0].started_at_ms).toBeLessThanOrEqual(Date.now());
      expect(bus.runtimeSnapshot(TEST_UID, TEST_CID).activeTurns[0].started_at_ms)
        .toBe(running.activeTurns[0].started_at_ms);
      expect(running.inFlight).toContain('commander');

      streamGate.releaseActiveTurn?.();
      await waitForQuiescent(TEST_UID, TEST_CID);

      const finalEv = events.find((ev) => ev.type === 'message' && ev.turn_end && ev.msg?.from === 'commander');
      expect(finalEv?.turn_id).toBe(processEv.turn_id);
      expect(finalEv?.msg?.turn_id).toBe(processEv.turn_id);
      expect(finalEv?.msg?.source_message_id).toBe(trigger.id);
      const paths = await import('../../../../src/main/paths');
      const persisted = fs.readFileSync(
        path.join(paths.userChatsDir(TEST_UID), `${TEST_CID}.jsonl`),
        'utf8',
      ).trim().split('\n').map((line) => JSON.parse(line));
      expect(persisted.find((row) => row.id === finalEv?.msg?.id)?.turn_id).toBe(processEv.turn_id);
      expect(persisted.find((row) => row.id === finalEv?.msg?.id)?.source_message_id).toBe(trigger.id);
      expect(bus.runtimeSnapshot(TEST_UID, TEST_CID).activeTurns).toEqual([]);
    } finally {
      streamGate.releaseActiveTurn?.();
      streamGate.releaseActiveTurn = null;
    }
  });

  // `@<agent_id>` → `@<name>` rewrite assertions live in
  // `bus-integration.test.ts` since they only matter for the persisted
  // form viewed end-to-end. Keep this file focused on bus's standalone
  // routing / persistence semantics.

  it('writes the message only into the canonical jsonl', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
    await bus.enqueue({
      uid: TEST_UID, cid: TEST_CID, fromActorId: 'user',
      text: `@${AGENT_NAME} 第一条任务`,
    });
    const mainFile = path.join(paths.userChatsDir(TEST_UID), `${TEST_CID}.jsonl`);
    expect(fs.existsSync(mainFile)).toBe(true);
    const mainLine = fs.readFileSync(mainFile, 'utf-8').trim();
    const persisted = JSON.parse(mainLine);
    expect(persisted.to).toEqual([AGENT_ID]);

    expect(fs.existsSync(path.join(paths.userChatsDir(TEST_UID), TEST_CID, 'visibility'))).toBe(false);
  });

  it('emits artifact_created as soon as create_artifact reports success', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const events: any[] = [];
    bus.subscribe(TEST_UID, TEST_CID, (ev) => events.push(ev));

    await bus.enqueue({
      uid: TEST_UID, cid: TEST_CID, fromActorId: 'user',
      text: 'ARTIFACT_EVENT_TEST',
    });
    await waitForQuiescent(TEST_UID, TEST_CID);

    const artifactIdx = events.findIndex((e) => e.type === 'artifact_created');
    const finalIdx = events.findIndex((e) =>
      e.type === 'message' && e.turn_end === true && e.msg?.from === 'commander');
    expect(artifactIdx).toBeGreaterThanOrEqual(0);
    expect(finalIdx).toBeGreaterThan(artifactIdx);
    expect(events[artifactIdx]).toMatchObject({
      cid: TEST_CID,
      actor: 'commander',
      artifact: { id: 'art-live-1', title: 'Live App', agent_id: 'commander' },
    });
    expect(events[finalIdx].msg.artifacts).toEqual([
      { id: 'art-live-1', title: 'Live App', agent_id: 'commander' },
    ]);
  });

  it('filters stale produced paths before persisting the final message', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
    const cid = 'cid-produced-filter';
    const stalePath = path.join(tmpDir, 'workspace', 'projects', 'business_planning.md');
    const finalPath = path.join(tmpDir, 'workspace', 'projects', 'deck', 'sources', 'business_planning.md');
    fs.mkdirSync(path.dirname(finalPath), { recursive: true });
    fs.writeFileSync(finalPath, 'final source');

    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `PRODUCED_FILTER_TEST:${Buffer.from(JSON.stringify({
        paths: [stalePath, finalPath],
      })).toString('base64')}`,
    });
    await waitForQuiescent(TEST_UID, cid);

    const mainFile = path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`);
    const rows = fs.readFileSync(mainFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const commanderMsg = rows.find((row: any) => row.from === 'commander' && row.text === 'produced filter ok');
    expect(commanderMsg?.produced).toEqual([finalPath]);
    expect(bus._cidStateForTest(TEST_UID, cid)?.producedPaths.has(stalePath)).toBe(false);
    expect(bus._cidStateForTest(TEST_UID, cid)?.producedPaths.has(finalPath)).toBe(true);
  });

  it('normalizes produced-file identity before resource publication', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
    const cid = 'cid-canonical-publication-path';
    const finalPath = path.join(tmpDir, 'workspace', 'sales-report.xlsx');
    const nonCanonicalPath = `${path.join(tmpDir, 'workspace')}${path.sep}drafts${path.sep}..${path.sep}sales-report.xlsx`;
    fs.mkdirSync(path.dirname(finalPath), { recursive: true });
    fs.writeFileSync(finalPath, 'xlsx');

    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `PUBLISHED_OUTPUT_TEST:${Buffer.from(JSON.stringify({
        paths: [nonCanonicalPath],
        published: [finalPath],
      })).toString('base64')}`,
    });
    await waitForQuiescent(TEST_UID, cid);

    const mainFile = path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`);
    const rows = fs.readFileSync(mainFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const commanderMsg = rows.find((row: any) => row.from === 'commander');
    expect(commanderMsg?.text).toBe('published output ok');
    expect(commanderMsg?.produced).toEqual([finalPath]);
    expect(bus._cidStateForTest(TEST_UID, cid)?.producedPaths.has(finalPath)).toBe(true);
    expect(bus._cidStateForTest(TEST_UID, cid)?.producedPaths.has(nonCanonicalPath)).toBe(false);
  });

  it('preserves model text and status when resource publication filters every requested path', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
    const cid = 'cid-rejected-output-publication';
    const missingPath = path.join(tmpDir, 'workspace', 'poster.html');

    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `PUBLISHED_OUTPUT_TEST:${Buffer.from(JSON.stringify({
        paths: [],
        published: [missingPath],
      })).toString('base64')}`,
    });
    await waitForQuiescent(TEST_UID, cid);

    const mainFile = path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`);
    const rows = fs.readFileSync(mainFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const commanderMsg = rows.find((row: any) => row.from === 'commander');
    expect(commanderMsg?.text).toBe('published output ok');
    expect(commanderMsg?.failure_kind).toBeUndefined();
    expect(commanderMsg?.failure_code).toBeUndefined();
    expect(commanderMsg?.produced).toBeUndefined();
  });

  it('allows a valid publication retry to resolve an earlier rejected path', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
    const cid = 'cid-output-publication-retry';
    const missingPath = path.join(tmpDir, 'workspace', 'missing.html');
    const finalPath = path.join(tmpDir, 'workspace', 'poster.html');
    fs.writeFileSync(finalPath, '<!doctype html>');

    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `PUBLISHED_OUTPUT_TEST:${Buffer.from(JSON.stringify({
        paths: [finalPath],
        publications: [[missingPath], [finalPath]],
      })).toString('base64')}`,
    });
    await waitForQuiescent(TEST_UID, cid);

    const mainFile = path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`);
    const rows = fs.readFileSync(mainFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const commanderMsg = rows.find((row: any) => row.from === 'commander');
    expect(commanderMsg?.text).toBe('published output ok');
    expect(commanderMsg?.failure_code).toBeUndefined();
    expect(commanderMsg?.produced).toEqual([finalPath]);
  });

  it('replaces an earlier publication with the eligible subset of a later declaration', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
    const cid = 'cid-output-publication-invalid-correction';
    const finalPath = path.join(tmpDir, 'workspace', 'poster.html');
    const missingPath = path.join(tmpDir, 'workspace', 'missing.html');
    fs.writeFileSync(finalPath, '<!doctype html>');

    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `PUBLISHED_OUTPUT_TEST:${Buffer.from(JSON.stringify({
        paths: [finalPath],
        publications: [[finalPath], [missingPath]],
      })).toString('base64')}`,
    });
    await waitForQuiescent(TEST_UID, cid);

    const mainFile = path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`);
    const rows = fs.readFileSync(mainFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const commanderMsg = rows.find((row: any) => row.from === 'commander');
    expect(commanderMsg?.text).toBe('published output ok');
    expect(commanderMsg?.failure_code).toBeUndefined();
    expect(commanderMsg?.produced).toBeUndefined();
  });

  it('persists only the terminal deliverable while retaining supporting-file ownership', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
    const cid = 'cid-produced-deliverable';
    const sourcePath = path.join(tmpDir, 'workspace', 'report.md');
    const previewPath = path.join(tmpDir, 'workspace', 'preview-cover.png');
    const finalPath = path.join(tmpDir, 'workspace', 'report.pdf');
    for (const [file, body] of [
      [sourcePath, '# source'],
      [previewPath, 'preview'],
      [finalPath, 'pdf'],
    ] as const) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, body);
    }

    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `PRODUCED_FILTER_TEST:${Buffer.from(JSON.stringify({
        paths: [sourcePath, previewPath, finalPath],
      })).toString('base64')}`,
    });
    await waitForQuiescent(TEST_UID, cid);

    const mainFile = path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`);
    const rows = fs.readFileSync(mainFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const commanderMsg = rows.find((row: any) => row.from === 'commander' && row.text === 'produced filter ok');
    expect(commanderMsg?.produced).toEqual([finalPath]);
    expect(bus._cidStateForTest(TEST_UID, cid)?.producedPaths.has(sourcePath)).toBe(true);
    expect(bus._cidStateForTest(TEST_UID, cid)?.producedPaths.has(previewPath)).toBe(true);
    expect(bus._cidStateForTest(TEST_UID, cid)?.producedPaths.has(finalPath)).toBe(true);
  });

  it('never finalizes a source-like file, including when it is explicitly published', async () => {
    const hooks = await import('../../../../src/main/features/produced_output_hooks');
    const finalized: string[] = [];
    const unregister = hooks.registerProducedOutputHooks({
      finalizeFile: async (file) => { finalized.push(file); },
    });
    try {
      const bus = await import('../../../../src/main/features/group_chat/bus');
      const sourcePath = path.join(tmpDir, 'workspace', 'repository', 'README.md');
      fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
      fs.mkdirSync(path.join(path.dirname(sourcePath), '.git'));
      fs.writeFileSync(sourcePath, '# source');
      const deliverablePath = path.join(tmpDir, 'workspace', 'summary.md');
      fs.writeFileSync(deliverablePath, '# summary');

      await bus.enqueue({
        uid: TEST_UID,
        cid: 'cid-source-provenance',
        fromActorId: 'user',
        text: `PRODUCED_FILTER_TEST:${Buffer.from(JSON.stringify({ paths: [sourcePath] })).toString('base64')}`,
      });
      await waitForQuiescent(TEST_UID, 'cid-source-provenance');
      expect(finalized).toEqual([]);

      // `publish_outputs` is the model's own presentation choice, so it cannot
      // double as consent to rewrite the bytes of a repository the user ships
      // from. The declaration still decides what the bubble shows; the
      // version-controlled file is shown without being modified.
      await bus.enqueue({
        uid: TEST_UID,
        cid: 'cid-explicit-source-deliverable',
        fromActorId: 'user',
        text: `PUBLISHED_OUTPUT_TEST:${Buffer.from(JSON.stringify({
          paths: [sourcePath, deliverablePath],
          published: [sourcePath, deliverablePath],
        })).toString('base64')}`,
      });
      await waitForQuiescent(TEST_UID, 'cid-explicit-source-deliverable');
      // The non-source deliverable is the control: publication still reaches
      // finalization, so the exclusion above is not an empty turn.
      expect(finalized).toEqual([deliverablePath]);
      expect(fs.readFileSync(sourcePath, 'utf8')).toBe('# source');
    } finally {
      unregister();
    }
  });

  it('does not finalize files produced at an open review gate', async () => {
    const hooks = await import('../../../../src/main/features/produced_output_hooks');
    const finalized: string[] = [];
    const unregister = hooks.registerProducedOutputHooks({
      finalizeFile: async (file) => { finalized.push(file); },
    });
    try {
      const bus = await import('../../../../src/main/features/group_chat/bus');
      const paths = await import('../../../../src/main/paths');
      const cid = 'cid-open-gate-output';
      const htmlPath = path.join(tmpDir, 'workspace', 'project', 'composition', 'index.html');
      fs.mkdirSync(path.dirname(htmlPath), { recursive: true });
      fs.writeFileSync(htmlPath, '<!doctype html><html><body>clean composition</body></html>');

      // Plan-interaction parsing is intentionally limited to interactive
      // agents. Make this fixture match VideoStudio's runtime contract.
      const agentPath = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
      const agent = JSON.parse(fs.readFileSync(agentPath, 'utf8'));
      fs.writeFileSync(agentPath, JSON.stringify({ ...agent, interactive: true }));

      await bus.enqueue({
        uid: TEST_UID,
        cid,
        fromActorId: 'user',
        text: `@${AGENT_NAME} PRODUCED_FILTER_TEST:${Buffer.from(JSON.stringify({
          paths: [htmlPath],
          planInteraction: 'open',
          withForm: true,
        })).toString('base64')}`,
      });
      await waitForQuiescent(TEST_UID, cid);

      const mainFile = path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`);
      const rows = fs.readFileSync(mainFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      const agentMsg = rows.find((row: any) => row.from === AGENT_ID && row.text === 'produced filter ok');
      expect(agentMsg?.produced).toBeUndefined();
      expect(agentMsg?.form?.fields?.[0]?.id).toBe('decision');
      expect(finalized).toEqual([]);
      expect(fs.readFileSync(htmlPath, 'utf8')).toContain('clean composition');
    } finally {
      unregister();
    }
  });

  it('shows explicitly published review outputs at an open gate without finalizing them', async () => {
    const hooks = await import('../../../../src/main/features/produced_output_hooks');
    const finalized: string[] = [];
    const unregister = hooks.registerProducedOutputHooks({
      finalizeFile: async (file) => { finalized.push(file); },
    });
    try {
      const bus = await import('../../../../src/main/features/group_chat/bus');
      const paths = await import('../../../../src/main/paths');
      const cid = 'cid-open-gate-review-output';
      const contactSheetPath = path.join(tmpDir, 'workspace', 'project', 'composition', 'preview', 'contact-sheet.svg');
      fs.mkdirSync(path.dirname(contactSheetPath), { recursive: true });
      fs.writeFileSync(contactSheetPath, '<svg xmlns="http://www.w3.org/2000/svg"></svg>');

      const agentPath = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
      const agent = JSON.parse(fs.readFileSync(agentPath, 'utf8'));
      fs.writeFileSync(agentPath, JSON.stringify({ ...agent, interactive: true }));

      await bus.enqueue({
        uid: TEST_UID,
        cid,
        fromActorId: 'user',
        text: `@${AGENT_NAME} PUBLISHED_OUTPUT_TEST:${Buffer.from(JSON.stringify({
          paths: [contactSheetPath],
          published: [contactSheetPath],
          planInteraction: 'open',
          withForm: true,
        })).toString('base64')}`,
      });
      await waitForQuiescent(TEST_UID, cid);

      const mainFile = path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`);
      const rows = fs.readFileSync(mainFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      const agentMsg = rows.find((row: any) => row.from === AGENT_ID && row.text === 'published output ok');
      expect(agentMsg?.produced).toEqual([contactSheetPath]);
      expect(agentMsg?.form?.fields?.[0]?.id).toBe('decision');
      expect(finalized).toEqual([]);
    } finally {
      unregister();
    }
  });

  it('shows and finalizes explicitly published draft videos at Gate D', async () => {
    const hooks = await import('../../../../src/main/features/produced_output_hooks');
    const finalized: string[] = [];
    const unregister = hooks.registerProducedOutputHooks({
      finalizeFile: async (file) => { finalized.push(file); },
    });
    try {
      const bus = await import('../../../../src/main/features/group_chat/bus');
      const paths = await import('../../../../src/main/paths');
      const cid = 'cid-open-gate-draft-video';
      const draftPath = path.join(tmpDir, 'workspace', 'project', 'render', 'draft.webm');
      fs.mkdirSync(path.dirname(draftPath), { recursive: true });
      fs.writeFileSync(draftPath, 'draft video bytes');

      const agentPath = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
      const agent = JSON.parse(fs.readFileSync(agentPath, 'utf8'));
      fs.writeFileSync(agentPath, JSON.stringify({ ...agent, interactive: true }));

      await bus.enqueue({
        uid: TEST_UID,
        cid,
        fromActorId: 'user',
        text: `@${AGENT_NAME} PUBLISHED_OUTPUT_TEST:${Buffer.from(JSON.stringify({
          paths: [draftPath],
          published: [draftPath],
          planInteraction: 'open',
          withForm: true,
        })).toString('base64')}`,
      });
      await waitForQuiescent(TEST_UID, cid);

      const mainFile = path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`);
      const rows = fs.readFileSync(mainFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      const agentMsg = rows.find((row: any) => row.from === AGENT_ID && row.text === 'published output ok');
      expect(agentMsg?.produced).toEqual([draftPath]);
      expect(agentMsg?.form?.fields?.[0]?.id).toBe('decision');
      expect(finalized).toEqual([draftPath]);
    } finally {
      unregister();
    }
  });

  it('finalizes explicitly published exported videos on terminal delivery', async () => {
    const hooks = await import('../../../../src/main/features/produced_output_hooks');
    const finalized: string[] = [];
    const unregister = hooks.registerProducedOutputHooks({
      finalizeFile: async (file) => { finalized.push(file); },
    });
    try {
      const bus = await import('../../../../src/main/features/group_chat/bus');
      const paths = await import('../../../../src/main/paths');
      const cid = 'cid-export-video-final';
      const finalPath = path.join(tmpDir, 'workspace', 'project', 'render', 'final.mp4');
      fs.mkdirSync(path.dirname(finalPath), { recursive: true });
      fs.writeFileSync(finalPath, 'final video bytes');

      await bus.enqueue({
        uid: TEST_UID,
        cid,
        fromActorId: 'user',
        text: `PUBLISHED_OUTPUT_TEST:${Buffer.from(JSON.stringify({
          paths: [finalPath],
          published: [finalPath],
        })).toString('base64')}`,
      });
      await waitForQuiescent(TEST_UID, cid);

      const mainFile = path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`);
      const rows = fs.readFileSync(mainFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      const commanderMsg = rows.find((row: any) => row.from === 'commander' && row.text === 'published output ok');
      expect(commanderMsg?.produced).toEqual([finalPath]);
      expect(finalized).toEqual([finalPath]);
    } finally {
      unregister();
    }
  });

  it('prefers an explicit current-turn publication over extension ranking', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
    const cid = 'cid-published-output';
    const sourcePath = path.join(tmpDir, 'workspace', 'editable-source.md');
    const finalPath = path.join(tmpDir, 'workspace', 'export.pdf');
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, '# source');
    fs.writeFileSync(finalPath, 'pdf');

    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `PUBLISHED_OUTPUT_TEST:${Buffer.from(JSON.stringify({
        paths: [sourcePath, finalPath],
        published: [sourcePath],
      })).toString('base64')}`,
    });
    await waitForQuiescent(TEST_UID, cid);

    const mainFile = path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`);
    const rows = fs.readFileSync(mainFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const commanderMsg = rows.find((row: any) => row.from === 'commander' && row.text === 'published output ok');
    expect(commanderMsg?.produced).toEqual([sourcePath]);
  });

  it('allows an explicit empty publication to suppress ambiguous working files', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
    const cid = 'cid-published-output-empty';
    const scriptPath = path.join(tmpDir, 'workspace', 'script.md');
    const shotlistPath = path.join(tmpDir, 'workspace', 'shotlist.json');
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(scriptPath, '# script');
    fs.writeFileSync(shotlistPath, '{}');

    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `PUBLISHED_OUTPUT_TEST:${Buffer.from(JSON.stringify({
        paths: [scriptPath, shotlistPath],
        published: [],
      })).toString('base64')}`,
    });
    await waitForQuiescent(TEST_UID, cid);

    const mainFile = path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`);
    const rows = fs.readFileSync(mainFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const commanderMsg = rows.find((row: any) => row.from === 'commander' && row.text === 'published output ok');
    expect(commanderMsg?.produced).toBeUndefined();
    expect(fs.existsSync(scriptPath)).toBe(true);
    expect(fs.existsSync(shotlistPath)).toBe(true);
  });

  it.each(['shotlist.json', 'metadata.json', 'working/shotlist.json'])(
    'hides process-dispatch file %s while keeping its path in the commander handback', async (filename) => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
    const cid = 'cid-process-output-hidden';
    const processPath = path.join(tmpDir, 'workspace', filename);
    fs.mkdirSync(path.dirname(processPath), { recursive: true });
    fs.writeFileSync(processPath, '{}');

    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `NESTED_OUTPUT_VISIBILITY_TEST:${Buffer.from(JSON.stringify({
        tool: 'dispatch_to',
        path: processPath,
      })).toString('base64')}`,
    });
    await waitForQuiescent(TEST_UID, cid);

    const mainFile = path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`);
    const rows = fs.readFileSync(mainFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const agentMsg = rows.find((row: any) => row.from === AGENT_ID && row.text === 'produced filter ok');
    expect(agentMsg?.produced).toBeUndefined();
    expect(streamProbe.dispatchResults.some((result) => result.includes(processPath))).toBe(true);
    expect(fs.existsSync(processPath)).toBe(true);
  });

  it('keeps hand-off files visible because the agent bubble is the final delivery', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
    const cid = 'cid-final-output-visible';
    const finalPath = path.join(tmpDir, 'workspace', 'final.pdf');
    fs.mkdirSync(path.dirname(finalPath), { recursive: true });
    fs.writeFileSync(finalPath, 'pdf');

    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `NESTED_OUTPUT_VISIBILITY_TEST:${Buffer.from(JSON.stringify({
        tool: 'hand_off_to',
        path: finalPath,
      })).toString('base64')}`,
    });
    await waitForQuiescent(TEST_UID, cid);

    const mainFile = path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`);
    const rows = fs.readFileSync(mainFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const agentMsg = rows.find((row: any) => row.from === AGENT_ID && row.text === 'produced filter ok');
    expect(agentMsg?.produced).toEqual([finalPath]);
    const handoffResult = streamProbe.dispatchResults.find((result) => result.includes('"handed_off_to"'));
    expect(handoffResult).toContain(AGENT_ID);
    expect(handoffResult).not.toContain('<worker-result');
    expect(rows.filter((row: any) => row.from === 'commander' && !row.dispatch)).toHaveLength(0);
  });

  it('gives Commander the prior Agent blocker independently of the hand-off shape used to produce it', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
    const cid = 'cid-commander-canonical-blocker';

    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: 'COMMANDER_BLOCKER_HANDOFF_TEST 请制作视频',
    });
    await waitForQuiescent(TEST_UID, cid);

    expect(streamProbe.dispatchResults).toHaveLength(1);
    expect(streamProbe.dispatchResults[0]).toContain('"handed_off_to"');
    expect(streamProbe.dispatchResults[0]).not.toContain('E_NARRATION_REPAIR_AUTHORIZATION_NOT_PERSISTED');

    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: 'COMMANDER_BLOCKER_FOLLOWUP_TEST Fix that blocker.',
    });
    await waitForQuiescent(TEST_UID, cid);

    expect(streamProbe.dispatchResults).toHaveLength(1);
    const followupIndex = streamProbe.messages.findIndex((message) =>
      message.includes('COMMANDER_BLOCKER_FOLLOWUP_TEST'));
    expect(followupIndex).toBeGreaterThanOrEqual(0);
    const history = JSON.stringify(streamProbe.conversationHistories[followupIndex]);
    expect(history).toContain(AGENT_NAME);
    expect(history).toContain('E_NARRATION_REPAIR_AUTHORIZATION_NOT_PERSISTED');
    expect(history).toContain('COMMANDER_BLOCKER_HANDOFF_TEST');
    expect(history).not.toContain('COMMANDER_BLOCKER_FOLLOWUP_TEST');
    expect(JSON.stringify(streamProbe.conversationHistories[followupIndex].messages
      .filter((message: any) => message.role === 'assistant')))
      .not.toContain('E_NARRATION_REPAIR_AUTHORIZATION_NOT_PERSISTED');

    const mainFile = path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`);
    const rows = fs.readFileSync(mainFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(rows.some((row: any) => row.from === AGENT_ID
      && String(row.text || '').includes('E_NARRATION_REPAIR_AUTHORIZATION_NOT_PERSISTED'))).toBe(true);
    expect(rows.findLast((row: any) => row.from === 'commander' && !row.dispatch)?.text)
      .toBe('recognized the exact blocker from canonical history and chose the recovery independently of the prior dispatch shape');
  });

  it('gives Commander the same recovery context after the user addressed the Agent directly', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const cid = 'cid-commander-direct-agent-blocker';

    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `@${AGENT_NAME} AGENT_BLOCKER_RESULT_TEST 请完成原任务`,
    });
    await waitForQuiescent(TEST_UID, cid);

    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: '@commander COMMANDER_BLOCKER_FOLLOWUP_TEST 现在由你解决并继续原任务',
    });
    await waitForQuiescent(TEST_UID, cid);

    const followupIndex = streamProbe.messages.findIndex((message) =>
      message.includes('COMMANDER_BLOCKER_FOLLOWUP_TEST'));
    expect(followupIndex).toBeGreaterThanOrEqual(0);
    const history = JSON.stringify(streamProbe.conversationHistories[followupIndex]);
    expect(history).toContain(AGENT_NAME);
    expect(history).toContain('E_NARRATION_REPAIR_AUTHORIZATION_NOT_PERSISTED');
    expect(history).toContain('AGENT_BLOCKER_RESULT_TEST');
    expect(streamProbe.dispatchResults).toHaveLength(0);
  });

  it('uses the persisted Commander checkpoint to read and replace only the new history tail', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
    const state = await import('../../../../src/main/features/group_chat/state');
    const sessions = await import('../../../../src/main/model/core-agent/session-store');
    const cid = 'cid-commander-incremental-history';

    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: 'first incremental-history turn',
    });
    await waitForQuiescent(TEST_UID, cid);

    const firstIndex = streamProbe.messages.findIndex((message) =>
      message.includes('first incremental-history turn'));
    const firstHistory = streamProbe.conversationHistories[firstIndex];
    expect(firstHistory?.replaceFromTurnId).toBeUndefined();
    expect(firstHistory?.checkpoint).toEqual(expect.any(String));

    const session = await sessions.getSessionForUser(
      TEST_UID,
      state.buildGconvSessionId(cid),
    );
    session.replaceConversationHistory(
      firstHistory.messages,
      firstHistory.source,
      { checkpoint: firstHistory.checkpoint },
    );
    session.beginUserTurn([{ type: 'text', text: 'first incremental-history turn' }]);
    session.addAssistantMessage([{ type: 'text', text: '(no reply)' }]);
    session.completeActiveTurn();
    await state.ensureAgentMember(TEST_UID, cid, AGENT_ID, AGENT_NAME);

    const mainFile = path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`);
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: 'second incremental-history turn',
    });
    await waitForQuiescent(TEST_UID, cid);

    const secondIndex = streamProbe.messages.findIndex((message) =>
      message.includes('second incremental-history turn'));
    const secondHistory = streamProbe.conversationHistories[secondIndex];
    expect(secondHistory?.replaceFromTurnId).toBe(1);
    expect(JSON.stringify(secondHistory?.messages)).toContain('first incremental-history turn');
    expect(JSON.stringify(secondHistory?.messages)).not.toContain('second incremental-history turn');

    const replacement = `${mainFile}.replacement`;
    fs.writeFileSync(replacement, fs.readFileSync(mainFile));
    fs.renameSync(replacement, mainFile);
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: 'third history turn after canonical replacement',
    });
    await waitForQuiescent(TEST_UID, cid);

    const thirdIndex = streamProbe.messages.findIndex((message) =>
      message.includes('third history turn after canonical replacement'));
    const thirdHistory = streamProbe.conversationHistories[thirdIndex];
    expect(thirdHistory?.replaceFromTurnId).toBeUndefined();
    expect(JSON.stringify(thirdHistory?.messages)).toContain('first incremental-history turn');
    expect(JSON.stringify(thirdHistory?.messages)).toContain('second incremental-history turn');
  });

  // `isQuiescent` reflects the in-memory queue/running state — exercised
  // implicitly by every bus-integration `waitForQuiescent` call. A
  // standalone tautological test (newly-empty bus is quiescent) wasn't
  // catching anything, so it was dropped.

  it('marks top-level Commander and CoreAgent turns as steerable', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const cases = [
      { cid: 'cid-steerable-commander', forceTo: undefined, actor: 'commander' },
      { cid: 'cid-steerable-agent', forceTo: [AGENT_ID], actor: AGENT_ID },
    ];
    for (const testCase of cases) {
      cidsToDrop.add(testCase.cid);
      await bus.enqueue({
        uid: TEST_UID,
        cid: testCase.cid,
        fromActorId: 'user',
        text: 'ACTIVE_TURN_TEST',
        ...(testCase.forceTo ? { forceTo: testCase.forceTo } : {}),
      });
      const deadline = Date.now() + 2_000;
      while (!streamGate.releaseActiveTurn && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(streamGate.releaseActiveTurn).toBeTypeOf('function');
      expect(bus.runtimeSnapshot(TEST_UID, testCase.cid).activeTurns).toEqual([
        expect.objectContaining({ actor: testCase.actor, steerable: true }),
      ]);
      streamGate.releaseActiveTurn?.();
      streamGate.releaseActiveTurn = null;
      await waitForQuiescent(TEST_UID, testCase.cid);
    }
  });

  it('keeps native async questions and their answers separate from the terminal reply without queueing another run', async () => {
    const paths = await import('../../../../src/main/paths');
    const agentFile = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
    const spec = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
    spec.runtime = { kind: 'cli', cli: 'codex' };
    fs.writeFileSync(agentFile, JSON.stringify(spec));
    cliRunMock.nextResult = { runId: 'question-run', status: 'completed', output: 'Finished inspecting.' };
    cliRunMock.activeIngress = { submit: vi.fn(async () => ({ mode: 'steered' })) };
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const cid = 'cid-cli-async-question';
    const { subscribeTaskInterventions } = await import('../../../../src/main/util/task-intervention-events');
    const attention = vi.fn();
    const stopAttention = subscribeTaskInterventions(attention);
    cidsToDrop.add(cid);
    const events: any[] = [];
    const unsub = bus.subscribe(TEST_UID, cid, event => events.push(event));
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'Inspect this project.', forceTo: [AGENT_ID] });
    await vi.waitFor(() => expect(cliRunMock.calls).toHaveLength(1));
    cliRunMock.calls[0].onEvent({ type: 'async-message', itemId: 'native-question', text: 'Which scope?', questions: [{ title: 'Which scope?', options: ['Current', 'All'] }] });
    await vi.waitFor(() => expect(events.some(event => event.msg?.cli_question)).toBe(true));
    const questionEvent = events.find(event => event.msg?.cli_question);
    expect(questionEvent.turn_end).toBe(false);
    expect(questionEvent.msg.cli_question).not.toHaveProperty('expires_at_ms');
    expect(bus.runtimeSnapshot(TEST_UID, cid).activeTurns).toHaveLength(1);
    const questionId = questionEvent.msg.id;
    expect(attention).toHaveBeenCalledExactlyOnceWith({
      attention_id: `cli-question:${questionId}`, user_id: TEST_UID,
      conversation_id: cid, kind: 'interactive_cli_input',
    });
    const [first, second] = await Promise.all([
      bus.submitCliAsyncInput(TEST_UID, cid, questionId, ['Current']),
      bus.submitCliAsyncInput(TEST_UID, cid, questionId, ['Current']),
    ]);
    expect(first.ok).toBe(true);
    expect(second).toEqual(first);
    expect(cliRunMock.activeIngress.submit).toHaveBeenCalledOnce();
    expect(cliRunMock.activeIngress.submit.mock.calls[0][0].text).toBe('Which scope?\nCurrent');
    cliRunMock.releaseActiveIngressRun?.();
    cliRunMock.releaseActiveIngressRun = null;
    await waitForQuiescent(TEST_UID, cid);
    const rows = fs.readFileSync(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    expect(rows.map(row => row.text)).toEqual(['Inspect this project.', 'Which scope?', 'Which scope?\nCurrent', 'Finished inspecting.']);
    expect(rows[2].cli_answer).toEqual({ message_id: questionId, answers: ['Current'] });
    expect(rows[1].cli_question).not.toHaveProperty('expires_at_ms');
    expect(await bus.submitCliAsyncInput(TEST_UID, cid, questionId, ['Current'])).toEqual(first);
    expect(cliRunMock.calls).toHaveLength(1);
    expect(attention).toHaveBeenCalledOnce();
    stopAttention();
    unsub();
  });

  it('uses explicit control without analytics attribution to steer the same native CLI run', async () => {
    const paths = await import('../../../../src/main/paths');
    const agentFile = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
    const spec = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
    spec.runtime = { kind: 'cli', cli: 'codex' };
    spec.interactive = true;
    fs.writeFileSync(agentFile, JSON.stringify(spec));

    cliRunMock.nextResult = {
      runId: 'native-cli-steer-run',
      status: 'completed',
      output: 'Applied both instructions in one native run.',
    };
    cliRunMock.activeIngress = {
      submit: vi.fn(async (input: any) => {
        cliRunMock.submittedSteers.push(input);
        return { mode: 'steered', acceptedId: input.id };
      }),
    };

    const bus = await import('../../../../src/main/features/group_chat/bus');
    const cid = 'cid-cli-native-active-steer';
    cidsToDrop.add(cid);
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: 'CLI_NATIVE_ACTIVE_TURN',
      forceTo: [AGENT_ID],
    });

    await vi.waitFor(() => {
      expect(bus.runtimeSnapshot(TEST_UID, cid).activeTurns).toEqual([
        expect.objectContaining({ actor: AGENT_ID, steerable: true }),
      ]);
    });

    const groupChat = await import('../../../../src/main/features/group_chat');
    const steerResult = await groupChat.send({
      userId: TEST_UID,
      cid,
      text: `@${AGENT_NAME} CLI_NATIVE_STEER_UPDATE`,
      steerActiveTurn: true,
    });
    expect(steerResult.ok).toBe(true);
    await vi.waitFor(() => expect(cliRunMock.submittedSteers).toHaveLength(1));
    expect(cliRunMock.submittedSteers[0].text).toContain('CLI_NATIVE_STEER_UPDATE');

    cliRunMock.releaseActiveIngressRun?.();
    cliRunMock.releaseActiveIngressRun = null;
    await waitForQuiescent(TEST_UID, cid);

    expect(cliRunMock.calls).toHaveLength(1);
    expect(bus.runtimeSnapshot(TEST_UID, cid).activeTurns).toEqual([]);
  });

  it('promotes an existing backend queue task into the matching native CLI turn', async () => {
    const paths = await import('../../../../src/main/paths');
    const agentFile = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
    const spec = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
    spec.runtime = { kind: 'cli', cli: 'codex' };
    spec.interactive = true;
    fs.writeFileSync(agentFile, JSON.stringify(spec));

    cliRunMock.nextResult = {
      runId: 'native-cli-promoted-queue-run',
      status: 'completed',
      output: 'Applied the queued update in the active run.',
    };
    cliRunMock.activeIngress = {
      submit: vi.fn(async (input: any) => {
        cliRunMock.submittedSteers.push(input);
        return { mode: 'steered', acceptedId: input.id };
      }),
    };

    const bus = await import('../../../../src/main/features/group_chat/bus');
    const taskBoard = await import('../../../../src/main/features/group_chat/task_board');
    const cid = 'cid-cli-promote-board-queue';
    cidsToDrop.add(cid);
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: 'CLI_PROMOTE_ACTIVE_TURN',
      forceTo: [AGENT_ID],
    });
    await vi.waitFor(() => {
      expect(bus.runtimeSnapshot(TEST_UID, cid).activeTurns).toEqual([
        expect.objectContaining({ actor: AGENT_ID, steerable: true }),
      ]);
    });

    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: 'CLI_PROMOTE_QUEUED_UPDATE',
      forceTo: [AGENT_ID],
    });
    const queued = (await taskBoard.listTasks(TEST_UID, cid))
      .find((task) => task.status === 'queued');
    expect(queued).toBeTruthy();

    const promoted = await bus.sendConversationTaskNow(TEST_UID, cid, queued!.task_id);
    expect(promoted).toMatchObject({ ok: true });
    await vi.waitFor(() => expect(cliRunMock.submittedSteers).toHaveLength(1));
    expect(cliRunMock.submittedSteers[0].text).toContain('CLI_PROMOTE_QUEUED_UPDATE');

    const absorbedRunning = (await taskBoard.listTasks(TEST_UID, cid))
      .find((task) => task.task_id === queued!.task_id);
    expect(absorbedRunning).toMatchObject({
      status: 'running',
      absorbed_into_turn_id: promoted.turn_id,
    });

    cliRunMock.releaseActiveIngressRun?.();
    cliRunMock.releaseActiveIngressRun = null;
    await waitForQuiescent(TEST_UID, cid);

    const rows = await taskBoard.listTasks(TEST_UID, cid);
    expect(cliRunMock.calls).toHaveLength(1);
    expect(rows).toHaveLength(2);
    expect(rows.every((task) => task.status === 'done')).toBe(true);
    expect(rows[0].result_msg_id).toBeTruthy();
    expect(rows[1].result_msg_id).toBe(rows[0].result_msg_id);
  });

  it('keeps an explicitly non-steering CLI message in FIFO despite Send now attribution', async () => {
    const paths = await import('../../../../src/main/paths');
    const agentFile = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
    const spec = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
    spec.runtime = { kind: 'cli', cli: 'claude' };
    spec.interactive = true;
    fs.writeFileSync(agentFile, JSON.stringify(spec));

    cliRunMock.nextResult = {
      runId: 'continuous-background-turn',
      status: 'completed',
      output: 'Background work and its resumed answer finished.',
    };
    cliRunMock.activeIngress = {
      submit: vi.fn(async (input: any) => {
        cliRunMock.submittedSteers.push(input);
        return { mode: 'steered', acceptedId: input.id };
      }),
    };

    const bus = await import('../../../../src/main/features/group_chat/bus');
    const cid = 'cid-cli-background-default-fifo';
    cidsToDrop.add(cid);
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: 'FIRST_LONG_BACKGROUND_TASK',
      forceTo: [AGENT_ID],
    });
    await vi.waitFor(() => expect(cliRunMock.releaseActiveIngressRun).toBeTypeOf('function'));

    const groupChat = await import('../../../../src/main/features/group_chat');
    const queuedResult = await groupChat.send({
      userId: TEST_UID,
      cid,
      text: `@${AGENT_NAME} SECOND_MESSAGE_MUST_WAIT`,
      entry_point: 'queue_send_now',
      steerActiveTurn: false,
    });
    expect(queuedResult.ok).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(cliRunMock.submittedSteers).toHaveLength(0);
    expect(cliRunMock.calls).toHaveLength(1);

    cliRunMock.activeIngress = null;
    cliRunMock.releaseActiveIngressRun?.();
    cliRunMock.releaseActiveIngressRun = null;
    await waitForQuiescent(TEST_UID, cid);

    expect(cliRunMock.calls).toHaveLength(2);
    expect(cliRunMock.calls[1].prompt).toContain('SECOND_MESSAGE_MUST_WAIT');
  });

  it('dropConv terminates the worker so it doesn\'t leak after conv delete', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    bus.subscribe(TEST_UID, TEST_CID, () => {});
    await bus.enqueue({
      uid: TEST_UID, cid: TEST_CID, fromActorId: 'user', text: 'hello',
    });
    const stateBefore = bus._cidStateForTest(TEST_UID, TEST_CID);
    expect(stateBefore).toBeTruthy();

    await bus.dropConv(TEST_UID, TEST_CID);
    const stateAfter = bus._cidStateForTest(TEST_UID, TEST_CID);
    expect(stateAfter).toBeNull();
    // Worker.terminated flag was set; the loop's `while (!w.terminated)`
    // now exits at the next wake. We can't observe the loop exit
    // directly, but isQuiescent reports true (since cid state is gone).
    expect(bus.isQuiescent(TEST_UID, TEST_CID)).toBe(true);
  });

  it('dropConv rejects late enqueue admission while an active worker unwinds', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    await bus.enqueue({
      uid: TEST_UID,
      cid: TEST_CID,
      fromActorId: 'user',
      text: 'ACTIVE_TURN_TEST',
    });
    const deadline = Date.now() + 2_000;
    while (!streamGate.releaseActiveTurn && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    expect(streamGate.releaseActiveTurn).toBeTypeOf('function');

    const dropping = bus.dropConv(TEST_UID, TEST_CID);
    await expect(bus.enqueue({
      uid: TEST_UID,
      cid: TEST_CID,
      fromActorId: 'user',
      text: 'must not resurrect deleted runtime',
    })).rejects.toMatchObject({ code: 'E_CONVERSATION_TERMINATING' });

    streamGate.releaseActiveTurn?.();
    await dropping;
    expect(bus._cidStateForTest(TEST_UID, TEST_CID)).toBeNull();
  });

  it('dropConv drains an enqueue already admitted before terminating workers', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    let enterGate!: () => void;
    let releaseGate!: () => void;
    const entered = new Promise<void>((resolve) => { enterGate = resolve; });
    const released = new Promise<void>((resolve) => { releaseGate = resolve; });
    bus._setEnqueueAdmissionGateForTest(async () => {
      enterGate();
      await released;
    });

    try {
      const enqueuing = bus.enqueue({
        uid: TEST_UID,
        cid: TEST_CID,
        fromActorId: 'user',
        text: 'admitted before deletion',
      });
      await entered;
      let dropResolved = false;
      const dropping = bus.dropConv(TEST_UID, TEST_CID).then(() => { dropResolved = true; });
      await Promise.resolve();
      expect(dropResolved).toBe(false);

      releaseGate();
      await enqueuing;
      await dropping;
      expect(bus._cidStateForTest(TEST_UID, TEST_CID)).toBeNull();
    } finally {
      bus._setEnqueueAdmissionGateForTest(null);
      releaseGate?.();
    }
  });

  it('does not inject handback into an in-loop external CLI dispatch that does not own the floor', async () => {
    const paths = await import('../../../../src/main/paths');
    const agentFile = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
    const spec = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
    spec.runtime = { kind: 'cli', cli: 'codex' };
    spec.interactive = true;
    fs.writeFileSync(agentFile, JSON.stringify(spec));
    cliRunMock.nextResult = {
      runId: 'direct-cli-run',
      status: 'completed',
      output: 'I will handle this directly.',
    };

    const bus = await import('../../../../src/main/features/group_chat/bus');
    const cid = 'cid-cli-direct-no-capability-handback';
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `NESTED_OUTPUT_VISIBILITY_TEST:${Buffer.from(JSON.stringify({
        tool: 'dispatch_to',
        path: path.join(tmpDir, 'unused.txt'),
      })).toString('base64')}`,
    });
    await waitForQuiescent(TEST_UID, cid);

    expect(cliRunMock.calls).toHaveLength(1);
    expect(cliRunMock.calls[0].prompt).not.toContain('primary outcome exceeds');
    expect(cliRunMock.calls[0].prompt).not.toContain('<handback');
  });

  it('relays content-free CLI activity live without persisting heartbeat spam', async () => {
    const paths = await import('../../../../src/main/paths');
    const agentFile = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
    const spec = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
    spec.runtime = { kind: 'cli', cli: 'codex' };
    spec.interactive = true;
    fs.writeFileSync(agentFile, JSON.stringify(spec));

    const privateThought = 'PRIVATE_CLI_THOUGHT_MUST_NOT_CROSS_BUS';
    const publicSummary = 'Reviewing the current implementation';
    cliRunMock.nextEvents.push(
      { type: 'thinking', chars: 17, summary: publicSummary, itemId: 'reasoning-1', text: privateThought },
      { type: 'thinking', chars: 17, summary: publicSummary, itemId: 'reasoning-1', heartbeat: true, text: privateThought },
      {
        type: 'status',
        status: 'tool-progress',
        tool: 'exec_command',
        callId: 'exec-1',
        heartbeat: true,
      },
    );
    cliRunMock.nextResult = {
      runId: 'cli-activity-heartbeat',
      status: 'completed',
      output: 'Activity test complete.',
    };

    const cid = 'cid-cli-activity-heartbeat';
    const events: any[] = [];
    const bus = await import('../../../../src/main/features/group_chat/bus');
    bus.subscribe(TEST_UID, cid, event => events.push(event));
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `@${AGENT_NAME} run the activity test`,
    });
    await waitForQuiescent(TEST_UID, cid);

    const liveCliEvents = events
      .filter(event => event.type === 'process' && event.data?.type === 'event')
      .map(event => event.data?.event)
      .filter(event => event?.stream === 'cli');
    expect(liveCliEvents).toEqual(expect.arrayContaining([
      {
        stream: 'cli',
        data: { type: 'thinking', chars: 17, summary: publicSummary, itemId: 'reasoning-1' },
      },
      {
        stream: 'cli',
        data: { type: 'thinking', chars: 17, summary: publicSummary, itemId: 'reasoning-1', heartbeat: true },
      },
      {
        stream: 'cli',
        data: {
          type: 'status',
          status: 'tool-progress',
          tool: 'exec_command',
          callId: 'exec-1',
          heartbeat: true,
        },
      },
    ]));
    expect(JSON.stringify(liveCliEvents)).not.toContain(privateThought);

    const rows = fs.readFileSync(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line));
    const reply = rows.find(row => row.from === AGENT_ID);
    const persistedCliEvents = (reply?.process || [])
      .filter((item: any) => item?.type === 'event' && item?.event?.stream === 'cli')
      .map((item: any) => item.event);
    expect(persistedCliEvents).toContainEqual({
      stream: 'cli',
      data: { type: 'thinking', chars: 17, summary: publicSummary, itemId: 'reasoning-1' },
    });
    expect(persistedCliEvents.some((event: any) => event.data?.heartbeat === true)).toBe(false);
    expect(JSON.stringify(reply)).not.toContain(privateThought);
  });

  it('keeps runner idle ticks on the live wire and persists the background-task status once', async () => {
    // A run held open by a background task emits an idle tick every 30 s until
    // the idle-kill window; persisting each one grew the synced conversation by
    // ~2 rows per stalled minute while the renderer showed a single wait row.
    const paths = await import('../../../../src/main/paths');
    const agentFile = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
    const spec = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
    spec.runtime = { kind: 'cli', cli: 'claude' };
    spec.interactive = true;
    fs.writeFileSync(agentFile, JSON.stringify(spec));

    const waitingOn = [{ taskId: 'bz0apow42', label: 'Start Web dev server on :9000' }];
    cliRunMock.nextEvents.push(
      {
        type: 'status', status: 'background-started',
        taskId: 'bz0apow42', taskType: 'local_bash', message: 'Start Web dev server on :9000',
      },
      { type: 'idle', stalledMs: 95_000, waitingOn },
      { type: 'idle', stalledMs: 125_000, waitingOn },
      { type: 'status', status: 'background-stopped', taskId: 'bz0apow42' },
    );
    cliRunMock.nextResult = {
      runId: 'cli-idle-ticks',
      status: 'completed',
      output: 'Dev server is running.',
    };

    const cid = 'cid-cli-idle-ticks';
    const events: any[] = [];
    const bus = await import('../../../../src/main/features/group_chat/bus');
    bus.subscribe(TEST_UID, cid, event => events.push(event));
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `@${AGENT_NAME} start the dev server`,
    });
    await waitForQuiescent(TEST_UID, cid);

    const liveCliEvents = events
      .filter(event => event.type === 'process' && event.data?.type === 'event')
      .map(event => event.data?.event)
      .filter(event => event?.stream === 'cli');
    // The live rail still receives every tick, with the task it is waiting on.
    expect(liveCliEvents.filter(event => event.data?.type === 'idle')).toEqual([
      { stream: 'cli', data: { type: 'idle', stalledMs: 95_000, waitingOn } },
      { stream: 'cli', data: { type: 'idle', stalledMs: 125_000, waitingOn } },
    ]);

    const rows = fs.readFileSync(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line));
    const reply = rows.find(row => row.from === AGENT_ID);
    const persistedCliEvents = (reply?.process || [])
      .filter((item: any) => item?.type === 'event' && item?.event?.stream === 'cli')
      .map((item: any) => item.event.data);
    expect(persistedCliEvents.filter((data: any) => data?.type === 'idle')).toHaveLength(0);
    expect(persistedCliEvents.filter((data: any) => data?.status === 'background-started')).toEqual([{
      type: 'status', status: 'background-started',
      taskId: 'bz0apow42', taskType: 'local_bash', message: 'Start Web dev server on :9000',
    }]);
  });

  it('persists every non-ephemeral CLI process event without a per-turn item limit', async () => {
    const paths = await import('../../../../src/main/paths');
    const agentFile = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
    const spec = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
    spec.runtime = { kind: 'cli', cli: 'codex' };
    spec.interactive = true;
    fs.writeFileSync(agentFile, JSON.stringify(spec));

    const processEventCount = 350;
    cliRunMock.nextEvents.push(...Array.from({ length: processEventCount }, (_, index) => ({
      type: 'thinking',
      chars: index + 1,
      summary: `Persisted process step ${index}`,
      itemId: `reasoning-${index}`,
    })));
    cliRunMock.nextResult = {
      runId: 'cli-unbounded-process-history',
      status: 'completed',
      output: 'All process history persisted.',
    };

    const cid = 'cid-cli-unbounded-process-history';
    const bus = await import('../../../../src/main/features/group_chat/bus');
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `@${AGENT_NAME} retain the complete process history`,
    });
    await waitForQuiescent(TEST_UID, cid);

    const rows = fs.readFileSync(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`), 'utf8')
      .trim().split('\n').map(line => JSON.parse(line));
    const reply = rows.find(row => row.from === AGENT_ID);
    const persistedThinking = (reply?.process || [])
      .filter((item: any) => item?.type === 'event'
        && item?.event?.stream === 'cli'
        && item?.event?.data?.type === 'thinking');

    expect(persistedThinking).toHaveLength(processEventCount);
    expect(persistedThinking[0]?.event?.data?.itemId).toBe('reasoning-0');
    expect(persistedThinking.at(-1)?.event?.data?.itemId).toBe(`reasoning-${processEventCount - 1}`);
    expect(reply?.process?.at(-1)).toMatchObject({
      type: 'event',
      event: {
        stream: 'runtime',
        data: { duration_ms: expect.any(Number) },
      },
    });
  });

  it('keeps a user-selected external CLI as the sticky recipient after completed replies', async () => {
    const paths = await import('../../../../src/main/paths');
    const agentFile = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
    const spec = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
    spec.runtime = { kind: 'cli', cli: 'codex' };
    spec.interactive = true;
    fs.writeFileSync(agentFile, JSON.stringify(spec));
    cliRunMock.nextResult = {
      runId: 'user-selected-cli-first',
      status: 'completed',
      output: 'The first requested change is complete.\n<handback />',
    };

    const bus = await import('../../../../src/main/features/group_chat/bus');
    const state = await import('../../../../src/main/features/group_chat/state');
    const cid = 'cid-cli-user-selected-sticky';
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `@${AGENT_NAME} make the requested change`,
    });
    await waitForQuiescent(TEST_UID, cid);

    expect(cliRunMock.calls).toHaveLength(1);
    expect(cliRunMock.calls[0].prompt).not.toContain('## Return control to commander');
    let floor = await state.readState(TEST_UID, cid);
    expect(floor.active_recipient).toBe(AGENT_ID);
    expect(floor.active_recipient_source).toBe('user_selection');

    cliRunMock.nextResult = {
      runId: 'user-selected-cli-follow-up',
      status: 'completed',
      output: 'The follow-up is complete too.\n<handback />',
    };
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: 'also update the adjacent test',
    });
    await waitForQuiescent(TEST_UID, cid);

    expect(cliRunMock.calls).toHaveLength(2);
    expect(cliRunMock.calls[1].prompt).not.toContain('## Return control to commander');
    floor = await state.readState(TEST_UID, cid);
    expect(floor.active_recipient).toBe(AGENT_ID);
    expect(floor.active_recipient_source).toBe('user_selection');
    const rows = fs.readFileSync(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line));
    expect(rows.filter((row: any) => row.from === AGENT_ID)).toHaveLength(2);
    expect(rows.some((row: any) => String(row.text || '').includes('<handback />'))).toBe(false);
  });

  it('routes a CLI bridge transfer through the ordinary Agent handback path exactly once', async () => {
    const paths = await import('../../../../src/main/paths');
    const agentFile = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
    const spec = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
    spec.runtime = { kind: 'cli', cli: 'codex' };
    spec.interactive = true;
    fs.writeFileSync(agentFile, JSON.stringify(spec));
    cliRunMock.nextResult = {
      runId: 'cli-commander-automation-handoff',
      status: 'completed',
      output: 'This Orkas automation mutation requires the Commander.',
      commanderHandoff: {
        reason: 'CLI_COMMANDER_AUTOMATION_HANDOFF_TEST: automation CRUD is Commander-only.',
        context: 'Create a daily 08:00 benchmark run that repairs safe failures and reports confirmation gates.',
      },
    };

    const bus = await import('../../../../src/main/features/group_chat/bus');
    const state = await import('../../../../src/main/features/group_chat/state');
    const autoTasks = await import('../../../../src/main/features/auto_tasks');
    const cid = 'cid-cli-commander-automation-handoff';
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `@${AGENT_NAME} create the daily benchmark automation`,
    });
    await waitForQuiescent(TEST_UID, cid);

    expect(cliRunMock.calls).toHaveLength(1);
    expect(cliRunMock.calls[0]).not.toHaveProperty('enabledConnectorIds');
    const commanderInput = streamProbe.messages.find((message) => (
      message.includes('CLI_COMMANDER_AUTOMATION_HANDOFF_TEST')
    ));
    expect(commanderInput).toContain('create the daily benchmark automation');
    expect(commanderInput).toContain('daily 08:00 benchmark run');
    expect(commanderInput).toContain('<agent-handback>');
    expect(commanderInput).toContain('"reason": "capability_boundary"');
    expect(commanderInput).not.toContain('explicit_cli_transfer');

    const tasks = await autoTasks.listTasks(TEST_UID);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      title: 'Daily benchmark repair',
      schedule: { type: 'daily', hour: 8, minute: 0 },
    });
    // The user picked this agent with an explicit `@` mention, so the capability
    // handback buys the commander THIS turn only — the microphone stays with
    // the agent and the user's next mention-less message returns to it.
    const handbackFloor = await state.readState(TEST_UID, cid);
    expect(handbackFloor.active_recipient).toBe(AGENT_ID);
    expect(handbackFloor.active_recipient_source).toBe('user_selection');

    const rows = fs.readFileSync(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line));
    expect(rows.filter((row: any) => row.from === 'commander'
      && String(row.text || '').includes('Automation created'))).toHaveLength(1);
    expect(rows.some((row: any) => String(row.text || '').includes('<auto-task>'))).toBe(false);
  });

  it('lends the commander one turn on a capability handback and routes the next message back to the user-picked agent', async () => {
    const paths = await import('../../../../src/main/paths');
    const agentFile = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
    const spec = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
    spec.runtime = { kind: 'cli', cli: 'codex' };
    spec.interactive = true;
    fs.writeFileSync(agentFile, JSON.stringify(spec));
    cliRunMock.nextResult = {
      runId: 'user-floor-capability-handback',
      status: 'completed',
      output: 'This Orkas automation mutation requires the Commander.',
      commanderHandoff: {
        reason: 'CLI_USER_FLOOR_HANDBACK_TEST: automation CRUD is Commander-only.',
      },
    };

    const bus = await import('../../../../src/main/features/group_chat/bus');
    const state = await import('../../../../src/main/features/group_chat/state');
    const cid = 'cid-user-floor-survives-handback';
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `@${AGENT_NAME} create the daily benchmark automation`,
    });
    await waitForQuiescent(TEST_UID, cid);

    // The commander was woken for this hop...
    expect(streamProbe.messages.some((message) => (
      message.includes('CLI_USER_FLOOR_HANDBACK_TEST')
    ))).toBe(true);
    // ...without taking the microphone the user handed to the agent.
    const afterHandback = await state.readState(TEST_UID, cid);
    expect(afterHandback.active_recipient).toBe(AGENT_ID);
    expect(afterHandback.active_recipient_source).toBe('user_selection');

    // The next message carries NO mention, so it routes purely by the floor.
    cliRunMock.nextResult = {
      runId: 'user-floor-follow-up',
      status: 'completed',
      output: 'Picking the work back up.',
    };
    const followUp = await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: 'keep going',
    });
    await waitForQuiescent(TEST_UID, cid);

    expect(followUp.to).toEqual([AGENT_ID]);
    const rows = fs.readFileSync(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line));
    const followUpRow = rows.find((row: any) => row.text === 'keep going');
    expect(followUpRow?.to).toEqual([AGENT_ID]);
  });

  it('does not wake Commander from a handoff request attached to a failed CLI run', async () => {
    const paths = await import('../../../../src/main/paths');
    const agentFile = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
    const spec = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
    spec.runtime = { kind: 'cli', cli: 'codex' };
    spec.interactive = true;
    fs.writeFileSync(agentFile, JSON.stringify(spec));
    cliRunMock.nextResult = {
      runId: 'failed-cli-handoff',
      status: 'failed',
      output: 'Partial, unverified work.',
      error: 'backend failed after requesting transfer',
      commanderHandoff: {
        reason: 'CLI_COMMANDER_AUTOMATION_HANDOFF_TEST: should not execute.',
      },
    };

    const bus = await import('../../../../src/main/features/group_chat/bus');
    const state = await import('../../../../src/main/features/group_chat/state');
    const autoTasks = await import('../../../../src/main/features/auto_tasks');
    const cid = 'cid-failed-cli-commander-handoff';
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `@${AGENT_NAME} create an automation`,
    });
    await waitForQuiescent(TEST_UID, cid);

    expect(streamProbe.messages).toEqual([]);
    expect(await autoTasks.listTasks(TEST_UID)).toEqual([]);
    expect((await state.readState(TEST_UID, cid)).active_recipient).toBe(AGENT_ID);
  });

  it('uses the ordinary Agent ledger resume for a Commander-routed CLI bridge transfer', async () => {
    const paths = await import('../../../../src/main/paths');
    const agentFile = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
    const spec = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
    spec.runtime = { kind: 'cli', cli: 'codex' };
    spec.interactive = true;
    fs.writeFileSync(agentFile, JSON.stringify(spec));
    cliRunMock.nextResult = {
      runId: 'ledger-cli-bridge-handoff',
      status: 'completed',
      output: 'The next step requires Commander-owned automation.',
      commanderHandoff: {
        reason: 'CLI_LEDGER_HANDOFF_TEST: automation CRUD is Commander-only.',
        context: 'Resume the broader workflow after creating the scheduled task.',
      },
    };

    const bus = await import('../../../../src/main/features/group_chat/bus');
    const state = await import('../../../../src/main/features/group_chat/state');
    const cid = 'cid-cli-ledger-shared-handback';
    const triggerMessage = await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: 'COMMANDER_CLI_LEDGER_ROUTE_TEST',
    });
    await waitForQuiescent(TEST_UID, cid);

    expect(cliRunMock.calls).toHaveLength(1);
    const cliWireContext = `${cliRunMock.calls[0].systemPrompt || ''}\n${cliRunMock.calls[0].prompt || ''}`;
    expect(cliWireContext).toContain('COMMANDER_CLI_LEDGER_ROUTE_TEST');
    expect(cliWireContext).toContain('CLI_LEDGER_TASK_TEST');
    expect(cliRunMock.calls[0].prompt).not.toContain('<referenced-messages>');
    expect(cliWireContext.match(/COMMANDER_CLI_LEDGER_ROUTE_TEST/g)).toHaveLength(1);
    const resumeInput = streamProbe.messages.find((message) => (
      message.includes('CLI_LEDGER_HANDOFF_TEST')
    ));
    expect(resumeInput).toContain('<orchestration-resume>');
    expect(resumeInput).toContain('Continue the broader Commander workflow.');
    expect(resumeInput).not.toContain('<agent-handback>');
    const floor = await state.readState(TEST_UID, cid);
    expect(floor.orchestration_ledger).toBeUndefined();
    expect(floor.active_recipient).toBeUndefined();

    const rows = fs.readFileSync(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line));
    expect(rows.some((row: any) => row.from === AGENT_ID
      && row.dispatch
      && String(row.model_text || '').includes('<agent-handback>'))).toBe(false);
    const hiddenDispatch = rows.find((row: any) => (
      row.from === 'commander'
      && row.dispatch === true
      && row.text === 'CLI_LEDGER_TASK_TEST'
    ));
    expect(hiddenDispatch?.source_message_id).toBe(triggerMessage.id);
    expect(hiddenDispatch?.references).toBeUndefined();
  });

  it('returns the floor silently when an interactive external CLI completes', async () => {
    const paths = await import('../../../../src/main/paths');
    const agentFile = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
    const spec = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
    spec.runtime = { kind: 'cli', cli: 'codex' };
    spec.interactive = true;
    fs.writeFileSync(agentFile, JSON.stringify(spec));
    cliRunMock.nextResult = {
      runId: 'interactive-cli-start',
      status: 'completed',
      output: 'I have the conversation. Tell me when the task is complete.',
    };

    const bus = await import('../../../../src/main/features/group_chat/bus');
    const state = await import('../../../../src/main/features/group_chat/state');
    const cid = 'cid-cli-interactive-lifecycle-handback';
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `NESTED_OUTPUT_VISIBILITY_TEST:${Buffer.from(JSON.stringify({
        tool: 'hand_off_to',
        path: path.join(tmpDir, 'unused.txt'),
      })).toString('base64')}`,
    });
    await waitForQuiescent(TEST_UID, cid);

    expect(cliRunMock.calls).toHaveLength(1);
    expect(cliRunMock.calls[0].prompt).toContain('## Return control to commander');
    expect(cliRunMock.calls[0].prompt).toContain('Use `<handback reason="completed_handoff" />` only to close this routed interaction.');
    expect(cliRunMock.calls[0].prompt).not.toContain('primary outcome exceeds');
    let floor = await state.readState(TEST_UID, cid);
    expect(floor.active_recipient).toBe(AGENT_ID);
    expect(floor.active_recipient_source).toBe('commander_handoff');
    const commanderTurnCount = streamProbe.messages.length;

    cliRunMock.nextResult = {
      runId: 'interactive-cli-complete',
      status: 'completed',
      output: 'The handed-off task is complete.\n<handback reason="completed_handoff" />',
    };
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: 'That completes it.',
    });
    await waitForQuiescent(TEST_UID, cid);

    expect(cliRunMock.calls).toHaveLength(2);
    expect(cliRunMock.calls[1].prompt).toContain('## Return control to commander');
    floor = await state.readState(TEST_UID, cid);
    expect(floor.active_recipient).toBeUndefined();
    expect(floor.active_recipient_source).toBeUndefined();
    const rows = fs.readFileSync(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line));
    const completedReply = rows.find((row: any) => row.from === AGENT_ID
      && String(row.text || '').includes('handed-off task is complete'));
    expect(completedReply?.text).toBe('The handed-off task is complete.');
    expect(rows.some((row: any) => row.from === AGENT_ID
      && row.dispatch
      && Array.isArray(row.to)
      && row.to.includes('commander'))).toBe(false);
    expect(streamProbe.messages).toHaveLength(commanderTurnCount);
    expect(streamProbe.messages.some((message) => message.includes('<agent-handback>'))).toBe(false);
  });

  it.each(['codex', 'opencode'] as const)(
    'initialises a %s coding CLI conversation cwd from the agent project-dir setting without replaying or asking again',
    async (cli) => {
      const paths = await import('../../../../src/main/paths');
      const agentFile = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
      const spec = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
      spec.runtime = { kind: 'cli', cli };
      fs.writeFileSync(agentFile, JSON.stringify(spec));

      const projectDir = path.join(tmpDir, 'repo');
      fs.mkdirSync(projectDir);
      const agents = await import('../../../../src/main/features/agents');
      await agents.setAgentCliProjectDir(TEST_UID, AGENT_ID, projectDir);

      const bus = await import('../../../../src/main/features/group_chat/bus');
      const state = await import('../../../../src/main/features/group_chat/state');
      const cid = 'cid-coding-dir';
      await bus.enqueue({
        uid: TEST_UID, cid, fromActorId: 'user',
        text: `@${AGENT_NAME} 看一下这个项目`,
      });
      await waitForQuiescent(TEST_UID, cid);

      expect(cliRunMock.calls).toHaveLength(1);
      expect(cliRunMock.calls[0].cli).toBe(cli);
      expect(cliRunMock.calls[0].cwd).toBe(projectDir);
      if (cli === 'codex') expect(cliRunMock.calls[0].prompt).toBe('看一下这个项目');
      else expect(cliRunMock.calls[0].prompt).toMatch(/看一下这个项目$/);
      expect(`${cliRunMock.calls[0].systemPrompt || ''}\n${cliRunMock.calls[0].prompt}`).toContain(
        '## Output protocol — switching project directory',
      );
      expect(`${cliRunMock.calls[0].systemPrompt || ''}\n${cliRunMock.calls[0].prompt}`)
        .toContain('<agent-input-form>');
      expect(cliRunMock.calls[0].prompt).not.toContain('## Conversation context recovered by Orkas');
      const st = await state.readState(TEST_UID, cid);
      expect(st.coding_project_dir).toBe(projectDir);
      expect(st.coding_project_dir_explicit).toBe(true);
      const mainFile = path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`);
      const rows = fs.readFileSync(mainFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(rows.some((row: any) => row.form?.fields?.some((field: any) => field.id === 'project_dir')))
        .toBe(false);
    },
  );

  it.each([
    { label: 'Project workspace when no Agent override exists', customOverride: false },
    { label: 'Agent custom directory ahead of the Project workspace', customOverride: true },
  ])('uses $label as the OpenCode project_dir without a first-turn form', async ({ customOverride }) => {
    const paths = await import('../../../../src/main/paths');
    const agentFile = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
    const spec = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
    spec.runtime = { kind: 'cli', cli: 'opencode' };
    fs.writeFileSync(agentFile, JSON.stringify(spec));

    const projects = await import('../../../../src/main/features/projects');
    const createdProject = await projects.createProject(TEST_UID, 'OpenCode default workspace');
    if (!createdProject.ok) throw new Error('project setup failed');
    const projectId = createdProject.project.project_id;
    await projects.addAgentBinding(TEST_UID, projectId, AGENT_ID);
    const projectDir = path.join(tmpDir, 'project-workspace');
    fs.mkdirSync(projectDir, { recursive: true });
    const userWorkspace = await import('../../../../src/main/features/user_workspace');
    const workspaceResult = userWorkspace.setWorkspacePath(TEST_UID, projectDir, projectId);
    expect(workspaceResult.ok).toBe(true);
    const customDir = path.join(tmpDir, 'agent-custom-workspace');
    if (customOverride) {
      fs.mkdirSync(customDir, { recursive: true });
      const agents = await import('../../../../src/main/features/agents');
      await agents.setAgentCliProjectDir(TEST_UID, AGENT_ID, customDir);
    }
    const expectedDir = customOverride ? customDir : projectDir;
    const chats = await import('../../../../src/main/features/chats');
    const cid = 'cid-opencode-project-default';
    const conversation = await chats.createConversation(TEST_UID, {
      conversationId: cid,
      projectId,
      title: 'OpenCode project task',
    });
    expect(conversation.project_id).toBe(projectId);
    expect((await chats.getConversation(TEST_UID, cid))?.project_id).toBe(projectId);
    expect(userWorkspace.getWorkspacePath(TEST_UID, projectId)).toBe(projectDir);

    cliRunMock.nextResult = {
      runId: 'opencode-project-default',
      status: 'completed',
      output: 'Project inspected.',
    };
    const groupChat = await import('../../../../src/main/features/group_chat');
    const state = await import('../../../../src/main/features/group_chat/state');
    await groupChat.send({
      userId: TEST_UID,
      cid,
      text: `@${AGENT_NAME} inspect this project`,
    });
    await waitForQuiescent(TEST_UID, cid);

    expect(cliRunMock.calls).toHaveLength(1);
    expect(cliRunMock.calls[0]).toMatchObject({
      cli: 'opencode',
      cwd: expectedDir,
      conversationTitle: 'OpenCode project task',
    });
    expect(`${cliRunMock.calls[0].systemPrompt || ''}\n${cliRunMock.calls[0].prompt}`).toContain(
      '## Output protocol — switching project directory',
    );
    const current = await state.readState(TEST_UID, cid);
    expect(current.coding_project_dir).toBe(expectedDir);
    expect(current.coding_project_dir_explicit).toBe(customOverride ? true : undefined);
    const mainFile = paths.projectChatJsonlFile(TEST_UID, projectId, cid);
    const rows = fs.readFileSync(mainFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(rows.some((row: any) => row.form?.fields?.some((field: any) => field.id === 'project_dir')))
      .toBe(false);
  });

  it('persists files and process detail from a real result-only OpenCode multi-file write event', async () => {
    const paths = await import('../../../../src/main/paths');
    const agentFile = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
    const spec = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
    spec.runtime = { kind: 'cli', cli: 'opencode' };
    fs.writeFileSync(agentFile, JSON.stringify(spec));

    const projectDir = path.join(tmpDir, 'workspace');
    const agents = await import('../../../../src/main/features/agents');
    await agents.setAgentCliProjectDir(TEST_UID, AGENT_ID, projectDir);
    const producedFile = path.join(projectDir, 'snake.html');
    const outsideFile = path.join(tmpDir, 'outside', 'customer-plan.md');
    const traversalFile = path.join(tmpDir, 'outside', 'traversal.ts');
    const misleadingInsideFile = path.join(projectDir, 'customer-plan.md');
    const misleadingTraversalFile = path.join(projectDir, 'traversal.ts');
    const nestedRelativeFiles = [
      'nested/path.ts',
      'nested/file.ts',
      'nested/file-path.ts',
      'nested/filePath.ts',
      'nested/filename.ts',
    ];
    const expectedProduced = [
      producedFile,
      ...nestedRelativeFiles.map(file => path.join(projectDir, file)),
    ];
    for (const file of expectedProduced) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, file === producedFile ? '<main>snake</main>' : 'export {};');
    }
    for (const file of [outsideFile, traversalFile, misleadingInsideFile, misleadingTraversalFile]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, 'pre-existing, not produced by this turn');
    }
    const opencode = await import('../../../../src/main/features/local_agents/backends/opencode');
    const mapped = opencode.mapOpencodeEvent({
      type: 'tool_use',
      part: {
        tool: 'write',
        callID: 'write-result-only',
        state: {
          status: 'completed',
          input: {
            filePath: 'snake.html',
            files: [
              { path: nestedRelativeFiles[0] },
              { file: nestedRelativeFiles[1] },
              { file_path: nestedRelativeFiles[2] },
              { filePath: nestedRelativeFiles[3] },
              { filename: nestedRelativeFiles[4] },
              { path: outsideFile },
              { filePath: 'nested/../../outside/traversal.ts' },
            ],
            content: '<main>private write body</main>',
          },
          output: 'created',
          time: { start: 100, end: 125 },
        },
      },
    });
    expect(mapped?.event).toMatchObject({
      type: 'tool-event',
      phase: 'result',
      tool: 'write',
      callId: 'write-result-only',
      durationMs: 25,
      output: 'created',
    });
    expect(JSON.stringify(mapped?.event)).not.toContain('private write body');
    const actualRunner = await vi.importActual<typeof import(
      '../../../../src/main/features/local_agents/runner'
    )>('../../../../src/main/features/local_agents/runner');
    const safeEvent = actualRunner.redactPrivateLocalAgentEvent(mapped!.event, projectDir);
    expect((safeEvent as any).input.files).toContainEqual({ displayPath: 'customer-plan.md' });
    expect((safeEvent as any).input.files).toContainEqual({ displayPath: 'traversal.ts' });
    cliRunMock.nextEvents.push(safeEvent);
    cliRunMock.nextResult = {
      runId: 'result-only-write',
      status: 'completed',
      output: 'Created the requested file.',
    };

    const bus = await import('../../../../src/main/features/group_chat/bus');
    const cid = 'cid-result-only-write';
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `@${AGENT_NAME} create the file`,
    });
    await waitForQuiescent(TEST_UID, cid);

    expect(cliRunMock.calls).toHaveLength(1);
    expect(cliRunMock.calls[0].cwd).toBe(projectDir);

    const mainFile = path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`);
    const rows = fs.readFileSync(mainFile, 'utf8').trim()
      .split('\n').map(line => JSON.parse(line));
    const reply = rows.find(row => row.from === AGENT_ID);
    // Delivery selection intentionally publishes only the primary HTML file;
    // every nested write still enters conversation ownership for later turns.
    expect(reply?.produced).toContain(producedFile);
    const ownedPaths = bus._cidStateForTest(TEST_UID, cid)?.producedPaths;
    for (const file of expectedProduced) expect(ownedPaths?.has(file)).toBe(true);
    expect(ownedPaths?.has(outsideFile)).toBe(false);
    expect(ownedPaths?.has(traversalFile)).toBe(false);
    expect(ownedPaths?.has(misleadingInsideFile)).toBe(false);
    expect(ownedPaths?.has(misleadingTraversalFile)).toBe(false);
    expect(reply?.process).toContainEqual({
      type: 'event',
      event: { stream: 'cli', data: safeEvent },
    });
  });

  it('publishes a managed Codex image file inline and does not restore it as an unsent attachment', async () => {
    const paths = await import('../../../../src/main/paths');
    const layout = await import('../../../../src/main/util/project-layout');
    const agentFile = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
    const spec = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
    spec.runtime = { kind: 'cli', cli: 'codex' };
    fs.writeFileSync(agentFile, JSON.stringify(spec));

    const cid = 'cid-codex-generated-image';
    const attachmentDir = layout.chatAttachmentDirForConversation(TEST_UID, cid);
    const generatedPath = path.join(attachmentDir, 'codex-generated-image.png');
    const outsidePath = path.join(tmpDir, 'outside', 'must-not-be-owned.png');
    fs.mkdirSync(attachmentDir, { recursive: true });
    fs.mkdirSync(path.dirname(outsidePath), { recursive: true });
    fs.writeFileSync(generatedPath, Buffer.from('generated image bytes'));
    fs.writeFileSync(outsidePath, Buffer.from('outside bytes'));

    cliRunMock.nextEvents.push({
      type: 'file-change',
      paths: [generatedPath, outsidePath],
      scope: 'conversation-media',
      source: 'image_generation',
      synthetic: true,
    });
    cliRunMock.nextResult = {
      runId: 'codex-generated-image',
      status: 'completed',
      output: 'The image is ready.',
    };

    const bus = await import('../../../../src/main/features/group_chat/bus');
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `@${AGENT_NAME} generate the image`,
      forceTo: [AGENT_ID],
    });
    await waitForQuiescent(TEST_UID, cid);

    const mainFile = path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`);
    const rows = fs.readFileSync(mainFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const reply = rows.find(row => row.from === AGENT_ID);
    expect(reply?.produced).toEqual([generatedPath]);
    expect(reply?.text).toContain('The image is ready.');
    expect(reply?.text).toContain(
      '![generated image](chat-media://cid/cid-codex-generated-image/codex-generated-image.png)',
    );
    expect(reply?.process).toContainEqual({
      type: 'event',
      event: {
        stream: 'cli',
        data: expect.objectContaining({
          type: 'file-change',
          scope: 'conversation-media',
          source: 'image_generation',
        }),
      },
    });
    expect(bus._cidStateForTest(TEST_UID, cid)?.producedPaths.has(generatedPath)).toBe(true);
    expect(bus._cidStateForTest(TEST_UID, cid)?.producedPaths.has(outsidePath)).toBe(false);

    const attachments = await import('../../../../src/main/features/chat_attachments');
    expect(attachments.listPendingAttachments(TEST_UID, cid)).toEqual([]);
  });

  it('converts a Codex file citation into the exact produced-file footer selection', async () => {
    const paths = await import('../../../../src/main/paths');
    const agentFile = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
    const spec = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
    spec.runtime = { kind: 'cli', cli: 'codex' };
    fs.writeFileSync(agentFile, JSON.stringify(spec));

    const projectDir = path.join(tmpDir, 'workspace');
    const agents = await import('../../../../src/main/features/agents');
    await agents.setAgentCliProjectDir(TEST_UID, AGENT_ID, projectDir);
    const deckPath = path.join(projectDir, 'AI会议助手竞品分析.pptx');
    const supportingPath = path.join(projectDir, 'analysis-notes.md');
    fs.writeFileSync(deckPath, 'presentation bytes');
    fs.writeFileSync(supportingPath, 'supporting notes');

    cliRunMock.nextEvents.push({
      type: 'file-change',
      source: 'codex',
      paths: [deckPath, supportingPath],
    });
    cliRunMock.nextResult = {
      runId: 'codex-file-citation',
      status: 'completed',
      output: [
        '演示文稿已经完成。',
        '',
        `:codex-file-citation{path="${deckPath}" purpose="output"}`,
      ].join('\n'),
    };

    const cid = 'cid-codex-file-citation';
    const bus = await import('../../../../src/main/features/group_chat/bus');
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `@${AGENT_NAME} create the presentation`,
      forceTo: [AGENT_ID],
    });
    await waitForQuiescent(TEST_UID, cid);

    const mainFile = path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`);
    const rows = fs.readFileSync(mainFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const reply = rows.find(row => row.from === AGENT_ID);
    expect(reply?.text).toBe('演示文稿已经完成。');
    // Renderer consumes `produced` for the clickable list under the bubble.
    // The native citation explicitly selects the deck, while the supporting
    // file remains owned by the conversation without being presented as final.
    expect(reply?.produced).toEqual([deckPath]);
    expect(bus._cidStateForTest(TEST_UID, cid)?.producedPaths.has(deckPath)).toBe(true);
    expect(bus._cidStateForTest(TEST_UID, cid)?.producedPaths.has(supportingPath)).toBe(true);
  });

  it('previews materialized CLI images and videos without publishing unscheduled remote media', async () => {
    const paths = await import('../../../../src/main/paths');
    const layout = await import('../../../../src/main/util/project-layout');
    const agentFile = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
    const spec = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
    spec.runtime = { kind: 'cli', cli: 'claude' };
    fs.writeFileSync(agentFile, JSON.stringify(spec));

    const cid = 'cid-cli-remote-image';
    const attachmentDir = layout.chatAttachmentDirForConversation(TEST_UID, cid);
    const generatedPath = path.join(attachmentDir, 'claude-generated-image.png');
    const generatedVideoPath = path.join(attachmentDir, 'claude-generated-video.mp4');
    fs.mkdirSync(attachmentDir, { recursive: true });
    fs.writeFileSync(generatedPath, Buffer.from('generated image bytes'));
    fs.writeFileSync(generatedVideoPath, Buffer.from('generated video bytes'));
    cliRunMock.nextEvents.push({
      type: 'file-change',
      paths: [generatedPath, generatedVideoPath],
      scope: 'conversation-media',
      source: 'cli_media_output',
      synthetic: true,
    });
    cliRunMock.nextEvents.push({
      type: 'media-output',
      source: 'claude',
      items: [
        {
          uri: 'https://cdn.example/generated.png?token=signed',
          mediaType: 'image/png',
          materializedName: 'claude-generated-image.png',
        },
        {
          uri: 'https://cdn.example/generated.mp4?token=signed',
          mediaType: 'video/mp4',
          materializedName: 'claude-generated-video.mp4',
        },
        { uri: 'https://cdn.example/fallback.webp?token=signed', mediaType: 'image/webp' },
        { uri: 'javascript:alert(1)' },
      ],
      materializedCount: 2,
      rejectedCount: 1,
    });
    cliRunMock.nextResult = {
      runId: 'claude-remote-image',
      status: 'completed',
      output: '',
    };

    const bus = await import('../../../../src/main/features/group_chat/bus');
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `@${AGENT_NAME} generate the image`,
      forceTo: [AGENT_ID],
    });
    await waitForQuiescent(TEST_UID, cid);

    const mainFile = path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`);
    const rows = fs.readFileSync(mainFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const reply = rows.find(row => row.from === AGENT_ID);
    expect(reply?.text).toBe([
      '![generated image](chat-media://cid/cid-cli-remote-image/claude-generated-image.png)',
      '![generated image](chat-media://cid/cid-cli-remote-image/claude-generated-video.mp4)',
    ].join('\n\n'));
    expect(reply?.text).not.toContain('javascript:');
    expect(reply?.text).not.toContain('https://cdn.example/generated.png');
    expect(reply?.text).not.toContain('https://cdn.example/generated.mp4');
    // Normal delivery selection keeps the highest-priority terminal media in
    // produced while both local copies remain owned and previewed inline.
    expect(reply?.produced).toEqual([generatedVideoPath]);
    expect(bus._cidStateForTest(TEST_UID, cid)?.producedPaths.has(generatedPath)).toBe(true);
    expect(bus._cidStateForTest(TEST_UID, cid)?.producedPaths.has(generatedVideoPath)).toBe(true);
    expect(reply?.process).toContainEqual({
      type: 'event',
      event: {
        stream: 'cli',
        data: expect.objectContaining({ type: 'media-output', source: 'claude' }),
      },
    });
  });

  it('persists a scheduled remote video with a stable local preview and correlation marker', async () => {
    const paths = await import('../../../../src/main/paths');
    const agentFile = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
    const spec = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
    spec.runtime = { kind: 'cli', cli: 'claude' };
    fs.writeFileSync(agentFile, JSON.stringify(spec));

    const cid = 'cid-cli-background-video';
    cliRunMock.nextEvents.push({
      type: 'media-output',
      source: 'claude',
      items: [{
        uri: 'https://cdn.example/render?id=clip-1',
        mediaType: 'video/mp4',
        localName: 'cli-remote-aabbccddeeff001122334455.mp4',
      }],
      scheduledCount: 1,
      materializedCount: 0,
      rejectedCount: 0,
    });
    cliRunMock.nextResult = {
      runId: 'claude-background-video',
      status: 'completed',
      output: '',
    };

    const bus = await import('../../../../src/main/features/group_chat/bus');
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `@${AGENT_NAME} generate the video`,
      forceTo: [AGENT_ID],
    });
    await waitForQuiescent(TEST_UID, cid);

    const mainFile = path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`);
    const rows = fs.readFileSync(mainFile, 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const reply = rows.find(row => row.from === AGENT_ID);
    expect(reply?.text).toBe(
      '![generated video](chat-media://cid/cid-cli-background-video/cli-remote-aabbccddeeff001122334455.mp4'
      + ' "orkas-media-v1:video:https%3A%2F%2Fcdn.example%2Frender%3Fid%3Dclip-1")',
    );
    expect(reply?.process).toContainEqual({
      type: 'event',
      event: {
        stream: 'cli',
        data: expect.objectContaining({ type: 'media-output', scheduledCount: 1 }),
      },
    });
  });

  it('keeps an OpenCode project-dir form retryable and atomically replays in a fresh cwd', async () => {
    const paths = await import('../../../../src/main/paths');
    const agentFile = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
    const spec = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
    spec.runtime = { kind: 'cli', cli: 'opencode' };
    fs.writeFileSync(agentFile, JSON.stringify(spec));

    const oldDir = path.join(tmpDir, 'workspace', 'old-project');
    const defaultDir = path.join(tmpDir, 'workspace', 'new-project');
    const nonDirectory = path.join(tmpDir, 'workspace', 'not-a-directory.txt');
    fs.mkdirSync(oldDir, { recursive: true });
    fs.mkdirSync(defaultDir, { recursive: true });
    fs.writeFileSync(nonDirectory, 'file');
    const agents = await import('../../../../src/main/features/agents');
    await agents.setAgentCliProjectDir(TEST_UID, AGENT_ID, oldDir);

    cliRunMock.nextResult = {
      runId: 'project-dir-form',
      status: 'completed',
      output: [
        'Choose the project directory.',
        '<agent-input-form>',
        JSON.stringify({
          fields: [{
            id: 'project_dir',
            type: 'directory',
            label: 'Project directory',
            required: true,
            default: defaultDir,
          }],
        }),
        '</agent-input-form>',
      ].join('\n'),
    };

    const bus = await import('../../../../src/main/features/group_chat/bus');
    const groupChat = await import('../../../../src/main/features/group_chat');
    const state = await import('../../../../src/main/features/group_chat/state');
    const sessions = await import('../../../../src/main/features/local_agents/sessions');
    const i18n = await import('../../../../src/main/i18n');
    i18n.setCurrentLang('en');
    const cid = 'cid-project-dir-form-atomic';
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `@${AGENT_NAME} change projects`,
    });
    await waitForQuiescent(TEST_UID, cid);

    const mainFile = path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`);
    const rows = fs.readFileSync(mainFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const formMessage = rows.find((row: any) => row.from === AGENT_ID && row.form);
    expect(formMessage?.form?.submitted).toBe(false);
    const mainBefore = fs.readFileSync(mainFile, 'utf8');
    // isQuiescent covers queues and active workers; the intentionally
    // fire-and-forget status reconciliation may finish one tick later. Wait
    // for that durable state before taking the atomicity snapshot.
    const stateDeadline = Date.now() + 2_000;
    let stateBefore = await state.readState(TEST_UID, cid);
    while (stateBefore.status !== 'idle' && Date.now() < stateDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      stateBefore = await state.readState(TEST_UID, cid);
    }
    expect(stateBefore.status).toBe('idle');
    await sessions.setSessionId(TEST_UID, cid, AGENT_ID, 'opencode', 'project-dir-session');
    const sessionBefore = await sessions.getBinding(TEST_UID, cid, AGENT_ID, 'opencode');
    const runCountBefore = cliRunMock.calls.length;

    const invalidValues: Array<{ value: unknown; error: string }> = [
      { value: null, error: 'Directory does not exist' },
      { value: 'relative/project', error: 'Directory does not exist' },
      { value: path.join(tmpDir, 'workspace', 'missing-project'), error: 'Directory does not exist' },
      { value: nonDirectory, error: 'Selected path is not a directory' },
    ];
    for (const { value: projectDir, error } of invalidValues) {
      const result = await groupChat.markFormSubmittedAndDispatch({
        userId: TEST_UID,
        cid,
        msgId: formMessage.id,
        formId: formMessage.form.form_id,
        values: { project_dir: projectDir },
      });
      expect(result.ok).toBe(false);
      expect(result.error).toBe(error);
      expect(result.submission).toBeUndefined();
      expect(fs.readFileSync(mainFile, 'utf8')).toBe(mainBefore);
      expect(await state.readState(TEST_UID, cid)).toEqual(stateBefore);
      expect(await sessions.getBinding(TEST_UID, cid, AGENT_ID, 'opencode')).toEqual(sessionBefore);
      expect(cliRunMock.calls).toHaveLength(runCountBefore);
    }

    // A validated path can still fail to persist. That failure must not
    // consume the canonical form or clear the cwd-bound session.
    const setProjectDir = vi.spyOn(state, 'setCodingProjectDir')
      .mockRejectedValueOnce(new Error('injected state write failure'));
    const stateWriteFailure = await groupChat.markFormSubmittedAndDispatch({
      userId: TEST_UID,
      cid,
      msgId: formMessage.id,
      formId: formMessage.form.form_id,
      values: { project_dir: defaultDir },
    });
    expect(stateWriteFailure.ok).toBe(false);
    expect(fs.readFileSync(mainFile, 'utf8')).toBe(mainBefore);
    expect((await state.readState(TEST_UID, cid)).coding_project_dir).toBe(oldDir);
    expect(await sessions.getBinding(TEST_UID, cid, AGENT_ID, 'opencode')).toEqual(sessionBefore);
    expect(cliRunMock.calls).toHaveLength(runCountBefore);
    setProjectDir.mockRestore();

    // Concurrent retries with identical values are idempotent: exactly one
    // commit wins, while both callers receive the same replay payload.
    const submissions = await Promise.all([0, 1].map(() => (
      groupChat.markFormSubmittedAndDispatch({
        userId: TEST_UID,
        cid,
        msgId: formMessage.id,
        formId: formMessage.form.form_id,
        values: { project_dir: defaultDir },
      })
    )));
    const [valid, duplicate] = submissions;
    expect(valid.ok).toBe(true);
    expect(duplicate).toEqual(valid);
    expect((await state.readState(TEST_UID, cid)).coding_project_dir).toBe(defaultDir);
    expect(await sessions.getSessionId(TEST_UID, cid, AGENT_ID, 'opencode')).toBeNull();
    const submittedRows = fs.readFileSync(mainFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    expect(submittedRows.find((row: any) => row.id === formMessage.id)?.form?.submitted).toBe(true);

    const conflictingRetry = await groupChat.markFormSubmittedAndDispatch({
      userId: TEST_UID,
      cid,
      msgId: formMessage.id,
      formId: formMessage.form.form_id,
      values: { project_dir: oldDir },
    });
    expect(conflictingRetry).toMatchObject({ ok: false, error: 'form already submitted with different values' });

    cliRunMock.nextResult = {
      runId: 'project-dir-form-replay',
      status: 'completed',
      output: 'Changed projects and completed the original task.',
    };
    await groupChat.send({
      userId: TEST_UID,
      cid,
      text: valid.submission!.text,
    });
    await waitForQuiescent(TEST_UID, cid);

    expect(cliRunMock.calls).toHaveLength(runCountBefore + 1);
    const replayCall = cliRunMock.calls.at(-1);
    expect(replayCall.cwd).toBe(defaultDir);
    expect(replayCall.resumeSessionId).toBeUndefined();
    expect(replayCall.prompt).toContain('change projects');
    expect(replayCall.prompt).not.toContain('<agent-input-submission');
    expect(replayCall.prompt).not.toContain('- Project directory:');
    expect(replayCall.prompt).not.toContain(defaultDir);
  });

  it('shows the sanitized CLI terminal error without inferring a different cause', async () => {
    const paths = await import('../../../../src/main/paths');
    const agentFile = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
    const spec = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
    spec.runtime = { kind: 'cli', cli: 'openclaw' };
    fs.writeFileSync(agentFile, JSON.stringify(spec));
    cliRunMock.nextResult = {
      runId: 'failed-run',
      status: 'failed',
        error: 'openclaw exited with code 17 at /Users/user/private-project',
    };

    const i18n = await import('../../../../src/main/i18n');
    i18n.setCurrentLang('en');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const cid = 'cid-cli-failure-copy';
    await bus.enqueue({
      uid: TEST_UID, cid, fromActorId: 'user',
      text: `@${AGENT_NAME} run the task`,
    });
    await waitForQuiescent(TEST_UID, cid);

    const mainFile = path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`);
    const rows = fs.readFileSync(mainFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const failure = rows.find((row: any) => row.from === AGENT_ID && row.failure_kind === 'runtime');
    expect(failure?.failure_code).toBe('cli_failed');
    expect(failure?.text).toContain('Agent run failed');
    expect(failure?.text).toContain('openclaw exited with code 17');
    expect(failure?.text).not.toContain('signed in');
    expect(failure?.text).not.toContain('/Users/alice');
  });

  it('states that no specific error information was provided when the CLI omits it', async () => {
    const paths = await import('../../../../src/main/paths');
    const agentFile = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
    const spec = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
    spec.runtime = { kind: 'cli', cli: 'codex' };
    fs.writeFileSync(agentFile, JSON.stringify(spec));
    cliRunMock.nextResult = {
      runId: 'failed-run-without-detail',
      status: 'failed',
    };

    const i18n = await import('../../../../src/main/i18n');
    i18n.setCurrentLang('zh');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const cid = 'cid-cli-failure-without-detail';
    await bus.enqueue({
      uid: TEST_UID, cid, fromActorId: 'user',
      text: `@${AGENT_NAME} run the task`,
    });
    await waitForQuiescent(TEST_UID, cid);

    const mainFile = path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`);
    const rows = fs.readFileSync(mainFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const failure = rows.find((row: any) => row.from === AGENT_ID && row.failure_kind === 'runtime');
    expect(failure?.failure_code).toBe('cli_failed');
    expect(failure?.text).toContain('未提供具体错误信息');
    expect(failure?.text).not.toContain('已登录');
  });

  it.each([
    { phase: 'background', kind: undefined, code: 'cli_timeout', copy: 'reached the 24-hour limit' },
    { phase: 'foreground', kind: 'wall', code: 'cli_wall_timeout', copy: 'reached the 24-hour limit' },
    { phase: 'foreground', kind: 'idle', code: 'cli_idle_timeout', copy: 'no progress for 30 minutes' },
    { phase: 'background', kind: 'idle', code: 'cli_idle_timeout', copy: 'no progress for 30 minutes' },
  ])('explains $phase / $kind timeout using its actual cause, including legacy background results', async ({ phase, kind, code, copy }) => {
    const paths = await import('../../../../src/main/paths');
    const agentFile = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
    const spec = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
    spec.runtime = { kind: 'cli', cli: 'claude' };
    fs.writeFileSync(agentFile, JSON.stringify(spec));
    cliRunMock.nextResult = {
      runId: 'background-timeout-run',
      status: 'timeout',
      timeoutPhase: phase,
      timeoutKind: kind,
      error: 'internal raw timeout detail',
    };

    const i18n = await import('../../../../src/main/i18n');
    i18n.setCurrentLang('en');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const cid = 'cid-cli-background-timeout-copy';
    await bus.enqueue({
      uid: TEST_UID, cid, fromActorId: 'user',
      text: `@${AGENT_NAME} run the long background task`,
    });
    await waitForQuiescent(TEST_UID, cid);

    const mainFile = path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`);
    const rows = fs.readFileSync(mainFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const failure = rows.find((row: any) => row.from === AGENT_ID && row.failure_kind === 'runtime');
    expect(failure?.failure_code).toBe(code);
    expect(failure?.text).toContain(copy);
    expect(failure?.text).not.toContain('did not respond for an extended period');
    expect(failure?.text).not.toContain('internal raw timeout detail');
  });

  it('reports an installed CLI version-probe timeout separately from not found', async () => {
    const paths = await import('../../../../src/main/paths');
    const agentFile = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
    const spec = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
    spec.runtime = { kind: 'cli', cli: 'claude' };
    fs.writeFileSync(agentFile, JSON.stringify(spec));
    cliRunMock.nextResult = {
      runId: '',
      status: 'missing_cli',
      error: 'raw version probe timeout detail',
      cliError: 'version_timeout',
      cliPath: '/usr/local/bin/claude',
    };

    const i18n = await import('../../../../src/main/i18n');
    i18n.setCurrentLang('en');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const cid = 'cid-cli-version-timeout';
    await bus.enqueue({
      uid: TEST_UID, cid, fromActorId: 'user',
      text: `@${AGENT_NAME} run the task`,
    });
    await waitForQuiescent(TEST_UID, cid);

    const mainFile = path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`);
    const rows = fs.readFileSync(mainFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const failure = rows.find((row: any) => row.from === AGENT_ID && row.failure_kind === 'dependency');
    expect(failure?.failure_code).toBe('version_timeout');
    expect(failure?.text).toContain('version check for “claude” timed out');
    expect(failure?.text).not.toContain('was not found');
    expect(failure?.text).not.toContain('raw version probe timeout detail');
  });

  it('shows a Codex model/version rejection as the CLI reported it', async () => {
    const paths = await import('../../../../src/main/paths');
    const agentFile = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
    const spec = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
    spec.runtime = { kind: 'cli', cli: 'codex' };
    fs.writeFileSync(agentFile, JSON.stringify(spec));
    cliRunMock.nextResult = {
      runId: 'old-codex-run',
      status: 'failed',
      error: "The 'gpt-5.6-sol' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again.",
    };

    const i18n = await import('../../../../src/main/i18n');
    i18n.setCurrentLang('en');
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const cid = 'cid-cli-upgrade-required';
    await bus.enqueue({
      uid: TEST_UID, cid, fromActorId: 'user',
      text: `@${AGENT_NAME} run the task`,
    });
    await waitForQuiescent(TEST_UID, cid);

    const mainFile = path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`);
    const rows = fs.readFileSync(mainFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const failure = rows.find((row: any) => row.from === AGENT_ID && row.failure_kind === 'runtime');
    expect(failure?.failure_code).toBe('cli_failed');
    expect(failure?.text).toContain("The 'gpt-5.6-sol' model requires a newer version of Codex");
    expect(failure?.text).not.toContain('signed in');
  });

  it.each(['codex', 'opencode'] as const)(
    'asks for a project directory instead of silently falling back when a saved %s coding cwd vanished',
    async (cli) => {
      const paths = await import('../../../../src/main/paths');
      const agentFile = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
      const spec = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
      spec.runtime = { kind: 'cli', cli };
      spec.inputs = [{ id: 'project_dir', type: 'directory', label: 'Project directory', required: true, default: '' }];
      fs.writeFileSync(agentFile, JSON.stringify(spec));

      const projectDir = path.join(tmpDir, 'repo-removed');
      fs.mkdirSync(projectDir);
      const agents = await import('../../../../src/main/features/agents');
      await agents.setAgentCliProjectDir(TEST_UID, AGENT_ID, projectDir);
      fs.rmSync(projectDir, { recursive: true, force: true });

      const bus = await import('../../../../src/main/features/group_chat/bus');
      const state = await import('../../../../src/main/features/group_chat/state');
      const cid = 'cid-coding-dir-missing';
      await bus.enqueue({
        uid: TEST_UID, cid, fromActorId: 'user',
        text: `@${AGENT_NAME} 修一下这个项目`,
      });
      await waitForQuiescent(TEST_UID, cid);

      expect(cliRunMock.calls).toHaveLength(0);
      const st = await state.readState(TEST_UID, cid);
      expect(st.coding_project_dir).toBe(projectDir);

      const mainFile = path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`);
      const rows = fs.readFileSync(mainFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      const formMsg = rows.find((row: any) => row?.form?.agent_id === AGENT_ID);
      expect(formMsg?.form?.fields?.map((f: any) => f.id)).toEqual(['project_dir']);
    },
  );

  it.each(['removed', 'replaced-with-file'])(
    'blocks a later OpenCode turn when its cwd is %s and resumes in the restored directory', async (fault) => {
    const paths = await import('../../../../src/main/paths');
    const agentFile = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
    const spec = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
    spec.runtime = { kind: 'cli', cli: 'opencode' };
    fs.writeFileSync(agentFile, JSON.stringify(spec));

    const projectDir = path.join(tmpDir, 'later-removed-project');
    fs.mkdirSync(projectDir, { recursive: true });
    const agents = await import('../../../../src/main/features/agents');
    await agents.setAgentCliProjectDir(TEST_UID, AGENT_ID, projectDir);

    const bus = await import('../../../../src/main/features/group_chat/bus');
    const state = await import('../../../../src/main/features/group_chat/state');
    const sessions = await import('../../../../src/main/features/local_agents/sessions');
    const cid = 'cid-coding-dir-removed-between-turns';
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `@${AGENT_NAME} inspect the selected project`,
    });
    await waitForQuiescent(TEST_UID, cid);

    expect(cliRunMock.calls).toHaveLength(1);
    expect(cliRunMock.calls[0]).toMatchObject({ cli: 'opencode', cwd: projectDir });
    expect((await state.readState(TEST_UID, cid)).coding_project_dir).toBe(projectDir);
    await sessions.setSessionId(TEST_UID, cid, AGENT_ID, 'opencode', 'stale-cwd-session');
    fs.rmSync(projectDir, { recursive: true, force: true });
    if (fault === 'replaced-with-file') fs.writeFileSync(projectDir, 'not a directory');

    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `@${AGENT_NAME} now edit that same project`,
    });
    await waitForQuiescent(TEST_UID, cid);

    expect(cliRunMock.calls).toHaveLength(1);
    expect((await state.readState(TEST_UID, cid)).coding_project_dir).toBe(projectDir);
    expect(await sessions.getSessionId(TEST_UID, cid, AGENT_ID, 'opencode')).toBe('stale-cwd-session');
    const rows = fs.readFileSync(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`), 'utf8')
      .trim().split('\n').map((line) => JSON.parse(line));
    const recoveryForm = rows.find((row: any) => row?.form?.agent_id === AGENT_ID
      && row.form.fields?.some((field: any) => field.id === 'project_dir'));
    expect(recoveryForm?.form?.submitted).toBe(false);
    if (fault === 'replaced-with-file') fs.rmSync(projectDir);
    fs.mkdirSync(projectDir);
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: `@${AGENT_NAME} continue after restoring the drive` });
    await waitForQuiescent(TEST_UID, cid);
    expect(cliRunMock.calls).toHaveLength(2);
    expect(cliRunMock.calls[1].cwd).toBe(projectDir);
  });

  it('keeps an unverified legacy directory recoverable when form persistence fails', async () => {
    const paths = await import('../../../../src/main/paths');
    const agentFile = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
    const spec = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
    spec.runtime = { kind: 'cli', cli: 'codex' };
    fs.writeFileSync(agentFile, JSON.stringify(spec));
    const state = await import('../../../../src/main/features/group_chat/state');
    const cid = 'cid-directory-migration-form';
    const legacy = path.join(tmpDir, 'legacy-unverified');
    await state.setCodingProjectDir(TEST_UID, cid, legacy, { explicit: true, needsConfirmation: true });
    const bus = await import('../../../../src/main/features/group_chat/bus');
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: `@${AGENT_NAME} continue the task` });
    await waitForQuiescent(TEST_UID, cid);
    expect(cliRunMock.calls).toHaveLength(0);
    const file = path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`);
    const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const form = rows.find((row: any) => row.form);
    const storage = await import('../../../../src/main/storage');
    const rewrite = vi.spyOn(storage, 'rewriteJsonlLine').mockResolvedValueOnce({ ok: false, error: 'injected transcript failure' });
    const facade = await import('../../../../src/main/features/group_chat');
    const input = { userId: TEST_UID, cid, msgId: form.id, formId: form.form.form_id, values: { project_dir: tmpDir } };
    try {
      expect((await facade.markFormSubmittedAndDispatch(input)).ok).toBe(false);
      expect((await state.readState(TEST_UID, cid)).coding_project_dir_pending).toBe(legacy);
      expect((await state.readState(TEST_UID, cid)).coding_project_dir).toBeUndefined();
    } finally { rewrite.mockRestore(); }
    expect((await facade.markFormSubmittedAndDispatch(input)).ok).toBe(true);
    expect((await state.readState(TEST_UID, cid)).coding_project_dir).toBe(tmpDir);
    expect((await state.readState(TEST_UID, cid)).coding_project_dir_pending).toBeUndefined();
  });

  it.each(['EACCES', 'EPERM', 'EIO'])(
    'retains the project and resumes after a %s directory-check failure', async (code) => {
      const paths = await import('../../../../src/main/paths');
      const agentFile = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
      const spec = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
      spec.runtime = { kind: 'cli', cli: 'codex' };
      fs.writeFileSync(agentFile, JSON.stringify(spec));
      const selected = path.join(tmpDir, 'protected-project');
      fs.mkdirSync(selected);
      const state = await import('../../../../src/main/features/group_chat/state');
      const cid = 'cid-directory-access';
      await state.setCodingProjectDir(TEST_UID, cid, selected, { explicit: true });
      const bus = await import('../../../../src/main/features/group_chat/bus');
      const { syncBuiltinESMExports } = await import('node:module');
      const realStat = fs.statSync;
      const nativeFs = (await import('node:fs')).default;
      const stat = vi.spyOn(nativeFs, 'statSync').mockImplementation(((target: any, options: any) => {
        if (String(target) === selected) throw Object.assign(new Error('injected directory access error'), { code });
        return realStat(target, options);
      }) as typeof fs.statSync);
      syncBuiltinESMExports();
      try {
        await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: `@${AGENT_NAME} inspect this project` });
        await waitForQuiescent(TEST_UID, cid);
        expect(cliRunMock.calls).toHaveLength(0);
        expect((await state.readState(TEST_UID, cid)).coding_project_dir).toBe(selected);
        const rows = fs.readFileSync(path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`), 'utf8')
          .trim().split('\n').map((line) => JSON.parse(line));
        expect(rows.some((row: any) => row.form)).toBe(false);
        expect(rows.some((row: any) => row.failure_code === 'project_directory_unavailable')).toBe(true);
      } finally { stat.mockRestore(); syncBuiltinESMExports(); }
      await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: `@${AGENT_NAME} try again` });
      await waitForQuiescent(TEST_UID, cid);
      expect(cliRunMock.calls).toHaveLength(1);
      expect(cliRunMock.calls[0].cwd).toBe(selected);
    },
  );

  it('ignores a legacy per-agent model override when dispatching a CLI turn', async () => {
    const paths = await import('../../../../src/main/paths');
    const agentFile = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
    const spec = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
    spec.runtime = { kind: 'cli', cli: 'codex', model: 'gpt-5.5' };
    fs.writeFileSync(agentFile, JSON.stringify(spec));

    const bus = await import('../../../../src/main/features/group_chat/bus');
    const cid = 'cid-legacy-cli-model';
    await bus.enqueue({
      uid: TEST_UID, cid, fromActorId: 'user',
      text: `@${AGENT_NAME} 完成当前任务`,
    });
    await waitForQuiescent(TEST_UID, cid);

    expect(cliRunMock.calls).toHaveLength(1);
    expect(cliRunMock.calls[0].cli).toBe('codex');
    expect(cliRunMock.calls[0]).not.toHaveProperty('model');
  });

  it('forwards a supported per-Agent CLI permission override', async () => {
    const paths = await import('../../../../src/main/paths');
    const agentFile = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
    const spec = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
    spec.runtime = {
      kind: 'cli',
      cli: 'hermes',
      permission_policy: 'full_access',
    };
    fs.writeFileSync(agentFile, JSON.stringify(spec));

    const bus = await import('../../../../src/main/features/group_chat/bus');
    const cid = 'cid-cli-agent-permission';
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `@${AGENT_NAME} inspect the current task`,
    });
    await waitForQuiescent(TEST_UID, cid);

    expect(cliRunMock.calls).toHaveLength(1);
    expect(cliRunMock.calls[0]).toMatchObject({
      cli: 'hermes',
      permissionPolicy: 'full_access',
    });
  });

  it.each([
    { name: 'legacy missing marker', cli: 'codex', runtimePolicy: undefined, storedPolicy: undefined, expected: 'inherit' },
    { name: 'changed explicit policy', cli: 'codex', runtimePolicy: 'ask', storedPolicy: 'full_access', expected: 'ask' },
    { name: 'stale OpenCode inherited policy', cli: 'opencode', runtimePolicy: undefined, storedPolicy: 'inherit', expected: 'full_access' },
  ] as const)('starts a fresh native session for a $name', async ({ cli, runtimePolicy, storedPolicy, expected }) => {
    const paths = await import('../../../../src/main/paths');
    const agentFile = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
    const spec = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
    spec.runtime = {
      kind: 'cli',
      cli,
      ...(runtimePolicy ? { permission_policy: runtimePolicy } : {}),
    };
    fs.writeFileSync(agentFile, JSON.stringify(spec));

    const cid = `cid-cli-policy-session-${cli}-${expected}`;
    const sessions = await import('../../../../src/main/features/local_agents/sessions');
    await sessions.setSessionId(TEST_UID, cid, AGENT_ID, cli, 'sticky-old-thread', {
      ...(storedPolicy ? { permissionPolicy: storedPolicy } : {}),
    });
    cliRunMock.nextResult = {
      runId: `run-${expected}`,
      status: 'completed',
      output: 'ok',
      sessionId: `fresh-${expected}-thread`,
    };

    const bus = await import('../../../../src/main/features/group_chat/bus');
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `@${AGENT_NAME} inspect the current task`,
    });
    await waitForQuiescent(TEST_UID, cid);

    expect(cliRunMock.calls).toHaveLength(1);
    expect(cliRunMock.calls[0].resumeSessionId).toBeUndefined();
    expect(cliRunMock.calls[0].permissionPolicy).toBe(expected);
    expect(await sessions.getBinding(TEST_UID, cid, AGENT_ID, cli)).toMatchObject({
      sessionId: `fresh-${expected}-thread`,
      permissionPolicy: expected,
    });
  });

  it('resumes a native CLI session when its explicit permission policy is unchanged', async () => {
    const paths = await import('../../../../src/main/paths');
    const agentFile = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
    const spec = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
    spec.runtime = {
      kind: 'cli',
      cli: 'codex',
      permission_policy: 'ask',
    };
    fs.writeFileSync(agentFile, JSON.stringify(spec));

    const cid = 'cid-cli-policy-session-unchanged';
    const sessions = await import('../../../../src/main/features/local_agents/sessions');
    const { fingerprintCliContext } = await import('../../../../src/main/features/local_agents/context');
    await sessions.setSessionId(TEST_UID, cid, AGENT_ID, 'codex', 'matching-policy-thread', {
      permissionPolicy: 'ask',
      agentMemoryHash: fingerprintCliContext(''),
    });

    const bus = await import('../../../../src/main/features/group_chat/bus');
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `@${AGENT_NAME} continue the current task`,
    });
    await waitForQuiescent(TEST_UID, cid);

    expect(cliRunMock.calls).toHaveLength(1);
    expect(cliRunMock.calls[0]).toMatchObject({
      cli: 'codex',
      permissionPolicy: 'ask',
      resumeSessionId: 'matching-policy-thread',
    });
    expect(await sessions.getBinding(TEST_UID, cid, AGENT_ID, 'codex')).toMatchObject({
      sessionId: 'matching-policy-thread',
      permissionPolicy: 'ask',
    });
  });

  it('supplies bounded canonical history when a legacy CLI resume has no sync cursor', async () => {
    const paths = await import('../../../../src/main/paths');
    const agentFile = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
    const spec = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
    spec.runtime = { kind: 'cli', cli: 'codex' };
    fs.writeFileSync(agentFile, JSON.stringify(spec));

    const cid = 'cid-coding-resume';
    const bus = await import('../../../../src/main/features/group_chat/bus');
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: 'PASS_AS_BOUNDED_HISTORY_WITHOUT_CURSOR',
    });
    await waitForQuiescent(TEST_UID, cid);
    const sessions = await import('../../../../src/main/features/local_agents/sessions');
    const { fingerprintCliContext } = await import('../../../../src/main/features/local_agents/context');
    await sessions.setSessionId(TEST_UID, cid, AGENT_ID, 'codex', 'thread-123', {
      permissionPolicy: 'inherit',
      agentMemoryHash: fingerprintCliContext(''),
    });

    await bus.enqueue({
      uid: TEST_UID, cid, fromActorId: 'user',
      text: `@${AGENT_NAME} 继续`,
    });
    await waitForQuiescent(TEST_UID, cid);

    expect(cliRunMock.calls).toHaveLength(1);
    expect(cliRunMock.calls[0].resumeSessionId).toBe('thread-123');
    expect(cliRunMock.calls[0].prompt).toContain('## Conversation context recovered by Orkas');
    expect(cliRunMock.calls[0].prompt).toContain('PASS_AS_BOUNDED_HISTORY_WITHOUT_CURSOR');
    expect(cliRunMock.calls[0].prompt).toContain('继续');
    expect(cliRunMock.calls[0].resumeFallbackPrompt).toContain('PASS_AS_BOUNDED_HISTORY_WITHOUT_CURSOR');
    expect(cliRunMock.calls[0].reuseSessionInstructions).toBe(false);
  });

  it('drops a Codex session after its last Agent memory is deleted without injecting an empty placeholder', async () => {
    const paths = await import('../../../../src/main/paths');
    const agentFile = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
    const spec = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
    spec.runtime = { kind: 'cli', cli: 'codex' };
    fs.writeFileSync(agentFile, JSON.stringify(spec));

    const memory = await import('../../../../src/main/features/memory');
    const sessions = await import('../../../../src/main/features/local_agents/sessions');
    const { fingerprintCliContext } = await import('../../../../src/main/features/local_agents/context');
    expect(memory.addAgentEntry(TEST_UID, AGENT_ID, 'OLD_AGENT_MEMORY_MUST_DISAPPEAR').ok).toBe(true);
    const oldMemoryBlock = memory.formatAgentForSystemPrompt(TEST_UID, AGENT_ID, AGENT_NAME);
    const cid = 'cid-codex-agent-memory-deleted';
    await sessions.setSessionId(TEST_UID, cid, AGENT_ID, 'codex', 'thread-with-old-memory', {
      permissionPolicy: 'inherit',
      agentMemoryHash: fingerprintCliContext(oldMemoryBlock),
    });
    expect(memory.removeAgentEntry(TEST_UID, AGENT_ID, 'OLD_AGENT_MEMORY_MUST_DISAPPEAR').ok).toBe(true);

    const bus = await import('../../../../src/main/features/group_chat/bus');
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `@${AGENT_NAME} continue after deletion`,
    });
    await waitForQuiescent(TEST_UID, cid);

    expect(cliRunMock.calls).toHaveLength(1);
    expect(cliRunMock.calls[0].resumeSessionId).toBeUndefined();
    expect(cliRunMock.calls[0].prompt).not.toContain('OLD_AGENT_MEMORY_MUST_DISAPPEAR');
    expect(cliRunMock.calls[0].prompt).not.toContain('## Durable memory for this agent');
    expect(loggerMocks.info).toHaveBeenCalledWith(
      'cli recovery selected',
      expect.objectContaining({
        cli: 'codex',
        resume_session: false,
        memory_binding_mismatch: true,
      }),
    );
    expect(await sessions.getSessionId(TEST_UID, cid, AGENT_ID, 'codex')).toBeNull();
  });

  it("resumes a Codex session after the Agent's own memory append and still resets after an edit", async () => {
    const paths = await import('../../../../src/main/paths');
    const agentFile = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
    const spec = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
    spec.runtime = { kind: 'cli', cli: 'codex' };
    fs.writeFileSync(agentFile, JSON.stringify(spec));

    const memory = await import('../../../../src/main/features/memory');
    const sessions = await import('../../../../src/main/features/local_agents/sessions');
    const { fingerprintCliContext } = await import('../../../../src/main/features/local_agents/context');
    expect(memory.addAgentEntry(TEST_UID, AGENT_ID, 'SEEN_LESSON_ONE').ok).toBe(true);
    const cid = 'cid-codex-agent-memory-append';
    await sessions.setSessionId(TEST_UID, cid, AGENT_ID, 'codex', 'thread-seen-one', {
      permissionPolicy: 'inherit',
      agentMemoryHash: fingerprintCliContext(memory.formatAgentForSystemPrompt(TEST_UID, AGENT_ID, AGENT_NAME)),
      agentMemoryEntryHashes: [fingerprintCliContext('SEEN_LESSON_ONE')],
    });
    // The Agent appended a lesson during its last run (bridge write).
    expect(memory.addAgentEntry(TEST_UID, AGENT_ID, 'APPENDED_LESSON_TWO').ok).toBe(true);
    cliRunMock.nextResult = { runId: 'append-run', status: 'completed', output: 'ok', sessionId: 'thread-seen-one' };

    const bus = await import('../../../../src/main/features/group_chat/bus');
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: `@${AGENT_NAME} continue after append` });
    await waitForQuiescent(TEST_UID, cid);

    expect(cliRunMock.calls).toHaveLength(1);
    expect(cliRunMock.calls[0].resumeSessionId).toBe('thread-seen-one');
    // The new entry still reaches the resumed session through the turn block.
    expect(cliRunMock.calls[0].prompt).toContain('APPENDED_LESSON_TWO');
    expect(loggerMocks.info).toHaveBeenCalledWith(
      'cli recovery selected',
      expect.objectContaining({ cli: 'codex', resume_session: true, memory_binding_mismatch: false }),
    );
    expect(await sessions.getBinding(TEST_UID, cid, AGENT_ID, 'codex')).toMatchObject({
      sessionId: 'thread-seen-one',
      agentMemoryEntryHashes: [fingerprintCliContext('SEEN_LESSON_ONE'), fingerprintCliContext('APPENDED_LESSON_TWO')].sort(),
    });

    // Negative control: editing an entry the session has seen resets it.
    expect(memory.replaceAgentEntry(TEST_UID, AGENT_ID, 'SEEN_LESSON_ONE', 'SEEN_LESSON_ONE_CORRECTED').ok).toBe(true);
    cliRunMock.nextResult = { runId: 'edit-run', status: 'completed', output: 'ok', sessionId: 'thread-after-edit' };
    await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: `@${AGENT_NAME} continue after edit` });
    await waitForQuiescent(TEST_UID, cid);

    expect(cliRunMock.calls).toHaveLength(2);
    expect(cliRunMock.calls[1].resumeSessionId).toBeUndefined();
    expect(cliRunMock.calls[1].prompt).toContain('SEEN_LESSON_ONE_CORRECTED');
    expect(loggerMocks.info).toHaveBeenCalledWith(
      'cli recovery selected',
      expect.objectContaining({ cli: 'codex', resume_session: false, memory_binding_mismatch: true }),
    );
  });

  it('rebuilds a legacy Codex binding without an Agent-memory marker once, then resumes it', async () => {
    const paths = await import('../../../../src/main/paths');
    const agentFile = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
    const spec = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
    spec.runtime = { kind: 'cli', cli: 'codex' };
    fs.writeFileSync(agentFile, JSON.stringify(spec));

    const sessions = await import('../../../../src/main/features/local_agents/sessions');
    const cid = 'cid-codex-legacy-agent-memory-marker';
    await sessions.setSessionId(TEST_UID, cid, AGENT_ID, 'codex', 'legacy-thread', {
      permissionPolicy: 'inherit',
    });
    cliRunMock.nextResult = {
      runId: 'replacement-memory-marker-run',
      status: 'completed',
      output: 'ok',
      sessionId: 'replacement-thread',
    };

    const bus = await import('../../../../src/main/features/group_chat/bus');
    await bus.enqueue({
      uid: TEST_UID, cid, fromActorId: 'user',
      text: `@${AGENT_NAME} first compatible turn`,
    });
    await waitForQuiescent(TEST_UID, cid);
    await bus.enqueue({
      uid: TEST_UID, cid, fromActorId: 'user',
      text: `@${AGENT_NAME} second compatible turn`,
    });
    await waitForQuiescent(TEST_UID, cid);

    expect(cliRunMock.calls).toHaveLength(2);
    expect(cliRunMock.calls[0].resumeSessionId).toBeUndefined();
    expect(cliRunMock.calls[0].prompt).not.toContain('## Durable memory for this agent');
    expect(cliRunMock.calls[1].resumeSessionId).toBe('replacement-thread');
    expect(await sessions.getBinding(TEST_UID, cid, AGENT_ID, 'codex')).toMatchObject({
      sessionId: 'replacement-thread',
      agentMemoryHash: expect.any(String),
    });
  });

  it('logs canonical CLI history failures without exposing private paths or actor ids', async () => {
    const paths = await import('../../../../src/main/paths');
    const agentFile = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
    const spec = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
    spec.runtime = { kind: 'cli', cli: 'codex' };
    fs.writeFileSync(agentFile, JSON.stringify(spec));

    const cid = 'cid-canonical-log-failure';
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const sessions = await import('../../../../src/main/features/local_agents/sessions');
    await sessions.setSessionId(TEST_UID, cid, AGENT_ID, 'codex', 'thread-private-log', {
      permissionPolicy: 'inherit',
    });
    const storage = await import('../../../../src/main/storage');
    // The CLI turn reads the canonical log through the bounded tail pager.
    const originalReadJsonlPage = storage.readJsonlPage.bind(storage);
    const mainFile = path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`);
    const privateFailure = `EACCES: denied, open '${path.join(tmpDir, 'private', 'conversation.jsonl')}'`;
    const canonicalRead = vi.spyOn(storage, 'readJsonlPage').mockImplementation(async (
      filePath: string,
      limit?: number,
      before?: number | null,
    ) => {
      if (path.resolve(filePath) === path.resolve(mainFile)) throw new Error(privateFailure);
      return originalReadJsonlPage(filePath, limit, before);
    });

    try {
      await bus.enqueue({
        uid: TEST_UID, cid, fromActorId: 'user',
        text: `@${AGENT_NAME} 继续`,
      });
      await waitForQuiescent(TEST_UID, cid);
    } finally {
      canonicalRead.mockRestore();
    }

    expect(cliRunMock.calls).toHaveLength(0);
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      'cli canonical history read failed',
      expect.objectContaining({
        cid: expect.stringMatching(/\.\.\./),
        agent_id: expect.stringMatching(/\.\.\./),
        error: expect.objectContaining({
          name: 'Error',
          message_hash: expect.any(String),
          message_chars: privateFailure.length,
        }),
      }),
    );
    const canonicalLog = loggerMocks.warn.mock.calls.find(
      ([message]) => message === 'cli canonical history read failed',
    );
    expect(JSON.stringify(canonicalLog)).not.toContain(privateFailure);
    expect(JSON.stringify(canonicalLog)).not.toContain(cid);
    expect(JSON.stringify(canonicalLog)).not.toContain(AGENT_ID);
  });

  it('lets a matching Codex thread reuse durable instructions without resending an override', async () => {
    const paths = await import('../../../../src/main/paths');
    const agentFile = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
    const spec = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
    spec.runtime = { kind: 'cli', cli: 'codex' };
    fs.writeFileSync(agentFile, JSON.stringify(spec));
    cliRunMock.nextResult = {
      runId: 'codex-context-run',
      status: 'completed',
      output: 'ok',
      sessionId: 'thread-with-durable-context',
    };

    const bus = await import('../../../../src/main/features/group_chat/bus');
    const cid = 'cid-codex-durable-reuse';
    await bus.enqueue({
      uid: TEST_UID, cid, fromActorId: 'user',
      text: `@${AGENT_NAME} 第一轮`,
    });
    await waitForQuiescent(TEST_UID, cid);
    await bus.enqueue({
      uid: TEST_UID, cid, fromActorId: 'user',
      text: `@${AGENT_NAME} 第二轮`,
    });
    await waitForQuiescent(TEST_UID, cid);

    expect(cliRunMock.calls).toHaveLength(2);
    expect(cliRunMock.calls[0].resumeSessionId).toBeUndefined();
    expect(cliRunMock.calls[0].reuseSessionInstructions).toBe(false);
    expect(cliRunMock.calls[1].resumeSessionId).toBe('thread-with-durable-context');
    expect(cliRunMock.calls[1].reuseSessionInstructions).toBe(true);
    expect(cliRunMock.calls[1].prompt).toBe('第二轮');
  });

  it('resumes a project OpenCode session with fresh memory but without automatically injecting changed backlog records', async () => {
    const paths = await import('../../../../src/main/paths');
    const agentFile = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
    const spec = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
    spec.runtime = { kind: 'cli', cli: 'opencode' };
    fs.writeFileSync(agentFile, JSON.stringify(spec));

    const projects = await import('../../../../src/main/features/projects');
    const createdProject = await projects.createProject(TEST_UID, 'OpenCode dynamic context');
    if (!createdProject.ok) throw new Error('project setup failed');
    const projectId = createdProject.project.project_id;
    await projects.addAgentBinding(TEST_UID, projectId, AGENT_ID);
    const workspace = path.join(tmpDir, 'opencode-dynamic-workspace');
    fs.mkdirSync(workspace, { recursive: true });
    const userWorkspace = await import('../../../../src/main/features/user_workspace');
    expect(userWorkspace.setWorkspacePath(TEST_UID, workspace, projectId).ok).toBe(true);

    const cid = 'cid-opencode-dynamic-context-resume';
    const chats = await import('../../../../src/main/features/chats');
    await chats.createConversation(TEST_UID, {
      conversationId: cid,
      projectId,
      title: 'Dynamic context continuity',
    });
    cliRunMock.nextResult = {
      runId: 'opencode-dynamic-context-run',
      status: 'completed',
      output: 'ok',
      sessionId: 'opencode-dynamic-session',
    };

    const groupChat = await import('../../../../src/main/features/group_chat');
    await groupChat.send({
      userId: TEST_UID,
      cid,
      text: `@${AGENT_NAME} FIRST_DYNAMIC_CONTEXT_TASK`,
    });
    await waitForQuiescent(TEST_UID, cid);

    const memory = await import('../../../../src/main/features/memory');
    const tasks = await import('../../../../src/main/features/project_tasks');
    memory.addEntry(TEST_UID, { project: projectId }, 'DYNAMIC_MEMORY_AFTER_SESSION_START');
    await tasks.createTask(TEST_UID, projectId, { title: 'DYNAMIC_TASK_AFTER_SESSION_START' });

    await groupChat.send({
      userId: TEST_UID,
      cid,
      text: `@${AGENT_NAME} SECOND_DYNAMIC_CONTEXT_TASK`,
    });
    await waitForQuiescent(TEST_UID, cid);

    expect(cliRunMock.calls).toHaveLength(2);
    expect(cliRunMock.calls[1].resumeSessionId).toBe('opencode-dynamic-session');
    expect(cliRunMock.calls[1].prompt).not.toContain('## Project context policy');
    expect(cliRunMock.calls[1].prompt).not.toContain('## User intent and clarification');
    expect(cliRunMock.calls[1].prompt).toContain('DYNAMIC_MEMORY_AFTER_SESSION_START');
    expect(cliRunMock.calls[1].prompt).not.toContain('DYNAMIC_TASK_AFTER_SESSION_START');
    expect(cliRunMock.calls[1].prompt).not.toContain('## Project status');
    expect(await tasks.listTasks(TEST_UID, projectId)).toContainEqual(
      expect.objectContaining({ title: 'DYNAMIC_TASK_AFTER_SESSION_START', status: 'todo' }),
    );
    expect(cliRunMock.calls[1].prompt).toMatch(/SECOND_DYNAMIC_CONTEXT_TASK$/);
    expect(loggerMocks.info).toHaveBeenCalledWith(
      'cli recovery selected',
      expect.objectContaining({
        cli: 'opencode',
        resume_session: true,
        durable_context_mismatch: false,
      }),
    );
  });

  it('supplies only the bounded canonical diff after the last persisted CLI reply', async () => {
    const paths = await import('../../../../src/main/paths');
    const agentFile = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
    const spec = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
    spec.runtime = { kind: 'cli', cli: 'codex' };
    fs.writeFileSync(agentFile, JSON.stringify(spec));
    cliRunMock.nextResult = {
      runId: 'codex-diff-run',
      status: 'completed',
      output: 'FIRST_CLI_REPLY',
      sessionId: 'thread-with-diff-cursor',
    };

    const bus = await import('../../../../src/main/features/group_chat/bus');
    const cid = 'cid-codex-canonical-diff';
    await bus.enqueue({
      uid: TEST_UID, cid, fromActorId: 'user',
      text: `@${AGENT_NAME} FIRST_CLI_TASK`,
    });
    await waitForQuiescent(TEST_UID, cid);

    const mainFile = path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`);
    fs.appendFileSync(mainFile, [
      {
        id: 'interposed-user',
        ts: '2026-08-05T00:00:00.000Z',
        from: 'user',
        to: ['commander'],
        text: 'INTERPOSED_CANONICAL_USER_CONTEXT',
      },
      {
        id: 'interposed-commander',
        ts: '2026-08-05T00:00:01.000Z',
        from: 'commander',
        to: ['user'],
        text: 'INTERPOSED_CANONICAL_COMMANDER_CONTEXT',
      },
    ].map((row) => JSON.stringify(row)).join('\n') + '\n');

    await bus.enqueue({
      uid: TEST_UID, cid, fromActorId: 'user',
      text: `@${AGENT_NAME} SECOND_CLI_TASK`,
    });
    await waitForQuiescent(TEST_UID, cid);

    expect(cliRunMock.calls).toHaveLength(2);
    expect(cliRunMock.calls[1].resumeSessionId).toBe('thread-with-diff-cursor');
    expect(cliRunMock.calls[1].prompt).toContain('## Conversation updates since the previous CLI turn');
    expect(cliRunMock.calls[1].prompt).toContain('INTERPOSED_CANONICAL_USER_CONTEXT');
    expect(cliRunMock.calls[1].prompt).toContain('INTERPOSED_CANONICAL_COMMANDER_CONTEXT');
    expect(cliRunMock.calls[1].prompt).toContain('SECOND_CLI_TASK');
    expect(cliRunMock.calls[1].prompt).not.toContain('FIRST_CLI_TASK');
    expect(cliRunMock.calls[1].prompt).not.toContain('FIRST_CLI_REPLY');
  });

  it('does not advance the CLI history cursor after a failed resumed turn', async () => {
    const paths = await import('../../../../src/main/paths');
    const agentFile = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
    const spec = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
    spec.runtime = { kind: 'cli', cli: 'codex' };
    fs.writeFileSync(agentFile, JSON.stringify(spec));

    const bus = await import('../../../../src/main/features/group_chat/bus');
    const cid = 'cid-codex-failed-diff-cursor';
    cliRunMock.nextResult = {
      runId: 'first-success',
      status: 'completed',
      output: 'FIRST_SUCCESSFUL_REPLY',
      sessionId: 'thread-failure-cursor',
    };
    await bus.enqueue({
      uid: TEST_UID, cid, fromActorId: 'user',
      text: `@${AGENT_NAME} FIRST_SUCCESSFUL_TASK`,
    });
    await waitForQuiescent(TEST_UID, cid);

    cliRunMock.nextResult = {
      runId: 'second-failed',
      status: 'failed',
      error: 'synthetic failure',
      sessionId: 'thread-failure-cursor',
    };
    await bus.enqueue({
      uid: TEST_UID, cid, fromActorId: 'user',
      text: `@${AGENT_NAME} SECOND_TASK_THAT_FAILED`,
    });
    await waitForQuiescent(TEST_UID, cid);

    cliRunMock.nextResult = {
      runId: 'third-success',
      status: 'completed',
      output: 'THIRD_SUCCESSFUL_REPLY',
      sessionId: 'thread-failure-cursor',
    };
    await bus.enqueue({
      uid: TEST_UID, cid, fromActorId: 'user',
      text: `@${AGENT_NAME} THIRD_TASK_AFTER_FAILURE`,
    });
    await waitForQuiescent(TEST_UID, cid);

    expect(cliRunMock.calls).toHaveLength(3);
    expect(cliRunMock.calls[2].resumeSessionId).toBe('thread-failure-cursor');
    expect(cliRunMock.calls[2].prompt).toContain('Conversation updates since the previous CLI turn');
    expect(cliRunMock.calls[2].prompt).toContain('SECOND_TASK_THAT_FAILED');
    expect(cliRunMock.calls[2].prompt).toContain('THIRD_TASK_AFTER_FAILURE');
    expect(cliRunMock.calls[2].prompt).not.toContain('FIRST_SUCCESSFUL_TASK');
  });

  it('reuses a matching user-message session but restarts when durable instructions change', async () => {
    const paths = await import('../../../../src/main/paths');
    const agentFile = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
    const spec = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
    spec.runtime = { kind: 'cli', cli: 'opencode' };
    spec.workflow = 'Initial durable workflow';
    fs.writeFileSync(agentFile, JSON.stringify(spec));
    cliRunMock.nextResult = {
      runId: 'opencode-context-run',
      status: 'completed',
      output: 'ok',
      sessionId: 'opencode-durable-session',
    };

    const bus = await import('../../../../src/main/features/group_chat/bus');
    const cid = 'cid-opencode-durable-change';
    await bus.enqueue({
      uid: TEST_UID, cid, fromActorId: 'user',
      text: `@${AGENT_NAME} 第一轮`,
    });
    await waitForQuiescent(TEST_UID, cid);
    await bus.enqueue({
      uid: TEST_UID, cid, fromActorId: 'user',
      text: `@${AGENT_NAME} 第二轮`,
    });
    await waitForQuiescent(TEST_UID, cid);

    expect(cliRunMock.calls).toHaveLength(2);
    expect(cliRunMock.calls[0].resumeSessionId).toBeUndefined();
    expect(cliRunMock.calls[0].prompt).toContain('Initial durable workflow');
    expect(cliRunMock.calls[1].resumeSessionId).toBe('opencode-durable-session');
    expect(cliRunMock.calls[1].prompt).toBe('第二轮');
    expect(cliRunMock.calls[1].prompt).not.toContain('Initial durable workflow');

    spec.workflow = 'Updated durable workflow';
    fs.writeFileSync(agentFile, JSON.stringify(spec));
    await bus.enqueue({
      uid: TEST_UID, cid, fromActorId: 'user',
      text: `@${AGENT_NAME} 第三轮`,
    });
    await waitForQuiescent(TEST_UID, cid);

    expect(cliRunMock.calls).toHaveLength(3);
    expect(cliRunMock.calls[2].resumeSessionId).toBeUndefined();
    expect(cliRunMock.calls[2].prompt).toContain('Updated durable workflow');
    expect(cliRunMock.calls[2].prompt).not.toContain('Initial durable workflow');
    expect(cliRunMock.calls[2].prompt).toContain('## Conversation context recovered by Orkas');
    expect(cliRunMock.calls[2].prompt).toContain('第三轮');
  });

  it('does not mark a fresh user-message slash session as durably bootstrapped', async () => {
    const paths = await import('../../../../src/main/paths');
    const agentFile = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
    const spec = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
    spec.runtime = { kind: 'cli', cli: 'opencode' };
    fs.writeFileSync(agentFile, JSON.stringify(spec));
    cliRunMock.nextResult = {
      runId: 'opencode-slash-run',
      status: 'completed',
      output: 'ok',
      sessionId: 'slash-only-session',
    };

    const bus = await import('../../../../src/main/features/group_chat/bus');
    const sessions = await import('../../../../src/main/features/local_agents/sessions');
    const cid = 'cid-opencode-fresh-slash';
    await bus.enqueue({
      uid: TEST_UID, cid, fromActorId: 'user',
      text: `@${AGENT_NAME} /compact`,
    });
    await waitForQuiescent(TEST_UID, cid);

    expect(cliRunMock.calls).toHaveLength(1);
    expect(cliRunMock.calls[0].prompt).toBe('/compact');
    const slashBinding = await sessions.getBinding(TEST_UID, cid, AGENT_ID, 'opencode');
    expect(slashBinding?.sessionId).toBe('slash-only-session');
    expect(slashBinding?.durableContextHash).toBeUndefined();
    expect(slashBinding?.contextProtocolVersion).toBeUndefined();

    await bus.enqueue({
      uid: TEST_UID, cid, fromActorId: 'user',
      text: `@${AGENT_NAME} 继续普通任务`,
    });
    await waitForQuiescent(TEST_UID, cid);

    expect(cliRunMock.calls).toHaveLength(2);
    expect(cliRunMock.calls[1].resumeSessionId).toBeUndefined();
    expect(cliRunMock.calls[1].prompt).toContain(`You are "${AGENT_NAME}".`);
    expect(cliRunMock.calls[1].prompt).toContain('继续普通任务');
  });

  it('does not mark a fresh Codex slash session as synchronized with Agent memory', async () => {
    const paths = await import('../../../../src/main/paths');
    const agentFile = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
    const spec = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
    spec.runtime = { kind: 'cli', cli: 'codex' };
    fs.writeFileSync(agentFile, JSON.stringify(spec));
    cliRunMock.nextResult = {
      runId: 'codex-slash-run',
      status: 'completed',
      output: 'ok',
      sessionId: 'codex-slash-only-session',
    };

    const bus = await import('../../../../src/main/features/group_chat/bus');
    const sessions = await import('../../../../src/main/features/local_agents/sessions');
    const cid = 'cid-codex-fresh-slash-memory';
    await bus.enqueue({
      uid: TEST_UID, cid, fromActorId: 'user',
      text: `@${AGENT_NAME} /compact`,
    });
    await waitForQuiescent(TEST_UID, cid);

    expect(cliRunMock.calls).toHaveLength(1);
    expect(cliRunMock.calls[0].prompt).toBe('/compact');
    const slashBinding = await sessions.getBinding(TEST_UID, cid, AGENT_ID, 'codex');
    expect(slashBinding?.sessionId).toBe('codex-slash-only-session');
    expect(slashBinding?.agentMemoryHash).toBeUndefined();

    await bus.enqueue({
      uid: TEST_UID, cid, fromActorId: 'user',
      text: `@${AGENT_NAME} 继续普通任务`,
    });
    await waitForQuiescent(TEST_UID, cid);

    expect(cliRunMock.calls).toHaveLength(2);
    expect(cliRunMock.calls[1].resumeSessionId).toBeUndefined();
    expect(cliRunMock.calls[1].prompt).toContain('## Conversation context recovered by Orkas');
    expect(cliRunMock.calls[1].prompt).toContain('继续普通任务');
    expect(await sessions.getBinding(TEST_UID, cid, AGENT_ID, 'codex')).toMatchObject({
      sessionId: 'codex-slash-only-session',
      agentMemoryHash: expect.any(String),
    });
  });

  it('builds a fresh CLI session from canonical history and ignores an existing legacy visibility file', async () => {
    const paths = await import('../../../../src/main/paths');
    const agentFile = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
    const spec = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
    spec.runtime = { kind: 'cli', cli: 'codex' };
    fs.writeFileSync(agentFile, JSON.stringify(spec));

    const cid = 'cid-coding-bridge';
    const bus = await import('../../../../src/main/features/group_chat/bus');
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: 'PASS_WHEN_FRESH_WITH_PRIOR_CONTEXT',
    });
    await waitForQuiescent(TEST_UID, cid);
    const legacyVisibilityFile = path.join(
      paths.userChatsDir(TEST_UID), cid, 'visibility', `${AGENT_ID}.jsonl`,
    );
    fs.mkdirSync(path.dirname(legacyVisibilityFile), { recursive: true });
    const legacyVisibilityText = `${JSON.stringify({
      id: 'legacy-private-row',
      ts: '2026-05-19T00:00:00.000Z',
      from: 'user',
      to: [AGENT_ID],
      text: 'LEGACY_VISIBILITY_MUST_NOT_REACH_MODEL',
    })}\n`;
    fs.writeFileSync(legacyVisibilityFile, legacyVisibilityText);
    await bus.enqueue({
      uid: TEST_UID, cid, fromActorId: 'user',
      text: `@${AGENT_NAME} 换目录后继续`,
    });
    await waitForQuiescent(TEST_UID, cid);

    expect(cliRunMock.calls).toHaveLength(1);
    expect(cliRunMock.calls[0].resumeSessionId).toBeUndefined();
    expect(cliRunMock.calls[0].prompt).toContain('## Conversation context recovered by Orkas');
    expect(cliRunMock.calls[0].prompt).toContain('PASS_WHEN_FRESH_WITH_PRIOR_CONTEXT');
    expect(cliRunMock.calls[0].prompt).toContain('换目录后继续');
    expect(cliRunMock.calls[0].prompt).not.toContain('LEGACY_VISIBILITY_MUST_NOT_REACH_MODEL');
    expect(fs.readFileSync(legacyVisibilityFile, 'utf8')).toBe(legacyVisibilityText);
  });

  it('starts a fresh CLI session for an explicit failed-turn restart', async () => {
    const paths = await import('../../../../src/main/paths');
    const agentFile = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
    const spec = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
    spec.runtime = { kind: 'cli', cli: 'codex' };
    fs.writeFileSync(agentFile, JSON.stringify(spec));

    const cid = 'cid-coding-explicit-restart';
    const mainFile = path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`);
    fs.mkdirSync(path.dirname(mainFile), { recursive: true });
    fs.writeFileSync(mainFile, [
      { id: 'older-history', from: 'user', to: [AGENT_ID], text: 'KEEP_CONTEXT_BEFORE_ATTEMPT' },
      { id: 'retry-source', from: 'user', to: [AGENT_ID], text: 'OLD_FAILED_REQUEST' },
      { id: 'retry-failure', from: AGENT_ID, to: ['user'], text: 'DO_NOT_REPLAY_FAILED_ATTEMPT' },
    ].map((row) => JSON.stringify({ ...row, ts: '2026-05-19T00:00:00.000Z' })).join('\n') + '\n');
    const sessions = await import('../../../../src/main/features/local_agents/sessions');
    await sessions.setSessionId(TEST_UID, cid, AGENT_ID, 'codex', 'stale-thread', {
      sourceMessageId: 'retry-source',
    });

    const bus = await import('../../../../src/main/features/group_chat/bus');
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `@${AGENT_NAME} Continue`,
      model_text: 'AUTHORITATIVE_RESTART_TASK',
      forceTo: [AGENT_ID],
      failedTurnRetryMode: 'restart',
      retrySourceMessageId: 'retry-source',
    });
    await waitForQuiescent(TEST_UID, cid);

    expect(cliRunMock.calls).toHaveLength(1);
    expect(cliRunMock.calls[0].resumeSessionId).toBeUndefined();
    expect(cliRunMock.calls[0].prompt).toContain('AUTHORITATIVE_RESTART_TASK');
    expect(cliRunMock.calls[0].prompt).toContain('KEEP_CONTEXT_BEFORE_ATTEMPT');
    expect(cliRunMock.calls[0].prompt).not.toContain('DO_NOT_REPLAY_FAILED_ATTEMPT');
    expect(await sessions.getSessionId(TEST_UID, cid, AGENT_ID, 'codex')).toBeNull();
  });

  it('does not trust a legacy binding without provenance during an explicit retry resume', async () => {
    const paths = await import('../../../../src/main/paths');
    const agentFile = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
    const spec = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
    spec.runtime = { kind: 'cli', cli: 'codex' };
    fs.writeFileSync(agentFile, JSON.stringify(spec));

    const cid = 'cid-coding-resume-legacy-binding';
    const mainFile = path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`);
    fs.mkdirSync(path.dirname(mainFile), { recursive: true });
    fs.writeFileSync(mainFile, JSON.stringify({
      id: 'retry-source',
      ts: '2026-05-19T00:00:00.000Z',
      from: 'user',
      to: [AGENT_ID],
      text: 'LEGACY_RETRY_CONTEXT',
    }) + '\n');
    const sessions = await import('../../../../src/main/features/local_agents/sessions');
    // Old records have no sourceMessageId, so they cannot be proven to own
    // the failed bubble selected by this explicit retry.
    await sessions.setSessionId(TEST_UID, cid, AGENT_ID, 'codex', 'legacy-thread');

    const bus = await import('../../../../src/main/features/group_chat/bus');
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `@${AGENT_NAME} Continue`,
      model_text: 'AUTHORITATIVE_RESUME_TASK',
      forceTo: [AGENT_ID],
      failedTurnRetryMode: 'resume',
      retrySourceMessageId: 'retry-source',
      resumeActiveTurn: true,
    });
    await waitForQuiescent(TEST_UID, cid);

    expect(cliRunMock.calls).toHaveLength(1);
    expect(cliRunMock.calls[0].resumeSessionId).toBeUndefined();
    expect(cliRunMock.calls[0].prompt).toContain('LEGACY_RETRY_CONTEXT');
    expect(cliRunMock.calls[0].prompt).toContain('AUTHORITATIVE_RESUME_TASK');
    expect(await sessions.getSessionId(TEST_UID, cid, AGENT_ID, 'codex')).toBeNull();
  });

  it('ignores unusable Hermes bindings and bridges visible history', async () => {
    const paths = await import('../../../../src/main/paths');
    const agentFile = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
    const spec = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
    spec.runtime = { kind: 'cli', cli: 'hermes' };
    fs.writeFileSync(agentFile, JSON.stringify(spec));

    const cid = 'cid-hermes-history-bridge';
    const mainFile = path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`);
    fs.mkdirSync(path.dirname(mainFile), { recursive: true });
    fs.writeFileSync(mainFile, JSON.stringify({
      id: 'older-history',
      ts: '2026-05-19T00:00:00.000Z',
      from: 'user',
      to: [AGENT_ID],
      text: 'HERMES_MUST_RECEIVE_THIS_HISTORY',
    }) + '\n');
    const sessions = await import('../../../../src/main/features/local_agents/sessions');
    await sessions.setSessionId(TEST_UID, cid, AGENT_ID, 'hermes', 'unusable-acp-session');

    const bus = await import('../../../../src/main/features/group_chat/bus');
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `@${AGENT_NAME} 继续`,
    });
    await waitForQuiescent(TEST_UID, cid);

    expect(cliRunMock.calls).toHaveLength(1);
    expect(cliRunMock.calls[0].resumeSessionId).toBeUndefined();
    expect(cliRunMock.calls[0].prompt).toContain('## Conversation context recovered by Orkas');
    expect(cliRunMock.calls[0].prompt).toContain('HERMES_MUST_RECEIVE_THIS_HISTORY');
    expect(await sessions.getSessionId(TEST_UID, cid, AGENT_ID, 'hermes')).toBeNull();
  });

  it('publishes only the Hermes result and drops private thought events', async () => {
    const paths = await import('../../../../src/main/paths');
    const agentFile = path.join(paths.agentDir(TEST_UID, AGENT_ID), 'agent.json');
    const spec = JSON.parse(fs.readFileSync(agentFile, 'utf8'));
    spec.runtime = { kind: 'cli', cli: 'hermes' };
    fs.writeFileSync(agentFile, JSON.stringify(spec));

    const privateThought = 'PRIVATE_THOUGHT_SENTINEL: apply the hidden KSTAR rubric';
    const rawOutput = [
      'K — 知识',
      '- 用户画像：PRIVATE_PROFILE_SENTINEL',
      'S — 情境',
      '- 用户问候。',
      'T — 任务',
      '- 回复。',
      'Â — 行动',
      '- 组织答案。',
      'R̂ — 预期结果',
      '- 简短公开答复。',
      'R — 结果',
      '你好！今天想一起处理什么？',
      'ΔR — 差距',
      '- 无。',
      'AAR — 复盘',
      '- 完成。',
    ].join('\n');
    cliRunMock.nextEvents.push(
      { type: 'thinking', text: privateThought },
      { type: 'text-delta', text: rawOutput },
    );
    cliRunMock.nextResult = {
      runId: 'hermes-private-output',
      status: 'completed',
      output: rawOutput,
    };

    const cid = 'cid-hermes-public-boundary';
    const events: any[] = [];
    const bus = await import('../../../../src/main/features/group_chat/bus');
    bus.subscribe(TEST_UID, cid, (event) => events.push(event));
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `@${AGENT_NAME} 你好`,
    });
    await waitForQuiescent(TEST_UID, cid);

    const mainFile = path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`);
    const messages = fs.readFileSync(mainFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    const reply = messages.find((message) => message.from === AGENT_ID);
    expect(reply?.text).toBe('你好！今天想一起处理什么？');
    expect(JSON.stringify(reply)).not.toContain('PRIVATE_PROFILE_SENTINEL');
    expect(JSON.stringify(reply)).not.toContain('PRIVATE_THOUGHT_SENTINEL');
    expect(JSON.stringify(events)).not.toContain('PRIVATE_PROFILE_SENTINEL');
    expect(JSON.stringify(events)).not.toContain('PRIVATE_THOUGHT_SENTINEL');
    expect(cliRunMock.calls[0].prompt).toContain('你好');
    expect(cliRunMock.calls[0].prompt).not.toContain(`@${AGENT_NAME}`);
    expect(cliRunMock.calls[0].prompt).not.toContain('Public response boundary');
  });
});

describe('group_chat bus › abort', () => {
  it('flips state.json to aborted + clears the queue', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const state = await import('../../../../src/main/features/group_chat/state');
    bus.subscribe(TEST_UID, TEST_CID, () => {});
    await bus.enqueue({
      uid: TEST_UID, cid: TEST_CID, fromActorId: 'user', text: 'hi',
    });
    await bus.abort(TEST_UID, TEST_CID);
    const st = await state.readState(TEST_UID, TEST_CID);
    expect(st.status).toBe('aborted');
    expect(st.in_flight).toEqual([]);
    await bus.dropConv(TEST_UID, TEST_CID);
  });

  it('persists an interrupted row when phase buffering emitted no process output', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');
    const cid = 'cid-abort-before-phase-boundary';
    cidsToDrop.add(cid);

    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: 'ABORT_WITHOUT_PHASED_OUTPUT_TEST',
    });
    const deadline = Date.now() + 2_000;
    while (!bus.runtimeSnapshot(TEST_UID, cid).activeTurns.length && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(bus.runtimeSnapshot(TEST_UID, cid).activeTurns).toHaveLength(1);

    await bus.abort(TEST_UID, cid);
    const rows = fs.readFileSync(
      path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`),
      'utf8',
    ).trim().split('\n').map((line) => JSON.parse(line));
    const interrupted = rows.find((row: any) => row.from === 'commander');
    expect(interrupted?.text).toBe('Run aborted');
  });
});

describe('group_chat bus › processItemsAreRoutingOnly (abort promotion guard)', () => {
  const toolEvent = (name: string) => ({ type: 'event' as const, event: { stream: 'tool', data: { name } } });
  const cliToolEvent = (tool: string) => ({ type: 'event' as const, event: { stream: 'cli', data: { type: 'tool-event', tool } } });

  it('is routing-only for a prep read + hand_off_to (aborted turn stays silent)', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    expect(bus.processItemsAreRoutingOnly([
      toolEvent('read_files'), toolEvent('read_files'), toolEvent('hand_off_to'),
    ])).toBe(true);
    // Runtime "总耗时" + progress lines (no tool name) are ignored.
    expect(bus.processItemsAreRoutingOnly([
      { type: 'progress', text: 'thinking…' },
      toolEvent('search_files'),
      cliToolEvent('dispatch_to'),
      { type: 'event', event: { stream: 'runtime', data: { phase: 'end' } } },
    ])).toBe(true);
  });

  it('is NOT routing-only when the trail did real work (keeps the persisted bubble)', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    expect(bus.processItemsAreRoutingOnly([toolEvent('plan_set'), toolEvent('hand_off_to')])).toBe(false);
    expect(bus.processItemsAreRoutingOnly([toolEvent('write_file'), toolEvent('hand_off_to')])).toBe(false);
    expect(bus.processItemsAreRoutingOnly([toolEvent('bash'), toolEvent('hand_off_to')])).toBe(false);
  });

  it('is NOT routing-only without a delegation tool (a read-only turn is preserved)', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    expect(bus.processItemsAreRoutingOnly([toolEvent('read_files')])).toBe(false);
    expect(bus.processItemsAreRoutingOnly([{ type: 'progress', text: 'x' }])).toBe(false);
    expect(bus.processItemsAreRoutingOnly([])).toBe(false);
  });
});

describe('deferred user-message bubble (queued-until-execution, 2026-08-27)', () => {
  // Scenario: while an execution runs, a follow-up send must live ONLY on the
  // task board until its own turn starts — the user reads the transcript as
  // "what has actually been said/worked", and a message that may still be
  // cancelled must not sit in it. The board row (instruction text) is the
  // sole surface of a waiting message.
  async function userRowRecords(cid: string): Promise<any[]> {
    const paths = await import('../../../../src/main/paths');
    const file = path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`);
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').trim().split('\n')
      .filter(Boolean).map((line) => JSON.parse(line))
      .filter((row: any) => row.from === 'user');
  }

  async function userRows(cid: string): Promise<string[]> {
    return (await userRowRecords(cid)).map((row: any) => String(row.text));
  }

  /** `nowIso` has second resolution, so a same-second test cannot tell an
   * enqueue stamp from an entry stamp. Park until the wall clock rolls into
   * the next second and return that second's first millisecond. */
  async function crossSecondBoundary(): Promise<number> {
    const startSecond = Math.floor(Date.now() / 1000);
    while (Math.floor(Date.now() / 1000) === startSecond) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return Math.floor(Date.now() / 1000) * 1000;
  }

  it.each(['commander', 'agent'])(
    'keeps slow %s admission distinct from real queuing in both task events and list snapshots', async (recipient) => {
      const storage = await import('../../../../src/main/storage');
      const originalAppend = storage.appendJsonlAtomic;
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let entered: () => void = () => {};
      const started = new Promise<void>((resolve) => { entered = resolve; });
      const append = vi.spyOn(storage, 'appendJsonlAtomic').mockImplementation(async (...args) => {
        entered();
        await gate;
        return originalAppend(...args);
      });
      const bus = await import('../../../../src/main/features/group_chat/bus');
      const cid = `cid-slow-admission-${recipient}`;
      cidsToDrop.add(cid);
      const events: any[] = [];
      const unsubscribe = bus.subscribe(TEST_UID, cid, (event) => events.push(event));
      const sending = bus.enqueue({
        uid: TEST_UID, cid, fromActorId: 'user',
        text: recipient === 'agent' ? `@${AGENT_NAME} ordinary message` : 'ordinary message',
      });
      try {
        await started;
        expect(await userRows(cid)).toEqual([]);
        const rows = await bus.listConversationTasks(TEST_UID, cid);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ status: 'queued', admission_pending: true });
        expect(events.find((event) => event.type === 'task_created')?.task)
          .toMatchObject({ task_id: rows[0].task_id, admission_pending: true });
        expect(events.some((event) => event.type === 'message')).toBe(false);
      } finally {
        release();
        await sending;
        await waitForQuiescent(TEST_UID, cid, 5000);
        append.mockRestore();
        unsubscribe();
      }
      expect(await userRows(cid)).toHaveLength(1);
      expect(events.filter((event) => event.task?.status === 'queued')
        .every((event) => event.task.admission_pending === true)).toBe(true);
      expect((await bus.listConversationTasks(TEST_UID, cid))[0].admission_pending).toBeUndefined();
    },
  );

  it('keeps a queued busy-send out of history until its turn starts, then persists it in execution order', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const taskBoard = await import('../../../../src/main/features/group_chat/task_board');
    const cid = 'cid-deferred-bubble';
    cidsToDrop.add(cid);
    let release: () => void = () => {};
    streamProbe.slowGate = new Promise<void>((resolve) => { release = resolve; });
    try {
      await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'DEFERRED_SLOW_TURN_TEST first' });
      // Idle send executed immediately → persisted before enqueue returned.
      expect(await userRows(cid)).toEqual(['DEFERRED_SLOW_TURN_TEST first']);

      await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'queued follow-up text' });
      // Busy send: board row exists, history does NOT.
      expect(await userRows(cid)).toEqual(['DEFERRED_SLOW_TURN_TEST first']);
      const rows = await taskBoard.listTasks(TEST_UID, cid);
      const queued = rows.find((t) => t.status === 'queued');
      expect(queued?.instruction).toBe('queued follow-up text');
      expect(queued?.admission_pending).toBeUndefined();
    } finally {
      release();
      streamProbe.slowGate = null;
    }
    await waitForQuiescent(TEST_UID, cid, 5000);
    // Admission persisted the message before its turn ran.
    expect(await userRows(cid)).toEqual(['DEFERRED_SLOW_TURN_TEST first', 'queued follow-up text']);
  });

  it('does not start the admitted turn when Stop lands while its bubble is being persisted', async () => {
    // The admitted item sits in neither `queue` nor `executions` while the
    // deferred bubble persists; a whole-conversation Stop in that window
    // used to be outrun by `_startExecution`, leaving a fresh turn running
    // on a sticky 'aborted' conversation (2026-08-28 review A-1).
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const taskBoard = await import('../../../../src/main/features/group_chat/task_board');
    const paths = await import('../../../../src/main/paths');
    const cid = 'cid-deferred-stop-window';
    cidsToDrop.add(cid);
    let releaseTurn: () => void = () => {};
    streamProbe.slowGate = new Promise<void>((resolve) => { releaseTurn = resolve; });
    let releasePersist: () => void = () => {};
    const persistGate = new Promise<void>((resolve) => { releasePersist = resolve; });
    let persistStarted: () => void = () => {};
    const persistStartedGate = new Promise<void>((resolve) => { persistStarted = resolve; });
    try {
      await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'DEFERRED_SLOW_TURN_TEST first' });
      await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'stopped while persisting' });
      const state = bus._cidStateForTest(TEST_UID, cid)!;
      const queued = state.queue.find((it: any) => it.deferredBubble)!;
      const original = queued.deferredBubble!.persist;
      queued.deferredBubble = {
        persist: async () => { persistStarted(); await persistGate; return original(); },
      };
    } finally {
      releaseTurn();
      streamProbe.slowGate = null;
    }
    await persistStartedGate; // admission claimed the item and is inside the persist await
    const stopping = bus.abort(TEST_UID, cid); // epoch bumps synchronously; abort waits for quiescence
    releasePersist();
    await stopping;
    await waitForQuiescent(TEST_UID, cid, 5000);

    // The bubble entered history (its work "started"), but no turn ran on it.
    const file = path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`);
    const rows = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const followUpAt = rows.findIndex((row: any) => row.text === 'stopped while persisting');
    expect(followUpAt).toBeGreaterThan(0);
    expect(rows.slice(followUpAt + 1).filter((row: any) => row.from !== 'user')).toEqual([]);
    const board = await taskBoard.listTasks(TEST_UID, cid);
    expect(board.find((t) => t.instruction === 'stopped while persisting')?.status).toBe('cancelled');
  });

  it('stamps a queued send with its entry time, not its enqueue time', async () => {
    // Regression (on-device 2026-08-28): the row was appended after the reply
    // it waited on but kept the enqueue stamp, so every ts-ordered reader
    // (renderer live insert, history load's defensive sort) hoisted the bubble
    // back above that reply — two user bubbles stacked over a single answer.
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const cid = 'cid-deferred-bubble-ts';
    cidsToDrop.add(cid);
    let release: () => void = () => {};
    streamProbe.slowGate = new Promise<void>((resolve) => { release = resolve; });
    let entryBoundaryMs = 0;
    try {
      await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'DEFERRED_SLOW_TURN_TEST hold ts' });
      await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'queued row stamped at entry' });
      entryBoundaryMs = await crossSecondBoundary();
    } finally {
      release();
      streamProbe.slowGate = null;
    }
    await waitForQuiescent(TEST_UID, cid, 5000);

    const queuedRow = (await userRowRecords(cid))
      .find((row: any) => row.text === 'queued row stamped at entry');
    expect(queuedRow).toBeTruthy();
    // Local-time ISO without an offset parses as local time — same clock the
    // writer stamped from.
    expect(Date.parse(String(queuedRow.ts))).toBeGreaterThanOrEqual(entryBoundaryMs);
  });

  it('a cancelled queued send never enters history; its text survives on the cancelled row', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const taskBoard = await import('../../../../src/main/features/group_chat/task_board');
    const cid = 'cid-deferred-cancel';
    cidsToDrop.add(cid);
    let release: () => void = () => {};
    streamProbe.slowGate = new Promise<void>((resolve) => { release = resolve; });
    try {
      await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'DEFERRED_SLOW_TURN_TEST hold' });
      await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'message that must never send' });
      const rows = await taskBoard.listTasks(TEST_UID, cid);
      const queued = rows.find((t) => t.status === 'queued');
      expect(queued).toBeTruthy();

      const cancel = await bus.cancelConversationTask(TEST_UID, cid, queued!.task_id);
      expect(cancel).toMatchObject({ ok: true, scope: 'queued' });
    } finally {
      release();
      streamProbe.slowGate = null;
    }
    await waitForQuiescent(TEST_UID, cid, 5000);
    // The message never happened in the conversation; the cancelled row keeps
    // its text as the record of what was withdrawn.
    expect(await userRows(cid)).toEqual(['DEFERRED_SLOW_TURN_TEST hold']);
    const after = await taskBoard.listTasks(TEST_UID, cid);
    const cancelled = after.find((t) => t.status === 'cancelled');
    expect(cancelled?.instruction).toBe('message that must never send');
    expect(streamProbe.messages.join('\n')).not.toContain('message that must never send');
  });

  it('board send-now persists the queued message at the fold and absorbs its row', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const taskBoard = await import('../../../../src/main/features/group_chat/task_board');
    const cid = 'cid-deferred-send-now';
    cidsToDrop.add(cid);
    let release: () => void = () => {};
    streamProbe.slowGate = new Promise<void>((resolve) => { release = resolve; });
    try {
      // Commander turns are always steerable (in-process runtime).
      await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'DEFERRED_SLOW_TURN_TEST live' });
      await bus.enqueue({ uid: TEST_UID, cid, fromActorId: 'user', text: 'fold me into the live turn' });
      const rows = await taskBoard.listTasks(TEST_UID, cid);
      const queued = rows.find((t) => t.status === 'queued');
      expect(queued).toBeTruthy();

      const res = await bus.sendConversationTaskNow(TEST_UID, cid, queued!.task_id);
      expect(res).toMatchObject({ ok: true });
      // Send-now IS the start of execution (D21): the message persists right
      // here, while the live turn is still running. The board row survives as
      // the durable record and settles through the absorbed/leftover path.
      expect(await userRows(cid)).toEqual([
        'DEFERRED_SLOW_TURN_TEST live',
        'fold me into the live turn',
      ]);
    } finally {
      release();
      streamProbe.slowGate = null;
    }
    await waitForQuiescent(TEST_UID, cid, 5000);
    // Whether the fold landed mid-turn or the leftover claimed its own turn,
    // the message is delivered exactly once, history holds both rows, and the
    // promoted task reaches a terminal state instead of ghosting as queued.
    expect(await userRows(cid)).toEqual([
      'DEFERRED_SLOW_TURN_TEST live',
      'fold me into the live turn',
    ]);
    const settled = await taskBoard.listTasks(TEST_UID, cid);
    const promoted = settled.find((t) => t.instruction === 'fold me into the live turn');
    expect(['done', 'stopped', 'failed', 'cancelled']).toContain(promoted?.status);
  });

  it('cancels every parallel recipient when their shared bubble cannot persist', async () => {
    const storage = await import('../../../../src/main/storage');
    const append = vi.spyOn(storage, 'appendJsonlAtomic')
      .mockRejectedValueOnce(new Error('injected deferred history failure'));
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const taskBoard = await import('../../../../src/main/features/group_chat/task_board');
    const cid = 'cid-deferred-shared-persist-failure';
    cidsToDrop.add(cid);

    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `@指挥官 inspect persistence @${AGENT_NAME} do not execute`,
      multiDispatch: 'parallel',
    });
    await waitForQuiescent(TEST_UID, cid, 5000);
    append.mockRestore();

    expect(await userRows(cid)).toEqual([]);
    expect(streamProbe.messages.join('\n')).not.toContain('inspect persistence');
    expect(streamProbe.messages.join('\n')).not.toContain('do not execute');
    const rows = await taskBoard.listTasks(TEST_UID, cid);
    expect(rows.filter((task) => task.source_msg_id).map((task) => task.status))
      .toEqual(['cancelled', 'cancelled']);
  });
});

describe('D22 segmentation: commander segments (2026-08-27)', () => {
  // An unaddressed first instruction belongs to the default recipient.
  // Both implicit and explicit Commander segments precede the Agent's own
  // instruction without broadcasting the full text to either recipient.
  async function boardRows(cid: string) {
    const taskBoard = await import('../../../../src/main/features/group_chat/task_board');
    return taskBoard.listTasks(TEST_UID, cid);
  }

  it('dispatches a substantive preamble to Commander before the mentioned Agent segment', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const cid = 'cid-d22-preamble';
    cidsToDrop.add(cid);
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `写一个登录页 @${AGENT_NAME} 出这个页面的视觉稿`,
    });
    await waitForQuiescent(TEST_UID, cid, 5000);

    const rows = await boardRows(cid);
    const commanderRow = rows.find((t) => t.assignee === 'commander');
    const agentRow = rows.find((t) => t.assignee === AGENT_ID);
    expect(commanderRow?.instruction).toBe('写一个登录页');
    expect(commanderRow?.after).toBeUndefined();
    expect(agentRow?.instruction).toBe('出这个页面的视觉稿');
    expect(agentRow?.after).toBe(commanderRow?.task_id);
  });

  it('an explicit @指挥官 mention segments instead of broadcasting the full text', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const cid = 'cid-d22-mixed';
    cidsToDrop.add(cid);
    await bus.enqueue({
      uid: TEST_UID,
      cid,
      fromActorId: 'user',
      text: `@指挥官 总结一下现状 @${AGENT_NAME} 跑一遍回归`,
    });
    await waitForQuiescent(TEST_UID, cid, 5000);

    const rows = await boardRows(cid);
    const commanderRow = rows.find((t) => t.assignee === 'commander');
    const agentRow = rows.find((t) => t.assignee === AGENT_ID);
    // Each actor got ONLY its own span — no same-text broadcast.
    expect(commanderRow?.instruction).toBe('总结一下现状');
    expect(agentRow?.instruction).toBe('跑一遍回归');
    expect(agentRow?.after).toBe(commanderRow?.task_id);
  });
});

// The counts exist because a long turn's closing summary is written from a
// bounded view of its own work. The threshold is what keeps them from becoming
// wallpaper on every short reply, so both sides of it are worth pinning.
describe('turn execution facts', () => {
  const toolStart = (name: string) => ({
    type: 'event' as const,
    event: { stream: 'tool', data: { name, phase: 'start' } },
  });
  const toolEnd = (name: string) => ({
    type: 'event' as const,
    event: { stream: 'tool', data: { name, phase: 'end' } },
  });
  const compactionDone = () => ({
    type: 'event' as const,
    event: { stream: 'context', data: { phase: 'active_process_compaction_done' } },
  });

  async function summarize(items: unknown[]) {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    return bus.summarizeTurnExecution(items as never);
  }

  it('classifies a long turn and counts each call once', async () => {
    const items = [
      ...Array.from({ length: 12 }, () => toolStart('read_files')),
      ...Array.from({ length: 12 }, () => toolEnd('read_files')),
      ...Array.from({ length: 6 }, () => toolStart('edit_file')),
      ...Array.from({ length: 3 }, () => toolStart('bash')),
      toolStart('some_unclassified_tool'),
      compactionDone(),
      compactionDone(),
    ];

    expect(await summarize(items)).toEqual({
      // `end` events must not double-count, and an unclassified tool still
      // belongs in the total the user is being shown.
      tool_calls: 22,
      reads: 12,
      writes: 6,
      commands: 3,
      compactions: 2,
    });
  });

  it('stays silent on a turn short enough to read in full', async () => {
    const items = Array.from({ length: 19 }, () => toolStart('read_files'));
    expect(await summarize(items)).toBeNull();
  });

  it('counts library and chat_history calls as reads', async () => {
    // A research turn reads mostly through the Library and prior conversation;
    // the facts under-reported such a turn when only workspace readers counted.
    const items = [
      ...Array.from({ length: 10 }, () => toolStart('library')),
      ...Array.from({ length: 10 }, () => toolStart('chat_history')),
      ...Array.from({ length: 3 }, () => toolStart('web_fetch')),
    ];
    expect(await summarize(items)).toEqual({
      tool_calls: 23, reads: 23, writes: 0, commands: 0, compactions: 0,
    });
  });

  it('counts skill_search and dispatch_to calls in the total only', async () => {
    const items = [
      ...Array.from({ length: 15 }, () => toolStart('skill_search')),
      ...Array.from({ length: 5 }, () => toolStart('dispatch_to')),
      toolStart('bash'),
    ];
    expect(await summarize(items)).toEqual({
      tool_calls: 21, reads: 0, writes: 0, commands: 1, compactions: 0,
    });
  });

  it('reports a short turn whose context was compacted', async () => {
    // Compaction is the signal that matters even at low call counts: it is the
    // point where the model stopped being able to see its own earlier work.
    const facts = await summarize([toolStart('bash'), compactionDone()]);
    expect(facts).toMatchObject({ tool_calls: 1, commands: 1, compactions: 1 });
  });

  it('counts a coding CLI agent\'s tool events too', async () => {
    const items = Array.from({ length: 20 }, () => ({
      type: 'event' as const,
      event: { stream: 'cli', data: { type: 'tool-event', tool: 'write_file', phase: 'start' } },
    }));
    expect(await summarize(items)).toMatchObject({ tool_calls: 20, writes: 20 });
  });
});


describe('execution facts reach the persisted reply', () => {
  it('attaches host counts to a long turn and leaves a short one clean', async () => {
    const bus = await import('../../../../src/main/features/group_chat/bus');
    const paths = await import('../../../../src/main/paths');

    const readFacts = async (cid: string, calls: number) => {
      await bus.enqueue({
        uid: TEST_UID,
        cid,
        fromActorId: 'user',
        text: `RUN_FACTS_TEST:${Buffer.from(JSON.stringify({ calls })).toString('base64')}`,
      });
      await waitForQuiescent(TEST_UID, cid);
      const file = path.join(paths.userChatsDir(TEST_UID), `${cid}.jsonl`);
      const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      return rows.find((row: any) => row.from === 'commander')?.run_facts;
    };

    // The claim in the mock's reply is "done and verified" either way; only the
    // host's own count separates the turn that can be read in full from the one
    // whose summary is standing in for work the user never saw.
    expect(await readFacts('cid-facts-long', 24)).toMatchObject({ tool_calls: 24, reads: 24 });
    expect(await readFacts('cid-facts-short', 3)).toBeUndefined();
  });
});
