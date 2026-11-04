# PROTOCOL.md: How the Urja Meter Ops portal works

**What this is.** A write-up of how `https://urja-ops.flockenergy.tech` works, found by using it as a normal logged-in user: browser DevTools first, then replaying requests. The portal was treated as read-only throughout.

**Conventions.** Everything below was seen in a captured request or response unless marked *(inferred)*. Section 6 lists what is still unknown.

---

## 1. Overview

The portal is a SvelteKit app *(inferred from the `__data.json` routes and `x-sveltekit-*` headers)* with login handled by Better Auth *(inferred from the cookie name)*. The dataset has **403 meters** (`J100000` to `J100402`) and **40 distribution transformers (DTs)**.

| I want... | Call | Auth |
|---|---|---|
| Meter list, searchable | `GET /portal/meters/search?q=&page=` | cookie |
| One meter's attributes and network hierarchy | `GET /meters/{id}/__data.json` | cookie |
| Half-hourly energy readings | `GET /portal/meters/{id}/energy?from=YYYY-MM-DD&to=YYYY-MM-DD` (both optional) | cookie |
| Meter coordinates | `GET /portal/meters/{id}/geo` | cookie |
| DT list | `GET /portal/dts?page=` | cookie |
| Attributes, coordinates and hierarchy for **all** meters | `GET /portal/export?page=1` | cookie + signed headers |
| Signing secret for the export | `GET /portal/keys` | cookie |

The UI has three areas: **Meters** (list and detail pages), **Transformers** (DT table and an "Export all meters" button), and an **Ops Desk** link, which is only a hardcoded string with no data behind it.

---

## 2. Authentication and sessions

**Login**

```
POST /login
Content-Type: application/x-www-form-urlencoded
Accept: application/json
x-sveltekit-action: true

email=<email>&password=<password>
```

Response body: `{"type":"redirect","status":303,"location":"/meters"}`. The useful part is the `Set-Cookie` header:

| Attribute | Value |
|---|---|
| Name | `__Secure-better-auth.session_token` |
| Path | `/` |
| HttpOnly / Secure | yes / yes |
| SameSite | Lax |
| Lifetime | about **1 hour** |

- The credentials go in a **form body**, not JSON. The `x-sveltekit-action: true` header makes SvelteKit answer with JSON instead of an HTML redirect.
- Each login produces a **different token**. The same account was logged in from **multiple browsers at once** and all sessions worked, so concurrent sessions are allowed (upper limit unknown).
- Because the cookie is HttpOnly, a script must take it from the login response's `Set-Cookie`, not from page JavaScript.
- A script should send `Origin` and `Referer` headers matching the portal, as a browser does. SvelteKit rejects cross-site form POSTs by comparing `Origin`, so a script that omits it is likely to be refused *(inferred: login works with the header; not tried without it)*.
- Login from a script was confirmed live: HTTP 200, body `type: "redirect"`, cookie valid for 3600 seconds (`npm run smoke`).
- Only the cookie is needed on the `/portal/...` GET endpoints, except `/portal/export` (section 3.6).

**Without a session**, any `/portal/...` call returns **HTTP 401** with a JSON body:

```json
{"error": "unauthorized", "message": "A valid session is required."}
```

A client can therefore detect an expired session by the 401 and log in again. Even the mistyped path `/portal/meter` returned this 401 rather than a 404, so the guard seems to cover the whole `/portal` prefix *(inferred)*.

---

## 3. Endpoints

### 3.1 Meter search / list

```
GET /portal/meters/search?q=<text>&page=<n>
```

```json
{
  "data": [
    {"meterId": "J100001", "serialNo": "GE84132", "make": "L&T",
     "phaseType": "single", "installStatus": "Installed", "dtCode": "DT-002"},
     {...},
     {...}...
  ],
  "total": 403, "page": 1, "pageSize": 20
}
```

