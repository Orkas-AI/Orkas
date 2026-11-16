import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProviderErrorCapture } from '../src/providers/provider-error-capture.js';
import { providerErrorFacts, providerRequestWasRejected } from '../src/shared/provider-error-facts.js';
import { classifyRetryableError } from '../src/shared/errors.js';
import { wrapErrorForTest } from '../src/providers/pi-provider.js';

afterEach(() => vi.useRealTimers());

it('retains HTTP Retry-After through SDK error flattening', async () => {
  const capture = createProviderErrorCapture();
  await capture.wrapFetch(async () => new Response('{"error":{"code":"rate_limit_exceeded"}}', {
    status: 429, headers: { 'content-type': 'application/json', 'retry-after': '7' },
  }))('https://fixture.invalid');
  expect(wrapErrorForTest(capture.cause(), 'fixture')).toMatchObject({ retryAfterMs: 7000 });
});

it('retains only the numeric recovery delay from a structured SSE rejection', async () => {
  const capture = createProviderErrorCapture('openai-responses');
  const body = 'event: response.failed\ndata: ' + JSON.stringify({ type: 'response.failed', response: {
    error: { code: 'rate_limit_exceeded', retry_after_ms: 25_000, message: 'private fixture diagnostic' },
  } }) + '\n\n';
  const response = await capture.wrapFetch(async () => new Response(body, {
    headers: { 'content-type': 'text/event-stream' },
  }))('https://fixture.invalid');
  expect(await response.text()).toBe(body);
  const cause = capture.cause();
  expect(wrapErrorForTest(cause, 'fixture')).toMatchObject({ retryAfterMs: 25_000 });
  expect(JSON.stringify(cause)).not.toContain('private fixture diagnostic');
});

