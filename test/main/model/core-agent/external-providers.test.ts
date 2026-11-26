import { getBuiltinModel } from '@earendil-works/pi-ai/providers/all';
import type { Message } from '#core-agent';
import * as fs from 'node:fs';
import * as path from 'node:path';
const coreAgentMocks = vi.hoisted(() => ({createPiProvider:vi.fn(({provider}: {provider:string}) => ({id:provider,name:provider,complete:vi.fn(),stream:vi.fn(),validateAuth:vi.fn()}))}));
vi.mock('#core-agent',()=>({createPiProvider:coreAgentMocks.createPiProvider}));
import { describe, it, expect, vi } from 'vitest';
import {
  buildRuntimeMoonshotModel,
  createDeepSeekProvider,
  createDoubaoProvider,
  createCustomOpenAICompatibleProvider,
  buildConfiguredOpenAICompatibleModel,
  createConfiguredOpenAICompatibleProvider,
  repairOpenAICompatiblePayload,
  omitReservedOutputLimitForProvider,
  buildCustomOpenAICompatibleModel,
  buildCustomAnthropicModel,
  buildCustomResponsesModel,
  buildDeepSeekModel,
  buildDoubaoModel,
  buildMoonshotModel,
  buildOrkasApiModel,
  createMoonshotProvider,
  repairDeepSeekPayload,
  repairDeepSeekRequest,
} from '../../../../src/main/model/core-agent/external-providers';
import { isSelectableModel, modelInputImageLimit } from '../../../../src/main/model/provider_catalog';

describe('external-providers › custom OpenAI-compatible model', () => {
  const runtimeConfig = {
    baseUrl: 'https://gateway.example.test/v1',
    contextWindow: 262_144,
    maxTokens: 16_384,
  };

  it('defaults unknown models to image input and preserves explicit text-only overrides', () => {
    expect(buildCustomOpenAICompatibleModel('acme/reasoner-v2', runtimeConfig)).toMatchObject({
      reasoning: false,
      input: ['text', 'image'],
      contextWindow: 262_144,
      maxTokens: 16_384,
    });
    expect(buildCustomOpenAICompatibleModel('acme/text-only', {
      ...runtimeConfig,
      supportsVision: false,
    }).input).toEqual(['text']);
  });

  it('honors custom endpoint vision declarations independently of vendor-like model names', () => {
    for (const modelId of [
      'deepseek-chat',
      'deepseek-reasoner',
      'deepseek-v4-flash',
      'deepseek-v4-pro[1m]',
      'deepseek/deepseek-v4-flash-0731',
    ]) {
      expect(buildCustomOpenAICompatibleModel(modelId, {
        ...runtimeConfig,
        supportsVision: true,
      }).input).toEqual(['text', 'image']);
    }
    expect(buildCustomOpenAICompatibleModel(
      'deepseek-v4-flash-vision-exp',
      runtimeConfig,
    ).input).toEqual(['text', 'image']);
  });

  it('carries explicit reasoning controls into the custom adapter contract', () => {
    expect(buildCustomOpenAICompatibleModel('acme/reasoner-v2', {
      ...runtimeConfig,
      supportsReasoning: true,
      reasoningEffort: 'medium',
    })).toMatchObject({
      reasoning: true,
      compat: { supportsReasoningEffort: true },
    });
  });
});

describe('external-providers › custom Anthropic model', () => {
  it('uses the native Anthropic Messages API and preserves custom limits', () => {
    expect(buildCustomAnthropicModel('claude-3-7-sonnet', {
      baseUrl: 'https://gateway.example.test',
      contextWindow: 200_000,
      maxTokens: 8_192,
    })).toMatchObject({
      api: 'anthropic-messages',
      baseUrl: 'https://gateway.example.test',
      input: ['text', 'image'],
      contextWindow: 200_000,
      maxTokens: 8_192,
    });
  });
});

describe('external-providers › Orkas API model', () => {
  it('uses the public chat endpoint and preserves the selected public model id', () => {
    expect(buildOrkasApiModel('orkas-llm-1.5-pro')).toMatchObject({
      api: 'openai-completions',
      provider: 'orkas-api',
      id: 'orkas-llm-1.5-pro',
      baseUrl: 'https://orkas.ai/v1',
      input: ['text', 'image'],
    });
  });
});

describe('external-providers › DeepSeek model capabilities', () => {
  it('uses official V4 limits and keeps the text aliases text-only', () => {
    for (const modelId of ['deepseek-v4-pro', 'deepseek-v4-flash']) {
      expect(buildDeepSeekModel(modelId)).toMatchObject({
        id: modelId,
        input: ['text'],
        contextWindow: 1_000_000,
        maxTokens: 128_000,
      });
    }
  });

  it('enables image input for DeepSeek V4 Flash Vision', () => {
    const model = buildDeepSeekModel('deepseek-v4-flash-vision-exp');
    expect(model).toMatchObject({
      name: 'DeepSeek V4 Flash Vision',
      input: ['text', 'image'],
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    });
    expect(modelInputImageLimit('deepseek', 'deepseek-v4-flash-vision-exp', model)).toBe(20);
  });

  it('selects the canonical V4.1 Flash alias with vision and reasoning capabilities', () => {
    expect(isSelectableModel('deepseek', 'deepseek-flash')).toBe(true);
    const model = buildDeepSeekModel('deepseek-flash');
    expect(model).toMatchObject({
      id: 'deepseek-flash', name: 'DeepSeek V4.1 Flash',
      api: 'openai-completions', baseUrl: 'https://api.deepseek.com/v1',
      reasoning: true, input: ['text', 'image'],
      contextWindow: 1_000_000, maxTokens: 128_000,
    });
    expect(modelInputImageLimit('deepseek', 'deepseek-flash', model)).toBe(20);
  });

  it('defaults unknown direct DeepSeek models to vision while known aliases remain text-only', () => {
    expect(buildDeepSeekModel('deepseek-next').input).toEqual(['text', 'image']);
    expect(buildDeepSeekModel('deepseek-v4-flash').input).toEqual(['text']);
  });
});

