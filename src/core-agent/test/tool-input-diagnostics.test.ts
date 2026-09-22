import { afterEach, expect, it, vi } from 'vitest';
import { ToolInputDiagnostics, toolInputDiagnostic } from '../src/providers/tool-input-diagnostics.js';
import { createPiProvider } from '../src/providers/pi-provider.js';
import { Session } from '../src/agent/session.js';
import { AgentRunner } from '../src/agent/runner.js';
import { ProviderRegistry } from '../src/providers/registry.js';
import { createConfig } from '../src/config/loader.js';
import { defineTool } from '../src/tools/base.js';
import { fileFailureForLog } from '../src/tools/file-diagnostics.js';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function completions(argumentsText?: string): Response {
  const chunks = argumentsText === undefined
    ? [{ choices: [{ index: 0, delta: { content: 'Inspected.' }, finish_reason: 'stop' }] }]
    : [
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'fixture-call', type: 'function', function: { name: 'read_files', arguments: argumentsText.slice(0, 17) } }] }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: argumentsText.slice(17) } }] }, finish_reason: 'tool_calls' }] },
    ];
  return new Response(chunks.map(chunk => `data: ${JSON.stringify({ id: 'fixture', model: 'fixture', ...chunk })}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
}

it.each([false, true])('keeps strict/partial input evidence through the real SDK and runner (partial=%s)', async partial => {
  const input = { paths: [{ path: '@skill/skill-creator},{' }] };
  const json = JSON.stringify(input);
  const wire = partial ? json.slice(0, -1) : json;
  let requests = 0;
  vi.stubGlobal('fetch', vi.fn(async () => completions(requests++ === 0 ? wire : undefined)));
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const provider = createPiProvider({ provider: 'openai', apiKey: 'fixture', customModel: {
    id: 'fixture', name: 'fixture', api: 'openai-completions', provider: 'openai', baseUrl: 'https://fixture.invalid/v1',
    reasoning: false, input: ['text'], contextWindow: 128_000, maxTokens: 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  } });
  const registry = new ProviderRegistry();
  registry.registerFactory('fixture', () => provider);
  const execute = vi.fn(async (received: Record<string, unknown>) => {
    expect(received).toEqual(input);
    expect(toolInputDiagnostic(received)).toMatchObject({
      stream_json: partial ? 'non_strict' : 'strict', tolerant_parse: partial ? 'used' : 'not_used',
    });
    return { content: 'E_SKILL_REF_INVALID: Use the advertised reference.', isError: true,
      observations: { fileFailure: { code: 'E_SKILL_REF_INVALID' as const, reason: 'skill_ref_format' as const, skill_ref_valid: false } } };
  });
  const session = new Session();
  const runner = new AgentRunner({ session, config: createConfig({ agent: { defaultProvider: 'fixture', defaultModel: 'fixture' } }), providers: registry,
    tools: [defineTool({ name: 'read_files', description: 'Read files.', inputSchema: { type: 'object' }, execute })] });
  await runner.run({ message: 'Inspect the protocol.' });
  expect(execute).toHaveBeenCalledOnce();
  expect(requests).toBe(2);
  const errors = warning.mock.calls.filter(call => call[1] === 'Tool returned error');
  expect(errors).toHaveLength(1);
  expect(errors[0][2]).toMatchObject({ input_parse: { stream_json: partial ? 'non_strict' : 'strict', tolerant_parse: partial ? 'used' : 'not_used' }, file_failure: { code: 'E_SKILL_REF_INVALID', skill_ref_valid: false } });
  expect(JSON.stringify(warning.mock.calls)).not.toContain('skill-creator');
  expect(JSON.stringify(session.getMessagesForModel())).not.toContain('tolerant_parse');
});

it('keeps snapshot transports and absent input unknown instead of claiming no repair', () => {
  const observer = new ToolInputDiagnostics(false);
  observer.start(0);
  observer.delta(0, '{"value":1}');
  const replaced = { value: 2 };
  observer.end(0, replaced);
  expect(toolInputDiagnostic(replaced)).toEqual({ stream_json: 'strict', tolerant_parse: 'unknown', parsed_input_matches: false });
  const unobserved = {};
  observer.end(1, unobserved);
  expect(toolInputDiagnostic(unobserved)).toEqual({ stream_json: 'unobserved', tolerant_parse: 'unknown' });
  const partial = {};
  observer.start(2); observer.delta(2, '{'); observer.end(2, partial);
  expect(toolInputDiagnostic(partial)).toEqual({ stream_json: 'non_strict', tolerant_parse: 'unknown' });
  // The SDK treats whitespace as absent input, without entering JSON repair.
  const completionsObserver = new ToolInputDiagnostics(true);
  completionsObserver.start(0); completionsObserver.delta(0, ' \n ');
  const empty = {}; completionsObserver.end(0, empty);
  expect(toolInputDiagnostic(empty)).toEqual({ stream_json: 'unobserved', tolerant_parse: 'unknown' });
});

it('isolates interleaved inputs and bounds large inputs, total volume and call storms', () => {
  const observer = new ToolInputDiagnostics(true);
  observer.start(0); observer.start(1);
  observer.delta(0, '{"value":'); observer.delta(1, '{"other":2}'); observer.delta(0, '1}');
  const first = { value: 1 }, second = { other: 2 };
  observer.end(1, second); observer.end(0, first);
  expect(toolInputDiagnostic(first)).toMatchObject({ stream_json: 'strict', parsed_input_matches: true });
  expect(toolInputDiagnostic(second)).toMatchObject({ stream_json: 'strict', parsed_input_matches: true });
  observer.start(2); observer.delta(2, 'x'.repeat(32_769));
  const large = {}; observer.end(2, large);
  expect(toolInputDiagnostic(large)).toEqual({ stream_json: 'limit', tolerant_parse: 'unknown' });
  for (let index = 3; index < 8; index++) {
    observer.start(index); observer.delta(index, JSON.stringify({ body: 'x'.repeat(32_700) }));
    const input = { body: 'x'.repeat(32_700) }; observer.end(index, input);
    if (index === 7) expect(toolInputDiagnostic(input)).toEqual({ stream_json: 'limit', tolerant_parse: 'unknown' });
  }
  for (let index = 8; index < 40; index++) observer.start(index);
  observer.delta(39, '{}'); const overflow = {}; observer.end(39, overflow);
  expect(toolInputDiagnostic(overflow)).toEqual({ stream_json: 'unobserved', tolerant_parse: 'unknown' });
});

it('allows only closed diagnostic facts into logs', () => {
  expect(fileFailureForLog({ code: 'E_SKILL_REF_INVALID', reason: 'skill_ref_format', stage: 'input', skill_ref_valid: false, skill_binding_found: 'secret', requested_path: '/private/secret' })).toEqual({ code: 'E_SKILL_REF_INVALID', reason: 'skill_ref_format', stage: 'input', skill_ref_valid: false });
});
