import { describe, it, expect } from 'vitest';
import { getClauses, getClause, clauseIndexForPrompt, parse } from '@/lib/policy/clauses';

describe('policy clause parser', () => {
  it('parses exactly 29 addressable units', () => {
    expect(getClauses()).toHaveLength(29);
  });

  it('extracts every numbered clause id', () => {
    const ids = getClauses().map((c) => c.id);
    for (const id of [
      '1.1', '1.2', '1.3', '1.4', '1.5', '1.6', '1.7',
      '2.1', '2.2', '2.3', '2.4', '2.5', '2.6',
      '3.1', '3.2', '3.3', '3.4',
      '4.1', '4.2', '4.3', '4.4',
      '5.1', '5.2', '5.3',
      '6.1', '6.2', '7',
    ]) {
      expect(ids).toContain(id);
    }
  });

  it('includes the two meta clauses', () => {
    const ids = getClauses().map((c) => c.id);
    expect(ids).toContain('meta.source-of-truth');
    expect(ids).toContain('meta.support-hours');
  });

  it('captures the 30-day rule verbatim in 2.1', () => {
    expect(getClause('2.1')?.text).toContain('30 calendar days');
  });

  it('captures the full refund table in 3.1', () => {
    const text = getClause('3.1')?.text ?? '';
    expect(text).toContain('5–7 business days');
    expect(text).toContain('Cash on delivery');
  });

  it('lists all five non-returnable categories in 2.3', () => {
    const text = getClause('2.3')?.text ?? '';
    for (const c of ['Innerwear', 'Jewellery', 'Beauty', 'Face masks', 'Gift cards']) {
      expect(text).toContain(c);
    }
  });

  it('builds a compact prompt index under 1200 characters', () => {
    const index = clauseIndexForPrompt();
    expect(index).toContain('2.1');
    expect(index.length).toBeLessThan(1200);
  });

  it('returns undefined for an unknown clause id', () => {
    expect(getClause('99.9')).toBeUndefined();
  });

  it('excludes both meta clauses from the prompt index', () => {
    const index = clauseIndexForPrompt();
    expect(index).not.toContain('meta.source-of-truth');
    expect(index).not.toContain('meta.support-hours');
  });

  it('captures section 7 as a single clause with all five prohibitions', () => {
    const text = getClause('7')?.text ?? '';
    expect(text).toContain('Offer discounts');
    expect(text).toContain('Collect bank account numbers');
    expect(text).toContain('Give medical, legal, or financial advice');
    expect(text).toContain('Confirm or discuss any order belonging to a different customer');
    expect(text).toContain('Invent policy where this document is silent');
  });

  it('every clause body is distinct from its title (text is the body, not just the heading)', () => {
    for (const c of getClauses()) {
      if (c.id.startsWith('meta.')) continue;
      expect(c.text.length).toBeGreaterThan(c.title.length);
    }
  });
});

describe('parse() — pure function used for the build-time count assertion', () => {
  it('throws a descriptive error when the parsed count does not match EXPECTED_CLAUSE_COUNT', () => {
    // A markdown doc that yields far fewer than 29 addressable units. Exercises
    // the tripwire this parser exists to enforce, without touching the real
    // (checksum-protected) trendly_policy.md.
    const brokenMarkdown = '## 1. Shipping\n\n**1.1 Dispatch times.** Some text.\n';
    expect(() => parse(brokenMarkdown)).toThrow(/Policy parse produced/);
    expect(() => parse(brokenMarkdown)).toThrow(/expected 29/);
  });

  it('falls back to the raw section number when a clause has no matching ## heading', () => {
    // Build a minimal doc with 27 numbered/§7 units plus enough padding that
    // only the section-title lookup is exercised, isolating the ?? fallback
    // branch in the section-title map lookup.
    const lines: string[] = [];
    // Section 9 deliberately has no "## 9. ..." heading above it.
    for (let i = 1; i <= 26; i += 1) {
      lines.push(`**9.${i} Clause ${i}.** Body text for clause ${i}.`, '');
    }
    lines.push('## 7. What the assistant must not do', '', '- A prohibition', '', '---', '');
    const md = lines.join('\n');
    const clauses = parse(md);
    const c = clauses.find((cl) => cl.id === '9.1');
    expect(c?.section).toBe('9');
  });
});
