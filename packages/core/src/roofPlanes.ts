/**
 * Roof pitch from lidar. USGS's 3D Elevation Program has flown lidar over most of the US and hosts it
 * free on AWS as Entwine point clouds in web-mercator meters. The browser downloads the points over a
 * drawn roof (apps/web/src/features/measure/lidar.ts); this finds the flat planes they make, reads each
 * one's pitch, and works out a pitch for each roof section drawn on the map. Platform-free, so the
 * tests can run it on made-up roofs.
 *
 * How: points on the roof (inside a drawn roof, above the ground, single returns where the survey has
 * them so trees mostly drop out), then plane after plane: try many planes through three nearby points,
 * keep the one most points lie on (within 12 cm), refit it, keep its biggest connected patch, and take
 * those points out before looking for the next. Walls, trees and tiny bits are left over.
 */
import type { Position } from "./geo";

// ---------------------------------------------------------------------------------------------
// Where the surveys are
// ---------------------------------------------------------------------------------------------

const R = 6378137;
/** Web mercator meters (EPSG:3857), what the surveys are stored in. */
export const toMercator = (lng: number, lat: number): [number, number] => [(R * lng * Math.PI) / 180, R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))];

/** A survey in apps/web/src/features/measure/lidarSurveys.json: name, year flown, outlines as flat [lng, lat, ...] rings. */
export interface LidarSurvey {
  n: string;
  y: number | null;
  r: number[][];
}

/** The public address of a survey's point cloud. */
export const surveyUrl = (name: string) => `https://s3-us-west-2.amazonaws.com/usgs-lidar-public/${name}`;

/**
 * Surveys whose outline takes in a spot, newest first. The outlines are simplified to about a
 * kilometer, so a spot that close to one counts too (the caller checks the survey has points there).
 */
export function surveysAt(surveys: LidarSurvey[], lng: number, lat: number, slack = 0.015): LidarSurvey[] {
  const near = (ring: number[]) => {
    let inside = false;
    let best = Infinity;
    for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
      const [xi, yi, xj, yj] = [ring[i], ring[i + 1], ring[j], ring[j + 1]];
      if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
      best = Math.min(best, segmentDistance(lng, lat, xi, yi, xj, yj));
    }
    return inside || best < slack;
  };
  return surveys.filter((s) => s.r.some(near)).sort((a, b) => (b.y ?? 0) - (a.y ?? 0));
}

/** An Entwine tile's [west, south, east, north] in the survey's units, from its key "depth-x-y-z". */
export function tileBox(bounds: number[], key: string): [number, number, number, number] {
  const [d, x, y] = key.split("-").map(Number);
  const [minx, miny, , maxx, maxy] = bounds;
  const sx = (maxx - minx) / 2 ** d;
  const sy = (maxy - miny) / 2 ** d;
  return [minx + x * sx, miny + y * sy, minx + (x + 1) * sx, miny + (y + 1) * sy];
}

export const boxesMeet = (a: number[], b: number[]) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

// ---------------------------------------------------------------------------------------------
// Reading the roof
// ---------------------------------------------------------------------------------------------

/** Lidar points in web-mercator meters (x, y), meters up (z), with their class and how many returns their pulse had. */
export interface PointCloud {
  count: number;
  x: Float64Array;
  y: Float64Array;
  z: Float64Array;
  /** ASPRS class: 2 ground, 6 building, 7 and 18 noise, 9 water. */
  cls: Uint8Array;
  /** Returns from the same pulse: 1 off a hard surface like a roof, more through trees. */
  returns: Uint8Array;
}

/** A roof section drawn on the map: its outline in [lng, lat]. */
export interface RoofOutline {
  id: string;
  ring: Position[];
}

export interface RoofPlane {
  /** Rise per 12, unrounded. */
  rise: number;
  degrees: number;
  /** The compass direction it faces (downhill), degrees from north. */
  facing: number;
  points: number;
  /** Its size seen from above, in square feet. */
  planSqft: number;
  /** How far its points sit off it on average, in meters. */
  rms: number;
  /** Points of it inside each roof section, by section id. */
  bySection: Record<string, number>;
}

export interface SectionReading {
  id: string;
  /** "6/12" (to the half inch), "0/12" for flat, or null when too little of it was found. */
  pitch: string | null;
  /** The measured rise per 12, unrounded. */
  rise: number | null;
  /** Roof points the pitch is based on. */
  points: number;
  /** Part of the section is at another pitch (a dormer or porch inside it): that pitch. */
  alsoPitch: string | null;
}

export interface RoofReading {
  planes: RoofPlane[];
  sections: SectionReading[];
  /** Points that looked like roof, and how many per square meter of roof. */
  roofPoints: number;
  density: number;
}

