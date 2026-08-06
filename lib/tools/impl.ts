import {
  getOrder, getOrdersForCustomer, findCustomerByContact, type Order,
} from '@/lib/data/orders';
import type { TrendlyContext } from '@/lib/agent/session';
import { now, parseUtcDate } from '@/lib/policy/clock';
import { checkReturnEligibility, checkExchangeEligibility } from '@/lib/policy/eligibility';
import { refundPlanFor } from '@/lib/policy/refunds';
import { delayCreditFor } from '@/lib/policy/delay';
import { searchPolicy } from '@/lib/policy/retrieval';

/**
 * Read-tool implementations, kept as pure functions of (args, ctx) so they
 * are testable with no AI SDK involved. `ctx` always comes from the runtime
 * session (Task 8), never from a model-supplied argument — the model has no
 * `customerId` parameter to name, anywhere, on any tool. That is the crux of
 * the authorization design: it cannot forge an identity it is never asked
 * to supply.
 */

const NOT_VERIFIED_MESSAGE =
  'Ask the customer for the email address or phone number on the order, then call '
  + 'verify_customer before looking anything up.';

function accessDeniedMessage(orderId: string): string {
  return `No order ${orderId} is associated with this account.`;
}

type AuthFailureCode = 'NOT_VERIFIED' | 'ACCESS_DENIED';
type AuthResult =
  | { ok: true; order: Order }
  | { ok: false; code: AuthFailureCode };

/**
 * Shared identity gate for every order-scoped read tool.
 *
 * A missing order and someone else's order MUST produce the identical
 * ACCESS_DENIED response — distinguishing them would turn the agent into an
 * order-existence oracle for an attacker. Policy §7 separately forbids
 * confirming or discussing any order belonging to a different customer;
 * this function is the one place that rule is enforced, so every caller
 * inherits it instead of re-implementing (and possibly getting it wrong).
 */
function authoriseOrder(orderId: string, ctx: TrendlyContext): AuthResult {
  if (!ctx.verifiedCustomerId) return { ok: false, code: 'NOT_VERIFIED' };
  const order = getOrder(orderId);
  if (!order || order.customer_id !== ctx.verifiedCustomerId) {
    return { ok: false, code: 'ACCESS_DENIED' };
  }
  return { ok: true, order };
}

function authFailure(code: AuthFailureCode, orderId: string) {
  return code === 'NOT_VERIFIED'
    ? { code: 'NOT_VERIFIED' as const, message: NOT_VERIFIED_MESSAGE }
    : { code: 'ACCESS_DENIED' as const, message: accessDeniedMessage(orderId) };
}

function summariseOrder(order: Order) {
  return {
    orderId: order.order_id, status: order.status,
    placedAt: order.placed_at, deliveredAt: order.delivered_at,
    expectedDelivery: order.expected_delivery,
    carrier: order.carrier, trackingNumber: order.tracking_number,
    paymentMethod: order.payment_method, shippingCity: order.shipping_city,
    total: order.total,
    items: order.items.map((i) => ({
      sku: i.sku, name: i.name, category: i.category, size: i.size,
      qty: i.qty, price: i.price, finalSale: i.final_sale,
      shipped: i.shipped, backorderEta: i.backorder_eta,
    })),
  };
}

/**
 * Verify who the customer is, from a contact string THEY supply — never
 * from an id. On success, the caller (lib/tools/index.ts) is responsible
 * for calling verifySession() to actually transition the session; this
 * function stays a pure lookup so it is trivially testable.
 */
export function verifyCustomerImpl(args: { contact: string }, ctx: TrendlyContext) {
  void ctx; // signature kept uniform with every other tool impl; unused here by design.
  const customer = findCustomerByContact(args.contact);

  // Silence is the security property: an unknown contact must look IDENTICAL
  // to any other unrecognised one. No customer id, no name, nothing that
  // would let an attacker enumerate valid emails/phones by watching for a
  // different response shape.
  if (!customer) {
    return {
      code: 'NOT_RECOGNISED' as const,
      message: 'No Trendly account matches that email or phone number. Ask the customer '
        + 'to double-check the contact info on their order, or offer a human agent if '
        + 'they still cannot verify.',
    };
  }

  return {
    code: 'VERIFIED' as const,
    customerId: customer.customer_id,
    name: customer.name,
    message: `Identity verified for ${customer.name}.`,
  };
}

export function lookupOrderImpl(args: { orderId: string }, ctx: TrendlyContext) {
  const auth = authoriseOrder(args.orderId, ctx);
  if (!auth.ok) return authFailure(auth.code, args.orderId);

  return {
    code: 'OK' as const,
    evaluatedAt: now().toISOString().slice(0, 10),
    order: summariseOrder(auth.order),
  };
}

