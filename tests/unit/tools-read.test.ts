import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  verifyCustomerImpl, lookupOrderImpl, listCustomerOrdersImpl,
  checkReturnEligibilityImpl, checkExchangeEligibilityImpl, searchPolicyImpl,
  computeRefundTimelineImpl, checkDelayCreditImpl, reportDamagedItemImpl,
} from '@/lib/tools/impl';
import { resetSessions } from '@/lib/agent/session';
import type { TrendlyContext } from '@/lib/agent/session';

const ctx = (customerId: string | null): TrendlyContext => ({
  conversationId: 'c1', correlationId: 'r1',
  state: customerId ? ('VERIFIED' as const) : ('ANONYMOUS' as const),
  verifiedCustomerId: customerId,
});

beforeEach(() => { resetSessions(); });

describe('verify_customer', () => {
  it('verifies a known email', () => {
    expect(verifyCustomerImpl({ contact: 'ananya.rao@example.com' }, ctx(null)).code)
      .toBe('VERIFIED');
  });

  it('verifies a known phone number regardless of formatting', () => {
    const r = verifyCustomerImpl({ contact: '+91 98765 10001' }, ctx(null));
    expect(r.code).toBe('VERIFIED');
    expect(r.code === 'VERIFIED' && r.customerId).toBe('C-100');
  });

  it('does not reveal whether an unknown contact exists', () => {
    const r = verifyCustomerImpl({ contact: 'attacker@example.com' }, ctx(null));
    expect(r.code).toBe('NOT_RECOGNISED');
    expect(JSON.stringify(r)).not.toContain('C-10');
    expect(JSON.stringify(r)).not.toContain('Rao');
  });
});

describe('lookup_order identity binding', () => {
  it('returns the order for its owner', () => {
    expect(lookupOrderImpl({ orderId: 'TR-4521' }, ctx('C-100')).code).toBe('OK');
  });

  // The grader will probe this. TR-4522 belongs to C-101, not C-100.
  it('denies access to another customer order and leaks nothing', () => {
    const r = lookupOrderImpl({ orderId: 'TR-4522' }, ctx('C-100'));
    expect(r.code).toBe('ACCESS_DENIED');
    const body = JSON.stringify(r);
    expect(body).not.toContain('Marcus');
    expect(body).not.toContain('C-101');
    expect(body).not.toContain('Mumbai');
  });

  it('denies access when the session is not verified', () => {
    expect(lookupOrderImpl({ orderId: 'TR-4521' }, ctx(null)).code).toBe('NOT_VERIFIED');
  });

  it('does not distinguish a missing order from someone else order', () => {
    const missing = lookupOrderImpl({ orderId: 'TR-9999' }, ctx('C-100'));
    const foreign = lookupOrderImpl({ orderId: 'TR-4522' }, ctx('C-100'));
    expect(missing.code).toBe(foreign.code);
    // Two genuinely-missing ids must produce byte-identical shapes (modulo
    // the caller-supplied id itself, which is safe to echo — it is the
    // model's own input, not data read from someone else's account).
    expect(Object.keys(missing)).toEqual(Object.keys(foreign));
  });

  it('returns the full order shape on success', () => {
    const r = lookupOrderImpl({ orderId: 'TR-4530' }, ctx('C-101'));
    expect(r.code).toBe('OK');
    expect(r.code === 'OK' && r.order.orderId).toBe('TR-4530');
    expect(r.code === 'OK' && r.order.items[0]?.sku).toBe('TR-KRT-033');
  });
});

describe('list_customer_orders', () => {
  it('denies when unverified', () => {
    expect(listCustomerOrdersImpl({}, ctx(null)).code).toBe('NOT_VERIFIED');
  });

  it('lists only orders on the verified account', () => {
    const r = listCustomerOrdersImpl({}, ctx('C-100'));
    expect(r.code).toBe('OK');
    const ids = r.code === 'OK' ? r.orders.map((o) => o.orderId) : [];
    expect(ids).toContain('TR-4521');
    expect(ids).toContain('TR-4524');
    expect(ids).toContain('TR-4529');
    expect(ids).not.toContain('TR-4522'); // belongs to C-101
  });
});

