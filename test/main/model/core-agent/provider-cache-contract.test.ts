import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import * as zlib from 'node:zlib';
import { getBuiltinModel } from '@earendil-works/pi-ai/providers/all';
import type { Api, Model } from '@earendil-works/pi-ai';
import { createPiProvider } from '../../../../src/core-agent/src/providers/pi-provider.js';
import { PUBLIC_PROVIDER_MODELS } from '../../../../src/main/model/public_model_catalog';
import { CATALOG } from '../../../../src/main/model/provider_catalog';
import type { CompletionParams } from '../../../../src/core-agent/src/providers/base.js';

import { buildCustomAnthropicModel, buildCustomOpenAICompatibleModel,
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
  ['openrouter-openai', () => builtin('openrouter', 'openai/gpt-6.1-sol')],
  ['openrouter-claude', () => builtin('openrouter', 'anthropic/claude-opus-5')],
  ['claude', () => builtin('anthropic')],
  ['gemini', () => builtin('google')],
  ['glm', () => builtin('zai')],
  ['kimi-coding', () => builtin('kimi-coding', 'kimi-for-coding')],
  ['moonshot', () => buildRuntimeMoonshotModel('kimi-k3')],
  ['doubao', () => buildDoubaoModel('doubao-seed-2-1-pro-260915')],
  ['deepseek', () => buildDeepSeekModel('deepseek-v4-flash')],
  ['minimax-cn', () => builtin('minimax-cn', 'MiniMax-M3')],
  ['minimax-global-oauth', () => ({ ...builtin('minimax', 'MiniMax-M3'), provider: 'minimax-portal' })],
  ['minimax-cn-oauth', () => ({ ...builtin('minimax-cn', 'MiniMax-M3'), provider: 'minimax-portal-cn' })],
  ['orkas-api', () => buildOrkasApiModel('orkas-llm-1.5-pro')],
  ['custom-chat', () => buildCustomOpenAICompatibleModel('fixture', config)],
  ['custom-claude', () => buildCustomAnthropicModel('fixture', config)],
];
const report: unknown[] = [];
afterEach(() => vi.unstubAllGlobals());
afterAll(() => {
  if (process.env.ORKAS_CACHE_AUDIT_OUTPUT) fs.writeFileSync(process.env.ORKAS_CACHE_AUDIT_OUTPUT,
    JSON.stringify({ boundary: 'real-sdk-serialization-zero-network', scenarios: report }, null, 2));
});

describe('Provider cache and conversation isolation contracts', () => {
  it('covers every built-in provider card and public custom routes', async () => {
    const models = await Promise.all(scenarios.map(([, build]) => build()));
    expect(new Set(models.map(model => model.provider))).toEqual(new Set([
      ...CATALOG.map(entry => entry.id),
    ]));
  });
  it.each(scenarios.flatMap(([id, build]) => (['short', 'long'] as const)
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
      const p = createPiProvider(providerConfig);
      const params: CompletionParams = { model: model.id, sessionId, cacheRetention: retention, onRequestFailure() {},
        systemPrompt: 'Stable reference', messages: [{ role: 'user', content: [{ type: 'text', text: 'Read the reference' }] }],
      };
      if (method === 'complete') await p.complete(params).catch(() => undefined);
      else for await (const _event of p.stream(params)) { /* Expected transport stop. */ }
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
    if (model.api === 'openai-codex-responses') {
      expect(a.get('session-id')).toBe(b.get('session-id'));
      expect(a.get('session-id')).not.toBe('fixture-chat-a');
      expect(a.get('x-client-request-id')).not.toBe(b.get('x-client-request-id'));
    } else expect(a.has('session-id') || b.has('session-id')).toBe(false);
    if (model.provider === 'openrouter') {
      expect(a.get('x-session-id')).toBe('fixture-chat-a');
      expect(b.get('x-session-id')).toBe('fixture-chat-b');
    }
    if (['custom-chat', 'deepseek'].includes(id)) {
      expect(captures[0].payload.prompt_cache_key).toBeUndefined();
      expect(captures[0].payload.prompt_cache_retention).toBeUndefined();
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
