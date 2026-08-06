import type { Order, OrderItem } from '@/lib/data/orders';
import type { ClauseId } from './clauses';
import { now, parseUtcDate, startOfUtcDay } from './clock';
import { calendarDaysBetween, addCalendarDays } from './business-days';
import { refundPlanFor, type RefundPlan } from './refunds';

export type VerdictCode =
  | 'ELIGIBLE_REFUND' | 'ELIGIBLE_WITH_CONDITION' | 'EXCHANGE_ONLY_FINAL_SALE'
  | 'INELIGIBLE_WINDOW' | 'INELIGIBLE_CATEGORY' | 'NOT_A_RETURN_LOST_PARCEL'
  | 'NOT_APPLICABLE_CANCELLED' | 'NOT_YET_DELIVERED';

export interface ItemVerdict {
  sku: string; name: string; code: VerdictCode; reason: string;
  clauses: ClauseId[]; mustEscalate?: boolean;
  windowClosedOn?: string; deductionInr?: number; refund?: RefundPlan;
}

export interface OrderEligibility {
  orderId: string; evaluatedAt: string; items: ItemVerdict[];
}

/** §2.1: "within 30 calendar days of the delivery date". Day 30 is still valid. */
const RETURN_WINDOW_DAYS = 30;

/** §2.3, verbatim. */
const NON_RETURNABLE_CATEGORIES = new Set([
  'innerwear', 'jewellery', 'jewelry', 'beauty', 'fragrance',
  'face_mask', 'face_masks', 'gift_card', 'gift_cards',
]);

/**
 * §2.3 names "Innerwear and socks" explicitly. Category is the primary signal,
 * but a sock miscategorised as apparel must still be refused, so the item name
 * is a fallback check.
 */
function isNonReturnable(item: OrderItem): boolean {
  if (NON_RETURNABLE_CATEGORIES.has(item.category.toLowerCase())) return true;
  return /\bsocks?\b/i.test(item.name);
}

function verdictForItem(order: Order, item: OrderItem, today: Date): ItemVerdict {
  const base = { sku: item.sku, name: item.name };

  // Precedence matters and is itself tested. §1.6 routes lost parcels away from
  // the return flow entirely, before any window or category logic runs.
  if (order.status === 'lost_in_transit') {
    return {
      ...base, code: 'NOT_A_RETURN_LOST_PARCEL', mustEscalate: true,
      reason: 'The carrier marked this parcel lost. Policy §1.6 treats this as a '
        + 'lost-parcel claim handled by a human agent, not as a return.',
      clauses: ['1.6'],
    };
  }

  if (order.status === 'cancelled') {
    return {
      ...base, code: 'NOT_APPLICABLE_CANCELLED',
      reason: 'This order was cancelled, so no return can be raised against it.',
      clauses: ['2.6'],
    };
  }

  if (!order.delivered_at) {
    return {
      ...base, code: 'NOT_YET_DELIVERED',
      reason: 'The return window is counted from delivery, and this order has not '
        + 'been delivered yet.',
      clauses: ['2.1'],
    };
  }

  const deliveredAt = parseUtcDate(order.delivered_at);
  const daysSince = calendarDaysBetween(deliveredAt, today);

  // §2.1 is absolute: "not eligible under any circumstance" after 30 days.
  // It therefore outranks the category and final-sale checks below.
  if (daysSince > RETURN_WINDOW_DAYS) {
    return {
      ...base, code: 'INELIGIBLE_WINDOW',
      windowClosedOn: addCalendarDays(deliveredAt, RETURN_WINDOW_DAYS)
        .toISOString().slice(0, 10),
      reason: `Delivered ${daysSince} days ago. The 30-day return window has closed.`,
      clauses: ['2.1'],
    };
  }

  // Deliberately NOT citing 2.1 here: TR-4527 is inside the window and must be
  // refused on hygiene grounds alone. Citing the window would misstate why.
  if (isNonReturnable(item)) {
    return {
      ...base, code: 'INELIGIBLE_CATEGORY',
      reason: `${item.name} falls under a non-returnable category (${item.category}) `
        + 'for hygiene and safety reasons.',
      clauses: ['2.3'],
    };
  }

  if (item.final_sale) {
    return {
      ...base, code: 'EXCHANGE_ONLY_FINAL_SALE',
      reason: 'This item is marked final sale, so it is eligible for a size exchange '
        + 'only — no refund and no store credit.',
      clauses: ['2.4'],
    };
  }

  if (item.category.toLowerCase() === 'footwear') {
    return {
      ...base, code: 'ELIGIBLE_WITH_CONDITION', deductionInr: 300,
      reason: 'Footwear is returnable, but must be sent back in its original shoe box. '
        + 'Returns without the box incur a ₹300 deduction.',
      clauses: ['2.1', '2.5'], refund: refundPlanFor(order.payment_method),
    };
  }

  return {
    ...base, code: 'ELIGIBLE_REFUND',
    reason: `Delivered ${daysSince} days ago, inside the 30-day window, and in a `
      + 'returnable category.',
    clauses: ['2.1'], refund: refundPlanFor(order.payment_method),
  };
}

