import { describe, expect, it, vi } from 'vitest';

const configs = vi.hoisted(() => [] as any[]);
vi.mock('#core-agent', () => ({ createPiProvider: (config: any) => { configs.push(config); return { id: config.provider }; } }));

import { createDeepSeekProvider, createDoubaoProvider, createMoonshotProvider, createOrkasApiProvider } from '../../../../src/main/model/core-agent/external-providers';

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

  it.each(['deepseek-v4-flash', 'deepseek-flash'])('does not silently choose low reasoning for a direct %s request', async (modelId) => {
    await createDeepSeekProvider({ apiKey: 'fixture', modelId });
    expect(configs.at(-1).defaultReasoning).toBeUndefined();
    expect(configs.at(-1).customModel).toMatchObject({ id: modelId, reasoning: true });
    if (modelId === 'deepseek-flash') {
      expect(configs.at(-1).customModel).toMatchObject({
        name: 'DeepSeek V4.1 Flash', input: ['text', 'image'], contextWindow: 1_048_576, maxTokens: 384_000,
      });
    }
  });
});
