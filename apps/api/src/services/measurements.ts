/**
 * Saving a drawing (Measure's Save, and an assistant's save_lawn_measurement), a measurement's
 * values for quote formulas (FORMULA_VARIABLES), and filling a quote's lines from them: "Fill
 * quantities from this" on a quote (POST /quotes/:id/apply-measurement) and a roof package's lines
 * on a roof estimate (routes/roofing.ts) both work them out here, so they agree.
 */
import {
  drawingPitchFactor,
  drawingSquares,
  edgeLengths,
  evaluateFormula,
  FormulaError,
  lawnQuantities,
  normalizePitch,
  pavingQuantities,
  pitchProblem,
  roundCoordinates,
  savedRoofingQuantities,
  summarizeFeatureCollection,
  usesDepth,
  type FeatureCollection,
  type FormulaVariable,
  type MeasurementSummary,
  type Section,
} from "@crewtavo/core";
import { asJson, dbError, HttpError, must } from "../lib/http";
import type { Db } from "../lib/supabase";

/** A drawing to save: its shapes, what it's for, and where the map was. */
export interface MeasurementSave {
  id?: string;
  title: string;
  property_id?: string | null;
  request_id?: string | null;
  quote_id?: string | null;
  invoice_id?: string | null;
  /** The imagery it was drawn on, "report" for a roof typed in from a report, "assistant" for one an assistant drew. */
  provider: string;
  geojson: FeatureCollection;
  roof_pitch?: string | null;
  waste_pct: number;
  view?: unknown;
  snapshot_path?: string;
}

/**
 * Save a drawing, new or over the one with `id`. Totals always come from the shapes, worked out
 * again here; nothing the caller worked out is trusted. Cutouts come off the areas under them, and
 * each roof section can have its own pitch. Points are kept to the 9 decimals Measure's map takes
 * (roundCoordinates): it refuses a shape with a finer one, so a drawing an assistant or a script sent
 * would open in Measure with shapes missing. HttpError 400 for shapes or a pitch that don't read.
 */
export async function saveMeasurement(db: Db, companyId: string, body: MeasurementSave): Promise<{ id: string; summary: MeasurementSummary; squares: number | null }> {
  const geojson: FeatureCollection = {
    ...body.geojson,
    features: (body.geojson.features ?? []).map((f) => (f.geometry ? { ...f, geometry: { ...f.geometry, coordinates: roundCoordinates(f.geometry.coordinates) } } : f)),
  };
  let summary: MeasurementSummary;
  try {
    summary = summarizeFeatureCollection(geojson, { pitch: body.roof_pitch });
  } catch (error) {
    if (error instanceof RangeError) throw new HttpError(400, error.message);
    throw error;
  }
  const problem = pitchProblem(summary, body.roof_pitch);
  if (problem) throw new HttpError(400, problem);
  const raw = drawingSquares(summary, body.roof_pitch, body.waste_pct);
  const squares = raw === null ? null : Math.round(raw * 100) / 100;
  // As much as the columns hold: under a trillion square feet or feet, a hundred million squares.
  if (summary.total_area_sqft >= 1e12 || summary.total_length_ft >= 1e12 || (squares ?? 0) >= 1e8) {
    throw new HttpError(400, "This measurement is too large to save. Check the shapes and measured values.");
  }
  const { id, view, ...fields } = body;
  const row = {
    ...fields,
    // Written the one way ("4/12" for 4-12 or 4:12), so the quote and the client read the same.
    roof_pitch: fields.roof_pitch ? normalizePitch(fields.roof_pitch) : fields.roof_pitch,
    ...(view ? { view: asJson(view) } : {}),
    geojson: asJson(geojson),
    company_id: companyId,
    sections: asJson(summary.sections),
    total_area_sqft: summary.total_area_sqft,
    total_area_sqyd: summary.total_area_sqyd,
    total_length_ft: summary.total_length_ft,
    roofing_squares: squares,
  };
  const result = id
    ? await db.from("measurements").update(row).eq("id", id).eq("company_id", companyId).select("id").maybeSingle()
    : await db.from("measurements").insert(row).select("id").single();
  return { id: must(result, "Measurement not found.").id, summary, squares };
}

/** The measurement columns the values come from. */
export const MEASUREMENT_VALUE_FIELDS = "total_area_sqft, total_area_sqyd, total_length_ft, sections, roof_pitch, waste_pct";

export interface MeasurementValues {
  total_area_sqft: number | string | null;
  total_area_sqyd: number | string | null;
  total_length_ft: number | string | null;
  sections: unknown;
  roof_pitch: string | null;
  waste_pct: number | string | null;
}

export type MeasurementVariables = Record<FormulaVariable, number | null>;

/**
 * A saved measurement's roof slope (weighted by area when its sections have their own pitches), or
 * null when a pitch doesn't read (formulas that use it say so).
 */
function savedPitchFactor(sections: Section[], pitch: string | null): number | null {
  try {
    return drawingPitchFactor({ sections }, pitch);
  } catch {
    return null;
  }
}

/**
 * Every value a formula may use (FORMULA_VARIABLES), and nothing else: the totals, the roof's edges
 * and slope, a lawn's slope and items, a paving takeoff's items and a roof's squares with and
 * without waste. `depthIn` is
 * the depth asked for, else the first section's.
 */
