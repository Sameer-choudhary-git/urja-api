/**
 * Does the API return ALL the portal's data, unchanged? Compares the REAL
 * portal with a running API, record by record.
 *
 *   npm run verify                                   # API on http://localhost:3000, 40 meters' readings
 *   npm run verify -- --all                          # readings of every meter (403 x 2 calls, a few minutes)
 *   npm run verify -- --api http://15.252.70.41      # check the deployed API
 *   npm run verify -- --meters J100040,J100000       # just these meters' readings
 *
 * Needs .env with PORTAL_EMAIL / PORTAL_PASSWORD (to read the portal directly)
 * and an API key: VERIFY_API_KEY, or the first key in API_KEYS. Read-only on
 * both sides. Exit code 0 = no unexplained difference, 1 = something to look at.
 *
 * What it checks:
 *   1. Meters: the same IDs in the signed export and GET /v1/meters, and every
 *      field equal (enums compared case- and spacing-insensitively).
 *   2. Transformers: /portal/dts vs GET /v1/transformers (code, name, kVA, feeder).
 *   3. Readings: for each meter, every portal energy row (1-30 June) has an API
 *      reading with the same timestamp and the same kWh, kVAh and V(R); and the
 *      API's interval usage adds up to the change in the kWh register.
 * A difference the API made on purpose and reported on the record (a repaired
 * hierarchy cell, a dropped duplicate reading) is listed as "explained".
 */
import { loadPortalConfig, parseApiKeys } from "../src/config.js";
import { createJsonLogger } from "../src/logger.js";
import { createPortal } from "../src/portal/createPortal.js";
import {
  compareMeters,
  compareReadings,
  compareTransformers,
  type ApiMeterLike,
  type ApiReadingLike,
  type ApiTransformerLike,
  type ParityDifference,
  type ReadingsParity,
} from "../src/quality/parity.js";
import { mapPool } from "../src/shared/mapPool.js";

const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const apiBase = (arg("--api") ?? process.env.VERIFY_API_URL ?? "http://localhost:3000").replace(/\/$/, "");
const apiKey = process.env.VERIFY_API_KEY ?? parseApiKeys(process.env.API_KEYS ?? "")[0]?.key;
const all = args.includes("--all");
const limit = all ? Number.POSITIVE_INFINITY : Number(arg("--limit") ?? 40);
const onlyMeters = arg("--meters")?.split(",").map((m) => m.trim().toUpperCase());
// Portal energy history is 1-30 June 2026 (PROTOCOL.md 3.3). The API window is one day wider on each
// side, so the first reading (whose interval starts the day before) and the last are both inside it.
const DAYS = { from: arg("--from") ?? "2026-06-01", to: arg("--to") ?? "2026-06-30" };
const shiftDay = (day: string, by: number) => new Date(Date.parse(`${day}T00:00:00Z`) + by * 86_400_000).toISOString().slice(0, 10);
const API_WINDOW = { from: `${shiftDay(DAYS.from, -1)}T00:00:00+05:30`, to: `${shiftDay(DAYS.to, 1)}T00:00:00+05:30` };

if (apiKey === undefined) {
  console.error("No API key: set VERIFY_API_KEY, or API_KEYS in .env");
  process.exit(2);
}

/** GET on the API, waiting out a 429 (the API allows 300 requests a minute per key). */
async function api<T>(path: string, query: Record<string, string | number> = {}): Promise<T> {
  const url = `${apiBase}${path}?${new URLSearchParams(Object.entries(query).map(([k, v]): [string, string] => [k, String(v)]))}`;
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetch(url, { headers: { "x-api-key": apiKey! }, signal: AbortSignal.timeout(90_000) });
    if (res.status === 429 && attempt < 5) {
      await new Promise((r) => setTimeout(r, Number(res.headers.get("retry-after") ?? 10) * 1000));
      continue;
    }
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as T;
  }
}

const portal = createPortal(loadPortalConfig(), createJsonLogger("warn", { script: "verify" }));
let problems = 0;
const show = (label: string, diffs: readonly ParityDifference[]) => {
  const unexplained = diffs.filter((d) => !d.explained);
  const explained = diffs.filter((d) => d.explained);
  problems += unexplained.length;
  console.log(`   ${label}: ${unexplained.length} unexplained difference(s), ${explained.length} explained`);
  for (const d of unexplained.slice(0, 30)) console.log(`     ✗ ${d.subject} ${d.field}: portal=${JSON.stringify(d.portal)} api=${JSON.stringify(d.api)}`);
  if (unexplained.length > 30) console.log(`     ... and ${unexplained.length - 30} more`);
  for (const d of explained.slice(0, 5)) console.log(`     ~ ${d.subject} ${d.field}: portal=${JSON.stringify(d.portal)} api=${JSON.stringify(d.api)} (reported in the meter's issues)`);
  if (explained.length > 5) console.log(`     ~ ... and ${explained.length - 5} more explained`);
};
const showSet = (label: string, set: { portalCount: number; apiCount: number; missingInApi: string[]; extraInApi: string[] }) => {
  problems += set.missingInApi.length + set.extraInApi.length;
  const ok = set.missingInApi.length === 0 && set.extraInApi.length === 0;
  console.log(`   ${ok ? "✓" : "✗"} ${label}: portal ${set.portalCount}, API ${set.apiCount}`);
  if (set.missingInApi.length > 0) console.log(`     missing in API: ${set.missingInApi.join(", ")}`);
  if (set.extraInApi.length > 0) console.log(`     only in API: ${set.extraInApi.join(", ")}`);
};

