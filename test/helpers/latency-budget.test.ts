import { afterEach, expect, it, vi } from 'vitest';
import { checkLatencyBudget, LATENCY_TARGET_MS } from './latency-budget';
import { createModelEvalLogCollector } from '../../scripts/model-eval-log-policy.mjs';

afterEach(() => vi.restoreAllMocks());

it('surfaces a soft latency warning without converting it into a checkpoint error', () => {
  const collector = createModelEvalLogCollector('latency-contract');
  const write = process.stdout.write.bind(process.stdout);
  vi.spyOn(process.stdout, 'write').mockImplementation(chunk => {
    collector.ingest('stdout', String(chunk));
    return write(chunk);
  });
  checkLatencyBudget('fixture response', { elapsedMs: LATENCY_TARGET_MS + 1 }, 700);
  expect(collector.finish()).toMatchObject({ passed: true, requiresReview: true,
    coveragePassed: true, levelCounts: { warn: 1, error: 0 } });
  const unknown = createModelEvalLogCollector('unknown-stderr-control');
  unknown.ingest('stderr', 'Unexpected fixture stderr\n');
  expect(unknown.finish().passed).toBe(false);
});

it.each([
  { platform: 'win32', limit: 1000, firstRequest: 1000, target: 500, ready: 3000, interactiveGap: 300, bulkGap: 500, multilineEdit: 300, paragraphEdit: 500 },
  { platform: 'darwin', limit: 500, firstRequest: 500, target: 300, ready: 1000, interactiveGap: 150, bulkGap: 300, multilineEdit: 150, paragraphEdit: 300 },
  { platform: 'linux', limit: 500, firstRequest: 500, target: 300, ready: 1000, interactiveGap: 150, bulkGap: 300, multilineEdit: 150, paragraphEdit: 300 },
])('uses the approved $limit ms response budget on $platform', async ({ platform, limit, firstRequest, target, ready, interactiveGap, bulkGap, multilineEdit, paragraphEdit }) => {
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
  expect(budget.LATENCY_TARGET_MS).toBe(target);
  expect(budget.LIBRARY_READY_TIMEOUT_MS).toBe(ready);
  expect(budget.INTERACTIVE_MAIN_GAP_LIMIT_MS).toBe(interactiveGap);
  expect(budget.BULK_MAIN_GAP_LIMIT_MS).toBe(bulkGap);
  expect(budget.COMPOSER_EDIT_LIMIT_MS).toEqual({ multiline: multilineEdit, paragraph: paragraphEdit });
  const warn = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  for (const ms of [firstRequest - 1, firstRequest, firstRequest + 1]) {
    warn.mockClear();
    const check = () => budget.checkLatencyBudget('first request', { elapsedMs: ms }, budget.FIRST_REQUEST_LATENCY_LIMIT_MS);
    if (ms <= firstRequest) expect(check).not.toThrow();
    else expect(check).toThrow(`budget ${firstRequest} ms`);
    expect(warn).toHaveBeenCalledOnce();
    expect(JSON.parse(String(warn.mock.calls[0][0]).split('latency target exceeded ')[1]))
      .toMatchObject({ elapsed_ms: ms, target_ms: target, limit_ms: firstRequest });
  }
  for (const { ms, warnings, fails } of [
    { ms: target, warnings: 0, fails: false },
    { ms: target + 1, warnings: 1, fails: false },
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
      expect(warn.mock.calls[0][0]).toMatch(/^\[00:00:00.000\] \[warn\] \[\(latency-budget\)\] latency target exceeded /);
      expect(JSON.parse(String(warn.mock.calls[0][0]).split('latency target exceeded ')[1])).toEqual({
        metric: 'fixture request', elapsed_ms: ms, target_ms: target, limit_ms: limit,
        phases: [{ phase: 'prepared', ms: 100 }],
      });
    }
  }
});

it.each([NaN, Infinity, -1])('rejects an invalid measurement (%s) instead of passing silently', ms => {
  expect(() => checkLatencyBudget('fixture request', { elapsedMs: ms })).toThrow('Invalid latency measurement');
});
