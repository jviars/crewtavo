/**
 * Building outlines from OpenStreetMap, for cutting the house out of a yard in one tap or starting a
 * roof from its outline. Free and keyless (ODbL, so drawings that use them carry the credit). The map
 * usually has them already, in the street map's tiles (MeasureMap's buildings()); when it doesn't,
 * they're asked from the browser through the public Overpass API, with a second server for when the
 * first is busy.
 * Coverage is good in towns and patchy in the country, and outlines follow the walls, not the eaves.
 */
import { cutOut, polygonAreaM2, type Position } from "@crewtavo/core/geo";

export const OSM_BUILDINGS_CREDIT = "Building outlines © OpenStreetMap contributors";
const SERVERS = ["https://overpass-api.de/api/interpreter", "https://overpass.private.coffee/api/interpreter"];
/** About a kilometer across: plenty for a property, and kind to a free server. */
const MAX_SPAN_DEG = 0.012;

/** [west, south, east, north] */
export type Box = [number, number, number, number];
type Ring = Position[];
type Element = { type: string; geometry?: Array<{ lat: number; lon: number }>; members?: Array<{ role: string; geometry?: Array<{ lat: number; lon: number }> }> };

export class BuildingsError extends Error {}

const ring = (points: Array<{ lat: number; lon: number }>): Ring => {
  const r = points.map((p) => [p.lon, p.lat]);
  const [first, last] = [r[0], r[r.length - 1]];
  if (first[0] !== last[0] || first[1] !== last[1]) r.push([...first]);
  return r;
};
const isRing = (points?: Array<unknown>) => (points?.length ?? 0) >= 4;

/** Outlines of the buildings in a box, as Polygon coordinates (outer ring first, then courtyards). */
export async function buildingsIn([w, s, e, n]: Box): Promise<Ring[][]> {
  if (e - w > MAX_SPAN_DEG || n - s > MAX_SPAN_DEG) throw new BuildingsError("That's too big an area to look for buildings in. Zoom in to the property, or draw the building with Cut out.");
  const query = `[out:json][timeout:15];(way["building"](${s},${w},${n},${e});relation["building"]["type"="multipolygon"](${s},${w},${n},${e}););out geom;`;
  for (const [i, server] of SERVERS.entries()) {
    try {
      // GET: the main server turns POSTs from browsers away. It can be slow when busy, so it gets longer.
      const response = await fetch(`${server}?data=${encodeURIComponent(query)}`, { signal: AbortSignal.timeout(i ? 15_000 : 35_000) });
      if (!response.ok) continue;
      const body = (await response.json()) as { elements?: Element[] };
      return toPolygons(body.elements ?? []);
    } catch {
      /* busy or down: try the next one */
    }
  }
  throw new BuildingsError("OpenStreetMap's building server isn't answering right now. Try again in a minute, or draw the building with Cut out.");
}

function toPolygons(elements: Element[]): Ring[][] {
  const polygons: Ring[][] = [];
  for (const el of elements) {
    if (el.type === "way" && isRing(el.geometry)) polygons.push([ring(el.geometry!)]);
    if (el.type === "relation") {
      const outers = (el.members ?? []).filter((m) => m.role === "outer" && isRing(m.geometry));
      const inners = (el.members ?? []).filter((m) => m.role === "inner" && isRing(m.geometry));
      // Courtyards only go with a single outline; with several we can't tell whose they are.
      for (const outer of outers) polygons.push([ring(outer.geometry!), ...(outers.length === 1 ? inners.map((m) => ring(m.geometry!)) : [])]);
    }
  }
  return polygons;
}

const polygon = (coordinates: Ring[]) => ({ type: "Polygon", coordinates });
const areaOf = (polygons: Position[][][]) => polygons.reduce((sum, p) => sum + polygonAreaM2(p), 0);

/**
 * The buildings that sit on the areas (at least a tenth of the building over them), leaving out
 * any that's mostly cut out already.
 */
export function buildingsOn(buildings: Ring[][], areas: Ring[][], cutouts: Ring[][]): Ring[][] {
  return buildings.filter((b) => {
    const whole = polygonAreaM2(b);
    if (!(whole > 1)) return false;
    const offAreas = areaOf(cutOut(polygon(b), areas.map(polygon)));
    const uncut = areaOf(cutOut(polygon(b), cutouts.map(polygon)));
    return whole - offAreas > whole * 0.1 && uncut > whole * 0.5;
  });
}

/** The building a spot is in, else the nearest one within about 30 m of it. */
export function buildingAt(buildings: Ring[][], [lng, lat]: [number, number]): Ring[] | null {
  const inside = buildings.find((b) => contains(b[0], lng, lat));
  if (inside) return inside;
  const metersPerDegLng = 111_320 * Math.cos((lat * Math.PI) / 180);
  let best: { b: Ring[]; d: number } | null = null;
  for (const b of buildings) {
    for (const p of b[0]) {
      const d = Math.hypot((Number(p[0]) - lng) * metersPerDegLng, (Number(p[1]) - lat) * 111_320);
      if (d < 30 && (!best || d < best.d)) best = { b, d };
    }
  }
  return best?.b ?? null;
}

function contains(r: Ring, x: number, y: number) {
  let inside = false;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const [xi, yi] = [Number(r[i][0]), Number(r[i][1])];
    const [xj, yj] = [Number(r[j][0]), Number(r[j][1])];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** The box around some shapes, a few meters bigger so buildings on the edge come along. */
export function boxAround(polygons: Ring[][]): Box | null {
  let [w, s, e, n] = [180, 90, -180, -90];
  for (const p of polygons) for (const pt of p[0] ?? []) {
    w = Math.min(w, Number(pt[0])); e = Math.max(e, Number(pt[0]));
    s = Math.min(s, Number(pt[1])); n = Math.max(n, Number(pt[1]));
  }
  const pad = 0.00005;
  return w <= e ? [w - pad, s - pad, e + pad, n + pad] : null;
}
