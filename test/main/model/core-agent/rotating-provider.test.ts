import { mapCoreAgentEvents } from '../../../../src/main/model/core-agent/event-mapper';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { classifyRetryableError, classifyTransientNetworkError } from '../../../../src/core-agent/src/shared/errors';
import {
  boundMessagesForImageLimit,
  ALL_CONFIGURED_RATE_LIMITED_MESSAGE,
  createRotatingProvider,
  PROVIDER_EMPTY_NORMAL_CODE,
  PROVIDER_EMPTY_SAFETY_CODE,
  PROVIDER_EMPTY_UNKNOWN_CODE,
  type RotatingCandidate,
} from '../../../../src/main/model/core-agent/rotating-provider';
import type { LLMProvider, StreamEvent, CompletionParams, CompletionResult } from '#core-agent';
import { createPiProvider, AgentRunner, createConfig, defineTool, ContextOverflowError, ProviderError, ProviderRegistry } from '#core-agent';
import { _clearAll, getCooldown } from '../../../../src/main/model/core-agent/profile-cooldown';

import { normalizeElectronNetFetchError } from '../../../../src/main/util/proxy-dispatcher';
import { getCurrentLang, setCurrentLang, t } from '../../../../src/main/i18n';

// ── Fake LLMProvider factory ────────────────────────────────────────────

interface FakeBehavior {
  streamEvents?: StreamEvent[];  // Yield these events, then finish normally.
  throwBefore?: unknown;          // Throw before the first event.
  throwAfter?: unknown;           // Throw after yielding the first event.
  throwAfterN?: { n: number; err: unknown }; // Throw after yielding event N.
  completeResult?: any;
  completeError?: unknown;
  buildError?: unknown;           // Fail during external-provider construction.
}

function fakeProvider(id: string, b: FakeBehavior): LLMProvider {
  return {
    id,
    name: id,
    async *stream(_params: CompletionParams): AsyncIterable<StreamEvent> {
      if (b.throwBefore !== undefined) throw b.throwBefore;
      const events = b.streamEvents ?? [];
      for (let i = 0; i < events.length; i++) {
        yield events[i];
        if (b.throwAfter !== undefined && i === 0) throw b.throwAfter;
        if (b.throwAfterN && i === b.throwAfterN.n) throw b.throwAfterN.err;
      }
    },
    async complete(_p: CompletionParams) {
      if (b.completeError !== undefined) throw b.completeError;
      return b.completeResult;
    },
    async validateAuth() { return true; },
  };
}

function candidate(profileId: string, b: FakeBehavior, providerId = 'test', modelId = 'test-model'): RotatingCandidate {
  return {
    profileId,
    providerId,
    modelId,
    build: async () => {
      if (b.buildError !== undefined) throw b.buildError;
      return fakeProvider(profileId, b);
    },
  };
}

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

const PARAMS: CompletionParams = {
  model: 'test-model',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }],
};

describe('Anthropic API-key cache retention', () => {
  it.each((['complete', 'stream'] as const).flatMap(method =>
    (['long', 'short', 'none'] as const).map(retention => [method, retention] as const),
  ))('preserves the requested %s fallback cache policy (%s) for API keys and subscriptions', async (method, retention) => {
    _clearAll();
    const authError = Object.assign(new Error('invalid API key'), { status: 401 });
    const answer: CompletionResult = {
      content: [{ type: 'text', text: 'Recovered' }], stopReason: 'end_turn', model: 'claude-fixture',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    };
    const requests: Array<[string, CompletionParams['cacheRetention']]> = [];
    const record = (entry: RotatingCandidate): RotatingCandidate => ({
      ...entry,
      async build() {
        const provider = await entry.build();
        return {
          ...provider,
          stream(params) {
            requests.push([entry.profileId, params.cacheRetention]);
            return provider.stream(params);
          },
          complete(params) {
            requests.push([entry.profileId, params.cacheRetention]);
            return provider.complete(params);
          },
        };
      },
    });
    const rejected = { completeError: authError, throwBefore: authError };
    const provider = createRotatingProvider({ providerId: 'openai', candidates: [
      record(candidate('openai-key', rejected, 'openai')),
      record(candidate('claude-key', rejected, 'anthropic')),
      record({
        ...candidate('claude-subscription', {
          completeResult: answer, streamEvents: [{ type: 'text_delta', text: 'Recovered' }],
        }, 'anthropic', answer.model),
        refreshCredential: async () => false,
      }),
    ] });
    try {
      const params = { ...PARAMS, cacheRetention: retention };
      if (method === 'complete') {
        await expect(provider.complete(params)).resolves.toEqual(answer);
      } else {
        expect(await collect(provider.stream(params))).toContainEqual({ type: 'text_delta', text: 'Recovered' });
      }
      expect(requests).toEqual([
        ['openai-key', retention], ['claude-key', retention], ['claude-subscription', retention],
      ]);
    } finally { _clearAll(); }
  });
});

describe('recovery of actual upstream rejections', () => {
  it.each(['openai-completions', 'openai-responses'] as const)
  ('leaves malformed length recovery with Runner through the configured wrapper (%s)', async api => {
    _clearAll();
    const bodies: any[] = [];
    const execute = vi.fn(async () => ({ content: 'must not execute' }));
    const fallbackBuild = vi.fn(async () => fakeProvider('fallback', {}));
    vi.stubGlobal('fetch', vi.fn(async (input, init) => {
      bodies.push(JSON.parse(await new Request(input, init).text()));
      expect(bodies.length).toBeLessThanOrEqual(2);
      const first = bodies.length === 1;
      if (api === 'openai-completions') return new Response(`data: ${JSON.stringify({ choices: [{ index: 0,
        delta: first ? { role: 'assistant', tool_calls: [{ index: 0, id: 'partial', type: 'function',
          function: { name: 'write_file', arguments: '{"value":' } }] } : { role: 'assistant', content: 'Recovered.' },
        finish_reason: first ? 'length' : 'stop',
      }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
      const item = first ? { type: 'function_call', id: 'fc_partial', call_id: 'partial', name: 'write_file', arguments: '{"value":' }
        : { type: 'message', id: 'msg_final', role: 'assistant', content: [{ type: 'output_text', text: 'Recovered.', annotations: [] }] };
      const events = [
        { type: 'response.output_item.added', output_index: 0, item: { ...item, arguments: '', content: [] } },
        ...(first ? [{ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"value":' }] : []),
        { type: 'response.output_item.done', output_index: 0, item },
        { type: first ? 'response.incomplete' : 'response.completed', response: { id: 'resp_fixture',
          status: first ? 'incomplete' : 'completed', output: [item],
          ...(first ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
          usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } } },
      ];
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''),
        { headers: { 'content-type': 'text/event-stream' } });
    }));
    try {
      const provider = createRotatingProvider({ providerId: 'custom', networkRetryAttempts: 0,
        candidates: [{ profileId: 'primary', providerId: 'custom', modelId: 'fixture',
          build: async () => createPiProvider({ provider: 'custom', apiKey: 'fixture', customModel: {
            id: 'fixture', name: 'Fixture', provider: 'custom', api, baseUrl: 'https://fixture.invalid/v1',
            reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          } }),
        }, { profileId: 'fallback', providerId: 'custom', modelId: 'fixture', build: fallbackBuild }],
      });
      const registry = new ProviderRegistry();
      registry.registerFactory('custom', () => provider);
      const runner = new AgentRunner({ providers: registry,
        config: createConfig({ agent: { defaultProvider: 'custom', defaultModel: 'fixture', maxRetries: 0 } }),
        tools: [defineTool({ name: 'write_file', description: 'Synthetic write', inputSchema: { type: 'object' }, execute })],
      });
      const result = await runner.run({ message: 'Prepare the explanation.' });
      expect(result.meta.error).toBeUndefined();
      expect(result.text).toBe('Recovered.');
      expect(bodies).toHaveLength(2);
      expect(JSON.stringify(bodies[1])).toContain('at or below 12000 characters');
      expect(execute).not.toHaveBeenCalled();
      expect(fallbackBuild).not.toHaveBeenCalled();
      expect(getCooldown('primary')).toBeUndefined();
    } finally { vi.unstubAllGlobals(); _clearAll(); }
  });


  it.each(['complete', 'stream'] as const)('leaves local context overflow to Runner without rotating or cooling down (%s)', async method => {
    _clearAll();
    const fetchStub = vi.fn(async () => new Response(JSON.stringify({ error: {
      code: 400, type: 'exceed_context_size_error', message: 'Request rejected',
      n_prompt_tokens: 16764, n_ctx: 8192,
    } }), { status: 400, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchStub);
    const fallbackBuild = vi.fn(async () => fakeProvider('fallback', {}));
    const onCandidateChosen = vi.fn();
    try {
      const provider = createRotatingProvider({ providerId: 'custom', networkRetryDelayMs: () => 0, onCandidateChosen,
        candidates: [{ profileId: 'primary', providerId: 'custom', modelId: 'fixture',
          build: async () => createPiProvider({ provider: 'custom', apiKey: 'fixture', customModel: {
            id: 'fixture', name: 'fixture', api: 'openai-completions', provider: 'custom',
            baseUrl: 'https://primary.invalid/v1', reasoning: false, input: ['text'],
            contextWindow: 131072, maxTokens: 32768,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          } }),
        }, { profileId: 'fallback', providerId: 'custom', modelId: 'fixture', build: fallbackBuild }],
      });
      if (method === 'complete') await expect(provider.complete(PARAMS)).rejects.toBeInstanceOf(ContextOverflowError);
      else await expect(collect(provider.stream(PARAMS))).rejects.toBeInstanceOf(ContextOverflowError);
      expect(fetchStub).toHaveBeenCalledTimes(1);
      expect(fallbackBuild).not.toHaveBeenCalled();
      expect(onCandidateChosen).toHaveBeenCalledExactlyOnceWith({
        profileId: 'primary', providerId: 'custom', modelId: 'fixture',
      });
      expect(getCooldown('primary')).toBeUndefined();
    } finally { vi.unstubAllGlobals(); _clearAll(); }
  });
});

describe('HTTP 451 terminal handling', () => {
  it.each([
    ['complete', 'openai-completions'], ['stream', 'openai-completions'],
    ['complete', 'openai-responses'], ['stream', 'openai-responses'],
  ] as const)('stops %s via %s without retry, rotation or cooldown and allows a fresh request', async (method, api) => {
    _clearAll();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const requests: string[] = [];
    const recoveryEvents: StreamEvent[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input) => {
      requests.push(String(input).includes('primary.invalid') ? 'primary' : 'fallback');
      return new Response(null, { status: 451 });
    }));
    const create = () => createRotatingProvider({ providerId: 'custom', networkRetryDelayMs: () => 0,
      candidates: ['primary', 'fallback'].map(name => ({ profileId: name, providerId: 'custom', modelId: 'fixture',
        build: async () => createPiProvider({ provider: 'custom', apiKey: 'fixture', customModel: {
          id: 'fixture', name: 'fixture', api, provider: 'custom', baseUrl: `https://${name}.invalid/v1`,
          reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        } }),
      })),
    });
    const invoke = async () => {
      const provider = create();
      if (method === 'complete') return provider.complete(PARAMS);
      for await (const event of provider.stream(PARAMS)) {
        if (event.type === 'retry' || event.type === 'provider_fallback') recoveryEvents.push(event);
      }
    };
    try {
      await expect(invoke()).rejects.toMatchObject({ statusCode: 451 });
      expect(requests).toEqual(['primary']);
      expect(recoveryEvents).toEqual([]);
      expect(getCooldown('primary')).toBeUndefined();
      expect(getCooldown('fallback')).toBeUndefined();
      await expect(invoke()).rejects.toMatchObject({ statusCode: 451 });
      expect(requests).toEqual(['primary', 'primary']);
      expect(warning.mock.calls).toHaveLength(2);
      expect(warning.mock.calls.every(([, , facts]) => facts?.httpStatus === 451)).toBe(true);
    } finally { vi.unstubAllGlobals(); warning.mockRestore(); _clearAll(); }
  });
});

describe('rotating-provider › successful streams', () => {
  beforeEach(() => _clearAll());

  it('forwards every event and reports success for the only candidate', async () => {
    let winner: string | null = null;
    const p = createRotatingProvider({
      providerId: 'test',
      candidates: [candidate('p1', {
        streamEvents: [
          { type: 'text_delta', text: 'hi' } as any,
          { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, model: 'test-model' } as any,
        ],
      })],
      onSuccess: (pid) => { winner = pid; },
    });
    const events = await collect(p.stream(PARAMS));
    expect(events.length).toBe(2);
    expect(winner).toBe('p1');
  });

  it('reports candidate counts even when the first candidate succeeds', async () => {
    const observed: Array<{ candidateCount: number; availableCandidateCount: number }> = [];
    const p = createRotatingProvider({
      providerId: 'test',
      candidates: [
        candidate('p1', { streamEvents: [{ type: 'text_delta', text: 'ok' } as any] }),
        candidate('p2', { streamEvents: [{ type: 'text_delta', text: 'unused' } as any] }),
      ],
      onCandidatesObserved: (info) => observed.push(info),
    });

    await collect(p.stream(PARAMS));
    expect(observed).toEqual([{ candidateCount: 2, availableCandidateCount: 2 }]);
  });
});

