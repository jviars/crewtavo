import { describe, expect, it } from "vitest";
import { DEFAULT_TEMPLATE, documentColor, pickTemplate, templateSettings } from "../src/documents";
import {
  followPrice,
  hidesExactPrice,
  inRangeMode,
  lineChanges,
  marginPct,
  priceRange,
  rangeSettings,
  sitePriceAdjustment,
  snapshotLines,
  type CurrentLine,
} from "../src/estimates";

describe("priceRange", () => {
  it("rounds the estimate down and the estimate with room up", () => {
    expect(priceRange(18304, { pct: 15, round: 50 })).toEqual({ low: 18300, high: 21050 });
    expect(priceRange("19524.00", { pct: 15, round: 100 })).toEqual({ low: 19500, high: 22500 });
  });

  it("keeps exact amounts exact", () => {
    expect(priceRange(20000, { pct: 15, round: 50 })).toEqual({ low: 20000, high: 23000 });
    expect(priceRange(0, { pct: 15, round: 50 })).toEqual({ low: 0, high: 0 });
  });

  it("never makes the high end lower than the low end", () => {
    expect(priceRange(1234.56, { pct: 0, round: 1000 })).toEqual({ low: 1000, high: 2000 });
  });
});

describe("rangeSettings", () => {
  it("reads the business's settings and falls back to 15% and $50", () => {
    expect(rangeSettings({ roofing: { range_pct: 10, range_round: 100 } })).toEqual({ pct: 10, round: 100 });
    expect(rangeSettings({})).toEqual({ pct: 15, round: 50 });
    expect(rangeSettings({ roofing: { range_pct: -1, range_round: 7 } })).toEqual({ pct: 15, round: 50 });
    expect(rangeSettings(null)).toEqual({ pct: 15, round: 50 });
  });
});

describe("inRangeMode", () => {
  it("is on while the range is out and nobody has priced it on site", () => {
    expect(inRangeMode({ range_low: 18300, priced_on_site_at: null, status: "sent" })).toBe(true);
    expect(inRangeMode({ range_low: null, priced_on_site_at: null, status: "sent" })).toBe(false);
    expect(inRangeMode({ range_low: 18300, priced_on_site_at: "2026-10-24T18:00:00Z", status: "sent" })).toBe(false);
    expect(inRangeMode({ range_low: 18300, priced_on_site_at: null, status: "approved" })).toBe(false);
    expect(inRangeMode({ range_low: 18300, priced_on_site_at: null, exact_sent_at: "2026-10-24T18:00:00Z", status: "sent" })).toBe(false);
  });

  it("keeps the exact price hidden for a range that was turned down, until a price is set or sent", () => {
    expect(hidesExactPrice({ range_low: 18300, priced_on_site_at: null, status: "lost" })).toBe(true);
    expect(hidesExactPrice({ range_low: 18300, priced_on_site_at: null, status: "archived" })).toBe(true);
    expect(hidesExactPrice({ range_low: 18300, priced_on_site_at: null, status: "approved" })).toBe(false);
    expect(hidesExactPrice({ range_low: 18300, priced_on_site_at: null, exact_sent_at: "2026-10-24T18:00:00Z", status: "sent" })).toBe(false);
    expect(hidesExactPrice({ range_low: null, priced_on_site_at: null, status: "lost" })).toBe(false);
  });
});

describe("followPrice and marginPct", () => {
  it("adds the markup to materials plus labor, to the cent", () => {
    expect(followPrice(147.37, 182, 70)).toBe(559.93);
    expect(followPrice("10.00", "5.00", 0)).toBe(15);
  });

  it("works out the margin as a whole percent", () => {
    expect(marginPct(560, 329.37)).toBe(41);
    expect(marginPct(0, 10)).toBeNull();
  });
});

const line = (id: string, name: string, quantity: number, unit_price: number, extra: Partial<CurrentLine> = {}): CurrentLine => ({
  id, service_id: `svc-${name}`, name, quantity, unit: "ea", unit_price, ...extra,
});

describe("lineChanges", () => {
  const before = snapshotLines([line("a", "Shingles", 24.2, 560), line("b", "Pipe boots", 3, 45), line("c", "Ridge vent", 48, 9)]);

  it("finds what was added, taken off and changed", () => {
    const now = [line("a", "Shingles", 24.2, 560), line("b", "Pipe boots", 2, 45), line("d", "Chimney flashing", 1, 650)];
    const changes = lineChanges(before, now);
    expect(changes).toEqual([
      { kind: "changed", id: "b", name: "Pipe boots", unit: "ea", from: 3, to: 2, amount: -45 },
      { kind: "added", id: "d", name: "Chimney flashing", unit: "ea", from: null, to: 1, amount: 650 },
      expect.objectContaining({ kind: "removed", id: "c", name: "Ridge vent", amount: -432 }),
    ]);
  });

  it("doesn't count a line that was taken off and put back", () => {
    const now = [line("a", "Shingles", 24.2, 560), line("b", "Pipe boots", 3, 45), line("z", "Ridge vent", 48, 9)];
    expect(lineChanges(before, now)).toEqual([]);
  });

  it("leaves out unchosen options and has nothing to say without a range", () => {
    const now = [...[line("a", "Shingles", 24.2, 560), line("b", "Pipe boots", 3, 45), line("c", "Ridge vent", 48, 9)], line("x", "Metal", 24.2, 1285, { optional: true, selected: false })];
    expect(lineChanges(before, now)).toEqual([]);
    expect(lineChanges(null, now)).toEqual([]);
  });
});

describe("sitePriceAdjustment", () => {
  it("is a discount below the estimate and an extra line above it", () => {
    expect(sitePriceAdjustment(19524, 19500)).toEqual({ discount: 24, extra: 0 });
    expect(sitePriceAdjustment("19524.00", 21000)).toEqual({ discount: 0, extra: 1476 });
    expect(sitePriceAdjustment(100, 100)).toEqual({ discount: 0, extra: 0 });
  });
});

describe("templateSettings", () => {
  it("fills in the defaults", () => {
    expect(templateSettings(null)).toEqual(DEFAULT_TEMPLATE);
    expect(templateSettings({ header: "banner", color: "#A33A2B", license: "RC-1" })).toMatchObject({ header: "banner", color: "#a33a2b", license: "RC-1", font: "modern" });
  });

  it("drops what's out of shape", () => {
    const t = templateSettings({ header: "wavy", color: "red", show_license: "yes", terms: "x".repeat(5000) });
    expect(t.header).toBe("classic");
    expect(t.color).toBeNull();
    expect(t.show_license).toBe(true);
    expect(t.terms).toHaveLength(4000);
  });

  it("picks the quote's template, else the default, else the built-in one", () => {
    const templates = [
      { id: "1", is_default: false, settings: { header: "centered" } },
      { id: "2", is_default: true, settings: { header: "banner" } },
    ];
    expect(pickTemplate(templates, "1").header).toBe("centered");
    expect(pickTemplate(templates, null).header).toBe("banner");
    expect(pickTemplate([], null)).toEqual(DEFAULT_TEMPLATE);
  });

  it("prints in the template's color, else the brand color", () => {
    expect(documentColor({ color: "#2f6b3a" }, { branding: { color: "#000000" } })).toBe("#2f6b3a");
    expect(documentColor({ color: null }, { branding: { color: "#123456" } })).toBe("#123456");
    expect(documentColor({ color: null }, {})).toBe("#1f4e79");
  });
});
