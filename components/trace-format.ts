import type { TraceEvent } from '@/lib/obs/trace';

export type Tone = 'success' | 'denied' | 'escalation' | 'repair' | 'warning' | 'neutral';

/**
 * Every top-level `code` a tool result can carry, read directly from
 * lib/tools/impl.ts and lib/tools/mutating.ts (not guessed) and classified
 * by what it means for the customer: success (green), a refusal/denial
 * (amber), or a hand-off to a human (blue — shared with the `escalation`
 * trace event type). Anything not in this table renders as neutral rather
 * than silently guessing a colour for a code this UI has never seen.
 */
const CODE_TONE: Record<string, Tone> = {
  OK: 'success',
  VERIFIED: 'success',
  HITS: 'success',
  MAPPED: 'success',
  OWED: 'success',
  WITHIN_WINDOW: 'success',
  RETURN_CREATED: 'success',
  EXCHANGE_CREATED: 'success',
  CREDIT_ISSUED: 'success',

  NOT_RECOGNISED: 'denied',
  NOT_VERIFIED: 'denied',
  ACCESS_DENIED: 'denied',
  NO_COVERAGE: 'denied',
  UNMAPPED_PAYMENT_METHOD: 'denied',
  NOT_OWED: 'denied',
  NOT_APPLICABLE: 'denied',
  OUTSIDE_WINDOW: 'denied',
  SKU_NOT_IN_ORDER: 'denied',
  REFUSED_INELIGIBLE: 'denied',
  REFUSED_NOT_OWED: 'denied',
  INVALID_REASON_CODE: 'denied',

  MUST_ESCALATE: 'escalation',
  ESCALATED: 'escalation',
};

export function toneForCode(code: string): Tone {
  return CODE_TONE[code] ?? 'neutral';
}

export function toneForValidator(verdict: 'pass' | 'repair' | 'fail'): Tone {
  if (verdict === 'pass') return 'success';
  if (verdict === 'repair') return 'repair';
  return 'denied';
}

export function shortToolName(name: string): string {
  return name.replace(/_/g, ' ');
}

/** A present-progressive label for the live "thinking" status line in Chat.tsx. */
export function describeEvent(event: TraceEvent): string {
  switch (event.type) {
    case 'guard':
      return event.verdict === 'block'
        ? `Blocked by the ${event.name} guard`
        : `Passed the ${event.name} guard`;
    case 'plan':
      return `Reasoning via ${event.provider}…`;
    case 'tool_call':
      return `Calling ${shortToolName(event.name)}…`;
    case 'tool_result':
      return `${shortToolName(event.name)} → ${event.code}`;
    case 'validator':
      return event.verdict === 'repair'
        ? 'Rewriting the reply to fix a validation issue…'
        : 'Checking the reply against this turn’s tool evidence…';
    case 'failover':
      return `${event.from} unavailable — retrying via ${event.to}…`;
    case 'escalation':
      return 'Handing off to a human agent…';
    default:
      return 'Working…';
  }
}
