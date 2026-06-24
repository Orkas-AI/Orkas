import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchWithRetry, retryAsync } from '../../../src/main/util/retry';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('retryAsync', () => {
  it('retries a transient failure three times before succeeding', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('temporary 1'))
      .mockRejectedValueOnce(new Error('temporary 2'))
      .mockRejectedValueOnce(new Error('temporary 3'))
      .mockResolvedValue('ok');

    await expect(retryAsync('test:retry', fn, { delaysMs: [0, 0, 0] })).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(4);
  });
});

describe('fetchWithRetry', () => {
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
