import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  recordUsageTokens,
  taskTokens,
  resetTaskTokens,
  isOverTaskBudget,
  maxTaskTokens,
} from '../../../src/main/util/conversation-cost-meter';

const CID = 'c_cost_meter_test';
let prevMax: string | undefined;

beforeEach(() => {
  prevMax = process.env.ORKAS_MAX_TASK_TOKENS;
  resetTaskTokens(CID);
});
afterEach(() => {
  if (prevMax === undefined) delete process.env.ORKAS_MAX_TASK_TOKENS;
  else process.env.ORKAS_MAX_TASK_TOKENS = prevMax;
  resetTaskTokens(CID);
});

describe('conversation-cost-meter', () => {
  it('accumulates input+output tokens per cid', () => {
    recordUsageTokens(CID, { inputTokens: 100, outputTokens: 20 });
    recordUsageTokens(CID, { inputTokens: 30, outputTokens: 5 });
    expect(taskTokens(CID)).toBe(155);
  });

  it('prefers totalTokens when provided', () => {
    recordUsageTokens(CID, { inputTokens: 100, outputTokens: 20, totalTokens: 999 });
    expect(taskTokens(CID)).toBe(999);
  });

  it('no-ops without a cid or usage, and on non-positive totals', () => {
    recordUsageTokens(undefined, { inputTokens: 100, outputTokens: 20 });
    recordUsageTokens(CID, undefined);
    recordUsageTokens(CID, { inputTokens: 0, outputTokens: 0 });
    expect(taskTokens(CID)).toBe(0);
  });

  it('resetTaskTokens clears the task allowance', () => {
    recordUsageTokens(CID, { inputTokens: 1000, outputTokens: 0 });
    resetTaskTokens(CID);
    expect(taskTokens(CID)).toBe(0);
  });

  it('isOverTaskBudget trips at the ceiling (env-overridable)', () => {
    process.env.ORKAS_MAX_TASK_TOKENS = '500';
    expect(maxTaskTokens()).toBe(500);
    recordUsageTokens(CID, { inputTokens: 400, outputTokens: 0 });
    expect(isOverTaskBudget(CID)).toBe(false);
    recordUsageTokens(CID, { inputTokens: 100, outputTokens: 0 }); // now exactly 500
    expect(isOverTaskBudget(CID)).toBe(true);
  });

  it('a non-positive ceiling disables the backstop', () => {
    process.env.ORKAS_MAX_TASK_TOKENS = '0';
    recordUsageTokens(CID, { inputTokens: 10_000_000_000, outputTokens: 0 });
    expect(isOverTaskBudget(CID)).toBe(false);
  });

  it('defaults to a generous ceiling that normal usage never hits', () => {
    delete process.env.ORKAS_MAX_TASK_TOKENS;
    expect(maxTaskTokens()).toBe(25_000_000);
    recordUsageTokens(CID, { inputTokens: 2_000_000, outputTokens: 100_000 }); // a heavy task
    expect(isOverTaskBudget(CID)).toBe(false);
  });
});
