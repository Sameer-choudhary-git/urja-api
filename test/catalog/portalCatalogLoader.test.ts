import { afterEach, describe, expect, it } from "vitest";
import { PortalCatalogLoader } from "../../src/catalog/portalCatalogLoader.js";
import { PortalAuthenticator } from "../../src/portal/authenticator.js";
import { PortalExportApi } from "../../src/portal/exportApi.js";
import { PortalClient } from "../../src/portal/portalClient.js";
import { SessionManager } from "../../src/portal/session.js";
import { PortalTransformersApi } from "../../src/portal/transformersApi.js";
import { startFakePortal, type FakePortal } from "../helpers/fakePortal.js";
import { sampleExport, sampleTransformerRows } from "../helpers/sample.js";

describe("PortalCatalogLoader (end to end against the fake portal)", () => {
  let portal: FakePortal;

  afterEach(async () => {
    await portal.close();
  });

  async function loaderFor(transformers: readonly unknown[]) {
    portal = await startFakePortal({ exportMeters: sampleExport, transformers });
    const authenticator = new PortalAuthenticator({
      baseUrl: portal.baseUrl,
      email: "operator@urja.local",
      password: "correct-horse",
      timeoutMs: 2_000,
    });
    const client = new PortalClient({
      baseUrl: portal.baseUrl,
      sessions: new SessionManager({ authenticator }),
      timeoutMs: 2_000,
      maxRetries: 0,
    });
    return new PortalCatalogLoader({
      exportApi: new PortalExportApi({ client }),
      transformersApi: new PortalTransformersApi({ client }),
    });
  }

  it("logs in once, combines export and /portal/dts into one snapshot", async () => {
    const loader = await loaderFor(sampleTransformerRows);

    const snapshot = await loader.load();

    expect(snapshot.size).toBe(sampleExport.length);
    expect(snapshot.getTransformer("DT-007")).toMatchObject({ name: "Sanganer DT 7", capacityKva: 100 });
    expect(portal.stats.logins).toBe(1);
  });

  it("pages through /portal/dts when there are more than 20 transformers", async () => {
    const many = Array.from({ length: 45 }, (_, i) => ({
      code: `DT-${String(100 + i)}`,
      name: `Extra ${i}`,
      feederCode: "F-100",
      capacityKva: 63,
    }));
    const loader = await loaderFor([...sampleTransformerRows, ...many]);

    const snapshot = await loader.load();

    expect(snapshot.transformers.filter((t) => t.meterCount === 0)).toHaveLength(45);
  });

  it("still builds a catalog when /portal/dts is broken, just without capacities", async () => {
    const loader = await loaderFor([{ code: "DT-001" }]); // wrong shape -> protocol error

    const snapshot = await loader.load();

    expect(snapshot.size).toBe(sampleExport.length);
    expect(snapshot.getTransformer("DT-001")?.capacityKva).toBeNull();
  });
});
