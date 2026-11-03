import { HIERARCHY_LEVELS, type ExportMeter, type HierarchyLevel, type TransformerRow } from "../portal/schemas.js";
import { createCellRepairer, type CellRepairer } from "./cellRepair.js";
import { NODE_SEPARATOR } from "./meter.js";
import type {
  DataIssue,
  InstallationType,
  Meter,
  MeterStatus,
  NetworkLevel,
  NetworkPosition,
  NetworkRef,
  PhaseType,
  Transformer,
} from "./meter.js";

export interface NormalizedCatalog {
  readonly meters: readonly Meter[];
  readonly transformers: readonly Transformer[];
}

/** The portal says "dt"; our API says "transformer". */
const LEVEL_NAMES: Readonly<Record<HierarchyLevel, NetworkLevel>> = {
  zone: "zone",
  circle: "circle",
  division: "division",
  subdivision: "subdivision",
  substation: "substation",
  feeder: "feeder",
  dt: "transformer",
};

const STATUS: Readonly<Record<string, MeterStatus>> = {
  installed: "installed",
  faulty: "faulty",
  decommissioned: "decommissioned",
};
const PHASE: Readonly<Record<string, PhaseType>> = { single: "single", three: "three" };
const INSTALLATION: Readonly<Record<string, InstallationType>> = {
  "whole current": "whole_current",
  "ct operated": "ct_operated",
};

/** Placeholder in a network path where a code is blank and could not be repaired. */
export const UNKNOWN_CODE = "?";

/**
 * Turns raw portal records into the domain model.
 *
 * Decisions (also in the README, "Design decisions"):
 *  - A blank hierarchy name or code is filled only when the other side maps to
 *    exactly one value elsewhere in the export. Otherwise it stays blank and
 *    the meter carries a `network_cell_missing` issue.
 *  - A transformer's canonical name comes from `/portal/dts` (the dedicated
 *    transformer list). Without it, the name most meters use wins, ties broken
 *    alphabetically so the result is deterministic. Other names become aliases,
 *    and the affected meters carry a `transformer_name_conflict` issue.
 *  - Unknown enum values map to "unknown" with an issue, instead of failing the
 *    whole catalog because of one odd record.
 *
 * Pure: same input, same output. `transformerRows` may be null when
 * `/portal/dts` was unavailable; the catalog still works, just without
 * capacities.
 */
export function normalizeCatalog(
  exportMeters: readonly ExportMeter[],
  transformerRows: readonly TransformerRow[] | null,
): NormalizedCatalog {
  const repairer = createCellRepairer(exportMeters);
  const rowsByCode = new Map((transformerRows ?? []).map((row) => [row.code, row]));
  const names = canonicalTransformerNames(exportMeters, repairer, rowsByCode);

  const meters = exportMeters
    .map((raw) => toMeter(raw, repairer, names))
    .sort((a, b) => a.id.localeCompare(b.id));

  return { meters, transformers: buildTransformers(meters, rowsByCode, names) };
}

interface TransformerNames {
  readonly canonical: ReadonlyMap<string, string>;
  readonly aliases: ReadonlyMap<string, readonly string[]>;
}

function canonicalTransformerNames(
  exportMeters: readonly ExportMeter[],
  repairer: CellRepairer,
  rowsByCode: ReadonlyMap<string, TransformerRow>,
): TransformerNames {
  const canonical = new Map<string, string>();
  const aliases = new Map<string, string[]>();
  const codes = new Set([...exportMeters.map((m) => m.dtCode), ...rowsByCode.keys()]);

  for (const code of codes) {
    const seen = repairer.namesFor("dt", code);
    const byUsage = [...seen.entries()].sort(([a, n], [b, m]) => m - n || a.localeCompare(b));
    const chosen = rowsByCode.get(code)?.name || byUsage[0]?.[0];
    if (chosen === undefined) continue;
    canonical.set(code, chosen);
    aliases.set(
      code,
      byUsage.map(([name]) => name).filter((name) => name !== chosen),
    );
  }
  return { canonical, aliases };
}

