import { describe, expect, it } from "vitest";
import { deriveReadings } from "../../src/domain/readings.js";
import { normalizeCatalog } from "../../src/domain/normalize.js";
import { toIstIso } from "../../src/domain/time.js";
import { compareMeters, compareReadings, compareTransformers, type ApiMeterLike, type ApiReadingLike } from "../../src/quality/parity.js";
import { generateEnergy } from "../helpers/fakeEnergy.js";
import { sampleExport, sampleTransformerRows } from "../helpers/sample.js";

const { meters, transformers } = normalizeCatalog(sampleExport, sampleTransformerRows);
const apiMeters = meters as unknown as ApiMeterLike[];

const apiReadings = (rows: ReturnType<typeof generateEnergy>): ApiReadingLike[] =>
  deriveReadings(rows).readings.map((r) => ({
    timestamp: toIstIso(r.at),
    kwhRegister: r.kwhRegister,
    kvahRegister: r.kvahRegister,
    voltageR: r.voltageR,
    intervalKwh: r.intervalKwh,
  }));

describe("compareMeters", () => {
  it("finds no unexplained difference between the export and our normalised meters", () => {
    const { set, differences } = compareMeters(sampleExport, apiMeters);
    expect(set.missingInApi).toEqual([]);
    expect(set.extraInApi).toEqual([]);
    expect(differences.filter((d) => !d.explained)).toEqual([]);
  });

  it("flags a missing meter and a changed field", () => {
    const changed = apiMeters.slice(1).map((m, i) => (i === 0 ? { ...m, serialNumber: "XX" } : m));
    const { set, differences } = compareMeters(sampleExport, changed);
    expect(set.missingInApi).toEqual([sampleExport[0]!.meterId]);
    expect(differences).toContainEqual(expect.objectContaining({ subject: sampleExport[1]!.meterId, field: "serialNumber", api: "XX", explained: false }));
  });
});

describe("compareTransformers", () => {
  it("matches /portal/dts against our transformers", () => {
    const { set, differences } = compareTransformers(sampleTransformerRows, transformers);
    expect(set.missingInApi).toEqual([]);
    expect(differences).toEqual([]);
  });
});

describe("compareReadings", () => {
  const rows = generateEnergy("J100000");

  it("accounts for every portal row of a month", () => {
    const result = compareReadings("J100000", rows, apiReadings(rows), []);
    expect(result).toMatchObject({ portalRows: 1440, apiRows: 1440, missingInApi: [], extraInApi: [], differences: [], cadenceMinutes: 30 });
    expect(result.usage?.matches).toBe(true);
  });

  it("reports a row the API lost and a value it changed", () => {
    const api = apiReadings(rows);
    const broken = [...api.slice(0, 100), ...api.slice(101)].map((r, i) => (i === 5 ? { ...r, voltageR: r.voltageR + 1 } : r));
    const result = compareReadings("J100000", rows, broken, []);
    expect(result.missingInApi).toEqual([rows[100]!.timestamp]);
    expect(result.differences).toEqual([expect.objectContaining({ field: "voltR" })]);
  });

  it("treats a duplicate the API reported as dropped on purpose, not missing", () => {
    const withDup = [...rows.slice(0, 10), { ...rows[9]!, kwh: "1.00" }, ...rows.slice(10)];
    const derived = deriveReadings(withDup);
    const result = compareReadings("J100000", withDup, apiReadings(withDup), derived.issues.map((i) => i.code));
    expect(result).toMatchObject({ missingInApi: [], droppedAndReported: 1 });
  });

  it("sees a once-a-day meter (J100040) as complete", () => {
    const daily = generateEnergy("J100040");
    const result = compareReadings("J100040", daily, apiReadings(daily), []);
    expect(result).toMatchObject({ portalRows: 30, apiRows: 30, missingInApi: [], cadenceMinutes: 1440 });
    expect(result.usage?.matches).toBe(true);
  });
});
