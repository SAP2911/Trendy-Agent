import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import {
  initiateReturnImpl, initiateExchangeImpl, issueDelayCreditImpl, escalateToHumanImpl,
} from '@/lib/tools/mutating';
import { resetStore, getTicket, findItemExchange } from '@/lib/data/store';
import type { TrendlyContext } from '@/lib/agent/session';

const ORIGINAL_AS_OF = process.env.TRENDLY_AS_OF;

const ctx = (customerId: string): TrendlyContext => ({
  conversationId: 'c1', correlationId: 'r1',
  state: 'VERIFIED' as const, verifiedCustomerId: customerId,
});

beforeEach(() => {
  resetStore();
  process.env.TRENDLY_AS_OF = '2026-08-04T12:00:00Z';
});

afterAll(() => {
  if (ORIGINAL_AS_OF === undefined) delete process.env.TRENDLY_AS_OF;
  else process.env.TRENDLY_AS_OF = ORIGINAL_AS_OF;
});

describe('initiate_return re-verifies server-side', () => {
  it('creates an RMA for the eligible happy path', () => {
    const r = initiateReturnImpl(
      { orderId: 'TR-4530', sku: 'TR-KRT-033' }, ctx('C-101'));
    expect(r.code).toBe('RETURN_CREATED');
  });

  // The model must never be trusted to have checked. If a jailbreak talks it
  // into filing this return, the TOOL refuses.
  it('refuses the jewellery order even when instructed to proceed', () => {
    const r = initiateReturnImpl(
      { orderId: 'TR-4527', sku: 'TR-EAR-042' }, ctx('C-102'));
    expect(r.code).toBe('REFUSED_INELIGIBLE');
    expect(r.verdict?.code).toBe('INELIGIBLE_CATEGORY');
  });

  it('refuses the out-of-window order', () => {
    expect(initiateReturnImpl(
      { orderId: 'TR-4523', sku: 'TR-JKT-008' }, ctx('C-102')).code)
      .toBe('REFUSED_INELIGIBLE');
  });

  it('routes the lost parcel to escalation instead of creating an RMA', () => {
    const r = initiateReturnImpl(
      { orderId: 'TR-4526', sku: 'TR-BAG-011' }, ctx('C-101'));
    expect(r.code).toBe('MUST_ESCALATE');
  });

  it('is idempotent on retry', () => {
    const a = initiateReturnImpl({ orderId: 'TR-4530', sku: 'TR-KRT-033' }, ctx('C-101'));
    const b = initiateReturnImpl({ orderId: 'TR-4530', sku: 'TR-KRT-033' }, ctx('C-101'));
    expect(b.rmaId).toBe(a.rmaId);
    expect(b.alreadyExisted).toBe(true);
  });

  it('denies a return against another customer order', () => {
    expect(initiateReturnImpl(
      { orderId: 'TR-4530', sku: 'TR-KRT-033' }, ctx('C-100')).code)
      .toBe('ACCESS_DENIED');
  });

  it('denies when the session is not verified', () => {
    const anon: TrendlyContext = {
      conversationId: 'c1', correlationId: 'r1', state: 'ANONYMOUS', verifiedCustomerId: null,
    };
    expect(initiateReturnImpl({ orderId: 'TR-4530', sku: 'TR-KRT-033' }, anon).code)
      .toBe('NOT_VERIFIED');
  });

  it('refuses a sku that is not part of the order', () => {
    expect(initiateReturnImpl({ orderId: 'TR-4530', sku: 'NOPE' }, ctx('C-101')).code)
      .toBe('SKU_NOT_IN_ORDER');
  });

  it('cannot be tricked into refunding a cancelled order', () => {
    expect(initiateReturnImpl({ orderId: 'TR-4529', sku: 'TR-SCF-027' }, ctx('C-100')).code)
      .toBe('REFUSED_INELIGIBLE');
  });
});

