import { afterEach, describe, expect, it } from "vitest";
import { PortalCatalogLoader } from "../../src/catalog/portalCatalogLoader.js";
import { normalizeCatalog } from "../../src/domain/normalize.js";
import { createPortal } from "../../src/portal/createPortal.js";
import { decodeDevalue, decodeSvelteKitPageData } from "../../src/portal/devalue.js";
import { PortalProtocolError, PortalUnavailableError } from "../../src/portal/errors.js";
import { readDetail, splitNameAndCode, toExportMeter } from "../../src/portal/fallbackApi.js";
import { meterPageDataSchema } from "../../src/portal/schemas.js";
import { crossCheck } from "../../src/quality/crossCheck.js";
import { encodeDevalue } from "../helpers/fakeEnergy.js";
import { startFakePortal, type FakePortal } from "../helpers/fakePortal.js";
import { sampleExport, sampleTransformerRows } from "../helpers/sample.js";

describe("devalue decoder", () => {
  it("decodes the PROTOCOL.md example, including a shared value", () => {
    const flat = [
      { meterId: 1, detail: 2 },
      "J100001",
      { data: 3 },
      [4],
      { parameterName: 5, parameterValue: 1 },
      "Meter ID",
    ];
    expect(decodeDevalue(flat)).toEqual({
      meterId: "J100001",
      detail: { data: [{ parameterName: "Meter ID", parameterValue: "J100001" }] },
    });
  });

  it("round-trips anything our independent encoder produces", () => {
    const value = { a: [1, 2, 2, "x"], b: { c: null, d: true, e: "x" }, f: [] };
    expect(decodeDevalue(encodeDevalue(value))).toEqual(value);
  });

  it("fails loudly on encodings the portal has not been seen to use", () => {
    expect(() => decodeDevalue([{ a: -1 }])).toThrow(/special value/); // undefined
    expect(() => decodeDevalue([{ a: 1 }, ["Date", "2026-01-01"]])).toThrow(/tagged value "Date"/);
    expect(() => decodeDevalue([{ a: 9 }])).toThrow(/out of range/);
    expect(() => decodeDevalue([{ a: 0 }])).toThrow(/cyclic/);
    expect(() => decodeDevalue("nope")).toThrow(PortalProtocolError);
  });

  it("picks the page node out of a SvelteKit response", () => {
    const body = { type: "data", nodes: [{ type: "skip" }, { type: "skip" }, { type: "data", data: encodeDevalue({ ok: 1 }) }] };
    expect(decodeSvelteKitPageData(body)).toEqual({ ok: 1 });
    expect(() => decodeSvelteKitPageData({ type: "redirect", location: "/login" })).toThrow(PortalProtocolError);
  });
});

describe("splitNameAndCode", () => {
  it.each([
    ["Mansarovar DT 2 (DT-002)", { name: "Mansarovar DT 2", code: "DT-002" }],
    ["Circle 2 (C-02)", { name: "Circle 2", code: "C-02" }],
    [" (C-02)", { name: "", code: "C-02" }],
    ["Circle 2 ()", { name: "Circle 2", code: "" }],
    ["Circle 2", { name: "Circle 2", code: "" }],
    [undefined, { name: "", code: "" }],
  ])("%s", (input, expected) => expect(splitNameAndCode(input)).toEqual(expected));
});

