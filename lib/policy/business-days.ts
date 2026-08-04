import { startOfUtcDay } from './clock';

const MS_PER_DAY = 86_400_000;

/** Whole calendar days elapsed from `from` to `to`. Negative ranges clamp to 0. */
export function calendarDaysBetween(from: Date, to: Date): number {
  const diff = (startOfUtcDay(to).getTime() - startOfUtcDay(from).getTime()) / MS_PER_DAY;
  return diff > 0 ? diff : 0;
}

/**
 * Business days elapsed from `from` to `to`, counting days AFTER `from` up to
 * and including `to`, excluding Saturdays and Sundays.
 *
 * Policy §1.5 counts in business days, not calendar days. Getting this wrong
 * offers money on TR-4521, which is only 2 business days past expected.
 *
 * Known limitation: weekends only. trendly_policy.md names no holiday calendar,
 * and inventing one would violate §7. See SOLUTION.md discovery question #2.
 */
export function businessDaysBetween(from: Date, to: Date): number {
  let count = 0;
  const cursor = startOfUtcDay(from);
  const end = startOfUtcDay(to);
  while (cursor.getTime() < end.getTime()) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) count += 1;
  }
  return count;
}

export function addCalendarDays(d: Date, n: number): Date {
  const result = startOfUtcDay(d);
  result.setUTCDate(result.getUTCDate() + n);
  return result;
}
