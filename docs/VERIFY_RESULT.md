# Parity check result: the API vs the live portal

`npm run verify -- --all` compares every record of the **live portal** with
what this API returns ([`scripts/verify-parity.ts`](../scripts/verify-parity.ts),
[`src/quality/parity.ts`](../src/quality/parity.ts)). A full run takes about
4 minutes and is deliberately slow (one meter at a time, the portal rate
limits), so the result of a run is recorded here.

**Run:** 2026-11-04, 05:25–05:29 UTC, on Windows, API started with
`npm run dev` (real portal, `.env` from `.env.example`), commit `301b116`.

**Result: PASS.** Nothing the portal has is missing from the API, and no value differs.

## Summary

| Check | Portal | API | Result |
|---|---|---|---|
| Meter IDs (signed export vs `GET /v1/meters`) | 403 | 403 | ✓ identical set |
| Meter fields (serial, make, status, phase, type, build, lat/lng, every network level's code and name) | | | ✓ 0 unexplained differences, 25 explained |
| Transformers (`/portal/dts` vs `GET /v1/transformers`: code, name, kVA, feeder) | 40 | 40 | ✓ 0 differences |
| Energy rows, 1–30 June (`/portal/meters/{id}/energy` vs `GET /v1/meters/{id}/readings?granularity=raw`) | 68,495 | 68,490 | ✓ 0 missing, 0 extra; 5 dropped on purpose and reported |
| Reading values (kWh, kVAh, V(R)) on every matched row | | | ✓ 0 differences |
| Interval usage adds up to the change in the kWh register | | | ✓ 403/403 meters |

## What the explained differences are

- **25 meter fields:** the API filled hierarchy cells the portal leaves blank
  (e.g. J100011 has no circle code; its siblings under the same division say
  C-06), and resolved DT-007's second name ("Old Malviya Nagar Xfmr" on
  J100400–J100402) to the canonical "Sanganer DT 7" from `/portal/dts`. Each
  one is listed in that meter's `issues` (`network_cell_repaired`,
  `transformer_name_conflict`), so a consumer can see exactly what was changed.
- **5 energy rows:** portal rows whose `kwh`, `kvah` or `voltR` is not a
  number. The API skips such a row and reports it as a `bad_value` reading
  issue; because registers are cumulative, the next reading's interval still
  carries the usage, which is why "usage adds up to the register change"
  passes for all 403 meters.

## What the run taught us about the portal

- **Only 40 of 403 meters are half-hourly** (J100000–J100039, 1,440 rows each
  for June). **The other 363 (J100040–J100402) are read once a day**, at 00:00
  (30 rows each): 40 × 1,440 + 363 × 30 = 68,490. The API detects the cadence
  per meter (`summary.readingIntervalMinutes`), gives daily meters daily totals
  and no hourly figures, and leaves them out of half-hourly transformer loading.
- **The energy endpoint rate limits.** Even one meter at a time with a 250 ms
  pause, it answered `429` three times (around J100116, J100236, J100356, i.e.
  roughly every 120 meters). The API waited and retried (0.6 s up to 8 s) and
  every meter still got through; the circuit breaker was not tripped.

## Full output

