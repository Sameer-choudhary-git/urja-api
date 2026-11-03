/**
 * Live: fetch ALL meters through the signed export and save them locally.
 *
 *   npm run fetch-export
 *   npm run fetch-export -- path/to/output.json
 *
 * Default output is fixtures/local/meter-export.json (git-ignored: it is real
 * portal data). The file is the raw `{ data, total }` response, so
 * `npm run scan` can read it directly. Prints no secrets.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { loadPortalConfig } from "../src/config.js";
import { consoleLogger } from "../src/logger.js";
import { createPortal } from "../src/portal/createPortal.js";

const output = process.argv[2] ?? "fixtures/local/meter-export.json";
const { exportApi } = createPortal(loadPortalConfig(), consoleLogger);

const started = Date.now();
const snapshot = await exportApi.fetchAllMeters();

await mkdir(dirname(output), { recursive: true });
await writeFile(
  output,
  JSON.stringify({ data: snapshot.meters, total: snapshot.meters.length }, null, 2),
);

console.log(
  `Exported ${snapshot.meters.length} meters in ${Date.now() - started} ms -> ${output}`,
);
console.log("Next: npm run scan -- " + output);
