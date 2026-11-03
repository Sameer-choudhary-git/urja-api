import { noopLogger, type Logger } from "../logger.js";
import { cookieLifetimeMs, parseSetCookie } from "./cookies.js";
import { PortalAuthError, PortalUnavailableError } from "./errors.js";
import type { Authenticator, Session } from "./session.js";

/** Cookie set by the portal's Better Auth login (see PROTOCOL.md, section 2). */
export const SESSION_COOKIE_NAME = "__Secure-better-auth.session_token";

/** Used only if the portal ever omits Max-Age/Expires. Observed lifetime is ~1 hour. */
const FALLBACK_SESSION_TTL_MS = 50 * 60 * 1000;

export interface PortalAuthenticatorOptions {
  readonly baseUrl: string;
  readonly email: string;
  readonly password: string;
  readonly timeoutMs: number;
  readonly fetch?: typeof fetch;
  readonly now?: () => number;
  readonly logger?: Logger;
}

/**
 * Performs the portal's form login: `POST /login` (urlencoded) with the
 * `x-sveltekit-action` header, then reads the session cookie from `Set-Cookie`.
 *
 * Notes on the protocol:
 *  - The cookie is HttpOnly, so it can only be taken from the response headers.
 *  - SvelteKit rejects cross-site form POSTs by comparing the `Origin` header.
 *    Browsers send it automatically; a server-side client must set it itself.
 *  - On success the portal answers `{"type":"redirect","status":303,...}`. The
 *    failure body shape has not been observed, so success is decided by the
 *    presence of the session cookie, not by the body.
 */
export class PortalAuthenticator implements Authenticator {
  private readonly origin: string;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly logger: Logger;

  constructor(private readonly options: PortalAuthenticatorOptions) {
    this.origin = new URL(options.baseUrl).origin;
    this.fetchFn = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? noopLogger;
  }

  async login(): Promise<Session> {
    const body = new URLSearchParams({
      email: this.options.email,
      password: this.options.password,
    });

    let response: Response;
    try {
      response = await this.fetchFn(`${this.origin}/login`, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(this.options.timeoutMs),
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
          "x-sveltekit-action": "true",
          origin: this.origin,
          referer: `${this.origin}/login`,
        },
        body: body.toString(),
      });
    } catch (cause) {
      throw new PortalUnavailableError("Could not reach the portal login endpoint", { cause });
    }

    const actionType = await readActionType(response);

    if (response.status >= 500) {
      throw new PortalUnavailableError(`Portal login failed with HTTP ${response.status}`, {
        upstreamStatus: response.status,
      });
    }

    const session = this.extractSession(response.headers.getSetCookie());
    if (session === null) {
      throw new PortalAuthError(
        "Portal did not issue a session cookie; check PORTAL_EMAIL and PORTAL_PASSWORD",
        { upstreamStatus: response.status },
      );
    }

    this.logger.debug("portal.login.ok", { status: response.status, actionType });
    return session;
  }

  private extractSession(setCookieHeaders: readonly string[]): Session | null {
    for (const header of setCookieHeaders) {
      const cookie = parseSetCookie(header);
      if (cookie?.name !== SESSION_COOKIE_NAME) continue;

      const nowMs = this.now();
      const lifetimeMs = cookieLifetimeMs(cookie, nowMs) ?? FALLBACK_SESSION_TTL_MS;
      // Max-Age=0 or a past Expires is how a server *clears* a cookie.
      if (lifetimeMs <= 0) return null;

      return {
        cookie: `${cookie.name}=${cookie.value}`,
        expiresAt: nowMs + lifetimeMs,
      };
    }
    return null;
  }
}

/** Best-effort read of SvelteKit's action result type; also drains the body. */
async function readActionType(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null && "type" in body) {
      const { type } = body as { type: unknown };
      return typeof type === "string" ? type : undefined;
    }
  } catch {
    // Body was empty or not JSON: irrelevant, the cookie decides success.
  }
  return undefined;
}
