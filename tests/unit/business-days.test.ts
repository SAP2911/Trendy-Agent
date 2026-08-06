import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  businessDaysBetween, calendarDaysBetween, addCalendarDays,
} from '@/lib/policy/business-days';
import { parseUtcDate, now } from '@/lib/policy/clock';

const d = parseUtcDate;

describe('businessDaysBetween', () => {
  // The single highest-value trap in the dataset: TR-4521 expected Fri 2026-07-31,
  // evaluated Tue 2026-08-04. Four calendar days, but only two business days.
  it('excludes the weekend for TR-4521 (Fri -> Tue = 2, not 4)', () => {
    expect(businessDaysBetween(d('2026-07-31'), d('2026-08-04'))).toBe(2);
    expect(calendarDaysBetween(d('2026-07-31'), d('2026-08-04'))).toBe(4);
  });

  it('counts TR-4525 as 14 business days past expected', () => {
    expect(businessDaysBetween(d('2026-07-15'), d('2026-08-04'))).toBe(14);
  });

  it('returns 0 for same day and for negative ranges', () => {
    expect(businessDaysBetween(d('2026-08-04'), d('2026-08-04'))).toBe(0);
    expect(businessDaysBetween(d('2026-08-04'), d('2026-08-01'))).toBe(0);
  });

  it('counts a full Mon->Fri week as 4 business days', () => {
    expect(businessDaysBetween(d('2026-08-03'), d('2026-08-07'))).toBe(4);
  });

  it('does not count the weekend itself', () => {
    // Fri -> Sat -> Sun all yield 0 business days elapsed
    expect(businessDaysBetween(d('2026-07-31'), d('2026-08-01'))).toBe(0);
    expect(businessDaysBetween(d('2026-07-31'), d('2026-08-02'))).toBe(0);
  });
});

describe('addCalendarDays', () => {
  it('computes the 30-day return window boundary', () => {
    expect(addCalendarDays(d('2026-06-05'), 30).toISOString().slice(0, 10))
      .toBe('2026-07-05');
  });
});

describe('calendarDaysBetween', () => {
  it('returns 0 for negative ranges (reversed dates)', () => {
    expect(calendarDaysBetween(d('2026-08-04'), d('2026-08-01'))).toBe(0);
  });
});

describe('parseUtcDate', () => {
  it('throws on invalid date input', () => {
    expect(() => parseUtcDate('garbage')).toThrow('Invalid date: garbage');
  });

  it('throws on impossible calendar date (Feb 30)', () => {
    expect(() => parseUtcDate('2026-02-30')).toThrow();
  });

  it('throws on impossible calendar date (Apr 31)', () => {
    expect(() => parseUtcDate('2026-04-31')).toThrow();
  });

  it('accepts valid leap day (Feb 29)', () => {
    const result = parseUtcDate('2024-02-29');
    expect(result.toISOString().slice(0, 10)).toBe('2024-02-29');
  });

  it('throws on naive timestamp without Z or offset', () => {
    expect(() => parseUtcDate('2026-08-04T10:00:00')).toThrow();
  });

  it('accepts ISO 8601 UTC with Z', () => {
    const result = parseUtcDate('2026-08-04T10:00:00Z');
    expect(result.toISOString().slice(0, 10)).toBe('2026-08-04');
  });

  it('accepts ISO 8601 with numeric offset', () => {
    const result = parseUtcDate('2026-08-04T10:00:00+05:30');
    // This should parse; the exact time depends on the offset
    expect(result).toBeInstanceOf(Date);
  });
});

describe('now', () => {
  beforeEach(() => {
    delete process.env.TRENDLY_AS_OF;
  });

  afterEach(() => {
    delete process.env.TRENDLY_AS_OF;
  });

  it('returns current time when TRENDLY_AS_OF is not set', () => {
    const before = new Date();
    const result = now();
    const after = new Date();
    expect(result.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(result.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it('returns the override when TRENDLY_AS_OF is set', () => {
    process.env.TRENDLY_AS_OF = '2026-08-04';
    const result = now();
    expect(result.toISOString().slice(0, 10)).toBe('2026-08-04');
  });

  it('re-reads TRENDLY_AS_OF on each call, not cached', () => {
    process.env.TRENDLY_AS_OF = '2026-08-04';
    const first = now();
    process.env.TRENDLY_AS_OF = '2026-08-05';
    const second = now();
    expect(first.toISOString().slice(0, 10)).toBe('2026-08-04');
    expect(second.toISOString().slice(0, 10)).toBe('2026-08-05');
  });
});
