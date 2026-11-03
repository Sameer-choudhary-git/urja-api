import { describe, expect, it } from "vitest";
import { buildSigningMessage, signRequest } from "../../src/portal/signing.js";

/**
 * Reference vectors were computed with Python's `hmac` module, i.e. by a
 * second, independent implementation:
 *
 *   hmac.new(secret.encode(), "\n".join([method, path, query, ts]).encode(),
 *            hashlib.sha256).hexdigest()
 *
 * The secret is made up. The timestamps are the two from the real captured
 * requests (PROTOCOL.md, section 3.6), about 50 seconds apart.
 */
const SECRET = "k3Y-example-secret-32-characters";

describe("export request signing", () => {
  it("matches the Python reference for the first captured timestamp", () => {
    const headers = signRequest({
      method: "GET",
      path: "/portal/export",
      query: "page=1",
      secret: SECRET,
      timestampSeconds: 1793681738,
    });

    expect(headers).toEqual({
      "x-timestamp": "1793681738",
      "x-signature": "8a665521ac5ebde822f1e147d1b20e239da3044dbebc959dddd43787f80633c6",
    });
  });

  it("changes completely when only the timestamp changes", () => {
    const headers = signRequest({
      method: "GET",
      path: "/portal/export",
      query: "page=1",
      secret: SECRET,
      timestampSeconds: 1793681789,
    });

    expect(headers["x-signature"]).toBe(
      "0cce8afb6fe06b07fc33e581642217c23d71946edf5af0e5013a8b4784f1f097",
    );
  });

  it("builds the four-line message the portal expects", () => {
    const message = buildSigningMessage(
      { method: "get", path: "/portal/export", query: "page=1" },
      "1793681738",
    );
    expect(message).toBe("GET\n/portal/export\npage=1\n1793681738");
  });

  it("uses whole seconds from the clock when no timestamp is given", () => {
    const before = Math.floor(Date.now() / 1000);
    const { "x-timestamp": timestamp, "x-signature": signature } = signRequest({
      method: "GET",
      path: "/portal/export",
      query: "page=1",
      secret: SECRET,
    });
    const after = Math.floor(Date.now() / 1000);

    expect(Number(timestamp)).toBeGreaterThanOrEqual(before);
    expect(Number(timestamp)).toBeLessThanOrEqual(after);
    expect(signature).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects a query that still has its leading "?"', () => {
    expect(() =>
      signRequest({ method: "GET", path: "/portal/export", query: "?page=1", secret: SECRET }),
    ).toThrow(/must not start with/);
  });

  it("rejects an empty secret instead of signing with it", () => {
    expect(() =>
      signRequest({ method: "GET", path: "/portal/export", query: "page=1", secret: "" }),
    ).toThrow(/empty/);
  });
});
