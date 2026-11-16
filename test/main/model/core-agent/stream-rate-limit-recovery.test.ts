import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AgentRunner, createConfig, createPiProvider, defineTool, ProviderError, ProviderRegistry, RateLimitError,
  type AgentRunEvent, type CompletionParams, type StreamEvent } from '#core-agent';
import { createRotatingProvider } from '../../../../src/main/model/core-agent/rotating-provider';

const realSetImmediate = setImmediate;
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function task(failures: unknown[], options: { signal?: AbortSignal; onRetry?: () => void; maxRetries?: number; incompleteTool?: boolean; secondEpisode?: boolean } = {}) {
  let calls = 0, writes = 0, fallbacks = 0;
  const contexts: CompletionParams['messages'][] = [];
  const callTimes: number[] = [];
  const provider = {
    id: 'fixture', name: 'Fixture',
    async complete() { throw new Error('unused'); },
    async validateAuth() { return true; },
    async *stream(params: CompletionParams): AsyncIterable<StreamEvent> {
      contexts.push(JSON.parse(JSON.stringify(params.messages)));
      calls++;
      callTimes.push(Date.now());
      if (calls === 1) {
        yield { type: 'message_end', stopReason: 'tool_use', model: 'fixture-model',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          content: [{ type: 'tool_use', id: 'write-once', name: 'save_record', input: {} }] };
        return;
      }
      const error = failures[calls - 2];
      if (options.secondEpisode && calls === 3) {
        yield { type: 'message_end', stopReason: 'tool_use', model: 'fixture-model',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          content: [{ type: 'tool_use', id: 'write-second', name: 'save_record', input: {} }] };
        return;
      }
      if (error) {
        if (options.incompleteTool) {
          yield { type: 'tool_use_start', id: 'unfinished-call', name: 'save_record' };
          yield { type: 'tool_use_delta', id: 'unfinished-call', input: '{"record":' };
        } else yield { type: 'text_delta', text: 'Interrupted draft.' };
        throw error;
      }
      yield { type: 'text_delta', text: 'Completed summary.' };
      yield { type: 'message_end', stopReason: 'end_turn', model: 'fixture-model',
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        content: [{ type: 'text', text: 'Completed summary.' }] };
    },
  };
  const rotating = createRotatingProvider({ providerId: 'fixture', candidates: [{
    profileId: 'recovery-a', providerId: 'fixture', modelId: 'fixture-model', build: async () => provider,
  }, {
    profileId: 'recovery-b', providerId: 'fixture', modelId: 'other-model',
    build: async () => { fallbacks++; throw new Error('must keep the committed model'); },
  }] });
  const registry = new ProviderRegistry();
  registry.registerFactory('fixture', () => rotating);
  const runner = new AgentRunner({ config: createConfig({ agent: {
    defaultProvider: 'fixture', defaultModel: 'fixture-model', maxRetries: options.maxRetries ?? 3,
  } }), providers: registry, evolution: { enabled: false }, tools: [defineTool({
    name: 'save_record', description: 'Save fixture record', inputSchema: { type: 'object', properties: {} },
    async execute() { writes++; return { content: `saved-receipt-${writes}` }; },
  })] });
  const events: AgentRunEvent[] = [];
  return {
    runner, contexts, events, callTimes,
    counts: () => ({ calls, writes, fallbacks }),
    async run() {
      let settled = false;
      const draining = (async () => {
        for await (const event of runner.runStream({ message: options.secondEpisode
          ? 'Save two records and report their outcomes.' : 'Save a record and report its outcome.', signal: options.signal })) {
          events.push(event);
          if (event.type === 'retry') options.onRetry?.();
        }
      })().finally(() => { settled = true; });
      for (let tick = 0; !settled && tick < 100; tick++) {
        await new Promise<void>(resolve => realSetImmediate(resolve));
        await vi.runAllTimersAsync();
      }
      expect(settled).toBe(true);
      await draining;
      expect(events.filter(event => event.type === 'done')).toHaveLength(1);
      expect(events.at(-1)?.type).toBe('done');
      expect(writes).toBe(options.secondEpisode ? 2 : 1);
      expect(fallbacks).toBe(0);
      return events.at(-1) as Extract<AgentRunEvent, { type: 'done' }>;
    },
  };
}

it.each([0, 25_000, 59_999, 60_000])('recovers on the same model with the completed receipt after %s ms', async delay => {
  const t = task([new RateLimitError('limited', delay)]);
  const final = await t.run();
  expect(final.result.text).toBe('Completed summary.');
  expect(t.counts().calls).toBe(3);
  expect(t.events.filter(event => event.type === 'retry')).toMatchObject([{ waitMs: delay }]);
  expect(t.callTimes[2] - t.callTimes[1]).toBeGreaterThanOrEqual(delay);
  expect(JSON.stringify(t.contexts[2])).toContain('saved-receipt-1');
  expect(JSON.stringify(t.contexts[2])).not.toContain('Interrupted draft.');
});

