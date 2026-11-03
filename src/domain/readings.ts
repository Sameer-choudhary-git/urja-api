import type { EnergyRow } from "../portal/schemas.js";
import {
  ceilToHalfHour,
  DAY_MS,
  HALF_HOUR_MS,
  HOUR_MS,
  parsePortalTimestamp,
  startOfHour,
  startOfIstDay,
} from "./time.js";

/**
 * Energy readings, from the portal's raw strings to numbers people can use.
 *
 * The portal gives CUMULATIVE registers every 30 minutes (like a car's
 * odometer). Usage is the difference between two readings:
 *
 *   reading at 00:00  kwh 48438.74
 *   reading at 00:30  kwh 48439.16   -> 0.42 kWh used from 00:00 to 00:30
 *
 * So each reading "closes" the half hour before it. Everything below follows
 * that one rule: a reading at time t carries the usage of [t - 30 min, t).
 */

export interface Reading {
  /** When the registers were read (end of the interval). Epoch ms. */
  readonly at: number;
  readonly kwhRegister: number;
  readonly kvahRegister: number;
  /** R-phase voltage at `at`, volts. */
  readonly voltageR: number;
  /** kWh used in [at - 30 min, at). Null when that cannot be known (see issues). */
  readonly intervalKwh: number | null;
  readonly intervalKvah: number | null;
  /** intervalKwh / intervalKvah, 0..1. Null with no load or no interval. */
  readonly powerFactor: number | null;
}

export const READING_ISSUE_CODES = [
  "bad_timestamp",
  "duplicate_reading",
  "reading_gap",
  "irregular_interval",
  "register_decreased",
  "power_factor_out_of_range",
] as const;
export type ReadingIssueCode = (typeof READING_ISSUE_CODES)[number];

export interface ReadingIssue {
  readonly code: ReadingIssueCode;
  /** The reading the issue is about; null when its timestamp could not be read. */
  readonly at: number | null;
  readonly message: string;
}

/** Floating-point noise (0.42000000000000455) is removed here. Inputs have 2 decimals. */
export const round = (value: number, decimals: number): number => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

/**
 * Portal rows -> readings with per-interval usage and power factor.
 * Never throws on odd data: it keeps what it can and reports the rest as issues.
 */
export function deriveReadings(rows: readonly EnergyRow[]): { readings: Reading[]; issues: ReadingIssue[] } {
  const issues: ReadingIssue[] = [];

  const parsed: { at: number; kwh: number; kvah: number; volt: number }[] = [];
  for (const row of rows) {
    const at = parsePortalTimestamp(row.timestamp);
    if (at === null) {
      issues.push({ code: "bad_timestamp", at: null, message: `Unreadable timestamp "${row.timestamp}"; row skipped` });
      continue;
    }
    parsed.push({ at, kwh: Number(row.kwh), kvah: Number(row.kvah), volt: Number(row.voltR) });
  }
  // The portal sends rows in time order today; sorting costs little and removes the assumption.
  parsed.sort((a, b) => a.at - b.at);

  const readings: Reading[] = [];
  for (const row of parsed) {
    const prev = readings.at(-1);
    if (prev !== undefined && prev.at === row.at) {
      if (prev.kwhRegister !== row.kwh || prev.kvahRegister !== row.kvah) {
        issues.push({ code: "duplicate_reading", at: row.at, message: "Two different readings for one time; the first is kept" });
      }
      continue;
    }

    let intervalKwh: number | null = null;
    let intervalKvah: number | null = null;
    let powerFactor: number | null = null;

    if (prev !== undefined) {
      const gap = row.at - prev.at;
      if (gap !== HALF_HOUR_MS) {
        const missing = gap / HALF_HOUR_MS - 1;
        issues.push(
          gap > HALF_HOUR_MS && Number.isInteger(missing)
            ? { code: "reading_gap", at: row.at, message: `${missing} reading(s) missing before this one` }
            : { code: "irregular_interval", at: row.at, message: `${gap / 60_000} minutes since the previous reading, expected 30` },
        );
      } else {
        const dKwh = round(row.kwh - prev.kwhRegister, 6);
        const dKvah = round(row.kvah - prev.kvahRegister, 6);
        if (dKwh < 0 || dKvah < 0) {
          issues.push({ code: "register_decreased", at: row.at, message: "A cumulative register went down (reset or meter swap?)" });
        } else {
          intervalKwh = dKwh;
          intervalKvah = dKvah;
          if (dKvah > 0) {
            const pf = dKwh / dKvah;
            if (pf > 1 + 1e-6) {
              issues.push({ code: "power_factor_out_of_range", at: row.at, message: `kWh > kVAh in this interval (pf ${round(pf, 3)})` });
            } else {
              powerFactor = round(Math.min(pf, 1), 4);
            }
          }
        }
      }
    }

    readings.push({
      at: row.at,
      kwhRegister: row.kwh,
      kvahRegister: row.kvah,
      voltageR: row.volt,
      intervalKwh,
      intervalKvah,
      powerFactor,
    });
  }

  return { readings, issues };
}

/** A half-open window [from, to) of time, epoch ms. */
export interface TimeWindow {
  readonly from: number;
  readonly to: number;
}

/** The interval a reading closes starts 30 minutes before it. */
export const intervalStart = (reading: Pick<Reading, "at">): number => reading.at - HALF_HOUR_MS;

