import { noopLogger, type Logger } from "../logger.js";
import { PortalProtocolError } from "./errors.js";
import { toQueryString, type PortalClient, type QueryParams } from "./portalClient.js";
import {
  exportResponseSchema,
  keysResponseSchema,
  type ExportMeter,
} from "./schemas.js";
import { signRequest } from "./signing.js";

export const EXPORT_PATH = "/portal/export";
export const KEYS_PATH = "/portal/keys";

export interface ExportSnapshot {
  readonly meters: readonly ExportMeter[];
  /** Epoch ms when the portal answered. Used later for cache age and `X-Data-Age`. */
  readonly fetchedAt: number;
}

export interface PortalExportApiOptions {
  readonly client: PortalClient;
  readonly now?: () => number;
  readonly logger?: Logger;
}

/**
 * Fetches every meter (attributes, geo, hierarchy) in ONE signed request,
 * the same way the portal's "Export all meters" button does:
 *
 *   1. GET /portal/keys           -> signingSecret
 *   2. sign "GET\n/portal/export\npage=1\n<unix seconds>"
 *   3. GET /portal/export?page=1  with x-timestamp + x-signature
 *
 * The secret is fetched again for every attempt, exactly like the browser does
 * on every click. We do not know yet whether the secret is per session, per
 * user or fixed (PROTOCOL.md, section 6), and this choice is correct in all
 * three cases: after a re-login the next attempt automatically gets the
 * secret that belongs to the new session. The cost is one tiny extra request
 * per export, which runs a few times an hour at most.
 */
export class PortalExportApi {
  private readonly client: PortalClient;
  private readonly now: () => number;
  private readonly logger: Logger;

  constructor(options: PortalExportApiOptions) {
    this.client = options.client;
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? noopLogger;
  }

  async fetchAllMeters(): Promise<ExportSnapshot> {
    // The UI always asks for page=1 and gets all meters back (PROTOCOL.md, 3.6).
    const query: QueryParams = { page: 1 };
    const queryString = toQueryString(query);

    const response = await this.client.get(EXPORT_PATH, exportResponseSchema, query, {
      headers: async () => {
        const secret = await this.fetchSigningSecret();
        return signRequest({ method: "GET", path: EXPORT_PATH, query: queryString, secret });
      },
    });

    // If the portal ever starts paginating the export, `total` will exceed the
    // page we got. Failing loudly beats silently serving a partial catalog.
    if (response.total !== response.data.length) {
      throw new PortalProtocolError(
        `Export returned ${response.data.length} meters but reports total=${response.total}; ` +
          "the export may have become paginated",
      );
    }

    assertUniqueIds(response.data);

    this.logger.info("portal.export.ok", { meters: response.data.length });
    return { meters: response.data, fetchedAt: this.now() };
  }

  private async fetchSigningSecret(): Promise<string> {
    const keys = await this.client.get(KEYS_PATH, keysResponseSchema);
    return keys.data.signingSecret;
  }
}

function assertUniqueIds(meters: readonly ExportMeter[]): void {
  const seen = new Set<string>();
  for (const meter of meters) {
    if (seen.has(meter.meterId)) {
      throw new PortalProtocolError(`Export contains meter ${meter.meterId} more than once`);
    }
    seen.add(meter.meterId);
  }
}
