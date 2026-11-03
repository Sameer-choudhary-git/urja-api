import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PortalAuthenticator } from "../../src/portal/authenticator.js";
import { PortalAuthError, PortalUnavailableError } from "../../src/portal/errors.js";
import { startFakePortal, type FakePortal } from "../helpers/fakePortal.js";

describe("PortalAuthenticator", () => {
  let portal: FakePortal;

  beforeEach(async () => {
    portal = await startFakePortal({ maxAgeSeconds: 3600 });
  });

  afterEach(async () => {
    await portal.close();
  });

  const build = (overrides: { password?: string; baseUrl?: string; now?: () => number } = {}) =>
    new PortalAuthenticator({
      baseUrl: overrides.baseUrl ?? portal.baseUrl,
      email: "operator@urja.local",
      password: overrides.password ?? "correct-horse",
      timeoutMs: 2_000,
      ...(overrides.now && { now: overrides.now }),
    });

  it("logs in and returns the raw cookie with an expiry from Max-Age", async () => {
    const now = 5_000_000;
    const session = await build({ now: () => now }).login();

    expect(session.cookie).toBe("__Secure-better-auth.session_token=token-1.sig%3D");
    expect(session.expiresAt).toBe(now + 3_600_000);
  });

  it("sends the Origin header the portal's CSRF check requires", async () => {
    // The fake portal answers 403 unless Origin matches, so success proves it was sent.
    await expect(build().login()).resolves.toBeDefined();
  });

  it("raises PortalAuthError for wrong credentials", async () => {
    await expect(build({ password: "wrong" }).login()).rejects.toBeInstanceOf(PortalAuthError);
  });

  it("raises PortalUnavailableError when the portal cannot be reached", async () => {
    await portal.close();
    await expect(build().login()).rejects.toBeInstanceOf(PortalUnavailableError);
    portal = await startFakePortal(); // so afterEach has something to close
  });
});
