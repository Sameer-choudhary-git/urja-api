import { z } from "zod";
import { FACET_FIELDS, MAX_LIMIT, SORT_FIELDS } from "../catalog/catalogSnapshot.js";
import { ANOMALY_CODES } from "../domain/anomalies.js";
import { READING_ISSUE_CODES } from "../domain/readings.js";
import { DAY_MS, parseUserTime } from "../domain/time.js";
import { MAX_SPAN_MS } from "../readings/readingsService.js";
import {
  INSTALLATION_TYPES,
  METER_STATUSES,
  NETWORK_LEVELS,
  PHASE_TYPES,
} from "../domain/meter.js";

/**
 * The public contract of /v1. Field names are camelCase, enums are lowercase
 * snake_case, numbers are numbers, times are ISO 8601. These schemas generate
 * openapi.json, so every `.describe()` here is documentation.
 */

// ---------------------------------------------------------------------------
// Query helpers

/** "a,b" -> ["a","b"]. Repeated keys (?status=a&status=b) are joined to "a,b" by the app's query parser. */
const csv = <T extends string>(values: readonly [T, ...T[]], description: string) =>
  z
    .string()
    .describe(`${description} Comma-separated; a meter matches ANY of them. Values: ${values.join(", ")}.`)
    .transform((raw) => raw.split(",").map((part) => part.trim()).filter((part) => part !== ""))
    .pipe(z.array(z.enum(values)))
    .optional();

const freeCsv = (description: string) =>
  z
    .string()
    .describe(`${description} Comma-separated; matches ANY of them.`)
    .transform((raw) => raw.split(",").map((part) => part.trim()).filter((part) => part !== ""))
    .optional();

const limit = (fallback: number, max: number) =>
  z.coerce.number().int().min(1).max(max).default(fallback).describe(`Page size, 1 to ${max}.`);
const offset = z.coerce.number().int().min(0).default(0).describe("Number of items to skip.");

const booleanString = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

export const meterIdParams = z.object({
  meterId: z
    .string()
    .regex(/^[Jj]\d{6}$/, "Meter IDs look like J100001")
    .transform((id) => id.toUpperCase())
    .describe("Meter ID, e.g. J100001 (case-insensitive)."),
});

export const transformerCodeParams = z.object({
  code: z
    .string()
    .regex(/^[Dd][Tt]-\d{3}$/, "Transformer codes look like DT-007")
    .transform((code) => code.toUpperCase())
    .describe("Transformer code, e.g. DT-007."),
});

export const nodeIdParams = z.object({
  nodeId: z
    .string()
    .regex(/^[A-Za-z0-9?-]+(\.[A-Za-z0-9?-]+){0,6}$/, "Node ids look like Z-01.C-01.D-07")
    .describe("Network node id: codes from the zone down, joined with dots, e.g. Z-01.C-01.D-07."),
});

const meterFilterShape = {
  q: z.string().max(64).optional().describe("Substring of meter ID or serial number, case-insensitive."),
  status: csv(METER_STATUSES, "Installation status."),
  phase: csv(PHASE_TYPES, "Phase type."),
  installationType: csv(INSTALLATION_TYPES, "Installation type."),
  make: freeCsv("Manufacturer, e.g. Genus."),
  build: freeCsv("Portal `build` value, e.g. legacy or v2."),
  zone: z.string().optional().describe("Zone code, e.g. Z-01."),
  circle: z.string().optional().describe("Circle code."),
  division: z.string().optional().describe("Division code (repeats across circles; prefer `node`)."),
  subdivision: z.string().optional().describe("Subdivision code."),
  substation: z.string().optional().describe("Substation code."),
  feeder: z.string().optional().describe("Feeder code, e.g. F-007."),
  transformer: z.string().optional().describe("Transformer code, e.g. DT-007."),
  node: z.string().optional().describe("Network node id; returns that exact subtree, e.g. Z-01.C-01.D-07."),
  hasIssues: booleanString.optional().describe("true: only meters with data-quality issues; false: only clean ones."),
};

export const meterListQuery = z.object({
  ...meterFilterShape,
  sort: z.enum(SORT_FIELDS).default("id").describe("Sort field."),
  order: z.enum(["asc", "desc"]).default("asc").describe("Sort direction."),
  limit: limit(50, MAX_LIMIT),
  offset,
});

