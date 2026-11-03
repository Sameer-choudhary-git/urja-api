/**
 * Tiny, pure helpers for the one cookie we care about. We deliberately do not
 * use a cookie-jar library: the portal sets a single session cookie and we
 * send it back verbatim.
 */
export interface ParsedSetCookie {
  readonly name: string;
  /** Raw value exactly as sent by the server (still percent-encoded). */
  readonly value: string;
  readonly maxAgeSeconds?: number;
  readonly expires?: Date;
}

export function parseSetCookie(header: string): ParsedSetCookie | null {
  const [pair, ...attributes] = header.split(";").map((part) => part.trim());
  if (pair === undefined) return null;

  const equals = pair.indexOf("=");
  if (equals <= 0) return null;

  let maxAgeSeconds: number | undefined;
  let expires: Date | undefined;

  for (const attribute of attributes) {
    const separator = attribute.indexOf("=");
    const key = (separator === -1 ? attribute : attribute.slice(0, separator)).toLowerCase();
    const value = separator === -1 ? "" : attribute.slice(separator + 1);

    if (key === "max-age") {
      const seconds = Number.parseInt(value, 10);
      if (Number.isFinite(seconds)) maxAgeSeconds = seconds;
    } else if (key === "expires") {
      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) expires = date;
    }
  }

  return {
    name: pair.slice(0, equals),
    value: pair.slice(equals + 1),
    ...(maxAgeSeconds !== undefined && { maxAgeSeconds }),
    ...(expires !== undefined && { expires }),
  };
}

/**
 * Remaining lifetime in milliseconds, or `null` when the cookie carries no
 * expiry information. `Max-Age` wins over `Expires` (RFC 6265, section 5.3).
 */
export function cookieLifetimeMs(cookie: ParsedSetCookie, nowMs: number): number | null {
  if (cookie.maxAgeSeconds !== undefined) return cookie.maxAgeSeconds * 1000;
  if (cookie.expires !== undefined) return cookie.expires.getTime() - nowMs;
  return null;
}
