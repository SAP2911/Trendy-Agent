const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** Parse a date string as UTC. Date-only strings become UTC midnight. */
export function parseUtcDate(value: string): Date {
  let iso: string;
  let isDateOnly = false;

  if (DATE_ONLY.test(value)) {
    isDateOnly = true;
    iso = `${value}T00:00:00.000Z`;
  } else {
    // Non-date-only strings must have explicit UTC designation (Z or ±HH:MM offset)
    if (!value.includes('Z') && !/[+-]\d{2}:\d{2}$/.test(value)) {
      throw new Error(`Invalid date: ${value} (must have explicit UTC designator Z or offset)`);
    }
    iso = value;
  }

  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid date: ${value}`);
  }

  // For date-only strings, validate that the parsed UTC date matches the input
  // This catches impossible dates like 2026-02-30 which silently become 2026-03-02
  if (isDateOnly) {
    const [year, month, day] = value.split('-').map(Number);
    const parsedYear = parsed.getUTCFullYear();
    const parsedMonth = parsed.getUTCMonth() + 1; // getUTCMonth returns 0-11
    const parsedDay = parsed.getUTCDate();

    if (parsedYear !== year || parsedMonth !== month || parsedDay !== day) {
      throw new Error(`Invalid date: ${value} (impossible calendar date)`);
    }
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
