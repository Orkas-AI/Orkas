import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { drainMainRuntimeForTest } from '../../../helpers/drain-main-runtime';
import { checkLatencyBudget, FIRST_REQUEST_LATENCY_LIMIT_MS, type LatencySample } from '../../../helpers/latency-budget';

// Measure the real send -> bus -> client -> Runner -> SDK fetch path. Only the external
// model response is simulated; configuration, connectors, sessions, and tools stay real.
const logs = vi.hoisted(() => [] as Array<{
  level: string; message: string; at: number; payload?: Record<string, unknown>;
}>);
vi.mock('../../../../src/main/logger', () => ({
  createLogger: () => Object.fromEntries(['debug', 'info', 'warn', 'error'].map(level => [
    level, (message: string, payload?: Record<string, unknown>) => logs.push({
      level, message, at: performance.now(), payload,
    }),
  ])),
}));
vi.mock('../../../../src/main/features/local_agents/registry', async (original) => ({
  ...await original<typeof import('../../../../src/main/features/local_agents/registry')>(),
  resolveCliForDispatch: async (type: string) => ({ type, available: true, path: process.execPath, version: '2.0.0' }),
}));
vi.mock('../../../../src/main/features/local_agents/backends/claude', () => ({
  claudeBackend: { run: async (opts: any) => completeCliDispatch(opts) },
}));
vi.mock('../../../../src/main/features/local_agents/backends/codex', () => ({
  codexBackend: { run: async (opts: any) => completeCliDispatch(opts) },
}));

const UID = 'send-latency';
const AGENT_ID = 'latency-agent';
const BUDGET_MS = FIRST_REQUEST_LATENCY_LIMIT_MS;
let chats: typeof import('../../../../src/main/features/chats');
let groupChat: typeof import('../../../../src/main/features/group_chat');
let bus: typeof import('../../../../src/main/features/group_chat/bus');
let state: typeof import('../../../../src/main/features/group_chat/state');
let paths: typeof import('../../../../src/main/paths');
let storage: typeof import('../../../../src/main/storage');
const cids: string[] = [];
let onRequest: ((body: Record<string, any>) => void) | undefined;
const unexpectedRequests: string[] = [];

function completeCliDispatch(opts: any): void {
  // External CLI startup/network timing belongs to that executable. The host budget
  // ends after the real runner has prepared persistence, context, and its live bridge.
  const bridgeEnv = JSON.parse(fs.readFileSync(opts.bridge.server.env.ORKAS_BRIDGE_ENV_FILE, 'utf8'));
  expect(bridgeEnv.ORKAS_BRIDGE_CAPABILITIES).toContain('chat.read');
  onRequest?.({ messages: [{ role: 'user', content: opts.prompt }] });
  opts.onEvent({ type: 'done', status: 'completed', output: 'Ready.', durationMs: 1 });
}

