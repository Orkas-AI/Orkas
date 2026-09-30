import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProviderErrorCapture } from '../src/providers/provider-error-capture.js';
import { providerErrorFacts } from '../src/shared/provider-error-facts.js';
import { classifyRetryableError } from '../src/shared/errors.js';

afterEach(() => vi.useRealTimers());

describe('SDK error evidence retention', () => {
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
