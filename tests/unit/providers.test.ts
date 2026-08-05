import {
  describe, it, expect, afterEach,
} from 'vitest';
import { getProviderChain } from '@/lib/agent/providers';

/**
 * getProviderChain() re-reads process.env on every call (unlike the module-level
 * google()/groq() client factories, which are constructed once at import time), so
 * toggling the env vars between calls is enough to exercise its branches without
 * needing to reset the module registry.
 */
describe('getProviderChain', () => {
  const original = {
    google: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
    groq: process.env.GROQ_API_KEY,
  };

  afterEach(() => {
    if (original.google === undefined) delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    else process.env.GOOGLE_GENERATIVE_AI_API_KEY = original.google;
    if (original.groq === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = original.groq;
  });

  it('throws when neither provider is configured', () => {
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    delete process.env.GROQ_API_KEY;
    expect(() => getProviderChain()).toThrow(/No LLM provider configured/);
  });

  it('includes only google when only its key is set', () => {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'test-key';
    delete process.env.GROQ_API_KEY;
    const chain = getProviderChain();
    expect(chain.map((p) => p.name)).toEqual(['google']);
  });

  it('includes only groq when only its key is set', () => {
    delete process.env.GOOGLE_GENERATIVE_AI_API_KEY;
    process.env.GROQ_API_KEY = 'test-key';
    const chain = getProviderChain();
    expect(chain.map((p) => p.name)).toEqual(['groq']);
  });

  it('orders groq before google when both keys are set, each with a closed breaker', () => {
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = 'test-key';
    process.env.GROQ_API_KEY = 'test-key';
    const chain = getProviderChain();
    expect(chain.map((p) => p.name)).toEqual(['groq', 'google']);
    expect(chain.every((p) => p.breaker.state === 'closed')).toBe(true);
  });
});
