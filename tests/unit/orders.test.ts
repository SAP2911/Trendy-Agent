import { describe, it, expect } from 'vitest';
import {
  getOrder, getCustomer, findCustomerByContact, getOrdersForCustomer, allOrders,
} from '@/lib/data/orders';

describe('order loader', () => {
  it('strips the _note_for_designers hint fields', () => {
    const order = getOrder('TR-4523');
    expect(order).toBeDefined();
    expect(order as unknown as Record<string, unknown>)
      .not.toHaveProperty('_note_for_designers');
  });

  it('returns undefined for unknown orders rather than throwing', () => {
    expect(getOrder('TR-9999')).toBeUndefined();
  });

  it('matches customers by email case-insensitively', () => {
    expect(findCustomerByContact('ANANYA.RAO@example.com')?.customer_id).toBe('C-100');
  });

  it('matches customers by phone ignoring spaces, dashes and parentheses', () => {
    expect(findCustomerByContact('+91 98765 10001')?.customer_id).toBe('C-100');
    expect(findCustomerByContact('+919876510001')?.customer_id).toBe('C-100');
  });

  it('returns undefined for an unknown contact', () => {
    expect(findCustomerByContact('nobody@example.com')).toBeUndefined();
  });

  it('groups orders by customer', () => {
    expect(getOrdersForCustomer('C-100').map((o) => o.order_id))
      .toEqual(['TR-4521', 'TR-4524', 'TR-4529']);
  });

  it('exposes the partial-shipment item flags on TR-4524', () => {
    const items = getOrder('TR-4524')!.items;
    expect(items.find((i) => i.sku === 'TR-JNS-021')?.shipped).toBe(true);
    expect(items.find((i) => i.sku === 'TR-BLT-005')?.backorder_eta).toBe('2026-08-09');
  });

  it('looks up a customer by id', () => {
    expect(getCustomer('C-100')?.name).toBe('Ananya Rao');
  });

  it('returns undefined for an unknown customer id', () => {
    expect(getCustomer('C-999')).toBeUndefined();
  });

  it('exposes the full order list', () => {
    const orders = allOrders();
    expect(orders).toHaveLength(10);
    expect(orders.map((o) => o.order_id)).toContain('TR-4521');
  });
});
