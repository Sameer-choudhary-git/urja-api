import { noopLogger, type Logger } from "../logger.js";
import type { PortalClient, QueryParams } from "./portalClient.js";
import { energyResponseSchema, type EnergyRow } from "./schemas.js";

export const energyPath = (meterId: string): string =>
  `/portal/meters/${encodeURIComponent(meterId)}/energy`;

/** Whole days in the portal's own calendar (IST), `YYYY-MM-DD`, both inclusive. */
export interface PortalDayRange {
  readonly from: string;
  readonly to: string;
}

export interface PortalEnergyApiOptions {
  readonly client: PortalClient;
  readonly logger?: Logger;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Half-hourly register readings for one meter.
 *
 * The portal's UI never sends a query and gets "the last 7 days". The
 * endpoint also takes `from`/`to` as ISO dates (whole days, inclusive), which
 * we found by probing (PROTOCOL.md 3.3). Anything else it silently ignores,
 * including a time of day, so this adapter only ever sends plain dates and
 * leaves finer filtering to the domain layer.
 */
export class PortalEnergyApi {
  private readonly client: PortalClient;
  private readonly logger: Logger;

  constructor(options: PortalEnergyApiOptions) {
    this.client = options.client;
    this.logger = options.logger ?? noopLogger;
  }

  /** `days` null = the portal's default window (last 7 days of data plus one reading). */
  async fetchReadings(meterId: string, days: PortalDayRange | null): Promise<readonly EnergyRow[]> {
    if (days !== null && (!ISO_DAY.test(days.from) || !ISO_DAY.test(days.to))) {
      // The portal would silently ignore a bad value and answer with a different window.
      throw new Error(`Portal day range must be YYYY-MM-DD: ${days.from}..${days.to}`);
    }
    const query: QueryParams = days === null ? {} : { from: days.from, to: days.to };
    const body = await this.client.get(energyPath(meterId), energyResponseSchema, query);
    this.logger.debug("portal.energy.ok", { meterId, ...query, rows: body.data.length });
    return body.data;
  }
}
