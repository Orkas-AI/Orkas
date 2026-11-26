import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentRunner, createConfig, PersistentSession, ProviderRegistry } from '#core-agent';
import { createPiProvider } from '../../../../src/core-agent/src/providers/pi-provider.js';
import { getBuiltinModel } from '@earendil-works/pi-ai/providers/all';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompletionParams, LLMProvider, StreamEvent } from '#core-agent';
import { createDeepSeekProvider, createCustomOpenAICompatibleProvider } from '../../../../src/main/model/core-agent/external-providers';
import { _clearAll } from '../../../../src/main/model/core-agent/profile-cooldown';

// Keep the SDK and public provider factories real; only HTTP is synthetic.
const host = vi.hoisted(() => ({
  refresh: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
}));
vi.mock('../../../../src/main/logger', () => ({ createLogger: () => ({
  info: host.info, warn: host.warn, error: host.error, debug: vi.fn(),
}) }));

const answer = { type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed',
  content: [{ type: 'output_text', text: 'Saved record 42.', annotations: [] }] };
function response(items: ReadonlyArray<typeof answer>) {
  const events = items.flatMap((item, output_index) => [
    { type: 'response.output_item.added', output_index, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.output_text.delta', output_index, content_index: 0, delta: item.content[0].text },
    { type: 'response.output_item.done', output_index, item },
  ]);
  return new Response([...events, { type: 'response.completed', response: {
    id: 'resp_fixture', status: 'completed', output: items,
    usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
  } }].map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),
  { headers: { 'content-type': 'text/event-stream' } });
}
async function invoke(provider: LLMProvider, mode: 'stream' | 'complete', params: CompletionParams) {
  if (mode === 'complete') return provider.complete(params);
  const events: StreamEvent[] = [];
  for await (const event of provider.stream(params)) {
    if (event.type === 'error') throw event.error;
    events.push(event);
  }
  expect(events.filter(e => e.type === 'message_end')).toHaveLength(1);
  return events.find(e => e.type === 'message_end');
}
beforeEach(() => { vi.clearAllMocks(); _clearAll(); });
afterEach(() => {
  try { expect(host.error).not.toHaveBeenCalled(); }
  finally { vi.unstubAllGlobals(); vi.restoreAllMocks(); _clearAll(); }
});

it.each(['complete', 'stream'] as const)('preserves DeepSeek thinking choices through configured factories and %s SDK requests', async mode => {
  const wire: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
    wire.push(JSON.parse(init.body));
    return new Response('data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Saved record 42."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } });
  }));
  const messages: CompletionParams['messages'] = [
    { role: 'assistant', content: [
      { type: 'thinking', thinking: '', thinkingSignature: '{"type":"reasoning","encrypted_content":"foreign-private-state"}' },
      { type: 'tool_use', id: 'call_save|fc_save', name: 'save_record', input: { value: 42 } },
    ] },
    { role: 'user', content: [{ type: 'tool_result', toolUseId: 'call_save|fc_save', content: 'saved-record-42' }] },
  ];
  const original = JSON.stringify(messages);
  for (const provider of [
    await createDeepSeekProvider({ apiKey: 'fixture', modelId: 'deepseek-flash' }),
    await createCustomOpenAICompatibleProvider({ apiKey: 'fixture', modelId: 'deepseek-flash',
      baseUrl: 'https://api.deepseek.com/v1', supportsReasoning: true, reasoningEffort: 'high', contextWindow: 128000, maxTokens: 4096 }),
  ]) {
    for (const reasoning of ['high', 'off'] as const) {
      const result = await invoke(provider, mode, { messages, reasoning });
      expect(result?.content).toContainEqual(expect.objectContaining({ type: 'text', text: 'Saved record 42.' }));
      const sent = wire.at(-1);
      const assistant = sent.messages.find((m: any) => m.tool_calls);
      expect(assistant.reasoning_content).toBe(reasoning === 'high' ? '.' : '');
      expect(sent.thinking).toEqual({ type: reasoning === 'high' ? 'enabled' : 'disabled' });
      if (reasoning === 'high') expect(sent.reasoning_effort).toBe('high');
      expect(sent.messages.find((m: any) => m.role === 'tool')).toMatchObject({
        tool_call_id: assistant.tool_calls[0].id, content: 'saved-record-42',
      });
      expect(JSON.stringify(sent)).not.toContain('foreign-private-state');
      expect(JSON.stringify(messages)).toBe(original);
    }
  }
  expect(wire).toHaveLength(4);
  expect(host.warn).not.toHaveBeenCalled();
});


