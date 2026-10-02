import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const api = require('../../../../bin/yahoo-shopping-api.cjs');
const { withRequestSignal } = require('../../../../bin/commerce-request-context.cjs');
let sequence = 0;
const config = () => ({ provider: 'yahoo_shopping', metadata: { seller_id: 'rate-fixture' },
  credentials: { client_id: `rate-client-${++sequence}`, client_secret: 'fixture-secret', access_token: 'fixture-token' } });
const invoke = (c: object) => api.request(c, 'getShopCategory', { seller_id: 'rate-fixture' });
function network() {
  const sendTimes: number[] = [];
  const fetch = vi.fn(async () => {
    sendTimes.push(Date.now());
    return new Response('<ResultSet totalResultsAvailable="0"/>');
  });
  vi.stubGlobal('fetch', fetch);
  return { fetch, sendTimes };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('Yahoo! merchant request spacing recovery', () => {
  it('completes a sequential read when a timer wakes early, without sending before the one-second boundary', async () => {
    // A real scheduler may wake before its requested wall-clock deadline. The merchant
    // should still receive the second result; the network spacing is the independent oracle.
    vi.useFakeTimers(); vi.setSystemTime(10000);
    const c = config(), { fetch, sendTimes } = network();
    await invoke(c);
    const schedule = globalThis.setTimeout;
    vi.spyOn(globalThis, 'setTimeout').mockImplementationOnce(((callback: () => void, delay: number) =>
      schedule(callback, delay - 1)) as typeof setTimeout);
    const next = invoke(c).then((value: unknown) => ({ value }), (error: unknown) => ({ error }));
    await vi.advanceTimersByTimeAsync(999);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await next).toHaveProperty('value.data.ResultSet');
    expect(sendTimes).toEqual([10000, 11000]);
  });

  it('rejects a competing read instead of following its new deadline, and cancels a waiting request without sending', async () => {
    vi.useFakeTimers(); vi.setSystemTime(20000);
    const c = config(), { fetch, sendTimes } = network();
    await invoke(c);
    const racing = Promise.allSettled([invoke(c), invoke(c)]);
    await vi.advanceTimersByTimeAsync(1000);
    const outcomes = await racing;
    expect(outcomes.filter(value => value.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find(value => value.status === 'rejected')).toMatchObject({ reason: { code: 'E_TOOL_CALL_RATE_LIMIT' } });
    expect(sendTimes).toEqual([20000, 21000]);
    const controller = new AbortController();
    const cancelled = withRequestSignal(controller.signal, () => invoke(c)).catch((error: unknown) => error);
    controller.abort();
    await vi.advanceTimersByTimeAsync(1000);
    expect(await cancelled).toMatchObject({ code: 'E_TOOL_CALL_CANCELLED' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
