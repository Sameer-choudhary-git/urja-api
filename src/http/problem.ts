import {
  PortalAuthError,
  PortalCircuitOpenError,
  PortalError,
  PortalNotFoundError,
  PortalProtocolError,
  PortalUnavailableError,
} from "../portal/errors.js";

/**
 * Errors leave the API as RFC 9457 "problem details" (`application/problem+json`):
 *
 *   { "type": "https://urja-api.local/problems/not-found", "title": "Not found",
 *     "status": 404, "detail": "Meter J999999 does not exist", "code": "not_found",
 *     "requestId": "..." }
 *
 * `code` is stable and meant for programs; `title`/`detail` are for people.
 */
export interface Problem {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly code: string;
  readonly detail?: string;
  readonly requestId?: string;
  readonly errors?: readonly { readonly path: string; readonly message: string }[];
}

const PROBLEM_BASE = "https://urja-api.local/problems/";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly title: string,
    detail?: string,
    readonly errors?: Problem["errors"],
    readonly headers: Readonly<Record<string, string>> = {},
  ) {
    super(detail ?? title);
    this.name = "ApiError";
  }

  static notFound(detail: string): ApiError {
    return new ApiError(404, "not_found", "Not found", detail);
  }

  static badRequest(detail: string, errors?: Problem["errors"]): ApiError {
    return new ApiError(400, "invalid_request", "Invalid request", detail, errors);
  }
}

/**
 * Maps every error to a problem. Portal failures are OUR upstream's
 * failures, so they become 502/503, never 401: a consumer with a valid key
 * should not be told *they* are unauthorised because our portal login broke.
 */
export function toProblem(error: unknown): { problem: Problem; headers: Record<string, string> } {
  if (error instanceof ApiError) {
    return {
      problem: problem(error.status, error.code, error.title, error.message, error.errors),
      headers: { ...error.headers },
    };
  }
  if (error instanceof PortalNotFoundError) {
    return { problem: problem(404, "not_found", "Not found", error.message), headers: {} };
  }
  if (error instanceof PortalCircuitOpenError) {
    return {
      problem: problem(503, "upstream_unavailable", "Portal unavailable", "The legacy portal is failing; calls are paused briefly to let it recover"),
      headers: { "retry-after": String(error.retryAfterSeconds) },
    };
  }
  if (error instanceof PortalUnavailableError) {
    return {
      problem: problem(503, "upstream_unavailable", "Portal unavailable", "The legacy portal is not responding; try again shortly"),
      headers: { "retry-after": "30" },
    };
  }
  if (error instanceof PortalAuthError) {
    return {
      problem: problem(502, "upstream_auth_failed", "Portal login failed", "This service could not log in to the legacy portal"),
      headers: {},
    };
  }
  if (error instanceof PortalProtocolError || error instanceof PortalError) {
    return {
      problem: problem(502, "upstream_protocol_error", "Unexpected portal response", "The legacy portal answered in an unexpected format"),
      headers: {},
    };
  }
  return {
    problem: problem(500, "internal_error", "Internal server error", "Something went wrong on our side"),
    headers: {},
  };
}

function problem(
  status: number,
  code: string,
  title: string,
  detail?: string,
  errors?: Problem["errors"],
): Problem {
  return {
    type: `${PROBLEM_BASE}${code.replaceAll("_", "-")}`,
    title,
    status,
    code,
    ...(detail !== undefined && { detail }),
    ...(errors !== undefined && errors.length > 0 && { errors }),
  };
}