/**
 * Evaluate every item in an order independently.
 *
 * Per-SKU is mandatory, not a refinement: TR-4522 contains a returnable tee and
 * non-returnable socks in one order. Order-level eligibility gets it wrong.
 */
export function checkReturnEligibility(order: Order): OrderEligibility {
  const today = startOfUtcDay(now());
  return {
    orderId: order.order_id,
    evaluatedAt: today.toISOString().slice(0, 10),
    items: order.items.map((item) => verdictForItem(order, item, today)),
  };
}

export type ExchangeCode =
  | 'EXCHANGE_ALLOWED' | 'SKU_NOT_IN_ORDER' | 'SAME_SIZE_REQUESTED'
  | 'INELIGIBLE_CATEGORY' | 'INELIGIBLE_WINDOW' | 'NOT_YET_DELIVERED'
  | 'NOT_APPLICABLE_CANCELLED' | 'NOT_A_RETURN_LOST_PARCEL';

export interface ExchangeVerdict {
  code: ExchangeCode; reason: string; clauses: ClauseId[];
  sku?: string; fromSize?: string; toSize?: string;
}

/**
 * §4.1: size exchanges only — never colour or style. §4.2: same 30-day window.
 */
export function checkExchangeEligibility(
  order: Order, sku: string, requestedSize: string,
): ExchangeVerdict {
  const item = order.items.find((i) => i.sku === sku);
  if (!item) {
    return {
      code: 'SKU_NOT_IN_ORDER',
      reason: `Item ${sku} is not part of order ${order.order_id}.`, clauses: [],
    };
  }

  const returnVerdict = verdictForItem(order, item, startOfUtcDay(now()));

  // Final sale blocks refunds but explicitly permits size exchange (§2.4),
  // so it is the one return-blocking verdict that does not block an exchange.
  const blocking: VerdictCode[] = [
    'NOT_A_RETURN_LOST_PARCEL', 'NOT_APPLICABLE_CANCELLED',
    'NOT_YET_DELIVERED', 'INELIGIBLE_WINDOW', 'INELIGIBLE_CATEGORY',
  ];
  if (blocking.includes(returnVerdict.code)) {
    return {
      code: returnVerdict.code as ExchangeCode,
      reason: returnVerdict.reason, clauses: returnVerdict.clauses, sku,
    };
  }

  if (item.size.toLowerCase() === requestedSize.trim().toLowerCase()) {
    return {
      code: 'SAME_SIZE_REQUESTED', sku, fromSize: item.size, toSize: requestedSize,
      reason: 'Trendly offers size exchanges only. To change colour or style, the item '
        + 'is returned and a new order placed.',
      clauses: ['4.1'],
    };
  }

  return {
    code: 'EXCHANGE_ALLOWED', sku, fromSize: item.size, toSize: requestedSize,
    reason: `A size exchange from ${item.size} to ${requestedSize} is available.`,
    clauses: ['4.1', '4.2'],
  };
}