describe('external-providers › buildMoonshotModel', () => {
  it('builds a Model for https://api.moonshot.cn/v1 using openai-completions', () => {
    const model = buildMoonshotModel('kimi-k2.5');
    expect(model.api).toBe('openai-completions');
    expect(model.baseUrl).toBe('https://api.moonshot.cn/v1');
    expect(model.id).toBe('kimi-k2.5');
    // pi-ai only uses provider for logs here; the type accepts arbitrary strings.
    expect(model.provider).toBe('moonshot');
  });

  it('uses known context windows and falls back to 131072 for unknown ids', () => {
    expect(buildMoonshotModel('kimi-k3').contextWindow).toBe(1000000);
    expect(buildMoonshotModel('kimi-k3').maxTokens).toBe(131072);
    expect(buildMoonshotModel('kimi-k2.7-code').contextWindow).toBe(262144);
    expect(buildMoonshotModel('kimi-k2.6').contextWindow).toBe(262144);
    expect(buildMoonshotModel('kimi-k2.5').contextWindow).toBe(262144);
    // Future Moonshot models fall back to the conservative 128k lower bound.
    // Legacy preview ids also use the fallback and remain usable until Moonshot retires them.
    expect(buildMoonshotModel('brand-new-model').contextWindow).toBe(131072);
    expect(buildMoonshotModel('kimi-k2-0905-preview').contextWindow).toBe(131072);
  });

  it('prefers curated labels and falls back to the id', () => {
    expect(buildMoonshotModel('kimi-k3').name).toBe('Kimi K3');
    expect(buildMoonshotModel('kimi-k2.7-code').name).toBe('Kimi K2.7 Code');
    // Uncurated ids fall back directly without throwing.
    expect(buildMoonshotModel('random-id').name).toBe('random-id');
  });

  it('uses K3 reasoning compatibility when the bundled runtime lacks native metadata', () => {
    const model = buildMoonshotModel('kimi-k3');
    expect(model.reasoning).toBe(true);
    expect(model.compat).toMatchObject({
      supportsDeveloperRole: false,
      thinkingFormat: 'deepseek',
      requiresReasoningContentOnAssistantMessages: true,
    });
  });
});

describe('external-providers › buildDoubaoModel', () => {
  it('uses the current Seed 2.0 Lite limits', () => {
    expect(buildDoubaoModel('doubao-seed-2-0-lite-260428')).toMatchObject({
      contextWindow: 262144,
      maxTokens: 32768,
    });
  });
});

describe('external-providers › createMoonshotProvider', () => {
  it('throws without apiKey before pi-ai can swallow the auth failure', async () => {
    await expect(createMoonshotProvider({ apiKey: '', modelId: 'kimi-k2.5' }))
      .rejects.toThrow(/apiKey required/);
  });

  it('throws without modelId so callers must choose explicitly', async () => {
    await expect(createMoonshotProvider({ apiKey: 'sk-xxx', modelId: '' }))
      .rejects.toThrow(/modelId required/);
  });

  it('returns an LLMProvider with id and the expected methods', async () => {
    const p = await createMoonshotProvider({ apiKey: 'sk-xxx', modelId: 'kimi-k2.5' });
    expect(p.id).toBe('moonshot');
    expect(typeof p.complete).toBe('function');
    expect(typeof p.stream).toBe('function');
    expect(typeof p.validateAuth).toBe('function');
  });
});

