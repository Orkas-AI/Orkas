import { describe, expect, it, vi } from 'vitest';

const configs = vi.hoisted(() => [] as any[]);
vi.mock('#core-agent', () => ({ createPiProvider: (config: any) => { configs.push(config); return { id: config.provider }; } }));

import { createDeepSeekProvider, createDoubaoProvider, createMoonshotProvider, createOrkasApiProvider, createCustomOpenAICompatibleProvider } from '../../../../src/main/model/core-agent/external-providers';

describe('external provider request policy', () => {
  it.each([
    ['deepseek', createDeepSeekProvider, 'deepseek-v4-flash'],
    ['doubao', createDoubaoProvider, 'doubao-seed-2-0-lite-260428'],
    ['moonshot', createMoonshotProvider, 'kimi-k3'],
    ['orkas-api', createOrkasApiProvider, 'orkas-llm-1.5-pro'],
  ] as const)('preserves detached tool results without sending invalid %s message order', async (_provider, create, modelId) => {
    await create({ apiKey: 'fixture', modelId });
    const config = configs.at(-1);
    const request = { messages: [{ role: 'user', content: 'Continue' }, { role: 'tool', tool_call_id: 'lost-call', content: 'Persisted evidence' }] };
    const payload = config.onPayload ? config.onPayload(request) : request;
    expect(payload.messages[1]).toMatchObject({ role: 'user', content: expect.stringContaining('Persisted evidence') });
    expect(payload.messages[1]).not.toHaveProperty('tool_call_id');
  });

  it.each([
    ['deepseek', createDeepSeekProvider, 'deepseek-flash'],
    ['doubao', createDoubaoProvider, 'doubao-seed-2-1-pro-260915'],
    ['moonshot', createMoonshotProvider, 'kimi-k3'],
    ['orkas-api', createOrkasApiProvider, 'orkas-llm-1.5-pro'],
  ] as const)('carries only the supplied opaque cache identity through the %s factory', async (provider, create, modelId) => {
    const start = configs.length;
    await create({ apiKey: 'fixture', modelId, userCacheKey: 'opaque-user-scope' });
    expect(configs).toHaveLength(start + 1);
    expect(configs.at(-1)).toMatchObject({ provider, apiKey: 'fixture', userCacheKey: 'opaque-user-scope' });
    await create({ apiKey: 'fixture', modelId });
    expect(configs.at(-1).userCacheKey).toBeUndefined();
  });

  it.each(['openai', 'responses', 'anthropic'] as const)('retains the user cache scope on a custom %s endpoint without changing its protocol', async protocol => {
    await createCustomOpenAICompatibleProvider({ apiKey: 'fixture', modelId: 'fixture-model', protocol,
      baseUrl: 'https://fixture.invalid/v1', contextWindow: 128000, maxTokens: 1024, userCacheKey: 'opaque-user-scope' });
    expect(configs.at(-1)).toMatchObject({ provider: 'custom', userCacheKey: 'opaque-user-scope',
      customModel: { id: 'fixture-model', api: protocol === 'anthropic' ? 'anthropic-messages'
        : protocol === 'responses' ? 'openai-responses' : 'openai-completions' } });
  });

  it.each(['deepseek-v4-flash', 'deepseek-flash'])('does not silently choose low reasoning for a direct %s request', async (modelId) => {
    await createDeepSeekProvider({ apiKey: 'fixture', modelId });
    expect(configs.at(-1).defaultReasoning).toBeUndefined();
    expect(configs.at(-1).customModel).toMatchObject({ id: modelId, reasoning: true });
    if (modelId === 'deepseek-flash') {
      expect(configs.at(-1).customModel).toMatchObject({
        name: 'DeepSeek V4.1 Flash', input: ['text', 'image'], contextWindow: 1_000_000, maxTokens: 128_000,
      });
    }
  });
});
