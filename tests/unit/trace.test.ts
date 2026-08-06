import { describe, it, expect } from 'vitest';
import { TraceCollector, redact } from '@/lib/obs/trace';

describe('TraceCollector', () => {
  it('stamps every event with the correlation id and a sequence number', () => {
    const t = new TraceCollector('corr-1');
    t.emit({ type: 'guard', name: 'pii', verdict: 'pass' });
    t.emit({ type: 'tool_call', name: 'lookup_order', args: { orderId: 'TR-4530' } });
    const events = t.events();
    expect(events).toHaveLength(2);
    expect(events.every((e) => e.correlationId === 'corr-1')).toBe(true);
    expect(events.map((e) => e.seq)).toEqual([0, 1]);
  });

  it('preserves the discriminated event shape alongside the stamped fields', () => {
    const t = new TraceCollector('corr-2');
    t.emit({ type: 'tool_result', name: 'search_policy', code: 'OK', clauses: ['2.1'] });
    t.emit({ type: 'failover', from: 'google', to: 'groq', reason: 'breaker-open' });
    t.emit({ type: 'validator', name: 'output', verdict: 'repair' });
    t.emit({ type: 'plan', model: 'gemini-3.6-flash', provider: 'google', latencyMs: 42 });
    t.emit({ type: 'escalation', reasonCode: 'LOST_PARCEL_CLAIM', ticketId: 'TKT-00001' });
    const [toolResult, failover, validator, plan, escalation] = t.events();
    expect(toolResult).toMatchObject({ type: 'tool_result', code: 'OK', clauses: ['2.1'] });
    expect(failover).toMatchObject({ type: 'failover', from: 'google', to: 'groq' });
    expect(validator).toMatchObject({ type: 'validator', verdict: 'repair' });
    expect(plan).toMatchObject({ type: 'plan', model: 'gemini-3.6-flash' });
    expect(escalation).toMatchObject({ type: 'escalation', ticketId: 'TKT-00001' });
  });

  it('events() returns every event regardless of prior drain() calls', () => {
    const t = new TraceCollector('corr-3');
    t.emit({ type: 'guard', name: 'input', verdict: 'pass' });
    t.drain();
    t.emit({ type: 'guard', name: 'output', verdict: 'pass' });
    expect(t.events()).toHaveLength(2);
  });

  it('drain() returns only events emitted since the last drain, then resets', () => {
    const t = new TraceCollector('corr-4');
    expect(t.drain()).toEqual([]);
    t.emit({ type: 'guard', name: 'a', verdict: 'pass' });
    t.emit({ type: 'guard', name: 'b', verdict: 'pass' });
    const first = t.drain();
    expect(first.map((e) => (e.type === 'guard' ? e.name : undefined))).toEqual(['a', 'b']);
    expect(t.drain()).toEqual([]);
    t.emit({ type: 'guard', name: 'c', verdict: 'pass' });
    const last = t.drain();
    expect(last.map((e) => (e.type === 'guard' ? e.name : undefined))).toEqual(['c']);
  });
});

describe('redact', () => {
  it('never lets an api key reach the log', () => {
    const out = JSON.stringify(redact({ apiKey: 'AIzaSecret', GROQ_API_KEY: 'gsk_x' }));
    expect(out).not.toContain('AIzaSecret');
    expect(out).not.toContain('gsk_x');
  });

  it('redacts email addresses in traced values', () => {
    expect(JSON.stringify(redact({ contact: 'ananya.rao@example.com' })))
      .not.toContain('ananya.rao@example.com');
  });

  it('redacts secrets and emails inside nested objects and arrays', () => {
    const out = JSON.stringify(redact({
      headers: { Authorization: 'Bearer sk-live-abc123' },
      tickets: [{ situation: 'contact me at priya@example.com please' }],
    }));
    expect(out).not.toContain('sk-live-abc123');
    expect(out).not.toContain('priya@example.com');
  });

  it('leaves non-secret, non-email values untouched', () => {
    expect(redact({ orderId: 'TR-4530', qty: 2, ok: true, note: null })).toEqual({
      orderId: 'TR-4530', qty: 2, ok: true, note: null,
    });
  });

  it('passes primitives through unchanged', () => {
    expect(redact(42)).toBe(42);
    expect(redact(true)).toBe(true);
    expect(redact(null)).toBe(null);
    expect(redact(undefined)).toBe(undefined);
  });

  it('does not loop forever on a circular reference', () => {
    const obj: Record<string, unknown> = { name: 'loop' };
    obj.self = obj;
    expect(() => redact(obj)).not.toThrow();
  });
});