describe('external-providers › DeepSeek request compatibility', () => {
  it.each(['complete', 'stream'] as const)('omits unsupported cache controls from DeepSeek %s requests', async mode => {
    const { createPiProvider } = await vi.importActual<typeof import('#core-agent')>('#core-agent');
    for (const modelId of ['deepseek-flash', 'deepseek-v4-flash']) {
      for (const cacheRetention of ['long', 'short', 'none'] as const) {
        let wire: Record<string, unknown> | undefined;
        const provider = createPiProvider({
          provider: 'deepseek', apiKey: 'test',
          customModel: buildDeepSeekModel(modelId),
          onPayload: (payload, model, metadata) => {
            wire = JSON.parse(JSON.stringify(repairDeepSeekPayload(payload)));
            throw new Error('captured before network');
          },
        });
        const request = {
          model: modelId, sessionId: 'cache-contract', cacheRetention,
          messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hello' }] }],
        };
        if (mode === 'complete') {
          await expect(provider.complete(request)).rejects.toThrow('captured before network');
        } else {
          const events = [];
          for await (const event of provider.stream(request)) events.push(event);
          expect(events.some(event => event.type === 'error')).toBe(true);
        }
        expect(wire).toMatchObject({ model: modelId, stream: true });
        expect(wire).not.toHaveProperty('prompt_cache_key');
        expect(wire).not.toHaveProperty('prompt_cache_retention');
        expect(wire).not.toHaveProperty('prompt_cache_options');
      }
    }
  });
});


  it('preserves explicit effort across mixed history while repairing orphan receipts', () => {
    const plainPayload = {
      thinking: { type: 'enabled' },
      reasoning_effort: 'low',
      messages: [
        { role: 'assistant', content: 'plain assistant message' },
        { role: 'tool', tool_call_id: 'lost_call', content: 'tool output' },
      ],
    };
    const mixedPayload = {
      thinking: { type: 'enabled' },
      reasoning_effort: 'medium',
      messages: [
        { role: 'assistant', content: 'reasoned answer', reasoning_content: 'reasoning' },
        { role: 'assistant', content: 'plain fallback answer' },
        { role: 'user', content: 'continue' },
      ],
    };

    const repaired = repairDeepSeekPayload(plainPayload) as Record<string, unknown>;
    const mixed = repairDeepSeekPayload(mixedPayload) as Record<string, unknown>;

    expect(repaired.reasoning_effort).toBe('low');
    expect(repaired.thinking).toEqual({ type: 'enabled' });
    expect((repaired.messages as Array<Record<string, unknown>>)[1]).toMatchObject({
      role: 'user',
      content: expect.stringContaining('tool output'),
    });
    expect(mixed.reasoning_effort).toBe('medium');
    expect(mixed.thinking).toEqual({ type: 'enabled' });
  });

describe('DeepSeek host reservation wire boundary',()=>{
 it('drops only a marked model-default reservation, preserving explicit and auxiliary caps',()=>{
  const request={max_tokens:128000,messages:[{role:'user',content:'Hello'}]};
  expect(repairDeepSeekRequest(request,{maxTokens:128000},{outputLimitSource:'model_default'})).not.toHaveProperty('max_tokens');
  expect(repairDeepSeekRequest(request,{maxTokens:128000})).toHaveProperty('max_tokens',128000);
  expect(repairDeepSeekRequest({...request,max_tokens:512},{maxTokens:128000},{outputLimitSource:'model_default'})).toHaveProperty('max_tokens',512);
  expect(request.max_tokens).toBe(128000);
 });
});