describe('rotating-provider › rotatable stream failures', () => {
  beforeEach(() => _clearAll());

  it('falls back after a 401 and cools down the rejected credential', async () => {
    let winner: string | null = null;
    const authErr = Object.assign(new Error('Unauthorized'), { status: 401 });
    const p = createRotatingProvider({
      providerId: 'test',
      candidates: [
        candidate('p1', { throwBefore: authErr }),
        candidate('p2', { streamEvents: [{ type: 'text_delta', text: 'ok' } as any] }),
      ],
      onSuccess: (pid) => { winner = pid; },
    });
    const events = await collect(p.stream(PARAMS));
    expect(events.length).toBe(2);
    expect(events[0]).toMatchObject({ type: 'provider_fallback', reason: 'auth' });
    expect((events[1] as any).text).toBe('ok');
    expect(winner).toBe('p2');
    expect(getCooldown('p1')?.kind).toBe('auth');
    expect(getCooldown('p2')).toBeUndefined();
  });

  it('isolates cooldowns for two models sharing one external profile', async () => {
    const authErr = Object.assign(new Error('Unauthorized'), { status: 401 });
    const primary = candidate('openai:Personal', { throwBefore: authErr }, 'openai', 'gpt-5.4-pro');
    primary.cooldownId = 'openai:Personal/gpt-5.4-pro';
    const fallback = candidate(
      'openai:Personal',
      { streamEvents: [{ type: 'text_delta', text: 'standard works' } as any] },
      'openai',
      'gpt-5.4',
    );
    fallback.cooldownId = 'openai:Personal/gpt-5.4';

    const provider = createRotatingProvider({
      providerId: 'openai',
      candidates: [primary, fallback],
    });
    const events = await collect(provider.stream(PARAMS));

    expect(events[0]).toMatchObject({
      type: 'provider_fallback',
      reason: 'auth',
      providerId: 'openai',
    });
    expect(events.at(-1)).toMatchObject({ type: 'text_delta', text: 'standard works' });
    expect(getCooldown(primary.cooldownId)?.kind).toBe('auth');
    expect(getCooldown(fallback.cooldownId)).toBeUndefined();
    expect(getCooldown('openai:Personal')).toBeUndefined();
  });

  it.each([
    ['Encountered invalidated oauth token for user, failing request', 401],
    ['Encountered invalidated oauth token for user, failing request', undefined],
    ['The authentication token is expired', undefined],
  ] as const)('invalidated or expired OAuth stays skipped for later rounds (%s, status=%s)', async (message, status) => {
    const authErr = Object.assign(new Error(message), { ...(status ? { status } : {}), code: 'token_invalidated' });
    let primaryBuilds = 0;
    let fallbackBuilds = 0;
    const p = createRotatingProvider({
      providerId: 'test',
      networkRetryDelayMs: () => 0,
      candidates: [
        {
          profileId: 'expired-oauth',
          providerId: 'openai-codex',
          modelId: 'gpt-test',
          build: async () => {
            primaryBuilds += 1;
            return fakeProvider('expired-oauth', { throwBefore: authErr });
          },
        },
        {
          profileId: 'fallback',
          providerId: 'deepseek',
          modelId: 'deepseek-test',
          build: async () => {
            fallbackBuilds += 1;
            return fakeProvider('fallback', { streamEvents: [{ type: 'text_delta', text: 'ok' } as any] });
          },
        },
      ],
    });

    const firstRound = await collect(p.stream(PARAMS));
    const secondRound = await collect(p.stream(PARAMS));

    expect(primaryBuilds).toBe(1);
    expect(fallbackBuilds).toBe(2);
    expect(firstRound.filter((event: any) => event.type === 'provider_fallback')).toEqual([
      {
        type: 'provider_fallback',
        reason: 'auth',
        providerId: 'openai-codex',
        candidateIndex: 1,
        candidateCount: 2,
      },
    ]);
    expect(firstRound.some((event: any) => event.type === 'retry')).toBe(false);
    expect((firstRound.at(-1) as any).text).toBe('ok');
    expect(secondRound.some((event: any) => event.type === 'provider_fallback')).toBe(false);
    expect((secondRound.at(-1) as any).text).toBe('ok');
    expect(getCooldown('expired-oauth')?.kind).toBe('auth');
  });

  it('falls back when a candidate never produces a usable first event and skips it for later model rounds', async () => {
    let primaryBuilds = 0;
    let fallbackBuilds = 0;
    let primaryAborts = 0;
    const p = createRotatingProvider({
      providerId: 'test',
      firstEventTimeoutMs: 30,
      candidates: [
        {
          profileId: 'silent',
          providerId: 'silent-provider',
          modelId: 'silent-model',
          build: async () => {
            primaryBuilds += 1;
            return {
              id: 'silent-provider',
              name: 'silent-provider',
              async *stream(params: CompletionParams): AsyncIterable<StreamEvent> {
                yield { type: 'message_start' } as any;
                await new Promise<void>((_resolve, reject) => {
                  params.signal?.addEventListener('abort', () => {
                    primaryAborts += 1;
                    reject(params.signal?.reason || new Error('aborted'));
                  }, { once: true });
                });
              },
              async complete() { throw new Error('unused'); },
              async validateAuth() { return true; },
            };
          },
        },
        {
          profileId: 'fallback',
          providerId: 'fallback-provider',
          modelId: 'fallback-model',
          build: async () => {
            fallbackBuilds += 1;
            return fakeProvider('fallback', { streamEvents: [{ type: 'text_delta', text: 'ok' } as any] });
          },
        },
      ],
    });

    const firstRound = await collect(p.stream(PARAMS));
    const secondRound = await collect(p.stream(PARAMS));

    expect(primaryBuilds).toBe(1);
    expect(primaryAborts).toBe(1);
    expect(fallbackBuilds).toBe(2);
    expect(firstRound[0]).toMatchObject({
      type: 'provider_fallback',
      reason: 'no_first_event_timeout',
      providerId: 'silent-provider',
      candidateIndex: 1,
      candidateCount: 2,
    });
    expect(firstRound.some((event: any) => event.type === 'retry')).toBe(false);
    expect((firstRound.at(-1) as any).text).toBe('ok');
    expect(secondRound.some((event: any) => event.type === 'provider_fallback')).toBe(false);
    expect((secondRound.at(-1) as any).text).toBe('ok');
    expect(getCooldown('silent')).toBeUndefined();
  });

  it('surfaces a stable non-retryable code after all candidates miss the first-event deadline', async () => {
    let builds = 0;
    const p = createRotatingProvider({
      providerId: 'test',
      firstEventTimeoutMs: 20,
      candidates: [{
        profileId: 'silent',
        providerId: 'silent-provider',
        modelId: 'silent-model',
        build: async () => {
          builds += 1;
          return {
            id: 'silent-provider',
            name: 'silent-provider',
            async *stream(): AsyncIterable<StreamEvent> {
              yield { type: 'message_start' } as any;
              await new Promise(() => {});
            },
            async complete() { throw new Error('unused'); },
            async validateAuth() { return true; },
          };
        },
      }],
    });

    await expect(collect(p.stream(PARAMS))).rejects.toMatchObject({
      code: 'PROVIDER_NO_FIRST_EVENT_TIMEOUT',
    });
    expect(builds).toBe(1);
  });

  it('does not rotate when the caller aborts during the pre-commit wait', async () => {
    let fallbackBuilds = 0;
    const controller = new AbortController();
    const p = createRotatingProvider({
      providerId: 'test',
      firstEventTimeoutMs: 1_000,
      candidates: [
        {
          profileId: 'silent',
          providerId: 'silent-provider',
          modelId: 'silent-model',
          build: async () => ({
            id: 'silent-provider',
            name: 'silent-provider',
            async *stream(): AsyncIterable<StreamEvent> {
              yield { type: 'message_start' } as any;
              await new Promise(() => {});
            },
            async complete() { throw new Error('unused'); },
            async validateAuth() { return true; },
          }),
        },
        {
          profileId: 'fallback',
          providerId: 'fallback-provider',
          modelId: 'fallback-model',
          build: async () => {
            fallbackBuilds += 1;
            return fakeProvider('fallback', { streamEvents: [{ type: 'text_delta', text: 'unexpected' } as any] });
          },
        },
      ],
    });

    const draining = collect(p.stream({ ...PARAMS, signal: controller.signal }));
    setTimeout(() => controller.abort(new Error('cancelled by caller')), 20);
    await expect(draining).rejects.toThrow(/cancelled by caller/);
    expect(fallbackBuilds).toBe(0);
  });

  it('gives cancellation precedence when provider construction fails after the caller aborts', async () => {
    const controller = new AbortController();
    const buildStarted = Promise.withResolvers<void>();
    const buildResult = Promise.withResolvers<LLMProvider>();
    let fallbackBuilds = 0;
    const p = createRotatingProvider({
      providerId: 'test',
      candidates: [
        {
          profileId: 'building',
          providerId: 'building-provider',
          modelId: 'building-model',
          build: async () => {
            buildStarted.resolve();
            return buildResult.promise;
          },
        },
        {
          profileId: 'fallback',
          providerId: 'fallback-provider',
          modelId: 'fallback-model',
          build: async () => {
            fallbackBuilds += 1;
            return fakeProvider('fallback', { streamEvents: [{ type: 'text_delta', text: 'unexpected' } as any] });
          },
        },
      ],
    });

    const firstEvent = p.stream({ ...PARAMS, signal: controller.signal })[Symbol.asyncIterator]().next();
    await buildStarted.promise;
    controller.abort(new Error('cancelled during provider construction'));
    buildResult.reject(Object.assign(new Error('credential initialization failed'), { status: 401 }));

    await expect(firstEvent).rejects.toThrow(/cancelled during provider construction/);
    expect(fallbackBuilds).toBe(0);
    expect(getCooldown('building')).toBeUndefined();
  });

  it('rotates on a 429 rate limit', async () => {
    const rateErr = Object.assign(new Error('Too Many Requests'), { status: 429 });
    const p = createRotatingProvider({
      providerId: 'test',
      candidates: [
        candidate('p1', { throwBefore: rateErr }),
        candidate('p2', { streamEvents: [{ type: 'text_delta', text: 'ok' } as any] }),
      ],
    });
    const events = await collect(p.stream(PARAMS));
    expect(events.length).toBe(1);
    expect(getCooldown('p1')).toBeUndefined();
  });

  it('treats a 429 insufficient-quota response as balance exhaustion without a network retry', async () => {
    const quotaErr = Object.assign(new Error('429 {"error":{"message":"insufficient quota","type":"insufficient_quota"}}'), { status: 429, code: 'insufficient_quota' });
    const p = createRotatingProvider({
      providerId: 'test',
      networkRetryDelayMs: () => 0,
      candidates: [
        candidate('p1', { throwBefore: quotaErr }, 'openai', 'gpt-5.4'),
        candidate('p2', { streamEvents: [{ type: 'text_delta', text: 'ok' } as any] }, 'deepseek', 'deepseek-v4-pro'),
      ],
    });
    const events = await collect(p.stream(PARAMS));
    expect(events.some((ev: any) => ev.type === 'retry')).toBe(false);
    expect((events.at(-1) as any).text).toBe('ok');
    expect(getCooldown('p1')?.kind).toBe('balance');
  });

  it('rotates on an in-band balance-exhaustion error', async () => {
    const quotaErr = Object.assign(new Error('429 账户余额不足'), { status: 402, code: 'insufficient_balance' });
    const p = createRotatingProvider({
      providerId: 'test',
      networkRetryDelayMs: () => 0,
      candidates: [
        candidate('p1', {
          streamEvents: [
            { type: 'message_start' } as any,
            { type: 'error', error: quotaErr } as any,
          ],
        }, 'openai', 'gpt-5.4'),
        candidate('p2', { streamEvents: [{ type: 'text_delta', text: 'ok' } as any] }, 'openai-codex', 'gpt-5.5'),
      ],
    });
    const events = await collect(p.stream(PARAMS));
    expect(events.some((ev: any) => ev.type === 'retry')).toBe(false);
    expect((events.at(-1) as any).text).toBe('ok');
    expect(getCooldown('p1')?.kind).toBe('balance');
  });

  it('rotates on a localized balance-exhaustion error', async () => {
    const balanceErr = Object.assign(new Error('账户余额不足，请充值'), { status: 402, code: 'insufficient_balance' });
    const p = createRotatingProvider({
      providerId: 'test',
      candidates: [
        candidate('p1', { throwBefore: balanceErr }),
        candidate('p2', { streamEvents: [{ type: 'text_delta', text: 'ok' } as any] }),
      ],
    });
    await collect(p.stream(PARAMS));
    expect(getCooldown('p1')?.kind).toBe('balance');
  });

  it('rotates when provider construction reports a credential failure', async () => {
    const authErr = Object.assign(new Error('invalid_api_key'), { status: 401, code: 'invalid_api_key' });
    const p = createRotatingProvider({
      providerId: 'test',
      candidates: [
        candidate('p1', { buildError: authErr }),
        candidate('p2', { streamEvents: [{ type: 'text_delta', text: 'ok' } as any] }),
      ],
    });
    const events = await collect(p.stream(PARAMS));
    expect(events.length).toBe(2);
    expect(events[0]).toMatchObject({ type: 'provider_fallback', reason: 'auth' });
    expect(getCooldown('p1')?.kind).toBe('auth');
  });

  it('retries a fetch failure three times before moving to the next candidate', async () => {
    const netErr = Object.assign(new TypeError('fetch failed'), { code: 'ECONNRESET' });
    let p1Builds = 0;
    let p2Builds = 0;
    const p = createRotatingProvider({
      providerId: 'test',
      networkRetryDelayMs: () => 0,
      candidates: [
        {
          profileId: 'p1',
          providerId: 'test',
          modelId: 'test-model',
          build: async () => {
            p1Builds += 1;
            return fakeProvider('p1', { throwBefore: netErr });
          },
        },
        {
          profileId: 'p2',
          providerId: 'test',
          modelId: 'test-model',
          build: async () => {
            p2Builds += 1;
            return fakeProvider('p2', { streamEvents: [{ type: 'text_delta', text: 'ok' } as any] });
          },
        },
      ],
    });
    const events = await collect(p.stream(PARAMS));
    expect(p1Builds).toBe(4); // initial try + 3 retries
    expect(p2Builds).toBe(1);
    expect(events.filter((ev: any) => ev.type === 'retry').map((ev: any) => ev.attempt)).toEqual([1, 2, 3]);
    expect((events[events.length - 1] as any).text).toBe('ok');
    expect(getCooldown('p1')).toBeUndefined();
    expect(getCooldown('p2')).toBeUndefined();
  });

  it('does not retry or rotate when storage is full', async () => {
    const storageErr = Object.assign(
      new Error('ENOSPC: no space left on device, write'),
      { code: 'ENOSPC' },
    );
    let primaryBuilds = 0;
    let fallbackBuilds = 0;
    const p = createRotatingProvider({
      providerId: 'test',
      networkRetryAttempts: 3,
      networkRetryDelayMs: () => 0,
      candidates: [
        {
          profileId: 'primary',
          providerId: 'test',
          modelId: 'test-model',
          build: async () => {
            primaryBuilds += 1;
            return fakeProvider('primary', { throwBefore: storageErr });
          },
        },
        {
          profileId: 'fallback',
          providerId: 'test',
          modelId: 'test-model',
          build: async () => {
            fallbackBuilds += 1;
            return fakeProvider('fallback', {
              streamEvents: [{ type: 'text_delta', text: 'should not run' } as any],
            });
          },
        },
      ],
    });

    await expect(collect(p.stream(PARAMS))).rejects.toBe(storageErr);
    expect(primaryBuilds).toBe(1);
    expect(fallbackBuilds).toBe(0);
  });

  it('does not refresh the same-candidate retry budget during an AgentRunner recovery attempt', async () => {
    const netErr = Object.assign(new TypeError('fetch failed'), { code: 'ECONNRESET' });
    let primaryBuilds = 0;
    let fallbackBuilds = 0;
    const p = createRotatingProvider({
      providerId: 'test',
      networkRetryAttempts: 3,
      networkRetryDelayMs: () => 0,
      candidates: [
        {
          profileId: 'primary',
          providerId: 'test',
          modelId: 'test-model',
          build: async () => {
            primaryBuilds++;
            return fakeProvider('primary', { throwBefore: netErr });
          },
        },
        {
          profileId: 'fallback',
          providerId: 'test',
          modelId: 'test-model',
          build: async () => {
            fallbackBuilds++;
            return fakeProvider('fallback', {
              streamEvents: [{ type: 'text_delta', text: 'recovered without nested retries' } as any],
            });
          },
        },
      ],
    });

    const events = await collect(p.stream({
      ...PARAMS,
      retryContext: { agentAttempt: 1 },
    }));

    expect(primaryBuilds).toBe(1);
    expect(fallbackBuilds).toBe(1);
    expect(events.some((event: any) => event.type === 'retry')).toBe(false);
    expect((events.at(-1) as any).text).toBe('recovered without nested retries');
  });

  it('Stream ended without finish_reason retries the current candidate before fallback', async () => {
    const streamErr = new ProviderError('Stream ended without finish_reason', 'openai-completions');
    let p1Builds = 0;
    let p2Builds = 0;
    const p = createRotatingProvider({
      providerId: 'test',
      networkRetryDelayMs: () => 0,
      candidates: [
        {
          profileId: 'p1',
          providerId: 'openai-completions',
          modelId: 'gpt-test',
          build: async () => {
            p1Builds += 1;
            return fakeProvider('p1', { throwBefore: streamErr });
          },
        },
        {
          profileId: 'p2',
          providerId: 'test',
          modelId: 'test-model',
          build: async () => {
            p2Builds += 1;
            return fakeProvider('p2', { streamEvents: [{ type: 'text_delta', text: 'ok' } as any] });
          },
        },
      ],
    });
    const events = await collect(p.stream(PARAMS));
    expect(p1Builds).toBe(4);
    expect(p2Builds).toBe(1);
    expect(events.filter((ev: any) => ev.type === 'retry').map((ev: any) => ev.attempt)).toEqual([1, 2, 3]);
    expect((events[events.length - 1] as any).text).toBe('ok');
    expect(getCooldown('p1')).toBeUndefined();
  });

  it('unknown pre-content provider errors default to retryable', async () => {
    const unknownErr = new ProviderError('Unexpected provider stream failure', 'test');
    let p1Builds = 0;
    let p2Builds = 0;
    const p = createRotatingProvider({
      providerId: 'test',
      networkRetryAttempts: 1,
      networkRetryDelayMs: () => 0,
      candidates: [
        {
          profileId: 'p1',
          providerId: 'test',
          modelId: 'test-model',
          build: async () => {
            p1Builds += 1;
            return fakeProvider('p1', { throwBefore: unknownErr });
          },
        },
        {
          profileId: 'p2',
          providerId: 'test',
          modelId: 'test-model',
          build: async () => {
            p2Builds += 1;
            return fakeProvider('p2', { streamEvents: [{ type: 'text_delta', text: 'ok' } as any] });
          },
        },
      ],
    });
    const events = await collect(p.stream(PARAMS));
    expect(p1Builds).toBe(2);
    expect(p2Builds).toBe(1);
    expect(events.filter((ev: any) => ev.type === 'retry').map((ev: any) => ev.attempt)).toEqual([1]);
    expect((events[events.length - 1] as any).text).toBe('ok');
    expect(getCooldown('p1')).toBeUndefined();
  });

  it('retries a 503 provider failure three times before moving to the next candidate', async () => {
    const err503 = new ProviderError('503 status code (no body)', 'example-provider', 503);
    let p1Builds = 0;
    let p2Builds = 0;
    const p = createRotatingProvider({
      providerId: 'test',
      networkRetryDelayMs: () => 0,
      candidates: [
        {
          profileId: 'p1',
          providerId: 'example-provider',
          modelId: 'example-model',
          build: async () => {
            p1Builds += 1;
            return fakeProvider('p1', { throwBefore: err503 });
          },
        },
        {
          profileId: 'p2',
          providerId: 'test',
          modelId: 'test-model',
          build: async () => {
            p2Builds += 1;
            return fakeProvider('p2', { streamEvents: [{ type: 'text_delta', text: 'ok' } as any] });
          },
        },
      ],
    });
    const events = await collect(p.stream(PARAMS));
    expect(p1Builds).toBe(4);
    expect(p2Builds).toBe(1);
    expect(events.filter((ev: any) => ev.type === 'retry').map((ev: any) => ev.attempt)).toEqual([1, 2, 3]);
    expect((events[events.length - 1] as any).text).toBe('ok');
    expect(getCooldown('p1')).toBeUndefined();
    expect(getCooldown('p2')).toBeUndefined();
  });
});

