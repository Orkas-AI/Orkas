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

