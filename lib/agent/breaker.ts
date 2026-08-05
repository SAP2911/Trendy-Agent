export interface BreakerOptions {
  threshold: number; cooldownMs: number; now?: () => number;
}

/**
 * Free-tier providers rate-limit hard and without warning. Retrying into a 429
 * wastes the daily quota that the eval run needs. The breaker fails fast and
 * lets the loop fail over to the secondary provider instead.
 */
export class CircuitBreaker {
  #failures = 0;
  #openedAt: number | null = null;
  #halfOpen = false;
  readonly #opts: Required<BreakerOptions>;

  constructor(opts: BreakerOptions) {
    this.#opts = { now: () => Date.now(), ...opts };
  }

  get state(): 'closed' | 'open' | 'half-open' {
    if (this.#openedAt === null) return 'closed';
    if (this.#halfOpen) return 'half-open';
    return 'open';
  }

  canAttempt(): boolean {
    if (this.#openedAt === null) return true;
    if (this.#opts.now() - this.#openedAt >= this.#opts.cooldownMs) {
      this.#halfOpen = true;
      return true;
    }
    return false;
  }

  recordSuccess(): void {
    this.#failures = 0; this.#openedAt = null; this.#halfOpen = false;
  }

  recordFailure(): void {
    this.#failures += 1;
    this.#halfOpen = false;
    if (this.#failures >= this.#opts.threshold) this.#openedAt = this.#opts.now();
  }
}
