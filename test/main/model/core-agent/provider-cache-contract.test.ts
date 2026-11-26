import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import * as zlib from 'node:zlib';
import { getBuiltinModel } from '@earendil-works/pi-ai/providers/all';
import type { Api, Model } from '@earendil-works/pi-ai';
import { createPiProvider } from '../../../../src/core-agent/src/providers/pi-provider.js';
import { PUBLIC_PROVIDER_MODELS } from '../../../../src/main/model/public_model_catalog';
import { CATALOG } from '../../../../src/main/model/provider_catalog';
import { providerUserCacheKey } from '../../../../src/main/model/core-agent/provider-cache-scope';
import { createRotatingProvider } from '../../../../src/main/model/core-agent/rotating-provider';
import type { CompletionParams } from '../../../../src/core-agent/src/providers/base.js';
import { Session } from '../../../../src/core-agent/src/agent/session.js';

import { buildCustomAnthropicModel, buildCustomOpenAICompatibleModel, buildCustomResponsesModel,
  buildDeepSeekModel, buildDoubaoModel, buildRuntimeMoonshotModel, buildOrkasApiModel,
} from '../../../../src/main/model/core-agent/external-providers';

const jwt = `fixture.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': {
  chatgpt_account_id: 'fixture-account',
} })).toString('base64')}.fixture`;
const config = { baseUrl: 'https://fixture.invalid/v1', contextWindow: 128000, maxTokens: 4096 };
const builtin = (provider: string, id?: string): Model<Api> => {
  const model = getBuiltinModel(provider as any, (id ?? PUBLIC_PROVIDER_MODELS[provider]?.[0]?.id) as any);
  if (!model) throw new Error(`Missing fixture model: ${provider}`);
  return model;
};
const scenarios: Array<[string, () => Model<Api> | Promise<Model<Api>>]> = [
  ['codex', () => builtin('openai-codex', 'gpt-6.1-sol')],
  ['openai', () => builtin('openai', 'gpt-6.1-sol')],
  ['openai-sol-6.2', () => builtin('openai', 'gpt-6.2-sol')],
  ['openai-sol-6', () => builtin('openai', 'gpt-6-sol')],
  ['openai-sol-5.6', () => builtin('openai', 'gpt-5.6-sol')],
  ['openai-astra', () => builtin('openai', 'gpt-6.2-astra')],
  ['openai-legacy', () => builtin('openai', 'gpt-5.5')],
  ['openrouter-openai', () => builtin('openrouter', 'openai/gpt-6.1-sol')],
  ['openrouter-auto', () => builtin('openrouter', 'openrouter/auto')],
  ['openrouter-claude', () => builtin('openrouter', 'anthropic/claude-opus-5')],
  ['claude', () => builtin('anthropic')],
  ['gemini', () => builtin('google')],
  ['glm', () => builtin('zai')],
  ['kimi-coding', () => builtin('kimi-coding', 'kimi-for-coding')],
  ['moonshot', () => buildRuntimeMoonshotModel('kimi-k3')],
  ['moonshot-k3.1', () => buildRuntimeMoonshotModel('kimi-k3.1-pro')],
  ['moonshot-legacy', () => buildRuntimeMoonshotModel('kimi-k2.7-code')],
  ['doubao', () => buildDoubaoModel('doubao-seed-2-1-pro-260915')],
  ['deepseek', () => buildDeepSeekModel('deepseek-v4-flash')],
  ['minimax-cn', () => builtin('minimax-cn', 'MiniMax-M3')],
  ['minimax-global-oauth', () => ({ ...builtin('minimax', 'MiniMax-M3'), provider: 'minimax-portal' })],
  ['minimax-cn-oauth', () => ({ ...builtin('minimax-cn', 'MiniMax-M3'), provider: 'minimax-portal-cn' })],
  ['orkas-api', () => buildOrkasApiModel('orkas-llm-1.5-pro')],
  ['custom-chat', () => buildCustomOpenAICompatibleModel('fixture', config)],
  ['custom-responses', () => buildCustomResponsesModel('fixture', config)],
  ['custom-claude', () => buildCustomAnthropicModel('claude-haiku-5-5', config)],
];
const report: unknown[] = [];
afterEach(() => vi.unstubAllGlobals());
afterAll(() => {
  if (process.env.ORKAS_CACHE_AUDIT_OUTPUT) fs.writeFileSync(process.env.ORKAS_CACHE_AUDIT_OUTPUT,
    JSON.stringify({ boundary: 'real-sdk-serialization-zero-network', scenarios: report }, null, 2));
});

