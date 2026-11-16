import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentRunner } from '../src/agent/runner.js';
import { PersistentSession } from '../src/agent/persistent-session.js';
import { createConfig } from '../src/config/loader.js';
import { createPiProvider } from '../src/providers/pi-provider.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import type { AgentRunEvent } from '../src/agent/types.js';

type Api = 'openai-completions' | 'openai-responses';
type Reply = {
  kind: 'bad' | 'unfinished' | 'tool' | 'text';
  length?: boolean;
  text?: string;
  file?: string;
  sibling?: boolean;
};
const APIS: Api[] = ['openai-completions', 'openai-responses'];
const BAD_ARGUMENTS = '{"path":"PRIVATE_INCOMPLETE_ARGUMENT';
const roots: string[] = [];

afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

// Exercise the installed SDK, adapter, Runner and durable Session. Only model
// HTTP responses are synthetic; the executor appends real isolated files so a
// duplicate or accidentally admitted sibling is independently observable.
function wireReply(api: Api, reply: Reply, round: number): Response {
  const truncated = reply.length ?? (reply.kind === 'bad' || reply.kind === 'unfinished');
  const text = reply.text ?? 'Analysis retained.';
  const calls = reply.kind === 'text' ? [] : [{
    id: `${reply.kind}_${round}`, name: 'write_file',
    arguments: reply.kind === 'tool'
      ? JSON.stringify({ path: reply.file ?? 'report.txt', content: 'verified\n' }) : BAD_ARGUMENTS,
  }];
  if (reply.sibling) calls.push({ id: `sibling_${round}`, name: 'write_file',
    arguments: JSON.stringify({ path: 'forbidden.txt', content: 'must not run\n' }) });
  let frames: unknown[];
  if (api === 'openai-completions') {
    frames = [{ id: 'fixture', model: 'fixture', choices: [{ index: 0,
      delta: { role: 'assistant', content: text, ...(calls.length ? { tool_calls: calls.map((call, index) => ({
        index, id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments },
      })) } : {}) }, finish_reason: truncated ? 'length' : calls.length ? 'tool_calls' : 'stop',
    }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }];
  } else {
    const message = { type: 'message', id: `msg_${round}`, role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text, annotations: [] }] };
    const items = calls.map(call => ({ type: 'function_call', id: `fc_${call.id}`, call_id: call.id,
      name: call.name, arguments: call.arguments, status: truncated ? 'incomplete' : 'completed' }));
    frames = [{ type: 'response.created', response: { id: `resp_${round}` } },
      { type: 'response.output_item.added', output_index: 0, item: { ...message, content: [] } },
      { type: 'response.output_text.delta', output_index: 0, delta: text },
      { type: 'response.output_item.done', output_index: 0, item: message }];
    items.forEach((item, index) => {
      frames.push({ type: 'response.output_item.added', output_index: index + 1, item: { ...item, arguments: '' } },
        { type: 'response.function_call_arguments.delta', output_index: index + 1, delta: item.arguments });
      if (reply.kind !== 'unfinished') frames.push({ type: 'response.output_item.done', output_index: index + 1, item });
    });
    frames.push({ type: truncated ? 'response.incomplete' : 'response.completed', response: {
      id: `resp_${round}`, status: truncated ? 'incomplete' : 'completed',
      incomplete_details: truncated ? { reason: 'max_output_tokens' } : null, output: [message, ...items],
      usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30, input_tokens_details: { cached_tokens: 0 } },
    } });
  }
  return new Response(frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('')
    + (api === 'openai-completions' ? 'data: [DONE]\n\n' : ''),
  { headers: { 'content-type': 'text/event-stream' } });
}

function setup(api: Api, replies: Reply[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-output-limit-'));
  roots.push(root);
  const bodies: any[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(await new Request(input, init).text());
    bodies.push(body);
    const reply = replies[bodies.length - 1];
    if (!reply) throw new Error('Synthetic request budget exceeded');
    return wireReply(api, reply, bodies.length);
  }));
  const provider = createPiProvider({ provider: 'custom', apiKey: 'fixture', customModel: {
    id: 'fixture', name: 'Fixture', provider: 'custom', api, baseUrl: 'https://fixture.invalid/v1',
    reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  } });
  const registry = new ProviderRegistry();
  registry.registerFactory('custom', () => provider);
  const file = path.join(root, 'session.jsonl');
  const session = new PersistentSession({ sessionFile: file });
  const writes: unknown[] = [];
  const runner = new AgentRunner({ providers: registry, session,
    config: createConfig({ agent: { defaultProvider: 'custom', defaultModel: 'fixture', maxRetries: 0 } }),
    tools: [{ name: 'write_file', description: 'Write a report', inputSchema: {
      type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'],
    }, async execute(input) {
      writes.push(input);
      expect(['report.txt', 'first.txt', 'forbidden.txt']).toContain(input.path);
      fs.appendFileSync(path.join(root, String(input.path)), String(input.content));
      return { content: `Saved ${input.path}` };
    } }],
  });
  return { root, file, session, runner, provider, bodies, writes };
}

