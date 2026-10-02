import { afterEach, expect, it, vi } from 'vitest';
import { createResponsesStatusDiagnostics as observe } from '../src/providers/responses-status-diagnostics.js';
import { createPiProvider } from '../src/providers/pi-provider.js';
import type { CompletionParams } from '../src/providers/base.js';
import type { MessageContent } from '../src/shared/types.js';

const model = { api: 'openai-responses', provider: 'openai', id: 'fixture' };
const item = (id = 'PRIVATE_ID', status = 'in_progress') => ({ type: 'reasoning', id, status,
  summary: [], encrypted_content: 'PRIVATE_CIPHER' });
const content = (value = item()) => [{ type: 'thinking', thinking: '', thinkingSignature: JSON.stringify(value) }];
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('distinguishes source, history and wire state without changing any stage or leaking content', () => {
  const owner = () => {};
  observe(owner, model, 1, 'a'.repeat(32))!.output(content(), 'completed');
  const next = observe(owner, model, 2, undefined)!;
  next.history(item('PRIVATE_ID', 'incomplete'));
  const wire = { input: [item('PRIVATE_ID', 'completed')] };
  const before = JSON.stringify(wire);
  next.payload(wire);
  const evidence = next.failure(0);
  expect(evidence).toMatchObject({ rows: [{ i: 0, source_status: 'in_progress',
    source_response_status: 'completed', history_status: 'incomplete', wire_status: 'completed',
    source_sequence: 1, source_request_ref: 'a'.repeat(32), same_model: true, origin: 'observed' }] });
  expect(JSON.stringify(evidence)).not.toContain('PRIVATE');
  expect(JSON.stringify(wire)).toBe(before);
});

it('marks restarted runs, duplicate identities and model changes without inventing provenance', () => {
  const owner = () => {};
  observe(owner, model, 1, undefined)!.output(content(), undefined);
  const changed = observe(owner, { ...model, id: 'other' }, 2, undefined)!;
  changed.payload({ input: [item()] });
  expect(changed.failure()).toMatchObject({ rows: [{ same_model: false, source_response_status: 'missing' }] });
  changed.history(item()); changed.history(item());
  changed.output(content(), 'completed');
  expect(changed.failure()).toMatchObject({ rows: [{ history_status: 'ambiguous', origin: 'ambiguous' }] });
  expect((changed.failure()!.rows as any[])[0]).not.toHaveProperty('source_status');
  const restarted = observe(() => {}, model, 1, undefined)!;
  restarted.history(item()); restarted.payload({ input: [item()] });
  expect(restarted.failure()).toMatchObject({ rows: [{ history_status: 'in_progress', origin: 'unobserved' }] });
});

it('bounds retained sources and signature parsing, prioritizing one exact rejection outside the prefix', () => {
  expect(observe(undefined, model, 1, undefined)).toBeUndefined();
  expect(observe(() => {}, { ...model, api: 'openai-completions' }, 1, undefined)).toBeUndefined();
  const owner = () => {};
  const source = observe(owner, model, 1, undefined)!;
  for (let i = 0; i < 257; i++) source.output(content(item(String(i))), 'completed');
  source.output([{ type: 'thinking', thinkingSignature: JSON.stringify({ ...item('oversized'), encrypted_content: 'x'.repeat(65536) }) }], 'completed');
  const next = observe(owner, model, 2, undefined)!;
  next.payload({ input: [item('0'), item('256'), item('oversized'), ...Array(9997).fill(item('PRIVATE_OTHER'))] });
  expect(next.failure(9999)).toMatchObject({ input_count: 10000, rejected_index: 9999,
    rows: [{ i: 9999, origin: 'unobserved' }, { i: 0, origin: 'unobserved' },
      { i: 1, origin: 'observed' }, { i: 2, origin: 'unobserved' }] });
});

it.each(['complete', 'stream'] as const)('retains real SDK %s provenance across serialized history and an HTTP rejection', async method => {
  const reasoning = item();
  const events = [
    { type: 'response.output_item.added', output_index: 0, item: reasoning },
    { type: 'response.output_item.done', output_index: 0, item: reasoning },
    { type: 'response.completed', response: { id: 'fixture_response', status: 'completed', output: [{ ...reasoning, status: 'completed' }] } },
  ];
  const wire: any[] = [];
  const fetch = vi.fn(async (_url: unknown, init: any) => {
    wire.push(JSON.parse(init.body));
    return wire.length === 1 ? new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
      { headers: { 'content-type': 'text/event-stream' } }) : new Response(JSON.stringify({ error: {
        type: 'invalid_request_error', param: 'input[1].status', message: 'fixture rejected state',
      } }), { status: 400, headers: { 'content-type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetch);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const provider = createPiProvider({ provider: 'openai', apiKey: 'fixture', customModel: {
    ...model, name: 'fixture', api: 'openai-responses', baseUrl: 'https://example.invalid/v1',
    reasoning: true, input: ['text'], contextWindow: 10000, maxTokens: 100,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  } });
  const failures: any[] = [];
  const params: CompletionParams = { messages: [{ role: 'user', content: [{ type: 'text', text: 'fixture' }] }],
    requestMetadata: { orkasRequestId: 'a'.repeat(32) }, onRequestFailure: failure => failures.push(failure) };
  let result: MessageContent[] = [];
  if (method === 'complete') result = (await provider.complete(params)).content;
  else for await (const event of provider.stream(params)) if (event.type === 'message_end') result = event.content!;
  expect(result.some(block => block.type === 'thinking' && !!block.thinkingSignature)).toBe(true);
  const replay = { ...params, messages: JSON.parse(JSON.stringify([...params.messages, { role: 'assistant', content: result }])),
    requestMetadata: { orkasRequestId: 'b'.repeat(32) } };
  if (method === 'complete') await expect(provider.complete(replay)).rejects.toThrow();
  else {
    const errors = [];
    for await (const event of provider.stream(replay)) if (event.type === 'error') errors.push(event);
    expect(errors).toHaveLength(1);
  }
  expect(fetch).toHaveBeenCalledTimes(2);
  const { status: _status, ...inputReasoning } = reasoning;
  expect(wire[1].input[1]).toEqual(inputReasoning);
  expect(failures).toHaveLength(1);
  expect(failures[0]).toMatchObject({ httpStatus: 400, requestSequence: 2,
    responsesStatus: { rejected_index: 1, rows: [{ i: 1, origin: 'observed', source_sequence: 1,
      source_status: 'in_progress', source_response_status: 'completed', history_status: 'in_progress',
      wire_status: 'missing', same_model: true }] } });
  expect(failures[0].responsesStatus.rows[0]).not.toHaveProperty('source_request_ref');
  expect(JSON.stringify(failures)).not.toContain('a'.repeat(32));
  expect(JSON.stringify(failures)).not.toContain('b'.repeat(32));
  expect(JSON.stringify(failures)).not.toContain('PRIVATE');
});