describe('SDK error evidence retention', () => {
  it('distinguishes actual upstream rejection from a local payload failure', async () => {
    const capture = createProviderErrorCapture();
    await capture.wrapFetch(async () => new Response('{"error":{"type":"server_error"}}', {
      status: 400, headers: { 'content-type': 'application/json' },
    }))('https://fixture.invalid');
    expect(providerRequestWasRejected(capture.cause())).toBe(true);
    const local = Object.assign(new Error('Local payload failure'), { status: 400 });
    await expect(capture.wrapFetch(async () => { throw local; })('https://fixture.invalid')).rejects.toBe(local);
    expect(providerRequestWasRejected(capture.cause())).toBe(false);
  });

  it('preserves an embedded output barrier across HTTP, SSE and legacy SDK errors', async () => {
    for (const field of ['output', 'choices']) {
      const payload = { error: { code: 'server_error' }, [field]: [{ type: 'function_call', name: 'write' }] };
      const capture = createProviderErrorCapture('openai-responses');
      await capture.wrapFetch(async () => new Response(JSON.stringify(payload), {
        status: 503, headers: { 'content-type': 'application/json' },
      }))('https://fixture.invalid');
      expect(classifyRetryableError(capture.cause())).toBeNull();
      const failed = { type: 'response.failed', response: { status: 'failed', ...payload } };
      const response = await capture.wrapFetch(async () => sseResponse('event: response.failed\ndata: ' + JSON.stringify(failed) + '\n\n'))('https://fixture.invalid');
      await response.text();
      expect(classifyRetryableError(capture.cause())).toBeNull();
      const legacy = createProviderErrorCapture();
      expect(classifyRetryableError(legacy.cause('503 ' + JSON.stringify(payload)))).toBeNull();
    }
  });

  it('keeps only exact structured rejected indexes and resets between responses', async () => {
    const capture = createProviderErrorCapture();
    for (const param of ['input[9999].status', 'input[1].status.extra', 'messages[1].status', 'input[-1].status']) {
      const response = new Response(JSON.stringify({ error: { param, message: 'input[1].status' } }), {
        status: 400, headers: { 'content-type': 'application/json' },
      });
      await capture.wrapFetch(async () => response)('https://fixture.invalid');
      expect(capture.rejectedInputIndex).toBe(param === 'input[9999].status' ? 9999 : undefined);
      expect((await response.json()).error.param).toBe(param);
    }
    await capture.wrapFetch(async () => new Response('{}'))('https://fixture.invalid');
    expect(capture.rejectedInputIndex).toBeUndefined();
  });
  it('retains safe id/status field positions without retaining arbitrary parameters or changing HTTP errors', async () => {
    const capture = createProviderErrorCapture();
    for (const param of ['input[0].id', 'input[999999].status', 'input[1000000].id', 'input[-1].id',
      'input[1].id.extra', 'input[1].PRIVATE', 'PRIVATE', ['input[0].id']]) {
      const body = JSON.stringify({ error: { code: 'invalid_request_error', param, message: 'PRIVATE' } });
      const response = new Response(body, { status: 400, headers: { 'content-type': 'application/json' } });
      await capture.wrapFetch(async () => response)('https://fixture.invalid');
      const expected = param === 'input[0].id' ? { index: 0, field: 'id' }
        : param === 'input[999999].status' ? { index: 999999, field: 'status' } : undefined;
      expect((capture as any).rejectedInput).toEqual(expected);
      expect(classifyRetryableError(capture.cause())).toBeNull();
      expect(await response.text()).toBe(body);
    }
    await capture.wrapFetch(async () => new Response('{}'))('https://fixture.invalid');
    expect((capture as any).rejectedInput).toBeUndefined();
  });
  it('retains the original transport cause and isolates concurrent requests', async () => {
    const first = createProviderErrorCapture(), second = createProviderErrorCapture();
    const error = new TypeError('arbitrary', { cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } });
    await expect(first.wrapFetch(async () => { throw error; })('https://fixture.invalid')).rejects.toBe(error);
    await second.wrapFetch(async () => new Response('', { status: 403 }))('https://fixture.invalid');
    expect(first.cause()).toBe(error);
    expect(classifyRetryableError(first.cause())).toBe('timeout');
    expect(classifyRetryableError(second.cause())).toBeNull();
    await first.wrapFetch(async () => new Response('ok'))('https://fixture.invalid');
    expect(first.cause()).toBeUndefined();
  });

  it.each(['forbidden', 'invalid_request', '{"error":{"code":"invalid_api_key"}}'])
  ('retains actual HTTP machine fields without decoding the message: %s', async message => {
    const capture = createProviderErrorCapture();
    const response = new Response(JSON.stringify({ error: { type: 'upstream_error', message } }), {
      status: 502, headers: { 'content-type': 'application/json' },
    });
    expect(await capture.wrapFetch(async () => response)('https://fixture.invalid')).toBe(response);
    expect(classifyRetryableError(capture.cause('401 {"code":"invalid_api_key"}'))).toBe('service_unavailable');
    expect(providerErrorFacts(capture.cause(), false)).toEqual({ status: 502, codes: ['upstream_error'] });
    expect(await response.json()).toEqual({ error: { type: 'upstream_error', message } });
  });

  it('preserves status on oversized/malformed bodies without inferring diagnostic codes', async () => {
    for (const body of ['{"code":', JSON.stringify({ message: 'x'.repeat(17000), code: 'invalid_api_key' })]) {
      const capture = createProviderErrorCapture();
      const response = new Response(body, { status: 502, headers: { 'content-type': 'application/json' } });
      await capture.wrapFetch(async () => response)('https://fixture.invalid');
      expect(classifyRetryableError(capture.cause())).toBe('service_unavailable');
      expect(await response.text()).toBe(body);
    }
  });

  it('preserves the response and HTTP status when its clone is unavailable', async () => {
    const capture = createProviderErrorCapture();
    const response = new Response('{}', { status: 502, headers: { 'content-type': 'application/json' } });
    vi.spyOn(response, 'clone').mockImplementation(() => { throw new Error('clone unavailable'); });
    expect(await capture.wrapFetch(async () => response)('https://fixture.invalid')).toBe(response);
    expect(classifyRetryableError(capture.cause())).toBe('service_unavailable');
    expect(await response.text()).toBe('{}');
  });

  it.each(['timeout', 'abort'] as const)('bounds inspection of a stalled error body: %s', async mode => {
    vi.useFakeTimers();
    const capture = createProviderErrorCapture();
    const controller = new AbortController();
    let stream!: ReadableStreamDefaultController;
    const response = new Response(new ReadableStream({ start(value) { stream = value; } }), {
      status: 502, headers: { 'content-type': 'application/json' },
    });
    const pending = capture.wrapFetch(async () => response)('https://fixture.invalid', { signal: controller.signal });
    await Promise.resolve();
    if (mode === 'abort') controller.abort();
    else await vi.advanceTimersByTimeAsync(2000);
    expect(await pending).toBe(response);
    expect(providerErrorFacts(capture.cause(), false).status).toBe(502);
    stream.close();
    await response.text();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('decodes only machine fields in complete legacy SDK envelopes', () => {
    const capture = createProviderErrorCapture();
    expect(providerErrorFacts(capture.cause('429 {"error":{"code":"insufficient_quota"}}'), false))
      .toEqual({ status: 429, codes: ['insufficient_quota'] });
    for (const message of ['invalid_request', '{"message":"{\\"code\\":\\"invalid_api_key\\"}"}',
      'Example: {"code":"invalid_api_key"}', '{"code":"invalid_api_key"']) {
      expect(capture.cause(message)).toBeUndefined();
    }
  });
});

function sseResponse(text: string, chunkSize = 1): Response {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (offset === bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.subarray(offset, offset + chunkSize));
      offset = Math.min(bytes.length, offset + chunkSize);
    },
  }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } });
}

