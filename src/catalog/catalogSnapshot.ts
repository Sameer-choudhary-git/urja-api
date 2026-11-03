import { SpatialGrid, type GeoPoint, type Neighbour } from "../geo/spatialGrid.js";
import { NETWORK_LEVELS, NODE_SEPARATOR, type Meter, type NetworkLevel, type Transformer } from "../domain/meter.js";
import { buildNetworkTree, type NetworkTree } from "../domain/networkTree.js";
import type { QualityReport } from "../quality/scanExport.js";

/** Fields with a small, closed set of values: indexed, filterable, counted as facets. */
export type CatalogSource = "export" | "fallback";

export const FACET_FIELDS = ["make", "status", "phase", "installationType", "build"] as const;
export type FacetField = (typeof FACET_FIELDS)[number];

export const SORT_FIELDS = ["id", "serialNumber", "make", "status"] as const;
export type SortField = (typeof SORT_FIELDS)[number];

export interface MeterQuery {
  /** Case-insensitive substring of meter ID or serial number (same rule as the portal's search). */
  readonly q?: string;
  /** Each facet: a meter matches if its value is ANY of the given ones. Facets combine with AND. */
  readonly make?: readonly string[];
  readonly status?: readonly string[];
  readonly phase?: readonly string[];
  readonly installationType?: readonly string[];
  readonly build?: readonly string[];
  /** Match by code at a level, e.g. `{ feeder: "F-007" }`. Codes repeat across parents; use `node` to be exact. */
  readonly network?: Readonly<Partial<Record<NetworkLevel, string>>>;
  /** A network node id (path prefix), e.g. "Z-01.C-01.D-07". Exact subtree. */
  readonly node?: string;
  /** true: only meters with data issues; false: only clean ones. */
  readonly hasIssues?: boolean;
  readonly sort?: SortField;
  readonly order?: "asc" | "desc";
  readonly limit?: number;
  readonly offset?: number;
}

export interface MeterPage {
  readonly items: readonly Meter[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  /** Counts per facet value over ALL matches (not just this page): drives filter UIs and dashboards. */
  readonly facets: Readonly<Record<FacetField, Readonly<Record<string, number>>>>;
}

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 500;

/**
 * An immutable, fully indexed view of the catalog at one point in time.
 *
 * Built once per refresh and swapped in whole, so a request never sees a
 * half-updated catalog (readers keep the snapshot they started with).
 *
 * Indexes: id -> meter, and value -> ids for every facet field and every
 * network level's code. A query intersects the smallest candidate sets first;
 * text search and the subtree filter then scan only those candidates.
 */
export class CatalogSnapshot {
  readonly meters: readonly Meter[];
  readonly transformers: readonly Transformer[];
  readonly tree: NetworkTree;
  /** Epoch ms when the source data was fetched from the portal. */
  readonly fetchedAt: number;
  /** Data-quality scan of the raw export this snapshot was built from (null in tests that skip it). */
  readonly quality: QualityReport | null;
  /** Where the data came from: the signed export, or the slower fallback path (PROTOCOL.md 3.1/3.2). */
  readonly source: CatalogSource;

  private readonly byId: ReadonlyMap<string, Meter>;
  private readonly transformersByCode: ReadonlyMap<string, Transformer>;
  private readonly facetIndex: ReadonlyMap<FacetField, ReadonlyMap<string, ReadonlySet<string>>>;
  private readonly networkIndex: ReadonlyMap<NetworkLevel, ReadonlyMap<string, ReadonlySet<string>>>;
  private readonly grid: SpatialGrid<Meter>;

  constructor(input: {
    meters: readonly Meter[];
    transformers: readonly Transformer[];
    fetchedAt: number;
    quality?: QualityReport | null;
    source?: CatalogSource;
  }) {
    this.source = input.source ?? "export";
    this.meters = input.meters;
    this.transformers = input.transformers;
    this.fetchedAt = input.fetchedAt;
    this.quality = input.quality ?? null;
    this.byId = new Map(input.meters.map((m) => [m.id, m]));
    this.transformersByCode = new Map(input.transformers.map((t) => [t.code, t]));
    this.tree = buildNetworkTree(input.meters);
    this.grid = new SpatialGrid(input.meters, (m) => m.location);

    this.facetIndex = new Map(
      FACET_FIELDS.map((field) => [field, indexBy(input.meters, (m) => m[field])]),
    );
    this.networkIndex = new Map(
      NETWORK_LEVELS.map((level) => [level, indexBy(input.meters, (m) => m.network[level].code)]),
    );
  }

