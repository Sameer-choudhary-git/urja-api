# Optional extensions and extras

The brief has a required core (API, README, PROTOCOL.md, openapi.json,
reflection) and a list of **optional extensions**. Part 1 of this page goes
through each optional extension: what was built, where the code is, and how to
try it. Part 2 lists what was built beyond the brief.

Where to try things:

| | |
|---|---|
| API (local) | `npm run dev` → http://localhost:3000/docs (see [README Quick start](../README.md#quick-start)) |
| API (deployed) | http://15.252.70.41/docs |
| Web client (live) | https://urja-umber.vercel.app |
| Web client (code) | https://github.com/Sameer-choudhary-git/urja-v0-frontend |

Every route below needs the reviewer API key from the README (`X-API-Key`).

---

## Part 1: the optional extensions from the brief

### 1. Network hierarchy

> *Reconstruct that structure and expose it in a useful way. Watch out for messy or inconsistent data.*

**Built.** The full chain Zone → Circle → Division → Subdivision → Substation →
Feeder → Transformer is rebuilt from the bulk export.

- **Codes are not unique.** `D-01` appears under three different circles, so a
  node is identified by its full path (`Z-01.C-01.D-07...`), never by its code
  alone.
- **Messy data is repaired only when it is safe.** 22 meters have one blank
  hierarchy cell. A blank is filled only when the name maps to exactly one code
  elsewhere in the data, and the other way round. Every repair is recorded on
  the meter as a `network_cell_repaired` issue, so the API never hides that it
  changed portal data.
- **Conflicting names are kept and flagged.** DT-007 is "Sanganer DT 7" in
  `/portal/dts` but "Old Malviya Nagar Xfmr" on 3 meters. The transformer list
  wins, the other name is kept as an alias, and those 3 meters carry a
  `transformer_name_conflict` issue.

| Try | What you get |
|---|---|
| `GET /v1/hierarchy?depth=3` | The tree, with meter and status counts on every node |
| `GET /v1/hierarchy/{nodeId}` | One node: breadcrumb, children, its meters (paged) |
| `GET /v1/meters?node=Z-01.C-01` | All meters under any node |
| `GET /v1/quality` | The data-quality report: repairs, conflicts, unknown values |
| Web: `/network` | Hierarchy explorer |

Code: `src/domain/networkTree.ts`, `src/domain/cellRepair.ts`, `src/quality/scanExport.ts`.

### 2. A local index / query layer

> *Answer questions the portal itself can't easily answer (filtering across attributes, "what's near this location?"). Say at what scale it would struggle.*

**Built.** The catalog is a read-only snapshot in memory, with indexes. Each
refresh builds a new one and swaps it in whole.

- **Filtering across attributes.** `/v1/meters` filters on status, phase,
  installation type, make, build, any network level, transformer, node and
  `hasIssues`. It also sorts, pages, and returns **facet counts** (how many
  meters each filter value would give you).
- **Nearby search.** A grid index with cells of about 1 km. A query only looks
  at the cells its circle touches, then works out exact haversine distances.
  A test checks it returns exactly what a full scan returns.
  `npm run bench:nearby`:

  | Meters | Full scan / query | Grid / query |
  |---|---|---|
  | 403 | 41 µs | 3.8 µs |
  | 10,000 | 703 µs | 10 µs |
  | 100,000 | 13.2 ms | 260 µs |

- **Other questions the portal can't answer:** `/v1/search` (meters,
  transformers and network nodes in one search), `/v1/stats?groupBy=zone`, and
  `/v1/meters.geojson` for maps.
