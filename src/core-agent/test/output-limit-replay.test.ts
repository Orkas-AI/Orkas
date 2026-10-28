// The consumer must receive original reasoning after truncation, without executing discarded proposals.
// Real SDK serialization is exercised; the synthetic transport makes no model request.
import { afterEach, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPiProvider } from '../src/providers/pi-provider.js';
import { AgentRunner } from '../src/agent/runner.js';
import { Session } from '../src/agent/session.js';
import { PersistentSession } from '../src/agent/persistent-session.js';
import { createConfig } from '../src/config/loader.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { defineTool } from '../src/tools/base.js';

const model = { api: 'openai-responses' as const, provider: 'fixture-provider', id: 'fixture', name: 'fixture',
  baseUrl: 'https://fixture.invalid/v1', reasoning: true, input: ['text' as const], contextWindow: 10000,
  maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const originalReason = 'The source calculation is seven and is ready to save.';
const reason = { type: 'reasoning', id: 'rs_fixture', status: 'completed', summary: [],
  content: [{ type: 'reasoning_text', text: originalReason }], _orkas_replay: 'v1:synthetic' };
const message = (text: string) => ({ type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed',
  content: [{ type: 'output_text', text, annotations: [] }] });
const toolCall = { type: 'function_call', id: 'fc_fixture', call_id: 'call_fixture', name: 'write_file', arguments: '{"value":"seven"}' };
function response(items: any[], incomplete = false, reasonDone = true) {
  const events: any[] = [];
  items.forEach((item, output_index) => {
    events.push({ type: 'response.output_item.added', output_index, item: { ...item, content: [], summary: [] } });
    if (item.type === 'reasoning') events.push({ type: 'response.reasoning_text.delta', output_index,
      delta: item.content.map((part: { text: string }) => part.text).join('') });
    if (item.type !== 'reasoning' || reasonDone) events.push({ type: 'response.output_item.done', output_index, item });
  });
  const kind = incomplete ? 'response.incomplete' : 'response.completed';
  events.push({ type: kind, response: { id: 'resp_fixture', status: incomplete ? 'incomplete' : 'completed', output: items,
    ...(incomplete ? { incomplete_details: { reason: 'max_output_tokens' } } : {}),
    usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } } });
  return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } });
}
afterEach(() => vi.unstubAllGlobals());

it.each([
  { label: 'completed tool response control', truncated: false, hasCall: true, reasonDone: true, wireReasoning: 1, executions: 1 },
  { label: 'truncated tool response', truncated: true, hasCall: true, reasonDone: true, wireReasoning: 1, executions: 0 },
  { label: 'truncated text response control', truncated: true, hasCall: false, reasonDone: true, wireReasoning: 1, executions: 0 },
  { label: 'truncated tool response without public text', truncated: true, hasCall: true, reasonDone: true, wireReasoning: 1, executions: 0, noText: true },
  { label: 'plaintext item with protocol-null encrypted content', truncated: true, hasCall: true, reasonDone: true, wireReasoning: 1, executions: 0, nullCipher: true },
])('preserves original reasoning on the wire: $label', async scenario => {
  const bodies: any[] = [], requests: any[] = [], outputs: any[] = [];
  const sourceReason = 'nullCipher' in scenario ? { ...reason, encrypted_content: null } : reason;
  let executions = 0;
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init: any) => {
    expect(String(url)).toContain('fixture.invalid');
    bodies.push(JSON.parse(init.body));
    expect(bodies.length).toBeLessThanOrEqual(2);
    return bodies.length === 1
      ? response([sourceReason, ...('noText' in scenario ? [] : [message('Ready to save.')]),
          ...(scenario.hasCall ? [toolCall] : [])], scenario.truncated, scenario.reasonDone)
      : response([message('Seven.')]);
  }));
  const native = createPiProvider({ provider: 'fixture-provider', apiKey: 'synthetic', customModel: model });
  const provider = { ...native, async *stream(params: any) {
    requests.push(structuredClone(params.messages));
    for await (const event of native.stream(params)) {
      if (event.type === 'message_end') outputs.push(structuredClone(event));
      yield event;
    }
  } };
  const registry = new ProviderRegistry();
  registry.registerFactory('fixture-provider', () => provider);
  const runner = new AgentRunner({ config: createConfig({ agent: { defaultProvider: 'fixture-provider', defaultModel: 'fixture' } }),
    providers: registry, session: new Session(), evolution: { enabled: false }, tools: [defineTool({ name: 'write_file',
      description: 'Synthetic write counter.', inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
      execute: async () => { executions++; return { content: 'Saved.' }; } })] });
  const result = await runner.run({ message: 'Save the synthetic count and explain it.' });
  expect(result.meta.error).toBeUndefined();
  expect(bodies).toHaveLength(2);
  expect(executions).toBe(scenario.executions);
  const source = outputs[0].content.find((i: any) => i.type === 'thinking');
  expect(source.thinking).toBe(originalReason);
  expect(!!source.thinkingSignature).toBe(scenario.reasonDone);
  const nextThinking = requests[1].flatMap((m: any) => m.content).filter((c: any) => c.type === 'thinking');
  const wireThinking = bodies[1].input.filter((i: any) => i.type === 'reasoning');
  expect(wireThinking).toHaveLength(scenario.wireReasoning);
  expect(nextThinking).toHaveLength(1);
  expect(wireThinking[0].content).toEqual(reason.content);
  expect(wireThinking[0]).not.toHaveProperty('_orkas_replay');
  expect(wireThinking[0]).not.toHaveProperty('status');
  if (scenario.truncated) {
    expect(bodies[1].input.every((i: any) => i.type !== 'function_call' && i.type !== 'function_call_output')).toBe(true);
  }
});