- Empty `q` returns everything: 403 meters, 20 per page, so 21 pages. No page-size control was seen.
- Search is **case-insensitive** and **substring** (`q=j1000` gave `total: 100`; `q=j100003` found `J100003`).
- A search with no match is a normal `200` with `{"data":[],"total":0,"page":1,"pageSize":20}`.
- Paging through the full list by hand showed no duplicate or missing meter IDs.
- Values: `phaseType` in {`single`, `three`}; `installStatus` in {`Installed`, `Faulty`, `Decommissioned`}; `make` in {HPL, L&T, Genus, Allied, Secure}.
- The list has no install type and no location.

### 3.2 Meter detail and hierarchy (`__data.json`)

```
GET /meters/{meterId}/__data.json?x-sveltekit-invalidated=001
```

This is SvelteKit's serialized page data (the UI requests it when you hover a meter row or open its page). It is not plain JSON; see section 4. Decoded for `J100001`:

```json
{
  "meterId": "J100001",
  "detail": {"data": [
    {"parameterName": "Meter ID", "parameterValue": "J100001"},
    {"parameterName": "Serial No", "parameterValue": "GE84132"},
    {"parameterName": "Make", "parameterValue": "L&T"},
    {"parameterName": "Phase Type", "parameterValue": "single"},
    {"parameterName": "Installation Status", "parameterValue": "Installed"},
    {"parameterName": "Installation Type", "parameterValue": "CT Operated"}
  ]},
  "hierarchy": {
    "Meter ID": "J100001", "Installation Status": "Installed", "Installation Type": "CT Operated",
    "Zone": "Jaipur Zone 2 (Z-02)", "Circle": "Circle 2 (C-02)", "Division": "Division 2 (D-02)",
    "Subdivision": "Subdivision 2 (SD-02)", "Sub Station": "Substation 2 (SS-02)",
    "Feeder": "Feeder 2 (F-002)", "DT": "Mansarovar DT 2 (DT-002)"
  }
}
```

- The response is `{"type":"data","nodes":[...]}`. With `x-sveltekit-invalidated=001` the first two nodes are `{"type":"skip"}` (layouts) and the third holds the page data.
- `detail` comes in **two shapes**. Usually (`J100001`) it is a list of name/value pairs, not a flat object. For some meters (`J100020`) it is instead a **JSON string inside the JSON**, under `classData`, with different field names:

  ```json
  "detail": {"classData": "{\"installed_meter\":{\"MeterId\":\"J100020\",\"SerialNo\":\"AL20290\",\"Make\":\"Allied\",\"PhaseType\":\"three\",\"InstallationStatus\":\"Installed\",\"InstallationType\":\"CT Operated\"}}"}
  ```

  The wrapper key `installed_meter` may depend on the status (only an installed meter has been seen in this shape). The `hierarchy` block repeats the installation status and type in both shapes, so it is the reliable place to read them.
- Each hierarchy level is one string, `"<Name> (<Code>)"`.
- An unknown meter ID in the page URL returns `404`.
- Together with search (3.1) and `/geo` (3.4), this page carries every field of the export except `build`, so it is a second (slower: about 830 calls instead of 1) way to get the full dataset.
- **The two paths agree.** A field-by-field comparison on the live portal (`npm run cross-check`, 2026-11-03): search and export list the same 403 meter IDs; for 40 meters spread over the list, 39 were identical in every field (serial, make, phase, status, installation type, location, all seven hierarchy levels). The one difference: `J100370`'s Circle is blank on the detail page, while the export has a blank name but the code `C-05`. So blank hierarchy cells exist on both paths, and they are not always blank in the same way.

### 3.3 Energy readings

```
GET /portal/meters/{meterId}/energy
```

```json
{"data": [
  {"timestamp": "23/06/2026 23:30", "kwh": "48438.74", "kvah": "52313.84", "voltR": "226"},
  {"timestamp": "24/06/2026 00:00", "kwh": "48439.16", "kvah": "52314.29", "voltR": "229"},...
]}
```

