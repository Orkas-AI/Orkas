import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPiProvider } from '../../../../src/core-agent/src/providers/pi-provider';
import { classifyRetryableError } from '../../../../src/core-agent/src/shared/errors';
import { createRequestDiagnostics } from '../../../../src/core-agent/src/providers/request-diagnostics';
import { buildCustomOpenAICompatibleModel, createCustomOpenAICompatibleProvider } from '../../../../src/main/model/core-agent/external-providers';
import { createRotatingProvider } from '../../../../src/main/model/core-agent/rotating-provider';
const config = { apiKey: 'synthetic', baseUrl: 'https://gateway.example.test/v1', modelId: 'gateway-alias', contextWindow: 128000, maxTokens: 1024 };
const messages = [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hello' }] }];
function success() {
  return new Response('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: config.modelId, choices: [{ index: 0, delta: { content: 'hello' }, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
}
async function failure(provider: ReturnType<typeof createPiProvider>, mode: 'complete' | 'stream', observations: any[]) {
  const params = { messages, onRequestFailure: (value: unknown) => observations.push(value) };
  if (mode === 'complete') {
    try { await provider.complete(params); } catch (error) { return error as Error; }
  } else {
    const events = []; for await (const event of provider.stream(params)) events.push(event);
    expect(events.filter(e => e.type === 'error')).toHaveLength(1);
    expect(events.some(e => e.type === 'text_delta' || e.type === 'tool_use_end')).toBe(false);
    return (events.find(e => e.type === 'error') as any).error as Error;
  }
  throw new Error('Expected a failed request');
}
afterEach(() => { vi.restoreAllMocks(); });
describe('custom Chat Completions admission and diagnostic origin', () => {
  it.each(['complete', 'stream'] as const)('keeps body-read failure codes at the request boundary in %s', async mode => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(new ReadableStream({
      pull(controller) { controller.error(new TypeError('PRIVATE body failure', { cause: { code: 'ECONNRESET' } })); },
    }, { highWaterMark: 0 }), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const provider = await createCustomOpenAICompatibleProvider(config);
    const rows: any[] = [];
    const error = await failure(provider, mode, rows);
    expect(classifyRetryableError(error)).toBe('connection_dropped');
    expect(rows).toMatchObject([{ phase: 'after_response', source: 'sdk_error', httpStatus: 200, code: 'ECONNRESET' }]);
    expect(rows).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not enrich normal cancellation or read malformed metadata on healthy calls', () => {
    const metadata = new Proxy({}, { get() { throw new Error('private metadata'); } });
    const observed = vi.fn();
    const healthy = createRequestDiagnostics(undefined, observed, metadata);
    healthy.onResponse({ status: 200 });
    expect(observed).not.toHaveBeenCalled();
    const cancelled = createRequestDiagnostics(undefined, observed, { version: 1, estimated_input_tokens: 123 });
    expect(cancelled.report(new Error('cancelled'), true)?.contextBudget).toBeUndefined();
    const broken = createRequestDiagnostics(undefined, observed, metadata);
    expect(() => broken.report(new Error('original error'))).not.toThrow();
  });
  it.each(['complete', 'stream'] as const)('keeps budget evidence off healthy %s requests and emits only safe failure metadata', async mode => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const wires: string[] = [];
    let reject = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      wires.push(String(init?.body));
      return reject ? new Response('{"error":{"code":"invalid_request_error","message":"rejected"}}', { status: 400 }) : success();
    });
    const provider = await createCustomOpenAICompatibleProvider(config);
    const rows: any[] = [];
    const params = { messages, onRequestFailure: (v: unknown) => rows.push(v), requestMetadata: {
      orkasRequestId: 'a'.repeat(32), contextBudgetDiagnostics: {
        version: 1, budget_context_window: 272000, output_reservation: 32000,
        estimated_input_tokens: 14000, compaction_before_tokens: 28000, compaction_after_tokens: 12000,
        compaction_attempts: 1, compaction_failures: 0, estimate_source: 'anchored',
        private: 'PRIVATE_CONTENT', input_ceiling_tokens: 'PRIVATE_CONTENT', emergency_result: 'PRIVATE_CONTENT',
      },
    } };
    const call = async () => {
      if (mode === 'complete') return provider.complete(params);
      const events = []; for await (const event of provider.stream(params)) events.push(event); return events;
    };
    await call();
    expect(rows).toEqual([]);
    expect(warnings).not.toHaveBeenCalled();
    reject = true;
    await call().catch(() => {});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ httpStatus: 400, contextBudget: {
      version: 1, budget_context_window: 272000, output_reservation: 32000, estimated_input_tokens: 14000,
      compaction_before_tokens: 28000, compaction_after_tokens: 12000, compaction_attempts: 1,
      compaction_failures: 0, estimate_source: 'anchored',
    } });
    // The public SDK adapter deliberately omits hosted request correlation ids.
    expect(rows[0]).not.toHaveProperty('requestRef');
    expect(JSON.stringify(rows)).not.toContain('PRIVATE');
    expect(wires).toHaveLength(2);
    expect(wires.every(wire => !wire.includes('contextBudgetDiagnostics') && !wire.includes('estimated_input_tokens'))).toBe(true);
  });
  it.each(['complete', 'stream'] as const)('admits incremental request shapes through the real SDK %s adapter', async mode => {
    const wires: any[] = [];
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => { wires.push(JSON.parse(String(init?.body))); return success(); });
    const tool = { name: 'read_fixture', description: 'Read a fixture', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false } };
    for (const shape of ['minimal', 'system', 'tools', 'reasoning'] as const) {
      const reasoning = shape === 'reasoning';
      const provider = await createCustomOpenAICompatibleProvider({ ...config, ...(reasoning ? { supportsReasoning: true, reasoningEffort: 'medium' as const } : {}) });
      const params = { messages, ...(shape !== 'minimal' ? { systemPrompt: 'Synthetic system' } : {}), ...(['tools', 'reasoning'].includes(shape) ? { tools: [tool] } : {}), ...(reasoning ? { maxTokens: 512 } : {}) };
      if (mode === 'complete') expect((await provider.complete(params)).content).toContainEqual({ type: 'text', text: 'hello' });
      else { const events = []; for await (const event of provider.stream(params)) events.push(event); expect(events.filter(e => e.type === 'error')).toHaveLength(0); expect(events.filter(e => e.type === 'message_end')).toHaveLength(1); }
      const wire = wires.at(-1);
      expect(wire.model).toBe(config.modelId); expect(wire.stream).toBe(true);
      for (const key of ['store', 'prompt_cache_retention', 'max_tokens']) expect(wire).not.toHaveProperty(key);
      expect(wire.messages.some((m: any) => m.role === 'developer')).toBe(false);
      if (shape !== 'minimal') expect(wire.messages[0]).toMatchObject({ role: 'system', content: 'Synthetic system' });
      if (wire.tools) { expect(wire.tools[0].function.parameters).toEqual(tool.inputSchema); expect(wire.tools[0].function).not.toHaveProperty('strict'); }
      if (reasoning) expect(wire).toMatchObject({ reasoning_effort: 'medium', max_completion_tokens: 512 });
      else expect(wire).not.toHaveProperty('reasoning_effort');
    }
    expect(fetch).toHaveBeenCalledTimes(4);
  });
  for (const mode of ['complete', 'stream'] as const) {
    it(`keeps concurrent payload failures isolated from a healthy ${mode} call`, async () => {
      let rejectPayload!: (error: Error) => void;
      const blockedPayload = new Promise<never>((_resolve, reject) => { rejectPayload = reject; });
      const hook = vi.fn().mockImplementationOnce(() => blockedPayload).mockImplementation(payload => payload);
      const provider = createPiProvider({
        provider: 'custom', apiKey: config.apiKey,
        customModel: buildCustomOpenAICompatibleModel(config.modelId, config), onPayload: hook,
      });
      const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => success());
      const failedObservations: any[] = [];
      const failedCall = failure(provider, mode, failedObservations);
      await vi.waitFor(() => expect(hook).toHaveBeenCalledTimes(1));
      const healthyObservations: any[] = [];
      const params = { messages, onRequestFailure: (value: unknown) => healthyObservations.push(value) };
      if (mode === 'complete') {
        expect((await provider.complete(params)).content).toContainEqual({ type: 'text', text: 'hello' });
      } else {
        const events = [];
        for await (const event of provider.stream(params)) events.push(event);
        expect(events.filter(event => event.type === 'message_end')).toHaveLength(1);
        expect(events.filter(event => event.type === 'error')).toHaveLength(0);
      }
      rejectPayload(new ReferenceError('require is not defined'));
      await failedCall;
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(healthyObservations).toEqual([]);
      expect(failedObservations).toMatchObject([{
        phase: 'before_request', code: 'REFERENCE_ERROR', elapsedMs: expect.any(Number), aborted: false,
      }]);
    });
    it.each(['reference', 'permission'] as const)(`distinguishes local payload failure from identical upstream error text on ${mode}: %s`, async kind => {
      const original = kind === 'reference' ? new ReferenceError('require is not defined') : Object.assign(new Error("EPERM: open 'private-canary'"), { code: 'EPERM', path: 'private-canary' });
      const code = kind === 'reference' ? 'REFERENCE_ERROR' : 'EPERM';
      const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(`data: ${JSON.stringify({ error: { message: original.message } })}\n\n`, { headers: { 'content-type': 'text/event-stream' } }));
      const local = createPiProvider({ provider: 'custom', apiKey: config.apiKey, customModel: buildCustomOpenAICompatibleModel(config.modelId, config), onPayload: async () => { throw original; } });
      const localFailures: any[] = []; const localError = await failure(local, mode, localFailures);
      expect(fetch).not.toHaveBeenCalled();
      expect(localFailures).toMatchObject([{ phase: 'before_request', source: 'payload', lastEvent: 'none', code, elapsedMs: expect.any(Number), aborted: false }]);
      const remoteFailures: any[] = []; const remoteError = await failure(await createCustomOpenAICompatibleProvider(config), mode, remoteFailures);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(remoteFailures).toMatchObject([{ phase: 'after_response', source: 'sdk_error', httpStatus: 200, code: 'unknown', elapsedMs: expect.any(Number), aborted: false }]);
      expect(remoteError.message).toBe(localError.message);
      // Observation must not become a retry classifier or inject a cause.
      expect(classifyRetryableError(remoteError)).toBe(classifyRetryableError(localError));
      expect(JSON.stringify([localFailures, remoteFailures])).not.toContain('private-canary');
    });
    it(`retains a structured transport permission failure on ${mode} without guessing from prose`, async () => {
      const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(Object.assign(new Error('private-canary'), { code: 'EPERM' }));
      const failures: any[] = []; await failure(await createCustomOpenAICompatibleProvider(config), mode, failures);
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(failures).toMatchObject([{ phase: 'before_response', source: 'transport', lastEvent: 'none', code: 'EPERM', elapsedMs: expect.any(Number), aborted: false }]);
    });
    it(`keeps an HTTP parameter rejection separate from local failures on ${mode}`, async () => {
      const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ error: { message: 'Unsupported parameter', type: 'invalid_request_error' } }, { status: 400 }));
      const failures: any[] = []; const error = await failure(await createCustomOpenAICompatibleProvider(config), mode, failures);
      expect(error).toMatchObject({ statusCode: 400 }); expect(classifyRetryableError(error)).toBeNull(); expect(fetch).toHaveBeenCalledTimes(1);
      expect(failures).toMatchObject([{ phase: 'after_response', source: 'http', httpStatus: 400, code: 'invalid_request_error', elapsedMs: expect.any(Number), aborted: false }]);
    });
  }
  it('does not diagnose local exception types from upstream text or arbitrary names/codes', () => {
    for (const error of [new Error('require is not defined'), { name: 'ReferenceError', message: 'private-canary', code: 'private-canary' }, { get code() { throw new Error('private-canary'); } }]) {
      const observed = createRequestDiagnostics().report(error);
      expect(observed).toMatchObject({ phase: 'unknown', code: 'unknown' }); expect(JSON.stringify(observed)).not.toContain('private-canary');
    }
  });
  it('preserves a synchronous payload exception and bounds observation even with a broken observer', async () => {
    const controller = new AbortController();
    const observer = vi.fn(() => { throw new Error('observer-private-canary'); });
    const diagnostics = createRequestDiagnostics(controller.signal, observer);
    const original = Object.assign(new Error('private-canary'), { code: 'EACCES' });
    await expect(diagnostics.observePayload(() => { throw original; })).rejects.toBe(original);
    controller.abort();
    expect(diagnostics.report(new Error('flattened'))).toMatchObject({
      phase: 'before_request', code: 'EACCES', aborted: true,
    });
    expect(diagnostics.report(original)).toBeUndefined();
    expect(observer).toHaveBeenCalledTimes(1);
  });
});