describe('rotating-provider › non-rotatable stream failures', () => {
  beforeEach(() => _clearAll());

  it('surfaces a 400 invalid request without trying another candidate', async () => {
    const badReq = Object.assign(new Error('invalid_request_error: missing model'), { status: 400 });
    let p2Called = false;
    const p = createRotatingProvider({
      providerId: 'test',
      candidates: [
        candidate('p1', { throwBefore: badReq }),
        {
          profileId: 'p2',
          build: async () => { p2Called = true; return fakeProvider('p2', { streamEvents: [] }); },
        },
      ],
    });
    await expect(collect(p.stream(PARAMS))).rejects.toThrow(/invalid_request/);
    expect(p2Called).toBe(false);
    // The credential remains usable because the request, not the key, failed.
    expect(getCooldown('p1')).toBeUndefined();
  });

  it('surfaces a content-policy error without rotating', async () => {
    const policy = new Error('content_policy_violation: user asked for X');
    const p = createRotatingProvider({
      providerId: 'test',
      candidates: [
        candidate('p1', { throwBefore: policy }),
        candidate('p2', { streamEvents: [{ type: 'text_delta', text: 'ok' } as any] }),
      ],
    });
    await expect(collect(p.stream(PARAMS))).rejects.toThrow(/content_policy/);
    expect(getCooldown('p1')).toBeUndefined();
  });

  it('preserves a structured provider safety error without retrying or falling back', async () => {
    const safety = Object.assign(new Error('Request rejected by provider'), {
      code: 'ResponsibleAIPolicyViolation',
    });
    let primaryBuilds = 0;
    let fallbackBuilds = 0;
    const p = createRotatingProvider({
      providerId: 'test',
      networkRetryDelayMs: () => 0,
      candidates: [
        {
          profileId: 'p1',
          providerId: 'test',
          modelId: 'test-model',
          build: async () => {
            primaryBuilds += 1;
            return fakeProvider('p1', { throwBefore: safety });
          },
        },
        {
          profileId: 'p2',
          providerId: 'test',
          modelId: 'test-model',
          build: async () => {
            fallbackBuilds += 1;
            return fakeProvider('p2', { streamEvents: [{ type: 'text_delta', text: 'bypassed' } as any] });
          },
        },
      ],
    });

    await expect(collect(p.stream(PARAMS))).rejects.toThrow(/rejected by provider/);
    expect(primaryBuilds).toBe(1);
    expect(fallbackBuilds).toBe(0);
    expect(getCooldown('p1')).toBeUndefined();
  });

  it.each([false, true])('legacy Server message patterns cannot suppress bounded recovery (structured=%s)', async structured => {
    const users = await import('../../../../src/main/features/users');
    const paths = await import('../../../../src/main/paths');
    const storage = await import('../../../../src/main/storage');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const uid = 'rotatingproviderretrypolicy';
    users.activateUser(uid);
    const file = paths.userRemoteConfigFile(uid);
    storage.writeJsonSync(file, {
      version: 1,
      active: {
        immediate: {
          'model.retry_error_policy': {
            permanent_message_patterns: ['custom_non_retryable'],
          },
        },
      },
    });

    try {
      let p2Called = false;
      const p = createRotatingProvider({
        providerId: 'test',
        networkRetryDelayMs: () => 0,
        candidates: [
          candidate('p1', { throwBefore: Object.assign(new Error('custom_non_retryable'), structured ? { status: 503 } : {}) }),
          {
            profileId: 'p2',
            providerId: 'test',
            modelId: 'test-model',
            build: async () => {
              p2Called = true;
              return fakeProvider('p2', { streamEvents: [{ type: 'text_delta', text: 'ok' } as any] });
            },
          },
        ],
      });
      const events = await collect(p.stream(PARAMS));
      expect(events.filter(event => event.type === 'retry')).toHaveLength(3);
      expect(events.at(-1)).toMatchObject({ type: 'text_delta', text: 'ok' });
      expect(p2Called).toBe(true);
      expect(getCooldown('p1')).toBeUndefined();
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });
});

describe('rotating-provider › stream preamble drain', () => {
  beforeEach(() => _clearAll());

  it('treats an iterator ending before a terminal event as transport-empty and can fall back', async () => {
    const p = createRotatingProvider({
      providerId: 'test',
      networkRetryAttempts: 0,
      candidates: [
        candidate('p1', {
          streamEvents: [
            { type: 'message_start' } as any,
            { type: 'text_delta', text: '   ' } as any,
          ],
        }),
        candidate('p2', { streamEvents: [{ type: 'text_delta', text: 'recovered' } as any] }),
      ],
    });

    const events = await collect(p.stream(PARAMS));
    expect(events[0]).toMatchObject({
      type: 'provider_empty',
      kind: 'transport_empty',
      terminalEventSeen: false,
      candidateIndex: 1,
      candidateCount: 2,
    });
    expect(events.at(-1)).toMatchObject({ type: 'text_delta', text: 'recovered' });
  });

  it('retries a normal terminal empty response once on the same candidate without fallback', async () => {
    let primaryBuilds = 0;
    let fallbackBuilds = 0;
    const p = createRotatingProvider({
      providerId: 'test',
      candidates: [
        {
          profileId: 'p1',
          providerId: 'test',
          modelId: 'test-model',
          build: async () => {
            primaryBuilds += 1;
            return fakeProvider('p1', {
              streamEvents: primaryBuilds === 1
                ? [{
                    type: 'message_end',
                    stopReason: 'end_turn',
                    usage: { inputTokens: 4, outputTokens: 0, totalTokens: 4 },
                    content: [],
                    providerTermination: { category: 'normal' },
                  } as any]
                : [{ type: 'text_delta', text: 'same-model recovery' } as any],
            });
          },
        },
        {
          profileId: 'p2',
          providerId: 'fallback',
          modelId: 'fallback-model',
          build: async () => {
            fallbackBuilds += 1;
            return fakeProvider('p2', { streamEvents: [{ type: 'text_delta', text: 'wrong model' } as any] });
          },
        },
      ],
    });

    const events = await collect(p.stream(PARAMS));
    expect(events).toEqual([
      expect.objectContaining({
        type: 'provider_empty',
        kind: 'normal_end_empty',
        terminalEventSeen: true,
        usage: { inputTokens: 4, outputTokens: 0, totalTokens: 4 },
      }),
      expect.objectContaining({ type: 'retry', attempt: 1 }),
      expect.objectContaining({ type: 'text_delta', text: 'same-model recovery' }),
    ]);
    expect(primaryBuilds).toBe(2);
    expect(fallbackBuilds).toBe(0);
  });

  it('surfaces repeated normal terminal emptiness without crossing models', async () => {
    let primaryBuilds = 0;
    let fallbackBuilds = 0;
    const empty = {
      type: 'message_end',
      stopReason: 'end_turn',
      usage: { inputTokens: 4, outputTokens: 0, totalTokens: 4 },
      content: [],
      providerTermination: { category: 'normal' },
    } as any;
    const p = createRotatingProvider({
      providerId: 'test',
      candidates: [
        {
          profileId: 'p1',
          providerId: 'test',
          modelId: 'test-model',
          build: async () => {
            primaryBuilds += 1;
            return fakeProvider('p1', { streamEvents: [empty] });
          },
        },
        {
          profileId: 'p2',
          providerId: 'fallback',
          modelId: 'fallback-model',
          build: async () => {
            fallbackBuilds += 1;
            return fakeProvider('p2', { streamEvents: [{ type: 'text_delta', text: 'wrong model' } as any] });
          },
        },
      ],
    });

    await expect(collect(p.stream(PARAMS))).rejects.toMatchObject({
      code: PROVIDER_EMPTY_NORMAL_CODE,
      message: 'empty response',
    });
    expect(primaryBuilds).toBe(2);
    expect(fallbackBuilds).toBe(0);
  });

  it('does not cross models when the one normal-empty recovery request hits a transport error', async () => {
    let primaryBuilds = 0;
    let fallbackBuilds = 0;
    const p = createRotatingProvider({
      providerId: 'test',
      candidates: [
        {
          profileId: 'p1',
          providerId: 'test',
          modelId: 'test-model',
          build: async () => {
            primaryBuilds += 1;
            return fakeProvider('p1', primaryBuilds === 1
              ? { streamEvents: [{
                  type: 'message_end',
                  stopReason: 'end_turn',
                  content: [],
                  providerTermination: { category: 'normal' },
                } as any] }
              : { throwBefore: new Error('fetch failed during empty recovery') });
          },
        },
        {
          profileId: 'p2',
          providerId: 'fallback',
          modelId: 'fallback-model',
          build: async () => {
            fallbackBuilds += 1;
            return fakeProvider('p2', { streamEvents: [{ type: 'text_delta', text: 'wrong model' } as any] });
          },
        },
      ],
      networkRetryDelayMs: () => 0,
    });

    await expect(collect(p.stream(PARAMS))).rejects.toThrow(/fetch failed during empty recovery/);
    expect(primaryBuilds).toBe(2);
    expect(fallbackBuilds).toBe(0);
  });

  it('does not add a nested normal-empty retry during an AgentRunner recovery attempt', async () => {
    let builds = 0;
    const p = createRotatingProvider({
      providerId: 'test',
      candidates: [{
        profileId: 'p1',
        providerId: 'test',
        modelId: 'test-model',
        build: async () => {
          builds += 1;
          return fakeProvider('p1', { streamEvents: [{
            type: 'message_end',
            stopReason: 'end_turn',
            content: [],
            providerTermination: { category: 'normal' },
          } as any] });
        },
      }],
    });

    await expect(collect(p.stream({
      ...PARAMS,
      retryContext: { agentAttempt: 1 },
    }))).rejects.toMatchObject({ code: PROVIDER_EMPTY_NORMAL_CODE });
    expect(builds).toBe(1);
  });

  it.each([
    ['safety', 'safety_filtered_empty', PROVIDER_EMPTY_SAFETY_CODE],
    ['unknown', 'unknown_empty', PROVIDER_EMPTY_UNKNOWN_CODE],
  ] as const)('does not retry or fall back for %s terminal emptiness', async (category, kind, code) => {
    let primaryBuilds = 0;
    let fallbackBuilds = 0;
    const p = createRotatingProvider({
      providerId: 'test',
      candidates: [
        {
          profileId: 'p1',
          providerId: 'test',
          modelId: 'test-model',
          build: async () => {
            primaryBuilds += 1;
            return fakeProvider('p1', { streamEvents: [{
              type: 'message_end',
              stopReason: 'end_turn',
              content: [],
              providerTermination: { category },
            } as any] });
          },
        },
        {
          profileId: 'p2',
          providerId: 'fallback',
          modelId: 'fallback-model',
          build: async () => {
            fallbackBuilds += 1;
            return fakeProvider('p2', { streamEvents: [{ type: 'text_delta', text: 'wrong model' } as any] });
          },
        },
      ],
    });

    const seen: StreamEvent[] = [];
    let failure: unknown;
    try {
      for await (const event of p.stream(PARAMS)) seen.push(event);
    } catch (err) {
      failure = err;
    }
    expect(failure).toMatchObject({ code });
    expect(seen).toEqual([
      expect.objectContaining({ type: 'provider_empty', kind, terminalEventSeen: true }),
    ]);
    expect(primaryBuilds).toBe(1);
    expect(fallbackBuilds).toBe(0);
  });

  it('accepts terminal message content when the provider emitted no text deltas', async () => {
    let winner: string | null = null;
    const p = createRotatingProvider({
      providerId: 'test',
      candidates: [candidate('p1', {
        streamEvents: [
          { type: 'message_start' } as any,
          {
            type: 'message_end',
            stopReason: 'end_turn',
            usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6 },
            content: [{ type: 'text', text: 'terminal answer' }],
          } as any,
        ],
      })],
      onSuccess: (pid) => { winner = pid; },
    });

    const events = await collect(p.stream(PARAMS));
    expect(events.at(-1)).toMatchObject({
      type: 'message_end',
      content: [{ type: 'text', text: 'terminal answer' }],
    });
    expect(winner).toBe('p1');
  });

  it('still rotates after a start preamble followed by a 401', async () => {
    // pi-ai emits start before the provider request can report a 401.
    // Treating that preamble as committed user-visible content would prevent
    // fallback and leave the user with an avoidable failure.
    const authErr = Object.assign(new Error('401 Incorrect API key'), { status: 401 });
    let winner: string | null = null;
    const p = createRotatingProvider({
      providerId: 'test',
      candidates: [
        candidate('p1', {
          streamEvents: [{ type: 'start', model: 't' } as any],
          throwAfter: authErr,
        }),
        candidate('p2', {
          streamEvents: [
            { type: 'start', model: 't' } as any,
            { type: 'text_delta', text: 'ok' } as any,
          ],
        }),
      ],
      onSuccess: (pid) => { winner = pid; },
    });
    const events = await collect(p.stream(PARAMS));
    expect(winner).toBe('p2');
    expect(getCooldown('p1')?.kind).toBe('auth');
    // Forward both the fallback candidate's preamble and its text.
    expect(events.length).toBe(3);
    expect(events[0]).toMatchObject({ type: 'provider_fallback', reason: 'auth' });
    expect((events[2] as any).text).toBe('ok');
  });

  it('rotates on an in-band error event', async () => {
    const authErr = Object.assign(new Error('401 invalid'), { status: 401 });
    const p = createRotatingProvider({
      providerId: 'test',
      candidates: [
        candidate('p1', {
          streamEvents: [
            { type: 'start', model: 't' } as any,
            { type: 'error', error: authErr } as any,
          ],
        }),
        candidate('p2', {
          streamEvents: [{ type: 'text_delta', text: 'ok' } as any],
        }),
      ],
    });
    const events = await collect(p.stream(PARAMS));
    expect(events.length).toBe(2);
    expect(events[0]).toMatchObject({ type: 'provider_fallback', reason: 'auth' });
    expect((events[1] as any).text).toBe('ok');
    expect(getCooldown('p1')?.kind).toBe('auth');
  });

  it('does not commit after repeated preambles and still rotates on a later error', async () => {
    const authErr = Object.assign(new Error('invalid_api_key'), { status: 401, code: 'invalid_api_key' });
    const p = createRotatingProvider({
      providerId: 'test',
      candidates: [
        candidate('p1', {
          streamEvents: [
            { type: 'start', model: 't' } as any,
            { type: 'content_block_start', index: 0 } as any,
            { type: 'error', error: authErr } as any,
          ],
        }),
        candidate('p2', {
          streamEvents: [{ type: 'text_delta', text: 'ok' } as any],
        }),
      ],
    });
    const events = await collect(p.stream(PARAMS));
    expect((events[events.length - 1] as any).text).toBe('ok');
    expect(getCooldown('p1')?.kind).toBe('auth');
  });
});

describe('rotating-provider › AgentRunner empty recovery', () => {
  beforeEach(() => _clearAll());

  it('reuses committed tool results instead of executing tools again', async () => {
    let providerRequests = 0;
    let toolExecutions = 0;
    let fallbackBuilds = 0;
    const requestMessages: CompletionParams['messages'][] = [];
    const primary: RotatingCandidate = {
      profileId: 'primary',
      providerId: 'mock',
      modelId: 'mock-model',
      build: async () => ({
        id: 'mock',
        name: 'Mock',
        async *stream(params: CompletionParams): AsyncIterable<StreamEvent> {
          providerRequests += 1;
          requestMessages.push(params.messages);
          yield { type: 'message_start' };
          if (providerRequests === 1) {
            yield {
              type: 'message_end',
              stopReason: 'tool_use',
              usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
              content: [{ type: 'tool_use', id: 'call-once', name: 'count_once', input: {} }],
              providerTermination: { category: 'normal' },
              model: 'mock-model',
            };
          } else if (providerRequests === 2) {
            yield {
              type: 'message_end',
              stopReason: 'end_turn',
              usage: { inputTokens: 4, outputTokens: 0, totalTokens: 4 },
              content: [],
              providerTermination: { category: 'normal' },
              model: 'mock-model',
            };
          } else {
            yield {
              type: 'message_end',
              stopReason: 'end_turn',
              usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
              content: [{ type: 'text', text: 'recovered without replay' }],
              providerTermination: { category: 'normal' },
              model: 'mock-model',
            };
          }
        },
        async complete() { throw new Error('unused'); },
        async validateAuth() { return true; },
      }),
    };
    const rotating = createRotatingProvider({
      providerId: 'mock',
      candidates: [
        primary,
        {
          profileId: 'fallback',
          providerId: 'fallback',
          modelId: 'fallback-model',
          build: async () => {
            fallbackBuilds += 1;
            return fakeProvider('fallback', { streamEvents: [{ type: 'text_delta', text: 'wrong model' } as any] });
          },
        },
      ],
    });
    const registry = new ProviderRegistry();
    registry.registerFactory('mock', () => rotating);
    const tool = defineTool({
      name: 'count_once',
      description: 'Count one execution',
      inputSchema: { type: 'object', properties: {} },
      async execute() {
        toolExecutions += 1;
        return { content: 'tool result already committed' };
      },
    });
    const runner = new AgentRunner({
      config: createConfig({ agent: { defaultProvider: 'mock', defaultModel: 'mock-model' } }),
      providers: registry,
      tools: [tool],
    });

    const result = await runner.run({ message: 'run the tool once' });

    expect(result.text).toBe('recovered without replay');
    expect(providerRequests).toBe(3);
    expect(toolExecutions).toBe(1);
    expect(fallbackBuilds).toBe(0);
    expect(result.meta.usage).toMatchObject({ inputTokens: 11, outputTokens: 3, totalTokens: 14 });
    expect(JSON.stringify(requestMessages[1])).toContain('tool result already committed');
    expect(JSON.stringify(requestMessages[2])).toContain('tool result already committed');
  });
});

describe('rotating-provider › failures after visible stream content', () => {
  beforeEach(() => _clearAll());

  it('does not rotate when the caller deadline aborts a stream after first content', async () => {
    const controller = new AbortController();
    let fallbackBuilds = 0;
    const p = createRotatingProvider({
      providerId: 'test',
      candidates: [
        {
          profileId: 'started',
          providerId: 'started-provider',
          modelId: 'started-model',
          build: async () => ({
            id: 'started-provider',
            name: 'started-provider',
            async *stream(params): AsyncIterable<StreamEvent> {
              yield { type: 'text_delta', text: 'partial summary' } as any;
              await new Promise<void>((_resolve, reject) => {
                params.signal?.addEventListener('abort', () => {
                  reject(params.signal?.reason || new Error('aborted'));
                }, { once: true });
              });
            },
            async complete() { throw new Error('unused'); },
            async validateAuth() { return true; },
          }),
        },
        {
          profileId: 'fallback',
          providerId: 'fallback-provider',
          modelId: 'fallback-model',
          build: async () => {
            fallbackBuilds += 1;
            return fakeProvider('fallback', {
              streamEvents: [{ type: 'text_delta', text: 'must not run' } as any],
            });
          },
        },
      ],
    });
    const events: StreamEvent[] = [];
    const draining = (async () => {
      for await (const event of p.stream({ ...PARAMS, signal: controller.signal })) events.push(event);
    })();
    setTimeout(() => controller.abort(new Error('overall compaction timeout')), 20);

    await expect(draining).rejects.toThrow(/overall compaction timeout/);
    expect(events).toEqual([{ type: 'text_delta', text: 'partial summary' }]);
    expect(fallbackBuilds).toBe(0);
  });

  it('does not rotate after a text delta has committed visible content', async () => {
    const authErr = Object.assign(new Error('Unauthorized'), { status: 401 });
    let winner: string | null = null;
    let p2Called = false;
    const p = createRotatingProvider({
      providerId: 'test',
      candidates: [
        candidate('p1', {
          streamEvents: [{ type: 'text_delta', text: 'partial' } as any],
          throwAfter: authErr,
        }),
        {
          profileId: 'p2',
          build: async () => { p2Called = true; return fakeProvider('p2', { streamEvents: [] }); },
        },
      ],
      onSuccess: (pid) => { winner = pid; },
    });
    const events: StreamEvent[] = [];
    let thrown: unknown = null;
    try {
      for await (const ev of p.stream(PARAMS)) events.push(ev);
    } catch (err) {
      thrown = err;
    }
    expect(winner).toBe('p1');      // The first candidate owns the committed response.
    expect(events.length).toBe(1);  // Preserve partial text for recovery UI.
    expect(thrown).toBeTruthy();    // Surface the terminal failure.
    expect(p2Called).toBe(false);   // Do not splice a second model into the response.
  });
});

describe('rotating-provider › exhausted stream candidates', () => {
  beforeEach(() => _clearAll());

  it('cools every rejected credential and surfaces the final 401', async () => {
    const authErr = Object.assign(new Error('Unauthorized'), { status: 401 });
    const p = createRotatingProvider({
      providerId: 'test',
      candidates: [
        candidate('p1', { throwBefore: authErr }),
        candidate('p2', { throwBefore: authErr }),
        candidate('p3', { throwBefore: authErr }),
      ],
    });
    await expect(collect(p.stream(PARAMS))).rejects.toMatchObject({
      message: expect.stringMatching(/Unauthorized/),
      code: 'PROVIDER_AUTH_EXHAUSTED',
    });
    expect(getCooldown('p1')?.kind).toBe('auth');
    expect(getCooldown('p2')?.kind).toBe('auth');
    expect(getCooldown('p3')?.kind).toBe('auth');
  });

  it('rejects an empty candidate list at construction', () => {
    expect(() => createRotatingProvider({
      providerId: 'test',
      candidates: [],
    })).toThrow(/candidates list is empty/);
  });

  it('returns a structured unavailable error when every candidate was exhausted earlier in the run', async () => {
    const authErr = Object.assign(new Error('Unauthorized'), { status: 401 });
    const p = createRotatingProvider({
      providerId: 'test',
      candidates: [candidate('p1', { throwBefore: authErr })],
    });

    await expect(collect(p.stream(PARAMS))).rejects.toMatchObject({
      code: 'PROVIDER_AUTH_EXHAUSTED',
    });
    await expect(p.complete(PARAMS)).rejects.toMatchObject({
      code: 'PROVIDER_CANDIDATES_UNAVAILABLE',
    });
    await expect(collect(p.stream(PARAMS))).rejects.toMatchObject({
      code: 'PROVIDER_CANDIDATES_UNAVAILABLE',
    });
  });

  it('retries each network-failing candidate and surfaces a stable exhausted error without cooldown', async () => {
    const netErr = Object.assign(new TypeError('fetch failed'), { code: 'ECONNRESET' });
    let p1Builds = 0;
    let p2Builds = 0;
    const p = createRotatingProvider({
      providerId: 'test',
      networkRetryDelayMs: () => 0,
      candidates: [
        {
          profileId: 'p1',
          providerId: 'test',
          modelId: 'test-model',
          build: async () => {
            p1Builds += 1;
            return fakeProvider('p1', { throwBefore: netErr });
          },
        },
        {
          profileId: 'p2',
          providerId: 'test',
          modelId: 'test-model',
          build: async () => {
            p2Builds += 1;
            return fakeProvider('p2', { throwBefore: netErr });
          },
        },
      ],
    });
    await expect(collect(p.stream(PARAMS))).rejects.toMatchObject({
      message: expect.stringMatching(/All configured model candidates failed after network retries/),
      code: 'PROVIDER_NETWORK_EXHAUSTED',
      // The sentence above is diagnostic and reaches nobody useful on its own:
      // 2026-08-08 a transient blip mid-run showed the user "[network]
      // connection failed", which names a transport they cannot act on and
      // omits the one thing they can do. Keeping the original error as `cause`
      // is what lets the existing classifier recognise this as transient and
      // the user see "the model connection is unstable. Try again later."
      cause: netErr,
    });
    expect(classifyTransientNetworkError(
      Object.assign(new Error('All configured model candidates failed after network retries: [network] connection failed'), {
        code: 'PROVIDER_NETWORK_EXHAUSTED',
        cause: netErr,
      }),
    )).toBeTruthy();
    expect(p1Builds).toBe(4);
    expect(p2Builds).toBe(4);
    expect(getCooldown('p1')).toBeUndefined();
    expect(getCooldown('p2')).toBeUndefined();
  });
});

