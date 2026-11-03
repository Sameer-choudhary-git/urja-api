/**
 * A small in-memory cache with the three behaviours a slow upstream needs:
 *
 *  - TTL per entry, decided by the caller from the value itself
 *    (old data can be kept longer than fresh data);
 *  - single-flight: concurrent misses for one key share ONE load, so 50
 *    dashboard tabs opening the same meter cost the portal one request;
 *  - stale-if-error: if a reload fails, an expired entry is served for a
 *    while longer instead of an error, and the caller is told it is stale.
 *
 * Size is bounded with least-recently-used eviction (a Map keeps insertion
 * order, so re-inserting on use moves an entry to the back).
 *
 * In memory = per process. Several instances would share Redis instead
 * (see README); the interface would stay the same.
 */

export type CacheOutcome = "hit" | "miss" | "stale";

export interface CacheResult<V> {
  readonly value: V;
  readonly fetchedAt: number;
  readonly expiresAt: number;
  readonly outcome: CacheOutcome;
}

export interface TtlCacheOptions {
  readonly maxEntries: number;
  /** How long past expiry an entry may still be served when a reload fails. */
  readonly maxStaleMs: number;
  /** Errors for which a stale value must NOT be served (e.g. "it no longer exists"). */
  readonly isFatal?: (error: unknown) => boolean;
  readonly now?: () => number;
}

interface Entry<V> {
  readonly value: V;
  readonly fetchedAt: number;
  readonly expiresAt: number;
}

export class TtlCache<V> {
  private readonly entries = new Map<string, Entry<V>>();
  private readonly inFlight = new Map<string, Promise<Entry<V>>>();
  private readonly options: TtlCacheOptions;
  private readonly now: () => number;
  readonly stats = { hits: 0, misses: 0, staleServed: 0, loads: 0, evictions: 0 };

  constructor(options: TtlCacheOptions) {
    if (options.maxEntries < 1) throw new Error("maxEntries must be at least 1");
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.entries.size;
  }

  async getOrLoad(
    key: string,
    load: () => Promise<V>,
    ttlFor: (value: V, now: number) => number,
  ): Promise<CacheResult<V>> {
    const cached = this.entries.get(key);
    if (cached !== undefined && this.now() < cached.expiresAt) {
      this.touch(key, cached);
      this.stats.hits += 1;
      return { ...cached, outcome: "hit" };
    }

    this.stats.misses += 1;
    try {
      const entry = await this.loadOnce(key, load, ttlFor);
      return { ...entry, outcome: "miss" };
    } catch (error) {
      const fatal = this.options.isFatal?.(error) ?? false;
      if (!fatal && cached !== undefined && this.now() <= cached.expiresAt + this.options.maxStaleMs) {
        this.stats.staleServed += 1;
        return { ...cached, outcome: "stale" };
      }
      if (fatal) this.entries.delete(key);
      throw error;
    }
  }

  private loadOnce(key: string, load: () => Promise<V>, ttlFor: (value: V, now: number) => number): Promise<Entry<V>> {
    const running = this.inFlight.get(key);
    if (running !== undefined) return running;

    this.stats.loads += 1;
    const promise = (async () => {
      const value = await load();
      const fetchedAt = this.now();
      const entry = { value, fetchedAt, expiresAt: fetchedAt + Math.max(0, ttlFor(value, fetchedAt)) };
      this.touch(key, entry);
      this.evict();
      return entry;
    })().finally(() => this.inFlight.delete(key));

    this.inFlight.set(key, promise);
    return promise;
  }

  private touch(key: string, entry: Entry<V>): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
  }

  private evict(): void {
    while (this.entries.size > this.options.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) return;
      this.entries.delete(oldest);
      this.stats.evictions += 1;
    }
  }
}
