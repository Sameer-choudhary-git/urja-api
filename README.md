# urja-api

A clean REST API for the old **Urja Meter Ops** portal
(`https://urja-ops.flockenergy.tech`).

The portal is a SvelteKit app with no public API. So I first worked out how it
talks to its own UI: the login, the session cookie, the signed bulk export, the
JSON endpoints and the SvelteKit `__data.json` pages. All of that is written up
in [`PROTOCOL.md`](PROTOCOL.md).

On top of that sits a typed TypeScript service. It hides every portal quirk and
gives one consistent API for meters, the network hierarchy, transformers,
half-hourly energy readings, nearby search, anomaly detection and transformer
load.

| Live | Link |
|---|---|
| Web client | https://urja-umber.vercel.app (code: [urja-v0-frontend](https://github.com/Sameer-choudhary-git/urja-v0-frontend)) |
| API on AWS (Swagger UI) | http://15.252.70.41/docs |
| API source (this repo) | [Sameer-choudhary-git/urja-api](https://github.com/Sameer-choudhary-git/urja-api) |

Every optional extension in the brief is built: hierarchy, query layer,
freshness, robustness, full dataset and a web client. A few extras are built
too. [`docs/EXTRAS.md`](docs/EXTRAS.md) lists each one and shows how to try it.

| Document | What it covers |
|---|---|
| [`PROTOCOL.md`](PROTOCOL.md) | How the portal works: auth, endpoints, signing, data shapes, quirks |
| [`openapi.json`](openapi.json) | OpenAPI 3.1 spec, generated from the code (also served at `/openapi.json`, Swagger UI at `/docs`) |
| [`docs/EXTRAS.md`](docs/EXTRAS.md) | Each optional extension and extra: what, where, how to try it |
| [`REFLECTION.md`](REFLECTION.md) | What was hard, what I would change, how I used AI |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Layers, diagrams, and one request followed step by step |
| [`docs/SYSTEM_DESIGN.md`](docs/SYSTEM_DESIGN.md) | System design as diagrams: HLD, LLD (modules, classes, domain model) and step-by-step flows |
| [`docs/VERIFY_RESULT.md`](docs/VERIFY_RESULT.md) | Output of `npm run verify -- --all`: the API checked against the live portal, every meter (PASS) |
| [`docs/api-examples.md`](docs/api-examples.md) | Real responses for every route |

## Contents

- [What was built](#what-was-built)
- [Who it is for](#who-it-is-for)
- [Quick start](#quick-start)
- [Sample request and response](#sample-request-and-response)
- [API overview](#api-overview)
- [Scripts](#scripts)
- [Structure](#structure)
- [Assumptions](#assumptions)
- [Historical data today, ready for live data](#historical-data-today-ready-for-live-data)
- [Design decisions and trade-offs](#design-decisions-and-trade-offs)
- [Data quality](#data-quality)
- [Where this would struggle at scale](#where-this-would-struggle-at-scale)
- [Intentionally skipped](#intentionally-skipped)
- [With more time](#with-more-time)
- [Deployment](#deployment)

## What was built

| Area | What |
|---|---|
| Portal adapter | One shared login session (created on first use, renewed early, never two logins at once). Re-login on 401, retries with backoff, timeouts, and zod checks on every portal response |
| Data access | The HMAC-signed bulk export is the main source. If it breaks, a fallback rebuilds the same catalog from the search pages, `__data.json` (own devalue decoder) and `/geo` |
| Catalog | Clean domain model in one indexed, read-only snapshot. Network tree, data-quality issues on each meter, and serving slightly old data while it refreshes |
| Readings | Interval kWh worked out from the cumulative registers, power factor, hour and day totals in IST, and a cache whose lifetime depends on how old the data is |
| Extras | Nearby search with a grid index, rule-based anomaly detection, transformer load against its kVA rating |
| Robustness | Circuit breaker and concurrency limit around the portal, chaos tests, graceful shutdown, `/health` and `/ready` |
| HTTP | Express 5 with 19 routes (17 under `/v1`, plus `/health` and `/ready`). One route declaration gives validation, types and OpenAPI. API keys, rate limit, RFC 9457 errors, ETags, CORS |
| Ops | Small multi-stage Docker image (non-root, read-only filesystem), Compose with an nginx gateway, GitHub Actions for CI and auto-deploy, an EC2 guide |
| Web client | A Next.js app in its own repo ([urja-v0-frontend](https://github.com/Sameer-choudhary-git/urja-v0-frontend), live at https://urja-umber.vercel.app). It has an overview, meter list, meter detail with charts, map and nearby, hierarchy explorer, transformer load, anomalies and data quality. The API key stays in its server-side proxy |
| Tests | 231 tests (vitest + supertest) against a fake portal built from PROTOCOL.md. No network needed |

## Who it is for

The portal is one screen for one kind of user. An API in front of it serves
several teams at once, and each team wants something different from the same
data. The response shapes follow from that:

| Consumer | What they need | What the API gives them |
|---|---|---|
| Field operations | Find a meter, see where it sits, see what is wrong nearby | `/v1/search`, the full `network` path on every meter, `/v1/meters/nearby`, `/v1/meters.geojson` for maps |
| Data analysts / BI | Slice the fleet without exporting by hand | `/v1/export/meters` and `/v1/export/readings` (flat rows, JSON or CSV), filters on every field, `facets` counts on every list, `/v1/stats?groupBy=`, readings with interval kWh and power factor already worked out |
| Planning / network engineering | Is a transformer close to its rating? | `/v1/transformers/{code}/load` against `capacityKva`, a hierarchy with meter and status counts per node |
| Revenue protection | Meters that should not be using power, odd readings | `/v1/anomalies` (decommissioned but consuming, spikes, zero use, low power factor) |
| Data owners / auditors | Can this data be trusted, and how old is it? | `issues` on each meter, `/v1/quality`, and `meta.asOf` / `stale` / `source` on every answer |
| Other services | A stable contract | OpenAPI 3.1 generated from the code, RFC 9457 errors with stable codes, ETags |

So fields like `facets`, `network.path`, `issues` and `meta.source` exist
because someone downstream needs them. Everything is computed from data the
portal already has. Nothing is made up.

Some things are kept simple on purpose, to match 403 meters and one portal: no
database, no Redis, no message queue, no user accounts, and rules instead of a
model for anomalies. It is one process with its state in memory. The sections
[Where this would struggle at scale](#where-this-would-struggle-at-scale) and
[Intentionally skipped](#intentionally-skipped) say where that stops being
enough.

## Quick start

There are four ways to try it. **For a review, use option 1.** It runs the real
API against the live portal and takes about two minutes.

| | How | Portal | Needs |
|---|---|---|---|
| 1 | [Locally against the real portal](#1-locally-against-the-real-portal-recommended) | live | Node 20.6+, the portal account from the brief |
| 2 | [Locally with Docker](#2-locally-with-docker) (api + nginx, like production) | live | Docker, the portal account |
| 3 | [Offline](#3-offline-no-portal-no-env) | built-in fake | Node only |
| 4 | [Deployed on AWS](#4-deployed-on-aws) | live | a browser |

**Reviewer API key.** It is in `.env.example` and also works on the AWS
deployment:

```
uKmXzDqwVrlosCHMOThjrkJeeILTQop6
```

In Swagger UI, click **Authorize**, paste the key, and every "Try it out" call
will send it. From code, send it as `X-API-Key: <key>` or
`Authorization: Bearer <key>`. Either header works. This key is for a
read-only API and is published here on purpose. It will be removed after the
review.

### 1. Locally against the real portal (recommended)

```bash
git clone https://github.com/Sameer-choudhary-git/urja-api.git && cd urja-api
cp .env.example .env      # set PORTAL_EMAIL and PORTAL_PASSWORD (the account from the brief)
                          # and make sure .env has API_KEYS=tester:uKmXzDqwVrlosCHMOThjrkJeeILTQop6
npm ci
npm test                  # 231 tests, offline, about 10 s
npm run dev               # http://localhost:3000, reads .env
```

`npm run dev` prints one JSON log line per event. Within a few seconds you
should see these three lines. They mean the service logged in to the portal,
downloaded all 403 meters through the signed export, and built its catalog in
memory. From then on, the API answers requests.

```
{"level":"info","msg":"portal.session.established", ...}
{"level":"info","msg":"portal.export.ok", ... "meters":403}
{"level":"info","msg":"catalog.refreshed", ... "meters":403, ...}
```

If you see `catalog.refresh_failed` with a login error instead, check
`PORTAL_EMAIL` and `PORTAL_PASSWORD` in `.env`. Then:

- Open http://localhost:3000/docs, click **Authorize**, paste the reviewer key and try any route.
- Or run the [sample request](#sample-request-and-response) below.
- For the strongest check, run `npm run verify -- --all`. It compares every
  meter, transformer and energy row on the live portal with what this API
  returns, and ends with `PASS`. It takes about 5 minutes because it goes
  slowly on purpose: the portal rate limits. If you don't want to wait, the
  output of a real run is in [`docs/VERIFY_RESULT.md`](docs/VERIFY_RESULT.md):
  403/403 meters, 40/40 transformers, and 68,495 portal rows with 0 missing
  and 0 changed.

On Windows PowerShell, `cp` works as is. Use `curl.exe` instead of `curl`.

### 2. Locally with Docker

```bash
cp .env.example .env              # PORTAL_EMAIL and PORTAL_PASSWORD, as above
docker compose up -d --build      # api + nginx gateway on http://localhost
docker compose ps                 # wait until api is "healthy"
curl localhost/ready              # 200 once the catalog has loaded
docker compose logs -f api        # JSON logs; "docker compose down" to stop
```

Swagger UI is at http://localhost/docs (port 80, through nginx).

### 3. Offline (no portal, no .env)

```bash
npm ci
npm run dev:offline       # the real server and adapter, against a built-in fake portal; auth is off
```

This uses the committed snapshot of all 403 meters
(`fixtures/meter-export.json`, captured from the portal's export). Energy
readings and transformer capacities are made up in this mode. It is handy for
looking around without credentials, but it is not the real data path.

### 4. Deployed on AWS

Open http://15.252.70.41/docs and use the reviewer key above. It is the same
code as option 2, on one EC2 instance.

The web client lives in its own repo. It calls the API through a small
server-side proxy, so the key never reaches the browser.

The raw spec is at `/openapi.json`. Regenerate the committed copy with
`npm run openapi`.

## Sample request and response

```bash
KEY=uKmXzDqwVrlosCHMOThjrkJeeILTQop6
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

The response headers include `ETag`, `Cache-Control: no-cache`,
`X-Request-Id`, `X-Data-Age: 1`, `X-Data-Stale: false` and
`X-Data-Source: export`.

More requests to try:

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

Real responses for every route are in
[`docs/api-examples.md`](docs/api-examples.md). The portal's energy history
covers 1 to 30 June 2026, so use June dates for readings.

## API overview

| Route | What it does |
|---|---|
| `GET /health` | Liveness: the process is up (public) |
| `GET /ready` | Readiness: 503 until the first catalog load works; also shows the circuit breaker and queue (public) |
| `GET /v1/meters` | Filter (`q`, `status`, `phase`, `installationType`, `make`, `build`, `zone` ... `transformer`, `node`, `hasIssues`), sort and page. Returns facet counts |
| `GET /v1/meters.geojson` | Same filters, as a GeoJSON FeatureCollection for maps |
| `GET /v1/meters/{meterId}` | One meter with its full network position and data issues |
| `GET /v1/meters/{meterId}/readings` | Half-hourly readings with interval kWh and power factor, or hour/day totals (`from`, `to`, `granularity`) |
| `GET /v1/meters/nearby?lat=&lng=&radiusM=` | Meters near a point, nearest first (optional status, phase and installationType filters) |
| `GET /v1/meters/{meterId}/anomalies` | Rule-based anomalies in one meter's readings |
| `GET /v1/anomalies?transformer=` / `node=` / `meterIds=` | Anomaly scan over up to 50 meters, most severe first |
| `GET /v1/export/meters` | Bulk export: every meter that matches the `/v1/meters` filters, as flat rows. `format=json` or `csv` (file download) |
| `GET /v1/export/readings` | Bulk export: readings for a transformer, node or meter list (up to 50 meters), one row per meter per period. `format=json` or `csv` |
| `GET /v1/transformers`, `/v1/transformers/{code}` | Transformers with capacity, feeder and meter counts |
| `GET /v1/transformers/{code}/load` | Total demand of the transformer's meters per half hour, against its kVA rating |
| `GET /v1/hierarchy` | Zone > Circle > ... > Transformer tree with meter and status counts (`depth`, `status`) |
| `GET /v1/hierarchy/{nodeId}` | One node: breadcrumb, children and its meters (paged) |
| `GET /v1/search?q=` | Search meters, transformers and network nodes at once |
| `GET /v1/stats` | Counts and capacity, optionally grouped by a field (`groupBy`) |
| `GET /v1/quality` | The data-quality report for the current catalog |
| `GET /docs`, `GET /openapi.json` | Swagger UI and the spec (public) |

Conventions:

- **Auth:** `Authorization: Bearer <key>` or `X-API-Key: <key>` on every `/v1` route.
- **Errors:** RFC 9457 `application/problem+json`, with a stable `code` and the `requestId`.
- **Lists:** `limit` (default 50, max 500) and `offset`. The answer is `data` plus `page { total, limit, offset }`. List filters accept `a,b` or repeated keys.
- **Times:** ISO 8601 with an offset, both in and out. The service writes IST (`+05:30`). A date-only `to` includes that whole day.
- **Freshness:** every `/v1` body has `meta` (`asOf`, `ageSeconds`, `stale`, `source`), also sent as `X-Data-Age`, `X-Data-Stale` and `X-Data-Source` headers.
- **Caching:** catalog routes send a strong `ETag` with `Cache-Control: no-cache`, so clients can get `304`. Readings send `Cache-Control: private, max-age=N` and `X-Cache: hit|miss|stale`.
- **Request IDs:** every response has `X-Request-Id`. If a proxy already sent one, it is reused.
- **CORS:** off unless `CORS_ORIGINS` lists the allowed browser origins (for example `http://localhost:5173`).

## Scripts

| Command | Needs portal? | What it does |
|---|---|---|
| `npm test` | no | Unit and integration tests against a fake portal built from PROTOCOL.md |
| `npm run typecheck` | no | Strict TypeScript check |
| `npm run smoke` | yes | Logs in and reads the first page of meters |
| `npm run fetch-export` | yes | Downloads all meters through the signed export into `fixtures/local/meter-export.json` (git-ignored; a snapshot is committed as `fixtures/meter-export.json`) |
| `npm run scan -- <file>` | no | Data-quality report for an export file (`--json` for machine output) |
| `npm run probe` | yes | Read-only checks of the portal behaviour described in PROTOCOL.md |
| `npm run cross-check` | yes | Compares the signed export with the fallback path (`--all` for every meter) |
| `npm run verify` | yes | **Checks that the API returns everything the portal has.** Every meter, transformer and energy row from the real portal, against a running API (`--api http://<host>`, `--all` for every meter's readings, `--meters J100040`). Exits with code 1 on any unexplained difference. Full run: [`docs/VERIFY_RESULT.md`](docs/VERIFY_RESULT.md) |
| `npm run dump-page -- <id>` | yes | Prints one meter's decoded `__data.json` page (for odd pages) |
| `npm run bench:nearby` | no | Grid index vs full scan for nearby search, from 403 to 100k meters |

Live scripts never print secrets. The signing secret only appears as a short
SHA-256 fingerprint.

## Structure

```
src/
  config.ts              env validation (fails fast, never prints values)
  logger.ts              logging port
  portal/                anti-corruption layer: the only code that knows the portal's quirks
    authenticator.ts     POST /login, session cookie from Set-Cookie
    session.ts           one shared session: login on first use, early renewal, one login at a time
    portalClient.ts      authenticated GET: 401 re-login, retries, timeout, schema check
    signing.ts           HMAC-SHA256 request signing for the export
    exportApi.ts         /portal/keys + signed /portal/export
    schemas.ts           zod wire schemas (what the portal actually sends)
    createPortal.ts      wires the adapter together
    transformersApi.ts   paged /portal/dts (capacity, feeder, canonical DT names)
    energyApi.ts         /portal/meters/{id}/energy with the day filter
    fallbackApi.ts       slow path: search + __data.json + geo, same shape as the export
    devalue.ts           decoder for SvelteKit's __data.json format
  domain/                our clean model; knows nothing about HTTP or the portal's spelling
    meter.ts             Meter, Transformer, NetworkPosition, DataIssue
    normalize.ts         portal records -> domain (repairs, DT names, enum mapping)
    cellRepair.ts        fills blank hierarchy cells when name and code match one-to-one
    networkTree.ts       Zone > ... > Transformer tree with meter and status counts
    time.ts              IST parsing and formatting (fixed +05:30, no daylight saving)
    readings.ts          registers -> interval kWh, power factor, issues, hour/day totals
    anomalies.ts         anomaly rules and transformer load (pure functions)
  catalog/
    catalogSnapshot.ts   read-only indexed view: lookups, filters, facets, tree
    catalogService.ts    freshness: TTL, serve-stale-while-refreshing, serve-stale-on-error, one refresh at a time
    portalCatalogLoader.ts  export + /portal/dts -> snapshot
  readings/
    readingsService.ts   window rules, portal day mapping, cache with data-age TTL
  anomalies/
    anomalyService.ts    runs the rules over many meters, returns partial results on failure
  geo/
    spatialGrid.ts       grid index + haversine distance for nearby search
  shared/
    ttlCache.ts          cache with TTL, shared loads, stale-on-error and LRU limit
    circuitBreaker.ts    closed / open / half-open, for the portal
    concurrencyLimiter.ts  at most N portal calls at once, with a bounded queue
    mapPool.ts           ordered map with limited concurrency
  quality/
    scanExport.ts        pure data-quality scan (also served by /v1/quality)
    crossCheck.ts        field-by-field comparison of export vs fallback
    parity.ts            portal-vs-API comparison used by npm run verify
  http/                  generic HTTP plumbing; knows nothing about meters
    routeRegistry.ts     one declaration per route -> validation, types and OpenAPI
    middleware.ts        request id, access log, API-key auth, rate limit, errors
    problem.ts           RFC 9457 errors; portal failures -> 502/503
    app.ts               builds the Express app (no listen, so tests can use it directly)
  api/                   our product: routes, request and response schemas
    schemas.ts           zod schemas for every query, param and response
    routes.ts            the 19 routes
    context.ts           what handlers may use (catalog, clock), freshness headers
    csv.ts               CSV writer for the bulk export routes
  main.ts                composition root: config -> portal -> catalog -> app -> listen
scripts/                 smoke, fetch-export, scan-export, probe, cross-check, verify-parity, bench-nearby, dev-offline, export-openapi
test/                    vitest suites, fake portal, small real-data fixture
docs/                    architecture, system design diagrams, extras, verify result, API examples
deploy/                  nginx gateway config, EC2 setup script, deploy.sh
.github/workflows/       ci.yml (checks on every push), deploy.yml (auto-deploy to EC2)
Dockerfile, docker-compose.yml
```

## Assumptions

- The account in the brief is a read-only service account. The portal is
  treated as read-only: no request changes anything there.
- Portal timestamps have no time zone and are IST (+05:30). India has no
  daylight saving, so a fixed offset is exact.
- A reading at time t closes the period before it. For most meters that is
  [t − 30 min, t). Some meters are read only once a day, so for them it is
  [t − 1 day, t). The service detects this per meter from the usual gap
  between readings and reports it as `summary.readingIntervalMinutes`.
- kWh and kVAh are cumulative registers, so usage is the difference between
  two readings. Usage across a gap is still exact; it just covers a longer
  period. A bucket only counts usage whose whole period fits inside it. So a
  once-a-day meter has daily totals but no hourly ones, and it is left out of
  half-hourly transformer load.
- One portal energy row had a value that is not a number (on J100089). It is
  skipped and reported as a `bad_value` reading issue. The rest of the month
  is still served, and the next reading covers the gap.
- The portal rate limits its energy endpoint with `429`. The client waits for
  the portal's `Retry-After`, or else 1, 2, 4, 8 and 15 s. A `429` does not
  open the circuit breaker, because the portal is healthy, just busy. If it
  keeps happening, the API answers 503 `upstream_rate_limited` with
  `Retry-After`.
- `/portal/dts` is the portal's own transformer list, so its names win when
  meter records disagree (DT-007).
- The portal data looks static (history ends on 30 June 2026), but nothing
  depends on that. The catalog TTL, the refresh diffs and the readings TTL all
  work the same if new meters or readings appear. New meters show up within
  15 minutes; new readings within the readings TTL.
- Voltage limits follow the Indian Electricity Rules (230 V ± 6%). The other
  anomaly thresholds are sensible defaults, kept in one place so an operator
  can tune them.
- Transformer load assumes each meter's kVAh belongs to its transformer and
  ignores line losses, so it is a lower bound.

## Historical data today, ready for live data

The portal only holds history right now: 403 meters and readings from 1 to 30
June 2026. Nothing new arrives. **The service does not rely on that.** It is
built as if new meters and new readings will keep coming, and it handles both
without a code change or a restart:

| If the portal starts adding... | What the service does |
|---|---|
| New meters or transformers | The catalog is re-read from the portal every 15 minutes (in the background, while the old copy keeps serving). New meters appear in every route within 15 minutes, and each refresh logs how many meters were added, removed or changed |
| Changed meter data (status, location, network) | Same refresh: the new snapshot replaces the old one in one step, so no request ever sees half old, half new data |
| New readings | The readings cache lifetime follows the age of the data. Old history is kept for 1 hour. Live data is kept only until the next reading is due (at most 5 minutes), so new readings show up almost at once |
| Readings beyond 30 June | Nothing is hard-coded to June. With no `from`/`to`, a request returns the 7 days ending at the meter's newest reading, whatever date that is. Any window up to 31 days works |
| More meters overall | Indexes, facets and the nearby grid are rebuilt with every snapshot. The limits of the in-memory design are in [Where this would struggle at scale](#where-this-would-struggle-at-scale) |

## Design decisions and trade-offs

### Getting the data

- **The bulk export is the main source.** One signed call returns all 403
  meters with location and hierarchy. The alternative is about 800 detail and
  geo calls.
- **The signing secret is fetched again before every export**, the same way
  the portal's own button does it. Today the secret never changes, but this
  keeps working if the portal starts rotating it. It costs one tiny request.
- **The export fails loudly if `total` does not match the number of items.**
  That would mean the portal started paging. Serving a half catalog without
  saying so would be worse than an error.
- **A second way to build the catalog.** If the signed export breaks (new
  signing scheme, new format), the catalog is rebuilt from the pages the UI
  itself uses: meter search (21 pages), each meter's `__data.json` (decoded
  from SvelteKit's devalue format) and `/geo`. That is about 830 calls instead
  of 1, two meters at a time, so it is only a fallback. It is not used when the
  portal is simply down, because it would fail too. `meta.source` and
  `X-Data-Source` say which path the data came from. A test proves both paths
  give the same catalog, and `npm run cross-check` does the same on the real
  portal. Try the switch with `OFFLINE_BREAK_EXPORT=1 npm run dev:offline`.

### Cleaning the data

- **Wire schemas are relaxed where the data is messy and strict where a change
  means the protocol changed.** Blank hierarchy cells and unknown `build`
  values pass. A missing field or a wrong type does not. Cleaning is the
  domain layer's job.
- **Codes are not unique below Circle.** `D-01` sits under three circles, so a
  network node is identified by its full path (`Z-01.C-01.D-07...`), never by
  its code alone. The path uses dots, not slashes, so a node id fits in one URL
  segment (`/v1/hierarchy/Z-01.C-01.D-07`).
- **Blank hierarchy cells are repaired only when it is safe.** A blank code is
  filled only if that name maps to exactly one code elsewhere in the data, and
  the other way round. Every repair is recorded on the meter as a
  `network_cell_repaired` issue, so the API never hides that it changed portal
  data.
- **DT-007 has two names.** `/portal/dts` says "Sanganer DT 7", so that name
  wins. The other name is kept as an alias, and the three affected meters
  carry a `transformer_name_conflict` issue. Without `/portal/dts`, the name
  most meters use wins.
- **Unknown values do not break the catalog.** A new status or phase becomes
  `"unknown"` with an issue. One odd record should not fail all 403 meters.

### Keeping it fresh

- **One read-only snapshot, swapped in one step.** A refresh builds a new
  indexed snapshot next to the old one and then replaces it with a single
  assignment. Requests already running keep the snapshot they started with.
- **The freshness rule for the catalog.** It is fresh for 15 minutes. After
  that, the service still answers from memory straight away and refreshes in
  the background (stale-while-revalidate). If the refresh fails, it keeps
  serving the old data and logs the error (stale-if-error), for up to 24
  hours. After 24 hours, requests wait for a refresh and see its error. Every
  refresh logs how many meters were added, removed or changed, so any drift is
  visible.
- **`/portal/dts` is optional for a refresh.** It only adds capacities and the
  DT-name tie-break, so if it fails the catalog is still built, just with less
  detail.
- **Readings are fetched when asked for, and cached by (meter, days).**
  Fetching all 403 meters up front would waste calls on data nobody looks at.
  The cache lifetime follows the age of the data. If the newest reading is
  more than a day old, it is history and is kept for an hour. Live data would
  be kept only until the next reading is due (at most 5 minutes). Requests for
  the same thing at the same time share one portal call. If the portal fails,
  an expired copy is served for up to 6 hours, marked `stale`.
- **One export snapshot is committed** (`fixtures/meter-export.json`, 403
  meters, about 360 KB) so offline mode shows the whole fleet. It holds only
  meter data, no credentials or session data. New exports go to the
  git-ignored `fixtures/local/`. Tests use a 14-meter sample picked for its
  quirks.

### Being a good client of the portal

- **Protecting the portal, and us from the portal.** Every portal call goes
  through a concurrency limit (4 at once, queue of 200) and a circuit breaker.
  The breaker opens after 5 failures in a row, waits 30 s, then lets one trial
  call through. Only real health problems count: unreachable, timeouts,
  5xx after retries, broken login. A 404 means the portal is fine. While the
  breaker is open, calls fail in microseconds with `503` and `Retry-After`,
  catalog routes keep answering from memory, and cached readings are still
  served. `/ready` shows the breaker state. `test/chaos.test.ts` runs the whole
  stack against a portal that fails 30% of the time with random delays, and
  against one that goes down and comes back.
- **Portal failures are not the consumer's fault.** A portal login failure
  gives `502`. An unreachable portal gives `503` with `Retry-After`. Neither
  gives `401`. With a cached catalog, most routes keep working while the
  portal is down.

### The API itself

- **Express 5** for HTTP. It is widely known, and v5 passes errors from async
  handlers to the error middleware without extra wrappers.
- **One route declaration drives validation, types and docs.** Each route is
  declared once, with zod schemas for its params, query and response. The
  registry validates requests with them, TypeScript gets the handler's types
  from them, and the OpenAPI document is generated from them. So the docs
  cannot drift from the code, and the tests check every response against its
  schema.
- **Consumer API keys, separate from the portal account.** Consumers never see
  portal credentials. Keys are set in env as `name:key`. Only their SHA-256
  hashes are kept, and they are compared in constant time. The name (never the
  key) goes into logs and the rate limiter. With no keys set, the server
  refuses to start, unless `AUTH_MODE=disabled` is set on purpose.
- **Rate limit per consumer:** 300 requests a minute by default (per IP on
  public routes). It lives in memory, which is right for one instance.
  Several instances would share it through Redis.
- **Liveness vs readiness.** `/health` only says the process is alive. `/ready`
  says the catalog has loaded, so a load balancer does not send traffic before
  there is data.
- **Readings are cumulative registers, so usage is a difference.** Each
  half-hourly reading closes the half hour before it, so `intervalKwh` at
  00:30 is the usage from 00:00 to 00:30. A window selects periods, not
  readings. That way raw half hours, hourly buckets, daily buckets and the
  summary all add up to the same total, and a test checks it. Float noise
  like 0.42000000000000455 is rounded to 6 decimals (inputs have 2).
- **IST everywhere, written out.** Portal timestamps have no zone. We read them
  as IST and always write the offset (`2026-06-29T00:30:00+05:30`).
- **Odd readings are reported, not hidden and not fatal.** Gaps, off-grid
  readings, a register that goes down, or kWh greater than kVAh give a null
  interval and an entry in `issues`. Hour and day buckets say
  `complete: false` when a half hour is missing. Empty buckets are still
  returned.
- **The portal filters by whole days only, so we cut the exact window.** We
  ask for the IST days that cover the window (including the reading that
  closes its last half hour), then cut locally. So `from=...T10:15` works even
  though the portal ignores times. Windows are checked before any portal call
  (31 days at most).
- **Nearby search uses a grid index.** Meters are put into cells of about
  1 km. A query checks only the cells its circle touches, then works out exact
  haversine distances. A test checks it returns exactly what a full scan
  returns. `npm run bench:nearby` (2000 queries, 1 km radius):

  | Meters | Full scan / query | Grid / query | Speed-up |
  |---|---|---|---|
  | 403 | 41 µs | 3.8 µs | 11x |
  | 10,000 | 703 µs | 10 µs | 68x |
  | 100,000 | 13.2 ms | 260 µs | 51x |

  At 403 meters both are instant. The grid makes the cost depend on how many
  meters are nearby, not on the size of the fleet.
- **Anomalies are simple rules, not a model.** Each rule has a named threshold
  an operator can question (`src/domain/anomalies.ts`):

  | Code | Rule |
  |---|---|
  | `voltage_out_of_range` | R-phase voltage outside 230 V ± 6% (216.2 to 243.8 V; Indian Electricity Rules 1956, rule 54) |
  | `low_power_factor` | Power factor over the window below 0.85 |
  | `zero_consumption` | 24 h or more of zero use on a meter that is not decommissioned |
  | `consumption_spike` | A half hour above median + 6 × MAD (and at least 0.5 kWh) |
  | `decommissioned_but_consuming` | A decommissioned meter that recorded consumption |
  | `data_gap`, `register_decreased` | Missing half hours; a cumulative register that went down |
  | `transformer_overload` | Peak total demand of a transformer's meters at 80% (warning) or 100% (critical) of its kVA rating |

  Real data already triggers one: `J100000` is *Decommissioned* in the
  export, yet its kWh register rose by 142 kWh in a week. A scan covers at most
  50 meters (one portal call each, then cached). Meters whose readings fail
  are listed under `failed`, and the rest are still returned.
- **Transformer load is a lower bound.** kVAh used in a half hour × 2 gives the
  average kVA. That is summed over the transformer's meters and compared with
  `capacityKva` from `/portal/dts`. Line losses and unmetered load are
  invisible to us, so the real load is higher.
- **No Redis yet, on purpose.** One process holds everything in memory: the
  catalog (403 meters, well under 1 MB), the readings cache (at most 500
  entries; a full month for one half-hourly meter is 1440 readings, about
  150 KB, so about 75 MB at worst) and the rate-limit counters. That is right
  for a single instance and needs no extra service. Redis becomes worth it
  with several instances behind a load balancer: rate limits must then be
  shared (otherwise each instance allows 300 a minute), and a shared readings
  cache saves repeat portal calls. The cache and the limiter sit behind small
  interfaces (`TtlCache`, express-rate-limit's store), so that change stays
  small.
- **Strong ETags** let a polling frontend get `304 Not Modified` for free while
  the catalog has not changed.

## Data quality

From `npm run scan` on the 403-meter export: no duplicate or missing IDs and
no bad coordinates. 22 meters have one blank hierarchy cell, and all 22 can be
repaired because name and code map one-to-one elsewhere in the data. `DT-007`
has two names (10 meters say "Sanganer DT 7", 3 say "Old Malviya Nagar Xfmr").
Codes from Division to Feeder are reused under different parents, so codes
alone do not form a tree. Each transformer, though, always has exactly one path
above it.

From `npm run verify -- --all` on the live portal: only 40 meters
(J100000 to J100039) are read every half hour. The other 363 are read once a
day, at 00:00. One meter (J100089) has a non-numeric energy value.

## Where this would struggle at scale

The design fits the data as it is: 403 meters, one portal, one instance. Here
is where it would stop fitting:

- **The whole catalog lives in memory and is rebuilt from one export call.**
  That is fine up to tens of thousands of meters (403 meters is well under
  1 MB). With millions of meters, the export would be too big for one
  response and a rebuild would take seconds of CPU. A database with real
  indexes (Postgres + PostGIS) would replace the in-memory snapshot.
- **Readings are fetched from the portal when asked for.** One meter's month is
  one portal call. An anomaly scan over a transformer is one call per meter,
  capped at 50 meters per request and 4 portal calls at a time. A scan of all
  403 meters would take minutes through the portal. At that point readings
  should be pulled in the background into a time-series store (TimescaleDB),
  and scans should run there.
- **The nearby grid** uses fixed cells of about 1 km. If density is very uneven
  (100k meters in one block, few anywhere else), the busy cells get large. A
  quadtree, geohash or PostGIS GiST index would adapt. The benchmark shows it
  is fine up to 100k evenly spread meters.
- **State is per instance.** Rate-limit counters, the readings cache and the
  circuit breaker live in each process. Two instances would each allow the
  full rate and each hit the portal. That is when Redis comes in (see "No Redis
  yet" above).
- **The portal is the real bottleneck.** Anything not cached is limited by how
  hard we are willing to hit a legacy system. The concurrency limit is low (4)
  on purpose, to be a polite client.

## Intentionally skipped

- **A database.** The data fits in memory and the portal stays the source of
  truth. A second copy would need sync logic for no gain at this size.
- **Redis.** Only needed with two or more instances (shared rate limit and
  cache). One instance is enough here.
- **Writes.** The brief is about reading the portal, so there are no create or
  update routes.
- **User accounts / OAuth.** Static API keys per consumer are enough for a
  service-to-service API. Keys are hashed and compared in constant time.
- **HTTPS inside the app.** TLS belongs at the edge (nginx with a certificate,
  or a load balancer). The deploy guide explains how; it needs a domain.
- **The web client in this repo.** It has its own repo
  ([urja-v0-frontend](https://github.com/Sameer-choudhary-git/urja-v0-frontend),
  live at https://urja-umber.vercel.app). The API stays the focus here, and
  the two deploy separately (EC2 and Vercel).
- **Machine-learning anomaly detection.** Rules with named thresholds are
  easier to trust and to argue with. One month of data is also too little to
  train anything on.

## With more time

- Pull readings into TimescaleDB in the background, so fleet-wide scans and
  long-range queries do not depend on the portal at request time.
- Redis for shared rate limits and a shared readings cache, then two instances
  behind the gateway.
- Metrics (Prometheus: portal latency, breaker state, cache hit rate) and
  tracing, next to today's JSON logs.
- Contract tests that run the probe against the live portal on a schedule and
  alert when a response shape or quirk changes.
- Cursor pagination for very large lists, and field selection to keep
  payloads small for mobile clients.
- HTTPS with a domain and automatic certificates, and a Docker image built in
  CI and pushed to a registry instead of building on the server.

## Deployment

`docker compose up -d --build` runs the API behind an nginx gateway. nginx
adds a per-IP rate limit, allows only GET/HEAD/OPTIONS, returns problem+json
error pages and gzips responses. The API container runs as a non-root user on
a read-only filesystem, with a memory limit and a health check.

GitHub Actions runs `.github/workflows/ci.yml` (typecheck, tests, build and a
Docker build) on every push. When CI passes on `main`,
`.github/workflows/deploy.yml` deploys to EC2 over SSH, using a key that can
only run the deploy script (`deploy/deploy.sh`). `deploy/ec2-setup.sh`
prepares a fresh Ubuntu instance (Docker, Compose, swap). Only port 80 is
open to the internet; the portal login and API keys live in a `.env` file on
the server, never in git.
