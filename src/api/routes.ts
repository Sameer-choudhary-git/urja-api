import type { MeterQuery } from "../catalog/catalogSnapshot.js";
import { NETWORK_LEVELS, type Meter, type NetworkLevel } from "../domain/meter.js";
import { AnomalyService, MAX_SCOPE_METERS } from "../anomalies/anomalyService.js";
import type { Anomaly } from "../domain/anomalies.js";
import { aggregate, inWindow, intervalStart, summarize, type TimeWindow } from "../domain/readings.js";
import { HALF_HOUR_MS, toIstIso } from "../domain/time.js";
import { buildNetworkTree, type NetworkNode } from "../domain/networkTree.js";
import { ApiError } from "../http/problem.js";
import type { RouteRegistry } from "../http/routeRegistry.js";
import { readCatalog, type ApiContext } from "./context.js";
import * as s from "./schemas.js";

/**
 * Every endpoint of the service, registered in one place. Handlers stay thin:
 * read the catalog snapshot, shape the answer. All filtering, indexing and
 * freshness logic lives in the catalog, not here.
 */
const SEVERITY_RANK = { info: 0, warning: 1, critical: 2 } as const;

const isoWindow = (window: TimeWindow) => ({ from: toIstIso(window.from), to: toIstIso(window.to) });
const anomalyOut = (anomaly: Anomaly) => ({ ...anomaly, at: anomaly.at === null ? null : toIstIso(anomaly.at) });

