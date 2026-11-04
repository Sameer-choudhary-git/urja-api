# Testing guide

A module-by-module checklist to verify the whole system by hand: what to run,
what you should see, and which file is responsible. Work top to bottom; each
part builds on the one before.

Shell: the commands are written for **Git Bash** on Windows (or any bash).
In PowerShell use `curl.exe` instead of `curl`, and `$env:NAME="value"`
instead of `NAME=value`.

Expected values below come from the real export (403 meters). Energy readings
in offline mode are synthetic, so kWh numbers differ from the live portal;
shapes and rules are the same.

---

## 0. Setup

```bash
cd urja-api
node -v                  # v20.6 or newer (v22 recommended)
npm ci
cp .env.example .env     # first time only; fill PORTAL_EMAIL, PORTAL_PASSWORD, API_KEYS
```

| Check | Expected |
|---|---|
| `npm run typecheck` | no output, exit code 0 |
| `npm test` | `Test Files 23 passed`, `Tests 225 passed`, no network calls |
| `npm run build` | creates `dist/`, no errors |

The tests run against an in-process fake portal (`test/helpers/fakePortal.ts`)
built from PROTOCOL.md. Run one file with `npx vitest run test/domain/readings.test.ts`.

| Test file | What it proves |
|---|---|
| `test/portal/*` | login and cookies, session reuse and renewal, 401 re-login, retries, timeouts, HMAC signing, export, energy filter, fallback + devalue |
| `test/domain/*` | normalization and repairs, IST time handling, interval kWh and rollups, anomaly rules |
| `test/catalog/*` | snapshot indexes and filters, freshness (TTL, stale-while-revalidate, stale-if-error), export → fallback switch |
| `test/readings/*`, `test/shared/*` | window rules, portal day mapping, data-age TTL, cache, circuit breaker, limiter |
| `test/geo/*` | grid index returns exactly what a full scan returns |
| `test/chaos.test.ts` | the whole stack against a portal failing 30% of the time, and one that goes down and comes back |
| `test/http/app.test.ts` | every route end to end, auth, errors, ETag/304, CORS, every response checked against its schema |
| `test/config.test.ts` | env validation fails fast and never echoes secrets |

---

## 1. Portal adapter (live, read-only)

Needs `.env` with the portal account. These scripts never print secrets.

| Command | Expected | Module |
|---|---|---|
| `npm run smoke` | "Logged in. The portal reports 403 meters", the first meter id, "Smoke test passed" | `portal/authenticator.ts`, `session.ts`, `portalClient.ts` |
| `npm run fetch-export` | writes `fixtures/local/meter-export.json` with 403 meters | `portal/signing.ts`, `exportApi.ts` |
| `npm run scan -- fixtures/local/meter-export.json` | 403 meters, 0 duplicate IDs, 22 blank hierarchy cells (all repairable), DT-007 with two names | `quality/scanExport.ts` |
| `npm run probe` | signing secret fingerprint identical across calls and logins; energy filter is whole days inclusive; history 1–30 June 2026 | `scripts/probe.ts` |
| `npm run verify -- --all` (API running: `npm run dev`, or `-- --api http://<EC2_IP>`) | `✓ meter IDs: portal 403, API 403`, `0 unexplained` meter and transformer differences (about 25 explained: repaired blank hierarchy cells and the DT-007 alias), `portal rows missing in the API: 0`, `interval usage adds up to the register change: 403/403`, the reading cadence (how many meters are read once a day), then `✓ PASS` | `quality/parity.ts`, `scripts/verify-parity.ts` |
| `npm run cross-check` | 39 of 40 sampled meters identical; J100370 differs only in Circle (blank on the page) | `quality/crossCheck.ts`, `portal/fallbackApi.ts` |
| `npm run dump-page -- J100020` | decoded page data with the `classData` shape | `portal/devalue.ts` |

