import { describe, expect, it } from "vitest";
import { distanceMeters, SpatialGrid, withinByScan, type GeoPoint } from "../../src/geo/spatialGrid.js";

/** Seeded points around Jaipur, so failures can be replayed. */
function points(count: number, seed = 1): GeoPoint[] {
  let state = seed;
  const random = () => ((state = (state * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31);
  return Array.from({ length: count }, () => ({ lat: 26.75 + random() * 0.3, lng: 75.6 + random() * 0.35 }));
}
const self = (p: GeoPoint) => p;

describe("distanceMeters", () => {
  it("matches known distances", () => {
    expect(distanceMeters({ lat: 26.9124, lng: 75.7873 }, { lat: 26.9124, lng: 75.7873 })).toBe(0);
    // One degree of latitude is about 111.2 km.
    expect(distanceMeters({ lat: 26, lng: 75 }, { lat: 27, lng: 75 })).toBeCloseTo(111_195, -2);
    // Jaipur to Delhi (Connaught Place), about 236 km in a straight line.
    expect(distanceMeters({ lat: 26.9124, lng: 75.7873 }, { lat: 28.6315, lng: 77.2167 }) / 1000).toBeCloseTo(236, -1);
  });
});

describe("SpatialGrid", () => {
  const data = points(2_000);
  const grid = new SpatialGrid(data, self);

  it("returns exactly what a full scan returns, for many centres and radii", () => {
    for (const [i, center] of points(200, 99).entries()) {
      const radius = [50, 300, 1_000, 2_500, 8_000][i % 5] as number;
      expect(grid.within(center, radius, 1_000)).toEqual(withinByScan(data, self, center, radius, 1_000));
    }
  });

  it("finds points across cell borders and sorts nearest first", () => {
    const g = new SpatialGrid<GeoPoint>([{ lat: 26.9999, lng: 75.5 }, { lat: 27.0001, lng: 75.5 }, { lat: 27.05, lng: 75.5 }], self);
    const found = g.within({ lat: 27.0, lng: 75.5 }, 100, 10);
    expect(found).toHaveLength(2);
    expect(found[0]!.distanceM).toBeLessThanOrEqual(found[1]!.distanceM);
  });

  it("applies the limit and the filter", () => {
    const center = { lat: 26.9, lng: 75.78 };
    expect(grid.within(center, 5_000, 3)).toHaveLength(3);
    const north = grid.within(center, 5_000, 1_000, (p) => p.lat > 26.9);
    expect(north.every((n) => n.item.lat > 26.9)).toBe(true);
  });
});
