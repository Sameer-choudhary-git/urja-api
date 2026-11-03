import type { PortalConfig } from "../config.js";
import { noopLogger, type Logger } from "../logger.js";
import { CircuitBreaker } from "../shared/circuitBreaker.js";
import { ConcurrencyLimiter } from "../shared/concurrencyLimiter.js";
import { PortalAuthError, PortalUnavailableError } from "./errors.js";
import { PortalAuthenticator } from "./authenticator.js";
import { PortalExportApi } from "./exportApi.js";
import { PortalEnergyApi } from "./energyApi.js";
import { PortalFallbackApi } from "./fallbackApi.js";
import { PortalClient } from "./portalClient.js";
import { SessionManager } from "./session.js";
import { PortalTransformersApi } from "./transformersApi.js";

export interface Portal {
  readonly client: PortalClient;
  readonly exportApi: PortalExportApi;
  readonly transformersApi: PortalTransformersApi;
  readonly energyApi: PortalEnergyApi;
  readonly fallbackApi: PortalFallbackApi;
  readonly breaker: CircuitBreaker;
  readonly limiter: ConcurrencyLimiter;
}

/**
 * Composition root for the portal adapter: the one place that knows how the
 * pieces fit together. Scripts and the HTTP server both call this, so there is
 * exactly one wiring to read and to test.
 */
export function createPortal(config: PortalConfig, logger: Logger = noopLogger): Portal {
  const authenticator = new PortalAuthenticator({ ...config, logger });
  const sessions = new SessionManager({ authenticator, logger });
  // Unhealthy = unreachable, timing out, 5xx/429 after retries, or login broken.
  // A 404 or an odd payload means the portal is up, so it does not count.
  const breaker = new CircuitBreaker({
    failureThreshold: config.breakerThreshold ?? 5,
    openMs: config.breakerOpenMs ?? 30_000,
    isFailure: (error) => error instanceof PortalUnavailableError || error instanceof PortalAuthError,
    onStateChange: (from, to) => logger[to === "open" ? "warn" : "info"]("portal.circuit", { from, to }),
  });
  const limiter = new ConcurrencyLimiter({ maxConcurrent: config.maxConcurrency ?? 4, maxQueue: config.maxQueue ?? 200 });
  const client = new PortalClient({ ...config, sessions, logger, breaker, limiter });
  const exportApi = new PortalExportApi({ client, logger });
  const transformersApi = new PortalTransformersApi({ client, logger });
  const energyApi = new PortalEnergyApi({ client, logger });
  const fallbackApi = new PortalFallbackApi({ client, logger, concurrency: Math.max(1, Math.floor((config.maxConcurrency ?? 4) / 2)) });
  return { client, exportApi, transformersApi, energyApi, fallbackApi, breaker, limiter };
}
