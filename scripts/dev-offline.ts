/**
 * Offline demo: the REAL server and the REAL portal adapter (login, signing,
 * retries, normalisation), pointed at the in-process fake portal from the
 * tests instead of urja-ops.flockenergy.tech.
 *
 *   npm run dev:offline            # http://localhost:3000/docs, auth disabled
 *
 * Data: fixtures/local/meter-export.json if you have it (all 403 meters),
 * otherwise the 14-meter test sample. Useful for frontend work, demos, and
 * anywhere the real portal is not reachable.
 */
import { existsSync, readFileSync } from "node:fs";
import { CatalogService } from "../src/catalog/catalogService.js";
import { PortalCatalogLoader } from "../src/catalog/portalCatalogLoader.js";
import { createApp } from "../src/http/app.js";
import { createJsonLogger } from "../src/logger.js";
import { createPortal } from "../src/portal/createPortal.js";
import { portalHealth } from "../src/portal/portalHealth.js";
import { ReadingsService } from "../src/readings/readingsService.js";
import { exportFileSchema, exportResponseSchema } from "../src/portal/schemas.js";
import { startFakePortal } from "../test/helpers/fakePortal.js";
import { sampleExport } from "../test/helpers/sample.js";

const LOCAL_EXPORT = "fixtures/local/meter-export.json";
const port = Number(process.env.PORT ?? 3000);

function loadMeters() {
  if (!existsSync(LOCAL_EXPORT)) return sampleExport;
  const raw: unknown = JSON.parse(readFileSync(LOCAL_EXPORT, "utf8"));
  const asArray = exportFileSchema.safeParse(raw);
  return asArray.success ? asArray.data : exportResponseSchema.parse(raw).data;
}

const meters = loadMeters();
// Transformer rows shaped like /portal/dts, with DT-007's real canonical name.
const transformers = [...new Map(meters.map((m) => [m.dtCode, m])).values()].map((m) => ({
  code: m.dtCode,
  name: m.dtCode === "DT-007" ? "Sanganer DT 7" : m.hierarchy.dt.name,
  feederCode: m.hierarchy.feeder.code,
  capacityKva: [63, 100, 160, 250, 400][Number(m.dtCode.slice(3)) % 5] ?? 100,
}));

const fake = await startFakePortal({ exportMeters: meters, transformers });
// OFFLINE_BREAK_EXPORT=1 makes the signed export fail, to watch the fallback path take over.
if (process.env.OFFLINE_BREAK_EXPORT === "1") fake.failNextExports(403, Number.MAX_SAFE_INTEGER);
const logger = createJsonLogger("info", { service: "urja-api", mode: "offline" });
const portal = createPortal(
  { baseUrl: fake.baseUrl, email: "operator@urja.local", password: "correct-horse", timeoutMs: 5_000, maxRetries: 2 },
  logger,
);
const catalog = new CatalogService({
  loader: new PortalCatalogLoader(portal, logger), // fallback included
  ttlMs: 15 * 60_000,
  maxStaleMs: 24 * 60 * 60_000,
  logger,
});
await catalog.refresh();
const readings = new ReadingsService({ source: portal.energyApi, logger });

const { app } = createApp({
  context: { catalog, readings, portalHealth: portalHealth(portal), startedAt: Date.now(), now: Date.now },
  apiKeys: null,
  rateLimitPerMinute: 1_000,
  corsOrigins: ["*"], // so a local web client (Vite, Lovable preview) can call it
  logger,
});
app.listen(port, () => {
  logger.info("offline.ready", { meters: meters.length, docs: `http://localhost:${port}/docs`, note: "fake portal, auth disabled" });
});
