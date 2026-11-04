import { describe, expect, it } from "vitest";
import { aggregate, deriveReadings, inWindow, summarize } from "../../src/domain/readings.js";
import { toIstIso } from "../../src/domain/time.js";
import type { EnergyRow } from "../../src/portal/schemas.js";
import { generateEnergy } from "../helpers/fakeEnergy.js";

const row = (timestamp: string, kwh: string, kvah: string, voltR = "230"): EnergyRow => ({ timestamp, kwh, kvah, voltR });
const ist = (value: string) => Date.parse(`${value}+05:30`);

describe("deriveReadings", () => {
  it("turns cumulative registers into per-interval usage (real first rows of J100000)", () => {
    const { readings, issues } = deriveReadings([
      row("23/06/2026 23:30", "48438.74", "52313.84", "226"),
      row("24/06/2026 00:00", "48439.16", "52314.29", "229"),
    ]);
    expect(issues).toEqual([]);
    expect(readings[0]?.intervalKwh).toBeNull(); // nothing before it
    expect(readings[1]).toMatchObject({
      at: ist("2026-06-24T00:00:00"),
      kwhRegister: 48439.16,
      voltageR: 229,
      intervalKwh: 0.42, // not 0.42000000000000455
      intervalKvah: 0.45,
      powerFactor: 0.9333,
    });
  });

  it("sorts rows and drops exact duplicates silently", () => {
    const { readings, issues } = deriveReadings([
      row("01/06/2026 00:30", "10.50", "11.00"),
      row("01/06/2026 00:00", "10.00", "10.40"),
      row("01/06/2026 00:30", "10.50", "11.00"),
    ]);
    expect(readings.map((r) => toIstIso(r.at))).toEqual(["2026-06-01T00:00:00+05:30", "2026-06-01T00:30:00+05:30"]);
    expect(issues).toEqual([]);
  });

  it("reports what it cannot use instead of failing", () => {
    const { readings, issues } = deriveReadings([
      row("01/06/2026 00:00", "10.00", "11.00"),
      row("01/06/2026 00:00", "99.00", "99.00"), // conflicting duplicate
      row("01/06/2026 00:30", "10.50", "11.60"),
      row("01/06/2026 02:00", "12.00", "13.20"), // 2 readings missing before it
      row("01/06/2026 02:10", "12.10", "13.30"), // off the half-hour grid
      row("01/06/2026 02:40", "11.00", "13.50"), // kWh register went down
      row("01/06/2026 03:10", "11.80", "13.60"), // kWh 0.8 > kVAh 0.1
      row("31/02/2026 00:00", "1", "1"), // impossible date
    ]);
    expect(issues.map((issue) => issue.code)).toEqual([
      "bad_timestamp",
      "duplicate_reading",
      "reading_gap",
      "irregular_interval",
      "register_decreased",
      "power_factor_out_of_range",
    ]);
    expect(issues.find((i) => i.code === "reading_gap")?.message).toMatch(/^2 reading/);
    // Registers are cumulative, so usage across the gap is still exact; it covers 90 minutes.
    expect(readings.map((r) => r.intervalKwh)).toEqual([null, 0.5, 1.5, 0.1, null, 0.8]);
    expect(readings.map((r) => r.intervalMinutes)).toEqual([30, 30, 90, 10, 30, 30]);
    expect(readings.at(-1)?.powerFactor).toBeNull();
  });

  it("handles a meter read once a day: daily totals, no hourly ones, no gap issues", () => {
    const days = ["01", "02", "03", "04"].map((d, i) => row(`${d}/06/2026 00:00`, (100 + i * 8.86).toFixed(2), (110 + i * 9.57).toFixed(2)));
    const { readings, issues } = deriveReadings(days);
    expect(issues).toEqual([]);
    expect(readings[1]).toMatchObject({ intervalMinutes: 1440, intervalKwh: 8.86, intervalKvah: 9.57 });

    const window = { from: ist("2026-06-01T00:00:00"), to: ist("2026-06-04T00:00:00") };
    const daily = aggregate(readings, window, "day");
    expect(daily.map((b) => b.kwh)).toEqual([8.86, 8.86, 8.86]);
    expect(daily.every((b) => b.complete)).toBe(true);
    expect(aggregate(readings, window, "hour").every((b) => b.kwh === null)).toBe(true);

    const summary = summarize(readings, window);
    expect(summary).toMatchObject({ totalKwh: 26.58, intervals: 144, expectedIntervals: 144, readingIntervalMinutes: 1440, peak: null });
  });

  it("skips a row with a non-numeric value (seen on J100089) and carries its usage to the next reading", () => {
    const { readings, issues } = deriveReadings([
      row("01/06/2026 00:00", "10.00", "11.00"),
      { timestamp: "01/06/2026 00:30", kwh: "", kvah: "11.50", voltR: "NaN" },
      row("01/06/2026 01:00", "11.00", "12.10"),
      row("01/06/2026 01:30", "11.50", "12.70"),
      row("01/06/2026 02:00", "12.00", "13.30"),
    ]);
    expect(issues.map((i) => i.code)).toEqual(["bad_value", "reading_gap"]);
    expect(issues[0]).toMatchObject({ at: ist("2026-06-01T00:30:00") });
    expect(readings.map((r) => [r.intervalMinutes, r.intervalKwh])).toEqual([[30, null], [60, 1], [30, 0.5], [30, 0.5]]);
  });

  it("gives no power factor when there was no load", () => {
    const { readings } = deriveReadings([row("01/06/2026 00:00", "5.00", "6.00"), row("01/06/2026 00:30", "5.00", "6.00")]);
    expect(readings[1]).toMatchObject({ intervalKwh: 0, powerFactor: null });
  });
});

