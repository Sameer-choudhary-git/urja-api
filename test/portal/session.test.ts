import { describe, expect, it, vi } from "vitest";
import { SessionManager, type Authenticator, type Session } from "../../src/portal/session.js";

const HOUR = 3_600_000;

function setup() {
  const clock = { now: 1_000_000 };
  let counter = 0;
  const login = vi.fn(async (): Promise<Session> => {
    counter += 1;
    await Promise.resolve(); // give concurrent callers a chance to pile up
    return { cookie: `session-${counter}`, expiresAt: clock.now + HOUR };
  });
  const authenticator: Authenticator = { login };
  const manager = new SessionManager({ authenticator, now: () => clock.now, refreshMarginMs: 60_000 });
  return { clock, login, manager };
}

describe("SessionManager", () => {
  it("logs in lazily and reuses a valid session", async () => {
    const { login, manager } = setup();
    expect(login).not.toHaveBeenCalled();

    expect(await manager.getCookie()).toBe("session-1");
    expect(await manager.getCookie()).toBe("session-1");
    expect(login).toHaveBeenCalledTimes(1);
  });

  it("lets concurrent callers share a single login", async () => {
    const { login, manager } = setup();
    const cookies = await Promise.all(Array.from({ length: 5 }, () => manager.getCookie()));

    expect(new Set(cookies)).toEqual(new Set(["session-1"]));
    expect(login).toHaveBeenCalledTimes(1);
  });

  it("renews once the session is within the refresh margin of expiry", async () => {
    const { clock, manager } = setup();
    await manager.getCookie();

    clock.now += HOUR - 120_000; // 2 minutes left: still outside the 1 minute margin
    expect(await manager.getCookie()).toBe("session-1");

    clock.now += 90_000; // 30 seconds left: inside the margin
    expect(await manager.getCookie()).toBe("session-2");
  });

  it("forces a new login after the current cookie is invalidated", async () => {
    const { manager } = setup();
    const first = await manager.getCookie();
    manager.invalidate(first);
    expect(await manager.getCookie()).toBe("session-2");
  });

  it("ignores invalidation of a cookie that was already replaced", async () => {
    const { login, manager } = setup();
    const first = await manager.getCookie();
    manager.invalidate(first);
    await manager.getCookie(); // session-2 is now current

    manager.invalidate(first); // stale report from a slow request
    expect(await manager.getCookie()).toBe("session-2");
    expect(login).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failed login", async () => {
    const clock = { now: 0 };
    const login = vi
      .fn<() => Promise<Session>>()
      .mockRejectedValueOnce(new Error("portal down"))
      .mockResolvedValueOnce({ cookie: "ok", expiresAt: clock.now + HOUR });
    const manager = new SessionManager({ authenticator: { login }, now: () => clock.now });

    await expect(manager.getCookie()).rejects.toThrow("portal down");
    expect(await manager.getCookie()).toBe("ok");
  });
});
