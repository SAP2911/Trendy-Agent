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

  // ~3.1k chars is roughly 780 tokens. Groq's free tier allows 8K TPM and the 13
  // tool schemas take the larger share, so this is comfortable rather than tight.
  // The ceiling moved from 2500 in v2 to buy an explicit scope boundary — the
  // agent previously answered general-knowledge questions, which is a brand risk
  // and a jailbreak wedge. Verified end to end against the live provider.
  it('stays under 3500 characters to respect free-tier TPM limits', () => {
    expect(buildInstructions(anon).length).toBeLessThan(3500);
    expect(buildInstructions(verified).length).toBeLessThan(3500);
  });
});

describe('scope boundary', () => {
  // The agent answered "what is 2+2" and "who is <public figure>" before v2.
  // A retailer's support bot doing homework or discussing politics is a brand
  // risk and a jailbreak wedge, and "refuse what it shouldn't do" is graded.
  it('states the remit and names the off-topic categories', () => {
    const p = buildInstructions(anon);
    expect(p).toMatch(/SCOPE/);
    expect(p).toMatch(/NOT a general assistant/i);
    for (const topic of ['politics', 'trivia', 'maths', 'homework']) {
      expect(p.toLowerCase()).toContain(topic);
    }
  });

  it('gives a concrete refusal line rather than only a prohibition', () => {
    expect(buildInstructions(anon)).toMatch(/I can only help with Trendly orders/);
  });

  it('still permits greetings so the bot is not hostile to normal openers', () => {
    expect(buildInstructions(anon)).toMatch(/greetings/i);
  });
});
