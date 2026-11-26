import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPiProvider } from '../src/providers/pi-provider.js';
import { createProviderErrorCapture } from '../src/providers/provider-error-capture.js';
import { classifyRetryableError } from '../src/shared/errors.js';
import type { CompletionParams } from '../src/providers/base.js';
import { codexSseFetch } from '../src/providers/codex-sse-fetch.js';
import { zstdCompressSync } from 'node:zlib';

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const account = Buffer.from(JSON.stringify({
  'https://api.openai.com/auth': { chatgpt_account_id: 'fixture' },
})).toString('base64url');
const apiKey = `fixture.${account}.fixture`;
const model = 'gpt-6-luna';
const encode = (event: object) => new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
const completed = () => new Response(Buffer.concat([
  encode({ type: 'response.output_item.added', output_index: 0,
    item: { type: 'message', id: 'msg_fixture', role: 'assistant', content: [] } }),
  encode({ type: 'response.output_text.delta', item_id: 'msg_fixture', output_index: 0, content_index: 0, delta: 'READY' }),
  encode({ type: 'response.output_item.done', output_index: 0,
    item: { type: 'message', id: 'msg_fixture', role: 'assistant', status: 'completed',
      content: [{ type: 'output_text', text: 'READY', annotations: [] }] } }),
  encode({ type: 'response.completed', response: {
    id: 'resp_fixture', status: 'completed', output: [{ type: 'message', id: 'msg_fixture',
      role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'READY', annotations: [] }] }],
    usage: { input_tokens: 100, output_tokens: 2, total_tokens: 102 },
  } }),
]), { headers: { 'content-type': 'text/event-stream' } });

