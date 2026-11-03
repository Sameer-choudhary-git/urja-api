import type { MeterStatus } from "./meter.js";
import { inWindow, intervalStart, round, summarize, type Reading, type ReadingIssue, type TimeWindow } from "./readings.js";
import { HALF_HOUR_MS } from "./time.js";

/**
 * Rule-based anomaly detection on one meter's readings. Every rule is a plain,
 * explainable check with a named threshold, so an operator can see WHY a
 * meter was flagged and argue with the threshold, not with a black box.
 */

export const ANOMALY_CODES = [
  "voltage_out_of_range",
  "low_power_factor",
  "zero_consumption",
  "consumption_spike",
  "decommissioned_but_consuming",
  "data_gap",
  "register_decreased",
  "transformer_overload",
] as const;
export type AnomalyCode = (typeof ANOMALY_CODES)[number];
export type Severity = "info" | "warning" | "critical";

export interface Anomaly {
  readonly code: AnomalyCode;
  readonly severity: Severity;
  readonly subject: string;
  /** When it happened: the first offending interval/reading, or null for window-wide findings. */
  readonly at: number | null;
  readonly message: string;
  /** The measured value that broke the rule (volts, power factor, kWh, %...). */
  readonly value: number | null;
}

export const THRESHOLDS = {
  /** 230 V nominal, +-6% at low voltage (Indian Electricity Rules 1956, rule 54). */
  voltageMin: 216.2,
  voltageMax: 243.8,
  /** Many Indian utilities penalise a power factor below 0.85 (some 0.9). */
  powerFactorMin: 0.85,
  /** A half hour counts as a spike above median + k * MAD (robust to the spikes themselves). */
  spikeMadFactor: 6,
  /** ...and only if it is also at least this many kWh, so tiny loads do not trigger. */
  spikeMinKwh: 0.5,
  /** Zero consumption for at least this long, on a meter that should be live. */
  zeroRunIntervals: 48,
  /** Transformer: peak demand above this share of capacity is a warning; above 100% critical. */
  transformerWarnPercent: 80,
} as const;

export function detectMeterAnomalies(
  meter: { readonly id: string; readonly status: MeterStatus },
  readings: readonly Reading[],
  issues: readonly ReadingIssue[],
  window: TimeWindow,
): Anomaly[] {
  const selected = inWindow(readings, window);
  const found: Anomaly[] = [];
  const subject = meter.id;

  // Voltage: one finding per direction, with the worst value and how often.
  const low = selected.filter((r) => r.voltageR < THRESHOLDS.voltageMin);
  const high = selected.filter((r) => r.voltageR > THRESHOLDS.voltageMax);
  for (const [list, word, pick] of [
    [low, "below", Math.min],
    [high, "above", Math.max],
  ] as const) {
    if (list.length === 0) continue;
    const worst = pick(...list.map((r) => r.voltageR));
    found.push({
      code: "voltage_out_of_range",
      severity: list.length >= 4 ? "warning" : "info",
      subject,
      at: list[0]!.at,
      message: `${list.length} reading(s) ${word} the ${word === "below" ? THRESHOLDS.voltageMin : THRESHOLDS.voltageMax} V limit (worst ${worst} V)`,
      value: worst,
    });
  }

  const summary = summarize(readings, window);
  if (summary.powerFactor !== null && summary.powerFactor < THRESHOLDS.powerFactorMin) {
    found.push({
      code: "low_power_factor",
      severity: "warning",
      subject,
      at: null,
      message: `Power factor ${summary.powerFactor} over the window, below ${THRESHOLDS.powerFactorMin}`,
      value: summary.powerFactor,
    });
  }

  // Zero consumption: longest run of known, zero intervals.
  if (meter.status !== "decommissioned") {
    let run = 0;
    let runStart: number | null = null;
    let best = { length: 0, start: null as number | null };
    for (const r of selected) {
      if (r.intervalKwh === 0) {
        if (run === 0) runStart = intervalStart(r);
        run += 1;
        if (run > best.length) best = { length: run, start: runStart };
      } else {
        run = 0;
      }
    }
    if (best.length >= THRESHOLDS.zeroRunIntervals) {
      found.push({
        code: "zero_consumption",
        severity: meter.status === "installed" ? "critical" : "warning",
        subject,
        at: best.start,
        message: `No consumption for ${(best.length * HALF_HOUR_MS) / 3_600_000} hours on a ${meter.status} meter (stopped, bypassed or disconnected?)`,
        value: best.length,
      });
    }
  }

  // Spikes: robust statistics, so one huge spike does not hide itself by raising the mean.
  const usage = selected.map((r) => r.intervalKwh).filter((v): v is number => v !== null);
  if (usage.length >= 48) {
    const med = median(usage);
    const mad = median(usage.map((v) => Math.abs(v - med)));
    const limit = Math.max(med + THRESHOLDS.spikeMadFactor * mad, THRESHOLDS.spikeMinKwh);
    const spikes = selected.filter((r) => r.intervalKwh !== null && r.intervalKwh > limit);
    if (spikes.length > 0) {
      const top = spikes.reduce((a, b) => ((a.intervalKwh ?? 0) >= (b.intervalKwh ?? 0) ? a : b));
      found.push({
        code: "consumption_spike",
        severity: "info",
        subject,
        at: intervalStart(top),
        message: `${spikes.length} half hour(s) above ${round(limit, 3)} kWh (typical ${round(med, 3)} kWh); highest ${top.intervalKwh} kWh`,
        value: top.intervalKwh,
      });
    }
  }

  if (meter.status === "decommissioned" && summary.totalKwh !== null && summary.totalKwh > 0) {
    found.push({
      code: "decommissioned_but_consuming",
      severity: "critical",
      subject,
      at: summary.firstReadingAt,
      message: `Marked decommissioned, but recorded ${summary.totalKwh} kWh in this window`,
      value: summary.totalKwh,
    });
  }

  const inside = (at: number | null) => at !== null && at - HALF_HOUR_MS >= window.from && at - HALF_HOUR_MS < window.to;
  const gaps = issues.filter((i) => i.code === "reading_gap" || i.code === "irregular_interval").filter((i) => inside(i.at));
  if (gaps.length > 0 || (summary.expectedIntervals > 0 && summary.intervals < summary.expectedIntervals)) {
    const missing = summary.expectedIntervals - summary.intervals;
    if (missing > 0) {
      found.push({
        code: "data_gap",
        severity: missing > 48 ? "warning" : "info",
        subject,
        at: gaps[0]?.at ?? null,
        message: `${missing} of ${summary.expectedIntervals} half hours have no usage figure`,
        value: missing,
      });
    }
  }
  for (const issue of issues.filter((i) => i.code === "register_decreased" && inside(i.at))) {
    found.push({ code: "register_decreased", severity: "warning", subject, at: issue.at, message: issue.message, value: null });
  }

  return found;
}

