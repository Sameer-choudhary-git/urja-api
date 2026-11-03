# Urja web client: build spec

A brief for building the web client with Lovable, v0, Bolt or by hand. Give the
tool this file, `openapi.json`, and (for exact shapes) `docs/api-examples.md`.
A ready-to-paste prompt is at the end.

## 1. What it is

Urja Meter Ops is a utility's internal portal for 403 smart meters in Jaipur:
meter details, where each meter sits in the electricity network, and its
half-hourly consumption. The portal itself is a plain table UI. Our API
(`urja-api`) exposes the same data cleanly, plus things the portal cannot do:
filters with counts, a network tree, nearby search, consumption analytics,
anomaly detection and transformer loading.

The web client is for **operations staff and analysts**. It should answer,
at a glance:

- How healthy is the fleet? (status split, anomalies, data freshness)
- Where are the meters, and which ones need attention? (map)
- What is this meter doing? (consumption, power factor, voltage, issues)
- How is the network structured, and how loaded is each transformer?

Read-only. No login screen of its own (see section 3).

## 2. Data facts the UI must respect

- **403 meters, 40 distribution transformers (DTs)**, one city.
- Network hierarchy, top to bottom: Zone > Circle > Division > Subdivision >
  Substation > Feeder > Transformer (DT) > Meter. A node's `id` is its full
  path, dot-separated: `Z-01.C-01.D-07.SD-07.SS-07.F-007.DT-007`. Codes repeat
  under different parents, so always use the `id`, never the code alone.
- Meter `status`: `installed`, `faulty`, `decommissioned` (and `unknown`).
  Suggested colours: installed green, faulty amber, decommissioned grey, unknown purple.
- **Energy history exists only for 1 to 30 June 2026** (half-hourly). Date
  pickers must default to that month and should not offer other dates as if
  data existed. Without `from`/`to` the API returns the 7 days ending at the
  newest reading (24 to 30 June).
- All reading times are **IST, with the offset in the string**
  (`2026-06-29T00:30:00+05:30`). Show them as IST; do not convert to the
  viewer's timezone.
- `kwhRegister` is a cumulative counter (like an odometer). Charts should plot
  **`intervalKwh`** (usage in that half hour) or the `kwh` of hour/day
  buckets, never the register.
- Some meters carry data-quality `issues` (e.g. a repaired blank network
  cell). Show a small badge, not an error.

## 3. Talking to the API

| Setting | Value |
|---|---|
| Base URL | env `VITE_API_BASE_URL`, e.g. `http://localhost:3000` |
| Auth | header `X-API-Key: <key>` (or `Authorization: Bearer <key>`) on every `/v1` call |
| Key | env `VITE_API_KEY`. Use a dedicated low-privilege key named `web` |
| Public routes | `/health`, `/ready`, `/openapi.json`, `/docs` need no key |
| CORS | the API must list the app's origin in `CORS_ORIGINS` (`dev:offline` allows any) |

A key in a browser app is visible to anyone who opens dev tools. Fine for a
demo with a read-only key; in production the app is served behind nginx,
which adds the key server-side so the browser never sees it.

**Errors** are RFC 9457 `application/problem+json`:

```json
{ "type": "...", "title": "Not found", "status": 404, "code": "not_found",
  "detail": "Meter J999999 does not exist", "requestId": "..." }
```

Show `detail` to the user and keep `requestId` copyable. Handle these codes:

| Status | Meaning | UI |
|---|---|---|
| 400 `invalid_request` | bad filter or date; `errors[]` lists fields | inline message on the field |
| 401 | missing or wrong key | full-page "API key not accepted" |
| 404 | not found | "Not found" state with a link back |
| 429 | rate limit (300/min per key) | toast, retry after a few seconds |
| 502 | portal answered wrongly or login failed | banner "Upstream portal error" |
| 503 | portal down; `Retry-After` header in seconds | banner "Portal unavailable, retrying in N s", auto-retry once |

**Freshness.** Catalog responses carry `meta: { asOf, ageSeconds, stale, source }`
and headers `X-Data-Age`, `X-Data-Stale`, `X-Data-Source`. Show a small
"Data as of 10:42 (2 min ago)" in the header; if `stale` is true, add
"refreshing"; if `source` is `fallback`, add "via fallback path". Readings
responses have their own `meta` with `cache` (`hit`/`miss`/`stale`).

**Caching.** Responses have strong ETags with `Cache-Control: no-cache`
(catalog) or `private, max-age=N` (readings). A fetch client with default
browser caching gets 304s for free. With TanStack Query, `staleTime` of 60 s
for catalog data and 5 minutes for readings is plenty.

