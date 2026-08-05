import {
  describe, it, expect, vi, beforeEach,
} from 'vitest';
import { NextRequest } from 'next/server';
import type { TraceEvent } from '@/lib/obs/trace';
import type { ProviderEntry } from '@/lib/agent/providers';
import { CircuitBreaker } from '@/lib/agent/breaker';

const { runTurnMock, getProviderChainMock } = vi.hoisted(() => ({
  runTurnMock: vi.fn(),
  getProviderChainMock: vi.fn(),
}));

vi.mock('@/lib/agent/loop', () => ({ runTurn: runTurnMock }));
vi.mock('@/lib/agent/providers', () => ({ getProviderChain: getProviderChainMock }));

// Imported after the mocks so the route picks up the mocked modules.
const { POST } = await import('@/app/api/chat/route');
const { GET: getTrace } = await import('@/app/api/trace/[id]/route');
const { resetTraceStore, getTraceByCorrelationId } = await import('@/lib/obs/trace-store');

function stubChain(): ProviderEntry[] {
  return [{
    name: 'stub',
    model: {} as unknown as ProviderEntry['model'],
    breaker: new CircuitBreaker({ threshold: 2, cooldownMs: 30_000 }),
  }];
}

/** Mimics runTurn's real shape: an async generator yielding items, returning RunTurnMeta. */
function fakeTurn(items: unknown[]): AsyncGenerator<unknown, { modelCalls: number; activeToolsFirstStep: string[] }, void> {
  return (async function* gen() {
    for (const item of items) yield item;
    return { modelCalls: 1, activeToolsFirstStep: [] };
  })();
}

function postRequest(body: unknown, raw?: string): NextRequest {
  return new NextRequest('http://localhost/api/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw ?? JSON.stringify(body),
  });
}

/** Splits an SSE body into its parsed `data:` payloads, in order. */
function parseSse(body: string): unknown[] {
  return body
    .split('\n\n')
    .map((chunk) => chunk.trim())
    .filter((chunk) => chunk.startsWith('data: '))
    .map((chunk) => JSON.parse(chunk.slice('data: '.length)));
}

beforeEach(() => {
  runTurnMock.mockReset();
  getProviderChainMock.mockReset();
  getProviderChainMock.mockReturnValue(stubChain());
  resetTraceStore();
});

describe('POST /api/chat — validation', () => {
  it('rejects invalid JSON with 400 and a structured error, no stack trace', async () => {
    const res = await POST(postRequest(undefined, '{not valid json'));
    expect(res.status).toBe(400);
    const payload = await res.json();
    expect(payload.error.code).toBe('INVALID_JSON');
    expect(JSON.stringify(payload)).not.toMatch(/at \S+:\d+:\d+/);
  });

  it('rejects a body failing zod validation with 400', async () => {
    const res = await POST(postRequest({ conversationId: 'c1' })); // missing `message`
    expect(res.status).toBe(400);
    const payload = await res.json();
    expect(payload.error.code).toBe('INVALID_REQUEST');
    expect(Array.isArray(payload.error.issues)).toBe(true);
    expect(payload.error.issues.length).toBeGreaterThan(0);
  });

  it('rejects an empty message', async () => {
    const res = await POST(postRequest({ conversationId: 'c1', message: '' }));
    expect(res.status).toBe(400);
  });
});

