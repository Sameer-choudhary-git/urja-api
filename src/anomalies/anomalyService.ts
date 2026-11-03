import type { Meter, Transformer } from "../domain/meter.js";
import {
  detectMeterAnomalies,
  transformerAnomalies,
  transformerLoad,
  type Anomaly,
  type TransformerLoad,
} from "../domain/anomalies.js";
import type { TimeWindow } from "../domain/readings.js";
import type { ReadingsResult, ReadingsService } from "../readings/readingsService.js";

/** A scan touches one portal call per meter, so a scope is capped. */
export const MAX_SCOPE_METERS = 50;

export interface WindowRequest {
  readonly from?: number | undefined;
  readonly to?: number | undefined;
}

export interface MeterAnomalies {
  readonly meterId: string;
  readonly window: TimeWindow;
  readonly anomalies: readonly Anomaly[];
}

export interface ScanResult {
  readonly results: readonly MeterAnomalies[];
  /** Meters whose readings could not be fetched; the scan still returns the rest. */
  readonly failed: readonly { readonly meterId: string; readonly error: string }[];
}

/**
 * Runs the anomaly rules over meters' readings. Readings come through the
 * ReadingsService, so they are cached, and the portal client's concurrency
 * limit turns a 50-meter scan into a steady trickle of portal calls.
 */
export class AnomalyService {
  constructor(private readonly readings: Pick<ReadingsService, "get">) {}

  async scan(meters: readonly Meter[], window: WindowRequest): Promise<ScanResult> {
    if (meters.length > MAX_SCOPE_METERS) {
      throw new RangeError(`A scan covers at most ${MAX_SCOPE_METERS} meters; this scope has ${meters.length}`);
    }
    const fetched = await this.fetchAll(meters, window);
    return {
      results: fetched.ok.map(({ meter, result }) => ({
        meterId: meter.id,
        window: result.window,
        anomalies: detectMeterAnomalies(meter, result.readings, result.issues, result.window),
      })),
      failed: fetched.failed,
    };
  }

  async transformer(
    transformer: Transformer,
    meters: readonly Meter[],
    window: WindowRequest,
  ): Promise<{ load: TransformerLoad; window: TimeWindow; anomalies: Anomaly[]; failed: ScanResult["failed"] }> {
    const fetched = await this.fetchAll(meters, window);
    // Meters without from/to each resolve "the 7 days ending at their newest reading";
    // use the first one's so every meter is summed over the same window.
    const resolved = fetched.ok[0]?.result.window ?? { from: window.from ?? 0, to: window.to ?? 0 };
    const load = transformerLoad(transformer.capacityKva, fetched.ok.map(({ result }) => result.readings), resolved);
    return { load, window: resolved, anomalies: transformerAnomalies(transformer.code, load), failed: fetched.failed };
  }

  private async fetchAll(meters: readonly Meter[], window: WindowRequest) {
    const settled = await Promise.allSettled(
      meters.map((meter) => this.readings.get({ meterId: meter.id, from: window.from, to: window.to })),
    );
    const ok: { meter: Meter; result: ReadingsResult }[] = [];
    const failed: { meterId: string; error: string }[] = [];
    settled.forEach((outcome, i) => {
      const meter = meters[i]!;
      if (outcome.status === "fulfilled") ok.push({ meter, result: outcome.value });
      else failed.push({ meterId: meter.id, error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason) });
    });
    // Nothing worked at all: that is an outage, not a partial result. Surface the real error (503 etc.).
    if (ok.length === 0 && settled.length > 0) {
      throw (settled[0] as PromiseRejectedResult).reason;
    }
    return { ok, failed };
  }
}
