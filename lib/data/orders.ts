import { readFileSync } from 'node:fs';
import path from 'node:path';

export type OrderStatus =
  | 'in_transit' | 'delivered' | 'partially_shipped'
  | 'delayed' | 'lost_in_transit' | 'cancelled';

export type PaymentMethod =
  | 'prepaid_card' | 'credit_card' | 'cash_on_delivery' | 'upi';

export interface OrderItem {
  sku: string; name: string; category: string; size: string;
  qty: number; price: number; final_sale: boolean;
  shipped?: boolean; backorder_eta?: string;
}

export interface Order {
  order_id: string; customer_id: string; status: OrderStatus;
  placed_at: string; delivered_at: string | null;
  expected_delivery: string | null;
  carrier: string | null; tracking_number: string | null;
  payment_method: PaymentMethod; shipping_city: string;
  items: OrderItem[]; total: number;
  cancelled_at?: string; refund_status?: string;
}

export interface Customer {
  customer_id: string; name: string; email: string; phone: string;
}

/** Digits only, so "+91-98765-10001" and "+91 98765 10001" compare equal. */
function normalisePhone(value: string): string {
  return value.replace(/\D/g, '');
}

interface RawDataset { customers: Customer[]; orders: Order[] }

function load(): RawDataset {
  // Read at root — the dataset must not be moved. See Global Constraints.
  const raw = readFileSync(path.join(process.cwd(), 'orders.json'), 'utf8');
  const parsed = JSON.parse(raw) as RawDataset & Record<string, unknown>;

  // Strip the designer hint fields. They are answer keys, not order data, and
  // must never reach the model — it would read the answer instead of deriving it.
  const orders = parsed.orders.map((order) => {
    const clean: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(order)) {
      if (!k.startsWith('_')) clean[k] = v;
    }
    return clean as unknown as Order;
  });

  return { customers: parsed.customers, orders };
}

const dataset = load();

export function getOrder(orderId: string): Order | undefined {
  return dataset.orders.find((o) => o.order_id === orderId.trim().toUpperCase());
}

export function getCustomer(customerId: string): Customer | undefined {
  return dataset.customers.find((c) => c.customer_id === customerId);
}

export function findCustomerByContact(contact: string): Customer | undefined {
  const trimmed = contact.trim();
  const asEmail = trimmed.toLowerCase();
  const asPhone = normalisePhone(trimmed);
  return dataset.customers.find(
    (c) =>
      c.email.toLowerCase() === asEmail ||
      (asPhone.length >= 7 && normalisePhone(c.phone) === asPhone),
  );
}

export function getOrdersForCustomer(customerId: string): Order[] {
  return dataset.orders.filter((o) => o.customer_id === customerId);
}

export function allOrders(): readonly Order[] {
  return dataset.orders;
}