Checked on `J100000`:
- **337 rows**, one every 30 minutes, from `23/06/2026 23:30` to `30/06/2026 23:30` (7 days plus one reading, about 27 KB). No pagination wrapper and no query parameters were used.
- `timestamp` is `DD/MM/YYYY HH:mm` with **no timezone** (day 23 and above cannot be a month). IST is likely *(inferred)*.
- All values are **strings**.
- `kwh` and `kvah` are **cumulative register readings** that only grow, not per-interval usage. Usage for an interval is the difference between consecutive readings. Here `kwh` rose by 142.05 over 336 intervals, about 0.42 kWh per half hour.
- An unknown meter ID returns **404**: `{"error":"not_found","message":"Meter not found"}`.
- The same shape (`timestamp`, `kwh`, `kvah`, `voltR`) and the same default window were seen for legacy and v2 meters, single- and three-phase (J100000, J100005, J100004, J100013). So `build` does not change the energy format.

**Date filter.** The endpoint accepts `from` and `to` as **ISO dates** (`YYYY-MM-DD`). This is not used by the UI; it was found by trying common parameter names (`npm run probe`, all on `J100000`):

| Query | Rows | First .. last reading |
|---|---|---|
| *(none)* | 337 | 23/06/2026 23:30 .. 30/06/2026 23:30 |
| `from=2026-06-29&to=2026-06-30` | 96 | 29/06/2026 00:00 .. 30/06/2026 23:30 |
| `from=2026-06-30&to=2026-06-30` | 48 | 30/06/2026 00:00 .. 30/06/2026 23:30 |
| `from=2026-06-29` | 96 | 29/06/2026 00:00 .. 30/06/2026 23:30 |
| `to=2026-06-24` | 336 | **18/06/2026** 00:00 .. 24/06/2026 23:30 |
| `from=not-a-date&to=2026-06-30` | 336 | 24/06/2026 00:00 .. 30/06/2026 23:30 |
| `from=2026-07-01&to=2026-07-05` | 0 | outside the data |
| `from=2026-06-30&to=2026-06-29` | 0 | reversed range |
| `from=2026-06-29T12:00&to=2026-06-29T18:00` | 337 | ignored, same as no query |
| `from=29/06/2026&to=30/06/2026` | 337 | ignored, same as no query |
| `start=`/`end=`, `limit=10`, `page=2` | 337 | ignored |

What this shows:
- `from` and `to` are **whole days, both inclusive** (00:00 to 23:30 of each day). A time of day is not supported; a value with a time makes the server ignore the filter entirely.
- `to` alone returns the **7 days ending on `to`**, and an invalid `from` is dropped the same way. So the server's default is "7 days ending at `to`", and the no-query window is the last 7 days plus one reading.
- `to=2026-06-24` returned readings from **18 June**, before the default window starts. The portal therefore keeps **more history than the UI shows**.

**History depth** (probe section 4b, `J100000`):

| Query | Rows | First .. last reading |
|---|---|---|
| `from=2026-06-01&to=2026-06-30` | 1440 | 01/06/2026 00:00 .. 30/06/2026 23:30 |
| `from=2026-01-01&to=2026-06-30` | 1440 | 01/06/2026 00:00 .. 30/06/2026 23:30 |
| `to=2026-06-01` | 48 | 01/06/2026 00:00 .. 01/06/2026 23:30 |
| `to=2026-03-01`, `to=2026-01-01`, `to=2025-07-01` | 0 | before the data |
| `from=2020-01-01&to=2020-01-07` | 0 | before the data |

- History covers exactly **1 June 2026 00:00 to 30 June 2026 23:30**: 30 days, 1440 half-hour readings.
- **One request is not capped**: a 30-day range returns all 1440 rows (about 115 KB, estimated from the 7-day size). A range wider than the data is clipped to it, not rejected.
- The default (no query) window starts at 23:30 the day before, which is why it has 337 rows and not 336.
- An empty or reversed range is a normal `200` with an empty list, not an error.
- **Not every meter is half-hourly.** Seen with `npm run verify` on
  2026-11-04: of the first 115 meters compared, 40 had 1440 half-hourly rows
  for June and **75 (J100040 to J100115) had one reading a day**, at 00:00 (30
  rows), in the same shape (`timestamp`, `kwh`, `kvah`, `voltR`). The portal's
  own meter page shows the same daily rows. The rest of the fleet was not
  compared in that run (see the rate limit below), so the cadence has to be
  detected per meter, never assumed.