/**
 * Readings whose INTERVAL starts inside the window. For a day window
 * [00:00, 24:00) that is the readings at 00:30 ... 24:00, so their usage adds
 * up to exactly that day's usage.
 */
export function inWindow<T extends Pick<Reading, "at">>(items: readonly T[], window: TimeWindow): T[] {
  return items.filter((item) => intervalStart(item) >= window.from && intervalStart(item) < window.to);
}

/** Number of half-hour intervals that start inside [from, to). */
export function expectedIntervals(from: number, to: number): number {
  const first = ceilToHalfHour(from);
  return first >= to ? 0 : Math.ceil((to - first) / HALF_HOUR_MS);
}

export interface VoltageStats {
  readonly min: number;
  readonly avg: number;
  readonly max: number;
}

export interface Bucket {
  readonly start: number;
  readonly end: number;
  readonly kwh: number | null;
  readonly kvah: number | null;
  readonly powerFactor: number | null;
  readonly voltageR: VoltageStats | null;
  /** Intervals with known usage. */
  readonly intervals: number;
  /** Intervals that should exist in this bucket (inside the requested window). */
  readonly expectedIntervals: number;
  readonly complete: boolean;
}

export type BucketSize = "hour" | "day";

/**
 * Rolls readings up into hour or IST-day buckets. Every bucket in the window
 * is returned, empty ones included, so a chart shows a gap instead of
 * silently joining the dots. `complete` says whether any interval is missing.
 */
export function aggregate(readings: readonly Reading[], window: TimeWindow, size: BucketSize): Bucket[] {
  const floor = size === "hour" ? startOfHour : startOfIstDay;
  const step = size === "hour" ? HOUR_MS : DAY_MS;

  const accumulators = new Map<number, Accumulator>();
  for (let start = floor(window.from); start < window.to; start += step) {
    accumulators.set(start, newAccumulator());
  }
  for (const reading of inWindow(readings, window)) {
    const acc = accumulators.get(floor(intervalStart(reading)));
    if (acc !== undefined) add(acc, reading);
  }

  return [...accumulators].map(([start, acc]) => {
    const end = start + step;
    const expected = expectedIntervals(Math.max(start, window.from), Math.min(end, window.to));
    return { start, end, ...finish(acc), expectedIntervals: expected, complete: acc.intervals === expected };
  });
}

export interface ReadingsSummary {
  readonly intervals: number;
  readonly expectedIntervals: number;
  readonly totalKwh: number | null;
  readonly totalKvah: number | null;
  readonly powerFactor: number | null;
  readonly voltageR: VoltageStats | null;
  /** The half hour with the highest usage. */
  readonly peak: { readonly intervalStart: number; readonly kwh: number } | null;
  readonly firstReadingAt: number | null;
  readonly lastReadingAt: number | null;
}

export function summarize(readings: readonly Reading[], window: TimeWindow): ReadingsSummary {
  const selected = inWindow(readings, window);
  const acc = newAccumulator();
  let peak: ReadingsSummary["peak"] = null;
  for (const reading of selected) {
    add(acc, reading);
    if (reading.intervalKwh !== null && (peak === null || reading.intervalKwh > peak.kwh)) {
      peak = { intervalStart: intervalStart(reading), kwh: reading.intervalKwh };
    }
  }
  const { kwh, kvah, powerFactor, voltageR, intervals } = finish(acc);
  return {
    intervals,
    expectedIntervals: expectedIntervals(window.from, window.to),
    totalKwh: kwh,
    totalKvah: kvah,
    powerFactor,
    voltageR,
    peak,
    firstReadingAt: selected[0]?.at ?? null,
    lastReadingAt: selected.at(-1)?.at ?? null,
  };
}

// ---------------------------------------------------------------------------

interface Accumulator {
  kwh: number;
  kvah: number;
  intervals: number;
  vMin: number;
  vMax: number;
  vSum: number;
  vCount: number;
}

const newAccumulator = (): Accumulator => ({
  kwh: 0,
  kvah: 0,
  intervals: 0,
  vMin: Number.POSITIVE_INFINITY,
  vMax: Number.NEGATIVE_INFINITY,
  vSum: 0,
  vCount: 0,
});

function add(acc: Accumulator, reading: Reading): void {
  acc.vMin = Math.min(acc.vMin, reading.voltageR);
  acc.vMax = Math.max(acc.vMax, reading.voltageR);
  acc.vSum += reading.voltageR;
  acc.vCount += 1;
  if (reading.intervalKwh === null || reading.intervalKvah === null) return;
  acc.kwh += reading.intervalKwh;
  acc.kvah += reading.intervalKvah;
  acc.intervals += 1;
}

function finish(acc: Accumulator) {
  const kwh = acc.intervals === 0 ? null : round(acc.kwh, 6);
  const kvah = acc.intervals === 0 ? null : round(acc.kvah, 6);
  return {
    kwh,
    kvah,
    powerFactor: kwh !== null && kvah !== null && kvah > 0 ? round(Math.min(kwh / kvah, 1), 4) : null,
    voltageR:
      acc.vCount === 0
        ? null
        : { min: acc.vMin, avg: round(acc.vSum / acc.vCount, 1), max: acc.vMax },
    intervals: acc.intervals,
  };
}
