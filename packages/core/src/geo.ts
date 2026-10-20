/**
 * Geometry for map measurements. Platform-free, so the browser, API and tests share it.
 *
 * Areas and lengths are computed on a sphere with the same mean Earth radius Turf uses
 * (6,371,008.8 m), so server totals match what the estimator saw while drawing. The server always
 * recomputes from the stored GeoJSON; totals sent by the browser are ignored.
 */
import polygonClipping, { type MultiPolygon as ClipMultiPolygon, type Polygon as ClipPolygon } from "polygon-clipping";

export const EARTH_RADIUS_M = 6371008.8;
export const SQFT_PER_SQM = 10.763910416709722;
export const FT_PER_M = 3.280839895013123;
export const SQFT_PER_SQYD = 9;
export const SQFT_PER_ROOFING_SQUARE = 100;

/** [longitude, latitude], GeoJSON order. */
export type Position = [number, number] | number[];

export interface Geometry {
  type: string;
  coordinates: unknown;
}
export interface Feature {
  type: "Feature";
  id?: string | number;
  geometry: Geometry | null;
  properties?: Record<string, unknown> | null;
}
export interface FeatureCollection {
  type: "FeatureCollection";
  features: Feature[];
}

/** A Cutout is an area taken out of the areas under it (the house out of the yard). */
export type ShapeKind = "Area" | "Length" | "Count" | "Cutout";

/**
 * The roof edges a line can be, for drip edge, starter, ridge cap and valley flashing. Rakes, hips
 * and valleys run up the roof, so they're longer than they look from above.
 */
export const ROOF_EDGES = ["eave", "rake", "ridge", "hip", "valley"] as const;
export type RoofEdge = (typeof ROOF_EDGES)[number];
export const isRoofEdge = (value: unknown): value is RoofEdge => (ROOF_EDGES as readonly unknown[]).includes(value);

export interface Section {
  feature_id: string;
  label: string;
  kind: ShapeKind;
  /** Areas after cutouts; for a cutout, how much it took out; lines at their true length. */
  value: number;
  unit: "sq ft" | "ft" | "ea";
  depth_in?: number | null;
  pitch?: string | null;
  manual_override: boolean;
  /** An area's size before cutouts took some out (only when they did). */
  uncut_value?: number;
  /** A line along a roof edge. */
  edge?: RoofEdge | null;
  /** A rake, hip or valley's length as seen from above, before the pitch stretched it. */
  plan_value?: number;
}

export interface MeasurementSummary {
  sections: Section[];
  total_area_sqft: number;
  total_area_sqyd: number;
  total_length_ft: number;
  count: number;
}

const rad = (deg: number) => (deg * Math.PI) / 180;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Unsigned area of a closed or open linear ring, in square metres. */
export function ringAreaM2(ring: Position[]): number {
  let coords = ring.map((p) => [Number(p[0]), Number(p[1])]);
  if (coords.length > 1) {
    const [first, last] = [coords[0], coords[coords.length - 1]];
    if (first[0] === last[0] && first[1] === last[1]) coords = coords.slice(0, -1);
  }
  const n = coords.length;
  if (n < 3) return 0;
  let total = 0;
  for (let i = 0; i < n; i++) {
    const lower = coords[i];
    const middle = coords[(i + 1) % n];
    const upper = coords[(i + 2) % n];
    total += (rad(upper[0]) - rad(lower[0])) * Math.sin(rad(middle[1]));
  }
  return Math.abs((total * EARTH_RADIUS_M * EARTH_RADIUS_M) / 2);
}

/** Outer ring minus holes. */
export function polygonAreaM2(rings: Position[][]): number {
  if (!rings.length) return 0;
  let area = ringAreaM2(rings[0]);
  for (const hole of rings.slice(1)) area -= ringAreaM2(hole);
  return Math.max(area, 0);
}

