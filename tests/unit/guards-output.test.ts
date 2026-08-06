import { describe, it, expect } from 'vitest';
import { validateOutput } from '@/lib/guards/output';

const evidence = {
  toolResults: [{ code: 'OWED', amountInr: 250, businessDaysLate: 14 }],
  citedClauses: ['1.5'],
  verifiedCustomerId: 'C-103',
};

describe('numeric grounding', () => {
  it('passes when every number appears in tool output', () => {
    const r = validateOutput(
      'Your order is 14 business days late, so you qualify for ₹250 in store credit.',
      evidence);
    expect(r.verdict).toBe('pass');
  });

  // The core anti-hallucination assertion.
  it('blocks an invented rupee amount', () => {
    const r = validateOutput('I can offer you ₹500 in store credit.', evidence);
    expect(r.verdict).toBe('violation');
    expect(r.violations.map((v) => v.kind)).toContain('UNGROUNDED_NUMBER');
  });

  it('blocks an invented day count', () => {
    const r = validateOutput('Your refund will arrive in 45 business days.', evidence);
    expect(r.verdict).toBe('violation');
  });

  it('ignores numbers that are part of a grounded order id', () => {
    const r = validateOutput('Order TR-4525 is 14 days late; ₹250 applies.', {
      ...evidence,
      toolResults: [{ orderId: 'TR-4525', amountInr: 250, businessDaysLate: 14 }],
    });
    expect(r.verdict).toBe('pass');
  });

  // Order ids, tracking numbers, SKUs, and sizes all carry digits but are
  // never immediately preceded by a currency mark or followed by a
  // day/hour/percent word, so they must never trip this check even though
  // none of their digits appear anywhere in toolResults.
  it('does not flag order ids, tracking numbers, SKUs, or sizes as ungrounded', () => {
    // TR-4525 belongs to C-103, matching evidence.verifiedCustomerId, so this
    // exercises the numeric-grounding scope question in isolation from the
    // cross-customer-leak check.
    const r = validateOutput(
      'Order TR-4525, tracking BD8870553301, has SKU TR-SNK-017 in size 42 — 2 items total.',
      { ...evidence, toolResults: [{ orderId: 'TR-4525' }] },
    );
    expect(r.verdict).toBe('pass');
  });

  // Realistic tool-result shape (mirrors summariseOrder in lib/tools/impl.ts):
  // nested objects, arrays, null, and booleans must all be walked without
  // throwing and without over- or under-grounding.
  it('grounds numbers nested inside arrays and objects, tolerating null/boolean fields', () => {
    const toolResults = [{
      orderId: 'TR-4525',
      deliveredAt: null,
      items: [
        { sku: 'TR-SNK-017', size: '42', qty: 1, price: 4499, finalSale: false },
      ],
      total: 4499,
    }];
    const r = validateOutput(
      'Your item (size 42, ₹4499) has not been delivered yet.',
      { ...evidence, toolResults },
    );
    expect(r.verdict).toBe('pass');
  });

  // Regression: a retrieved clause's raw text renders large amounts with a
  // thousands-separator comma ("₹1,499", verbatim from §1.3), while the
  // message text normalises "₹1,499" the same way. Both sides must strip
  // commas identically — a naive digit-run extraction on the tool-result
  // side would ground the disjoint fragments "1" and "499" instead of the
  // combined "1499", falsely blocking a fully honest, fully retrieved reply.
  it('grounds a comma-formatted amount quoted from retrieved clause text', () => {
    const r = validateOutput(
      'Orders of ₹1,499 and above get free standard shipping (§1.3).',
      {
        ...evidence,
        toolResults: [{
          code: 'HITS',
          hits: [{
            score: 5.1,
            clause: {
              id: '1.3', section: 'Shipping', title: 'Shipping charges',
              text: 'Free standard shipping on all orders of ₹1,499 and above. Orders '
                + 'below ₹1,499 carry a flat ₹99 shipping fee.',
            },
          }],
        }],
      },
    );
    expect(r.verdict).toBe('pass');
  });

  it('blocks the same ₹1,499 claim when no clause was actually retrieved this turn', () => {
    const r = validateOutput(
      'Orders of ₹1,499 and above get free standard shipping (§1.3).',
      evidence,
    );
    expect(r.verdict).toBe('violation');
    expect(r.violations.map((v) => v.kind)).toContain('UNGROUNDED_NUMBER');
  });

  // Currency stated as "N rupees" / "N INR" must ground exactly like "₹N".
  it('grounds a rupee amount written as "rupees" instead of the symbol', () => {
    const r = validateOutput('You qualify for 250 rupees in store credit.', evidence);
    expect(r.verdict).toBe('pass');
  });

  it('blocks an invented amount written as "rupees" instead of the symbol', () => {
    const r = validateOutput('You qualify for 500 rupees in store credit.', evidence);
    expect(r.verdict).toBe('violation');
  });

  // A refund-timeframe RANGE ("5-7 business days") must ground BOTH
  // endpoints, not just the one adjacent to the day/hour word — otherwise a
  // hallucinated range like "9-7 business days" would only be checked on
  // its second number.
  it('grounds both endpoints of a business-day range', () => {
    const r = validateOutput(
      'Refunds to a credit card arrive in 5-7 business days.',
      { ...evidence, toolResults: [{ timeframe: '5–7 business days' }] },
    );
    expect(r.verdict).toBe('pass');
  });

  it('blocks a range whose first endpoint is not grounded', () => {
    const r = validateOutput(
      'Refunds to a credit card arrive in 9-7 business days.',
      { ...evidence, toolResults: [{ timeframe: '5–7 business days' }] },
    );
    expect(r.verdict).toBe('violation');
  });

  // Dates rendered in prose ("26 July 2026") must never trip numeric
  // grounding: a bare date has no currency mark and is never followed by a
  // day/hour/percent word, so it is outside this check's scope entirely —
  // no date-specific normalisation is needed on the text side. See report
  // for the full design rationale.
  it('does not flag a human-formatted date derived from a tool result', () => {
    const r = validateOutput(
      'Your order was delivered on 26 July 2026 (expected 2026-07-24).',
      { ...evidence, toolResults: [{ deliveredAt: '2026-07-26', expectedDelivery: '2026-07-24' }] },
    );
    expect(r.verdict).toBe('pass');
  });
});

