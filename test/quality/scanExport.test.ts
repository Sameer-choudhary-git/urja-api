import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { exportFileSchema, type ExportMeter } from "../../src/portal/schemas.js";
import { scanExport } from "../../src/quality/scanExport.js";

/**
 * The sample is 14 real meters picked for their quirks:
 *  - J100006, J100046 (DT-007 "Sanganer DT 7") vs J100400-402 ("Old Malviya Nagar Xfmr")
 *  - J100011: circle "Circle 6" with a blank code; J100017 has "Circle 6"/"C-06"
 *  - J100162: feeder F-003 with a blank name; J100002 has F-003 named
 */
const sample = exportFileSchema.parse(
  JSON.parse(readFileSync(new URL("../fixtures/export-sample.json", import.meta.url), "utf8")),
);

function withHierarchy(meter: ExportMeter, patch: Partial<ExportMeter["hierarchy"]>): ExportMeter {
  return { ...meter, hierarchy: { ...meter.hierarchy, ...patch } };
}

describe("scanExport", () => {
  const report = scanExport(sample);

  it("counts meters and value distributions", () => {
    expect(report.meterCount).toBe(14);
    expect(Object.values(report.distributions.build).reduce((a, b) => a + b, 0)).toBe(14);
    expect(Object.keys(report.distributions.build).sort()).toEqual(["legacy", "v2"]);
  });

  it("finds the DT-007 name conflict and which meters carry each name", () => {
    expect(report.hierarchy.codeWithManyNames).toEqual([
      {
        level: "dt",
        code: "DT-007",
        names: {
          "Sanganer DT 7": ["J100006", "J100046"],
          "Old Malviya Nagar Xfmr": ["J100400", "J100401", "J100402"],
        },
      },
    ]);
  });

  it("reports blank cells and repairs them from other meters", () => {
    expect(report.hierarchy.blankCells).toEqual([
      { meterId: "J100011", level: "circle", missing: "code", repairableTo: "C-06" },
      { meterId: "J100162", level: "feeder", missing: "name", repairableTo: "Feeder 3" },
    ]);
  });

  it("does not repair a blank cell when nothing else confirms the value", () => {
    const lonely = withHierarchy(sample[0]!, { zone: { name: "Nowhere Zone", code: "" } });
    const result = scanExport([lonely]);

    expect(result.hierarchy.blankCells).toEqual([
      { meterId: lonely.meterId, level: "zone", missing: "code", repairableTo: null },
    ]);
  });

  it("detects a code reused under different parents", () => {
    const [a, b] = sample;
    const moved = withHierarchy(b!, {
      circle: { name: "Circle 9", code: "C-09" },
      division: a!.hierarchy.division,
    });
    const result = scanExport([a!, { ...moved, meterId: "J999999" }]);

    expect(result.hierarchy.codeWithManyParents).toContainEqual({
      level: "division",
      code: a!.hierarchy.division.code,
      parentLevel: "circle",
      parentCodes: [a!.hierarchy.circle.code, "C-09"].sort(),
    });
  });

  it("flags a DT whose meters disagree on the path above it", () => {
    const base = sample.find((m) => m.meterId === "J100006")!;
    const twin = withHierarchy(
      { ...base, meterId: "J999998" },
      { feeder: { name: "Feeder 99", code: "F-099" } },
    );
    const result = scanExport([base, twin]);

    expect(result.hierarchy.dtWithManyPaths).toHaveLength(1);
    expect(result.hierarchy.dtWithManyPaths[0]?.dtCode).toBe("DT-007");
  });

  it("reports ID gaps and duplicates", () => {
    const result = scanExport([sample[0]!, sample[0]!, { ...sample[0]!, meterId: "J100003" }]);

    expect(result.ids.duplicateMeterIds).toEqual(["J100000"]);
    expect(result.ids.missingInSequence).toEqual(["J100001", "J100002"]);
  });

  it("flags impossible coordinates", () => {
    const result = scanExport([{ ...sample[0]!, geo: { lat: 0, lng: 0 } }]);

    expect(result.geo.invalid).toEqual([sample[0]!.meterId]);
  });
});
