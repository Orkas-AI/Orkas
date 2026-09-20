import { afterEach, expect, it, vi } from 'vitest';
import { checkLatencyBudget } from './latency-budget';

afterEach(() => vi.restoreAllMocks());

it.each([
  { ms: 300, warnings: 0, fails: false },
  { ms: 301, warnings: 1, fails: false },
  { ms: 500, warnings: 1, fails: false },
  { ms: 501, warnings: 1, fails: true },
])('reports $ms ms without turning the 300 ms target into a hard failure', ({ ms, warnings, fails }) => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  const check = () => checkLatencyBudget('fixture request', {
    elapsedMs: ms, phases: [{ phase: 'prepared', ms: 100 }],
  });
  if (fails) expect(check).toThrow('budget 500 ms');
  else expect(check).not.toThrow();
  expect(warn).toHaveBeenCalledTimes(warnings);
  if (warnings) {
    expect(warn.mock.calls[0][0]).toBe('[latency-warning]');
    expect(JSON.parse(warn.mock.calls[0][1])).toEqual({
      metric: 'fixture request', elapsed_ms: ms, target_ms: 300, limit_ms: 500,
      phases: [{ phase: 'prepared', ms: 100 }],
    });
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