it('rearms the recovery allowance only after a completed model round', async () => {
  const t = task([new RateLimitError('limited', 40_000), undefined, new RateLimitError('limited', 40_000)],
    { secondEpisode: true });
  expect((await t.run()).result.text).toBe('Completed summary.');
  expect(t.counts().calls).toBe(5);
  expect(t.events.filter(event => event.type === 'retry')).toHaveLength(2);
  expect(JSON.stringify(t.contexts[4])).toContain('saved-receipt-1');
  expect(JSON.stringify(t.contexts[4])).toContain('saved-receipt-2');
});

it('discards an incomplete tool proposal while keeping earlier completed work', async () => {
  const t = task([new RateLimitError('limited', 1)], { incompleteTool: true });
  expect((await t.run()).result.text).toBe('Completed summary.');
  expect(JSON.stringify(t.contexts[2])).not.toContain('unfinished-call');
  expect(t.counts().writes).toBe(1);
});

it('shares a three-retry cap even when the outer runner allows more attempts', async () => {
  const t = task(Array.from({ length: 8 }, () => new RateLimitError('limited', 1)), { maxRetries: 9 });
  const final = await t.run();
  expect(t.counts().calls).toBe(5); // One tool round plus initial generation and three retries.
  expect(t.events.filter(event => event.type === 'retry')).toHaveLength(3);
  expect(final.result.meta.error?.code).toBe('PROVIDER_RATE_LIMIT_EXHAUSTED');
  expect(t.runner.getSession().getSerializedContextState()?.activeTurn).toBeTruthy();
});

it('allows exactly 60 seconds of accumulated wait and stops at the next limit', async () => {
  const t = task(Array.from({ length: 5 }, () => new RateLimitError('limited', 20_000)));
  const final = await t.run();
  const retries = t.events.filter(event => event.type === 'retry');
  expect(retries).toHaveLength(3);
  expect(retries.reduce((sum, event) => sum + (event.waitMs ?? 0), 0)).toBe(60_000);
  expect(t.counts().calls).toBe(5);
  expect(final.result.meta.error?.code).toBe('PROVIDER_RATE_LIMIT_EXHAUSTED');
});

it('never retries earlier than a Retry-After beyond the remaining wait budget', async () => {
  const t = task([new RateLimitError('limited', 60_001)]);
  const final = await t.run();
  expect(t.events.some(event => event.type === 'retry')).toBe(false);
  expect(t.counts().calls).toBe(2);
  expect(final.result.meta.error?.code).toBe('PROVIDER_RATE_LIMIT_EXHAUSTED');
});

it.each([undefined, -1, NaN, Infinity])('uses bounded backoff for an absent/malformed delay: %s', async delay => {
  const t = task([new RateLimitError('limited', delay)]);
  expect((await t.run()).result.text).toBe('Completed summary.');
  const retry = t.events.find(event => event.type === 'retry');
  expect(retry?.type === 'retry' && retry.waitMs).toBeGreaterThan(0);
  expect(retry?.type === 'retry' && retry.waitMs).toBeLessThanOrEqual(60_000);
});

it('cancels during recovery without dispatching another model request', async () => {
  const controller = new AbortController();
  const t = task([new RateLimitError('limited', 30_000)], {
    signal: controller.signal, onRetry: () => controller.abort(new Error('user stopped')),
  });
  expect((await t.run()).result.meta.aborted).toBe(true);
  expect(t.counts().calls).toBe(2);
});

it('interrupts an already pending recovery wait', async () => {
  const controller = new AbortController();
  const t = task([new RateLimitError('limited', 30_000)], {
    signal: controller.signal, onRetry: () => { setTimeout(() => controller.abort(new Error('user stopped')), 5000); },
  });
  expect((await t.run()).result.meta.aborted).toBe(true);
  expect(t.counts().calls).toBe(2);
});

it('uses a caller retry budget smaller than the default cap', async () => {
  const t = task([new RateLimitError('limited', 1), new RateLimitError('limited', 1)], { maxRetries: 1 });
  expect((await t.run()).result.meta.error?.code).toBe('PROVIDER_RATE_LIMIT_EXHAUSTED');
  expect(t.events.filter(event => event.type === 'retry')).toHaveLength(1);
  expect(t.counts().calls).toBe(3);
});

it('honors an explicit zero retry budget', async () => {
  const t = task([new RateLimitError('limited', 1)], { maxRetries: 0 });
  expect((await t.run()).result.meta.error).toBeTruthy();
  expect(t.events.some(event => event.type === 'retry')).toBe(false);
  expect(t.counts().calls).toBe(2);
});

it.each(['PROVIDER_OUTPUT_UNCERTAIN', 'TASK_TOKEN_LIMIT_REACHED', 'SESSION_PERSISTENCE_FAILED'])
('never makes a terminal failure recoverable through a rate-limit cause: %s', async code => {
  const error = Object.assign(new Error('terminal fixture failure'), { code, cause: new RateLimitError('limited', 1) });
  const t = task([error]);
  expect((await t.run()).result.meta.error?.code).toBe(code);
  expect(t.events.some(event => event.type === 'retry')).toBe(false);
  expect(t.counts().calls).toBe(2);
});

