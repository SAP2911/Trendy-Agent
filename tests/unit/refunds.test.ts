import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { refundPlanFor } from '@/lib/policy/refunds';
import { delayCreditFor } from '@/lib/policy/delay';
import { getOrder } from '@/lib/data/orders';
import type { Order } from '@/lib/data/orders';

const ORIGINAL_AS_OF = process.env.TRENDLY_AS_OF;

beforeAll(() => {
  process.env.TRENDLY_AS_OF = '2026-08-04T12:00:00Z';
});

afterAll(() => {
  if (ORIGINAL_AS_OF === undefined) delete process.env.TRENDLY_AS_OF;
  else process.env.TRENDLY_AS_OF = ORIGINAL_AS_OF;
});

describe('refundPlanFor', () => {
  it('maps credit_card to 5-7 business days on the original card', () => {
    const plan = refundPlanFor('credit_card');
    expect(plan.code).toBe('MAPPED');
    if (plan.code === 'MAPPED') {
      expect(plan.timeframe).toBe('5–7 business days');
      expect(plan.requiresHumanForBankDetails).toBe(false);
    }
  });

  it('maps upi to 3-5 business days', () => {
    const plan = refundPlanFor('upi');
    if (plan.code === 'MAPPED') expect(plan.timeframe).toBe('3–5 business days');
  });

  it('flags cash_on_delivery as requiring a human for bank details (§3.3)', () => {
    const plan = refundPlanFor('cash_on_delivery');
    expect(plan.code).toBe('MAPPED');
    if (plan.code === 'MAPPED') {
      expect(plan.requiresHumanForBankDetails).toBe(true);
      expect(plan.clauses).toContain('3.3');
    }
  });

  // Trap C: prepaid_card appears in the dataset (TR-4521) but NOT in the §3.1
  // table. Mapping it to "card" would be inventing policy, which §7 forbids.
  it('refuses to guess for prepaid_card, which §3.1 does not enumerate', () => {
    expect(refundPlanFor('prepaid_card').code).toBe('UNMAPPED_PAYMENT_METHOD');
  });

  it('refuses to guess for any unknown method', () => {
    expect(refundPlanFor('crypto').code).toBe('UNMAPPED_PAYMENT_METHOD');
  });

  // Not present in any dataset order, but §3.1 enumerates it and customers
  // ask about it regardless of what their own order history contains.
  it('maps store_credit to an immediate refund', () => {
    const plan = refundPlanFor('store_credit');
    expect(plan.code).toBe('MAPPED');
    if (plan.code === 'MAPPED') {
      expect(plan.destination).toBe('store credit');
      expect(plan.timeframe).toBe('immediately');
      expect(plan.requiresHumanForBankDetails).toBe(false);
    }
  });

  it('maps debit_card the same as credit_card', () => {
    const plan = refundPlanFor('debit_card');
    expect(plan.code).toBe('MAPPED');
    if (plan.code === 'MAPPED') expect(plan.timeframe).toBe('5–7 business days');
  });
});

describe('delayCreditFor', () => {
  // Trap A: only 2 business days past expected, so NOT owed despite being
  // 4 calendar days late.
  it('does NOT owe credit for TR-4521 (2 business days past expected)', () => {
    const result = delayCreditFor(getOrder('TR-4521')!);
    expect(result.code).toBe('NOT_OWED');
    if (result.code === 'NOT_OWED') expect(result.businessDaysLate).toBe(2);
  });

  it('does NOT owe credit for TR-4524 (2 business days past expected)', () => {
    expect(delayCreditFor(getOrder('TR-4524')!).code).toBe('NOT_OWED');
  });

  it('owes 250 for TR-4525 (14 business days past expected)', () => {
    const result = delayCreditFor(getOrder('TR-4525')!);
    expect(result.code).toBe('OWED');
    if (result.code === 'OWED') {
      expect(result.amountInr).toBe(250);
      expect(result.businessDaysLate).toBe(14);
      expect(result.clauses).toContain('1.5');
    }
  });

  it('is not applicable to a delivered order', () => {
    expect(delayCreditFor(getOrder('TR-4530')!).code).toBe('NOT_APPLICABLE');
  });

  it('is not applicable to a cancelled order with no expected date', () => {
    expect(delayCreditFor(getOrder('TR-4529')!).code).toBe('NOT_APPLICABLE');
  });

  // No order in the fixed dataset is both non-cancelled/non-delivered AND
  // missing an expected_delivery date, so this defensive branch is otherwise
  // unreachable via real data. Exercised with a synthetic fixture, same
  // rationale as the footwear/store_credit cases in eligibility.test.ts.
  it('is not applicable when an in-transit order has no expected delivery date', () => {
    const base = getOrder('TR-4521')!;
    const order: Order = { ...base, order_id: 'TEST-NO-EXPECTED-1', expected_delivery: null };
    const result = delayCreditFor(order);
    expect(result.code).toBe('NOT_APPLICABLE');
    if (result.code === 'NOT_APPLICABLE') {
      expect(result.reason).toBe('The order has no expected delivery date.');
    }
  });
});

describe('NOT_OWED carries the policy figures it is refusing on', () => {
  // Without these the agent cannot explain the refusal without inventing
  // numbers, and the numeric-grounding validator then blocks a correct answer.
  it('exposes the ₹250 amount and the 3-business-day threshold', () => {
    const r = delayCreditFor(getOrder('TR-4521')!);
    expect(r.code).toBe('NOT_OWED');
    if (r.code === 'NOT_OWED') {
      expect(r.wouldBeAmountInr).toBe(250);
      expect(r.thresholdBusinessDays).toBe(3);
    }
  });
});
