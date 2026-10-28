import { afterEach, expect, it, vi } from 'vitest';
import { checkLatencyBudget } from './latency-budget';

afterEach(() => vi.restoreAllMocks());

it.each([
  { platform: 'win32', limit: 800, firstRequest: 700 },
  { platform: 'darwin', limit: 500, firstRequest: 500 },
  { platform: 'linux', limit: 500, firstRequest: 500 },
])('uses the approved $limit ms response budget on $platform', async ({ platform, limit, firstRequest }) => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  let budget: typeof import('./latency-budget');
  try {
    Object.defineProperty(process, 'platform', { value: platform });
    vi.resetModules();
    budget = await import('./latency-budget');
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
  expect(budget.LATENCY_LIMIT_MS).toBe(limit);
  expect(budget.FIRST_REQUEST_LATENCY_LIMIT_MS).toBe(firstRequest);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  for (const { ms, warnings, fails } of [
    { ms: 300, warnings: 0, fails: false },
    { ms: 301, warnings: 1, fails: false },
    { ms: limit - 1, warnings: 1, fails: false },
    { ms: limit, warnings: 1, fails: false },
    { ms: limit + 1, warnings: 1, fails: true },
  ]) {
    warn.mockClear();
    const check = () => budget.checkLatencyBudget('fixture request', {
      elapsedMs: ms, phases: [{ phase: 'prepared', ms: 100 }],
    });
    if (fails) expect(check).toThrow(`budget ${limit} ms`);
    else expect(check).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(warnings);
    if (warnings) {
      expect(warn.mock.calls[0][0]).toBe('[latency-warning]');
      expect(JSON.parse(warn.mock.calls[0][1])).toEqual({
        metric: 'fixture request', elapsed_ms: ms, target_ms: 300, limit_ms: limit,
        phases: [{ phase: 'prepared', ms: 100 }],
      });
    }
  }
});

it.each([NaN, Infinity, -1])('rejects an invalid measurement (%s) instead of passing silently', ms => {
  expect(() => checkLatencyBudget('fixture request', { elapsedMs: ms })).toThrow('Invalid latency measurement');
});

it.each([700, 701])('enforces the Windows first-request boundary at %i ms while retaining warnings', ms => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const check = () => checkLatencyBudget('first request', { elapsedMs: ms }, 700);
  if (ms === 700) expect(check).not.toThrow();
  else expect(check).toThrow('budget 700 ms');
  expect(JSON.parse(warn.mock.calls[0][1])).toMatchObject({ target_ms: 300, limit_ms: 700 });
});