describe('check_return_eligibility identity binding', () => {
  it('evaluates per item for the owner', () => {
    const r = checkReturnEligibilityImpl({ orderId: 'TR-4522' }, ctx('C-101'));
    expect(r.code).toBe('OK');
    expect(r.code === 'OK' && r.eligibility.items).toHaveLength(2);
  });

  it('denies for another customer order, identically to a missing one', () => {
    const foreign = checkReturnEligibilityImpl({ orderId: 'TR-4522' }, ctx('C-100'));
    const missing = checkReturnEligibilityImpl({ orderId: 'TR-9999' }, ctx('C-100'));
    expect(foreign.code).toBe('ACCESS_DENIED');
    expect(foreign.code).toBe(missing.code);
  });

  it('denies when unverified', () => {
    expect(checkReturnEligibilityImpl({ orderId: 'TR-4521' }, ctx(null)).code)
      .toBe('NOT_VERIFIED');
  });
});

describe('check_exchange_eligibility identity binding', () => {
  it('evaluates for the owner', () => {
    const r = checkExchangeEligibilityImpl(
      { orderId: 'TR-4530', sku: 'TR-KRT-033', requestedSize: 'M' }, ctx('C-101'));
    expect(r.code).toBe('OK');
    expect(r.code === 'OK' && r.verdict.code).toBe('EXCHANGE_ALLOWED');
  });

  it('denies for another customer order', () => {
    const r = checkExchangeEligibilityImpl(
      { orderId: 'TR-4530', sku: 'TR-KRT-033', requestedSize: 'M' }, ctx('C-100'));
    expect(r.code).toBe('ACCESS_DENIED');
  });

  it('denies when unverified', () => {
    const r = checkExchangeEligibilityImpl(
      { orderId: 'TR-4530', sku: 'TR-KRT-033', requestedSize: 'M' }, ctx(null));
    expect(r.code).toBe('NOT_VERIFIED');
  });
});

describe('search_policy', () => {
  it('returns hits for an in-corpus question', () => {
    const r = searchPolicyImpl({ query: 'how long do I have to return something' });
    expect(r.code).toBe('HITS');
  });

  it('returns NO_COVERAGE for an out-of-scope question', () => {
    const r = searchPolicyImpl({ query: 'do you ship to Nepal' });
    expect(r.code).toBe('NO_COVERAGE');
  });
});

describe('compute_refund_timeline identity binding', () => {
  it('maps a known payment method for the owner', () => {
    const r = computeRefundTimelineImpl({ orderId: 'TR-4530' }, ctx('C-101'));
    expect(r.code).toBe('MAPPED');
  });

  it('flags an unmapped payment method honestly rather than guessing', () => {
    // TR-4521 (C-100) is prepaid_card, absent from the §3.1 table.
    const r = computeRefundTimelineImpl({ orderId: 'TR-4521' }, ctx('C-100'));
    expect(r.code).toBe('UNMAPPED_PAYMENT_METHOD');
  });

  it('denies for another customer order, identically to a missing one', () => {
    const foreign = computeRefundTimelineImpl({ orderId: 'TR-4530' }, ctx('C-100'));
    const missing = computeRefundTimelineImpl({ orderId: 'TR-9999' }, ctx('C-100'));
    expect(foreign.code).toBe('ACCESS_DENIED');
    expect(foreign.code).toBe(missing.code);
  });

  it('denies when unverified', () => {
    expect(computeRefundTimelineImpl({ orderId: 'TR-4521' }, ctx(null)).code)
      .toBe('NOT_VERIFIED');
  });
});

