import { defineConfig } from 'vitest/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: { alias: { '@': path.resolve(__dirname, './') } },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    /**
     * Pin the clock for the whole suite.
     *
     * Policy verdicts are functions of "today": §1.5 counts business days from
     * the expected delivery date, §2.1 counts 30 calendar days from delivery.
     * A suite that reads the wall clock therefore rots — and it did. On
     * 2026-08-06 a test asserting TR-4521 was NOT owed delay credit failed,
     * because the order had genuinely crossed from 2 to 4 business days late.
     * The implementation was right; the unpinned assertion was the bug.
     *
     * The fixed dataset was authored for early August 2026, so that is the
     * reference date. Individual tests may still override this, or `delete` it
     * to exercise the real-clock fallback in `now()`.
     */
    env: { TRENDLY_AS_OF: '2026-08-04T12:00:00Z' },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      include: ['lib/**/*.ts'],
      exclude: ['lib/**/*.d.ts'],
      thresholds: { lines: 90, functions: 90, branches: 90, statements: 90 },
    },
  },
});
