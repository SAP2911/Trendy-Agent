import { getOrder, type Order } from '@/lib/data/orders';
import { checkReturnEligibility, checkExchangeEligibility } from '@/lib/policy/eligibility';
import { delayCreditFor } from '@/lib/policy/delay';
import {
  createReturn, createExchange, issueCredit, createTicket,
} from '@/lib/data/store';
import type { TrendlyContext } from '@/lib/agent/session';
import { escalateSession } from '@/lib/agent/session';

const REASON_CODES = new Set([
  'LOST_PARCEL_CLAIM', 'COD_REFUND_BANK_DETAILS', 'POLICY_NOT_COVERED',
  'SECOND_EXCHANGE_REQUEST', 'DAMAGED_ITEM_OUTSIDE_WINDOW',
  'IDENTITY_VERIFICATION_FAILED', 'OUT_OF_SCOPE_ADVICE',
  'CUSTOMER_REQUESTED_HUMAN', 'VALIDATOR_REPAIR_FAILED',
  'UNMAPPED_PAYMENT_METHOD',
]);

type AuthResult =
  | { ok: true; order: Order }
  | { ok: false; code: 'NOT_VERIFIED' | 'ACCESS_DENIED' };

/**
 * Same identity gate as lib/tools/impl.ts's authoriseOrder, re-implemented
 * (not imported) so this module stays independently testable and does not
 * take on a cross-file dependency for a five-line check. The invariant is
 * identical either way: a missing order and someone else's order refuse
 * with the same code.
 */
function authorise(orderId: string, ctx: TrendlyContext): AuthResult {
  if (!ctx.verifiedCustomerId) return { ok: false, code: 'NOT_VERIFIED' };
  const order = getOrder(orderId);
  if (!order || order.customer_id !== ctx.verifiedCustomerId) {
    return { ok: false, code: 'ACCESS_DENIED' };
  }
  return { ok: true, order };
}

/**
 * File a return. Eligibility is re-computed here rather than trusted from the
 * conversation: the model may have been persuaded, confused, or injected
 * into over the course of the chat. This tool is the last line of defence
 * and it does not take the model's word for what is eligible — if a
 * jailbreak talks the model into filing a return against the jewellery
 * order TR-4527, this function refuses regardless of what the model
 * believes or claims.
 */
export function initiateReturnImpl(
  args: { orderId: string; sku: string }, ctx: TrendlyContext,
) {
  const auth = authorise(args.orderId, ctx);
  if (!auth.ok) return { code: auth.code };

  const verdict = checkReturnEligibility(auth.order).items
    .find((v) => v.sku === args.sku);
  if (!verdict) return { code: 'SKU_NOT_IN_ORDER' as const };

  if (verdict.mustEscalate) {
    return { code: 'MUST_ESCALATE' as const, verdict };
  }
  if (verdict.code !== 'ELIGIBLE_REFUND' && verdict.code !== 'ELIGIBLE_WITH_CONDITION') {
    return { code: 'REFUSED_INELIGIBLE' as const, verdict };
  }

  const { rmaId, created } = createReturn({
    orderId: args.orderId, sku: args.sku, resolution: 'refund',
  });
  return {
    code: 'RETURN_CREATED' as const, rmaId, alreadyExisted: !created, verdict,
  };
}

/**
 * File a size exchange. Mirrors initiateReturnImpl exactly: eligibility is
 * re-derived from checkExchangeEligibility server-side, never trusted from
 * what the model believes the customer is owed. Idempotent on
 * (orderId, sku) — a retried identical request returns the same
 * exchangeId with alreadyExisted: true instead of minting a second one.
 */