describe('initiate_exchange re-verifies server-side', () => {
  it('creates an exchange for the eligible happy path', () => {
    const r = initiateExchangeImpl(
      { orderId: 'TR-4530', sku: 'TR-KRT-033', toSize: 'M' }, ctx('C-101'));
    expect(r.code).toBe('EXCHANGE_CREATED');
    expect(r.exchangeId).toMatch(/^EXC-/);
  });

  it('allows a size exchange on a final-sale item, per §2.4', () => {
    const r = initiateExchangeImpl(
      { orderId: 'TR-4528', sku: 'TR-SHR-009', toSize: 'L' }, ctx('C-103'));
    expect(r.code).toBe('EXCHANGE_CREATED');
  });

  it('refuses the jewellery order even when instructed to proceed', () => {
    const r = initiateExchangeImpl(
      { orderId: 'TR-4527', sku: 'TR-EAR-042', toSize: 'FS' }, ctx('C-102'));
    expect(r.code).toBe('REFUSED_INELIGIBLE');
    expect(r.verdict?.code).toBe('INELIGIBLE_CATEGORY');
  });

  it('refuses a same-size request instead of creating a no-op exchange', () => {
    const r = initiateExchangeImpl(
      { orderId: 'TR-4530', sku: 'TR-KRT-033', toSize: 'L' }, ctx('C-101'));
    expect(r.code).toBe('REFUSED_INELIGIBLE');
    expect(r.verdict?.code).toBe('SAME_SIZE_REQUESTED');
  });

  it('routes the lost parcel to escalation instead of creating an exchange', () => {
    const r = initiateExchangeImpl(
      { orderId: 'TR-4526', sku: 'TR-BAG-011', toSize: 'FS' }, ctx('C-101'));
    expect(r.code).toBe('MUST_ESCALATE');
  });

  it('refuses a sku that is not part of the order', () => {
    const r = initiateExchangeImpl(
      { orderId: 'TR-4530', sku: 'NOPE', toSize: 'M' }, ctx('C-101'));
    expect(r.code).toBe('SKU_NOT_IN_ORDER');
  });

  it('is idempotent on retry', () => {
    const a = initiateExchangeImpl(
      { orderId: 'TR-4530', sku: 'TR-KRT-033', toSize: 'M' }, ctx('C-101'));
    const b = initiateExchangeImpl(
      { orderId: 'TR-4530', sku: 'TR-KRT-033', toSize: 'M' }, ctx('C-101'));
    expect(b.exchangeId).toBe(a.exchangeId);
    expect(b.alreadyExisted).toBe(true);
  });

  it('denies an exchange against another customer order', () => {
    expect(initiateExchangeImpl(
      { orderId: 'TR-4530', sku: 'TR-KRT-033', toSize: 'M' }, ctx('C-100')).code)
      .toBe('ACCESS_DENIED');
  });

  it('denies when the session is not verified', () => {
    const anon: TrendlyContext = {
      conversationId: 'c1', correlationId: 'r1', state: 'ANONYMOUS', verifiedCustomerId: null,
    };
    expect(initiateExchangeImpl({ orderId: 'TR-4530', sku: 'TR-KRT-033', toSize: 'M' }, anon).code)
      .toBe('NOT_VERIFIED');
  });
});

describe('issue_delay_credit', () => {
  it('issues 250 for the genuinely delayed order', () => {
    const r = issueDelayCreditImpl({ orderId: 'TR-4525' }, ctx('C-103'));
    expect(r.code).toBe('CREDIT_ISSUED');
    expect(r.amountInr).toBe(250);
  });

  it('refuses for TR-4521, which is only 2 business days late', () => {
    expect(issueDelayCreditImpl({ orderId: 'TR-4521' }, ctx('C-100')).code)
      .toBe('REFUSED_NOT_OWED');
  });

  it('does not issue the credit twice', () => {
    const a = issueDelayCreditImpl({ orderId: 'TR-4525' }, ctx('C-103'));
    const b = issueDelayCreditImpl({ orderId: 'TR-4525' }, ctx('C-103'));
    expect(b.creditId).toBe(a.creditId);
    expect(b.alreadyExisted).toBe(true);
  });

  it('denies a credit against another customer order', () => {
    expect(issueDelayCreditImpl({ orderId: 'TR-4525' }, ctx('C-100')).code)
      .toBe('ACCESS_DENIED');
  });

  it('denies when the session is not verified', () => {
    const anon: TrendlyContext = {
      conversationId: 'c1', correlationId: 'r1', state: 'ANONYMOUS', verifiedCustomerId: null,
    };
    expect(issueDelayCreditImpl({ orderId: 'TR-4525' }, anon).code).toBe('NOT_VERIFIED');
  });

  it('refuses an already-delivered order (not applicable, not owed)', () => {
    const r = issueDelayCreditImpl({ orderId: 'TR-4530' }, ctx('C-101'));
    expect(r.code).toBe('REFUSED_NOT_OWED');
    expect(r.detail?.code).toBe('NOT_APPLICABLE');
  });
});

