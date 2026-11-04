import type { Request, RequestHandler, Response, Router } from "express";
import { z } from "zod";
import { ApiError } from "./problem.js";

/**
 * One declaration per endpoint. The SAME zod schemas are used to:
 *   1. validate and coerce the request at runtime (bad input -> 400 problem),
 *   2. type the handler's input and output at compile time,
 *   3. generate `openapi.json` (and so the Swagger UI at /docs).
 * Code is the single source of truth, so the docs cannot drift from the code.
 */
/** Lets handlers return the domain's readonly data without copying it. */
type DeepReadonly<T> = T extends readonly (infer U)[]
  ? readonly DeepReadonly<U>[]
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

export interface RouteSpec<
  P extends z.ZodType = z.ZodType,
  Q extends z.ZodType = z.ZodType,
  R extends z.ZodType = z.ZodType,
> {
  readonly method: "get";
  /** Express-style path, e.g. "/v1/meters/:meterId". */
  readonly path: string;
  readonly operationId: string;
  readonly summary: string;
  readonly description?: string;
  readonly tags: readonly string[];
  /** Whether the route needs an API key (all /v1 routes do). */
  readonly auth: boolean;
  readonly params?: P;
  readonly query?: Q;
  readonly response: R;
  /** Error statuses worth documenting besides the generic ones. */
  readonly errors?: readonly number[];
  /**
   * Extra media types the route can answer with besides JSON (e.g. text/csv for
   * bulk exports). The handler returns a RawBody for those.
   */
  readonly alsoProduces?: readonly string[];
  readonly handler: (input: {
    params: z.output<P>;
    query: z.output<Q>;
    req: Request;
    res: Response;
  }) => Promise<DeepReadonly<z.input<R>> | RawBody> | DeepReadonly<z.input<R>> | RawBody;
}

/** A non-JSON answer (CSV, NDJSON): sent as-is with its media type. */
export class RawBody {
  constructor(
    readonly contentType: string,
    readonly body: string,
    readonly filename?: string,
  ) {}
}

// The registry stores routes of many shapes; a type-erased spec keeps that simple.
type AnySpec = RouteSpec<z.ZodType, z.ZodType, z.ZodType>;

export class RouteRegistry {
  private readonly specs: AnySpec[] = [];

  add<P extends z.ZodType, Q extends z.ZodType, R extends z.ZodType>(spec: RouteSpec<P, Q, R>): this {
    this.specs.push(spec as unknown as AnySpec);
    return this;
  }

  get routes(): readonly AnySpec[] {
    return this.specs;
  }

  /** Registers every route on an Express router; protected routes get `guards` first (auth, rate limit). */
  mount(router: Router, guards: readonly RequestHandler[]): void {
    for (const spec of this.specs) {
      const handlers: RequestHandler[] = spec.auth ? [...guards] : [];
      handlers.push(toExpressHandler(spec));
      router[spec.method](spec.path, ...handlers);
    }
  }
}

function toExpressHandler(spec: AnySpec): RequestHandler {
  return async (req, res) => {
    const params = validate(spec.params, req.params, "path");
    const query = validate(spec.query, req.query, "query");
    const body = await spec.handler({ params, query, req, res });
    if (body instanceof RawBody) {
      if (body.filename !== undefined) res.attachment(body.filename);
      res.type(body.contentType).send(body.body);
      return;
    }
    res.json(body);
    // Express 5 forwards a rejected promise to the error middleware by itself.
  };
}

function validate(schema: z.ZodType | undefined, value: unknown, where: "path" | "query"): unknown {
  if (schema === undefined) return {};
  const result = schema.safeParse(value ?? {});
  if (result.success) return result.data;
  throw ApiError.badRequest(
    `Invalid ${where} parameters`,
    result.error.issues.map((issue) => ({
      path: [where, ...issue.path.map(String)].join("."),
      message: issue.message,
    })),
  );
}

// ---------------------------------------------------------------------------
// OpenAPI generation

export interface OpenApiInfo {
  readonly title: string;
  readonly version: string;
  readonly description: string;
}

type JsonSchema = Record<string, unknown>;

const STANDARD_ERRORS: Readonly<Record<number, string>> = {
  400: "Invalid parameters",
  401: "Missing or invalid API key",
  404: "Not found",
  429: "Rate limit exceeded",
  502: "The legacy portal failed or answered unexpectedly",
  503: "The legacy portal is unavailable",
};

export function buildOpenApiDocument(
  registry: RouteRegistry,
  info: OpenApiInfo,
  problemSchema: z.ZodType,
): JsonSchema {
  const paths: Record<string, Record<string, unknown>> = {};

  for (const spec of registry.routes) {
    const openApiPath = spec.path.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, "{$1}");
    const errorStatuses = new Set<number>([
      ...(spec.query !== undefined || spec.params !== undefined ? [400] : []),
      ...(spec.auth ? [401, 429] : []),
      ...(spec.errors ?? []),
    ]);

    const responses: Record<string, unknown> = {
      200: {
        description: "OK",
        content: {
          "application/json": { schema: toSchema(spec.response, "output") },
          ...Object.fromEntries((spec.alsoProduces ?? []).map((type) => [type, { schema: { type: "string" } }])),
        },
      },
    };
    for (const status of [...errorStatuses].sort()) {
      responses[status] = {
        description: STANDARD_ERRORS[status] ?? "Error",
        content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } },
      };
    }

    paths[openApiPath] ??= {};
    paths[openApiPath][spec.method] = {
      operationId: spec.operationId,
      summary: spec.summary,
      ...(spec.description !== undefined && { description: spec.description }),
      tags: spec.tags,
      ...(spec.auth ? {} : { security: [] }),
      parameters: [
        ...parameters(spec.params, "path"),
        ...parameters(spec.query, "query"),
      ],
      responses,
    };
  }

  return {
    openapi: "3.1.0",
    info,
    servers: [{ url: "/" }],
    // One scheme in the docs, so Swagger UI's Authorize dialog has one box. The server also
    // accepts `Authorization: Bearer <key>` (same key); that is described here, not as a second box.
    security: [{ apiKey: [] }],
    paths,
    components: {
      securitySchemes: {
        apiKey: {
          type: "apiKey",
          in: "header",
          name: "X-API-Key",
          description:
            "Paste your API key here (for a review: the key in the README). It is sent as `X-API-Key: <key>`. " +
            "Clients may send the same key as `Authorization: Bearer <key>` instead; either header works, one is enough.",
        },
      },
      schemas: { Problem: toSchema(problemSchema, "output") },
    },
  };
}

function parameters(schema: z.ZodType | undefined, location: "path" | "query"): unknown[] {
  if (schema === undefined) return [];
  const json = toSchema(schema, "input");
  const properties = (json.properties ?? {}) as Record<string, JsonSchema>;
  const required = new Set((json.required as string[] | undefined) ?? []);
  return Object.entries(properties).map(([name, property]) => {
    const { description, ...rest } = property;
    return {
      name,
      in: location,
      required: location === "path" || required.has(name),
      ...(typeof description === "string" && { description }),
      schema: rest,
    };
  });
}

function toSchema(schema: z.ZodType, io: "input" | "output"): JsonSchema {
  const json = z.toJSONSchema(schema, { io, unrepresentable: "any" }) as JsonSchema;
  delete json.$schema;
  return json;
}