export function initiateExchangeImpl(
  args: { orderId: string; sku: string; toSize: string }, ctx: TrendlyContext,
) {
  const auth = authorise(args.orderId, ctx);
  if (!auth.ok) return { code: auth.code };

  const verdict = checkExchangeEligibility(auth.order, args.sku, args.toSize);

  if (verdict.code === 'SKU_NOT_IN_ORDER') {
    return { code: 'SKU_NOT_IN_ORDER' as const, verdict };
  }
  // §1.6: a lost parcel is never actioned by this tool, exchange or return —
  // it is routed to a human, exactly as initiateReturnImpl does.
  if (verdict.code === 'NOT_A_RETURN_LOST_PARCEL') {
    return { code: 'MUST_ESCALATE' as const, verdict };
  }
  if (verdict.code !== 'EXCHANGE_ALLOWED') {
    return { code: 'REFUSED_INELIGIBLE' as const, verdict };
  }

  // verdict.code === 'EXCHANGE_ALLOWED' guarantees checkExchangeEligibility
  // found this sku in the order (the SKU_NOT_IN_ORDER branch above is the
  // only path where it would not), so the item is structurally present.
  const item = auth.order.items.find((i) => i.sku === args.sku)!;
  const { exchangeId, created } = createExchange({
    orderId: args.orderId, sku: args.sku, fromSize: item.size, toSize: args.toSize,
  });
  return {
    code: 'EXCHANGE_CREATED' as const, exchangeId, alreadyExisted: !created, verdict,
  };
}

/**
 * Issue the §1.5 delivery-delay credit. Recomputes lateness itself so a
 * customer (or an injected prompt) insisting an order is "very late" cannot
 * talk the model into issuing ₹250 for TR-4521, which is genuinely only 2
 * business days past its expected delivery date.
 */
export function issueDelayCreditImpl(
  args: { orderId: string }, ctx: TrendlyContext,
) {
  const auth = authorise(args.orderId, ctx);
  if (!auth.ok) return { code: auth.code };

  const result = delayCreditFor(auth.order);
  if (result.code !== 'OWED') {
    return { code: 'REFUSED_NOT_OWED' as const, detail: result };
  }

  const { creditId, created } = issueCredit(args.orderId, result.amountInr);
  return {
    code: 'CREDIT_ISSUED' as const, creditId, amountInr: result.amountInr,
    alreadyExisted: !created, clauses: result.clauses,
  };
}

/**
 * Hand off to a human agent. reasonCode is validated against a fixed set —
 * the model cannot invent a reason, which matters because several of these
 * codes exist precisely to stop the model from doing something itself
 * (COD_REFUND_BANK_DETAILS: §3.3 forbids collecting bank details in chat;
 * UNMAPPED_PAYMENT_METHOD: §7 forbids inventing policy where the document
 * is silent).
 *
 * `attempted` and `policyRefs` are optional model-supplied context (what
 * tools/checks already ran, which clauses were cited) so the resulting
 * ticket is something a human who has never seen this conversation can act
 * on immediately, not just a bare situation string. Omitted fields default
 * to an empty array rather than being required — escalation must still
 * succeed even when the model has nothing to report yet (e.g. an
 * identity-verification failure before any order tool was ever called).
 */
export function escalateToHumanImpl(
  args: {
    reasonCode: string; situation: string;
    suggestedResolution: string; orderIds: string[];
    // `| undefined` alongside `?:` because the AI SDK's zod-inferred call
    // site (lib/tools/index.ts) can pass the key present-but-undefined;
    // exactOptionalPropertyTypes treats that as a distinct type from a
    // merely-absent key, so both must be accepted here.
    attempted?: string[] | undefined; policyRefs?: string[] | undefined;
  },
  ctx: TrendlyContext,
) {
  if (!REASON_CODES.has(args.reasonCode)) {
    return {
      code: 'INVALID_REASON_CODE' as const,
      allowed: [...REASON_CODES],
    };
  }
  const { ticketId } = createTicket({
    reasonCode: args.reasonCode,
    conversationId: ctx.conversationId, correlationId: ctx.correlationId,
    customerId: ctx.verifiedCustomerId, orderIds: args.orderIds,
    situation: args.situation,
    attempted: args.attempted ?? [],
    policyRefs: args.policyRefs ?? [],
    suggestedResolution: args.suggestedResolution,
  });
  escalateSession(ctx.conversationId);
  return {
    code: 'ESCALATED' as const, ticketId,
    message: 'A human agent will pick this up. Trendly support hours are '
      + '9:00 AM – 9:00 PM IST, seven days a week.',
  };
}
