// Pin sidebar conversation-list time bucketing. timeBucket is a pure helper
// in conversation.js (CJS bridge per CLAUDE.md §9) that classifies an ISO
// timestamp into today / yesterday / last7 / last30 / older against an
// injected `now`. Boundary-case fixtures use a fixed `now` so DST + wall-
// clock skew don't flake the suite.

import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const convBucket = require('../../src/renderer/modules/conv-bucket.js');
const { timeBucket } = convBucket as {
  timeBucket: (iso: string, now?: Date) => 'today' | 'yesterday' | 'last7' | 'last30' | 'older';
};

// 2026-05-15T14:30:00 local — anchor every fixture against this; today
// starts at 2026-05-15T00:00:00 local.
const NOW = new Date(2026, 4, 15, 14, 30, 0);
const DAY = 24 * 60 * 60 * 1000;
const todayStart = (() => { const d = new Date(NOW); d.setHours(0, 0, 0, 0); return d; })();
function offsetFromTodayStart(ms: number): string {
  return new Date(todayStart.getTime() + ms).toISOString();
}

describe('timeBucket — today', () => {
  it('exactly local midnight today → today', () => {
    expect(timeBucket(offsetFromTodayStart(0), NOW)).toBe('today');
  });

  it('current wall-clock instant → today', () => {
    expect(timeBucket(NOW.toISOString(), NOW)).toBe('today');
  });

  it('one millisecond before midnight today → yesterday', () => {
    expect(timeBucket(offsetFromTodayStart(-1), NOW)).toBe('yesterday');
  });
});

describe('timeBucket — yesterday', () => {
  it('exactly local midnight yesterday → yesterday', () => {
    expect(timeBucket(offsetFromTodayStart(-DAY), NOW)).toBe('yesterday');
  });

  it('one millisecond before midnight yesterday → last7', () => {
    expect(timeBucket(offsetFromTodayStart(-DAY - 1), NOW)).toBe('last7');
  });
});

describe('timeBucket — last7', () => {
  it('3 days ago → last7', () => {
    expect(timeBucket(offsetFromTodayStart(-3 * DAY + 1), NOW)).toBe('last7');
  });

  it('exactly 7 days ago at midnight → last7 (boundary inclusive)', () => {
    expect(timeBucket(offsetFromTodayStart(-7 * DAY), NOW)).toBe('last7');
  });

  it('one millisecond before 7-day boundary → last30', () => {
    expect(timeBucket(offsetFromTodayStart(-7 * DAY - 1), NOW)).toBe('last30');
  });
});

describe('timeBucket — last30', () => {
  it('15 days ago → last30', () => {
    expect(timeBucket(offsetFromTodayStart(-15 * DAY), NOW)).toBe('last30');
  });

  it('exactly 30 days ago at midnight → last30 (boundary inclusive)', () => {
    expect(timeBucket(offsetFromTodayStart(-30 * DAY), NOW)).toBe('last30');
  });

  it('one millisecond before 30-day boundary → older', () => {
    expect(timeBucket(offsetFromTodayStart(-30 * DAY - 1), NOW)).toBe('older');
  });
});

describe('timeBucket — older + degenerate inputs', () => {
  it('60 days ago → older', () => {
    expect(timeBucket(offsetFromTodayStart(-60 * DAY), NOW)).toBe('older');
  });

  it('empty iso → older (missing timestamp gets the safest bucket)', () => {
    expect(timeBucket('', NOW)).toBe('older');
  });

  it('null-ish iso → older', () => {
    expect(timeBucket(null as unknown as string, NOW)).toBe('older');
    expect(timeBucket(undefined as unknown as string, NOW)).toBe('older');
  });

  it('malformed iso → older (no NaN leak)', () => {
    expect(timeBucket('not-a-date', NOW)).toBe('older');
  });
});
