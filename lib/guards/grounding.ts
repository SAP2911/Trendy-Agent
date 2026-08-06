export interface Violation { kind: string; detail: string }

/**
 * Currency amounts ("₹250", "250 rupees", "250 INR") and day/hour/percent
 * counts ("14 business days", "48 hours", "20%") are the only two shapes of
 * quantity a customer-facing message is allowed to assert without a tool
 * result backing it up.
 *
 * Both patterns are scoped narrowly ON PURPOSE: order ids (TR-4530),
 * tracking numbers (BD8871209341), SKUs (TR-KRT-033), and sizes ("size 42")
 * are all digit-bearing but are never immediately preceded by a currency
 * mark or followed by a day/hour/percent word, so none of them are even
 * candidate matches — no separate allowlist is needed for them.
 *
 * Dates get the same treatment for the same reason: "26 July 2026" or
 * "2026-07-26" rendered as prose matches neither pattern (a bare date has
 * no currency prefix and is not followed by "days"/"hours"/"%"), so no
 * date-specific normalisation is needed on the TEXT side at all. What *is*
 * needed — and is handled in extractGroundedNumbers below — is exploding
 * tool-result date/timeframe strings like "2026-07-26" or
 * "5–7 business days" into their individual numeric components, so that if
 * a real day/hour count DOES coincide with something date-shaped, it still
 * grounds correctly without any date parsing or reformatting logic.
 *
 * COUNT also captures an optional range ("5-7 business days" / "5–7 business
 * days") so BOTH endpoints are checked, not just the one adjacent to the
 * unit word — otherwise a hallucinated range like "9-7 business days" would
 * only ever be checked on its second number.
 */
const CURRENCY = /₹\s?([\d,]+(?:\.\d+)?)|\b([\d,]+(?:\.\d+)?)\s*(?:rupees?|INR)\b/gi;
const COUNT =
  /\b(\d+(?:\.\d+)?)\s*(?:[-–]\s*(\d+(?:\.\d+)?)\s*)?(?:%|percent\b|business\s+days?\b|days?\b|hours?\b)/gi;

/**
 * Walk every tool result returned THIS turn and collect every numeric token
 * found in it, as a comma-stripped string (not a parsed number) — so a
 * zero-padded component like "07" is tracked distinctly from "7". Recurses
 * through arrays and plain objects; numbers contribute their decimal string
 * directly, strings contribute every digit run found inside them, INCLUDING
 * thousands-separator commas as part of the same run (then stripped) — a
 * policy clause's raw text containing "₹1,499" must ground the same
 * normalised "1499" that checkNumericGrounding produces from "₹1,499" in the
 * message text (also comma-stripped there), not the two disjoint fragments
 * "1" and "499" that a comma-blind digit regex would produce. This is also
 * how a date string ("2026-07-26") or a timeframe string
 * ("5–7 business days") grounds its component numbers with no separate
 * date-parsing step: neither contains a comma, so each digit run is grounded
 * on its own exactly as before.
 */
export function extractGroundedNumbers(toolResults: readonly unknown[]): Set<string> {
  const found = new Set<string>();
  const walk = (value: unknown): void => {
    if (typeof value === 'number') { found.add(String(value)); return; }
    if (typeof value === 'string') {
      for (const m of value.match(/\d[\d,]*(?:\.\d+)?/g) ?? []) found.add(stripCommas(m));
      return;
    }
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (value && typeof value === 'object') { Object.values(value).forEach(walk); }
  };
  toolResults.forEach(walk);
  // Small conversational integers ("2 items", "one of your 3 orders") are
  // ordinary prose, not policy claims, and are cheap to allow unconditionally
  // — real hallucinated amounts and day counts in this domain are never this
  // small.
  for (const n of ['0', '1', '2', '3']) found.add(n);
  return found;
}

function stripCommas(raw: string): string {
  return raw.replace(/,/g, '');
}

/**
 * Numeric grounding: the single strongest anti-hallucination check in the
 * system. Every ₹ amount and every day/hour/percent count asserted in
 * `text` must appear, digit-for-digit, somewhere in this turn's tool
 * results. The model may phrase things however it likes; it may not invent
 * a quantity.
 */
export function checkNumericGrounding(
  text: string, toolResults: readonly unknown[], userMessage?: string,
): Violation[] {
  const grounded = extractGroundedNumbers(toolResults);

  // Numbers the customer typed are theirs to have back. Refusing a demand is
  // usually phrased by naming it — "I can't give you 30% off" — and blocking
  // that as an ungrounded number turns a correct refusal into a repair loop
  // and then an escalation. Observed live: "give me 30% off" produced exactly
  // that failure. Echoing a customer's own figure asserts nothing about
  // Trendly's policy or their order, so it cannot be a hallucination; every
  // figure the model invents unprompted is still caught.
  if (userMessage) {
    for (const m of userMessage.match(/\d[\d,]*(?:\.\d+)?/g) ?? []) {
      grounded.add(stripCommas(m));
    }
  }

  const violations: Violation[] = [];
  const flagged = new Set<string>();

  const flag = (raw: string, label: string): void => {
    if (!raw || grounded.has(raw) || flagged.has(label)) return;
    flagged.add(label);
    violations.push({ kind: 'UNGROUNDED_NUMBER', detail: label });
  };

  for (const m of text.matchAll(CURRENCY)) {
    // CURRENCY has exactly two top-level alternatives ("₹N" / "N rupees|INR"),
    // each with its own single capturing group. Whichever alternative
    // produced this match populated exactly that one group — never both,
    // never neither — so `m[1] ?? m[2]` is never undefined here.
    const raw = stripCommas((m[1] ?? m[2])!);
    flag(raw, `₹${raw}`);
  }
  for (const m of text.matchAll(COUNT)) {
    // COUNT's leading `(\d+(?:\.\d+)?)` is a mandatory (non-alternated)
    // capturing group: any successful match populated it.
    const first = stripCommas(m[1]!);
    flag(first, first);
    if (m[2]) {
      const second = stripCommas(m[2]);
      flag(second, second);
    }
  }
  return violations;
}
