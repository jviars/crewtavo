import { priceRange, rangeSettings } from "@crewtavo/core/estimates";
import { describe, expect, it } from "vitest";
import { copyName, formulaWords, isSquareUnit, moneyText, PACKAGE_NAME_MAX, quickAddChips, rangeText, roofStage, unitPrice, unitShort } from "../src/features/roofing/data";
import { formatMoney, formatMoneyCents } from "../src/lib/format";

const FORMAT = { whole: formatMoney, cents: formatMoneyCents };

describe("where a roof estimate is", () => {
  const quote = (patch: Parameters<typeof roofStage>[0]) => ({ lines: [{}], jobs: [], range_low: null, range_accepted_at: null, priced_on_site_at: null, ...patch });

  it("follows the roof from measuring to the job", () => {
    expect(roofStage(quote({ status: "draft", lines: [] }), false).label).toBe("Measuring");
    expect(roofStage(quote({ status: "draft", lines: [] }), true).label).toBe("Pricing");
    expect(roofStage(quote({ status: "draft" }), true).label).toBe("Pricing");
    expect(roofStage(quote({ status: "sent", range_low: 18300 }), true)).toEqual({ label: "Range sent", tone: "info" });
    expect(roofStage(quote({ status: "sent", range_low: 18300, range_accepted_at: "2026-10-22T15:00:00Z" }), true)).toEqual({ label: "Wants a visit", tone: "warning" });
    expect(roofStage(quote({ status: "sent", range_low: 18300, range_accepted_at: "2026-10-22T15:00:00Z", priced_on_site_at: "2026-10-23T15:00:00Z" }), true).label).toBe("Priced on site");
    expect(roofStage(quote({ status: "sent" }), true).label).toBe("Proposal sent");
    // The office sent the exact price instead of the range (after a yes, or without one): not priced on site.
    expect(roofStage(quote({ status: "sent", range_low: 18300, exact_sent_at: "2026-10-23T15:00:00Z" }), true)).toEqual({ label: "Exact price sent", tone: "info" });
    expect(roofStage(quote({ status: "sent", range_low: 18300, range_accepted_at: "2026-10-22T15:00:00Z", exact_sent_at: "2026-10-23T15:00:00Z" }), true).label).toBe("Exact price sent");
    expect(roofStage(quote({ status: "approved" }), true)).toEqual({ label: "Signed", tone: "good" });
    expect(roofStage(quote({ status: "converted", jobs: [{ status: "active" }] }), true).label).toBe("Scheduled");
    expect(roofStage(quote({ status: "converted", jobs: [{ status: "requires_invoicing" }] }), true).label).toBe("To invoice");
    expect(roofStage(quote({ status: "converted", jobs: [{ status: "completed" }] }), true).label).toBe("Done");
  });

  it("says when it's lost, archived or waiting on changes before anything else", () => {
    expect(roofStage(quote({ status: "lost", range_low: 18300 }), true)).toEqual({ label: "Lost", tone: "danger" });
    expect(roofStage(quote({ status: "archived" }), false).label).toBe("Archived");
    expect(roofStage(quote({ status: "changes_requested", range_low: 18300 }), true).label).toBe("Changes requested");
    // A signed estimate is signed, even if its drawing was taken off.
    expect(roofStage(quote({ status: "approved" }), false).label).toBe("Signed");
  });

  it("shows a range as a price", () => {
    expect(rangeText(18300, 21050, formatMoney)).toBe("$18,300 – $21,050");
  });

  it("reads the business's range settings for the example sentence", () => {
    expect(priceRange(18304, rangeSettings({}))).toEqual({ low: 18300, high: 21050 });
    expect(priceRange(18304, rangeSettings({ roofing: { range_pct: 10, range_round: 100 } }))).toEqual({ low: 18300, high: 20200 });
  });
});

describe("roof packages", () => {
  it("says how much of each service goes on the roof, in words", () => {
    expect(formulaWords("squares")).toBe("Roof area plus waste");
    expect(formulaWords("roof_squares")).toBe("Roof area");
    expect(formulaWords("eave_ft + rake_ft")).toBe("Eaves and rakes");
    expect(formulaWords("ridge_ft+hip_ft")).toBe("Ridges and hips");
    expect(formulaWords(" valley_ft ")).toBe("Valleys");
    expect(formulaWords("steep_squares")).toBe("Steep parts (8/12 and up)");
    expect(formulaWords("ridge_ft")).toBe("Ridge");
    expect(formulaWords("eave_ft + valley_ft")).toBe("Eaves and valleys");
    expect(formulaWords("eave_ft")).toBe("Eaves");
    expect(formulaWords("area_sqft * pitch_factor / 100")).toBe("From the measurements");
    expect(formulaWords(null)).toBeNull();
    expect(formulaWords("  ")).toBeNull();
  });

  it("writes prices the way a roofer says them", () => {
    expect(unitPrice(560, "square", FORMAT)).toBe("$560 / sq");
    expect(unitPrice(3.5, "ft", FORMAT)).toBe("$3.50 / ft");
    expect(unitPrice(45, "ea", FORMAT)).toBe("$45 each");
    expect(unitPrice(45, "ea", FORMAT, true)).toBe("$45");
    expect(unitPrice(650, "lump sum", FORMAT)).toBe("$650");
    expect(unitPrice(95, "sheet", FORMAT)).toBe("$95 / sheet");
    expect(unitPrice(9, "sq ft", FORMAT)).toBe("$9 / sq ft");
    expect(moneyText(559.93, FORMAT)).toBe("$559.93");
    expect(moneyText(1285, FORMAT)).toBe("$1,285");
    expect(unitShort("Squares")).toBe("sq");
    expect(unitShort("LF")).toBe("ft");
  });

  it("knows the roofing square when it sees it", () => {
    for (const unit of ["square", "Squares", "sq", "SQ.", "roofing square"]) expect(isSquareUnit(unit), unit).toBe(true);
    for (const unit of ["sq ft", "ft", "ea", "sqyd"]) expect(isSquareUnit(unit), unit).toBe(false);
  });

  it("names a copy so it fits", () => {
    expect(copyName("Architectural shingle")).toBe("Architectural shingle (copy)");
    const long = copyName("x".repeat(100));
    expect(long).toHaveLength(PACKAGE_NAME_MAX);
    expect(long.endsWith(" (copy)")).toBe(true);
  });

  it("offers every active service that isn't on the roof as a quick add, the package's own first", () => {
    const services = [
      { id: "roof", name: "Architectural shingle roof", active: true, sort: 1 },
      { id: "tear", name: "Tear-off and disposal", active: true, sort: 2 },
      { id: "vent", name: "Ridge vent", active: true, sort: 3 },
      { id: "chimney", name: "Chimney flashing", active: true, sort: 4 },
      { id: "deck", name: "Rotten decking", active: true, sort: 5 },
      { id: "old", name: "Old service", active: false, sort: 6 },
      { id: "gutters", name: "Seamless gutters", active: true, sort: 5 },
    ];
    const items = [
      { service_id: "tear", kind: "included", sort: 0 },
      { service_id: "deck", kind: "quick", sort: 0 },
      { service_id: "chimney", kind: "quick", sort: 1 },
      { service_id: "old", kind: "quick", sort: 2 },
    ];
    expect(quickAddChips(services, items, "roof").map((c) => [c.service.id, c.on])).toEqual([
      ["deck", true],
      ["chimney", true],
      ["vent", false],
      ["gutters", false],
    ]);
    expect(quickAddChips(services, [], null).map((c) => c.service.id)).toEqual(["roof", "tear", "vent", "chimney", "deck", "gutters"]);
  });
});
