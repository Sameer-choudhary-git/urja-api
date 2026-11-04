import { noopLogger, type Logger } from "../logger.js";
import { CircuitBreaker, CircuitOpenError } from "../shared/circuitBreaker.js";
import { ConcurrencyLimiter, LimiterFullError } from "../shared/concurrencyLimiter.js";
import {
  PortalAuthError,
  PortalCircuitOpenError,
  PortalNotFoundError,
  PortalProtocolError,
  PortalRateLimitedError,
  PortalUnavailableError,
} from "./errors.js";
import type { SessionProvider } from "./session.js";

/**
 * Structural type satisfied by zod schemas (and anything else with `safeParse`),
 * so this module does not depend on a specific validation library.
 */
export interface ResponseSchema<T> {
  safeParse(data: unknown):
    | { success: true; data: T }
    | {
        success: false;
        error: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }> };
      };
}

export type QueryParams = Readonly<Record<string, string | number>>;

/**
 * Serialises query params exactly the way `PortalClient` puts them on the URL
 * (insertion order, URL-encoded, no leading "?"). Signing needs the identical
 * string, so both sides use this one function.
 */
export function toQueryString(query: QueryParams): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) params.set(key, String(value));
  return params.toString();
}

export interface RequestOptions {
  /**
   * Extra headers, computed again for EVERY attempt (first try, each retry,
   * and the retry after a re-login). Signed requests need this: a retried
   * request must carry a fresh timestamp, and possibly a fresh secret.
   */
  readonly headers?: () => Promise<Readonly<Record<string, string>>>;
}

export interface PortalClientOptions {
  readonly baseUrl: string;
  readonly sessions: SessionProvider;
  readonly timeoutMs: number;
  /** Retries for transient failures (network error, 429, 5xx). Does not include the one re-login. */
  readonly maxRetries: number;
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly logger?: Logger;
  /** Shared guards. Each logical request (with all its retries) is one breaker call and one limiter slot. */
  readonly breaker?: CircuitBreaker;
  readonly limiter?: ConcurrencyLimiter;
}

const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);
const BACKOFF_BASE_MS = 200;
const BACKOFF_MAX_MS = 2_000;
/**
 * 429 = the portal is rate limiting us (seen live on 2026-11-04 after about
 * 230 energy calls in 6 seconds). Waiting 200 ms does not help there, so a
 * 429 waits for the portal's Retry-After, or 1 s, 2 s, 4 s ... up to 15 s,
 * and gets a few more attempts than other errors.
 */
const RATE_LIMIT_BASE_MS = 1_000;
const RATE_LIMIT_MAX_MS = 15_000;
const RATE_LIMIT_EXTRA_RETRIES = 3;

/**
 * Authenticated, validated, resilient GET access to the portal's JSON endpoints.
 *
 * Responsibilities (and nothing more):
 *  - attach the session cookie,
 *  - on HTTP 401: drop the session and retry ONCE with a fresh login,
 *  - retry transient failures with capped exponential backoff + jitter,
 *  - enforce a timeout,
 *  - turn every failure into a typed PortalError,
 *  - validate the payload against a schema, so malformed portal data never
 *    leaks into the rest of the system.
 *
 * Only idempotent GETs go through here, which is what makes retrying safe.
 */
export class PortalClient {
  private readonly baseUrl: string;
  private readonly sessions: SessionProvider;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchFn: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly logger: Logger;
  private readonly breaker: CircuitBreaker | undefined;
  private readonly limiter: ConcurrencyLimiter | undefined;

  constructor(options: PortalClientOptions) {
    this.breaker = options.breaker;
    this.limiter = options.limiter;
    this.baseUrl = options.baseUrl;
    this.sessions = options.sessions;
    this.timeoutMs = options.timeoutMs;
    this.maxRetries = options.maxRetries;
    this.fetchFn = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
    this.logger = options.logger ?? noopLogger;
  }

  async get<T>(
    path: string,
    schema: ResponseSchema<T>,
    query: QueryParams = {},
    options: RequestOptions = {},
  ): Promise<T> {
    const attempt = () => this.getWithRetries(path, schema, query, options);
    const guarded = this.breaker === undefined ? attempt : () => this.breaker!.run(attempt);
    try {
      return await (this.limiter === undefined ? guarded() : this.limiter.run(guarded));
    } catch (error) {
      if (error instanceof CircuitOpenError) {
        throw new PortalCircuitOpenError(error.message, Math.ceil(error.retryAfterMs / 1000));
      }
      if (error instanceof LimiterFullError) {
        throw new PortalCircuitOpenError(error.message, 5);
      }
      throw error;
    }
  }

