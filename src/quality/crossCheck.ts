import type { ExportMeter } from "../portal/schemas.js";

export interface FieldDifference {
  readonly meterId: string;
  readonly field: string;
  readonly export: unknown;
  readonly fallback: unknown;
}

export interface CrossCheckReport {
  readonly compared: number;
  readonly onlyInExport: readonly string[];
  readonly onlyInFallback: readonly string[];
  readonly identical: number;
  readonly differences: readonly FieldDifference[];
}

/** Coordinates travel as strings on one path and numbers on the other; agree to ~1 cm. */
const GEO_TOLERANCE_DEG = 1e-7;

/**
 * Compares the two ways of reading the same meters: the signed export and the
 * fallback path (search + detail page + geo). If they agree, the fallback is
 * a safe substitute; if not, the differences say which source to trust for
 * what. `build` is skipped: the fallback path cannot see it.
 */
export function crossCheck(
  exported: readonly ExportMeter[],
  fallback: readonly ExportMeter[],
  options: { restrictToFallback?: boolean } = {},
): CrossCheckReport {
  const byId = new Map(exported.map((m) => [m.meterId, m]));
  const fallbackIds = new Set(fallback.map((m) => m.meterId));
  const differences: FieldDifference[] = [];
  let identical = 0;

  for (const other of fallback) {
    const base = byId.get(other.meterId);
    if (base === undefined) continue;
    const before = differences.length;
    const compare = (field: string, a: unknown, b: unknown) => {
      if (a !== b) differences.push({ meterId: other.meterId, field, export: a, fallback: b });
    };
    for (const field of ["serialNo", "make", "phaseType", "installStatus", "installType", "dtCode"] as const) {
      compare(field, base[field], other[field]);
    }
    for (const axis of ["lat", "lng"] as const) {
      if (Math.abs(base.geo[axis] - other.geo[axis]) > GEO_TOLERANCE_DEG) {
        differences.push({ meterId: other.meterId, field: `geo.${axis}`, export: base.geo[axis], fallback: other.geo[axis] });
      }
    }
    for (const level of Object.keys(base.hierarchy) as (keyof ExportMeter["hierarchy"])[]) {
      compare(`hierarchy.${level}.name`, base.hierarchy[level].name, other.hierarchy[level].name);
      compare(`hierarchy.${level}.code`, base.hierarchy[level].code, other.hierarchy[level].code);
    }
    if (differences.length === before) identical += 1;
  }

  return {
    compared: fallback.filter((m) => byId.has(m.meterId)).length,
    onlyInExport: options.restrictToFallback ? [] : exported.filter((m) => !fallbackIds.has(m.meterId)).map((m) => m.meterId),
    onlyInFallback: fallback.filter((m) => !byId.has(m.meterId)).map((m) => m.meterId),
    identical,
    differences,
  };
}
