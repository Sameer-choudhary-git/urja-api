import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { PortalAuthenticator } from "../../src/portal/authenticator.js";
import { PortalProtocolError, PortalUnavailableError } from "../../src/portal/errors.js";
import { PortalExportApi } from "../../src/portal/exportApi.js";
import { PortalClient } from "../../src/portal/portalClient.js";
import { SessionManager } from "../../src/portal/session.js";
import { startFakePortal, type FakePortal, type FakePortalOptions } from "../helpers/fakePortal.js";

const sample: unknown[] = JSON.parse(
  readFileSync(new URL("../fixtures/export-sample.json", import.meta.url), "utf8"),
);

describe("PortalExportApi (signed bulk export, against a fake portal)", () => {
  let portal: FakePortal;

  async function setup(options: FakePortalOptions = {}) {
    portal = await startFakePortal({ exportMeters: sample, ...options });
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
      maxRetries: 2,
      sleep: async () => undefined,
    });
    return new PortalExportApi({ client, now: () => 1_000 });
  }

  afterEach(async () => {
    await portal.close();
  });

  it("fetches keys, signs the request and returns every meter", async () => {
    const api = await setup();

    const snapshot = await api.fetchAllMeters();

    expect(snapshot.meters).toHaveLength(sample.length);
    expect(snapshot.meters[0]?.meterId).toBe("J100000");
    expect(snapshot.fetchedAt).toBe(1_000);
    expect(portal.stats.keysRequests).toBe(1);
    expect(portal.stats.exportRequests).toEqual([
      { timestamp: expect.stringMatching(/^\d{10}$/), accepted: true },
    ]);
  });

  it("signs again on every retry after a transient failure", async () => {
    const api = await setup();
    portal.failNextExports(503, 2);

    const snapshot = await api.fetchAllMeters();

    expect(snapshot.meters).toHaveLength(sample.length);
    expect(portal.stats.exportRequests).toHaveLength(3);
    expect(portal.stats.exportRequests.every((r) => r.accepted)).toBe(true);
    expect(portal.stats.keysRequests).toBe(3); // one fresh secret per attempt
  });

  it("recovers when the session expires and the secret is tied to the session", async () => {
    const api = await setup({ secretMode: "per-session" });
    await api.fetchAllMeters();
    portal.expireAllSessions();

    const snapshot = await api.fetchAllMeters();

    expect(snapshot.meters).toHaveLength(sample.length);
    expect(portal.stats.logins).toBe(2);
    // Every export the portal saw was signed with the right session's secret.
    expect(portal.stats.exportRequests.every((r) => r.accepted)).toBe(true);
  });

  it("re-signs with the NEW session's secret when the session dies between keys and export", async () => {
    const api = await setup({ secretMode: "per-session" });
    portal.expireSessionsAfterNextKeys();

    const snapshot = await api.fetchAllMeters();

    // keys (session 1) -> export 401 -> re-login -> keys (session 2) -> export OK
    expect(snapshot.meters).toHaveLength(sample.length);
    expect(portal.stats.logins).toBe(2);
    expect(portal.stats.keysRequests).toBe(2);
    expect(portal.stats.exportRequests.at(-1)?.accepted).toBe(true);
  });

  it("gives up with PortalUnavailableError when the portal keeps failing", async () => {
    const api = await setup();
    portal.failNextExports(503, 10);

    await expect(api.fetchAllMeters()).rejects.toBeInstanceOf(PortalUnavailableError);
  });

  it("fails loudly if the export looks paginated (total > items)", async () => {
    const api = await setup();
    portal.setExportTotal(403);

    await expect(api.fetchAllMeters()).rejects.toThrow(/may have become paginated/);
  });

  it("rejects a payload whose shape does not match the documented protocol", async () => {
    const api = await setup({ exportMeters: [{ meterId: "J1", geo: { lat: "26.9", lng: 75 } }] });

    await expect(api.fetchAllMeters()).rejects.toBeInstanceOf(PortalProtocolError);
  });

  it("rejects duplicate meter IDs", async () => {
    const api = await setup({ exportMeters: [sample[0], sample[0]] });

    await expect(api.fetchAllMeters()).rejects.toThrow(/more than once/);
  });
});