**Lists** use `limit` (default 50, max 500) and `offset`; the response has
`page: { total, limit, offset }` and `facets` (counts per filter value over
ALL matches, ideal for filter chips). Multi-value filters: `status=installed,faulty`.

## 4. Endpoints the UI uses

Full contract: `openapi.json` (OpenAPI 3.1; can generate TypeScript types with
`openapi-typescript`). Examples: `docs/api-examples.md`.

| Screen | Call |
|---|---|
| Header | `GET /ready` (portal circuit state, catalog age) |
| Overview | `GET /v1/stats`, `GET /v1/stats?groupBy=status` (or `zone`, `make`...), `GET /v1/quality` |
| Meters table | `GET /v1/meters?q=&status=&phase=&installationType=&make=&node=&hasIssues=&sort=&order=&limit=&offset=` |
| Map | `GET /v1/meters.geojson` (same filters), `GET /v1/meters/nearby?lat=&lng=&radiusM=&status=` |
| Meter detail | `GET /v1/meters/{id}`, `GET /v1/meters/{id}/readings?from=&to=&granularity=raw\|hour\|day`, `GET /v1/meters/{id}/anomalies?from=&to=` |
| Network explorer | `GET /v1/hierarchy?depth=2`, `GET /v1/hierarchy/{nodeId}?limit=&offset=` (breadcrumb, children, meters) |
| Transformers | `GET /v1/transformers`, `GET /v1/transformers/{code}`, `GET /v1/transformers/{code}/load?from=&to=` |
| Anomalies | `GET /v1/anomalies?transformer=DT-007` or `?node=<id>` or `?meterIds=J100000,J100005`, optional `severity=warning` |
| Global search | `GET /v1/search?q=` (meters, transformers, network nodes) |

Rules worth knowing:
- `from`/`to` accept `2026-06-29` (date, `to` inclusive of that day) or
  `2026-06-29T12:00` (IST assumed). Max window 31 days.
- `/v1/anomalies` scans at most 50 meters and needs exactly one scope; for a
  bigger node the API answers 400 with a hint. Some meters can come back under
  `failed`; show them as "could not check".
- `/v1/meters/nearby` must be called with `lat` and `lng`; radius max 50 km.

## 5. Screens

### 5.1 Layout
Left sidebar: Overview, Meters, Map, Network, Transformers, Anomalies, Data quality.
Top bar: global search box (debounced `/v1/search`, grouped results), data
freshness badge, portal status dot from `/ready` (green closed, red open,
amber half_open). Light and dark theme. Works at 1280 px and down to a tablet.

### 5.2 Overview (home)
- KPI cards: total meters, installed, faulty, decommissioned (from `/v1/stats`),
  transformers count, meters with data issues.
- Donut: meters by status. Bar: meters by zone (`groupBy=zone`) stacked by status if
  possible (use `/v1/hierarchy?depth=1` `statusCounts`).
- "Needs attention" list: top transformers by meter count with a button
  "Scan for anomalies" that calls `/v1/anomalies?transformer=`.
- Small data-quality card from `/v1/quality` `summary` (issues by code).

### 5.3 Meters
- Table: ID, serial, make, phase, status (coloured pill), installation type,
  zone, feeder, transformer, issues badge. Sortable by the API's sort fields.
- Filter bar with chips from `facets` showing counts ("Faulty 31").
- Text search `q` (ID or serial substring). Server-side pagination.
- Row click opens Meter detail. "Show on map" button applies the same filters to the Map.
- Export current page to CSV (client-side).

### 5.4 Map
- Leaflet + OpenStreetMap tiles, centred on Jaipur (26.91, 75.79), zoom 11.
- Points from `/v1/meters.geojson`, coloured by status, clustered when zoomed out.
- Popup: ID, status, transformer, link to detail.
- "Nearby" mode: click on the map, choose a radius (500 m to 5 km), draw the
  circle and list `/v1/meters/nearby` results with distances; optional status filter.

### 5.5 Meter detail
- Header: ID, status pill, make, phase, installation type, serial.
- Breadcrumb of the network path (each part links to the Network explorer node).
- Mini map with the meter's point.
- Date range picker limited to June 2026 (presets: last 7 days of data, last 24 h of data, whole month).
- Granularity toggle: Half-hourly / Hourly / Daily.
- Chart 1: consumption (bars of `intervalKwh` or bucket `kwh`). Empty or
  incomplete buckets (`complete: false`) drawn hatched or lighter, with a tooltip.
