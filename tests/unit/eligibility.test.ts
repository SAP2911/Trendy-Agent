import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { checkReturnEligibility, checkExchangeEligibility } from '@/lib/policy/eligibility';
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

const codesFor = (id: string) =>
  checkReturnEligibility(getOrder(id)!).items.map((v) => v.code);

describe('checkReturnEligibility — the fixed dataset', () => {
  it('TR-4530 is the happy path: eligible refund', () => {
    const v = checkReturnEligibility(getOrder('TR-4530')!).items[0]!;
    expect(v.code).toBe('ELIGIBLE_REFUND');
    expect(v.clauses).toContain('2.1');
    expect(v.refund?.code).toBe('MAPPED');
  });

  it('TR-4523 is refused on window grounds, with the closing date', () => {
    const v = checkReturnEligibility(getOrder('TR-4523')!).items[0]!;
    expect(v.code).toBe('INELIGIBLE_WINDOW');
    expect(v.windowClosedOn).toBe('2026-07-05');
  });

  // Trap: must be refused on CATEGORY grounds, not date. It is within the window.
  it('TR-4527 is refused on category grounds despite being in window', () => {
    const v = checkReturnEligibility(getOrder('TR-4527')!).items[0]!;
    expect(v.code).toBe('INELIGIBLE_CATEGORY');
    expect(v.clauses).toContain('2.3');
    expect(v.clauses).not.toContain('2.1');
  });

  it('TR-4528 is exchange-only because it is final sale', () => {
    const v = checkReturnEligibility(getOrder('TR-4528')!).items[0]!;
    expect(v.code).toBe('EXCHANGE_ONLY_FINAL_SALE');
    expect(v.clauses).toContain('2.4');
  });

  it('TR-4526 is a lost-parcel claim that must escalate, not a return', () => {
    const v = checkReturnEligibility(getOrder('TR-4526')!).items[0]!;
    expect(v.code).toBe('NOT_A_RETURN_LOST_PARCEL');
    expect(v.mustEscalate).toBe(true);
    expect(v.clauses).toContain('1.6');
  });

  it('TR-4529 cannot have a return raised against it', () => {
    expect(codesFor('TR-4529')).toEqual(['NOT_APPLICABLE_CANCELLED']);
  });

  it.each(['TR-4521', 'TR-4524', 'TR-4525'])(
    '%s is not delivered yet, so the window has not opened', (id) => {
      expect(new Set(codesFor(id))).toEqual(new Set(['NOT_YET_DELIVERED']));
    });

  // Trap B: one order, two different verdicts. Order-level logic fails here.
  it('TR-4522 splits per SKU: tee eligible, socks refused as innerwear', () => {
    const items = checkReturnEligibility(getOrder('TR-4522')!).items;
    expect(items).toHaveLength(2);
    const tee = items.find((i) => i.sku === 'TR-TSH-002')!;
    const socks = items.find((i) => i.sku === 'TR-SOK-031')!;
    expect(tee.code).toBe('ELIGIBLE_REFUND');
    expect(socks.code).toBe('INELIGIBLE_CATEGORY');
    expect(socks.clauses).toContain('2.3');
  });

  it('stamps the evaluation date so reasoning is auditable', () => {
    expect(checkReturnEligibility(getOrder('TR-4530')!).evaluatedAt)
      .toBe('2026-08-04');
  });

  // Footwear (§2.5) is not reachable via the real dataset — every footwear
  // order (TR-4525) is undelivered. Exercised here with a synthetic fixture
  // built from a real delivered order shape, since customers ask "what if I
  // lost the shoe box?" regardless of what their own order history contains.
  it('footwear is eligible with a ₹300 deduction condition (synthetic fixture)', () => {
    const base = getOrder('TR-4530')!;
    const footwearOrder: Order = {
      ...base,
      order_id: 'TEST-FOOTWEAR-1',
      items: [{
        sku: 'TR-SHO-999', name: 'Test Running Shoe', category: 'footwear',
        size: '9', qty: 1, price: 2999, final_sale: false,
      }],
    };
    const v = checkReturnEligibility(footwearOrder).items[0]!;
    expect(v.code).toBe('ELIGIBLE_WITH_CONDITION');
    expect(v.deductionInr).toBe(300);
    expect(v.clauses).toContain('2.5');
    expect(v.refund?.code).toBe('MAPPED');
  });
});

describe('checkExchangeEligibility', () => {
  it('allows a size exchange on a final-sale item (§2.4)', () => {
    const v = checkExchangeEligibility(getOrder('TR-4528')!, 'TR-SHR-009', 'L');
    expect(v.code).toBe('EXCHANGE_ALLOWED');
  });

  it('refuses an exchange on a non-returnable category', () => {
    const v = checkExchangeEligibility(getOrder('TR-4527')!, 'TR-EAR-042', 'FS');
    expect(v.code).toBe('INELIGIBLE_CATEGORY');
  });

  it('refuses a same-size exchange, since only size exchanges exist (§4.1)', () => {
    const v = checkExchangeEligibility(getOrder('TR-4528')!, 'TR-SHR-009', 'M');
    expect(v.code).toBe('SAME_SIZE_REQUESTED');
    expect(v.clauses).toContain('4.1');
  });

  it('refuses an exchange on an unknown sku', () => {
    expect(checkExchangeEligibility(getOrder('TR-4530')!, 'NOPE', 'S').code)
      .toBe('SKU_NOT_IN_ORDER');
  });
});
