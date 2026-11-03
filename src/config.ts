import { z } from "zod";

/**
 * Environment-driven configuration, validated once at startup so that a bad
 * setting fails fast with a readable message instead of surfacing later as a
 * confusing runtime error.
 */
const portalEnvSchema = z.object({
  PORTAL_BASE_URL: z.string().url().default("https://urja-ops.flockenergy.tech"),
  PORTAL_EMAIL: z.string().min(1),
  PORTAL_PASSWORD: z.string().min(1),
  PORTAL_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  PORTAL_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  /** At most this many portal requests at once; more wait in a queue of PORTAL_MAX_QUEUE. */
  PORTAL_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(4),
  PORTAL_MAX_QUEUE: z.coerce.number().int().min(0).default(200),
  /** Consecutive failed portal calls that open the circuit breaker, and how long it stays open. */
  PORTAL_BREAKER_THRESHOLD: z.coerce.number().int().min(1).default(5),
  PORTAL_BREAKER_OPEN_MS: z.coerce.number().int().positive().default(30_000),
});

const MINUTE = 60_000;

const appEnvSchema = portalEnvSchema.extend({
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  HOST: z.string().default("0.0.0.0"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  /**
   * Consumer API keys as `name:key` pairs, comma-separated, e.g.
   * `web:3f9c...,data-team:a71b...`. Keys must be at least 24 characters.
   */
  API_KEYS: z.string().default(""),
  /** `keys` (default) requires a valid key on /v1. `disabled` turns auth off: local development only. */
  AUTH_MODE: z.enum(["keys", "disabled"]).default("keys"),
  CATALOG_TTL_MS: z.coerce.number().int().positive().default(15 * MINUTE),
  /** Rebuild the catalog from search + detail pages when the signed export breaks (about 830 portal calls). */
  CATALOG_FALLBACK: z.enum(["true", "false"]).default("true").transform((v) => v === "true"),
  CATALOG_MAX_STALE_MS: z.coerce.number().int().positive().default(24 * 60 * MINUTE),
  /** Readings cache: how many (meter, days) answers to keep, and how long past expiry to serve one if the portal fails. */
  READINGS_CACHE_ENTRIES: z.coerce.number().int().positive().default(500),
  READINGS_MAX_STALE_MS: z.coerce.number().int().min(0).default(6 * 60 * MINUTE),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(300),
  /** Comma-separated browser origins allowed to call the API (CORS), e.g. http://localhost:5173. "*" = any. */
  CORS_ORIGINS: z.string().default(""),
  /** Express `trust proxy`: number of proxies in front (1 behind nginx), so client IPs are right. */
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
});

export interface PortalConfig {
  /** Origin of the legacy portal, without a trailing slash. */
  readonly baseUrl: string;
  readonly email: string;
  readonly password: string;
  /** Per-request timeout, including reading the response body. */
  readonly timeoutMs: number;
  /** How many times an idempotent GET is retried after a transient failure. */
  readonly maxRetries: number;
  /** Optional so tests can build a config by hand; defaults in createPortal. */
  readonly maxConcurrency?: number;
  readonly maxQueue?: number;
  readonly breakerThreshold?: number;
  readonly breakerOpenMs?: number;
}

export interface ApiKeyConfig {
  readonly name: string;
  readonly key: string;
}

export interface AppConfig {
  readonly portal: PortalConfig;
  readonly http: {
    readonly port: number;
    readonly host: string;
    readonly trustProxy: number;
    readonly rateLimitPerMinute: number;
    readonly corsOrigins: readonly string[];
  };
  readonly auth:
    | { readonly mode: "keys"; readonly keys: readonly ApiKeyConfig[] }
    | { readonly mode: "disabled" };
  readonly catalog: { readonly ttlMs: number; readonly maxStaleMs: number; readonly fallback: boolean };
  readonly readings: { readonly cacheEntries: number; readonly maxStaleMs: number };
  readonly logLevel: "debug" | "info" | "warn" | "error";
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

type Env = Record<string, string | undefined>;

export function loadPortalConfig(env: Env = process.env): PortalConfig {
  return toPortalConfig(parse(portalEnvSchema, env));
}

export function loadAppConfig(env: Env = process.env): AppConfig {
  const values = parse(appEnvSchema, env);

  if (values.CATALOG_MAX_STALE_MS < values.CATALOG_TTL_MS) {
    throw new ConfigError("Invalid configuration:\n  - CATALOG_MAX_STALE_MS must be >= CATALOG_TTL_MS");
  }

  let auth: AppConfig["auth"];
  if (values.AUTH_MODE === "disabled") {
    auth = { mode: "disabled" };
  } else {
    const keys = parseApiKeys(values.API_KEYS);
    // Fail closed: a server holding a privileged portal session must never
    // start wide open just because someone forgot to set API_KEYS.
    if (keys.length === 0) {
      throw new ConfigError(
        "Invalid configuration:\n  - API_KEYS is empty. Set at least one name:key pair, " +
          "or AUTH_MODE=disabled for local development.",
      );
    }
    auth = { mode: "keys", keys };
  }

  return {
    portal: toPortalConfig(values),
    http: {
      port: values.PORT,
      host: values.HOST,
      trustProxy: values.TRUST_PROXY,
      rateLimitPerMinute: values.RATE_LIMIT_PER_MINUTE,
      corsOrigins: values.CORS_ORIGINS.split(",").map((o) => o.trim().replace(/\/+$/, "")).filter((o) => o !== ""),
    },
    auth,
    catalog: { ttlMs: values.CATALOG_TTL_MS, maxStaleMs: values.CATALOG_MAX_STALE_MS, fallback: values.CATALOG_FALLBACK },
    readings: { cacheEntries: values.READINGS_CACHE_ENTRIES, maxStaleMs: values.READINGS_MAX_STALE_MS },
    logLevel: values.LOG_LEVEL,
  };
}

/** `web:abc...,data:def...` -> [{name:"web", key:"abc..."}, ...]. Never echoes key values in errors. */
export function parseApiKeys(raw: string): ApiKeyConfig[] {
  const entries = raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");

  const keys: ApiKeyConfig[] = [];
  const names = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    const separator = entry.indexOf(":");
    const name = separator > 0 ? entry.slice(0, separator).trim() : "";
    const key = separator > 0 ? entry.slice(separator + 1).trim() : "";
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(name) || key.length < 24) {
      throw new ConfigError(
        `Invalid configuration:\n  - API_KEYS entry #${index + 1} must look like name:key ` +
          "(name: letters, digits, - or _; key: at least 24 characters)",
      );
    }
    if (names.has(name)) {
      throw new ConfigError(`Invalid configuration:\n  - API_KEYS has the name "${name}" twice`);
    }
    names.add(name);
    keys.push({ name, key });
  }
  return keys;
}

function parse<S extends z.ZodType>(schema: S, env: Env): z.output<S> {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    // Only variable names and generic messages are reported, never values,
    // so a mistyped password cannot leak into logs.
    const problems = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new ConfigError(`Invalid configuration:\n  - ${problems.join("\n  - ")}`);
  }
  return parsed.data;
}

function toPortalConfig(values: z.output<typeof portalEnvSchema>): PortalConfig {
  return {
    baseUrl: values.PORTAL_BASE_URL.replace(/\/+$/, ""),
    email: values.PORTAL_EMAIL,
    password: values.PORTAL_PASSWORD,
    timeoutMs: values.PORTAL_TIMEOUT_MS,
    maxRetries: values.PORTAL_MAX_RETRIES,
    maxConcurrency: values.PORTAL_MAX_CONCURRENCY,
    maxQueue: values.PORTAL_MAX_QUEUE,
    breakerThreshold: values.PORTAL_BREAKER_THRESHOLD,
    breakerOpenMs: values.PORTAL_BREAKER_OPEN_MS,
  };
}
