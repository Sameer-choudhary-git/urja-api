/**
 * Offline data-quality scan of an export file. No portal access needed.
 *
 *   npm run scan -- fixtures/local/meter-export.json
 *   npm run scan -- fixtures/local/meter-export.json --json > report.json
 *
 * Accepts both shapes: the UI's downloaded file (a bare array) and the raw
 * API response (`{ data, total }`, as saved by `npm run fetch-export`).
 */
import { readFile } from "node:fs/promises";
import { exportFileSchema, exportResponseSchema, type ExportMeter } from "../src/portal/schemas.js";
import { scanExport, type QualityReport } from "../src/quality/scanExport.js";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const path = args.find((arg) => !arg.startsWith("--")) ?? "fixtures/local/meter-export.json";

const raw: unknown = JSON.parse(await readFile(path, "utf8"));
const meters = parseMeters(raw);
const report = scanExport(meters);

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  printSummary(path, report);
}

function parseMeters(value: unknown): readonly ExportMeter[] {
  const asArray = exportFileSchema.safeParse(value);
  if (asArray.success) return asArray.data;
  const asResponse = exportResponseSchema.safeParse(value);
  if (asResponse.success) return asResponse.data.data;
  const issue = asArray.error.issues[0];
  throw new Error(
    `${path} is not an export file: ${issue?.path.join(".") ?? "(root)"}: ${issue?.message ?? "?"}`,
  );
}

function printSummary(file: string, r: QualityReport): void {
  const h = r.hierarchy;
  const repairable = h.blankCells.filter((cell) => cell.repairableTo !== null).length;
  const lines = [
    `Data-quality scan of ${file}`,
    "",
    `Meters: ${r.meterCount} (${r.ids.first} .. ${r.ids.last})`,
    `  duplicate IDs: ${list(r.ids.duplicateMeterIds)}`,
    `  duplicate serials: ${list(r.ids.duplicateSerials)}`,
    `  gaps in ID sequence: ${list(r.ids.missingInSequence)}`,
    "",
    "Distributions:",
    ...Object.entries(r.distributions).map(
      ([field, counts]) =>
        `  ${field.padEnd(14)} ${Object.entries(counts)
          .map(([value, n]) => `${value}=${n}`)
          .join(", ")}`,
    ),
    "",
    "Hierarchy:",
    `  blank cells: ${h.blankCells.length} in ${new Set(h.blankCells.map((c) => c.meterId)).size} meters ` +
      `(${repairable} repairable from other meters)`,
    ...h.blankCells.map(
      (c) =>
        `    ${c.meterId} ${c.level}: ${c.missing} missing -> ${c.repairableTo ?? "NOT repairable"}`,
    ),
    `  one code, many names: ${h.codeWithManyNames.length}`,
    ...h.codeWithManyNames.map(
      (c) =>
        `    ${c.level} ${c.code}: ${Object.entries(c.names)
          .map(([name, ids]) => `"${name}" (${ids.length}: ${ids.slice(0, 4).join(", ")}${ids.length > 4 ? ", ..." : ""})`)
          .join(" vs ")}`,
    ),
    `  one name, many codes: ${h.nameWithManyCodes.length}`,
    ...h.nameWithManyCodes.map((c) => `    ${c.level} "${c.name}": ${c.codes.join(", ")}`),
    `  codes under more than one parent: ${h.codeWithManyParents.length}`,
    ...h.codeWithManyParents.map(
      (c) => `    ${c.level} ${c.code} under ${c.parentLevel} ${c.parentCodes.join(", ")}`,
    ),
    `  DTs with more than one path above them: ${h.dtWithManyPaths.length}`,
    ...h.dtWithManyPaths.map((d) => `    ${d.dtCode}: ${d.paths.join(" | ")}`),
    `  dtCode vs hierarchy.dt.code mismatches: ${h.dtCodeMismatches.length}`,
    "",
    "Geo:",
    `  lat ${r.geo.minLat} .. ${r.geo.maxLat}, lng ${r.geo.minLng} .. ${r.geo.maxLng}`,
    `  invalid coordinates: ${list(r.geo.invalid)}`,
  ];
  console.log(lines.join("\n"));
}

function list(values: readonly string[]): string {
  return values.length === 0 ? "none" : `${values.length} (${values.slice(0, 8).join(", ")}${values.length > 8 ? ", ..." : ""})`;
}
