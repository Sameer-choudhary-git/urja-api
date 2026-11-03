import { noopLogger, type Logger } from "../logger.js";
import { mapPool } from "../shared/mapPool.js";
import { decodeSvelteKitPageData } from "./devalue.js";
import { PortalProtocolError } from "./errors.js";
import type { ExportSnapshot } from "./exportApi.js";
import type { PortalClient, ResponseSchema } from "./portalClient.js";
import {
  geoResponseSchema,
  HIERARCHY_LEVELS,
  meterPageDataSchema,
  searchPageSchema,
  type ExportMeter,
  type HierarchyLevel,
  type MeterPageData,
  type SearchRow,
} from "./schemas.js";

export const SEARCH_PATH = "/portal/meters/search";
const MAX_PAGES = 100;

/** Labels the detail page uses for each hierarchy level (PROTOCOL.md 3.2). */
const HIERARCHY_LABELS: Readonly<Record<HierarchyLevel, string>> = {
  zone: "Zone",
  circle: "Circle",
  division: "Division",
  subdivision: "Subdivision",
  substation: "Sub Station",
  feeder: "Feeder",
  dt: "DT",
};

/** zod cannot express "decode devalue, then validate", so this small adapter does both. */
const pageDataSchema: ResponseSchema<MeterPageData> = {
  safeParse(data: unknown) {
    let decoded: unknown;
    try {
      decoded = decodeSvelteKitPageData(data);
    } catch (error) {
      return { success: false, error: { issues: [{ path: [], message: (error as Error).message }] } };
    }
    return meterPageDataSchema.safeParse(decoded);
  },
};

export interface PortalFallbackApiOptions {
  readonly client: PortalClient;
  /** Meter pages fetched at once (each meter needs two calls). */
  readonly concurrency?: number;
  readonly logger?: Logger;
  readonly now?: () => number;
}

/**
 * The slow way to build the catalog, without the signed export:
 *
 *   /portal/meters/search (21 pages)  -> id, serial, make, phase, status, DT
 *   /meters/{id}/__data.json          -> installation type + hierarchy (devalue)
 *   /portal/meters/{id}/geo           -> location
 *
 * About 830 calls instead of 1, so it is only used when the export fails in a
 * way that is not "the portal is down" (e.g. the signing scheme changed). The
 * result has the export's shape, so the same normaliser and quality scan run
 * on it. `build` is not available on this path and is set to "unknown".
 */
export class PortalFallbackApi {
  private readonly client: PortalClient;
  private readonly concurrency: number;
  private readonly logger: Logger;
  private readonly now: () => number;

  constructor(options: PortalFallbackApiOptions) {
    this.client = options.client;
    this.concurrency = options.concurrency ?? 4;
    this.logger = options.logger ?? noopLogger;
    this.now = options.now ?? Date.now;
  }

  async listMeters(): Promise<SearchRow[]> {
    const rows: SearchRow[] = [];
    let total = Number.POSITIVE_INFINITY;
    for (let page = 1; rows.length < total; page += 1) {
      if (page > MAX_PAGES) throw new PortalProtocolError(`Meter search still incomplete after ${MAX_PAGES} pages`);
      const body = await this.client.get(SEARCH_PATH, searchPageSchema, { q: "", page });
      total = body.total;
      if (body.data.length === 0) break;
      rows.push(...body.data);
    }
    if (rows.length !== total) {
      throw new PortalProtocolError(`Meter search reported total=${total} but returned ${rows.length} rows`);
    }
    if (new Set(rows.map((r) => r.meterId)).size !== rows.length) {
      throw new PortalProtocolError("Meter search returned the same meter twice");
    }
    return rows;
  }

  fetchPageData(meterId: string): Promise<MeterPageData> {
    return this.client.get(`/meters/${encodeURIComponent(meterId)}/__data.json`, pageDataSchema, {
      "x-sveltekit-invalidated": "001",
    });
  }

  async fetchLocation(meterId: string): Promise<{ lat: number; lng: number }> {
    const body = await this.client.get(`/portal/meters/${encodeURIComponent(meterId)}/geo`, geoResponseSchema);
    return { lat: Number(body.data.latitude), lng: Number(body.data.longitude) };
  }

  /** Same contract as PortalExportApi.fetchAllMeters, so loaders can swap them. */
  async fetchAllMeters(): Promise<ExportSnapshot> {
    const started = this.now();
    const rows = await this.listMeters();
    const meters = await mapPool(rows, this.concurrency, async (row) => {
      const [page, location] = await Promise.all([this.fetchPageData(row.meterId), this.fetchLocation(row.meterId)]);
      return toExportMeter(row, page, location);
    });
    this.logger.info("portal.fallback.ok", { meters: meters.length, calls: 1 + Math.ceil(rows.length / 20) + rows.length * 2, ms: this.now() - started });
    return { meters, fetchedAt: this.now() };
  }
}

const CLASS_DATA_LABELS: Readonly<Record<string, string>> = {
  MeterId: "Meter ID",
  SerialNo: "Serial No",
  Make: "Make",
  PhaseType: "Phase Type",
  InstallationStatus: "Installation Status",
  InstallationType: "Installation Type",
};

/**
 * The detail block as label -> value, whichever of its two shapes the page
 * used. `classData` is a JSON string inside the JSON, wrapped in one key
 * (`installed_meter` seen so far); its field names are mapped to the labels
 * the list shape uses. An unreadable `classData` yields nothing rather than
 * failing: the hierarchy block still has the installation type.
 */
export function readDetail(page: MeterPageData): Map<string, string> {
  const result = new Map<string, string>();
  for (const pair of page.detail?.data ?? []) result.set(pair.parameterName, pair.parameterValue);
  const raw = page.detail?.classData;
  if (raw !== undefined) {
    try {
      const outer: unknown = JSON.parse(raw);
      const inner = outer !== null && typeof outer === "object" ? Object.values(outer)[0] : undefined;
      if (inner !== null && typeof inner === "object") {
        for (const [key, value] of Object.entries(inner)) {
          if (typeof value === "string") result.set(CLASS_DATA_LABELS[key] ?? key, value);
        }
      }
    } catch {
      // Malformed classData: fall back to the hierarchy block.
    }
  }
  return result;
}

/** "Mansarovar DT 2 (DT-002)" -> { name: "Mansarovar DT 2", code: "DT-002" }. */
export function splitNameAndCode(value: string | undefined): { name: string; code: string } {
  const text = (value ?? "").trim();
  const match = /^(.*?)\s*\(([^()]*)\)$/.exec(text);
  return match === null ? { name: text, code: "" } : { name: (match[1] ?? "").trim(), code: (match[2] ?? "").trim() };
}

export function toExportMeter(row: SearchRow, page: MeterPageData, location: { lat: number; lng: number }): ExportMeter {
  if (page.meterId !== row.meterId) {
    throw new PortalProtocolError(`Detail page for ${row.meterId} described ${page.meterId}`);
  }
  const detail = readDetail(page);
  const hierarchy = Object.fromEntries(
    HIERARCHY_LEVELS.map((level) => [level, splitNameAndCode(page.hierarchy[HIERARCHY_LABELS[level]])]),
  ) as ExportMeter["hierarchy"];
  return {
    meterId: row.meterId,
    serialNo: row.serialNo,
    make: row.make,
    phaseType: row.phaseType,
    installStatus: row.installStatus,
    installType: detail.get("Installation Type") ?? page.hierarchy["Installation Type"] ?? "",
    build: "unknown",
    dtCode: row.dtCode,
    geo: location,
    hierarchy,
  };
}
