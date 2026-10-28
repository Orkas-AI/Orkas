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
 it('round-trips custom Responses tools and images through the real SDK', async () => {
  const wires: any[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
   wires.push(JSON.parse(String(init?.body)));
   const first = wires.length === 1;
   const item = first ? { type: 'function_call', id: 'fc_lookup', call_id: 'call_lookup', name: 'lookup', arguments: '{"key":"42"}', status: 'completed' }
    : { type: 'message', id: 'msg_done', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Ready: 5827', annotations: [] }] };
   const response = { id: 'resp_fixture', status: 'completed', model: config.modelId, output: [item], usage: { input_tokens: 3, output_tokens: 2 } };
   const events = [{ type: 'response.created', response: { ...response, output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: first ? { ...item, arguments: '' } : { ...item, content: [] } },
    ...(first ? [{ type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"key":"42"}' }]
      : [{ type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
         { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Ready: 5827' }]),
    { type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response }];
   return new Response(events.map(e => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  });
  const provider = await createCustomOpenAICompatibleProvider({ ...config, protocol: 'responses', supportsVision: true });
  const schema = { type: 'object', properties: { key: { type: 'string' }, limit: { type: 'integer' } }, required: ['key'] };
  const input: any = { model: config.modelId, maxTokens: 512,
   tools: [{ name: 'lookup', description: 'Read status', inputSchema: schema }],
   messages: [{ role: 'user', content: [{ type: 'text', text: 'Read status' }, { type: 'image', mediaType: 'image/png', data: 'aGVsbG8=' }] }] };
  const first = await provider.complete(input);
  const call: any = first.content.find(b => b.type === 'tool_use');
  expect(call).toMatchObject({ name: 'lookup', input: { key: '42' } });
  input.messages.push({ role: 'assistant', content: first.content }, { role: 'user', content: [{ type: 'tool_result', toolUseId: call.id, content: 'Ready: 5827' }] });
  expect((await provider.complete(input)).content).toContainEqual(expect.objectContaining({ type: 'text', text: 'Ready: 5827' }));
  expect(wires).toHaveLength(2);
  expect(wires[0].tools[0]).toMatchObject({ type: 'function', name: 'lookup', strict: false, parameters: schema });
  expect(wires[0].input[0].content).toContainEqual(expect.objectContaining({ type: 'input_image', image_url: 'data:image/png;base64,aGVsbG8=' }));
  const output = wires[1].input.find((x: any) => x.type === 'function_call_output');
  expect(output).toMatchObject({ call_id: 'call_lookup', output: expect.stringContaining('5827') });
 });
 it.each(['complete', 'stream', 'validateAuth'] as const)('uses Responses for a custom %s without Chat compatibility rewriting', async mode => {
  const calls: any[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
   calls.push({ url: String(url), body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
   const response = { id: 'resp_fixture', object: 'response', status: 'completed', model: config.modelId,
    output: [{ type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'hello', annotations: [] }] }],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
   const events = [{ type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...response.output[0], content: [] } },
    { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'hello' },
    { type: 'response.output_item.done', output_index: 0, item: response.output[0] },
    { type: 'response.completed', response }];
   return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
  });
  const provider = await createCustomOpenAICompatibleProvider({ ...config, protocol: 'responses', supportsReasoning: true, reasoningEffort: 'medium' });
  if (mode === 'complete') expect((await provider.complete(params)).content).toContainEqual(expect.objectContaining({ type: 'text', text: 'hello' }));
  else if (mode === 'validateAuth') expect(await provider.validateAuth()).toBe(true);
  else { const events = []; for await (const e of provider.stream(params)) events.push(e); expect(events).toContainEqual({ type: 'text_delta', text: 'hello' }); }
  expect(calls).toHaveLength(1);
  expect(new URL(calls[0].url).pathname).toBe('/responses');
  expect(calls[0].headers.get('authorization')).toBe(`Bearer ${config.apiKey}`);
  expect(calls[0].body.input).toBeInstanceOf(Array);
  expect(calls[0].body.messages).toBeUndefined();
  expect(calls[0].body.max_tokens).toBeUndefined();
  expect(calls[0].body.max_completion_tokens).toBeUndefined();
  expect(calls[0].body.max_output_tokens).toBe(mode === 'validateAuth' ? 16 : 512);
  expect(calls[0].body.reasoning?.effort).toBe(mode === 'validateAuth' ? 'none' : 'medium');
 });
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
