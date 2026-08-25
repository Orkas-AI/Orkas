import { describe, it, expect } from 'vitest';
import {
  buildCustomOpenAICompatibleModel,
  buildDeepSeekModel,
  buildDoubaoModel,
  buildMoonshotModel,
  createMoonshotProvider,
} from '../../../../src/main/model/core-agent/external-providers';
import { modelInputImageLimit } from '../../../../src/main/model/provider_catalog';

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