describe("fallback catalog path (against the fake portal)", () => {
  let fake: FakePortal;
  afterEach(async () => fake.close());

  async function setup() {
    fake = await startFakePortal({ exportMeters: sampleExport, transformers: sampleTransformerRows });
    return createPortal({ baseUrl: fake.baseUrl, email: "operator@urja.local", password: "correct-horse", timeoutMs: 2_000, maxRetries: 0 });
  }

  it("rebuilds exactly the export's data from search + detail pages + geo (except `build`)", async () => {
    const portal = await setup();
    const fallback = await portal.fallbackApi.fetchAllMeters();
    expect(fallback.meters).toHaveLength(sampleExport.length);
    expect(fallback.meters.every((m) => m.build === "unknown")).toBe(true);

    const report = crossCheck(sampleExport, fallback.meters);
    expect(report).toMatchObject({ compared: sampleExport.length, identical: sampleExport.length, onlyInExport: [], onlyInFallback: [] });
    // And the normalised catalogs agree too, blank-cell repairs included.
    const strip = (meters: ReturnType<typeof normalizeCatalog>["meters"]) => meters.map(({ build: _build, ...rest }) => rest);
    expect(strip(normalizeCatalog(fallback.meters, sampleTransformerRows).meters)).toEqual(
      strip(normalizeCatalog(sampleExport, sampleTransformerRows).meters),
    );
  });

  it("the loader switches to the fallback when the export breaks, and says so", async () => {
    const portal = await setup();
    fake.failNextExports(403, 10); // e.g. the signing scheme changed
    const snapshot = await new PortalCatalogLoader(portal).load();
    expect(snapshot.source).toBe("fallback");
    expect(snapshot.size).toBe(sampleExport.length);
  });

  it("does NOT try the fallback when the portal is simply down", async () => {
    const portal = await setup();
    fake.setDown(true);
    await expect(new PortalCatalogLoader(portal).load()).rejects.toBeInstanceOf(PortalUnavailableError);
    expect(fake.stats.searchRequests).toBe(0);
  });
});

describe("toExportMeter", () => {
  it("reads the installation type from the hierarchy when `detail` has no list (seen on J100020)", () => {
    const page = meterPageDataSchema.parse({
      meterId: "J100020",
      detail: {},
      hierarchy: { "Installation Type": "Whole Current", Zone: "Jaipur Zone 1 (Z-01)", DT: "Mansarovar DT 2 (DT-002)" },
    });
    const meter = toExportMeter(
      { meterId: "J100020", serialNo: "S1", make: "HPL", phaseType: "single", installStatus: "Installed", dtCode: "DT-002" },
      page,
      { lat: 26.9, lng: 75.8 },
    );
    expect(meter).toMatchObject({ installType: "Whole Current", hierarchy: { zone: { code: "Z-01" }, dt: { name: "Mansarovar DT 2" } } });
  });
});

describe("readDetail", () => {
  it("reads both detail shapes the live portal uses", () => {
    const list = meterPageDataSchema.parse({
      meterId: "J100001",
      detail: { data: [{ parameterName: "Installation Type", parameterValue: "CT Operated" }] },
      hierarchy: {},
    });
    // Exactly as J100020 came back: a JSON string inside the JSON.
    const classData = meterPageDataSchema.parse({
      meterId: "J100020",
      detail: {
        classData:
          '{"installed_meter":{"MeterId":"J100020","SerialNo":"AL20290","Make":"Allied","PhaseType":"three","InstallationStatus":"Installed","InstallationType":"CT Operated"}}',
      },
      hierarchy: {},
    });
    expect(readDetail(list).get("Installation Type")).toBe("CT Operated");
    expect(Object.fromEntries(readDetail(classData))).toEqual({
      "Meter ID": "J100020",
      "Serial No": "AL20290",
      Make: "Allied",
      "Phase Type": "three",
      "Installation Status": "Installed",
      "Installation Type": "CT Operated",
    });
    const broken = meterPageDataSchema.parse({ meterId: "J1", detail: { classData: "{not json" }, hierarchy: {} });
    expect(readDetail(broken).size).toBe(0);
  });
});

describe("crossCheck", () => {
  it("reports field differences", () => {
    const changed = structuredClone(sampleExport.slice(0, 2));
    changed[0]!.make = "Other";
    changed[1]!.geo.lat += 0.001;
    const report = crossCheck(sampleExport, changed, { restrictToFallback: true });
    expect(report.identical).toBe(0);
    expect(report.differences.map((d) => d.field)).toEqual(["make", "geo.lat"]);
  });
});
