import { describe, it, expect } from 'vitest';
import { searchPolicy, ALIASES } from '@/lib/policy/retrieval';
import { getClauses } from '@/lib/policy/clauses';

function topId(query: string): string {
  const r = searchPolicy(query);
  if (r.code !== 'HITS') throw new Error(`expected hits for "${query}"`);
  return r.hits[0]!.clause.id;
}

describe('policy retrieval', () => {
  it.each([
    ['how long do I have to return something', '2.1'],
    ['can I return underwear',                 '2.3'],
    ['my item was a final sale',               '2.4'],
    ['when will I get my money back',          '3.1'],
    ['my parcel is lost',                      '1.6'],
    ['my order is late',                       '1.5'],
    ['can I change my delivery address',       '1.7'],
    ['do you charge for shipping',             '1.3'],
    ['I want a different colour',              '4.1'],
    ['I lost the shoe box',                    '2.5'],
  ])('retrieves %s -> clause %s', (query, expected) => {
    expect(topId(query)).toBe(expected);
  });

  it.each([
    'do you ship to Nepal',
    'what is your warranty on watches',
    'can I buy a franchise',
    'what is the CEO name',
  ])('returns NO_COVERAGE for out-of-corpus query: %s', (query) => {
    expect(searchPolicy(query).code).toBe('NO_COVERAGE');
  });

  it('returns at most k hits', () => {
    const r = searchPolicy('return', 2);
    expect(r.code).toBe('HITS');
    if (r.code === 'HITS') expect(r.hits.length).toBeLessThanOrEqual(2);
  });

  it('treats an empty query as NO_COVERAGE rather than matching everything', () => {
    expect(searchPolicy('   ').code).toBe('NO_COVERAGE');
  });

  it('treats a query whose tokens match zero documents as NO_COVERAGE (not just below-threshold hits)', () => {
    // Distinct from the out-of-corpus cases above: those queries still share
    // at least one token with some clause (just not enough to clear the
    // threshold). This query is tokenized (non-empty after stopword removal)
    // but shares no vocabulary with any of the 29 clauses at all, so every
    // candidate scores exactly 0 and the post-filter `scored` array is
    // empty — exercising the `!best` branch, not the `best.score < THRESHOLD`
    // branch.
    const r = searchPolicy('zzqxworpwibbleflarn');
    expect(r.code).toBe('NO_COVERAGE');
  });
});

describe('ALIASES map integrity', () => {
  it('every key is a real ClauseId from the current policy corpus', () => {
    // ClauseId is `string`, not a literal union, so a typo'd key here (e.g.
    // "2.03" instead of "2.3") would type-check silently and just never
    // match anything at query time. This is the one place that could hide.
    const realIds = new Set(getClauses().map((c) => c.id));
    for (const key of Object.keys(ALIASES)) {
      expect(realIds.has(key)).toBe(true);
    }
  });
});

// Mutation testing scored this module 36%: the existing tests assert end-to-end
// outcomes ("this query returns 2.1") while the BM25 internals — ranking order,
// the k limit, the zero-score filter, tokenisation — went unprobed. These pin
// the observable behaviour those internals produce.
describe('ranking and result shape', () => {
  it('returns hits sorted by descending score', () => {
    const r = searchPolicy('when will I get my money back', 5);
    expect(r.code).toBe('HITS');
    if (r.code !== 'HITS') return;
    const scores = r.hits.map((h) => h.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it('never returns a hit that scored zero', () => {
    const r = searchPolicy('when will I get my money back', 10);
    if (r.code !== 'HITS') return;
    for (const h of r.hits) expect(h.score).toBeGreaterThan(0);
  });

  it('honours k exactly, and defaults to 3', () => {
    const one = searchPolicy('how long do I have to return something', 1);
    expect(one.code).toBe('HITS');
    if (one.code === 'HITS') expect(one.hits).toHaveLength(1);
    const dflt = searchPolicy('how long do I have to return something');
    if (dflt.code === 'HITS') expect(dflt.hits.length).toBeLessThanOrEqual(3);
  });

  it('every hit carries a real clause with an id and body text', () => {
    const r = searchPolicy('lost parcel', 3);
    if (r.code !== 'HITS') return;
    for (const h of r.hits) {
      expect(h.clause.id).toMatch(/^(\d+(\.\d+)?|meta\.[a-z-]+)$/);
      expect(h.clause.text.length).toBeGreaterThan(0);
    }
  });
});

describe('tokenisation', () => {
  it('is case-insensitive', () => {
    const lower = searchPolicy('my parcel is lost');
    const upper = searchPolicy('MY PARCEL IS LOST');
    expect(upper.code).toBe(lower.code);
    if (lower.code === 'HITS' && upper.code === 'HITS') {
      expect(upper.hits[0]!.clause.id).toBe(lower.hits[0]!.clause.id);
    }
  });

  it('ignores punctuation around words', () => {
    const r = searchPolicy('is my parcel... lost?!');
    expect(r.code).toBe('HITS');
    if (r.code === 'HITS') expect(r.hits[0]!.clause.id).toBe('1.6');
  });

  it('treats a query of only stopwords as NO_COVERAGE', () => {
    // Stopwords are stripped, leaving nothing to score — this must behave
    // exactly like the empty query rather than matching every clause.
    expect(searchPolicy('the a is of and or to').code).toBe('NO_COVERAGE');
  });

  it('scores digits as tokens, so a policy figure is findable', () => {
    const r = searchPolicy('1,499 free shipping threshold');
    expect(r.code).toBe('HITS');
    if (r.code === 'HITS') expect(r.hits.map((h) => h.clause.id)).toContain('1.3');
  });
});

describe('alias map contribution', () => {
  it.each([
    ['my order came in two separate parcels', '1.4'],
    ['who will collect the item for pickup', '5.1'],
    ['how do I get my cash on delivery refund', '3.3'],
  ])('an alias-driven phrase (%s) resolves to %s', (query, expected) => {
    const r = searchPolicy(query);
    expect(r.code).toBe('HITS');
    if (r.code === 'HITS') expect(r.hits[0]!.clause.id).toBe(expected);
  });

  // Measured, not assumed. Most single words DO clear the threshold; "refund"
  // and "backorder" do not, because each appears in only one clause whose body
  // is long, so length-normalised BM25 dilutes the single term below 2.3.
  // The agent therefore says the policy does not cover a bare "refund" — the
  // SAFE direction to fail, but less helpful than ideal (SOLUTION.md
  // limitation 3). If the threshold is retuned, this is the test to revisit.
  it.each(['refund', 'backorder'])(
    'a bare single-word query (%s) falls below threshold', (query) => {
      expect(searchPolicy(query).code).toBe('NO_COVERAGE');
    });

  it.each(['return', 'exchange', 'jewellery', 'pickup', 'lost'])(
    'a bare single-word query (%s) clears it', (query) => {
      expect(searchPolicy(query).code).toBe('HITS');
    });
});
