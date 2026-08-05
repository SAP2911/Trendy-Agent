import { describe, it, expect } from 'vitest';
import { CircuitBreaker } from '@/lib/agent/breaker';

describe('CircuitBreaker', () => {
  it('starts closed and allows attempts', () => {
    const b = new CircuitBreaker({ threshold: 3, cooldownMs: 1000 });
    expect(b.state).toBe('closed');
    expect(b.canAttempt()).toBe(true);
  });

  it('opens after the failure threshold and blocks attempts', () => {
    const b = new CircuitBreaker({ threshold: 3, cooldownMs: 1000 });
    b.recordFailure(); b.recordFailure(); b.recordFailure();
    expect(b.state).toBe('open');
    expect(b.canAttempt()).toBe(false);
  });

  it('half-opens after the cooldown elapses', () => {
    let clock = 0;
    const b = new CircuitBreaker({ threshold: 1, cooldownMs: 500, now: () => clock });
    b.recordFailure();
    expect(b.canAttempt()).toBe(false);
    clock = 600;
    expect(b.canAttempt()).toBe(true);
    expect(b.state).toBe('half-open');
  });

  it('closes again on success', () => {
    const b = new CircuitBreaker({ threshold: 2, cooldownMs: 10 });
    b.recordFailure();
    b.recordSuccess();
    expect(b.state).toBe('closed');
    b.recordFailure();
    expect(b.state).toBe('closed');
  });
});