function modelResponse(): Response {
  const events = [
    { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'claude-sonnet-5', content: [], stop_reason: null, usage: { input_tokens: 20, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Ready.' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ];
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream' },
  });
}

beforeAll(async () => {
  // Vitest's source transformation is harness startup, outside the loaded-app send budget.
  const { installSdkTimeoutPatch } = await import('../../../../src/main/model/core-agent/sdk-timeout-patch');
  installSdkTimeoutPatch();
  await import('#core-agent');
  await import('../../../../src/main/model/client');
  await import('../../../../src/main/features/local_agents/runner');
  await import('../../../../src/main/features/local_agents/bridge');
  // Chats and Commander use CJS cycle-breaking paths in production. Vitest's
  // separate ESM graph would otherwise recompile the bus on the first send.
  // No send is warmed up. Fixtures are written after module loading, so their
  // first reads and all request preparation remain inside the budget.
  const require = createRequire(import.meta.url);
  require('../../../../src/main/features/packages');
  require('../../../../src/main/features/group_chat/bus');
  [chats, groupChat, bus, state, paths, storage] = await Promise.all([
    import('../../../../src/main/features/chats'),
    import('../../../../src/main/features/group_chat'),
    import('../../../../src/main/features/group_chat/bus'),
    import('../../../../src/main/features/group_chat/state'),
    import('../../../../src/main/paths'),
    import('../../../../src/main/storage'),
  ]);
  vi.stubEnv('ORKAS_MODEL_EVAL_GLOBAL_SKILLS_ROOT', path.join(paths.WS_ROOT, 'fixture-global-skills'));
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname !== 'api.anthropic.com' || url.pathname !== '/v1/messages') {
      unexpectedRequests.push(url.origin + url.pathname);
      throw new Error('Unexpected outbound request in send latency test');
    }
    const body = JSON.parse(input instanceof Request ? await input.text() : String(init?.body));
    onRequest?.(body);
    return modelResponse();
  });
  const users = await import('../../../../src/main/features/users');
  users.activateUser(UID);
  const auth = await import('../../../../src/main/features/auth');
  await auth.addApiKeyEntry('anthropic', 'claude-sonnet-5', 'fixture-not-a-real-api-key');
  storage.writeJsonSync(path.join(paths.agentDir(UID, AGENT_ID), 'agent.json'), {
    agent_id: AGENT_ID, name: 'Latency Agent', description: 'Fixture assistant',
    workflow: 'Answer the user.', created_at: '2026-09-12', updated_at: '2026-09-12',
  });
}, 60_000);

afterEach(async () => {
  onRequest = undefined;
  for (const cid of cids.splice(0)) await bus.dropConv(UID, cid);
  vi.restoreAllMocks();
  expect(unexpectedRequests).toEqual([]);
  const failures = logs.filter(row => row.level === 'warn' || row.level === 'error');
  logs.length = 0;
  expect(failures).toEqual([]);
});

afterAll(async () => {
  await drainMainRuntimeForTest();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function seedConnectors(count: number): void {
  const catalog = Array.from({ length: 133 }, (_, index) => ({
    id: `latency-service-${index}`, display_name: `Service ${index}`, category: 'productivity',
    auth_mode: 'mcp_dcr', icon_svg: `<svg>${'x'.repeat(28_000)}</svg>`,
    transport_template: { kind: 'streamable-http', url: 'https://example.com/mcp' },
  }));
  storage.writeJsonSync(paths.userRemoteConfigFile(UID), { active: { immediate: { 'connectors.catalog': catalog } } });
  storage.writeJsonSync(paths.userConnectorsConfigFile(UID), {
    version: 2, oauth_hints: {}, _deleted_at: {},
    connections: Object.fromEntries(catalog.slice(0, count).map(entry => [entry.id, {
      id: entry.id, origin: 'catalog', display_name: entry.display_name, transport: null,
      status: { kind: 'connected', since: 1 }, enabled_subtools: null,
      tools_cache: Array.from({ length: 20 }, (_, index) => ({
        name: `read_items_${index}`, description: 'Read items',
        inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'q'.repeat(4_000) } } },
      })),
      created_at: '2026-09-12T00:00:00Z', updated_at: '2026-09-12T00:00:00Z',
    }])),
  });
}

async function sendUntilRequest(cid: string): Promise<LatencySample & { body: Record<string, any> }> {
  let received: { elapsedMs: number; body: Record<string, any> } | undefined;
  const startedAt = performance.now();
  onRequest = body => { received ??= { elapsedMs: performance.now() - startedAt, body }; };
  const sent = await groupChat.send({ userId: UID, cid, text: 'Hello.' });
  expect(sent.ok).toBe(true);
  // A generous completion deadline prevents hangs; the first-fetch budget is asserted
  // separately using a monotonic clock, so synchronous stalls cannot evade a timer race.
  await vi.waitFor(() => {
    expect(received, 'send must reach the model transport').toBeDefined();
    expect(bus.isQuiescent(UID, cid)).toBe(true);
  }, { timeout: 5_000, interval: 10 });
  onRequest = undefined;
  const phases = new Set(['group message enqueued', 'model turn queued', 'model turn build start', 'model turn ready', 'model turn run start']);
  return {
    ...received!,
    phases: logs
      .filter(row => row.at >= startedAt && row.at <= startedAt + received!.elapsedMs && phases.has(row.message))
      .map(row => ({ phase: row.message, ms: row.at - startedAt })),
  };
}

