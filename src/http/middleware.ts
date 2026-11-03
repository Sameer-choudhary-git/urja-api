import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { ErrorRequestHandler, RequestHandler } from "express";
import { ipKeyGenerator, rateLimit } from "express-rate-limit";
import type { ApiKeyConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { ApiError, toProblem } from "./problem.js";

declare module "express-serve-static-core" {
  interface Locals {
    requestId?: string;
    /** Name of the API consumer that authenticated (never the key itself). */
    consumer?: string;
  }
}

/** Reuses a sane incoming X-Request-Id (e.g. from nginx) or makes one; echoes it back. */
export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.get("x-request-id");
  const id = incoming !== undefined && /^[\w.-]{8,128}$/.test(incoming) ? incoming : randomUUID();
  res.locals.requestId = id;
  res.set("x-request-id", id);
  next();
};

/** One access-log line per request, written when the response is finished. */
export function accessLog(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const started = process.hrtime.bigint();
    res.on("finish", () => {
      logger.info("http.request", {
        requestId: res.locals.requestId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
        durationMs: Number((process.hrtime.bigint() - started) / 1_000_000n),
        consumer: res.locals.consumer,
      });
    });
    next();
  };
}

/**
 * API-key authentication for consumers of OUR API (never the portal's
 * credentials). Accepts `Authorization: Bearer <key>` or `X-API-Key: <key>`.
 *
 *  - Only SHA-256 hashes of the keys are kept in memory.
 *  - Comparison is constant-time over equal-length hashes, so response timing
 *    does not reveal how much of a guessed key was right.
 *  - On success the consumer's NAME is attached for logs and rate limits;
 *    the key itself is never logged.
 */
export function apiKeyAuth(keys: readonly ApiKeyConfig[] | null): RequestHandler {
  if (keys === null) {
    return (_req, res, next) => {
      res.locals.consumer = "anonymous";
      next();
    };
  }
  const hashed = keys.map(({ name, key }) => ({ name, hash: sha256(key) }));

  return (req, res, next) => {
    const presented = readKey(req.get("authorization"), req.get("x-api-key"));
    if (presented === null) {
      next(unauthorized("Send an API key as 'Authorization: Bearer <key>' or 'X-API-Key: <key>'"));
      return;
    }
    const candidate = sha256(presented);
    // Check every key (no early exit), so timing does not depend on which one matched.
    let match: string | null = null;
    for (const { name, hash } of hashed) {
      if (timingSafeEqual(candidate, hash)) match = name;
    }
    if (match === null) {
      next(unauthorized("The API key is not valid"));
      return;
    }
    res.locals.consumer = match;
    next();
  };
}

function readKey(authorization: string | undefined, apiKeyHeader: string | undefined): string | null {
  const bearer = /^Bearer\s+(\S+)$/i.exec(authorization ?? "")?.[1];
  const key = bearer ?? apiKeyHeader?.trim();
  return key === undefined || key === "" ? null : key;
}

function unauthorized(detail: string): ApiError {
  return new ApiError(401, "unauthorized", "Unauthorized", detail, undefined, {
    "www-authenticate": 'Bearer realm="urja-api"',
  });
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Per-consumer (or per-IP for public routes) rate limit, in a fixed one-minute
 * window. In-memory: correct for one instance. With several instances behind
 * a load balancer this would move to a shared store (Redis); see README.
 */
export function perConsumerRateLimit(perMinute: number): RequestHandler {
  return rateLimit({
    windowMs: 60_000,
    limit: perMinute,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    // ipKeyGenerator groups IPv6 addresses by subnet, so one client cannot
    // dodge the limit by rotating through its /64.
    keyGenerator: (req, res) =>
      res.locals.consumer !== undefined
        ? `consumer:${res.locals.consumer}`
        : `ip:${ipKeyGenerator(req.ip ?? "0.0.0.0")}`,
    handler: (_req, _res, next) => {
      next(new ApiError(429, "rate_limited", "Too many requests", `Limit is ${perMinute} requests per minute`));
    },
  });
}

/**
 * CORS for browser clients on another origin (a web app on Vercel/Lovable, a
 * local Vite dev server). Only origins listed in CORS_ORIGINS get the headers;
 * "*" allows any origin. Preflight (OPTIONS) is answered here, before auth,
 * because browsers never send credentials on a preflight.
 */
export function cors(allowedOrigins: readonly string[]): RequestHandler {
  const any = allowedOrigins.includes("*");
  const allowed = new Set(allowedOrigins);
  return (req, res, next) => {
    const origin = req.get("origin");
    if (origin === undefined || allowedOrigins.length === 0 || (!any && !allowed.has(origin))) {
      next();
      return;
    }
    res.set({
      "access-control-allow-origin": any ? "*" : origin,
      "access-control-expose-headers":
        "x-request-id, x-data-age, x-data-stale, x-data-source, x-cache, etag, retry-after, ratelimit, ratelimit-policy",
      vary: "Origin",
    });
    if (req.method === "OPTIONS") {
      res.set({
        "access-control-allow-methods": "GET, OPTIONS",
        "access-control-allow-headers": "authorization, x-api-key, content-type, if-none-match",
        "access-control-max-age": "600",
      });
      res.status(204).end();
      return;
    }
    next();
  };
}

/** Unknown routes get a problem, not Express's HTML page. */
export const notFound: RequestHandler = (req, _res, next) => {
  next(ApiError.notFound(`No route for ${req.method} ${req.path}`));
};

/** Last middleware: every error becomes an application/problem+json response. */
export function errorHandler(logger: Logger): ErrorRequestHandler {
  return (error: unknown, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }
    // Malformed JSON bodies and similar errors from Express itself carry a status.
    const expressStatus = (error as { status?: unknown; type?: unknown }).status;
    const normalized =
      typeof expressStatus === "number" && expressStatus >= 400 && expressStatus < 500 && !(error instanceof ApiError)
        ? new ApiError(expressStatus, "invalid_request", "Invalid request", (error as Error).message)
        : error;

    const { problem, headers } = toProblem(normalized);
    const level = problem.status >= 500 ? "error" : "debug";
    logger[level]("http.error", {
      requestId: res.locals.requestId,
      path: req.path,
      status: problem.status,
      code: problem.code,
      error: normalized instanceof Error ? `${normalized.name}: ${normalized.message}` : String(normalized),
    });

    res
      .status(problem.status)
      .set(headers)
      .type("application/problem+json")
      .send(JSON.stringify({ ...problem, requestId: res.locals.requestId }));
  };
}