  private async getWithRetries<T>(
    path: string,
    schema: ResponseSchema<T>,
    query: QueryParams,
    options: RequestOptions,
  ): Promise<T> {
    const url = this.buildUrl(path, query);
    let retries = 0;
    let reauthenticated = false;

    for (;;) {
      const cookie = await this.sessions.getCookie();
      const extraHeaders = options.headers === undefined ? {} : await options.headers();

      let response: Response;
      try {
        response = await this.fetchFn(url, {
          headers: { ...extraHeaders, accept: "application/json", cookie },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (cause) {
        if (retries < this.maxRetries) {
          retries += 1;
          await this.backoff(retries, path, `network error: ${describe(cause)}`);
          continue;
        }
        throw new PortalUnavailableError(`Portal request failed: ${describe(cause)}`, { cause });
      }

      if (response.status === 401) {
        await discard(response);
        this.sessions.invalidate(cookie);
        if (reauthenticated) {
          throw new PortalAuthError("Portal rejected a freshly issued session", {
            upstreamStatus: 401,
          });
        }
        reauthenticated = true;
        this.logger.info("portal.session.rejected", { path });
        continue;
      }

      if (response.status === 404) {
        const message = (await readErrorMessage(response)) ?? "Not found";
        throw new PortalNotFoundError(message, { upstreamStatus: 404 });
      }

      if (response.status === 429) {
        const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"), Date.now());
        await discard(response);
        if (retries < this.maxRetries + RATE_LIMIT_EXTRA_RETRIES) {
          retries += 1;
          const ceiling = Math.min(RATE_LIMIT_BASE_MS * 2 ** (retries - 1), RATE_LIMIT_MAX_MS);
          const delayMs = Math.min(retryAfterMs ?? Math.round(ceiling * (0.5 + this.random() * 0.5)), RATE_LIMIT_MAX_MS);
          this.logger.warn("portal.rate_limited", { path, retry: retries, delayMs });
          await this.sleep(delayMs);
          continue;
        }
        throw new PortalRateLimitedError("Portal kept answering HTTP 429 (rate limited)", Math.ceil((retryAfterMs ?? RATE_LIMIT_MAX_MS) / 1000));
      }

      if (RETRYABLE_STATUSES.has(response.status)) {
        await discard(response);
        if (retries < this.maxRetries) {
          retries += 1;
          await this.backoff(retries, path, `HTTP ${response.status}`);
          continue;
        }
        throw new PortalUnavailableError(`Portal kept answering HTTP ${response.status}`, {
          upstreamStatus: response.status,
        });
      }

      if (!response.ok) {
        await discard(response);
        throw new PortalProtocolError(`Unexpected HTTP ${response.status} from ${path}`, {
          upstreamStatus: response.status,
        });
      }

      return this.parse(path, response, schema);
    }
  }

  private buildUrl(path: string, query: QueryParams): string {
    if (!path.startsWith("/")) {
      throw new Error(`Portal path must start with "/": ${path}`);
    }
    const url = new URL(path, this.baseUrl);
    url.search = toQueryString(query);
    return url.toString();
  }

  private async parse<T>(path: string, response: Response, schema: ResponseSchema<T>): Promise<T> {
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (cause) {
      throw new PortalProtocolError(`Response from ${path} was not valid JSON`, {
        cause,
        upstreamStatus: response.status,
      });
    }

    const result = schema.safeParse(payload);
    if (!result.success) {
      const summary = result.error.issues
        .slice(0, 3)
        .map((issue) => `${issue.path.map(String).join(".") || "(root)"}: ${issue.message}`)
        .join("; ");
      throw new PortalProtocolError(`Response from ${path} had an unexpected shape: ${summary}`, {
        upstreamStatus: response.status,
      });
    }
    return result.data;
  }

  private async backoff(retry: number, path: string, reason: string): Promise<void> {
    const ceiling = Math.min(BACKOFF_BASE_MS * 2 ** (retry - 1), BACKOFF_MAX_MS);
    const delayMs = Math.round(ceiling * (0.5 + this.random() * 0.5));
    this.logger.warn("portal.retry", { path, retry, delayMs, reason });
    await this.sleep(delayMs);
  }
}

/** Retry-After as seconds or an HTTP date -> milliseconds to wait; null if absent or unreadable. */
export function parseRetryAfter(value: string | null, now: number): number | null {
  if (value === null || value.trim() === "") return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
}

function describe(cause: unknown): string {
  return cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause);
}

/** Read and throw away a body so the underlying socket can be reused. */
async function discard(response: Response): Promise<void> {
  try {
    await response.arrayBuffer();
  } catch {
    // Nothing useful to do if draining fails.
  }
}

/** The portal's error bodies look like `{"error":"not_found","message":"..."}`. */
async function readErrorMessage(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = await response.json();
    if (typeof body === "object" && body !== null && "message" in body) {
      const { message } = body as { message: unknown };
      return typeof message === "string" ? message : undefined;
    }
  } catch {
    // Not JSON; fall through to the default message.
  }
  return undefined;
}
