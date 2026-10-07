import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCustomOutputLimitCompatibility } from '../../../../src/main/model/core-agent/custom-output-limit';
import { normalizeAnthropicBaseUrl } from '../../../../src/main/model/custom-model-url';
import { createCustomOpenAICompatibleProvider } from '../../../../src/main/model/core-agent/external-providers';
const config = { apiKey: 'synthetic-custom-protocol', baseUrl: 'https://gateway.example.test', modelId: 'claude-gateway-alias', contextWindow: 131072, maxTokens: 32768 };
const params = { model: config.modelId, maxTokens: 512, messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hello' }] }] };
function anthropicSuccess() {
 const events = [
  { type: 'message_start', message: { id: 'msg-fixture', type: 'message', role: 'assistant', model: config.modelId, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
 ];
 return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}
afterEach(() => vi.restoreAllMocks());
describe('custom model protocol wire contract', () => {
 it.each(['complete', 'stream', 'validateAuth'] as const)('dispatches a clean Anthropic %s request through the real SDK', async mode => {
  const calls: any[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
   calls.push({ url: String(url), body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
   return anthropicSuccess();
  });
  const provider = await createCustomOpenAICompatibleProvider({ ...config, apiKey: `synthetic-${mode}`, protocol: 'anthropic' });
  if (mode === 'complete') expect((await provider.complete(params)).content).toContainEqual({ type: 'text', text: 'hello' });
  else if (mode === 'validateAuth') expect(await provider.validateAuth()).toBe(true);
  else { const events = []; for await (const e of provider.stream(params)) events.push(e); expect(events).toContainEqual({ type: 'text_delta', text: 'hello' }); expect(events.some(e => e.type === 'error')).toBe(false); }
  expect(calls).toHaveLength(1);
  expect(new URL(calls[0].url).pathname).toBe('/v1/messages');
  expect(calls[0].headers.get('x-api-key')).toBe(`synthetic-${mode}`);
  expect(calls[0].body.max_tokens).toBe(mode === 'validateAuth' ? 1 : 512);
  expect(calls[0].body.max_completion_tokens).toBeUndefined();
 });
 it.each(['/v1', '/v1/messages'])('normalizes the common Anthropic endpoint suffix %s instead of duplicating it', async suffix => {
  const urls: string[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async url => { urls.push(String(url)); return anthropicSuccess(); });
  await (await createCustomOpenAICompatibleProvider({ ...config, baseUrl: normalizeAnthropicBaseUrl(config.baseUrl + suffix), protocol: 'anthropic' })).complete(params);
  expect(new URL(urls[0]).pathname).toBe('/v1/messages');
 });
 it('does not reuse a learned OpenAI output field in an Anthropic request with otherwise identical configuration', async () => {
  const compat = createCustomOutputLimitCompatibility(config); let count = 0;
  await compat.wrapFetch(async () => ++count === 1
   ? Response.json({ error: { code: 'unsupported_parameter', param: 'max_tokens' } }, { status: 400 })
   : new Response('{}', { headers: { 'content-type': 'application/json' } }))(
    config.baseUrl + '/chat/completions', { method: 'POST', body: JSON.stringify({ model: config.modelId, max_tokens: 512 }) });
  const wires: any[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => { wires.push(JSON.parse(String(init?.body))); return anthropicSuccess(); });
  await (await createCustomOpenAICompatibleProvider({ ...config, protocol: 'anthropic' })).complete(params);
  expect(wires).toHaveLength(1);
  expect(wires[0]).toHaveProperty('max_tokens', 512);
  expect(wires[0]).not.toHaveProperty('max_completion_tokens');
 });
 it('preserves native Messages system, image and tool-result blocks', async () => {
  let body: any;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
   body = JSON.parse(String(init?.body)); return anthropicSuccess();
  });
  const provider = await createCustomOpenAICompatibleProvider({ ...config, protocol: 'anthropic' });
  await provider.complete({ model: config.modelId, maxTokens: 512, systemPrompt: 'Fixture system',
   tools: [{ name: 'lookup', description: 'Fixture lookup', inputSchema: { type: 'object', properties: {} } }],
   messages: [
    { role: 'user', content: [{ type: 'text', text: 'Inspect image' },
     { type: 'image', data: 'aGVsbG8=', mediaType: 'image/png' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_fixture', name: 'lookup', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', toolUseId: 'toolu_fixture', content: 'Found fixture' }] },
   ],
  });
  expect(body.system).toContainEqual(expect.objectContaining({ type: 'text', text: 'Fixture system' }));
  expect(body.tools).toContainEqual(expect.objectContaining({ name: 'lookup', input_schema: expect.objectContaining({ type: 'object', properties: {} }) }));
  expect(body.messages[0].content).toContainEqual(expect.objectContaining({
   type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGVsbG8=' },
  }));
  expect(body.messages[1].content).toContainEqual(expect.objectContaining({ type: 'tool_use', id: 'toolu_fixture', name: 'lookup' }));
  expect(body.messages[2].content).toContainEqual(expect.objectContaining({ type: 'tool_result', tool_use_id: 'toolu_fixture' }));
  expect(body.messages.some((message: any) => message.role === 'tool' || message.role === 'system')).toBe(false);
 });

});
