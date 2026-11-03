import { noopLogger, type Logger } from "../logger.js";

export interface Session {
  /** Ready-to-send value for the HTTP `Cookie` header, e.g. `name=value`. */
  readonly cookie: string;
  /** Epoch milliseconds after which the portal stops accepting the cookie. */
  readonly expiresAt: number;
}

/** Knows *how* to log in to the portal. Kept separate so lifecycle logic stays protocol-free. */
export interface Authenticator {
  login(): Promise<Session>;
}

/** What the HTTP client needs from a session store. */
export interface SessionProvider {
  /** A cookie that is believed valid, logging in first if necessary. */
  getCookie(): Promise<string>;
  /** Report that the portal rejected this cookie (HTTP 401). */
  invalidate(rejectedCookie: string): void;
}

export interface SessionManagerOptions {
  readonly authenticator: Authenticator;
  readonly now?: () => number;
  /** Renew this long before the expiry we were told about, to avoid racing it. */
  readonly refreshMarginMs?: number;
  readonly logger?: Logger;
}

/**
 * Owns the single portal session for this process:
 *  - logs in lazily on first use,
 *  - renews shortly before expiry,
 *  - lets many concurrent callers share ONE login (single-flight), so a burst
 *    of requests after expiry does not hammer the portal's login endpoint.
 *
 * The session lives in memory only; it is never written to disk or logged.
 */
export class SessionManager implements SessionProvider {
  private readonly authenticator: Authenticator;
  private readonly now: () => number;
  private readonly refreshMarginMs: number;
  private readonly logger: Logger;

  private session: Session | null = null;
  private inflightLogin: Promise<Session> | null = null;

  constructor(options: SessionManagerOptions) {
    this.authenticator = options.authenticator;
    this.now = options.now ?? Date.now;
    this.refreshMarginMs = options.refreshMarginMs ?? 60_000;
    this.logger = options.logger ?? noopLogger;
  }

  async getCookie(): Promise<string> {
    const session = await this.ensureSession();
    return session.cookie;
  }

  invalidate(rejectedCookie: string): void {
    // Only drop the session if it is still the one that was rejected. If
    // another caller already replaced it, the fresh session must survive.
    if (this.session?.cookie === rejectedCookie) {
      this.session = null;
    }
  }

  private ensureSession(): Promise<Session> {
    const current = this.session;
    if (current !== null && this.now() < current.expiresAt - this.refreshMarginMs) {
      return Promise.resolve(current);
    }

    this.inflightLogin ??= this.authenticator
      .login()
      .then((session) => {
        this.session = session;
        this.logger.info("portal.session.established", {
          validForSeconds: Math.round((session.expiresAt - this.now()) / 1000),
        });
        return session;
      })
      .finally(() => {
        // Clear on success AND failure so a failed login is retried next time
        // instead of being cached forever.
        this.inflightLogin = null;
      });

    return this.inflightLogin;
  }
}
