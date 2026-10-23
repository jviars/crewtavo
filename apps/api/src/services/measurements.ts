/**
 * A measurement's values for quote formulas (FORMULA_VARIABLES), and filling a quote's lines from
 * them: "Fill quantities from this" on a quote (POST /quotes/:id/apply-measurement) and a roof
 * package's lines on a roof estimate (routes/roofing.ts) both work them out here, so they agree.
 */
import {
  drawingPitchFactor,
  edgeLengths,
  evaluateFormula,
  FormulaError,
  pavingQuantities,
  savedRoofingQuantities,
  type FormulaVariable,
  type Section,
} from "@crewtavo/core";
import { dbError, must } from "../lib/http";
import type { Db } from "../lib/supabase";

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
 * and slope, a paving takeoff's items and a roof's squares with and without waste. `depthIn` is
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
  error?: string;
}

/**
 * Fill a quote's line quantities (or prices) from a measurement using each line's formula, and tie
 * the measurement to the quote. Lines whose formula can't be worked out say why instead. With
 * `lineIds`, only those lines are filled (a line just added or changed on the estimate), so the
 * others keep quantities set by hand and a newer measurement nobody chose to apply.
 */
export async function applyMeasurement(db: Db, companyId: string, quoteId: string, measurementId: string, depthIn?: number | null, lineIds?: readonly string[] | null) {
  const m = must(await db.from("measurements").select(MEASUREMENT_VALUE_FIELDS).eq("id", measurementId).eq("company_id", companyId).maybeSingle(), "Measurement not found.");
  const vars = measurementVariables(m as MeasurementValues, depthIn);

  let query = db.from("quote_line_items").select("id, name, formula, service:services(formula_target)").eq("quote_id", quoteId);
  if (lineIds) query = query.in("id", [...lineIds]);
  const lines = must(await query);
  const results: AppliedLine[] = [];
  for (const line of lines as Array<{ id: string; name: string; formula: string | null; service: { formula_target: string } | null }>) {
    if (!line.formula) continue;
    try {
      const value = formulaValue(line.formula, vars);
      const field = line.service?.formula_target === "unit_price" ? "unit_price" : "quantity";
      const change = field === "unit_price" ? { unit_price: Math.round(value * 100) / 100 } : { quantity: value };
      const { error } = await db.from("quote_line_items").update(change).eq("id", line.id);
      if (error) throw dbError(error);
      results.push({ id: line.id, name: line.name, field, value });
    } catch (error) {
      if (!(error instanceof FormulaError)) throw error;
      results.push({ id: line.id, name: line.name, error: error.message });
    }
  }
  await db.from("measurements").update({ quote_id: quoteId }).eq("id", measurementId);
  return { variables: vars, lines: results };
}