describe('rotating-provider › cross-provider fallback', () => {
  beforeEach(() => _clearAll());

  it.each(['complete', 'stream'] as const)('requires image input in %s without calling text-only candidates', async method => {
    const textBuild = vi.fn(async () => fakeProvider('text', {
      completeResult: { content: [{ type: 'text', text: 'blind answer' }] }, streamEvents: [{ type: 'text_delta', text: 'blind answer' } as any],
    }));
    const received: CompletionParams[] = [];
    const vision: LLMProvider = {
      id: 'vision', name: 'vision', validateAuth: async () => true,
      complete: async params => { received.push(params); return { content: [{ type: 'text', text: 'red chart' }] } as any; },
      async *stream(params) { received.push(params); yield { type: 'text_delta', text: 'red chart' } as any; },
    };
    const provider = createRotatingProvider({
      providerId: 'test', requireImageInput: true,
      candidates: [
        { ...candidate('text', {}), maxInputImages: 0, build: textBuild },
        { ...candidate('vision', {}), maxInputImages: 1, build: async () => vision },
        { ...candidate('unused', {}), maxInputImages: 1, build: textBuild },
      ],
    });
    const params: CompletionParams = { ...PARAMS, messages: [{ role: 'user', content: [
      { type: 'image', data: 'red-pixels', mediaType: 'image/png' },
    ] }] };
    if (method === 'complete') expect((await provider.complete(params)).content).toEqual([{ type: 'text', text: 'red chart' }]);
    else expect(await collect(provider.stream(params))).toContainEqual({ type: 'text_delta', text: 'red chart' });
    expect(textBuild).not.toHaveBeenCalled();
    expect(received).toHaveLength(1);
    expect(received[0].messages).toEqual(params.messages);
    expect(getCooldown('text')).toBeUndefined();
  });

  it.each(['complete', 'stream'] as const)('fails %s without requests when every configured candidate lacks vision', async method => {
    const build = vi.fn(async () => fakeProvider('blind', {}));
    const provider = createRotatingProvider({
      providerId: 'test', requireImageInput: true,
      candidates: [
        { ...candidate('text', {}), maxInputImages: 0, build },
        { ...candidate('observed', {}), imageSupport: { unsupported: true, observeRejection() {} }, build },
      ],
    });
    const params: CompletionParams = { ...PARAMS, messages: [{ role: 'user', content: [
      { type: 'image', data: 'red-pixels', mediaType: 'image/png' },
    ] }] };
    const error = await (method === 'complete' ? provider.complete(params) : collect(provider.stream(params)))
      .catch(error => error);
    expect(error).toMatchObject({ code: 'UNSUPPORTED_MODEL' });
    expect(classifyRetryableError(error)).toBeNull();
    expect(build).not.toHaveBeenCalled();
  });

  it.each(['complete', 'stream'] as const)('keeps pixels when an unknown custom model rejects images during %s', async method => {
    const { customModelImageSupport } = await import('../../../../src/main/model/core-agent/custom-model-image-support');
    const imageSupport = customModelImageSupport({ userId: 'vision-test', profileId: method,
      modelId: 'unknown', apiKey: 'test-only', config: {} });
    const rejection = Object.assign(new Error('This model does not support image inputs.'), { status: 400 });
    const primary = vi.fn(async () => fakeProvider('unknown', { throwBefore: rejection, completeError: rejection }));
    const received: CompletionParams[] = [];
    const provider = createRotatingProvider({
      providerId: 'custom', requireImageInput: true,
      candidates: [
        { ...candidate('unknown', {}, 'custom'), imageSupport, build: primary },
        { ...candidate('vision', {}), maxInputImages: 1, build: async () => ({
          id: 'vision', name: 'vision', validateAuth: async () => true,
          async complete(params) { received.push(params); return { content: [{ type: 'text', text: 'red' }] } as any; },
          async *stream(params) { received.push(params); yield { type: 'text_delta', text: 'red' } as any; },
        }) },
      ],
    });
    const params: CompletionParams = { ...PARAMS, messages: [{ role: 'user', content: [
      { type: 'image', data: 'red-pixels', mediaType: 'image/png' },
    ] }] };
    if (method === 'complete') await provider.complete(params);
    else await collect(provider.stream(params));
    expect(primary).toHaveBeenCalledTimes(1);
    expect(received).toHaveLength(1);
    expect(received[0].messages).toEqual(params.messages);
    expect(imageSupport.unsupported).toBe(true);
    expect(getCooldown('unknown')).toBeUndefined();
  });

  it('applies each fallback candidate image limit without mutating caller history', async () => {
    const authErr = Object.assign(new Error('401 primary rejected'), { status: 401 });
    const received: Array<{ provider: string; images: string[] }> = [];
    const messages: CompletionParams['messages'] = [{
      role: 'user',
      content: [
        { type: 'text', text: 'compare these' },
        ...Array.from({ length: 6 }, (_item, index) => ({
          type: 'image' as const,
          data: `image-${index}`,
          mediaType: 'image/jpeg' as const,
        })),
      ],
    }];
    const original = structuredClone(messages);
    const makeProvider = (provider: string, error?: unknown): LLMProvider => ({
      id: provider,
      name: provider,
      async *stream(params) {
        received.push({
          provider,
          images: params.messages.flatMap((message) => message.content)
            .filter((content) => content.type === 'image')
            .map((content) => content.data),
        });
        if (error) throw error;
        yield { type: 'text_delta', text: 'ok' } as any;
      },
      async complete() { throw new Error('unused'); },
      async validateAuth() { return true; },
    });
    const provider = createRotatingProvider({
      providerId: 'primary',
      candidates: [
        {
          profileId: 'primary',
          providerId: 'primary',
          modelId: 'vision-large',
          maxInputImages: 4,
          build: async () => makeProvider('primary', authErr),
        },
        {
          profileId: 'fallback',
          providerId: 'fallback',
          modelId: 'vision-small',
          maxInputImages: 2,
          build: async () => makeProvider('fallback'),
        },
      ],
    });

    await collect(provider.stream({ ...PARAMS, messages }));

    expect(received).toEqual([
      { provider: 'primary', images: ['image-0', 'image-1', 'image-2', 'image-3'] },
      { provider: 'fallback', images: ['image-0', 'image-1'] },
    ]);
    expect(messages).toEqual(original);
  });

  it('prioritizes a newly read image over older composer images in later model rounds', () => {
    const messages: CompletionParams['messages'] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'initial turn' },
          ...Array.from({ length: 4 }, (_item, index) => ({
            type: 'image' as const,
            data: `initial-${index}`,
            mediaType: 'image/jpeg' as const,
          })),
        ],
      },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tool-1', name: 'read_file', input: { path: '/attachment/5.png' } }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: 'tool-1', content: 'Image loaded.' }],
      },
      {
        role: 'user',
        content: [{ type: 'image', data: 'read-file-latest', mediaType: 'image/jpeg' }],
      },
    ];

    const bounded = boundMessagesForImageLimit(messages, 2);
    const images = bounded.flatMap((message) => message.content)
      .filter((content) => content.type === 'image')
      .map((content) => content.data);

    expect(images).toEqual(['initial-0', 'read-file-latest']);
    expect(messages[0].content.filter((content) => content.type === 'image')).toHaveLength(4);
    expect(bounded.at(-1)?.content).toEqual([{
      type: 'text',
      text: expect.stringContaining('max_images="2" omitted_images="3"'),
    }]);
  });

  it('removes all image blocks and tells a text-only candidate not to claim vision', () => {
    const bounded = boundMessagesForImageLimit([{
      role: 'user',
      content: [{ type: 'image', data: 'pixels', mediaType: 'image/png' }],
    }], 0);

    expect(bounded.flatMap((message) => message.content)
      .some((content) => content.type === 'image')).toBe(false);
    expect(bounded).toEqual([{
      role: 'developer',
      content: [{
        type: 'text',
        text: expect.stringContaining('vision_supported="false"'),
      }],
    }]);
  });

  it('K3 认证失败兜底到 Claude 时，同时切换模型和模型默认输出上限', async () => {
    const authErr = Object.assign(new Error('401 invalid kimi key'), { status: 401 });
    // 记录 fake provider 收到的模型参数，验证跨 provider 切换不能把
    // primary K3 的 131072 输出上限泄漏给最大只接受 128000 的 Claude。
    const received: Array<{ model: string; maxTokens: number | undefined }> = [];
    const makeProvider = (id: string, b: FakeBehavior): LLMProvider => ({
      id,
      name: id,
      async *stream(params) {
        received.push({ model: params.model, maxTokens: params.maxTokens });
        if (b.throwBefore !== undefined) throw b.throwBefore;
        for (const ev of (b.streamEvents ?? [])) yield ev;
      },
      async complete(params) {
        received.push({ model: params.model, maxTokens: params.maxTokens });
        if (b.completeError !== undefined) throw b.completeError;
        return b.completeResult;
      },
      async validateAuth() { return true; },
    });

    const p = createRotatingProvider({
      providerId: 'kimi-coding', // registry 里的路由 id（primary 的 provider）
      candidates: [
        {
          profileId: 'kimi-coding:default',
          providerId: 'kimi-coding',
          modelId: 'k3',
          maxTokens: 131_072,
          build: async () => makeProvider('kimi-coding', { throwBefore: authErr }),
        },
        {
          profileId: 'anthropic:default',
          providerId: 'anthropic',
          modelId: 'claude-opus-4-8',
          maxTokens: 128_000,
          build: async () => makeProvider('anthropic', {
            streamEvents: [{ type: 'text_delta', text: 'hello from claude' } as any],
          }),
        },
      ],
    });

    // AgentRunner 会把 primary 的模型默认上限放进 params；rotating 内部
    // 必须把 model 和该默认上限一起切到每个 candidate 自己的值。
    const events = await collect(p.stream({
      ...PARAMS,
      model: 'k3',
      maxTokens: 131_072,
      requestMetadata: { outputLimitSource: 'model_default' },
    }));
    expect(events.length).toBe(2);
    expect(events[0]).toMatchObject({ type: 'provider_fallback', reason: 'auth' });
    expect((events[1] as any).text).toBe('hello from claude');
    expect(received).toEqual([
      { model: 'k3', maxTokens: 131_072 },
      { model: 'claude-opus-4-8', maxTokens: 128_000 },
    ]);
  });

  it('跨 provider fallback 保留摘要等调用方显式指定的输出上限', async () => {
    const authErr = Object.assign(new Error('401 invalid kimi key'), { status: 401 });
    const received: Array<{ model: string; maxTokens: number | undefined }> = [];
    const makeProvider = (id: string, throwBefore?: unknown): LLMProvider => ({
      id,
      name: id,
      async *stream(params) {
        received.push({ model: params.model, maxTokens: params.maxTokens });
        if (throwBefore !== undefined) throw throwBefore;
        yield { type: 'text_delta', text: 'summary' } as any;
      },
      async complete() {
        throw new Error('unused');
      },
      async validateAuth() { return true; },
    });
    const p = createRotatingProvider({
      providerId: 'kimi-coding',
      candidates: [
        {
          profileId: 'kimi-coding:default',
          providerId: 'kimi-coding',
          modelId: 'k3',
          maxTokens: 131_072,
          build: async () => makeProvider('kimi-coding', authErr),
        },
        {
          profileId: 'anthropic:default',
          providerId: 'anthropic',
          modelId: 'claude-opus-4-8',
          maxTokens: 128_000,
          build: async () => makeProvider('anthropic'),
        },
      ],
    });

    await collect(p.stream({
      ...PARAMS,
      model: 'k3',
      maxTokens: 2_048,
    }));

    expect(received).toEqual([
      { model: 'k3', maxTokens: 2_048 },
      { model: 'claude-opus-4-8', maxTokens: 2_048 },
    ]);
  });
});

describe('rotating-provider › complete calls and per-call stream policy', () => {
  it('keeps a model that missed only a per-call first-content deadline for the next main request', async () => {
    const silentThenWorking = (name: string) => ({
      id: name, name,
      async *stream(params: CompletionParams): AsyncIterable<StreamEvent> {
        if (params.firstEventTimeoutMs === undefined) {
          yield { type: 'text_delta', text: `${name} answered` } as any;
          return;
        }
        yield { type: 'message_start' } as any;
        await new Promise<void>((_resolve, reject) => {
          params.signal?.addEventListener('abort', () => reject(params.signal?.reason), { once: true });
        });
      },
      async complete() { throw new Error('unused'); },
      async validateAuth() { return true; },
    });
    const only = createRotatingProvider({ providerId: 'test', candidates: [{
      profileId: 'slow', providerId: 'slow-provider', modelId: 'slow-model', build: async () => silentThenWorking('slow') }] });
    await expect(collect(only.stream({ ...PARAMS, firstEventTimeoutMs: 20 }))).rejects.toMatchObject({ code: 'PROVIDER_NO_FIRST_EVENT_TIMEOUT' });
    // A repeat of the short call may wait again; the deadline bounds each one.
    await expect(collect(only.stream({ ...PARAMS, firstEventTimeoutMs: 20 }))).rejects.toMatchObject({ code: 'PROVIDER_NO_FIRST_EVENT_TIMEOUT' });
    expect((await collect(only.stream(PARAMS))).at(-1)).toMatchObject({ type: 'text_delta', text: 'slow answered' });

    const fallbackUsed: string[] = [];
    const chain = createRotatingProvider({ providerId: 'test', candidates: [
      { profileId: 'slow', providerId: 'slow-provider', modelId: 'slow-model', build: async () => silentThenWorking('slow') },
      { profileId: 'fallback', providerId: 'fallback-provider', modelId: 'fallback-model', build: async () => {
        fallbackUsed.push('fallback');
        return fakeProvider('fallback', { streamEvents: [{ type: 'text_delta', text: 'bounded summary' } as any] });
      } },
    ] });
    expect((await collect(chain.stream({ ...PARAMS, firstEventTimeoutMs: 20 }))).at(-1)).toMatchObject({ text: 'bounded summary' });
    expect((await collect(chain.stream(PARAMS))).at(-1)).toMatchObject({ text: 'slow answered' });
    expect(fallbackUsed).toEqual(['fallback']);
    expect(getCooldown('slow')).toBeUndefined();
  });

  beforeEach(() => _clearAll());

  it('falls back when the first completion credential returns 401', async () => {
    let winner: string | null = null;
    const authErr = Object.assign(new Error('Unauthorized'), { status: 401 });
    const p = createRotatingProvider({
      providerId: 'test',
      candidates: [
        candidate('p1', { completeError: authErr }),
        candidate('p2', { completeResult: { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, model: 'test' } }),
      ],
      onSuccess: (pid) => { winner = pid; },
    });
    const res = await p.complete(PARAMS);
    expect((res.content[0] as any).text).toBe('ok');
    expect(winner).toBe('p2');
    expect(getCooldown('p1')?.kind).toBe('auth');
  });

  it('honors a shorter per-call first-content deadline before rotating a stream', async () => {
    let primaryAborts = 0;
    let fallbackBuilds = 0;
    const p = createRotatingProvider({
      providerId: 'test',
      firstEventTimeoutMs: 1_000,
      candidates: [
        {
          profileId: 'slow',
          providerId: 'slow-provider',
          modelId: 'slow-model',
          build: async () => ({
            id: 'slow-provider',
            name: 'slow-provider',
            async *stream(params): AsyncIterable<StreamEvent> {
              yield { type: 'message_start' } as any;
              await new Promise<void>((_resolve, reject) => {
                params.signal?.addEventListener('abort', () => {
                  primaryAborts += 1;
                  reject(params.signal?.reason || new Error('aborted'));
                }, { once: true });
              });
            },
            async complete() { throw new Error('unused'); },
            async validateAuth() { return true; },
          }),
        },
        {
          profileId: 'fallback',
          providerId: 'fallback-provider',
          modelId: 'fallback-model',
          build: async () => {
            fallbackBuilds += 1;
            return fakeProvider('fallback', {
              streamEvents: [{ type: 'text_delta', text: 'bounded summary' } as any],
            });
          },
        },
      ],
    });

    const events = await collect(p.stream({ ...PARAMS, firstEventTimeoutMs: 20 }));

    expect(primaryAborts).toBe(1);
    expect(fallbackBuilds).toBe(1);
    expect(events[0]).toMatchObject({ type: 'provider_fallback', reason: 'no_first_event_timeout' });
    expect(events.at(-1)).toMatchObject({ type: 'text_delta', text: 'bounded summary' });
    expect(getCooldown('slow')).toBeUndefined();
  });

  it('complete does not refresh its retry budget during an AgentRunner recovery attempt', async () => {
    const netErr = Object.assign(new TypeError('fetch failed'), { code: 'ECONNRESET' });
    let primaryBuilds = 0;
    let fallbackBuilds = 0;
    const p = createRotatingProvider({
      providerId: 'test',
      networkRetryAttempts: 3,
      networkRetryDelayMs: () => 0,
      candidates: [
        {
          profileId: 'primary',
          providerId: 'test',
          modelId: 'test-model',
          build: async () => {
            primaryBuilds++;
            return fakeProvider('primary', { completeError: netErr });
          },
        },
        {
          profileId: 'fallback',
          providerId: 'test',
          modelId: 'test-model',
          build: async () => {
            fallbackBuilds++;
            return fakeProvider('fallback', {
              completeResult: {
                content: [{ type: 'text', text: 'recovered summary' }],
                stopReason: 'end_turn',
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                model: 'test-model',
              },
            });
          },
        },
      ],
    });

    const result = await p.complete({
      ...PARAMS,
      retryContext: { agentAttempt: 1 },
    });

    expect(primaryBuilds).toBe(1);
    expect(fallbackBuilds).toBe(1);
    expect((result.content[0] as any).text).toBe('recovered summary');
  });

  it('surfaces a non-rotatable completion error without fallback', async () => {
    const badReq = Object.assign(new Error('invalid_request'), { status: 400 });
    const p = createRotatingProvider({
      providerId: 'test',
      candidates: [
        candidate('p1', { completeError: badReq }),
        candidate('p2', { completeResult: { content: [], stopReason: 'end_turn', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, model: 't' } }),
      ],
    });
    await expect(p.complete(PARAMS)).rejects.toThrow(/invalid_request/);
    expect(getCooldown('p1')).toBeUndefined();
  });

  it('preserves a structured safety completion without retrying or falling back', async () => {
    const safety = Object.assign(new Error('Candidate unavailable'), {
      code: 'PROHIBITED_CONTENT',
    });
    let primaryBuilds = 0;
    let fallbackBuilds = 0;
    const p = createRotatingProvider({
      providerId: 'test',
      networkRetryDelayMs: () => 0,
      candidates: [
        {
          profileId: 'p1',
          providerId: 'test',
          modelId: 'test-model',
          build: async () => {
            primaryBuilds += 1;
            return fakeProvider('p1', { completeError: safety });
          },
        },
        {
          profileId: 'p2',
          providerId: 'test',
          modelId: 'test-model',
          build: async () => {
            fallbackBuilds += 1;
            return fakeProvider('p2', {
              completeResult: {
                content: [{ type: 'text', text: 'bypassed' }],
                stopReason: 'end_turn',
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                model: 'test-model',
              },
            });
          },
        },
      ],
    });

    await expect(p.complete(PARAMS)).rejects.toThrow(/Candidate unavailable/);
    expect(primaryBuilds).toBe(1);
    expect(fallbackBuilds).toBe(0);
    expect(getCooldown('p1')).toBeUndefined();
  });

  it('stops before another completion attempt when the caller aborts during retry backoff', async () => {
    const controller = new AbortController();
    const firstAttemptFailed = Promise.withResolvers<void>();
    let completionCalls = 0;
    const p = createRotatingProvider({
      providerId: 'test',
      networkRetryAttempts: 3,
      networkRetryDelayMs: () => 10_000,
      candidates: [{
        profileId: 'p1',
        providerId: 'test',
        modelId: 'test-model',
        build: async () => ({
          id: 'p1',
          name: 'p1',
          async *stream(): AsyncIterable<StreamEvent> {
            yield { type: 'text_delta', text: 'unused' } as any;
          },
          async complete() {
            completionCalls += 1;
            if (completionCalls === 1) {
              firstAttemptFailed.resolve();
              throw Object.assign(new TypeError('fetch failed'), { code: 'ECONNRESET' });
            }
            return { content: [], stopReason: 'end_turn' } as any;
          },
          async validateAuth() { return true; },
        }),
      }],
    });

    const completion = p.complete({ ...PARAMS, signal: controller.signal });
    await firstAttemptFailed.promise;
    controller.abort(new Error('cancelled during retry wait'));

    await expect(completion).rejects.toThrow(/cancelled during retry wait/);
    expect(completionCalls).toBe(1);
  });

  it('discards a late completion result after the caller has cancelled the request', async () => {
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const p = createRotatingProvider({
      providerId: 'test',
      candidates: [{
        profileId: 'p1',
        providerId: 'test',
        modelId: 'test-model',
        build: async () => ({
          id: 'p1',
          name: 'p1',
          async *stream(): AsyncIterable<StreamEvent> {
            yield { type: 'text_delta', text: 'unused' } as any;
          },
          async complete() {
            started.resolve();
            await release.promise;
            return { content: [{ type: 'text', text: 'late answer' }], stopReason: 'end_turn' } as any;
          },
          async validateAuth() { return true; },
        }),
      }],
    });

    const completion = p.complete({ ...PARAMS, signal: controller.signal });
    await started.promise;
    controller.abort(new Error('cancelled before completion settled'));
    release.resolve();

    await expect(completion).rejects.toThrow(/cancelled before completion settled/);
  });

  it('complete propagates caller abort without retrying or rotating', async () => {
    const controller = new AbortController();
    let primaryBuilds = 0;
    let fallbackBuilds = 0;
    const p = createRotatingProvider({
      providerId: 'test',
      networkRetryAttempts: 3,
      networkRetryDelayMs: () => 0,
      candidates: [
        {
          profileId: 'primary',
          providerId: 'test',
          modelId: 'test-model',
          build: async () => {
            primaryBuilds++;
            return {
              ...fakeProvider('primary', {}),
              async complete(params: CompletionParams) {
                return await new Promise((_, reject) => {
                  params.signal?.addEventListener('abort', () => {
                    reject(params.signal?.reason || new Error('aborted'));
                  }, { once: true });
                });
              },
            };
          },
        },
        {
          profileId: 'fallback',
          providerId: 'test',
          modelId: 'test-model',
          build: async () => {
            fallbackBuilds++;
            return fakeProvider('fallback', {
              completeResult: {
                content: [{ type: 'text', text: 'unexpected fallback' }],
                stopReason: 'end_turn',
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
                model: 'test-model',
              },
            });
          },
        },
      ],
    });

    const completing = p.complete({ ...PARAMS, signal: controller.signal });
    await vi.waitFor(() => expect(primaryBuilds).toBe(1));
    controller.abort(new Error('user stopped compaction'));

    await expect(completing).rejects.toThrow(/user stopped compaction/);
    expect(primaryBuilds).toBe(1);
    expect(fallbackBuilds).toBe(0);
  });
});

