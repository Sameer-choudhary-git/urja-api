import { normalizeCatalog } from "../domain/normalize.js";
import { noopLogger, type Logger } from "../logger.js";
import { PortalUnavailableError } from "../portal/errors.js";
import type { ExportSnapshot } from "../portal/exportApi.js";
import type { TransformerRow } from "../portal/schemas.js";
import { scanExport } from "../quality/scanExport.js";
import { CatalogSnapshot } from "./catalogSnapshot.js";
import type { CatalogLoader } from "./catalogService.js";

/** The two portal calls the loader needs; satisfied by PortalExportApi and PortalTransformersApi. */
export interface CatalogSources {
  readonly exportApi: { fetchAllMeters(): Promise<ExportSnapshot> };
  readonly transformersApi: { fetchAll(): Promise<readonly TransformerRow[]> };
  /** Slow path used when the export is broken (search + detail pages + geo). Optional. */
  readonly fallbackApi?: { fetchAllMeters(): Promise<ExportSnapshot> } | undefined;
}

/**
 * Builds a catalog snapshot from the portal: the signed export (required)
 * plus `/portal/dts` (optional), fetched in parallel.
 *
 * `/portal/dts` only adds capacities and the tie-break for DT names, so if it
 * fails we still publish a catalog rather than nothing (logged as a warning).
 * If the export fails, the whole load fails and the CatalogService keeps
 * serving the previous snapshot.
 */
export class PortalCatalogLoader implements CatalogLoader {
  constructor(
    private readonly sources: CatalogSources,
    private readonly logger: Logger = noopLogger,
  ) {}

  async load(): Promise<CatalogSnapshot> {
    const [{ exported, source }, transformers] = await Promise.all([
      this.loadMeters(),
      this.sources.transformersApi.fetchAll().catch((error: unknown) => {
        this.logger.warn("catalog.transformers_unavailable", {
          message: error instanceof Error ? error.message : String(error),
        });
        return null;
      }),
    ]);

    const { meters, transformers: normalized } = normalizeCatalog(exported.meters, transformers);
    return new CatalogSnapshot({
      meters,
      transformers: normalized,
      fetchedAt: exported.fetchedAt,
      quality: scanExport(exported.meters),
      source,
    });
  }

  /**
   * The signed export first. If it fails in a way that suggests the export
   * itself broke (bad signature, changed format, ...) and a fallback is wired,
   * rebuild the same data from the unsigned pages instead. If the portal is
   * simply down, the fallback would fail too, so the error is passed on and the
   * CatalogService keeps serving the previous snapshot.
   */
  private async loadMeters(): Promise<{ exported: ExportSnapshot; source: "export" | "fallback" }> {
    try {
      return { exported: await this.sources.exportApi.fetchAllMeters(), source: "export" };
    } catch (error) {
      const fallback = this.sources.fallbackApi;
      if (fallback === undefined || error instanceof PortalUnavailableError) throw error;
      this.logger.warn("catalog.export_failed_using_fallback", {
        message: error instanceof Error ? error.message : String(error),
      });
      return { exported: await fallback.fetchAllMeters(), source: "fallback" };
    }
  }
}