it('keeps each original reasoning item through repeated truncation, later execution and reload', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reasoning-recovery-'));
  const file = path.join(root, 'session.jsonl');
  const bodies: any[] = [];
  const thoughts = [1, 2, 3].map(n => ({ ...reason, id: `rs_${n}`,
    content: [{ type: 'reasoning_text', text: `Original calculation step ${n}.` }] }));
  const executed: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: any) => {
    bodies.push(JSON.parse(init.body));
    const n = bodies.length;
    expect(n).toBeLessThanOrEqual(4);
    return n <= 3 ? response([thoughts[n - 1],
      { ...message(`Step ${n}. `), id: `msg_${n}` },
      { ...toolCall, id: `fc_${n}`, call_id: `call_${n}`, arguments: JSON.stringify({ value: `step-${n}` }) },
    ], n < 3) : response([message('Saved.')]);
  }));
  const registry = new ProviderRegistry();
  registry.registerFactory('fixture-provider', () => createPiProvider({ provider: 'fixture-provider', apiKey: 'synthetic', customModel: model }));
  const session = new PersistentSession({ sessionFile: file });
  const runner = new AgentRunner({ config: createConfig({ agent: { defaultProvider: 'fixture-provider', defaultModel: 'fixture' } }),
    providers: registry, session, evolution: { enabled: false }, tools: [defineTool({ name: 'write_file',
      description: 'Synthetic write counter.', inputSchema: { type: 'object', properties: { value: { type: 'string' } } },
      execute: async input => { executed.push(String(input.value)); return { content: 'Saved once.' }; } })] });
  try {
    expect((await runner.run({ message: 'Save the calculation.' })).meta.error).toBeUndefined();
    expect(executed).toEqual(['step-3']);
    expect(bodies).toHaveLength(4);
    for (let i = 1; i <= 3; i++) {
      const wire = bodies[i].input;
      expect(wire.filter((item: any) => item.type === 'reasoning')).toEqual(thoughts.slice(0, i).map(({ status, _orkas_replay, ...item }) => item));
      expect(wire.filter((item: any) => item.type === 'function_call').map((item: any) => item.call_id)).toEqual(i === 3 ? ['call_3'] : []);
      expect(wire.filter((item: any) => item.type === 'function_call_output').map((item: any) => item.call_id)).toEqual(i === 3 ? ['call_3'] : []);
      // Each reasoning item stays beside its own text, not combined ahead of one merged message.
      for (const thought of thoughts.slice(0, i)) {
        const index = wire.findIndex((item: any) => item.id === thought.id);
        expect(wire[index + 1].type).toBe('message');
      }
    }
    const restored = new PersistentSession({ sessionFile: file }).getMessages();
    const blocks = restored.flatMap(m => m.content);
    expect(blocks.filter(c => c.type === 'thinking').map(c => JSON.parse(c.thinkingSignature!))).toEqual(thoughts);
    expect(blocks.filter(c => c.type === 'tool_use')).toHaveLength(1);
    expect(JSON.stringify(restored)).not.toContain('Internal execution control');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it.each([
  { label: 'text control', text: 'Ready.', proposal: true, field: 'reasoning_content' },
  { label: 'reasoning only', text: '', proposal: false, field: 'reasoning_content' },
  { label: 'whitespace body', text: ' \n ', proposal: false, field: 'reasoning_content' },
  { label: 'discarded tool without text', text: '', proposal: true, field: 'reasoning_content' },
  { label: 'portable reasoning field', text: '', proposal: false, field: 'reasoning' },
  { label: 'portable reasoning_text field', text: '', proposal: false, field: 'reasoning_text' },
])('replays original Chat reasoning without a placeholder: $label', async scenario => {
  const bodies: any[] = [];
  let executed = 0;
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: any) => {
    bodies.push(JSON.parse(init.body));
    expect(bodies.length).toBeLessThanOrEqual(2);
    const first = bodies.length === 1;
    const delta = first ? { role: 'assistant', content: scenario.text, [scenario.field]: originalReason,
      ...(scenario.proposal ? { tool_calls: [{ index: 0, id: 'discard', type: 'function', function: { name: 'write_file', arguments: '{}' } }] } : {}) }
      : { role: 'assistant', content: 'Finished.' };
    return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: first ? 'length' : 'stop' }] })}\n\ndata: [DONE]\n\n`,
      { headers: { 'content-type': 'text/event-stream' } });
  }));
  const registry = new ProviderRegistry();
  const providerId = scenario.label === 'text control' ? 'deepseek' : 'custom';
  registry.registerFactory(providerId, () => createPiProvider({ provider: providerId, apiKey: 'synthetic',
    customModel: { ...model, api: 'openai-completions', provider: providerId } }));
  const runner = new AgentRunner({ config: createConfig({ agent: { defaultProvider: providerId, defaultModel: 'fixture' } }),
    providers: registry, session: new Session(), evolution: { enabled: false }, tools: [defineTool({ name: 'write_file',
      description: 'Synthetic write counter.', inputSchema: { type: 'object' },
      execute: async () => { executed++; return { content: 'Unexpected.' }; } })] });
  expect((await runner.run({ message: 'Prepare the change.' })).meta.error).toBeUndefined();
  expect(executed).toBe(0);
  expect(bodies).toHaveLength(2);
  const assistant = bodies[1].messages.find((m: any) => m.role === 'assistant');
  expect(assistant?.[scenario.field]).toBe(originalReason);
  expect(assistant).not.toHaveProperty('tool_calls');
  expect(assistant.content || '').toBe(scenario.text.trim() ? scenario.text : '');
  expect(JSON.stringify(bodies)).not.toContain('orkas-chat-replay:');
});
