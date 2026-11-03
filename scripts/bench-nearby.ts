/**
 * Grid index vs full scan for "meters within R metres of a point".
 *
 *   npm run bench:nearby
 *
 * Fleet sizes: today's 403, then synthetic fleets around Jaipur to show how
 * each approach scales. Same queries for both; results are checked equal.
 */
import { SpatialGrid, withinByScan, type GeoPoint } from "../src/geo/spatialGrid.js";

function points(count: number, seed: number): GeoPoint[] {
  let state = seed;
  const random = () => ((state = (state * 1_103_515_245 + 12_345) % 2 ** 31) / 2 ** 31);
  return Array.from({ length: count }, () => ({ lat: 26.75 + random() * 0.3, lng: 75.6 + random() * 0.35 }));
}

const self = (p: GeoPoint) => p;
const QUERIES = 2_000;
const RADIUS_M = 1_000;
const centers = points(QUERIES, 7);

function time(fn: () => void): number {
  const start = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - start) / 1e6;
}

console.log(`${QUERIES} queries, radius ${RADIUS_M} m, limit 50\n`);
console.log("fleet     build grid   scan / query   grid / query   speed-up");
for (const size of [403, 10_000, 100_000]) {
  const data = points(size, 1);
  let grid!: SpatialGrid<GeoPoint>;
  const buildMs = time(() => (grid = new SpatialGrid(data, self)));
  // Warm up the JIT so the first approach measured is not penalised.
  for (const c of centers.slice(0, 50)) {
    withinByScan(data, self, c, RADIUS_M, 50);
    grid.within(c, RADIUS_M, 50);
  }
  const scanMs = time(() => centers.forEach((c) => withinByScan(data, self, c, RADIUS_M, 50)));
  const gridMs = time(() => centers.forEach((c) => grid.within(c, RADIUS_M, 50)));
  for (const c of centers.slice(0, 100)) {
    if (JSON.stringify(grid.within(c, RADIUS_M, 50)) !== JSON.stringify(withinByScan(data, self, c, RADIUS_M, 50))) {
      throw new Error("grid and scan disagree");
    }
  }
  const us = (ms: number) => `${((ms / QUERIES) * 1000).toFixed(1)} µs`.padStart(10);
  console.log(
    `${String(size).padStart(7)}   ${`${buildMs.toFixed(1)} ms`.padStart(10)}   ${us(scanMs)}     ${us(gridMs)}     ${(scanMs / gridMs).toFixed(1)}x`,
  );
}
