/**
 * Writes openapi.json from the code (the route registry), so the committed
 * file is always what the server actually serves.
 *
 *   npm run openapi
 */
import { writeFileSync } from "node:fs";
import { createApp } from "../src/http/app.js";

const { openApi } = createApp({
  context: {
    catalog: {
      read: () => Promise.reject(new Error("not used")),
      status: () => ({ loaded: false, meterCount: 0, fetchedAt: null, ageMs: null, refreshing: false, lastRefreshMs: null, lastError: null }),
    },
    readings: { get: () => Promise.reject(new Error("not used")) },
    startedAt: 0,
    now: Date.now,
  },
  apiKeys: null,
  rateLimitPerMinute: 1,
  version: (JSON.parse((await import("node:fs")).readFileSync("package.json", "utf8")) as { version: string }).version,
});
writeFileSync("openapi.json", `${JSON.stringify(openApi, null, 2)}\n`);
console.log(`openapi.json written (${Object.keys(openApi.paths as object).length} paths)`);
