import { describe, it, expect } from 'vitest';
import {
  businessDaysBetween, calendarDaysBetween, addCalendarDays,
} from '@/lib/policy/business-days';
import { parseUtcDate } from '@/lib/policy/clock';

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