- Chart 2: power factor line with a reference line at 0.85.
- Chart 3: voltage (R-phase) with a band from 216.2 to 243.8 V.
- Summary tiles: total kWh, average power factor, peak half hour (time + kWh),
  data coverage (`intervals / expectedIntervals`).
- Anomalies panel for the same window, severity-coloured (critical red,
  warning amber, info blue).
- Data issues list from the meter (`issues`) and readings (`data.issues`).

### 5.6 Network explorer
- Collapsible tree: Zone > ... > Transformer with meter counts and a tiny
  status bar per node (`statusCounts`). Load the first levels with
  `/v1/hierarchy?depth=2`, open deeper nodes via `/v1/hierarchy/{id}`.
- Right panel for the selected node: breadcrumb, child list, paged meters
  table, and "Scan this node for anomalies" (disabled with a tooltip if it has
  more than 50 meters).
- Optional: a sunburst or treemap of meter counts.

### 5.7 Transformers
- Table: code, name (with aliases tooltip, e.g. DT-007 also called
  "Old Malviya Nagar Xfmr"), capacity kVA, feeder, meter count.
- Detail: load chart from `/load`: `kva` per half hour as an area, a
  horizontal line at `capacityKva`, the 80% level dashed. Show
  `peakUtilisationPercent` big, coloured (green < 80, amber 80-100, red > 100).
  Note under the chart: "Sum of metered demand; real loading is higher
  (losses, unmetered load)."
- List of the DT's meters linking to their detail.

### 5.8 Anomalies
- Scope picker: transformer (dropdown of 40), network node (from the tree), or meter IDs.
- Date range (June 2026), severity filter.
- Results: counts by severity and by code as chips, then a table: severity,
  code (human label), meter, time, message, value. `failed` meters listed separately.
- Human labels: voltage_out_of_range "Voltage out of range", low_power_factor
  "Low power factor", zero_consumption "No consumption", consumption_spike
  "Consumption spike", decommissioned_but_consuming "Decommissioned but
  consuming", data_gap "Missing data", register_decreased "Register went
  down", transformer_overload "Transformer overload".

### 5.9 Data quality
From `/v1/quality`: summary numbers, issues by code (bar), the DT name
conflict table (code, canonical name, aliases), and a collapsible raw JSON of `scan`.

## 6. States and polish
- Skeleton loaders, not spinners, for tables and charts.
- Empty states with a hint ("No readings in this range. Data exists for 1 to 30 June 2026").
- Every error state shows the problem `detail` and `requestId`.
- Numbers: kWh with 2 decimals, power factor with 3, percentages with 1;
  thousands separators; Indian locale is fine (`en-IN`).
- URLs hold state (`/meters?status=faulty&page=2`, `/meters/J100000?from=2026-06-24&g=day`) so views can be shared.
- Accessible colour contrast; status is never shown by colour alone (pill text too).

## 7. Suggested stack
React + TypeScript + Vite, React Router, TanStack Query, Tailwind (+ shadcn/ui),
Recharts for charts, react-leaflet for the map, `openapi-typescript` for types
from `openapi.json`. No backend of its own.

## 8. Prompt to paste

> Build a read-only operations dashboard called "Urja Meter Ops" as a React +
> TypeScript + Vite app with Tailwind, shadcn/ui, TanStack Query, React Router,
> Recharts and react-leaflet. It talks to an existing REST API described by the
> attached openapi.json; base URL from VITE_API_BASE_URL and an API key from
> VITE_API_KEY sent as the X-API-Key header on every /v1 request. Errors are
> application/problem+json with `detail`, `code` and `requestId`; handle 400,
> 401, 404, 429, 502 and 503 (503 has a Retry-After header) as described in the
> attached spec. Screens: Overview, Meters (filterable, paginated table with
> facet counts), Map (GeoJSON points coloured by status, nearby search by
> clicking), Meter detail (consumption, power factor and voltage charts with
> half-hourly/hourly/daily toggle, anomalies), Network explorer (tree of
> Zone > Circle > Division > Subdivision > Substation > Feeder > Transformer),
> Transformers (load vs capacity chart), Anomalies (scan by transformer, node or
> meter IDs), Data quality. Energy data exists only for 1 to 30 June 2026 and
> all times are IST with the +05:30 offset; default date pickers to that month
> and display times in IST. Follow the attached WEB_CLIENT_SPEC.md for every
> screen, colour and rule.
