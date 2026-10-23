import { DEFAULT_TEMPLATE } from "@crewtavo/core/documents";
import { describe, expect, it } from "vitest";
import {
  credentialLine,
  dayText,
  hubAccent,
  measuredLine,
  measuredRoof,
  packageLabel,
  phoneHref,
  propertyLine,
  rangeDates,
  roofTiles,
  tearOffLayers,
  trustBadges,
  websiteHref,
  type HubDrawing,
  type QuoteView,
} from "../src/features/hub/document";

const company: QuoteView["company"] = { name: "Summit Roofing", phone: "555-0100", email: null, website: null, timezone: "America/Chicago", branding: { color: "#3b7d23" } };

function drawing(overrides: Partial<HubDrawing> = {}): HubDrawing {
  return {
    id: "d1", title: "Roof", has_picture: true, total_area_sqft: 1968, total_length_ft: 180, roofing_squares: 25.3, roof_pitch: "6/12", imagery: null,
    sections: [
      { label: "Area 1", kind: "Area", value: 1968, unit: "sq ft" },
      { label: "Eaves", kind: "Length", value: 180, unit: "ft" },
      { label: "Chimney", kind: "Cutout", value: 16, unit: "sq ft" },
    ],
    ...overrides,
  };
}

function rangeView(quote: Partial<QuoteView["quote"]> = {}, range: Partial<NonNullable<QuoteView["quote"]["range"]>> = {}): Pick<QuoteView, "company" | "quote"> {
  return {
    company,
    quote: {
      id: "q1", number: 1042, status: "sent", title: "New roof", message: null, subtotal: null, discount_amount: null, promo: null, tax_rate: 0, tax_amount: null, total: null,
      deposit_amount: null, valid_until: "2026-11-21", sent_at: "2026-10-20T15:00:00Z", approved_at: null, client: { display_name: "Dana Whitfield" }, property: null, lines: [],
      range: { low: 18300, high: 21050, sent_at: "2026-10-23T03:00:00Z", accepted_at: null, included: [], maybe: [], ...range },
      ...quote,
    },
  };
}

describe("the roof on the range page", () => {
  it("measures the roof at its pitch, without the waste the saved squares include", () => {
    const roof = measuredRoof([drawing()])!;
    // 1,968 sq ft from above at 6/12 is 2,200 sq ft of roof; the saved 25.3 squares have waste in them.
    expect(roof.areaSqft).toBeCloseTo(2200.3, 1);
    expect(roof.squares).toBeCloseTo(22, 1);
    expect(roof).toMatchObject({ pitch: "6/12", mixed: false });
    expect(roofTiles(roof)).toEqual([
      { label: "Roof size", value: "22 squares" },
      { label: "Roof area", value: "2,200 sq ft" },
      { label: "Pitch", value: "6/12" },
    ]);
  });

  it("adds up sections at their own pitches and names the main one", () => {
    const roof = measuredRoof([drawing({
      sections: [
        { label: "House", kind: "Area", value: 1600, unit: "sq ft" },
        { label: "Porch", kind: "Area", value: 400, unit: "sq ft", pitch: "3/12" },
      ],
    })])!;
    expect(roof.areaSqft).toBeCloseTo(1600 * Math.sqrt(1.25) + 400 * Math.sqrt(1 + 1 / 16), 6);
    expect(roof).toMatchObject({ pitch: "6/12", mixed: true });
    expect(roofTiles(roof).find((t) => t.value === "6/12")?.label).toBe("Main pitch");
  });

  it("keeps a decimal on small roofs, calls 0/12 flat, and leaves out a pitch it can't read", () => {
    const flat = measuredRoof([drawing({ roof_pitch: "0/12", sections: [{ label: "Garage", kind: "Area", value: 640, unit: "sq ft" }] })])!;
    expect(roofTiles(flat)).toEqual([
      { label: "Roof size", value: "6.4 squares" },
      { label: "Roof area", value: "640 sq ft" },
      { label: "Pitch", value: "Flat" },
    ]);
    const odd = measuredRoof([drawing({ roof_pitch: "steep", sections: [{ label: "Area 1", kind: "Area", value: 2000, unit: "sq ft" }] })])!;
    expect(odd.pitch).toBeNull();
    expect(roofTiles(odd).map((t) => t.label)).toEqual(["Roof size", "Roof area"]);
  });

  it("falls back to the drawing's whole area, and skips drawings that aren't roofs", () => {
    const roof = measuredRoof([drawing({ sections: [], total_area_sqft: 2000 })])!;
    expect(roof.areaSqft).toBeCloseTo(2000 * Math.sqrt(1.25), 6);
    expect(measuredRoof([drawing({ roofing_squares: null })])).toBeNull();
    expect(measuredRoof(undefined)).toBeNull();
    expect(measuredRoof([drawing({ id: "gutters", roofing_squares: null }), drawing({ id: "roof" })])!.drawings.map((d) => d.id)).toEqual(["roof"]);
  });

  it("finds the layers coming off in what's included", () => {
    expect(tearOffLayers(["Architectural shingle roof", "Tear-off and disposal (2 layers)"])).toBe(2);
    expect(tearOffLayers(["Tear-off and disposal"])).toBe(1);
    expect(tearOffLayers(["Tear off old roof"])).toBe(1);
    expect(tearOffLayers(["Dumpster and disposal"])).toBeNull();
    const roof = measuredRoof([drawing()])!;
    expect(roofTiles(roof, ["Tear-off and disposal"]).at(-1)).toEqual({ label: "Tear-off", value: "1 layer" });
    expect(roofTiles(roof, ["Tear-off and disposal (3 layers)"]).at(-1)).toEqual({ label: "Tear-off", value: "3 layers" });
  });

  it("says when it was measured, where the business is, when the server sends the date", () => {
    const roof = measuredRoof([drawing({ measured_at: "2026-10-23T02:00:00Z" })])!;
    expect(measuredLine(roof, "America/Chicago", "2026-10-23")).toBe("Measured from aerial photos on October 22. We check every measurement on site.");
    expect(measuredLine(roof, "America/Chicago", "2027-01-05")).toBe("Measured from aerial photos on October 22, 2026. We check every measurement on site.");
    expect(measuredLine(measuredRoof([drawing()])!, "America/Chicago", "2026-10-23")).toBe("Measured from aerial photos. We check every measurement on site.");
  });
});