describe("rotation shared run lifecycle", () => {
it('commits on reasoning activity before answer text and clears the first-event deadline', async () => {
    let fallbackBuilds = 0;
    const p = createRotatingProvider({
      providerId: 'test',
      firstEventTimeoutMs: 20,
      candidates: [
        {
          profileId: 'reasoner',
          providerId: 'reasoner',
          modelId: 'reasoner-model',
          build: async () => ({
            id: 'reasoner',
            name: 'reasoner',
            async *stream(): AsyncIterable<StreamEvent> {
              yield { type: 'message_start' };
              yield { type: 'thinking_start' };
              await new Promise((resolve) => setTimeout(resolve, 50));
              yield { type: 'thinking_delta', chars: 12 };
              yield { type: 'thinking_end' };
              yield { type: 'text_delta', text: 'answer' };
            },
            async complete() { throw new Error('unused'); },
            async validateAuth() { return true; },
          }),
        },
        {
          profileId: 'fallback',
          providerId: 'fallback',
          modelId: 'fallback-model',
          build: async () => {
            fallbackBuilds += 1;
            return fakeProvider('fallback', { streamEvents: [{ type: 'text_delta', text: 'wrong' }] });
          },
        },
      ],
    });

    const events = await collect(p.stream(PARAMS));
    expect(events.map((event) => event.type)).toEqual([
      'message_start', 'thinking_start', 'thinking_delta', 'thinking_end', 'text_delta',
    ]);
    expect(fallbackBuilds).toBe(0);
  });
it('latches a network-exhausted candidate out of later model rounds once a fallback commits, without cooldown', async () => {
    // 2026-08-16 latency review P0-1: stream() runs once per tool-loop round.
    // Without the run-local latch, a candidate whose endpoint is dead in a
    // candidate-specific way (e.g. its fetch path ignores the proxy) re-pays
    // the full timeout/retry ladder on every remaining round of the turn
    // before reaching the fallback that actually serves the reply.
    const netErr = Object.assign(new TypeError('fetch failed'), { code: 'ECONNRESET' });
    let p1Builds = 0;
    let p2Builds = 0;
    const p = createRotatingProvider({
      providerId: 'test',
      networkRetryDelayMs: () => 0,
      candidates: [
        {
          profileId: 'p1',
          providerId: 'test',
          modelId: 'test-model',
          build: async () => {
            p1Builds += 1;
            return fakeProvider('p1', { throwBefore: netErr });
          },
        },
        {
          profileId: 'p2',
          providerId: 'test',
          modelId: 'test-model',
          build: async () => {
            p2Builds += 1;
            return fakeProvider('p2', { streamEvents: [{ type: 'text_delta', text: 'ok' } as any] });
          },
        },
      ],
    });

    const firstRound = await collect(p.stream(PARAMS));
    const secondRound = await collect(p.stream(PARAMS));

    expect(p1Builds).toBe(4); // round 1 keeps the full same-candidate retry ladder
    expect(p2Builds).toBe(2);
    expect((firstRound.at(-1) as any).text).toBe('ok');
    expect(secondRound.some((ev: any) => ev.type === 'retry')).toBe(false); // round 2 skips p1 entirely
    expect((secondRound.at(-1) as any).text).toBe('ok');
    // Run-local only: a fresh run (new provider instance) must retry p1, so
    // the network failure must not enter the persisted cooldown.
    expect(getCooldown('p1')).toBeUndefined();
  });
it('does not latch anything when every candidate fails network-class, so recovery after a full blip retries them all', async () => {
    // Counterexample guarding the deferred-latch design: compaction shares
    // this provider instance and swallows the exhausted error, so a transient
    // machine-local outage must leave the next call free to retry every
    // candidate. Only a sweep where a later candidate commits may latch.
    const netErr = Object.assign(new TypeError('fetch failed'), { code: 'ECONNRESET' });
    let p1Builds = 0;
    let p2Builds = 0;
    let blip = true;
    const p = createRotatingProvider({
      providerId: 'test',
      networkRetryDelayMs: () => 0,
      candidates: [
        {
          profileId: 'p1',
          providerId: 'test',
          modelId: 'test-model',
          build: async () => {
            p1Builds += 1;
            return blip
              ? fakeProvider('p1', { throwBefore: netErr })
              : fakeProvider('p1', { streamEvents: [{ type: 'text_delta', text: 'back' } as any] });
          },
        },
        {
          profileId: 'p2',
          providerId: 'test',
          modelId: 'test-model',
          build: async () => {
            p2Builds += 1;
            return fakeProvider('p2', { throwBefore: netErr });
          },
        },
      ],
    });

    await expect(collect(p.stream(PARAMS))).rejects.toMatchObject({ code: 'PROVIDER_NETWORK_EXHAUSTED' });
    blip = false;
    const events = await collect(p.stream(PARAMS));

    expect(p1Builds).toBe(5); // 4 during the blip + 1 recovered attempt
    expect(p2Builds).toBe(4); // only the blip round
    expect((events.at(-1) as any).text).toBe('back');
  });
it('announces omitted images when the committed candidate is text-only', async () => {
    // W4-2: a text-only model silently lost every attached image and the
    // only visible symptom was the model claiming it cannot see. The commit
    // must be preceded by an images_omitted event naming the count.
    const messages: CompletionParams['messages'] = [{
      role: 'user',
      content: [
        { type: 'text', text: 'read this screenshot' },
        { type: 'image', data: 'shot-1', mediaType: 'image/jpeg' },
        { type: 'image', data: 'shot-2', mediaType: 'image/jpeg' },
      ],
    }];
    const provider = createRotatingProvider({
      providerId: 'custom',
      candidates: [{
        profileId: 'text-only',
        providerId: 'custom',
        modelId: 'tiny-8b',
        maxInputImages: 0,
        build: async () => ({
          id: 'custom',
          name: 'custom',
          async *stream() {
            yield { type: 'text_delta', text: 'I cannot see any image.' } as any;
          },
          async complete() { throw new Error('unused'); },
          async validateAuth() { return true; },
        }),
      }],
    });

    const events = await collect(provider.stream({ ...PARAMS, messages }));
    const omitted = events.find((ev: any) => ev.type === 'images_omitted');
    expect(omitted).toMatchObject({ count: 2, providerId: 'custom' });
    expect(events.findIndex((ev: any) => ev.type === 'images_omitted'))
      .toBeLessThan(events.findIndex((ev: any) => ev.type === 'text_delta'));
  });
it('announces omitted images once per run, not on every tool-loop round', async () => {
    // The agent runner calls stream() once per tool-loop round with the full
    // history; a per-call announcement repeated the same notice ten times in
    // a ten-round turn and persisted every copy into the process rail.
    const messages: CompletionParams['messages'] = [{
      role: 'user',
      content: [
        { type: 'text', text: 'read this screenshot' },
        { type: 'image', data: 'shot-1', mediaType: 'image/jpeg' },
      ],
    }];
    const provider = createRotatingProvider({
      providerId: 'custom',
      candidates: [{
        profileId: 'text-only',
        providerId: 'custom',
        modelId: 'tiny-8b',
        maxInputImages: 0,
        build: async () => ({
          id: 'custom',
          name: 'custom',
          async *stream() {
            yield { type: 'text_delta', text: 'round output' } as any;
          },
          async complete() { throw new Error('unused'); },
          async validateAuth() { return true; },
        }),
      }],
    });

    const round1 = await collect(provider.stream({ ...PARAMS, messages }));
    const round2 = await collect(provider.stream({ ...PARAMS, messages }));
    expect(round1.filter((ev: any) => ev.type === 'images_omitted')).toHaveLength(1);
    expect(round2.filter((ev: any) => ev.type === 'images_omitted')).toHaveLength(0);
  });
it('complete() latches a network-exhausted candidate after a fallback succeeds, without cooldown', async () => {
    // Equivalent-path invariant with stream(): auxiliary complete() callers
    // repeat within one run too, and must not re-pay a dead candidate's
    // retry ladder once a fallback has proven the failure candidate-specific.
    const netErr = Object.assign(new TypeError('fetch failed'), { code: 'ECONNRESET' });
    let p1Builds = 0;
    let p2Builds = 0;
    const okResult = { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, model: 'test' };
    const p = createRotatingProvider({
      providerId: 'test',
      networkRetryDelayMs: () => 0,
      candidates: [
        {
          profileId: 'p1',
          providerId: 'test',
          modelId: 'test-model',
          build: async () => {
            p1Builds += 1;
            return fakeProvider('p1', { completeError: netErr });
          },
        },
        {
          profileId: 'p2',
          providerId: 'test',
          modelId: 'test-model',
          build: async () => {
            p2Builds += 1;
            return fakeProvider('p2', { completeResult: okResult });
          },
        },
      ],
    });

    const first = await p.complete(PARAMS);
    const second = await p.complete(PARAMS);

    expect((first.content[0] as any).text).toBe('ok');
    expect((second.content[0] as any).text).toBe('ok');
    expect(p1Builds).toBe(4); // full retry ladder in call 1, skipped in call 2
    expect(p2Builds).toBe(2);
    expect(getCooldown('p1')).toBeUndefined();
  });
});

it('applies image limits to native tool-result images without mutating their receipts', () => {
    const messages: CompletionParams['messages'] = [{ role: 'user', content: [
      { type: 'image', data: 'old', mediaType: 'image/png' },
    ] }, { role: 'assistant', content: [{ type: 'tool_use', id: 'img', name: 'read_files', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', toolUseId: 'img', content: 'Preview loaded', images: [
      { type: 'image', data: 'desktop', mediaType: 'image/png' },
      { type: 'image', data: 'mobile', mediaType: 'image/png' },
    ] }] }];
    const before = structuredClone(messages);
    const limited = boundMessagesForImageLimit(messages, 1);
    expect(limited.flatMap((m) => m.content).find((c) => c.type === 'tool_result')).toMatchObject({
      toolUseId: 'img', content: 'Preview loaded', images: [{ data: 'desktop' }],
    });
    expect(limited.at(-1)?.role).toBe('developer');
    expect(JSON.stringify(boundMessagesForImageLimit(messages, 0))).not.toContain('"data"');
    expect(messages).toEqual(before);
  });

describe('structured HTTP retry policy through the real SDK', () => {
  it.each(['Upstream access forbidden, please contact administrator', 'invalid_request', '服务暂时不可用', ''])
  ('recovers a 502 with the same bounded candidate sequence regardless of message: %s', async message => {
    _clearAll();
    const requests: string[] = [];
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fetchStub = vi.fn(async (input: string | URL | Request) => {
      const endpoint = String(input);
      requests.push(endpoint.includes('primary.invalid') ? 'primary' : 'fallback');
      if (endpoint.includes('primary.invalid')) return new Response(JSON.stringify({
        error: { type: 'upstream_error', message },
      }), { status: 502, headers: { 'content-type': 'application/json' } });
      return new Response('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: 'recovered' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      });
    });
    vi.stubGlobal('fetch', fetchStub);
    try {
      const provider = createRotatingProvider({
        providerId: 'custom', networkRetryDelayMs: () => 0,
        candidates: ['primary', 'fallback'].map(name => ({
          profileId: name, providerId: 'custom', modelId: 'fixture',
          build: async () => createPiProvider({ provider: 'custom', apiKey: 'fixture', customModel: {
            id: 'fixture', name: 'fixture', provider: 'custom', api: 'openai-completions',
            baseUrl: `https://${name}.invalid/v1`, reasoning: false, input: ['text'],
            contextWindow: 128000, maxTokens: 4096,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          } }),
        })),
      });
      const events = await collect(provider.stream({ ...PARAMS, model: 'fixture' }));
      expect(requests).toEqual(['primary', 'primary', 'primary', 'primary', 'fallback']);
      expect(events.filter(event => event.type === 'retry')).toHaveLength(3);
      expect(events.some(event => event.type === 'text_delta' && event.text === 'recovered')).toBe(true);
      expect(events.filter(event => event.type === 'message_end')).toHaveLength(1);
      expect(getCooldown('primary')).toBeUndefined();
      expect(getCooldown('fallback')).toBeUndefined();
      // Expected HTTP failures are redacted diagnostic facts, never body text.
      expect(warning.mock.calls).toHaveLength(4);
      expect(JSON.stringify(warning.mock.calls)).not.toContain('administrator');
    } finally { vi.unstubAllGlobals(); warning.mockRestore(); }
  });
});

// Real SDK flattening must not turn an explicit rejection into network retries.
describe('structured stream rejection through the real SDK', () => {
  it.each(['complete', 'stream'] as const)('stops rejected requests and retains transient recovery in %s', async method => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const api of ['openai-responses', 'openai-completions'] as const) {
        for (const status of [400, 503]) {
          _clearAll();
          const requests: string[] = [];
          vi.stubGlobal('fetch', vi.fn(async (_input, init) => {
            requests.push(String(init?.body));
            const error = { code: status === 400 ? 'invalid_request_error' : 'upstream_error', status,
              message: 'Synthetic diagnostic including misleading 401 invalid_api_key' };
            const body = api === 'openai-responses'
              ? 'event: error\ndata: ' + JSON.stringify({ ...error, type: 'error' }) + '\n\n'
              : 'data: ' + JSON.stringify({ error }) + '\n\ndata: [DONE]\n\n';
            return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
          }));
          const provider = createRotatingProvider({
            providerId: 'custom', networkRetryDelayMs: () => 0,
            candidates: [{ profileId: 'stream-rejection', providerId: 'custom', modelId: 'fixture',
              build: async () => createPiProvider({ provider: 'custom', apiKey: 'fixture', customModel: {
                id: 'fixture', name: 'fixture', api, provider: 'custom', baseUrl: 'https://fixture.invalid/v1',
                reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              } }),
            }],
          });
          if (method === 'complete') await expect(provider.complete({ ...PARAMS, model: 'fixture' })).rejects.toThrow();
          else {
            const events: any[] = [];
            const run = async () => { for await (const event of provider.stream({ ...PARAMS, model: 'fixture' })) events.push(event); };
            await expect(run()).rejects.toThrow();
            expect(events.filter(event => event.type === 'message_end')).toHaveLength(0);
            expect(events.filter(event => event.type === 'retry')).toHaveLength(status === 400 ? 0 : 3);
          }
          expect(requests).toHaveLength(status === 400 ? 1 : 4);
          expect(new Set(requests).size).toBe(1);
          expect(getCooldown('stream-rejection')).toBeUndefined();
        }
      }
      expect(warning.mock.calls.length).toBeGreaterThan(0);
      expect(JSON.stringify(warning.mock.calls)).not.toContain('misleading');
    } finally { vi.unstubAllGlobals(); warning.mockRestore(); _clearAll(); }
  });
});

it.each([
  { status: 401, code: 'invalid_api_key', retries: 0 },
  { status: 400, code: 'server_error', retries: 3 },
  { status: 400, code: 'invalid_request_error', retries: 0 },
])('continues a real SDK tool round after $status/$code without foreign ciphertext or a duplicate write', async ({ status, code, retries }) => {
  _clearAll();
  const wire: any[] = [];
  let writes = 0;
  const sse = (items: any[]) => {
    const events: any[] = items.flatMap((item, output_index) => [
      { type: 'response.output_item.added', output_index, item },
      { type: 'response.output_item.done', output_index, item },
    ]);
    events.push({ type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: items,
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } });
    return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
      { headers: { 'content-type': 'text/event-stream' } });
  };
  const fetch = vi.fn(async (_url: unknown, init: any) => {
    const payload = JSON.parse(init.body);
    wire.push(payload);
    if (wire.length === 1) return sse([
      { type: 'reasoning', id: 'rs_fixture', status: 'completed', summary: [], encrypted_content: 'source-private-state' },
      { type: 'function_call', id: 'fc_fixture', call_id: 'call_fixture', name: 'write_once', arguments: '{}' },
    ]);
    if (payload.model === 'model-a') return new Response(JSON.stringify({ error: { code } }),
      { status, headers: { 'content-type': 'application/json' } });
    expect(payload.model).toBe('model-b');
    expect(payload.input.some((i: any) => i.type === 'reasoning')).toBe(false);
    expect(payload.input.filter((i: any) => i.type === 'function_call_output')).toEqual([
      { type: 'function_call_output', call_id: 'call_fixture', output: 'saved-record-42' },
    ]);
    return sse([{ type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'Saved once.', annotations: [] }] }]);
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetch;
  try {
    const rotating = createRotatingProvider({ providerId: 'mock', networkRetryDelayMs: () => 0, candidates: ['a', 'b'].map(id => ({
      profileId: `replay-${id}`, providerId: 'openai', modelId: `model-${id}`,
      build: async () => createPiProvider({ provider: 'openai', apiKey: `key-${id}`, customModel: {
        api: 'openai-responses', provider: 'openai', id: `model-${id}`, name: 'fixture',
        baseUrl: `https://${id}.invalid/v1`, reasoning: true, input: ['text'],
        contextWindow: 128000, maxTokens: 1000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      } }),
    })) });
    const registry = new ProviderRegistry();
    registry.registerFactory('mock', () => rotating);
    const runner = new AgentRunner({
      config: createConfig({ agent: { defaultProvider: 'mock', defaultModel: 'model-a' } }),
      providers: registry, evolution: { enabled: false },
      tools: [defineTool({ name: 'write_once', description: 'Save fixture',
        inputSchema: { type: 'object', properties: {} },
        async execute() { writes++; return { content: 'saved-record-42' }; },
      })],
    });
    const result = await runner.run({ message: 'Save the record and report the result.' });
    expect(result.text).toBe('Saved once.');
    expect(writes).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(3 + retries);
    expect(wire[1].input.find((i: any) => i.type === 'reasoning')).toEqual({
      type: 'reasoning', id: 'rs_fixture', summary: [], encrypted_content: 'source-private-state',
    });
  } finally { globalThis.fetch = originalFetch; _clearAll(); }
});

  it('reports a message-only Electron proxy outage as network exhaustion', async () => {
    const transportError = normalizeElectronNetFetchError(new Error('net::ERR_PROXY_CONNECTION_FAILED'));
    const p = createRotatingProvider({
      providerId: 'test',
      networkRetryDelayMs: () => 0,
      networkRetryAttempts: 1,
      candidates: [candidate('p1', { throwBefore: transportError })],
    });

    await expect(collect(p.stream(PARAMS))).rejects.toMatchObject({
      code: 'PROVIDER_NETWORK_EXHAUSTED',
      cause: transportError,
    });
    expect(getCooldown('p1')).toBeUndefined();
  });


