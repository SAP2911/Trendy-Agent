import { describe, it, expect, beforeEach } from 'vitest';
import {
  createReturn, createExchange, issueCredit, createTicket, getTicket, resetStore,
} from '@/lib/data/store';

beforeEach(() => { resetStore(); });

describe('idempotent store', () => {
  it('creates an RMA once and returns the same id on retry', () => {
    const a = createReturn({ orderId: 'TR-4530', sku: 'TR-KRT-033', resolution: 'refund' });
    const b = createReturn({ orderId: 'TR-4530', sku: 'TR-KRT-033', resolution: 'refund' });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.rmaId).toBe(a.rmaId);
  });

  it('treats a different sku in the same order as a distinct return', () => {
    const a = createReturn({ orderId: 'TR-4522', sku: 'TR-TSH-002', resolution: 'refund' });
    const b = createReturn({ orderId: 'TR-4522', sku: 'TR-SOK-031', resolution: 'refund' });
    expect(b.rmaId).not.toBe(a.rmaId);
  });

  it('issues the delay credit once per order', () => {
    const a = issueCredit('TR-4525', 250);
    const b = issueCredit('TR-4525', 250);
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.creditId).toBe(a.creditId);
  });

  it('creates an exchange once and returns the same id on retry', () => {
    const a = createExchange({ orderId: 'TR-4530', sku: 'TR-KRT-033', fromSize: 'L', toSize: 'M' });
    const b = createExchange({ orderId: 'TR-4530', sku: 'TR-KRT-033', fromSize: 'L', toSize: 'M' });
    expect(a.created).toBe(true);
    expect(b.created).toBe(false);
    expect(b.exchangeId).toBe(a.exchangeId);
    expect(a.exchangeId).toMatch(/^EXC-/);
  });

  it('treats a different order as a distinct credit even at the same amount', () => {
    const a = issueCredit('TR-4525', 250);
    const b = issueCredit('TR-4521', 250);
    expect(b.creditId).not.toBe(a.creditId);
  });

  it('mints ids from a shared, monotonically increasing counter', () => {
    const a = createReturn({ orderId: 'TR-4530', sku: 'TR-KRT-033', resolution: 'refund' });
    const b = createExchange({ orderId: 'TR-4522', sku: 'TR-TSH-002', fromSize: 'L', toSize: 'M' });
    expect(a.rmaId).toBe('RMA-00001');
    expect(b.exchangeId).toBe('EXC-00002');
  });

  it('creates a ticket and makes it retrievable', () => {
    const { ticketId } = createTicket({
      reasonCode: 'CUSTOMER_REQUESTED_HUMAN',
      conversationId: 'c1',
      correlationId: 'r1',
      customerId: 'C-100',
      orderIds: ['TR-4521'],
      situation: 'Customer wants a human.',
      attempted: [],
      policyRefs: [],
      suggestedResolution: 'Route to a human agent.',
    });
    expect(ticketId).toMatch(/^TKT-/);
    expect(getTicket(ticketId)?.reasonCode).toBe('CUSTOMER_REQUESTED_HUMAN');
    expect(getTicket(ticketId)?.customerId).toBe('C-100');
  });

  it('returns undefined for an unknown ticket id', () => {
    expect(getTicket('TKT-99999')).toBeUndefined();
  });

  it('resets the counter along with all maps', () => {
    createReturn({ orderId: 'TR-4530', sku: 'TR-KRT-033', resolution: 'refund' });
    resetStore();
    const a = createReturn({ orderId: 'TR-4530', sku: 'TR-KRT-033', resolution: 'refund' });
    expect(a.rmaId).toBe('RMA-00001');
  });
});
