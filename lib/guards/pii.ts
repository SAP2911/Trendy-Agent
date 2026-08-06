export interface PiiResult { found: boolean; kinds: string[]; redacted: string }

/**
 * Candidate digit runs, 13-19 digits long (the real length range of card
 * PANs), allowing spaces or dashes as human-typed separators. This alone is
 * intentionally broad — Trendly order ids (TR-4530, 4 digits) and tracking
 * numbers (BD8871209341, 10 digits) both fall well under the 13-digit floor
 * and never produce a full match here, but the length floor is NOT treated
 * as sufficient on its own: every candidate below is additionally
 * Luhn-validated. A false hit on some other 13-19 digit run that is not
 * actually a card (e.g. a concatenated reference number) would fail Luhn
 * about 9 times out of 10; the length filter alone would not catch that.
 */
const CANDIDATE = /\b(?:\d[ -]?){13,19}\b/g;
const CVV = /\b(?:cvv|cvc|security code)\b\D{0,10}(\d{3,4})\b/i;
const IFSC = /\b[A-Z]{4}0[A-Z0-9]{6}\b/;
const ACCOUNT =
  /\b(?:bank account|account|a\/c|acct)\s*(?:number|no\.?|#)?\s*[:\-]?\s*\d{9,18}\b/i;

/**
 * Standard Luhn (mod-10) checksum over a pure-digit string.
 *
 * No length bounds check here: this is only ever called from detectPii
 * below with a match already produced by CANDIDATE, whose {13,19}
 * repetition bound structurally guarantees `digits.length` is already
 * within [13, 19] for every call — duplicating that check here would be a
 * branch coverage cannot exercise (same reasoning as the noUncheckedIndexedAccess
 * guard removal precedent in lib/policy/clauses.ts).
 *
 * Uses `charAt` rather than bracket indexing so the read is always typed
 * `string` (never `string | undefined` under noUncheckedIndexedAccess).
 */
function luhnValid(digits: string): boolean {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = Number(digits.charAt(i));
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/** Replace every occurrence of `needle` in `text`, not just the first. */
function redactAll(text: string, needle: string, placeholder: string): string {
  return text.split(needle).join(placeholder);
}

/**
 * Card detection is Luhn-validated rather than pattern-only. Trendly
 * tracking numbers (BD8871209341) and order ids (TR-4530) are digit-heavy;
 * a naive length-only check would redact them and break every happy-path
 * conversation where a customer pastes their own tracking number back to
 * the assistant.
 */
export function detectPii(text: string): PiiResult {
  const kinds: string[] = [];
  let redacted = text;

  for (const match of text.match(CANDIDATE) ?? []) {
    const digits = match.replace(/\D/g, '');
    if (luhnValid(digits)) {
      kinds.push('CARD_NUMBER');
      redacted = redactAll(redacted, match, '[REDACTED_CARD]');
    }
  }

  const cvvMatch = text.match(CVV);
  if (cvvMatch) {
    kinds.push('CVV');
    redacted = redactAll(redacted, cvvMatch[0], '[REDACTED_CVV]');
  }

  const ifscMatch = text.match(IFSC);
  const accountMatch = text.match(ACCOUNT);
  if (ifscMatch || accountMatch) {
    kinds.push('BANK_DETAILS');
    if (ifscMatch) redacted = redactAll(redacted, ifscMatch[0], '[REDACTED_BANK]');
    if (accountMatch) redacted = redactAll(redacted, accountMatch[0], '[REDACTED_BANK]');
  }

  return { found: kinds.length > 0, kinds: [...new Set(kinds)], redacted };
}
