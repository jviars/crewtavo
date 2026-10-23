import { describe, expect, it } from "vitest";
import { describePerUnit, lineUnitCost, materialsPerUnit, orderQuantity, priceMaterials, serviceUnitCost, suggestPerUnit, type MaterialLink } from "../src/materials";

const shingles: MaterialLink = { item_number: "02GASTZ3WW", name: "GAF Timberline HDZ Weathered Wood", uom: "BD", uom_name: "Bundle", per_unit: 3, unit_price: 45.12 };
const felt: MaterialLink = { item_number: "FELT10", name: "Synthetic underlayment 10 Sq Roll", uom: "RL", uom_name: "Roll", per_unit: 0.1, unit_price: "89.50" };

describe("materials", () => {
  it("orders whole ones, rounded up, without float dust", () => {
    expect(orderQuantity(28.4, 3)).toBe(86);
    expect(orderQuantity(10, 3)).toBe(30);
    expect(orderQuantity(0.3, 10)).toBe(3); // 0.3 * 10 is 3.0000000000000004
    expect(orderQuantity(28.4, 0.1)).toBe(3);
    expect(orderQuantity(0, 3)).toBe(0);
    expect(orderQuantity("12.5", "2")).toBe(25);
  });

  it("prices a line's materials to the cent", () => {
    const { items, total, unpriced } = priceMaterials(28.4, [shingles, felt]);
    expect(items.map((i) => [i.quantity, i.total])).toEqual([[86, 3880.32], [3, 268.5]]);
    expect(total).toBe(4148.82);
    expect(unpriced).toBe(0);
  });

  it("doesn't count a branch's 0.00 as free", () => {
    const { items, total, unpriced } = priceMaterials(10, [shingles, { ...felt, unit_price: 0, price_note: "Call for pricing." }]);
    expect(total).toBe(1353.6);
    expect(unpriced).toBe(1);
    expect(items[1]).toMatchObject({ quantity: 1, unit_price: null, total: null, note: "Call for pricing." });
  });

  it("works out a service's cost from its materials and labor", () => {
    expect(materialsPerUnit([shingles, felt])).toBeCloseTo(144.31, 6);
    expect(serviceUnitCost([shingles, felt], 180)).toBe(324.31);
    expect(serviceUnitCost([shingles, felt], null)).toBe(144.31);
    expect(lineUnitCost(4148.82, 180, 28.4)).toBe(326.09);
    expect(lineUnitCost(0, 180, 0)).toBe(180);
  });

  it("guesses how many go into a unit from the supplier's description", () => {
    expect(suggestPerUnit("GAF StainGuard Timberline HDZ Shingles Weathered Wood 3 Bdl Per Square", "BD", "square")).toEqual({ per_unit: 3 });
    expect(suggestPerUnit("GAF Timberline HDZ Shingles Pewter Gray 3 Bundle Per Square", "SQ", "square")).toEqual({ per_unit: 1 });
    expect(suggestPerUnit("GAF FeltBuster Synthetic Underlayment 10 Sq Roll", "RL", "square")).toEqual({ per_unit: 0.1, covers: 10 });
    expect(suggestPerUnit("Grace Ice & Water Shield 200 Sq Ft Roll", "RL", "square")).toEqual({ per_unit: 0.5, covers: 2 });
    expect(suggestPerUnit("Aluminum Drip Edge White 10'", "PC", "ft")).toEqual({ per_unit: 0.1, covers: 10 });
    expect(suggestPerUnit("Pro-Start Starter Strip 120 LF", "BD", "ft")).toEqual({ per_unit: 1 / 120, covers: 120 });
    expect(suggestPerUnit("Ridge vent 1,000 Sq Ft", "PC", "sq ft")).toEqual({ per_unit: 0.001, covers: 1000 });
    expect(suggestPerUnit("Pipe boot 3 in", "EA", "ea")).toEqual({ per_unit: 1 });
    expect(suggestPerUnit("Coil nails 1-1/4 in", "BX", "square")).toEqual({ per_unit: 1 });
  });

  it("says it the way a roofer would", () => {
    expect(describePerUnit(3, "Bundle", "square")).toBe("3 bundles per square");
    expect(describePerUnit(0.1, "Roll", "square")).toBe("1 roll per 10 squares");
    expect(describePerUnit(1 / 120, "Bundle", "ft")).toBe("1 bundle per 120 ft");
    expect(describePerUnit(1, "Box", "square")).toBe("1 box per square");
    expect(describePerUnit(2, "Box", "ea")).toBe("2 boxes per ea");
  });
});