export function registerRoutes(registry: RouteRegistry, context: ApiContext): void {
  const anomalies = new AnomalyService(context.readings);

  // -- Operations ------------------------------------------------------------

  registry.add({
    method: "get",
    path: "/health",
    operationId: "getHealth",
    summary: "Liveness: is the process up?",
    description: "Never touches the portal. For container health checks.",
    tags: ["Operations"],
    auth: false,
    response: s.healthResponse,
    handler: () => ({
      status: "ok" as const,
      uptimeSeconds: Math.floor((context.now() - context.startedAt) / 1000),
    }),
  });

  registry.add({
    method: "get",
    path: "/ready",
    operationId: "getReadiness",
    summary: "Readiness: is the catalog loaded, and how fresh is it?",
    description: "Answers 503 with ready=false until the first catalog load succeeds, so a load balancer can wait.",
    tags: ["Operations"],
    auth: false,
    response: s.readyResponse,
    handler: ({ res }) => {
      const status = context.catalog.status();
      if (!status.loaded) res.status(503);
      return {
        ready: status.loaded,
        portal: context.portalHealth?.() ?? null,
        catalog: {
          loaded: status.loaded,
          meterCount: status.meterCount,
          asOf: status.fetchedAt === null ? null : new Date(status.fetchedAt).toISOString(),
          ageSeconds: status.ageMs === null ? null : Math.floor(status.ageMs / 1000),
          refreshing: status.refreshing,
          lastError:
            status.lastError === null
              ? null
              : { message: status.lastError.message, at: new Date(status.lastError.at).toISOString() },
        },
      };
    },
  });

  // -- Meters ---------------------------------------------------------------

  registry.add({
    method: "get",
    path: "/v1/meters",
    operationId: "listMeters",
    summary: "List and filter meters",
    description:
      "Filters combine with AND; comma-separated values inside one filter combine with OR. " +
      "`facets` counts every filter value over ALL matches, for building filter UIs.",
    tags: ["Meters"],
    auth: true,
    query: s.meterListQuery,
    response: s.meterListResponse,
    handler: async ({ query, res }) => {
      const { snapshot, meta } = await readCatalog(context, res);
      const page = snapshot.query({
        ...toMeterQuery(query),
        sort: query.sort,
        order: query.order,
        limit: query.limit,
        offset: query.offset,
      });
      return {
        data: [...page.items],
        page: { total: page.total, limit: page.limit, offset: page.offset },
        facets: page.facets,
        meta,
      };
    },
  });

  registry.add({
    method: "get",
    path: "/v1/meters.geojson",
    operationId: "listMetersGeoJson",
    summary: "Meters as GeoJSON points, for maps",
    description: "Same filters as /v1/meters, no paging: every match is returned (403 meters is about 80 KB).",
    tags: ["Meters"],
    auth: true,
    query: s.meterGeoQuery,
    response: s.meterGeoJsonResponse,
    handler: async ({ query, res }) => {
      const { snapshot } = await readCatalog(context, res);
      const { items } = snapshot.query({ ...toMeterQuery(query), limit: Number.MAX_SAFE_INTEGER });
      res.type("application/geo+json");
      return {
        type: "FeatureCollection" as const,
        features: items.map((m) => ({
          type: "Feature" as const,
          id: m.id,
          geometry: { type: "Point" as const, coordinates: [m.location.lng, m.location.lat] as [number, number] },
          properties: {
            status: m.status,
            make: m.make,
            phase: m.phase,
            transformer: m.network.transformer.code,
            hasIssues: m.issues.length > 0,
          },
        })),
      };
    },
  });

  // Must be registered before /v1/meters/:meterId, or "nearby" would be read as a meter ID.
  registry.add({
    method: "get",
    path: "/v1/meters/nearby",
    operationId: "listNearbyMeters",
    summary: "Meters near a point, nearest first",
    description:
      "Uses a grid index over meter locations (see README for the benchmark). " +
      "Optional status/phase/installationType filters, e.g. faulty meters within 2 km of a site.",
    tags: ["Meters"],
    auth: true,
    query: s.nearbyQuery,
    response: s.nearbyResponse,
    handler: async ({ query, res }) => {
      const { snapshot, meta } = await readCatalog(context, res);
      const center = { lat: query.lat, lng: query.lng };
      const found = snapshot.nearby(center, query.radiusM, query.limit, query);
      return {
        data: found.map(({ item, distanceM }) => ({ distanceM: Math.round(distanceM * 10) / 10, meter: item })),
        center,
        radiusM: query.radiusM,
        meta,
      };
    },
  });

  registry.add({
    method: "get",
    path: "/v1/meters/:meterId",
    operationId: "getMeter",
    summary: "One meter: attributes, location, network position, data issues",
    tags: ["Meters"],
    auth: true,
    params: s.meterIdParams,
    response: s.meterResponse,
    errors: [404],
    handler: async ({ params, res }) => {
      const { snapshot, meta } = await readCatalog(context, res);
      const meter = snapshot.getMeter(params.meterId);
      if (meter === undefined) throw ApiError.notFound(`Meter ${params.meterId} does not exist`);
      return {
        data: { ...meter, transformer: snapshot.getTransformer(meter.network.transformer.code) ?? null },
        meta,
      };
    },
  });

  registry.add({
    method: "get",
    path: "/v1/meters/:meterId/readings",
    operationId: "getMeterReadings",
    summary: "Energy readings: half-hourly, or summed per hour or day",
    description:
      "The portal stores cumulative registers every 30 minutes. This returns them with the usage of each half hour " +
      "(the difference to the previous reading), power factor, and optional hourly or daily totals. " +
      "Without from/to you get the 7 days ending at the newest reading. A window is at most 31 days. " +
      "History currently covers 1 to 30 June 2026 (PROTOCOL.md 3.3). Times are IST (+05:30).",
    tags: ["Meters"],
    auth: true,
    params: s.meterIdParams,
    query: s.readingsQuery,
    response: s.readingsResponse,
    errors: [404, 502, 503],
    handler: async ({ params, query, res }) => {
      // Unknown IDs are answered from the catalog, without a portal call.
      const { snapshot } = await context.catalog.read();
      if (snapshot.getMeter(params.meterId) === undefined) {
        throw ApiError.notFound(`Meter ${params.meterId} does not exist`);
      }

      const result = await context.readings.get({ meterId: params.meterId, from: query.from, to: query.to });
      const now = context.now();
      const maxAgeSeconds = Math.max(0, Math.floor((result.expiresAt - now) / 1000));
      res.set({
        "cache-control": result.cache === "stale" ? "no-cache" : `private, max-age=${maxAgeSeconds}`,
        "x-cache": result.cache.toUpperCase(),
      });

      const { window, readings } = result;
      const summary = summarize(readings, window);
      const items =
        query.granularity === "raw"
          ? inWindow(readings, window).map((reading) => ({
              timestamp: toIstIso(reading.at),
              intervalStart: toIstIso(intervalStart(reading)),
              kwhRegister: reading.kwhRegister,
              kvahRegister: reading.kvahRegister,
              voltageR: reading.voltageR,
              intervalKwh: reading.intervalKwh,
              intervalKvah: reading.intervalKvah,
              powerFactor: reading.powerFactor,
            }))
          : aggregate(readings, window, query.granularity).map((bucket) => ({
              ...bucket,
              start: toIstIso(bucket.start),
              end: toIstIso(bucket.end),
            }));
      const issues = result.issues
        .filter((issue) => issue.at === null || (issue.at - HALF_HOUR_MS >= window.from && issue.at - HALF_HOUR_MS < window.to))
        .map((issue) => ({ ...issue, at: issue.at === null ? null : toIstIso(issue.at) }));

      return {
        data: {
          meterId: result.meterId,
          granularity: query.granularity,
          timezone: "+05:30" as const,
          window: { from: toIstIso(window.from), to: toIstIso(window.to) },
          summary: {
            ...summary,
            peak: summary.peak === null ? null : { intervalStart: toIstIso(summary.peak.intervalStart), kwh: summary.peak.kwh },
            firstReadingAt: summary.firstReadingAt === null ? null : toIstIso(summary.firstReadingAt),
            lastReadingAt: summary.lastReadingAt === null ? null : toIstIso(summary.lastReadingAt),
          },
          items,
          issues,
        },
        meta: {
          asOf: new Date(result.fetchedAt).toISOString(),
          ageSeconds: Math.max(0, Math.floor((now - result.fetchedAt) / 1000)),
          stale: result.cache === "stale",
          cache: result.cache,
          maxAgeSeconds,
          latestReadingAt: result.latestReadingAt === null ? null : toIstIso(result.latestReadingAt),
        },
      };
    },
  });

  // -- Anomalies --------------------------------------------------------------

  registry.add({
    method: "get",
    path: "/v1/meters/:meterId/anomalies",
    operationId: "getMeterAnomalies",
    summary: "Anomalies in one meter's readings",
    description:
      "Rule-based checks: voltage outside 230 V +-6%, power factor below 0.85, a day or more of zero use on a live meter, " +
      "usage spikes (median + 6 x MAD), consumption on a decommissioned meter, data gaps, register resets. " +
      "Thresholds are listed in the README.",
    tags: ["Anomalies"],
    auth: true,
    params: s.meterIdParams,
    query: s.windowQuery,
    response: s.meterAnomaliesResponse,
    errors: [404, 502, 503],
    handler: async ({ params, query, res }) => {
      const { snapshot, meta } = await readCatalog(context, res);
      const meter = snapshot.getMeter(params.meterId);
      if (meter === undefined) throw ApiError.notFound(`Meter ${params.meterId} does not exist`);
      const { results } = await anomalies.scan([meter], query);
      const result = results[0]!;
      return { data: { meterId: meter.id, window: isoWindow(result.window), anomalies: result.anomalies.map(anomalyOut) }, meta };
    },
  });

  registry.add({
    method: "get",
    path: "/v1/anomalies",
    operationId: "scanAnomalies",
    summary: "Scan an area for anomalies: a transformer, a network node, or a list of meters",
    description:
      `Give exactly one scope: transformer, node or meterIds (at most ${MAX_SCOPE_METERS} meters, one portal call each, ` +
      "cached afterwards). Meters whose readings cannot be fetched are listed under `failed`; the rest are still returned.",
    tags: ["Anomalies"],
    auth: true,
    query: s.anomalyScopeQuery,
    response: s.anomalyScanResponse,
    errors: [502, 503],
    handler: async ({ query, res }) => {
      const { snapshot, meta } = await readCatalog(context, res);
      const scopes = [query.transformer, query.node, query.meterIds].filter((v) => v !== undefined);
      if (scopes.length !== 1) throw ApiError.badRequest("Give exactly one of transformer, node or meterIds");

      let meters: Meter[];
      let scope: string;
      if (query.meterIds !== undefined) {
        const unknown = query.meterIds.filter((id) => snapshot.getMeter(id) === undefined);
        if (unknown.length > 0) throw ApiError.badRequest(`Unknown meter IDs: ${unknown.join(", ")}`);
        meters = [...new Set(query.meterIds.map((id) => snapshot.getMeter(id)!))];
        scope = `meters ${meters.map((m) => m.id).join(",")}`;
      } else if (query.transformer !== undefined) {
        const code = query.transformer.toUpperCase();
        meters = [...snapshot.query({ network: { transformer: code }, limit: 500 }).items];
        scope = `transformer ${code}`;
      } else {
        meters = [...snapshot.query({ node: query.node!, limit: 500 }).items];
        scope = `node ${query.node}`;
      }
      if (meters.length === 0) throw ApiError.notFound(`No meters in ${scope}`);
      if (meters.length > MAX_SCOPE_METERS) {
        throw ApiError.badRequest(
          `${scope} has ${meters.length} meters; a scan covers at most ${MAX_SCOPE_METERS}. Pick a smaller node or a transformer.`,
        );
      }

      const { results, failed } = await anomalies.scan(meters, query);
      const minRank = query.severity === undefined ? 0 : SEVERITY_RANK[query.severity];
      const found = results
        .flatMap((r) => r.anomalies)
        .filter((a) => SEVERITY_RANK[a.severity] >= minRank)
        .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || a.subject.localeCompare(b.subject));
      const count = (key: (a: Anomaly) => string) =>
        found.reduce<Record<string, number>>((acc, a) => ({ ...acc, [key(a)]: (acc[key(a)] ?? 0) + 1 }), {});
      return {
        data: {
          scope,
          metersScanned: results.length,
          failed,
          counts: { bySeverity: count((a) => a.severity), byCode: count((a) => a.code) },
          anomalies: found.map(anomalyOut),
        },
        meta,
      };
    },
  });

  registry.add({
    method: "get",
    path: "/v1/transformers/:code/load",
    operationId: "getTransformerLoad",
    summary: "Transformer loading: demand of its meters per half hour against its kVA rating",
    description:
      "Sums the apparent power (kVAh x 2) of the DT's meters per half hour and compares the peak with the rating from " +
      "/portal/dts. A lower bound on real loading: line losses and unmetered load are not visible. Flags 80%+ as warning, 100%+ as critical.",
    tags: ["Transformers", "Anomalies"],
    auth: true,
    params: s.transformerCodeParams,
    query: s.windowQuery,
    response: s.transformerLoadResponse,
    errors: [404, 502, 503],
    handler: async ({ params, query, res }) => {
      const { snapshot, meta } = await readCatalog(context, res);
      const transformer = snapshot.getTransformer(params.code);
      if (transformer === undefined) throw ApiError.notFound(`Transformer ${params.code} does not exist`);
      const meters = snapshot.query({ network: { transformer: transformer.code }, limit: 500 }).items;
      const result = await anomalies.transformer(transformer, meters, query);
      const point = (p: { intervalStart: number; kva: number; metersReporting: number }) => ({ ...p, intervalStart: toIstIso(p.intervalStart) });
      return {
        data: {
          transformer,
          window: isoWindow(result.window),
          capacityKva: result.load.capacityKva,
          peak: result.load.peak === null ? null : point(result.load.peak),
          peakUtilisationPercent: result.load.peakUtilisationPercent,
          averageKva: result.load.averageKva,
          metersReporting: meters.length - result.failed.length,
          failed: result.failed,
          points: result.load.points.map(point),
          anomalies: result.anomalies.map(anomalyOut),
        },
        meta,
      };
    },
  });

  // -- Transformers ---------------------------------------------------------

  registry.add({
    method: "get",
    path: "/v1/transformers",
    operationId: "listTransformers",
    summary: "List distribution transformers",
    tags: ["Network"],
    auth: true,
    query: s.transformerListQuery,
    response: s.transformerListResponse,
    handler: async ({ query, res }) => {
      const { snapshot, meta } = await readCatalog(context, res);
      const needle = query.q?.toLowerCase();
      const feeder = query.feeder?.toUpperCase();
      const direction = query.order === "asc" ? 1 : -1;
      const matches = snapshot.transformers
        .filter(
          (t) =>
            (feeder === undefined || t.feederCode === feeder) &&
            (needle === undefined ||
              [t.code, t.name, ...t.aliases].some((text) => text.toLowerCase().includes(needle))),
        )
        .sort((a, b) => {
          const left = a[query.sort] ?? -1;
          const right = b[query.sort] ?? -1;
          const order =
            typeof left === "number" && typeof right === "number"
              ? left - right
              : String(left).localeCompare(String(right));
          return direction * (order || a.code.localeCompare(b.code));
        });
      return {
        data: matches.slice(query.offset, query.offset + query.limit),
        page: { total: matches.length, limit: query.limit, offset: query.offset },
        meta,
      };
    },
  });

  registry.add({
    method: "get",
    path: "/v1/transformers/:code",
    operationId: "getTransformer",
    summary: "One transformer with its meters and status counts",
    tags: ["Network"],
    auth: true,
    params: s.transformerCodeParams,
    response: s.transformerResponse,
    errors: [404],
    handler: async ({ params, res }) => {
      const { snapshot, meta } = await readCatalog(context, res);
      const transformer = snapshot.getTransformer(params.code);
      if (transformer === undefined) throw ApiError.notFound(`Transformer ${params.code} does not exist`);
      const { items } = snapshot.query({ network: { transformer: transformer.code }, limit: Number.MAX_SAFE_INTEGER });
      return {
        data: {
          ...transformer,
          statusCounts: countBy(items, (m) => m.status),
          meters: items.map(({ id, serialNumber, make, phase, status }) => ({ id, serialNumber, make, phase, status })),
        },
        meta,
      };
    },
  });

  // -- Network hierarchy ----------------------------------------------------

  registry.add({
    method: "get",
    path: "/v1/hierarchy",
    operationId: "getHierarchy",
    summary: "Network tree: Zone > Circle > Division > Subdivision > Substation > Feeder > Transformer",
    description:
      "Each node carries meter and status counts. Node ids are paths (codes repeat under different parents below Circle).",
    tags: ["Network"],
    auth: true,
    query: s.hierarchyQuery,
    response: s.hierarchyResponse,
    handler: async ({ query, res }) => {
      const { snapshot, meta } = await readCatalog(context, res);
      const tree =
        query.status === undefined
          ? snapshot.tree
          : buildNetworkTree(snapshot.query({ status: query.status, limit: Number.MAX_SAFE_INTEGER }).items);
      return { data: tree.roots.map((node) => trim(node, query.depth)), meta };
    },
  });

  registry.add({
    method: "get",
    path: "/v1/hierarchy/:nodeId",
    operationId: "getHierarchyNode",
    summary: "One network node: its breadcrumb, children and the meters below it",
    tags: ["Network"],
    auth: true,
    params: s.nodeIdParams,
    query: s.hierarchyNodeQuery,
    response: s.hierarchyNodeResponse,
    errors: [404],
    handler: async ({ params, query, res }) => {
      const { snapshot, meta } = await readCatalog(context, res);
      const node = snapshot.tree.byId.get(params.nodeId);
      if (node === undefined) throw ApiError.notFound(`Network node ${params.nodeId} does not exist`);

      const parts = node.id.split(".");
      const breadcrumb = parts
        .slice(0, -1)
        .map((_, index) => snapshot.tree.byId.get(parts.slice(0, index + 1).join(".")))
        .filter((ancestor): ancestor is NetworkNode => ancestor !== undefined)
        .map(({ id, level, code, name }) => ({ id, level, code, name }));
      const meters = snapshot.query({ node: node.id, limit: query.limit, offset: query.offset });

      return {
        data: {
          ...summary(node),
          breadcrumb,
          children: node.children.map(summary),
          meters: [...meters.items],
          page: { total: meters.total, limit: meters.limit, offset: meters.offset },
        },
        meta,
      };
    },
  });

  // -- Search, stats, quality -----------------------------------------------

  registry.add({
    method: "get",
    path: "/v1/search",
    operationId: "search",
    summary: "Search meters, transformers and network nodes at once",
    description: "For a global search box. Case-insensitive substring match.",
    tags: ["Search"],
    auth: true,
    query: s.searchQuery,
    response: s.searchResponse,
    handler: async ({ query, res }) => {
      const { snapshot, meta } = await readCatalog(context, res);
      const needle = query.q.toLowerCase();
      const hit = (...texts: string[]) => texts.some((text) => text.toLowerCase().includes(needle));
      return {
        data: {
          meters: snapshot
            .query({ q: query.q, limit: query.limit })
            .items.map(({ id, serialNumber, status }) => ({ id, serialNumber, status })),
          transformers: snapshot.transformers
            .filter((t) => hit(t.code, t.name, ...t.aliases))
            .slice(0, query.limit)
            .map(({ code, name, aliases }) => ({ code, name, aliases: [...aliases] })),
          nodes: [...snapshot.tree.byId.values()]
            .filter((n) => n.level !== "transformer" && hit(n.code, n.name))
            .slice(0, query.limit)
            .map(({ id, level, code, name }) => ({ id, level, code, name })),
        },
        meta,
      };
    },
  });

  registry.add({
    method: "get",
    path: "/v1/stats",
    operationId: "getStats",
    summary: "Fleet totals for dashboards",
    tags: ["Insights"],
    auth: true,
    query: s.statsQuery,
    response: s.statsResponse,
    handler: async ({ query, res }) => {
      const { snapshot, meta } = await readCatalog(context, res);
      const { facets } = snapshot.query({ limit: 1 });
      const capacities = snapshot.transformers.map((t) => t.capacityKva);
      const groupBy = query.groupBy;
      return {
        data: {
          meters: snapshot.size,
          transformers: snapshot.transformers.length,
          totalCapacityKva: capacities.every((c) => c === null)
            ? null
            : capacities.reduce<number>((sum, c) => sum + (c ?? 0), 0),
          metersWithIssues: snapshot.meters.filter((m) => m.issues.length > 0).length,
          byStatus: facets.status,
          byMake: facets.make,
          byPhase: facets.phase,
          byInstallationType: facets.installationType,
          byBuild: facets.build,
          groupedBy:
            groupBy === undefined
              ? null
              : {
                  field: groupBy,
                  counts: countBy(snapshot.meters, (m) =>
                    isNetworkLevel(groupBy) ? m.network[groupBy].code || "?" : m[groupBy],
                  ),
                },
        },
        meta,
      };
    },
  });

  registry.add({
    method: "get",
    path: "/v1/quality",
    operationId: "getDataQuality",
    summary: "Data-quality report: what is messy in the portal's data and what we did about it",
    tags: ["Insights"],
    auth: true,
    response: s.qualityResponse,
    handler: async ({ res }) => {
      const { snapshot, meta } = await readCatalog(context, res);
      const issues = snapshot.meters.flatMap((m) => m.issues);
      return {
        data: {
          summary: {
            meters: snapshot.size,
            metersWithIssues: snapshot.meters.filter((m) => m.issues.length > 0).length,
            issuesByCode: countBy(issues, (issue) => issue.code),
          },
          transformerNameConflicts: snapshot.transformers
            .filter((t) => t.aliases.length > 0)
            .map((t) => ({ code: t.code, canonicalName: t.name, aliases: [...t.aliases] })),
          scan: snapshot.quality,
        },
        meta,
      };
    },
  });
}

