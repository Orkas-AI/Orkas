import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getBuiltinModel } from '@earendil-works/pi-ai/providers/all';
import { createPiProvider, buildPiContextForTest } from '../src/providers/pi-provider.js';
import { createApplyPatchTool } from '../src/tools/apply-patch.js';
import { toToolDefinition } from '../src/tools/base.js';
import { AgentRunner } from '../src/agent/runner.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { createConfig } from '../src/config/loader.js';
import { PersistentSession } from '../src/agent/persistent-session.js';
import type { Message, StreamEvent } from '../src/shared/types.js';

const patch = '*** Begin Patch\n*** Add File: quoted.txt\n+const text = "你好\\world";\n+\n*** End Patch';
const item = { type: 'custom_tool_call', id: 'ctc_patch', call_id: 'call_patch', name: 'apply_patch', input: patch };
const roots: string[] = [];
const fakeToken = `test.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'fixture' } })).toString('base64url')}.test`;
const tool = createApplyPatchTool();
const start: Message[] = [{ role: 'user', content: [{ type: 'text', text: 'Create the text file.' }] }];
function directory() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orkas-patch-provider-'));
  roots.push(root);
  return root;
}
function response(terminal = true, input = patch, native = true) {
  const outputItem = native ? { ...item, input } : { type: 'function_call', id: 'fc_patch', call_id: item.call_id, name: item.name, arguments: JSON.stringify({ patch: input }) };
  const events: unknown[] = [
    { type: 'response.output_item.added', output_index: 0, item: native ? { ...item, input: '' } : { ...outputItem, arguments: '' } },
    ...(native ? [input.slice(0, 55), input.slice(55)] : [JSON.stringify({ patch: input })]).map(delta => ({ type: native ? 'response.custom_tool_call_input.delta' : 'response.function_call_arguments.delta', output_index: 0, delta })),
  ];
  if (terminal) events.push(
    ...(native ? [{ type: 'response.custom_tool_call_input.done', output_index: 0, input }] : []),
    { type: 'response.output_item.done', output_index: 0, item: outputItem },
    { type: 'response.completed', response: { id: 'resp_patch', status: 'completed', output: [outputItem], usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 } } },
  );
  return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('native patch input through the real provider SDK', () => {
  it.each([
    ['openai', 'complete'], ['openai', 'stream'],
    ['openai-codex', 'complete'], ['openai-codex', 'stream'],
  ] as const)('executes intact input and replays durable calls/results on %s / %s', async (providerId, method) => {
    const requests: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      return response(true, patch, requests.at(-1)?.tools?.[0]?.type === 'custom');
    }));
    const provider = createPiProvider({ provider: providerId, model: 'gpt-5.5', apiKey: fakeToken, onPayload: payload => { requests.push(structuredClone(payload)); } });
    const params = { model: 'gpt-5.5', messages: start, tools: [toToolDefinition(tool)] };
    let content: Message['content'];
    if (method === 'complete') content = (await provider.complete(params)).content;
    else {
      const events: StreamEvent[] = [];
      for await (const event of provider.stream(params)) events.push(event);
      const final = events.find(event => event.type === 'message_end');
      expect(final?.type).toBe('message_end');
      content = final!.type === 'message_end' ? final!.content! : [];
      const deltas = events.flatMap(event => event.type === 'tool_use_delta' ? [event.input] : []);
      expect(JSON.parse(deltas.join(''))).toEqual({ patch });
      expect(events.filter(event => event.type === 'tool_use_end')).toHaveLength(1);
    }
    expect(requests[0].tools).toEqual([expect.objectContaining({ type: 'custom', name: 'apply_patch', format: expect.objectContaining({ type: 'grammar' }) })]);
    expect(content).toEqual([{ type: 'tool_use', id: 'call_patch|ctc_patch', name: 'apply_patch', input: { patch } }]);
    const root = directory();
    const result = await tool.execute(content[0].type === 'tool_use' ? content[0].input : {}, { workingDir: root, state: {} });
    expect(result.isError).toBeUndefined();
    expect(fs.readFileSync(path.join(root, 'quoted.txt'), 'utf8')).toBe('const text = "你好\\world";\n\n');
    const sessionFile = path.join(root, 'session.jsonl');
    const session = new PersistentSession({ sessionFile });
    session.beginUserTurn(start[0].content);
    session.addAssistantMessage(content);
    session.addToolResult('call_patch|ctc_patch', result.content);
    const reloaded = new PersistentSession({ sessionFile });
    const history = reloaded.getMessagesForModel();
    await provider.complete({ ...params, messages: history });
    const replay = requests[1].input;
    expect(replay.find((row: any) => row.type === 'custom_tool_call')).toMatchObject({ call_id: 'call_patch', name: 'apply_patch', input: patch });
    expect(replay.find((row: any) => row.type === 'custom_tool_call_output')).toMatchObject({ call_id: 'call_patch', output: result.content });
    // No function-only item identifier may be sent for a custom call.
    const replayId = replay.find((row: any) => row.type === 'custom_tool_call').id;
    expect(replayId === undefined || replayId === 'ctc_patch').toBe(true);
    expect(reloaded.getMessagesForModel()).toEqual(history);

    // Model rotation must turn both halves back into ordinary function items.
    const fallback = createPiProvider({ provider: providerId, apiKey: fakeToken,
      customModel: { ...getBuiltinModel(providerId, 'gpt-5.5'), compat: { supportsOpenAIGrammarTools: false } },
      onPayload: payload => { requests.push(structuredClone(payload)); } });
    await fallback.complete({ ...params, messages: history });
    expect(requests[2].tools[0].type).toBe('function');
    expect(requests[2].input.find((row: any) => row.type === 'function_call').arguments).toBe(JSON.stringify({ patch }));
    expect(requests[2].input.find((row: any) => row.type === 'function_call_output').call_id).toBe('call_patch');
  });

  it.each([false, true])('keeps a deferred patch at its original insertion (additional tools=%s)', async supportsAdditionalTools => {
    const requests: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => { requests.push(JSON.parse(typeof init.body === 'string' ? init.body : new TextDecoder().decode(init.body))); return response(); }));
    const provider = createPiProvider({ provider: 'openai', apiKey: fakeToken,
      customModel: { ...getBuiltinModel('openai', 'gpt-5.5'), compat: { supportsOpenAIGrammarTools: true, supportsToolSearch: true, supportsAdditionalTools } } });
    const tools = [{ name: 'tool_load', description: 'Load tools.', inputSchema: { type: 'object' } }, toToolDefinition(tool)];
    const messages: Message[] = [...start,
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call_load', name: 'tool_load', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'call_load', content: 'Loaded.', addedToolNames: ['apply_patch'] }] },
    ];
    await provider.complete({ model: 'gpt-5.5', messages, tools });
    const receipt = requests[0].input.find((row: any) => row.type === (supportsAdditionalTools ? 'additional_tools' : 'tool_search_output'));
    expect(receipt.tools).toEqual([expect.objectContaining({ type: 'custom', name: 'apply_patch' })]);
    expect(requests[0].tools.some((row: any) => row.name === 'apply_patch')).toBe(false);
    await provider.complete({ model: 'gpt-5.5', messages, tools: tools.slice(0, 1) });
    expect(JSON.stringify(requests[1])).not.toContain('"type":"custom"');
  });

  it('does not deliver executable completed content from an interrupted native input', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => response(false)));
    const provider = createPiProvider({ provider: 'openai', model: 'gpt-5.5', apiKey: fakeToken });
    const events: StreamEvent[] = [];
    for await (const event of provider.stream({ model: 'gpt-5.5', messages: start, tools: [toToolDefinition(tool)] })) events.push(event);
    expect(events.some(event => event.type === 'message_end')).toBe(false);
    expect(events.some(event => event.type === 'error')).toBe(true);
    expect(warning).toHaveBeenCalled();
  });

  it.each(['success', 'malformed', 'aborted'] as const)('uses the ordinary runner transaction without duplicate effects: %s', async scenario => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const root = directory();
    const abort = new AbortController();
    let requests = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      requests++;
      if (requests === 1) {
        if (scenario === 'aborted') abort.abort();
        return response(scenario !== 'aborted', scenario === 'malformed' ? '*** Begin Patch\nnot a patch\n*** End Patch' : patch);
      }
      const final = { type: 'message', id: 'msg_final', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Done.', annotations: [] }] };
      return new Response([
        { type: 'response.output_item.done', output_index: 0, item: final },
        { type: 'response.completed', response: { id: 'resp_final', status: 'completed', output: [final] } },
      ].map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
    }));
    const provider = createPiProvider({ provider: 'openai', model: 'gpt-5.5', apiKey: fakeToken });
    const registry = new ProviderRegistry();
    registry.registerFactory('patch-fixture', () => provider);
    const execute = vi.spyOn(tool, 'execute');
    const runner = new AgentRunner({
      config: createConfig({ agent: { defaultProvider: 'patch-fixture', defaultModel: 'gpt-5.5', maxRetries: 0 } }),
      providers: registry, tools: [tool], evolution: { enabled: false },
    });
    const result = await runner.run({ message: 'Create the text file.', workingDir: root, signal: abort.signal });
    expect(execute).toHaveBeenCalledTimes(scenario === 'aborted' ? 0 : 1);
    expect(fs.existsSync(path.join(root, 'quoted.txt'))).toBe(scenario === 'success');
    if (scenario === 'success') {
      expect(result.text).toBe('Done.');
      expect(fs.readFileSync(path.join(root, 'quoted.txt'), 'utf8')).toBe('const text = "你好\\world";\n\n');
    }
    if (scenario === 'malformed') {
      expect((await execute.mock.results[0].value).isError).toBe(true);
      expect(warning).toHaveBeenCalledExactlyOnceWith('[agent-runner]', 'Tool returned error', expect.objectContaining({
        tool: 'apply_patch', file_failure: expect.objectContaining({ code: 'E_PATCH_FORMAT', stage: 'parse' }),
      }));
    }
    if (scenario === 'aborted') expect(requests).toBe(1);
    if (scenario === 'success') expect(warning).not.toHaveBeenCalled();
  });

  it('retains the JSON tool on non-Responses routes', () => {
    const definition = toToolDefinition(tool);
    for (const api of ['openai-completions', 'anthropic-messages', 'google-generative-ai'] as const) {
      const context = buildPiContextForTest(start, undefined, [definition], { ...getBuiltinModel('openai', 'gpt-5.5'), api } as any);
      expect(context.tools?.[0].constrainedSampling).toBeUndefined();
      expect(context.tools?.[0].parameters).toMatchObject({ required: ['patch'], properties: { patch: { type: 'string' } } });
    }
    const undeclared = buildPiContextForTest(start, undefined, [definition], {
      api: 'openai-responses', provider: 'custom', id: 'gpt-5.5',
    });
    expect(undeclared.tools?.[0].constrainedSampling).toBeUndefined();
  });
});
