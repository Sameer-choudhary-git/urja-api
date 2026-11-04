/**
 * Energy data for the fake portal, and the portal's date-filter rules as
 * measured by `npm run probe` (PROTOCOL.md 3.3). Deliberately written without
 * importing anything from src/, so a bug in our time code cannot hide by
 * appearing on both sides of a test.
 */

export interface FakeEnergyRow {
  timestamp: string;
  kwh: string;
  kvah: string;
  voltR: string;
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * 1 June 2026 00:00 to 30 June 2026 23:30 IST, every 30 minutes: 1440 rows,
 * the same span as the real portal. Usage follows a daily curve plus a
 * per-meter wobble; registers are kept in hundredths so they never drift.
 */
export function generateEnergy(meterId: string): FakeEnergyRow[] {
  const seed = Number(meterId.replace(/\D/g, "")) % 997;
  let kwh = 1_000_000 + seed * 3_217; // hundredths of kWh
  let kvah = Math.round(kwh * 1.08);
  const rows: FakeEnergyRow[] = [];
  for (let day = 1; day <= 30; day += 1) {
    for (let slot = 0; slot < 48; slot += 1) {
      const hour = slot / 2;
      const curve = 0.55 + 0.45 * Math.max(0, Math.sin(((hour - 6) / 24) * 2 * Math.PI));
      const wobble = ((seed * 31 + day * 17 + slot * 7) % 13) / 100;
      const used = Math.round((0.3 + seed / 2_000 + wobble) * curve * 100);
      const pf = 0.86 + ((seed + slot) % 12) / 100; // 0.86 .. 0.97
      kwh += used;
      kvah += Math.round(used / pf);
      rows.push({
        timestamp: `${pad(day)}/06/2026 ${pad(Math.floor(hour))}:${slot % 2 === 0 ? "00" : "30"}`,
        kwh: (kwh / 100).toFixed(2),
        kvah: (kvah / 100).toFixed(2),
        voltR: String(218 + ((seed + slot * 3 + day) % 21)),
      });
    }
  }
  // Like the real portal, some meters are read only once a day (at 00:00).
  return DAILY_METERS.has(meterId) ? rows.filter((row) => row.timestamp.endsWith(" 00:00")) : rows;
}

/** Meters the real portal reads once a day (J100040 seen in the portal UI, 2026-11-04). */
const DAILY_METERS = new Set(["J100040"]);

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const dayOf = (timestamp: string) => `${timestamp.slice(6, 10)}-${timestamp.slice(3, 5)}-${timestamp.slice(0, 2)}`;
const minusDays = (isoDay: string, days: number) =>
  new Date(Date.parse(`${isoDay}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);

/**
 * The real portal's rules (probe, 2026-11-03):
 *  - from/to are whole days, both inclusive; anything not YYYY-MM-DD is ignored;
 *  - only `to`: the 7 days ending on `to`; only `from`: from there to the end;
 *  - neither: the last 7 days plus one reading (337 rows);
 *  - reversed or empty range: [].
 */
export function filterEnergy(rows: readonly FakeEnergyRow[], search: URLSearchParams): FakeEnergyRow[] {
  const valid = (name: string) => {
    const value = search.get(name);
    return value !== null && ISO_DAY.test(value) ? value : null;
  };
  const from = valid("from");
  const to = valid("to");
  if (from === null && to === null) return rows.slice(-337);
  const lower = from ?? minusDays(to as string, 6);
  const upper = to ?? "9999-12-31";
  return rows.filter((row) => {
    const day = dayOf(row.timestamp);
    return day >= lower && day <= upper;
  });
}

/**
 * Encodes a value the way SvelteKit's devalue does for plain data: one flat
 * array, objects and lists hold indexes, repeated primitives are stored once.
 * Written independently of src/portal/devalue.ts, so the decoder is tested
 * against a separate implementation.
 */
export function encodeDevalue(value: unknown): unknown[] {
  const flat: unknown[] = [];
  const seen = new Map<string, number>();
  const encode = (v: unknown): number => {
    if (v !== null && typeof v === "object") {
      const index = flat.length;
      flat.push(null);
      flat[index] = Array.isArray(v)
        ? v.map(encode)
        : Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, child]) => [k, encode(child)]));
      return index;
    }
    const key = JSON.stringify(v);
    const existing = seen.get(key);
    if (existing !== undefined) return existing;
    flat.push(v);
    seen.set(key, flat.length - 1);
    return flat.length - 1;
  };
  encode(value);
  return flat;
}

interface ExportLike {
  meterId: string;
  serialNo: string;
  make: string;
  phaseType: string;
  installStatus: string;
  installType: string;
  dtCode: string;
  geo: { lat: number; lng: number };
  hierarchy: Record<string, { name: string; code: string }>;
}

/** The detail page's data for a meter, as PROTOCOL.md 3.2 shows it (before devalue encoding). */
export function meterPageData(meter: ExportLike): unknown {
  const cell = (level: string) => {
    const node = meter.hierarchy[level] ?? { name: "", code: "" };
    return `${node.name} (${node.code})`;
  };
  return {
    meterId: meter.meterId,
    detail: {
      data: [
        ["Meter ID", meter.meterId],
        ["Serial No", meter.serialNo],
        ["Make", meter.make],
        ["Phase Type", meter.phaseType],
        ["Installation Status", meter.installStatus],
        ["Installation Type", meter.installType],
      ].map(([parameterName, parameterValue]) => ({ parameterName, parameterValue })),
    },
    hierarchy: {
      "Meter ID": meter.meterId,
      "Installation Status": meter.installStatus,
      "Installation Type": meter.installType,
      Zone: cell("zone"),
      Circle: cell("circle"),
      Division: cell("division"),
      Subdivision: cell("subdivision"),
      "Sub Station": cell("substation"),
      Feeder: cell("feeder"),
      DT: cell("dt"),
    },
  };
}
