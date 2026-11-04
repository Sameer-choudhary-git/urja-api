# urja-api

A clean, documented REST API in front of the legacy **Urja Meter Ops** portal
(`https://urja-ops.flockenergy.tech`), a SvelteKit app with no public API.

The portal was reverse-engineered first (login, session cookie, the signed bulk
export, the JSON endpoints the UI calls, SvelteKit `__data.json` pages). The
findings are in [`PROTOCOL.md`](PROTOCOL.md). On top of that sits a typed
TypeScript service that hides every portal quirk and exposes a consistent API:
meters, network hierarchy, transformers, half-hourly energy readings, nearby
search, anomaly detection and transformer loading.

| Document | What is in it |
|---|---|
| [`PROTOCOL.md`](PROTOCOL.md) | How the portal works: auth, endpoints, signing, data shapes, quirks |
| [`openapi.json`](openapi.json) | OpenAPI 3.1 spec, generated from the code (also served at `/openapi.json`, Swagger UI at `/docs`) |
| [`REFLECTION.md`](REFLECTION.md) | What was hard, what I would change, how AI was used |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Layers, diagrams and a dry run of one request |
| [`docs/TESTING_GUIDE.md`](docs/TESTING_GUIDE.md) | Module-by-module manual checks with expected results |
| [`docs/DEPLOY_AWS.md`](docs/DEPLOY_AWS.md) | Running it on one EC2 instance with Docker Compose |
| [`docs/api-examples.md`](docs/api-examples.md) | Real responses for every route |
| [`docs/WEB_CLIENT_SPEC.md`](docs/WEB_CLIENT_SPEC.md) | Spec for a web client built on this API |

## Contents

