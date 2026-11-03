import { describe, expect, it } from "vitest";
import { normalizeCatalog, UNKNOWN_CODE } from "../../src/domain/normalize.js";
import type { ExportMeter } from "../../src/portal/schemas.js";
import { sampleExport, sampleTransformerRows } from "../helpers/sample.js";

const byId = (id: string, meters = normalizeCatalog(sampleExport, sampleTransformerRows).meters) =>
  meters.find((m) => m.id === id)!;

describe("normalizeCatalog", () => {
  it("maps portal spellings to the domain vocabulary", () => {
    const meter = byId("J100000");

    expect(meter).toMatchObject({
      id: "J100000",
      serialNumber: "SE33962",
      status: "decommissioned",
      phase: "single",
      installationType: "whole_current",
      build: "legacy",
      location: { lat: 26.938961002479868, lng: 75.83095696146852 },
    });
    expect(meter.network.transformer).toEqual({ code: "DT-001", name: "Malviya Nagar DT 1" });
    expect(meter.network.path).toBe("Z-01.C-01.D-01.SD-01.SS-01.F-001.DT-001");
    expect(meter.issues).toEqual([]);
  });

  it("repairs a blank code and records what it did", () => {
    const meter = byId("J100011");

    expect(meter.network.circle).toEqual({ code: "C-06", name: "Circle 6" });
    expect(meter.network.path).toContain(".C-06.");
    expect(meter.issues).toEqual([
      {
        code: "network_cell_repaired",
        field: "network.circle",
        detail: 'Blank code filled as "C-06" from other meters',
      },
    ]);
  });

  it("repairs a blank name too", () => {
    expect(byId("J100162").network.feeder).toEqual({ code: "F-003", name: "Feeder 3" });
  });

  it("uses the /portal/dts name for DT-007 and keeps the other as an alias", () => {
    const { meters, transformers } = normalizeCatalog(sampleExport, sampleTransformerRows);

    expect(byId("J100400", meters).network.transformer.name).toBe("Sanganer DT 7");
    expect(byId("J100400", meters).issues.map((i) => i.code)).toEqual(["transformer_name_conflict"]);
    expect(byId("J100006", meters).issues).toEqual([]);
    expect(transformers.find((t) => t.code === "DT-007")).toMatchObject({
      name: "Sanganer DT 7",
      aliases: ["Old Malviya Nagar Xfmr"],
      capacityKva: 100,
      meterCount: 5,
    });
  });

  it("falls back to the majority name when /portal/dts is unavailable", () => {
    const { transformers } = normalizeCatalog(sampleExport, null);

    // Sample: 3 meters say "Old Malviya Nagar Xfmr", 2 say "Sanganer DT 7".
    expect(transformers.find((t) => t.code === "DT-007")).toMatchObject({
      name: "Old Malviya Nagar Xfmr",
      aliases: ["Sanganer DT 7"],
      capacityKva: null,
    });
  });

  it("maps unknown enum values to 'unknown' instead of rejecting the catalog", () => {
    const odd: ExportMeter = { ...sampleExport[0]!, installStatus: "Stolen", phaseType: "two" };
    const [meter] = normalizeCatalog([odd], null).meters;

    expect(meter?.status).toBe("unknown");
    expect(meter?.phase).toBe("unknown");
    expect(meter?.issues.map((i) => i.field)).toEqual(["phase", "status"]);
  });

  it("leaves an unrepairable cell blank, marks it in the path, and says so", () => {
    const lonely: ExportMeter = {
      ...sampleExport[0]!,
      hierarchy: { ...sampleExport[0]!.hierarchy, zone: { name: "Nowhere", code: "" } },
    };
    const [meter] = normalizeCatalog([lonely], null).meters;

    expect(meter?.network.zone).toEqual({ code: "", name: "Nowhere" });
    expect(meter?.network.path.startsWith(`${UNKNOWN_CODE}.`)).toBe(true);
    expect(meter?.issues[0]?.code).toBe("network_cell_missing");
  });

  it("lists a transformer from /portal/dts even when no meter uses it", () => {
    const { transformers } = normalizeCatalog(sampleExport, [
      ...sampleTransformerRows,
      { code: "DT-099", name: "Spare DT", feederCode: "F-099", capacityKva: 63 },
    ]);

    expect(transformers.find((t) => t.code === "DT-099")).toMatchObject({
      meterCount: 0,
      networkPath: "",
      capacityKva: 63,
    });
  });

  it("is deterministic: same input, same output", () => {
    expect(normalizeCatalog(sampleExport, sampleTransformerRows)).toEqual(
      normalizeCatalog([...sampleExport].reverse(), sampleTransformerRows),
    );
  });
});