  get size(): number {
    return this.meters.length;
  }

  getMeter(id: string): Meter | undefined {
    return this.byId.get(id) ?? this.byId.get(id.toUpperCase());
  }

  getTransformer(code: string): Transformer | undefined {
    return this.transformersByCode.get(code) ?? this.transformersByCode.get(code.toUpperCase());
  }

  /** Meters within `radiusM` of a point, nearest first (grid index, see geo/spatialGrid.ts). */
  nearby(
    center: GeoPoint,
    radiusM: number,
    limit: number,
    filter: Pick<MeterQuery, "status" | "phase" | "installationType"> = {},
  ): Neighbour<Meter>[] {
    const accept = (meter: Meter) =>
      (filter.status === undefined || filter.status.length === 0 || filter.status.includes(meter.status)) &&
      (filter.phase === undefined || filter.phase.length === 0 || filter.phase.includes(meter.phase)) &&
      (filter.installationType === undefined ||
        filter.installationType.length === 0 ||
        filter.installationType.includes(meter.installationType));
    return this.grid.within(center, radiusM, limit, accept);
  }

  query(query: MeterQuery = {}): MeterPage {
    const limit = clamp(query.limit ?? DEFAULT_LIMIT, 1, MAX_LIMIT);
    const offset = Math.max(0, query.offset ?? 0);

    const matches = this.match(query);
    const facets = countFacets(matches);
    const sorted = sortMeters(matches, query.sort ?? "id", query.order ?? "asc");

    return { items: sorted.slice(offset, offset + limit), total: sorted.length, limit, offset, facets };
  }

  private match(query: MeterQuery): Meter[] {
    const candidateSets: ReadonlySet<string>[] = [];

    for (const field of FACET_FIELDS) {
      const wanted = query[field];
      if (wanted === undefined || wanted.length === 0) continue;
      candidateSets.push(unionOf(this.facetIndex.get(field), wanted));
    }
    for (const level of NETWORK_LEVELS) {
      const code = query.network?.[level];
      if (code === undefined || code === "") continue;
      candidateSets.push(unionOf(this.networkIndex.get(level), [code, code.toUpperCase()]));
    }

    let candidates: readonly Meter[];
    if (candidateSets.length === 0) {
      candidates = this.meters;
    } else {
      candidateSets.sort((a, b) => a.size - b.size);
      const [smallest, ...rest] = candidateSets;
      candidates = [...(smallest ?? [])]
        .filter((id) => rest.every((set) => set.has(id)))
        .map((id) => this.byId.get(id))
        .filter((m): m is Meter => m !== undefined);
    }

    const needle = query.q?.trim().toLowerCase();
    const node = query.node?.replace(/\.+$/, "");
    return candidates.filter(
      (m) =>
        (needle === undefined ||
          needle === "" ||
          m.id.toLowerCase().includes(needle) ||
          m.serialNumber.toLowerCase().includes(needle)) &&
        (node === undefined ||
          node === "" ||
          m.network.path === node ||
          m.network.path.startsWith(`${node}${NODE_SEPARATOR}`)) &&
        (query.hasIssues === undefined || query.hasIssues === m.issues.length > 0),
    );
  }
}

function indexBy(
  meters: readonly Meter[],
  key: (meter: Meter) => string,
): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();
  for (const meter of meters) {
    const value = key(meter);
    const ids = index.get(value) ?? new Set<string>();
    ids.add(meter.id);
    index.set(value, ids);
  }
  return index;
}

function unionOf(
  index: ReadonlyMap<string, ReadonlySet<string>> | undefined,
  values: readonly string[],
): Set<string> {
  const result = new Set<string>();
  for (const value of values) {
    for (const id of index?.get(value) ?? []) result.add(id);
  }
  return result;
}

function countFacets(meters: readonly Meter[]): MeterPage["facets"] {
  const facets = {} as Record<FacetField, Record<string, number>>;
  for (const field of FACET_FIELDS) {
    const counts: Record<string, number> = {};
    for (const meter of meters) counts[meter[field]] = (counts[meter[field]] ?? 0) + 1;
    facets[field] = counts;
  }
  return facets;
}

function sortMeters(meters: Meter[], field: SortField, order: "asc" | "desc"): Meter[] {
  const direction = order === "asc" ? 1 : -1;
  return meters.sort(
    (a, b) => direction * (a[field].localeCompare(b[field]) || a.id.localeCompare(b.id)),
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
