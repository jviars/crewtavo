import { describe, expect, it } from "vitest";
import {
  evaluateFormula,
  FORMULA_VARIABLES,
  isRoofDrawing,
  optionLabels,
  PRESETS,
  ROOFING_SAMPLE,
  ROOFING_VARIABLE_NAMES,
  roofingQuantities,
  savedRoofingQuantities,
  suggestedWaste,
  type Section,
} from "../src";

const area = (value: number, pitch?: string): Section => ({ feature_id: `a${value}`, label: "Roof", kind: "Area", value, unit: "sq ft", manual_override: false, pitch });
const line = (value: number, edge?: Section["edge"]): Section => ({ feature_id: `l${value}`, label: "Line", kind: "Length", value, unit: "ft", manual_override: false, edge });

describe("roofing values", () => {
  it("gives formulas a value for each, with sample values for the price list", () => {
    for (const name of ROOFING_VARIABLE_NAMES) expect(FORMULA_VARIABLES).toContain(name);
    expect(Object.keys(ROOFING_SAMPLE).sort()).toEqual([...ROOFING_VARIABLE_NAMES].sort());
  });

  it("works out the roof at each section's pitch, with and without waste", () => {
    // 2,000 sq ft from above at 6/12 (×1.118) and a 400 sq ft porch at 3/12 (×1.031), 10% waste.
    const q = roofingQuantities([area(2000), area(400, "3/12"), line(80, "eave")], "6/12", 10);
    const surface = 2000 * Math.sqrt(1 + 0.25) + 400 * Math.sqrt(1 + 0.0625);
    expect(q.roof_sqft).toBeCloseTo(surface, 1);
    expect(q.roof_squares).toBeCloseTo(surface / 100, 2);
    expect(q.squares).toBeCloseTo((surface * 1.1) / 100, 2);
    expect(q.steep_squares).toBe(0);
  });

  it("counts the steep sections (8/12 and up) for a steep charge", () => {
    const q = roofingQuantities([area(1000, "8/12"), area(1000, "7/12"), area(500, "12/12")], null, 15);
    expect(q.steep_squares).toBeCloseTo((1000 * Math.sqrt(1 + (8 / 12) ** 2) + 500 * Math.SQRT2) / 100, 2);
    // Waste goes on what's ordered, not on the steep charge.
    expect(q.squares).toBeCloseTo(q.roof_squares * 1.15, 1);
  });

  it("counts a roof with no pitch as flat, and leaves the values blank for one that doesn't read", () => {
    expect(roofingQuantities([area(1500)], "", 0)).toEqual({ roof_sqft: 1500, squares: 15, roof_squares: 15, steep_squares: 0 });
    expect(() => roofingQuantities([area(1500)], "steep", 0)).toThrow(RangeError);
    expect(savedRoofingQuantities([area(1500)], "steep", 0)).toEqual({ roof_sqft: null, squares: null, roof_squares: null, steep_squares: null });
  });

  it("tells a roof from other drawings", () => {
    expect(isRoofDrawing([area(1000)], null)).toBe(false);
    expect(isRoofDrawing([area(1000)], "5/12")).toBe(true);
    expect(isRoofDrawing([area(1000, "4/12")])).toBe(true);
    expect(isRoofDrawing([line(40, "ridge")])).toBe(true);
    expect(isRoofDrawing([line(40)])).toBe(false);
  });

  it("starts the waste at 10%, or 15% with hips or valleys", () => {
    expect(suggestedWaste({ eave: 80, rake: 60, ridge: 40 })).toBe(10);
    expect(suggestedWaste({ eave: 80, hip: 30 })).toBe(15);
    expect(suggestedWaste({ valley: 12 })).toBe(15);
  });

  it("gives the roofing price list a value for every service it measures", () => {
    const roofing = PRESETS.roofing_exteriors;
    const formulas = new Map(roofing.formulas.map((f) => [f.name, f.formula]));
    const sample = { ...ROOFING_SAMPLE, area_sqft: 2500, length_ft: 300, pitch_factor: 1.12, waste: 0.1, eave_ft: 120, rake_ft: 80, ridge_ft: 40, hip_ft: 20, valley_ft: 20 };
    for (const s of roofing.services.filter((s) => s.formula_name)) {
      expect(evaluateFormula(formulas.get(s.formula_name!)!, sample), s.name).toBeGreaterThan(0);
    }
  });
});

describe("Good, Better and Best", () => {
  const roof = (id: string, unit_price: number, option_group: string | null = "Roof") => ({ id, optional: true, option_group, quantity: 30, unit_price });

  it("names the choices in a group from the cheapest up", () => {
    const labels = optionLabels([roof("metal", 1285), roof("arch", 560), roof("designer", 735), { id: "gutters", optional: false, quantity: 120, unit_price: 12 }]);
    expect(Object.fromEntries(labels)).toEqual({ arch: "Good", designer: "Better", metal: "Best" });
  });

  it("names two choices Good and Better, and leaves one, four or ungrouped options alone", () => {
    expect(Object.fromEntries(optionLabels([roof("a", 500), roof("b", 700)]))).toEqual({ a: "Good", b: "Better" });
    expect(optionLabels([roof("a", 500)]).size).toBe(0);
    expect(optionLabels([roof("a", 1), roof("b", 2), roof("c", 3), roof("d", 4)]).size).toBe(0);
    expect(optionLabels([roof("a", 500, null), roof("b", 700, null)]).size).toBe(0);
  });
});
