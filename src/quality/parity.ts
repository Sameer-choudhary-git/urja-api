import type { EnergyRow, ExportMeter, TransformerRow } from "../portal/schemas.js";
import { HIERARCHY_LEVELS } from "../portal/schemas.js";
import { parsePortalTimestamp, toIstIso } from "../domain/time.js";

/**
 * Parity check: does the API return everything the portal has, unchanged?
 *
 * Used by `npm run verify` against the REAL portal and a running API. These
 * functions are pure (portal data in, API data in, differences out) so they
 * are unit-tested without a network.
 *
 * Two kinds of difference are kept apart:
 *  - EXPLAINED: the API changed a value on purpose and says so on the record
 *    (an entry in the meter's `issues` for that field, e.g. a repaired
 *    hierarchy cell, or a reading issue such as a dropped duplicate);
 *  - UNEXPLAINED: anything else. Those are bugs (or a portal change) and make
 *    the script exit non-zero.
 */

export interface ParityDifference {
  readonly subject: string;
  readonly field: string;
  readonly portal: unknown;
  readonly api: unknown;
  readonly explained: boolean;
}

export interface SetComparison {
  readonly portalCount: number;
  readonly apiCount: number;
  readonly missingInApi: string[];
  readonly extraInApi: string[];
}

/** The parts of an API meter (GET /v1/meters) the check reads. */
export interface ApiMeterLike {
  readonly id: string;
  readonly serialNumber: string;
  readonly make: string;
  readonly phase: string;
  readonly status: string;
  readonly installationType: string;
  readonly build: string;
  readonly location: { readonly lat: number; readonly lng: number };
  readonly network: Record<string, { readonly code: string; readonly name: string }>;
  readonly issues: readonly { readonly code: string; readonly field: string }[];
}

export interface ApiTransformerLike {
  readonly code: string;
  readonly name: string;
  readonly capacityKva: number | null;
  readonly feederCode: string;
}

/** "Whole Current", "whole-current" and "whole_current" are the same value; the API uses snake_case. */
const loose = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");

const API_LEVEL: Record<(typeof HIERARCHY_LEVELS)[number], string> = {
  zone: "zone",
  circle: "circle",
  division: "division",
  subdivision: "subdivision",
  substation: "substation",
  feeder: "feeder",
  dt: "transformer",
};

function compareSets(portalIds: readonly string[], apiIds: readonly string[]): SetComparison {
  const portal = new Set(portalIds);
  const api = new Set(apiIds);
  return {
    portalCount: portal.size,
    apiCount: api.size,
    missingInApi: [...portal].filter((id) => !api.has(id)).sort(),
    extraInApi: [...api].filter((id) => !portal.has(id)).sort(),
  };
}

/** Every meter of the signed export against GET /v1/meters, field by field. */
export function compareMeters(
  portal: readonly ExportMeter[],
  api: readonly ApiMeterLike[],
): { set: SetComparison; differences: ParityDifference[] } {
  const byId = new Map(api.map((m) => [m.id, m]));
  const differences: ParityDifference[] = [];

  for (const p of portal) {
    const a = byId.get(p.meterId);
    if (a === undefined) continue;
    const explainedFields = new Set(a.issues.map((i) => i.field));
    const check = (field: string, portalValue: unknown, apiValue: unknown, same: boolean) => {
      if (!same) differences.push({ subject: p.meterId, field, portal: portalValue, api: apiValue, explained: explainedFields.has(field) });
    };

    check("serialNumber", p.serialNo, a.serialNumber, p.serialNo === a.serialNumber);
    check("make", p.make, a.make, p.make === a.make);
    check("build", p.build, a.build, p.build === a.build);
    check("phase", p.phaseType, a.phase, loose(p.phaseType) === loose(a.phase));
    check("status", p.installStatus, a.status, loose(p.installStatus) === loose(a.status));
    check("installationType", p.installType, a.installationType, loose(p.installType) === loose(a.installationType));
    check("location.lat", p.geo.lat, a.location.lat, p.geo.lat === a.location.lat);
    check("location.lng", p.geo.lng, a.location.lng, p.geo.lng === a.location.lng);
    check("network.transformer.code", p.dtCode, a.network.transformer?.code, p.dtCode.toUpperCase() === a.network.transformer?.code.toUpperCase());

    for (const level of HIERARCHY_LEVELS) {
      const field = `network.${API_LEVEL[level]}`;
      const portalNode = p.hierarchy[level];
      const apiNode = a.network[API_LEVEL[level]];
      check(`${field}.code`, portalNode.code, apiNode?.code, portalNode.code === apiNode?.code);
      check(`${field}.name`, portalNode.name, apiNode?.name, portalNode.name === apiNode?.name);
    }
  }
  // An issue on "network.zone" explains both network.zone.code and network.zone.name.
  return {
    set: compareSets(portal.map((m) => m.meterId), api.map((m) => m.id)),
    differences: differences.map((d) => (d.explained ? d : { ...d, explained: byId.get(d.subject)?.issues.some((i) => d.field.startsWith(`${i.field}.`)) ?? false })),
  };
}

