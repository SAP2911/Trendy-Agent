import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import {
  loadScenarios, parseScenario, CATEGORIES, ScenarioSchema,
} from '@/tests/eval/schema';

const SCENARIOS_DIR = path.join(process.cwd(), 'tests/eval/scenarios');

/**
 * Loads and Zod-validates every scenario YAML file that `npm run eval`
 * would otherwise only discover at runtime. This test needs no cassette
 * and no API key — a malformed scenario file (bad category, missing
 * `turns`, an unrecognised `expect` key) must fail `npm test`, not surface
 * for the first time when someone runs the eval harness.
 */
describe('eval scenario fixtures', () => {
  const scenarios = loadScenarios(SCENARIOS_DIR);

  it('loads all 12 scenarios', () => {
    expect(scenarios).toHaveLength(12);
  });

  it('every scenario id is unique', () => {
    const ids = scenarios.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('covers all six graded categories', () => {
    const covered = new Set(scenarios.map((s) => s.category));
    expect([...covered].sort()).toEqual([...CATEGORIES].sort());
  });

  it('matches the assignment\'s category bucketing (2/2/3/2/2/1)', () => {
    const counts = new Map<string, number>();
    for (const s of scenarios) counts.set(s.category, (counts.get(s.category) ?? 0) + 1);
    expect(counts.get('order-lookup')).toBe(2);
    expect(counts.get('policy-grounding')).toBe(2);
    expect(counts.get('returns-eligibility')).toBe(3);
    expect(counts.get('escalation')).toBe(2);
    expect(counts.get('safety-refusals')).toBe(2);
    expect(counts.get('robustness')).toBe(1);
  });

  it('every turn has a non-empty message and at least one expectation', () => {
    for (const scenario of scenarios) {
      for (const turn of scenario.turns) {
        expect(turn.message.trim().length).toBeGreaterThan(0);
        expect(Object.keys(turn.expect).length).toBeGreaterThan(0);
      }
    }
  });

  it('every forbidden pattern compiles as a regular expression', () => {
    for (const scenario of scenarios) {
      for (const turn of scenario.turns) {
        for (const pattern of turn.expect.forbidden ?? []) {
          expect(() => new RegExp(pattern, 'i')).not.toThrow();
        }
      }
    }
  });

  it('the multi-turn robustness scenario actually has more than one turn', () => {
    const multi = scenarios.find((s) => s.id === 'robustness-multi-turn-identity');
    expect(multi?.turns.length).toBeGreaterThan(1);
  });

  it('the card-number safety scenario asserts zero model calls', () => {
    const cardScenario = scenarios.find((s) => s.id === 'safety-card-number-refusal');
    expect(cardScenario?.turns[0]?.expect.modelCalls).toBe(0);
  });
});

describe('scenario schema validation fails loudly on malformed input', () => {
  it('rejects a scenario with an unknown category', () => {
    const yaml = `
id: bad-category
category: not-a-real-category
turns:
  - message: "hi"
    expect:
      toolCalls: [verify_customer]
`;
    expect(() => parseScenario(yaml, 'synthetic.yaml')).toThrow(/failed scenario schema validation/);
  });

  it('rejects a scenario with an unrecognised expect key (typo)', () => {
    const yaml = `
id: bad-expect-key
category: order-lookup
turns:
  - message: "hi"
    expect:
      toolCall: [verify_customer]
`;
    expect(() => parseScenario(yaml, 'synthetic.yaml')).toThrow(/failed scenario schema validation/);
  });

  it('rejects a scenario with zero turns', () => {
    const yaml = `
id: no-turns
category: order-lookup
turns: []
`;
    expect(() => parseScenario(yaml, 'synthetic.yaml')).toThrow(/failed scenario schema validation/);
  });

  it('rejects a scenario with an empty message', () => {
    const yaml = `
id: empty-message
category: order-lookup
turns:
  - message: ""
    expect:
      toolCalls: [verify_customer]
`;
    expect(() => parseScenario(yaml, 'synthetic.yaml')).toThrow(/failed scenario schema validation/);
  });

  it('rejects a non-kebab-case id', () => {
    const yaml = `
id: Not_Kebab_Case
category: order-lookup
turns:
  - message: "hi"
    expect:
      toolCalls: [verify_customer]
`;
    expect(() => parseScenario(yaml, 'synthetic.yaml')).toThrow(/failed scenario schema validation/);
  });

  it('rejects invalid YAML outright', () => {
    const notYaml = '{ this is: [not, valid, yaml';
    expect(() => parseScenario(notYaml, 'synthetic.yaml')).toThrow(/not valid YAML/);
  });

  it('accepts a minimal well-formed scenario', () => {
    const yaml = `
id: minimal-ok
category: robustness
turns:
  - message: "hi"
    expect:
      toolCalls: [verify_customer]
`;
    expect(() => parseScenario(yaml, 'synthetic.yaml')).not.toThrow();
  });

  it('ScenarioSchema rejects an extra top-level key (strict mode)', () => {
    const result = ScenarioSchema.safeParse({
      id: 'extra-key',
      category: 'robustness',
      turns: [{ message: 'hi', expect: { toolCalls: ['verify_customer'] } }],
      unexpectedField: true,
    });
    expect(result.success).toBe(false);
  });
});

describe('every committed scenario file round-trips through the raw filesystem read', () => {
  const scenarios = loadScenarios(SCENARIOS_DIR); // already exercised the fs path; this is a second, independent check
  const filenames = readdirSync(SCENARIOS_DIR);

  it('re-reading each file on disk finds the id loadScenarios() reported for it', () => {
    for (const scenario of scenarios) {
      const file = filenames.find(
        (f) => readFileSync(path.join(SCENARIOS_DIR, f), 'utf8').includes(`id: ${scenario.id}`),
      );
      expect(file, `no file on disk declares id: ${scenario.id}`).toBeDefined();
    }
  });
});
