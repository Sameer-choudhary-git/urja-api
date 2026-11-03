/**
 * Live smoke test: logs in to the REAL portal and fetches the first page of
 * meters. Run it after `cp .env.example .env` and filling in the credentials:
 *
 *   npm run smoke
 *
 * It prints no secrets. A healthy run ends with "Smoke test passed".
 */
import { z } from "zod";
import { loadPortalConfig } from "../src/config.js";
import { consoleLogger } from "../src/logger.js";
import { createPortal } from "../src/portal/createPortal.js";

const searchPage = z.object({
  data: z.array(z.object({ meterId: z.string() })),
  total: z.number(),
  pageSize: z.number(),
});

const { client } = createPortal(loadPortalConfig(), consoleLogger);

const page = await client.get("/portal/meters/search", searchPage, { q: "", page: 1 });
console.log(`Logged in. The portal reports ${page.total} meters (page size ${page.pageSize}).`);
console.log(`First meter on page 1: ${page.data[0]?.meterId ?? "(none)"}`);
console.log("Smoke test passed");
