import { describe, expect, it, vi } from "vitest";
import { CircuitBreaker, CircuitOpenError } from "../../src/shared/circuitBreaker.js";
import { ConcurrencyLimiter, LimiterFullError } from "../../src/shared/concurrencyLimiter.js";

class Down extends Error {}
const fail = () => Promise.reject(new Down("down"));
const ok = () => Promise.resolve("ok");

function setup() {
  let now = 0;
  const changes: string[] = [];
  const breaker = new CircuitBreaker({
    failureThreshold: 3,
    openMs: 1_000,
    isFailure: (e) => e instanceof Down,
    now: () => now,
    onStateChange: (from, to) => changes.push(`${from}->${to}`),
  });
  return { breaker, changes, advance: (ms: number) => (now += ms) };
}

describe("CircuitBreaker", () => {
  it("opens after N consecutive failures and then fails fast without calling", async () => {
    const { breaker } = setup();
    for (let i = 0; i < 3; i += 1) await expect(breaker.run(fail)).rejects.toBeInstanceOf(Down);
    expect(breaker.state).toBe("open");
    const call = vi.fn(ok);
    await expect(breaker.run(call)).rejects.toBeInstanceOf(CircuitOpenError);
    expect(call).not.toHaveBeenCalled();
  });

  it("a success resets the count; errors that are not failures do not count", async () => {
    const { breaker } = setup();
    await expect(breaker.run(fail)).rejects.toThrow();
    await expect(breaker.run(fail)).rejects.toThrow();
    await breaker.run(ok);
    await expect(breaker.run(() => Promise.reject(new Error("404, portal is fine")))).rejects.toThrow();
    await expect(breaker.run(fail)).rejects.toThrow();
    expect(breaker.state).toBe("closed");
  });

  it("after the cool-down lets ONE trial through; success closes, failure reopens", async () => {
    const { breaker, advance, changes } = setup();
    for (let i = 0; i < 3; i += 1) await expect(breaker.run(fail)).rejects.toThrow();
    advance(1_000);
    expect(breaker.state).toBe("half_open");

    let release!: () => void;
    const trial = breaker.run(() => new Promise<string>((resolve) => (release = () => resolve("ok"))));
    await expect(breaker.run(ok)).rejects.toBeInstanceOf(CircuitOpenError); // second caller waits outside
    release();
    await trial;
    expect(breaker.state).toBe("closed");

    for (let i = 0; i < 3; i += 1) await expect(breaker.run(fail)).rejects.toThrow();
    advance(1_000);
    await expect(breaker.run(fail)).rejects.toBeInstanceOf(Down);
    expect(breaker.state).toBe("open");
    expect(changes).toEqual(["closed->open", "open->half_open", "half_open->closed", "closed->open", "open->half_open", "half_open->open"]);
  });
});

describe("ConcurrencyLimiter", () => {
  it("never runs more than maxConcurrent at once and keeps FIFO order", async () => {
    const limiter = new ConcurrencyLimiter({ maxConcurrent: 2, maxQueue: 10 });
    let running = 0;
    let peak = 0;
    const order: number[] = [];
    const task = (id: number) => async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push(id);
      running -= 1;
    };
    await Promise.all([1, 2, 3, 4, 5, 6].map((id) => limiter.run(task(id))));
    expect(peak).toBe(2);
    expect(order).toEqual([1, 2, 3, 4, 5, 6]);
    expect(limiter.snapshot()).toEqual({ active: 0, queued: 0 });
  });

  it("refuses at once when the queue is full, and frees the slot when a task throws", async () => {
    const limiter = new ConcurrencyLimiter({ maxConcurrent: 1, maxQueue: 1 });
    let release!: () => void;
    const first = limiter.run(() => new Promise<void>((resolve) => (release = resolve)));
    const second = limiter.run(() => Promise.reject(new Error("boom")));
    await expect(limiter.run(ok)).rejects.toBeInstanceOf(LimiterFullError);
    release();
    await first;
    await expect(second).rejects.toThrow("boom");
    expect(await limiter.run(ok)).toBe("ok");
  });
});
