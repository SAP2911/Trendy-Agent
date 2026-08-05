import type { ClauseId } from '@/lib/policy/clauses';

/**
 * One structured event per orchestration stage (§8 of the design spec).
 * Every stage of the loop — input guards, planning, tool calls/results,
 * output validation, provider failover, escalation — emits exactly one of
 * these, so the trace panel (and the eval harness) can show the
 * orchestration actually happening, not just the final chat message.
 */
export type TraceEventInput =
  | { type: 'guard'; name: string; verdict: 'pass' | 'block'; detail?: string }
  | { type: 'plan'; model: string; provider: string; latencyMs: number }
  | { type: 'tool_call'; name: string; args: unknown }
  | { type: 'tool_result'; name: string; code: string; clauses?: ClauseId[] }
  | { type: 'validator'; name: string; verdict: 'pass' | 'repair' | 'fail' }
  | { type: 'failover'; from: string; to: string; reason: string }
  | { type: 'escalation'; reasonCode: string; ticketId: string };

export type TraceEvent = TraceEventInput & { correlationId: string; seq: number };

/**
 * Collects trace events for a single turn, stamping each one with the
 * turn's correlation id and a monotonically increasing sequence number so
 * consumers (UI panel, eval scorecard) can order and group them without
 * re-deriving anything.
 *
 * `drain()` exists alongside `events()` because the orchestration loop is
 * an async generator that streams events out incrementally, interleaved
 * with model text deltas, as they happen — not all at once at the end.
 * `drain()` returns only the events emitted since the last drain, so the
 * loop can do `yield* trace.drain()` after each unit of work without
 * re-yielding events a caller has already seen.
 */
export class TraceCollector {
  readonly #correlationId: string;
  readonly #events: TraceEvent[] = [];
  #drainedThrough = 0;

  constructor(correlationId: string) {
    this.#correlationId = correlationId;
  }

  emit(event: TraceEventInput): void {
    this.#events.push({
      ...event,
      correlationId: this.#correlationId,
      seq: this.#events.length,
    });
  }

  /** Every event emitted so far, in order. Does not affect drain()'s cursor. */
  events(): TraceEvent[] {
    return [...this.#events];
  }

  /** Events emitted since the last drain() call. Advances the drain cursor. */
  drain(): TraceEvent[] {
    const pending = this.#events.slice(this.#drainedThrough);
    this.#drainedThrough = this.#events.length;
    return pending;
  }
}

/** Object keys whose VALUE is always redacted outright, whatever its type. */
const SECRET_KEY = /key|secret|token|password|credential|authoriz/i;

/** Matches an email address anywhere inside a string, not just a whole-string match. */
const EMAIL = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

/**
 * Deep-redacts a value before it is allowed anywhere near a log or trace
 * event. Two independent rules, both applied everywhere in the structure:
 *
 *  - A key that LOOKS like a secret (matches SECRET_KEY: "apiKey",
 *    "GROQ_API_KEY", "authorization", ...) has its value replaced outright,
 *    regardless of the value's type or how deeply it is nested. This is the
 *    line that must never leak GOOGLE_GENERATIVE_AI_API_KEY / GROQ_API_KEY.
 *  - Every string value, wherever it is found — not only under a key named
 *    "email" — has any embedded email address masked. A customer's email
 *    can legitimately show up under "contact" (verify_customer's argument)
 *    or inside free-text tool output, not just a field literally named
 *    "email".
 *
 * A WeakSet guards against a circular object reference turning this into an
 * infinite loop; trace payloads are always plain JSON-shaped data in
 * practice, so this is defence in depth, not a path any test needs to hit.
 */
export function redact(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === 'string') {
    return value.replace(EMAIL, '[REDACTED_EMAIL]');
  }
  if (Array.isArray(value)) {
    return value.map((item) => redact(item, seen));
  }
  if (value !== null && typeof value === 'object') {
    if (seen.has(value)) return '[CIRCULAR]';
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      out[key] = SECRET_KEY.test(key) ? '[REDACTED]' : redact(v, seen);
    }
    return out;
  }
  return value;
}
