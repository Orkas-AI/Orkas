import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const diagnostics = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() }));
vi.mock('../../../src/main/logger', () => ({ createLogger: () => diagnostics }));
import { fetchMediaAndRead, mediaRateLimitDelay, mediaLimitRetryDelay } from '../../../src/main/util/media-rate-limit';
beforeEach(() => vi.clearAllMocks());
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
const limited = (code?: string, header = '2') => new Response(code ? JSON.stringify({ error: { code } }) : '',
  { status: 429, headers: { 'Retry-After': header } });

it('keeps every speech retry at ten seconds unless the provider requires a longer wait', () => {
  expect([0, 1, 2, 3, 20].map(attempt => mediaLimitRetryDelay(attempt, 0, 'tts')))
    .toEqual([10000, 10000, 10000, 10000, 10000]);
  expect(mediaLimitRetryDelay(0, 40000, 'tts')).toBe(40000);
  expect(mediaLimitRetryDelay(0, 0, 'image')).toBe(1000);
});

it('waits Retry-After then retries identical rejected submission and reads the success once', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn().mockResolvedValueOnce(limited('RateLimitExceeded'))
    .mockResolvedValueOnce(new Response('{"id":"accepted"}'));
  vi.stubGlobal('fetch', fetch);
  const read = vi.fn((response: Response) => response.json());
  const init = { method: 'POST', headers: { 'Idempotency-Key': 'same-request' }, body: '{"prompt":"fixture"}' };
  const pending = fetchMediaAndRead('https://media.invalid/tasks', init, 30_000, undefined, 'timeout', read);
  await vi.advanceTimersByTimeAsync(1999);
  expect(fetch).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(await pending).toMatchObject({ body: { id: 'accepted' } });
  expect(fetch).toHaveBeenCalledTimes(2); expect(read).toHaveBeenCalledOnce();
  for (const [, sent] of fetch.mock.calls) expect(sent).toMatchObject(init);
});

it('keeps the speech HTTP reader pending through all limit retries until the shared deadline', async () => {
  vi.useFakeTimers(); vi.setSystemTime(0);
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => Date.now());
  try {
    const fetch = vi.fn(async () => limited(undefined, '0'));
    const read = vi.fn((response: Response) => response.text());
    vi.stubGlobal('fetch', fetch);
    let settled = false;
    const pending = fetchMediaAndRead('https://media.invalid/speech', {}, 55000, undefined, 'speech timeout', read, [], 'tts');
    void pending.then(() => { settled = true; }, () => { settled = true; });
    const observed = expect(pending).rejects.toThrow('speech timeout');
    await vi.advanceTimersByTimeAsync(54999);
    expect(settled).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(6);
    await vi.advanceTimersByTimeAsync(1); await observed;
    expect(fetch).toHaveBeenCalledTimes(6);
    expect(read).not.toHaveBeenCalled();
    expect(records()).toHaveLength(4);
    expect(records().at(-1)).toMatchObject({ outcome: 'budget_exhausted', retry_bound: 'deadline', wait_ms: 55000 });
  } finally { clock.mockRestore(); }
});

it.each(['insufficient_quota', 'QuotaExceeded', 'AuthenticationError', 'InvalidParameter', 'unknown'])
('does not turn %s into a retry using diagnostic prose', async code => {
  expect(await mediaRateLimitDelay(new Response(JSON.stringify({ error: { code, message: 'rate limited, try again' } }), { status: 429 }))).toBeNull();
});

it('never replays transport uncertainty, accepted failure or an ordinary 5xx', async () => {
  for (const status of [200, 400, 401, 402, 403, 503]) {
    const fetch = vi.fn(async () => new Response('fixture', { status }));
    vi.stubGlobal('fetch', fetch);
    await fetchMediaAndRead('https://media.invalid', { method: 'POST' }, 30_000, undefined, 'timeout', response => response.text());
    expect(fetch).toHaveBeenCalledOnce();
  }
  const fetch = vi.fn(async () => { throw new Error('connection lost'); });
  vi.stubGlobal('fetch', fetch);
  await expect(fetchMediaAndRead('https://media.invalid', {}, 30_000, undefined, 'timeout', response => response.text())).rejects.toThrow('connection lost');
  expect(fetch).toHaveBeenCalledOnce();
});

it('stops at three retries and cancels waiting without another send', async () => {
  vi.useFakeTimers();
  const fetch = vi.fn(async () => limited()); vi.stubGlobal('fetch', fetch);
  const pending = fetchMediaAndRead('https://media.invalid', {}, 30_000, undefined, 'timeout', response => response.status as any);
  await vi.advanceTimersByTimeAsync(8000);
  expect((await pending).body).toBe(429); expect(fetch).toHaveBeenCalledTimes(4);
  const stop = new AbortController();
  const cancelled = fetchMediaAndRead('https://media.invalid', {}, 30_000, stop.signal, 'timeout', response => response.text());
  const observed = expect(cancelled).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(1); stop.abort(); await observed;
  await vi.advanceTimersByTimeAsync(8000); expect(fetch).toHaveBeenCalledTimes(5);
});

it('honors HTTP date hints and leaves requests untouched when the existing budget cannot fit the wait', async () => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-13T00:00:00Z'));
  expect(await mediaRateLimitDelay(limited(undefined, 'Fri, 13 Nov 2026 00:00:12 GMT'))).toBe(12000);
  const fetch = vi.fn(async () => limited(undefined, '120')); vi.stubGlobal('fetch', fetch);
  expect((await fetchMediaAndRead('https://media.invalid', {}, 1000, undefined, 'timeout', response => response.text())).response.status).toBe(429);
  expect(fetch).toHaveBeenCalledOnce();
});

