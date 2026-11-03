/**
 * Time in this service.
 *
 * The portal writes `DD/MM/YYYY HH:mm` with no timezone. We read it as IST
 * (UTC+05:30): the utility is in Jaipur, and the readings sit exactly on
 * :00/:30 in that reading (PROTOCOL.md 3.3, inferred). IST has no daylight
 * saving, so a fixed offset is exact, and no timezone library is needed.
 *
 * Inside the service a moment is a plain number (epoch milliseconds). At the
 * API edge it becomes ISO 8601 with an explicit offset, e.g.
 * `2026-06-29T00:30:00+05:30`, so no client has to guess.
 */

export const IST_OFFSET_MINUTES = 330;
export const IST_OFFSET = "+05:30";
const OFFSET_MS = IST_OFFSET_MINUTES * 60_000;

export const MINUTE_MS = 60_000;
export const HALF_HOUR_MS = 30 * MINUTE_MS;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** "23/06/2026 23:30" -> epoch ms. Returns null for anything that is not a real IST date-time. */
export function parsePortalTimestamp(value: string): number | null {
  const match = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/.exec(value);
  if (match === null) return null;
  const [, dd, mm, yyyy, hh, mi] = match.map(Number) as [number, number, number, number, number, number];
  // Date.UTC rolls 31/02 over to March; reject instead of silently moving the reading.
  if (!isRealDate(yyyy, mm, dd) || hh > 23 || mi > 59) return null;
  return Date.UTC(yyyy, mm - 1, dd, hh, mi) - OFFSET_MS;
}

function isRealDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** epoch ms -> "2026-06-29T00:30:00+05:30". */
export function toIstIso(epochMs: number): string {
  return new Date(epochMs + OFFSET_MS).toISOString().replace(/\.\d{3}Z$/, IST_OFFSET);
}

/** epoch ms -> the IST calendar day it falls on, "2026-06-29". */
export function istDay(epochMs: number): string {
  return new Date(epochMs + OFFSET_MS).toISOString().slice(0, 10);
}

/** Start of the IST day / hour containing `epochMs`. */
export function startOfIstDay(epochMs: number): number {
  return Math.floor((epochMs + OFFSET_MS) / DAY_MS) * DAY_MS - OFFSET_MS;
}
export function startOfHour(epochMs: number): number {
  // IST is a whole number of half hours from UTC, not of hours, so shift first.
  return Math.floor((epochMs + OFFSET_MS) / HOUR_MS) * HOUR_MS - OFFSET_MS;
}

/** Round up to the next :00 or :30 (unchanged if already on one). Same in UTC and IST. */
export function ceilToHalfHour(epochMs: number): number {
  return Math.ceil(epochMs / HALF_HOUR_MS) * HALF_HOUR_MS;
}

/**
 * Parses a time given by an API consumer:
 *  - `2026-06-29`                  -> 00:00 IST that day
 *  - `2026-06-29T12:00`            -> IST is assumed when no offset is given
 *  - `2026-06-29T12:00:00+05:30`, `...Z` -> as written
 * A "+" in a query string arrives as a space ("12:00:00 05:30"); that is
 * repaired here so a forgotten %2B does not turn into a confusing error.
 * Returns null when the value is not a valid date or date-time.
 */
export function parseUserTime(raw: string): { epochMs: number; dateOnly: boolean } | null {
  const value = raw.trim().replace(/ (\d{2}:\d{2})$/, "+$1");
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (dateOnly !== null) {
    const epochMs = parsePortalTimestamp(`${dateOnly[3]}/${dateOnly[2]}/${dateOnly[1]} 00:00`);
    return epochMs === null ? null : { epochMs, dateOnly: true };
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:\d{2})?$/.exec(value);
  if (match === null) return null;
  const [, y, mo, d, h, mi, sec = "00", zone] = match as unknown as [string, string, string, string, string, string, string?, string?];
  // V8's Date.parse rolls 2026-02-31 over to 3 March; check the calendar date first.
  if (!isRealDate(Number(y), Number(mo), Number(d)) || Number(h) > 23 || Number(mi) > 59 || Number(sec) > 59) {
    return null;
  }
  const epochMs = Date.parse(`${y}-${mo}-${d}T${h}:${mi}:${sec}${zone ?? IST_OFFSET}`);
  return Number.isNaN(epochMs) ? null : { epochMs, dateOnly: false };
}
