import request from "supertest";
import { afterEach, describe, expect, it } from "vitest";
import { CatalogService } from "../src/catalog/catalogService.js";
import { PortalCatalogLoader } from "../src/catalog/portalCatalogLoader.js";
import { createApp } from "../src/http/app.js";
import { createPortal } from "../src/portal/createPortal.js";
import { portalHealth } from "../src/portal/portalHealth.js";
import { ReadingsService } from "../src/readings/readingsService.js";
import { startFakePortal, type FakePortal, type FakePortalOptions } from "./helpers/fakePortal.js";
import { sampleExport, sampleTransformerRows } from "./helpers/sample.js";

/**
 * The whole stack (Express app, readings cache, portal client with retries,
 * breaker and limiter, real HTTP) against a misbehaving fake portal.
 */
describe("chaos: the API under a failing, slow portal", () => {
  let fake: FakePortal;
  afterEach(async () => fake.close());

  async function stack(options: FakePortalOptions, portalOptions: { maxConcurrency?: number; breakerOpenMs?: number } = {}) {
    fake = await startFakePortal({ exportMeters: sampleExport, transformers: sampleTransformerRows, ...options });
    const portal = createPortal({
      baseUrl: fake.baseUrl,
      email: "operator@urja.local",
      password: "correct-horse",
      timeoutMs: 2_000,
      maxRetries: 2,
      maxConcurrency: portalOptions.maxConcurrency ?? 3,
      breakerThreshold: 3,
      breakerOpenMs: portalOptions.breakerOpenMs ?? 60_000,
    });
    const catalog = new CatalogService({ loader: new PortalCatalogLoader(portal), ttlMs: 60_000, maxStaleMs: 600_000 });
    const readings = new ReadingsService({ source: portal.energyApi });
    const { app } = createApp({
      context: { catalog, readings, portalHealth: portalHealth(portal), startedAt: Date.now(), now: Date.now },
      apiKeys: null,
      rateLimitPerMinute: 10_000,
    });
    return { app, portal, catalog };
  }

  it("30% failures and random latency: every answer is 200 or a clean 503, and the portal never sees more than 3 calls at once", async () => {
    const { app } = await stack({ chaos: { failureRate: 0.3, maxLatencyMs: 20, seed: 7 } });
    const ids = sampleExport.map((meter) => meter.meterId);
    const responses = await Promise.all(
      Array.from({ length: 40 }, (_, i) =>
        request(app).get(`/v1/meters/${ids[i % ids.length]}/readings?from=2026-06-${String(1 + (i % 28)).padStart(2, "0")}`),
      ),
    );
    const statuses = responses.map((res) => res.status);
    for (const res of responses) {
      expect([200, 503]).toContain(res.status);
      if (res.status === 503) expect(res.headers["content-type"]).toMatch(/problem\+json/);
    }
    // Retries absorb most injected failures.
    expect(statuses.filter((status) => status === 200).length).toBeGreaterThan(30);
    expect(fake.stats.maxInFlight).toBeLessThanOrEqual(3);
  });

  it("portal goes down: the breaker opens, calls fail fast with Retry-After, cached data is still served, and it recovers", async () => {
    const { app, portal } = await stack({}, { breakerOpenMs: 300 });
    await request(app).get("/v1/meters/J100000/readings?from=2026-06-10&to=2026-06-10").expect(200);

    fake.setDown(true);
    for (let i = 0; i < 3; i += 1) {
      await request(app).get(`/v1/meters/J100000/readings?from=2026-06-2${i}&to=2026-06-2${i}`).expect(503);
    }
    expect(portal.breaker.state).toBe("open");
    const ready = await request(app).get("/ready").expect(200);
    expect(ready.body.portal).toMatchObject({ circuit: "open" });

    const before = fake.stats.energyRequests.length;
    const started = Date.now();
    const fast = await request(app).get("/v1/meters/J100000/readings?from=2026-06-25&to=2026-06-25").expect(503);
    expect(Date.now() - started).toBeLessThan(200);
    expect(Number(fast.headers["retry-after"])).toBeGreaterThan(0);
    expect(fake.stats.energyRequests.length).toBe(before); // the portal was not called at all

    // Catalog routes and cached readings keep working from memory.
    await request(app).get("/v1/meters?status=faulty").expect(200);
    await request(app).get("/v1/meters/J100000/readings?from=2026-06-10&to=2026-06-10").expect(200);

    fake.setDown(false);
    await new Promise((resolve) => setTimeout(resolve, 350));
    await request(app).get("/v1/meters/J100000/readings?from=2026-06-25&to=2026-06-25").expect(200);
    expect(portal.breaker.state).toBe("closed");
  });
});
