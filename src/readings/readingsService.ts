import { deriveReadings, type Reading, type ReadingIssue, type TimeWindow } from "../domain/readings.js";
import { DAY_MS, HALF_HOUR_MS, HOUR_MS, istDay, MINUTE_MS } from "../domain/time.js";
import { noopLogger, type Logger } from "../logger.js";
import type { PortalDayRange } from "../portal/energyApi.js";
import { PortalNotFoundError } from "../portal/errors.js";
import type { EnergyRow } from "../portal/schemas.js";
import { TtlCache, type CacheOutcome } from "../shared/ttlCache.js";

/** Where readings come from. The portal adapter satisfies this; tests pass a fake. */
export interface ReadingsSource {
  fetchReadings(meterId: string, days: PortalDayRange | null): Promise<readonly EnergyRow[]>;
}

/** What the API asks for. Times are epoch ms; either side may be missing. */
export interface ReadingsRequest {
  readonly meterId: string;
  readonly from?: number;
  readonly to?: number;
}

export interface ReadingsResult {
  readonly meterId: string;
  /** The window actually served, [from, to). */
  readonly window: TimeWindow;
  /** Every reading fetched; may extend past the window (callers select with `inWindow`). */
  readonly readings: readonly Reading[];
  readonly issues: readonly ReadingIssue[];
  readonly latestReadingAt: number | null;
  readonly fetchedAt: number;
  readonly expiresAt: number;
  readonly cache: CacheOutcome;
}

export const DEFAULT_SPAN_MS = 7 * DAY_MS;
export const MAX_SPAN_MS = 31 * DAY_MS;

export interface ReadingsServiceOptions {
  readonly source: ReadingsSource;
  readonly maxEntries?: number;
  readonly maxStaleMs?: number;
  readonly now?: () => number;
  readonly logger?: Logger;
}

interface Loaded {
  readonly readings: readonly Reading[];
  readonly issues: readonly ReadingIssue[];
  readonly latestReadingAt: number | null;
}

/**
 * Energy readings for one meter and time window, through a cache.
 *
 * Unlike the catalog (403 meters, one bulk call), readings are fetched per
 * meter on demand: 403 x 1440 rows would be a lot to prefetch for data that
 * is mostly never looked at.
 *
 * The portal filters by whole IST days only, so we ask it for the days that
 * cover the window (plus the reading just before, which is needed to compute
 * the first interval) and cut the exact window locally.
 */
export class ReadingsService {
  private readonly source: ReadingsSource;
  private readonly cache: TtlCache<Loaded>;
  private readonly now: () => number;
  private readonly logger: Logger;

  constructor(options: ReadingsServiceOptions) {
    this.source = options.source;
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? noopLogger;
    this.cache = new TtlCache<Loaded>({
      maxEntries: options.maxEntries ?? 500,
      maxStaleMs: options.maxStaleMs ?? 6 * HOUR_MS,
      // A meter the portal says does not exist must not be served from an old copy.
      isFatal: (error) => error instanceof PortalNotFoundError,
      now: this.now,
    });
  }

  get cacheStats(): Readonly<TtlCache<Loaded>["stats"]> & { readonly entries: number } {
    return { ...this.cache.stats, entries: this.cache.size };
  }

  async get(request: ReadingsRequest): Promise<ReadingsResult> {
    const requested = resolveWindow(request);
    const days = requested === null ? null : portalDaysFor(requested);
    const key = `${request.meterId}|${days === null ? "default" : `${days.from}|${days.to}`}`;

    const result = await this.cache.getOrLoad(
      key,
      async () => {
        const rows = await this.source.fetchReadings(request.meterId, days);
        const { readings, issues } = deriveReadings(rows);
        this.logger.info("readings.loaded", { meterId: request.meterId, days: days ?? "default", rows: rows.length, issues: issues.length });
        return { readings, issues, latestReadingAt: readings.at(-1)?.at ?? null };
      },
      (loaded, now) => ttlForDataAge(loaded.latestReadingAt, now),
    );

    const { readings, issues, latestReadingAt } = result.value;
    return {
      meterId: request.meterId,
      window: requested ?? defaultWindow(latestReadingAt, this.now()),
      readings,
      issues,
      latestReadingAt,
      fetchedAt: result.fetchedAt,
      expiresAt: result.expiresAt,
      cache: result.outcome,
    };
  }
}

/**
 * Missing sides default to a 7-day span. Neither side = "the portal's own
 * default", resolved after the fetch from the latest reading (see defaultWindow).
 */
export function resolveWindow(request: Pick<ReadingsRequest, "from" | "to">): TimeWindow | null {
  const { from, to } = request;
  if (from !== undefined && to !== undefined) return { from, to };
  if (from !== undefined) return { from, to: from + DEFAULT_SPAN_MS };
  if (to !== undefined) return { from: to - DEFAULT_SPAN_MS, to };
  return null;
}

/** The 7 days ending at the latest reading, so the default view has no empty tail. */
export function defaultWindow(latestReadingAt: number | null, now: number): TimeWindow {
  const to = latestReadingAt === null ? now : latestReadingAt;
  return { from: to - DEFAULT_SPAN_MS, to };
}

/**
 * The whole IST days to request so the window's intervals are all covered:
 * from the day of `from` (whose first reading is the baseline for the first
 * interval) to the day of the reading that closes the last interval.
 */
export function portalDaysFor(window: TimeWindow): PortalDayRange {
  return { from: istDay(window.from), to: istDay(window.to + HALF_HOUR_MS - 1) };
}

/**
 * How long a fetched answer stays fresh, from how old its newest reading is:
 *  - newest reading over a day old: history, it will not change; 1 hour.
 *  - live data: until just after the next half-hourly reading is due,
 *    between 30 seconds and 5 minutes.
 *  - no readings at all: 5 minutes.
 * Today the portal's data ends on 30 June 2026, so everything is "history".
 */
export function ttlForDataAge(latestReadingAt: number | null, now: number): number {
  if (latestReadingAt === null) return 5 * MINUTE_MS;
  if (now - latestReadingAt > DAY_MS) return HOUR_MS;
  const nextReadingDue = latestReadingAt + HALF_HOUR_MS + MINUTE_MS;
  return Math.min(5 * MINUTE_MS, Math.max(30_000, nextReadingDue - now));
}
