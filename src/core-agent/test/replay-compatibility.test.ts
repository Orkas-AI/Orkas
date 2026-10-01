import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPiProvider, buildPiContextForTest, mapProviderContentForTest } from '../src/providers/pi-provider.js';
import { replayOrigin, projectDeepSeekToolReasoning } from '../src/providers/replay-compatibility.js';
import { PersistentSession } from '../src/agent/persistent-session.js';
import type { CompletionParams, LLMProvider } from '../src/providers/base.js';
import type { MessageContent } from '../src/shared/types.js';
import { transformMessages } from '@earendil-works/pi-ai/api/transform-messages';

const model = { api: 'openai-responses' as const, provider: 'openai', id: 'fixture', name: 'fixture',
  baseUrl: 'https://example.invalid/v1', reasoning: true, input: ['text' as const], contextWindow: 10000,
  maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const reasoning = { type: 'reasoning', id: 'rs_fixture', status: 'completed', summary: [], encrypted_content: 'PRIVATE_CIPHER' };
const call = { type: 'function_call', id: 'fc_fixture', call_id: 'call_fixture', name: 'inspect', arguments: '{}' };
const answer = { type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed',
  content: [{ type: 'output_text', text: 'Count: 7', annotations: [] }] };
function response(items: any[]) {
  const events: any[] = items.flatMap((item, output_index) => [
    { type: 'response.output_item.added', output_index, item },
    { type: 'response.output_item.done', output_index, item },
  ]);
  events.push({ type: 'response.completed', response: { id: 'resp_fixture', status: 'completed', output: items,
    usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } } });
  return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } });
}
async function invoke(provider: LLMProvider, method: 'complete' | 'stream', params: CompletionParams) {
  if (method === 'complete') return (await provider.complete(params)).content;
  let content: MessageContent[] | undefined;
  for await (const event of provider.stream(params)) {
    if (event.type === 'error') throw event.error;
    if (event.type === 'message_end') content = event.content;
  }
  expect(content).toBeDefined();
  return content!;
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it.each(['complete', 'stream'] as const)('keeps managed replay provenance off direct %s requests', async method => {
  const marked = { ...reasoning, _orkas_replay: 'v1:synthetic-managed-source' };
  const messages: CompletionParams['messages'] = [
    { role: 'assistant', content: [{ type: 'thinking', thinking: '',
      thinkingSignature: JSON.stringify(marked), replayOrigin: replayOrigin(model, 'fixture') }] },
    { role: 'user', content: [{ type: 'text', text: 'Continue' }] },
  ];
  const original = JSON.stringify(messages);
  let sent: any;
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: any) => {
    sent = JSON.parse(init.body);
    return response([answer]);
  }));
  await invoke(createPiProvider({ provider: 'openai', apiKey: 'fixture', customModel: model }), method, { messages });
  expect(sent.input.find((item: any) => item.type === 'reasoning')).toEqual({
    type: 'reasoning', id: 'rs_fixture', summary: [], encrypted_content: 'PRIVATE_CIPHER',
  });
  expect(JSON.stringify(messages)).toBe(original);


});

