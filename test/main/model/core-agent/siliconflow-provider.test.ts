import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSiliconFlowModel, createSiliconFlowProvider } from '../../../../src/main/model/core-agent/external-providers';

const FLASH = 'deepseek-ai/DeepSeek-V4-Flash';
const QWEN = 'Qwen/Qwen3.8-27B';

afterEach(() => vi.unstubAllGlobals());

function response(deltas: Record<string, unknown>[], finish = 'stop'): Response {
  const chunks = [...deltas.map(delta => ({ choices: [{ index: 0, delta, finish_reason: null }] })),
    { choices: [{ index: 0, delta: {}, finish_reason: finish }] }];
  return new Response(chunks.map(chunk => `data: ${JSON.stringify({
    id: 'fixture', object: 'chat.completion.chunk', model: FLASH, ...chunk,
  })}\n\n`).join('') + 'data: [DONE]\n\n', {
    headers: { 'content-type': 'text/event-stream' },
  });
}

function transport(replies: (() => Response)[]) {
  const bodies: any[] = [];
  const fetch = vi.fn(async (input: any, init: any) => {
    expect(String(input)).toBe('https://api.siliconflow.cn/v1/chat/completions');
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer synthetic-siliconflow-key');
    bodies.push(JSON.parse(init.body));
    const reply = replies.shift();
    if (!reply) throw new Error('Unexpected duplicate model request');
    return reply();
  });
  vi.stubGlobal('fetch', fetch);
  return { bodies, fetch };
}

describe('SiliconFlow provider', () => {
  it('uses provider-specific model limits and rejects unknown aliases', () => {
    expect(buildSiliconFlowModel(FLASH)).toMatchObject({
      provider: 'siliconflow', api: 'openai-completions',
      baseUrl: 'https://api.siliconflow.cn/v1', reasoning: true,
      input: ['text'], contextWindow: 1_000_000, maxTokens: 32768,
    });
    expect(buildSiliconFlowModel(QWEN)).toMatchObject({
      input: ['text', 'image'], contextWindow: 256000, maxTokens: 32768,
    });
    expect(() => buildSiliconFlowModel('unknown-model')).toThrow(/not configured/);
  });

  it.each([FLASH, QWEN])('keeps omitted thinking at the upstream default and supports explicit off for %s', async modelId => {
    const { bodies } = transport(Array.from({ length: 4 }, () => () => response([{ content: 'Ready' }])));
    const provider = await createSiliconFlowProvider({ apiKey: 'synthetic-siliconflow-key', modelId });
    const request = { model: modelId, systemPrompt: 'Fixture',
      messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Hello' }] }] };
    expect((await provider.complete(request)).content).toContainEqual(expect.objectContaining({ type: 'text', text: 'Ready' }));
    await provider.complete({ ...request, reasoning: 'off' });
    await provider.complete({ ...request, reasoning: 'low' });
    await provider.complete({ ...request, reasoning: 'high' });
    expect(bodies[0]).not.toHaveProperty('enable_thinking');
    expect(bodies[1]).toMatchObject({ enable_thinking: false });
    expect(bodies[2]).toMatchObject({ enable_thinking: true });
    expect(bodies[3]).toMatchObject({ enable_thinking: true });
    if (modelId === FLASH) {
      expect(bodies[2].reasoning_effort).toBe('high');
      expect(bodies[3].reasoning_effort).toBe('max');
    } else {
      expect(bodies.every(body => body.reasoning_effort === undefined)).toBe(true);
    }
    for (const body of bodies) {
      expect(body.model).toBe(modelId);
      expect(body).not.toHaveProperty('thinking');
      expect(body).not.toHaveProperty('store');
      expect(body).not.toHaveProperty('prompt_cache_retention');
      expect(body.messages[0].role).toBe('system');
    }
  });

  it.each([FLASH, QWEN])('streams a tool call and preserves its reasoning and result on the next request for %s', async modelId => {
    const { bodies, fetch } = transport([
      () => response([
        { reasoning_content: 'Inspect the saved note.' },
        { tool_calls: [{ index: 0, id: 'call_note', type: 'function', function: { name: 'read_note', arguments: '{"id":' } }] },
        { tool_calls: [{ index: 0, function: { arguments: '7}' } }] },
      ], 'tool_calls'),
      () => response([{ content: 'The note is ready.' }]),
    ]);
    const provider = await createSiliconFlowProvider({ apiKey: 'synthetic-siliconflow-key', modelId });
    const messages: any[] = [{ role: 'user', content: [{ type: 'text', text: 'Read note 7.' }] }];
    const tools = [{ name: 'read_note', description: 'Read a saved note.',
      inputSchema: { type: 'object', properties: { id: { type: 'number' } }, required: ['id'] } }];
    const first = await provider.complete({ model: modelId, messages, tools });
    expect(first.stopReason).toBe('tool_use');
    const call = first.content.find(part => part.type === 'tool_use');
    expect(call).toMatchObject({ name: 'read_note', input: { id: 7 } });
    messages.push({ role: 'assistant', content: first.content },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: (call as any).id, content: 'Saved note contents' }] });
    const events: any[] = [];
    for await (const event of provider.stream({ model: modelId, messages, tools })) events.push(event);
    expect(events.some(event => event.type === 'text_delta' && event.text === 'The note is ready.')).toBe(true);
    expect(events.some(event => event.type === 'message_end' && event.stopReason === 'end_turn')).toBe(true);
    expect(bodies[1].messages).toContainEqual(expect.objectContaining({
      role: 'assistant', reasoning_content: 'Inspect the saved note.',
      tool_calls: [expect.objectContaining({ function: { name: 'read_note', arguments: '{"id":7}' } })],
    }));
    expect(bodies[1].messages).toContainEqual(expect.objectContaining({ role: 'tool', content: 'Saved note contents' }));
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('rejects invalid credentials before sending a request', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(createSiliconFlowProvider({ apiKey: '', modelId: FLASH })).rejects.toThrow(/apiKey required/);
    await expect(createSiliconFlowProvider({ apiKey: 'unsafe-щ-key', modelId: FLASH })).rejects.toMatchObject({ code: 'API_KEY_INVALID' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports an upstream rejection without replaying the request', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({
      error: { message: 'Fixture account has no balance', type: 'insufficient_quota' },
    }), { status: 402, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetch);
    const provider = await createSiliconFlowProvider({ apiKey: 'synthetic-siliconflow-key', modelId: FLASH });
    await expect(provider.complete({ model: FLASH,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
    })).rejects.toThrow(/no balance/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