it('keeps the shared attempt budget when a rate-limit recovery meets a transient 503', async () => {
  const t = task([new RateLimitError('limited', 1), new ProviderError('unavailable', 'fixture', 503)]);
  expect((await t.run()).result.text).toBe('Completed summary.');
  expect(t.counts().calls).toBe(4);
  expect(t.events.filter(event => event.type === 'retry')).toHaveLength(2);
});

it('stops recovery when the next attempt is rejected for authentication', async () => {
  const t = task([new RateLimitError('limited', 1), Object.assign(new Error('sign in'), { status: 401 })]);
  expect((await t.run()).result.meta.error).toBeTruthy();
  expect(t.counts().calls).toBe(3);
  expect(t.events.filter(event => event.type === 'retry')).toHaveLength(1);
});

it('keeps the same model after a retry is throttled before producing its first delta', async () => {
  const throttled = new RateLimitError('limited', 1);
  let calls = 0, fallbacks = 0;
  const primary = {
    id: 'fixture', name: 'Fixture', async complete() { throw new Error('unused'); }, async validateAuth() { return true; },
    async *stream(): AsyncIterable<StreamEvent> {
      calls++;
      if (calls === 1) yield { type: 'text_delta', text: 'partial' };
      if (calls <= 2) throw throttled;
      yield { type: 'message_end', stopReason: 'end_turn', content: [{ type: 'text', text: 'recovered' }],
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
    },
  };
  const rotating = createRotatingProvider({ providerId: 'fixture', candidates: [{
    profileId: 'before-delta', providerId: 'fixture', modelId: 'fixture-model', build: async () => primary,
  }, { profileId: 'other', providerId: 'fixture', modelId: 'other-model',
    build: async () => { fallbacks++; throw new Error('wrong model'); } }] });
  const registry = new ProviderRegistry(); registry.registerFactory('fixture', () => rotating);
  const runner = new AgentRunner({ config: createConfig({ agent: { defaultProvider: 'fixture', defaultModel: 'fixture-model' } }),
    providers: registry, tools: [], evolution: { enabled: false } });
  let settled = false;
  const pending = runner.run({ message: 'Continue the task.' }).finally(() => { settled = true; });
  for (let tick = 0; !settled && tick < 100; tick++) {
    await new Promise<void>(resolve => realSetImmediate(resolve)); await vi.runAllTimersAsync();
  }
  expect(settled).toBe(true);
  expect((await pending).text).toBe('recovered');
  expect(calls).toBe(3); expect(fallbacks).toBe(0);
});

it('recovers a real SDK stream using the retained SSE retry delay', async () => {
  let calls = 0;
  vi.stubGlobal('fetch', vi.fn(async () => {
    calls++;
    const delta = (text: string, done = false) => 'data: ' + JSON.stringify({
      choices: [{ index: 0, delta: { content: text }, finish_reason: done ? 'stop' : null }],
    }) + '\n\n';
    const body = calls === 1
      ? delta('partial') + 'data: ' + JSON.stringify({ error: { code: 'rate_limit_exceeded', retry_after_ms: 25_000 } }) + '\n\n'
      : delta('recovered', true) + 'data: [DONE]\n\n';
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  }));
  const rotating = createRotatingProvider({ providerId: 'custom', candidates: [{
    profileId: 'real-sdk-recovery', providerId: 'custom', modelId: 'fixture-model',
    contextWindow: 128_000, maxTokens: 4096,
    build: async () => createPiProvider({ provider: 'custom', apiKey: 'fixture', customModel: {
      id: 'fixture-model', name: 'Fixture', provider: 'custom', api: 'openai-completions', baseUrl: 'https://fixture.invalid/v1',
      reasoning: false, input: ['text'], contextWindow: 128_000, maxTokens: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    } }),
  }] });
  const registry = new ProviderRegistry(); registry.registerFactory('custom', () => rotating);
  const runner = new AgentRunner({ config: createConfig({ agent: { defaultProvider: 'custom', defaultModel: 'fixture-model' } }),
    providers: registry, tools: [], evolution: { enabled: false } });
  const events: AgentRunEvent[] = [];
  let settled = false;
  const draining = (async () => { for await (const event of runner.runStream({ message: 'Report the result.' })) events.push(event); })()
    .finally(() => { settled = true; });
  for (let tick = 0; !settled && tick < 100; tick++) {
    await new Promise<void>(resolve => realSetImmediate(resolve)); await vi.runAllTimersAsync();
  }
  await draining;
  expect(events.at(-1)).toMatchObject({ type: 'done', result: { text: 'recovered' } });
  expect(events.filter(event => event.type === 'retry')).toMatchObject([{ waitMs: 25_000 }]);
  expect(calls).toBe(2);
});