- **Where it would struggle.** The README covers this in
  [Where this would struggle at scale](../README.md#where-this-would-struggle-at-scale).
  In short: memory is fine up to tens of thousands of meters. At millions you
  would move to Postgres + PostGIS. If density is very uneven, a quadtree or
  geohash beats a fixed grid.

| Try | |
|---|---|
| `GET /v1/meters?status=faulty&phase=three&hasIssues=true` | Filters + facets |
| `GET /v1/meters/nearby?lat=26.85&lng=75.80&radiusM=1000` | Nearest first, with distance |
| Web: `/meters`, `/map` (click anywhere on the map to see what is nearby) | |

Code: `src/catalog/catalogSnapshot.ts`, `src/geo/spatialGrid.ts`, `scripts/bench-nearby.ts`.

### 3. Freshness / caching

> *If you cache anything, how do you decide when it's stale?*

**Built, with two different rules, because the two kinds of data behave
differently.**

- **Catalog (meters, transformers, hierarchy).** Fresh for 15 minutes. After
  that, the API still answers straight away from memory and refreshes in the
  background (stale-while-revalidate). If the refresh fails, it keeps serving
  the old data (stale-if-error), for up to 24 hours. Every refresh logs how
  many meters were added, removed or changed.
- **Readings.** Cached per (meter, days). How long an entry lives depends on
  how old the data is. If the newest reading is more than a day old, it is
  history, so it is kept for an hour. Live data would be kept only until the
  next reading is due (at most 5 minutes). Requests for the same thing at the
  same time share one portal call. If the portal fails, an expired copy is
  served for up to 6 hours, marked `stale`.
- **The client can always see how fresh the data is.** Every answer has
  `meta.asOf`, `ageSeconds`, `stale` and `source`, also sent as the
  `X-Data-Age`, `X-Data-Stale` and `X-Data-Source` headers. Catalog routes send
  a strong `ETag`, so a polling client gets `304 Not Modified`. Readings send
  `X-Cache: hit|miss|stale`.

Code: `src/catalog/catalogService.ts`, `src/readings/readingsService.ts`, `src/shared/ttlCache.ts`.

### 4. Robustness

> *What happens over a long-running session, or when the portal misbehaves?*

**Built.**

- **Long sessions.** There is one shared portal session. It is created on first
  use and renewed before it expires. If many requests need a login at once,
  they share one login attempt (single-flight). On a 401, the client logs in
  again and retries once.
- **When the portal misbehaves:**
  - every call has a timeout and retries with backoff;
  - at most 4 portal calls run at once, with a queue of up to 200;
  - a circuit breaker opens after 5 failures in a row, waits 30 s, then lets
    one trial call through. While it is open, calls fail in microseconds with
    `503` and `Retry-After`.
- **The portal's rate limit (429), found with the verify script:**
  - the client follows `Retry-After`, or else waits 1, 2, 4, 8 and 15 s;
  - a 429 does not open the circuit breaker, because the portal is healthy,
    just busy;
  - if it keeps happening, consumers get `503 upstream_rate_limited` with a
    retry time.
- **Bad data:**
  - every portal response is checked with zod;
  - the schemas are relaxed where the data is messy and strict where a change
    would mean the protocol changed. For example, a non-numeric energy value
    becomes a `bad_value` reading issue, and the rest of the month still works.
- **Portal failures are not the consumer's fault.** A portal login failure
  gives `502` and an unreachable portal gives `503`. Neither gives `401`.
  Catalog routes keep answering from memory while the portal is down.
- **Proof.** `test/chaos.test.ts` runs the whole stack against a portal that
  fails 30% of the time with random delays, and against one that goes down and
  comes back. `/ready` shows the breaker and queue state. On shutdown, the
  server finishes the requests already running before it exits.

Code: `src/portal/session.ts`, `src/portal/portalClient.ts`, `src/shared/circuitBreaker.ts`, `src/shared/concurrencyLimiter.ts`.

### 5. The full dataset

> *There may be more than one way to get data out of the portal. If a bulk path exists, using it well is a nice touch.*

**Built both ways, plus bulk export from our own API.**

- **Main path: the portal's HMAC-signed bulk export.** One call returns all 403
  meters with location and hierarchy, instead of about 800 detail and geo
  calls. [PROTOCOL.md](../PROTOCOL.md) explains how the signature works. The
  client fails loudly if `total` does not match the number of items, in case
  the portal starts paging.
- **Fallback path: the pages the UI itself uses.** If the export breaks, the
  catalog is rebuilt from meter search (21 pages), each meter's `__data.json`
  (decoded from SvelteKit's devalue format with our own decoder) and `/geo`.
  That is about 830 calls, two meters at a time, so it is only a fallback. A
  test proves both paths give the same catalog, and `npm run cross-check`
  compares them on the real portal. `meta.source` says which path the data came
  from. Try it offline: `OFFLINE_BREAK_EXPORT=1 npm run dev:offline`.
- **Bulk export from our API.** `GET /v1/export/meters` and
  `GET /v1/export/readings` return flat rows, as JSON or as a CSV download,
  with no paging. An analyst can pull the whole fleet, or a transformer's
  readings, in one request.
- **Proof that nothing is lost.** `npm run verify -- --all` compares every
  meter, transformer and energy row on the live portal with the API. Result:
  **PASS**. All 403/403 meters and 40/40 transformers match, and none of the
  68,495 energy rows is missing or changed. 5 rows with non-numeric values were
  skipped and reported. See [VERIFY_RESULT.md](VERIFY_RESULT.md).

Code: `src/portal/signing.ts`, `src/portal/exportApi.ts`, `src/portal/fallbackApi.ts`, `src/portal/devalue.ts`, `src/quality/parity.ts`.

### 6. A modern web client

> *A small, modern web app on top of your API that presents the portal's data more usefully than the original.*

**Built**, in its own repo:
[urja-v0-frontend](https://github.com/Sameer-choudhary-git/urja-v0-frontend),
live at **https://urja-umber.vercel.app**. It uses Next.js, a dark theme,
Recharts and Leaflet. Every screen uses only this API's routes.

| Screen | What it shows |
|---|---|
| Overview | Fleet counts, status mix, meters by zone |
| Meters | Filters with facet counts, sorting and paging. Filters live in the URL, so a view can be shared |
| Meter detail | Network position, data issues, consumption charts (half-hourly, hourly, daily) with kWh, kVAh and voltage, peak day, completeness, anomalies, a readings table and CSV download |
| Map & nearby | All meters on a map, coloured by status. Click to find meters nearby |
| Network | Hierarchy explorer with counts per node and breadcrumbs |
| Transformers | Capacity, meters, and a load chart against the kVA rating |
| Anomalies | Scan a transformer, a node or a list of meters, most severe first |
| Data quality | The quality report: repairs, conflicts, unknown values |
| Header | Global search and live API status (catalog loaded, circuit breaker) |

Design choices:

- **The API key never reaches the browser.** A small server-side proxy
  (`app/api/urja/[...path]`) adds the key and forwards only GET requests to
  the API's read routes. It also avoids CORS and mixed-content problems (the
  site is https on Vercel, the API is http on EC2).
- **Errors and freshness are visible.** Errors keep the API's RFC 9457 shape
  (status, code, requestId, retry time). Every page shows a freshness badge.
- **Daily meters are shown honestly.** 363 of the 403 meters are read once a
  day. The meter page notices this, says so, and switches to the daily view
  instead of showing empty half-hour charts.

---

## Part 2: extras beyond the brief

| Extra | What it is | Where |
|---|---|---|
| Anomaly detection | Simple rules with named thresholds: voltage out of range, low power factor, zero consumption, spikes (median + 6 × MAD), decommissioned but consuming, data gaps, a register going down. Real data triggers one: J100000 is decommissioned, yet its register rose 142 kWh in a week | `/v1/meters/{id}/anomalies`, `/v1/anomalies`, `src/domain/anomalies.ts` |
| Transformer load | Total demand of a transformer's meters per half hour against its kVA rating. Warning at 80%, critical at 100% | `/v1/transformers/{code}/load` |
| Derived readings | Interval kWh from the cumulative registers, power factor, and hourly and daily totals in IST that always add up to the same total. Each meter's reading rhythm (every 30 min or once a day) is detected from the data | `/v1/meters/{id}/readings`, `src/domain/readings.ts` |
| Parity check | A script that checks, record by record, that the API returns everything the live portal has | `npm run verify`, [VERIFY_RESULT.md](VERIFY_RESULT.md) |
| Data-quality report | Every oddity found in the export, and what the API did about it | `/v1/quality`, `npm run scan` |
| OpenAPI from code | One route declaration (zod) gives request validation, TypeScript types and the OpenAPI 3.1 spec, so the docs cannot drift from the code. Swagger UI at `/docs` with one Authorize box | `src/http/routeRegistry.ts`, `npm run openapi` |
| API hygiene | Hashed API keys per consumer (constant-time compare, refuses to start without keys), rate limit per key, RFC 9457 errors with stable codes, ETags, request IDs, CORS allow-list, helmet, compression | `src/http/` |
| Offline mode | Runs the whole API against a fake portal built from the committed 403-meter export. No network and no `.env` needed | `npm run dev:offline` |
| Tests | 231 tests (vitest + supertest) against a fake portal, including chaos tests. No network needed | `test/` |
| Docker + nginx | Multi-stage image (non-root, read-only filesystem), Compose with an nginx gateway (20 requests/s per IP) | `Dockerfile`, `docker-compose.yml`, `deploy/nginx.conf` |
| CI/CD | GitHub Actions runs typecheck, tests and build on every push. A green run on `main` deploys to EC2 over SSH, with a key that can only run the deploy script | `.github/workflows/`, `deploy/deploy.sh` |
| AWS deployment | Live on one EC2 instance, with a step-by-step guide | http://15.252.70.41/docs, [DEPLOY_AWS.md](DEPLOY_AWS.md) |
| Probe and smoke scripts | Scripts used to discover and re-check how the portal behaves (`probe`, `smoke`, `cross-check`, `dump-page`) | `scripts/` |
| Documentation | Architecture with diagrams and one request followed step by step, a module-by-module testing guide, and real responses for every route | [ARCHITECTURE.md](ARCHITECTURE.md), [TESTING_GUIDE.md](TESTING_GUIDE.md), [api-examples.md](api-examples.md) |