- **Values are not always numbers.** J100089 had one row (index 30 of June)
  whose `kwh` and `voltR` were not decimal strings, while the rest of the
  month was normal.
- **The energy endpoint is rate limited.** About 230 energy calls in 6 seconds
  (two clients at once) started `429` answers; short retries kept getting
  `429`. Whether a `Retry-After` header is sent was not captured.

### 3.4 Meter location

```
GET /portal/meters/{meterId}/geo
```

```  
{"data": {"latitude": "26.938961002479868", "longitude": "75.83095696146852"}}
```

Coordinates are strings.

### 3.5 Distribution transformers

```
GET /portal/dts?page=<n>
```

```json
{"data": [{"code": "DT-002", "name": "Mansarovar DT 2", "feederCode": "F-002", "capacityKva": 63},{...},...],
 "total": 40, "page": 1, "pageSize": 20}
```

- 40 DTs, 2 pages of 20. Capacities seen: 63, 100, 160, 250, 400 kVA. `capacityKva` is a JSON number.
- With 403 meters over 40 DTs, DTs are shared by about 10 meters each *(inferred)*.
- `page=3` returns `data: []` with `total: 40`, so a client can stop when it has `total` rows or gets an empty page.
- Names agree with the export for 39 of 40 DTs. The exception is `DT-007` (section 3.7).

### 3.6 Bulk export (signed)

The **Export all meters** button on `/transformers` fetches everything except energy in one request.

```
GET /portal/export?page=1
x-timestamp: <unix seconds>
x-signature: <64 hex characters>
Cookie: __Secure-better-auth.session_token=<session>
```

On each click the browser first calls `GET /portal/keys` (cookie only), which returns `{"data": {"signingSecret": "<32 characters>"}}`. It then signs the request in the browser and sends `export?page=1` with the two extra headers.

**Signing.** The algorithm is in the page's own JavaScript (the Transformers page) and uses the browser's Web Crypto API:

```
timestamp = floor(Date.now() / 1000)                  # Unix seconds, as a string
message   = METHOD + "\n" + PATH + "\n" + QUERY + "\n" + timestamp
signature = lowercase hex of HMAC-SHA256(key = signingSecret, data = message)
```

For this request the message is `"GET\n/portal/export\npage=1\n<timestamp>"` (four lines joined by a newline character).
- The query is written **without** the leading `?`.
- The secret is used as plain UTF-8 text as the HMAC key (not hex- or base64-decoded).
- The hex output is lowercase, each byte padded to 2 digits.
- Headers sent: `x-timestamp: <timestamp>` and `x-signature: <signature>`.
- **Verified offline**: recomputing this HMAC with the secret and timestamps of two captured requests (about 50 seconds apart) reproduced both `x-signature` values exactly. The same secret signed both, so it did not change between those two clicks.
- The UI always requests `page=1`, and on success saves the response's `data` array as `meter-export.json`.
- **The secret is fixed**, at least per user: it was identical on two calls within one session and across two separate logins (compared by SHA-256 fingerprint, `npm run probe`). How old a timestamp the server accepts was deliberately not tested, since that means sending stale signatures on purpose.

**Response.** `{"data": [...], "total": 403}`. One request with `page=1` returned **all 403 meters**, with no `page` or `pageSize` field. `page=0` and `page=2` return the same 403 meters, so the parameter is ignored. One item (`J100402`):

```json
{
  "meterId": "J100402", "serialNo": "GN11062", "make": "Genus", "phaseType": "three",
  "installStatus": "Installed", "installType": "CT Operated", "build": "legacy",
  "dtCode": "DT-007",
  "geo": {"lat": 26.97874373345878, "lng": 75.73645286911419},
  "hierarchy": {
    "zone":        {"name": "Jaipur Zone 1",          "code": "Z-01"},
    "circle":      {"name": "Circle 1",               "code": "C-01"},
    "division":    {"name": "Division 7",             "code": "D-07"},
    "subdivision": {"name": "Subdivision 7",          "code": "SD-07"},
    "substation":  {"name": "Substation 7",           "code": "SS-07"},
    "feeder":      {"name": "Feeder 7",               "code": "F-007"},
    "dt":          {"name": "Old Malviya Nagar Xfmr", "code": "DT-007"}
  }
}
```