type MeterFilterInput = {
  q?: string | undefined;
  status?: string[] | undefined;
  phase?: string[] | undefined;
  installationType?: string[] | undefined;
  make?: string[] | undefined;
  build?: string[] | undefined;
  node?: string | undefined;
  hasIssues?: boolean | undefined;
} & Partial<Record<NetworkLevel, string | undefined>>;

function toMeterQuery(query: MeterFilterInput): MeterQuery {
  const network: Partial<Record<NetworkLevel, string>> = {};
  for (const level of NETWORK_LEVELS) {
    const code = query[level];
    if (code !== undefined) network[level] = code;
  }
  return {
    ...(query.q !== undefined && { q: query.q }),
    ...(query.status !== undefined && { status: query.status }),
    ...(query.phase !== undefined && { phase: query.phase }),
    ...(query.installationType !== undefined && { installationType: query.installationType }),
    ...(query.make !== undefined && { make: query.make }),
    ...(query.build !== undefined && { build: query.build }),
    ...(query.node !== undefined && { node: query.node }),
    ...(query.hasIssues !== undefined && { hasIssues: query.hasIssues }),
    network,
  };
}

function summary(node: NetworkNode): s.NetworkNodeTree {
  const { id, level, code, name, meterCount, statusCounts } = node;
  return { id, level, code, name, meterCount, statusCounts: { ...statusCounts } };
}

function trim(node: NetworkNode, depth: number): s.NetworkNodeTree {
  return depth <= 1 ? summary(node) : { ...summary(node), children: node.children.map((child) => trim(child, depth - 1)) };
}

function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) counts[key(item)] = (counts[key(item)] ?? 0) + 1;
  return counts;
}

function isNetworkLevel(value: string): value is NetworkLevel {
  return (NETWORK_LEVELS as readonly string[]).includes(value);
}

export type { Meter };