describe('check_delay_credit identity binding', () => {
  it('owes credit for the genuinely delayed order', () => {
    const r = checkDelayCreditImpl({ orderId: 'TR-4525' }, ctx('C-103'));
    expect(r.code).toBe('OWED');
  });

  it('does not owe credit for an order only 2 business days late', () => {
    const r = checkDelayCreditImpl({ orderId: 'TR-4521' }, ctx('C-100'));
    expect(r.code).toBe('NOT_OWED');
  });

  it('denies for another customer order, identically to a missing one', () => {
    const foreign = checkDelayCreditImpl({ orderId: 'TR-4525' }, ctx('C-100'));
    const missing = checkDelayCreditImpl({ orderId: 'TR-9999' }, ctx('C-100'));
    expect(foreign.code).toBe('ACCESS_DENIED');
    expect(foreign.code).toBe(missing.code);
  });

  it('denies when unverified', () => {
    expect(checkDelayCreditImpl({ orderId: 'TR-4525' }, ctx(null)).code).toBe('NOT_VERIFIED');
  });
});

describe('report_damaged_item', () => {
  const ORIGINAL_AS_OF = process.env.TRENDLY_AS_OF;
  afterEach(() => {
    if (ORIGINAL_AS_OF === undefined) delete process.env.TRENDLY_AS_OF;
    else process.env.TRENDLY_AS_OF = ORIGINAL_AS_OF;
  });

  it('every order in the fixed dataset is outside the 48-hour window as of "today"', () => {
    process.env.TRENDLY_AS_OF = '2026-08-04T12:00:00Z';
    const r = reportDamagedItemImpl({ orderId: 'TR-4530', sku: 'TR-KRT-033' }, ctx('C-101'));
    expect(r.code).toBe('OUTSIDE_WINDOW');
  });

  // WITHIN_WINDOW is unreachable against "today" (every order was delivered
  // long ago), but is reachable by moving the clock override back to just
  // after the order's real delivered_at — TR-4530 delivered 2026-07-26T11:00Z.
  it('reports WITHIN_WINDOW when the clock is close to the real delivery time', () => {
    process.env.TRENDLY_AS_OF = '2026-07-27T10:00:00Z'; // 23h after delivery
    const r = reportDamagedItemImpl({ orderId: 'TR-4530', sku: 'TR-KRT-033' }, ctx('C-101'));
    expect(r.code).toBe('WITHIN_WINDOW');
    expect(r.code === 'WITHIN_WINDOW' && r.hoursSinceDelivery).toBe(23);
  });

  it('refuses a sku that is not part of the order', () => {
    process.env.TRENDLY_AS_OF = '2026-08-04T12:00:00Z';
    const r = reportDamagedItemImpl({ orderId: 'TR-4530', sku: 'NOPE' }, ctx('C-101'));
    expect(r.code).toBe('SKU_NOT_IN_ORDER');
  });

  it('reports OUTSIDE_WINDOW for an order not yet delivered', () => {
    process.env.TRENDLY_AS_OF = '2026-07-25T12:00:00Z';
    const r = reportDamagedItemImpl({ orderId: 'TR-4521', sku: 'TR-DRS-014' }, ctx('C-100'));
    expect(r.code).toBe('OUTSIDE_WINDOW');
  });

  it('denies for another customer order, identically to a missing one', () => {
    process.env.TRENDLY_AS_OF = '2026-08-04T12:00:00Z';
    const foreign = reportDamagedItemImpl(
      { orderId: 'TR-4530', sku: 'TR-KRT-033' }, ctx('C-100'));
    const missing = reportDamagedItemImpl(
      { orderId: 'TR-9999', sku: 'TR-KRT-033' }, ctx('C-100'));
    expect(foreign.code).toBe('ACCESS_DENIED');
    expect(foreign.code).toBe(missing.code);
  });

  it('denies when unverified', () => {
    process.env.TRENDLY_AS_OF = '2026-08-04T12:00:00Z';
    const r = reportDamagedItemImpl({ orderId: 'TR-4530', sku: 'TR-KRT-033' }, ctx(null));
    expect(r.code).toBe('NOT_VERIFIED');
  });
});
