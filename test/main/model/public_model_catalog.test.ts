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

  it('keeps every variant in the curated current GPT generations', () => {
    const expected = ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'];
    expect(PUBLIC_PROVIDER_MODELS.openai?.map((model) => model.id)).toEqual(expected);
    expect(PUBLIC_PROVIDER_MODELS['openai-codex']?.map((model) => model.id)).toEqual(expected);
    expect(PUBLIC_PROVIDER_MODELS.openai?.every((model) => model.maxInputImages === 20)).toBe(true);
    expect(PUBLIC_PROVIDER_MODELS['openai-codex']?.every((model) => model.maxInputImages === 20)).toBe(true);
  });

  it('tracks recent Anthropic models and the Gemini 3.1 Pro exception', () => {
    expect(PUBLIC_PROVIDER_MODELS.anthropic?.map((model) => model.id)).toEqual([
      'claude-opus-5',
      'claude-fable-5-1',
      'claude-fable-5',
      'claude-sonnet-5',
    ]);
    expect(PUBLIC_PROVIDER_MODELS.google?.map((model) => model.id)).toEqual([
      'gemini-3.8-flash',
      'gemini-3.7-flash',
      'gemini-3.1-pro-preview',
      'gemini-3.5-flash-lite',
    ]);
  });

  it('publishes DeepSeek V4.1 Flash and the V4 models with their official limits', () => {
    expect(PUBLIC_PROVIDER_MODELS.deepseek?.map((model) => model.id)).toEqual([
      'deepseek-flash',
      'deepseek-v4-pro',
      'deepseek-v4-flash-vision-exp',
      'deepseek-v4-flash',
    ]);
    expect(PUBLIC_PROVIDER_MODELS.deepseek?.[0]).toMatchObject({
      name: 'DeepSeek V4.1 Flash',
      contextWindow: 1_048_576,
      maxTokens: 384_000,
      supportsVision: true,
      maxInputImages: 600,
    });
    expect(PUBLIC_PROVIDER_MODELS.deepseek?.[2]).toMatchObject({
      name: 'DeepSeek V4 Flash Vision',
      contextWindow: 1_048_576,
      maxTokens: 384_000,
      supportsVision: true,
      maxInputImages: 600,
    });
    expect(PUBLIC_PROVIDER_MODELS.deepseek?.[1]).toMatchObject({ supportsVision: false });
    expect(PUBLIC_PROVIDER_MODELS.deepseek?.[3]).toMatchObject({ supportsVision: false });
  });

  it('keeps the explicitly curated OpenRouter shortcut set', () => {
    expect(PUBLIC_PROVIDER_MODELS.openrouter?.map((model) => model.id)).toEqual([
      'anthropic/claude-opus-5',
      'anthropic/claude-fable-5.1',
      'anthropic/claude-fable-5',
      'anthropic/claude-sonnet-5',
      'openai/gpt-6-astra',
      'openai/gpt-5.6-sol',
      'openai/gpt-5.6-terra',
      'openai/gpt-5.6-luna',
      'google/gemini-3.8-flash',
      'google/gemini-3.7-flash',
      'google/gemini-3.1-pro-preview',
      'google/gemini-3.5-flash-lite',
      'deepseek/deepseek-v4.1-flash',
      'deepseek/deepseek-v4-pro',
      'deepseek/deepseek-v4-flash-0731',
      'moonshotai/kimi-k3',
      'moonshotai/kimi-k2.7-code',
      'qwen/qwen3.8-max-0902',
      'qwen/qwen3.8-flash',
      'qwen/qwen3.7-plus',
      'qwen/qwen3-coder-next',
      'z-ai/glm-5.2',
      'z-ai/glm-5.1',
      'minimax/minimax-m3',
      'minimax/minimax-m2.7',
      'xiaomi/mimo-v2.5-pro',
      'xiaomi/mimo-v2.5',
      'x-ai/grok-4.20',
      'x-ai/grok-4.5',
    ]);
  });

  it('declares compatibility metadata for models newer than older runtimes', () => {
    for (const provider of ['openai', 'openai-codex'] as const) {
      expect(PUBLIC_PROVIDER_MODELS[provider]?.[0]).toEqual({
        id: 'gpt-6-astra',
        name: 'GPT-6 Astra',
        maxInputImages: 20,
      });
      for (const model of PUBLIC_PROVIDER_MODELS[provider]?.slice(1, 4) || []) {
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