export const nearbyQuery = z.object({
  lat: z.coerce.number().min(-90).max(90).describe("Latitude of the centre, e.g. 26.9124."),
  lng: z.coerce.number().min(-180).max(180).describe("Longitude of the centre, e.g. 75.7873."),
  radiusM: z.coerce.number().positive().max(50_000).default(1_000).describe("Search radius in metres, up to 50 km."),
  limit: limit(20, 200),
  status: meterFilterShape.status,
  phase: meterFilterShape.phase,
  installationType: meterFilterShape.installationType,
});

export const meterGeoQuery = z.object(meterFilterShape);

export const transformerListQuery = z.object({
  q: z.string().max(64).optional().describe("Substring of code, name or alias, case-insensitive."),
  feeder: z.string().optional().describe("Feeder code, e.g. F-007."),
  sort: z.enum(["code", "name", "meterCount", "capacityKva"]).default("code").describe("Sort field."),
  order: z.enum(["asc", "desc"]).default("asc").describe("Sort direction."),
  limit: limit(50, 200),
  offset,
});

export const hierarchyQuery = z.object({
  depth: z.coerce.number().int().min(1).max(7).default(7).describe("How many levels to return (1 = zones only, 7 = down to transformers)."),
  status: csv(METER_STATUSES, "Only count meters with this status."),
});

export const hierarchyNodeQuery = z.object({
  limit: limit(50, MAX_LIMIT),
  offset,
});

export const searchQuery = z.object({
  q: z.string().trim().min(1).max(64).describe("Text to look for in meters, transformers and network nodes."),
  limit: limit(10, 50).describe("Max results per kind."),
});

export const statsQuery = z.object({
  groupBy: z.enum([...FACET_FIELDS, ...NETWORK_LEVELS]).optional().describe("Also count meters per value of this field."),
});

/** A consumer-supplied time; see parseUserTime for the accepted forms. */
const userTime = (description: string) =>
  z
    .string()
    .describe(description)
    .transform((raw, ctx) => {
      const parsed = parseUserTime(raw);
      if (parsed === null) {
        ctx.addIssue({ code: "custom", message: "Use a date (2026-06-29) or a date-time (2026-06-29T12:00:00+05:30)" });
        return z.NEVER;
      }
      return parsed;
    })
    .optional();

/** The shared `from`/`to` window fields. */
const windowFields = {
  from: userTime("Start of the window, inclusive. A date means 00:00 IST that day; a date-time without an offset is read as IST."),
  to: userTime("End of the window, exclusive. A date-only value includes that whole day (to=2026-06-30 ends at 1 July 00:00 IST)."),
};

type ParsedTime = { epochMs: number; dateOnly: boolean } | undefined;

/** Parsed times -> epoch ms; a date-only `to` becomes the end of that day. */
function toWindow<R extends { from?: ParsedTime; to?: ParsedTime }>(value: R) {
  const { from, to, ...rest } = value;
  return {
    ...(rest as Omit<R, "from" | "to">),
    from: from?.epochMs,
    to: to === undefined ? undefined : to.dateOnly ? to.epochMs + DAY_MS : to.epochMs,
  };
}

/** from < to, and at most 31 days. */
function checkWindow({ from, to }: { from?: number | undefined; to?: number | undefined }, ctx: z.RefinementCtx): void {
  if (from === undefined || to === undefined) return;
  if (from >= to) ctx.addIssue({ code: "custom", path: ["to"], message: "`to` must be after `from`" });
  else if (to - from > MAX_SPAN_MS) {
    ctx.addIssue({ code: "custom", path: ["to"], message: `A window can be at most ${MAX_SPAN_MS / DAY_MS} days` });
  }
}

export const readingsQuery = z
  .object({
    ...windowFields,
    granularity: z
      .enum(["raw", "hour", "day"])
      .default("raw")
      .describe("raw = every half-hourly reading; hour/day = usage summed per IST hour or day."),
  })
  .transform(toWindow)
  .superRefine(checkWindow);

export const windowQuery = z.object(windowFields).transform(toWindow).superRefine(checkWindow);

export const anomalyScopeQuery = z
  .object({
    ...windowFields,
  transformer: z.string().regex(/^[Dd][Tt]-\d{3}$/).optional().describe("All meters on this transformer, e.g. DT-007."),
  node: z.string().optional().describe("All meters under this network node id, e.g. Z-01.C-01.D-07.SD-07."),
  meterIds: freeCsv("Explicit meter IDs, e.g. J100000,J100005."),
    severity: z.enum(["info", "warning", "critical"]).optional().describe("Only findings at or above this severity."),
  })
  .transform(toWindow)
  .superRefine(checkWindow);

