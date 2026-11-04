# Reflection

## What assumptions did I make?

- **Time zone.** The portal's timestamps have no time zone, so I read them as
  IST (+05:30). India has no daylight saving, so a fixed offset is exact, not
  a guess.
- **Readings are running totals.** `kwh` and `kvah` only ever go up, so I
  treated them as cumulative registers. The usage in a half hour is the
  difference between two readings, and the reading at 00:30 closes the period
  00:00 to 00:30.
- **Which name wins.** When the export and `/portal/dts` disagree on a
  transformer's name (DT-007), I trusted `/portal/dts`, because it is the
  portal's own transformer list. I kept the other name as an alias and marked
  the affected meters with an issue.
- **Read-only.** I assumed the account in the brief is a normal read-only
  user, so the service never writes anything to the portal.
- **The data might change.** All the history is from June 2026, so the data
  looks frozen. I did not rely on that. The catalog refreshes every 15
  minutes and the readings cache lifetime follows the age of the data, so new
  meters or readings would show up without a code change.

The full list is in the README under "Assumptions".

## Which part was the most difficult, and how did I get unstuck?

**Finding a good way to get the data out.** The UI shows a paged meter table
and a detail page per meter. The obvious route is 21 search pages plus a
detail call and a geo call for every meter, about 830 requests. When I
watched the network tab while clicking the export button, I saw a signed
request: the browser first gets a secret from `/portal/keys`, then sends
`x-timestamp` and `x-signature` headers. I worked out the signing scheme by
computing HMAC-SHA256 myself over captured requests until my signatures
matched the browser's exactly. Then I checked that the secret stays the same
across logins. After that, one call gives all 403 meters.

**Reading the detail pages.** The detail page's `__data.json` uses
SvelteKit's devalue format, a flat array where numbers point back to other
positions in the same array. I read devalue's source and wrote a small
decoder that fails loudly on anything it does not expect. Later the live
cross-check showed a second detail shape (`classData`, a JSON string), and the
decoder handles that too now. This path is the fallback if the signed export
ever breaks.

## What mistakes did I make?

**I trusted my own fake portal too much.** My tests use a fake portal that I
built from the first few detail pages I looked at. All of them had a
`detail.data` list, so the tests passed. The first live cross-check then
crashed on meter J100020, whose page has the detail as a `classData` string
with different field names. The lesson: a fake built from a few samples only
tests my assumptions, not the real system. I fixed the schema and the parser,
changed the cross-check to collect failures per meter instead of stopping at
the first one, and added a `dump-page` script to look at odd pages.

**I assumed every meter is read every half hour.** The meters I tested with
early on all were, so I built the readings logic around 30-minute intervals.
When I ran the full parity check (`npm run verify -- --all`) against every
meter, I found that 363 of the 403 meters are read only once a day. The same
run also hit the portal's rate limit (HTTP 429 after about 230 calls in 6
seconds) and found one meter (J100089) with a value that is not a number. I
changed the service to detect each meter's reading rhythm from its data, to
wait and retry properly on a 429 without opening the circuit breaker, and to
report the bad value as an issue instead of failing the whole month. Running
against **all** the real data, not a sample, is what found all three.

**A small one.** JavaScript's `Date.parse` quietly turns `2026-02-31` into
3 March, so an impossible date in a query was accepted. I now check calendar
dates myself and return a 400.

## If I had more time, what would I improve?

- **Roles and proper auth, for the API and the frontend.** Today every
  consumer has one static API key with the same access. I would add users and
  roles (for example field staff, analysts, admins), log in through OAuth/OIDC,
  and give each role only the routes and data it needs. The frontend would get
  real sign-in and show different things to different roles.
- **Dedicated dashboards per team.** The web client has one general view. I
  would build focused dashboards: a field-operations map of faulty meters, a
  planning view of transformer loading over time, a revenue-protection view
  of anomalies, and a data-quality view for data owners.
- **More than one server.** Right now there is one instance on one EC2
  machine. I would run several instances behind a load balancer, move the
  rate-limit counters and the readings cache to Redis so they are shared, and
  add HTTPS with a real domain.
- **Better logging and monitoring.** Today there are JSON logs per container.
  I would send them to one central place (for example CloudWatch or Grafana
  Loki), add metrics (portal latency, breaker state, cache hit rate, error
  rates), tracing across the frontend and the API, and alerts when something
  goes wrong.
- **Background ingestion of readings.** Readings are fetched from the portal
  when someone asks. An anomaly scan over a transformer needs one portal call
  per meter, so it is capped at 50 meters. I would pull readings in the
  background into a time-series store (TimescaleDB), so fleet-wide scans and
  long date ranges are fast and do not depend on the portal at request time.
- **Watching the portal for changes.** I would run the read-only probe on a
  schedule, so a change in the portal's responses raises an alert before a
  user sees an error.

## If I were reviewing my own submission, what would I criticise?

- **It may look heavy for 403 meters.** I designed the API for several teams
  at once, which is why responses include facets, full network paths,
  data-quality issues and worked-out reading values. The README maps each of
  those to the team that needs it. I kept the infrastructure small on purpose
  (one process, no database, no Redis). Still, the circuit breaker,
  concurrency limiter, grid index and fallback path are each more code to
  maintain, and it is fair to ask whether all of them were needed on day one.
- **The tests prove consistency, not reality.** The fake portal is my reading
  of the protocol. Only the probe, cross-check and verify scripts touch the
  real portal, and they are run by hand, not in CI.
- **Some numbers are estimates.** Transformer loading is a lower bound (it
  cannot see line losses or unmetered load), and the anomaly thresholds are
  sensible defaults, not values agreed with someone who runs a distribution
  network.

## How I used AI

I used an AI assistant (Claude) as a guide and pair programmer. It helped me
compare approaches, check my reasoning, explain things I had not used before
(devalue, Express 5 error handling, generating OpenAPI from zod), and draft
code and documents. I ran everything myself, tested it against the live
portal from my machine (the assistant had no access to the portal), and
changed what did not match reality, such as the second detail-page shape and
the once-a-day meters above. I went through the code module by module, with
flow diagrams, until I could explain each file and why it is built that way.
