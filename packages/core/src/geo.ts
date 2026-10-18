/**
 * Geometry for map measurements. Platform-free, so the browser, API and tests share it.
 *
 * Areas and lengths are computed on a sphere with the same mean Earth radius Turf uses
 * (6,371,008.8 m), so server totals match what the estimator saw while drawing. The server always
 * recomputes from the stored GeoJSON; totals sent by the browser are ignored.
 */

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

export type ShapeKind = "Area" | "Length" | "Count";

export interface Section {
  feature_id: string;
  label: string;
  kind: ShapeKind;
  value: number;
  unit: "sq ft" | "ft" | "ea";
  depth_in?: number | null;
  pitch?: string | null;
  manual_override: boolean;
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

/**
 * Slope multiplier for a roof pitch. Accepts "7/12" (rise over run), "7" (rise per 12) or
 * "30deg". Blank or flat returns 1.
 */
export function pitchFactor(pitch: string | number | null | undefined): number {
  if (pitch === null || pitch === undefined || pitch === "" || pitch === 0 || pitch === "0") return 1;
  const text = String(pitch).trim().toLowerCase();
  if (text.endsWith("deg")) {
    // Short of upright: at 90 degrees the slope never ends.
    const degrees = Number(text.slice(0, -3));
    if (!(Math.abs(degrees) < 90)) throw new RangeError(`Invalid roof pitch "${pitch}"`);
    return 1 / Math.cos(rad(degrees));
  }
  let rise: number;
  let run = 12;
  if (text.includes("/")) {
    const [r, n] = text.split("/", 2);
    rise = Number(r);
    run = Number(n);
  } else {
    rise = Number(text);
  }
  if (!Number.isFinite(rise) || !Number.isFinite(run) || run <= 0) throw new RangeError(`Invalid roof pitch "${pitch}"`);
  const factor = Math.sqrt(1 + (rise / run) ** 2);
  if (!Number.isFinite(factor)) throw new RangeError(`Invalid roof pitch "${pitch}"`); // too steep to count, like "1e200/12"
  return factor;
}

/** Roof plane angle (for example from Google's Solar API) to rise per 12, rounded to the half inch. */
export function pitchFromDegrees(degrees: number): string {
  const rise = Math.tan(rad(degrees)) * 12;
  return `${Math.round(rise * 2) / 2}/12`;
}

export function roofingSquares(planAreaSqft: number, pitch: string | null | undefined, wastePct = 0): number {
  return (planAreaSqft * pitchFactor(pitch) * (1 + (wastePct || 0) / 100)) / SQFT_PER_ROOFING_SQUARE;
}

/** How deep each kind of shape nests its [longitude, latitude] points. */
const NESTING: Record<string, number> = { Point: 0, MultiPoint: 1, LineString: 1, Polygon: 2, MultiPolygon: 3 };

const isPosition = (value: unknown) =>
  Array.isArray(value) && value.length >= 2 && value.every((n) => typeof n === "number" && Number.isFinite(n)) &&
  Math.abs(value[0]) <= 180 && Math.abs(value[1]) <= 90;
const nestsPositions = (value: unknown, depth: number): boolean =>
  depth === 0 ? isPosition(value) : Array.isArray(value) && value.every((item) => nestsPositions(item, depth - 1));

/**
 * Per-shape values and totals for a FeatureCollection. Feature properties understood: label,
 * depth_in, pitch, manual_value (overrides the computed value, for shapes measured on site).
 * Throws RangeError, with a message to show, for a shape whose points or value aren't numbers.
 */
export function summarizeFeatureCollection(collection: FeatureCollection): MeasurementSummary {
  const sections: Section[] = [];
  let area = 0;
  let length = 0;
  let count = 0;

  (collection.features ?? []).forEach((feature, index) => {
    const geometry = feature.geometry;
    if (!geometry) return;
    // Shapes can come from the API as well as the map, so check them before doing math on them.
    if (Object.hasOwn(NESTING, geometry.type) && !nestsPositions(geometry.coordinates, NESTING[geometry.type])) {
      throw new RangeError(`Shape ${index + 1} needs its points as [longitude, latitude] numbers`);
    }
    const props = feature.properties ?? {};
    const coords = geometry.coordinates as never;
    let kind: ShapeKind;
    let unit: Section["unit"];
    let value: number;

    switch (geometry.type) {
      case "Polygon":
        [kind, unit, value] = ["Area", "sq ft", sqmToSqft(polygonAreaM2(coords))];
        break;
      case "MultiPolygon":
        [kind, unit, value] = ["Area", "sq ft", sqmToSqft((coords as Position[][][]).reduce((s, p) => s + polygonAreaM2(p), 0))];
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
    const hasManual = manual !== undefined && manual !== null && manual !== "";
    if (hasManual) {
      value = Number(manual);
      if (!(value >= 0 && Number.isFinite(value))) throw new RangeError(`Shape ${index + 1} needs a measured value of zero or more`);
    }
    if (kind === "Area") area += value;
    else if (kind === "Length") length += value;
    else count += value;

    sections.push({
      feature_id: String(feature.id ?? index),
      label: typeof props.label === "string" && props.label ? props.label : `${kind} ${index + 1}`,
      kind,
      value: round2(value),
      unit,
      depth_in: props.depth_in == null || props.depth_in === "" ? null : Number(props.depth_in),
      pitch: typeof props.pitch === "string" ? props.pitch : null,
      manual_override: hasManual,
    });
  });

  return {
    sections,
    total_area_sqft: round2(area),
    total_area_sqyd: round2(area / SQFT_PER_SQYD),
    total_length_ft: round2(length),
    count,
  };
}