// ---------------------------------------------------------------------------
// Response building blocks

export const metaSchema = z
  .object({
    asOf: z.string().describe("When this data was fetched from the portal (ISO 8601, UTC)."),
    ageSeconds: z.number().int().describe("Age of the data in seconds."),
    stale: z.boolean().describe("True when older than the refresh interval; a refresh is under way."),
    source: z
      .enum(["export", "fallback"])
      .describe("export = the portal's signed bulk export; fallback = rebuilt from search and detail pages because the export failed."),
  })
  .describe("Freshness of the catalog the answer came from.");

const networkRefSchema = z.object({ code: z.string(), name: z.string() });

export const dataIssueSchema = z.object({
  code: z.enum(["network_cell_repaired", "network_cell_missing", "transformer_name_conflict", "unknown_value"]),
  field: z.string(),
  detail: z.string(),
});

export const meterSchema = z.object({
  id: z.string().describe("Meter ID, e.g. J100001."),
  serialNumber: z.string(),
  make: z.string(),
  phase: z.enum([...PHASE_TYPES, "unknown"]),
  status: z.enum([...METER_STATUSES, "unknown"]),
  installationType: z.enum([...INSTALLATION_TYPES, "unknown"]),
  build: z.string().describe("Portal `build` field; meaning unknown (legacy or v2 so far)."),
  location: z.object({ lat: z.number(), lng: z.number() }),
  network: z
    .object({
      zone: networkRefSchema,
      circle: networkRefSchema,
      division: networkRefSchema,
      subdivision: networkRefSchema,
      substation: networkRefSchema,
      feeder: networkRefSchema,
      transformer: networkRefSchema,
      path: z.string().describe("Node id of the transformer, e.g. Z-01.C-01.D-07.SD-07.SS-07.F-007.DT-007."),
    })
    .describe("Where the meter sits in the network, zone down to transformer."),
  issues: z.array(dataIssueSchema).describe("What we repaired or could not trust in the portal's record."),
});

export const transformerSchema = z.object({
  code: z.string(),
  name: z.string().describe("Canonical name (from the portal's transformer list)."),
  aliases: z.array(z.string()).describe("Other names the portal uses for the same code."),
  capacityKva: z.number().nullable(),
  feederCode: z.string(),
  networkPath: z.string(),
  meterCount: z.number().int(),
});

const statusCountsSchema = z.record(z.string(), z.number().int());

export const networkNodeSummarySchema = z.object({
  id: z.string(),
  level: z.enum(NETWORK_LEVELS),
  code: z.string(),
  name: z.string(),
  meterCount: z.number().int(),
  statusCounts: statusCountsSchema,
});

export type NetworkNodeTree = z.infer<typeof networkNodeSummarySchema> & {
  children?: NetworkNodeTree[];
};

export const networkNodeTreeSchema: z.ZodType<NetworkNodeTree> = networkNodeSummarySchema.extend({
  get children() {
    return z.array(networkNodeTreeSchema).optional();
  },
});

const pageSchema = z.object({
  total: z.number().int(),
  limit: z.number().int(),
  offset: z.number().int(),
});

// ---------------------------------------------------------------------------
// Responses

export const healthResponse = z.object({ status: z.literal("ok"), uptimeSeconds: z.number().int() });

export const readyResponse = z.object({
  ready: z.boolean(),
  catalog: z.object({
    loaded: z.boolean(),
    meterCount: z.number().int(),
    asOf: z.string().nullable(),
    ageSeconds: z.number().int().nullable(),
    refreshing: z.boolean(),
    lastError: z.object({ message: z.string(), at: z.string() }).nullable(),
  }),
  portal: z
    .object({
      circuit: z.enum(["closed", "open", "half_open"]).describe("open = the portal failed repeatedly; calls are paused."),
      consecutiveFailures: z.number().int(),
      retryAfterSeconds: z.number().int().nullable(),
      activeRequests: z.number().int(),
      queuedRequests: z.number().int(),
    })
    .nullable()
    .describe("Health of the connection to the legacy portal (null when not wired)."),
});