describe('external-providers › custom OpenAI-compatible model', () => {
  const runtimeConfig = {
    baseUrl: 'https://gateway.example.test/v1',
    contextWindow: 262_144,
    maxTokens: 16_384,
  };

  it.each(['complete', 'stream'] as const)('omits unsupported long-cache extensions from custom %s requests', async (mode) => {
    const { createPiProvider } = await vi.importActual<typeof import('#core-agent')>('#core-agent');
    for (const cacheRetention of ['long', 'short', 'none'] as const) {
      let wire: Record<string, unknown> | undefined;
      const provider = createPiProvider({
        provider: 'custom', apiKey: 'test',
        customModel: buildCustomOpenAICompatibleModel('custom-model', runtimeConfig),
        onPayload: payload => {
          wire = JSON.parse(JSON.stringify(payload));
          throw new Error('captured before network');
        },
      });
      const request = {
        model: 'custom-model', sessionId: 'cache-contract', cacheRetention,
        messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hello' }] }],
      };
      if (mode === 'complete') {
        await expect(provider.complete(request)).rejects.toThrow('captured before network');
      } else {
        const events = [];
        for await (const event of provider.stream(request)) events.push(event);
        expect(events.some(event => event.type === 'error')).toBe(true);
      }
      expect(wire).toMatchObject({ model: 'custom-model', stream: true });
      expect(wire).not.toHaveProperty('prompt_cache_retention');
      expect(wire).not.toHaveProperty('prompt_cache_key');
      expect(wire).not.toHaveProperty('prompt_cache_options');
    }
  });

  it.each(['complete', 'stream'] as const)('preserves a bodyless HTTP 402 status through the real custom SDK %s path', async mode => {
    const { createPiProvider } = await vi.importActual<typeof import('#core-agent')>('#core-agent');
    const requestFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 402 }));
    try {
      const provider = createPiProvider({
        provider: 'custom', apiKey: 'synthetic',
        customModel: buildCustomOpenAICompatibleModel('custom-model', runtimeConfig),
      });
      const request = {
        model: 'custom-model',
        messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hello' }] }],
      };
      if (mode === 'complete') {
        await expect(provider.complete(request)).rejects.toMatchObject({ statusCode: 402 });
      } else {
        const events = [];
        for await (const event of provider.stream(request)) events.push(event);
        expect(events).toContainEqual(expect.objectContaining({
          type: 'error', error: expect.objectContaining({ statusCode: 402 }),
        }));
      }
      expect(requestFetch).toHaveBeenCalledTimes(1);
    } finally {
      requestFetch.mockRestore();
    }
  });

  it('preserves the endpoint and sizing metadata used by runtime planning', () => {
    expect(buildCustomOpenAICompatibleModel('acme/reasoner-v2', runtimeConfig)).toMatchObject({
      id: 'acme/reasoner-v2',
      api: 'openai-completions',
      provider: 'custom',
      baseUrl: 'https://gateway.example.test/v1',
      input: ['text', 'image'],
      contextWindow: 262_144,
      maxTokens: 16_384,
    });
  });

  it('enables explicit reasoning only for a curated relay profile', () => {
    expect(buildCustomOpenAICompatibleModel('gpt-5.6-luna', {
      ...runtimeConfig,
      reasoningEffort: 'medium',
    })).toMatchObject({
      reasoning: true,
      compat: { supportsReasoningEffort: true },
    });
    expect(buildCustomOpenAICompatibleModel('acme/plain-chat', runtimeConfig)).toMatchObject({
      reasoning: false,
      input: ['text', 'image'],
      compat: { supportsReasoningEffort: false },
    });
  });

  it('retains provider-default reasoning and vision without sending an effort', () => {
    expect(buildCustomOpenAICompatibleModel('gpt-5.6-luna', {
      ...runtimeConfig,
      supportsReasoning: true,
      supportsVision: true,
    })).toMatchObject({
      reasoning: true,
      input: ['text', 'image'],
      compat: { supportsReasoningEffort: false },
    });
  });

  it('preserves custom gateway capabilities regardless of namesake official models', () => {
    // A custom gateway may remap a model ID or handle image input itself.
    // Its configured capabilities, not a namesake model's public card, own input.
    for (const modelId of [
      'glm-5.3', 'z-ai/GLM-5.3', 'z-ai/glm-5.3:free',
      'deepseek-chat', 'deepseek-reasoner', 'deepseek-v4-flash',
      'deepseek-v4-pro[1m]', 'deepseek/deepseek-v4-flash-0731',
      'deepseek-v4-flash-vision-exp', 'acme/text-only',
    ]) {
      for (const supportsVision of [undefined, true]) {
        const model = buildCustomOpenAICompatibleModel(modelId, {
          ...runtimeConfig,
          supportsVision,
        });
        expect(model?.input).toEqual(['text', 'image']);
        expect(modelInputImageLimit('custom', modelId, model)).toBe(20);
      }
      const textOnly = buildCustomOpenAICompatibleModel(modelId, {
        ...runtimeConfig,
        supportsVision: false,
      });
      expect(textOnly.input).toEqual(['text']);
      expect(modelInputImageLimit('custom', modelId, textOnly)).toBe(0);
    }
  });

  it('constructs the provider only when all required runtime fields are present', async () => {
    await expect(createCustomOpenAICompatibleProvider({
      apiKey: '',
      modelId: 'acme/reasoner-v2',
      ...runtimeConfig,
    })).rejects.toThrow(/apiKey required/);

    const provider = await createCustomOpenAICompatibleProvider({
      apiKey: 'sk-custom-test',
      modelId: 'acme/reasoner-v2',
      ...runtimeConfig,
    });
    expect(provider.id).toBe('custom');
    expect(coreAgentMocks.createPiProvider).toHaveBeenLastCalledWith(
      expect.objectContaining({ normalizeLiteralLeadingThinkText: true }),
    );
  });

  it('rejects a legacy API key that cannot form an Authorization header before provider construction', async () => {
    const callsBefore = coreAgentMocks.createPiProvider.mock.calls.length;

    await expect(createCustomOpenAICompatibleProvider({
      apiKey: 'щ-custom-key',
      modelId: 'acme/reasoner-v2',
      ...runtimeConfig,
    })).rejects.toMatchObject({ code: 'CUSTOM_API_KEY_INVALID' });

    expect(coreAgentMocks.createPiProvider.mock.calls).toHaveLength(callsBefore);
  });
});


