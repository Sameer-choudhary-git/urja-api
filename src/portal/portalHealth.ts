import type { PortalHealth } from "../api/context.js";
import type { Portal } from "./createPortal.js";

/** Reads the portal client's guards for /ready. */
export function portalHealth(portal: Pick<Portal, "breaker" | "limiter">): () => PortalHealth {
  return () => {
    const breaker = portal.breaker.snapshot();
    const limiter = portal.limiter.snapshot();
    return {
      circuit: breaker.state,
      consecutiveFailures: breaker.consecutiveFailures,
      retryAfterSeconds: breaker.retryAfterMs === null ? null : Math.ceil(breaker.retryAfterMs / 1000),
      activeRequests: limiter.active,
      queuedRequests: limiter.queued,
    };
  };
}
