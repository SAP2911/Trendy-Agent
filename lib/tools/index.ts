import { tool, type ToolSet } from 'ai';
import { z } from 'zod';
import type { TrendlyContext } from '@/lib/agent/session';
import { verifySession } from '@/lib/agent/session';
import * as impl from './impl';

/**
 * Tools read the verified identity from `ctx`, closed over here at build
 * time — NEVER from a model-supplied argument. There is no `customerId`
 * parameter on any tool below: the model is structurally unable to name
 * which customer it is acting as. A prompt injection that tries to pass a
 * different id has nowhere to put it. This is the crux of the
 * authorization design; everything else (per-tool ACCESS_DENIED handling,
 * server-side re-verification in mutating.ts) builds on this one fact.
 */
export function buildTools(ctx: TrendlyContext): ToolSet {
  return {
    verify_customer: tool({
      description:
        'Verify who you are speaking to, using the email address or phone number on '
        + 'their order. Must be called, and must succeed, before any order-specific tool '
        + 'is used. Never ask the customer for a customer id — only an email or phone '
        + 'number. On NOT_RECOGNISED, ask them to double-check what they typed; never '
        + 'reveal whether the contact is close to a real account.',
      inputSchema: z.object({
        contact: z.string().describe('Email address or phone number the customer gives'),
      }),
      execute: async (args) => {
        const result = impl.verifyCustomerImpl(args, ctx);
        // The ONLY place a session transitions to VERIFIED, and the only
        // place a customer id is ever attached to it — sourced from the
        // dataset lookup inside verifyCustomerImpl, never echoed from a
        // model-supplied argument.
        if (result.code === 'VERIFIED') {
          verifySession(ctx.conversationId, result.customerId);
        }
        return result;
      },
    }),

    lookup_order: tool({
      description:
        'Fetch one order belonging to the verified customer: status, carrier, tracking, '
        + 'items, and dates. ACCESS_DENIED is returned identically whether the order id '
        + "does not exist or belongs to a different customer — never tell the customer "
        + "their order id looks wrong; just say the order isn't on this account.",
      inputSchema: z.object({
        orderId: z.string().describe('Order id, e.g. TR-4530'),
      }),
      execute: async (args) => impl.lookupOrderImpl(args, ctx),
    }),

    list_customer_orders: tool({
      description:
        "List every order on the verified customer's account. Use this when the "
        + 'customer has not given a specific order id, or asks something like '
        + '"what have I ordered" or "show my orders".',
      inputSchema: z.object({}),
      execute: async () => impl.listCustomerOrdersImpl({}, ctx),
    }),

    check_return_eligibility: tool({
      description:
        'Decide whether each item in an order can be returned. Returns one verdict PER '
        + 'ITEM — a single order can mix eligible and ineligible items — with the policy '
        + 'clauses that produced each verdict. Always call this before telling a customer '
        + 'whether they can return something; never guess from the item category alone.',
      inputSchema: z.object({ orderId: z.string() }),
      execute: async (args) => impl.checkReturnEligibilityImpl(args, ctx),
    }),

    check_exchange_eligibility: tool({
      description:
        'Decide whether one item in an order can be exchanged for a different SIZE. '
        + 'Trendly offers size exchanges only (§4.1) — for a different colour or style, '
        + 'tell the customer to return the item and place a new order; do not call this '
        + 'tool for that case.',
      inputSchema: z.object({
        orderId: z.string(), sku: z.string(), requestedSize: z.string(),
      }),
      execute: async (args) => impl.checkExchangeEligibilityImpl(args, ctx),
    }),

    search_policy: tool({
      description:
        "Look up Trendly's shipping/returns policy using the customer's own words. "
        + 'Returns clause ids and exact text, or NO_COVERAGE when the policy does not '
        + 'address the question. If NO_COVERAGE comes back, say plainly that the policy '
        + 'does not cover it and offer a human agent — never guess, and never invent '
        + 'policy that is not in the returned text.',
      inputSchema: z.object({
        query: z.string().describe("The policy question, in the customer's own words"),
      }),
      execute: async (args) => impl.searchPolicyImpl(args),
    }),

    compute_refund_timeline: tool({
      description:
        'Look up how, and how soon, a refund will arrive for an order, based on its '
        + 'original payment method. Returns UNMAPPED_PAYMENT_METHOD for a payment method '
        + 'the policy table does not cover (e.g. prepaid_card) — in that case say the '
        + 'policy does not specify a timeline for it and offer a human agent; never guess '
        + 'one by analogy to a similar payment method.',
      inputSchema: z.object({ orderId: z.string() }),
      execute: async (args) => impl.computeRefundTimelineImpl(args, ctx),
    }),

    check_delay_credit: tool({
      description:
        'Check whether an order qualifies for the ₹250 delivery-delay store credit — '
        + 'more than 3 business days past its expected delivery date (§1.5). Always call '
        + 'this before offering or issuing a delay credit; do not take the customer\'s '
        + 'word for how late an order is.',
      inputSchema: z.object({ orderId: z.string() }),
      execute: async (args) => impl.checkDelayCreditImpl(args, ctx),
    }),

    report_damaged_item: tool({
      description:
        'Check whether a damaged, defective, or incorrect item report is within the '
        + '48-hour-from-delivery reporting window (§6.1). Returns OUTSIDE_WINDOW honestly '
        + 'when the window has closed — do not promise a replacement or refund the policy '
        + 'does not authorise just because the item genuinely arrived damaged.',
      inputSchema: z.object({ orderId: z.string(), sku: z.string() }),
      execute: async (args) => impl.reportDamagedItemImpl(args, ctx),
    }),
  } satisfies ToolSet;
}

/**
 * While unverified, the agent loop shows the model only these tool names
 * (see the prepareStep-based gating built in a later task). Kept as a plain
 * array — not derived from buildTools()'s keys — so the anonymous allowlist
 * is an explicit, auditable decision rather than "whatever happens to be
 * left after some other filter runs".
 */
export const TOOL_NAMES_ANONYMOUS = [
  'verify_customer', 'search_policy', 'escalate_to_human',
] as const;
