import { describe, expect, it } from "vitest";
import { CATALOG_CATEGORIES, swatchOf } from "../src/features/materials/data";
import { listed, packagesUsing, usesOf } from "../src/features/roofing/catalog/uses";
import type { PriceListService, RoofPackage } from "../src/features/roofing/packages";

describe("the roofing catalog", () => {
  it("draws a swatch from an item's color, or its name when ABC gives no color", () => {
    expect(swatchOf("Charcoal")).toBe("#34363a");
    expect(swatchOf("Weathered Wood")).toBe("#6f675b");
    expect(swatchOf(null, "Drip Edge 10 ft White")).toBe("#ecebe6");
    // A color is believed over the words in the name.
    expect(swatchOf("Hunter Green", "Shingles Charcoal Blend")).toBe("#3c5443");
    expect(swatchOf(null, "Synthetic underlayment")).toBeNull();
  });

  it("has a search for every category, each with its own key", () => {
    expect(new Set(CATALOG_CATEGORIES.map((c) => c.key)).size).toBe(CATALOG_CATEGORIES.length);
    expect(CATALOG_CATEGORIES.every((c) => c.search.trim().length >= 2)).toBe(true);
  });

  it("says where a material is used: each service, how many go in, and its packages", () => {
    const services = [
      { id: "roof", name: "Architectural shingle roof", unit: "square" },
      { id: "starter", name: "Starter strip", unit: "ft" },
    ] as PriceListService[];
    const packages = [
      { name: "Good", roof_service_id: "roof", items: [] },
      { name: "Better", roof_service_id: "other", items: [{ kind: "included", service_id: "roof" }] },
      { name: "Best", roof_service_id: "other", items: [{ kind: "quick", service_id: "roof" }] },
    ] as unknown as RoofPackage[];
    expect(packagesUsing(packages, "roof")).toEqual(["Good", "Better"]);
    const link = { id: "m1", service_id: "roof", item_number: "02GATZ3CH", name: "Timberline HDZ", uom: "BD", uom_name: "Bundle", length_ft: null, per_unit: 3, unit_price: 40, priced_at: null, price_note: null, sort: 1 };
    expect(usesOf([link], services, packages)).toEqual([{ link, service: services[0], amount: "3 bundles per square", packages: ["Good", "Better"] }]);
    expect(listed(["Good", "Better", "Best"])).toBe("Good, Better and Best");
    expect(listed(["Good"])).toBe("Good");
  });
});
