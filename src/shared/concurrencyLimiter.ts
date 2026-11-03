/**
 * Bulkhead: at most `maxConcurrent` calls run at once; the rest wait in a
 * FIFO queue of at most `maxQueue`. Beyond that, calls are refused at once.
 *
 * Why: the portal is a legacy system we must not overload. A dashboard that
 * opens 40 meters, or a fleet anomaly scan, should turn into a steady trickle
 * of portal requests, not a burst. A bounded queue also bounds memory and
 * latency: refusing early beats letting requests pile up for minutes.
 */

export class LimiterFullError extends Error {
  override readonly name = "LimiterFullError";
}

export interface ConcurrencyLimiterOptions {
  readonly maxConcurrent: number;
  readonly maxQueue: number;
}

export class ConcurrencyLimiter {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  readonly stats = { maxActiveSeen: 0, rejected: 0 };

  constructor(private readonly options: ConcurrencyLimiterOptions) {
    if (options.maxConcurrent < 1) throw new Error("maxConcurrent must be at least 1");
  }

  snapshot(): { active: number; queued: number } {
    return { active: this.active, queued: this.waiting.length };
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.options.maxConcurrent) {
      if (this.waiting.length >= this.options.maxQueue) {
        this.stats.rejected += 1;
        throw new LimiterFullError(`Too many portal requests waiting (${this.waiting.length})`);
      }
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.active += 1;
    }
    this.stats.maxActiveSeen = Math.max(this.stats.maxActiveSeen, this.active);
    try {
      return await fn();
    } finally {
      const next = this.waiting.shift();
      // Hand the slot straight to the next caller, so `active` never dips and lets a newcomer jump the queue.
      if (next !== undefined) next();
      else this.active -= 1;
    }
  }
}
