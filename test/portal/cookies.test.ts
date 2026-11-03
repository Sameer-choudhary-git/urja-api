import { describe, expect, it } from "vitest";
import { cookieLifetimeMs, parseSetCookie } from "../../src/portal/cookies.js";

describe("parseSetCookie", () => {
  it("keeps the raw (still percent-encoded) value and reads Max-Age", () => {
    const cookie = parseSetCookie(
      "__Secure-better-auth.session_token=abc.def%3D; Path=/; Max-Age=3600; HttpOnly; Secure; SameSite=Lax",
    );
    expect(cookie).toEqual({
      name: "__Secure-better-auth.session_token",
      value: "abc.def%3D",
      maxAgeSeconds: 3600,
    });
  });

  it("reads Expires when Max-Age is absent", () => {
    const cookie = parseSetCookie("a=b; Expires=Tue, 03 Nov 2026 05:00:00 GMT");
    expect(cookie?.expires?.toISOString()).toBe("2026-11-03T05:00:00.000Z");
  });

  it("keeps '=' characters that belong to the value", () => {
    expect(parseSetCookie("a=b=c; Path=/")?.value).toBe("b=c");
  });

  it("returns null for a malformed header", () => {
    expect(parseSetCookie("no-equals-sign")).toBeNull();
    expect(parseSetCookie("=novalue")).toBeNull();
  });
});

describe("cookieLifetimeMs", () => {
  const now = Date.parse("2026-11-03T04:00:00Z");

  it("prefers Max-Age over Expires", () => {
    const cookie = parseSetCookie("a=b; Max-Age=60; Expires=Tue, 03 Nov 2026 09:00:00 GMT");
    expect(cookie && cookieLifetimeMs(cookie, now)).toBe(60_000);
  });

  it("derives the lifetime from Expires", () => {
    const cookie = parseSetCookie("a=b; Expires=Tue, 03 Nov 2026 05:00:00 GMT");
    expect(cookie && cookieLifetimeMs(cookie, now)).toBe(3_600_000);
  });

  it("returns null when there is no expiry information", () => {
    const cookie = parseSetCookie("a=b; Path=/");
    expect(cookie && cookieLifetimeMs(cookie, now)).toBeNull();
  });
});
