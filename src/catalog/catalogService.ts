import { noopLogger, type Logger } from "../logger.js";
import type { CatalogSnapshot } from "./catalogSnapshot.js";

/** Produces a brand-new snapshot from the source of truth (the portal). */
export interface CatalogLoader {
  load(): Promise<CatalogSnapshot>;
}

export interface CatalogServiceOptions {
  readonly loader: CatalogLoader;
  /** After this age the snapshot is "stale": still served, refreshed in the background. */
  readonly ttlMs: number;
  /**
   * Hard limit. Past this age a failing refresh is no longer hidden: the
   * request waits for a refresh and gets the error if it fails. Bounds how
   * old the data we serve can ever be.
   */
  readonly maxStaleMs: number;
  readonly now?: () => number;
  readonly logger?: Logger;
}

export interface CatalogRead {
  readonly snapshot: CatalogSnapshot;
  /** Milliseconds since the data was fetched from the portal. */
  readonly ageMs: number;
  /** True when older than the TTL (a refresh is under way or just failed). */
  readonly stale: boolean;
}

export interface CatalogStatus {
  readonly loaded: boolean;
  readonly meterCount: number;
  readonly fetchedAt: number | null;
  readonly ageMs: number | null;
  readonly refreshing: boolean;
  readonly lastRefreshMs: number | null;
  readonly lastError: { readonly message: string; readonly at: number } | null;
}

/**
 * Keeps one catalog snapshot in memory and decides when to reload it.
 *
 *   no snapshot yet            -> wait for the first load (errors reach the caller)
 *   age < ttl                  -> serve it                                  (fresh)
 *   ttl <= age < maxStale      -> serve it now, refresh in the background   (stale-while-revalidate)
 *   refresh fails meanwhile    -> keep serving the old one, remember error  (stale-if-error)
 *   age >= maxStale            -> wait for a refresh; its error reaches the caller
 *
 * Only one load runs at a time (single-flight), however many requests ask.
 * A new snapshot replaces the old one in a single assignment, so readers
 * never see a mix of old and new data.
 */
export class CatalogService {
  private readonly loader: CatalogLoader;
  private readonly ttlMs: number;
  private readonly maxStaleMs: number;
  private readonly now: () => number;
  private readonly logger: Logger;

  private current: CatalogSnapshot | null = null;
  private inflight: Promise<CatalogSnapshot> | null = null;
  private lastRefreshMs: number | null = null;
  private lastError: { message: string; at: number } | null = null;

  constructor(options: CatalogServiceOptions) {
    if (options.maxStaleMs < options.ttlMs) {
      throw new Error("maxStaleMs must be >= ttlMs");
    }
    this.loader = options.loader;
    this.ttlMs = options.ttlMs;
    this.maxStaleMs = options.maxStaleMs;
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? noopLogger;
  }

  async read(): Promise<CatalogRead> {
    const snapshot = this.current;
    if (snapshot === null) {
      return this.describe(await this.refresh());
    }

    const ageMs = this.now() - snapshot.fetchedAt;
    if (ageMs >= this.maxStaleMs) {
      this.logger.warn("catalog.too_stale", { ageMs });
      return this.describe(await this.refresh());
    }
    if (ageMs >= this.ttlMs) {
      this.refreshInBackground();
    }
    return this.describe(snapshot);
  }

  /** Load now (sharing a load already in flight). Used at startup and by an admin endpoint. */
  refresh(): Promise<CatalogSnapshot> {
    this.inflight ??= this.load().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  status(): CatalogStatus {
    const snapshot = this.current;
    return {
      loaded: snapshot !== null,
      meterCount: snapshot?.size ?? 0,
      fetchedAt: snapshot?.fetchedAt ?? null,
      ageMs: snapshot === null ? null : this.now() - snapshot.fetchedAt,
      refreshing: this.inflight !== null,
      lastRefreshMs: this.lastRefreshMs,
      lastError: this.lastError,
    };
  }

  private refreshInBackground(): void {
    if (this.inflight !== null) return;
    this.refresh().catch(() => {
      // Already logged and recorded in load(); the old snapshot keeps serving.
    });
  }

  private async load(): Promise<CatalogSnapshot> {
    const started = this.now();
    try {
      const next = await this.loader.load(); // cataloglover ->load() : snapshot
      const previous = this.current;
      this.current = next; // atomic swap
      this.lastRefreshMs = this.now() - started;
      this.lastError = null;
      this.logger.info("catalog.refreshed", {
        meters: next.size,
        durationMs: this.lastRefreshMs,
        ...diff(previous, next),
      });
      return next;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.lastError = { message, at: this.now() };
      this.logger.error("catalog.refresh_failed", { message, servingStale: this.current !== null });
      throw error;
    }
  }

  private describe(snapshot: CatalogSnapshot): CatalogRead {
    const ageMs = Math.max(0, this.now() - snapshot.fetchedAt);
    return { snapshot, ageMs, stale: ageMs >= this.ttlMs };
  }
}

/** What changed between two snapshots: logged on every refresh, so data drift is visible. */
function diff(previous: CatalogSnapshot | null, next: CatalogSnapshot) {
  if (previous === null) return { initial: true };
  const before = new Map(previous.meters.map((m) => [m.id, JSON.stringify(m)]));
  let added = 0;
  let changed = 0;
  for (const meter of next.meters) {
    const old = before.get(meter.id);
    if (old === undefined) added += 1;
    else if (old !== JSON.stringify(meter)) changed += 1;
    before.delete(meter.id);
  }
  return { added, removed: before.size, changed };
}
