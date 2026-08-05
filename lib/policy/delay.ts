import type { Order } from '@/lib/data/orders';
import type { ClauseId } from './clauses';
import { now, parseUtcDate } from './clock';
import { businessDaysBetween } from './business-days';

export type DelayCreditResult =
  | { code: 'OWED'; amountInr: 250; businessDaysLate: number; clauses: ClauseId[] }
  | { code: 'NOT_OWED'; businessDaysLate: number; clauses: ClauseId[] }
  | { code: 'NOT_APPLICABLE'; reason: string; clauses: ClauseId[] };

/** §1.5: "more than 3 business days past its expected delivery date". */
const THRESHOLD_BUSINESS_DAYS = 3;
const CREDIT_INR = 250 as const;

export function delayCreditFor(order: Order): DelayCreditResult {
  if (order.status === 'delivered') {
    return {
      code: 'NOT_APPLICABLE',
      reason: 'The order has already been delivered.', clauses: ['1.5'],
    };
  }
  if (order.status === 'cancelled') {
    return {
      code: 'NOT_APPLICABLE',
      reason: 'The order was cancelled.', clauses: ['1.5', '2.6'],
    };
  }
  if (!order.expected_delivery) {
    return {
      code: 'NOT_APPLICABLE',
      reason: 'The order has no expected delivery date.', clauses: ['1.5'],
    };
  }

  const late = businessDaysBetween(parseUtcDate(order.expected_delivery), now());

  // Strictly "more than 3" — 3 business days exactly does not qualify.
  return late > THRESHOLD_BUSINESS_DAYS
    ? { code: 'OWED', amountInr: CREDIT_INR, businessDaysLate: late, clauses: ['1.5'] }
    : { code: 'NOT_OWED', businessDaysLate: late, clauses: ['1.5'] };
}