export function listCustomerOrdersImpl(
  _args: Record<string, never>, ctx: TrendlyContext,
) {
  if (!ctx.verifiedCustomerId) {
    return { code: 'NOT_VERIFIED' as const, message: NOT_VERIFIED_MESSAGE };
  }
  return {
    code: 'OK' as const,
    orders: getOrdersForCustomer(ctx.verifiedCustomerId).map(summariseOrder),
  };
}

export function checkReturnEligibilityImpl(args: { orderId: string }, ctx: TrendlyContext) {
  const auth = authoriseOrder(args.orderId, ctx);
  if (!auth.ok) return authFailure(auth.code, args.orderId);
  return { code: 'OK' as const, eligibility: checkReturnEligibility(auth.order) };
}

export function checkExchangeEligibilityImpl(
  args: { orderId: string; sku: string; requestedSize: string }, ctx: TrendlyContext,
) {
  const auth = authoriseOrder(args.orderId, ctx);
  if (!auth.ok) return authFailure(auth.code, args.orderId);
  return {
    code: 'OK' as const,
    verdict: checkExchangeEligibility(auth.order, args.sku, args.requestedSize),
  };
}

/**
 * Policy lookup is not customer-scoped — the shipping/returns policy is the
 * same document for everyone — so this is the one read tool that takes no
 * ctx at all. NO_COVERAGE is the load-bearing branch: see lib/policy/retrieval.ts.
 */
export function searchPolicyImpl(args: { query: string }) {
  return searchPolicy(args.query);
}

export function computeRefundTimelineImpl(args: { orderId: string }, ctx: TrendlyContext) {
  const auth = authoriseOrder(args.orderId, ctx);
  if (!auth.ok) return authFailure(auth.code, args.orderId);
  const plan = refundPlanFor(auth.order.payment_method);
  return { ...plan, orderId: auth.order.order_id };
}

export function checkDelayCreditImpl(args: { orderId: string }, ctx: TrendlyContext) {
  const auth = authoriseOrder(args.orderId, ctx);
  if (!auth.ok) return authFailure(auth.code, args.orderId);
  const result = delayCreditFor(auth.order);
  return { ...result, orderId: auth.order.order_id };
}

/** §6.1: damaged/defective/incorrect items must be reported within 48 hours of delivery. */
const REPORT_WINDOW_HOURS = 48;
const MS_PER_HOUR = 3_600_000;

/**
 * Every order in the fixed dataset was delivered more than 48 hours before
 * any plausible TRENDLY_AS_OF clock value, so OUTSIDE_WINDOW is the honest,
 * expected answer against real data — this tool must not promise a
 * replacement or refund the policy does not authorise just because the item
 * genuinely arrived damaged.
 */
export function reportDamagedItemImpl(
  args: { orderId: string; sku: string }, ctx: TrendlyContext,
) {
  const auth = authoriseOrder(args.orderId, ctx);
  if (!auth.ok) return authFailure(auth.code, args.orderId);

  const item = auth.order.items.find((i) => i.sku === args.sku);
  if (!item) {
    return {
      code: 'SKU_NOT_IN_ORDER' as const,
      message: `Item ${args.sku} is not part of order ${args.orderId}.`,
    };
  }

  if (!auth.order.delivered_at) {
    return {
      code: 'OUTSIDE_WINDOW' as const,
      reason: 'This order has not been delivered yet, so a damage report cannot be filed '
        + 'against it.',
      clauses: ['6.1'],
    };
  }

  const deliveredAt = parseUtcDate(auth.order.delivered_at);
  const hoursSinceDelivery = Math.floor((now().getTime() - deliveredAt.getTime()) / MS_PER_HOUR);

  if (hoursSinceDelivery > REPORT_WINDOW_HOURS) {
    return {
      code: 'OUTSIDE_WINDOW' as const,
      hoursSinceDelivery,
      reason: `Delivered ${Math.floor(hoursSinceDelivery / 24)} day(s) ago. Damaged, `
        + 'defective, or incorrect items must be reported within 48 hours of delivery (§6.1).',
      clauses: ['6.1'],
    };
  }

  return {
    code: 'WITHIN_WINDOW' as const,
    hoursSinceDelivery,
    reason: 'Reported within the 48-hour window. Trendly ships a replacement at no cost, '
      + "or issues a full refund including shipping, at the customer's choice (§6.2). This "
      + 'applies even to non-returnable categories (§2.3) when the item arrives damaged or '
      + 'incorrect.',
    clauses: ['6.1', '6.2'],
  };
}