describe('Codex SSE compatibility through the installed SDK', () => {
  it.each(['complete', 'stream'] as const)('sends the exact full JSON once in %s, without zstd framing', async method => {
    let expected = '';
    const requests: RequestInit[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_input, init) => { requests.push(init); return completed(); }));
    const provider = createPiProvider({ provider: 'openai-codex', model, apiKey,
      onPayload(payload) { expected = JSON.stringify(payload); },
    });
    const params: CompletionParams = { model, sessionId: 'fixture-session',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'abcdefghij'.repeat(14000) + '中文 🎬 \\n' }] }],
      tools: [{ name: 'fixture_tool', description: 'Fixture', inputSchema: { type: 'object', properties: {} } }],
    };
    if (method === 'complete') expect((await provider.complete(params)).content).toMatchObject([{ type: 'text', text: 'READY' }]);
    else {
      const events = [];
      for await (const event of provider.stream(params)) events.push(event);
      expect(events.filter(e => e.type === 'message_end')).toHaveLength(1);
      expect(events.filter(e => e.type === 'error')).toHaveLength(0);
    }
    expect(requests).toHaveLength(1);
    const headers = new Headers(requests[0].headers);
    expect(headers.has('content-encoding')).toBe(false);
    expect(headers.get('authorization')).toBe(`Bearer ${apiKey}`);
    expect(Buffer.from(requests[0].body as Uint8Array)).toEqual(Buffer.from(expected));
    expect(Buffer.byteLength(expected)).toBeGreaterThan(131072);
  });

  it('uses the same compatible request encoding for credential validation', async () => {
    let request!: RequestInit;
    const send = vi.fn(async (_input, init) => { request = init; return completed(); });
    vi.stubGlobal('fetch', send);
    expect(await createPiProvider({ provider: 'openai-codex', model, apiKey }).validateAuth()).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(new Headers(request.headers).has('content-encoding')).toBe(false);
    expect(JSON.parse(Buffer.from(request.body as Uint8Array).toString()).model).toBe(model);
  });

  it.each((['complete', 'stream'] as const).flatMap(method =>
    [undefined, 'text/event-stream'].map(contentType => [method, contentType] as const)))
  ('preserves the original read exception and machine code in %s with content type %s', async (method, contentType) => {
    const original = new TypeError('PRIVATE socket diagnostic', {
      cause: Object.assign(new Error('PRIVATE peer details'), { code: 'UND_ERR_SOCKET' }),
    });
    let reads = 0;
    const bytes = Buffer.concat([
      encode({ type: 'response.created', response: { id: 'resp_fixture', status: 'in_progress', output: [] } }),
      encode({ type: 'response.output_item.added', output_index: 0,
        item: { type: 'function_call', id: 'fc_fixture', call_id: 'call_fixture', name: 'fixture_tool', arguments: '' } }),
      encode({ type: 'response.function_call_arguments.delta', item_id: 'fc_fixture', output_index: 0, delta: '{"x":' }),
    ]);
    const send = vi.fn(async () => new Response(new ReadableStream({
      pull(controller) { if (++reads === 1) controller.enqueue(bytes); else controller.error(original); },
    }, { highWaterMark: 0 }), { headers: contentType ? { 'content-type': contentType } : undefined }));
    vi.stubGlobal('fetch', send);
    const failures: any[] = [];
    const params: CompletionParams = { model, messages: [{ role: 'user', content: [{ type: 'text', text: 'probe' }] }],
      onRequestFailure: failure => failures.push(failure) };
    const provider = createPiProvider({ provider: 'openai-codex', model, apiKey });
    let delivered: any;
    if (method === 'complete') delivered = await provider.complete(params).catch(error => error);
    else for await (const event of provider.stream(params)) if (event.type === 'error') delivered = event.error;
    expect(delivered.cause).toBe(original);
    expect(classifyRetryableError(delivered)).toBe('connection_dropped');
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ httpStatus: 200, phase: 'after_response',
      code: 'UND_ERR_SOCKET', aborted: false,
      // complete consumes the SDK final result rather than portable deltas.
      ...(method === 'stream' ? { lastEvent: 'toolcall_delta' } : {}),
    });
    expect(JSON.stringify(failures)).not.toContain('PRIVATE');
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('Codex read-failure ownership', () => {
  it('retains partial bytes and the original failure without prefetching or parsing SDK envelopes', async () => {
    const original = Object.assign(new Error('PRIVATE'), { code: 'ECONNRESET' });
    const bytes = encode({ type: 'error', code: 'invalid_request_error', message: 'PRIVATE' });
    const pull = vi.fn(controller => {
      if (pull.mock.calls.length === 1) controller.enqueue(bytes);
      else controller.error(original);
    });
    const source = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 });
    const capture = createProviderErrorCapture('openai-codex-responses');
    const observe = capture.wrapFetch(async () => new Response(source));
    const response = await observe('https://fixture.invalid');
    expect(pull).not.toHaveBeenCalled();
    const reader = response.body!.getReader();
    expect((await reader.read()).value).toBe(bytes);
    expect(capture.cause()).toBeUndefined();
    await expect(reader.read()).rejects.toBe(original);
    expect(capture.cause()).toBe(original);
    expect(source.locked).toBe(false);
    await capture.wrapFetch(async () => new Response('ok'))('https://fixture.invalid');
    expect(capture.cause()).toBeUndefined();
  });

  it('adds no idle timeout and forwards cancellation to the pending source read', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 });
    const capture = createProviderErrorCapture('openai-codex-responses');
    const response = await capture.wrapFetch(async () => new Response(source))('https://fixture.invalid');
    const reader = response.body!.getReader();
    const pending = reader.read();
    await vi.advanceTimersByTimeAsync(1_800_000);
    expect(capture.cause()).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    await reader.cancel('user abort');
    expect(await pending).toEqual({ done: true, value: undefined });
    expect(cancel).toHaveBeenCalledExactlyOnceWith('user abort');
    expect(source.locked).toBe(false);
  });

  it.each([{ code: 'ECONNRESET' }, 'PRIVATE primitive', null, undefined])
  ('retains non-Error read rejection values in the cause chain: %j', async original => {
    const capture = createProviderErrorCapture('openai-codex-responses');
    const response = await capture.wrapFetch(async () => new Response(new ReadableStream({
      pull(controller) { controller.error(original); },
    }, { highWaterMark: 0 })))('https://fixture.invalid');
    await expect(response.body!.getReader().read()).rejects.toBe(original);
    expect(capture.cause()).toHaveProperty('cause', original);
    await capture.wrapFetch(async () => new Response('ok'))('https://fixture.invalid');
    expect(capture.cause()).toBeUndefined();
  });
});

