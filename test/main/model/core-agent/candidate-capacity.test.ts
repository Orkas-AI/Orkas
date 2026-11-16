import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentRunner, createConfig, createPiProvider, ProviderRegistry, Session, PersistentSession,
  type CompletionParams, type CompletionResult, type LLMProvider, type StreamEvent } from '#core-agent';
import { createRotatingProvider, type RotatingCandidate } from '../../../../src/main/model/core-agent/rotating-provider';
import { mapCoreAgentEvents } from '../../../../src/main/model/core-agent/event-mapper';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const result: CompletionResult = { model: 'fixture', content: [{ type: 'text', text: 'done' }], stopReason: 'end_turn', usage };
const success = (calls: CompletionParams[]): LLMProvider => ({
  id: 'fixture', name: 'Fixture',
  async complete(params) { calls.push(params); return result; },
  async *stream(params) {
    calls.push(params);
    yield { type: 'text_delta', text: 'done' };
    yield { type: 'message_end', ...result };
  },
  async validateAuth() { return true; },
});
function candidate(id: string, window: number, output: number, provider: LLMProvider): RotatingCandidate {
  return { profileId: id, providerId: 'fixture', modelId: id, contextWindow: window,
    maxTokens: output, build: vi.fn(async () => provider) };
}
async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