describe('escalate_to_human', () => {
  it('produces a ticket a person could actually use', () => {
    const r = escalateToHumanImpl({
      reasonCode: 'LOST_PARCEL_CLAIM',
      situation: 'Canvas Tote marked lost by Delhivery.',
      suggestedResolution: 'Offer replacement or full refund per §1.6.',
      orderIds: ['TR-4526'],
    }, ctx('C-101'));
    expect(r.code).toBe('ESCALATED');
    expect(r.ticketId).toMatch(/^TKT-/);
    if (r.code !== 'ESCALATED') throw new Error('expected ESCALATED'); // narrows r.ticketId

    const ticket = getTicket(r.ticketId);
    expect(ticket?.reasonCode).toBe('LOST_PARCEL_CLAIM');
    expect(ticket?.customerId).toBe('C-101');
    expect(ticket?.orderIds).toEqual(['TR-4526']);
    expect(ticket?.situation).toContain('Canvas Tote');
    // attempted/policyRefs default to [] rather than being required, so a
    // ticket can still be created before the model has anything to report.
    expect(ticket?.attempted).toEqual([]);
    expect(ticket?.policyRefs).toEqual([]);
  });

  it('captures what was tried and which clauses were cited, for the human agent', () => {
    const r = escalateToHumanImpl({
      reasonCode: 'LOST_PARCEL_CLAIM',
      situation: 'Canvas Tote marked lost by Delhivery.',
      suggestedResolution: 'Offer replacement or full refund per §1.6.',
      orderIds: ['TR-4526'],
      attempted: ['called check_return_eligibility: NOT_A_RETURN_LOST_PARCEL'],
      policyRefs: ['1.6'],
    }, ctx('C-101'));
    expect(r.code).toBe('ESCALATED');
    if (r.code !== 'ESCALATED') throw new Error('expected ESCALATED');

    const ticket = getTicket(r.ticketId);
    expect(ticket?.attempted).toEqual(['called check_return_eligibility: NOT_A_RETURN_LOST_PARCEL']);
    expect(ticket?.policyRefs).toEqual(['1.6']);
  });

  it('rejects an unknown reason code rather than inventing one', () => {
    const r = escalateToHumanImpl({
      reasonCode: 'MADE_UP', situation: 'x', suggestedResolution: 'y', orderIds: [],
    }, ctx('C-101'));
    expect(r.code).toBe('INVALID_REASON_CODE');
    expect(r.allowed).toContain('LOST_PARCEL_CLAIM');
    expect(r.allowed).not.toContain('MADE_UP');
  });

  it('can escalate an unverified (anonymous) session, e.g. failed identity checks', () => {
    const anon: TrendlyContext = {
      conversationId: 'c2', correlationId: 'r1', state: 'ANONYMOUS', verifiedCustomerId: null,
    };
    const r = escalateToHumanImpl({
      reasonCode: 'IDENTITY_VERIFICATION_FAILED',
      situation: 'Customer could not verify with any contact info on file.',
      suggestedResolution: 'Human agent verifies identity through an alternate channel.',
      orderIds: [],
    }, anon);
    expect(r.code).toBe('ESCALATED');
    if (r.code !== 'ESCALATED') throw new Error('expected ESCALATED'); // narrows r.ticketId
    expect(getTicket(r.ticketId)?.customerId).toBeNull();
  });
});

describe('§4.4 — one exchange per item, second needs human approval', () => {
  const diego = () => ctx('C-103');

  // The old key was (orderId, sku), which could not tell a retry from a genuine
  // second request: asking for a different size silently returned the FIRST
  // exchange's id and the approval requirement never fired.
  it('creates the first size exchange', () => {
    const r = initiateExchangeImpl(
      { orderId: 'TR-4528', sku: 'TR-SHR-009', toSize: 'L' }, diego());
    expect(r.code).toBe('EXCHANGE_CREATED');
  });

  it('treats the SAME size again as an idempotent retry, not a second exchange', () => {
    const a = initiateExchangeImpl({ orderId: 'TR-4528', sku: 'TR-SHR-009', toSize: 'L' }, diego());
    const b = initiateExchangeImpl({ orderId: 'TR-4528', sku: 'TR-SHR-009', toSize: 'L' }, diego());
    expect(b.code).toBe('EXCHANGE_CREATED');
    if (a.code === 'EXCHANGE_CREATED' && b.code === 'EXCHANGE_CREATED') {
      expect(b.exchangeId).toBe(a.exchangeId);
      expect(b.alreadyExisted).toBe(true);
    }
  });

  it('refuses a DIFFERENT size on the same item and cites 4.4', () => {
    initiateExchangeImpl({ orderId: 'TR-4528', sku: 'TR-SHR-009', toSize: 'L' }, diego());
    const second = initiateExchangeImpl(
      { orderId: 'TR-4528', sku: 'TR-SHR-009', toSize: 'XL' }, diego());
    expect(second.code).toBe('SECOND_EXCHANGE_NEEDS_APPROVAL');
    if (second.code === 'SECOND_EXCHANGE_NEEDS_APPROVAL') {
      expect(second.clauses).toContain('4.4');
      expect(second.requestedSize).toBe('XL');
    }
  });

  it('does not create a second exchange record when it refuses', () => {
    initiateExchangeImpl({ orderId: 'TR-4528', sku: 'TR-SHR-009', toSize: 'L' }, diego());
    const before = findItemExchange('TR-4528', 'TR-SHR-009');
    initiateExchangeImpl({ orderId: 'TR-4528', sku: 'TR-SHR-009', toSize: 'XL' }, diego());
    expect(findItemExchange('TR-4528', 'TR-SHR-009')?.exchangeId).toBe(before?.exchangeId);
  });
});