const THRESHOLD = 0.12; // meters off a plane still on it
const MAX_SLOPE_COS = Math.cos((65 * Math.PI) / 180); // steeper than about 26/12 is a wall or a tree
const SQFT_PER_SQM = 10.763910416709722;

/** Rise per 12 as a pitch to the half inch, and anything under about 1/2 in 12 as flat. */
export function lidarPitch(rise: number): string {
  if (rise < 0.6) return "0/12";
  return `${Math.round(rise * 2) / 2}/12`;
}

/** The planes in a roof's points, and a pitch for each drawn section. */
export function readRoof(cloud: PointCloud, outlines: RoofOutline[], seed = 1): RoofReading {
  const random = mulberry32(seed);
  const all = outlines.flatMap((o) => o.ring);
  const lat0 = all.reduce((s, p) => s + Number(p[1]), 0) / (all.length || 1);
  const k = Math.cos((lat0 * Math.PI) / 180); // real meters per mercator meter here
  const merc = all.map((p) => toMercator(Number(p[0]), Number(p[1])));
  const ox = merc.reduce((s, p) => s + p[0], 0) / (merc.length || 1);
  const oy = merc.reduce((s, p) => s + p[1], 0) / (merc.length || 1);
  const local = (mx: number, my: number): [number, number] => [(mx - ox) * k, (my - oy) * k];
  const rings = outlines.map((o) => {
    const ring = o.ring.map((p) => local(...toMercator(Number(p[0]), Number(p[1]))));
    return { id: o.id, ring, area: ringArea(ring) };
  });
  const roofArea = rings.reduce((s, r) => s + r.area, 0);

  // Ground: the survey's ground points nearby, else the lowest points around.
  const zs: number[] = [];
  for (let i = 0; i < cloud.count; i++) if (cloud.cls[i] === 2) zs.push(cloud.z[i]);
  const allZ = zs.length ? zs : Array.from(cloud.z.subarray(0, cloud.count));
  allZ.sort((a, b) => a - b);
  const ground = zs.length ? allZ[Math.floor(allZ.length / 2)] : allZ[Math.floor(allZ.length * 0.05)] ?? 0;

  // Roof points: in a section (or within the eaves' width of one), off the ground, not noise or water.
  type P = { x: number; y: number; z: number; section: string; cls: number; returns: number };
  let candidates: P[] = [];
  for (let i = 0; i < cloud.count; i++) {
    const c = cloud.cls[i];
    if (c === 2 || c === 7 || c === 9 || c === 18 || cloud.z[i] < ground + 1.8) continue;
    const [x, y] = local(cloud.x[i], cloud.y[i]);
    const section = sectionAt(rings, x, y, 0.6);
    if (section) candidates.push({ x, y, z: cloud.z[i], section, cls: c, returns: cloud.returns[i] });
  }
  // Use the survey's own building class, and single returns, when it has enough of them.
  const buildings = candidates.filter((p) => p.cls === 6);
  if (buildings.length >= candidates.length * 0.3 && buildings.length >= 30) candidates = buildings;
  const single = candidates.filter((p) => p.returns === 1);
  if (single.length >= candidates.length * 0.5 && single.length >= 30) candidates = single;

  const planes: RoofPlane[] = [];
  let left = candidates;
  const minSupport = Math.max(20, Math.round(candidates.length * 0.02));
  for (let round = 0; round < 14 && left.length >= minSupport; round++) {
    const found = bestPlane(left, random);
    if (!found || found.length < minSupport) break;
    const patch = biggestPatch(found);
    const fit = fitPlane(patch);
    const keep = new Set(patch);
    left = left.filter((p) => !keep.has(p));
    if (patch.length < minSupport || fit.rms > 0.1 || fit.normal[2] < MAX_SLOPE_COS) continue;
    const [nx, ny, nz] = fit.normal;
    const degrees = (Math.acos(Math.min(1, nz)) * 180) / Math.PI;
    const bySection: Record<string, number> = {};
    for (const p of patch) bySection[p.section] = (bySection[p.section] ?? 0) + 1;
    planes.push({
      rise: Math.tan((degrees * Math.PI) / 180) * 12,
      degrees,
      facing: ((Math.atan2(nx, ny) * 180) / Math.PI + 360) % 360,
      points: patch.length,
      planSqft: hullArea(patch) * SQFT_PER_SQM,
      rms: fit.rms,
      bySection,
    });
  }
  planes.sort((a, b) => b.planSqft - a.planSqft);

  const sections = rings.map(({ id }): SectionReading => {
    // Each plane's share of this section, by its size, grouped by pitch (within 3/4 in 12).
    const parts = planes
      .filter((p) => p.bySection[id])
      .map((p) => ({ rise: p.rise, weight: p.planSqft * (p.bySection[id] / p.points), points: p.bySection[id] }));
    const groups: Array<{ rise: number; weight: number; points: number }> = [];
    for (const part of [...parts].sort((a, b) => b.weight - a.weight)) {
      const group = groups.find((g) => Math.abs(g.rise - part.rise) <= 0.75);
      if (group) {
        group.rise = (group.rise * group.weight + part.rise * part.weight) / (group.weight + part.weight);
        group.weight += part.weight;
        group.points += part.points;
      } else groups.push({ ...part });
    }
    groups.sort((a, b) => b.weight - a.weight);
    const [main, second] = groups;
    if (!main || main.points < 25) return { id, pitch: null, rise: main?.rise ?? null, points: main?.points ?? 0, alsoPitch: null };
    // A porch or dormer worth its own pitch: a tenth of the section or more, with enough points to trust.
    const also = second && second.weight >= main.weight * 0.1 && second.points >= 40 && lidarPitch(second.rise) !== lidarPitch(main.rise) ? lidarPitch(second.rise) : null;
    return { id, pitch: lidarPitch(main.rise), rise: main.rise, points: main.points, alsoPitch: also };
  });

  return { planes, sections, roofPoints: candidates.length, density: roofArea ? candidates.length / roofArea : 0 };
}

