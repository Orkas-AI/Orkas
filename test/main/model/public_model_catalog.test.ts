import { describe, expect, it } from 'vitest';
import { PUBLIC_PROVIDER_MODELS } from '../../../src/main/model/public_model_catalog';

describe('public model catalog', () => {
  it('contains only public providers with unique model ids', () => {
    expect(Object.keys(PUBLIC_PROVIDER_MODELS).sort()).toEqual([
      'anthropic',
      'deepseek',
      'doubao',
      'google',
      'kimi-coding',
      'minimax-cn',
      'minimax-portal',
      'minimax-portal-cn',
      'moonshot',
      'openai',
      'openai-codex',
      'openrouter',
      'zai',
    ]);
    for (const models of Object.values(PUBLIC_PROVIDER_MODELS)) {
      const ids = models.map((model) => model.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.every(Boolean)).toBe(true);
    }
  });

  it('keeps OpenAI and OpenAI Codex on the same GPT-5.6 generation', () => {
    const expected = ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5'];
    expect(PUBLIC_PROVIDER_MODELS.openai?.map((model) => model.id)).toEqual(expected);
    expect(PUBLIC_PROVIDER_MODELS['openai-codex']?.map((model) => model.id)).toEqual(expected);
  });

  it('declares compatibility metadata for models newer than older runtimes', () => {
    for (const provider of ['openai', 'openai-codex'] as const) {
      for (const model of PUBLIC_PROVIDER_MODELS[provider]?.slice(0, 3) || []) {
        expect(model.template).toBe('gpt-5.5');
        expect(model.contextWindow).toBeGreaterThan(0);
        expect(model.maxTokens).toBe(128000);
      }
    }
    expect(PUBLIC_PROVIDER_MODELS['kimi-coding']?.[0]).toMatchObject({
      id: 'k3',
      template: 'kimi-for-coding',
      contextWindow: 1048576,
      maxTokens: 131072,
    });
  });
});
