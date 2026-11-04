import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchAndReadWithRetry, fetchWithRetry, RequestTimeoutError, RetriableHttpStatusError, retryAsync } from '../../../src/main/util/retry';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('retryAsync', () => {
  it('reports only dispatched attempts without letting diagnostics alter retries', async () => {
    const attempts: number[] = [];
    const operation = vi.fn().mockRejectedValueOnce(new Error('transient')).mockResolvedValue('done');
    await expect(retryAsync('bounded-observer', operation, { delaysMs: [0],
      onAttempt: (attempt: number) => { attempts.push(attempt); throw new Error('observer unavailable'); },
    } as any)).resolves.toBe('done');
    expect(attempts).toEqual([0, 1]);
    expect(operation).toHaveBeenCalledTimes(2);
  });
  it('retries a transient failure three times before succeeding', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('temporary 1'))
      .mockRejectedValueOnce(new Error('temporary 2'))
      .mockRejectedValueOnce(new Error('temporary 3'))
      .mockResolvedValue('ok');

    await expect(retryAsync('test:retry', fn, { delaysMs: [0, 0, 0] })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(4);
  });

  it('cancels a pending backoff immediately and never starts another attempt', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fn = vi.fn().mockRejectedValue(new Error('temporary failure'));
    const pending = retryAsync('test:abort-backoff', fn, {
      retries: 2,
      delaysMs: [10_000],
      signal: controller.signal,
    });
    await vi.advanceTimersByTimeAsync(1);

    controller.abort(new Error('user cancelled download'));

    await expect(pending).rejects.toThrow('user cancelled download');
    expect(fn).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('fetchWithRetry', () => {
  it.each([
    ['2', 2000],
    ['Sat, 17 Oct 2026 12:00:03 GMT', 3000],
    ['busy', undefined],
    ['-1', undefined],
  ])('retains a bounded caller receipt for Retry-After %s without replaying the request', async (header, wait) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-17T12:00:00Z'));
    const fetchMock = vi.fn().mockResolvedValue(new Response('busy', {
      status: 503, headers: { 'retry-after': header },
    }));
    const readBody = vi.fn();
    const failure = await fetchAndReadWithRetry('test:receipt', 'https://example.test/api',
      undefined, readBody, { retries: 0, fetch: fetchMock }).catch(error => error);
    expect(failure).toBeInstanceOf(RetriableHttpStatusError);
    expect(failure.status).toBe(503);
    expect(failure.retryAfterMs).toBe(wait);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(readBody).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('distinguishes a request deadline from transport failure without another attempt', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    const pending = fetchAndReadWithRetry('test:deadline', 'https://example.test/api', undefined,
      async response => response.text(), { retries: 0, timeoutMs: 100, fetch: fetchMock }).catch(error => error);
    await vi.advanceTimersByTimeAsync(100);
    const failure = await pending;
    expect(failure).toBeInstanceOf(RequestTimeoutError);
    expect(failure.message).toBe('test:deadline timed out after 100ms');
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['request', 'options'])('cancels the %s signal during HTTP backoff without another attempt', async source => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetchMock = vi.fn().mockImplementation(async () => new Response('busy', { status: 503 }));
    vi.stubGlobal('fetch', fetchMock);
    let failure: Error | undefined;
    const work = fetchWithRetry('test:http-cancel', 'https://example.test/api',
      source === 'request' ? { signal: controller.signal } : undefined,
      { retries: 2, delaysMs: [10_000], ...(source === 'options' ? { signal: controller.signal } : {}) })
      .catch(error => { failure = error; });
    try {
      await vi.advanceTimersByTimeAsync(1);
      controller.abort(new Error('user cancelled request'));
      await vi.advanceTimersByTimeAsync(1);
      expect(failure?.message).toBe('user cancelled request');
      expect(fetchMock).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await vi.advanceTimersByTimeAsync(30_000);
      await work;
    }
  });

  it('retries retriable HTTP status responses', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValueOnce(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await fetchWithRetry('test:http', 'https://example.test/api', undefined, { delaysMs: [0] });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(200);
  });

  it('does not retry normal non-success statuses that callers handle', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('missing', { status: 404 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await fetchWithRetry('test:not-found', 'https://example.test/missing', undefined, { delaysMs: [0] });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(404);
  });

  it('aborts a hung request when timeoutMs is provided', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_url, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);

    const promise = expect(fetchWithRetry(
      'test:timeout',
      'https://example.test/slow',
      undefined,
      { retries: 0, timeoutMs: 100 },
    )).rejects.toThrow(/test:timeout timed out after 100ms/);

    await vi.advanceTimersByTimeAsync(100);
    await promise;
  });
});