export const meterListResponse = z.object({
  data: z.array(meterSchema),
  page: pageSchema,
  facets: z.record(z.string(), z.record(z.string(), z.number().int())).describe("Counts per filter value over all matches."),
  meta: metaSchema,
});

export const nearbyResponse = z.object({
  data: z.array(
    z.object({
      distanceM: z.number().describe("Great-circle distance from the centre, metres (rounded to 0.1)."),
      meter: meterSchema,
    }),
  ),
  center: z.object({ lat: z.number(), lng: z.number() }),
  radiusM: z.number(),
  meta: metaSchema,
});

export const meterResponse = z.object({
  data: meterSchema.extend({
    transformer: transformerSchema.nullable().describe("The meter's transformer with capacity."),
  }),
  meta: metaSchema,
});

export const meterGeoJsonResponse = z.object({
  type: z.literal("FeatureCollection"),
  features: z.array(
    z.object({
      type: z.literal("Feature"),
      id: z.string(),
      geometry: z.object({ type: z.literal("Point"), coordinates: z.tuple([z.number(), z.number()]).describe("[lng, lat]") }),
      properties: z.object({
        status: z.string(),
        make: z.string(),
        phase: z.string(),
        transformer: z.string(),
        hasIssues: z.boolean(),
      }),
    }),
  ),
});

export const transformerListResponse = z.object({
  data: z.array(transformerSchema),
  page: pageSchema,
  meta: metaSchema,
});

export const transformerResponse = z.object({
  data: transformerSchema.extend({
    statusCounts: statusCountsSchema,
    meters: z.array(meterSchema.pick({ id: true, serialNumber: true, make: true, phase: true, status: true })),
  }),
  meta: metaSchema,
});

export const hierarchyResponse = z.object({
  data: z.array(networkNodeTreeSchema),
  meta: metaSchema,
});

export const hierarchyNodeResponse = z.object({
  data: networkNodeSummarySchema.extend({
    breadcrumb: z.array(networkNodeSummarySchema.pick({ id: true, level: true, code: true, name: true })),
    children: z.array(networkNodeSummarySchema),
    meters: z.array(meterSchema),
    page: pageSchema,
  }),
  meta: metaSchema,
});

export const searchResponse = z.object({
  data: z.object({
    meters: z.array(meterSchema.pick({ id: true, serialNumber: true, status: true })),
    transformers: z.array(transformerSchema.pick({ code: true, name: true, aliases: true })),
    nodes: z.array(networkNodeSummarySchema.pick({ id: true, level: true, code: true, name: true })),
  }),
  meta: metaSchema,
});

export const statsResponse = z.object({
  data: z.object({
    meters: z.number().int(),
    transformers: z.number().int(),
    totalCapacityKva: z.number().nullable(),
    metersWithIssues: z.number().int(),
    byStatus: z.record(z.string(), z.number().int()),
    byMake: z.record(z.string(), z.number().int()),
    byPhase: z.record(z.string(), z.number().int()),
    byInstallationType: z.record(z.string(), z.number().int()),
    byBuild: z.record(z.string(), z.number().int()),
    groupedBy: z
      .object({ field: z.string(), counts: z.record(z.string(), z.number().int()) })
      .nullable(),
  }),
  meta: metaSchema,
});

export const qualityResponse = z.object({
  data: z.object({
    summary: z.object({
      meters: z.number().int(),
      metersWithIssues: z.number().int(),
      issuesByCode: z.record(z.string(), z.number().int()),
    }),
    transformerNameConflicts: z.array(
      z.object({ code: z.string(), canonicalName: z.string(), aliases: z.array(z.string()) }),
    ),
    scan: z.unknown().describe("Full scan of the raw export (see PROTOCOL.md section 3.7)."),
  }),
  meta: metaSchema,
});

const istTime = z.string().describe("ISO 8601 with the IST offset, e.g. 2026-06-29T00:30:00+05:30.");
const voltageStatsSchema = z
  .object({ min: z.number(), avg: z.number(), max: z.number() })
  .nullable()
  .describe("R-phase voltage over the readings, volts.");

