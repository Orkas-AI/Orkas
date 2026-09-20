import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCustomOutputLimitCompatibility } from '../../../../src/main/model/core-agent/custom-output-limit';
import { createCustomOpenAICompatibleProvider } from '../../../../src/main/model/core-agent/external-providers';

let serial = 0;
function config() { return { apiKey: `synthetic-${++serial}`, baseUrl: 'https://gateway.example.test/v1', modelId: 'gateway-alias', contextWindow: 128000, maxTokens: 1024 }; }
function rejection(param = 'max_completion_tokens', status = 400, code = 'unsupported_parameter') {
  return Response.json({ error: { code, param, message: 'synthetic rejection' } }, { status });
}
function request(body: Record<string, unknown>, signal?: AbortSignal) {
  return { method: 'POST', body: JSON.stringify(body), headers: { authorization: 'Bearer synthetic', 'content-type': 'application/json' }, signal };
}
const body = { model: 'gateway-alias', max_completion_tokens: 512, messages: [{ role: 'user', content: 'synthetic input' }], stream: true };
function success() {
  const chunk = (delta: unknown, finish_reason: string | null) => ({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'gateway-alias', choices: [{ index: 0, delta, finish_reason }] });
  return new Response([chunk({ role: 'assistant', content: 'hello' }, null), chunk({}, 'stop')].map(value => `data: ${JSON.stringify(value)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
}
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('custom output limit negotiation', () => {
  it.each(['complete', 'stream', 'validateAuth'] as const)('negotiates once through the real SDK %s path and reuses the field on a rebuilt provider', async mode => {
    const wires: any[] = [];
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const wire = JSON.parse(String(init?.body)); wires.push(wire);
      return wire.max_completion_tokens !== undefined ? rejection() : success();
    });
    const c = config();
    for (let run = 0; run < 2; run++) {
      const provider = await createCustomOpenAICompatibleProvider(c);
      const params = { model: c.modelId, maxTokens: 512, messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hello' }] }] };
      if (mode === 'complete') expect((await provider.complete(params)).content).toContainEqual({ type: 'text', text: 'hello' });
      else if (mode === 'validateAuth') expect(await provider.validateAuth()).toBe(true);
      else {
        const events = []; for await (const event of provider.stream(params)) events.push(event);
        expect(events.filter(event => event.type === 'message_start')).toHaveLength(1);
        expect(events.filter(event => event.type === 'message_end')).toHaveLength(1);
        expect(events.filter(event => event.type === 'error')).toHaveLength(0);
        expect(events.filter(event => event.type === 'text_delta')).toEqual([{ type: 'text_delta', text: 'hello' }]);
      }
    }
    expect(fetch).toHaveBeenCalledTimes(3);
    const amount = mode === 'validateAuth' ? 1 : 512;
    expect(wires[0].max_completion_tokens).toBe(amount);
    expect(wires[0].max_tokens).toBeUndefined();
    expect(wires[1]).toEqual({ ...wires[0], max_completion_tokens: undefined, max_tokens: amount });
    expect(wires[2].max_tokens).toBe(amount);
    expect(wires[2].max_completion_tokens).toBeUndefined();
  });

  it('accepts SDK defaults in one request when supported', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const wire = JSON.parse(String(init?.body));
      return wire.max_tokens !== undefined ? rejection('max_tokens') : success();
    });
    const provider = await createCustomOpenAICompatibleProvider(config());
    await provider.complete({ maxTokens: 512, messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('switches either direction, preserves the full request and caller signal, and isolates configuration/model changes', async () => {
    const c = config(); const compat = createCustomOutputLimitCompatibility(c);
    const controller = new AbortController();
    const { max_completion_tokens: _unused, ...rest } = body;
    const initial = { ...rest, max_tokens: 700, tools: [{ type: 'function', function: { name: 'read' } }] };
    let count = 0;
    const next = vi.fn(async (_input, init) => {
      expect(init?.signal).toBe(controller.signal);
      const sent = JSON.parse(String(init?.body));
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer synthetic');
      if (++count === 1) return rejection('max_tokens');
      expect(sent).toEqual({ ...initial, max_tokens: undefined, max_completion_tokens: 700 });
      return success();
    }) as unknown as typeof fetch;
    await compat.wrapFetch(next)('https://gateway.example.test/v1/chat/completions', request(initial, controller.signal));
    expect(compat.onPayload(initial)).toEqual({ ...initial, max_tokens: undefined, max_completion_tokens: 700 });
    expect(compat.onPayload({ ...initial, model: 'another' })).toEqual({ ...initial, model: 'another' });
    for (const changed of [{ ...c, apiKey: 'changed' }, { ...c, baseUrl: 'https://other.test/v1' }, { ...c, maxTokens: 2048 }]) {
      expect(createCustomOutputLimitCompatibility(changed).onPayload(initial)).toEqual(initial);
    }
  });

  it.each([401, 402, 403, 408, 429, 500, 503])('never negotiates HTTP %i even with a matching-looking body', async status => {
    const compat = createCustomOutputLimitCompatibility(config());
    const response = rejection('max_completion_tokens', status);
    const next = vi.fn(async () => response);
    expect(await compat.wrapFetch(next)('https://gateway.example.test/v1/chat/completions', request(body))).toBe(response);
    expect(next).toHaveBeenCalledTimes(1);
    expect(compat.onPayload(body)).toBe(body);
  });

  it.each([
    { error: { code: 'invalid_request_error', param: 'max_completion_tokens', message: 'unsupported_parameter' } },
    { error: { code: 'unsupported_parameter', param: 'temperature' } },
    { message: 'max_completion_tokens unsupported; use max_tokens' },
    { error: { code: 'unsupported_parameter', param: 'max_tokens' } },
  ])('requires the exact structured rejection of the sent field: %j', async error => {
    const compat = createCustomOutputLimitCompatibility(config());
    const response = Response.json(error, { status: 400 }); const next = vi.fn(async () => response);
    expect(await compat.wrapFetch(next)('https://gateway.example.test/v1/chat/completions', request(body))).toBe(response);
    expect(await response.json()).toEqual(error); expect(next).toHaveBeenCalledTimes(1);
  });

  it('stops after one switch and does not learn a rejected alternative', async () => {
    const compat = createCustomOutputLimitCompatibility(config());
    const next = vi.fn(async (_input, init) => rejection(JSON.parse(String(init?.body)).max_tokens ? 'max_tokens' : 'max_completion_tokens'));
    const result = await compat.wrapFetch(next)('https://gateway.example.test/v1/chat/completions', request(body));
    expect(result.status).toBe(400); expect(next).toHaveBeenCalledTimes(2);
    expect(compat.onPayload(body)).toBe(body);
  });

  it('does not retry network failures, cancellation, or a partial successful stream', async () => {
    const compat = createCustomOutputLimitCompatibility(config());
    const network = vi.fn(async () => { throw new TypeError('fetch failed'); });
    await expect(compat.wrapFetch(network)('https://gateway.example.test/v1/chat/completions', request(body))).rejects.toThrow('fetch failed');
    expect(network).toHaveBeenCalledTimes(1);
    const controller = new AbortController();
    const aborted = vi.fn(async () => { controller.abort(); return rejection(); });
    await compat.wrapFetch(aborted)('https://gateway.example.test/v1/chat/completions', request(body, controller.signal));
    expect(aborted).toHaveBeenCalledTimes(1);
    const stream = new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: partial\n\n')); c.error(new Error('disconnect')); } }), { status: 200 });
    const accepted = vi.fn(async () => stream);
    expect(await compat.wrapFetch(accepted)('https://gateway.example.test/v1/chat/completions', request(body))).toBe(stream);
    await expect(stream.text()).rejects.toThrow('disconnect'); expect(accepted).toHaveBeenCalledTimes(1);
  });

  it('expires learned fields and replaces stale fields only after a successful alternative', async () => {
    const compat = createCustomOutputLimitCompatibility(config());
    let count = 0;
    await compat.wrapFetch(vi.fn(async () => ++count === 1 ? rejection() : success()))('https://gateway.example.test/v1/chat/completions', request(body));
    const cached = compat.onPayload(body) as any;
    expect(cached.max_tokens).toBe(512);
    count = 0;
    await compat.wrapFetch(vi.fn(async () => ++count === 1 ? rejection('max_tokens') : success()))('https://gateway.example.test/v1/chat/completions', request(cached));
    expect((compat.onPayload(cached) as any).max_completion_tokens).toBe(512);
    const now = Date.now(); vi.spyOn(Date, 'now').mockReturnValue(now + 24 * 3600 * 1000 + 1);
    expect(compat.onPayload(cached)).toBe(cached);
  });

  it('bounds inspection of malformed, oversized and slow rejection bodies', async () => {
    const compat = createCustomOutputLimitCompatibility(config());
    for (const content of ['not JSON', 'x'.repeat(17000)]) {
      const response = new Response(content, { status: 400, headers: { 'content-type': 'application/json' } });
      const next = vi.fn(async () => response);
      expect(await compat.wrapFetch(next)('https://gateway.example.test/v1/chat/completions', request(body))).toBe(response);
      expect(await response.text()).toBe(content); expect(next).toHaveBeenCalledTimes(1);
    }
    vi.useFakeTimers();
    const response = new Response(new ReadableStream(), { status: 400, headers: { 'content-type': 'application/json' } });
    const next = vi.fn(async () => response);
    const pending = compat.wrapFetch(next)('https://gateway.example.test/v1/chat/completions', request(body));
    await vi.advanceTimersByTimeAsync(2001);
    expect(await pending).toBe(response); expect(next).toHaveBeenCalledTimes(1);
    void response.body?.cancel();
  });

  it('does not reissue a real SDK stream after text or tool output, even if a later error names the parameter', async () => {
    const c = config();
    const chunk = { id: 'partial', object: 'chat.completion.chunk', created: 1, model: c.modelId,
      choices: [{ index: 0, delta: { role: 'assistant', content: 'partial', tool_calls: [{ index: 0, id: 'call-1', type: 'function', function: { name: 'read', arguments: '{}' } }] }, finish_reason: null }] };
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(
      `data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify({ error: { code: 'unsupported_parameter', param: 'max_completion_tokens', message: 'synthetic stream failure' } })}\n\n`,
      { headers: { 'content-type': 'text/event-stream' } },
    ));
    const provider = await createCustomOpenAICompatibleProvider(c);
    const events = [];
    for await (const event of provider.stream({ maxTokens: 512, messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] })) events.push(event);
    expect(events.some(event => event.type === 'text_delta')).toBe(true);
    expect(events.some(event => event.type === 'tool_use_start')).toBe(true);
    expect(events.filter(event => event.type === 'error')).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps the newer learned field when a concurrent older negotiation finishes late', async () => {
    const compat = createCustomOutputLimitCompatibility(config());
    let release!: () => void;
    let reached!: () => void;
    const waiting = new Promise<void>(resolve => { reached = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let count = 0;
    const old = compat.wrapFetch(vi.fn(async () => {
      if (++count === 1) return rejection();
      reached(); await gate; return success();
    }))('https://gateway.example.test/v1/chat/completions', request(body));
    await waiting;
    let newerCount = 0;
    const legacyBody = { model: body.model, max_tokens: 512 };
    await compat.wrapFetch(vi.fn(async () => ++newerCount === 1 ? rejection('max_tokens') : success()))('https://gateway.example.test/v1/chat/completions', request(legacyBody));
    release(); await old;
    expect((compat.onPayload(legacyBody) as any).max_completion_tokens).toBe(512);
    expect(compat.onPayload(body)).toBe(body);
  });

  it('does not learn an alternative that fails before its HTTP response', async () => {
    const compat = createCustomOutputLimitCompatibility(config()); let count = 0;
    const next = vi.fn(async () => { if (++count === 1) return rejection(); throw new TypeError('alternate disconnected'); });
    await expect(compat.wrapFetch(next)('https://gateway.example.test/v1/chat/completions', request(body))).rejects.toThrow('alternate disconnected');
    expect(next).toHaveBeenCalledTimes(2); expect(compat.onPayload(body)).toBe(body);
  });

  it('bounds cache capacity across distinct credentials without retaining raw identities', async () => {
    const first = createCustomOutputLimitCompatibility(config());
    const teach = async (compat: ReturnType<typeof createCustomOutputLimitCompatibility>) => {
      let count = 0;
      await compat.wrapFetch(vi.fn(async () => ++count === 1 ? rejection() : success()))('https://gateway.example.test/v1/chat/completions', request(body));
    };
    await teach(first);
    expect((first.onPayload(body) as any).max_tokens).toBe(512);
    for (let n = 0; n < 128; n++) await teach(createCustomOutputLimitCompatibility(config()));
    expect(first.onPayload(body)).toBe(body);
  });

  it('cancels a slow rejection inspection without issuing the alternate request', async () => {
    const controller = new AbortController();
    const compat = createCustomOutputLimitCompatibility(config());
    const response = new Response(new ReadableStream(), { status: 400, headers: { 'content-type': 'application/json' } });
    const next = vi.fn(async () => response);
    const pending = compat.wrapFetch(next)('https://gateway.example.test/v1/chat/completions', request(body, controller.signal));
    await Promise.resolve(); controller.abort();
    expect(await pending).toBe(response); expect(next).toHaveBeenCalledTimes(1);
    void response.body?.cancel();
  });


  it('corrects an SDK-selected legacy field through the real SDK without changing the output budget', async () => {
    const c = { ...config(), baseUrl: 'https://api.deepseek.com.example.test/v1' };
    const wires: any[] = [];
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const wire = JSON.parse(String(init?.body)); wires.push(wire);
      return wire.max_tokens !== undefined ? rejection('max_tokens') : success();
    });
    const provider = await createCustomOpenAICompatibleProvider(c);
    expect((await provider.complete({ maxTokens: 256, messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] })).content).toContainEqual({ type: 'text', text: 'hello' });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(wires[0].max_tokens).toBe(256);
    expect(wires[1]).toEqual({ ...wires[0], max_tokens: undefined, max_completion_tokens: 256 });
  });

  it('preserves the final HTTP rejection and emits only one error after both fields are rejected', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const wire = JSON.parse(String(init?.body));
      return rejection(wire.max_tokens !== undefined ? 'max_tokens' : 'max_completion_tokens');
    });
    const provider = await createCustomOpenAICompatibleProvider(config());
    const failures: unknown[] = [];
    const events = [];
    for await (const event of provider.stream({ maxTokens: 512, onRequestFailure: failure => failures.push(failure), messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] })) events.push(event);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(events.filter(event => event.type === 'error')).toEqual([expect.objectContaining({ error: expect.objectContaining({ statusCode: 400 }) })]);
    expect(events.some(event => event.type === 'message_start')).toBe(false);
    expect(failures).toEqual([expect.objectContaining({ httpStatus: 400, phase: 'after_response' })]);
  });

});