// The switch journey uses the real SDK and disk reload; the synthetic transport
// proves projection and tool/receipt continuity, not live DeepSeek acceptance.
it.each([
  ['complete', undefined, 'deepseek'], ['stream', 'high', 'deepseek'],
  ['complete', 'high', 'custom'], ['stream', undefined, 'custom'],
] as const)('keeps reasoning and receipts after repeated switches: %s / %s / %s', async (method, effort, providerId) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-deepseek-switch-'));
  const file = path.join(directory, 'session.jsonl');
  const bodies: any[] = [];
  const chatModel = { ...model, api: 'openai-completions' as const, provider: providerId,
    baseUrl: 'https://api.deepseek.com/v1', id: 'deepseek-flash' };
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: any) => {
    const body = JSON.parse(init.body); bodies.push(body);
    if (!body.messages) return response([
      { ...reasoning, id: `rs_${bodies.length}` },
      { ...call, id: `fc_${bodies.length}`, call_id: `call_${bodies.length}` },
    ]);
    const delta = bodies.length === 2
      ? { reasoning_content: 'Native DeepSeek thought', tool_calls: [{ index: 0, id: 'call_2',
        type: 'function', function: { name: 'inspect', arguments: '{}' } }] }
      : { content: 'Count: 7' };
    return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', ...delta },
      finish_reason: bodies.length === 2 ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`,
    { headers: { 'content-type': 'text/event-stream' } });
  }));
  try {
    let session = new PersistentSession({ sessionFile: file });
    session.beginUserTurn([{ type: 'text', text: 'Inspect the count' }]);
    for (const [index, target] of [model, chatModel, model, chatModel].entries()) {
      session = new PersistentSession({ sessionFile: file });
      const messages = session.getMessagesForModel();
      const before = JSON.stringify(messages);
      const provider = createPiProvider({ provider: target.provider, apiKey: 'fixture', customModel: target,
        // Async observer must retain all outbound normalization.
        ...(providerId === 'custom' ? { onPayload: async () => undefined } : {}) });
      const output = await invoke(provider, method, { messages, reasoning: effort });
      expect(JSON.stringify(messages)).toBe(before);
      if (index % 2 === 1) {
        const sent = bodies.at(-1);
        const assistants = sent.messages.filter((m: any) => m.tool_calls?.length);
        expect(assistants.map((m: any) => m.reasoning_content)).toEqual(index === 1
          ? ['.'] : ['.', 'Native DeepSeek thought', '.']);
        for (const assistant of assistants) {
          expect(assistant.tool_calls).toHaveLength(1);
          const tool = assistant.tool_calls[0];
          expect(tool.function).toEqual({ name: 'inspect', arguments: '{}' });
          expect(sent.messages.find((m: any) => m.tool_call_id === tool.id)).toMatchObject({ role: 'tool', content: '{"count":7}' });
        }
        if (effort) expect(sent).toMatchObject({ thinking: { type: 'enabled' }, reasoning_effort: effort });
        else { expect(sent).not.toHaveProperty('thinking'); expect(sent).not.toHaveProperty('reasoning_effort'); }
        expect(JSON.stringify(sent)).not.toContain('PRIVATE_CIPHER');
      } else if (index === 2) {
        expect(bodies.at(-1).input.filter((i: any) => i.type === 'reasoning')).toEqual([
          { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'PRIVATE_CIPHER' },
        ]);
        expect(JSON.stringify(bodies.at(-1))).not.toContain('Native DeepSeek thought');
      }
      session.addAssistantMessage(output);
      if (index < 3) {
        const tool = output.find(i => i.type === 'tool_use');
        expect(tool?.type).toBe('tool_use');
        session.addToolResult(tool!.type === 'tool_use' ? tool!.id : '', '{"count":7}');
      } else expect(output).toContainEqual(expect.objectContaining({ type: 'text', text: 'Count: 7' }));
    }
    expect(bodies).toHaveLength(4);
    const saved = new PersistentSession({ sessionFile: file }).getMessagesForModel();
    expect(saved.flatMap(m => m.content).filter(c => c.type === 'thinking')
      .some(c => c.type === 'thinking' && c.thinking === '.')).toBe(false);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

it('fills only missing DeepSeek tool reasoning without changing real thoughts, images, ids or public text', () => {
  const target = { ...model, api: 'openai-completions', provider: 'deepseek' };
  const tool = { id: 'c1', type: 'function', function: { name: 'inspect', arguments: '{}' } };
  const payload = { reasoning_effort: 'high', thinking: { type: 'enabled' }, messages: [
    { role: 'assistant', content: 'plain answer' },
    { role: 'assistant', content: 'Checking', tool_calls: [tool, { ...tool, id: 'c2' }], reasoning_content: '' },
    { role: 'tool', tool_call_id: 'c1', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] },
    { role: 'assistant', tool_calls: [tool], reasoning_content: 'Real thought' },
    { role: 'assistant', tool_calls: [tool] },
  ] };
  const original = JSON.stringify(payload);
  const projected = projectDeepSeekToolReasoning(payload, target) as typeof payload;
  expect(projected.messages).toEqual(payload.messages.map((m, i) => i === 1 || i === 4 ? { ...m, reasoning_content: '.' } : m));
  expect(projected.reasoning_effort).toBe('high');
  expect(projected.thinking).toEqual({ type: 'enabled' });
  expect(projectDeepSeekToolReasoning(projected, target)).toBe(projected);
  expect(JSON.stringify(payload)).toBe(original);
  for (const field of ['reasoning', 'reasoning_text']) {
    const portable = { messages: [{ role: 'assistant', tool_calls: [tool], reasoning_content: '', [field]: 'Portable thought' }] };
    expect(projectDeepSeekToolReasoning(portable, target)).toEqual({ messages: [
      { ...portable.messages[0], reasoning_content: 'Portable thought' },
    ] });
  }
  for (const controls of [{ thinking: { type: 'disabled' } }, { reasoning_effort: 'none' }, { reasoning_effort: 'off' }]) {
    const disabled = { ...payload, ...controls };
    expect(projectDeepSeekToolReasoning(disabled, target)).toBe(disabled);
  }
  for (const patch of [
    { reasoning: false }, { api: 'openai-responses' },
    { provider: 'moonshot', compat: { thinkingFormat: 'deepseek', requiresReasoningContentOnAssistantMessages: true } },
    { provider: 'custom', id: 'deepseek-flash' },
    { provider: 'custom', baseUrl: 'https://api.deepseek.com.evil.invalid/v1' },
    { provider: 'custom', baseUrl: 'https://other.invalid/api.deepseek.com' },
  ]) expect(projectDeepSeekToolReasoning(payload, { ...target, ...patch })).toBe(payload);
});

it.each(['complete', 'stream'] as const)('resumes stored tool receipts through same and foreign %s providers without replaying private state', async method => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-replay-'));
  const file = path.join(directory, 'session.jsonl');
  const payloads: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: any) => {
    payloads.push(JSON.parse(init.body));
    return response(payloads.length === 1 ? [reasoning, call] : [answer]);
  }));
  const make = (patch = {}, apiKey = 'fixture-key', headers?: Record<string, string>) => createPiProvider({ provider: 'openai', apiKey, headers,
    requestHeaders: () => ({ 'x-request-id': String(payloads.length) }), customModel: { ...model, ...patch } });
  try {
    const session = new PersistentSession({ sessionFile: file });
    session.beginUserTurn([{ type: 'text', text: 'Inspect the count' }]);
    const output = await invoke(make(), method, { messages: session.getMessagesForModel() });
    session.addAssistantMessage(output);
    const tool = output.find(i => i.type === 'tool_use');
    expect(tool?.type).toBe('tool_use');
    session.addToolResult(tool!.type === 'tool_use' ? tool!.id : '', '{"count":7}');
    const stored = fs.readFileSync(file, 'utf8');
    const messages = new PersistentSession({ sessionFile: file }).getMessagesForModel();
    const original = JSON.stringify(messages);
    for (const [provider, compatible] of [[make(), true], [make({ id: 'other' }), false],
      [make({ baseUrl: 'https://other.invalid/v1' }), false], [make({}, 'other-key'), false],
      [make({}, 'fixture-key', { Authorization: 'Bearer another-owner' }), false]] as const) {
      const result = await invoke(provider, method, { messages });
      const wire = payloads.at(-1).input;
      expect(wire.filter((i: any) => i.type === 'reasoning')).toEqual(compatible
        ? [{ type: 'reasoning', id: 'rs_fixture', summary: [], encrypted_content: 'PRIVATE_CIPHER' }] : []);
      const sentCall = wire.find((i: any) => i.type === 'function_call');
      const receipt = wire.find((i: any) => i.type === 'function_call_output');
      expect(sentCall).toMatchObject({ name: 'inspect', arguments: '{}' });
      expect(receipt).toMatchObject({ call_id: sentCall.call_id, output: '{"count":7}' });
      expect(result.some(i => i.type === 'text' && i.text === 'Count: 7')).toBe(true);
      expect(JSON.stringify(wire)).not.toContain('replayOrigin');
    }
    expect(payloads).toHaveLength(6);
    expect(stored).not.toContain('fixture-key');
    expect(stored).not.toContain('example.invalid');
    expect(JSON.stringify(messages)).toBe(original);
    expect(fs.readFileSync(file, 'utf8')).toBe(stored);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

it('keeps legacy public content and tool receipts but excludes unknown and malformed opaque state', async () => {
  const { buildPiContextForTest } = await import('../src/providers/pi-provider.js');
  const { replayOrigin } = await import('../src/providers/replay-compatibility.js');
  const content: MessageContent[] = [
    { type: 'thinking', thinking: '', thinkingSignature: JSON.stringify(reasoning) },
    { type: 'text', text: 'Checking', textSignature: 'foreign-message-state' },
    { type: 'tool_use', id: 'call_fixture', name: 'inspect', input: {}, thoughtSignature: 'foreign-tool-state' },
  ];
  const source = JSON.stringify(content);
  const messages = [{ role: 'assistant' as const, content },
    { role: 'user' as const, content: [{ type: 'tool_result' as const, toolUseId: 'call_fixture', content: '{"count":7}' }] }];
  const projected = buildPiContextForTest(messages, undefined, undefined, model);
  expect(JSON.stringify(projected)).not.toContain('PRIVATE_CIPHER');
  // The SDK, rather than our history mapper, owns generic signature removal.
  expect(JSON.stringify(transformMessages(projected.messages, model))).not.toContain('foreign-');
  expect(projected.messages).toMatchObject([
    { role: 'assistant', content: [{ type: 'text', text: 'Checking' }, { type: 'toolCall', id: 'call_fixture' }] },
    { role: 'toolResult', toolCallId: 'call_fixture', content: [{ text: '{"count":7}' }] },
  ]);
  for (const signature of ['null', '[]', '"text"', '{"type":"message"}', 'not-json']) {
    const invalid = [{ role: 'assistant' as const, content: [{ type: 'thinking' as const,
      thinking: 'private', thinkingSignature: signature, replayOrigin: replayOrigin(model) }] }];
    expect(buildPiContextForTest(invalid, undefined, undefined, model).messages).toEqual([]);
  }
  expect(JSON.stringify(content)).toBe(source);
});

it.each(['chat-to-responses', 'responses-to-chat', 'chat-to-chat', 'legacy-chat-to-chat'] as const)(
  'preserves tool receipt linkage and target-compatible reasoning across %s', async direction => {
  const chatModel = { ...model, api: 'openai-completions' as const, provider: 'deepseek', id: 'deepseek-flash',
    baseUrl: 'https://deepseek.invalid/v1' };
  const make = (chat: boolean) => createPiProvider({ provider: chat ? 'deepseek' : 'openai', apiKey: 'fixture',
    customModel: chat ? chatModel : model });
  const chatResponse = (first: boolean) => {
    const chunks = first ? [
      { choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'Private plaintext thought',
        tool_calls: [{ index: 0, id: 'call_fixture', type: 'function', function: { name: 'inspect', arguments: '{}' } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
    ] : [{ choices: [{ index: 0, delta: { role: 'assistant', content: 'Count: 7' }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }];
    return new Response(chunks.map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } });
  };
  const bodies: any[] = [];
  const sourceChat = direction !== 'responses-to-chat';
  const targetChat = direction !== 'chat-to-responses';
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: any) => {
    const body = JSON.parse(init.body); bodies.push(body);
    return body.messages ? chatResponse(bodies.length === 1) : response(bodies.length === 1 ? [reasoning, call] : [answer]);
  }));
  const messages: CompletionParams['messages'] = [{ role: 'user', content: [{ type: 'text', text: 'Inspect the count' }] }];
  const output = JSON.parse(JSON.stringify(await invoke(make(sourceChat), 'complete', { messages }))) as MessageContent[];
  if (direction === 'legacy-chat-to-chat') for (const block of output) delete block.replayOrigin;
  const tool = output.find(c => c.type === 'tool_use');
  expect(tool?.type).toBe('tool_use');
  messages.push({ role: 'assistant', content: output }, { role: 'user', content: [{ type: 'tool_result',
    toolUseId: tool!.type === 'tool_use' ? tool!.id : '', content: '{"count":7}' }] });
  const original = JSON.stringify(messages);
  await invoke(make(targetChat), 'complete', { messages });
  expect(bodies).toHaveLength(2);
  const sent = bodies[1];
  expect(JSON.stringify(sent)).not.toContain('PRIVATE_CIPHER');
  if (sourceChat && targetChat) {
    expect(sent.messages.find((i: any) => i.tool_calls)).toMatchObject({ reasoning_content: 'Private plaintext thought' });
  } else expect(JSON.stringify(sent)).not.toContain('Private plaintext thought');
  if (!targetChat) {
    const sentCall = sent.input.find((i: any) => i.type === 'function_call');
    expect(sent.input.find((i: any) => i.type === 'function_call_output')).toMatchObject({ call_id: sentCall.call_id, output: '{"count":7}' });
  } else {
    const sentCall = sent.messages.find((i: any) => i.tool_calls).tool_calls[0];
    expect(sentCall.id).not.toContain('|');
    expect(sent.messages.find((i: any) => i.role === 'tool')).toMatchObject({ tool_call_id: sentCall.id, content: '{"count":7}' });
  }
  expect(JSON.stringify(messages)).toBe(original);
});

it.each([
  { api: 'google-generative-ai' as const, provider: 'google', id: 'gemini-fixture' },
  { api: 'anthropic-messages' as const, provider: 'anthropic', id: 'claude-fixture' },
])('passes $provider source identity to pi so its converter removes foreign signatures', identity => {
  const source = { ...model, ...identity };
  const content = mapProviderContentForTest([
    { type: 'thinking', thinking: 'PRIVATE_THOUGHT', thinkingSignature: 'PRIVATE_SIGNATURE', redacted: true },
    { type: 'text', text: 'Checking', textSignature: 'GOOGLE_TEXT_SIGNATURE' },
    { type: 'toolCall', id: 'call_fixture', name: 'inspect', arguments: {}, thoughtSignature: 'GOOGLE_TOOL_SIGNATURE' },
  ], false, undefined, replayOrigin(source));
  const messages: CompletionParams['messages'] = [{ role: 'assistant', content },
    { role: 'user', content: [{ type: 'tool_result', toolUseId: 'call_fixture', content: '7' }] }];
  const original = JSON.stringify(messages);
  const context = buildPiContextForTest(messages, undefined, undefined, model);
  expect(context.messages[0]).toMatchObject({ api: source.api, provider: source.provider, model: source.id });
  // A deliberate boundary assertion: these reach pi, rather than being stripped
  // by a duplicate Orkas generic converter. The outbound SDK result is the oracle.
  expect(JSON.stringify(context.messages)).toContain('GOOGLE_TOOL_SIGNATURE');
  const converted = transformMessages(context.messages, model);
  expect(JSON.stringify(converted)).not.toContain('GOOGLE_');
  expect(JSON.stringify(converted)).not.toContain('PRIVATE_');
  expect(converted).toMatchObject([{ role: 'assistant', content: [
    { type: 'text', text: 'Checking' }, { type: 'toolCall', id: 'call_fixture', name: 'inspect' },
  ] }, { role: 'toolResult', toolCallId: 'call_fixture', content: [{ text: '7' }] }]);
  expect(JSON.stringify(messages)).toBe(original);
});

it('does not treat malformed saved source identity as the target model', () => {
  const origin = { ...replayOrigin(model), scope: 'foreign', source: {} } as unknown as NonNullable<MessageContent['replayOrigin']>;
  const context = buildPiContextForTest([{ role: 'assistant', content: [
    { type: 'text', text: 'Public', textSignature: 'FOREIGN_SIGNATURE', replayOrigin: origin },
  ] }], undefined, undefined, model);
  expect(JSON.stringify(transformMessages(context.messages, model))).not.toContain('FOREIGN_SIGNATURE');
});

it('retains compatible private state beside foreign blocks without leaking their signatures or item ids', async () => {
  const same = replayOrigin(model, 'fixture');
  const foreign = replayOrigin({ ...model, id: 'other' }, 'fixture');
  const content: MessageContent[] = [
    { type: 'thinking', thinking: '', thinkingSignature: JSON.stringify(reasoning), replayOrigin: same },
    { type: 'text', text: 'Checking', textSignature: 'FOREIGN_TEXT_SIGNATURE', replayOrigin: foreign },
    { type: 'tool_use', id: 'call_foreign|fc_foreign', name: 'inspect', input: {},
      thoughtSignature: 'FOREIGN_TOOL_SIGNATURE', namespace: 'foreign_namespace', replayOrigin: foreign },
    { type: 'tool_use', id: 'call_same|fc_same', name: 'inspect', input: {}, replayOrigin: same },
  ];
  let sent: any;
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: any) => { sent = JSON.parse(init.body); return response([answer]); }));
  const messages: CompletionParams['messages'] = [{ role: 'assistant', content },
    { role: 'user', content: [
      { type: 'tool_result', toolUseId: 'call_foreign|fc_foreign', content: '7' },
      { type: 'tool_result', toolUseId: 'call_same|fc_same', content: '9' },
    ] }];
  const original = JSON.stringify(messages);
  await invoke(createPiProvider({ provider: 'openai', apiKey: 'fixture', customModel: model }), 'complete', { messages });
  const calls = sent.input.filter((i: any) => i.type === 'function_call');
  expect(calls).toHaveLength(2);
  expect(calls[0]).not.toHaveProperty('id');
  expect(calls[0]).not.toHaveProperty('namespace');
  expect(calls[1]).toMatchObject({ id: 'fc_same', call_id: 'call_same' });
  expect(sent.input.filter((i: any) => i.type === 'function_call_output')).toMatchObject([
    { call_id: calls[0].call_id, output: '7' }, { call_id: calls[1].call_id, output: '9' },
  ]);
  expect(JSON.stringify(sent)).toContain('PRIVATE_CIPHER');
  expect(JSON.stringify(sent)).not.toContain('FOREIGN_');
  expect(JSON.stringify(messages)).toBe(original);
});

it('uses pi to keep distinct parallel receipts when Responses call ids share a prefix on a Chat handoff', async () => {
  const source = replayOrigin(model);
  const chat = { ...model, api: 'openai-completions' as const, provider: 'deepseek', id: 'deepseek-flash' };
  const content: MessageContent[] = ['one', 'two'].map(suffix => ({ type: 'tool_use',
    id: `call_shared|fc_${suffix}`, name: 'inspect', input: { key: suffix }, replayOrigin: source }));
  const messages: CompletionParams['messages'] = [{ role: 'assistant', content }, { role: 'user',
    content: ['one', 'two'].map(suffix => ({ type: 'tool_result', toolUseId: `call_shared|fc_${suffix}`, content: suffix })) }];
  let sent: any;
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: any) => {
    sent = JSON.parse(init.body);
    return new Response('data: {"choices":[{"index":0,"delta":{"content":"Both checked"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } });
  }));
  await invoke(createPiProvider({ provider: 'deepseek', apiKey: 'fixture', customModel: chat }), 'complete', { messages });
  const calls = sent.messages.find((i: any) => i.tool_calls).tool_calls;
  const receipts = sent.messages.filter((i: any) => i.role === 'tool');
  expect(calls).toHaveLength(2);
  expect(new Set(calls.map((c: any) => c.id)).size).toBe(2);
  expect(receipts).toMatchObject([
    { tool_call_id: calls[0].id, content: 'one' }, { tool_call_id: calls[1].id, content: 'two' },
  ]);
});
