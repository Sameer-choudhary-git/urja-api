import { describe, expect, it, vi } from "vitest";
import { TtlCache } from "../../src/shared/ttlCache.js";

function setup(options: { maxEntries?: number; maxStaleMs?: number; isFatal?: (e: unknown) => boolean } = {}) {
  let now = 0;
  const cache = new TtlCache<string>({ maxEntries: options.maxEntries ?? 10, maxStaleMs: options.maxStaleMs ?? 1_000, isFatal: options.isFatal, now: () => now });
  return { cache, advance: (ms: number) => (now += ms) };
}
const ttl = (ms: number) => () => ms;

describe("TtlCache", () => {
  it("serves a hit until the TTL the caller chose, then reloads", async () => {
    const { cache, advance } = setup();
    const load = vi.fn(async () => "v");
    expect((await cache.getOrLoad("k", load, ttl(100))).outcome).toBe("miss");
    advance(99);
    expect((await cache.getOrLoad("k", load, ttl(100))).outcome).toBe("hit");
    advance(1);
    expect((await cache.getOrLoad("k", load, ttl(100))).outcome).toBe("miss");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("lets the TTL depend on the value", async () => {
    const { cache } = setup();
    const result = await cache.getOrLoad("k", async () => "old data", (value) => (value.startsWith("old") ? 3_600 : 30));
    expect(result.expiresAt).toBe(3_600);
  });

  it("single-flight: concurrent misses share one load", async () => {
    const { cache } = setup();
    let release!: (value: string) => void;
    const load = vi.fn(() => new Promise<string>((resolve) => (release = resolve)));
    const pending = Promise.all([1, 2, 3].map(() => cache.getOrLoad("k", load, ttl(100))));
    release("v");
    expect((await pending).map((r) => r.value)).toEqual(["v", "v", "v"]);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("stale-if-error: serves the expired copy when a reload fails, within maxStale", async () => {
    const { cache, advance } = setup({ maxStaleMs: 500 });
    await cache.getOrLoad("k", async () => "v1", ttl(100));
    advance(400);
    const result = await cache.getOrLoad("k", () => Promise.reject(new Error("portal down")), ttl(100));
    expect(result).toMatchObject({ value: "v1", outcome: "stale" });
    advance(201); // now 601: 501 ms past expiry
    await expect(cache.getOrLoad("k", () => Promise.reject(new Error("portal down")), ttl(100))).rejects.toThrow("portal down");
  });

  it("never serves stale data after a fatal error (e.g. the meter is gone)", async () => {
    const { cache, advance } = setup({ isFatal: (e) => (e as Error).message === "gone" });
    await cache.getOrLoad("k", async () => "v1", ttl(100));
    advance(150);
    await expect(cache.getOrLoad("k", () => Promise.reject(new Error("gone")), ttl(100))).rejects.toThrow("gone");
    expect(cache.size).toBe(0);
  });

  it("does not cache failures", async () => {
    const { cache } = setup();
    await expect(cache.getOrLoad("k", () => Promise.reject(new Error("x")), ttl(100))).rejects.toThrow();
    expect((await cache.getOrLoad("k", async () => "v", ttl(100))).value).toBe("v");
  });

  it("evicts the least recently used entry when full", async () => {
    const { cache } = setup({ maxEntries: 2 });
    await cache.getOrLoad("a", async () => "a", ttl(1_000));
    await cache.getOrLoad("b", async () => "b", ttl(1_000));
    await cache.getOrLoad("a", async () => "a", ttl(1_000)); // a is now the most recent
    await cache.getOrLoad("c", async () => "c", ttl(1_000)); // evicts b
    const loadB = vi.fn(async () => "b");
    await cache.getOrLoad("b", loadB, ttl(1_000));
    expect(loadB).toHaveBeenCalledTimes(1);
    expect(cache.stats.evictions).toBe(2);
  });
});
