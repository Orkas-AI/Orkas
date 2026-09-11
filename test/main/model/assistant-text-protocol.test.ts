import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Model } from '@earendil-works/pi-ai';
import { mapCoreAgentEvents } from '../../../src/main/model/core-agent/event-mapper';

type Protocol = 'responses' | 'responses-unphased' | 'chat' | 'anthropic';
const PROGRESS = ['先检查当前实现。', '检查完成，继续验证结果。'];
const FINAL = '验证完成。';

// Exercise the real SDK SSE parser, provider adapter, runner, persistence and
// host event mapper. Only the HTTP peer and the bounded task tool are fixtures.
function responseEvents(round: number, phased: boolean): Record<string, unknown>[] {
  const text = PROGRESS[round] ?? FINAL;
  const message = {
    type: 'message', id: `msg_round_${round}`, role: 'assistant', status: 'completed',
    ...(phased ? { phase: round < 2 ? 'commentary' : 'final_answer' } : {}),
    content: [{ type: 'output_text', text, annotations: [] }],
  };
  const tool = {
    type: 'function_call', id: `fc_round_${round}`, call_id: `call_round_${round}`,
    name: 'verify_step', arguments: JSON.stringify({ step: round }), status: 'completed',
  };
  const events: Record<string, unknown>[] = [
    { type: 'response.created', response: { id: `resp_round_${round}`, status: 'in_progress' } },
    { type: 'response.output_item.added', output_index: 0, item: { ...message, content: [], status: 'in_progress' } },
    { type: 'response.output_text.delta', output_index: 0, item_id: message.id, content_index: 0, delta: text.slice(0, 3) },
    { type: 'response.output_text.delta', output_index: 0, item_id: message.id, content_index: 0, delta: text.slice(3) },
  ];
  if (phased) events.push({ type: 'response.output_item.done', output_index: 0, item: message });
  if (round < 2) events.push(
    { type: 'response.output_item.added', output_index: 1, item: { ...tool, arguments: '', status: 'in_progress' } },
    { type: 'response.function_call_arguments.delta', output_index: 1, item_id: tool.id, delta: tool.arguments },
  );
  // The Server's Chat-to-Responses adapter closes message items after streaming
  // the tool arguments. Preserve this different, supported boundary ordering.
  if (!phased) events.push({ type: 'response.output_item.done', output_index: 0, item: message });
  if (round < 2) events.push({ type: 'response.output_item.done', output_index: 1, item: tool });
  events.push({
    type: 'response.completed',
    response: { id: `resp_round_${round}`, status: 'completed', output: round < 2 ? [message, tool] : [message],
      usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 } },
  });
  return events;
}

function wireReply(protocol: Protocol, round: number): Response {
  const text = PROGRESS[round] ?? FINAL;
  let events: Record<string, unknown>[];
  if (protocol.startsWith('responses')) {
    events = responseEvents(round, protocol === 'responses');
  } else if (protocol === 'anthropic') {
    events = [
      { type: 'message_start', message: { id: `msg_round_${round}`, type: 'message', role: 'assistant', model: 'protocol-fixture', content: [], usage: { input_tokens: 100, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
      { type: 'content_block_stop', index: 0 },
      ...(round < 2 ? [
        { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: `call_round_${round}`, name: 'verify_step', input: {} } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ step: round }) } },
        { type: 'content_block_stop', index: 1 },
      ] : []),
      { type: 'message_delta', delta: { stop_reason: round < 2 ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 20 } },
      { type: 'message_stop' },
    ];
  } else {
    events = [
      { id: `chatcmpl_${round}`, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] },
      { id: `chatcmpl_${round}`, choices: [{ index: 0, delta: round < 2 ? { tool_calls: [{ index: 0, id: `call_round_${round}`, type: 'function', function: { name: 'verify_step', arguments: JSON.stringify({ step: round }) } }] } : {}, finish_reason: round < 2 ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } },
    ];
  }
  const sse = events.map((event) => `${event.type ? `event: ${event.type}\n` : ''}data: ${JSON.stringify(event)}\n\n`).join('')
    + (protocol === 'chat' ? 'data: [DONE]\n\n' : '');
  const bytes = new TextEncoder().encode(sse);
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      // Includes splits inside UTF-8 text, SSE fields, JSON and tool arguments.
      for (let offset = 0; offset < bytes.length; offset += 11) controller.enqueue(bytes.slice(offset, offset + 11));
      controller.close();
    },
  }), { headers: { 'content-type': 'text/event-stream' } });
}

afterEach(() => vi.unstubAllGlobals());