```text
PS D:\Shinchan\Flock Energy\urja-api> npm run verify -- --all
npm notice run urja-api@0.1.0 verify
npm notice run tsx --env-file=.env scripts/verify-parity.ts --all
Portal vs API at http://localhost:3000

1. Meters (signed export vs GET /v1/meters)
   ✓ meter IDs: portal 403, API 403
   meter fields: 0 unexplained difference(s), 25 explained
     ~ J100011 network.circle.code: portal="" api="C-06" (reported in the meter's issues)
     ~ J100044 network.feeder.code: portal="" api="F-005" (reported in the meter's issues)
     ~ J100074 network.circle.code: portal="" api="C-05" (reported in the meter's issues)
     ~ J100078 network.feeder.code: portal="" api="F-011" (reported in the meter's issues)
     ~ J100097 network.circle.code: portal="" api="C-06" (reported in the meter's issues)
     ~ ... and 20 more explained

2. Transformers (/portal/dts vs GET /v1/transformers)
   ✓ transformer codes: portal 40, API 40
   transformer fields: 0 unexplained difference(s), 0 explained

3. Readings 2026-06-01..2026-06-30 for 403 meter(s) (portal energy vs GET /v1/meters/{id}/readings?granularity=raw)
   ... 20/403
   ... 40/403
   ... 60/403
   ... 80/403
   ... 100/403
{"time":"2026-11-04T05:26:09.550Z","level":"warn","msg":"portal.rate_limited","script":"verify","path":"/portal/meters/J100116/energy","retry":1,"delayMs":585}
{"time":"2026-11-04T05:26:10.185Z","level":"warn","msg":"portal.rate_limited","script":"verify","path":"/portal/meters/J100116/energy","retry":2,"delayMs":1870}
{"time":"2026-11-04T05:26:12.124Z","level":"warn","msg":"portal.rate_limited","script":"verify","path":"/portal/meters/J100116/energy","retry":3,"delayMs":2552}
   ... 120/403
   ... 140/403
   ... 160/403
   ... 180/403
   ... 200/403
   ... 220/403
{"time":"2026-11-04T05:27:04.272Z","level":"warn","msg":"portal.rate_limited","script":"verify","path":"/portal/meters/J100236/energy","retry":1,"delayMs":836}
{"time":"2026-11-04T05:27:05.152Z","level":"warn","msg":"portal.rate_limited","script":"verify","path":"/portal/meters/J100236/energy","retry":2,"delayMs":1454}
{"time":"2026-11-04T05:27:06.671Z","level":"warn","msg":"portal.rate_limited","script":"verify","path":"/portal/meters/J100236/energy","retry":3,"delayMs":3454}
{"time":"2026-11-04T05:27:10.180Z","level":"warn","msg":"portal.rate_limited","script":"verify","path":"/portal/meters/J100236/energy","retry":4,"delayMs":6252}
   ... 240/403
   ... 260/403
   ... 280/403
   ... 300/403
   ... 320/403
   ... 340/403
{"time":"2026-11-04T05:28:02.108Z","level":"warn","msg":"portal.rate_limited","script":"verify","path":"/portal/meters/J100356/energy","retry":1,"delayMs":972}
{"time":"2026-11-04T05:28:03.136Z","level":"warn","msg":"portal.rate_limited","script":"verify","path":"/portal/meters/J100356/energy","retry":2,"delayMs":1279}
{"time":"2026-11-04T05:28:04.471Z","level":"warn","msg":"portal.rate_limited","script":"verify","path":"/portal/meters/J100356/energy","retry":3,"delayMs":2964}
{"time":"2026-11-04T05:28:07.488Z","level":"warn","msg":"portal.rate_limited","script":"verify","path":"/portal/meters/J100356/energy","retry":4,"delayMs":6043}
{"time":"2026-11-04T05:28:13.832Z","level":"warn","msg":"portal.rate_limited","script":"verify","path":"/portal/meters/J100356/energy","retry":5,"delayMs":8237}
   ... 360/403
   ... 380/403
   ... 400/403
   rows: portal 68495, API 68490, dropped on purpose and reported 5
   ✓ portal rows missing in the API: 0
   ✓ API rows not in the portal: 0
   reading values (kWh, kVAh, V(R)): 0 unexplained difference(s), 0 explained
   ✓ interval usage adds up to the register change: 403/403 meters
   reading cadence: every 30 min 40, once a day 363
     once a day: J100040, J100041, J100042, J100043, J100044, J100045, J100046, J100047, J100048, J100049, J100050, J100051, J100052, J100053, J100054, J100055, J100056, J100057, J100058, J100059, J100060, J100061, J100062, J100063, J100064, J100065, J100066, J100067, J100068, J100069, J100070, J100071, J100072, J100073, J100074, J100075, J100076, J100077, J100078, J100079, J100080, J100081, J100082, J100083, J100084, J100085, J100086, J100087, J100088, J100089, J100090, J100091, J100092, J100093, J100094, J100095, J100096, J100097, J100098, J100099, J100100, J100101, J100102, J100103, J100104, J100105, J100106, J100107, J100108, J100109, J100110, J100111, J100112, J100113, J100114, J100115, J100116, J100117, J100118, J100119, J100120, J100121, J100122, J100123, J100124, J100125, J100126, J100127, J100128, J100129, J100130, J100131, J100132, J100133, J100134, J100135, J100136, J100137, J100138, J100139, J100140, J100141, J100142, J100143, J100144, J100145, J100146, J100147, J100148, J100149, J100150, J100151, J100152, J100153, J100154, J100155, J100156, J100157, J100158, J100159, J100160, J100161, J100162, J100163, J100164, J100165, J100166, J100167, J100168, J100169, J100170, J100171, J100172, J100173, J100174, J100175, J100176, J100177, J100178, J100179, J100180, J100181, J100182, J100183, J100184, J100185, J100186, J100187, J100188, J100189, J100190, J100191, J100192, J100193, J100194, J100195, J100196, J100197, J100198, J100199, J100200, J100201, J100202, J100203, J100204, J100205, J100206, J100207, J100208, J100209, J100210, J100211, J100212, J100213, J100214, J100215, J100216, J100217, J100218, J100219, J100220, J100221, J100222, J100223, J100224, J100225, J100226, J100227, J100228, J100229, J100230, J100231, J100232, J100233, J100234, J100235, J100236, J100237, J100238, J100239, J100240, J100241, J100242, J100243, J100244, J100245, J100246, J100247, J100248, J100249, J100250, J100251, J100252, J100253, J100254, J100255, J100256, J100257, J100258, J100259, J100260, J100261, J100262, J100263, J100264, J100265, J100266, J100267, J100268, J100269, J100270, J100271, J100272, J100273, J100274, J100275, J100276, J100277, J100278, J100279, J100280, J100281, J100282, J100283, J100284, J100285, J100286, J100287, J100288, J100289, J100290, J100291, J100292, J100293, J100294, J100295, J100296, J100297, J100298, J100299, J100300, J100301, J100302, J100303, J100304, J100305, J100306, J100307, J100308, J100309, J100310, J100311, J100312, J100313, J100314, J100315, J100316, J100317, J100318, J100319, J100320, J100321, J100322, J100323, J100324, J100325, J100326, J100327, J100328, J100329, J100330, J100331, J100332, J100333, J100334, J100335, J100336, J100337, J100338, J100339, J100340, J100341, J100342, J100343, J100344, J100345, J100346, J100347, J100348, J100349, J100350, J100351, J100352, J100353, J100354, J100355, J100356, J100357, J100358, J100359, J100360, J100361, J100362, J100363, J100364, J100365, J100366, J100367, J100368, J100369, J100370, J100371, J100372, J100373, J100374, J100375, J100376, J100377, J100378, J100379, J100380, J100381, J100382, J100383, J100384, J100385, J100386, J100387, J100388, J100389, J100390, J100391, J100392, J100393, J100394, J100395, J100396, J100397, J100398, J100399, J100400, J100401, J100402

✓ PASS: the API returns everything the portal has.
```
