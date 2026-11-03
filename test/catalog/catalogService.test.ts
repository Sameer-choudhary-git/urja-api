import { describe, expect, it } from "vitest";
import { CatalogSnapshot } from "../../src/catalog/catalogSnapshot.js";
import { CatalogService, type CatalogLoader } from "../../src/catalog/catalogService.js";
import { normalizeCatalog } from "../../src/domain/normalize.js";
import { sampleExport } from "../helpers/sample.js";

const [realMeter] = normalizeCatalog(sampleExport, null).meters;

const MIN = 60_000;

/**
 * A loader we control by hand: each load() waits until the test resolves or
 * rejects it, so we can see exactly what the service does in between.
 */
function manualLoader(clock: { now: number }) {
  const pending: { resolve: (s: CatalogSnapshot) => void; reject: (e: Error) => void }[] = [];
  let loads = 0;
  const loader: CatalogLoader = {
    load: () => {
      loads += 1;
      return new Promise((resolve, reject) => pending.push({ resolve, reject }));
    },
  };
  const snapshot = (tag: string) =>
    new CatalogSnapshot({
      meters: [{ ...realMeter!, id: tag }],
      transformers: [],
      fetchedAt: clock.now,
    });
  return {
    loader,
    get loads() {
      return loads;
    },
    succeed(tag: string) {
      pending.shift()!.resolve(snapshot(tag));
    },
    fail(message: string) {
      pending.shift()!.reject(new Error(message));
    },
  };
}

function setup() {
  const clock = { now: 1_000_000 };
  const control = manualLoader(clock);
  const service = new CatalogService({
    loader: control.loader,
    ttlMs: 15 * MIN,
    maxStaleMs: 60 * MIN,
    now: () => clock.now,
  });
  const tag = async () => (await service.read()).snapshot.meters[0]?.id;
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  return { clock, control, service, tag, flush };
}

describe("CatalogService freshness", () => {
  it("waits for the first load and shares it between concurrent readers", async () => {
    const { control, service, flush } = setup();

    const reads = Promise.all([service.read(), service.read(), service.read()]);
    await flush();
    expect(control.loads).toBe(1);
    control.succeed("v1");

    const results = await reads;
    expect(results.map((r) => r.snapshot.meters[0]?.id)).toEqual(["v1", "v1", "v1"]);
    expect(results[0]?.stale).toBe(false);
  });

  it("serves a fresh snapshot without touching the portal", async () => {
    const { clock, control, service, tag, flush } = setup();
    const first = service.read();
    await flush();
    control.succeed("v1");
    await first;

    clock.now += 14 * MIN;
    expect(await tag()).toBe("v1");
    expect(control.loads).toBe(1);
  });

  it("stale-while-revalidate: serves the old snapshot at once and refreshes once in the background", async () => {
    const { clock, control, service, tag, flush } = setup();
    const first = service.read();
    await flush();
    control.succeed("v1");
    await first;

    clock.now += 20 * MIN;
    const read = await service.read();
    expect(read.snapshot.meters[0]?.id).toBe("v1");
    expect(read.stale).toBe(true);
    await service.read(); // a second stale read must not start a second load
    expect(control.loads).toBe(2);

    control.succeed("v2");
    await flush();
    expect(await tag()).toBe("v2");
  });

  it("stale-if-error: a failed background refresh keeps the old snapshot and records the error", async () => {
    const { clock, control, service, tag, flush } = setup();
    const first = service.read();
    await flush();
    control.succeed("v1");
    await first;

    clock.now += 20 * MIN;
    await service.read();
    control.fail("portal down");
    await flush();

    expect(await tag()).toBe("v1");
    expect(service.status().lastError?.message).toBe("portal down");
  });

  it("past maxStale, a reader waits for the refresh and sees its error", async () => {
    const { clock, control, service, flush } = setup();
    const first = service.read();
    await flush();
    control.succeed("v1");
    await first;

    clock.now += 61 * MIN;
    const read = service.read();
    await flush();
    control.fail("portal down");

    await expect(read).rejects.toThrow("portal down");
  });

  it("the first load's error reaches the caller, and the next read tries again", async () => {
    const { control, service, tag, flush } = setup();
    const first = service.read();
    await flush();
    control.fail("bad credentials");
    await expect(first).rejects.toThrow("bad credentials");

    const second = tag();
    await flush();
    control.succeed("v1");
    expect(await second).toBe("v1");
  });

  it("refuses a configuration where maxStale is shorter than the TTL", () => {
    expect(
      () => new CatalogService({ loader: { load: async () => never() }, ttlMs: 10, maxStaleMs: 5 }),
    ).toThrow(/maxStaleMs/);
  });
});

function never(): never {
  throw new Error("not called");
}
