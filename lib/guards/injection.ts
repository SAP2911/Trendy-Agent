export interface InjectionResult { found: boolean; patterns: string[] }

/**
 * Coarse, high-recall prompt-injection signatures. These are deliberately
 * NOT the enforcement mechanism (see screenInput below) — they only need to
 * be good enough to flag suspicious turns for the loop to react to. The
 * output validators (lib/guards/output.ts) are what actually stop a
 * compromised reply from reaching the customer.
 */
const PATTERNS: Array<[string, RegExp]> = [
  ['INSTRUCTION_OVERRIDE',
    /\b(ignore|disregard|forget)\b[^.]{0,30}\b(previous|prior|above|all)\b[^.]{0,20}\b(instruction|rule|prompt|direction)/i],
  ['ROLE_OVERRIDE',
    /\byou are now\b|\bact as\b[^.]{0,20}\b(dan|jailbreak|unrestricted)\b|\bpretend you\b/i],
  ['PROMPT_EXTRACTION',
    /\b(print|show|reveal|repeat|output)\b[^.]{0,20}\b(system prompt|instructions|your prompt)\b/i],
  ['POLICY_OVERRIDE',
    /\bdisregard\b[^.]{0,20}\bpolicy\b|\bpolicy (does not|doesn't) apply\b/i],
];

/**
 * Flag (never refuse — see screenInput) turns that look like an attempt to
 * override the assistant's instructions, role, or the policy document.
 */
export function detectInjection(text: string): InjectionResult {
  const hits = PATTERNS.filter(([, re]) => re.test(text)).map(([name]) => name);
  return { found: hits.length > 0, patterns: hits };
}
