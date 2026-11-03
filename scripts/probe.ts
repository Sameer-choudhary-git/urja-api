/**
 * Live, read-only probe for the questions PROTOCOL.md section 6 still lists
 * as open. It only sends requests a logged-in user's browser could send.
 *
 *   npm run probe
 *   npm run probe > probe-report.txt
 *
 * Prints no secrets: the signing secret is shown only as a short SHA-256
 * fingerprint, which is enough to tell whether two secrets are equal.
 *
 * Deliberately NOT probed: how old an x-timestamp the server accepts. Finding
 * that out means sending deliberately stale signatures, which is closer to
 * testing the portal's defences than to using it.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { loadPortalConfig } from "../src/config.js";
import { noopLogger } from "../src/logger.js";
import { createPortal } from "../src/portal/createPortal.js";
import { PortalError } from "../src/portal/errors.js";
import { EXPORT_PATH, KEYS_PATH } from "../src/portal/exportApi.js";
import { toQueryString, type PortalClient, type QueryParams } from "../src/portal/portalClient.js";
import { keysResponseSchema } from "../src/portal/schemas.js";
import { signRequest } from "../src/portal/signing.js";

const config = loadPortalConfig();
const anything = z.unknown();

const energySchema = z.object({ data: z.array(z.record(z.string(), z.unknown())) });
const dtPageSchema = z.object({
  data: z.array(z.object({ code: z.string(), name: z.string() }).loose()),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
});

function heading(title: string): void {
  console.log(`\n=== ${title}`);
}

function fingerprint(secret: string): string {
  return createHash("sha256").update(secret).digest("hex").slice(0, 12);
}

async function attempt<T>(label: string, run: () => Promise<T>): Promise<T | undefined> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof PortalError) {
      console.log(`  ${label}: ${error.code} (HTTP ${error.upstreamStatus ?? "-"}) ${error.message}`);
    } else {
      console.log(`  ${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
    return undefined;
  }
}

async function secretOf(client: PortalClient): Promise<string> {
  return (await client.get(KEYS_PATH, keysResponseSchema)).data.signingSecret;
}

// ---------------------------------------------------------------------------
heading("1. Signing secret lifecycle");
const sessionA = createPortal(config, noopLogger);
const sessionB = createPortal(config, noopLogger); // separate SessionManager = separate login
const a1 = await secretOf(sessionA.client);
const a2 = await secretOf(sessionA.client);
const b1 = await secretOf(sessionB.client);
console.log(`  session A, call 1: ${fingerprint(a1)} (length ${a1.length})`);
console.log(`  session A, call 2: ${fingerprint(a2)}`);
console.log(`  session B, call 1: ${fingerprint(b1)}`);
console.log(
  `  => same within a session: ${a1 === a2}; same across logins: ${a1 === b1}` +
    (a1 === a2 && a1 === b1
      ? " (secret looks fixed, at least per user)"
      : a1 === a2
        ? " (secret looks per session)"
        : " (secret changes on every call)"),
);

// ---------------------------------------------------------------------------
heading("2. Export pagination (page=1, page=2, page=0)");
const { client } = sessionA;
for (const page of [1, 2, 0]) {
  await attempt(`page=${page}`, async () => {
    const body = await client.get(EXPORT_PATH, anything, { page }, {
      headers: async () =>
        signRequest({
          method: "GET",
          path: EXPORT_PATH,
          query: toQueryString({ page }),
          secret: await secretOf(client),
        }),
    });
    const shape = body as { data?: unknown[]; total?: unknown; page?: unknown };
    console.log(
      `  page=${page}: ${Array.isArray(shape.data) ? shape.data.length : "no data array"} items, ` +
        `total=${String(shape.total)}, keys=${Object.keys(body as object).join(",")}`,
    );
  });
}

// ---------------------------------------------------------------------------
heading("3. Energy response shape by build and phase");
const samples = [
  ["J100000", "legacy, single"],
  ["J100005", "legacy, three"],
  ["J100004", "v2, single"],
  ["J100013", "v2, three"],
] as const;
const windows = new Map<string, string>();
for (const [meterId, note] of samples) {
  await attempt(meterId, async () => {
    const { data } = await client.get(`/portal/meters/${meterId}/energy`, energySchema);
    const first = data[0];
    const last = data[data.length - 1];
    const window = `${String(first?.timestamp)} .. ${String(last?.timestamp)}`;
    windows.set(meterId, window);
    console.log(`  ${meterId} (${note}): ${data.length} rows, ${window}`);
    console.log(`    fields: ${first ? Object.keys(first).join(", ") : "(no rows)"}`);
    console.log(`    first row: ${JSON.stringify(first)}`);
  });
}
console.log(`  => same window for all sampled meters: ${new Set(windows.values()).size <= 1}`);

// ---------------------------------------------------------------------------
heading("4. Energy query parameters (does the server honour any?)");
const energyQueries: readonly QueryParams[] = [
  { from: "2026-06-29", to: "2026-06-30" },
  // Follow-ups after the first probe showed from/to (ISO dates) are honoured:
  { from: "2026-06-30", to: "2026-06-30" }, // same day: inclusive or empty?
  { from: "2026-06-29" }, // only from
  { to: "2026-06-24" }, // only to
  { from: "2026-06-29T12:00", to: "2026-06-29T18:00" }, // time of day honoured?
  { from: "2026-06-29T12:00:00+05:30", to: "2026-06-29T18:00:00+05:30" }, // with offset
  { from: "2026-07-01", to: "2026-07-05" }, // outside the data window
  { from: "2026-06-30", to: "2026-06-29" }, // reversed
  { from: "not-a-date", to: "2026-06-30" }, // invalid
  { from: "29/06/2026", to: "30/06/2026" },
  { start: "2026-06-29", end: "2026-06-30" },
  { limit: 10 },
  { page: 2 },
];
for (const query of energyQueries) {
  await attempt(JSON.stringify(query), async () => {
    const { data } = await client.get("/portal/meters/J100000/energy", energySchema, query);
    const first = data[0]?.timestamp;
    const last = data[data.length - 1]?.timestamp;
    console.log(
      `  ?${toQueryString(query)}: ${data.length} rows` +
        (data.length > 0 ? ` (${String(first)} .. ${String(last)})` : ""),
    );
  });
}

// ---------------------------------------------------------------------------
heading("4b. Energy history: how far back, and is one request capped?");
const historyQueries: readonly QueryParams[] = [
  { from: "2026-06-01", to: "2026-06-30" }, // 30 days: capped at 7?
  { from: "2026-01-01", to: "2026-06-30" }, // half a year
  { to: "2026-06-01" }, // 7 days ending 1 June
  { to: "2026-03-01" },
  { to: "2026-01-01" },
  { to: "2025-07-01" },
  { from: "2020-01-01", to: "2020-01-07" },
];
for (const query of historyQueries) {
  await attempt(JSON.stringify(query), async () => {
    const { data } = await client.get("/portal/meters/J100000/energy", energySchema, query);
    const first = data[0]?.timestamp;
    const last = data[data.length - 1]?.timestamp;
    console.log(
      `  ?${toQueryString(query)}: ${data.length} rows` +
        (data.length > 0 ? ` (${String(first)} .. ${String(last)})` : ""),
    );
  });
}

// ---------------------------------------------------------------------------
heading("5. Transformers: /portal/dts vs export names");
const dtNames = new Map<string, string>();
for (const page of [1, 2, 3]) {
  await attempt(`dts page=${page}`, async () => {
    const body = await client.get("/portal/dts", dtPageSchema, { page });
    console.log(`  page=${page}: ${body.data.length} items (total ${body.total}, pageSize ${body.pageSize})`);
    for (const dt of body.data) dtNames.set(dt.code, dt.name);
  });
}
await attempt("export", async () => {
  const snapshot = await sessionA.exportApi.fetchAllMeters();
  const exportNames = new Map<string, Set<string>>();
  for (const meter of snapshot.meters) {
    const set = exportNames.get(meter.dtCode) ?? new Set<string>();
    if (meter.hierarchy.dt.name !== "") set.add(meter.hierarchy.dt.name);
    exportNames.set(meter.dtCode, set);
  }
  let disagreements = 0;
  for (const [code, names] of exportNames) {
    const listed = dtNames.get(code);
    if (listed === undefined) {
      console.log(`  ${code}: in export, missing from /portal/dts`);
      disagreements += 1;
    } else if (names.size !== 1 || !names.has(listed)) {
      console.log(`  ${code}: /portal/dts says "${listed}", export says ${[...names].map((n) => `"${n}"`).join(" + ")}`);
      disagreements += 1;
    }
  }
  for (const code of dtNames.keys()) {
    if (!exportNames.has(code)) {
      console.log(`  ${code}: in /portal/dts, no meters in export`);
      disagreements += 1;
    }
  }
  console.log(`  => ${disagreements} DT(s) disagree between the two sources`);
});

console.log("\nProbe finished.");