describe('assistant prose across the provider protocol', () => {
  it.each<Protocol>(['responses', 'responses-unphased', 'chat', 'anthropic'])(
    'keeps %s progress visible before tools, continues execution and preserves replay metadata',
    async (protocol) => {
      const { AgentRunner, PersistentSession, ProviderRegistry, createConfig, createPiProvider, defineTool } = await import('#core-agent');
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-prose-protocol-'));
      try {
        const sessionFile = path.join(dir, 'session.jsonl');
        const requests: any[] = [];
        const delivered: Array<{ text: string; phase?: string }> = [];
        const executed: number[] = [];
        const providerId = protocol === 'anthropic' ? 'anthropic' : 'openai';
        const api = protocol === 'anthropic' ? 'anthropic-messages'
          : protocol === 'chat' ? 'openai-completions' : 'openai-responses';
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const raw = input instanceof Request ? await input.clone().text() : String(init?.body);
          requests.push(JSON.parse(raw));
          if (requests.length > 3) throw new Error('Unexpected extra provider round');
          return wireReply(protocol, requests.length - 1);
        }));
        const model: Model<any> = {
          id: 'protocol-fixture', name: 'Protocol fixture', api, provider: providerId,
          baseUrl: 'https://protocol.invalid/v1', reasoning: false, input: ['text'],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 128_000, maxTokens: 4096,
        };
        const provider = createPiProvider({ provider: providerId, apiKey: 'fixture-only', customModel: model });
        const providers = new ProviderRegistry();
        providers.registerFactory(providerId, () => provider);
        const tool = defineTool({
          name: 'verify_step', description: 'Verify one bounded task step',
          inputSchema: { type: 'object', properties: { step: { type: 'integer' } }, required: ['step'] },
          async execute(input) {
            const step = Number(input.step);
            expect(delivered.filter((part) => part.phase === 'commentary').map((part) => part.text).join(''))
              .toBe(PROGRESS.slice(0, step + 1).join(''));
            executed.push(step);
            fs.writeFileSync(path.join(dir, `step-${step}.txt`), 'verified');
            return { content: 'Step verified' };
          },
        });
        const session = new PersistentSession({ sessionFile });
        const runner = new AgentRunner({
          config: createConfig({ agent: { defaultProvider: providerId, defaultModel: model.id }, evolution: { enabled: false } }),
          providers, session, tools: [tool], isToolActive: (name) => name === tool.name,
        });
        const events: any[] = [];
        for await (const event of mapCoreAgentEvents(runner.runStream({ message: '检查实现并验证结果。' }), { failureTrackingScope: {} })) {
          events.push(event);
          if (event.type === 'delta') delivered.push({ text: event.text!, phase: event.phase });
        }
        expect(events.filter((event) => event.type === 'error')).toEqual([]);
        expect(executed).toEqual([0, 1]);
        expect(fs.readFileSync(path.join(dir, 'step-1.txt'), 'utf8')).toBe('verified');
        expect(requests).toHaveLength(3);
        expect(events.filter((event) => event.type === 'final')).toEqual([{ type: 'final', text: FINAL }]);
        expect(delivered.filter((part) => part.phase === 'final_answer').map((part) => part.text).join('')).toBe(FINAL);
        const restored = new PersistentSession({ sessionFile });
        const textBlocks = restored.getMessages().filter((message) => message.role === 'assistant')
          .flatMap((message) => message.content).filter((block) => block.type === 'text');
        expect(textBlocks.map((block) => block.text)).toEqual([...PROGRESS, FINAL]);
        if (protocol === 'responses') {
          // Assert the actual outbound API payload, not a signature-parser helper.
          const replayed = requests[2].input.filter((item: any) => item.type === 'message' && item.role === 'assistant');
          expect(replayed.map((item: any) => ({ id: item.id, phase: item.phase }))).toEqual([
            { id: 'msg_round_0', phase: 'commentary' },
            { id: 'msg_round_1', phase: 'commentary' },
          ]);
          expect(textBlocks.map((block) => JSON.parse(block.textSignature!).phase))
            .toEqual(['commentary', 'commentary', 'final_answer']);
        } else if (protocol === 'responses-unphased') {
          expect(requests[2].input.filter((item: any) => item.role === 'assistant').every((item: any) => item.phase === undefined)).toBe(true);
        }
        const userItems = requests.flatMap((request) => request.input ?? request.messages ?? []).filter((item: any) => item.role === 'user');
        expect(userItems.every((item: any) => item.phase === undefined)).toBe(true);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