- One call replaces about 403 detail calls plus 403 geo calls. Energy still needs one call per meter.
- The hierarchy is already structured (`name` and `code` split).
- Geo is numeric under `lat`/`lng`, unlike `/geo`.
- There is a new field, `build` (`"legacy"` here), whose meaning is unknown.

### 3.7 What the export data looks like

A full scan of the 403-meter export (`npm run scan`) found:

- **IDs are clean**: 403 unique IDs from `J100000` to `J100402` with no gaps, unique serial numbers, and valid coordinates for every meter (lat 26.79 to 27.04, lng 75.66 to 75.91, around Jaipur).
- **Value counts**: status Installed 238, Faulty 90, Decommissioned 75; phase single 277, three 126; install type Whole Current 205, CT Operated 198; build legacy 238, v2 165.
- **22 meters have one blank hierarchy cell** (a name or a code is `""`), at circle, substation or feeder level. All 22 can be filled safely, because each name maps to exactly one code (and back) everywhere else in the data.
- **One DT code, two names**: `DT-007` is "Sanganer DT 7" for 10 meters and in `/portal/dts`, but "Old Malviya Nagar Xfmr" for the last three meters (`J100400` to `J100402`). No other code has more than one name.
- **Codes are not unique below Circle.** `D-01` appears under circles C-01, C-03 and C-05; 54 codes from Division to Feeder sit under more than one parent. A node in the network tree must therefore be identified by its full path (`Z-01/C-01/D-07/...`), not by its code.
- **Each DT has exactly one path above it.** All meters on a DT agree on zone, circle, division, subdivision, substation and feeder. So the DT fixes a meter's whole position in the network.
- `dtCode` always equals `hierarchy.dt.code`.

---

## 4. Decoding `__data.json` (devalue format)

SvelteKit serializes page data with **devalue**: a flat array where every number inside an object or list is an **index into the same array**. Repeated values are stored once.

```
arr[0] = {"meterId":1, "detail":2, "hierarchy":21}     <- root, values are indexes
arr[1] = "J100001"                                     <- meterId
arr[4] = {"parameterName":5, "parameterValue":1}       <- parameterValue reuses arr[1]
arr[5] = "Meter ID"
arr[21] = {"Meter ID":1, "Installation Status":17, ..., "Zone":22, ..., "DT":28}
arr[22] = "Jaipur Zone 2 (Z-02)"
```

```
decode(i):  v = arr[i]
            object -> { key: decode(idx) }      list -> [ decode(idx) ]      else -> v
```

Take the nodes whose `type` is `data` and decode their `data` array; `skip` nodes carry nothing. devalue also has special encodings (`undefined`, `NaN`, `Date`, `Map`, ...) that have not appeared; a decoder should fail loudly on them.

---

## 5. Quirks and surprises

