import request from "supertest";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import type { ApiContext } from "../../src/api/context.js";
import * as s from "../../src/api/schemas.js";
import { CatalogSnapshot } from "../../src/catalog/catalogSnapshot.js";
import type { CatalogStatus } from "../../src/catalog/catalogService.js";
import { normalizeCatalog } from "../../src/domain/normalize.js";
import { createApp } from "../../src/http/app.js";
import { PortalAuthError, PortalUnavailableError } from "../../src/portal/errors.js";
import type { PortalDayRange } from "../../src/portal/energyApi.js";
import { ReadingsService } from "../../src/readings/readingsService.js";
import { scanExport } from "../../src/quality/scanExport.js";
import { filterEnergy, generateEnergy } from "../helpers/fakeEnergy.js";
import { sampleExport, sampleTransformerRows } from "../helpers/sample.js";

const KEY = "test-key-0123456789abcdefghij";
const NOW = 1_800_000_000_000;

const { meters, transformers } = normalizeCatalog(sampleExport, sampleTransformerRows);
const snapshot = new CatalogSnapshot({
  meters,
  transformers,
  fetchedAt: NOW - 90_000,
  quality: scanExport(sampleExport),
});

const loadedStatus: CatalogStatus = {
  loaded: true,
  meterCount: snapshot.size,
  fetchedAt: snapshot.fetchedAt,
  ageMs: 90_000,
  refreshing: false,
  lastRefreshMs: 20,
  lastError: null,
};

/** Portal energy stand-in with the real portal's filter rules; counts calls. */
const energyCalls: (string | null)[] = [];
let energyFailure: Error | null = null;
const energySource = {
  fetchReadings: async (meterId: string, days: PortalDayRange | null) => {
    energyCalls.push(days === null ? null : `${days.from}..${days.to}`);
    if (energyFailure !== null) throw energyFailure;
    return filterEnergy(generateEnergy(meterId), new URLSearchParams(days === null ? {} : { ...days }));
  },
};

function build(overrides: Partial<ApiContext["catalog"]> = {}, rateLimitPerMinute = 1_000) {
  const context: ApiContext = {
    readings: new ReadingsService({ source: energySource, now: () => NOW }),
    catalog: {
      read: async () => ({ snapshot, ageMs: 90_000, stale: false }),
      status: () => loadedStatus,
      ...overrides,
    },
    startedAt: NOW - 5_000,
    now: () => NOW,
  };
  return createApp({ context, apiKeys: [{ name: "tests", key: KEY }], rateLimitPerMinute });
}

const { app, openApi } = build();
const get = (path: string) => request(app).get(path).set("authorization", `Bearer ${KEY}`);

/** Every 200 must match the schema the OpenAPI document promises. */
function expectShape<T extends z.ZodType>(schema: T, body: unknown): z.output<T> {
  const result = schema.safeParse(body);
  if (!result.success) throw new Error(JSON.stringify(result.error.issues.slice(0, 3), null, 2));
  return result.data;
}

describe("operations routes (public)", () => {
  it("GET /health needs no key", async () => {
    const res = await request(app).get("/health").expect(200);
    expect(expectShape(s.healthResponse, res.body)).toEqual({ status: "ok", uptimeSeconds: 5 });
  });

  it("GET /ready reports freshness, and 503 until the catalog is loaded", async () => {
    const ready = await request(app).get("/ready").expect(200);
    expect(expectShape(s.readyResponse, ready.body).catalog).toMatchObject({ loaded: true, ageSeconds: 90 });

    const cold = build({
      status: () => ({ ...loadedStatus, loaded: false, meterCount: 0, fetchedAt: null, ageMs: null }),
    });
    const res = await request(cold.app).get("/ready").expect(503);
    expect(res.body.ready).toBe(false);
  });

  it("serves openapi.json and the Swagger UI", async () => {
    await request(app).get("/openapi.json").expect(200).expect("content-type", /json/);
    const docs = await request(app).get("/docs/").expect(200);
    expect(docs.text).toContain("swagger-ui");
  });

  it("does not force https for sub-resources, so /docs works behind plain HTTP", async () => {
    const docs = await request(app).get("/docs/").expect(200);
    expect(docs.headers["content-security-policy"]).toBeDefined();
    expect(docs.headers["content-security-policy"]).not.toContain("upgrade-insecure-requests");
  });
});