describe('real SDK output-limit recovery', () => {
  it.each(APIS.flatMap(api => (['complete', 'stream'] as const).map(method => [api, method] as const)))
  ('preserves a known length termination without executable malformed calls (%s/%s)', async (api, method) => {
    const { provider, bodies } = setup(api, [{ kind: 'bad', sibling: true }]);
    const params = { model: 'fixture', messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'Write the report.' }] }],
      onRequestFailure() {} };
    let result: any;
    if (method === 'complete') result = await provider.complete(params);
    else for await (const event of provider.stream(params)) if (event.type === 'message_end') result = event;
    expect(result.stopReason).toBe('max_tokens');
    expect(result.incompleteToolCall).toBe(true);
    expect(result.content).toContainEqual(expect.objectContaining({ type: 'text', text: 'Analysis retained.' }));
    expect(result.content.some((block: any) => block.type === 'tool_use')).toBe(false);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_INCOMPLETE_ARGUMENT');
    expect(bodies).toHaveLength(1);
  });

  it.each(APIS.flatMap(api => (['complete', 'stream'] as const).map(method => [api, method] as const)))
  ('keeps non-length malformed arguments rejected (%s/%s)', async (api, method) => {
    const { provider, bodies, writes } = setup(api, [{ kind: 'bad', length: false }]);
    const failures: any[] = [];
    const params = { model: 'fixture', messages: [], onRequestFailure: (failure: unknown) => failures.push(failure) };
    const call = async () => {
      if (method === 'complete') return provider.complete(params);
      for await (const _event of provider.stream(params)) { /* Drain the actual SDK. */ }
    };
    await expect(call()).rejects.toThrow('Invalid tool call arguments');
    expect(writes).toEqual([]);
    expect(bodies).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ toolArguments: { code: 'tool_arguments_invalid', api,
      stop_reason: 'tool_use',
      stream_json: method === 'stream' ? 'non_strict' : 'unobserved' } });
    expect(JSON.stringify(failures)).not.toContain('PRIVATE_INCOMPLETE_ARGUMENT');
  });

  it.each(APIS)('recovers only the incomplete proposal and retains completed files after reload (%s)', async api => {
    const { root, file, runner, session, bodies, writes } = setup(api, [
      { kind: 'tool', file: 'first.txt' }, { kind: 'bad', sibling: true, text: '' },
      { kind: 'tool', text: '' }, { kind: 'text', text: 'Finished.' },
    ]);
    const events: AgentRunEvent[] = [];
    for await (const event of runner.runStream({ message: 'Write both reports.' })) events.push(event);
    const terminals = events.filter(event => event.type === 'done');
    expect(terminals).toHaveLength(1);
    const result = terminals[0].result;
    expect(result.meta.error).toBeUndefined();
    expect(result.text).toBe('Finished.');
    expect(result.meta.convergenceSignals).toContain('output_limit_continuation');
    expect(result.meta.usage.totalTokens).toBe(120);
    const calls = events.filter(event => event.type === 'provider_call');
    expect(calls).toHaveLength(4);
    expect(calls[1].output?.toolCalls).toBe(2);
    expect(bodies).toHaveLength(4);
    expect(writes).toHaveLength(2);
    expect(fs.readFileSync(path.join(root, 'first.txt'), 'utf8')).toBe('verified\n');
    expect(fs.readFileSync(path.join(root, 'report.txt'), 'utf8')).toBe('verified\n');
    expect(fs.existsSync(path.join(root, 'forbidden.txt'))).toBe(false);
    expect(JSON.stringify(bodies[2])).toContain('at or below 12000 characters');
    expect(JSON.stringify(bodies[2])).toContain('Saved first.txt');
    for (const body of bodies.slice(2)) {
      expect(JSON.stringify(body)).not.toMatch(/PRIVATE_INCOMPLETE_ARGUMENT|bad_2|sibling_2|incompleteToolCall/);
    }
    expect(new PersistentSession({ sessionFile: file }).getMessages()).toEqual(session.getMessages());
    expect(fs.readFileSync(file, 'utf8')).not.toMatch(/PRIVATE_INCOMPLETE_ARGUMENT|bad_2|sibling_2|incompleteToolCall/);
  });

  it.each(APIS.flatMap(api => [false, true].map(mixed => [api, mixed] as const)))
  ('bounds repeated and mixed truncation while preserving resumable prose (%s/mixed=%s)', async (api, mixed) => {
    const replies: Reply[] = mixed
      ? [{ kind: 'bad' }, { kind: 'text', length: true }, { kind: 'unfinished' }, { kind: 'bad' }]
      : Array.from({ length: 4 }, () => ({ kind: 'bad' }));
    const { runner, bodies, writes, file, root } = setup(api, replies);
    const result = await runner.run({ message: 'Write the report.' });
    expect(result.meta.error?.code).toBe('OUTPUT_LIMIT');
    expect(result.text).toContain('Analysis retained.');
    expect(result.meta.convergenceSignals).toContain('output_limit_unrecovered');
    expect(bodies).toHaveLength(4);
    expect(writes).toEqual([]);
    expect(fs.existsSync(path.join(root, 'report.txt'))).toBe(false);
    const restored = JSON.stringify(new PersistentSession({ sessionFile: file }).getMessages());
    expect(new PersistentSession({ sessionFile: file }).getSerializedContextState()?.activeTurn).toBeDefined();
    expect(restored).toContain('Analysis retained.');
    expect(restored).toContain('tool calls from truncated responses were NOT executed');
    expect(restored).not.toMatch(/PRIVATE_INCOMPLETE_ARGUMENT|bad_\d|unfinished_\d|incompleteToolCall/);
  });

  it.each(APIS)('honors cancellation before a recovery request without admitting any tool (%s)', async api => {
    const { runner, bodies, writes } = setup(api, [{ kind: 'bad' }]);
    const controller = new AbortController();
    let result;
    let completed = false;
    for await (const event of runner.runStream({ message: 'Write the report.', signal: controller.signal })) {
      if (event.type === 'provider_call' && event.outcome === 'completed') {
        completed = true;
        controller.abort();
      }
      if (event.type === 'done') result = event.result;
    }
    expect(completed).toBe(true);
    expect(result?.meta.aborted).toBe(true);
    expect(bodies).toHaveLength(1);
    expect(writes).toEqual([]);
  });
});
