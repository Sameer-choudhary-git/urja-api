/**
 * Compares the signed export with the fallback path on the REAL portal.
 *
 *   npm run cross-check              # 40 meters through the fallback (~100 calls)
 *   npm run cross-check -- --all     # every meter (~830 calls, a few minutes)
 *   npm run cross-check -- --limit 100
 *
 * Read-only. Prints a summary and every field that differs. No secrets printed.
 */
import { loadPortalConfig } from "../src/config.js";
import { createJsonLogger } from "../src/logger.js";
import { createPortal } from "../src/portal/createPortal.js";
import { toExportMeter } from "../src/portal/fallbackApi.js";
import { crossCheck } from "../src/quality/crossCheck.js";
import { mapPool } from "../src/shared/mapPool.js";

const args = process.argv.slice(2);
const all = args.includes("--all");
const limitArg = args.indexOf("--limit");
const limit = all ? Number.POSITIVE_INFINITY : limitArg >= 0 ? Number(args[limitArg + 1]) : 40;

const portal = createPortal(loadPortalConfig(), createJsonLogger("warn", { script: "cross-check" }));

console.log("1. Signed export ...");
const exported = await portal.exportApi.fetchAllMeters();
console.log(`   ${exported.meters.length} meters`);

console.log("2. Meter search (all pages) ...");
const rows = await portal.fallbackApi.listMeters();
console.log(`   ${rows.length} meters`);

// Spread the sample over the whole list (not just the first N), so all builds and areas show up.
const step = Math.max(1, Math.floor(rows.length / Math.min(limit, rows.length)));
const sample = rows.filter((_, i) => i % step === 0).slice(0, limit);
console.log(`3. Detail page + geo for ${sample.length} meters ...`);
// One odd page must not stop the comparison: collect failures and report them.
const failures: { meterId: string; error: string }[] = [];
const fetched = await mapPool(sample, 2, async (row) => {
  try {
    const [page, location] = await Promise.all([portal.fallbackApi.fetchPageData(row.meterId), portal.fallbackApi.fetchLocation(row.meterId)]);
    return toExportMeter(row, page, location);
  } catch (error) {
    failures.push({ meterId: row.meterId, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
});
const fallback = fetched.filter((m) => m !== null);

const searchIds = new Set(rows.map((r) => r.meterId));
const report = crossCheck(exported.meters, fallback, { restrictToFallback: !all });
console.log("\n=== Result");
console.log(`   in export but not in search: ${exported.meters.filter((m) => !searchIds.has(m.meterId)).map((m) => m.meterId).join(", ") || "none"}`);
console.log(`   in search but not in export: ${rows.filter((r) => !exported.meters.some((m) => m.meterId === r.meterId)).map((r) => r.meterId).join(", ") || "none"}`);
console.log(`   could not read ${failures.length} meter page(s)${failures.length > 0 ? " (inspect with: npm run dump-page -- <id>)" : ""}`);
for (const f of failures) console.log(`   ${f.meterId}: ${f.error}`);
console.log(`   compared ${report.compared} meters: ${report.identical} identical, ${report.compared - report.identical} with differences`);
for (const d of report.differences) {
  console.log(`   ${d.meterId} ${d.field}: export=${JSON.stringify(d.export)} fallback=${JSON.stringify(d.fallback)}`);
}
