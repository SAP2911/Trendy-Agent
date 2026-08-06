import { describe, it, expect } from 'vitest';
import { buildInstructions, PROMPT_VERSION } from '@/lib/agent/prompts';
import type { TrendlyContext } from '@/lib/agent/session';

const anon: TrendlyContext = {
  conversationId: 'c', correlationId: 'r',
  state: 'ANONYMOUS', verifiedCustomerId: null,
};

const verified: TrendlyContext = {
  conversationId: 'c', correlationId: 'r',
  state: 'VERIFIED', verifiedCustomerId: 'C-101',
};

describe('buildInstructions', () => {
  it('is versioned so PROMPTS.md can track iterations', () => {
    expect(PROMPT_VERSION).toMatch(/^v\d+$/);
  });

  it('embeds the clause index rather than the full policy text', () => {
    const p = buildInstructions(anon);
    expect(p).toContain('2.1');
    expect(p).not.toContain('Free reverse pickup is available');
  });

  it('states the current date so the model never guesses it', () => {
    process.env.TRENDLY_AS_OF = '2026-08-04T12:00:00Z';
    expect(buildInstructions(anon)).toContain('2026-08-04');
    delete process.env.TRENDLY_AS_OF;
  });

  it('tells an unverified session to verify first, and never claims an order exists', () => {
    const p = buildInstructions(anon);
    expect(p).toMatch(/verify_customer/);
    expect(p).toMatch(/NOT verified/);
  });

  it('tells a verified session it may use the order tools', () => {
    expect(buildInstructions(verified)).toMatch(/verified\. You may use the order tools/);
  });

  it('forbids discounts, coupons, waivers, and goodwill credits', () => {
    const p = buildInstructions(anon);
    expect(p).toMatch(/discount/i);
    expect(p).toMatch(/goodwill/i);
    expect(p).toMatch(/₹250/);
  });

  it('forbids collecting card, CVV, or bank details in chat', () => {
    expect(buildInstructions(anon)).toMatch(/CVV/);
  });

  it('forbids medical, legal, or financial advice', () => {
    expect(buildInstructions(anon)).toMatch(/medical, legal, or financial advice/);
  });

  it('instructs the assistant to acknowledge late or lost orders before quoting policy', () => {
    expect(buildInstructions(anon)).toMatch(/late or lost.*acknowledge/i);
  });

  it('stays under 2500 characters to respect free-tier TPM limits', () => {
    expect(buildInstructions(anon).length).toBeLessThan(2500);
    expect(buildInstructions(verified).length).toBeLessThan(2500);
  });
});