export function measurementVariables(m: MeasurementValues, depthIn?: number | null): MeasurementVariables {
  const sections = (m.sections ?? []) as Section[];
  const edges = edgeLengths({ sections });
  return {
    area_sqft: Number(m.total_area_sqft),
    area_sqyd: Number(m.total_area_sqyd),
    length_ft: Number(m.total_length_ft),
    count: sections.filter((s) => s.kind === "Count").length,
    depth_in: depthIn ?? sections.find((s) => s.depth_in)?.depth_in ?? null,
    pitch_factor: savedPitchFactor(sections, m.roof_pitch),
    waste: Number(m.waste_pct) / 100,
    waste_pct: Number(m.waste_pct),
    eave_ft: edges.eave,
    rake_ft: edges.rake,
    ridge_ft: edges.ridge,
    hip_ft: edges.hip,
    valley_ft: edges.valley,
    // A lawn's slope (read from USGS when it was drawn), beds, edging, trees and obstacles.
    ...lawnQuantities(sections),
    // A paving takeoff's items: asphalt, striping, stalls and the rest.
    ...pavingQuantities(sections),
    // A roof's surface and squares, with and without waste.
    ...savedRoofingQuantities(sections, m.roof_pitch, Number(m.waste_pct)),
  };
}

/** A formula's value for a measurement, to 3 decimals (quantities are numeric(14,3)). Throws FormulaError. */
export const formulaValue = (formula: string, vars: MeasurementVariables) => Math.round(evaluateFormula(formula, vars) * 1000) / 1000;

export interface AppliedLine {
  id: string;
  name: string;
  field?: string;
  value?: number;
  /** The depth its formula was given, for a line whose formula reads one. */
  depth_in?: number | null;
  error?: string;
}

/** The depths sent with a measurement to apply. */
export interface SentDepths {
  /** One depth for every line: all an app from before each line had its own sends. */
  depthIn?: number | null;
  /** A depth for a line, by its id: what the office confirmed for it. */
  depths?: Readonly<Record<string, number>> | null;
  /** An item's own default depth comes before the one depth for every line. */
  itemDepths?: boolean;
}

/**
 * The depth a line's formula gets. The one confirmed for the line, if any. Otherwise, as it always
 * was, the one depth sent for every line, else the drawing's; an item's own default only fills in
 * when there's neither. With `itemDepths` the item's default comes first, so 6 inches of stone
 * isn't priced at the 2 inches typed for the asphalt.
 */
export function lineDepth(line: { id: string; service?: { default_depth_in?: number | string | null } | null }, sent: SentDepths, drawn: number | null): number | null {
  const own = sent.depths?.[line.id];
  if (own != null) return own;
  const item = line.service?.default_depth_in != null ? Number(line.service.default_depth_in) : null;
  return sent.itemDepths ? item ?? sent.depthIn ?? drawn : sent.depthIn ?? drawn ?? item;
}

/**
 * Fill a quote's line quantities (or prices) from a measurement using each line's formula, and tie
 * the measurement to the quote. Lines whose formula can't be worked out say why instead. With
 * `lineIds`, only those lines are filled (a line just added or changed on the estimate), so the
 * others keep quantities set by hand and a newer measurement nobody chose to apply. Each line whose
 * formula reads a depth gets its own (lineDepth): `more.depths` by line, its item's default, or the
 * one depth for every line.
 */
export async function applyMeasurement(db: Db, companyId: string, quoteId: string, measurementId: string, depthIn?: number | null, lineIds?: readonly string[] | null, more: Pick<SentDepths, "depths" | "itemDepths"> = {}) {
  const m = must(await db.from("measurements").select(MEASUREMENT_VALUE_FIELDS).eq("id", measurementId).eq("company_id", companyId).maybeSingle(), "Measurement not found.");
  const vars = measurementVariables(m as MeasurementValues, depthIn);
  // The drawing's own depth, whatever was sent.
  const drawn = measurementVariables(m as MeasurementValues).depth_in;

  let query = db.from("quote_line_items").select("id, name, formula, service:services(formula_target, default_depth_in)").eq("quote_id", quoteId);
  if (lineIds) query = query.in("id", [...lineIds]);
  const lines = must(await query);
  const results: AppliedLine[] = [];
  for (const line of lines as Array<{ id: string; name: string; formula: string | null; service: { formula_target: string; default_depth_in: number | null } | null }>) {
    if (!line.formula) continue;
    const deep = usesDepth(line.formula);
    const depth = deep ? lineDepth(line, { depthIn, ...more }, drawn) : vars.depth_in;
    try {
      const value = formulaValue(line.formula, { ...vars, depth_in: depth });
      const field = line.service?.formula_target === "unit_price" ? "unit_price" : "quantity";
      const change = field === "unit_price" ? { unit_price: Math.round(value * 100) / 100 } : { quantity: value };
      const { error } = await db.from("quote_line_items").update(change).eq("id", line.id);
      if (error) throw dbError(error);
      results.push({ id: line.id, name: line.name, field, value, ...(deep ? { depth_in: depth } : {}) });
    } catch (error) {
      if (!(error instanceof FormulaError)) throw error;
      results.push({ id: line.id, name: line.name, error: error.message });
    }
  }
  await db.from("measurements").update({ quote_id: quoteId }).eq("id", measurementId);
  return { variables: vars, lines: results };
}