describe('bounded stream machine facts', () => {
  it('retains the original body-read failure after unchanged partial bytes without prefetching', async () => {
    const capture = createProviderErrorCapture('openai-responses');
    const error = new TypeError('private body failure', { cause: { code: 'UND_ERR_BODY_TIMEOUT' } });
    const bytes = new TextEncoder().encode(': heartbeat\n\n');
    const pull = vi.fn(controller => {
      if (pull.mock.calls.length === 1) controller.enqueue(bytes);
      else controller.error(error);
    });
    const source = new ReadableStream<Uint8Array>({ pull }, { highWaterMark: 0 });
    const response = await capture.wrapFetch(async () => new Response(source, {
      headers: { 'content-type': 'text/event-stream' },
    }))('https://fixture.invalid');
    expect(pull).not.toHaveBeenCalled();
    const reader = response.body!.getReader();
    expect((await reader.read()).value).toBe(bytes);
    expect(pull).toHaveBeenCalledTimes(1);
    expect(capture.cause()).toBeUndefined();
    await expect(reader.read()).rejects.toBe(error);
    expect(source.locked).toBe(false);
    expect(capture.cause()).toBe(error);
    expect(classifyRetryableError(capture.cause())).toBe('timeout');
    await capture.wrapFetch(async () => new Response('ok'))('https://fixture.invalid');
    expect(capture.cause()).toBeUndefined();
  });

  it('does not replace a protocol rejection with a later body failure', async () => {
    const capture = createProviderErrorCapture('openai-completions');
    let reads = 0;
    const response = await capture.wrapFetch(async () => new Response(new ReadableStream({
      pull(controller) {
        if (++reads === 1) controller.enqueue(new TextEncoder().encode('data: {"error":{"status":400,"code":"invalid_request_error"}}\n\n'));
        else controller.error(new TypeError('private', { cause: { code: 'ECONNRESET' } }));
      },
    }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } }))('https://fixture.invalid');
    await expect(response.text()).rejects.toThrow('private');
    expect(providerErrorFacts(capture.cause(), false)).toEqual({ status: 400, codes: ['invalid_request_error'] });
    expect(classifyRetryableError(capture.cause())).toBeNull();
  });

  it('cannot attach a previous stream read failure to a newer request', async () => {
    const capture = createProviderErrorCapture('openai-responses');
    const previous = await capture.wrapFetch(async () => new Response(new ReadableStream({
      pull(controller) { controller.error(new TypeError('private', { cause: { code: 'ECONNRESET' } })); },
    }, { highWaterMark: 0 }), { headers: { 'content-type': 'text/event-stream' } }))('https://fixture.invalid');
    await capture.wrapFetch(async () => new Response('ok'))('https://fixture.invalid');
    await expect(previous.text()).rejects.toThrow('private');
    expect(capture.cause()).toBeUndefined();
  });

  it.each(['\n', '\r\n', '\r'])('preserves split UTF-8 bytes and multiline error frames with %j delimiters', async newline => {
    const capture = createProviderErrorCapture('openai-responses');
    const text = [': heartbeat', '', 'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","delta":"私密 {\\"code\\":\\"invalid_api_key\\"}"}', '',
      'event: error', 'data: {"type":"error",',
      'data: "code":"invalid_request_error","status":400,"message":"PRIVATE"}', '', ''].join(newline);
    const response = await capture.wrapFetch(async () => sseResponse(text))('https://fixture.invalid');
    expect(capture.cause()).toBeUndefined();
    expect(await response.text()).toBe(text);
    expect(providerErrorFacts(capture.cause(), false)).toEqual({ status: 400, codes: expect.arrayContaining(['error', 'invalid_request_error']) });
    expect(JSON.stringify(capture.cause())).not.toContain('PRIVATE');
    expect(classifyRetryableError(capture.cause())).toBeNull();
  });

  it('retains response.failed machine codes without interpreting nested prose', async () => {
    const capture = createProviderErrorCapture('openai-responses');
    const text = 'event: response.failed\ndata: ' + JSON.stringify({ type: 'response.failed', response: {
      status: 'failed', error: { code: 'invalid_request_error', message: '503 overloaded' },
    } }) + '\n\n';
    const response = await capture.wrapFetch(async () => sseResponse(text, 65536))('https://fixture.invalid');
    expect(await response.text()).toBe(text);
    expect(providerErrorFacts(capture.cause(), false)).toEqual({ status: undefined, codes: ['invalid_request_error'] });
    expect(classifyRetryableError(capture.cause())).toBeNull();
  });

  it('never interprets output look-alikes, malformed, unterminated or oversized frames', async () => {
    const bodies = [
      'event: response.output_text.delta\ndata: {"type":"error","status":400}\n\n',
      'data: {"type":"response.output_text.delta","delta":"{\\"status\\":400}"}\n\n',
      'event: error\ndata: {"type":"error","status":400}',
      'event: error\ndata: not-json\n\n',
      'event: error\ndata: {"type":"error","status":400,"message":"' + '私'.repeat(9000) + '"}\n\n',
    ];
    for (const text of bodies) {
      const capture = createProviderErrorCapture('openai-responses');
      const response = await capture.wrapFetch(async () => sseResponse(text, 65536))('https://fixture.invalid');
      expect(await response.text()).toBe(text);
      expect(capture.cause()).toBeUndefined();
    }
  });

  it('resumes after an oversized frame and preserves only the first error', async () => {
    const capture = createProviderErrorCapture('openai-responses');
    const text = 'data: ' + 'x'.repeat(100000) + '\n\n'
      + 'event: error\ndata: {"type":"error","status":400}\n\n'
      + 'event: error\ndata: {"type":"error","status":503}\n\n';
    const response = await capture.wrapFetch(async () => sseResponse(text, 65536))('https://fixture.invalid');
    expect(await response.text()).toBe(text);
    expect(providerErrorFacts(capture.cause(), false).status).toBe(400);
  });

  it('does not prefetch, propagates cancellation and preserves response metadata', async () => {
    const pull = vi.fn(controller => controller.enqueue(new TextEncoder().encode(': heartbeat\n\n')));
    const cancel = vi.fn();
    const original = new Response(new ReadableStream({ pull, cancel }, { highWaterMark: 0 }), {
      headers: { 'content-type': 'text/event-stream', 'x-request-id': 'synthetic' },
    });
    Object.defineProperty(original, 'url', { value: 'https://fixture.invalid/v1/responses' });
    const capture = createProviderErrorCapture('openai-responses');
    const response = await capture.wrapFetch(async () => original)('https://fixture.invalid');
    expect(pull).not.toHaveBeenCalled();
    expect(response.url).toBe(original.url);
    expect(response.headers.get('x-request-id')).toBe('synthetic');
    const reader = response.body!.getReader();
    await reader.read();
    expect(pull).toHaveBeenCalledTimes(1);
    await reader.cancel('caller stopped');
    expect(cancel).toHaveBeenCalledExactlyOnceWith('caller stopped');
    expect(capture.cause()).toBeUndefined();
  });

  it('cancels a pending read without adding a timeout or leaving a locked source', async () => {
    const cancel = vi.fn();
    const source = new ReadableStream<Uint8Array>({ cancel }, { highWaterMark: 0 });
    const capture = createProviderErrorCapture('openai-responses');
    const response = await capture.wrapFetch(async () => new Response(source, {
      headers: { 'content-type': 'text/event-stream' },
    }))('https://fixture.invalid');
    const reader = response.body!.getReader();
    const pending = reader.read();
    await Promise.resolve();
    await reader.cancel('abort');
    expect(await pending).toEqual({ done: true, value: undefined });
    expect(cancel).toHaveBeenCalledExactlyOnceWith('abort');
    expect(source.locked).toBe(false);
    expect(capture.cause()).toBeUndefined();
  });

  it('isolates late streams from the next request and leaves other protocols untouched', async () => {
    const text = 'event: error\ndata: {"type":"error","status":400}\n\n';
    const capture = createProviderErrorCapture('openai-responses');
    const previous = await capture.wrapFetch(async () => sseResponse(text))('https://fixture.invalid');
    await capture.wrapFetch(async () => new Response('ok'))('https://fixture.invalid');
    await previous.text();
    expect(capture.cause()).toBeUndefined();
    const original = sseResponse(text);
    expect(await createProviderErrorCapture().wrapFetch(async () => original)('https://fixture.invalid')).toBe(original);
  });
});
