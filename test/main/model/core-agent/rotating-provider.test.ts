import { describe, it, expect, beforeEach } from 'vitest';

import { classifyTransientNetworkError } from '../../../../src/core-agent/src/shared/errors';
import {
  boundMessagesForImageLimit,
  createRotatingProvider,
  PROVIDER_EMPTY_NORMAL_CODE,
  PROVIDER_EMPTY_SAFETY_CODE,
  PROVIDER_EMPTY_UNKNOWN_CODE,
  type RotatingCandidate,
} from '../../../../src/main/model/core-agent/rotating-provider';
import type { LLMProvider, StreamEvent, CompletionParams, CompletionResult } from '#core-agent';
import { AgentRunner, createConfig, defineTool, ProviderError, ProviderRegistry } from '#core-agent';
import { _clearAll, getCooldown } from '../../../../src/main/model/core-agent/profile-cooldown';

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

  it('invalidated OAuth is shown once, falls back immediately, and stays skipped for later model rounds', async () => {
    const authErr = new Error('Encountered invalidated oauth token for user, failing request');
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
    expect(getCooldown('p1')?.kind).toBe('rate_limit');
  });

  it('treats a 429 insufficient-quota response as balance exhaustion without a network retry', async () => {
    const quotaErr = Object.assign(new Error('429 {"error":{"message":"insufficient quota","type":"insufficient_quota"}}'), { status: 429 });
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
    const quotaErr = new Error('429 账户余额不足');
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
    const balanceErr = new Error('账户余额不足，请充值');
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
    const authErr = new Error('invalid_api_key');
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
    const netErr = new TypeError('fetch failed');
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
    const netErr = new TypeError('fetch failed');
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

  it('Server retry policy can blacklist otherwise retryable pre-content errors', async () => {
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
          candidate('p1', { throwBefore: new Error('custom_non_retryable') }),
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
      await expect(collect(p.stream(PARAMS))).rejects.toThrow(/custom_non_retryable/);
      expect(p2Called).toBe(false);
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
    ['length', 'unknown_empty', PROVIDER_EMPTY_UNKNOWN_CODE],
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
              stopReason: category === 'length' ? 'max_tokens' : 'end_turn',
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
    const authErr = new Error('invalid_api_key');
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

  it('retries each network-failing candidate and surfaces a stable exhausted error without cooldown', async () => {
    const netErr = new TypeError('fetch failed');
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
      role: 'user',
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
    const netErr = new TypeError('fetch failed');
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
              throw new TypeError('fetch failed');
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
    controller.abort(new Error('user stopped compaction'));

    await expect(completing).rejects.toThrow(/user stopped compaction/);
    expect(primaryBuilds).toBe(1);
    expect(fallbackBuilds).toBe(0);
  });
});
