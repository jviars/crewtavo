/**
 * Home's setup checklist (features/home/SetupCard.tsx): the price list counts as set up once it's
 * the business's own, and measuring is only offered for work priced by area or length.
 */
import { describe, expect, it } from "vitest";
import { priceListState } from "../src/features/home/SetupCard";

const made = "2026-11-01T10:00:00.000+00:00";
const item = (unit: string, extra: Partial<{ formula: string | null; created_at: string; updated_at: string }> = {}) => ({
  unit, formula: null, created_at: "2026-11-01T10:00:01.000+00:00", updated_at: "2026-11-01T10:00:01.000+00:00", ...extra,
});

describe("the setup checklist's price list step", () => {
  it("waits while the price list is still the starter one", () => {
    expect(priceListState(made, [item("hr"), item("visit")]).prices).toBe(false);
    expect(priceListState(made, []).prices).toBe(false);
  });

  it("is done once an item is changed, or one is added later", () => {
    expect(priceListState(made, [item("hr", { updated_at: "2026-11-02T09:00:00.000+00:00" })]).prices).toBe(true);
    expect(priceListState(made, [item("ea", { created_at: "2026-11-03T09:00:00.000+00:00", updated_at: "2026-11-03T09:00:00.000+00:00" })]).prices).toBe(true);
  });

  it("offers measuring only when something is priced by area, length or a formula", () => {
    expect(priceListState(made, [item("hr"), item("ea"), item("visit")]).measures).toBe(false);
    for (const unit of ["sq ft", "SqFt", "ft", "square", "ton", "sq yd"]) expect(priceListState(made, [item(unit)]).measures).toBe(true);
    expect(priceListState(made, [item("ea", { formula: "area_sqft * 0.05" })]).measures).toBe(true);
  });
});
