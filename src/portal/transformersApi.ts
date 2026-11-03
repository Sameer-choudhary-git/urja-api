import { noopLogger, type Logger } from "../logger.js";
import { PortalProtocolError } from "./errors.js";
import type { PortalClient } from "./portalClient.js";
import { transformerPageSchema, type TransformerRow } from "./schemas.js";

export const TRANSFORMERS_PATH = "/portal/dts";

/** Safety net: stop paging even if the portal keeps reporting a larger total. */
const MAX_PAGES = 50;

export interface PortalTransformersApiOptions {
  readonly client: PortalClient;
  readonly logger?: Logger;
}

/**
 * Reads every distribution transformer from the paginated `/portal/dts`.
 * This is the only source of `capacityKva` and `feederCode`, and the
 * tie-breaker when the export uses two names for one DT code.
 */
export class PortalTransformersApi {
  private readonly client: PortalClient;
  private readonly logger: Logger;

  constructor(options: PortalTransformersApiOptions) {
    this.client = options.client;
    this.logger = options.logger ?? noopLogger;
  }

  async fetchAll(): Promise<readonly TransformerRow[]> {
    const rows: TransformerRow[] = [];
    let total = Number.POSITIVE_INFINITY;

    for (let page = 1; rows.length < total; page += 1) {
      if (page > MAX_PAGES) {
        throw new PortalProtocolError(`/portal/dts still incomplete after ${MAX_PAGES} pages`);
      }
      const body = await this.client.get(TRANSFORMERS_PATH, transformerPageSchema, { page });
      total = body.total;
      if (body.data.length === 0) break; // portal says more exist but sends none: stop, check below
      rows.push(...body.data);
    }

    if (rows.length !== total) {
      throw new PortalProtocolError(
        `/portal/dts reported total=${total} but returned ${rows.length} rows`,
      );
    }
    const codes = new Set(rows.map((row) => row.code));
    if (codes.size !== rows.length) {
      throw new PortalProtocolError("/portal/dts returned the same DT code more than once");
    }

    this.logger.info("portal.transformers.ok", { transformers: rows.length });
    return rows;
  }
}
