import type { Section } from "@crewtavo/core/geo";
import { describe, expect, it } from "vitest";
import { formulaValue, takeoffVariables, type TakeoffRow } from "../src/features/paving/data";
import { firstChoice, isRoof, layersFormula, layersName, layersOf, roofServiceKind, roofSummary } from "../src/features/roofing/data";

const area = (value: number, pitch?: string): Section => ({ feature_id: `a${value}`, label: "Roof", kind: "Area", value, unit: "sq ft", manual_override: false, pitch });
const edge = (value: number, kind: NonNullable<Section["edge"]>): Section => ({ feature_id: `${kind}${value}`, label: kind, kind: "Length", value, unit: "ft", manual_override: false, edge: kind });
const roof = (sections: Section[], pitch: string | null, squares: number | null): TakeoffRow => ({
  id: "m1", title: "Roof at 12 Oak St", sections, total_area_sqft: sections.filter((s) => s.kind === "Area").reduce((t, s) => t + s.value, 0), total_area_sqyd: 0,
  total_length_ft: 0, roof_pitch: pitch, waste_pct: 10, roofing_squares: squares, snapshot_path: null, show_on_quote: false, updated_at: "2026-10-21T12:00:00Z",
});

describe("the roofing flow", () => {
  it("prices the roof, its tear-off and its edges from a measured roof", () => {
    const vars = takeoffVariables(roof([area(2000, "6/12"), edge(120, "eave"), edge(80, "rake"), edge(40, "ridge")], "6/12", 24.6), null);
    expect(formulaValue("squares", vars)).toBeCloseTo((2000 * Math.sqrt(1.25) * 1.1) / 100, 2);
    expect(formulaValue("roof_squares", vars)).toBeCloseTo((2000 * Math.sqrt(1.25)) / 100, 2);
    // A price list from before the roofing values still works the same.
    expect(formulaValue("area_sqft * pitch_factor * (1 + waste) / 100", vars)).toBeCloseTo(formulaValue("squares", vars)!, 1);
    expect(formulaValue("eave_ft + rake_ft", vars)).toBe(200);
    expect(formulaValue(layersFormula("roof_squares", 2), vars)).toBeCloseTo(2 * formulaValue("roof_squares", vars)!, 2);
  });

  it("sorts the price list by what each service prices on a roof", () => {
    expect(roofServiceKind("squares", "Architectural shingle roof")).toBe("roof");
    expect(roofServiceKind("area_sqft * pitch_factor * (1 + waste) / 100", "Metal roof")).toBe("roof");
    expect(roofServiceKind("roof_squares", "Tear-off and disposal")).toBe("tearoff");
    expect(roofServiceKind("area_sqft * pitch_factor / 100", "Tear-off and disposal")).toBe("tearoff");
    expect(roofServiceKind("eave_ft + rake_ft", "Drip edge")).toBe("extra");
    expect(roofServiceKind("steep_squares", "Steep roof charge")).toBe("extra");
    expect(roofServiceKind("roof_squares", "Synthetic underlayment")).toBe("extra");
    expect(roofServiceKind("length_ft", "Seamless gutters")).toBe("other");
    expect(roofServiceKind("area_sqft", "Vinyl siding")).toBe("other");
    expect(roofServiceKind(null, "Dumpster")).toBe("other");
  });

  it("takes off more layers by multiplying the service's own formula", () => {
    expect(layersFormula("roof_squares", 1)).toBe("roof_squares");
    expect(layersFormula("area_sqft * pitch_factor / 100", 2)).toBe("(area_sqft * pitch_factor / 100) * 2");
    expect(layersOf("(area_sqft * pitch_factor / 100) * 2")).toBe(2);
    expect(layersOf("roof_squares")).toBe(1);
    expect(layersName("Tear-off and disposal", 2)).toBe("Tear-off and disposal (2 layers)");
  });

  it("shows the middle of three roofs first, else the cheapest", () => {
    expect(firstChoice([{ id: "metal", price: 38_000 }, { id: "arch", price: 16_800 }, { id: "designer", price: 22_000 }])?.id).toBe("designer");
    expect(firstChoice([{ id: "metal", price: 38_000 }, { id: "arch", price: 16_800 }])?.id).toBe("arch");
    expect(firstChoice([])).toBeUndefined();
  });

  it("lists only roofs as roofing projects", () => {
    expect(isRoof(roof([area(2000)], null, null))).toBe(false);
    expect(isRoof(roof([area(2000, "6/12")], "6/12", 24.6))).toBe(true);
    expect(isRoof(roof([area(2000), edge(40, "ridge")], null, null))).toBe(true);
    const n = (x: number, digits = 0) => x.toFixed(digits);
    expect(roofSummary(roof([area(2000, "6/12")], "6/12", 24.6), n)).toBe("24.6 squares · 6/12");
    expect(roofSummary(roof([area(2000)], null, null), n)).toBe("2000 sq ft from above");
  });
});
