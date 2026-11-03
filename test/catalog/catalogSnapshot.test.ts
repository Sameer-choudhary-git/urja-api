import { describe, expect, it } from "vitest";
import { CatalogSnapshot, MAX_LIMIT } from "../../src/catalog/catalogSnapshot.js";
import { normalizeCatalog } from "../../src/domain/normalize.js";
import { sampleExport, sampleTransformerRows } from "../helpers/sample.js";

const { meters, transformers } = normalizeCatalog(sampleExport, sampleTransformerRows);
const snapshot = new CatalogSnapshot({ meters, transformers, fetchedAt: 0 });

/** Brute-force reference: what the indexes must agree with. */
const ids = (predicate: (m: (typeof meters)[number]) => boolean) =>
  meters.filter(predicate).map((m) => m.id);

describe("CatalogSnapshot", () => {
  it("looks meters up by id, case-insensitively", () => {
    expect(snapshot.getMeter("J100011")?.id).toBe("J100011");
    expect(snapshot.getMeter("j100011")?.id).toBe("J100011");
    expect(snapshot.getMeter("J999999")).toBeUndefined();
  });

  it("returns everything, sorted by id, when no filter is given", () => {
    const page = snapshot.query();

    expect(page.total).toBe(14);
    expect(page.items.map((m) => m.id)).toEqual([...meters.map((m) => m.id)].sort());
  });

  it("ORs values within a facet and ANDs across facets (matches a brute-force filter)", () => {
    const page = snapshot.query({ status: ["faulty", "installed"], phase: ["three"], limit: MAX_LIMIT });

    expect(page.items.map((m) => m.id)).toEqual(
      ids((m) => (m.status === "faulty" || m.status === "installed") && m.phase === "three"),
    );
  });

  it("searches id and serial number like the portal: substring, case-insensitive", () => {
    expect(snapshot.query({ q: "j10040" }).items.map((m) => m.id)).toEqual([
      "J100400",
      "J100401",
      "J100402",
    ]);
    const serial = meters[0]!.serialNumber;
    expect(snapshot.query({ q: serial.toLowerCase() }).items[0]?.serialNumber).toBe(serial);
  });

  it("filters by a network code at any level", () => {
    expect(snapshot.query({ network: { transformer: "DT-007" } }).total).toBe(5);
    expect(snapshot.query({ network: { transformer: "dt-007" } }).total).toBe(5);
  });

  it("filters by an exact subtree with a node path, without matching look-alike prefixes", () => {
    const path = snapshot.getMeter("J100400")!.network.path;
    const division = path.split(".").slice(0, 3).join("."); // Z-01.C-01.D-07

    expect(snapshot.query({ node: division }).items.map((m) => m.id)).toEqual(
      ids((m) => m.network.path.startsWith(`${division}.`)),
    );
    // "Z-01.C-0" is a string prefix of "Z-01.C-01...." but not a node: must match nothing.
    expect(snapshot.query({ node: "Z-01.C-0" }).total).toBe(0);
  });

  it("filters by data issues", () => {
    expect(snapshot.query({ hasIssues: true }).items.map((m) => m.id)).toEqual(
      ids((m) => m.issues.length > 0),
    );
  });

  it("pages with limit/offset and clamps silly values", () => {
    const page = snapshot.query({ limit: 5, offset: 10 });
    expect(page.items.map((m) => m.id)).toEqual(meters.slice(10, 15).map((m) => m.id));
    expect(snapshot.query({ limit: 0 }).limit).toBe(1);
    expect(snapshot.query({ limit: 10_000 }).limit).toBe(MAX_LIMIT);
    expect(snapshot.query({ offset: -3 }).offset).toBe(0);
  });

  it("sorts descending with a stable tie-break on id", () => {
    const page = snapshot.query({ sort: "make", order: "desc", limit: MAX_LIMIT });
    const makes = page.items.map((m) => m.make);
    expect(makes).toEqual([...makes].sort().reverse());
  });

  it("counts facets over all matches, not just the current page", () => {
    const page = snapshot.query({ limit: 1 });
    const total = Object.values(page.facets.status).reduce((a, b) => a + b, 0);
    expect(total).toBe(14);
  });

  it("builds a network tree whose counts add up", () => {
    const rootTotal = snapshot.tree.roots.reduce((sum, node) => sum + node.meterCount, 0);
    expect(rootTotal).toBe(14);

    for (const node of snapshot.tree.byId.values()) {
      if (node.children.length === 0) continue;
      expect(node.children.reduce((sum, child) => sum + child.meterCount, 0)).toBe(node.meterCount);
    }
    const dt7 = snapshot.tree.byId.get(snapshot.getMeter("J100400")!.network.path);
    expect(dt7).toMatchObject({ level: "transformer", code: "DT-007", name: "Sanganer DT 7", meterCount: 5 });
  });
});
