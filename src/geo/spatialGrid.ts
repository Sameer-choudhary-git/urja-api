/**
 * Fixed-size lat/lng grid for "what is near this point?".
 *
 * Points are bucketed into cells of `cellDeg` degrees. A radius query only
 * looks at the cells that overlap the circle's bounding box, then checks the
 * exact distance of the points in them. With 403 meters a plain scan is
 * already fast; the grid matters as the fleet grows (see
 * `npm run bench:nearby`), and it keeps the query cost proportional to how
 * many meters are actually nearby, not to the fleet size.
 *
 * Why a grid and not an R-tree or geohash library: the points never move
 * between snapshots (the index is rebuilt with each catalog), the area is one
 * city, and a grid is ~60 lines anyone can read and verify.
 */

export interface GeoPoint {
  readonly lat: number;
  readonly lng: number;
}

export interface Neighbour<T> {
  readonly item: T;
  readonly distanceM: number;
}

const EARTH_RADIUS_M = 6_371_008.8;
const METERS_PER_DEGREE_LAT = 111_320;

/** Great-circle distance in metres (haversine). Accurate to ~0.5% anywhere, far better at city scale. */
export function distanceMeters(a: GeoPoint, b: GeoPoint): number {
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLng = (b.lng - a.lng) * toRad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export class SpatialGrid<T> {
  private readonly cells = new Map<string, { item: T; point: GeoPoint }[]>();

  /** `cellDeg` 0.01 is about 1.1 km north-south. */
  constructor(
    items: readonly T[],
    private readonly pointOf: (item: T) => GeoPoint,
    private readonly cellDeg = 0.01,
  ) {
    for (const item of items) {
      const point = pointOf(item);
      const key = this.key(this.cell(point.lat), this.cell(point.lng));
      const bucket = this.cells.get(key);
      if (bucket === undefined) this.cells.set(key, [{ item, point }]);
      else bucket.push({ item, point });
    }
  }

  /** Items within `radiusM` of `center`, nearest first, at most `limit`. */
  within(center: GeoPoint, radiusM: number, limit: number, accept: (item: T) => boolean = () => true): Neighbour<T>[] {
    const dLat = radiusM / METERS_PER_DEGREE_LAT;
    // A degree of longitude shrinks with latitude; clamp near the poles.
    const dLng = radiusM / (METERS_PER_DEGREE_LAT * Math.max(Math.cos((center.lat * Math.PI) / 180), 0.01));
    const found: Neighbour<T>[] = [];
    for (let x = this.cell(center.lat - dLat); x <= this.cell(center.lat + dLat); x += 1) {
      for (let y = this.cell(center.lng - dLng); y <= this.cell(center.lng + dLng); y += 1) {
        for (const { item, point } of this.cells.get(this.key(x, y)) ?? []) {
          const distanceM = distanceMeters(center, point);
          if (distanceM <= radiusM && accept(item)) found.push({ item, distanceM });
        }
      }
    }
    return found.sort((a, b) => a.distanceM - b.distanceM).slice(0, limit);
  }

  private cell(degrees: number): number {
    return Math.floor(degrees / this.cellDeg);
  }

  private key(x: number, y: number): string {
    return `${x}:${y}`;
  }
}

/** The obvious O(n) version: the reference the grid is tested and benchmarked against. */
export function withinByScan<T>(
  items: readonly T[],
  pointOf: (item: T) => GeoPoint,
  center: GeoPoint,
  radiusM: number,
  limit: number,
): Neighbour<T>[] {
  return items
    .map((item) => ({ item, distanceM: distanceMeters(center, pointOf(item)) }))
    .filter((n) => n.distanceM <= radiusM)
    .sort((a, b) => a.distanceM - b.distanceM)
    .slice(0, limit);
}
