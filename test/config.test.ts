import { describe, expect, it } from "vitest";
import { ConfigError, loadAppConfig, parseApiKeys } from "../src/config.js";

const base = { PORTAL_EMAIL: "operator@urja.local", PORTAL_PASSWORD: "secret" };
const KEY = "a".repeat(24);

describe("loadAppConfig", () => {
  it("fails closed: refuses to start with no API keys", () => {
    expect(() => loadAppConfig(base)).toThrow(/API_KEYS is empty/);
  });

  it("starts with keys, and with auth explicitly disabled", () => {
    const withKeys = loadAppConfig({ ...base, API_KEYS: `web:${KEY}` });
    expect(withKeys.auth).toEqual({ mode: "keys", keys: [{ name: "web", key: KEY }] });
    expect(withKeys.catalog).toEqual({ ttlMs: 900_000, maxStaleMs: 86_400_000, fallback: true });

    expect(loadAppConfig({ ...base, AUTH_MODE: "disabled" }).auth).toEqual({ mode: "disabled" });
  });

  it("rejects a max staleness shorter than the TTL", () => {
    expect(() =>
      loadAppConfig({ ...base, AUTH_MODE: "disabled", CATALOG_TTL_MS: "1000", CATALOG_MAX_STALE_MS: "500" }),
    ).toThrow(/CATALOG_MAX_STALE_MS/);
  });

  it("never echoes the password in its error message", () => {
    try {
      loadAppConfig({ PORTAL_EMAIL: "", PORTAL_PASSWORD: "hunter2-super-secret" });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).not.toContain("hunter2");
    }
  });
});

describe("parseApiKeys", () => {
  it("parses name:key pairs", () => {
    expect(parseApiKeys(` web:${KEY} , data-team:${"b".repeat(30)} `)).toEqual([
      { name: "web", key: KEY },
      { name: "data-team", key: "b".repeat(30) },
    ]);
  });

  it("rejects short keys and duplicate names without printing the key", () => {
    expect(() => parseApiKeys("web:short")).toThrow(/at least 24 characters/);
    expect(() => parseApiKeys(`web:${KEY},web:${KEY}`)).toThrow(/twice/);
    try {
      parseApiKeys("web:tooshort-but-secret");
    } catch (error) {
      expect((error as Error).message).not.toContain("tooshort-but-secret");
    }
  });
});
