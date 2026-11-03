/**
 * Prints what the portal's meter detail page data looks like, decoded, for
 * one or more meters. For investigating pages the fallback path cannot read.
 *
 *   npm run dump-page -- J100020 J100001
 *
 * Read-only. Prints meter data only (no cookies, no secrets).
 */
import { z } from "zod";
import { loadPortalConfig } from "../src/config.js";
import { createJsonLogger } from "../src/logger.js";
import { createPortal } from "../src/portal/createPortal.js";
import { decodeSvelteKitPageData } from "../src/portal/devalue.js";

const ids = process.argv.slice(2);
if (ids.length === 0) {
  console.error("usage: npm run dump-page -- <meterId> [<meterId> ...]");
  process.exit(1);
}

const { client } = createPortal(loadPortalConfig(), createJsonLogger("warn", { script: "dump-page" }));
for (const id of ids) {
  console.log(`\n=== ${id}`);
  // Raw JSON first, so the shape is visible even if decoding fails.
  const raw = await client.get(`/meters/${id}/__data.json`, z.unknown(), { "x-sveltekit-invalidated": "001" });
  const nodes = (raw as { nodes?: { type?: string; data?: unknown[] }[] }).nodes ?? [];
  console.log(`node types: ${nodes.map((n) => n.type).join(", ")}`);
  try {
    console.log(JSON.stringify(decodeSvelteKitPageData(raw), null, 2));
  } catch (error) {
    console.log(`decode failed: ${(error as Error).message}`);
    console.log(JSON.stringify(nodes.at(-1)?.data?.slice(0, 40)));
  }
}