describe("the range page's words", () => {
  it("dates the range on the business's calendar", () => {
    // Sent at 10 PM on the 22nd in Chicago, which is already the 23rd in UTC.
    expect(rangeDates(rangeView(), "2026-10-23")).toEqual({ sent: "October 22, 2026", goodUntil: "November 21", expired: false });
    expect(rangeDates(rangeView({ valid_until: "2027-01-15" }), "2026-10-23").goodUntil).toBe("January 15, 2027");
    expect(rangeDates(rangeView(), "2026-11-22").expired).toBe(true);
    // An older range without its own sent date uses the quote's; a preview has neither.
    expect(rangeDates(rangeView({}, { sent_at: null }), "2026-10-23").sent).toBe("October 20, 2026");
    expect(rangeDates(rangeView({ sent_at: null, valid_until: null }, { sent_at: null }), "2026-10-23")).toEqual({ sent: null, goodUntil: null, expired: false });
  });

  it("writes days out in full", () => {
    expect(dayText("2026-10-23")).toBe("October 23, 2026");
    expect(dayText("2026-10-23", false)).toBe("October 23");
    expect(dayText("not a date")).toBe("");
  });

  it("names the package as a roof, and the property on one line", () => {
    expect(packageLabel("Architectural shingle")).toBe("Architectural shingle roof");
    expect(packageLabel("Standing-seam metal roof")).toBe("Standing-seam metal roof");
    expect(packageLabel("Roof over")).toBe("Roof over");
    expect(packageLabel(null)).toBe("");
    expect(propertyLine({ line1: "1482 Ridgeview Dr", city: "Columbus", region: "OH", postal_code: "43221" })).toBe("1482 Ridgeview Dr, Columbus, OH 43221");
    expect(propertyLine({ line1: "1482 Ridgeview Dr", city: null })).toBe("1482 Ridgeview Dr");
    expect(propertyLine(null)).toBe("");
  });

  it("links the phone and website", () => {
    expect(phoneHref("+1 (614) 555-0188")).toBe("tel:+16145550188");
    expect(websiteHref("ridgeline.example")).toBe("https://ridgeline.example");
    expect(websiteHref("http://ridgeline.example/")).toBe("http://ridgeline.example/");
  });

  it("shows Licensed and Fully insured only when they're filled in and shown", () => {
    const template = { ...DEFAULT_TEMPLATE, license: "License #RC-104882", insurer: "Hartwell Mutual" };
    expect(trustBadges(template)).toEqual([
      { kind: "license", title: "Licensed", detail: "#RC-104882" },
      { kind: "insured", title: "Fully insured", detail: "Hartwell Mutual" },
    ]);
    expect(trustBadges({ ...template, license: "Lic. 5521" })[0]!.detail).toBe("5521");
    expect(trustBadges({ ...template, license: "LIC-12345" })[0]!.detail).toBe("LIC-12345");
    expect(trustBadges({ ...template, license: "Licensed contractor 99" })[0]!.detail).toBe("Licensed contractor 99");
    expect(trustBadges({ ...template, show_license: false }).map((b) => b.kind)).toEqual(["insured"]);
    expect(trustBadges({ ...template, insurer: "  " }).map((b) => b.kind)).toEqual(["license"]);
    expect(trustBadges(DEFAULT_TEMPLATE)).toEqual([]);
  });

  it("words the license and insurer at the foot as the document does", () => {
    const template = { ...DEFAULT_TEMPLATE, license: "#RC-104882", insurer: "Hartwell Mutual" };
    expect(credentialLine(template)).toBe("License #RC-104882 · Insured by Hartwell Mutual");
    expect(credentialLine({ ...template, license: "Lic. 5521", show_insurer: false })).toBe("Lic. 5521");
    expect(credentialLine(DEFAULT_TEMPLATE)).toBe("");
  });
});

describe("the range page's color", () => {
  it("uses the template's color, else the brand color, else navy", () => {
    expect(hubAccent({ template: { color: "#a33a2b" }, company }).color).toBe("#a33a2b");
    expect(hubAccent({ template: {}, company }).color).toBe("#3b7d23");
    expect(hubAccent({ company: { branding: null } }).color).toBe("#1f4e79");
  });

  it("keeps words readable: the color itself when it's dark enough, else ink", () => {
    expect(hubAccent({ template: { color: "#1f4e79" }, company })).toEqual({ color: "#1f4e79", text: "#1f4e79", on: "#ffffff" });
    // A light brand color fills the button with ink words on it, and words on white go ink.
    expect(hubAccent({ company: { branding: { color: "#f4b143" } } })).toEqual({ color: "#f4b143", text: "#0f2a35", on: "#0f2a35" });
    // Readable as a big fill, too light for small words on white.
    expect(hubAccent({ company: { branding: { color: "#5cb85c" } } }).text).toBe("#0f2a35");
  });
});