describe("authentication", () => {
  it("rejects a missing key with a problem+json 401", async () => {
    const res = await request(app).get("/v1/meters").expect(401);
    expect(res.headers["content-type"]).toMatch(/application\/problem\+json/);
    expect(res.headers["www-authenticate"]).toMatch(/Bearer/);
    expect(JSON.parse(res.text)).toMatchObject({ status: 401, code: "unauthorized" });
  });

  it("rejects a wrong key", async () => {
    await request(app).get("/v1/meters").set("authorization", "Bearer wrong-key-0123456789abcdef").expect(401);
  });

  it("accepts the key as Bearer or as X-API-Key", async () => {
    await get("/v1/meters").expect(200);
    await request(app).get("/v1/meters").set("x-api-key", KEY).expect(200);
  });
});

describe("/v1/meters", () => {
  it("lists meters with paging, facets and freshness", async () => {
    const res = await get("/v1/meters?limit=5").expect(200);
    const body = expectShape(s.meterListResponse, res.body);

    expect(body.data).toHaveLength(5);
    expect(body.page).toEqual({ total: 14, limit: 5, offset: 0 });
    expect(body.meta).toMatchObject({ ageSeconds: 90, stale: false });
    expect(res.headers["x-data-age"]).toBe("90");
    expect(res.headers["x-request-id"]).toBeDefined();
  });

  it("treats ?status=a,b and ?status=a&status=b the same", async () => {
    const csv = await get("/v1/meters?status=faulty,installed&limit=500").expect(200);
    const repeated = await get("/v1/meters?status=faulty&status=installed&limit=500").expect(200);
    expect(repeated.body.data).toEqual(csv.body.data);
    expect(csv.body.data.every((m: { status: string }) => ["faulty", "installed"].includes(m.status))).toBe(true);
  });

  it("filters by transformer and by network subtree", async () => {
    const byDt = await get("/v1/meters?transformer=DT-007").expect(200);
    expect(byDt.body.page.total).toBe(5);

    const node = meters.find((m) => m.id === "J100400")!.network.path.split(".").slice(0, 2).join(".");
    const byNode = await get(`/v1/meters?node=${node}&limit=500`).expect(200);
    expect(byNode.body.data.every((m: { network: { path: string } }) => m.network.path.startsWith(`${node}.`))).toBe(true);
  });

  it("returns 400 with the offending parameter for bad input", async () => {
    const res = await get("/v1/meters?status=broken&limit=0").expect(400);
    const problem = JSON.parse(res.text);
    expect(problem.code).toBe("invalid_request");
    expect(problem.errors.map((e: { path: string }) => e.path).sort()).toEqual(["query.limit", "query.status.0"]);
  });

  it("answers an unchanged list with 304 when the client sends its ETag", async () => {
    const first = await get("/v1/meters?limit=3").expect(200);
    await get("/v1/meters?limit=3").set("if-none-match", first.headers.etag!).expect(304);
  });

  it("returns GeoJSON with [lng, lat] points", async () => {
    const res = await get("/v1/meters.geojson?status=faulty").expect(200);
    expect(res.headers["content-type"]).toMatch(/application\/geo\+json/);
    const body = expectShape(s.meterGeoJsonResponse, res.body);
    const first = body.features[0]!;
    const meter = meters.find((m) => m.id === first.id)!;
    expect(first.geometry.coordinates).toEqual([meter.location.lng, meter.location.lat]);
  });
});

