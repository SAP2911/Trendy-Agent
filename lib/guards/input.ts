import { detectPii } from './pii';
import { detectInjection } from './injection';

const ADVICE = /\b(medical|legal|financial|investment|tax)\s+(advice|opinion|recommendation)\b/i;

export interface InputScreen {
  action: 'allow' | 'refuse';
  reasonCode?: 'PII_IN_CHAT' | 'OUT_OF_SCOPE_ADVICE';
  injectionPatterns: string[];
  redacted: string;
}

/**
 * Injection detection does NOT refuse. Refusing on suspicion would break
 * honest customers who happen to use trigger words (e.g. "please ignore my
 * previous message and just refund me"). It records the signal so the
 * agent loop can re-assert its instructions for this turn; the output
 * validators remain the real defence against a reply that actually acted on
 * an injected instruction.
 *
 * PII and out-of-scope-advice DO refuse, per §3.3 and §7 respectively —
 * those are refused outright rather than merely flagged, because there is
 * no legitimate continuation of the turn once either is true: card/CVV/bank
 * details must never be collected in chat, and the assistant must never
 * give medical/legal/financial advice regardless of how the rest of the
 * turn plays out.
 */
export function screenInput(text: string): InputScreen {
  const pii = detectPii(text);
  const injection = detectInjection(text);

  if (pii.found) {
    return {
      action: 'refuse',
      reasonCode: 'PII_IN_CHAT',
      injectionPatterns: injection.patterns,
      redacted: pii.redacted,
    };
  }
  if (ADVICE.test(text)) {
    return {
      action: 'refuse',
      reasonCode: 'OUT_OF_SCOPE_ADVICE',
      injectionPatterns: injection.patterns,
      redacted: pii.redacted,
    };
  }
  return { action: 'allow', injectionPatterns: injection.patterns, redacted: pii.redacted };
}