const readingItemSchema = z.object({
  timestamp: istTime.describe("When the registers were read. This reading closes the half hour before it."),
  intervalStart: istTime.describe("Start of the half hour this reading's usage belongs to (timestamp - 30 min)."),
  kwhRegister: z.number().describe("Cumulative kWh register (like an odometer)."),
  kvahRegister: z.number().describe("Cumulative kVAh register."),
  voltageR: z.number().describe("R-phase voltage, volts."),
  intervalKwh: z.number().nullable().describe("kWh used in the half hour; null when the previous reading is missing or the register went down."),
  intervalKvah: z.number().nullable(),
  powerFactor: z.number().nullable().describe("intervalKwh / intervalKvah, 0 to 1; null with no load."),
});

const bucketItemSchema = z.object({
  start: istTime,
  end: istTime,
  kwh: z.number().nullable().describe("kWh used in the bucket; null if no interval in it has data."),
  kvah: z.number().nullable(),
  powerFactor: z.number().nullable(),
  voltageR: voltageStatsSchema,
  intervals: z.number().int().describe("Half hours with known usage."),
  expectedIntervals: z.number().int().describe("Half hours of this bucket inside the window."),
  complete: z.boolean().describe("True when no half hour is missing."),
});

export const readingIssueSchema = z.object({
  code: z.enum(READING_ISSUE_CODES),
  at: istTime.nullable(),
  message: z.string(),
});

export const readingsMetaSchema = z
  .object({
    asOf: z.string().describe("When these readings were fetched from the portal (ISO 8601, UTC)."),
    ageSeconds: z.number().int(),
    stale: z.boolean().describe("True when the portal failed and an older copy is served."),
    cache: z.enum(["hit", "miss", "stale"]),
    maxAgeSeconds: z.number().int().describe("How long this answer stays fresh (also sent as Cache-Control max-age)."),
    latestReadingAt: istTime.nullable().describe("Newest reading the portal has for this meter in the fetched days."),
  })
  .describe("Freshness of the readings.");

export const readingsResponse = z.object({
  data: z.object({
    meterId: z.string(),
    granularity: z.enum(["raw", "hour", "day"]),
    timezone: z.literal("+05:30").describe("All times are IST; the portal has no other timezone."),
    window: z.object({ from: istTime, to: istTime }).describe("The window served, [from, to)."),
    summary: z.object({
      intervals: z.number().int(),
      expectedIntervals: z.number().int(),
      totalKwh: z.number().nullable(),
      totalKvah: z.number().nullable(),
      powerFactor: z.number().nullable(),
      voltageR: voltageStatsSchema,
      peak: z.object({ intervalStart: istTime, kwh: z.number() }).nullable().describe("The half hour with the highest usage."),
      firstReadingAt: istTime.nullable(),
      lastReadingAt: istTime.nullable(),
    }),
    items: z
      .union([z.array(readingItemSchema), z.array(bucketItemSchema)])
      .describe("Readings for granularity=raw, otherwise one bucket per hour or day (empty buckets included)."),
    issues: z.array(readingIssueSchema).describe("Data problems found in this window: gaps, register resets, impossible power factors."),
  }),
  meta: readingsMetaSchema,
});

export const anomalySchema = z.object({
  code: z.enum(ANOMALY_CODES),
  severity: z.enum(["info", "warning", "critical"]),
  subject: z.string().describe("Meter ID, or transformer code for transformer findings."),
  at: istTime.nullable().describe("First offending interval or reading; null for window-wide findings."),
  message: z.string(),
  value: z.number().nullable().describe("The measured value that broke the rule."),
});

const windowSchema = z.object({ from: istTime, to: istTime });

export const meterAnomaliesResponse = z.object({
  data: z.object({ meterId: z.string(), window: windowSchema, anomalies: z.array(anomalySchema) }),
  meta: metaSchema,
});

export const anomalyScanResponse = z.object({
  data: z.object({
    scope: z.string().describe("What was scanned, e.g. transformer DT-007."),
    metersScanned: z.number().int(),
    failed: z.array(z.object({ meterId: z.string(), error: z.string() })).describe("Meters whose readings could not be fetched."),
    counts: z.object({
      bySeverity: z.record(z.string(), z.number().int()),
      byCode: z.record(z.string(), z.number().int()),
    }),
    anomalies: z.array(anomalySchema).describe("Most severe first."),
  }),
  meta: metaSchema,
});

const loadPointSchema = z.object({
  intervalStart: istTime,
  kva: z.number().describe("Average apparent power in the half hour (kVAh x 2), summed over the DT's meters."),
  metersReporting: z.number().int(),
});