describe('external-providers › OpenAI-compatible payload hooks', () => {
  it('keeps explicit DeepSeek thinking enabled for a fresh or reasoning-consistent history', () => {
    const fresh = repairDeepSeekPayload({
      thinking: { type: 'enabled' },
      reasoning_effort: 'medium',
      messages: [{ role: 'user', content: 'start' }],
    }) as Record<string, unknown>;
    const consistent = repairDeepSeekPayload({
      thinking: { type: 'enabled' },
      reasoning_effort: 'medium',
      messages: [
        { role: 'assistant', content: 'earlier answer', reasoning_content: 'earlier reasoning' },
        { role: 'user', content: 'continue' },
      ],
    }) as Record<string, unknown>;

    expect(fresh).toMatchObject({
      thinking: { type: 'enabled' },
      reasoning_effort: 'medium',
    });
    expect(consistent).toMatchObject({
      thinking: { type: 'enabled' },
      reasoning_effort: 'medium',
    });
  });

  it('repairs orphan tool messages for direct OpenAI-compatible providers', () => {
    const payload = {
      model: 'kimi-k2.7-code',
      messages: [
        { role: 'user', content: 'continue' },
        { role: 'tool', tool_call_id: 'lost_call', content: 'tool output' },
      ],
    };

    const repaired = repairOpenAICompatiblePayload(payload) as typeof payload;

    expect(repaired).not.toBe(payload);
    expect(repaired.messages[1]).toMatchObject({
      role: 'user',
      content: expect.stringContaining('tool output'),
    });
  });

  it('retains the DeepSeek V4 window and host output reservation across SDK catalog changes', async () => {
    const { getBuiltinModel } = await import('@earendil-works/pi-ai/providers/all');
    expect(getBuiltinModel('deepseek', 'deepseek-v4-pro')?.contextWindow).toBe(1_000_000);
    expect(getBuiltinModel('deepseek', 'deepseek-flash')?.contextWindow).toBe(1_000_000);
    for (const modelId of ['deepseek-v4-pro', 'deepseek-v4-flash']) {
      expect(buildDeepSeekModel( modelId)).toMatchObject({
        id: modelId,
        reasoning: true,
        input: ['text'],
        contextWindow: 1_000_000,
        // 128K is what the host reserves for output, not DeepSeek's 384K ceiling.
        maxTokens: 128_000,
      });
    }
  });

  // A DeepSeek main turn used to ask for the full 384K ceiling and reserve it
  // from the window, so a third of 1M was idle. Main turns now leave the limit
  // to DeepSeek's mode default; the reservation stays host-side. Explicit
  // caller limits and the compactor's small caps are untouched.
  // OpenAI-hosted main turns are handled the same way as DeepSeek's: the
  // catalog reservation sizes input, the wire carries no output limit.
  it.each(['openai', 'openai-codex'])('leaves the output limit to %s on main turns and to the caller elsewhere', (providerId) => {
    const seen: unknown[] = [];
    const inner = (params: unknown) => { seen.push(params); return params; };
    const hook = omitReservedOutputLimitForProvider(providerId, inner);
    const model = { maxTokens: 64_000 };
    const mainTurn = hook({ input: [], max_output_tokens: 64_000 }, model, { outputLimitSource: 'model_default' }) as Record<string, unknown>;
    const explicit = hook({ input: [], max_output_tokens: 32_000 }, model, { outputLimitSource: 'model_default' }) as Record<string, unknown>;
    const untagged = hook({ input: [], max_output_tokens: 64_000 }, model, undefined) as Record<string, unknown>;
    expect(mainTurn.max_output_tokens).toBeUndefined();
    expect(explicit.max_output_tokens).toBe(32_000);
    expect(untagged.max_output_tokens).toBe(64_000);
    // The inner hook (native search repair) still runs on the stripped payload.
    expect(seen).toHaveLength(3);
    // Other providers get the inner hook back unchanged.
    expect(omitReservedOutputLimitForProvider('anthropic', inner)).toBe(inner);
  });

  it('drops the reserved output limit from DeepSeek main turns and keeps every other limit', () => {
    const model = buildDeepSeekModel( 'deepseek-v4-pro');
    const mainTurn = repairDeepSeekRequest(
      { model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'ping' }], max_tokens: 128_000 },
      model,
      { outputLimitSource: 'model_default' },
    ) as Record<string, unknown>;
    const explicit = repairDeepSeekRequest(
      { model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'full report' }], max_tokens: 128_000 },
      model,
      undefined,
    ) as Record<string, unknown>;
    const auxiliary = repairDeepSeekRequest(
      { model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'summarize' }], max_tokens: 2_048 },
      model,
      { outputLimitSource: 'provider_default' },
    ) as Record<string, unknown>;
    const otherValue = repairDeepSeekRequest(
      { model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'ping' }], max_tokens: 64_000 },
      model,
      { outputLimitSource: 'model_default' },
    ) as Record<string, unknown>;

    expect(mainTurn.max_tokens).toBeUndefined();
    expect(explicit.max_tokens).toBe(128_000);
    expect(auxiliary.max_tokens).toBe(2_048);
    expect(otherValue.max_tokens).toBe(64_000);
  });

  it('enables official image input for DeepSeek V4 Flash Vision', () => {
    const model = buildDeepSeekModel( 'deepseek-v4-flash-vision-exp');
    expect(model).toMatchObject({
      id: 'deepseek-v4-flash-vision-exp',
      name: 'DeepSeek V4 Flash Vision',
      reasoning: true,
      input: ['text', 'image'],
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    });
    expect(modelInputImageLimit('deepseek', 'deepseek-v4-flash-vision-exp', model)).toBe(20);
  });

  it('selects V4.1 Flash and sends its canonical id with vision and reasoning capabilities', async () => {
    // DeepSeek's 2026-09-10 release uses deepseek-flash, not a versioned API id.
    expect(isSelectableModel('deepseek', 'deepseek-flash')).toBe(true);
    const model = buildDeepSeekModel( 'deepseek-flash');
    expect(model).toMatchObject({
      id: 'deepseek-flash',
      name: 'DeepSeek V4.1 Flash',
      api: 'openai-completions',
      baseUrl: 'https://api.deepseek.com/v1',
      reasoning: true,
      input: ['text', 'image'],
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    });
    expect(modelInputImageLimit('deepseek', 'deepseek-flash', model)).toBe(20);
    await createDeepSeekProvider({ apiKey: 'sk-test', modelId: 'deepseek-flash', userCacheKey: 'opaque-user-scope' });
    expect(coreAgentMocks.createPiProvider).toHaveBeenLastCalledWith(expect.objectContaining({
      provider: 'deepseek',
      customModel: model,
      userCacheKey: 'opaque-user-scope',
    }));
    expect(coreAgentMocks.createPiProvider.mock.lastCall?.[0]).not.toHaveProperty('defaultReasoning');
  });
});

describe('external-providers › Doubao Pro upgrade', () => {
  it('sends the September Pro model with a 1M window and preserves Turbo sizing', async () => {
    const modelId = 'doubao-seed-2-1-pro-260915';
    coreAgentMocks.createPiProvider.mockClear();
    await createDoubaoProvider({ apiKey: 'test-key', modelId, userCacheKey: 'opaque-user-scope' });
    expect(coreAgentMocks.createPiProvider).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'doubao',
      userCacheKey: 'opaque-user-scope',
      customModel: expect.objectContaining({
        id: modelId, contextWindow: 1_000_000, maxTokens: 32768,
        api: 'openai-completions', reasoning: true, input: ['text', 'image'],
      }),
    }));
    expect(buildDoubaoModel( 'doubao-seed-2-1-turbo-260628'))
      .toMatchObject({ contextWindow: 256000, maxTokens: 32768 });
  });
});


