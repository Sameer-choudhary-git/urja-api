import { describe, expect, it } from "vitest";
import { detectMeterAnomalies, THRESHOLDS, transformerAnomalies, transformerLoad } from "../../src/domain/anomalies.js";
import { deriveReadings } from "../../src/domain/readings.js";
import type { EnergyRow } from "../../src/portal/schemas.js";

const pad = (n: number) => String(n).padStart(2, "0");
const ist = (value: string) => Date.parse(`${value}+05:30`);
const DAY = { from: ist("2026-06-10T00:00:00"), to: ist("2026-06-12T00:00:00") }; // two days

/** Two days of rows from a per-slot usage function (kWh) and voltage function. */
function rows(usage: (i: number) => number, volt: (i: number) => number = () => 230, pf = 0.95): EnergyRow[] {
  let kwh = 1000;
  let kvah = 1100;
  const out: EnergyRow[] = [];
  for (let i = 0; i <= 96; i += 1) {
    const at = ist("2026-06-10T00:00:00") + i * 30 * 60_000;
    const d = new Date(at + 330 * 60_000);
    if (i > 0) {
      kwh += usage(i);
      kvah += usage(i) / pf;
    }
    out.push({
      timestamp: `${pad(d.getUTCDate())}/06/2026 ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`,
      kwh: kwh.toFixed(2),
      kvah: kvah.toFixed(2),
      voltR: String(volt(i)),
    });
  }
  return out;
}

function detect(data: EnergyRow[], status: "installed" | "faulty" | "decommissioned" = "installed") {
  const { readings, issues } = deriveReadings(data);
  return detectMeterAnomalies({ id: "J100001", status }, readings, issues, DAY);
}
const codes = (list: { code: string }[]) => list.map((a) => a.code);

describe("detectMeterAnomalies", () => {
  it("finds nothing on a healthy meter", () => {
    expect(detect(rows((i) => 0.4 + (i % 5) / 100))).toEqual([]);
  });

  it("flags voltage outside 230 V +-6%, once per direction, with the worst value", () => {
    const found = detect(rows(() => 0.4, (i) => (i < 5 ? 205 : i > 90 ? 250 : 230)));
    expect(found.filter((a) => a.code === "voltage_out_of_range").map((a) => a.value)).toEqual([205, 250]);
  });

  it("flags a low power factor", () => {
    const [found] = detect(rows(() => 0.4, () => 230, 0.7));
    expect(found).toMatchObject({ code: "low_power_factor", severity: "warning" });
    expect(found!.value).toBeLessThan(THRESHOLDS.powerFactorMin);
  });

  it("flags a day of zero use on an installed meter as critical", () => {
    const found = detect(rows((i) => (i > 40 ? 0 : 0.4)));
    expect(found.find((a) => a.code === "zero_consumption")).toMatchObject({ severity: "critical", value: 56 });
  });

  it("flags spikes with robust statistics", () => {
    const found = detect(rows((i) => (i === 50 ? 5 : 0.4 + (i % 3) / 100)));
    expect(found.find((a) => a.code === "consumption_spike")).toMatchObject({ value: 5, at: ist("2026-06-11T00:30:00") });
  });

  it("flags a decommissioned meter that still records consumption", () => {
    expect(codes(detect(rows(() => 0.4), "decommissioned"))).toEqual(["decommissioned_but_consuming"]);
  });

  it("reports missing data and register resets", () => {
    const data = rows(() => 0.4);
    data.splice(20, 3); // three readings missing
    data[60]!.kwh = "1.00"; // register drops
    expect(codes(detect(data))).toEqual(expect.arrayContaining(["data_gap", "register_decreased"]));
  });
});

describe("transformer loading", () => {
  const meter = (kwhPerSlot: number) => deriveReadings(rows(() => kwhPerSlot, () => 230, 1)).readings;

  it("sums kVA (kVAh x 2) over meters per half hour and compares the peak with the rating", () => {
    const load = transformerLoad(10, [meter(2), meter(2.5)], DAY);
    expect(load.points).toHaveLength(96);
    expect(load.peak).toMatchObject({ kva: 9, metersReporting: 2 });
    expect(load.peakUtilisationPercent).toBe(90);
    expect(transformerAnomalies("DT-001", load)).toEqual([expect.objectContaining({ code: "transformer_overload", severity: "warning" })]);
    expect(transformerAnomalies("DT-001", transformerLoad(8, [meter(2), meter(2.5)], DAY))[0]?.severity).toBe("critical");
    expect(transformerAnomalies("DT-001", transformerLoad(100, [meter(2)], DAY))).toEqual([]);
  });
});
