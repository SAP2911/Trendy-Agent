import { getClauses, type ClauseId } from '@/lib/policy/clauses';
import { getOrdersForCustomer } from '@/lib/data/orders';
import { checkNumericGrounding, type Violation } from './grounding';

export type { Violation };

export interface Evidence {
  toolResults: unknown[];
  citedClauses: ClauseId[];
  verifiedCustomerId: string | null;
}

export interface ValidationResult {
  verdict: 'pass' | 'violation';
  violations: Violation[];
}

const VALID_CLAUSES = new Set(getClauses().map((c) => c.id));

/**
 * §7 forbids discounts, coupons, waivers, and goodwill credits outright —
 * the ONLY monetary concession Trendly authorises is the ₹250 delayed-order
 * credit (§1.5), and that always arrives as a tool result (check_delay_credit
 * / issue_delay_credit), never as free-floating prose the model made up. This
 * list is deliberately narrow: it contains only words that name a forbidden
 * CONCESSION TYPE, not soft empathy language ("I'm sorry for the delay",
 * "as an apology", "for your trouble") that legitimately precedes a real,
 * grounded ₹250 credit explanation — flagging on empathy language would
 * break exactly the happy-path script the delayed-order dataset entry
 * (TR-4525) is designed to exercise.
 *
 * "free shipping" is deliberately NOT a trigger here even though it is the
 * exact phrase from one of the task brief's dishonest examples: §1.3 ("Free
 * standard shipping on orders of ₹1,499 and above") and §5.1 ("Free reverse
 * pickup") are real, universal policy facts, and an honest agent answering a
 * shipping-cost question will legitimately say "free shipping". The brief's
 * dishonest example ("As a goodwill gesture, have free shipping") is still
 * caught below via "goodwill" alone — see the calibration table in the task
 * report for the honest-sentence probe that found this false-positive risk
 * and the empty free-shipping/free-pickup sentence that proves it is fixed.
 */
const CONCESSION =
  /\b(discounts?|coupons?|promo(?:tional)?\s*codes?|vouchers?|waive[ds]?|waiving|goodwill|complimentary|comped?|on the house)\b/gi;

/**
 * A concession keyword preceded, within the SAME sentence, by a negation cue
 * is an honest refusal quoting §7's own vocabulary ("I can't offer a
 * discount, coupon, or waive any fees"), not an offer. Without this check a
 * compliant refusal is textually indistinguishable from the violation it is
 * refusing to commit, which is exactly the kind of false positive that would
 * break the happy path.
 */
const NEGATION =
  /\b(cannot|can't|won't|will not|unable to|not able to|do not|don't|does not|doesn't|is not|isn't|are not|aren't|no such|not authoris(?:ed|e)|not authoriz(?:ed|e))\b/i;

/**
 * Clause references in either "§1.5" / "section 1.5" / "policy 1.5" /
 * "clause 1.5" style, or bare parenthetical style "(1.5)" — the latter
 * matters because several tool-result reason strings in lib/tools/impl.ts
 * already render citations that way (e.g. "...within 48 hours of delivery
 * (§6.1)."), and the model may echo that text back verbatim.
 */
const CLAUSE_REF = /(?:§|section\s+|policy\s+|clause\s+)(\d+(?:\.\d+)?)|\((\d+(?:\.\d+)?)\)/gi;

/** Real order ids are always "TR-" followed by exactly 4 digits. */
const ORDER_ID = /\bTR-\d{4}\b/g;

function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/);
}

function checkConcessions(text: string): Violation[] {
  const violations: Violation[] = [];
  const seen = new Set<string>();
  for (const sentence of splitSentences(text)) {
    for (const m of sentence.matchAll(CONCESSION)) {
      // m.index is typed optional because some RegExpMatchArray sources
      // cannot report a position, but every match produced by
      // String.prototype.matchAll on a /g-flagged regex always carries one.
      const start = m.index!;
      const before = sentence.slice(0, start);
      if (NEGATION.test(before)) continue;
      const term = m[0].toLowerCase();
      if (seen.has(term)) continue;
      seen.add(term);
      violations.push({ kind: 'UNAUTHORISED_CONCESSION', detail: m[0] });
    }
  }
  return violations;
}

function checkCitations(text: string): Violation[] {
  const violations: Violation[] = [];
  const seen = new Set<string>();
  for (const m of text.matchAll(CLAUSE_REF)) {
    // CLAUSE_REF has exactly two top-level alternatives (keyword-prefixed
    // "§1.5" style vs. bare parenthetical "(1.5)" style), each with its own
    // single capturing group — never both, never neither, for a successful match.
    const id = (m[1] ?? m[2])!;
    if (VALID_CLAUSES.has(id) || seen.has(id)) continue;
    seen.add(id);
    violations.push({ kind: 'UNCITED_CLAUSE', detail: id });
  }
  return violations;
}

function checkLeakage(text: string, evidence: Evidence): Violation[] {
  const permitted = new Set(
    evidence.verifiedCustomerId
      ? getOrdersForCustomer(evidence.verifiedCustomerId).map((o) => o.order_id)
      : [],
  );
  const violations: Violation[] = [];
  const seen = new Set<string>();
  for (const id of text.match(ORDER_ID) ?? []) {
    if (permitted.has(id) || seen.has(id)) continue;
    seen.add(id);
    violations.push({ kind: 'CROSS_CUSTOMER_LEAK', detail: id });
  }
  return violations;
}

/**
 * The last gate before a message reaches the customer.
 *
 * Numeric grounding is the strongest single defence against hallucination:
 * every rupee amount and day/hour/percent count in the reply must have come
 * from a tool result this turn (see lib/guards/grounding.ts). The other
 * three checks close the remaining ways this system was explicitly asked
 * never to fail: inventing an unauthorised concession (§7), citing a policy
 * clause that does not exist, and leaking another customer's order id.
 *
 * All four checks run unconditionally and their violations are unioned — a
 * single message can trip more than one at once (e.g. "as a goodwill
 * gesture, here's ₹500" is both an unauthorised concession AND an ungrounded
 * number), and that is expected, not a bug.
 *
 * `evidence.citedClauses` is accepted for interface completeness (and for
 * the calling agent loop to log/reason about which clauses it actually
 * retrieved this turn) but is deliberately NOT used to gate citations here.
 * The rule this validator enforces is "a cited clause id must be real",
 * checked against the fixed, canonical clause list from getClauses() —
 * gating against citedClauses instead would make correctness depend on the
 * agent loop's own evidence bookkeeping being perfectly in sync with what
 * the model actually wrote, which is a second thing that could hide a bug
 * behind a false pass.
 */
export function validateOutput(text: string, evidence: Evidence): ValidationResult {
  const violations: Violation[] = [
    ...checkNumericGrounding(text, evidence.toolResults),
    ...checkConcessions(text),
    ...checkCitations(text),
    ...checkLeakage(text, evidence),
  ];
  return { verdict: violations.length === 0 ? 'pass' : 'violation', violations };
}