1. **Three data paths** with different shapes: clean JSON under `/portal/`, devalue-encoded `__data.json`, and a signed bulk export.
2. **Numbers as strings** in energy, voltage and `/geo`; `capacityKva` and the export's `lat`/`lng` are real numbers.
3. **Non-ISO timestamps** (`DD/MM/YYYY HH:mm`) with no timezone.
4. **Cumulative `kwh`/`kvah`**: per-interval usage must be derived.
5. **Name/value-pair detail** that must be normalized into an object.
6. **Name and code packed into one string** in `__data.json` (`"Mansarovar DT 2 (DT-002)"`), but split in the export.
7. **Inconsistent code padding**: `F-007` and `DT-007` (3 digits) against `D-07`, `Z-01`, `SD-07`, `SS-07` (2 digits).
8. **Same DT code, different names**: `DT-007` is "Old Malviya Nagar Xfmr" in the export and "Sanganer DT 7" in `/portal/dts`.
9. **Hierarchy is not a simple function of the DT number**: `J100001` has 2 at every level, while `J100402` (under `DT-007`) has Division to Feeder 7 but Zone 1 and Circle 1. Zone and Circle look like coarser groups shared by several DTs.
10. **Decommissioned meters still return readings**, and the data window is old and fixed.
11. **Location comes in three shapes**: `/geo` (strings, `latitude`/`longitude`), export (numbers, `lat`/`lng`).
12. **Short sessions** (about 1 hour), but concurrent logins are allowed.
13. **Uniform error shape** on `/portal`: `{"error": "<code>", "message": "<text>"}` for 401 and 404, while an unknown page route returns a bare `404 Not Found`.
14. **A no-match search is `200` with an empty list**, not an error.
15. **Hover prefetch**: SvelteKit requests `__data.json` as soon as you hover a meter row.
16. **An undocumented date filter** on energy (`from`/`to`, ISO dates, whole days) that the UI never uses, and history older than the window the UI shows (all of June 2026).
17. **Codes repeat under different parents** below Circle, and 22 meters have a blank hierarchy cell.
18. **The export's signing secret is handed to any logged-in client** (`/portal/keys`), and the signing runs in the browser. So the signature looks like a freshness and integrity check rather than a real access barrier *(inferred)*.
19. **Two shapes for the same detail block**: a name/value list for most meters, a JSON-encoded string (`classData`) with different field names for others (3.2).

---

## 6. Not yet determined

Still open:

- How old an `x-timestamp` the server accepts (deliberately not tested), and what a bad signature returns.
- Behaviour of an **expired** cookie (as opposed to a missing one); likely the same 401.
- The meaning of `build` (`legacy` 238, `v2` 165). It does not change the energy format.
- Which of DT-007's two names is right in the real world. `/portal/dts`, the dedicated transformer list, says "Sanganer DT 7".
- Rate limits. None were hit during normal use.
- `/meters/__data.json` (the list page's own data) and the detail `__data.json` without `x-sveltekit-invalidated`.

Answered since the first draft (details in the sections named):

- Signing secret: fixed across calls and logins (3.6).
- Export pagination: `page` is ignored; one call returns all meters (3.6).
- Energy date filter: `from`/`to` ISO dates, whole days, inclusive (3.3).
- Energy history: 1 to 30 June 2026, and one request returns the whole month (3.3).
- Energy shape and window: the same for legacy and v2, single- and three-phase meters sampled (3.3).
- DT names: only `DT-007` disagrees between the export and `/portal/dts` (3.5, 3.7).
- Zone/Circle mapping: each DT has exactly one path above it, but codes below Circle repeat under different parents (3.7).
- Second data path: search + `__data.json` + `/geo` match the export for 39 of 40 sampled meters (3.2).

---

## 7. Reproducing the unsigned calls

```bash
# Login and keep the cookie
curl -i -c cookies.txt -X POST https://urja-ops.flockenergy.tech/login \
  -H 'accept: application/json' -H 'x-sveltekit-action: true' \
  -H 'content-type: application/x-www-form-urlencoded' \
  --data-urlencode "email=$URJA_EMAIL" --data-urlencode "password=$URJA_PASSWORD"

curl -b cookies.txt 'https://urja-ops.flockenergy.tech/portal/meters/search?q=&page=1'
curl -b cookies.txt https://urja-ops.flockenergy.tech/portal/meters/J100001/energy
curl -b cookies.txt https://urja-ops.flockenergy.tech/portal/meters/J100001/geo
curl -b cookies.txt 'https://urja-ops.flockenergy.tech/portal/dts?page=1'
curl -b cookies.txt 'https://urja-ops.flockenergy.tech/meters/J100001/__data.json?x-sveltekit-invalidated=001'
```

The signed export, and the live checks behind sections 3.3 to 3.7, are scripted in this repo (read-only, no secrets printed):

```bash
npm run smoke          # login + first page of meters
npm run fetch-export   # signed export -> fixtures/local/meter-export.json
npm run scan           # data-quality report on that file (section 3.7)
npm run probe          # read-only checks for the open questions (sections 3.3, 3.6, 6)
npm run cross-check    # export vs search + __data.json + /geo, field by field (section 3.2)
```

Credentials come from environment variables. Session cookies and the signing secret must never be committed.