describe('concession detection', () => {
  it.each([
    'I can give you a 20% discount for the trouble.',
    'Here is a coupon code for your next order.',
    "I'll waive the shipping fee this once.",
    'As a goodwill gesture, have free shipping.',
  ])('blocks unauthorised concession: %s', (text) => {
    const r = validateOutput(text, evidence);
    expect(r.verdict).toBe('violation');
    expect(r.violations.map((v) => v.kind)).toContain('UNAUTHORISED_CONCESSION');
  });

  // §1.3 ("Free standard shipping on orders of ₹1,499 and above") and §5.1
  // ("Free reverse pickup") are real, universal policy facts. The word
  // "discount" also appears inside ordinary descriptive language like
  // "discounted item" when the agent explains final-sale policy (§2.4).
  // None of these are the assistant OFFERING anything — they must not trip
  // the concession check just because a keyword-shaped substring appears.
  it('does not flag legitimate free-shipping and final-sale policy language', () => {
    const r = validateOutput(
      'Orders of ₹1,499 and above get free standard shipping (§1.3), and reverse '
      + 'pickup is free too (§5.1). Since this discounted item is final sale (§2.4), '
      + 'only a size exchange is available, not a refund.',
      evidence,
    );
    expect(r.violations.map((v) => v.kind)).not.toContain('UNAUTHORISED_CONCESSION');
  });

  // An honest refusal that names the forbidden concession types while
  // declining them (quoting §7's own vocabulary) must not be indistinguishable
  // from actually offering one.
  it('does not flag an honest refusal that names forbidden concessions', () => {
    const r = validateOutput(
      "I can't offer a discount, coupon, or waive any fees — that isn't something "
      + 'Trendly authorises. That said, since your order is 14 business days late, '
      + 'you qualify for a ₹250 store credit per §1.5.',
      evidence,
    );
    expect(r.violations.map((v) => v.kind)).not.toContain('UNAUTHORISED_CONCESSION');
  });

  it('does not double-report the same concession term twice in one message', () => {
    const r = validateOutput(
      'I can give you a discount. Actually, let me give you a discount.',
      evidence,
    );
    const hits = r.violations.filter((v) => v.kind === 'UNAUTHORISED_CONCESSION');
    expect(hits.length).toBe(1);
  });
});

