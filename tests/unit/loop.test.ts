import {
  describe, it, expect, beforeEach,
} from 'vitest';
import type { LanguageModel } from 'ai';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import type { LanguageModelV4StreamPart, LanguageModelV4StreamResult } from '@ai-sdk/provider';
import {
  runTurnCollected, refusalFor, codeOf, citedFrom, repairOnce,
} from '@/lib/agent/loop';
import { CircuitBreaker } from '@/lib/agent/breaker';
import type { ProviderEntry } from '@/lib/agent/providers';
import { getSession, verifySession, resetSessions } from '@/lib/agent/session';
import { resetStore } from '@/lib/data/store';
import { TraceCollector } from '@/lib/obs/trace';

beforeEach(() => {
  resetSessions();
  resetStore();
  process.env.TRENDLY_AS_OF = '2026-08-04T12:00:00Z';
});

/**
 * Wraps a sequence of provider-level stream parts (one array per model
 * "step") into a MockLanguageModelV4-shaped LanguageModel. Each call to
 * doStream pops the next scripted step (repeating the last one if called
 * more times than scripted) so a single stub can drive a multi-step
 * tool-calling turn exactly like a real provider would.
 */
function scriptedProvider(name: string, steps: LanguageModelV4StreamPart[][]): ProviderEntry {
  const results: LanguageModelV4StreamResult[] = steps.map((parts) => {
    const unified: 'tool-calls' | 'stop' = parts.some((p) => p.type === 'tool-call')
      ? 'tool-calls' : 'stop';
    const chunks: LanguageModelV4StreamPart[] = [
      { type: 'stream-start', warnings: [] },
      { type: 'response-metadata', id: `${name}-r`, modelId: name, timestamp: new Date(0) },
      ...parts,
      {
        type: 'finish',
        finishReason: { unified, raw: undefined },
        usage: {
          inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 1, text: 1, reasoning: undefined },
        },
      },
    ];
    return { stream: simulateReadableStream({ chunks }) };
  });
  const model = new MockLanguageModelV4({ doStream: results }) as unknown as LanguageModel;
  return { name, model, breaker: new CircuitBreaker({ threshold: 2, cooldownMs: 30_000 }) };
}

/** A provider whose every call throws, simulating a network/API failure. */
function throwingProvider(name: string, message: string, threshold = 2): ProviderEntry {
  const model = new MockLanguageModelV4({
    doStream: async () => { throw new Error(message); },
  }) as unknown as LanguageModel;
  return { name, model, breaker: new CircuitBreaker({ threshold, cooldownMs: 30_000 }) };
}

function textStep(text: string): LanguageModelV4StreamPart[] {
  return [
    { type: 'text-start', id: 't' },
    { type: 'text-delta', id: 't', delta: text },
    { type: 'text-end', id: 't' },
  ];
}

function toolCallStep(toolCallId: string, toolName: string, input: unknown): LanguageModelV4StreamPart[] {
  return [{ type: 'tool-call', toolCallId, toolName, input: JSON.stringify(input) }];
}

