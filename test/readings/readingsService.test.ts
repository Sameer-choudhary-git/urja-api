import { describe, expect, it, vi } from "vitest";
import { HOUR_MS, MINUTE_MS, toIstIso } from "../../src/domain/time.js";
import type { PortalDayRange } from "../../src/portal/energyApi.js";
import { PortalNotFoundError, PortalUnavailableError } from "../../src/portal/errors.js";
import {
  portalDaysFor,
  ReadingsService,
  resolveWindow,
  ttlForDataAge,
} from "../../src/readings/readingsService.js";
import { filterEnergy, generateEnergy } from "../helpers/fakeEnergy.js";

const ist = (value: string) => Date.parse(`${value}+05:30`);
const NOW = ist("2026-11-03T12:00:00");

/** Behaves like the portal (same filter rules), counting calls. */
function fakeSource() {
  const calls: (PortalDayRange | null)[] = [];
  const source = {
    calls,
    fail: null as Error | null,
    fetchReadings: vi.fn(async (meterId: string, days: PortalDayRange | null) => {
      calls.push(days);
      if (source.fail !== null) throw source.fail;
      const params = new URLSearchParams(days === null ? {} : { from: days.from, to: days.to });
      return filterEnergy(generateEnergy(meterId), params);
    }),
  };
  return source;
}

describe("window rules", () => {
  it("fills a missing side with 7 days; neither side means the portal default", () => {
    const at = ist("2026-06-20T00:00:00");
    expect(resolveWindow({ from: at })).toEqual({ from: at, to: at + 7 * 24 * HOUR_MS });
    expect(resolveWindow({ to: at })).toEqual({ from: at - 7 * 24 * HOUR_MS, to: at });
    expect(resolveWindow({})).toBeNull();
  });

  it("asks the portal for the whole IST days covering every interval in the window", () => {
    expect(portalDaysFor({ from: ist("2026-06-29T00:00:00"), to: ist("2026-06-30T00:00:00") })).toEqual({
      from: "2026-06-29",
      to: "2026-06-30", // the reading at 30 June 00:00 closes the last interval of the 29th
    });
    expect(portalDaysFor({ from: ist("2026-06-29T10:15:00"), to: ist("2026-06-29T18:00:00") })).toEqual({
      from: "2026-06-29",
      to: "2026-06-29",
    });
  });

  it("keeps history for an hour and live data until just after the next reading", () => {
    expect(ttlForDataAge(ist("2026-06-30T23:30:00"), NOW)).toBe(HOUR_MS);
    expect(ttlForDataAge(null, NOW)).toBe(5 * MINUTE_MS);
    expect(ttlForDataAge(NOW - 10 * MINUTE_MS, NOW)).toBe(5 * MINUTE_MS); // capped
    expect(ttlForDataAge(NOW - 29 * MINUTE_MS, NOW)).toBe(2 * MINUTE_MS); // due in 1 min, +1 min grace
    expect(ttlForDataAge(NOW - 45 * MINUTE_MS, NOW)).toBe(30_000); // overdue: floor
  });
});

describe("ReadingsService", () => {
  it("default window: the 7 days ending at the newest reading, from one portal call", async () => {
    const source = fakeSource();
    const service = new ReadingsService({ source, now: () => NOW });
    const result = await service.get({ meterId: "J100000" });
    expect(source.calls).toEqual([null]);
    expect(toIstIso(result.window.from)).toBe("2026-06-23T23:30:00+05:30");
    expect(toIstIso(result.window.to)).toBe("2026-06-30T23:30:00+05:30");
    expect(result.cache).toBe("miss");
    expect(result.expiresAt - result.fetchedAt).toBe(HOUR_MS);
  });

  it("windows inside the same portal days share one cached answer", async () => {
    const source = fakeSource();
    const service = new ReadingsService({ source, now: () => NOW });
    await service.get({ meterId: "J100000", from: ist("2026-06-29T00:00:00"), to: ist("2026-06-29T12:00:00") });
    const second = await service.get({ meterId: "J100000", from: ist("2026-06-29T06:00:00"), to: ist("2026-06-29T18:00:00") });
    expect(source.fetchReadings).toHaveBeenCalledTimes(1);
    expect(second.cache).toBe("hit");
    expect(service.cacheStats).toMatchObject({ hits: 1, loads: 1, entries: 1 });
  });

  it("serves the last good copy when the portal goes down", async () => {
    let now = NOW;
    const source = fakeSource();
    const service = new ReadingsService({ source, now: () => now });
    const request = { meterId: "J100000", from: ist("2026-06-29T00:00:00"), to: ist("2026-06-30T00:00:00") };
    await service.get(request);
    now += 2 * HOUR_MS;
    source.fail = new PortalUnavailableError("down");
    const result = await service.get(request);
    expect(result.cache).toBe("stale");
    expect(result.readings.length).toBeGreaterThan(0);
  });

  it("does not hide a meter the portal says is gone", async () => {
    let now = NOW;
    const source = fakeSource();
    const service = new ReadingsService({ source, now: () => now });
    await service.get({ meterId: "J100000" });
    now += 2 * HOUR_MS;
    source.fail = new PortalNotFoundError("Meter not found");
    await expect(service.get({ meterId: "J100000" })).rejects.toBeInstanceOf(PortalNotFoundError);
  });
});
