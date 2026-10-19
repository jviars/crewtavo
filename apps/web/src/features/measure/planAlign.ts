/**
 * Putting a plan sheet on the map: where its corners go. The sheet is moved, turned and sized as
 * one piece (never stretched), worked out in Web Mercator, the map's own flat projection, which
 * keeps shapes true at the scale of a parking lot. Lining it up takes two spots found on both the
 * plan and the aerial: the first pins it in place, the second sets its size and angle.
 *
 * Plan pixels run right (u) and down (v); Mercator x runs east and y south, so the two turn the
 * same way and a placement is a complex number: point = origin + scale * pixel.
 */

export type LngLat = [number, number];
/** Top left, top right, bottom right, bottom left: the order MapLibre's image sources use. */
export type Corners = [LngLat, LngLat, LngLat, LngLat];

export interface Placement {
  /** Where the plan's top-left pixel is, in Mercator (0 to 1 across the world). */
  ox: number;
  oy: number;
  /** Mercator units per plan pixel, as a complex number: size and turn together. */
  a: number;
  b: number;
}

const EARTH_CIRCUMFERENCE_M = 40_075_016.686;
const FEET_PER_M = 3.280_839_9;

export function toMercator([lng, lat]: LngLat): [number, number] {
  const s = Math.sin((Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180);
  return [(lng + 180) / 360, 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)];
}

export function fromMercator([x, y]: [number, number]): LngLat {
  return [x * 360 - 180, (360 / Math.PI) * Math.atan(Math.exp((0.5 - y) * 2 * Math.PI)) - 90];
}

function apply(p: Placement, [u, v]: [number, number]): [number, number] {
  return [p.ox + p.a * u - p.b * v, p.oy + p.b * u + p.a * v];
}

/** Where a plan pixel lands on the map. */
export function pointAt(p: Placement, pixel: [number, number]): LngLat {
  return fromMercator(apply(p, pixel));
}

/** Which plan pixel is under a spot on the map. */
export function pixelAt(p: Placement, lngLat: LngLat): [number, number] {
  const [x, y] = toMercator(lngLat);
  const dx = x - p.ox;
  const dy = y - p.oy;
  const d = p.a * p.a + p.b * p.b;
  return [(p.a * dx + p.b * dy) / d, (-p.b * dx + p.a * dy) / d];
}

export function cornersOf(p: Placement, width: number, height: number): Corners {
  return [pointAt(p, [0, 0]), pointAt(p, [width, 0]), pointAt(p, [width, height]), pointAt(p, [0, height])];
}

/** Back from saved corners (only the top two are needed: the sheet isn't stretched). */
export function placementFromCorners(corners: Corners, width: number): Placement {
  const [tlx, tly] = toMercator(corners[0]);
  const [trx, try_] = toMercator(corners[1]);
  return { ox: tlx, oy: tly, a: (trx - tlx) / width, b: (try_ - tly) / width };
}

/** A first guess: the sheet upright in the middle of the view, `fraction` of its width across. */
export function fitToView(center: LngLat, viewWest: number, viewEast: number, width: number, height: number, fraction = 0.8): Placement {
  const [cx, cy] = toMercator(center);
  const across = Math.abs(toMercator([viewEast, center[1]])[0] - toMercator([viewWest, center[1]])[0]);
  const a = (across * fraction) / width;
  return { ox: cx - (a * width) / 2, oy: cy - (a * height) / 2, a, b: 0 };
}

/** The same size and angle, moved so `pixel` lands on `lngLat`. */
export function moveTo(p: Placement, pixel: [number, number], lngLat: LngLat): Placement {
  const [x, y] = toMercator(lngLat);
  const [px, py] = apply(p, pixel);
  return { ...p, ox: p.ox + x - px, oy: p.oy + y - py };
}

export class LineUpError extends Error {}

/** The placement that puts both plan pixels on their spots on the map. */
export function lineUp(pixels: [[number, number], [number, number]], spots: [LngLat, LngLat]): Placement {
  const [[u1, v1], [u2, v2]] = pixels;
  const [x1, y1] = toMercator(spots[0]);
  const [x2, y2] = toMercator(spots[1]);
  const du = u2 - u1;
  const dv = v2 - v1;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const plan = du * du + dv * dv;
  if (plan < 3600) throw new LineUpError("The two spots on the plan are too close together. Pick spots far apart, like opposite corners of the lot.");
  if (dx * dx + dy * dy === 0) throw new LineUpError("The two spots on the map are the same. Tap the second spot where it is on the aerial.");
  // c = (z2 - z1) / (w2 - w1), with z = x + iy and w = u + iv.
  const a = (dx * du + dy * dv) / plan;
  const b = (dy * du - dx * dv) / plan;
  return { ox: x1 - (a * u1 - b * v1), oy: y1 - (b * u1 + a * v1), a, b };
}

/** Real-world feet that one plan pixel covers, at this latitude. */
export function feetPerPixel(p: Placement, lat: number): number {
  return Math.hypot(p.a, p.b) * EARTH_CIRCUMFERENCE_M * Math.cos((lat * Math.PI) / 180) * FEET_PER_M;
}

/** The plan's scale as it's lined up: feet on the ground per inch of the printed sheet. */
export function feetPerInch(p: Placement, lat: number, pxPerInch: number): number {
  return feetPerPixel(p, lat) * pxPerInch;
}

/** "1 in = 30 ft", the way plans write it. */
export function scaleLabel(ftPerInch: number): string {
  const n = ftPerInch >= 10 ? Math.round(ftPerInch) : Math.round(ftPerInch * 10) / 10;
  return `1 in = ${n.toLocaleString()} ft`;
}

/** How far the plan is turned from north-up, in degrees clockwise. */
export function turnDegrees(p: Placement): number {
  return ((Math.atan2(p.b, p.a) * 180) / Math.PI + 360) % 360;
}

export const isCorners = (value: unknown): value is Corners =>
  Array.isArray(value) && value.length === 4 && value.every((c) => Array.isArray(c) && c.length === 2 && c.every((n) => typeof n === "number" && Number.isFinite(n)));