describe('initial model request latency', () => {
  it.each([
    ['commander', 0], ['commander', 10], ['agent', 10],
  ] as const)(`%s reaches the model within ${BUDGET_MS} ms with %i connectors on first and repeated sends`, async (actor, count) => {
    const conversation = await chats.createConversation(UID, { title: 'Latency fixture' });
    const cid = conversation.conversation_id;
    cids.push(cid);
    if (actor === 'agent') {
      await state.addMember(UID, cid, { id: AGENT_ID, name: 'Latency Agent', kind: 'agent' });
      await state.setActiveRecipient(UID, cid, AGENT_ID, 'user_selection');
    }
    seedConnectors(count);
    const samples: number[] = [];
    for (let turn = 0; turn < 3; turn++) {
      const result = await sendUntilRequest(cid);
      samples.push(result.elapsedMs);
      expect(result.body.messages.length).toBeGreaterThan(0);
      checkLatencyBudget('send to first model request', result, BUDGET_MS);
    }
    console.log('[send-latency]', JSON.stringify({ actor, connectors: count, budget_ms: BUDGET_MS, samples_ms: samples }));
  });

  it.each(['claude', 'codex'] as const)(`%s prepares the real CLI bridge within ${BUDGET_MS} ms on first and repeated sends`, async cli => {
    const agentId = `latency-${cli}`;
    storage.writeJsonSync(path.join(paths.agentDir(UID, agentId), 'agent.json'), {
      agent_id: agentId, name: `Latency ${cli}`, description: 'Fixture CLI assistant',
      workflow: 'Answer the user.', runtime: { kind: 'cli', cli },
      created_at: '2026-09-12', updated_at: '2026-09-12',
    });
    const conversation = await chats.createConversation(UID, { title: 'CLI latency fixture' });
    const cid = conversation.conversation_id;
    cids.push(cid);
    await state.addMember(UID, cid, { id: agentId, name: `Latency ${cli}`, kind: 'agent' });
    await state.setActiveRecipient(UID, cid, agentId, 'user_selection');
    seedConnectors(10);
    const samples: number[] = [];
    for (let turn = 0; turn < 3; turn++) {
      const result = await sendUntilRequest(cid);
      samples.push(result.elapsedMs);
      checkLatencyBudget('send to CLI backend dispatch', result, BUDGET_MS);
    }
    console.log('[send-latency]', JSON.stringify({ actor: cli, boundary: 'CLI backend dispatch', connectors: 10, budget_ms: BUDGET_MS, samples_ms: samples }));
  });

  it('reports which hop delayed a deferred bubble, without carrying the message', async () => {
    // A user message to an agent is not painted until admission persists it, so
    // everything between enqueue and admission is time the sender stares at a
    // transcript with no bubble. Production logs show that gap reaching ~270ms
    // at p90 with nothing logged in between, so the send path has to say which
    // hop it was: reading members, the task-board rows, the recipient/state
    // update, or admission itself.
    const conversation = await chats.createConversation(UID, { title: 'Bubble timing fixture' });
    const cid = conversation.conversation_id;
    cids.push(cid);
    await state.addMember(UID, cid, { id: AGENT_ID, name: 'Latency Agent', kind: 'agent' });
    await state.setActiveRecipient(UID, cid, AGENT_ID, 'user_selection');
    seedConnectors(0);

    await sendUntilRequest(cid);

    const timings = logs.filter(row => row.message === 'deferred bubble timing');
    expect(timings, 'one record per deferred-bubble send').toHaveLength(1);
    const payload = timings[0].payload as Record<string, number | boolean | string>;
    const segments = ['members_ms', 'board_ms', 'state_ms', 'admit_ms'] as const;
    for (const key of segments) {
      expect(Number.isFinite(payload[key] as number), `${key} must be a duration`).toBe(true);
      expect(payload[key] as number).toBeGreaterThanOrEqual(0);
    }
    // The parts must account for the whole, or a slow hop could fall outside
    // every mark and the record would under-report the gap.
    const parts = segments.reduce((sum, key) => sum + (payload[key] as number), 0);
    expect(payload.total_ms as number).toBe(parts);
    // An idle conversation admits immediately, so the record also states that
    // the bubble really exists rather than still sitting behind a running turn.
    expect(payload.persisted).toBe(true);

    // Diagnostics stay durations plus masked ids: no text, no recipient names.
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain('Hello.');
    expect(serialized).not.toContain(cid);
    expect(serialized).not.toContain(AGENT_ID);
  });

  it('charges a stalled hop to that hop, not to a neighbouring segment', async () => {
    // Accounting alone cannot tell a misplaced mark from a correct one: folding
    // one hop into the next keeps the total intact while pointing at the wrong
    // code. Stall a known hop — the member read that opens the stretch — and
    // require the record to name it.
    const conversation = await chats.createConversation(UID, { title: 'Bubble attribution fixture' });
    const cid = conversation.conversation_id;
    cids.push(cid);
    await state.addMember(UID, cid, { id: AGENT_ID, name: 'Latency Agent', kind: 'agent' });
    await state.setActiveRecipient(UID, cid, AGENT_ID, 'user_selection');
    seedConnectors(0);

    const STALL_MS = 150;
    const readJson = storage.readJson;
    // Every member read stalls: the send path reads members before this
    // stretch too, so a one-shot stall would be spent before the first mark.
    let stalls = 0;
    vi.spyOn(storage, 'readJson').mockImplementation(async target => {
      if (String(target).endsWith('members.json')) {
        stalls += 1;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, STALL_MS);
      }
      return readJson(target);
    });

    await sendUntilRequest(cid);
    expect(stalls, 'the member read must be the hop that stalled').toBeGreaterThan(0);

    const payload = logs
      .filter(row => row.message === 'deferred bubble timing')
      .map(row => row.payload as Record<string, number>)[0];
    expect(payload).toBeDefined();
    expect(payload.members_ms).toBeGreaterThanOrEqual(STALL_MS - 20);
    for (const key of ['board_ms', 'state_ms', 'admit_ms'] as const) {
      expect(payload[key], `${key} must not absorb the member-read stall`)
        .toBeLessThan(payload.members_ms);
    }
  });

  it('rejects a new synchronous stall anywhere before the first request, even when sending eventually succeeds', async () => {
    const conversation = await chats.createConversation(UID, { title: 'Latency negative control' });
    const cid = conversation.conversation_id;
    cids.push(cid);
    seedConnectors(10);
    const read = storage.readJsonSync;
    let injected = false;
    vi.spyOn(storage, 'readJsonSync').mockImplementation(target => {
      if (!injected && target === paths.userRemoteConfigFile(UID)) {
        injected = true;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, BUDGET_MS + 100);
      }
      return read(target);
    });
    const result = await sendUntilRequest(cid);
    expect(injected).toBe(true);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(() => checkLatencyBudget('send to first model request', result, BUDGET_MS)).toThrow(`budget ${BUDGET_MS} ms`);
    expect(warn).toHaveBeenCalledOnce();
    expect(JSON.parse(warn.mock.calls[0][1]).phases).not.toHaveLength(0);
  });
});
