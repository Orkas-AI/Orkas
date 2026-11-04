// Pin sidebar conversation-list time bucketing. timeBucket is a pure helper
// in conversation.js (CJS bridge per CLAUDE.md §9) that classifies an ISO
// timestamp into today / yesterday / last7 / last30 / older against an
// injected `now`. Boundary-case fixtures use a fixed `now` so DST + wall-
// clock skew don't flake the suite.

import { describe, it, expect } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const convBucket = require('../../src/renderer/modules/conv-bucket.js');
const { timeBucket, selectRecentConversations, recentConversationsSince } = convBucket as {
  timeBucket: (iso: string, now?: Date) => 'today' | 'yesterday' | 'last7' | 'last30' | 'older';
  selectRecentConversations: (rows: unknown, now?: Date) => Array<Record<string, unknown>>;
  recentConversationsSince: (now?: Date) => Date;
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

// Recent Tasks uses a rolling 24h window, independently of calendar-day
// headings, with the same activity-field precedence for all projects.
describe('selectRecentConversations — Recent Tasks membership', () => {
  it('keeps pinned tasks regardless of activity age and applies the cutoff again after unpinning', () => {
    const rows = [
      { conversation_id: 'old-pin', pinned_at: NOW.toISOString(), last_active_at: offsetFromTodayStart(-30 * DAY) },
      { conversation_id: 'project-pin', project_id: 'p1', pinned_at: NOW.toISOString() },
      { conversation_id: 'invalid-time-pin', pinned_at: NOW.toISOString(), last_active_at: 'not-a-date' },
      { conversation_id: 'old-unpinned', last_active_at: offsetFromTodayStart(-30 * DAY) },
      { pinned_at: NOW.toISOString() },
    ];
    expect(selectRecentConversations(rows, NOW).map(c => c.conversation_id))
      .toEqual(['old-pin', 'project-pin', 'invalid-time-pin']);
    expect(selectRecentConversations(rows.map(c => ({ ...c, pinned_at: undefined })), NOW)).toEqual([]);
  });

  it('keeps tasks from any project within 24h, including the exact cutoff, and rejects older or invalid rows', () => {
    const rows = [
      { conversation_id: 'unprojected-today', last_active_at: offsetFromTodayStart(10 * 60 * 60 * 1000) },
      { conversation_id: 'projected-today', project_id: 'p1', last_active_at: offsetFromTodayStart(0) },
      { conversation_id: 'yesterday-late', project_id: 'p2', last_active_at: offsetFromTodayStart(-1) },
      { conversation_id: 'cutoff-inside', last_active_at: new Date(NOW.getTime() - DAY + 1).toISOString() },
      { conversation_id: 'cutoff-exact', last_active_at: new Date(NOW.getTime() - DAY).toISOString() },
      { conversation_id: 'cutoff-outside', last_active_at: new Date(NOW.getTime() - DAY - 1).toISOString() },
      { conversation_id: 'yesterday-start', last_active_at: offsetFromTodayStart(-DAY) },
      { conversation_id: 'day-before-late', project_id: 'p3', last_active_at: offsetFromTodayStart(-DAY - 1) },
      { conversation_id: 'no-timestamps' },
      { conversation_id: 'invalid', last_active_at: 'not-a-date' },
      { title: 'no id', last_active_at: NOW.toISOString() },
      null,
    ];
    expect(selectRecentConversations(rows, NOW).map((c) => c.conversation_id))
      .toEqual(['unprojected-today', 'projected-today', 'yesterday-late', 'cutoff-inside', 'cutoff-exact']);
  });

  it('reads last_active_at before updated_at and created_at, exactly like the bucket headers', () => {
    const rows = [
      // Index row is stale but the sidebar already advanced its activity today.
      { conversation_id: 'bumped', updated_at: offsetFromTodayStart(-3 * DAY), last_active_at: NOW.toISOString() },
      // No last_active_at yet (freshly created client-side row).
      { conversation_id: 'created', created_at: offsetFromTodayStart(60_000) },
      { conversation_id: 'stale', updated_at: offsetFromTodayStart(-2 * DAY), created_at: offsetFromTodayStart(-3 * DAY) },
    ];
    expect(selectRecentConversations(rows, NOW).map((c) => c.conversation_id))
      .toEqual(['bumped', 'created']);
  });

  it('expires a task within the same calendar day when checked again', () => {
    const rows = [{ conversation_id: 'yesterday', last_active_at: new Date(NOW.getTime() - DAY).toISOString() }];
    expect(selectRecentConversations(rows, NOW).map((c) => c.conversation_id)).toEqual(['yesterday']);
    expect(selectRecentConversations(rows, new Date(NOW.getTime() + 1))).toEqual([]);
  });

  it('tolerates a missing or non-array cache', () => {
    expect(selectRecentConversations(undefined, NOW)).toEqual([]);
    expect(selectRecentConversations({} as unknown, NOW)).toEqual([]);
  });

  it('loads the startup slice from exactly 24h ago', () => {
    const since = recentConversationsSince(NOW);
    expect(since.getTime()).toBe(NOW.getTime() - DAY);
    expect(NOW.getHours()).toBe(14);
  });

  it.each([
    ['spring forward', '2026-03-09T00:30:00-04:00', '2026-03-08T04:30:00.000Z'],
    ['fall back', '2026-11-02T00:30:00-05:00', '2026-11-01T05:30:00.000Z'],
  ])('uses elapsed hours across %s instead of calendar boundaries', (_name, now, cutoff) => {
    const clock = new Date(now);
    expect(recentConversationsSince(clock).toISOString()).toBe(cutoff);
    expect(selectRecentConversations([
      { conversation_id: 'inside', last_active_at: cutoff },
      { conversation_id: 'outside', last_active_at: new Date(Date.parse(cutoff) - 1).toISOString() },
    ], clock).map(c => c.conversation_id)).toEqual(['inside']);
  });
});