describe("/v1/meters/:meterId", () => {
  it("returns one meter with its transformer, case-insensitively", async () => {
    const res = await get("/v1/meters/j100400").expect(200);
    const body = expectShape(s.meterResponse, res.body);
    expect(body.data.id).toBe("J100400");
    expect(body.data.transformer).toMatchObject({ code: "DT-007", name: "Sanganer DT 7", capacityKva: 100 });
    expect(body.data.issues.map((i) => i.code)).toEqual(["transformer_name_conflict"]);
  });

  it("404s an unknown meter and 400s a malformed id", async () => {
    const missing = await get("/v1/meters/J999999").expect(404);
    expect(JSON.parse(missing.text)).toMatchObject({ code: "not_found", detail: "Meter J999999 does not exist" });
    await get("/v1/meters/not-a-meter").expect(400);
  });
});

describe("network routes", () => {
  it("lists and sorts transformers, and finds them by alias", async () => {
    const list = expectShape(s.transformerListResponse, (await get("/v1/transformers?sort=meterCount&order=desc").expect(200)).body);
    expect(list.data[0]?.code).toBe("DT-007");

    const byAlias = await get("/v1/transformers?q=malviya%20nagar%20xfmr").expect(200);
    expect(byAlias.body.data.map((t: { code: string }) => t.code)).toEqual(["DT-007"]);
  });

  it("returns a transformer with its meters", async () => {
    const body = expectShape(s.transformerResponse, (await get("/v1/transformers/dt-007").expect(200)).body);
    expect(body.data.meters).toHaveLength(5);
    expect(Object.values(body.data.statusCounts).reduce((a, b) => a + b, 0)).toBe(5);
  });

  it("returns the tree, trimmed to the requested depth", async () => {
    const body = expectShape(s.hierarchyResponse, (await get("/v1/hierarchy?depth=1").expect(200)).body);
    expect(body.data.every((zone) => zone.level === "zone" && zone.children === undefined)).toBe(true);
    expect(body.data.reduce((sum, zone) => sum + zone.meterCount, 0)).toBe(14);
  });

  it("drills into a node by its dotted id, with breadcrumb and children", async () => {
    const path = meters.find((m) => m.id === "J100400")!.network.path; // Z-01.C-01.D-07....
    const division = path.split(".").slice(0, 3).join(".");
    const body = expectShape(s.hierarchyNodeResponse, (await get(`/v1/hierarchy/${division}`).expect(200)).body);

    expect(body.data).toMatchObject({ id: division, level: "division" });
    expect(body.data.breadcrumb.map((b) => b.level)).toEqual(["zone", "circle"]);
    expect(body.data.children.every((c) => c.level === "subdivision")).toBe(true);
    expect(body.data.page.total).toBe(body.data.meterCount);

    await get("/v1/hierarchy/Z-99.C-99").expect(404);
  });
});

describe("search, stats, quality", () => {
  it("searches meters, transformers and nodes together", async () => {
    const body = expectShape(s.searchResponse, (await get("/v1/search?q=sanganer").expect(200)).body);
    expect(body.data.transformers.map((t) => t.code)).toEqual(["DT-007"]);

    const meterHit = expectShape(s.searchResponse, (await get("/v1/search?q=j10040").expect(200)).body);
    expect(meterHit.data.meters.map((m) => m.id)).toEqual(["J100400", "J100401", "J100402"]);
  });

  it("requires a search term", async () => {
    await get("/v1/search").expect(400);
  });

  it("returns fleet stats, optionally grouped", async () => {
    const body = expectShape(s.statsResponse, (await get("/v1/stats?groupBy=zone").expect(200)).body);
    expect(body.data.meters).toBe(14);
    expect(Object.values(body.data.byStatus).reduce((a, b) => a + b, 0)).toBe(14);
    expect(body.data.groupedBy?.field).toBe("zone");
    expect(body.data.totalCapacityKva).toBe(100 * transformers.filter((t) => t.capacityKva !== null).length);
  });

  it("reports data quality, including the DT-007 name conflict", async () => {
    const body = expectShape(s.qualityResponse, (await get("/v1/quality").expect(200)).body);
    expect(body.data.transformerNameConflicts).toEqual([
      { code: "DT-007", canonicalName: "Sanganer DT 7", aliases: ["Old Malviya Nagar Xfmr"] },
    ]);
    expect(body.data.summary.issuesByCode).toMatchObject({ network_cell_repaired: 2, transformer_name_conflict: 3 });
  });
});

