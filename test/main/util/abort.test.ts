import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  composeAbortSignal,
  fetchAndReadWithTimeout,
  fetchWithTimeout,
  throwIfAborted,
} from '../../../src/main/util/abort';


afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('abort utilities', () => {
  it('throws only for an already-aborted signal', () => {
    expect(() => throwIfAborted()).not.toThrow();
    expect(() => throwIfAborted(new AbortController().signal)).not.toThrow();
    const controller = new AbortController();
    controller.abort();
    expect(() => throwIfAborted(controller.signal)).toThrow('operation aborted');
  });

  it('inherits an already-aborted parent reason', () => {
    const parent = new AbortController();
    const reason = new Error('parent reason');
    parent.abort(reason);

    const composed = composeAbortSignal(parent.signal, 0, 'timeout');

    expect(composed.signal.aborted).toBe(true);
    expect(composed.signal.reason).toBe(reason);
    composed.cleanup();
  });

  it('propagates a later parent abort and cleanup detaches the listener', () => {
    const parent = new AbortController();
    const composed = composeAbortSignal(parent.signal, 0, 'timeout');
    composed.cleanup();
    parent.abort(new Error('late'));

    expect(composed.signal.aborted).toBe(false);
  });

  it('aborts with the timeout reason and cleanup cancels pending timers', () => {
    vi.useFakeTimers();
    const timed = composeAbortSignal(undefined, 50, 'too slow');
    vi.advanceTimersByTime(50);
    expect(timed.signal.aborted).toBe(true);
    expect(timed.signal.reason).toMatchObject({ message: 'too slow' });

    const cleaned = composeAbortSignal(undefined, 50, 'should not fire');
    cleaned.cleanup();
    vi.advanceTimersByTime(50);
    expect(cleaned.signal.aborted).toBe(false);
  });

  it('passes a composed signal to fetch and returns a successful response', async () => {
    const expected = new Response('ok');
    const fetchMock = vi.fn(async () => expected);
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchWithTimeout('https://example.test', { method: 'POST' }, 100, null, 'timeout'))
      .resolves.toBe(expected);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'POST', signal: expect.any(AbortSignal) });
  });

  it('distinguishes caller cancellation from timeout', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_input: unknown, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    }));
    vi.stubGlobal('fetch', fetchMock);

    const parent = new AbortController();
    const cancelled = fetchWithTimeout('https://example.test', {}, 100, parent.signal, 'too slow');
    parent.abort();
    await expect(cancelled).rejects.toThrow('operation aborted');

    const timed = fetchWithTimeout('https://example.test', {}, 100, null, 'too slow');
    const timedRejection = expect(timed).rejects.toThrow('too slow');
    await vi.advanceTimersByTimeAsync(100);
    await timedRejection;
  });

  it('keeps the timeout active while reading the response body', async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | null = null;
    vi.stubGlobal('fetch', vi.fn(async (_input: unknown, init: RequestInit) => {
      requestSignal = init.signal || null;
      return new Response('body');
    }));

    const pending = fetchAndReadWithTimeout(
      'https://example.test', {}, 50, null, 'body timeout',
      async (response) => new Promise<string>((_resolve, reject) => {
        requestSignal?.addEventListener('abort', () => reject(requestSignal?.reason));
        void response;
      }),
    );
    const rejection = expect(pending).rejects.toThrow('body timeout');
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(50);

    await rejection;
  });
});
