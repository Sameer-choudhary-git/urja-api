import { createCellRepairer } from "../domain/cellRepair.js";
import { HIERARCHY_LEVELS, type ExportMeter, type HierarchyLevel } from "../portal/schemas.js";

/**
 * Data-quality scan over the portal's bulk export.
 *
 * Pure function: meters in, report out. It is used by `scripts/scan-export.ts`
 * today, and will back the `/v1/quality` endpoint later, so the API reports
 * the portal's messiness openly instead of hiding it.
 *
 * Every finding is computed from the data; nothing is assumed from names or
 * numbering (e.g. we never assume "DT-007" belongs to "Feeder 7").
 */
export interface QualityReport {
  readonly meterCount: number;
  readonly distributions: Readonly<Record<DistributionField, Readonly<Record<string, number>>>>;
  readonly ids: {
    readonly duplicateMeterIds: readonly string[];
    readonly duplicateSerials: readonly string[];
    /** Numeric gaps in J1xxxxx IDs between the lowest and highest seen. */
    readonly missingInSequence: readonly string[];
    readonly first: string | null;
    readonly last: string | null;
  };
  readonly hierarchy: {
    /** Cells where the name or the code is an empty string. */
    readonly blankCells: readonly BlankCell[];
    /** One code used with several different names (e.g. DT-007). */
    readonly codeWithManyNames: readonly CodeNameConflict[];
    /** One name used with several different codes. */
    readonly nameWithManyCodes: readonly NameCodeConflict[];
    /** A code that appears under more than one parent code: the codes alone do not form a tree. */
    readonly codeWithManyParents: readonly ParentConflict[];
    /**
     * DTs whose meters disagree on the full path above the DT (zone..feeder).
     * Empty means "the DT determines the whole path", which is what lets us
     * build the network tree keyed by path. Meters with a blank cell are skipped.
     */
    readonly dtWithManyPaths: readonly { dtCode: string; paths: readonly string[] }[];
    /** `dtCode` at the top level disagrees with `hierarchy.dt.code`. */
    readonly dtCodeMismatches: readonly { meterId: string; dtCode: string; hierarchyDtCode: string }[];
  };
  readonly geo: {
    readonly minLat: number | null;
    readonly maxLat: number | null;
    readonly minLng: number | null;
    readonly maxLng: number | null;
    /** Outside valid lat/lng ranges, or exactly (0, 0). */
    readonly invalid: readonly string[];
  };
}

export const DISTRIBUTION_FIELDS = [
  "make",
  "phaseType",
  "installStatus",
  "installType",
  "build",
] as const;
export type DistributionField = (typeof DISTRIBUTION_FIELDS)[number];

export interface BlankCell {
  readonly meterId: string;
  readonly level: HierarchyLevel;
  readonly missing: "name" | "code" | "both";
  /** The value we can fill in because name and code map 1:1 elsewhere in the data, if any. */
  readonly repairableTo: string | null;
}

export interface CodeNameConflict {
  readonly level: HierarchyLevel;
  readonly code: string;
  /** name -> meter IDs using it */
  readonly names: Readonly<Record<string, readonly string[]>>;
}

export interface NameCodeConflict {
  readonly level: HierarchyLevel;
  readonly name: string;
  readonly codes: readonly string[];
}

export interface ParentConflict {
  readonly level: HierarchyLevel;
  readonly code: string;
  readonly parentLevel: HierarchyLevel;
  readonly parentCodes: readonly string[];
}

export function scanExport(meters: readonly ExportMeter[]): QualityReport {
  return {
    meterCount: meters.length,
    distributions: distributions(meters),
    ids: idFindings(meters),
    hierarchy: hierarchyFindings(meters),
    geo: geoFindings(meters),
  };
}

function distributions(meters: readonly ExportMeter[]): QualityReport["distributions"] {
  const result = {} as Record<DistributionField, Record<string, number>>;
  for (const field of DISTRIBUTION_FIELDS) {
    const counts: Record<string, number> = {};
    for (const meter of meters) {
      counts[meter[field]] = (counts[meter[field]] ?? 0) + 1;
    }
    result[field] = sortByCountDesc(counts);
  }
  return result;
}

function idFindings(meters: readonly ExportMeter[]): QualityReport["ids"] {
  const ids = meters.map((m) => m.meterId);
  const numeric = ids
    .map((id) => /^J(\d+)$/.exec(id)?.[1])
    .filter((n): n is string => n !== undefined)
    .map(Number)
    .sort((a, b) => a - b);

  const missing: string[] = [];
  const present = new Set(numeric);
  const low = numeric[0];
  const high = numeric[numeric.length - 1];
  if (low !== undefined && high !== undefined) {
    for (let n = low; n <= high; n += 1) {
      if (!present.has(n)) missing.push(`J${n}`);
    }
  }

  return {
    duplicateMeterIds: duplicates(ids),
    duplicateSerials: duplicates(meters.map((m) => m.serialNo)),
    missingInSequence: missing,
    first: low === undefined ? null : `J${low}`,
    last: high === undefined ? null : `J${high}`,
  };
}