describe("errors and limits", () => {
  it("maps an unreachable portal to 503 with Retry-After", async () => {
    const down = build({ read: async () => { throw new PortalUnavailableError("timeout"); } });
    const res = await request(down.app).get("/v1/meters").set("authorization", `Bearer ${KEY}`).expect(503);
    expect(res.headers["retry-after"]).toBe("30");
    expect(JSON.parse(res.text).code).toBe("upstream_unavailable");
  });

  it("maps a failed portal login to 502, never 401", async () => {
    const broken = build({ read: async () => { throw new PortalAuthError("bad password"); } });
    const res = await request(broken.app).get("/v1/meters").set("authorization", `Bearer ${KEY}`).expect(502);
    expect(JSON.parse(res.text).code).toBe("upstream_auth_failed");
    expect(res.text).not.toContain("bad password"); // internal detail stays in the logs
  });

  it("answers unknown routes with a problem, not an HTML page", async () => {
    const res = await request(app).get("/v2/nothing").expect(404);
    expect(res.headers["content-type"]).toMatch(/problem\+json/);
  });

  it("rate-limits per consumer with a 429 problem", async () => {
    const limited = build({}, 2);
    const call = () => request(limited.app).get("/v1/stats").set("authorization", `Bearer ${KEY}`);
    await call().expect(200);
    await call().expect(200);
    const res = await call().expect(429);
    expect(JSON.parse(res.text).code).toBe("rate_limited");
    expect(res.headers["ratelimit-policy"]).toBeDefined();
  });
});

describe("OpenAPI document", () => {
  const paths = openApi.paths as Record<string, Record<string, { operationId: string; security?: unknown[]; parameters: { name: string; in: string }[] }>>;

  it("documents every route with an operationId", () => {
    expect(Object.keys(paths).sort()).toEqual([
      "/health",
      "/ready",
      "/v1/anomalies",
      "/v1/export/meters",
      "/v1/export/readings",
      "/v1/hierarchy",
      "/v1/hierarchy/{nodeId}",
      "/v1/meters",
      "/v1/meters.geojson",
      "/v1/meters/nearby",
      "/v1/meters/{meterId}",
      "/v1/meters/{meterId}/anomalies",
      "/v1/meters/{meterId}/readings",
      "/v1/quality",
      "/v1/search",
      "/v1/stats",
      "/v1/transformers",
      "/v1/transformers/{code}",
      "/v1/transformers/{code}/load",
    ]);
    for (const operations of Object.values(paths)) {
      expect(operations.get?.operationId).toBeTruthy();
    }
  });

  it("marks public routes as needing no key and documents query parameters", () => {
    expect(paths["/health"]?.get?.security).toEqual([]);
    expect(paths["/v1/meters"]?.get?.security).toBeUndefined(); // inherits the global key requirement
    const names = paths["/v1/meters"]?.get?.parameters.map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(["status", "transformer", "node", "limit", "offset"]));
    expect(paths["/v1/meters/{meterId}"]?.get?.parameters).toEqual([
      expect.objectContaining({ name: "meterId", in: "path" }),
    ]);
  });
});