console.log(`Portal vs API at ${apiBase}\n`);

console.log("1. Meters (signed export vs GET /v1/meters)");
const exported = await portal.exportApi.fetchAllMeters();
const apiMeters = (await api<{ data: ApiMeterLike[] }>("/v1/meters", { limit: 500 })).data;
const meters = compareMeters(exported.meters, apiMeters);
showSet("meter IDs", meters.set);
show("meter fields", meters.differences);

console.log("\n2. Transformers (/portal/dts vs GET /v1/transformers)");
const dts = await portal.transformersApi.fetchAll();
const apiDts = (await api<{ data: ApiTransformerLike[] }>("/v1/transformers", { limit: 200 })).data;
const transformers = compareTransformers(dts, apiDts);
showSet("transformer codes", transformers.set);
show("transformer fields", transformers.differences);

const ids = exported.meters.map((m) => m.meterId);
const step = Math.max(1, Math.floor(ids.length / Math.min(limit, ids.length)));
const sample = onlyMeters ?? ids.filter((_, i) => i % step === 0).slice(0, limit);
console.log(`\n3. Readings ${DAYS.from}..${DAYS.to} for ${sample.length} meter(s) (portal energy vs GET /v1/meters/{id}/readings?granularity=raw)`);

const failures: { meterId: string; error: string }[] = [];
let done = 0;
const results = (
  await mapPool(sample, 2, async (meterId): Promise<ReadingsParity | null> => {
    try {
      const [rows, res] = await Promise.all([
        portal.energyApi.fetchReadings(meterId, DAYS),
        api<{ data: { items: ApiReadingLike[]; issues: { code: string }[] } }>(`/v1/meters/${meterId}/readings`, { ...API_WINDOW, granularity: "raw" }),
      ]);
      return compareReadings(meterId, rows, res.data.items, res.data.issues.map((i) => i.code));
    } catch (error) {
      failures.push({ meterId, error: error instanceof Error ? error.message : String(error) });
      return null;
    } finally {
      done += 1;
      if (done % 20 === 0) console.log(`   ... ${done}/${sample.length}`);
    }
  })
).filter((r) => r !== null);

const portalRows = results.reduce((n, r) => n + r.portalRows, 0);
const apiRows = results.reduce((n, r) => n + r.apiRows, 0);
const missing = results.filter((r) => r.missingInApi.length > 0);
const extra = results.filter((r) => r.extraInApi.length > 0);
const usageOff = results.filter((r) => r.usage !== null && !r.usage.matches);
const byCadence = results.reduce<Record<string, string[]>>((acc, r) => {
  const key = r.cadenceMinutes === null ? "unknown" : r.cadenceMinutes >= 1440 ? "once a day" : `every ${r.cadenceMinutes} min`;
  (acc[key] ??= []).push(r.meterId);
  return acc;
}, {});

console.log(`   rows: portal ${portalRows}, API ${apiRows}, dropped on purpose and reported ${results.reduce((n, r) => n + r.droppedAndReported, 0)}`);
console.log(`   ${missing.length === 0 ? "✓" : "✗"} portal rows missing in the API: ${missing.reduce((n, r) => n + r.missingInApi.length, 0)}`);
for (const r of missing.slice(0, 10)) console.log(`     ${r.meterId}: ${r.missingInApi.slice(0, 5).join(", ")}${r.missingInApi.length > 5 ? ` ... (${r.missingInApi.length})` : ""}`);
console.log(`   ${extra.length === 0 ? "✓" : "✗"} API rows not in the portal: ${extra.reduce((n, r) => n + r.extraInApi.length, 0)}`);
for (const r of extra.slice(0, 10)) console.log(`     ${r.meterId}: ${r.extraInApi.slice(0, 5).join(", ")}`);
show("reading values (kWh, kVAh, V(R))", results.flatMap((r) => r.differences));
console.log(`   ${usageOff.length === 0 ? "✓" : "✗"} interval usage adds up to the register change: ${results.length - usageOff.length}/${results.length} meters`);
for (const r of usageOff.slice(0, 10)) console.log(`     ${r.meterId}: sum ${r.usage!.apiSum} vs register ${r.usage!.registerDelta}`);
console.log(`   reading cadence: ${Object.entries(byCadence).map(([k, v]) => `${k} ${v.length}`).join(", ")}`);
if (byCadence["once a day"]) console.log(`     once a day: ${byCadence["once a day"].join(", ")}`);
if (failures.length > 0) {
  console.log(`   ✗ could not compare ${failures.length} meter(s):`);
  for (const f of failures.slice(0, 10)) console.log(`     ${f.meterId}: ${f.error}`);
}
problems += missing.length + extra.length + usageOff.length + failures.length;

console.log(`\n${problems === 0 ? "✓ PASS: the API returns everything the portal has." : `✗ ${problems} problem(s) found (see ✗ above).`}`);
process.exit(problems === 0 ? 0 : 1);
