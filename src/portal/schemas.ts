import { z } from "zod";

/**
 * Wire schemas for portal responses: what the portal actually sends, checked
 * at the boundary (PROTOCOL.md, section 3). They are deliberately tolerant
 * where the real data is messy (blank hierarchy cells, unknown `build`
 * values) and strict where a change would mean we misunderstood the protocol
 * (missing fields, wrong types). Cleaning up the mess is the domain layer's
 * job, not the wire layer's.
 */

/** `GET /portal/keys` */
export const keysResponseSchema = z.object({
  data: z.object({
    signingSecret: z.string().min(1),
  }),
});

/**
 * One hierarchy level in the export, e.g. `{ "name": "Circle 6", "code": "C-06" }`.
 * Either side can be an empty string in real data (22 of 403 meters).
 */
const hierarchyNodeSchema = z.object({
  name: z.string(),
  code: z.string(),
});

export const HIERARCHY_LEVELS = [
  "zone",
  "circle",
  "division",
  "subdivision",
  "substation",
  "feeder",
  "dt",
] as const;

export type HierarchyLevel = (typeof HIERARCHY_LEVELS)[number];

const hierarchySchema = z.object({
  zone: hierarchyNodeSchema,
  circle: hierarchyNodeSchema,
  division: hierarchyNodeSchema,
  subdivision: hierarchyNodeSchema,
  substation: hierarchyNodeSchema,
  feeder: hierarchyNodeSchema,
  dt: hierarchyNodeSchema,
});

/** One meter in `GET /portal/export`. Enum-like fields stay plain strings here on purpose. */
export const exportMeterSchema = z.object({
  meterId: z.string().min(1),
  serialNo: z.string(),
  make: z.string(),
  phaseType: z.string(),
  installStatus: z.string(),
  installType: z.string(),
  /** Meaning unknown; seen values are "legacy" and "v2" (PROTOCOL.md, section 6). */
  build: z.string(),
  dtCode: z.string(),
  geo: z.object({
    lat: z.number(),
    lng: z.number(),
  }),
  hierarchy: hierarchySchema,
});

/** `GET /portal/export?page=1` */
export const exportResponseSchema = z.object({
  data: z.array(exportMeterSchema),
  total: z.number().int().nonnegative(),
});

/** What the UI's "Export all meters" button saves to disk: just the `data` array. */
export const exportFileSchema = z.array(exportMeterSchema);

export type ExportMeter = z.infer<typeof exportMeterSchema>;
export type ExportHierarchy = z.infer<typeof hierarchySchema>;
export type ExportResponse = z.infer<typeof exportResponseSchema>;

/** One row of `GET /portal/dts?page=N`. `capacityKva` is a real JSON number here. */
export const transformerRowSchema = z.object({
  code: z.string().min(1),
  name: z.string(),
  feederCode: z.string(),
  capacityKva: z.number(),
});

/** `GET /portal/dts?page=N` (40 DTs, 20 per page as of 2026-11-03). */
export const transformerPageSchema = z.object({
  data: z.array(transformerRowSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int(),
  pageSize: z.number().int().positive(),
});

export type TransformerRow = z.infer<typeof transformerRowSchema>;

/**
 * A register value as the portal sends it: normally a decimal number in a
 * string ("48438.74", "226"). Kept loose on purpose: on 2026-11-04 meter
 * J100089 had one row whose kwh and voltR were not numbers, and a strict
 * schema rejected the whole month. The readings code checks each value and
 * reports a bad row as a reading issue instead (domain/readings.ts).
 */
const rawValue = z.union([z.string(), z.number(), z.null()]).optional();

/**
 * One row of `GET /portal/meters/{id}/energy`. Normally everything is a
 * string; the timestamp is `DD/MM/YYYY HH:mm` with no timezone (PROTOCOL.md
 * 3.3). `kwh` and `kvah` are cumulative registers, not per-interval usage.
 */
export const energyRowSchema = z.object({
  timestamp: z.union([z.string(), z.null()]).optional(),
  kwh: rawValue,
  kvah: rawValue,
  voltR: rawValue,
});

export const energyResponseSchema = z.object({
  data: z.array(energyRowSchema),
});

export type EnergyRow = z.infer<typeof energyRowSchema>;

/** One row of `GET /portal/meters/search?q=&page=N` (PROTOCOL.md 3.1). No install type, no location. */
export const searchRowSchema = z.object({
  meterId: z.string().min(1),
  serialNo: z.string(),
  make: z.string(),
  phaseType: z.string(),
  installStatus: z.string(),
  dtCode: z.string(),
});

export const searchPageSchema = z.object({
  data: z.array(searchRowSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int(),
  pageSize: z.number().int().positive(),
});

/** `GET /portal/meters/{id}/geo`: coordinates as strings. */
export const geoResponseSchema = z.object({
  data: z.object({
    latitude: z.string().regex(/^-?\d+(\.\d+)?$/),
    longitude: z.string().regex(/^-?\d+(\.\d+)?$/),
  }),
});

/**
 * The decoded page data of `/meters/{id}/__data.json` (PROTOCOL.md 3.2).
 * `detail` comes in two shapes (live portal, 2026-11-03):
 *   - `{ data: [{ parameterName, parameterValue }, ...] }`  (e.g. J100001)
 *   - `{ classData: "<JSON string>" }` where the string is
 *     `{"installed_meter": {"MeterId": ..., "InstallationType": ..., ...}}` (e.g. J100020)
 * Both are optional here; the hierarchy block also carries the installation
 * type, and is what the fallback relies on when neither shape is present.
 */
export const meterPageDataSchema = z.object({
  meterId: z.string(),
  detail: z
    .object({
      data: z.array(z.object({ parameterName: z.string(), parameterValue: z.string() })).optional(),
      classData: z.string().optional(),
    })
    .passthrough()
    .nullable()
    .optional(),
  hierarchy: z.record(z.string(), z.string()),
});

export type SearchRow = z.infer<typeof searchRowSchema>;
export type MeterPageData = z.infer<typeof meterPageDataSchema>;
