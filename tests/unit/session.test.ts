import { describe, it, expect, beforeEach } from 'vitest';
import {
  getSession, verifySession, escalateSession, resetSessions,
} from '@/lib/agent/session';

beforeEach(() => { resetSessions(); });

describe('session state machine', () => {
  it('creates a fresh ANONYMOUS session on first contact', () => {
    const s = getSession('c1', 'r1');
    expect(s.state).toBe('ANONYMOUS');
    expect(s.verifiedCustomerId).toBeNull();
    expect(s.conversationId).toBe('c1');
    expect(s.correlationId).toBe('r1');
  });

  it('persists state across calls for the same conversation', () => {
    getSession('c1', 'r1');
    verifySession('c1', 'C-100');
    const s = getSession('c1', 'r2');
    expect(s.state).toBe('VERIFIED');
    expect(s.verifiedCustomerId).toBe('C-100');
    // correlationId always reflects the current call, not what was stored.
    expect(s.correlationId).toBe('r2');
  });

  it('keeps separate conversations fully isolated', () => {
    getSession('c1', 'r1');
    getSession('c2', 'r1');
    verifySession('c1', 'C-100');
    expect(getSession('c2', 'r2').state).toBe('ANONYMOUS');
    expect(getSession('c2', 'r2').verifiedCustomerId).toBeNull();
  });

  it('throws when verifying a conversation that was never started', () => {
    expect(() => verifySession('ghost', 'C-100')).toThrow(/Unknown conversation/);
  });

  it('transitions a session to ESCALATED', () => {
    getSession('c1', 'r1');
    escalateSession('c1');
    expect(getSession('c1', 'r2').state).toBe('ESCALATED');
  });

  it('is a no-op to escalate a conversation that does not exist', () => {
    expect(() => escalateSession('ghost')).not.toThrow();
  });
});