it('completes active compaction through the configured Responses SDK with SDK cache opt-out and intact authorization', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'public-compaction-'));
  const wire: Array<{ body: any; headers: Headers; checkpoint: boolean }> = [];
  vi.stubGlobal('fetch', vi.fn(async (input, init) => {
    const request = new Request(input, init);
    const raw = await request.text();
    const body = JSON.parse(raw);
    const headers = request.headers;
    const checkpoint = JSON.stringify(body.input).includes('You are a context compaction engine.');
    wire.push({ body, headers, checkpoint });
    if (headers.get('authorization') !== 'Bearer sk-fixture') return new Response(null, { status: 401 });
    if (checkpoint && (
      !body.prompt_cache_options || body.prompt_cache_options.mode !== 'explicit' ||
      Object.keys(body.prompt_cache_options).length !== 1 ||
      /"(?:prompt_cache_key|prompt_cache_retention|cache_control)"/.test(raw)
    )) {
      return new Response(null, { status: 400 });
    }
    const item = checkpoint ? { ...answer, content: [{ ...answer.content[0], text: 'CHECKPOINT_SAVED' }] } : answer;
    return response([item]);
  }));
  try {
    const contextWindow = 110_000;
    const session = new PersistentSession({ sessionFile: path.join(root, 'session.jsonl') });
    session.beginUserTurn([{ type: 'text', text: 'Compare the results.' }]);
    for (let i = 0; i < 8; i++) {
      session.addAssistantMessage([{ type: 'tool_use', id: `call_${i}|fc_${i}`, name: 'read_fixture', input: {} }]);
      session.addToolResult(`call_${i}|fc_${i}`, `${i === 7 ? 'LATEST_RESULT' : `OLD_RESULT_${i}`}\n${'sample '.repeat(6500)}`);
    }
    const providers = new ProviderRegistry();
    const modelId = 'gpt-6.1-sol';
    const model = getBuiltinModel('openai', modelId)!;
    const provider = createPiProvider({
      provider: 'openai',
      apiKey: 'sk-fixture',
      userCacheKey: 'public-cache-fixture',
      customModel: { ...model, contextWindow, baseUrl: 'https://fixture.invalid/v1' },
    });
    providers.registerFactory('openai', () => provider);
    const runner = new AgentRunner({ providers, session, disableTools: true, evolution: { enabled: false },
      config: createConfig({
        agent: { defaultProvider: 'openai', defaultModel: modelId, maxRetries: 0 },
        models: { catalog: { [modelId]: { provider: 'openai', model: modelId, contextWindow, maxOutputTokens: 8_192 } } },
      }),
    });
    const result = await runner.run({ message: 'Compare the results.', resumeActiveTurn: true, cacheRetention: 'long' });
    expect(result.meta.error).toBeUndefined();
    expect(result.text).toBe('Saved record 42.');
    expect(wire.map(call => call.checkpoint)).toEqual([true, false]);
    expect(wire.map(call => call.headers.get('authorization'))).toEqual(['Bearer sk-fixture', 'Bearer sk-fixture']);
    expect(wire[0].body).toMatchObject({ prompt_cache_options: { mode: 'explicit' } });
    expect(wire[0].body.prompt_cache_key).toBeUndefined();
    expect(wire[0].body.prompt_cache_retention).toBeUndefined();
    expect(wire[1].body.prompt_cache_options?.mode).toBeUndefined();
    expect(wire[1].body.prompt_cache_key).toBeDefined();
    expect(JSON.stringify(wire[1].body.input)).toContain('CHECKPOINT_SAVED');
    expect(JSON.stringify(wire[1].body.input)).toContain('LATEST_RESULT');
    expect(host.warn).not.toHaveBeenCalled();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
