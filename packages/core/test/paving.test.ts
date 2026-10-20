import { describe, expect, it } from "vitest";
import {
  evaluateFormula,
  FORMULA_VARIABLES,
  isPavingTakeoff,
  itemFits,
  itemTotal,
  PAVING_ITEMS,
  PAVING_SAMPLE,
  PAVING_VARIABLE_NAMES,
  pavingQuantities,
  PRESETS,
  stallRowStripeFt,
  stallsAlong,
  summarizeFeatureCollection,
  type Feature,
  type Section,
} from "../src";

// A 100 x 50 ft lot near 37.13° N, with a 100 ft line along its front.
const LAT = 37.13;
const FT_PER_DEG_LAT = 364_000;
const DLAT = 50 / FT_PER_DEG_LAT;
const DLNG = 100 / (FT_PER_DEG_LAT * Math.cos((LAT * Math.PI) / 180));
const [W, S] = [-80.55, LAT];
const lot = { type: "Polygon", coordinates: [[[W, S], [W + DLNG, S], [W + DLNG, S + DLAT], [W, S + DLAT], [W, S]]] };
const front = { type: "LineString", coordinates: [[W, S], [W + DLNG, S]] };
const spot = { type: "Point", coordinates: [W + DLNG / 2, S + DLAT / 2] };
const feature = (geometry: object, properties: Record<string, unknown> = {}): Feature => ({ type: "Feature", geometry: geometry as Feature["geometry"], properties });
const sections = (...features: Feature[]) => summarizeFeatureCollection({ type: "FeatureCollection", features }).sections;
const section = (item: string, kind: Section["kind"], value: number): Section => ({ feature_id: item, label: item, kind, value, unit: kind === "Area" ? "sq ft" : kind === "Length" ? "ft" : "ea", manual_override: false, item });

describe("paving takeoff items", () => {
  it("has a unique id and a formula value for each kind of work", () => {
    expect(new Set(PAVING_ITEMS.map((i) => i.id)).size).toBe(PAVING_ITEMS.length);
    for (const name of PAVING_VARIABLE_NAMES) expect(FORMULA_VARIABLES).toContain(name);
    expect(Object.keys(PAVING_SAMPLE).sort()).toEqual([...PAVING_VARIABLE_NAMES].sort());
  });

  it("keeps an item only on a shape it fits", () => {
    expect(itemFits("asphalt", "Area")).toBe(true);
    expect(itemFits("asphalt", "Length")).toBe(false);
    expect(itemFits("crack", "Length")).toBe(true);
    expect(itemFits("ada_stall", "Count")).toBe(true);
    expect(itemFits("nonsense", "Area")).toBe(false);
    const [area, line, point] = sections(feature(lot, { item: "asphalt" }), feature(front, { item: "asphalt" }), feature(spot, { item: "arrow" }));
    expect(area.item).toBe("asphalt");
    expect(line.item).toBeUndefined();
    expect(point.item).toBe("arrow");
  });

  it("counts stalls along a stall row and the lines between them", () => {
    expect(stallsAlong(90)).toBe(10);
    expect(stallsAlong(4)).toBe(0);
    expect(stallRowStripeFt(90)).toBe(11 * 18);
    expect(stallRowStripeFt(0)).toBe(0);
    const q = pavingQuantities(sections(feature(front, { item: "stall_row" })));
    expect(q.stalls).toBe(11); // 100 ft of row
    expect(q.stripe_white_ft).toBe(12 * 18);
    expect(q.stripe_ft).toBe(12 * 18);
  });

  it("adds up each item into the values quote formulas use", () => {
    const q = pavingQuantities([
      section("asphalt", "Area", 20_000),
      section("asphalt", "Area", 5000),
      section("concrete", "Area", 800),
      section("crack", "Length", 300),
      section("stripe_yellow", "Length", 120),
      section("stripe_white", "Length", 200),
      section("ada_stall", "Count", 1),
      section("ada_stall", "Count", 1),
      section("stall", "Count", 1),
      section("arrow", "Count", 1),
      section("symbol", "Count", 1),
      section("crosswalk", "Length", 40),
      section("wheel_stop", "Count", 1),
    ]);
    expect(q.asphalt_sqft).toBe(25_000);
    expect(q.asphalt_sqyd).toBeCloseTo(2777.78, 2);
    expect(q.sealcoat_sqft).toBe(25_000); // no sealcoat areas drawn: all the asphalt
    expect(q.concrete_sqft).toBe(800);
    expect(q.crack_ft).toBe(300);
    expect(q.stripe_ft).toBe(320);
    expect(q.stalls).toBe(3); // ADA stalls are stalls too
    expect(q.ada_stalls).toBe(2);
    expect(evaluateFormula("arrows + symbols", q)).toBe(2);
    expect(q.crosswalk_ft).toBe(40);
    expect(q.wheel_stops).toBe(1);
  });

  it("seals only the sealcoat areas when there are some", () => {
    const q = pavingQuantities([section("asphalt", "Area", 10_000), section("sealcoat", "Area", 4000)]);
    expect(q.sealcoat_sqft).toBe(4000);
    expect(q.asphalt_sqft).toBe(10_000);
  });

  it("prices a drawing without items as all asphalt", () => {
    const plain = sections(feature(lot));
    expect(isPavingTakeoff(plain)).toBe(false);
    const q = pavingQuantities(plain);
    expect(Math.abs(q.asphalt_sqft - 5000)).toBeLessThan(50);
    expect(q.sealcoat_sqft).toBe(q.asphalt_sqft);
    // Once one area is marked, unmarked areas aren't asphalt any more.
    const marked = sections(feature(lot), feature(lot, { item: "concrete" }));
    expect(isPavingTakeoff(marked)).toBe(true);
    expect(pavingQuantities(marked).asphalt_sqft).toBe(0);
  });

  it("totals one item the way the takeoff list shows it", () => {
    const list = [section("asphalt", "Area", 1000.004), section("asphalt", "Area", 500), section("stall_row", "Length", 90)];
    expect(itemTotal(list, "asphalt")).toEqual({ value: 1500, unit: "sq ft" });
    expect(itemTotal(list, "stall_row")).toEqual({ value: 10, unit: "ea" });
    expect(itemTotal(list, "crack")).toEqual({ value: 0, unit: "ft" });
  });

  it("gives the paving price list a value for every service it measures", () => {
    const paving = PRESETS.paving;
    const formulas = new Map(paving.formulas.map((f) => [f.name, f.formula]));
    for (const s of paving.services.filter((s) => s.formula_name)) {
      const value = evaluateFormula(formulas.get(s.formula_name!)!, { ...PAVING_SAMPLE, depth_in: 2 });
      expect(value, s.name).toBeGreaterThan(0);
    }
  });
});
