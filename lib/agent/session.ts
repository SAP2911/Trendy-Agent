export type SessionState = 'ANONYMOUS' | 'VERIFIED' | 'ESCALATED';

export interface TrendlyContext {
  conversationId: string;
  correlationId: string;
  state: SessionState;
  verifiedCustomerId: string | null;
}

const sessions = new Map<string, TrendlyContext>();

/**
 * Look up (or lazily create) the persistent state for a conversation.
 *
 * `correlationId` is per-request (for tracing a single call through logs) and
 * is always stamped onto the returned context fresh — it is never persisted
 * as part of session identity, only `conversationId`/`state`/`verifiedCustomerId` are.
 */
export function getSession(conversationId: string, correlationId: string): TrendlyContext {
  const existing = sessions.get(conversationId);
  if (existing) return { ...existing, correlationId };
  const fresh: TrendlyContext = {
    conversationId, correlationId, state: 'ANONYMOUS', verifiedCustomerId: null,
  };
  sessions.set(conversationId, fresh);
  return fresh;
}

/**
 * Called once `verify_customer` succeeds. This is the ONLY place a
 * conversation transitions to VERIFIED, and the only place a customer id is
 * ever attached to a session — never from a model-supplied tool argument.
 */
export function verifySession(conversationId: string, customerId: string): void {
  const s = sessions.get(conversationId);
  if (!s) throw new Error(`Unknown conversation: ${conversationId}`);
  sessions.set(conversationId, { ...s, state: 'VERIFIED', verifiedCustomerId: customerId });
}

export function escalateSession(conversationId: string): void {
  const s = sessions.get(conversationId);
  if (s) sessions.set(conversationId, { ...s, state: 'ESCALATED' });
}

/** Test-only reset. Production state is per-process and intentionally ephemeral. */
export function resetSessions(): void { sessions.clear(); }