export const transformerLoadResponse = z.object({
  data: z.object({
    transformer: transformerSchema,
    window: windowSchema,
    capacityKva: z.number().nullable(),
    peak: loadPointSchema.nullable(),
    peakUtilisationPercent: z.number().nullable().describe("Peak kVA as a share of the rating. A lower bound: losses and unmetered load are not included."),
    averageKva: z.number().nullable(),
    metersReporting: z.number().int(),
    failed: z.array(z.object({ meterId: z.string(), error: z.string() })),
    points: z.array(loadPointSchema),
    anomalies: z.array(anomalySchema),
  }),
  meta: metaSchema,
});

export const problemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  code: z.string().describe("Stable, machine-readable error code."),
  detail: z.string().optional(),
  requestId: z.string().optional(),
  errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
});

// ---------------------------------------------------------------------------
// Bulk exports (for analysts and other systems: no paging, flat rows, JSON or CSV)

const exportFormat = z
  .enum(["json", "csv"])
  .default("json")
  .describe("json = flat rows in `data.rows`; csv = the same rows as a CSV file (one header line).");

export const meterExportQuery = z.object({ ...meterFilterShape, format: exportFormat });

export const meterExportRowSchema = z.object({
  id: z.string(),
  serialNumber: z.string(),
  make: z.string(),
  phase: z.string(),
  status: z.string(),
  installationType: z.string(),
  build: z.string(),
  lat: z.number(),
  lng: z.number(),
  zoneCode: z.string(),
  zoneName: z.string(),
  circleCode: z.string(),
  circleName: z.string(),
  divisionCode: z.string(),
  divisionName: z.string(),
  subdivisionCode: z.string(),
  subdivisionName: z.string(),
  substationCode: z.string(),
  substationName: z.string(),
  feederCode: z.string(),
  feederName: z.string(),
  transformerCode: z.string(),
  transformerName: z.string(),
  transformerCapacityKva: z.number().nullable(),
  networkPath: z.string(),
  issueCodes: z.string().describe("Space-separated data-issue codes; empty when the record is clean."),
});

export const meterExportResponse = z.object({
  data: z.object({ count: z.number().int(), rows: z.array(meterExportRowSchema) }),
  meta: metaSchema,
});

export const readingsExportQuery = z
  .object({
    ...windowFields,
    transformer: z.string().regex(/^[Dd][Tt]-\d{3}$/).optional().describe("All meters on this transformer, e.g. DT-007."),
    node: z.string().optional().describe("All meters under this network node id, e.g. Z-01.C-01.D-07.SD-07."),
    meterIds: freeCsv("Explicit meter IDs, e.g. J100000,J100005."),
    granularity: z.enum(["raw", "hour", "day"]).default("hour").describe("raw = half-hourly rows; hour/day = summed per IST hour or day."),
    format: exportFormat,
  })
  .transform(toWindow)
  .superRefine(checkWindow);

export const readingsExportRowSchema = z
  .object({
    meterId: z.string(),
    start: istTime.describe("Start of the half hour, hour or day."),
    end: istTime,
    kwh: z.number().nullable(),
    kvah: z.number().nullable(),
    powerFactor: z.number().nullable(),
    voltageMin: z.number().nullable(),
    voltageAvg: z.number().nullable(),
    voltageMax: z.number().nullable(),
    intervals: z.number().int().describe("Half hours with known usage."),
    expectedIntervals: z.number().int(),
    kwhRegister: z.number().nullable().describe("Cumulative register at the end of the half hour (raw only)."),
    kvahRegister: z.number().nullable(),
  })
  .describe("One row per meter per bucket (long format), the shape spreadsheets and BI tools expect.");

export const readingsExportResponse = z.object({
  data: z.object({
    scope: z.string(),
    granularity: z.enum(["raw", "hour", "day"]),
    timezone: z.literal("+05:30"),
    window: z.object({ from: istTime, to: istTime }),
    meters: z.number().int().describe("Meters with readings in the export."),
    failed: z.array(z.object({ meterId: z.string(), error: z.string() })).describe("Meters whose readings could not be fetched."),
    count: z.number().int(),
    rows: z.array(readingsExportRowSchema),
  }),
  meta: metaSchema,
});

export type MeterExportRow = z.infer<typeof meterExportRowSchema>;
export type ReadingsExportRow = z.infer<typeof readingsExportRowSchema>;
