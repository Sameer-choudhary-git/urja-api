import { readFileSync } from "node:fs";
import { CatalogService } from "./catalog/catalogService.js";
import { PortalCatalogLoader } from "./catalog/portalCatalogLoader.js";
import { ConfigError, loadAppConfig } from "./config.js";
import { createApp } from "./http/app.js";
import { createJsonLogger } from "./logger.js";
import { createPortal } from "./portal/createPortal.js";
import { portalHealth } from "./portal/portalHealth.js";
import { ReadingsService } from "./readings/readingsService.js";

/**
 * Composition root: the only place that reads the environment, talks to the
 * real portal and opens a port. Everything below it is plain objects that
 * tests build with fakes.
 */
async function main(): Promise<void> {
  let config;
  try {
    config = loadAppConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  const logger = createJsonLogger(config.logLevel, { service: "urja-api" });
  const portal = createPortal(config.portal, logger);
  const catalog = new CatalogService({
    loader: new PortalCatalogLoader(
      { ...portal, fallbackApi: config.catalog.fallback ? portal.fallbackApi : undefined },
      logger,
    ),
    ttlMs: config.catalog.ttlMs,
    maxStaleMs: config.catalog.maxStaleMs,
    logger,
  });

  const readings = new ReadingsService({
    source: portal.energyApi,
    maxEntries: config.readings.cacheEntries,
    maxStaleMs: config.readings.maxStaleMs,
    logger,
  });

  const version = (JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }).version;
  const { app } = createApp({
    context: { catalog, readings, portalHealth: portalHealth(portal), startedAt: Date.now(), now: Date.now },
    apiKeys: config.auth.mode === "keys" ? config.auth.keys : null,
    rateLimitPerMinute: config.http.rateLimitPerMinute,
    trustProxy: config.http.trustProxy,
    corsOrigins: config.http.corsOrigins,
    logger,
    version,
  });

  if (config.auth.mode === "disabled") {
    logger.warn("auth.disabled", { note: "AUTH_MODE=disabled: /v1 is open. Local development only." });
  }

  // Warm the catalog in the background: the port opens at once, /ready says
  // false until the first load succeeds, and the first /v1 call waits for it.
  // If the portal is unreachable at boot (common right after a deploy), keep
  // retrying with a growing delay (30 s, 60 s, ... up to 5 min) until it loads,
  // so the service becomes ready on its own without waiting for traffic.
  const warmUp = (attempt: number): void => {
    catalog.refresh().catch(() => {
      // The catalog service logs the error; /ready shows it.
      if (catalog.status().loaded) return;
      const delayMs = Math.min(30_000 * attempt, 300_000);
      logger.warn("catalog.warmup_retry", { attempt, inSeconds: delayMs / 1000 });
      setTimeout(() => warmUp(attempt + 1), delayMs).unref();
    });
  };
  warmUp(1);

  const server = app.listen(config.http.port, config.http.host, () => {
    logger.info("http.listening", { host: config.http.host, port: config.http.port, docs: "/docs" });
  });

  // Graceful shutdown: stop accepting, let in-flight requests finish, then exit.
  // A hard deadline makes sure a stuck connection cannot block a deploy forever.
  const shutdown = (signal: string) => {
    logger.info("http.shutting_down", { signal });
    server.close(() => process.exit(0));
    server.closeIdleConnections();
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

void main();