export function haversineM(a: Position, b: Position): number {
  const [lng1, lat1] = [rad(Number(a[0])), rad(Number(a[1]))];
  const [lng2, lat2] = [rad(Number(b[0])), rad(Number(b[1]))];
  const h = Math.sin((lat2 - lat1) / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin((lng2 - lng1) / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function lineLengthM(coords: Position[]): number {
  let total = 0;
  for (let i = 0; i < coords.length - 1; i++) total += haversineM(coords[i], coords[i + 1]);
  return total;
}

export const sqmToSqft = (sqm: number) => sqm * SQFT_PER_SQM;
export const mToFt = (m: number) => m * FT_PER_M;

// The steepest roof counted (about 68/12). Past that is a wall or a typo, and the squares run away:
// 89.999deg is 57,000 times the plan area.
const MAX_PITCH_DEGREES = 80;
const MAX_SLOPE = Math.tan(rad(MAX_PITCH_DEGREES));
const DEGREES = /^(-?\d+(?:\.\d+)?)\s*(?:deg|degrees?|°)$/;
const RISE_OVER_RUN = /^(\d+(?:\.\d+)?)(?:\s*(?:\/|-|:|in|on)\s*(\d+(?:\.\d+)?))?$/;
const pitchText = (pitch: string | number | null | undefined) => String(pitch ?? "").trim().toLowerCase().replace(/\s*pitch$/, "");

/**
 * Rise over run for a roof pitch: 0.5 for 6/12. Reads it the ways roofers write it ("6/12", "6-12",
 * "6:12", "6 in 12", "6 on 12", "6" for rise per 12, "26.5deg" or "26.5°"), up to 80 degrees, about
 * 68/12. Blank, 0 or "flat" is 0. Anything else throws RangeError.
 */
export function pitchSlope(pitch: string | number | null | undefined): number {
  const text = pitchText(pitch);
  if (text === "" || text === "0" || text === "flat") return 0;
  const bad = () => new RangeError(`Invalid roof pitch "${pitch}"`);
  let slope: number;
  const degrees = DEGREES.exec(text);
  if (degrees) {
    const d = Math.abs(Number(degrees[1]));
    if (!(d <= MAX_PITCH_DEGREES)) throw bad();
    slope = Math.tan(rad(d));
  } else {
    // Whole and decimal numbers only, so "1e200" or "7/0" can't sneak through as a number.
    const ratio = RISE_OVER_RUN.exec(text);
    if (!ratio) throw bad();
    const run = ratio[2] === undefined ? 12 : Number(ratio[2]);
    if (!(run > 0)) throw bad();
    slope = Number(ratio[1]) / run;
  }
  if (!(slope <= MAX_SLOPE)) throw bad(); // too steep to count, like "100/12"
  return slope;
}

/** Slope multiplier for a roof pitch (pitchSlope reads it): 1.118 for 6/12. Blank or flat is 1. */
export function pitchFactor(pitch: string | number | null | undefined): number {
  return Math.sqrt(1 + pitchSlope(pitch) ** 2);
}

/** How much longer a hip or valley is than it looks from above, with the same pitch on both sides. */
export function hipFactor(pitch: string | number | null | undefined): number {
  return Math.sqrt(1 + pitchSlope(pitch) ** 2 / 2);
}

/** Rise per 12 for a pitch, to one decimal: "6/12" for 6/12, 6-12, 6:12 or 8/16. Blank stays blank. */
export function normalizePitch(pitch: string | number | null | undefined): string {
  if (pitchText(pitch) === "") return "";
  const rise = Math.round(pitchSlope(pitch) * 12 * 10) / 10;
  return `${rise}/12`;
}

/** Whether a pitch reads (pitchSlope), for checking a field while someone types. */
export function isPitch(pitch: string | number | null | undefined): boolean {
  try {
    pitchSlope(pitch);
    return true;
  } catch {
    return false;
  }
}

/** Roof plane angle (for example from Google's Solar API) to rise per 12, rounded to the half inch. */
export function pitchFromDegrees(degrees: number): string {
  const rise = Math.tan(rad(degrees)) * 12;
  return `${Math.round(rise * 2) / 2}/12`;
}

export function roofingSquares(planAreaSqft: number, pitch: string | null | undefined, wastePct = 0): number {
  return (planAreaSqft * pitchFactor(pitch) * (1 + (wastePct || 0) / 100)) / SQFT_PER_ROOFING_SQUARE;
}

/** How much longer a roof edge is than it looks from above: rakes by the pitch, hips and valleys less. */
export function edgeFactor(edge: RoofEdge | null | undefined, pitch: string | number | null | undefined): number {
  if (edge === "rake") return pitchFactor(pitch);
  if (edge === "hip" || edge === "valley") return hipFactor(pitch);
  return 1; // eaves and ridges are level
}

type Sections = Pick<MeasurementSummary, "sections">;
const ownPitch = (s: Section) => (typeof s.pitch === "string" && pitchText(s.pitch) !== "" ? s.pitch : null);

/** The first pitch in a drawing that doesn't read, as a message to show, or null when they all do. */
export function pitchProblem(summary: Sections, pitch?: string | null): string | null {
  if (!isPitch(pitch)) return "Roof pitch should look like 7/12.";
  const bad = summary.sections.find((s) => ownPitch(s) && !isPitch(s.pitch));
  return bad ? `The pitch for ${bad.label} should look like 7/12.` : null;
}

/** Roof surface in square feet: each area at its own pitch, else the drawing's. Throws RangeError for a pitch that doesn't read. */
export function roofAreaSqft(summary: Sections, pitch?: string | null): number {
  return summary.sections.reduce((sum, s) => (s.kind === "Area" ? sum + Number(s.value) * pitchFactor(ownPitch(s) ?? pitch) : sum), 0);
}

/**
 * Roofing squares for a drawing: its roof surface (each area at its own pitch) plus waste. Null
 * when no pitch is set anywhere, so it isn't a roof. Throws RangeError for a pitch that doesn't read.
 */
export function drawingSquares(summary: Sections, pitch: string | null | undefined, wastePct = 0): number | null {
  if (pitchText(pitch) === "" && !summary.sections.some((s) => s.kind === "Area" && ownPitch(s))) return null;
  return (roofAreaSqft(summary, pitch) * (1 + (wastePct || 0) / 100)) / SQFT_PER_ROOFING_SQUARE;
}

/** One slope factor for a whole drawing, weighted by area, so area_sqft * pitch_factor is still its roof surface when the sections' pitches differ. */
export function drawingPitchFactor(summary: Sections, pitch?: string | null): number {
  const area = summary.sections.reduce((sum, s) => (s.kind === "Area" ? sum + Number(s.value) : sum), 0);
  return area > 0 ? roofAreaSqft(summary, pitch) / area : pitchFactor(pitch);
}

/** Feet of each kind of roof edge in a drawing, at true length. */
export function edgeLengths(summary: Sections): Record<RoofEdge, number> {
  const totals = Object.fromEntries(ROOF_EDGES.map((edge) => [edge, 0])) as Record<RoofEdge, number>;
  for (const s of summary.sections) if (s.kind === "Length" && isRoofEdge(s.edge)) totals[s.edge] += Number(s.value);
  for (const edge of ROOF_EDGES) totals[edge] = round2(totals[edge]);
  return totals;
}

/** How deep each kind of shape nests its [longitude, latitude] points. */
const NESTING: Record<string, number> = { Point: 0, MultiPoint: 1, LineString: 1, Polygon: 2, MultiPolygon: 3 };

const isPosition = (value: unknown) =>
  Array.isArray(value) && value.length >= 2 && value.every((n) => typeof n === "number" && Number.isFinite(n)) &&
  Math.abs(value[0]) <= 180 && Math.abs(value[1]) <= 90;
const nestsPositions = (value: unknown, depth: number): boolean =>
  depth === 0 ? isPosition(value) : Array.isArray(value) && value.every((item) => nestsPositions(item, depth - 1));

type ClipGeometry = ClipPolygon | ClipMultiPolygon;
const isPolygonal = (geometry: Geometry | null | undefined): geometry is Geometry => geometry?.type === "Polygon" || geometry?.type === "MultiPolygon";
const pair = (p: Position): [number, number] => [Number(p[0]), Number(p[1])];
const toClip = (geometry: Geometry): ClipGeometry =>
  geometry.type === "Polygon"
    ? (geometry.coordinates as Position[][]).map((ring) => ring.map(pair))
    : (geometry.coordinates as Position[][][]).map((polygon) => polygon.map((ring) => ring.map(pair)));
const asMulti = (geometry: Geometry): Position[][][] => (geometry.type === "Polygon" ? [geometry.coordinates as Position[][]] : (geometry.coordinates as Position[][][]));
const multiAreaM2 = (polygons: Position[][][]) => polygons.reduce((sum, polygon) => sum + polygonAreaM2(polygon), 0);
// The clipping library throws on shapes it can't make sense of (say a ring of two points).
function clip<T>(run: () => T): T | null {
  try {
    return run();
  } catch {
    return null;
  }
}

/**
 * An area with cutouts taken out, as MultiPolygon coordinates: the yard with the house out of it.
 * When the shapes can't be cut (a ring too small to be a shape), the area comes back whole.
 */
export function cutOut(area: Geometry, cutouts: Geometry[]): Position[][][] {
  const clips = cutouts.filter(isPolygonal).map(toClip);
  if (!isPolygonal(area) || !clips.length) return isPolygonal(area) ? asMulti(area) : [];
  return clip(() => polygonClipping.difference(toClip(area), ...clips)) ?? asMulti(area);
}

/** Polygons that overlap or touch joined into one (a building split across map tiles), as Polygon coordinates. */
export function mergePolygons(polygons: Position[][][]): Position[][][] {
  const clips = polygons.filter((p) => p[0]?.length >= 4).map((p) => toClip({ type: "Polygon", coordinates: p }));
  if (clips.length < 2) return clips as Position[][][];
  return clip(() => polygonClipping.union(clips[0], ...clips.slice(1))) ?? (clips as Position[][][]);
}

export interface SummaryOptions {
  /** The drawing's roof pitch, for rakes, hips and valleys whose line has none of its own. */
  pitch?: string | null;
}

/**
 * Per-shape values and totals for a FeatureCollection. Feature properties understood: label,
 * depth_in, pitch, manual_value (overrides the computed value, for shapes measured on site),
 * cutout (true: an area taken out of the areas under it) and edge (a line along a roof edge, see
 * ROOF_EDGES). Cutouts come off every area they cover, and lines along a rake, hip or valley are
 * stretched by their pitch. Throws RangeError, with a message to show, for a shape whose points or
 * value aren't numbers.
 */
export function summarizeFeatureCollection(collection: FeatureCollection, options: SummaryOptions = {}): MeasurementSummary {
  const sections: Section[] = [];
  // Measured from their shapes (not typed in), so cutouts can come off them once everything is read.
  const areas: Array<{ section: Section; geometry: Geometry; sqft: number }> = [];
  const cutouts: Array<{ section: Section; geometry: Geometry }> = [];

  (collection.features ?? []).forEach((feature, index) => {
    const geometry = feature.geometry;
    if (!geometry) return;
    // Shapes can come from the API as well as the map, so check them before doing math on them.
    if (Object.hasOwn(NESTING, geometry.type) && !nestsPositions(geometry.coordinates, NESTING[geometry.type])) {
      throw new RangeError(`Shape ${index + 1} needs its points as [longitude, latitude] numbers`);
    }
    const props = feature.properties ?? {};
    const coords = geometry.coordinates as never;
    const isCutout = isPolygonal(geometry) && props.cutout === true;
    let kind: ShapeKind;
    let unit: Section["unit"];
    let value: number;

    switch (geometry.type) {
      case "Polygon":
      case "MultiPolygon":
        [kind, unit, value] = [isCutout ? "Cutout" : "Area", "sq ft", sqmToSqft(multiAreaM2(asMulti(geometry)))];
        break;
      case "LineString":
        [kind, unit, value] = ["Length", "ft", mToFt(lineLengthM(coords))];
        break;
      case "Point":
        [kind, unit, value] = ["Count", "ea", 1];
        break;
      case "MultiPoint":
        [kind, unit, value] = ["Count", "ea", (coords as Position[]).length];
        break;
      default:
        return;
    }

    const manual = props.manual_value;
    // A cutout is only ever what its shape covers.
    const hasManual = kind !== "Cutout" && manual !== undefined && manual !== null && manual !== "";
    if (hasManual) {
      value = Number(manual);
      if (!(value >= 0 && Number.isFinite(value))) throw new RangeError(`Shape ${index + 1} needs a measured value of zero or more`);
    }
    const pitch = typeof props.pitch === "string" ? props.pitch : null;
    const edge = kind === "Length" && isRoofEdge(props.edge) ? props.edge : null;
    // A pitch still being typed counts as flat here; pitchProblem() is what refuses it.
    const stretch = edge && !hasManual ? clip(() => edgeFactor(edge, pitch?.trim() || options.pitch)) ?? 1 : 1;

    const section: Section = {
      feature_id: String(feature.id ?? index),
      label: typeof props.label === "string" && props.label ? props.label : `${kind} ${index + 1}`,
      kind,
      value: round2(value * stretch),
      unit,
      depth_in: props.depth_in == null || props.depth_in === "" ? null : Number(props.depth_in),
      pitch,
      manual_override: hasManual,
      ...(edge ? { edge } : {}),
      ...(stretch !== 1 ? { plan_value: round2(value) } : {}),
    };
    sections.push(section);
    if (kind === "Area" && !hasManual) areas.push({ section, geometry, sqft: value });
    if (kind === "Cutout") cutouts.push({ section, geometry });
  });

  if (cutouts.length) {
    const cuts = cutouts.map((c) => c.geometry);
    for (const a of areas) {
      const left = sqmToSqft(multiAreaM2(cutOut(a.geometry, cuts)));
      if (left < a.sqft - 0.005) {
        a.section.uncut_value = round2(a.sqft);
        a.section.value = round2(left);
      }
    }
    // What each cutout took out: the part of it that's over an area.
    const under = areas.length ? clip(() => polygonClipping.union(toClip(areas[0].geometry), ...areas.slice(1).map((a) => toClip(a.geometry)))) : null;
    for (const c of cutouts) {
      const taken = under && clip(() => polygonClipping.intersection(toClip(c.geometry), under));
      c.section.value = round2(taken ? sqmToSqft(multiAreaM2(taken)) : 0);
    }
  }

  const total = (kind: ShapeKind) => sections.reduce((sum, s) => (s.kind === kind ? sum + s.value : sum), 0);
  const area = total("Area");
  return {
    sections,
    total_area_sqft: round2(area),
    total_area_sqyd: round2(area / SQFT_PER_SQYD),
    total_length_ft: round2(total("Length")),
    count: total("Count"),
  };
}