// Scenario portfolio: retain a user's complete task across heterogeneous
// fallback, reject impossible prompt/tool/image loads before network admission,
// and preserve interrupted work for a smaller subsequent request. Synthetic
// transport only; the real SDK wire is the independent input-preservation oracle.
describe('candidate request capacity', () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(['stream', 'complete'] as const)('honors the exact safe-input boundary and leaves a rejected candidate usable in %s', async mode => {
    const calls: CompletionParams[] = [];
    const failures = vi.fn();
    const entry = candidate('small', 131072, 32768, success(calls));
    const provider = createRotatingProvider({ providerId: 'fixture', candidates: [entry], onRequestFailure: failures });
    const invoke = (params: CompletionParams) => mode === 'stream' ? collect(provider.stream(params)) : provider.complete(params);
    for (const tokens of [80608, 80609, 80610, 80609]) {
      const params: CompletionParams = { model: 'small', maxTokens: 32768, systemPrompt: 'Keep the complete task.',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Continue' }] }] };
      params.requestTokenEstimate = { model: 'small', systemPrompt: params.systemPrompt, messages: params.messages,
        tools: params.tools, source: 'anchored', tokens };
      const before = JSON.stringify(params);
      if (tokens === 80610) await expect(invoke(params)).rejects.toMatchObject({ admissionChecked: true });
      else await invoke(params);
      expect(JSON.stringify(params)).toBe(before);
    }
    expect(calls).toHaveLength(3);
    expect(entry.build).toHaveBeenCalledTimes(3);
    expect(failures).toHaveBeenCalledTimes(1);
    expect(failures.mock.calls[0][0]).toMatchObject({ code: 'context_capacity_insufficient', elapsedMs: 0,
      phase: 'before_request', source: 'payload', contextBudget: { input_ceiling_tokens: 80609, estimated_input_tokens: 80610 } });
  });

  it.each(['stream', 'complete'] as const)('rejects invalid output reservations before invoking a candidate in %s', async mode => {
    const calls: CompletionParams[] = [];
    const entry = candidate('small', 32000, 1024, success(calls));
    const provider = createRotatingProvider({ providerId: 'fixture', candidates: [entry] });
    for (const maxTokens of [0, -1, 0.5, NaN, Infinity, 32000, 32001]) {
      const params: CompletionParams = { model: 'small', maxTokens, messages: [] };
      await expect(mode === 'stream' ? collect(provider.stream(params)) : provider.complete(params))
        .rejects.toMatchObject({ admissionChecked: true });
    }
    expect(entry.build).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it.each(['stream', 'complete'] as const)('rejects invalid known windows but preserves unknown-window compatibility in %s', async mode => {
    const calls: CompletionParams[] = [];
    const params: CompletionParams = { model: 'small', maxTokens: 1024, messages: [] };
    for (const window of [0, -1, 31999, NaN, Infinity, 32000.5, Number.MAX_SAFE_INTEGER + 1]) {
      const entry = candidate('small', window, 1024, success(calls));
      const provider = createRotatingProvider({ providerId: 'fixture', candidates: [entry] });
      await expect(mode === 'stream' ? collect(provider.stream(params)) : provider.complete(params))
        .rejects.toMatchObject({ admissionChecked: true });
      expect(entry.build).not.toHaveBeenCalled();
    }
    expect(calls).toEqual([]);
    const unknown = { ...candidate('small', 32000, 1024, success(calls)), contextWindow: undefined };
    const compatible = createRotatingProvider({ providerId: 'fixture', candidates: [unknown] });
    await (mode === 'stream' ? collect(compatible.stream(params)) : compatible.complete(params));
    expect(calls).toHaveLength(1);
    expect(calls[0].requestMetadata?.contextBudgetDiagnostics).toBeUndefined();
  });

  it.each(['stream', 'complete'] as const)('preserves the full request through a larger fallback and reuses the smaller candidate on the next request in %s', async mode => {
    const smallCalls: CompletionParams[] = [], largeCalls: CompletionParams[] = [];
    const observations: unknown[] = [];
    const small = candidate('small', 32000, 1024, success(smallCalls));
    const provider = createRotatingProvider({ providerId: 'fixture', onRequestFailure: failure => observations.push(failure), candidates: [small,
      candidate('large', 131072, 1024, success(largeCalls))] });
    const params: CompletionParams = { model: 'small', maxTokens: 1024,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'a'.repeat(160000) }] }] };
    const invoke = (request: CompletionParams) => mode === 'stream' ? collect(provider.stream(request)) : provider.complete(request);
    await invoke(params);
    expect(smallCalls).toEqual([]);
    expect(largeCalls).toHaveLength(1);
    expect(largeCalls[0].messages).toEqual(params.messages);
    expect(largeCalls[0].maxTokens).toBe(1024);
    await invoke({ ...params, messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }] });
    expect(smallCalls).toHaveLength(1);
    expect(largeCalls).toHaveLength(1);
  });

  it.each(['stream', 'complete'] as const)('stops candidate admission when cancellation arrives during a local skip in %s', async mode => {
    const controller = new AbortController();
    const small = candidate('small', 31999, 1024, success([]));
    const large = candidate('large', 64000, 1024, success([]));
    const failure = vi.fn(() => controller.abort());
    const provider = createRotatingProvider({ providerId: 'fixture', candidates: [small, large], onRequestFailure: failure });
    const params: CompletionParams = { model: 'small', signal: controller.signal, messages: [] };
    await expect(mode === 'stream' ? collect(provider.stream(params)) : provider.complete(params))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(failure).toHaveBeenCalledTimes(1);
    expect(small.build).not.toHaveBeenCalled();
    expect(large.build).not.toHaveBeenCalled();
  });

  it('skips an undersized fallback and sends the complete task through the next real SDK candidate', async () => {
    const wire: Array<{ url: string; body: any }> = [];
    vi.stubGlobal('fetch', async (url: unknown, init?: RequestInit) => {
      if (!String(url).startsWith('https://capacity-fixture.invalid/')) throw Error('Unexpected network target');
      wire.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response('data: ' + JSON.stringify({ id: 'fixture', choices: [{ index: 0,
        delta: { role: 'assistant', content: 'done' }, finish_reason: null }] }) + '\n\n'
        + 'data: ' + JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }) + '\n\ndata: [DONE]\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } });
    });
    const sdk = (id: string, window: number) => createPiProvider({ provider: 'fixture', apiKey: 'synthetic', customModel: {
      id, name: id, provider: 'fixture', api: 'openai-completions', baseUrl: `https://capacity-fixture.invalid/${id}/v1`,
      reasoning: false, input: ['text'], contextWindow: window, maxTokens: 32768,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    } });
    const captured: CompletionParams[] = [];
    const large = sdk('large', 1_000_000);
    const primary: LLMProvider = { ...success([]), async *stream() {
      throw Object.assign(new Error('Synthetic connection fault'), { code: 'ECONNRESET' });
    } };
    const small = candidate('small', 131072, 32768, sdk('small', 131072));
    const failures = vi.fn();
    const rotating = createRotatingProvider({ providerId: 'fixture', networkRetryAttempts: 0, onRequestFailure: failures,
      candidates: [candidate('primary', 1_000_000, 128000, primary), small,
        candidate('large', 1_000_000, 32768, { ...large, async *stream(params) {
          captured.push(params); yield* large.stream(params);
        } })] });
    const providers = new ProviderRegistry(); providers.registerFactory('fixture', () => rotating);
    const runner = new AgentRunner({ providers, tools: [], config: createConfig({
      agent: { defaultProvider: 'fixture', defaultModel: 'primary', maxRetries: 0 }, evolution: { enabled: false },
      models: { catalog: { primary: { provider: 'fixture', model: 'primary', contextWindow: 1_000_000, maxOutputTokens: 128000 } } },
    }) });
    const message = 'Review all supplied records.\n' + 'record '.repeat(120000);
    const events = await collect(runner.runStream({ message }));
    expect(wire).toHaveLength(1);
    expect(wire[0].url).toContain('/large/');
    expect(JSON.stringify(wire[0].body.messages).match(/record /g)).toHaveLength(120000);
    expect(wire[0].body.max_tokens ?? wire[0].body.max_completion_tokens).toBe(32768);
    expect(small.build).not.toHaveBeenCalled();
    expect(captured[0].requestMetadata?.contextBudgetDiagnostics).toMatchObject({
      budget_context_window: 1_000_000, output_reservation: 32768,
    });
    expect(events.filter(event => event.type === 'done')).toHaveLength(1);
    const failure = failures.mock.calls.find(([item]) => item.code === 'context_capacity_insufficient')?.[0];
    expect(failure).toMatchObject({ phase: 'before_request', source: 'payload', contextWindow: 131072, outputLimit: 32768 });
    expect(failure.contextBudget).toMatchObject({ preparation_context_window: 1_000_000, compaction_attempts: 0 });
  });

  it.each(['stream', 'complete'] as const)('derives %s admission from the actual prompt instead of a fixed model floor', async mode => {
    const calls: CompletionParams[] = [];
    const tiny = candidate('tiny', 32000, 1024, success(calls));
    const provider = createRotatingProvider({ providerId: 'fixture', candidates: [tiny] });
    const invoke = (params: CompletionParams) => mode === 'stream' ? collect(provider.stream(params)) : provider.complete(params);
    const request: CompletionParams = { model: 'tiny', maxTokens: 1024,
      systemPrompt: 'Help with the task.', messages: [{ role: 'user', content: [{ type: 'text', text: 'u'.repeat(80000) }] }] };
    await invoke(request);
    expect(calls).toHaveLength(1);
    await expect(invoke({ ...request, systemPrompt: '汉'.repeat(4000) })).rejects.toMatchObject({ code: 'CONTEXT_OVERFLOW' });
    expect(calls).toHaveLength(1);
    // Capacity is request-local: a rejected prompt must not poison the profile.
    await invoke(request);
    expect(calls).toHaveLength(2);
  });

  it.each(['tools', 'images', 'scoped_control'] as const)('accounts for %s before a small candidate can send', async kind => {
    const calls: CompletionParams[] = [];
    const entry = candidate('small', 32000, 1024, success(calls));
    const params: CompletionParams = { model: 'small', maxTokens: 1024,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Continue' }] }] };
    if (kind === 'tools') params.tools = [{ name: 'fixture', description: '汉'.repeat(20000), inputSchema: { type: 'object' } }];
    if (kind === 'images') params.messages[0].content.push(...Array.from({ length: 16 }, () =>
      ({ type: 'image' as const, data: 'synthetic', mediaType: 'image/png' })));
    if (kind === 'scoped_control') params.messages.push({ role: 'developer', content: [{ type: 'text', text: '汉'.repeat(20000) }] });
    const before = JSON.stringify(params);
    await expect(collect(createRotatingProvider({ providerId: 'fixture', candidates: [entry] }).stream(params)))
      .rejects.toMatchObject({ code: 'CONTEXT_OVERFLOW' });
    expect(entry.build).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
    expect(JSON.stringify(params)).toBe(before);
  });

  it('keeps explicit output limits and skips an incompatible candidate without reducing the requested output', async () => {
    const calls: CompletionParams[] = [];
    const small = candidate('small', 32000, 512, success([]));
    const provider = createRotatingProvider({ providerId: 'fixture', candidates: [small,
      candidate('large', 64000, 2048, success(calls))] });
    await provider.complete({ model: 'small', maxTokens: 31000,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Provide the complete report.\n' + 'report '.repeat(1000) }] }] });
    expect(small.build).not.toHaveBeenCalled();
    expect(calls[0].maxTokens).toBe(31000);
  });

  it.each(['model_default', 'provider_default'] as const)('prices %s against the candidate without creating an explicit auxiliary cap', async source => {
    const calls: CompletionParams[] = [];
    const provider = createRotatingProvider({ providerId: 'fixture', candidates: [candidate('small', 32000, 512, success(calls))] });
    await provider.complete({ model: 'small', ...(source === 'model_default' ? { maxTokens: 32768 } : {}),
      requestMetadata: { outputLimitSource: source },
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Read this'.repeat(100) }] }] });
    expect(calls[0].maxTokens).toBe(source === 'model_default' ? 512 : undefined);
    expect(calls[0].requestMetadata?.contextBudgetDiagnostics).toMatchObject({ output_reservation: 512 });
  });

  it.each([false, true])('preserves the complete unread parallel round when every candidate is too small (persistent: %s)', async persistent => {
    const directory = persistent ? fs.mkdtempSync(path.join(os.tmpdir(), 'capacity-session-')) : undefined;
    const sessionFile = directory ? path.join(directory, 'task.jsonl') : undefined;
    const session = sessionFile ? new PersistentSession({ sessionFile }) : new Session();
    try {
      session.beginUserTurn([{ type: 'text', text: 'Continue the review' }]);
      // Both siblings are unread. Older separate rounds are eligible for
      // normal preparation now that actual candidate limits are authoritative.
      session.addAssistantMessage([0, 1].map(round => ({
        type: 'tool_use' as const, id: `read-${round}`, name: 'read', input: {},
      })));
      session.addMessage('user', [0, 1].map(round => ({
        type: 'tool_result' as const, toolUseId: `read-${round}`,
        content: `${round}:` + 'record '.repeat(20000),
      })));
      const calls: CompletionParams[] = [];
      const observations: unknown[] = [];
      const entry = candidate('small', 32000, 256, success(calls));
      const other = candidate('other', 64000, 256, success(calls));
      const provider = createRotatingProvider({ providerId: 'fixture', candidates: [entry, other],
        onRequestFailure: failure => observations.push(failure) });
      const providers = new ProviderRegistry(); providers.registerFactory('fixture', () => provider);
      const runner = new AgentRunner({ session, providers, tools: [], config: createConfig({
        agent: { defaultProvider: 'fixture', defaultModel: 'small' }, evolution: { enabled: false },
        models: { catalog: { small: { provider: 'fixture', model: 'small', contextWindow: 1_000_000, maxOutputTokens: 256 } } },
      }) });
      const before = JSON.stringify(session.getMessages());
      const events = await collect(runner.runStream({ message: 'Continue the review', resumeActiveTurn: true }));
      const done = events.filter(event => event.type === 'done');
      expect(done).toHaveLength(1);
      expect(done[0].result.meta.error).toMatchObject({ kind: 'context_overflow', code: 'CONTEXT_CAPACITY_INSUFFICIENT' });
      const visible = await collect(mapCoreAgentEvents((async function* () { yield* events; })(), { failureTrackingScope: {} }));
      expect(visible.filter(event => event.type === 'error')).toEqual([expect.objectContaining({
        failureKind: 'model', failureCode: 'context_capacity_insufficient', failurePhase: 'preflight',
      })]);
      expect(visible.some(event => event.type === 'final')).toBe(false);
      expect(events.some(event => event.type === 'retry' || event.type === 'compaction')).toBe(false);
      expect(calls).toHaveLength(0);
      expect(entry.build).not.toHaveBeenCalled();
      expect(other.build).not.toHaveBeenCalled();
      expect(JSON.stringify(session.getMessages())).toBe(before);
      expect(session.getSerializedContextState()?.activeTurn).toBeDefined();
      if (sessionFile) {
        const restored = new PersistentSession({ sessionFile });
        expect(JSON.stringify(restored.getMessages())).toBe(before);
        expect(restored.getSerializedContextState()?.activeTurn).toBeDefined();
      }
      // Explicit retry with a larger model resumes the saved turn; existing
      // tool receipts are input, never an instruction to replay those tools.
      const recoveryProviders = new ProviderRegistry();
      recoveryProviders.registerFactory('fixture', () => createRotatingProvider({ providerId: 'fixture',
        candidates: [candidate('large', 1_000_000, 256, success(calls))] }));
      const recoverySession = sessionFile ? new PersistentSession({ sessionFile }) : session;
      const recovered = await collect(new AgentRunner({ session: recoverySession, providers: recoveryProviders, tools: [],
        config: createConfig({ agent: { defaultProvider: 'fixture', defaultModel: 'large' }, evolution: { enabled: false },
          models: { catalog: { large: { provider: 'fixture', model: 'large', contextWindow: 1_000_000, maxOutputTokens: 256 } } } }),
      }).runStream({ message: 'Continue the review', resumeActiveTurn: true }));
      expect(recovered.find(event => event.type === 'done')?.result.meta.error).toBeUndefined();
      expect(calls).toHaveLength(1);
      expect(recovered.some(event => event.type === 'tool_start')).toBe(false);
      expect(recoverySession.getMessages().filter(message => message.role === 'user'
        && message.content.some(block => block.type === 'text' && block.text === 'Continue the review'))).toHaveLength(1);
      expect(JSON.stringify(calls[0].messages)).toContain('read-0');
      expect(JSON.stringify(calls[0].messages)).toContain('read-1');
    } finally { if (directory) fs.rmSync(directory, { recursive: true, force: true }); }
  });

  it('does not underprice an unchanged request whose completed provider usage exceeds the local estimate', async () => {
    const calls: CompletionParams[] = [];
    const small = candidate('small', 32000, 1024, success([]));
    const provider = createRotatingProvider({ providerId: 'fixture', candidates: [small, candidate('large', 64000, 1024, success(calls))] });
    await provider.complete({ model: 'small', maxTokens: 1024, messages: [{ role: 'user', content: [{ type: 'text', text: 'Continue' }] }],
      requestMetadata: { contextBudgetDiagnostics: { estimate_source: 'anchored', estimated_input_tokens: 30000 } } });
    expect(small.build).not.toHaveBeenCalled();
    expect(calls[0].requestMetadata?.contextBudgetDiagnostics).toMatchObject({ estimated_input_tokens: 30000, estimate_source: 'anchored' });
  });

  it.each(['stream', 'complete'] as const)('skips below 32000 even for a greeting, and admits the exact minimum in %s', async mode => {
    const calls: CompletionParams[] = [];
    const small = candidate('small', 31999, 8192, success([]));
    const exact = candidate('exact', 32000, 8192, success(calls));
    const provider = createRotatingProvider({ providerId: 'fixture', candidates: [small, exact] });
    const params: CompletionParams = { model: 'small', maxTokens: 8192,
      messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }] };
    if (mode === 'stream') await collect(provider.stream(params)); else await provider.complete(params);
    expect(small.build).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe('exact');
    expect(calls[0].messages).toEqual(params.messages);
  });

  it('honors cancellation before building any candidate, including capacity skips', async () => {
    const entry = candidate('small', 1024, 256, success([]));
    const controller = new AbortController(); controller.abort();
    await expect(collect(createRotatingProvider({ providerId: 'fixture', candidates: [entry] }).stream({
      model: 'small', signal: controller.signal, messages: [],
    }))).rejects.toMatchObject({ name: 'AbortError' });
    expect(entry.build).not.toHaveBeenCalled();
  });
});