What to understand here: the session is created lazily on the first call and
shared (`session.ts`); a 401 triggers exactly one re-login; the export signs
`timestamp` with the secret from `/portal/keys` (PROTOCOL 3.6).

---

## 2. Server start, health and docs

```bash
npm run dev               # real portal
# or, without portal access:
npm run dev:offline       # auth is off in this mode
```

| Check | Expected |
|---|---|
| Log line `http.listening` | port 3000 opens immediately |
| `curl localhost:3000/health` | `200 {"status":"ok","uptimeSeconds":N}` |
| `curl localhost:3000/ready` | `503` for a moment, then `200` with `catalog.loaded: true`, `meterCount: 403`, `portal.circuit: "closed"` |
| Open http://localhost:3000/docs | Swagger UI with all routes; `/` redirects there |
| `curl localhost:3000/openapi.json` | OpenAPI 3.1 JSON, same as the committed `openapi.json` |

Module: `main.ts` (warm-up, graceful shutdown), `http/app.ts`.

Graceful shutdown: press Ctrl+C. Expect `http.shutting_down` and a clean exit
within 10 seconds.

---

## 3. Auth, rate limit, errors (needs `npm run dev` or Docker, not offline)

```bash
KEY=<the part after "web:" in API_KEYS>
B=localhost:3000
```

| Request | Expected | Module |
|---|---|---|
| `curl -i $B/v1/meters` | `401`, `application/problem+json`, `code: "unauthorized"` | `http/middleware.ts` apiKeyAuth |
| `curl -i -H "X-API-Key: wrong" $B/v1/meters` | `401` | same |
| `curl -i -H "X-API-Key: $KEY" $B/v1/meters` | `200` | same |
| `curl -i -H "Authorization: Bearer $KEY" $B/v1/meters` | `200` (both header styles work) | same |
| any `/v1` response headers | `RateLimit` and `RateLimit-Policy` headers | perConsumerRateLimit |
| `curl -i -H "X-Request-Id: test-123" -H "X-API-Key: $KEY" $B/v1/stats` | response has `x-request-id: test-123` and the log line has `requestId: "test-123"` | requestId |

Errors (also work in offline mode, drop the key header there):

| Request | Expected |
|---|---|
| `/v1/meters/J999999` | `404`, `code: "not_found"`, `detail: "Meter J999999 does not exist"` |
| `/v1/meters?status=broken` | `400`, `code: "invalid_request"`, `errors[0].path: "query.status.0"` |
| `/v1/meters/J100013/readings?from=2026-02-31` | `400` on `query.from` (an impossible date is rejected, not rolled over) |
| `/v1/meters/J100013/readings?from=2026-06-01&to=2026-07-15` | `400`, "A window can be at most 31 days" |
| `/v1/anomalies` | `400`, "Give exactly one of transformer, node or meterIds" |
| `/v1/nope` | `404`, "No route for GET /v1/nope" |

Every error body has `type`, `title`, `status`, `code`, `detail` and
`requestId` (RFC 9457). Module: `http/problem.ts`.

---

## 4. Catalog routes

Add `-H "X-API-Key: $KEY"` when auth is on.

| Request | Expected |
|---|---|
| `/v1/meters?limit=2` | `data` (2 meters), `page.total: 403`, `facets`, `meta.source: "export"` |
| `/v1/meters?status=faulty&transformer=DT-007&limit=1` | J100126, `page.total: 3` (the README sample) |
| `/v1/meters?status=faulty,decommissioned&limit=1` | `page.total: 165` (90 + 75) |
| `/v1/meters?hasIssues=true&limit=1` | `page.total: 25` |
| `/v1/meters/J100007` | one meter with full `network` and `path` |
| `/v1/meters.geojson?limit=1` | `type: "FeatureCollection"`, coordinates as `[lng, lat]` |
| `/v1/transformers/DT-007` | name "Sanganer DT 7", alias "Old Malviya Nagar Xfmr", 13 meters |
| `/v1/hierarchy?depth=1` | zones with `meterCount` and `statusCounts` |
| `/v1/hierarchy/Z-01.C-01` | breadcrumb, children, paged meters |
| `/v1/search?q=sanganer` | transformers DT-007, DT-017, DT-027, DT-037 |
| `/v1/stats?groupBy=status` | 403 meters, 40 transformers, installed 238, faulty 90, decommissioned 75 |
| `/v1/quality` | 25 meters with issues: 22 `network_cell_repaired`, 3 `transformer_name_conflict` |

