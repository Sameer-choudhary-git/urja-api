<!--
DRAFT. Rewrite every paragraph in your own words before you submit, and
delete this comment. The facts are taken from the build; the voice and the
opinions have to be yours, because the follow-up conversation will ask
about them.
-->

# Reflection

## What assumptions did you make?

The portal's timestamps carry no timezone, so I read them as IST (+05:30).
India has no daylight saving, which makes a fixed offset exact rather than
an approximation. I assumed `kwh` and `kvah` are cumulative registers (they
only ever go up, with one exception the code reports), so the usage in a half
hour is the difference between two readings, and the reading at 00:30 closes
the interval 00:00 to 00:30. Where the export and `/portal/dts` disagree on a
transformer's name (DT-007), I trusted `/portal/dts` because it is the
dedicated list, and kept the other name as an alias with an issue on the
affected meters. I assumed the account in the brief is a normal read-only
user, so the service never writes to the portal. The data looks frozen (all
history is June 2026), but I did not build on that: the catalog refreshes
every 15 minutes and the readings cache TTL follows how old the data is, so
new meters or readings would appear without a code change. The full list is
in the README under "Assumptions".

## Which part was the most difficult, and how did you get unstuck?

Finding the data paths. The UI shows a paginated meter table and detail pages,
so the obvious route is 21 search pages plus a detail and a geo call per
meter, about 830 requests. Watching the network tab while clicking the export
button showed a signed request: the browser first fetches a secret from
`/portal/keys`, then sends `x-timestamp` and `x-signature` headers. I worked
out the signing scheme by recomputing HMAC-SHA256 offline over captured
requests until my signatures matched the browser's exactly, then confirmed
that the secret stays the same across logins. After that, one call returns
all 403 meters. The second hard part was the detail page's `__data.json`,
which uses SvelteKit's devalue format (a flat array where numbers are indexes
back into the array). Reading devalue's source and writing a small decoder
that fails loudly on anything unexpected got me through it, and the live
cross-check later showed a second detail shape (`classData`, a JSON string)
that the decoder now handles too.

## If you had another day, what would you improve?

I would ingest readings in the background into a time-series store, so that
an anomaly scan over many meters does not need one portal call per meter at
request time. Today a scan is capped at 50 meters and runs at most 4 portal
calls at once, which is polite to the portal but slow for a whole-fleet view.
I would also add metrics (portal latency, breaker state, cache hit rate) next
to the JSON logs, and schedule the read-only probe against the live portal so
that a change in a response shape raises an alert instead of a user-facing
error.

## What mistake did you make while solving this?

I assumed every meter's detail page has the same shape. The fake portal in my
tests was built from the first pages I looked at, all of which had a
`detail.data` list, so the tests passed. The first live cross-check crashed on
meter J100020, whose page carries the detail as a JSON-encoded `classData`
string with different field names. The lesson was that a fake built from a few
samples tests my assumptions, not the real system. I fixed the schema and the
parser, made the cross-check collect per-meter failures instead of stopping at
the first one, and added a `dump-page` script to inspect odd pages. A smaller
one: JavaScript's `Date.parse` silently rolls `2026-02-31` over to 3 March, so
an invalid date in a query was accepted; I now validate the calendar date
myself.

## If you were reviewing your own submission, what would you criticise?

Some of it could look heavy for 403 meters. I designed the API for several
consumers at once (field operations, data analysts, planning, revenue
protection), which is why responses carry facets, full network paths,
data-quality issues and derived reading values; the README maps each of those
to the team that needs it. I kept the infrastructure small on purpose (one
process, no database, no Redis). Even so, the circuit breaker, concurrency
limiter, grid index and fallback data path are each more code to maintain, and
a reviewer could fairly ask whether all of them were needed on day one. The fake portal is my own reading of the protocol, so the
tests prove internal consistency, not that the real portal behaves that way;
only the probe and cross-check scripts touch the real thing, and they are run
by hand. Transformer loading is a lower bound with a synthetic-looking
dataset, so the numbers should not be read as real engineering advice. And the
anomaly thresholds are reasonable defaults rather than values agreed with
someone who operates a distribution network.

## How AI was used

I used an AI assistant (Claude) as a guide and pair programmer: to discuss
approaches, review my reasoning, explain unfamiliar pieces (devalue, Express 5
error handling, zod to OpenAPI), and draft code and documents that I then ran,
tested and changed. The portal investigation itself (network tab, captured
requests, running the probe, cross-check and dump-page scripts against the
live portal, reading their output) was done by me, since the assistant had no
access to the portal. I can walk through any file and the reason behind it.