describe("GET /v1/meters/{id}/readings", () => {
  const readings = (query: string, target = app) =>
    request(target).get(`/v1/meters/J100000/readings${query}`).set("authorization", `Bearer ${KEY}`);

  it("default: the 7 days ending at the newest reading, half-hourly, IST timestamps", async () => {
    const res = await readings("").expect(200);
    const body = expectShape(s.readingsResponse, res.body);
    expect(body.data.window).toEqual({ from: "2026-06-23T23:30:00+05:30", to: "2026-06-30T23:30:00+05:30" });
    expect(body.data.items).toHaveLength(336);
    expect(body.data.items[0]).toMatchObject({
      timestamp: "2026-06-24T00:00:00+05:30",
      intervalStart: "2026-06-23T23:30:00+05:30",
    });
    expect(body.data.summary).toMatchObject({ intervals: 336, expectedIntervals: 336 });
    expect(body.data.issues).toEqual([]);
    expect(body.meta).toMatchObject({ stale: false, maxAgeSeconds: 3600, latestReadingAt: "2026-06-30T23:30:00+05:30" });
    expect(res.headers["cache-control"]).toBe("private, max-age=3600");
  });

  it("day totals equal the sum of the half-hours, and a date-only `to` includes that day", async () => {
    const raw = expectShape(s.readingsResponse, (await readings("?from=2026-06-28&to=2026-06-29").expect(200)).body);
    const days = expectShape(s.readingsResponse, (await readings("?from=2026-06-28&to=2026-06-29&granularity=day").expect(200)).body);
    expect(raw.data.items).toHaveLength(96);
    expect(days.data.items).toHaveLength(2);
    const rawSum = (raw.data.items as { intervalKwh: number | null }[]).reduce((sum, item) => sum + (item.intervalKwh ?? 0), 0);
    const daySum = (days.data.items as { kwh: number | null }[]).reduce((sum, item) => sum + (item.kwh ?? 0), 0);
    expect(daySum).toBeCloseTo(rawSum, 6);
    expect(days.data.summary.totalKwh).toBeCloseTo(rawSum, 6);
    expect(days.data.items[0]).toMatchObject({ start: "2026-06-28T00:00:00+05:30", complete: true, intervals: 48 });
  });

  it("accepts date-times, including a '+' that arrived as a space", async () => {
    const body = expectShape(
      s.readingsResponse,
      (await readings("?from=2026-06-29T10:00:00+05:30&to=2026-06-29T12:00&granularity=hour").expect(200)).body,
    );
    expect(body.data.items.map((item) => (item as { start: string }).start)).toEqual([
      "2026-06-29T10:00:00+05:30",
      "2026-06-29T11:00:00+05:30",
    ]);
  });

  it("validates the window before calling the portal", async () => {
    const before = energyCalls.length;
    for (const query of ["?from=2026-06-30&to=2026-06-29", "?from=2026-05-01&to=2026-06-30", "?from=29/06/2026", "?granularity=week"]) {
      const res = await readings(query).expect(400);
      expect(res.body.code).toBe("invalid_request");
    }
    expect(energyCalls.length).toBe(before);
  });

  it("answers an unknown meter from the catalog with 404, without a portal call", async () => {
    const before = energyCalls.length;
    const res = await request(app).get("/v1/meters/J999999/readings").set("x-api-key", KEY).expect(404);
    expect(res.body.code).toBe("not_found");
    expect(energyCalls.length).toBe(before);
  });

  it("caches: a second request for the same days is a hit", async () => {
    const fresh = build().app;
    await readings("?from=2026-06-10&to=2026-06-10", fresh).expect(200).expect("x-cache", "MISS");
    await readings("?from=2026-06-10T06:00&to=2026-06-10T23:45", fresh).expect(200).expect("x-cache", "HIT");
  });

  it("maps a portal outage to 503 when nothing is cached", async () => {
    energyFailure = new PortalUnavailableError("down");
    try {
      const res = await readings("?from=2026-06-02&to=2026-06-02", build().app).expect(503);
      expect(res.headers["retry-after"]).toBe("30");
    } finally {
      energyFailure = null;
    }
  });
});

