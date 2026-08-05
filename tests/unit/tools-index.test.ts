import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import type { ToolSet } from 'ai';
import { buildTools, TOOL_NAMES_ANONYMOUS } from '@/lib/tools/index';
import { getSession, resetSessions } from '@/lib/agent/session';
import type { TrendlyContext } from '@/lib/agent/session';
import { resetStore } from '@/lib/data/store';

/**
 * Exercises the AI SDK 7 `tool()` wrappers themselves (lib/tools/index.ts),
 * not just the pure impls — buildTools()'s execute closures, and the
 * verify_customer -> verifySession() side effect, are otherwise untested and
 * showed up as a 0%-covered file.
 */
const EXEC_OPTS = { toolCallId: 'test-call', messages: [], context: {} };

// The AI SDK's ToolSet typing is intentionally generic here; casting to a
// loose callable shape keeps this file focused on runtime behaviour rather
// than re-deriving each tool's exact input/output type.
async function callTool(tools: ToolSet, name: string, args: unknown): Promise<Record<string, unknown>> {
  const found = (tools as unknown as Record<string, { execute: (a: unknown, o: unknown) => unknown }>)[name];
  if (!found) throw new Error(`No such tool: ${name}`);
  return (await found.execute(args, EXEC_OPTS)) as Record<string, unknown>;
}

const ORIGINAL_AS_OF = process.env.TRENDLY_AS_OF;

function ctx(customerId: string | null): TrendlyContext {
  return {
    conversationId: 'conv-fixed', correlationId: 'r1',
    state: customerId ? ('VERIFIED' as const) : ('ANONYMOUS' as const),
    verifiedCustomerId: customerId,
  };
}

beforeEach(() => {
  resetSessions();
  resetStore();
  process.env.TRENDLY_AS_OF = '2026-08-04T12:00:00Z';
});

afterAll(() => {
  if (ORIGINAL_AS_OF === undefined) delete process.env.TRENDLY_AS_OF;
  else process.env.TRENDLY_AS_OF = ORIGINAL_AS_OF;
});

describe('buildTools', () => {
  it('exposes exactly the 13 documented tools', () => {
    const tools = buildTools(ctx('C-100'));
    expect(Object.keys(tools).sort()).toEqual([
      'check_delay_credit', 'check_exchange_eligibility', 'check_return_eligibility',
      'compute_refund_timeline', 'escalate_to_human', 'initiate_exchange',
      'initiate_return', 'issue_delay_credit', 'list_customer_orders', 'lookup_order',
      'report_damaged_item', 'search_policy', 'verify_customer',
    ]);
  });

  it('TOOL_NAMES_ANONYMOUS names only tools that actually exist', () => {
    const tools = buildTools(ctx(null));
    for (const name of TOOL_NAMES_ANONYMOUS) {
      expect(Object.keys(tools)).toContain(name);
    }
    expect(TOOL_NAMES_ANONYMOUS).toEqual([
      'verify_customer', 'search_policy', 'escalate_to_human',
    ]);
  });

  it('verify_customer succeeding transitions the session to VERIFIED', async () => {
    const conversationId = 'sess-verify-ok';
    getSession(conversationId, 'r1'); // seeds the session store
    const tools = buildTools({
      conversationId, correlationId: 'r1', state: 'ANONYMOUS', verifiedCustomerId: null,
    });
    const result = await callTool(tools, 'verify_customer', { contact: 'ananya.rao@example.com' });
    expect(result.code).toBe('VERIFIED');
    const after = getSession(conversationId, 'r2');
    expect(after.state).toBe('VERIFIED');
    expect(after.verifiedCustomerId).toBe('C-100');
  });

  it('verify_customer failing leaves the session ANONYMOUS', async () => {
    const conversationId = 'sess-verify-fail';
    getSession(conversationId, 'r1');
    const tools = buildTools({
      conversationId, correlationId: 'r1', state: 'ANONYMOUS', verifiedCustomerId: null,
    });
    const result = await callTool(tools, 'verify_customer', { contact: 'nobody@example.com' });
    expect(result.code).toBe('NOT_RECOGNISED');
    expect(getSession(conversationId, 'r2').state).toBe('ANONYMOUS');
  });

  it('wires every read tool through to its impl', async () => {
    const tools = buildTools(ctx('C-100'));
    expect((await callTool(tools, 'lookup_order', { orderId: 'TR-4521' })).code).toBe('OK');
    expect((await callTool(tools, 'list_customer_orders', {})).code).toBe('OK');
    expect((await callTool(tools, 'check_return_eligibility', { orderId: 'TR-4521' })).code)
      .toBe('OK');
    expect((await callTool(tools, 'check_exchange_eligibility',
      { orderId: 'TR-4521', sku: 'TR-DRS-014', requestedSize: 'L' })).code).toBe('OK');
    expect((await callTool(tools, 'search_policy', { query: 'return window' })).code)
      .toBe('HITS');
    expect((await callTool(tools, 'compute_refund_timeline', { orderId: 'TR-4521' })).code)
      .toBe('UNMAPPED_PAYMENT_METHOD');
    expect((await callTool(tools, 'check_delay_credit', { orderId: 'TR-4521' })).code)
      .toBe('NOT_OWED');
    expect((await callTool(tools, 'report_damaged_item',
      { orderId: 'TR-4521', sku: 'TR-DRS-014' })).code).toBe('OUTSIDE_WINDOW');
  });

  it('wires every mutating tool through to its impl', async () => {
    const tools = buildTools(ctx('C-101'));
    expect((await callTool(tools, 'initiate_return',
      { orderId: 'TR-4530', sku: 'TR-KRT-033' })).code).toBe('RETURN_CREATED');
    expect((await callTool(tools, 'initiate_exchange',
      { orderId: 'TR-4530', sku: 'TR-KRT-033', toSize: 'M' })).code).toBe('EXCHANGE_CREATED');
  });

  it('wires issue_delay_credit through to its impl', async () => {
    const tools = buildTools(ctx('C-103'));
    expect((await callTool(tools, 'issue_delay_credit', { orderId: 'TR-4525' })).code)
      .toBe('CREDIT_ISSUED');
  });

  it('wires escalate_to_human through to its impl', async () => {
    const tools = buildTools(ctx('C-101'));
    const r = await callTool(tools, 'escalate_to_human', {
      reasonCode: 'CUSTOMER_REQUESTED_HUMAN', situation: 'x',
      suggestedResolution: 'y', orderIds: [],
    });
    expect(r.code).toBe('ESCALATED');
  });
});