export interface TransformerLoadPoint {
  readonly intervalStart: number;
  /** Average apparent power over the half hour: kVAh in 30 minutes x 2. */
  readonly kva: number;
  readonly metersReporting: number;
}

export interface TransformerLoad {
  readonly capacityKva: number | null;
  readonly points: TransformerLoadPoint[];
  readonly peak: TransformerLoadPoint | null;
  readonly peakUtilisationPercent: number | null;
  readonly averageKva: number | null;
}

/**
 * Demand on a transformer: the sum of its meters' apparent power per half
 * hour. kVAh used in 30 minutes, times 2, is the average kVA in that half
 * hour, which is what a transformer's kVA rating is compared against.
 * Only meters connected to the DT are counted, so losses and unmetered load
 * are missing: this is a lower bound on the real loading.
 */
export function transformerLoad(
  capacityKva: number | null,
  perMeter: readonly (readonly Reading[])[],
  window: TimeWindow,
): TransformerLoad {
  const buckets = new Map<number, { kva: number; meters: number }>();
  for (const readings of perMeter) {
    for (const r of inWindow(readings, window)) {
      if (r.intervalKvah === null) continue;
      const key = intervalStart(r);
      const bucket = buckets.get(key) ?? { kva: 0, meters: 0 };
      bucket.kva += r.intervalKvah * 2;
      bucket.meters += 1;
      buckets.set(key, bucket);
    }
  }
  const points = [...buckets]
    .sort(([a], [b]) => a - b)
    .map(([start, b]) => ({ intervalStart: start, kva: round(b.kva, 3), metersReporting: b.meters }));
  const peak = points.reduce<TransformerLoadPoint | null>((best, p) => (best === null || p.kva > best.kva ? p : best), null);
  return {
    capacityKva,
    points,
    peak,
    peakUtilisationPercent: peak !== null && capacityKva !== null && capacityKva > 0 ? round((peak.kva / capacityKva) * 100, 1) : null,
    averageKva: points.length === 0 ? null : round(points.reduce((sum, p) => sum + p.kva, 0) / points.length, 3),
  };
}

export function transformerAnomalies(code: string, load: TransformerLoad): Anomaly[] {
  const pct = load.peakUtilisationPercent;
  if (pct === null || load.peak === null || pct < THRESHOLDS.transformerWarnPercent) return [];
  return [
    {
      code: "transformer_overload",
      severity: pct >= 100 ? "critical" : "warning",
      subject: code,
      at: load.peak.intervalStart,
      message: `Peak demand ${load.peak.kva} kVA is ${pct}% of the ${load.capacityKva} kVA rating`,
      value: pct,
    },
  ];
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}
