/**
 * The clean domain model our API speaks. Nothing here knows the portal's
 * spelling ("Installed", "CT Operated", "Name (Code)", strings for numbers);
 * the translation lives in `normalize.ts`, the one place that sees both sides.
 */

export const NETWORK_LEVELS = [
  "zone",
  "circle",
  "division",
  "subdivision",
  "substation",
  "feeder",
  "transformer",
] as const;
export type NetworkLevel = (typeof NETWORK_LEVELS)[number];

export const METER_STATUSES = ["installed", "faulty", "decommissioned"] as const;
export type MeterStatus = (typeof METER_STATUSES)[number] | "unknown";

export const PHASE_TYPES = ["single", "three"] as const;
export type PhaseType = (typeof PHASE_TYPES)[number] | "unknown";

export const INSTALLATION_TYPES = ["whole_current", "ct_operated"] as const;
export type InstallationType = (typeof INSTALLATION_TYPES)[number] | "unknown";

export interface NetworkRef {
  readonly code: string;
  readonly name: string;
}

/** Joins codes into a network node id. Codes never contain ".", and a dot-joined id fits in one URL segment. */
export const NODE_SEPARATOR = ".";

/**
 * Where a meter sits, top (zone) to bottom (transformer).
 *
 * `path` is the stable key of the transformer's position: the codes from zone
 * to transformer joined with "." (e.g. "Z-01.C-01.D-07.SD-07.SS-07.F-007.DT-007"). Codes alone are NOT unique below circle
 * (e.g. D-01 sits under three circles), so a node is identified by its path.
 */
export type NetworkPosition = { readonly [L in NetworkLevel]: NetworkRef } & {
  readonly path: string;
};

export type DataIssueCode =
  /** A blank hierarchy name/code filled from other meters (name and code map 1:1). */
  | "network_cell_repaired"
  /** A blank hierarchy cell nothing else could confirm; left empty. */
  | "network_cell_missing"
  /** The portal used a different name for this meter's transformer; we use the canonical one. */
  | "transformer_name_conflict"
  /** An enum-like field had a value we have never seen; mapped to "unknown". */
  | "unknown_value";

export interface DataIssue {
  readonly code: DataIssueCode;
  readonly field: string;
  readonly detail: string;
}

export interface Meter {
  readonly id: string;
  readonly serialNumber: string;
  readonly make: string;
  readonly phase: PhaseType;
  readonly status: MeterStatus;
  readonly installationType: InstallationType;
  /** Portal's `build` field ("legacy" | "v2" so far). Meaning unknown; passed through as-is. */
  readonly build: string;
  readonly location: { readonly lat: number; readonly lng: number };
  readonly network: NetworkPosition;
  /** Everything we changed or could not trust about this record. Empty for clean records. */
  readonly issues: readonly DataIssue[];
}

export interface Transformer {
  readonly code: string;
  /** Canonical name (see normalize.ts for how conflicts are resolved). */
  readonly name: string;
  /** Other names the portal used for the same code. */
  readonly aliases: readonly string[];
  /** From /portal/dts; null when that source was unavailable or did not list this code. */
  readonly capacityKva: number | null;
  readonly feederCode: string;
  readonly networkPath: string;
  readonly meterCount: number;
}
