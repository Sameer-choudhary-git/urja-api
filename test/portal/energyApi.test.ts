import { afterEach, describe, expect, it } from "vitest";
import { createPortal } from "../../src/portal/createPortal.js";
import { PortalNotFoundError } from "../../src/portal/errors.js";
import { filterEnergy, generateEnergy } from "../helpers/fakeEnergy.js";
import { startFakePortal, type FakePortal } from "../helpers/fakePortal.js";
import { sampleExport } from "../helpers/sample.js";

describe("the fake portal's energy filter matches the live probe (PROTOCOL.md 3.3)", () => {
  const rows = generateEnergy("J100000");
  const cases: [string, number, string | null, string | null][] = [
    ["", 337, "23/06/2026 23:30", "30/06/2026 23:30"],
    ["from=2026-06-29&to=2026-06-30", 96, "29/06/2026 00:00", "30/06/2026 23:30"],
    ["from=2026-06-30&to=2026-06-30", 48, "30/06/2026 00:00", "30/06/2026 23:30"],
    ["from=2026-06-29", 96, "29/06/2026 00:00", "30/06/2026 23:30"],
    ["to=2026-06-24", 336, "18/06/2026 00:00", "24/06/2026 23:30"],
    ["from=2026-06-29T12:00&to=2026-06-29T18:00", 337, "23/06/2026 23:30", "30/06/2026 23:30"],
    ["from=2026-07-01&to=2026-07-05", 0, null, null],
    ["from=2026-06-30&to=2026-06-29", 0, null, null],
    ["from=not-a-date&to=2026-06-30", 336, "24/06/2026 00:00", "30/06/2026 23:30"],
    ["from=2026-06-01&to=2026-06-30", 1440, "01/06/2026 00:00", "30/06/2026 23:30"],
    ["from=2026-01-01&to=2026-06-30", 1440, "01/06/2026 00:00", "30/06/2026 23:30"],
    ["to=2026-06-01", 48, "01/06/2026 00:00", "01/06/2026 23:30"],
    ["to=2026-03-01", 0, null, null],
  ];
  it.each(cases)("?%s -> %i rows", (query, count, first, last) => {
    const result = filterEnergy(rows, new URLSearchParams(query));
    expect(result).toHaveLength(count);
    expect(result[0]?.timestamp ?? null).toBe(first);
    expect(result.at(-1)?.timestamp ?? null).toBe(last);
  });
});

describe("PortalEnergyApi (against the fake portal)", () => {
  let fake: FakePortal;
  afterEach(async () => fake.close());

  async function setup() {
    fake = await startFakePortal({ exportMeters: sampleExport });
    return createPortal({ baseUrl: fake.baseUrl, email: "operator@urja.local", password: "correct-horse", timeoutMs: 2_000, maxRetries: 1 }).energyApi;
  }

  it("sends only plain ISO days, and nothing at all for the default window", async () => {
    const api = await setup();
    expect(await api.fetchReadings("J100000", { from: "2026-06-29", to: "2026-06-30" })).toHaveLength(96);
    expect(await api.fetchReadings("J100000", null)).toHaveLength(337);
    expect(fake.stats.energyRequests).toEqual(["J100000?from=2026-06-29&to=2026-06-30", "J100000"]);
  });

  it("refuses a day format the portal would silently ignore", async () => {
    const api = await setup();
    await expect(api.fetchReadings("J100000", { from: "2026-06-29T10:00", to: "2026-06-30" })).rejects.toThrow(/YYYY-MM-DD/);
    expect(fake.stats.energyRequests).toEqual([]);
  });

  it("maps an unknown meter to PortalNotFoundError and retries a 503", async () => {
    const api = await setup();
    await expect(api.fetchReadings("J999999", null)).rejects.toBeInstanceOf(PortalNotFoundError);
    fake.failNextEnergy(503, 1);
    expect(await api.fetchReadings("J100000", null)).toHaveLength(337);
  });
});
