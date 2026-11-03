import compression from "compression";
import express, { type Express } from "express";
import helmet from "helmet";
import swaggerUi from "swagger-ui-express";
import type { ApiContext } from "../api/context.js";
import { registerRoutes } from "../api/routes.js";
import { problemSchema } from "../api/schemas.js";
import type { ApiKeyConfig } from "../config.js";
import { noopLogger, type Logger } from "../logger.js";
import {
  accessLog,
  apiKeyAuth,
  cors,
  errorHandler,
  notFound,
  perConsumerRateLimit,
  requestId,
} from "./middleware.js";
import { buildOpenApiDocument, RouteRegistry } from "./routeRegistry.js";

export interface AppOptions {
  readonly context: ApiContext;
  /** null = auth disabled (local development only). */
  readonly apiKeys: readonly ApiKeyConfig[] | null;
  readonly rateLimitPerMinute: number;
  readonly trustProxy?: number;
  readonly logger?: Logger;
  readonly version?: string;
  /** Browser origins allowed to call the API (CORS); "*" for any. Default: none. */
  readonly corsOrigins?: readonly string[];
}

export interface BuiltApp {
  readonly app: Express;
  readonly openApi: Record<string, unknown>;
}

/**
 * Builds the Express app without starting it, so tests can drive it in
 * process (supertest) and `main.ts` decides how it is served.
 *
 * Request pipeline, in order:
 *   request id -> access log -> security headers -> compression
 *   -> [per /v1 route: API key -> rate limit] -> zod validation -> handler
 *   -> 404 for unknown routes -> problem+json error handler
 */
export function createApp(options: AppOptions): BuiltApp {
  const logger = options.logger ?? noopLogger;
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", options.trustProxy ?? 0);
  app.set("etag", "strong");
  // Repeated keys (?status=a&status=b) become "a,b", the same as ?status=a,b.
  app.set("query parser", (raw: string) => {
    const result: Record<string, string> = {};
    for (const [key, value] of new URLSearchParams(raw)) {
      result[key] = key in result ? `${result[key]},${value}` : value;
    }
    return result;
  });

  app.use(requestId);
  app.use(accessLog(logger));
  app.use(cors(options.corsOrigins ?? []));
  // Cross-origin resource policy must allow other origins to read responses when CORS is on.
  app.use(
    helmet({
      // helmet's default CSP has `upgrade-insecure-requests`, which makes the
      // browser fetch Swagger UI's CSS/JS over https://. Behind plain HTTP
      // (EC2 on port 80, no certificate) that times out and /docs renders blank.
      // TLS is the gateway's job, so the app does not force the upgrade.
      contentSecurityPolicy: { directives: { upgradeInsecureRequests: null } },
      crossOriginResourcePolicy: { policy: (options.corsOrigins ?? []).length > 0 ? "cross-origin" : "same-origin" },
    }),
  );
  app.use(compression());

  const registry = new RouteRegistry();
  registerRoutes(registry, options.context);

  const openApi = buildOpenApiDocument(
    registry,
    {
      title: "Urja Meter API",
      version: options.version ?? "0.1.0",
      description:
        "A clean API over the legacy Urja Meter Ops portal: meters, their network position, " +
        "transformers and data quality. All /v1 routes need an API key. Errors are RFC 9457 problem+json. " +
        "How the portal works underneath is documented in PROTOCOL.md.",
    },
    problemSchema,
  );

  app.get("/", (_req, res) => res.redirect("/docs"));
  app.get("/openapi.json", (_req, res) => res.json(openApi));
  app.use("/docs", swaggerUi.serve, swaggerUi.setup(openApi, { customSiteTitle: "Urja Meter API" }));

  const router = express.Router();
  registry.mount(router, [
    apiKeyAuth(options.apiKeys),
    perConsumerRateLimit(options.rateLimitPerMinute),
  ]);
  app.use(router);

  app.use(notFound);
  app.use(errorHandler(logger));

  return { app, openApi };
}
