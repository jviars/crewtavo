/**
 * The slope of the ground under a drawn lawn, from free USGS elevation (3DEP: about 1 m lidar over
 * most of the US, bare ground with trees and buildings taken out, public domain). USGS works out the
 * slope of every meter inside the outline and sends back only how they spread: no key, and nothing
 * big comes down. The browser asks it while a lawn is drawn (Measure); the server asks it for a
 * drawing an assistant saves. It reads the ground at the outline's coordinates, not a picture, so
 * it's the same under any imagery, Google's included.
 */
import { cutOut, polygonAreaM2, type Geometry, type GroundSlope, type Position } from "./geo";

export const DEP_SERVICE = "https://elevation.nationalmap.gov/arcgis/rest/services/3DEPElevation/ImageServer";
/** 3DEP covers the US and its territories; nothing is asked for outside this box. */
export const US_BOX: [number, number, number, number] = [-179.5, 17.5, -64.5, 71.5];
/** Steeper than this grade (3:1) is what a lawn's slope counts as steep (steep_pct). */
export const STEEP_GRADE = 33.3;

// Core has no browser or Node types; these two are in every place it runs (browsers, Node, Workers).
declare const fetch: (url: string, init: { method: "POST"; headers: Record<string, string>; body: string; signal?: unknown }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
declare const setTimeout: (done: () => void, ms: number) => unknown;

/** What computeStatisticsHistograms sends back: the slopes' average and their spread. */
export interface SlopeStats {
  statistics?: Array<{ mean: number; count: number }>;
  histograms?: Array<{ min: number; max: number; counts: number[] }>;
  error?: { message?: string };
}

/** Each meter's grade, in percent. USGS's Slope handles its Web Mercator meters itself (checked against elevations). */
const SLOPE_RULE = JSON.stringify({ rasterFunction: "Slope", rasterFunctionArguments: { ZFactor: 1, SlopeType: 2 } });

/** The average grade and how much is steeper than 3:1, or null when USGS has no elevation there. */
export function slopeFrom(stats: SlopeStats): GroundSlope | null {
  const average = stats.statistics?.[0];
  const spread = stats.histograms?.[0];
  if (!average?.count || !spread?.counts.length) return null;
  const { min, max, counts } = spread;
  const width = (max - min) / counts.length;
  // A bin the 3:1 line runs through counts for the part of it past the line.
  const past = (i: number) => (width ? Math.min(1, Math.max(0, (min + (i + 1) * width - STEEP_GRADE) / width)) : min > STEEP_GRADE ? 1 : 0);
  const total = counts.reduce((sum, n) => sum + n, 0);
  const steep = counts.reduce((sum, n, i) => sum + n * past(i), 0);
  return { mean_pct: Math.round(average.mean * 10) / 10, steep_pct: Math.round((steep / total) * 1000) / 10 };
}

/** The slope under an area, less the cutouts over it; null where USGS has no elevation (outside the US). */
export async function readSlope(area: Geometry, cutouts: Geometry[], signal?: { aborted: boolean }): Promise<GroundSlope | null> {
  const rings = cutOut(area, cutouts).flat();
  const [west, south, east, north] = US_BOX;
  const inUs = rings.flat().every((p) => Number(p[0]) >= west && Number(p[0]) <= east && Number(p[1]) >= south && Number(p[1]) <= north);
  if (!rings.length || !inUs) return null;
  // Sent as a form: a big lawn's outline is too long for a link, and a form needs no CORS preflight.
  const fields = { geometry: JSON.stringify({ rings, spatialReference: { wkid: 4326 } }), geometryType: "esriGeometryPolygon", renderingRule: SLOPE_RULE, f: "json" };
  const body = Object.entries(fields).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("&");
  const headers = { "Content-Type": "application/x-www-form-urlencoded" };
  // USGS is sometimes slow and gives up with a gateway error, which a browser only sees as a failed
  // fetch (it has no CORS header): three tries, a little apart, before saying so.
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(`${DEP_SERVICE}/computeStatisticsHistograms`, { method: "POST", headers, body, signal });
      if (!response.ok) throw new Error(`USGS elevation returned ${response.status}`);
      const stats = (await response.json()) as SlopeStats;
      if (stats.error) throw new Error(stats.error.message ?? "USGS elevation sent an error");
      return slopeFrom(stats);
    } catch (error) {
      if (attempt === TRIES || signal?.aborted) throw error;
      await new Promise<void>((done) => setTimeout(done, attempt * 1500));
    }
  }
}