// ---------------------------------------------------------------------------------------------
// The pieces
// ---------------------------------------------------------------------------------------------

type Pt = { x: number; y: number; z: number };

/** The plane through the most points, tried through three points within a few meters of each other. */
function bestPlane<T extends Pt>(points: T[], random: () => number): T[] | null {
  const grid = new Map<string, T[]>();
  const cell = (p: Pt) => `${Math.floor(p.x / 2)},${Math.floor(p.y / 2)}`;
  for (const p of points) {
    const key = cell(p);
    const list = grid.get(key);
    if (list) list.push(p);
    else grid.set(key, [p]);
  }
  const nearby = (p: Pt) => {
    const [cx, cy] = [Math.floor(p.x / 2), Math.floor(p.y / 2)];
    const out: T[] = [];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) out.push(...(grid.get(`${cx + dx},${cy + dy}`) ?? []));
    return out;
  };
  let best: { count: number; n: number[]; a: Pt } | null = null;
  for (let t = 0; t < 400; t++) {
    const a = points[Math.floor(random() * points.length)];
    const near = nearby(a);
    if (near.length < 3) continue;
    const b = near[Math.floor(random() * near.length)];
    const c = near[Math.floor(random() * near.length)];
    const u = [b.x - a.x, b.y - a.y, b.z - a.z];
    const v = [c.x - a.x, c.y - a.y, c.z - a.z];
    let n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const len = Math.hypot(n[0], n[1], n[2]);
    if (len < 0.05) continue; // three points nearly in a line
    n = n.map((q) => q / len);
    if (n[2] < 0) n = n.map((q) => -q);
    if (n[2] < MAX_SLOPE_COS) continue;
    let count = 0;
    for (const p of points) if (Math.abs((p.x - a.x) * n[0] + (p.y - a.y) * n[1] + (p.z - a.z) * n[2]) < THRESHOLD) count++;
    if (!best || count > best.count) best = { count, n, a };
  }
  if (!best) return null;
  let on = points.filter((p) => Math.abs((p.x - best!.a.x) * best!.n[0] + (p.y - best!.a.y) * best!.n[1] + (p.z - best!.a.z) * best!.n[2]) < THRESHOLD);
  // Refit to all of them and take what's on the refitted plane.
  for (let i = 0; i < 2 && on.length >= 3; i++) {
    const { normal, center } = fitPlane(on);
    on = points.filter((p) => Math.abs((p.x - center[0]) * normal[0] + (p.y - center[1]) * normal[1] + (p.z - center[2]) * normal[2]) < THRESHOLD);
  }
  return on;
}

/** The biggest group of points that touch on a 1 m grid (one face of the roof, not every face that happens to line up with it). */
function biggestPatch<T extends Pt>(points: T[]): T[] {
  const cells = new Map<string, T[]>();
  for (const p of points) {
    const key = `${Math.floor(p.x)},${Math.floor(p.y)}`;
    const list = cells.get(key);
    if (list) list.push(p);
    else cells.set(key, [p]);
  }
  const seen = new Set<string>();
  let biggest: T[] = [];
  for (const start of cells.keys()) {
    if (seen.has(start)) continue;
    seen.add(start);
    const stack = [start];
    const group: T[] = [];
    while (stack.length) {
      const key = stack.pop()!;
      group.push(...cells.get(key)!);
      const [cx, cy] = key.split(",").map(Number);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const next = `${cx + dx},${cy + dy}`;
          if (cells.has(next) && !seen.has(next)) {
            seen.add(next);
            stack.push(next);
          }
        }
      }
    }
    if (group.length > biggest.length) biggest = group;
  }
  return biggest;
}

