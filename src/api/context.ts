import type { Response } from "express";
import type { CatalogSnapshot } from "../catalog/catalogSnapshot.js";
import type { CatalogService } from "../catalog/catalogService.js";
import type { ReadingsService } from "../readings/readingsService.js";
import type { z } from "zod";
import type { metaSchema } from "./schemas.js";

export interface PortalHealth {
  readonly circuit: "closed" | "open" | "half_open";
  readonly consecutiveFailures: number;
  readonly retryAfterSeconds: number | null;
  readonly activeRequests: number;
  readonly queuedRequests: number;
}

/** Everything route handlers may depend on. Built once in the composition root. */
export interface ApiContext {
  readonly catalog: Pick<CatalogService, "read" | "status">;
  readonly readings: Pick<ReadingsService, "get">;
  /** Circuit breaker and queue state of the portal client, for /ready. */
  readonly portalHealth?: () => PortalHealth;
  readonly startedAt: number;
  readonly now: () => number;
}

/**
 * Reads the current catalog snapshot and stamps freshness on the response:
 *  - `X-Data-Age` (seconds) and `X-Data-Stale` headers for programs,
 *  - a `meta` block for the JSON body,
 *  - `Cache-Control: no-cache`: clients may cache but must revalidate; Express
 *    adds an ETag, so an unchanged answer costs a 304 with no body.
 */
export async function readCatalog(
  context: ApiContext,
  res: Response,
): Promise<{ snapshot: CatalogSnapshot; meta: z.infer<typeof metaSchema> }> {
  const { snapshot, ageMs, stale } = await context.catalog.read();
  const ageSeconds = Math.floor(ageMs / 1000);
  res.set({
    "x-data-age": String(ageSeconds),
    "x-data-stale": String(stale),
    "x-data-source": snapshot.source,
    "cache-control": "no-cache",
  });
  return {
    snapshot,
    meta: { asOf: new Date(snapshot.fetchedAt).toISOString(), ageSeconds, stale, source: snapshot.source },
  };
}