describe("GET /v1/meters/nearby", () => {
  it("returns meters nearest first, starting with the one at the centre", async () => {
    // J100000's exact location.
    const res = await get("/v1/meters/nearby?lat=26.938961002479868&lng=75.83095696146852&radiusM=10000").expect(200);
    const body = expectShape(s.nearbyResponse, res.body);
    expect(body.data[0]).toMatchObject({ distanceM: 0, meter: { id: "J100000" } });
    const distances = body.data.map((d) => d.distanceM);
    expect(distances).toEqual([...distances].sort((a, b) => a - b));
    expect(distances.every((d) => d <= 10_000)).toBe(true);
  });

  it("filters by status, and is not mistaken for a meter ID", async () => {
    const res = await get("/v1/meters/nearby?lat=26.9&lng=75.8&radiusM=50000&status=installed").expect(200);
    expect(res.body.data.every((d: { meter: { status: string } }) => d.meter.status === "installed")).toBe(true);
    await get("/v1/meters/nearby?lat=126&lng=75.8").expect(400);
    await get("/v1/meters/nearby").expect(400);
  });
});

describe("anomalies", () => {
  it("GET /v1/meters/{id}/anomalies: a decommissioned meter that still consumes is critical", async () => {
    const res = await get("/v1/meters/J100000/anomalies?from=2026-06-20&to=2026-06-26").expect(200);
    const body = expectShape(s.meterAnomaliesResponse, res.body);
    expect(body.data.window).toEqual({ from: "2026-06-20T00:00:00+05:30", to: "2026-06-27T00:00:00+05:30" });
    expect(body.data.anomalies).toContainEqual(expect.objectContaining({ code: "decommissioned_but_consuming", severity: "critical" }));
  });

  it("GET /v1/anomalies?transformer=DT-007 scans that DT's meters, most severe first", async () => {
    const res = await get("/v1/anomalies?transformer=DT-007&from=2026-06-20&to=2026-06-21").expect(200);
    const body = expectShape(s.anomalyScanResponse, res.body);
    expect(body.data.metersScanned).toBe(5);
    expect(body.data.anomalies[0]?.severity).toBe("critical");
    expect(body.data.counts.byCode.decommissioned_but_consuming).toBe(2); // J100006 and J100046
    const filtered = await get("/v1/anomalies?transformer=DT-007&from=2026-06-20&to=2026-06-21&severity=critical").expect(200);
    expect(filtered.body.data.anomalies.every((a: { severity: string }) => a.severity === "critical")).toBe(true);
  });

  it("needs exactly one scope and known meters", async () => {
    await get("/v1/anomalies").expect(400);
    await get("/v1/anomalies?transformer=DT-007&meterIds=J100000").expect(400);
    const res = await get("/v1/anomalies?meterIds=J100000,J999999").expect(400);
    expect(res.body.detail).toMatch(/J999999/);
  });

  it("GET /v1/transformers/{code}/load compares summed demand with the rating", async () => {
    const res = await get("/v1/transformers/DT-007/load?from=2026-06-20&to=2026-06-20").expect(200);
    const body = expectShape(s.transformerLoadResponse, res.body);
    expect(body.data.points).toHaveLength(48);
    expect(body.data.metersReporting).toBe(5);
    expect(body.data.peak?.metersReporting).toBe(5);
    expect(body.data.peakUtilisationPercent).toBe(
      Math.round((body.data.peak!.kva / body.data.capacityKva!) * 1000) / 10,
    );
    await get("/v1/transformers/DT-999/load").expect(404);
  });
});

