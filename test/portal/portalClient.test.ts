import { z } from "zod";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PortalAuthenticator } from "../../src/portal/authenticator.js";
import {
  PortalAuthError,
  PortalNotFoundError,
  PortalProtocolError,
  PortalUnavailableError,
} from "../../src/portal/errors.js";
import { PortalClient } from "../../src/portal/portalClient.js";
import { SessionManager } from "../../src/portal/session.js";
import { startFakePortal, type FakePortal } from "../helpers/fakePortal.js";

const searchPage = z.object({
  data: z.array(z.object({ meterId: z.string() })),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
});

describe("PortalClient (against a fake portal)", () => {
  let portal: FakePortal;
  let client: PortalClient;

  const buildClient = (maxRetries = 2, timeoutMs = 2_000) => {
    const authenticator = new PortalAuthenticator({
      baseUrl: portal.baseUrl,
      email: "operator@urja.local",
      password: "correct-horse",
      timeoutMs,
    });
    return new PortalClient({
      baseUrl: portal.baseUrl,
      sessions: new SessionManager({ authenticator }),
      timeoutMs,
      maxRetries,
      sleep: async () => undefined, // keep tests fast
    });
  };

  beforeEach(async () => {
    portal = await startFakePortal();
    client = buildClient();
  });

  afterEach(async () => {
    await portal.close();
  });

  it("logs in on first use and returns validated data", async () => {
    const page = await client.get("/portal/meters/search", searchPage, { q: "", page: 1 });

    expect(page.total).toBe(403);
    expect(page.data[0]?.meterId).toBe("J100000");
    expect(portal.stats.logins).toBe(1);
  });

  it("shares one login between concurrent requests", async () => {
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        client.get("/portal/meters/search", searchPage, { page: index + 1 }),
      ),
    );
    expect(portal.stats.logins).toBe(1);
    expect(portal.stats.searchRequests).toBe(8);
  });

  it("transparently logs in again after the portal expires the session", async () => {
    await client.get("/portal/meters/search", searchPage);
    portal.expireAllSessions();

    const page = await client.get("/portal/meters/search", searchPage);

    expect(page.total).toBe(403);
    expect(portal.stats.logins).toBe(2);
  });

  it("re-logs in only once for a burst of requests that all hit an expired session", async () => {
    await client.get("/portal/meters/search", searchPage);
    portal.expireAllSessions();

    await Promise.all(
      Array.from({ length: 6 }, () => client.get("/portal/meters/search", searchPage)),
    );
    expect(portal.stats.logins).toBe(2);
  });

  it("maps a 404 to PortalNotFoundError and keeps the portal's message", async () => {
    const error = await client.get("/portal/meters/J999999/energy", searchPage).catch((e) => e);

    expect(error).toBeInstanceOf(PortalNotFoundError);
    expect((error as PortalNotFoundError).message).toBe("Meter not found");
  });

  it("retries a transient 503 and then succeeds", async () => {
    portal.failNextSearches(503, 2);

    const page = await client.get("/portal/meters/search", searchPage);

    expect(page.total).toBe(403);
    expect(portal.stats.searchRequests).toBe(3);
  });

  it("gives up with PortalUnavailableError once retries are exhausted", async () => {
    portal.failNextSearches(503, 10);

    await expect(client.get("/portal/meters/search", searchPage)).rejects.toBeInstanceOf(
      PortalUnavailableError,
    );
    expect(portal.stats.searchRequests).toBe(3); // 1 attempt + 2 retries
  });

  it("does not retry when retries are disabled", async () => {
    client = buildClient(0);
    portal.failNextSearches(503, 10);

    await expect(client.get("/portal/meters/search", searchPage)).rejects.toBeInstanceOf(
      PortalUnavailableError,
    );
    expect(portal.stats.searchRequests).toBe(1);
  });

  it("times out slow responses", async () => {
    client = buildClient(0, 100);
    portal.delayNextSearch(500);

    await expect(client.get("/portal/meters/search", searchPage)).rejects.toBeInstanceOf(
      PortalUnavailableError,
    );
  });

  it("raises PortalProtocolError when the body is not JSON", async () => {
    await expect(client.get("/portal/meters/not-json", searchPage)).rejects.toBeInstanceOf(
      PortalProtocolError,
    );
  });

  it("raises PortalProtocolError, naming the field, when the shape is wrong", async () => {
    const strictSchema = z.object({ data: z.array(z.object({ serialNo: z.string() })) });

    const error = await client.get("/portal/meters/search", strictSchema).catch((e) => e);

    expect(error).toBeInstanceOf(PortalProtocolError);
    expect((error as Error).message).toContain("data.0.serialNo");
  });

  it("fails with PortalAuthError when a brand-new session is also rejected", async () => {
    // A portal that rejects everything, even right after a successful login.
    await portal.close();
    portal = await startFakePortal();
    const stubbornClient = new PortalClient({
      baseUrl: portal.baseUrl,
      sessions: {
        getCookie: async () => "__Secure-better-auth.session_token=never-valid",
        invalidate: () => undefined,
      },
      timeoutMs: 2_000,
      maxRetries: 0,
    });

    await expect(stubbornClient.get("/portal/meters/search", searchPage)).rejects.toBeInstanceOf(
      PortalAuthError,
    );
  });
});