- [What was built](#what-was-built)
- [Who it is for](#who-it-is-for-and-why-the-responses-are-rich)
- [Quick start](#quick-start)
- [Sample request and response](#sample-request-and-response)
- [API overview](#api-overview)
- [Scripts](#scripts)
- [Structure](#structure)
- [Assumptions](#assumptions)
- [Design decisions and trade-offs](#design-decisions-and-trade-offs)
- [Data quality](#data-quality-from-npm-run-scan)
- [Where this would struggle at scale](#where-this-would-struggle-at-scale)
- [Intentionally skipped](#intentionally-skipped)
- [With more time](#with-more-time)

## What was built

| Area | What |
|---|---|
| Portal adapter | Login and one shared session (lazy, renewed early, single-flight), re-login on 401, retries with backoff, timeouts, zod validation of every portal response |
| Data access | HMAC-signed bulk export as the main source; a fallback that rebuilds the same catalog from search pages, `__data.json` (devalue decoder) and `/geo` if the export breaks |
| Catalog | Normalized domain model, immutable indexed snapshot, network tree, data-quality issues on each meter, stale-while-revalidate and stale-if-error freshness |
| Readings | Interval kWh from cumulative registers, power factor, hour/day rollups in IST, window rules, cache with a TTL that follows data age |
| Extras | Nearby search with a grid index, rule-based anomaly detection, transformer loading against kVA rating |
| Robustness | Circuit breaker and concurrency limit around the portal, chaos tests, graceful shutdown, `/health` and `/ready` |
| HTTP | Express 5, 19 routes (17 under `/v1`, plus `/health` and `/ready`), one route declaration drives validation, types and OpenAPI; API keys; rate limit; RFC 9457 errors; ETags; CORS |
| Ops | Multi-stage Docker image (non-root, read-only filesystem), Compose with an nginx gateway, GitHub Actions CI, EC2 deploy guide |
| Tests | 231 tests (vitest + supertest) against an in-process fake portal built from PROTOCOL.md; no network needed |

## Who it is for, and why the responses are rich

The portal is one screen for one kind of user. A clean API in front of it is
used by several teams at once, each wanting something different from the same
data. The response shapes were designed with those consumers in mind:

| Consumer | What they need | What the API gives them |
|---|---|---|
| Field operations | Find a meter, see where it sits, what is wrong nearby | `/v1/search`, full `network` path on every meter, `/v1/meters/nearby`, `/v1/meters.geojson` for maps |
| Data analysts / BI | Slice the fleet without exporting it by hand | `/v1/export/meters` and `/v1/export/readings` (flat rows, JSON or CSV, no paging), filters on every field, `facets` counts on every list, `/v1/stats?groupBy=`, half-hourly or hourly/daily readings with interval kWh and power factor already derived |
| Planning / network engineering | Is a transformer close to its rating? | `/v1/transformers/{code}/load` against `capacityKva`, hierarchy with meter and status counts per node |
| Revenue protection / loss teams | Meters that should not be consuming, odd readings | `/v1/anomalies` (decommissioned-but-consuming, spikes, zero use, low power factor) |
| Data owners / auditors | Can this data be trusted, and how old is it? | `issues` on each meter, `/v1/quality`, `meta.asOf` / `stale` / `source` on every answer |
| Other services | A stable contract | OpenAPI 3.1 generated from the code, RFC 9457 errors with stable codes, ETags |

So fields like `facets`, `network.path`, `issues`, `meta.source` and the
derived reading values are there because a downstream consumer needs them,
not for their own sake. Everything is computed from data the portal already
has; nothing is invented.

What was deliberately kept simple, to stay proportionate to 403 meters and
one portal: no database, no Redis, no message queue, no user accounts, and
anomaly rules instead of a model (see [Intentionally skipped](#intentionally-skipped)).
The service is one process with in-memory state, and the README says where
that stops being enough.

## Quick start

Requirements: Node 20.6 or newer, or just Docker. No paid services.

```bash
cp .env.example .env      # fill PORTAL_EMAIL, PORTAL_PASSWORD and API_KEYS; .env is git-ignored
```

**With Docker (closest to production):**

```bash
docker compose up -d --build     # api + nginx gateway on http://localhost
docker compose ps                # api should become "healthy"
curl localhost/ready             # 200 once the catalog has loaded
docker compose logs -f api       # JSON logs
docker compose down
```

**With Node:**

```bash
npm ci
npm test                  # offline: runs against an in-process fake portal
npm run dev               # real portal, reads .env, restarts on change
npm run build && npm start   # production build
```

**Without the portal or a `.env`:**

```bash
npm run dev:offline       # real server + adapter against the fake portal, auth off
```

`dev:offline` uses `fixtures/local/meter-export.json` when it exists (run
`npm run fetch-export` once), otherwise the 14-meter test sample. Energy
readings and transformer capacities are synthetic in that mode.

Then open http://localhost:3000/docs (or http://localhost/docs with Docker).
Click **Authorize** and paste a key from `API_KEYS` (the part after `name:`).
The raw spec is at `/openapi.json`; the committed copy is regenerated with
`npm run openapi`.

## Sample request and response

```bash
KEY=replace-me-with-a-long-random-key-000
curl -H "Authorization: Bearer $KEY" \
  "localhost:3000/v1/meters?status=faulty&transformer=DT-007&limit=1"
```

```json
{
  "data": [
    {
      "id": "J100126",
      "serialNumber": "L&14240",
      "make": "Genus",
      "phase": "three",
      "status": "faulty",
      "installationType": "whole_current",
      "build": "legacy",
      "location": { "lat": 26.994564630410263, "lng": 75.7897835698423 },
      "network": {
        "zone": { "code": "Z-01", "name": "Jaipur Zone 1" },
        "circle": { "code": "C-01", "name": "Circle 1" },
        "division": { "code": "D-07", "name": "Division 7" },
        "subdivision": { "code": "SD-07", "name": "Subdivision 7" },
        "substation": { "code": "SS-07", "name": "Substation 7" },
        "feeder": { "code": "F-007", "name": "Feeder 7" },
        "transformer": { "code": "DT-007", "name": "Sanganer DT 7" },
        "path": "Z-01.C-01.D-07.SD-07.SS-07.F-007.DT-007"
      },
      "issues": []
    }
  ],
  "page": { "total": 3, "limit": 1, "offset": 0 },
  "facets": {
    "make": { "Genus": 1, "Allied": 2 },
    "status": { "faulty": 3 },
    "phase": { "three": 1, "single": 2 },
    "installationType": { "whole_current": 1, "ct_operated": 2 },
    "build": { "legacy": 3 }
  },
  "meta": { "asOf": "2026-11-03T17:47:38.568Z", "ageSeconds": 1, "stale": false, "source": "export" }
}
```

Headers include `ETag`, `Cache-Control: no-cache`, `X-Request-Id`,
`X-Data-Age: 1`, `X-Data-Stale: false` and `X-Data-Source: export`.

More requests:

```bash
curl -H "X-API-Key: $KEY" "localhost:3000/v1/meters/J100007"
curl -H "X-API-Key: $KEY" "localhost:3000/v1/meters/J100013/readings?from=2026-06-29&to=2026-06-29&granularity=hour"
curl -H "X-API-Key: $KEY" "localhost:3000/v1/meters/nearby?lat=26.9124&lng=75.7873&radiusM=5000"
curl -H "X-API-Key: $KEY" "localhost:3000/v1/anomalies?transformer=DT-007&from=2026-06-24&to=2026-06-30"
curl -H "X-API-Key: $KEY" "localhost:3000/v1/transformers/DT-007/load?from=2026-06-29&to=2026-06-29"
curl -H "X-API-Key: $KEY" "localhost:3000/v1/hierarchy/Z-01.C-01"
curl -H "X-API-Key: $KEY" "localhost:3000/v1/stats?groupBy=status"
curl localhost:3000/health
```

Every route's real response is in [`docs/api-examples.md`](docs/api-examples.md).
Energy history on the portal covers 1 to 30 June 2026, so readings queries
use June dates.

## API overview

| Route | What |
|---|---|
| `GET /health` | Liveness: the process is up (public) |
| `GET /ready` | Readiness: 503 until the first catalog load succeeds; shows circuit breaker and queue state (public) |
| `GET /v1/meters` | Filter (`q`, `status`, `phase`, `installationType`, `make`, `build`, `zone` ... `transformer`, `node`, `hasIssues`), sort, page; returns facet counts |
| `GET /v1/meters.geojson` | Same filters as a GeoJSON FeatureCollection, for maps |
| `GET /v1/meters/{meterId}` | One meter with its full network position and data issues |
| `GET /v1/meters/{meterId}/readings` | Half-hourly readings with interval kWh and power factor, or hour/day totals (`from`, `to`, `granularity`) |
| `GET /v1/meters/nearby?lat=&lng=&radiusM=` | Meters near a point, nearest first (optional status/phase/installationType filters) |
| `GET /v1/meters/{meterId}/anomalies` | Rule-based anomalies in one meter's readings |
| `GET /v1/anomalies?transformer=` / `node=` / `meterIds=` | Anomaly scan over up to 50 meters, most severe first |
| `GET /v1/export/meters` | Bulk export: every meter matching the `/v1/meters` filters as flat rows (network codes and names, transformer kVA, issue codes); `format=json` or `csv` (file download) |
| `GET /v1/export/readings` | Bulk export: readings for a transformer, node or meter list (up to 50 meters), one row per meter per half hour/hour/day; `format=json` or `csv` |
| `GET /v1/transformers`, `/v1/transformers/{code}` | Transformers with capacity, feeder and meter counts |
| `GET /v1/transformers/{code}/load` | Summed demand of the DT's meters per half hour vs its kVA rating |
| `GET /v1/hierarchy` | Zone > Circle > ... > Transformer tree with meter and status counts (`depth`, `status`) |
| `GET /v1/hierarchy/{nodeId}` | One node: breadcrumb, children, and its meters (paged) |
| `GET /v1/search?q=` | Search across meters, transformers and network nodes |
| `GET /v1/stats` | Counts and capacity, optionally `groupBy` a field |
| `GET /v1/quality` | The data-quality report for the current catalog |
| `GET /docs`, `GET /openapi.json` | Swagger UI and the spec (public) |

Conventions:

- Auth: `Authorization: Bearer <key>` or `X-API-Key: <key>` on every `/v1` route.
- Errors: RFC 9457 `application/problem+json` with a stable `code` and the `requestId`.
- Lists: `limit` (default 50, max 500) and `offset`, answered as `data` + `page { total, limit, offset }`; list filters accept `a,b` or repeated keys.
- Times: ISO 8601 with an offset in and out; the service writes IST (`+05:30`). A date-only `to` includes that whole day.
- Freshness: every `/v1` body has `meta` (`asOf`, `ageSeconds`, `stale`, `source`), mirrored in `X-Data-Age` / `X-Data-Stale` / `X-Data-Source`.
- Caching: strong `ETag` with `Cache-Control: no-cache` on catalog routes (clients get `304`); readings say `Cache-Control: private, max-age=N` and `X-Cache: hit|miss|stale`.
- Every response carries `X-Request-Id` (an incoming one from a proxy is reused).
- CORS is off unless `CORS_ORIGINS` lists the browser origins allowed (e.g. a web client on `http://localhost:5173`).

## Scripts

| Command | Needs portal? | What it does |
|---|---|---|
| `npm test` | no | Unit + integration tests against a fake portal built from PROTOCOL.md |
| `npm run typecheck` | no | Strict TypeScript check |
| `npm run smoke` | yes | Logs in and reads the first page of meters |
| `npm run fetch-export` | yes | Fetches all meters via the signed export into `fixtures/local/meter-export.json` |
| `npm run scan -- <file>` | no | Data-quality report for an export file (`--json` for machine output) |
| `npm run probe` | yes | Read-only checks for the open questions in PROTOCOL.md section 6 |
| `npm run cross-check` | yes | Compares the signed export with the fallback path (`--all` for every meter) |
| `npm run verify` | yes | **Parity check: the API returns everything the portal has.** Every meter, transformer and energy row from the real portal against a running API (`--api http://<host>`, `--all` for every meter's readings, `--meters J100040`). Exit code 1 on any unexplained difference |
| `npm run dump-page -- <id>` | yes | Prints one meter's decoded `__data.json` page data (for odd pages) |
| `npm run bench:nearby` | no | Grid index vs full scan for nearby search, 403 to 100k meters |

Live scripts print no secrets. The signing secret only ever appears as a
short SHA-256 fingerprint.

## Structure

```
src/
  config.ts              env validation (fails fast, never echoes values)
  logger.ts              logging port
  portal/                anti-corruption layer: everything that knows the portal's quirks
    authenticator.ts     POST /login, session cookie from Set-Cookie
    session.ts           one shared session: lazy login, early renewal, single-flight
    portalClient.ts      authenticated GET: 401 re-login, retries, timeout, schema validation
    signing.ts           HMAC-SHA256 request signing for the export
    exportApi.ts         /portal/keys + signed /portal/export
    schemas.ts           zod wire schemas (what the portal actually sends)
    createPortal.ts      composition root for the adapter
    transformersApi.ts   paginated /portal/dts (capacity, feeder, canonical DT names)
    energyApi.ts         /portal/meters/{id}/energy with ISO day filter
    fallbackApi.ts       slow path: search + __data.json + geo, same shape as the export
    devalue.ts           decoder for SvelteKit's __data.json format
  domain/                our clean model; knows nothing about HTTP or the portal's spelling
    meter.ts             Meter, Transformer, NetworkPosition, DataIssue
    normalize.ts         portal records -> domain (repairs, DT names, enum mapping)
    cellRepair.ts        fills blank hierarchy cells when name<->code is 1:1
    networkTree.ts       Zone > ... > Transformer tree with meter/status counts
    time.ts              IST parsing and formatting (fixed +05:30, no DST)
    readings.ts          registers -> interval kWh, power factor, issues, hour/day rollups
    anomalies.ts         anomaly rules and transformer loading (pure functions)
  catalog/
    catalogSnapshot.ts   immutable, indexed view: lookups, filters, facets, tree
    catalogService.ts    freshness: TTL, stale-while-revalidate, stale-if-error, single-flight
    portalCatalogLoader.ts  export + /portal/dts -> snapshot
  readings/
    readingsService.ts   window rules, portal day mapping, cache with data-age TTL
  anomalies/
    anomalyService.ts    runs the rules over many meters' readings, partial results on failure
  geo/
    spatialGrid.ts       grid index + haversine distance for nearby search
  shared/
    ttlCache.ts          TTL + single-flight + stale-if-error + LRU cache
    circuitBreaker.ts    closed / open / half-open, for the portal
    concurrencyLimiter.ts  bulkhead: N portal calls at once, bounded queue
    mapPool.ts           ordered map with limited concurrency
  quality/
    scanExport.ts        pure data-quality scan (also served by /v1/quality)
    crossCheck.ts        field-by-field comparison of export vs fallback
  http/                  generic HTTP plumbing; knows nothing about meters
    routeRegistry.ts     one declaration per route -> validation, types and OpenAPI
    middleware.ts        request id, access log, API-key auth, rate limit, errors
    problem.ts           RFC 9457 errors; portal failures -> 502/503
    app.ts               builds the Express app (no listen; tests use it in process)
  api/                   our product: routes, request/response schemas
    schemas.ts           zod schemas for every query, param and response
    routes.ts            the 19 routes
    context.ts           what handlers may use (catalog read, clock), freshness headers
  main.ts                composition root: config -> portal -> catalog -> app -> listen
scripts/                 smoke, fetch-export, scan-export, probe, cross-check, verify-parity, bench-nearby, dev-offline, export-openapi
test/                    vitest suites, fake portal, small real-data fixture
docs/                    architecture, testing guide, AWS deploy, API examples, web client spec
deploy/                  nginx gateway config, EC2 setup script, deploy.sh + deploy.yml (auto-deploy on push)
Dockerfile, docker-compose.yml, .github/workflows/ci.yml
```

## Assumptions

- The service account in the brief is a read-only consumer, and the portal is
  treated as read-only: no request changes anything there.
- Portal timestamps have no zone and are IST (+05:30). India has no daylight
  saving, so a fixed offset is exact.
- A reading at time t closes the interval before it: [t − 30 min, t) for most
  meters, [t − 1 day, t) for meters the portal reads once a day (detected per
  meter from the usual step between readings, reported as
  `summary.readingIntervalMinutes`). kWh and kVAh are cumulative registers, so
  usage is the difference between readings, and usage across a gap is still
  exact; it is kept as one longer interval. A bucket only counts usage whose
  whole interval fits in it, so a once-a-day meter has daily totals but no
  hourly ones, and it is left out of half-hourly transformer loading.
- A portal energy row with a value that is not a number (seen once, on
  J100089) is skipped and reported as a `bad_value` reading issue; the rest of
  the month is still served, and the next reading's interval covers the gap.
- A portal `429` (it rate limits the energy endpoint) is waited out with the
  portal's `Retry-After`, or 1, 2, 4, 8 s, and does not open the circuit
  breaker: the portal is healthy, just busy. If it persists the API answers
  503 `upstream_rate_limited` with `Retry-After`.
- `/portal/dts` is the dedicated transformer list, so its names are canonical
  where the meter records disagree (DT-007).
- The portal data looks static (history ends on 30 June 2026), but nothing
  relies on that: catalog TTLs, refresh diffs and the data-age readings TTL
  all work the same if new meters or readings start appearing. New meters
  show up within the catalog TTL (15 minutes); new readings within the
  readings TTL.
- Voltage limits follow the Indian Electricity Rules (230 V ± 6%); the other
  anomaly thresholds are reasonable defaults, named in one place so an
  operator can tune them.
- Transformer loading assumes each meter's kVAh is attributable to its DT and
  ignores losses, so it is a lower bound.

## Design decisions and trade-offs

- **Bulk export as the main data source.** One signed call returns all 403
  meters with geo and a structured hierarchy, instead of about 800 detail and
  geo calls.
- **The signing secret is fetched again for every export attempt**, just as
  the portal's own button does. The probe showed it is fixed today, but
  refetching stays correct if the portal starts rotating it, and costs one
  tiny extra request.
- **The export fails loudly if `total` differs from the number of items**,
  in case the portal starts paginating. A partial catalog served silently
  would be worse than an error.
- **Wire schemas are tolerant where the data is messy and strict where a
  change means we misunderstood the protocol.** Blank hierarchy cells and
  unknown `build` values pass validation; a missing field or a wrong type
  does not. Cleaning the data is the domain layer's job.
- **Codes are not identities below Circle.** `D-01` sits under three
  circles, so a network node is identified by its path
  (`Z-01.C-01.D-07...`), never by its code alone. Dots, not slashes, so a
  node id fits in one URL segment (`/v1/hierarchy/Z-01.C-01.D-07`).
- **Blank hierarchy cells are repaired only when unambiguous.** A blank code
  is filled when that name maps to exactly one code elsewhere (and vice
  versa). Every repair is recorded on the meter as a `network_cell_repaired`
  issue, so the API never hides that it changed portal data.
- **DT-007's two names.** `/portal/dts` is the dedicated transformer list, so
  its name ("Sanganer DT 7") is canonical. The other name is kept as an alias,
  and the three affected meters carry a `transformer_name_conflict` issue.
  Without `/portal/dts`, the name most meters use wins.
- **Unknown values do not break the catalog.** An unseen status or phase maps
  to `"unknown"` with an issue, instead of failing all 403 meters for one odd
  record.
- **One immutable snapshot, swapped whole.** A refresh builds a new indexed
  snapshot beside the old one and replaces it in a single assignment.
  Requests in flight keep the snapshot they started with.
- **Freshness rule.** The catalog is fresh for 15 minutes. After that, the
  service still answers from memory at once and refreshes in the background
  (stale-while-revalidate). If that refresh fails, it keeps serving the old
  data and records the error (stale-if-error), up to a hard limit of 24
  hours. Past that, requests wait for a refresh and see its error. Each
  refresh logs how many meters were added, removed or changed, so data
  drift is visible even though the data looks static today.
- **`/portal/dts` is optional for a refresh.** It only adds capacities and the
  DT-name tie-break, so a failure there degrades the catalog instead of
  blocking it.
- **The full export is never committed.** `fixtures/local/` is git-ignored;
  tests use a 14-meter sample chosen for its quirks.

- **Express 5** for the HTTP layer: widely known, and v5 forwards errors
  from async handlers to the error middleware without wrappers.
- **One route declaration drives validation, types and docs.** Each route
  is declared once with zod schemas for params, query and response. The
  registry validates requests from them, TypeScript infers the handler's
  types from them, and the OpenAPI document is generated from them. The
  docs cannot drift from the code, and tests check every response against
  its schema.
- **Consumer API keys, separate from the portal account.** Consumers never
  see portal credentials. Keys live in env as `name:key`; only their SHA-256
  hashes are kept, compared in constant time. The name (never the key) goes
  into logs and the rate limiter. With no keys the server refuses to start,
  unless `AUTH_MODE=disabled` is set explicitly.
- **Portal failures are not the consumer's fault.** A portal login failure
  becomes `502`, an unreachable portal `503` with `Retry-After`, never `401`.
  With a cached catalog, most routes keep answering while the portal is down.
- **Rate limit per consumer** (300/min by default, per IP on public routes).
  It is in memory, which is right for one instance; several instances would
  share a Redis store.
- **Liveness vs readiness.** `/health` only says the process is alive.
  `/ready` says the catalog has loaded, so a load balancer does not send
  traffic before there is data.
- **Readings are cumulative registers; usage is a difference.** Each
  half-hourly reading closes the half hour before it, so `intervalKwh` at
  00:30 is the usage from 00:00 to 00:30. Windows select intervals, not
  readings, which makes raw half-hours, hourly buckets, daily buckets and the
  summary add up to the same total (a test checks this). Float noise
  (0.42000000000000455) is rounded away at 6 decimals; inputs have 2.
- **IST everywhere, said out loud.** The portal's timestamps have no zone; we
  read them as IST (+05:30, no daylight saving, so a fixed offset is exact)
  and always write the offset (`2026-06-29T00:30:00+05:30`).
- **Odd readings are reported, not hidden or fatal.** Gaps, off-grid
  readings, a register that goes down, or kWh greater than kVAh give a null
  interval and an entry in `issues`. Hour and day buckets say `complete:
  false` when a half hour is missing, and empty buckets are still returned.
- **The portal filters whole days only, we cut the exact window.** We ask for
  the IST days covering the window (including the reading that closes its last
  half hour) and cut locally, so `from=...T10:15` works even though the portal
  ignores times. Windows are validated before any portal call (max 31 days).
- **Readings are fetched on demand and cached by (meter, days).** Prefetching
  403 meters x 1440 rows would be wasted on data nobody looks at. The cache
  TTL follows data age: a newest reading over a day old is history and kept
  for an hour; live data would be kept only until the next reading is due
  (at most 5 minutes). Concurrent requests share one portal call, and if the
  portal fails an expired copy is served for up to 6 hours, marked `stale`.
- **Protecting the portal, and us from the portal.** Every portal call goes
  through a concurrency limit (4 at once, bounded queue of 200) and a circuit
  breaker (5 consecutive failures open it for 30 s, then one trial call).
  Only "unhealthy" errors count (unreachable, timeouts, 5xx/429 after
  retries, login broken); a 404 means the portal is fine. While open, calls
  fail in microseconds with `503` and `Retry-After`, catalog routes keep
  answering from memory, and cached readings are still served. `/ready` shows
  the breaker state. `test/chaos.test.ts` runs the whole stack against a
  portal that fails 30% of the time with random latency, and against one
  that goes down and comes back.
- **Nearby search uses a grid index.** Meters are bucketed into ~1 km cells;
  a query checks only the cells that overlap its circle, then exact
  haversine distances. A test checks it returns exactly what a full scan
  returns. `npm run bench:nearby` (2000 queries, 1 km radius):

  | Meters | Full scan / query | Grid / query | Speed-up |
  |---|---|---|---|
  | 403 | 41 µs | 3.8 µs | 11x |
  | 10,000 | 703 µs | 10 µs | 68x |
  | 100,000 | 13.2 ms | 260 µs | 51x |

  At 403 meters both are instant; the grid is there so the cost follows how
  many meters are nearby, not the fleet size.
- **Anomalies are explainable rules, not a model.** Each has a named
  threshold an operator can argue with (`src/domain/anomalies.ts`):

  | Code | Rule |
  |---|---|
  | `voltage_out_of_range` | R-phase voltage outside 230 V ± 6% (216.2 to 243.8 V; Indian Electricity Rules 1956, rule 54) |
  | `low_power_factor` | Power factor over the window below 0.85 |
  | `zero_consumption` | 24 h or more of zero use on a meter that is not decommissioned |
  | `consumption_spike` | A half hour above median + 6 × MAD (and at least 0.5 kWh) |
  | `decommissioned_but_consuming` | A decommissioned meter that recorded consumption |
  | `data_gap`, `register_decreased` | Missing half hours; a cumulative register that went down |
  | `transformer_overload` | Peak summed demand of a DT's meters at 80% (warning) or 100% (critical) of its kVA rating |

  Real data already triggers one: `J100000` is *Decommissioned* in the
  export, yet its kWh register rose by 142 kWh in a week. A scan is limited
  to 50 meters (one portal call each, then cached); meters whose readings fail
  are listed under `failed` and the rest are still returned.
- **Transformer loading is a lower bound.** kVAh used in a half hour × 2 is
  the average kVA; summed over the DT's meters and compared with
  `capacityKva` from `/portal/dts`. Line losses and unmetered load are
  invisible to us, so real loading is higher.
- **A second way to build the catalog.** If the signed export breaks (a
  changed signing scheme, a changed format), the catalog is rebuilt from the
  pages the UI itself uses: meter search (21 pages), each meter's
  `__data.json` (decoded from SvelteKit's devalue format) and `/geo`. That is
  about 830 calls instead of 1, at 2 meters at a time, so it is only a
  fallback, and not used when the portal is simply down (it would fail too).
  Responses say which path the data came from (`meta.source`,
  `X-Data-Source`). A test proves both paths give identical catalogs on the
  sample; `npm run cross-check` does the same comparison on the real portal.
  `npm run dev:offline` with `OFFLINE_BREAK_EXPORT=1` shows the switch.
- **No Redis (yet), on purpose.** One process holds everything in memory:
  the catalog (403 meters, well under 1 MB), the readings cache (bounded at 500
  entries; a full month for one meter is 1440 readings, roughly 150 KB in
  memory, so about 75 MB in the worst case) and the rate-limit counters. That is
  correct for a single instance and needs no extra service to run. Redis
  becomes worth it when there are several instances behind a load balancer:
  then rate limits must be shared (otherwise each instance allows 300/min),
  and a shared readings cache saves repeated portal calls. The cache and the
  limiter are behind small interfaces (`TtlCache`, express-rate-limit's store),
  so that change stays local.
- **Strong ETags** let a polling frontend get `304 Not Modified` for free
  while the catalog is unchanged.

## Data quality (from `npm run scan`)

On the 403-meter export: no duplicate or missing IDs, no bad coordinates.
22 meters have one blank hierarchy cell, and all 22 can be repaired because
name and code map one-to-one elsewhere in the data. `DT-007` has two names
(10 meters "Sanganer DT 7", 3 meters "Old Malviya Nagar Xfmr"). Codes from
Division to Feeder are reused under different parents, so codes alone do not
form a tree. Each DT, however, always has exactly one path above it.

## Where this would struggle at scale

The design fits the data as it is: 403 meters, one portal, one instance.
Being honest about where it stops fitting:

- **The whole catalog lives in memory and is rebuilt from one export call.**
  Fine up to tens of thousands of meters (a snapshot is well under 1 MB at
  403). At millions of meters the export itself would be too big for one
  response, a rebuild would take seconds of CPU, and a database with real
  indexes (Postgres + PostGIS) would replace the in-memory snapshot.
- **Readings are fetched on demand from the portal.** One meter's month is
  one portal call. An anomaly scan over a transformer is one call per meter,
  capped at 50 meters per request and at 4 portal calls at a time. A
  fleet-wide scan (403 meters) would take minutes through the portal. At that
  point readings should be ingested in the background into a time-series store
  (TimescaleDB) and scans would run there.
- **The grid index for nearby search** uses fixed ~1 km cells. With very
  uneven density (100k meters in one city block, few elsewhere), the busy
  cells get large; a quadtree, geohash or PostGIS GiST index would adapt.
  The benchmark above shows it is fine to 100k evenly spread meters.
- **Single instance state.** Rate-limit counters, the readings cache and the
  circuit breaker are per process. Two instances would each allow the full
  rate and each hit the portal. That is the point where Redis comes in (see
  "No Redis (yet)" above).
- **The portal is the real bottleneck.** Everything that is not cached is
  bounded by how hard we are willing to hit a legacy system; the concurrency
  limit is deliberately low (4) to be a polite client.

## Intentionally skipped

- **A database.** The data fits in memory and the portal stays the source of
  truth; a second copy would need sync logic for no gain at this size.
- **Redis.** Only needed with two or more instances (shared rate limit and
  cache). One instance is enough here.
- **Writes.** The brief is about reading the portal; no create/update routes.
- **User accounts / OAuth.** Static API keys per consumer are enough for a
  service-to-service API; keys are hashed and compared in constant time.
- **HTTPS inside the app.** TLS belongs at the edge (nginx with a
  certificate, or a load balancer). The deploy guide shows how; it needs a
  domain.
- **The web client in this repo.** A separate client is specified in
  `docs/WEB_CLIENT_SPEC.md`; the API is the deliverable.
- **Machine-learning anomaly detection.** Explainable rules with named
  thresholds are easier to trust and argue with, and one month of
  synthetic-looking data is too little to train anything on.

## With more time

- Background ingestion of readings into TimescaleDB, so fleet-wide scans and
  long-range queries do not depend on the portal at request time.
- Redis for shared rate limits and readings cache, then two instances behind
  the gateway.
- Metrics (Prometheus: portal latency, breaker state, cache hit rate) and
  tracing, next to the JSON logs that exist today.
- Contract tests that run the probe against the live portal on a schedule
  and alert when a response shape or quirk changes.
- Cursor pagination for very large lists, and field selection to keep
  payloads small for mobile clients.
- HTTPS with a domain and automatic certificates, and an image published to
  a registry from CI instead of building on the server.

## Deployment

`docker compose up -d --build` runs the API behind an nginx gateway (per-IP
rate limit, only GET/HEAD/OPTIONS, problem+json error pages, gzip). The API
container runs as a non-root user on a read-only filesystem with a memory
limit and a health check. Step-by-step EC2 instructions, including the
security group and how to hand a reviewer an API key, are in
[`docs/DEPLOY_AWS.md`](docs/DEPLOY_AWS.md). CI (`.github/workflows/ci.yml`)
runs typecheck, tests, build and a Docker build on every push.
