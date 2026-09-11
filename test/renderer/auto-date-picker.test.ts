import { describe, expect, it } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const auto = require('../../src/renderer/modules/auto.js') as {
  _autoLocalDateParts: (value: string) => {
    year: number;
    month: number;
    day: number;
    value: string;
  } | null;
  _autoCalendarCells: (year: number, month: number) => Array<{
    value: string;
    day: number;
    inMonth: boolean;
  }>;
  _autoCalendarShiftDate: (value: string, days: number) => string;
  _autoCalendarShiftMonth: (value: string, months: number) => string;
};

describe('automation date picker calendar math', () => {
  it('accepts real local dates and rejects rollover dates', () => {
    expect(auto._autoLocalDateParts('2024-02-29')).toMatchObject({
      year: 2024,
      month: 2,
      day: 29,
      value: '2024-02-29',
    });
    expect(auto._autoLocalDateParts('2025-02-29')).toBeNull();
    expect(auto._autoLocalDateParts('2026-8-29')).toBeNull();
  });

  it('builds a stable six-week Sunday-first grid', () => {
    const cells = auto._autoCalendarCells(2026, 7);
    expect(cells).toHaveLength(42);
    expect(cells[0]).toEqual({ value: '2026-07-26', day: 26, inMonth: false });
    expect(cells[6]).toEqual({ value: '2026-08-01', day: 1, inMonth: true });
    expect(cells[41]).toEqual({ value: '2026-09-05', day: 5, inMonth: false });
  });

  it('moves across day and month boundaries without date rollover surprises', () => {
    expect(auto._autoCalendarShiftDate('2026-08-31', 1)).toBe('2026-09-01');
    expect(auto._autoCalendarShiftDate('2026-03-01', -1)).toBe('2026-02-28');
    expect(auto._autoCalendarShiftMonth('2025-01-31', 1)).toBe('2025-02-28');
    expect(auto._autoCalendarShiftMonth('2024-01-31', 1)).toBe('2024-02-29');
  });
});
