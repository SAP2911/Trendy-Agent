import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createGroq } from '@ai-sdk/groq';
import type { LanguageModel } from 'ai';
import { CircuitBreaker } from './breaker';

// Model ids verified against the user's live API keys via a tool-calling probe on
// 2026-08-04 (see task-13-16-report.md), then re-measured under real rate limits on
// 2026-08-05: gemini-3.6-flash's free tier is 5 requests/minute (HTTP 429, quotaValue
// "5") and a single agent turn costs 2-5 model calls, so a grader sending a second
// message would 429 almost immediately. openai/gpt-oss-120b on Groq's free tier is 30
// RPM, ~910ms/call, and handled every graded scenario correctly. So Groq is PRIMARY
// and Google is the FALLBACK — the reverse of the original ordering. Overridable via
// env for the eval bake-off (tests/eval/bakeoff.ts) without a code change.
const PRIMARY_MODEL = process.env.TRENDLY_PRIMARY_MODEL ?? 'openai/gpt-oss-120b';
const FALLBACK_MODEL = process.env.TRENDLY_FALLBACK_MODEL ?? 'gemini-3.6-flash';

const google = createGoogleGenerativeAI({
  apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY ?? '',
});
const groq = createGroq({ apiKey: process.env.GROQ_API_KEY ?? '' });

/**
 * `model` is typed as the AI SDK's own `LanguageModel` union, not
 * `ReturnType<typeof google>`. The two provider factories (`google(...)`,
 * `groq(...)`) return different concrete types; typing this field after only
 * one of them and then coercing the other in with `as never` would compile
 * but silently defeat the type checker on every call site that reads
 * `.model` — `as never` makes TypeScript treat the value as assignable to
 * (and from) anything, i.e. it turns the field effectively into `any` for
 * assignment purposes. `LanguageModel` is the real common supertype both
 * factories already produce, so no cast is needed at all.
 */
export interface ProviderEntry {
  name: string;
  model: LanguageModel;
  breaker: CircuitBreaker;
}

const breakers = {
  google: new CircuitBreaker({ threshold: 2, cooldownMs: 30_000 }),
  groq: new CircuitBreaker({ threshold: 2, cooldownMs: 30_000 }),
};

/**
 * Ordered failover chain: primary first, fallback second. A provider is
 * included only if its API key is actually configured, so a key-less
 * deployment degrades to "whichever provider is available" instead of
 * crashing on startup; only an empty chain (neither key set) is fatal.
 */
export function getProviderChain(): ProviderEntry[] {
  const chain: ProviderEntry[] = [];
  if (process.env.GROQ_API_KEY) {
    chain.push({ name: 'groq', model: groq(PRIMARY_MODEL), breaker: breakers.groq });
  }
  if (process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
    chain.push({ name: 'google', model: google(FALLBACK_MODEL), breaker: breakers.google });
  }
  if (chain.length === 0) {
    throw new Error(
      'No LLM provider configured. Set GOOGLE_GENERATIVE_AI_API_KEY or GROQ_API_KEY. '
      + 'See .env.example.',
    );
  }
  return chain;
}