describe('committed stream resource ownership', () => {
  it.each(['notice', 'buffered content', 'stream tail', 'terminal receipt'] as const)('releases upstream when the consumer exits at %s', async boundary => {
    let signal: AbortSignal | undefined;
    let closed = 0;
    let tailReads = 0;
    let builds = 0;
    const cand: RotatingCandidate = { profileId: 'owned', providerId: 'openai', modelId: 'test-model',
      ...(boundary === 'notice' ? { imageSupport: { unsupported: true, observeRejection() {} } } : {}),
      build: async () => { builds += 1; return { ...fakeProvider('owned', {}),
        async *stream(params: CompletionParams): AsyncIterable<StreamEvent> {
          signal = params.signal;
          try {
            yield { type: 'text_delta', text: 'first' };
            tailReads += 1;
            yield { type: 'text_delta', text: 'tail' };
            yield { type: 'message_end', content: [{ type: 'text', text: 'firsttail' }] };
          } finally { closed += 1; }
        },
      }; },
    };
    const provider = createRotatingProvider({ providerId: 'openai', networkRetryAttempts: 0, candidates: [cand] });
    const params: CompletionParams = boundary === 'notice' ? { ...PARAMS, messages: [{ role: 'user', content: [
      { type: 'text', text: 'ping' }, { type: 'image', mediaType: 'image/png', data: 'fixture' },
    ] }] } : PARAMS;
    const stream = provider.stream(params)[Symbol.asyncIterator]();
    if (boundary === 'notice') expect((await stream.next()).value).toMatchObject({ type: 'images_omitted', count: 1 });
    else {
      expect((await stream.next()).value).toMatchObject({ text: 'first' });
      if (boundary !== 'buffered content') expect((await stream.next()).value).toMatchObject({ text: 'tail' });
      if (boundary === 'terminal receipt') expect((await stream.next()).value).toMatchObject({ type: 'message_end' });
    }
    await stream.return?.();
    expect(signal?.aborted).toBe(true);
    expect(closed).toBe(1);
    expect(tailReads).toBe(boundary === 'stream tail' || boundary === 'terminal receipt' ? 1 : 0);
    expect(builds).toBe(1);
    expect(await collect(provider.stream(PARAMS))).toEqual([
      { type: 'text_delta', text: 'first' }, { type: 'text_delta', text: 'tail' },
      { type: 'message_end', content: [{ type: 'text', text: 'firsttail' }] },
    ]);
    expect(signal?.aborted).toBe(false);
    expect(closed).toBe(2);
    expect(builds).toBe(2);
  });
});

// A request the provider refused is repeated unchanged when the user presses
// Continue. Rotation wraps it for the exhausted chain, and that wrapper must not
// hide the status: the user needs the provider's reason and, from the second
// refusal, to hear that retrying as is will not help.
describe('rejected requests after the candidate chain ends', () => {
  const REASON = 'Unknown parameter: stream_options';
  async function refusedRun(names: string[], failureTrackingScope: object, message = 'Continue') {
    const requests: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => {
      requests.push(new URL(String(input)).hostname.split('.')[0]);
      return new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: REASON } }),
        { status: 400, headers: { 'content-type': 'application/json' } });
    }));
    const rotating = createRotatingProvider({ providerId: 'custom', networkRetryDelayMs: () => 0,
      candidates: names.map(name => ({ profileId: name, providerId: 'custom', modelId: 'fixture',
        build: async () => createPiProvider({ provider: 'custom', apiKey: 'fixture', customModel: {
          id: 'fixture', name: 'fixture', api: 'openai-completions', provider: 'custom',
          baseUrl: `https://${name}.invalid/v1`, reasoning: false, input: ['text'],
          contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        } }),
      })),
    });
    const registry = new ProviderRegistry();
    registry.registerFactory('custom', () => rotating);
    const runner = new AgentRunner({
      config: createConfig({ agent: { defaultProvider: 'custom', defaultModel: 'fixture' }, evolution: { enabled: false } }),
      providers: registry, tools: [],
    });
    const events: any[] = [];
    for await (const event of mapCoreAgentEvents(runner.runStream({ message }), { failureTrackingScope })) events.push(event);
    return { requests, error: events.find(event => event.type === 'error') };
  }

  it.each([
    ['the only configured model', ['primary'], ['primary']],
    ['every configured model', ['primary', 'fallback'], ['primary', 'fallback']],
  ])('keeps the rejection facts when %s refuses the request', async (_label, names, expectedRequests) => {
    _clearAll();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const scope = {};
      const first = await refusedRun(names, scope);
      // Unchanged requests are not retried, so this was a refusal, not retries.
      expect(first.requests).toEqual(expectedRequests);
      expect(first.error).toMatchObject({ failureCode: 'provider_http_400', retryExhausted: true,
        text: t('errors.model_request_rejected'),
        detail: t('errors.provider_reply_detail', { detail: REASON }) });
      expect(first.error.text).not.toContain(t('errors.model_request_rejected_repeated'));

      const second = await refusedRun(names, scope);
      expect(second.error.text).toContain(t('errors.model_request_rejected_repeated'));
      expect(second.error.detail).toBe(t('errors.provider_reply_detail', { detail: REASON }));
      for (const id of names) expect(getCooldown(id)).toBeUndefined();
    } finally { vi.unstubAllGlobals(); warning.mockRestore(); _clearAll(); }
  });

  it('describes consecutive rejections across distinct text requests', async () => {
    _clearAll();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const language = getCurrentLang();
    try {
      setCurrentLang('en');
      const scope = {};
      const first = await refusedRun(['primary'], scope, 'Summarize the first draft');
      const second = await refusedRun(['primary'], scope, 'List the open decisions');
      expect(first.requests).toEqual(['primary']);
      expect(second.requests).toEqual(['primary']);
      expect(second.error.text).toContain('The model service rejected several requests in a row.');
      expect(second.error.text).not.toContain('will not change the result');
      expect(second.error.text).not.toContain('remove images or attachments');
      expect(second.error.detail).toBe(t('errors.provider_reply_detail', { detail: REASON }));
    } finally {
      setCurrentLang(language);
      vi.unstubAllGlobals();
      warning.mockRestore();
      _clearAll();
    }
  });
});


describe('rotating-provider request failure observation', () => {
  it.each(['complete', 'stream'] as const)('retains SDK failure evidence after successful %s recovery', async method => {
    _clearAll();
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const token = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture' } })).toString('base64url');
    const fetchStub = vi.fn(async () => { throw new TypeError('fetch failed', {
      cause: Object.assign(new Error('private-canary'), { code: 'ENOTFOUND' }),
    }); });
    vi.stubGlobal('fetch', fetchStub);
    const observations: any[] = [];
    let builds = 0;
    const provider = createRotatingProvider({
      providerId: 'openai-codex', networkRetryAttempts: 1, networkRetryDelayMs: () => 0,
      onRequestFailure: failure => observations.push(failure),
      candidates: [{ profileId: 'diagnostic-fixture', providerId: 'openai-codex', modelId: 'diagnostic-model',
        build: async () => ++builds === 1
          // Pin the transport contract, not a model in the changing SDK catalog.
          ? createPiProvider({ provider: 'openai-codex', apiKey: `fixture.${token}.fixture`, customModel: {
              id: 'diagnostic-model', name: 'Diagnostic fixture', api: 'openai-codex-responses',
              provider: 'openai-codex', baseUrl: 'https://diagnostic.invalid/backend-api',
              reasoning: false, input: ['text'], contextWindow: 200_000, maxTokens: 4_096,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, type: 'chat',
            } })
          : fakeProvider('recovered', { streamEvents: [{ type: 'text_delta', text: 'recovered' }], completeResult: {
              content: [{ type: 'text', text: 'recovered' }], stopReason: 'end_turn', model: 'diagnostic-model',
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            } }),
      }],
    });
    try {
      if (method === 'complete') expect((await provider.complete(PARAMS)).content).toEqual([{ type: 'text', text: 'recovered' }]);
      else {
        const events = await collect(provider.stream(PARAMS));
        expect(events.filter(event => event.type === 'error')).toEqual([]);
        expect(events.filter(event => event.type === 'text_delta')).toEqual([{ type: 'text_delta', text: 'recovered' }]);
        expect(events.filter(event => event.type === 'retry')).toHaveLength(1);
      }
      expect(observations).toMatchObject([{ phase: 'before_response', code: 'ENOTFOUND', aborted: false, elapsedMs: expect.any(Number) }]);
      expect(fetchStub).toHaveBeenCalledTimes(1);
      expect(builds).toBe(2);
      expect(JSON.stringify(warning.mock.calls)).not.toContain('private-canary');
    } finally { vi.unstubAllGlobals(); warning.mockRestore(); }
  });
});


it('does not dispatch another model under a credential invalidated earlier in the same prepared request', async () => {
  _clearAll();
  const builds: string[] = [];
  const failed: RotatingCandidate = { profileId: 'same-key', providerId: 'custom', modelId: 'first', build: async () => {
    builds.push('first'); return fakeProvider('first', { throwBefore: Object.assign(new Error('invalid credential'), { status: 401 }) });
  } };
  const duplicate: RotatingCandidate = { profileId: 'same-key', providerId: 'custom', modelId: 'second', build: async () => {
    builds.push('second'); return fakeProvider('second', { streamEvents: [{ type: 'text_delta', text: 'must not send' }] });
  } };
  const fallback: RotatingCandidate = { profileId: 'usable-key', providerId: 'custom', modelId: 'third', build: async () => {
    builds.push('third'); return fakeProvider('third', { streamEvents: [{ type: 'text_delta', text: 'recovered' }] });
  } };
  try {
    const provider = createRotatingProvider({ providerId: 'custom', candidates: [failed, duplicate, fallback] });
    const result = await collect(provider.stream(PARAMS));
    expect(builds).toEqual(['first', 'third']);
    expect(result.filter(item => item.type === 'text_delta')).toEqual([{ type: 'text_delta', text: 'recovered' }]);
    expect(getCooldown('same-key')?.kind).toBe('auth');
  } finally { _clearAll(); }
});


describe('public configured-provider balance fallback notices', () => {
  beforeEach(() => _clearAll());
  it('announces an empty user-owned account once before continuing with another configured account', async () => {
    const balance = new ProviderError('insufficient_quota', 'openai', 429, Object.assign(new Error('Provider HTTP error'), {
      status: 429, error: { type: 'insufficient_quota', code: 'insufficient_quota' },
    }));
    const p = createRotatingProvider({ providerId: 'openai', networkRetryDelayMs: () => 0, candidates: [
      candidate('public-empty-balance', { throwBefore: balance }, 'openai', 'gpt-test'),
      candidate('public-fallback', { streamEvents: [{ type: 'text_delta', text: 'Continued.' } as any] }, 'deepseek', 'fixture-model'),
    ] });
    const first = await collect(p.stream(PARAMS));
    expect(first.filter(event => event.type === 'provider_fallback')).toEqual([
      expect.objectContaining({ type: 'provider_fallback', reason: 'balance', providerId: 'openai', candidateIndex: 1, candidateCount: 2 }),
    ]);
    expect(first.filter(event => event.type === 'retry')).toEqual([]);
    expect((first.at(-1) as any).text).toBe('Continued.');
    expect(getCooldown('public-empty-balance')?.kind).toBe('balance');
    const second = await collect(p.stream(PARAMS));
    expect(second.some(event => event.type === 'provider_fallback')).toBe(false);
    expect((second.at(-1) as any).text).toBe('Continued.');
  });
});