/** Least-squares plane: the direction the points spread least in (normal, pointing up), and how far they sit off it. */
export function fitPlane(points: Pt[]): { normal: [number, number, number]; center: [number, number, number]; rms: number } {
  const n = points.length || 1;
  const c = [0, 0, 0];
  for (const p of points) {
    c[0] += p.x / n;
    c[1] += p.y / n;
    c[2] += p.z / n;
  }
  const m = [0, 0, 0, 0, 0, 0]; // xx xy xz yy yz zz
  for (const p of points) {
    const [dx, dy, dz] = [p.x - c[0], p.y - c[1], p.z - c[2]];
    m[0] += dx * dx; m[1] += dx * dy; m[2] += dx * dz; m[3] += dy * dy; m[4] += dy * dz; m[5] += dz * dz;
  }
  let normal = smallestEigenvector([[m[0], m[1], m[2]], [m[1], m[3], m[4]], [m[2], m[4], m[5]]]);
  if (normal[2] < 0) normal = [-normal[0], -normal[1], -normal[2]];
  let sq = 0;
  for (const p of points) sq += ((p.x - c[0]) * normal[0] + (p.y - c[1]) * normal[1] + (p.z - c[2]) * normal[2]) ** 2;
  return { normal, center: [c[0], c[1], c[2]], rms: Math.sqrt(sq / n) };
}

/** Jacobi rotations on a symmetric 3x3 matrix; the eigenvector of its smallest eigenvalue. */
function smallestEigenvector(input: number[][]): [number, number, number] {
  const a = input.map((row) => [...row]);
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 30; sweep++) {
    const off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
    if (off < 1e-12) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(a[p][q]) < 1e-15) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const cos = 1 / Math.sqrt(t * t + 1);
      const sin = t * cos;
      for (let r = 0; r < 3; r++) {
        const [arp, arq] = [a[r][p], a[r][q]];
        a[r][p] = cos * arp - sin * arq;
        a[r][q] = sin * arp + cos * arq;
      }
      for (let r = 0; r < 3; r++) {
        const [apr, aqr] = [a[p][r], a[q][r]];
        a[p][r] = cos * apr - sin * aqr;
        a[q][r] = sin * apr + cos * aqr;
      }
      for (let r = 0; r < 3; r++) {
        const [vrp, vrq] = [v[r][p], v[r][q]];
        v[r][p] = cos * vrp - sin * vrq;
        v[r][q] = sin * vrp + cos * vrq;
      }
    }
  }
  const smallest = [0, 1, 2].reduce((best, i) => (a[i][i] < a[best][best] ? i : best), 0);
  return [v[0][smallest], v[1][smallest], v[2][smallest]];
}

/** Area of the points' outline seen from above (convex hull), in square meters. */
function hullArea(points: Pt[]): number {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length < 3) return 0;
  const cross = (o: Pt, a: Pt, b: Pt) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Pt[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Pt[] = [];
  for (const p of [...pts].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)];
  return ringArea(hull.map((p) => [p.x, p.y]));
}

function ringArea(ring: number[][]): number {
  let a = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    a += x1 * y2 - x2 * y1;
  }
  return Math.abs(a) / 2;
}

/**
 * The section a spot is in (the smallest, where a porch is drawn over the whole house), else the
 * nearest one within `slack` meters of it.
 */
function sectionAt(rings: Array<{ id: string; ring: number[][]; area: number }>, x: number, y: number, slack: number): string | null {
  let inside: { id: string; area: number } | null = null;
  let nearest: { id: string; d: number } | null = null;
  for (const { id, ring, area } of rings) {
    let within = false;
    let d = Infinity;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i];
      const [xj, yj] = ring[j];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) within = !within;
      d = Math.min(d, segmentDistance(x, y, xi, yi, xj, yj));
    }
    if (within && (!inside || area < inside.area)) inside = { id, area };
    if (d < slack && (!nearest || d < nearest.d)) nearest = { id, d };
  }
  return inside?.id ?? nearest?.id ?? null;
}

function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const [dx, dy] = [bx - ax, by - ay];
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** A small seeded random number generator, so the same points always give the same answer. */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