describe('Provider cache and conversation isolation contracts', () => {
  it.each((['complete', 'stream'] as const).flatMap(method =>
    [
      ['anthropic', 'claude-haiku-5-5'],
      ['anthropic', 'claude-fable-5-2'],
      ['openrouter', 'anthropic/claude-sonnet-5.5'],
      ['custom', 'claude-haiku-5-5'],
    ].map(([providerId, modelId]) => [method, providerId, modelId] as const),
  ))('keeps the Claude hour breakpoint before active tool input through %s on %s/%s', async (method, providerId, modelId) => {
    const session = new Session();
    const user = (text: string) => [{ type: 'text' as const, text }];
    const model = providerId === 'custom'
      ? buildCustomAnthropicModel(modelId, { ...config, baseUrl: 'https://aihubmix.com' })
      : builtin(providerId, modelId);
    const provider = createPiProvider({ provider: providerId, apiKey: 'sk-fixture', customModel: model });
    let wire: any;
    vi.stubGlobal('fetch', vi.fn(async (input, init) => {
      wire = await new Request(input, init).json();
      throw new Error('Expected zero-network transport stop');
    }));
    async function send(retention: CompletionParams['cacheRetention']) {
      wire = undefined;
      const params: CompletionParams = {
        model: model.id, reasoning: 'low', cacheRetention: retention, onRequestFailure() {},
        systemPrompt: 'Stable project instructions',
        tools: [{ name: 'lookup', description: 'Read a result', inputSchema: { type: 'object' } }],
        messages: session.getMessagesForModel({ turnContext: 'Current turn state', markStableCacheHistory: retention === 'long' }),
      };
      if (method === 'complete') await provider.complete(params).catch(() => undefined);
      else { try { for await (const _ of provider.stream(params)) { /* Expected transport stop. */ } } catch (error) { if (!wire) throw error; } }
      expect(wire).toBeDefined();
      return wire;
    }
    const blocks = (body: any) => body.messages.flatMap((message: any) => message.content);
    session.beginUserTurn(user('Review the original source'));
    const first = await send('long');
    expect(first.system.at(-1).cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(blocks(first).filter((block: any) => block.cache_control)).toEqual([]);

    session.addAssistantMessage(user('The source reports three values.'));
    session.completeActiveTurn();
    session.beginUserTurn(user('Check the updated source'));
    session.addAssistantMessage([{ type: 'tool_use', id: 'lookup_1', name: 'lookup', input: {} }]);
    session.addMessage('user', [{ type: 'tool_result', toolUseId: 'lookup_1', content: 'New result for this turn' }]);
    const long = await send('long');
    const short = await send('short');
    expect(blocks(long).filter((block: any) => block.cache_control)).toEqual([
      { type: 'text', text: 'The source reports three values.', cache_control: { type: 'ephemeral', ttl: '1h' } },
    ]);
    expect(blocks(short).filter((block: any) => block.cache_control)).toEqual([
      expect.objectContaining({ type: 'tool_result', cache_control: { type: 'ephemeral' } }),
    ]);
    const withoutCacheMarkers = (body: any) => JSON.parse(JSON.stringify(body, (key, value) => key === 'cache_control' ? undefined : value));
    expect(withoutCacheMarkers(long)).toEqual(withoutCacheMarkers(short));
  });

  it('keeps full context and uses native Kimi caching after a Claude rejection', async () => {
    const claude = builtin('anthropic', 'claude-fable-5-2');
    const kimi = await buildRuntimeMoonshotModel('kimi-k3');
    const requests: Array<any> = [];
    vi.stubGlobal('fetch', vi.fn(async (input, init) => {
      const request = await new Request(input, init).json();
      requests.push(request);
      if (request.model === claude.id) {
        return Response.json({ type: 'error', error: { type: 'authentication_error', message: 'Fixture key rejected' } }, { status: 401 });
      }
      throw new Error('Expected zero-network transport stop');
    }));
    const provider = createRotatingProvider({ providerId: 'anthropic', networkRetryAttempts: 0, candidates: [claude, kimi].map(model => ({
      profileId: `cache-boundary-fallback-${model.provider}`,
      providerId: model.provider,
      modelId: model.id,
      build: async () => createPiProvider({ provider: model.provider, apiKey: 'sk-fixture', customModel: model }),
    })) });
    const session = new Session();
    session.beginUserTurn([{ type: 'text', text: 'Read the source' }]);
    session.addAssistantMessage([{ type: 'text', text: 'The source contains three items' }]);
    session.completeActiveTurn();
    session.beginUserTurn([{ type: 'text', text: 'Compare the three items' }]);
    await expect(provider.complete({ model: claude.id, systemPrompt: 'Stable system', cacheRetention: 'long', onRequestFailure() {},
      messages: session.getMessagesForModel({ markStableCacheHistory: true }),
    })).rejects.toThrow();
    expect(requests.map(request => request.model)).toEqual([claude.id, kimi.id]);
    expect(requests[0].messages.find((row: any) => row.role === 'assistant').content.at(-1))
      .toMatchObject({ text: 'The source contains three items', cache_control: { ttl: '1h' } });
    expect(requests[1].prompt_cache_options).toEqual({ mode: 'implicit', ttl: '1h' });
    const fallbackMessages = JSON.stringify(requests[1].messages);
    expect(fallbackMessages).toContain('The source contains three items');
    expect(fallbackMessages).toContain('Compare the three items');
    expect(fallbackMessages).not.toContain('cache_control');
  });

  it('keeps opaque user mapping stable without manufacturing a shared anonymous identity', () => {
    for (const absent of [undefined, null, '', 'anonymous']) expect(providerUserCacheKey(absent)).toBeUndefined();
    const a = providerUserCacheKey('用户/opaque-A')!;
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(a).toBe(providerUserCacheKey('用户/opaque-A'));
    expect(a).not.toBe(providerUserCacheKey('用户/opaque-B'));
    expect(a).not.toContain('opaque-A');
  });
  it('covers every built-in provider card and public custom routes', async () => {
    const models = await Promise.all(scenarios.map(([, build]) => build()));
    expect(new Set(models.map(model => model.provider))).toEqual(new Set([
      ...CATALOG.map(entry => entry.id),
    ]));
  });
  it.each(scenarios.flatMap(([id, build]) => (['short', 'long', 'none'] as const)
    .flatMap(retention => (['complete', 'stream'] as const).map(method => [id, retention, method, build] as const))))
  ('%s / %s / %s keeps final wire input independent of cache/session identity', async (id, retention, method, build) => {
    const model = await build();
    const captures: Array<{ payload: any; headers?: Headers }> = [];
    let current: { payload: any; headers?: Headers };
    // The real SDK serializes and reaches the transport; the explicit stop
    // forbids paid traffic. This does not simulate cache hits or acceptance.
    vi.stubGlobal('fetch', vi.fn(async (input, init) => {
      const wire = new Request(input, init);
      current.headers = wire.headers;
      const bytes = Buffer.from(await wire.arrayBuffer());
      const body = wire.headers.get('content-encoding') === 'zstd' ? zlib.zstdDecompressSync(bytes) : bytes;
      current.payload = JSON.parse(body.toString('utf8'));
      throw new Error('Expected zero-network transport stop');
    }));
    for (const sessionId of ['fixture-chat-a', 'fixture-chat-b']) {
      current = { payload: undefined };
      const providerConfig = { provider: model.provider, apiKey: model.api === 'openai-codex-responses' ? jwt : 'sk-fixture',
        userCacheKey: 'opaque-user-fixture',
        customModel: model,
      };
      const sdkProvider = createPiProvider(providerConfig);
      const p = model.provider === 'openai' || model.provider === 'anthropic' ? createRotatingProvider({
        providerId: model.provider,
        candidates: [{
          profileId: id, providerId: model.provider, modelId: model.id, build: async () => sdkProvider,
        }],
        networkRetryAttempts: 0,
      }) : sdkProvider;
      const params: CompletionParams = { model: model.id, sessionId, cacheRetention: retention, onRequestFailure() {},
        systemPrompt: 'Stable reference', messages: [{ role: 'user', content: [{ type: 'text', text: 'Read the reference' }] }],
      };
      if (method === 'complete') await p.complete(params).catch(() => undefined);
      else {
        try {
          for await (const _event of p.stream(params)) { /* Expected transport stop. */ }
        } catch (error) {
          if (!current.payload) throw error;
        }
      }
      expect(current.payload, 'Decode the final wire body, including Codex compression').toBeDefined();
      expect(current.headers, 'The outbound transport must be intercepted').toBeDefined();
      captures.push(current);
    }
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    const semantic = (payload: any) => {
      const copy = structuredClone(payload);
      delete copy.prompt_cache_key;
      return copy;
    };
    expect(semantic(captures[0].payload)).toEqual(semantic(captures[1].payload));
    expect(JSON.stringify(semantic(captures[0].payload))).not.toContain('fixture-chat-');
    const a = captures[0].headers!, b = captures[1].headers!;
    if (retention !== 'none' && (model.api === 'openai-codex-responses' || model.api === 'openai-responses')) {
      expect(a.get('session-id')).toBe('opaque-user-fixture');
      expect(b.get('session-id')).toBe('opaque-user-fixture');
      expect(a.get('x-client-request-id')).not.toBe(b.get('x-client-request-id'));
    } else expect(a.has('session-id') || b.has('session-id')).toBe(false);
    if (model.provider === 'openrouter') {
      expect(a.get('x-session-id')).toBe(retention === 'none' ? null : 'fixture-chat-a');
      expect(b.get('x-session-id')).toBe(retention === 'none' ? null : 'fixture-chat-b');
    }
    if (retention === 'none') {
      for (const { payload } of captures) {
        expect(payload.prompt_cache_key).toBeUndefined();
        expect(payload.prompt_cache_retention).toBeUndefined();
        expect(JSON.stringify(payload)).not.toContain('"cache_control"');
        expect(payload.prompt_cache_options).toEqual(model.provider === 'openai' && id !== 'openai-legacy'
          ? { mode: 'explicit' } : undefined);
      }
    }
    if (id === 'claude' && retention !== 'none') {
      for (const { payload } of captures) {
        expect(payload.system.at(-1).cache_control).toEqual(retention === 'short'
          ? { type: 'ephemeral' }
          : { type: 'ephemeral', ttl: '1h' });
      }
    }
    if (id === 'custom-claude' && retention === 'long') {
      expect(captures[0].payload.messages.at(-1).content.at(-1)).toMatchObject({
        text: 'Read the reference', cache_control: { type: 'ephemeral', ttl: '1h' },
      });
    }
    if (['custom-chat', 'deepseek'].includes(id)) {
      expect(captures[0].payload.prompt_cache_key).toBeUndefined();
      expect(captures[0].payload.prompt_cache_retention).toBeUndefined();
    }
    if (['openrouter-openai', 'glm', 'kimi-coding', 'moonshot', 'moonshot-k3.1', 'moonshot-legacy', 'doubao'].includes(id)) {
      const opts = retention === 'long' && (id === 'moonshot' || id === 'moonshot-k3.1')
        ? { mode: 'implicit', ttl: '1h' } : undefined;
      for (const { payload } of captures) {
        expect(payload.prompt_cache_retention).toBeUndefined();
        expect(payload.prompt_cache_options).toEqual(opts);
        expect(payload.prompt_cache_key).toBe(retention === 'long' ? 'opaque-user-fixture' : undefined);
      }
    }
    if (id === 'openrouter-auto') {
      expect(captures[0].payload.prompt_cache_retention).toBe(retention === 'long' ? '24h' : undefined);
    }
    if (model.provider === 'openai' && retention !== 'none') {
      const cacheOptions = id === 'openai-astra' && retention === 'long' ? { ttl: '30m' } : undefined;
      for (const { payload } of captures) {
        expect(payload.prompt_cache_options).toEqual(cacheOptions);
        expect(payload.prompt_cache_retention).toBe(id === 'openai-legacy' && retention === 'long' ? '24h' : undefined);
        expect(payload.prompt_cache_key).toBe('opaque-user-fixture');
      }
    }
    if (captures[0].payload.prompt_cache_key !== undefined) {
      expect(captures.map(c => c.payload.prompt_cache_key)).toEqual(['opaque-user-fixture', 'opaque-user-fixture']);
    }
    report.push({ id, retention, method, provider: model.provider, model: model.id, api: model.api,
      semanticInputStable: true,
      bodyKeyChanges: captures[0].payload.prompt_cache_key !== captures[1].payload.prompt_cache_key,
      legacyRetention: captures[0].payload.prompt_cache_retention ?? null,
      cacheOptions: captures[0].payload.prompt_cache_options ?? null,
      changedHeaders: ['session-id', 'session_id', 'x-session-id', 'x-client-request-id']
        .filter(name => a.get(name) !== b.get(name)),
      stableHeaders: ['session-id', 'session_id', 'x-session-id']
        .filter(name => a.has(name) && a.get(name) === b.get(name)),
    });
  });
});