it('waits on the image admission busy code only where that owner explicitly allows it', async () => {
  const busy = () => new Response('{"error":{"code":"server_busy"}}', { status: 503 });
  expect(await mediaRateLimitDelay(busy())).toBeNull();
  expect(await mediaRateLimitDelay(busy(), undefined, ['server_busy'])).toBe(0);
  expect(await mediaRateLimitDelay(new Response('{"error":{"code":"upstream_error"}}', { status: 503 }), undefined, ['server_busy'])).toBeNull();
});

it('does not send a late retry when backoff resumes after the existing deadline', async () => {
  vi.useFakeTimers();
  let clock = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => clock);
  const fetch = vi.fn(async () => limited(undefined, '1')); vi.stubGlobal('fetch', fetch);
  const pending = fetchMediaAndRead('https://media.invalid', {}, 3000, undefined, 'budget exhausted', response => response.text());
  const rejected = expect(pending).rejects.toThrow('budget exhausted');
  await vi.advanceTimersByTimeAsync(0); clock = 4000;
  await vi.advanceTimersByTimeAsync(1000); await rejected;
  expect(fetch).toHaveBeenCalledOnce();
  vi.restoreAllMocks();
});

const records = () => diagnostics.warn.mock.calls.filter(([event]) => event === 'media_rate_limit').map(([, data]) => data);

it('makes recovered latency discoverable without recording request or provider content', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ error: {
    code: 'RateLimitExceeded.private-provider-suffix', message: 'private-upstream-message',
  } }), { status: 429, headers: { 'Retry-After': '2' } })).mockResolvedValueOnce(new Response('accepted')));
  const pending = fetchMediaAndRead('https://private-host.invalid/private-path', {
    headers: { Authorization: 'private-key' }, body: 'private-prompt', method: 'POST',
  }, 30_000, undefined, 'timeout', response => response.text());
  await vi.advanceTimersByTimeAsync(2000);
  expect((await pending).body).toBe('accepted');
  expect(records()).toEqual([
    expect.objectContaining({ event: 'wait', status: 429, code: 'RateLimitExceeded.*', retry: 1, planned_wait_ms: 2000 }),
    expect.objectContaining({ event: 'result', outcome: 'response_received', status: 200, retry_count: 1, wait_ms: 2000 }),
  ]);
  expect(records()[0].request_ref).toBe(records()[1].request_ref);
  expect(JSON.stringify(records())).not.toMatch(/private-/);
});

it('records budget refusal even when no retry fits, and keeps ordinary traffic quiet', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => limited(undefined, '120')));
  await fetchMediaAndRead('https://media.invalid', {}, 1000, undefined, 'timeout', response => response.text());
  expect(records()).toEqual([expect.objectContaining({ event: 'result', outcome: 'budget_exhausted', status: 429, retry_count: 0, planned_wait_ms: 120000 })]);
  diagnostics.warn.mockClear();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('ok')));
  await fetchMediaAndRead('https://media.invalid', {}, 1000, undefined, 'timeout', response => response.text());
  expect(records()).toEqual([]);
});

it('bounds repeated-limit logs and records cancellation and later transport uncertainty', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn(async () => limited(undefined, '1')));
  const pending = fetchMediaAndRead('https://media.invalid', {}, 30_000, undefined, 'timeout', response => response.text());
  await vi.advanceTimersByTimeAsync(7000); await pending;
  expect(records()).toHaveLength(4);
  expect(records().at(-1)).toMatchObject({ event: 'result', outcome: 'http_error', status: 429, retry_count: 3, wait_ms: 7000 });
  diagnostics.warn.mockClear();
  const stop = new AbortController();
  const cancelled = fetchMediaAndRead('https://media.invalid', {}, 30_000, stop.signal, 'timeout', response => response.text());
  const observed = expect(cancelled).rejects.toThrow();
  await vi.advanceTimersByTimeAsync(500); stop.abort(); await observed;
  expect(records().at(-1)).toMatchObject({ outcome: 'cancelled', wait_ms: 500 });
  diagnostics.warn.mockClear();
  const failure = new Error('private-network-error');
  vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(limited(undefined, '1')).mockRejectedValueOnce(failure));
  const uncertain = fetchMediaAndRead('https://media.invalid', {}, 30_000, undefined, 'timeout', response => response.text());
  const rejected = expect(uncertain).rejects.toBe(failure);
  await vi.advanceTimersByTimeAsync(1000); await rejected;
  expect(records().at(-1)).toMatchObject({ outcome: 'failed', retry_count: 1, wait_ms: 1000 });
  expect(JSON.stringify(records())).not.toContain('private-network-error');
});

it('keeps recovery correct when diagnostic delivery fails', async () => {
  vi.useFakeTimers();
  diagnostics.warn.mockImplementation(() => { throw new Error('diagnostic sink unavailable'); });
  try {
    const fetch = vi.fn().mockResolvedValueOnce(limited(undefined, '1')).mockResolvedValueOnce(new Response('accepted'));
    vi.stubGlobal('fetch', fetch);
    const pending = fetchMediaAndRead('https://media.invalid', {}, 30_000, undefined, 'timeout', response => response.text());
    await vi.advanceTimersByTimeAsync(1000);
    expect((await pending).body).toBe('accepted');
    expect(fetch).toHaveBeenCalledTimes(2);
  } finally { diagnostics.warn.mockReset(); }
});