ETag / 304:

```bash
E=$(curl -sI $B/v1/meters/J100007 | grep -i etag | cut -d' ' -f2 | tr -d '\r')
curl -s -o /dev/null -w '%{http_code}\n' -H "If-None-Match: $E" $B/v1/meters/J100007   # 304
```

Modules: `domain/normalize.ts`, `cellRepair.ts`, `networkTree.ts`,
`catalog/catalogSnapshot.ts`, `catalogService.ts`.

---

## 5. Readings

| Request | Expected |
|---|---|
| `/v1/meters/J100013/readings?from=2026-06-29&to=2026-06-29&granularity=day` | one day bucket, `summary.intervals: 48`, `expectedIntervals: 48`, `powerFactor` = kWh ÷ kVAh |
| same with `granularity=hour` | 24 buckets, their kWh adds up to the day's kWh |
| `?from=2026-06-29T10:00&to=2026-06-29T11:00` | 2 raw half hours: 10:30 and 11:00 (each reading closes the half hour before it) |
| no `from`/`to` | the 7 days ending at the newest reading (`window` 2026-06-23T23:30 to 2026-06-30T23:30) |
| request the same URL twice | first `X-Cache: MISS`, then `HIT`; `Cache-Control: private, max-age≈3600` (old data → 1 h) |
| all times in the body | ISO with `+05:30` |

Dry-run check by hand: pick two consecutive raw readings, subtract the `kwh`
registers, and compare with `intervalKwh`.

Modules: `domain/time.ts`, `domain/readings.ts`, `readings/readingsService.ts`,
`shared/ttlCache.ts`, `portal/energyApi.ts`.

---

## 6. Nearby, anomalies, transformer load

| Request | Expected |
|---|---|
| `/v1/meters/nearby?lat=26.9124&lng=75.7873&radiusM=2000&limit=2` | `data[]` of `{ distanceM, meter }`, nearest first |
| `npm run bench:nearby` | grid faster than full scan at every size (11x to 60x) |
| `/v1/meters/J100000/anomalies?from=2026-06-24&to=2026-06-30` | `decommissioned_but_consuming` (critical): J100000 is decommissioned yet consumed |
| `/v1/anomalies?transformer=DT-007&from=2026-06-24&to=2026-06-30` | `metersScanned: 13`, `counts` by severity and code, `anomalies` most severe first, `failed: []` |
| `/v1/anomalies?meterIds=J100000,J100001&severity=critical` | only critical anomalies |
| `/v1/transformers/DT-007/load?from=2026-06-29&to=2026-06-29` | 48 points, `capacityKva: 160`, `peak`, `peakUtilisationPercent`, `metersReporting: 13` |

Rule thresholds are in `domain/anomalies.ts` (`THRESHOLDS`). Modules:
`geo/spatialGrid.ts`, `domain/anomalies.ts`, `anomalies/anomalyService.ts`.

### Bulk export

| Request | Expected |
|---|---|
| `/v1/export/meters?status=faulty` | `data.count` equals `page.total` of `/v1/meters?status=faulty`; every row flat (`zoneCode`, `zoneName`, ... `transformerCapacityKva`, `issueCodes`) |
| `/v1/export/meters?transformer=DT-007&format=csv` | `Content-Type: text/csv`, `Content-Disposition: attachment; filename=urja-meters.csv`, header line + 13 rows; opens in Excel |
| `/v1/export/readings?transformer=DT-007&from=2026-06-29&to=2026-06-29&granularity=hour` | `meters: 13`, `count: 13 x 24 = 312`, `failed: []` |
| `/v1/export/readings?meterIds=J100000&from=2026-06-29&to=2026-06-29&granularity=raw&format=csv` | header + 48 rows, with `kwhRegister` and `kvahRegister` |
| `/v1/export/readings` (no scope) | 400, same scope rules as `/v1/anomalies` |

