import type { TraceEvent } from './trace';

/**
 * Per-process store of trace events, keyed two ways so `/api/trace/[id]`
 * can be queried either with the correlationId a user quotes from a bug
 * report (one turn's trace) or the conversationId the chat UI already
 * holds (every turn in that conversation, oldest first). Ephemeral by
 * design, same as lib/agent/session.ts and lib/data/store.ts — this is a
 * demo-scale in-memory process, not a durable log store.
 */
interface StoredTurn {
  conversationId: string;
  events: TraceEvent[];
}

const byCorrelationId = new Map<string, StoredTurn>();
const byConversationId = new Map<string, string[]>();

/**
 * Appends one event to the running trace for this turn, creating it (and
 * linking it into its conversation's turn list) on first use. The
 * conversation link is only ever written here, exactly once per
 * correlationId — the `existing` branch above always short-circuits on
 * every later call for the same turn — so there is no separate dedupe check
 * to get wrong.
 */
export function appendTraceEvent(
  conversationId: string,
  correlationId: string,
  event: TraceEvent,
): void {
  const existing = byCorrelationId.get(correlationId);
  if (existing) {
    existing.events.push(event);
    return;
  }
  byCorrelationId.set(correlationId, { conversationId, events: [event] });
  const ids = byConversationId.get(conversationId) ?? [];
  ids.push(correlationId);
  byConversationId.set(conversationId, ids);
}

/** The trace for exactly one turn (one correlationId), or undefined if unknown. */
export function getTraceByCorrelationId(correlationId: string): TraceEvent[] | undefined {
  return byCorrelationId.get(correlationId)?.events;
}

/** Every turn's trace for a conversation, concatenated oldest-first. Empty if unknown. */
export function getTraceByConversationId(conversationId: string): TraceEvent[] {
  const correlationIds = byConversationId.get(conversationId) ?? [];
  // Every id in this list was inserted by appendTraceEvent in the same breath
  // as its byCorrelationId entry, so the lookup below always hits.
  return correlationIds.flatMap((id) => byCorrelationId.get(id)!.events);
}

/** Test-only reset. Production state is per-process and intentionally ephemeral. */
export function resetTraceStore(): void {
  byCorrelationId.clear();
  byConversationId.clear();
}
