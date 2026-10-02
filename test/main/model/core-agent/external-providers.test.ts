import { describe, it, expect, vi } from 'vitest';
import {
  buildCustomOpenAICompatibleModel,
  buildDeepSeekModel,
  buildDoubaoModel,
  buildMoonshotModel,
  buildOrkasApiModel,
  createMoonshotProvider,
  repairDeepSeekPayload,
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

  it('keeps documented DeepSeek text aliases text-only without hiding vision variants', () => {
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
      }).input).toEqual(['text']);
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
        contextWindow: 1_048_576,
        maxTokens: 384_000,
      });
    }
  });

  it('enables image input for DeepSeek V4 Flash Vision', () => {
    const model = buildDeepSeekModel('deepseek-v4-flash-vision-exp');
    expect(model).toMatchObject({
      name: 'DeepSeek V4 Flash Vision',
      input: ['text', 'image'],
      contextWindow: 1_048_576,
      maxTokens: 384_000,
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
      contextWindow: 1_048_576, maxTokens: 384_000,
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
    expect(buildMoonshotModel('kimi-k3').contextWindow).toBe(1048576);
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