function toMeter(raw: ExportMeter, repairer: CellRepairer, names: TransformerNames): Meter {
  const issues: DataIssue[] = [];
  const position: Partial<Record<NetworkLevel, NetworkRef>> = {};

  for (const level of HIERARCHY_LEVELS) {
    const cell = raw.hierarchy[level];
    const field = `network.${LEVEL_NAMES[level]}`;
    const fixed = repairer.repair(level, cell.name, cell.code);

    if (fixed.outcome === "repaired") {
      const side = cell.code === "" ? "code" : "name";
      const value = side === "code" ? fixed.code : fixed.name;
      issues.push({
        code: "network_cell_repaired",
        field,
        detail: `Blank ${side} filled as "${value}" from other meters`,
      });
    } else if (fixed.outcome === "missing") {
      issues.push({
        code: "network_cell_missing",
        field,
        detail: "Blank in the portal and not recoverable from other meters",
      });
    }

    let { name, code } = fixed;
    if (level === "dt") {
      code ||= raw.dtCode;
      const canonical = names.canonical.get(code);
      if (canonical !== undefined && canonical !== name) {
        if (name !== "") {
          issues.push({
            code: "transformer_name_conflict",
            field,
            detail: `Portal export calls it "${name}"; canonical name is "${canonical}"`,
          });
        }
        name = canonical;
      }
    }
    position[LEVEL_NAMES[level]] = { code, name };
  }

  const network = {
    ...(position as Record<NetworkLevel, NetworkRef>),
    path: HIERARCHY_LEVELS.map((level) => position[LEVEL_NAMES[level]]?.code || UNKNOWN_CODE).join(NODE_SEPARATOR),
  } satisfies NetworkPosition;

  return {
    id: raw.meterId,
    serialNumber: raw.serialNo,
    make: raw.make,
    phase: mapEnum(PHASE, raw.phaseType, "phase", issues),
    status: mapEnum(STATUS, raw.installStatus, "status", issues),
    installationType: mapEnum(INSTALLATION, raw.installType, "installationType", issues),
    build: raw.build,
    location: { lat: raw.geo.lat, lng: raw.geo.lng },
    network,
    issues,
  };
}

function mapEnum<T extends string>(
  table: Readonly<Record<string, T>>,
  raw: string,
  field: string,
  issues: DataIssue[],
): T | "unknown" {
  const mapped = table[raw.trim().toLowerCase()];
  if (mapped !== undefined) return mapped;
  issues.push({ code: "unknown_value", field, detail: `Unrecognised portal value "${raw}"` });
  return "unknown";
}

function buildTransformers(
  meters: readonly Meter[],
  rowsByCode: ReadonlyMap<string, TransformerRow>,
  names: TransformerNames,
): Transformer[] {
  const metersByCode = new Map<string, Meter[]>();
  for (const meter of meters) {
    const code = meter.network.transformer.code;
    metersByCode.set(code, [...(metersByCode.get(code) ?? []), meter]);
  }

  const codes = new Set([...metersByCode.keys(), ...rowsByCode.keys()]);
  return [...codes]
    .filter((code) => code !== "")
    .sort()
    .map((code) => {
      const own = metersByCode.get(code) ?? [];
      const row = rowsByCode.get(code);
      return {
        code,
        name: names.canonical.get(code) ?? row?.name ?? "",
        aliases: names.aliases.get(code) ?? [],
        capacityKva: row?.capacityKva ?? null,
        feederCode: row?.feederCode ?? own[0]?.network.feeder.code ?? "",
        networkPath: mostCommon(own.map((m) => m.network.path)) ?? "",
        meterCount: own.length,
      };
    });
}

function mostCommon(values: readonly string[]): string | undefined {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort(([a, n], [b, m]) => m - n || a.localeCompare(b))[0]?.[0];
}
