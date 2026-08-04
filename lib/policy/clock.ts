const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Parse a date string as UTC. Date-only strings become UTC midnight. */
export function parseUtcDate(value: string): Date {
  const iso = DATE_ONLY.test(value) ? `${value}T00:00:00.000Z` : value;
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid date: ${value}`);
  }
  return parsed;
}

/**
 * Current time. Honours TRENDLY_AS_OF so demos and cassette replay are
 * reproducible; falls back to real system time, which is the correct default.
 */
export function now(): Date {
  const override = process.env.TRENDLY_AS_OF;
  return override ? parseUtcDate(override) : new Date();
}

/** UTC midnight of the given instant — the unit all policy day-math uses. */
export function startOfUtcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
