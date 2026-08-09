import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

/**
 * The six categories the assignment grades the harness against. Kept as a
 * literal union (not a plain string) so a typo in a scenario file's
 * `category` field fails Zod validation loudly instead of silently forming
 * a seventh, ungraded bucket.
 */
export const CATEGORIES = [
  'order-lookup',
  'policy-grounding',
  'returns-eligibility',
  'escalation',
  'safety-refusals',
  'robustness',
] as const;

export type Category = (typeof CATEGORIES)[number];

/**
 * What a turn's reply is checked against.
 *
 * The five fields named in the assignment (toolCalls, resultCodes,
 * citedClauses, forbidden, mustEscalate) are all present. Two more are
 * added, both load-bearing for a specific scripted scenario rather than
 * decorative:
 *  - `modelCalls`: scenario 11 (card number) must prove ZERO model calls —
 *    a subset match over an empty toolCalls array can't express "and
 *    nothing else happened", so an exact count is the only way to assert it.
 *  - `activeToolsInclude`: scenario 12 (multi-turn) must prove identity
 *    carried across turns WITHOUT re-verifying. The only direct evidence of
 *    that is the tool-visibility gate itself (prepareStep) on the turn's
 *    first step — text-based heuristics over the reply can't prove a
 *    negative ("did not ask to re-verify") nearly as precisely.
 * `.strict()` on every object below means an unrecognised key in a scenario
 * YAML file is a validation failure, not a silently-ignored typo.
 */
export const ExpectSchema = z.object({
  toolCalls: z.array(z.string().min(1)).optional(),
  resultCodes: z.array(z.string().min(1)).optional(),
  citedClauses: z.array(z.string().min(1)).optional(),
  forbidden: z.array(z.string().min(1)).optional(),
  mustEscalate: z.boolean().optional(),
  modelCalls: z.number().int().nonnegative().optional(),
  activeToolsInclude: z.array(z.string().min(1)).optional(),
}).strict();

export type Expect = z.infer<typeof ExpectSchema>;

export const TurnSchema = z.object({
  message: z.string().min(1),
  expect: ExpectSchema,
}).strict();

export type Turn = z.infer<typeof TurnSchema>;

export const ScenarioSchema = z.object({
  id: z.string().regex(
    /^[a-z0-9]+(-[a-z0-9]+)*$/,
    'id must be kebab-case (lowercase letters, digits, single hyphens)',
  ),
  category: z.enum(CATEGORIES),
  description: z.string().min(1).optional(),
  turns: z.array(TurnSchema).min(1),
}).strict();

export type Scenario = z.infer<typeof ScenarioSchema>;

/**
 * Parses and validates one scenario document. Exported separately from the
 * file-loading wrapper so tests/unit/eval-scenarios.test.ts can feed
 * synthetic YAML strings straight to Zod without touching the filesystem.
 *
 * Throws (via Zod's default behaviour) on the first structural problem —
 * that IS the "fails loudly" requirement, not a bug to catch and hide.
 */
export function parseScenario(yamlText: string, sourcePath: string): Scenario {
  let raw: unknown;
  try {
    raw = parseYaml(yamlText);
  } catch (error) {
    throw new Error(
      `${sourcePath}: not valid YAML — ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const result = ScenarioSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `${sourcePath}: failed scenario schema validation:\n${result.error.issues
        .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('\n')}`,
    );
  }
  return result.data;
}

/** Every `*.yaml` file directly inside `dir`, sorted for deterministic order. */
function yamlFilesIn(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.yaml') || name.endsWith('.yml'))
    .sort()
    .map((name) => path.join(dir, name));
}

/**
 * Loads and validates every scenario file in `dir`.
 *
 * Duplicate ids are rejected here rather than left for the runner to
 * silently overwrite one scorecard row with another — two scenario files
 * sharing an id is exactly the kind of malformed-fixture bug the schema
 * layer exists to catch before a single API call is made.
 */
export function loadScenarios(dir: string): Scenario[] {
  const files = yamlFilesIn(dir);
  const scenarios: Scenario[] = [];
  const seenIds = new Map<string, string>();

  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const scenario = parseScenario(text, file);
    const previousFile = seenIds.get(scenario.id);
    if (previousFile) {
      throw new Error(
        `Duplicate scenario id "${scenario.id}" in ${file} (already defined in ${previousFile})`,
      );
    }
    seenIds.set(scenario.id, file);
    scenarios.push(scenario);
  }
  return scenarios;
}