describe('configured-provider credential, auxiliary and exhaustion recovery', () => {
  beforeEach(() => _clearAll());
  it.each(['complete', 'stream'] as const)('continues %s through real SDK rejection and configured fallback', async method => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const api of ['openai-responses', 'openai-completions'] as const) {
        for (const code of ['server_error', 'invalid_request_error', 'model_not_found']) {
          _clearAll();
          const requests: string[] = [];
          vi.stubGlobal('fetch', vi.fn(async (input) => {
            const primary = String(input).includes('primary.invalid');
            requests.push(primary ? 'primary' : 'fallback');
            if (primary) return new Response(JSON.stringify({ error: { type: code, message: 'private diagnostic' } }),
              { status: 400, headers: { 'content-type': 'application/json' } });
            if (api === 'openai-completions') return new Response('data: ' + JSON.stringify({
              choices: [{ index: 0, delta: { role: 'assistant', content: 'Finished' }, finish_reason: 'stop' }],
            }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
            const item = { id: 'msg_finished', type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Finished' }] };
            return new Response('event: response.output_item.done\ndata: ' + JSON.stringify({ type: 'response.output_item.done', output_index: 0, item })
              + '\n\nevent: response.completed\ndata: ' + JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [item], usage: { input_tokens: 2, output_tokens: 1 } } }) + '\n\n',
            { headers: { 'content-type': 'text/event-stream' } });
          }));
          const provider = createRotatingProvider({ providerId: 'custom', networkRetryDelayMs: () => 0,
            candidates: ['primary', 'fallback'].map(name => ({ profileId: name, providerId: 'custom', modelId: 'fixture',
              build: async () => createPiProvider({ provider: 'custom', apiKey: 'fixture', customModel: {
                id: 'fixture', name: 'fixture', api, provider: 'custom', baseUrl: `https://${name}.invalid/v1`,
                reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              } }),
            })),
          });
          if (method === 'complete') expect((await provider.complete(PARAMS)).content.some(block => block.type === 'text' && block.text === 'Finished')).toBe(true);
          else expect((await collect(provider.stream(PARAMS))).filter(event => event.type === 'message_end')).toHaveLength(1);
          expect(requests).toEqual(code === 'server_error' ? ['primary', 'primary', 'primary', 'primary', 'fallback'] : ['primary', 'fallback']);
          expect(getCooldown('primary')).toBeUndefined();
        }
      }
      expect(JSON.stringify(warning.mock.calls)).not.toContain('private diagnostic');
    } finally { vi.unstubAllGlobals(); warning.mockRestore(); _clearAll(); }
  });

  it('refreshes OAuth once after a pre-content auth failure and retries the same candidate invisibly', async () => {
    let token = 'stale-access';
    let builds = 0;
    let refreshes = 0;
    let fallbackBuilds = 0;
    const authErr = Object.assign(new Error('The authentication token is expired'), { code: 'oauth_token_expired' });
    const p = createRotatingProvider({
      providerId: 'openai-codex',
      candidates: [
        {
          profileId: 'oauth-profile',
          providerId: 'openai-codex',
          modelId: 'gpt-test',
          refreshCredential: async () => {
            refreshes += 1;
            token = 'fresh-access';
            return true;
          },
          build: async () => {
            builds += 1;
            return token === 'stale-access'
              ? fakeProvider('oauth-profile', {
                  // Mirrors pi-ai: a harmless stream preamble followed by an
                  // in-band, statusless authentication error event.
                  streamEvents: [
                    { type: 'message_start' } as any,
                    { type: 'error', error: authErr } as any,
                  ],
                })
              : fakeProvider('oauth-profile', { streamEvents: [{ type: 'text_delta', text: 'renewed' } as any] });
          },
        },
        {
          profileId: 'fallback',
          providerId: 'fallback',
          modelId: 'fallback-model',
          build: async () => {
            fallbackBuilds += 1;
            return fakeProvider('fallback', { streamEvents: [{ type: 'text_delta', text: 'fallback' } as any] });
          },
        },
      ],
    });

    const events = await collect(p.stream(PARAMS));

    expect(events).toEqual([{ type: 'text_delta', text: 'renewed' }]);
    expect(events.some((event) => event.type === 'retry')).toBe(false);
    expect(events.some((event) => event.type === 'provider_fallback')).toBe(false);
    expect(builds).toBe(2);
    expect(refreshes).toBe(1);
    expect(fallbackBuilds).toBe(0);
    expect(getCooldown('oauth-profile')).toBeUndefined();
  });

  it.each([
    ['refresh returns unavailable', 'unavailable'],
    ['refresh throws', 'throws'],
    ['the refreshed credential is rejected again', 'success'],
  ] as const)('%s: refreshes at most once, then falls back as auth', async (_label, refreshResult) => {
    let builds = 0;
    let refreshes = 0;
    const authErr = Object.assign(new Error('The authentication token is expired'), { code: 'oauth_token_expired' });
    const p = createRotatingProvider({
      providerId: 'openai-codex',
      candidates: [
        {
          profileId: 'oauth-profile',
          providerId: 'openai-codex',
          modelId: 'gpt-test',
          refreshCredential: async () => {
            refreshes += 1;
            if (refreshResult === 'throws') throw new Error('refresh grant expired');
            return refreshResult === 'success';
          },
          build: async () => {
            builds += 1;
            return fakeProvider('oauth-profile', { throwBefore: authErr });
          },
        },
        candidate('fallback', { streamEvents: [{ type: 'text_delta', text: 'fallback' } as any] }),
      ],
    });

    const events = await collect(p.stream(PARAMS));

    expect(refreshes).toBe(1);
    expect(builds).toBe(refreshResult === 'success' ? 2 : 1);
    expect(events.filter((event) => event.type === 'provider_fallback')).toEqual([
      expect.objectContaining({ reason: 'auth', providerId: 'openai-codex' }),
    ]);
    expect(events.some((event) => event.type === 'retry')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'text_delta', text: 'fallback' });
    expect(getCooldown('oauth-profile')?.kind).toBe('auth');
  });

  it('also refreshes once for complete() and rebuilds with the renewed credential', async () => {
    let token = 'stale-access';
    let builds = 0;
    const authErr = Object.assign(new Error('The authentication token is expired'), { code: 'oauth_token_expired' });
    const p = createRotatingProvider({
      providerId: 'openai-codex',
      networkRetryAttempts: 0,
      candidates: [{
        profileId: 'oauth-profile',
        providerId: 'openai-codex',
        modelId: 'gpt-test',
        refreshCredential: async () => {
          token = 'fresh-access';
          return true;
        },
        build: async () => {
          builds += 1;
          return fakeProvider('oauth-profile', token === 'stale-access'
            ? { completeError: authErr }
            : { completeResult: { content: [{ type: 'text', text: 'renewed' }] } });
        },
      }],
    });

    await expect(p.complete(PARAMS)).resolves.toMatchObject({
      content: [{ type: 'text', text: 'renewed' }],
    });
    expect(builds).toBe(2);
    expect(getCooldown('oauth-profile')).toBeUndefined();
  });

  it('leaves committed rate-limit retries to Runner without switching candidates', async () => {
    let requests = 0;
    let fallbackBuilds = 0;
    const primary: RotatingCandidate = { profileId: 'p1', providerId: 'test', modelId: 'test-model',
      build: async () => ({ id: 'test', name: 'test',
        async complete() { requests++; throw Object.assign(new Error('opaque'), { status: 429 }); },
        async *stream() {
          requests++;
          yield { type: 'text_delta', text: 'partial' };
          yield { type: 'error', error: Object.assign(new Error('opaque'), { status: 429 }) };
        },
        async validateAuth() { return true; },
      }),
    };
    const create = () => createRotatingProvider({ providerId: 'test', networkRetryDelayMs: () => 0,
      candidates: [primary, { ...candidate('fallback', {}), build: async () => {
        fallbackBuilds++; return fakeProvider('fallback', {});
      } }],
    });
    const p = create();
    const invoke = (provider: LLMProvider) => collect(provider.stream(PARAMS));
    await expect(invoke(p)).rejects.toMatchObject({ code: 'COMMITTED_STREAM_RATE_LIMIT' });
    await expect(invoke(p)).rejects.toMatchObject({ code: 'COMMITTED_STREAM_RATE_LIMIT' });
    expect(requests).toBe(2);
    expect(fallbackBuilds).toBe(0);
    expect(getCooldown('p1')).toBeUndefined();
    await expect(invoke(create())).rejects.toMatchObject({ code: 'COMMITTED_STREAM_RATE_LIMIT' });
    expect(requests).toBe(3);
    expect(fallbackBuilds).toBe(0);
  });

  it.each([
    'There is no rate limit; the operation failed',
    'The record number is 429 and operation failed',
    'Opaque gateway rule Z7 rejected the request',
    'require is not defined',
    'EPERM: operation not permitted, open <redacted>',
  ])('preserves unknown diagnostics through rotation, runner and display: %s', async (message) => {
    let calls = 0;
    const rotating = createRotatingProvider({
      providerId: 'mock',
      networkRetryAttempts: 1,
      networkRetryDelayMs: () => 0,
      candidates: [{
        profileId: 'unknown-error', providerId: 'mock', modelId: 'mock-model',
        build: async () => {
          calls++;
          return fakeProvider('unknown-error', { throwBefore: new Error(message) });
        },
      }],
    });
    const registry = new ProviderRegistry();
    registry.registerFactory('mock', () => rotating);
    const runner = new AgentRunner({
      config: createConfig({ agent: { defaultProvider: 'mock', defaultModel: 'mock-model' } }),
      providers: registry,
      tools: [],
    });
    const events = [];
    for await (const event of mapCoreAgentEvents(runner.runStream({ message: 'fixture' }), { failureTrackingScope: {} })) events.push(event);
    expect(calls).toBe(2);
    expect(getCooldown('unknown-error')).toBeUndefined();
    expect(events.filter((event) => event.type === 'progress')).toEqual([
      expect.objectContaining({ text: expect.stringContaining(message) }),
    ]);
    expect(events.filter((event) => event.type === 'error' || event.type === 'final')).toEqual([
      expect.objectContaining({ type: 'error', text: message, failureCode: 'provider_retries_exhausted' }),
    ]);
  });

  it.each([false, true])('preserves candidate recovery before reporting exhaustion through runner and mapper (fallbackFails=%s)', async (fallbackFails) => {
    const requests = { primary: 0, fallback: 0 };
    const rotating = createRotatingProvider({
      providerId: 'mock', networkRetryAttempts: 3, networkRetryDelayMs: () => 0,
      candidates: (['primary', 'fallback'] as const).map((name) => ({
        profileId: name, providerId: 'mock', modelId: 'mock-model',
        build: async () => {
          requests[name]++;
          return name === 'primary' || fallbackFails
            ? fakeProvider(name, { throwBefore: Object.assign(new TypeError('fetch failed'), { code: 'ECONNRESET' }) })
            : fakeProvider(name, { streamEvents: [
              { type: 'text_delta', text: 'recovered with fallback' },
              { type: 'message_end', stopReason: 'end_turn', model: 'mock-model',
                content: [{ type: 'text', text: 'recovered with fallback' }],
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
            ] });
        },
      })),
    });
    const registry = new ProviderRegistry();
    registry.registerFactory('mock', () => rotating);
    const runner = new AgentRunner({
      config: createConfig({ agent: { defaultProvider: 'mock', defaultModel: 'mock-model' } }),
      providers: registry, tools: [],
    });
    const events = [];
    for await (const event of mapCoreAgentEvents(runner.runStream({ message: 'Finish the report' }), { failureTrackingScope: {} })) events.push(event);
    expect(requests).toEqual({ primary: 4, fallback: fallbackFails ? 4 : 1 });
    expect(events.filter((event) => event.type === 'error' || event.type === 'final')).toEqual([
      expect.objectContaining(fallbackFails
        ? { type: 'error', failureCode: 'provider_network', retryExhausted: true }
        : { type: 'final', text: 'recovered with fallback' }),
    ]);
    expect(events.filter((event) => event.type !== 'error').some((event) => event.retryExhausted)).toBe(false);
    expect(getCooldown('primary')).toBeUndefined();
    expect(getCooldown('fallback')).toBeUndefined();
  });

  it('exhausted-rotation error is non-retryable so the runner cannot amplify the rotation', async () => {
    // Each candidate already got its per-candidate network retries inside the
    // rotation; the summary error must classify as permanent, otherwise the
    // agent runner re-runs the WHOLE rotation up to maxRetries more times
    // (candidates × inner retries × outer retries full-prompt calls).
    const { classifyRetryableError } = await import('#core-agent');
    const netErr = Object.assign(new TypeError('fetch failed'), { code: 'ECONNRESET' });
    const p = createRotatingProvider({
      providerId: 'test',
      networkRetryDelayMs: () => 0,
      networkRetryAttempts: 1,
      candidates: [
        candidate('p1', { throwBefore: netErr }),
        candidate('p2', { throwBefore: netErr }),
      ],
    });
    let thrown: unknown;
    try { await collect(p.stream(PARAMS)); } catch (err) { thrown = err; }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as { code?: string }).code).toBe('PROVIDER_NETWORK_EXHAUSTED');
    expect((thrown as { cause?: unknown }).cause).toBe(netErr);
    expect(classifyRetryableError(thrown)).toBeNull();
    // Look-alike guard: the raw per-candidate network error itself stays
    // retryable — only the exhausted summary is exempt.
    expect(classifyRetryableError(netErr)).toBe('connection_dropped');
  });

  it('complete() retries a normal empty completion once on the same candidate', async () => {
    const empty = { content: [], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 }, model: 'test' };
    const ok = { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, model: 'test' };
    let calls = 0;
    const p = createRotatingProvider({
      providerId: 'test',
      candidates: [{
        profileId: 'p1', providerId: 'test', modelId: 'test-model',
        build: async () => ({
          id: 'p1', name: 'p1',
          async *stream() { throw new Error('stream not used'); },
          async complete() { calls += 1; return calls === 1 ? empty : ok; },
          async validateAuth() { return true; },
        }),
      }],
    });
    const res = await p.complete(PARAMS);
    expect((res.content[0] as any).text).toBe('ok');
    expect(calls).toBe(2);
  });

  it.each([{ content: [] }, { content: [{ type: 'thinking', thinking: 'hmm' }] }, { content: [{ type: 'text', text: '  ' }] }])(
    'complete() fails repeated empty output without fallback or cooldown (%j)', async ({ content }) => {
      const empty = { content, stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 }, model: 'test' };
      const primary = vi.fn(async () => fakeProvider('p1', { completeResult: empty }));
      const fallback = vi.fn(async () => fakeProvider('p2', { completeResult: { ...empty, content: [{ type: 'text', text: 'must not be requested' }] } }));
      const chosen = vi.fn();
      const success = vi.fn();
      const p = createRotatingProvider({
        providerId: 'test', onCandidateChosen: chosen, onSuccess: success,
        candidates: [
          { profileId: 'p1', providerId: 'test', modelId: 'test-model', build: primary },
          { profileId: 'p2', providerId: 'test', modelId: 'other-model', build: fallback },
        ],
      });
      await expect(p.complete(PARAMS)).rejects.toMatchObject({ code: PROVIDER_EMPTY_NORMAL_CODE });
      expect(primary).toHaveBeenCalledTimes(2);
      expect(fallback).not.toHaveBeenCalled();
      expect(success).not.toHaveBeenCalled();
      expect(chosen.mock.calls).toEqual([[{ profileId: 'p1', providerId: 'test', modelId: 'test-model' }]]);
      expect(getCooldown('p1')).toBeUndefined();
    },
  );

  it.each([new TypeError('fetch failed'), Object.assign(new Error('Too Many Requests'), { status: 429 })])(
    'complete() retains fault recovery when the empty retry encounters %s', async error => {
      let calls = 0;
      const answer = { content: [{ type: 'text', text: 'recovered' }], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, model: 'test' };
      const p = createRotatingProvider({
        providerId: 'test', networkRetryAttempts: 1, networkRetryDelayMs: () => 0,
        candidates: [{ profileId: 'p1', providerId: 'test', modelId: 'test-model', build: async () => {
          calls++;
          return calls === 1
            ? fakeProvider('p1', { completeResult: { ...answer, content: [] } })
            : fakeProvider('p1', { completeError: error });
        } }, candidate('p2', { completeResult: answer })],
      });
      await expect(p.complete(PARAMS)).resolves.toEqual(answer);
      expect(calls).toBe('status' in error ? 2 : 3);
      expect(getCooldown('p1')).toBeUndefined();
    },
  );

  it.each(['reflection', 'summary'] as const)('contains empty %s failure without losing execution results', async mode => {
    let streams = 0;
    let completions = 0;
    let writes = 0;
    const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
    const fallback = vi.fn(async () => fakeProvider('fallback', {}));
    const primary: LLMProvider = {
      id: 'mock', name: 'Mock', async validateAuth() { return true; },
      async complete() {
        completions++;
        return { content: [], stopReason: 'end_turn', usage, model: 'mock-model' };
      },
      async *stream(): AsyncIterable<StreamEvent> {
        streams++;
        const finish = mode === 'reflection' && streams > 1;
        yield { type: 'message_end', stopReason: finish ? 'end_turn' : 'tool_use', usage,
          model: 'mock-model', providerTermination: { category: 'normal' },
          content: finish ? [{ type: 'text', text: 'Saved the record.' }]
            : [{ type: 'tool_use', id: `write-${streams}`, name: 'save_record', input: {} }],
        };
      },
    };
    const rotating = createRotatingProvider({ providerId: 'mock', candidates: [
      { profileId: 'primary', providerId: 'mock', modelId: 'mock-model', build: async () => primary },
      { profileId: 'fallback', providerId: 'mock', modelId: 'other-model', build: fallback },
    ] });
    const registry = new ProviderRegistry();
    registry.registerFactory('mock', () => rotating);
    const runner = new AgentRunner({
      config: createConfig({ agent: { defaultProvider: 'mock', defaultModel: 'mock-model', maxToolLoops: 1 } }),
      providers: registry, evolution: { enabled: false },
      tools: [defineTool({ name: 'save_record', description: 'Save a record', inputSchema: { type: 'object' },
        async execute() { writes++; return { content: 'Saved record 42' }; },
      })],
    });
    const events = [];
    for await (const event of runner.runStream({ message: 'Save the record.' })) events.push(event);
    const done = events.filter(event => event.type === 'done');
    expect(done).toHaveLength(1);
    const result = done[0].result;
    expect(result.meta.error).toBeUndefined();
    if (mode === 'reflection') {
      const messages = structuredClone(runner.getSession().getMessages());
      const failure = vi.fn();
      const durableWrite = vi.fn();
      await expect(runner.runReflection('Review the completed task.', undefined, undefined, undefined, durableWrite, failure)).resolves.toBe('');
      expect(failure).toHaveBeenCalledWith({ kind: 'llm_error', error: expect.objectContaining({ code: PROVIDER_EMPTY_NORMAL_CODE }) });
      expect(durableWrite).not.toHaveBeenCalled();
      expect(runner.getSession().getMessages()).toEqual(messages);
      expect(result.text).toBe('Saved the record.');
      expect(result.meta.termination).toBeUndefined();
    } else {
      expect(result.meta.termination).toEqual({ status: 'stopped', reason: 'tool_loop_limit',
        summaryIncomplete: true, toolRoundLimit: 1,
      });
      expect(result.text).toBe('');
      const saved = JSON.stringify(runner.getSession().getMessages());
      expect(saved).toContain('Saved record 42');
      expect(saved).not.toContain('Recent successful results:');
      expect(events.filter(event => event.type === 'provider_call').at(-1)).toMatchObject({ outcome: 'failed' });
    }
    expect(completions).toBe(2);
    expect(writes).toBe(1);
    expect(fallback).not.toHaveBeenCalled();
  });

  it('complete() does not add a nested empty retry during an AgentRunner recovery attempt', async () => {
    const empty = { content: [], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 }, model: 'test' };
    let calls = 0;
    const p = createRotatingProvider({
      providerId: 'test',
      candidates: [{
        profileId: 'p1', providerId: 'test', modelId: 'test-model',
        build: async () => ({
          id: 'p1', name: 'p1',
          async *stream() { throw new Error('stream not used'); },
          async complete() { calls += 1; return empty; },
          async validateAuth() { return true; },
        }),
      }],
    });
    await expect(p.complete({ ...PARAMS, retryContext: { agentAttempt: 1 } } as any)).rejects.toMatchObject({ code: PROVIDER_EMPTY_NORMAL_CODE });
    expect(calls).toBe(1);
  });

  it('complete() treats a truncated reply as an answer, not as empty', async () => {
    const truncated = { content: [], stopReason: 'max_tokens', usage: { inputTokens: 1, outputTokens: 9, totalTokens: 10 }, model: 'test' };
    let calls = 0;
    const p = createRotatingProvider({
      providerId: 'test',
      candidates: [{
        profileId: 'p1', providerId: 'test', modelId: 'test-model',
        build: async () => ({
          id: 'p1', name: 'p1',
          async *stream() { throw new Error('stream not used'); },
          async complete() { calls += 1; return truncated; },
          async validateAuth() { return true; },
        }),
      }],
    });
    await expect(p.complete(PARAMS)).resolves.toBe(truncated);
    expect(calls).toBe(1);
  });
});

describe('rotating-provider › user-confirmed rate-limit fallback', () => {
  beforeEach(() => _clearAll());

  for (const mode of ['stream', 'complete'] as const) {
    const invoke = async (provider: LLMProvider) => mode === 'stream'
      ? collect(provider.stream(PARAMS)) : provider.complete(PARAMS);

    it(`${mode}: tries every configured model even with a shared credential, then reopens them on a new request`, async () => {
      const attempts: string[] = [];
      let recovered = false;
      const configured = ['a', 'b', 'c'].map((modelId): RotatingCandidate => ({
        profileId: 'shared', providerId: 'test', modelId,
        build: async () => {
          attempts.push(modelId);
          const error = !recovered && modelId !== 'c'
            ? Object.assign(new Error('Too Many Requests'), { status: 429 }) : undefined;
          return fakeProvider(modelId, {
            throwBefore: error, completeError: error,
            streamEvents: [{ type: 'text_delta', text: modelId } as any],
            completeResult: { content: [{ type: 'text', text: modelId }], stopReason: 'end_turn' },
          });
        },
      }));
      const makeRequest = () => createRotatingProvider({ providerId: 'test', candidates: configured });
      const provider = makeRequest();
      const result = await invoke(provider);
      expect(JSON.stringify(result)).toContain('"text":"c"');
      expect(attempts).toEqual(['a', 'b', 'c']);
      await invoke(provider); // The same task's next model round must not revisit a/b.
      expect(attempts).toEqual(['a', 'b', 'c', 'c']);
      expect(getCooldown('shared')).toBeUndefined();
      recovered = true;
      const retry = await invoke(makeRequest());
      expect(JSON.stringify(retry)).toContain('"text":"a"');
      expect(attempts).toEqual(['a', 'b', 'c', 'c', 'a']);
    });

    it(`${mode}: stops after all candidates rate-limit without replaying the exhausted sweep`, async () => {
      const attempts: string[] = [];
      const p = createRotatingProvider({ providerId: 'test', candidates: ['a', 'b'].map((modelId) => ({
        profileId: modelId, providerId: 'test', modelId,
        build: async () => {
          attempts.push(modelId);
          const error = Object.assign(new Error('Too Many Requests'), { status: 429 });
          return fakeProvider(modelId, { throwBefore: error, completeError: error });
        },
      })) });
      const { classifyRetryableError } = await import('#core-agent');
      for (let round = 0; round < 2; round++) {
        let failure: unknown;
        try { await invoke(p); } catch (error) { failure = error; }
        expect(failure).toMatchObject({ code: 'PROVIDER_RATE_LIMIT_EXHAUSTED' });
        expect(classifyRetryableError(failure)).toBeNull();
      }
      expect(attempts).toEqual(['a', 'b']);
      expect(getCooldown('a')).toBeUndefined();
      expect(getCooldown('b')).toBeUndefined();
    });
  }

  it('does not run a fallback after the user cancels a rate-limited request', async () => {
    const controller = new AbortController();
    let fallbackAttempts = 0;
    const p = createRotatingProvider({ providerId: 'test', candidates: [{
      profileId: 'a', providerId: 'test', modelId: 'a',
      build: async () => {
        controller.abort(new Error('user cancelled'));
        throw Object.assign(new Error('Too Many Requests'), { status: 429 });
      },
    }, {
      profileId: 'b', providerId: 'test', modelId: 'b',
      build: async () => { fallbackAttempts++; return fakeProvider('b', {}); },
    }] });
    await expect(collect(p.stream({ ...PARAMS, signal: controller.signal }))).rejects.toThrow('user cancelled');
    expect(fallbackAttempts).toBe(0);
    expect(getCooldown('a')).toBeUndefined();
  });
});


