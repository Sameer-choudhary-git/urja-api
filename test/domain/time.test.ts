import { describe, expect, it } from "vitest";
import {
  ceilToHalfHour,
  istDay,
  parsePortalTimestamp,
  parseUserTime,
  startOfHour,
  startOfIstDay,
  toIstIso,
} from "../../src/domain/time.js";

describe("IST time helpers", () => {
  it("reads the portal's DD/MM/YYYY HH:mm as IST", () => {
    const at = parsePortalTimestamp("23/06/2026 23:30");
    expect(at).toBe(Date.parse("2026-06-23T18:00:00Z"));
    expect(toIstIso(at as number)).toBe("2026-06-23T23:30:00+05:30");
  });

  it("rejects impossible dates instead of rolling them over", () => {
    expect(parsePortalTimestamp("31/02/2026 10:00")).toBeNull();
    expect(parsePortalTimestamp("01/13/2026 10:00")).toBeNull();
    expect(parsePortalTimestamp("01/06/2026 24:00")).toBeNull();
    expect(parsePortalTimestamp("2026-06-01 10:00")).toBeNull();
  });

  it("uses the IST calendar day, not the UTC one", () => {
    // 00:15 IST on 1 June is still 31 May in UTC.
    const at = Date.parse("2026-05-31T18:45:00Z");
    expect(istDay(at)).toBe("2026-06-01");
    expect(toIstIso(startOfIstDay(at))).toBe("2026-06-01T00:00:00+05:30");
  });

  it("aligns hours to IST, which is half an hour off UTC hours", () => {
    const at = Date.parse("2026-06-01T10:45:00+05:30");
    expect(toIstIso(startOfHour(at))).toBe("2026-06-01T10:00:00+05:30");
    expect(toIstIso(ceilToHalfHour(Date.parse("2026-06-01T10:10:00+05:30")))).toBe("2026-06-01T10:30:00+05:30");
  });

  describe("parseUserTime", () => {
    it("accepts a date (IST midnight), a date-time with or without offset, and Z", () => {
      expect(parseUserTime("2026-06-29")).toEqual({ epochMs: Date.parse("2026-06-29T00:00:00+05:30"), dateOnly: true });
      expect(parseUserTime("2026-06-29T12:00")?.epochMs).toBe(Date.parse("2026-06-29T12:00:00+05:30"));
      expect(parseUserTime("2026-06-29T12:00:00+05:30")?.epochMs).toBe(Date.parse("2026-06-29T06:30:00Z"));
      expect(parseUserTime("2026-06-29T06:30:00Z")?.epochMs).toBe(Date.parse("2026-06-29T06:30:00Z"));
    });

    it("repairs a '+' that a query string turned into a space", () => {
      expect(parseUserTime("2026-06-29T12:00:00 05:30")?.epochMs).toBe(Date.parse("2026-06-29T12:00:00+05:30"));
    });

    it("rejects junk and impossible dates", () => {
      for (const bad of ["29/06/2026", "not-a-date", "2026-02-31", "2026-02-31T10:00:00Z", "2026-06-29T25:00"]) {
        expect(parseUserTime(bad), bad).toBeNull();
      }
    });
  });
});