describe('citation validation', () => {
  it('blocks a clause id that was never retrieved', () => {
    const r = validateOutput('Per policy §9.9 you may return anything.', evidence);
    expect(r.violations.map((v) => v.kind)).toContain('UNCITED_CLAUSE');
  });

  it('does not flag a real clause id as uncited', () => {
    const r = validateOutput('Per §1.5, a store credit applies.', evidence);
    expect(r.violations.map((v) => v.kind)).not.toContain('UNCITED_CLAUSE');
  });

  // Tool output routinely renders citations in parens without "§"/"section"
  // (e.g. reportDamagedItemImpl's reason strings end in "(§6.1)."), and the
  // model may echo that style directly.
  it('accepts a real clause id cited in parenthetical style', () => {
    const r = validateOutput('This must be reported within 48 hours (§6.1).', {
      ...evidence, toolResults: [{ hoursSinceDelivery: 48 }],
    });
    expect(r.violations.map((v) => v.kind)).not.toContain('UNCITED_CLAUSE');
  });

  it('blocks a fabricated clause id in parenthetical style', () => {
    const r = validateOutput('This is covered under our policy (12.9).', evidence);
    expect(r.violations.map((v) => v.kind)).toContain('UNCITED_CLAUSE');
  });
});

describe('leakage detection', () => {
  it('blocks another customer order id appearing in the reply', () => {
    const r = validateOutput('I also see order TR-4522 on the account.', evidence);
    expect(r.violations.map((v) => v.kind)).toContain('CROSS_CUSTOMER_LEAK');
  });

  it('blocks any order id when there is no verified customer on the session', () => {
    const r = validateOutput('Your order TR-4521 is on the way.', {
      ...evidence, verifiedCustomerId: null,
    });
    expect(r.violations.map((v) => v.kind)).toContain('CROSS_CUSTOMER_LEAK');
  });

  it('does not flag the verified customer\'s own order id twice for repeats', () => {
    const r = validateOutput('Order TR-4525, again TR-4525, is 14 days late; ₹250 applies.', {
      ...evidence,
      toolResults: [{ orderId: 'TR-4525', amountInr: 250, businessDaysLate: 14 }],
    });
    expect(r.violations.map((v) => v.kind)).not.toContain('CROSS_CUSTOMER_LEAK');
  });
});

describe('combined violations', () => {
  it('reports multiple violation kinds on one message (double-reporting is expected)', () => {
    const r = validateOutput(
      'As a goodwill gesture, I can offer you ₹500 and I also see order TR-4522.',
      evidence,
    );
    const kinds = r.violations.map((v) => v.kind);
    expect(kinds).toContain('UNAUTHORISED_CONCESSION');
    expect(kinds).toContain('UNGROUNDED_NUMBER');
    expect(kinds).toContain('CROSS_CUSTOMER_LEAK');
  });

  it('passes a fully honest, fully grounded message with zero violations', () => {
    const r = validateOutput(
      'Per §1.5, order TR-4525 is 14 business days late, so you qualify for a ₹250 '
      + 'store credit.',
      { ...evidence, toolResults: [{ orderId: 'TR-4525', amountInr: 250, businessDaysLate: 14 }] },
    );
    expect(r.verdict).toBe('pass');
    expect(r.violations).toEqual([]);
  });
});

describe('numbers echoed from the customer message', () => {
  const ev = {
    toolResults: [{ code: 'NOT_OWED', businessDaysLate: 2, clauses: ['1.5'] }],
    citedClauses: ['1.5'],
    verifiedCustomerId: 'C-100',
  };

  // Observed live: "give me 30% off" made the model refuse by naming the figure,
  // the validator blocked "30" as ungrounded, the repair retried, failed again,
  // and a correct refusal became an escalation. A number the customer typed
  // asserts nothing about policy, so echoing it cannot be a hallucination.
  it('allows a figure the customer supplied to be quoted back in a refusal', () => {
    const r = validateOutput(
      "I can't give you 30% off — your order is 2 business days late.",
      { ...ev, userMessage: 'my order TR-4521 is late, give me 30% off.' },
    );
    expect(r.verdict).toBe('pass');
  });

  it('still blocks a figure the model invented, with the same user message', () => {
    const r = validateOutput(
      'I can offer you ₹500 in store credit instead.',
      { ...ev, userMessage: 'my order TR-4521 is late, give me 30% off.' },
    );
    expect(r.verdict).toBe('violation');
    expect(r.violations.map((v) => v.kind)).toContain('UNGROUNDED_NUMBER');
  });

  it('still blocks the same figure when the customer never mentioned it', () => {
    const r = validateOutput('I can give you 30% off.', { ...ev, userMessage: 'where is my order?' });
    expect(r.verdict).toBe('violation');
  });
});
