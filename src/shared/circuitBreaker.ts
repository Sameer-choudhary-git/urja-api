/**
 * Circuit breaker: stop calling an upstream that is clearly down.
 *
 *   CLOSED --(N failures in a row)--> OPEN --(cool-down passes)--> HALF_OPEN
 *     ^                                                              |
 *     +------------------(trial call succeeds)-----------------------+
 *                         (trial call fails) -> OPEN again
 *
 * Why: when the portal is down, every request would otherwise wait for
 * timeouts and retries (seconds each) and keep hammering a struggling
 * server. While OPEN we fail in microseconds with a clear "try again in N
 * seconds", and the portal gets room to recover. One trial call at a time
 * probes whether it is back.
 *
 * Only failures that mean "the upstream is unhealthy" count (the caller
 * decides with `isFailure`). A 404 for an unknown meter is a healthy answer.
 */

export type CircuitState = "closed" | "open" | "half_open";

export class CircuitOpenError extends Error {
  override readonly name = "CircuitOpenError";
  constructor(readonly retryAfterMs: number) {
    super(`Circuit open; retry in ${Math.ceil(retryAfterMs / 1000)}s`);
  }
}

export interface CircuitBreakerOptions {
  /** Consecutive failures that open the circuit. */
  readonly failureThreshold: number;
  /** How long the circuit stays open before one trial call is allowed. */
  readonly openMs: number;
  readonly isFailure: (error: unknown) => boolean;
  readonly now?: () => number;
  readonly onStateChange?: (from: CircuitState, to: CircuitState) => void;
}

export class CircuitBreaker {
  private stateValue: CircuitState = "closed";
  private consecutiveFailures = 0;
  private openedAt = 0;
  private trialInFlight = false;
  private readonly now: () => number;
  readonly stats = { rejected: 0, opened: 0 };

  constructor(private readonly options: CircuitBreakerOptions) {
    if (options.failureThreshold < 1) throw new Error("failureThreshold must be at least 1");
    this.now = options.now ?? Date.now;
  }

  /** Current state; an OPEN circuit whose cool-down has passed reports HALF_OPEN. */
  get state(): CircuitState {
    if (this.stateValue === "open" && this.now() - this.openedAt >= this.options.openMs) return "half_open";
    return this.stateValue;
  }

  snapshot(): { state: CircuitState; consecutiveFailures: number; retryAfterMs: number | null } {
    const state = this.state;
    return {
      state,
      consecutiveFailures: this.consecutiveFailures,
      retryAfterMs: state === "open" ? this.options.openMs - (this.now() - this.openedAt) : null,
    };
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const state = this.state;
    if (state === "open" || (state === "half_open" && this.trialInFlight)) {
      this.stats.rejected += 1;
      const remaining = this.options.openMs - (this.now() - this.openedAt);
      throw new CircuitOpenError(Math.max(remaining, 1_000));
    }

    const isTrial = state === "half_open";
    if (isTrial) {
      this.trialInFlight = true;
      this.transition("half_open");
    }
    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      if (this.options.isFailure(error)) this.onFailure(isTrial);
      else this.onSuccess();
      throw error;
    } finally {
      if (isTrial) this.trialInFlight = false;
    }
  }

  private onSuccess(): void {
    this.consecutiveFailures = 0;
    if (this.stateValue !== "closed") this.transition("closed");
  }

  private onFailure(wasTrial: boolean): void {
    this.consecutiveFailures += 1;
    if (wasTrial || this.consecutiveFailures >= this.options.failureThreshold) {
      this.openedAt = this.now();
      this.stats.opened += 1;
      this.transition("open");
    }
  }

  private transition(to: CircuitState): void {
    const from = this.stateValue;
    this.stateValue = to;
    if (from !== to) this.options.onStateChange?.(from, to);
  }
}