describe("windows and rollups (one generated month)", () => {
  const { readings } = deriveReadings(generateEnergy("J100000"));
  const day = { from: ist("2026-06-29T00:00:00"), to: ist("2026-06-30T00:00:00") };

  it("selects readings by the interval they close: a day is 00:30 .. 24:00", () => {
    const selected = inWindow(readings, day);
    expect(selected).toHaveLength(48);
    expect(toIstIso(selected[0]!.at)).toBe("2026-06-29T00:30:00+05:30");
    expect(toIstIso(selected.at(-1)!.at)).toBe("2026-06-30T00:00:00+05:30");
  });

  it("raw intervals, hourly buckets, daily buckets and the summary all agree", () => {
    const week = { from: ist("2026-06-22T00:00:00"), to: ist("2026-06-29T00:00:00") };
    const rawTotal = inWindow(readings, week).reduce((sum, r) => sum + (r.intervalKwh ?? 0), 0);
    const hours = aggregate(readings, week, "hour");
    const days = aggregate(readings, week, "day");
    const summary = summarize(readings, week);

    expect(hours).toHaveLength(7 * 24);
    expect(days).toHaveLength(7);
    expect(days.every((d) => d.complete && d.intervals === 48)).toBe(true);
    expect(summary.intervals).toBe(336);
    expect(summary.expectedIntervals).toBe(336);
    for (const total of [hours.reduce((s, b) => s + (b.kwh ?? 0), 0), days.reduce((s, b) => s + (b.kwh ?? 0), 0)]) {
      expect(total).toBeCloseTo(rawTotal, 6);
    }
    expect(summary.totalKwh).toBeCloseTo(rawTotal, 6);
    expect(summary.powerFactor).toBeGreaterThan(0.8);
    expect(summary.powerFactor).toBeLessThanOrEqual(1);
    expect(summary.peak?.kwh).toBe(Math.max(...inWindow(readings, week).map((r) => r.intervalKwh ?? 0)));
  });

  it("keeps empty buckets and marks partial ones, so gaps stay visible", () => {
    // 30 June 12:00 to 2 July: data stops at 30 June 23:30.
    const window = { from: ist("2026-06-30T12:00:00"), to: ist("2026-07-02T00:00:00") };
    const days = aggregate(readings, window, "day");
    expect(days.map((d) => [toIstIso(d.start), d.intervals, d.expectedIntervals, d.complete])).toEqual([
      ["2026-06-30T00:00:00+05:30", 23, 24, false], // 12:00..23:30 needs a 1 July 00:00 reading for the last one
      ["2026-07-01T00:00:00+05:30", 0, 48, false],
    ]);
    expect(days[1]).toMatchObject({ kwh: null, powerFactor: null, voltageR: null });
  });
});
