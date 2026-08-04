import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('fixed dataset integrity', () => {
  it('loads 10 orders and 4 customers unmodified', () => {
    const raw = JSON.parse(readFileSync('orders.json', 'utf8'));
    expect(raw.orders).toHaveLength(10);
    expect(raw.customers).toHaveLength(4);
    expect(raw.orders.map((o: { order_id: string }) => o.order_id)).toEqual([
      'TR-4521', 'TR-4522', 'TR-4523', 'TR-4524', 'TR-4525',
      'TR-4526', 'TR-4527', 'TR-4528', 'TR-4529', 'TR-4530',
    ]);
  });

  it('loads the policy with all 7 sections present', () => {
    const md = readFileSync('trendly_policy.md', 'utf8');
    for (const heading of ['## 1. Shipping', '## 2. Returns', '## 3. Refunds',
      '## 4. Exchanges', '## 5. Return pickup', '## 6. Damaged or wrong items',
      '## 7. What the assistant must not do']) {
      expect(md).toContain(heading);
    }
  });
});