In Swagger the routes are under the **Bulk export** tag; for `format=csv`
Swagger shows a "Download file" link. With curl add `-OJ` to save the file
under the server's name. Modules: `api/routes.ts` (`exportMeters`,
`exportReadings`, `meterRow`), `api/csv.ts` (RFC 4180 writer, CSV-injection
guard), `http/routeRegistry.ts` (`RawBody`, `alsoProduces`).

---

## 7. Resilience

| Scenario | How | Expected |
|---|---|---|
| Fallback data source | `OFFLINE_BREAK_EXPORT=1 npm run dev:offline` | logs show the export failing and the fallback loading 403 meters (about 830 portal calls); `/v1/meters` has `meta.source: "fallback"` and `X-Data-Source: fallback` |
| Portal down at boot | in `.env` set `PORTAL_BASE_URL=http://127.0.0.1:9` and `npm run dev` | port opens, `/health` 200, `/ready` 503, logs `catalog.warmup_retry` with growing delays |
| Circuit breaker | same setup, call `/v1/meters` a few times and watch `/ready` | `503` problem+json each time; after 5 failed portal calls `/ready` shows `portal.circuit: "open"` and calls fail at once with `Retry-After` until the 30 s trial |
| Chaos | `npx vitest run test/chaos.test.ts` | passes: 30% failures with random latency, and a portal that goes down and comes back |

Undo the `PORTAL_BASE_URL` change afterwards. Modules:
`shared/circuitBreaker.ts`, `concurrencyLimiter.ts`, `portal/portalClient.ts`,
`catalog/portalCatalogLoader.ts`.

---

## 8. Docker and the gateway

Needs Docker Desktop.

```bash
docker compose up -d --build
docker compose ps                     # api: healthy, gateway: up
```

| Check | Expected |
|---|---|
| `curl -i localhost/health` | `200` through nginx |
| `curl -i localhost/ready` | `200` once the catalog loads |
| `curl -i -H "X-API-Key: $KEY" localhost/v1/stats` | `200`, has `x-request-id` |
| `curl -i -X POST localhost/v1/meters` | `405`, `application/problem+json` (nginx allows only GET/HEAD/OPTIONS) |
| `for i in $(seq 1 80); do curl -s -o /dev/null -w '%{http_code} ' localhost/v1/stats; done` | some `429` (nginx: 20 r/s, burst 40) |
| `docker compose exec api id` | `uid=1000(node)`: not root |
| `docker compose exec api touch /app/x` | fails: read-only filesystem |
| `docker stats --no-stream` | api well under its 768 MB limit (about 60–100 MB) |
| `docker compose logs api` | one JSON line per request |
| `docker compose down` | both containers stop cleanly |

Files: `Dockerfile`, `docker-compose.yml`, `deploy/nginx.conf`.

---

## 9. Things to be able to explain

For each module, be ready to answer "why this way and not the obvious way":

- Why the signed export and not 830 page calls, and why the fallback still exists.
- Why a reading at 00:30 belongs to 00:00–00:30, and why windows select intervals.
- Why the portal is asked for whole days and the window is cut locally.
- Why stale data is served when the portal is down, and where that stops (24 h / 6 h).
- Why a `404` from the portal does not open the circuit breaker.
- Why there is no database and no Redis, and what would change that.
- How one route declaration gives validation, TypeScript types and OpenAPI.
- What the grid index does and when it would stop being enough.

[`ARCHITECTURE.md`](ARCHITECTURE.md) has the dry run of one request through
every layer.