describe('rate-limit fallback across a real AgentRunner tool round', () => {
  beforeEach(() => _clearAll());

  it('continues with another configured model using committed results, without replaying the tool', async () => {
    let primaryCalls = 0;
    let fallbackCalls = 0;
    let toolCalls = 0;
    const fallbackMessages: CompletionParams['messages'][] = [];
    const rotating = createRotatingProvider({ providerId: 'mock', candidates: [{
      profileId: 'shared', providerId: 'mock', modelId: 'model-a',
      build: async () => ({
        ...fakeProvider('mock', {}),
        async *stream(): AsyncIterable<StreamEvent> {
          primaryCalls++;
          if (primaryCalls > 1) throw Object.assign(new Error('Too Many Requests'), { status: 429 });
          yield { type: 'message_end', stopReason: 'tool_use',
            usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
            content: [{ type: 'tool_use', id: 'one-write', name: 'write_once', input: {} }],
            model: 'model-a', providerTermination: { category: 'normal' } };
        },
      }),
    }, {
      profileId: 'shared', providerId: 'mock', modelId: 'model-b',
      build: async () => ({
        ...fakeProvider('mock', {}),
        async *stream(params: CompletionParams): AsyncIterable<StreamEvent> {
          fallbackCalls++;
          fallbackMessages.push(params.messages);
          expect(params.model).toBe('model-b');
          yield { type: 'message_end', stopReason: 'end_turn',
            usage: { inputTokens: 4, outputTokens: 1, totalTokens: 5 },
            content: [{ type: 'text', text: 'saved once' }],
            model: 'model-b', providerTermination: { category: 'normal' } };
        },
      }),
    }] });
    const registry = new ProviderRegistry();
    registry.registerFactory('mock', () => rotating);
    const runner = new AgentRunner({
      config: createConfig({ agent: { defaultProvider: 'mock', defaultModel: 'model-a' } }),
      providers: registry,
      tools: [defineTool({ name: 'write_once', description: 'Save fixture',
        inputSchema: { type: 'object', properties: {} },
        async execute() { toolCalls++; return { content: 'saved-record-42' }; },
      })],
    });
    const result = await runner.run({ message: 'Save the record and report the result.' });
    expect(result.text).toBe('saved once');
    expect(toolCalls).toBe(1);
    expect(primaryCalls).toBe(2);
    expect(fallbackCalls).toBe(1);
    expect(JSON.stringify(fallbackMessages)).toContain('saved-record-42');
    expect(getCooldown('shared')).toBeUndefined();
  });

  it('advances after the one empty-response recovery attempt is rate-limited', async () => {
    let primaryCalls = 0;
    const p = createRotatingProvider({ providerId: 'test', candidates: [{
      profileId: 'a', providerId: 'test', modelId: 'a',
      build: async () => {
        primaryCalls++;
        return primaryCalls === 1
          ? fakeProvider('a', { streamEvents: [{ type: 'message_end', stopReason: 'end_turn',
            content: [], providerTermination: { category: 'normal' } } as any] })
          : fakeProvider('a', { throwBefore: Object.assign(new Error('Too Many Requests'), { status: 429 }) });
      },
    }, candidate('b', { streamEvents: [{ type: 'text_delta', text: 'fallback answer' } as any] })] });
    const events = await collect(p.stream(PARAMS));
    expect(events).toContainEqual({ type: 'text_delta', text: 'fallback answer' });
    expect(primaryCalls).toBe(2);
    expect(getCooldown('a')).toBeUndefined();
  });
});

// of retrying into the same limit. Other endings keep the provider's error.
describe('all configured models rate limited', () => {
  const throttled = () => Object.assign(new Error('Too Many Requests'), { status: 429 });
  const ownCandidates = () => [
    candidate('own-a', { throwBefore: throttled(), completeError: throttled() }, 'custom', 'free-a'),
    candidate('own-b', { throwBefore: throttled(), completeError: throttled() }, 'deepseek', 'free-b'),
  ];

  it.each(['stream', 'complete'] as const)('says every configured model is throttled (%s)', async method => {
    _clearAll();
    const p = createRotatingProvider({ providerId: 'custom', networkRetryAttempts: 0, candidates: ownCandidates() });
    const invoke = () => method === 'stream' ? collect(p.stream(PARAMS)) : p.complete(PARAMS);
    for (let i = 0; i < 2; i++) {
      await expect(invoke()).rejects.toMatchObject({
        code: 'PROVIDER_RATE_LIMIT_EXHAUSTED', message: ALL_CONFIGURED_RATE_LIMITED_MESSAGE,
      });
    }
  });

  it('keeps the provider error when another configured model failed for a different reason', async () => {
    _clearAll();
    const reset = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    const p = createRotatingProvider({ providerId: 'custom', networkRetryAttempts: 0, candidates: [
      candidate('own-a', { throwBefore: reset }, 'custom', 'free-a'),
      candidate('own-b', { throwBefore: throttled() }, 'deepseek', 'free-b'),
    ] });
    const err = await collect(p.stream(PARAMS)).catch(error => error);
    expect(err).toMatchObject({ code: 'PROVIDER_RATE_LIMIT_EXHAUSTED' });
    expect(err.message).not.toBe(ALL_CONFIGURED_RATE_LIMITED_MESSAGE);
  });

  it('keeps the provider error when a stream is throttled after output began', async () => {
    _clearAll();
    const p = createRotatingProvider({ providerId: 'custom', networkRetryAttempts: 0, candidates: [
      candidate('own-a', { streamEvents: [{ type: 'text_delta', text: 'partial' } as any,
        { type: 'error', error: throttled() } as any] }, 'custom', 'free-a'),
      candidate('own-b', { streamEvents: [{ type: 'text_delta', text: 'ok' } as any] }, 'deepseek', 'free-b'),
    ] });
    const err = await collect(p.stream(PARAMS)).catch(error => error);
    expect(err).toMatchObject({ code: 'COMMITTED_STREAM_RATE_LIMIT' });
    expect(err.message).not.toBe(ALL_CONFIGURED_RATE_LIMITED_MESSAGE);
  });
});


describe('user-owned provider balance isolation', () => {
  beforeEach(() => _clearAll());
  it('keeps an Orkas-looking quota code from a user endpoint as an ordinary balance failure', async () => {
    const lookalike = Object.assign(new Error('payment required'), { status: 402, code: 'orkas_llm_quota_exceeded' });
    const p = createRotatingProvider({
      providerId: 'custom',
      networkRetryDelayMs: () => 0,
      candidates: [candidate('custom-key', { throwBefore: lookalike }, 'custom', 'custom-model')],
    });
    await expect(collect(p.stream(PARAMS))).rejects.toMatchObject({ code: 'PROVIDER_BALANCE_EXHAUSTED' });
    expect(getCooldown('custom-key')?.kind).toBe('balance');
  });
  it('stays quiet when throttling moves the run between the user\'s own credentials', async () => {
    const p = createRotatingProvider({
      providerId: 'openai',
      networkRetryDelayMs: () => 0,
      candidates: [
        candidate('mine', { throwBefore: Object.assign(new Error('Too Many Requests'), { status: 429 }) }, 'openai', 'gpt-test'),
        candidate('also-mine', { streamEvents: [{ type: 'text_delta', text: 'ok' } as any] }, 'deepseek', 'deepseek-test'),
      ],
    });
    const events = await collect(p.stream(PARAMS));
    expect(events.some((event: any) => event.type === 'provider_fallback')).toBe(false);
    expect((events.at(-1) as any).text).toBe('ok');

  });
});
describe('rotating-provider › failures that a same-candidate retry cannot help', () => {
  // The managed Server's in-band startup failure after it has tried its own routes.
  const managedStartupFailure = () => Object.assign(new Error('Provider stream error'), {
    status: 503, cause: { code: 'upstream_error', cause: {} }, providerRequestRejected: true,
  });
  // A configured model the provider does not have.
  const modelNotFound = () => Object.assign(new Error('404 The model does not exist'), {
    status: 404, code: 'model_not_found', providerRequestRejected: true,
  });
  const invalidRequest = () => Object.assign(new Error('400 Invalid request'), {
    status: 400, code: 'invalid_request_error', providerRequestRejected: true,
  });

  /** A candidate that fails before any output after `waitMs`, or serves when `fail` is absent. */
  function timedCandidate(id: string, sends: string[], behavior: { fail?: () => unknown; waitMs?: number },
    providerId = 'openai'): RotatingCandidate {
    return {
      profileId: id, cooldownId: id, providerId, modelId: id,
      build: async () => ({
        ...fakeProvider(id, {}),
        async *stream() {
          sends.push(id);
          yield { type: 'message_start' } as StreamEvent;
          if (behavior.waitMs) vi.advanceTimersByTime(behavior.waitMs);
          if (behavior.fail) { yield { type: 'error', error: behavior.fail() } as unknown as StreamEvent; return; }
          yield { type: 'text_delta', text: 'ok' } as StreamEvent;
        },
        async complete() {
          sends.push(id);
          if (behavior.waitMs) vi.advanceTimersByTime(behavior.waitMs);
          if (behavior.fail) throw behavior.fail();
          return { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } } as unknown as CompletionResult;
        },
      }),
    };
  }
  const call = (provider: LLMProvider, method: 'stream' | 'complete') => (method === 'stream'
    ? collect(provider.stream(PARAMS)) : provider.complete(PARAMS)).then(() => 'ok', (error) => String(error?.code || error?.message));

  beforeEach(() => { _clearAll(); vi.useFakeTimers({ toFake: ['performance'] }); });
  afterEach(() => { vi.useRealTimers(); _clearAll(); });

  it.each(['stream', 'complete'] as const)('sends an configured candidate once when it failed only after a long wait (%s)', async (method) => {
    const sends: string[] = [];
    const provider = createRotatingProvider({ providerId: 'openai', networkRetryDelayMs: () => 0,
      candidates: [timedCandidate('configured-first', sends, { fail: managedStartupFailure, waitMs: 280_000 })] });
    expect(await call(provider, method)).toBe('PROVIDER_NETWORK_EXHAUSTED');
    expect(sends).toEqual(['configured-first']);
  });

  it.each(['stream', 'complete'] as const)('moves on to the next candidate after a slow failure, without retrying in place (%s)', async (method) => {
    const sends: string[] = [];
    const provider = createRotatingProvider({ providerId: 'openai', networkRetryDelayMs: () => 0,
      candidates: [
        timedCandidate('configured-first', sends, { fail: managedStartupFailure, waitMs: 30_000 }),
        timedCandidate('configured-next', sends, {}),
      ] });
    expect(await call(provider, method)).toBe('ok');
    expect(sends).toEqual(['configured-first', 'configured-next']);
  });

  it.each(['stream', 'complete'] as const)('still retries a quick failure in place three times (%s)', async (method) => {
    const sends: string[] = [];
    const provider = createRotatingProvider({ providerId: 'openai', networkRetryDelayMs: () => 0,
      candidates: [timedCandidate('configured-first', sends, { fail: managedStartupFailure, waitMs: 29_999 })] });
    expect(await call(provider, method)).toBe('PROVIDER_NETWORK_EXHAUSTED');
    expect(sends).toEqual(['configured-first', 'configured-first', 'configured-first', 'configured-first']);
  });

  it.each(['stream', 'complete'] as const)('stops trying a model the provider does not have for the rest of the run (%s)', async (method) => {
    for (const providerId of ['openai', 'deepseek']) {
      const sends: string[] = [];
      const provider = createRotatingProvider({ providerId, networkRetryDelayMs: () => 0,
        candidates: [
          timedCandidate('missing-model', sends, { fail: modelNotFound }, providerId),
          timedCandidate('working-model', sends, {}, 'openai'),
        ] });
      for (let round = 0; round < 4; round++) expect(await call(provider, method)).toBe('ok');
      expect(sends).toEqual(['missing-model', 'working-model', 'working-model', 'working-model', 'working-model']);
      // A new run starts from the whole configured list again, with no stored cooldown.
      const nextRun: string[] = [];
      const next = createRotatingProvider({ providerId, networkRetryDelayMs: () => 0,
        candidates: [
          timedCandidate('missing-model', nextRun, { fail: modelNotFound }, providerId),
          timedCandidate('working-model', nextRun, {}, 'openai'),
        ] });
      expect(await call(next, method)).toBe('ok');
      expect(nextRun).toEqual(['missing-model', 'working-model']);
      expect(getCooldown('missing-model')).toBeUndefined();
    }
  });

  it.each(['stream', 'complete'] as const)('keeps a candidate that refused one request for the next one (%s)', async (method) => {
    const sends: string[] = [];
    const provider = createRotatingProvider({ providerId: 'openai', networkRetryDelayMs: () => 0,
      candidates: [
        timedCandidate('picky-model', sends, { fail: invalidRequest }, 'openai'),
        timedCandidate('working-model', sends, {}, 'openai'),
      ] });
    expect(await call(provider, method)).toBe('ok');
    expect(await call(provider, method)).toBe('ok');
    expect(sends).toEqual(['picky-model', 'working-model', 'picky-model', 'working-model']);
  });

  // 2026-11-02 review S1-7: a candidate that keeps answering 5xx at once was paid
  // four times (three in-place retries) at the start of every model call of the
  // run, while a later candidate did the work, and it still set the compaction budget.
  /** Fails quickly before output while `down()` is true, otherwise serves. */
  function flakyCandidate(id: string, sends: string[], down: () => boolean, providerId: string,
    contextWindow: number): RotatingCandidate {
    return {
      profileId: id, cooldownId: id, providerId, modelId: id, contextWindow, maxTokens: 8_000,
      build: async () => ({
        ...fakeProvider(id, {}),
        async *stream() {
          sends.push(id);
          yield { type: 'message_start' } as StreamEvent;
          if (down()) { yield { type: 'error', error: managedStartupFailure() } as unknown as StreamEvent; return; }
          yield { type: 'text_delta', text: 'ok' } as StreamEvent;
        },
        async complete() {
          sends.push(id);
          if (down()) throw managedStartupFailure();
          return { content: [{ type: 'text', text: 'ok' }], stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } } as unknown as CompletionResult;
        },
      }),
    };
  }

  it.each(['stream', 'complete'] as const)('sends a candidate another one outlived once per later call, and only for this run (%s)', async (method) => {
    const sends: string[] = [];
    const make = (log: string[]) => createRotatingProvider({ providerId: 'custom', networkRetryDelayMs: () => 0,
      candidates: [
        flakyCandidate('own-model', log, () => true, 'custom', 131_072),
        flakyCandidate('fallback-model', log, () => false, 'custom', 272_000),
      ] });
    const provider = make(sends);
    for (let round = 0; round < 3; round++) expect(await call(provider, method)).toBe('ok');
    expect(sends).toEqual([
      'own-model', 'own-model', 'own-model', 'own-model', 'fallback-model',
      'own-model', 'fallback-model',
      'own-model', 'fallback-model',
    ]);
    // A new run gives the user's model its in-place retries again; nothing is stored.
    const nextRun: string[] = [];
    expect(await call(make(nextRun), method)).toBe('ok');
    expect(nextRun).toEqual(['own-model', 'own-model', 'own-model', 'own-model', 'fallback-model']);
    expect(getCooldown('own-model')).toBeUndefined();
  });

  it.each(['stream', 'complete'] as const)('gives a recovered candidate its in-place retries back (%s)', async (method) => {
    const sends: string[] = [];
    let ownDown = true;
    let blip = false;
    const provider = createRotatingProvider({ providerId: 'custom', networkRetryDelayMs: () => 0,
      candidates: [
        flakyCandidate('own-model', sends, () => {
          if (blip) { blip = false; return true; }
          return ownDown;
        }, 'custom', 131_072),
        flakyCandidate('fallback-model', sends, () => false, 'custom', 272_000),
      ] });
    expect(await call(provider, method)).toBe('ok');
    ownDown = false;
    expect(await call(provider, method)).toBe('ok');
    // One quick failure after it served again is retried in place, as before.
    blip = true;
    expect(await call(provider, method)).toBe('ok');
    expect(sends).toEqual([
      'own-model', 'own-model', 'own-model', 'own-model', 'fallback-model',
      'own-model',
      'own-model', 'own-model',
    ]);
  });

  it.each(['stream', 'complete'] as const)('keeps every in-place retry when no candidate got through (%s)', async (method) => {
    const sends: string[] = [];
    const provider = createRotatingProvider({ providerId: 'custom', networkRetryDelayMs: () => 0,
      candidates: [
        flakyCandidate('own-model', sends, () => true, 'custom', 131_072),
        flakyCandidate('fallback-model', sends, () => true, 'custom', 272_000),
      ] });
    expect(await call(provider, method)).toBe('PROVIDER_NETWORK_EXHAUSTED');
    expect(await call(provider, method)).toBe('PROVIDER_NETWORK_EXHAUSTED');
    const once = ['own-model', 'own-model', 'own-model', 'own-model',
      'fallback-model', 'fallback-model', 'fallback-model', 'fallback-model'];
    expect(sends).toEqual([...once, ...once]);
  });

  it('prices compaction for the candidate that is serving, not one it outlived', async () => {
    const sends: string[] = [];
    let ownDown = true;
    const provider = createRotatingProvider({ providerId: 'custom', networkRetryDelayMs: () => 0,
      candidates: [
        flakyCandidate('own-model', sends, () => ownDown, 'custom', 131_072),
        flakyCandidate('fallback-model', sends, () => false, 'custom', 272_000),
      ] });
    expect(provider.contextBudgetModel?.()).toBe('own-model');
    expect(await call(provider, 'stream')).toBe('ok');
    expect(provider.contextBudgetModel?.()).toBe('fallback-model');
    expect(provider.contextBudget?.('next')).toMatchObject({ model: 'fallback-model', contextWindow: 272_000 });
    // Still failing on its one try: the budget stays with the serving model.
    expect(await call(provider, 'stream')).toBe('ok');
    expect(provider.contextBudgetModel?.()).toBe('fallback-model');
    // Once the user's model serves again, compaction is priced for it again.
    ownDown = false;
    expect(await call(provider, 'stream')).toBe('ok');
    expect(provider.contextBudgetModel?.()).toBe('own-model');
  });

  it('keeps the budget on a model that only missed a summary\'s shorter start deadline', async () => {
    const sends: string[] = [];
    const silent = flakyCandidate('own-model', sends, () => false, 'custom', 131_072);
    const provider = createRotatingProvider({ providerId: 'custom', networkRetryDelayMs: () => 0,
      candidates: [
        { ...silent, build: async () => ({
          ...(await silent.build()),
          async *stream(params: CompletionParams) {
            sends.push('own-model');
            yield { type: 'message_start' } as StreamEvent;
            await new Promise<void>((resolve) => params.signal?.addEventListener('abort', () => resolve(), { once: true }));
          },
        }) },
        flakyCandidate('fallback-model', sends, () => false, 'custom', 272_000),
      ] });
    const summary = await collect(provider.stream({ ...PARAMS, firstEventTimeoutMs: 5,
      requestMetadata: { outputLimitSource: 'provider_default' } }));
    expect(summary.some(event => event.type === 'text_delta')).toBe(true);
    expect(sends).toEqual(['own-model', 'fallback-model']);
    expect(provider.contextBudgetModel?.()).toBe('own-model');
  });

  it('prices for an outlived candidate when it is the only one left', async () => {
    const sends: string[] = [];
    let fallbackRateLimited = false;
    const fallback = flakyCandidate('fallback-model', sends, () => false, 'custom', 272_000);
    const provider = createRotatingProvider({ providerId: 'custom', networkRetryDelayMs: () => 0,
      candidates: [
        flakyCandidate('own-model', sends, () => true, 'custom', 131_072),
        { ...fallback, build: async () => ({
          ...(await fallback.build()),
          async *stream() {
            sends.push('fallback-model');
            if (fallbackRateLimited) throw Object.assign(new Error('Too Many Requests'), { status: 429 });
            yield { type: 'text_delta', text: 'ok' } as StreamEvent;
          },
        }) },
      ] });
    expect(await call(provider, 'stream')).toBe('ok');
    expect(provider.contextBudgetModel?.()).toBe('fallback-model');
    fallbackRateLimited = true;
    expect(await call(provider, 'stream')).not.toBe('ok');
    expect(sends.slice(-2)).toEqual(['own-model', 'fallback-model']);
    // The fallback models are out for this run; the user's model is what is left.
    expect(provider.contextBudgetModel?.()).toBe('own-model');
  });
});