describe("CORS", () => {
  const withCors = createApp({
    context: {
      catalog: { read: async () => ({ snapshot, ageMs: 0, stale: false }), status: () => loadedStatus },
      readings: new ReadingsService({ source: energySource, now: () => NOW }),
      startedAt: NOW,
      now: () => NOW,
    },
    apiKeys: [{ name: "tests", key: KEY }],
    rateLimitPerMinute: 1_000,
    corsOrigins: ["http://localhost:5173"],
  }).app;

  it("answers a preflight without a key, for allowed origins only", async () => {
    const ok = await request(withCors)
      .options("/v1/meters")
      .set("origin", "http://localhost:5173")
      .set("access-control-request-headers", "x-api-key")
      .expect(204);
    expect(ok.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    expect(ok.headers["access-control-allow-headers"]).toMatch(/x-api-key/);
    const other = await request(withCors).get("/health").set("origin", "https://evil.example").expect(200);
    expect(other.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("exposes the freshness headers to the browser", async () => {
    const res = await request(withCors).get("/v1/meters?limit=1").set("origin", "http://localhost:5173").set("x-api-key", KEY).expect(200);
    expect(res.headers["access-control-expose-headers"]).toMatch(/x-data-age/);
  });

  it("is off by default", async () => {
    const res = await get("/v1/meters?limit=1").set("origin", "http://localhost:5173").expect(200);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("bulk export", () => {
  it("GET /v1/export/meters returns every match as flat rows, without paging", async () => {
    const all = await get("/v1/meters?status=faulty&limit=500").expect(200);
    const res = await get("/v1/export/meters?status=faulty").expect(200);
    const body = expectShape(s.meterExportResponse, res.body);
    expect(body.data.count).toBe(all.body.page.total);
    expect(body.data.rows).toHaveLength(body.data.count);
    const row = body.data.rows[0]!;
    expect(row.status).toBe("faulty");
    expect(row.transformerCode).toMatch(/^DT-\d{3}$/);
    expect(row.networkPath).toContain(row.zoneCode);
  });

  it("format=csv sends a CSV download with one line per meter", async () => {
    const res = await get("/v1/export/meters?transformer=DT-007&format=csv").expect(200);
    expect(res.headers["content-type"]).toMatch(/^text\/csv/);
    expect(res.headers["content-disposition"]).toMatch(/^attachment; filename="?urja-meters\.csv"?$/);
    const lines = res.text.trimEnd().split("\r\n");
    expect(lines[0]).toMatch(/^id,serialNumber,make,phase,status,/);
    expect(lines[0]).toContain("transformerCapacityKva");
    expect(lines).toHaveLength(1 + 5); // header + DT-007's 5 meters
  });

  it("GET /v1/export/readings returns long-format rows for every meter in scope", async () => {
    const res = await get("/v1/export/readings?transformer=DT-007&from=2026-06-20&to=2026-06-20&granularity=hour").expect(200);
    const body = expectShape(s.readingsExportResponse, res.body);
    expect(body.data.meters).toBe(5);
    expect(body.data.failed).toEqual([]);
    expect(body.data.count).toBe(5 * 24);
    expect(new Set(body.data.rows.map((r) => r.meterId)).size).toBe(5);
    expect(body.data.rows[0]).toMatchObject({ start: "2026-06-20T00:00:00+05:30", end: "2026-06-20T01:00:00+05:30", expectedIntervals: 2 });
  });

  it("raw granularity keeps the registers; CSV has the same rows", async () => {
    const json = await get("/v1/export/readings?meterIds=J100000&from=2026-06-20&to=2026-06-20&granularity=raw").expect(200);
    expect(json.body.data.count).toBe(48);
    expect(json.body.data.rows[0].kwhRegister).toEqual(expect.any(Number));
    const csv = await get("/v1/export/readings?meterIds=J100000&from=2026-06-20&to=2026-06-20&granularity=raw&format=csv").expect(200);
    expect(csv.headers["content-disposition"]).toMatch(/urja-readings-meters-raw\.csv/);
    expect(csv.text.trimEnd().split("\r\n")).toHaveLength(1 + 48);
  });

  it("uses the same scope rules as the anomaly scan", async () => {
    await get("/v1/export/readings").expect(400);
    await get("/v1/export/readings?transformer=DT-007&node=Z-01").expect(400);
    await get("/v1/export/readings?meterIds=J999999").expect(400);
    await get("/v1/export/readings?transformer=DT-999").expect(404);
  });

  it("is listed in the OpenAPI document with a CSV alternative", () => {
    const op = (openApi as { paths: Record<string, { get: { tags: string[]; responses: Record<string, { content: object }> } }> })
      .paths["/v1/export/meters"]!.get;
    expect(op.tags).toEqual(["Bulk export"]);
    expect(Object.keys(op.responses["200"]!.content)).toEqual(["application/json", "text/csv"]);
  });
});