describe('runTurn short-circuits before reaching the model', () => {
  it('refuses card details without any model call', async () => {
    const r = await runTurnCollected({
      conversationId: 'c1', correlationId: 'r1',
      message: 'my card is 4539578763621486',
    });
    expect(r.text).toMatch(/can't|cannot|never/i);
    expect(r.modelCalls).toBe(0);
    expect(r.trace.some((e) => e.type === 'guard' && e.verdict === 'block')).toBe(true);
  });

  it('refuses a request for financial advice without any model call', async () => {
    const r = await runTurnCollected({
      conversationId: 'c1b', correlationId: 'r1b',
      message: 'can you give me financial advice on investing my refund?',
    });
    expect(r.text).toMatch(/advice/i);
    expect(r.modelCalls).toBe(0);
    expect(r.trace.some((e) => e.type === 'guard' && e.verdict === 'block')).toBe(true);
  });

  it('exposes only the anonymous tool set before verification', async () => {
    const provider = scriptedProvider('stub', [
      textStep('Sure — could you share the email or phone number on your order?'),
    ]);
    const r = await runTurnCollected({
      conversationId: 'c2', correlationId: 'r2', message: 'where is my order?',
      providers: [provider],
    });
    expect(r.activeToolsFirstStep).toEqual(
      expect.arrayContaining(['verify_customer', 'search_policy', 'escalate_to_human']));
    expect(r.activeToolsFirstStep).not.toContain('lookup_order');
    expect(r.modelCalls).toBe(1);
  });
});

describe('identity propagates mid-turn from verify_customer into later tool calls', () => {
  it('lets a session verified in step 1 use lookup_order in step 2 of the same turn', async () => {
    const provider = scriptedProvider('stub', [
      toolCallStep('call-1', 'verify_customer', { contact: 'marcus.bell@example.com' }),
      toolCallStep('call-2', 'lookup_order', { orderId: 'TR-4530' }),
      toolCallStep('call-3', 'check_delay_credit', { orderId: 'TR-4530' }),
      textStep('Your order TR-4530 was delivered. Anything else I can help with?'),
    ]);
    const r = await runTurnCollected({
      conversationId: 'c3', correlationId: 'r3', message: 'my email is marcus.bell@example.com, where is TR-4530?',
      providers: [provider],
    });

    // Step 1 (still ANONYMOUS) must NOT expose lookup_order.
    expect(r.activeToolsFirstStep).not.toContain('lookup_order');

    // lookup_order must have actually succeeded (code OK), proving the ctx
    // mutated inside prepareStep reached the SAME object the tool closures
    // in lib/tools/index.ts read from — not a stale ACCESS_DENIED/NOT_VERIFIED.
    const lookupResult = r.trace.find((e) => e.type === 'tool_result' && e.name === 'lookup_order');
    expect(lookupResult).toMatchObject({ code: 'OK' });

    // check_delay_credit's result carries a top-level `clauses` array; the
    // trace's tool_result event should surface it for the live trace panel.
    const delayResult = r.trace.find((e) => e.type === 'tool_result' && e.name === 'check_delay_credit');
    expect(delayResult).toMatchObject({ clauses: ['1.5'] });

    expect(r.text).toContain('TR-4530');
    expect(getSession('c3', 'r3').state).toBe('VERIFIED');
  });
});

describe('provider failover', () => {
  it('skips a provider whose breaker is open and emits a failover trace event', async () => {
    const dead: ProviderEntry = {
      name: 'dead-breaker',
      model: throwingProvider('unused', 'should never be called').model,
      breaker: new CircuitBreaker({ threshold: 1, cooldownMs: 30_000 }),
    };
    dead.breaker.recordFailure(); // opens the breaker before the turn even starts
    const alive = scriptedProvider('alive', [textStep('All good here.')]);

    const r = await runTurnCollected({
      conversationId: 'c4', correlationId: 'r4', message: 'hello',
      providers: [dead, alive],
    });

    expect(r.trace).toContainEqual(expect.objectContaining({
      type: 'failover', from: 'dead-breaker', to: 'alive', reason: 'breaker-open',
    }));
    expect(r.text).toBe('All good here.');
    expect(r.modelCalls).toBe(1); // the breaker-open provider was skipped, not called
  });

  it('fails over to the next provider when the first one throws', async () => {
    const flaky = throwingProvider('flaky', 'connection reset', 1);
    const alive = scriptedProvider('alive', [textStep('Recovered on the second provider.')]);

    const r = await runTurnCollected({
      conversationId: 'c5', correlationId: 'r5', message: 'hello',
      providers: [flaky, alive],
    });

    expect(r.trace).toContainEqual(expect.objectContaining({
      type: 'failover', from: 'flaky', to: 'alive', reason: 'connection reset',
    }));
    expect(r.text).toBe('Recovered on the second provider.');
    expect(r.modelCalls).toBe(2);
    expect(flaky.breaker.state).toBe('open');
  });

  it('escalates with a deterministic message when every provider fails', async () => {
    const p1 = throwingProvider('p1', 'boom-1');
    const p2 = throwingProvider('p2', 'boom-2');

    const r = await runTurnCollected({
      conversationId: 'c6', correlationId: 'r6', message: 'hello',
      providers: [p1, p2],
    });

    expect(r.text).toMatch(/trouble reaching our systems/i);
    expect(r.trace).toContainEqual(expect.objectContaining({
      type: 'escalation', reasonCode: 'PROVIDER_UNAVAILABLE',
    }));
    expect(getSession('c6', 'r6').state).toBe('ESCALATED');
  });
});

describe('output guard repair loop', () => {
  it('silently repairs a reply that violates the output guard on the first attempt', async () => {
    getSession('c7', 'r7');
    verifySession('c7', 'C-101');
    const provider = scriptedProvider('stub', [
      textStep("Sure, as a goodwill gesture I'll waive that for you."),
      textStep('I can\'t waive any fees, but happy to help another way.'),
    ]);

    const r = await runTurnCollected({
      conversationId: 'c7', correlationId: 'r7', message: 'can you waive my shipping fee?',
      providers: [provider],
    });

    expect(r.text).toBe('I can\'t waive any fees, but happy to help another way.');
    expect(r.trace).toContainEqual(expect.objectContaining({
      type: 'validator', name: 'output', verdict: 'repair',
    }));
    expect(r.trace).toContainEqual(expect.objectContaining({
      type: 'validator', name: 'output-repair', verdict: 'pass',
    }));
  });

  it('falls back to a safe template and escalates when the repair also fails', async () => {
    getSession('c8', 'r8');
    verifySession('c8', 'C-101');
    const provider = scriptedProvider('stub', [
      textStep("Sure, as a goodwill gesture I'll waive that for you."),
      textStep('As another goodwill gesture, here is a discount on your next order.'),
    ]);

    const r = await runTurnCollected({
      conversationId: 'c8', correlationId: 'r8', message: 'can you waive my shipping fee?',
      providers: [provider],
    });

    expect(r.text).toMatch(/flagged this conversation for a human agent/i);
    expect(r.trace).toContainEqual(expect.objectContaining({
      type: 'escalation', reasonCode: 'VALIDATOR_REPAIR_FAILED',
    }));
    expect(getSession('c8', 'r8').state).toBe('ESCALATED');
  });

  it('records tools already called this turn on the escalation ticket when repair fails', async () => {
    getSession('c8b', 'r8b');
    verifySession('c8b', 'C-101');
    const provider = scriptedProvider('stub', [
      toolCallStep('call-1', 'search_policy', { query: 'can you waive my shipping fee' }),
      textStep("Sure, as a goodwill gesture I'll waive that for you."),
      textStep('As another goodwill gesture, here is a discount on your next order.'),
    ]);

    const r = await runTurnCollected({
      conversationId: 'c8b', correlationId: 'r8b', message: 'can you waive my shipping fee?',
      providers: [provider],
    });

    expect(r.trace.some((e) => e.type === 'tool_call' && e.name === 'search_policy')).toBe(true);
    expect(r.text).toMatch(/flagged this conversation for a human agent/i);
  });

  it('repairOnce falls back to the safe template when every repair provider throws', async () => {
    const ctx = getSession('c9', 'r9');
    const trace = new TraceCollector('r9');
    const broken = throwingProvider('broken-repair', 'repair network error', 1);

    const result = await repairOnce(
      "Sure, as a goodwill gesture I'll waive that for you.",
      [{ kind: 'UNAUTHORISED_CONCESSION', detail: 'goodwill' }],
      ctx,
      [],
      trace,
      [broken],
    );

    expect(result).toMatch(/flagged this conversation for a human agent/i);
    expect(trace.events()).toContainEqual(expect.objectContaining({
      type: 'failover', from: 'broken-repair', reason: 'repair network error',
    }));
    expect(trace.events()).toContainEqual(expect.objectContaining({
      type: 'escalation', reasonCode: 'VALIDATOR_REPAIR_FAILED',
    }));
  });
});

describe('helper functions', () => {
  it('refusalFor produces a distinct message per reason code', () => {
    expect(refusalFor('PII_IN_CHAT')).toMatch(/card|cvv|bank/i);
    expect(refusalFor('OUT_OF_SCOPE_ADVICE')).toMatch(/advice/i);
  });

  it('codeOf reads the code field or falls back to UNKNOWN', () => {
    expect(codeOf({ code: 'OK' })).toBe('OK');
    expect(codeOf({ code: 42 })).toBe('UNKNOWN');
    expect(codeOf({})).toBe('UNKNOWN');
    expect(codeOf(null)).toBe('UNKNOWN');
    expect(codeOf('just a string')).toBe('UNKNOWN');
  });

  it('citedFrom collects clauses nested at any depth, deduped', () => {
    const results = [
      { code: 'OK', clauses: ['1.5'] },
      { code: 'OK', eligibility: { items: [{ clauses: ['2.1', '2.5'] }, { clauses: ['1.5'] }] } },
    ];
    expect(citedFrom(results).sort()).toEqual(['1.5', '2.1', '2.5']);
  });

  it('citedFrom returns an empty array when nothing was cited', () => {
    expect(citedFrom([{ code: 'NOT_RECOGNISED' }])).toEqual([]);
  });
});