describe('POST /api/chat — streaming', () => {
  it('returns text/event-stream with correlationId in the first event', async () => {
    runTurnMock.mockReturnValue(fakeTurn([{ type: 'text', text: 'hello' }]));
    const res = await POST(postRequest({ conversationId: 'conv-1', message: 'hi' }));

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);

    const events = parseSse(await res.text());
    expect(events[0]).toMatchObject({ type: 'meta', conversationId: 'conv-1' });
    const first = events[0] as { correlationId: string };
    expect(first.correlationId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('streams every yielded trace event and the final text chunk, then a done event', async () => {
    const guard: TraceEvent = {
      type: 'guard', name: 'input', verdict: 'pass', correlationId: 'ignored', seq: 0,
    };
    runTurnMock.mockReturnValue(fakeTurn([guard, { type: 'text', text: 'All set.' }]));

    const res = await POST(postRequest({ conversationId: 'conv-2', message: 'hi' }));
    const events = parseSse(await res.text());

    expect(events.map((e) => (e as { type: string }).type))
      .toEqual(['meta', 'guard', 'text', 'done']);
  });

  it('records non-text trace events in the trace store under the correlationId, not the text chunk', async () => {
    const guard: TraceEvent = {
      type: 'guard', name: 'input', verdict: 'pass', correlationId: 'ignored', seq: 0,
    };
    runTurnMock.mockReturnValue(fakeTurn([guard, { type: 'text', text: 'done' }]));

    const res = await POST(postRequest({ conversationId: 'conv-3', message: 'hi' }));
    const events = parseSse(await res.text());
    const meta = events[0] as { correlationId: string };

    const stored = getTraceByCorrelationId(meta.correlationId);
    expect(stored).toHaveLength(1);
    expect(stored?.[0]).toMatchObject({ type: 'guard' });
  });

  it('passes conversationId, message and the provider chain through to runTurn', async () => {
    runTurnMock.mockReturnValue(fakeTurn([{ type: 'text', text: 'ok' }]));
    await POST(postRequest({ conversationId: 'conv-4', message: 'where is my order' }));

    expect(runTurnMock).toHaveBeenCalledTimes(1);
    const call = runTurnMock.mock.calls[0]?.[0];
    expect(call).toMatchObject({ conversationId: 'conv-4', message: 'where is my order' });
    expect(call.providers).toHaveLength(1);
  });

  it('emits an SSE error event (not a raw exception) if the turn throws mid-stream', async () => {
    runTurnMock.mockReturnValue((async function* gen() {
      yield { type: 'text', text: 'partial' };
      throw new Error('provider exploded');
    })());

    const res = await POST(postRequest({ conversationId: 'conv-5', message: 'hi' }));
    const events = parseSse(await res.text());
    const errorEvent = events.find((e) => (e as { type: string }).type === 'error') as
      { message: string } | undefined;

    expect(errorEvent).toBeDefined();
    expect(errorEvent?.message).not.toContain('provider exploded');
    expect(errorEvent?.message).not.toMatch(/at \S+:\d+:\d+/);
  });
});

describe('POST /api/chat — no provider configured', () => {
  it('returns a clear 503 JSON error, never a stack trace', async () => {
    getProviderChainMock.mockImplementation(() => {
      throw new Error('No LLM provider configured. Set GOOGLE_GENERATIVE_AI_API_KEY or GROQ_API_KEY.');
    });

    const res = await POST(postRequest({ conversationId: 'conv-6', message: 'hi' }));
    expect(res.status).toBe(503);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);

    const payload = await res.json();
    expect(payload.error.code).toBe('PROVIDER_NOT_CONFIGURED');
    expect(payload.error.message).toMatch(/GOOGLE_GENERATIVE_AI_API_KEY/);
    expect(payload.error.message).toMatch(/GROQ_API_KEY/);
    expect(JSON.stringify(payload)).not.toMatch(/at \S+:\d+:\d+/);
  });
});

describe('GET /api/trace/[id]', () => {
  it('returns 404 with a structured error for an unknown id', async () => {
    const res = await getTrace(new Request('http://localhost/api/trace/nope'), {
      params: Promise.resolve({ id: 'nope' }),
    });
    expect(res.status).toBe(404);
    const payload = await res.json();
    expect(payload.error.code).toBe('TRACE_NOT_FOUND');
  });

  it('returns the trace for a known correlationId', async () => {
    runTurnMock.mockReturnValue(fakeTurn([
      { type: 'guard', name: 'input', verdict: 'pass' },
      { type: 'text', text: 'ok' },
    ]));
    const chatRes = await POST(postRequest({ conversationId: 'conv-7', message: 'hi' }));
    const events = parseSse(await chatRes.text());
    const { correlationId } = events[0] as { correlationId: string };

    const res = await getTrace(new Request(`http://localhost/api/trace/${correlationId}`), {
      params: Promise.resolve({ id: correlationId }),
    });
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload.events).toHaveLength(1);
    expect(payload.events[0]).toMatchObject({ type: 'guard' });
  });

  it('falls back to a conversationId, concatenating every turn recorded so far', async () => {
    runTurnMock.mockReturnValue(fakeTurn([{ type: 'guard', name: 'input', verdict: 'pass' }]));
    await POST(postRequest({ conversationId: 'conv-8', message: 'first' }));
    runTurnMock.mockReturnValue(fakeTurn([{ type: 'plan', model: 'x', provider: 'stub', latencyMs: 1 }]));
    await POST(postRequest({ conversationId: 'conv-8', message: 'second' }));

    const res = await getTrace(new Request('http://localhost/api/trace/conv-8'), {
      params: Promise.resolve({ id: 'conv-8' }),
    });
    const payload = await res.json();
    expect(payload.events).toHaveLength(2);
    expect(payload.events.map((e: { type: string }) => e.type)).toEqual(['guard', 'plan']);
  });
});