/** GET /portal/dts against GET /v1/transformers. */
export function compareTransformers(
  portal: readonly TransformerRow[],
  api: readonly ApiTransformerLike[],
): { set: SetComparison; differences: ParityDifference[] } {
  const byCode = new Map(api.map((t) => [t.code.toUpperCase(), t]));
  const differences: ParityDifference[] = [];
  for (const p of portal) {
    const a = byCode.get(p.code.toUpperCase());
    if (a === undefined) continue;
    const add = (field: string, portalValue: unknown, apiValue: unknown) =>
      portalValue !== apiValue && differences.push({ subject: p.code, field, portal: portalValue, api: apiValue, explained: false });
    add("name", p.name, a.name);
    add("capacityKva", p.capacityKva, a.capacityKva);
    add("feederCode", p.feederCode, a.feederCode);
  }
  return { set: compareSets(portal.map((t) => t.code.toUpperCase()), api.map((t) => t.code.toUpperCase())), differences };
}

/** The parts of a raw API reading (GET /v1/meters/{id}/readings?granularity=raw) the check reads. */
export interface ApiReadingLike {
  readonly timestamp: string;
  readonly kwhRegister: number;
  readonly kvahRegister: number;
  readonly voltageR: number;
  readonly intervalKwh: number | null;
}

export interface ReadingsParity {
  readonly meterId: string;
  readonly portalRows: number;
  readonly apiRows: number;
  /** Portal rows with no API reading at the same time, minus those the API reported as dropped. */
  readonly missingInApi: string[];
  /** Rows the API left out on purpose and reported as reading issues (bad timestamp, conflicting duplicate). */
  readonly droppedAndReported: number;
  readonly extraInApi: string[];
  readonly differences: ParityDifference[];
  /** Sum of the API's interval usage vs last register - first register. Equal unless a register went down. */
  readonly usage: { readonly apiSum: number; readonly registerDelta: number; readonly matches: boolean } | null;
  /** The usual minutes between portal readings: 30, or 1440 for a meter read once a day. */
  readonly cadenceMinutes: number | null;
}

/**
 * Every portal energy row against the API's raw readings for the same meter.
 * `apiIssueCodes` are the reading issues the API reported, used to explain
 * rows it dropped on purpose.
 */
export function compareReadings(
  meterId: string,
  portal: readonly EnergyRow[],
  api: readonly ApiReadingLike[],
  apiIssueCodes: readonly string[],
): ReadingsParity {
  const apiByTime = new Map(api.map((r) => [r.timestamp, r]));
  const differences: ParityDifference[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  let dropped = 0;

  const badTimestamps = apiIssueCodes.filter((c) => c === "bad_timestamp").length;
  const duplicates = apiIssueCodes.filter((c) => c === "duplicate_reading").length;
  let badSeen = 0;
  let dupSeen = 0;

  for (const row of portal) {
    const at = parsePortalTimestamp(row.timestamp);
    if (at === null) {
      if (badSeen < badTimestamps) {
        badSeen += 1;
        dropped += 1;
      } else missing.push(row.timestamp);
      continue;
    }
    const iso = toIstIso(at);
    if (seen.has(iso)) {
      // Same time twice: the API keeps the first and reports a conflicting second one.
      const first = apiByTime.get(iso);
      const identical = first !== undefined && Number(row.kwh) === first.kwhRegister && Number(row.kvah) === first.kvahRegister;
      if (identical) dropped += 1;
      else if (dupSeen < duplicates) {
        dupSeen += 1;
        dropped += 1;
      } else missing.push(row.timestamp);
      continue;
    }
    seen.add(iso);
    const a = apiByTime.get(iso);
    if (a === undefined) {
      missing.push(row.timestamp);
      continue;
    }
    const add = (field: string, portalValue: number, apiValue: number) =>
      portalValue !== apiValue && differences.push({ subject: `${meterId} ${row.timestamp}`, field, portal: portalValue, api: apiValue, explained: false });
    add("kwh", Number(row.kwh), a.kwhRegister);
    add("kvah", Number(row.kvah), a.kvahRegister);
    add("voltR", Number(row.voltR), a.voltageR);
  }

  const extra = api.filter((r) => !seen.has(r.timestamp)).map((r) => r.timestamp);

  let usage: ReadingsParity["usage"] = null;
  if (api.length >= 2) {
    const sorted = [...api].sort((x, y) => Date.parse(x.timestamp) - Date.parse(y.timestamp));
    const apiSum = round(sorted.slice(1).reduce((sum, r) => sum + (r.intervalKwh ?? 0), 0));
    const registerDelta = round(sorted.at(-1)!.kwhRegister - sorted[0]!.kwhRegister);
    usage = { apiSum, registerDelta, matches: apiSum === registerDelta || apiIssueCodes.includes("register_decreased") };
  }

  return {
    meterId,
    portalRows: portal.length,
    apiRows: api.length,
    missingInApi: missing,
    droppedAndReported: dropped,
    extraInApi: extra,
    differences,
    usage,
    cadenceMinutes: cadence(api.map((r) => Date.parse(r.timestamp))),
  };
}

const round = (value: number) => Math.round(value * 100) / 100;

function cadence(times: readonly number[]): number | null {
  const steps = times
    .slice(1)
    .map((t, i) => t - times[i]!)
    .filter((s) => s > 0)
    .sort((a, b) => a - b);
  return steps.length === 0 ? null : steps[Math.floor(steps.length / 2)]! / 60_000;
}