function hierarchyFindings(meters: readonly ExportMeter[]): QualityReport["hierarchy"] {
  const codeToNames = new Map<string, Map<string, string[]>>(); // `${level}|${code}` -> name -> ids
  const nameToCodes = new Map<string, Set<string>>(); // `${level}|${name}` -> codes
  const parents = new Map<string, Set<string>>(); // `${level}|${code}` -> parent codes

  for (const meter of meters) {
    HIERARCHY_LEVELS.forEach((level, index) => {
      const { name, code } = meter.hierarchy[level];
      if (name !== "" && code !== "") {
        const byName = getOrInit(codeToNames, `${level}|${code}`, () => new Map<string, string[]>());
        getOrInit(byName, name, () => []).push(meter.meterId);
        getOrInit(nameToCodes, `${level}|${name}`, () => new Set<string>()).add(code);
      }
      const parentLevel = HIERARCHY_LEVELS[index - 1];
      if (parentLevel !== undefined && code !== "") {
        const parentCode = meter.hierarchy[parentLevel].code;
        if (parentCode !== "") {
          getOrInit(parents, `${level}|${code}`, () => new Set<string>()).add(parentCode);
        }
      }
    });
  }

  const repairer = createCellRepairer(meters);
  const blankCells: BlankCell[] = [];
  for (const meter of meters) {
    for (const level of HIERARCHY_LEVELS) {
      const { name, code } = meter.hierarchy[level];
      if (name !== "" && code !== "") continue;
      const missing = name === "" && code === "" ? "both" : name === "" ? "name" : "code";
      const fixed = repairer.repair(level, name, code);
      blankCells.push({
        meterId: meter.meterId,
        level,
        missing,
        repairableTo:
          fixed.outcome !== "repaired" ? null : missing === "code" ? fixed.code : fixed.name,
      });
    }
  }

  const codeWithManyNames: CodeNameConflict[] = [];
  for (const [key, byName] of codeToNames) {
    if (byName.size < 2) continue;
    const [level, code] = splitKey(key);
    codeWithManyNames.push({ level, code, names: Object.fromEntries(byName) });
  }

  const nameWithManyCodes: NameCodeConflict[] = [];
  for (const [key, codes] of nameToCodes) {
    if (codes.size < 2) continue;
    const [level, name] = splitKey(key);
    nameWithManyCodes.push({ level, name, codes: [...codes].sort() });
  }

  const codeWithManyParents: ParentConflict[] = [];
  for (const [key, parentCodes] of parents) {
    if (parentCodes.size < 2) continue;
    const [level, code] = splitKey(key);
    const parentLevel = HIERARCHY_LEVELS[HIERARCHY_LEVELS.indexOf(level) - 1];
    if (parentLevel === undefined) continue;
    codeWithManyParents.push({ level, code, parentLevel, parentCodes: [...parentCodes].sort() });
  }

  const pathsByDt = new Map<string, Set<string>>();
  for (const meter of meters) {
    const above = HIERARCHY_LEVELS.slice(0, -1).map((level) => meter.hierarchy[level].code);
    if (above.includes("")) continue;
    getOrInit(pathsByDt, meter.dtCode, () => new Set<string>()).add(above.join(" > "));
  }
  const dtWithManyPaths = [...pathsByDt]
    .filter(([, paths]) => paths.size > 1)
    .map(([dtCode, paths]) => ({ dtCode, paths: [...paths].sort() }));

  const dtCodeMismatches = meters
    .filter((m) => m.hierarchy.dt.code !== "" && m.dtCode !== m.hierarchy.dt.code)
    .map((m) => ({ meterId: m.meterId, dtCode: m.dtCode, hierarchyDtCode: m.hierarchy.dt.code }));

  return {
    blankCells,
    codeWithManyNames,
    nameWithManyCodes,
    codeWithManyParents: codeWithManyParents.sort(
      (a, b) =>
        HIERARCHY_LEVELS.indexOf(a.level) - HIERARCHY_LEVELS.indexOf(b.level) ||
        a.code.localeCompare(b.code),
    ),
    dtWithManyPaths,
    dtCodeMismatches,
  };
}

function geoFindings(meters: readonly ExportMeter[]): QualityReport["geo"] {
  const valid = meters.filter(({ geo }) => isValidCoordinate(geo.lat, geo.lng));
  const lats = valid.map((m) => m.geo.lat);
  const lngs = valid.map((m) => m.geo.lng);
  return {
    minLat: lats.length ? Math.min(...lats) : null,
    maxLat: lats.length ? Math.max(...lats) : null,
    minLng: lngs.length ? Math.min(...lngs) : null,
    maxLng: lngs.length ? Math.max(...lngs) : null,
    invalid: meters.filter(({ geo }) => !isValidCoordinate(geo.lat, geo.lng)).map((m) => m.meterId),
  };
}

function isValidCoordinate(lat: number, lng: number): boolean {
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 && !(lat === 0 && lng === 0);
}

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) repeated.add(value);
    seen.add(value);
  }
  return [...repeated].sort();
}

function sortByCountDesc(counts: Record<string, number>): Record<string, number> {
  return Object.fromEntries(Object.entries(counts).sort(([, a], [, b]) => b - a));
}

function getOrInit<K, V>(map: Map<K, V>, key: K, init: () => V): V {
  let value = map.get(key);
  if (value === undefined) {
    value = init();
    map.set(key, value);
  }
  return value;
}

function splitKey(key: string): [HierarchyLevel, string] {
  const separator = key.indexOf("|");
  return [key.slice(0, separator) as HierarchyLevel, key.slice(separator + 1)];
}
