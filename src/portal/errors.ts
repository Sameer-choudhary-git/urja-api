/**
 * Everything that can go wrong while talking to the legacy portal, expressed
 * in our own vocabulary. Callers (services, the HTTP layer) branch on these
 * types and never need to know about fetch, cookies or status codes.
 */
export type PortalErrorCode =
  | "PORTAL_AUTH_FAILED"
  | "PORTAL_UNAVAILABLE"
  | "PORTAL_PROTOCOL_ERROR"
  | "PORTAL_NOT_FOUND";

export interface PortalErrorOptions {
  readonly cause?: unknown;
  /** HTTP status returned by the portal, when there was one. */
  readonly upstreamStatus?: number;
}

export abstract class PortalError extends Error {
  abstract readonly code: PortalErrorCode;
  readonly upstreamStatus: number | undefined;

  protected constructor(message: string, options: PortalErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.upstreamStatus = options.upstreamStatus;
  }
}

/** We could not obtain, or the portal refused, a valid session. */
export class PortalAuthError extends PortalError {
  readonly code = "PORTAL_AUTH_FAILED" as const;
  constructor(message: string, options?: PortalErrorOptions) {
    super(message, options);
  }
}

/** Network failure, timeout, or a 5xx/429 that survived all retries. */
export class PortalUnavailableError extends PortalError {
  readonly code = "PORTAL_UNAVAILABLE" as const;
  constructor(message: string, options?: PortalErrorOptions) {
    super(message, options);
  }
}

/**
 * We did not even try: the circuit breaker is open (the portal failed
 * repeatedly) or too many portal calls are already queued.
 */
export class PortalCircuitOpenError extends PortalUnavailableError {
  constructor(
    message: string,
    readonly retryAfterSeconds: number,
  ) {
    super(message);
  }
}

/** The portal answered, but not in the shape we documented in PROTOCOL.md. */
export class PortalProtocolError extends PortalError {
  readonly code = "PORTAL_PROTOCOL_ERROR" as const;
  constructor(message: string, options?: PortalErrorOptions) {
    super(message, options);
  }
}

/** The requested resource (e.g. a meter ID) does not exist in the portal. */
export class PortalNotFoundError extends PortalError {
  readonly code = "PORTAL_NOT_FOUND" as const;
  constructor(message: string, options?: PortalErrorOptions) {
    super(message, options);
  }
}