const TRIES = 3;

// ---------------------------------------------------------------------------------------------
// Slope from heights on a grid: for elevation that's asked point by point (Google's, outside the US).
// ---------------------------------------------------------------------------------------------

/** A point to ask the height at, and where it sits on the grid (column i, row j). */
export interface GridPoint { i: number; j: number; lng: number; lat: number }
export interface SlopeGrid { step: number; points: GridPoint[] }

/** Meters per degree, near enough over a lawn. */
const M_PER_DEG_LAT = 110_574;
const mPerDegLng = (lat: number) => 111_320 * Math.cos((lat * Math.PI) / 180);

/** Whether a point (in meters) is inside a polygon: an odd number of its rings' edges cross a ray from it. */
function inside(x: number, y: number, rings: number[][][]): boolean {
  let odd = false;
  for (const ring of rings) {
    for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
      const [xa, ya] = ring[a];
      const [xb, yb] = ring[b];
      if (ya > y !== yb > y && x < ((xb - xa) * (y - ya)) / (yb - ya) + xa) odd = !odd;
    }
  }
  return odd;
}

/**
 * Points on a grid over a lawn less its cutouts (cutOut's polygons), to ask heights at. The step
 * grows on a big lawn so there are about `max` points, and is never under 2 m, about as fine as
 * elevation data goes.
 */
export function slopeGrid(polygons: Position[][][], max = 400): SlopeGrid {
  const all = polygons.flat(2);
  if (!all.length) return { step: 0, points: [] };
  const lng0 = all.reduce((t, p) => t + Number(p[0]), 0) / all.length;
  const lat0 = all.reduce((t, p) => t + Number(p[1]), 0) / all.length;
  const mx = mPerDegLng(lat0);
  const shapes = polygons.map((rings) => rings.map((ring) => ring.map((p) => [(Number(p[0]) - lng0) * mx, (Number(p[1]) - lat0) * M_PER_DEG_LAT])));
  const area = polygons.reduce((t, rings) => t + polygonAreaM2(rings), 0);
  const step = Math.max(2, Math.sqrt(area / max));
  const xs = shapes.flat(2).map((p) => p[0]);
  const ys = shapes.flat(2).map((p) => p[1]);
  const [left, bottom] = [Math.min(...xs), Math.min(...ys)];
  const points: GridPoint[] = [];
  for (let i = 0, x = left + step / 2; x < Math.max(...xs); i++, x += step) {
    for (let j = 0, y = bottom + step / 2; y < Math.max(...ys); j++, y += step) {
      if (shapes.some((rings) => inside(x, y, rings))) points.push({ i, j, lng: lng0 + x / mx, lat: lat0 + y / M_PER_DEG_LAT });
    }
  }
  return { step, points };
}

/**
 * The slope from heights (meters) at slopeGrid's points, in the same order: each point's grade from
 * its neighbors on the grid, then their average and how many are steeper than 3:1. Null when no
 * point has a neighbor with a height.
 */
export function slopeFromGrid(grid: SlopeGrid, heights: readonly number[]): GroundSlope | null {
  const at = new Map(grid.points.flatMap((p, n) => (Number.isFinite(heights[n]) ? [[`${p.i},${p.j}`, heights[n]] as const] : [])));
  const grades: number[] = [];
  grid.points.forEach((p, n) => {
    const h = heights[n];
    if (!Number.isFinite(h)) return;
    // Across both neighbors where there are two, else from the one there is.
    const rise = (di: number, dj: number) => {
      const ahead = at.get(`${p.i + di},${p.j + dj}`);
      const behind = at.get(`${p.i - di},${p.j - dj}`);
      if (ahead !== undefined && behind !== undefined) return (ahead - behind) / (2 * grid.step);
      if (ahead !== undefined) return (ahead - h) / grid.step;
      if (behind !== undefined) return (h - behind) / grid.step;
      return null;
    };
    const [gx, gy] = [rise(1, 0), rise(0, 1)];
    if (gx === null && gy === null) return;
    grades.push(100 * Math.hypot(gx ?? 0, gy ?? 0));
  });
  if (!grades.length) return null;
  const mean = grades.reduce((t, g) => t + g, 0) / grades.length;
  const steep = grades.filter((g) => g > STEEP_GRADE).length / grades.length;
  return { mean_pct: Math.round(mean * 10) / 10, steep_pct: Math.round(steep * 1000) / 10, from: "google" };
}
