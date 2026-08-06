import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// These files are supplied fixed by an external evaluation harness and must
// NEVER be edited. The order-ID and policy-heading checks below only catch
// additions/removals — an in-place edit to a field value (an order total, a
// customer's email, policy body text under an unchanged heading) would sail
// straight through them. These digests close that hole: they were computed
// ONCE from the untouched files (via `readFileSync(path)` with no encoding,
// i.e. raw bytes — matching .gitattributes' `-text` so line endings never
// shift the hash) and hardcoded here. If this assertion ever fails, someone
// has modified orders.json or trendly_policy.md — revert the change, do not
// update the digest.
const EXPECTED_ORDERS_JSON_SHA256 =
  'df5ba2593e6f4f3e3bedbadee66f6b45bb086a4d3c988e53c1f584a3745b324a';
const EXPECTED_POLICY_MD_SHA256 =
  '26940d1c3bb6bc2c554504abe64099928da291fbfdb69e4d035cf4a48ef590e7';

function sha256(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

describe('fixed dataset integrity', () => {
  it('has not been modified from the evaluation harness originals (SHA-256)', () => {
    expect(sha256('orders.json')).toBe(EXPECTED_ORDERS_JSON_SHA256);
    expect(sha256('trendly_policy.md')).toBe(EXPECTED_POLICY_MD_SHA256);
  });

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
