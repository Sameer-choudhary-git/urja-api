import { createHmac } from "node:crypto";

/**
 * Request signing for the portal's bulk export (PROTOCOL.md, section 3.6).
 *
 * The portal's own Transformers page does exactly this in the browser:
 *
 *   message   = METHOD + "\n" + PATH + "\n" + QUERY + "\n" + TIMESTAMP
 *   signature = lowercase hex( HMAC-SHA256(key = signingSecret, data = message) )
 *
 * Details that matter (each one breaks the signature if done differently):
 *  - QUERY is written WITHOUT the leading "?" (e.g. "page=1").
 *  - TIMESTAMP is Unix time in whole SECONDS, as a decimal string.
 *  - The secret is used as plain UTF-8 text, not hex- or base64-decoded.
 *
 * This module is pure: no I/O, no clock unless you omit `timestampSeconds`.
 */
export interface SignInput {
  readonly method: string;
  readonly path: string;
  /** Query string without "?", e.g. "page=1". Empty string when there is none. */
  readonly query: string;
  readonly secret: string;
  /** Defaults to the current time. Tests pass a fixed value. */
  readonly timestampSeconds?: number;
}

// A type alias (not an interface) so it is assignable to Record<string, string>.
export type SignedHeaders = {
  readonly "x-timestamp": string;
  readonly "x-signature": string;
};

export function buildSigningMessage(input: Omit<SignInput, "secret">, timestamp: string): string {
  if (input.query.startsWith("?")) {
    throw new Error('Signing query must not start with "?"');
  }
  return [input.method.toUpperCase(), input.path, input.query, timestamp].join("\n");
}

export function signRequest(input: SignInput): SignedHeaders {
  if (input.secret.length === 0) {
    throw new Error("Signing secret is empty");
  }
  const seconds = input.timestampSeconds ?? Math.floor(Date.now() / 1000);
  const timestamp = String(seconds);
  const message = buildSigningMessage(input, timestamp);
  const signature = createHmac("sha256", input.secret).update(message, "utf8").digest("hex");
  return { "x-timestamp": timestamp, "x-signature": signature };
}