describe('Codex request transport boundaries', () => {
  it.each(['bytes', 'offset-view', 'array-buffer'] as const)('decodes %s without changing JSON bytes, routing headers or signals', async shape => {
    const raw = Buffer.from(' { "input": ["中文 🎬"], "model": "fixture" }\n');
    const compressed = zstdCompressSync(raw);
    const padded = Buffer.concat([Buffer.from('ignore'), compressed, Buffer.from('ignore')]);
    const body = shape === 'offset-view' ? new DataView(padded.buffer, padded.byteOffset + 6, compressed.length)
      : shape === 'array-buffer' ? Uint8Array.from(compressed).buffer : compressed;
    const controller = new AbortController();
    const response = new Response('not rewritten', { status: 400 });
    const next = vi.fn(async (_input, init) => {
      expect(Buffer.from(init.body)).toEqual(raw);
      expect(init.signal).toBe(controller.signal);
      const headers = new Headers(init.headers);
      expect(headers.has('content-encoding')).toBe(false);
      expect(headers.has('content-length')).toBe(false);
      expect(headers.get('x-codex-turn-state')).toBe('fixture-route');
      expect(headers.get('authorization')).toBe('Bearer fixture');
      return response;
    });
    expect(await codexSseFetch(next, 'openai-codex-responses')('https://fixture.invalid', {
      body: body as BodyInit, method: 'POST', signal: controller.signal,
      headers: { 'Content-Encoding': 'ZSTD', 'Content-Length': String(compressed.length),
        'x-codex-turn-state': 'fixture-route', authorization: 'Bearer fixture' },
    })).toBe(response);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('leaves other protocols and already plain Codex requests untouched', async () => {
    const next = vi.fn(async () => new Response('ok'));
    const foreign: RequestInit = { body: new Uint8Array([1, 2, 3]), headers: { 'content-encoding': 'zstd' } };
    await codexSseFetch(next, 'openai-responses')('https://fixture.invalid', foreign);
    expect(next.mock.calls[0][1]).toBe(foreign);
    const plain = { body: '{"input":[]}' };
    await codexSseFetch(next, 'openai-codex-responses')('https://fixture.invalid', plain);
    expect(next.mock.calls[1][1]).toBe(plain);
  });

  it('never dispatches an invalid compressed request', async () => {
    const next = vi.fn(async () => new Response('unexpected'));
    await expect(codexSseFetch(next, 'openai-codex-responses')('https://fixture.invalid', {
      body: new Uint8Array([1, 2, 3]), headers: { 'content-encoding': 'zstd' },
    })).rejects.toBeInstanceOf(Error);
    expect(next).not.toHaveBeenCalled();
  });

  it.each(['before', 'during'] as const)('does not dispatch after cancellation %s decoding', async when => {
    const controller = new AbortController();
    const reason = new Error('user stopped');
    const next = vi.fn(async () => new Response('unexpected'));
    if (when === 'before') controller.abort(reason);
    const pending = codexSseFetch(next, 'openai-codex-responses')('https://fixture.invalid', {
      body: zstdCompressSync(Buffer.alloc(1024 * 1024)), headers: { 'content-encoding': 'zstd' }, signal: controller.signal,
    });
    if (when === 'during') controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(next).not.toHaveBeenCalled();
  });
});