describe('bounded failure boundary evidence', () => {
  it.each([
    'ERR_EMPTY_RESPONSE', 'ERR_SSL_PROTOCOL_ERROR', 'ERR_CONNECTION_CLOSED',
    'ERR_CONNECTION_RESET', 'ERR_CONNECTION_REFUSED', 'ERR_CONNECTION_TIMED_OUT',
    'ERR_TIMED_OUT', 'ERR_NAME_NOT_RESOLVED', 'ERR_INTERNET_DISCONNECTED',
    'ERR_NETWORK_CHANGED', 'ERR_PROXY_CONNECTION_FAILED', 'ERR_TUNNEL_CONNECTION_FAILED',
    'ERR_CERT_AUTHORITY_INVALID', 'ERR_CERT_DATE_INVALID', 'ERR_CERT_COMMON_NAME_INVALID',
  ])('retains the native Chromium transport receipt for %s without changing the exception', async code => {
    const original = new Error(`net::${code}`);
    const diagnostics = createRequestDiagnostics();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(original);
    await expect(diagnostics.requestFetch('https://fixture.invalid')).rejects.toBe(original);
    const receipt = diagnostics.report(new Error('SDK flattened the transport failure'))!;
    expect(receipt).toMatchObject({ phase: 'before_response', source: 'transport', code });
    expect(receipt).not.toHaveProperty('httpStatus');
    expect(original).not.toHaveProperty('code');
  });

  it.each([
    new Error('request failed: net::ERR_SSL_PROTOCOL_ERROR'),
    new Error('net::ERR_SSL_PROTOCOL_ERROR private-canary'),
    new Error('net::ERR_UNREGISTERED_PRIVATE_CODE'),
    Object.assign(new Error('net::ERR_SSL_PROTOCOL_ERROR'), { name: 'AbortError' }),
    { message: 'net::ERR_SSL_PROTOCOL_ERROR' },
  ])('keeps look-alikes and cancellations out of native transport diagnostics (%#)', async original => {
    const diagnostics = createRequestDiagnostics();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(original);
    await expect(diagnostics.requestFetch('https://fixture.invalid')).rejects.toBe(original);
    expect(diagnostics.report(original)).toMatchObject({ code: 'unknown', source: 'transport' });
  });

  it('preserves structured codes and rejects native-looking payload errors', async () => {
    const original = Object.assign(new Error('net::ERR_SSL_PROTOCOL_ERROR'), { code: 'ETIMEDOUT' });
    const transport = createRequestDiagnostics();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(original);
    await expect(transport.requestFetch('https://fixture.invalid')).rejects.toBe(original);
    expect(transport.report(original)).toMatchObject({ code: 'ETIMEDOUT' });
    const payload = createRequestDiagnostics();
    const payloadError = new Error('net::ERR_SSL_PROTOCOL_ERROR');
    await expect(payload.observePayload(() => { throw payloadError; })).rejects.toBe(payloadError);
    expect(payload.report(payloadError)).toMatchObject({ code: 'unknown', source: 'payload' });
  });

  it.each(['openai-responses', 'openai-completions'] as const)
  ('retains Chromium diagnostics through the real %s SDK without expanding retries', async api => {
    const original = new Error('net::ERR_SSL_PROTOCOL_ERROR');
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(original);
    const provider = createRotatingProvider({ providerId: 'custom', networkRetryAttempts: 1,
      networkRetryDelayMs: () => 0, candidates: [{ profileId: 'chromium-fixture',
        providerId: 'custom', modelId: 'fixture', build: async () => createPiProvider({
          provider: 'custom', apiKey: 'synthetic', customModel: {
            id: 'fixture', name: 'fixture', api, provider: 'custom',
            baseUrl: 'https://fixture.invalid/v1', reasoning: false, input: ['text'],
            contextWindow: 128000, maxTokens: 1024,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        }) }],
    });
    const observations: any[] = [];
    const events: string[] = [];
    const run = async () => {
      for await (const event of provider.stream({ messages,
        onRequestFailure: receipt => observations.push(receipt),
      })) events.push(event.type);
    };
    await expect(run()).rejects.toMatchObject({ code: 'PROVIDER_RETRIES_EXHAUSTED' });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(events).toEqual(['retry']);
    expect(observations).toMatchObject([
      { code: 'ERR_SSL_PROTOCOL_ERROR', source: 'transport', phase: 'before_response' },
      { code: 'ERR_SSL_PROTOCOL_ERROR', source: 'transport', phase: 'before_response' },
    ]);
    expect(original).not.toHaveProperty('code');
  });

  it('records the last tool event and request sequence without guessing an SDK error origin', async () => {
    const provider = await createCustomOpenAICompatibleProvider(config);
    const observations: any[] = [];
    const onRequestFailure = (value: unknown) => observations.push(value);
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(
      'data: ' + JSON.stringify({ id: 'fixture', choices: [{ index: 0, delta: {
        tool_calls: [{ index: 0, id: 'private-call', type: 'function', function: { name: 'private-tool', arguments: '{"secret":' } }],
      }, finish_reason: null }] }) + '\n\ndata: ' + JSON.stringify({ error: { message: 'Upstream request failed' } }) + '\n\n',
      { headers: { 'content-type': 'text/event-stream' } },
    ));
    fetch.mockResolvedValueOnce(success());
    await provider.complete({ messages, onRequestFailure });
    expect(observations).toEqual([]);
    for (let attempt = 2; attempt <= 3; attempt++) {
      const events = [];
      for await (const event of provider.stream({ messages, onRequestFailure })) events.push(event);
      expect(events.some(event => event.type === 'tool_use_start')).toBe(true);
      expect(events.filter(event => event.type === 'error')).toHaveLength(1);
      expect(events.some(event => event.type === 'message_end')).toBe(false);
      expect(observations.at(-1)).toMatchObject({ source: 'sdk_error', lastEvent: 'toolcall_delta',
        requestSequence: attempt, phase: 'after_response', httpStatus: 200 });
    }
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(observations).toHaveLength(2);
    expect(JSON.stringify(observations)).not.toMatch(/private|secret|Upstream/);
  });

  it('isolates concurrent sequence scopes and preserves the captured transport boundary', async () => {
    const failures: any[] = [];
    const observer = (value: unknown) => failures.push(value);
    const first = createRequestDiagnostics(undefined, observer);
    const second = createRequestDiagnostics(undefined, observer);
    const other = createRequestDiagnostics(undefined, () => {});
    const original = Object.assign(new Error('private-canary'), { code: 'ECONNRESET' });
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(original);
    await expect(first.requestFetch('https://fixture.invalid')).rejects.toBe(original);
    const secondResult = second.report(new Error('flattened'));
    const firstResult = first.report(new Error('flattened'));
    expect(firstResult).toMatchObject({ source: 'transport', lastEvent: 'none', requestSequence: 1, code: 'ECONNRESET' });
    expect(secondResult).toMatchObject({ source: 'unknown', requestSequence: 2 });
    expect(other.report(null)).toMatchObject({ requestSequence: 1 });
    expect(first.report(original)).toBeUndefined();
    expect(failures).toHaveLength(2);
  });
});
