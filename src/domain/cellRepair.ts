import { HIERARCHY_LEVELS, type ExportMeter, type HierarchyLevel } from "../portal/schemas.js";

export interface CellRepairResult {
  readonly name: string;
  readonly code: string;
  /** "clean": nothing was blank · "repaired": a blank side was filled · "missing": could not fill. */
  readonly outcome: "clean" | "repaired" | "missing";
}

export interface CellRepairer {
  repair(level: HierarchyLevel, name: string, code: string): CellRepairResult;
  /** Every name seen with this code at this level (complete cells only). */
  namesFor(level: HierarchyLevel, code: string): ReadonlyMap<string, number>;
}

/**
 * Learns, from every COMPLETE hierarchy cell in the export, which names go
 * with which codes. A blank side is filled only when the other side maps to
 * exactly one value everywhere else, so we never guess between two options.
 *
 * Shared by the domain normaliser and the data-quality scan, so the API and
 * the scan report always agree on what is repairable.
 */
export function createCellRepairer(meters: readonly ExportMeter[]): CellRepairer {
  const codeToNames = new Map<string, Map<string, number>>(); // `${level}|${code}` -> name -> count
  const nameToCodes = new Map<string, Set<string>>(); // `${level}|${name}` -> codes

  for (const meter of meters) {
    for (const level of HIERARCHY_LEVELS) {
      const { name, code } = meter.hierarchy[level];
      if (name === "" || code === "") continue;
      const names = codeToNames.get(`${level}|${code}`) ?? new Map<string, number>();
      names.set(name, (names.get(name) ?? 0) + 1);
      codeToNames.set(`${level}|${code}`, names);
      const codes = nameToCodes.get(`${level}|${name}`) ?? new Set<string>();
      codes.add(code);
      nameToCodes.set(`${level}|${name}`, codes);
    }
  }

  return {
    namesFor: (level, code) => codeToNames.get(`${level}|${code}`) ?? new Map(),

    repair(level, name, code) {
      if (name !== "" && code !== "") return { name, code, outcome: "clean" };

      if (name === "" && code !== "") {
        const names = codeToNames.get(`${level}|${code}`);
        const only = names?.size === 1 ? [...names.keys()][0] : undefined;
        return only === undefined
          ? { name, code, outcome: "missing" }
          : { name: only, code, outcome: "repaired" };
      }

      if (code === "" && name !== "") {
        const codes = nameToCodes.get(`${level}|${name}`);
        const only = codes?.size === 1 ? [...codes][0] : undefined;
        return only === undefined
          ? { name, code, outcome: "missing" }
          : { name, code: only, outcome: "repaired" };
      }

      return { name, code, outcome: "missing" };
    },
  };
}
