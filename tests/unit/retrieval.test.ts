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