describe('native Moonshot metadata',()=>{
  it('loads K3 protocol metadata from the upgraded pi-ai catalog', async () => {
    const model = await buildRuntimeMoonshotModel('kimi-k3');
    expect(model).toMatchObject({
      id: 'kimi-k3',
      provider: 'moonshot',
      api: 'openai-completions',
      reasoning: true,
      contextWindow: 1_000_000,
      maxTokens: 131_072,
      compat: {
        requiresReasoningContentOnAssistantMessages: true,
        supportsMidConvoSystemMessages: true,
        supportsMidConvoToolAdditions: true,
      },
      thinkingLevelMap: { max: 'max' },
    });
  });

  it('preserves native protocol input when Server capability fields are omitted', () => {
    const nativeTextModel = {
      id: 'kimi-k2.7-code',
      name: 'Kimi K2.7 Code',
      api: 'openai-completions',
      provider: 'moonshotai-cn',
      baseUrl: 'https://api.moonshot.cn/v1',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 262144,
      maxTokens: 32768,
    } as any;
    expect(buildMoonshotModel('kimi-k2.7-code', nativeTextModel).input).toEqual(['text']);
  });


});

describe('external-providers › Server-configured OpenAI-compatible provider', () => {
  it('uses one endpoint with per-model text and image capabilities', async () => {
    const users = await import('../../../../src/main/features/users');
    const paths = await import('../../../../src/main/paths');
    const storage = await import('../../../../src/main/storage');
    const uid = 'externalconfiguredprovider';
    users.activateUser(uid);
    const file = paths.userRemoteConfigFile(uid);
    storage.writeJsonSync(file, {
      version: 1,
      active: {
        immediate: {
          model_catalog: {
            providers: {
              acme: [
                {
                  id: 'acme-vision',
                  name: 'Acme Vision',
                  contextWindow: 262_144,
                  maxTokens: 16_384,
                  supportsVision: true,
                  maxInputImages: 12,
                },
                { id: 'acme-default', name: 'Acme Default' },
                { id: 'acme-text', name: 'Acme Text', supportsVision: false },
                {
                  id: 'acme-explicit-text',
                  name: 'Acme Explicit Text',
                  supportsVision: false,
                  maxInputImages: 0,
                },
                { id: 'acme-legacy-text', name: 'Acme Legacy Text', maxInputImages: 0 },
                { id: 'glm-5.3', name: 'GLM-5.3', supportsVision: true, maxInputImages: 12 },
              ],
            },
            openai_compatible_providers: {
              acme: { label: 'Acme AI', baseUrl: 'https://api.acme.example/v1' },
            },
          },
        },
      },
    });
    try {
      const vision = buildConfiguredOpenAICompatibleModel('acme', 'acme-vision');
      const defaultVision = buildConfiguredOpenAICompatibleModel('acme', 'acme-default');
      const textOnly = buildConfiguredOpenAICompatibleModel('acme', 'acme-text');
      const explicitTextOnly = buildConfiguredOpenAICompatibleModel('acme', 'acme-explicit-text');
      const legacyTextOnly = buildConfiguredOpenAICompatibleModel('acme', 'acme-legacy-text');
      const glmGateway = buildConfiguredOpenAICompatibleModel('acme', 'glm-5.3');
      expect(vision).toMatchObject({
        id: 'acme-vision',
        name: 'Acme Vision',
        provider: 'acme',
        api: 'openai-completions',
        baseUrl: 'https://api.acme.example/v1',
        input: ['text', 'image'],
        contextWindow: 262_144,
        maxTokens: 16_384,
      });
      expect(defaultVision).toMatchObject({ input: ['text', 'image'] });
      expect(textOnly).toMatchObject({ input: ['text'] });
      expect(explicitTextOnly).toMatchObject({ input: ['text'] });
      expect(legacyTextOnly).toMatchObject({ input: ['text'] });
      expect(modelInputImageLimit('acme', 'acme-vision', vision)).toBe(12);
      expect(modelInputImageLimit('acme', 'acme-default', defaultVision)).toBe(20);
      expect(modelInputImageLimit('acme', 'acme-text', textOnly)).toBe(0);
      expect(modelInputImageLimit('acme', 'acme-explicit-text', explicitTextOnly)).toBe(0);
      expect(modelInputImageLimit('acme', 'acme-legacy-text', legacyTextOnly)).toBe(0);
      expect(glmGateway?.input).toEqual(['text', 'image']);
      expect(modelInputImageLimit('acme', 'glm-5.3', glmGateway)).toBe(12);
      expect(buildConfiguredOpenAICompatibleModel('acme', 'missing')).toBeNull();

      coreAgentMocks.createPiProvider.mockClear();
      await createConfiguredOpenAICompatibleProvider({
        providerId: 'acme',
        apiKey: 'sk-acme-valid-xxxxxxxx',
        modelId: 'acme-vision',
        userCacheKey: 'opaque-user-scope',
      });
      expect(coreAgentMocks.createPiProvider).toHaveBeenCalledWith(expect.objectContaining({
        provider: 'acme',
        apiKey: 'sk-acme-valid-xxxxxxxx',
        userCacheKey: 'opaque-user-scope',
        customModel: expect.objectContaining({ id: 'acme-vision', input: ['text', 'image'] }),
        onPayload: repairOpenAICompatiblePayload,
      }));
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });
});


describe('public discovered catalog contracts',()=>{
  it('applies Server limits to direct external providers before local fallbacks', async () => {
    const users = await import('../../../../src/main/features/users');
    const paths = await import('../../../../src/main/paths');
    const storage = await import('../../../../src/main/storage');
    const uid = 'externalproviderlimits';
    users.activateUser(uid);
    const file = paths.userRemoteConfigFile(uid);
    storage.writeJsonSync(file, {
      version: 1,
      active: {
        immediate: {
          model_catalog: {
            providers: {
              moonshot: [{
                id: 'kimi-k3',
                name: 'Kimi K3',
                contextWindow: 1_048_576,
                maxTokens: 131_072,
              }],
              deepseek: [{
                id: 'deepseek-next',
                name: 'DeepSeek Next',
                contextWindow: 524_288,
                maxTokens: 65_536,
                maxInputImages: 8,
              }],
              doubao: [{
                id: 'doubao-next',
                name: 'Doubao Next',
                contextWindow: 393_216,
                maxTokens: 49_152,
              }],
            },
          },
        },
      },
    });

    try {
      expect(buildMoonshotModel( 'kimi-k3')).toMatchObject({
        name: 'Kimi K3',
        contextWindow: 1_048_576,
        maxTokens: 131_072,
      });
      const deepseekNext = buildDeepSeekModel( 'deepseek-next');
      expect(deepseekNext).toMatchObject({
        name: 'DeepSeek Next',
        input: ['text', 'image'],
        contextWindow: 524_288,
        maxTokens: 65_536,
      });
      expect(isSelectableModel('deepseek', 'deepseek-next')).toBe(true);
      expect(modelInputImageLimit('deepseek', 'deepseek-next', deepseekNext)).toBe(8);
      // A partial Server catalog must not restore the old binary-meg token
      // window through the adapter's fallback table. Unknown ids stay conservative.
      for (const modelId of ['deepseek-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp', 'deepseek-v4-flash']) {
        expect(buildDeepSeekModel( modelId)).toMatchObject({
          contextWindow: 1_000_000,
          maxTokens: 128_000,
        });
      }
      expect(buildDeepSeekModel( 'deepseek-unknown')?.contextWindow).toBe(131_072);
      expect(buildDoubaoModel( 'doubao-seed-2-1-pro-260915')).toMatchObject({
        contextWindow: 1_000_000,
        maxTokens: 32768,
      });
      expect(buildDoubaoModel( 'doubao-next')).toMatchObject({
        name: 'Doubao Next',
        contextWindow: 393_216,
        maxTokens: 49_152,
      });
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });

  it('applies explicit Server vision declarations across direct provider adapters', async () => {
    const users = await import('../../../../src/main/features/users');
    const paths = await import('../../../../src/main/paths');
    const storage = await import('../../../../src/main/storage');
    const uid = 'externalprovidervision';
    users.activateUser(uid);
    const file = paths.userRemoteConfigFile(uid);
    storage.writeJsonSync(file, {
      version: 1,
      active: {
        immediate: {
          model_catalog: {
            providers: {
              moonshot: [{ id: 'kimi-k3', name: 'Kimi K3', supportsVision: false }],
              doubao: [{ id: 'doubao-next', name: 'Doubao Next', maxInputImages: 0 }],
              deepseek: [
                { id: 'deepseek-next', name: 'DeepSeek Next' },
                { id: 'deepseek-next-text', name: 'DeepSeek Next Text', supportsVision: false },
                {
                  id: 'deepseek-v4-flash',
                  name: 'DeepSeek V4 Flash',
                  supportsVision: true,
                },
              ],
            },
          },
        },
      },
    });
    try {
      expect(buildMoonshotModel( 'kimi-k3')?.input).toEqual(['text']);
      expect(buildDoubaoModel( 'doubao-next')?.input).toEqual(['text']);
      expect(buildDeepSeekModel( 'deepseek-next')?.input)
        .toEqual(['text', 'image']);
      expect(buildDeepSeekModel( 'deepseek-next-text')?.input)
        .toEqual(['text']);
      // The official known text-only alias remains authoritative even when a
      // malformed rollout tries to enable vision for it.
      expect(buildDeepSeekModel( 'deepseek-v4-flash')?.input)
        .toEqual(['text']);
    } finally {
      fs.rmSync(path.dirname(file), { recursive: true, force: true });
    }
  });
});

describe('dynamic tool declarations on actual model routes', () => {
  const options = { baseUrl: 'https://fixture.invalid/v1', contextWindow: 128_000, maxTokens: 4096 };
  const routes = [
    ['anthropic', 'claude-fable-5-2', 'tool_addition'],
    ['anthropic', 'claude-haiku-5-5', 'tool_addition'],
    ['anthropic', 'claude-opus-5-5', 'tool_addition'],
    ['anthropic', 'claude-sonnet-5-5', 'tool_addition'],
    ['openai', 'gpt-6-luna', 'additional_tools'],
    ['openai', 'gpt-6.2-sol', 'additional_tools'],
    ['openai-codex', 'gpt-6-luna', 'additional_tools'],
    ['moonshot', 'kimi-k3', 'system_tools'],
    ['kimi-coding', 'k3', 'system_tools'],
    ['anthropic', 'claude-sonnet-4-6', 'top_level'],
    ['anthropic', 'claude-sonnet-5', 'top_level'],
    ['openai', 'gpt-5.5', 'top_level'],
    ['moonshot', 'kimi-k2.7-code', 'top_level'],
    ['google', 'gemini-4-argon', 'top_level'],
    ['google', 'gemini-3.8-flash', 'top_level'],
    ['deepseek', 'deepseek-v4.1-flash', 'top_level'],
    ['zai', 'glm-5.3', 'top_level'],
    ['minimax', 'MiniMax-M3.1-Flash', 'top_level'],
    ['doubao', 'doubao-2.1-pro', 'top_level'],
    ['openrouter', 'anthropic/claude-fable-5.2', 'top_level'],
    ['openrouter', 'openai/gpt-6-luna', 'top_level'],
    ['openrouter', 'moonshotai/kimi-k3', 'top_level'],
    ['custom', 'anthropic', 'top_level'],
    ['custom', 'responses', 'top_level'],
    ['custom', 'openai', 'top_level'],
  ] as const;

  it.each(routes)('%s / %s advertises the authorized tool via %s', async (route, modelId, expected) => {
    const { createPiProvider } = await vi.importActual<typeof import('#core-agent')>('#core-agent');
    const model = await (async () => {
      switch (route) {
        case 'moonshot': return buildRuntimeMoonshotModel(modelId);
        case 'deepseek': return buildDeepSeekModel(modelId);
        case 'doubao': return buildDoubaoModel(modelId);
        case 'custom': {
          const id = 'claude-haiku-5-5';
          if (modelId === 'anthropic') return buildCustomAnthropicModel(id, options);
          if (modelId === 'responses') return buildCustomResponsesModel(id, options);
          return buildCustomOpenAICompatibleModel(id, options);
        }
        default:
          return buildConfiguredOpenAICompatibleModel(route, modelId) ?? getBuiltinModel(route as never, modelId as never);
      }
    })();
    expect(model).toBeTruthy();
    if (!model) throw new Error('Missing model route fixture');
    const token = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture' } })).toString('base64url');
    let payload: any;
    const provider = createPiProvider({
      provider: route, customModel: model,
      apiKey: route === 'openai-codex' ? `fixture.${token}.fixture` : 'fixture-auth',
      onPayload(value) { payload = value; throw new Error('tool declaration captured before sending'); },
    });
    const schema = (name: string) => ({ name, description: name, inputSchema: { type: 'object' } });
    const first = schema('first_tool');
    const last = schema('last_tool');
    const added = schema('connector_lookup');
    const start: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'Start the task' }] }];
    const steer: Message = { role: 'user', content: [{ type: 'text', text: 'Use the selected connector' }] };
    const withGrant: Message = { ...steer, toolsAddedAfter: [added.name, 'no_longer_authorized', added.name] };
    const capture = async (messages: Message[], tools: typeof first[]) => {
      payload = undefined;
      await expect(provider.complete({
        model: model.id, systemPrompt: 'Stable instructions', reasoning: 'low',
        messages, tools, onRequestFailure() {},
      })).rejects.toThrow('tool declaration captured before sending');
      return JSON.parse(JSON.stringify(payload));
    };
    const granted = await capture([...start, withGrant], [first, added, last]);
    const wire = JSON.stringify(granted);
    expect(wire).toContain(added.name);
    expect(wire).not.toContain('no_longer_authorized');
    if (expected === 'top_level') {
      expect(granted).toEqual(await capture([...start, steer], [first, added, last]));
    } else {
      const before = await capture(start, [first, last]);
      expect(granted.tools).toEqual(before.tools);
      expect(granted.system).toEqual(before.system);
      expect(granted.instructions).toEqual(before.instructions);
      if (expected === 'additional_tools') {
        expect(granted.input[0]).toEqual(before.input[0]);
        const deltas = granted.input.filter((row: any) =>
          row.type === 'additional_tools' && row.tools.some((tool: any) => tool.name === added.name));
        expect(deltas).toEqual([expect.objectContaining({ tools: [expect.objectContaining({ name: added.name })] })]);
      } else if (expected === 'tool_addition') {
        const deltas = granted.messages.flatMap((row: any) => row.content).filter((part: any) => part?.type === 'tool_addition');
        expect(deltas).toEqual([expect.objectContaining({
          tool: expect.objectContaining({ definition: expect.objectContaining({ name: added.name }) }),
        })]);
      } else {
        const deltas = granted.messages.filter((row: any) => row.role === 'system' && row.tools);
        expect(deltas).toEqual([expect.objectContaining({
          tools: [expect.objectContaining({ function: expect.objectContaining({ name: added.name }) })],
        })]);
      }
      expect(wire.indexOf(added.name)).toBeGreaterThan(wire.indexOf('Use the selected connector'));
    }
    const revoked = await capture([...start, withGrant], [first, last]);
    expect(revoked).toEqual(await capture([...start, steer], [first, last]));
    const toolsOff = await capture([...start, withGrant], []);
    expect(toolsOff).toEqual(await capture([...start, steer], []));
  });
});
