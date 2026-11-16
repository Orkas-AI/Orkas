import { afterEach, expect, it, vi } from 'vitest';
import { checkLatencyBudget, LATENCY_TARGET_MS, resolvePerformanceTier } from './latency-budget';
import { createModelEvalLogCollector } from '../../scripts/model-eval-log-policy.mjs';

const device = vi.hoisted(() => ({ tier: 'standard' as 'standard' | 'low' }));
vi.mock('../../src/main/util/boot-device-profile', () => ({ getBootDeviceProfile: () => device }));
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); device.tier = 'standard'; });

it('surfaces a soft latency warning without converting it into a checkpoint error', () => {
  const collector = createModelEvalLogCollector('latency-contract');
  const write = process.stdout.write.bind(process.stdout);
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
    collector.ingest('stdout', String(chunk));
    return write(chunk);
  });
  checkLatencyBudget('fixture response', { elapsedMs: LATENCY_TARGET_MS + 1 });
  expect(collector.finish()).toMatchObject({ passed: true, requiresReview: true,
    coveragePassed: true, levelCounts: { warn: 1, error: 0 } });
  const unknown = createModelEvalLogCollector('unknown-stderr-control');
  unknown.ingest('stderr', 'Unexpected fixture stderr\n');
  expect(unknown.finish().passed).toBe(false);
});

it.each([
  { tier: 'standard', response: 1000, first: 2000, ready: 5000, interactive: 300, bulk: 500, multiline: 300, paragraph: 500, largeSearch: 2000 },
  { tier: 'low', response: 2000, first: 3000, ready: 10000, interactive: 500, bulk: 750, multiline: 500, paragraph: 750, largeSearch: 4000 },
] as const)('applies bounded $tier tolerances and rejects stalls for every metric', async expected => {
  vi.stubEnv('ORKAS_TEST_PERFORMANCE_TIER', 'auto');
  device.tier = expected.tier;
  vi.resetModules();
  const budget = await import('./latency-budget');
  expect(budget.PERFORMANCE_TIER).toBe(expected.tier);
  expect(budget.LATENCY_TARGET_MS).toBe(expected.response / 2);
  expect(budget.LIBRARY_READY_TIMEOUT_MS).toBe(expected.ready);
  expect(budget.COMPOSER_EDIT_LIMIT_MS).toEqual({ multiline: expected.multiline, paragraph: expected.paragraph });
  const limits = [
    [budget.LATENCY_LIMIT_MS, expected.response],
    [budget.FIRST_REQUEST_LATENCY_LIMIT_MS, expected.first],
    [budget.INTERACTIVE_MAIN_GAP_LIMIT_MS, expected.interactive],
    [budget.BULK_MAIN_GAP_LIMIT_MS, expected.bulk],
    [budget.LARGE_REPOSITORY_SEARCH_LIMIT_MS, expected.largeSearch],
    [budget.INDEXED_SEARCH_LATENCY_LIMIT_MS, expected.interactive],
  ];
  const warn = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  for (const [limit, independentLimit] of limits) {
    expect(limit).toBe(independentLimit);
    const target = independentLimit / 2;
    for (const ms of [target - 1, target, target + 1, independentLimit - 1, independentLimit, independentLimit + 1]) {
      warn.mockClear();
      const check = () => budget.checkLatencyBudget('fixture request', {
        elapsedMs: ms, phases: [{ phase: 'prepared', ms: 10 }],
      }, limit);
      if (ms <= independentLimit) expect(check).not.toThrow();
      else expect(check).toThrow(`budget ${independentLimit} ms`);
      expect(warn).toHaveBeenCalledTimes(ms > target ? 1 : 0);
      if (ms > target) {
        expect(warn.mock.calls[0][0]).toMatch(/^\[00:00:00.000\] \[warn\] \[\(latency-budget\)\] latency target exceeded /);
        expect(JSON.parse(String(warn.mock.calls[0][0]).split('latency target exceeded ')[1])).toEqual({
          metric: 'fixture request', elapsed_ms: ms, target_ms: target, limit_ms: independentLimit,
          tier: expected.tier, phases: [{ phase: 'prepared', ms: 10 }],
        });
      }
    }
  }
});

it('selects hardware defaults and reproducible explicit tiers without an unbounded multiplier', async () => {
  for (const detected of ['standard', 'low'] as const) {
    expect(resolvePerformanceTier(undefined, detected)).toBe(detected);
    expect(resolvePerformanceTier('auto', detected)).toBe(detected);
    for (const requested of ['standard', 'low'] as const) {
      expect(resolvePerformanceTier(requested, detected)).toBe(requested);
    }
  }
  for (const invalid of ['', 'slow', '10', 'LOW']) {
    expect(() => resolvePerformanceTier(invalid, 'standard')).toThrow('Invalid ORKAS_TEST_PERFORMANCE_TIER');
  }
  device.tier = 'standard';
  vi.stubEnv('ORKAS_TEST_PERFORMANCE_TIER', 'low');
  vi.resetModules();
  expect((await import('./latency-budget')).LATENCY_LIMIT_MS).toBe(2000);
});

it.each([NaN, Infinity, -1])('rejects an invalid measurement (%s) instead of passing silently', ms => {
  expect(() => checkLatencyBudget('fixture request', { elapsedMs: ms })).toThrow('Invalid latency measurement');
});

it.each([NaN, Infinity, -1, 0])('rejects an invalid budget (%s) instead of disabling the gate', limit => {
  expect(() => checkLatencyBudget('fixture request', { elapsedMs: 1 }, limit)).toThrow('Invalid latency budget');
});
