import { readFileSync } from "node:fs";
import { exportFileSchema, type ExportMeter, type TransformerRow } from "../../src/portal/schemas.js";

/** 14 real meters picked for their quirks (see test/quality/scanExport.test.ts). */
export const sampleExport: readonly ExportMeter[] = exportFileSchema.parse(
  JSON.parse(readFileSync(new URL("../fixtures/export-sample.json", import.meta.url), "utf8")),
);

/** `/portal/dts` rows for the sample's transformers, shaped like the real endpoint. */
export const sampleTransformerRows: readonly TransformerRow[] = [
  ...new Map(sampleExport.map((m) => [m.dtCode, m])).values(),
]
  .map((m) => ({
    code: m.dtCode,
    // The real /portal/dts calls DT-007 "Sanganer DT 7" (probe, 2026-11-03).
    name: m.dtCode === "DT-007" ? "Sanganer DT 7" : m.hierarchy.dt.name,
    feederCode: m.hierarchy.feeder.code || "F-000",
    capacityKva: 100,
  }))
  .sort((a, b) => a.code.localeCompare(b.code));
