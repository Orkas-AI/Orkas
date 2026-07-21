import { describe, it, expect } from 'vitest';
import {
  buildDoubaoModel,
  buildMoonshotModel,
  createMoonshotProvider,
} from '../../../../src/main/model/core-agent/external-providers';

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
