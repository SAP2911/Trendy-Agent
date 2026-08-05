import type { ClauseId } from './clauses';

export type RefundPlan =
  | {
      code: 'MAPPED'; destination: string; timeframe: string;
      clauses: ClauseId[]; requiresHumanForBankDetails: boolean;
    }
  | { code: 'UNMAPPED_PAYMENT_METHOD'; paymentMethod: string; clauses: ClauseId[] };

/** Verbatim from §3.1. Exactly four methods are enumerated — no more. */
const TABLE: Record<string, Omit<Extract<RefundPlan, { code: 'MAPPED' }>, 'code'>> = {
  credit_card: {
    destination: 'the original card', timeframe: '5–7 business days',
    clauses: ['3.1'], requiresHumanForBankDetails: false,
  },
  debit_card: {
    destination: 'the original card', timeframe: '5–7 business days',
    clauses: ['3.1'], requiresHumanForBankDetails: false,
  },
  upi: {
    destination: 'the original UPI ID', timeframe: '3–5 business days',
    clauses: ['3.1'], requiresHumanForBankDetails: false,
  },
  cash_on_delivery: {
    destination: 'bank transfer or store credit', timeframe: '7–10 business days',
    clauses: ['3.1', '3.3'], requiresHumanForBankDetails: true,
  },
  store_credit: {
    destination: 'store credit', timeframe: 'immediately',
    clauses: ['3.1'], requiresHumanForBankDetails: false,
  },
};

/**
 * Map a payment method to its §3.1 refund row.
 *
 * Returns UNMAPPED_PAYMENT_METHOD for anything the table does not enumerate —
 * notably `prepaid_card`, used by TR-4521. A prepaid card is neither a credit
 * nor a debit card, and §7 forbids inventing policy where the document is
 * silent. The agent must say so and offer a human.
 */
export function refundPlanFor(method: string): RefundPlan {
  const row = TABLE[method];
  if (!row) {
    return { code: 'UNMAPPED_PAYMENT_METHOD', paymentMethod: method, clauses: ['3.1'] };
  }
  return { code: 'MAPPED', ...row };
}
