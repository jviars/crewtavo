import { describe, expect, it } from "vitest";
import { DEFAULT_TEMPLATE, documentColor, letterheadSrc, ownLetterhead, pickTemplate, templateSettings } from "../src/documents";
import {
  followPrice,
  hidesExactPrice,
  inRangeMode,
  lineChanges,
  marginPct,
  optionsIntroText,
  optionsRange,
  priceRange,
  rangeIntroText,
  rangeSettings,
  SITE_ADJUSTMENT_NAME,
  siteAdjustmentLines,
  sitePriceAdjustment,
  sitePriceSet,
  siteSubtotal,
  snapshotLines,
  type CurrentLine,
} from "../src/estimates";
import { discountSplit, optionBaseTotal, optionTotals, quoteTotals, toCents } from "../src/money";
import { add, cents, div, mul, num, round, sqlQuoteTotals } from "./numeric";

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

describe("optionsRange", () => {
  const settings = { pct: 15, round: 50 };

  it("runs from the cheapest option's low end to the priciest one's high end", () => {
    expect(optionsRange([22832, 17582, "39332.00"], settings)).toEqual({ low: priceRange(17582, settings).low, high: priceRange(39332, settings).high });
    expect(optionsRange([22832, 17582, 39332], settings)).toEqual({ low: 17550, high: 45250 });
  });

  it("is the same as one estimate's range for one option", () => {
    expect(optionsRange([18304], settings)).toEqual(priceRange(18304, settings));
    expect(optionsRange(["19524.00"], { pct: 15, round: 100 })).toEqual({ low: 19500, high: 22500 });
  });

  it("leaves out options with no total yet", () => {
    expect(optionsRange([null, 18304, 0, undefined, ""], settings)).toEqual(priceRange(18304, settings));
    expect(optionsRange([], settings)).toEqual({ low: 0, high: 0 });
    expect(optionsRange([null, 0])).toEqual({ low: 0, high: 0 });
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

describe("a range for an estimate with options", () => {
  // Better ("b") is shown, with its add-on picked: the other options' lines are unselected, as the
  // database keeps them.
  const lines = [
    line("dump", "Dumpster", 1, 450, { option_id: null }),
    line("arch", "Architectural shingle roof", 30, 560, { option_id: "a", selected: false }),
    line("designer", "Designer shingle roof", 30, 735, { option_id: "b", selected: true }),
    line("ice", "Ice and water shield", 1, 400, { option_id: "b", optional: true, selected: true }),
    line("snow", "Snow guards", 1, 900, { option_id: "c", optional: true, selected: false }),
    line("metal", "Standing-seam metal roof", 30, 1285, { option_id: "c", selected: false }),
  ];
  const range = snapshotLines(lines);
  /** The lines as the database keeps them with `option` shown: its required lines on, its add-ons off. */
  const show = (option: string) => lines.map((l) => (l.option_id == null ? l : { ...l, selected: l.option_id === option && !l.optional }));

  it("saves what the range was priced from: the shared lines and every option's own, without add-ons", () => {
    expect(range.map((s) => [s.id, s.option_id])).toEqual([["dump", null], ["arch", "a"], ["designer", "b"], ["metal", "c"]]);
    expect(snapshotLines(show("c"))).toEqual(range); // whichever option is shown
    expect(snapshotLines([line("x", "Gutters", 1, 10, { option_id: "b", optional: true, selected: true })])).toEqual([]);
    expect(snapshotLines([line("x", "Gutters", 1, 10, { option_id: null, optional: true, selected: true })])).toHaveLength(1);
    expect(snapshotLines([line("x", "Gutters", 1, 10)])[0]!.option_id).toBeNull();
  });

  it("adds up, option by option, to the base each option's range came from", () => {
    const withOptions = lines.map((l) => ({ ...l, option_id: l.option_id ?? null }));
    expect(optionBaseTotal(withOptions, "b", { taxRate: 0 })).toBe(22500);
    for (const opts of [{ taxRate: 0 }, { taxRate: 0.053, discountAmount: 100 }, { taxRate: "0.08875", promo: { kind: "percent", value: 7.5 } }]) {
      for (const option of ["a", "b", "c"]) {
        const saved = range.filter((s) => s.option_id == null || s.option_id === option);
        expect(quoteTotals(saved, opts).total, option).toBe(optionBaseTotal(withOptions, option, opts));
        expect(saved.reduce((sum, s) => sum + toCents(s.total), 0), option).toBe(toCents(quoteTotals(saved, { taxRate: 0 }).subtotal));
      }
    }
  });

  it("compares only the shared lines and that option's", () => {
    const now = [...lines.filter((l) => l.id !== "dump"), line("arch2", "Chimney flashing", 1, 650, { option_id: "a" })];
    expect(lineChanges(range, now, "a").map((c) => [c.kind, c.id])).toEqual([["added", "arch2"], ["removed", "dump"]]);
    expect(lineChanges(range, now, "b").map((c) => [c.kind, c.id])).toEqual([["added", "ice"], ["removed", "dump"]]);
  });

  it("shows an add-on picked on the shown option as added, since the range was priced without it", () => {
    // Better comes to $22,900 with the ice and water shield, against the $22,500 its range came from.
    expect(lineChanges(range, lines, "b")).toEqual([{ kind: "added", id: "ice", name: "Ice and water shield", unit: "ea", from: null, to: 1, amount: 400 }]);
  });

  it("finds nothing changed when only the option did", () => {
    expect(lineChanges(range, show("c"), "c")).toEqual([]);
    expect(lineChanges(range, show("b"), "b")).toEqual([]); // back on Better, its add-on starts off
    expect(lineChanges(range, show("c"), null)).toEqual([]);
    expect(lineChanges(range, lines)).toEqual([]); // without the option, just the shared lines
  });

  it("still reads a range sent before options", () => {
    const old = snapshotLines([line("a", "Shingles", 24.2, 560)]).map(({ option_id: _, ...s }) => s);
    expect(lineChanges(old, [line("a", "Shingles", 24.2, 560), line("b", "Gutters", 1, 10, { option_id: "x" })], null)).toEqual([]);
    expect(lineChanges(old, [line("a", "Shingles", 24.2, 560), line("b", "Gutters", 1, 10, { option_id: "x" })])).toEqual([]);
    expect(lineChanges(old, [line("a", "Shingles", 25, 560)], "x")).toEqual([expect.objectContaining({ kind: "changed", id: "a", amount: 448 })]);
  });
});

describe("a price set on site", () => {
  it("is a discount below the estimate and an extra line above it", () => {
    expect(sitePriceAdjustment(19524, 19500)).toEqual({ discount: 24, extra: 0 });
    expect(sitePriceAdjustment("19524.00", 21000)).toEqual({ discount: 0, extra: 1476 });
    expect(sitePriceAdjustment(100, 100)).toEqual({ discount: 0, extra: 0 });
  });

  it("is all one price adjustment line on an estimate with options, below zero when the price is lower", () => {
    expect(sitePriceAdjustment(23194, "22999.99", { onOption: true })).toEqual({ discount: 0, extra: -194.01 });
    expect(sitePriceAdjustment("23194.00", 24000.5, { onOption: true })).toEqual({ discount: 0, extra: 806.5 });
    expect(sitePriceAdjustment(100, 100, { onOption: true })).toEqual({ discount: 0, extra: 0 });
  });

  it("comes off an option's taxed and untaxed work as a discount would, so tax comes off as it would without options", () => {
    // $10,000 taxed and $500 untaxed, priced $1,000 lower: a taxed and an untaxed price adjustment line.
    const work = [{ quantity: 1, unit_price: 10000, taxable: true }, { quantity: 1, unit_price: 500, taxable: false }];
    const lines = siteAdjustmentLines(-1000, work);
    expect(lines).toEqual([{ unit_price: -952.38, taxable: true }, { unit_price: -47.62, taxable: false }]);
    // The total the database gets as quote_option_added splits it when such an estimate becomes option 1 ($10,223.81).
    const priced = quoteTotals([...work, ...lines.map((l) => ({ ...l, quantity: 1 }))], { taxRate: 0.08 });
    expect(priced).toEqual({ subtotal: 9500, discount: 0, tax: 723.81, total: 10223.81 });
    expect(priced.total).toBe(quoteTotals(work, { taxRate: 0.08, discountAmount: 1000 }).total);
    // All taxed work (or none): one line. Above the estimate: one taxed line. The same price: none.
    expect(siteAdjustmentLines(-194.01, [{ quantity: 2, unit_price: 50, taxable: true }])).toEqual([{ unit_price: -194.01, taxable: true }]);
    expect(siteAdjustmentLines(-50, [{ quantity: 1, unit_price: 80, taxable: false }])).toEqual([{ unit_price: -50, taxable: false }]);
    expect(siteAdjustmentLines(-50, [])).toEqual([{ unit_price: -50, taxable: true }]);
    expect(siteAdjustmentLines("806.50", work)).toEqual([{ unit_price: 806.5, taxable: true }]);
    expect(siteAdjustmentLines(0, work)).toEqual([]);
  });

  it("is in effect, so no promo code goes on top, only while its adjustment or discount is", () => {
    const adjustment = { option_id: "b", name: SITE_ADJUSTMENT_NAME, service_id: null, formula: null, optional: false, selected: true };
    const quote = { priced_on_site_at: "2026-10-25T18:00:00Z", option_id: "b", promo_code_id: null, discount_amount: 0 };
    expect(sitePriceSet(quote, [adjustment])).toBe(true);
    // Another option's price, or a visit that kept the estimate's price, isn't in effect.
    expect(sitePriceSet({ ...quote, option_id: "a" }, [adjustment])).toBe(false);
    expect(sitePriceSet(quote, [])).toBe(false);
    expect(sitePriceSet({ ...quote, priced_on_site_at: null }, [adjustment])).toBe(false);
    // Without options, the discount it set.
    expect(sitePriceSet({ ...quote, option_id: null, discount_amount: "24.00" }, [])).toBe(true);
    expect(sitePriceSet({ ...quote, option_id: null, promo_code_id: "p1", discount_amount: "24.00" }, [])).toBe(false);
  });

  it("splits a discount exactly as Postgres divides it", () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const money = (hi: number) => (Math.floor(rnd() * hi * 100) / 100).toFixed(2);
    const bad: unknown[] = [];
    for (let i = 0; i < 5000; i++) {
      const lines = Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => ({ quantity: rnd() < 0.7 ? "1" : "2.5", unit_price: rnd() < 0.1 ? `-${money(200)}` : money(5000), taxable: rnd() < 0.6, selected: rnd() < 0.9 }));
      const discount = money(3000);
      const charges = lines.filter((l) => l.selected && Number(l.unit_price) > 0);
      const sum = (rows: typeof lines) => rows.reduce((t, l) => add(t, round(mul(num(l.quantity, 3), num(l.unit_price, 2)), 2)), num("0"));
      const base = sum(charges);
      // round(v_discount * v_base_taxable / v_base, 2), else all of it
      const taxed = base.n > 0n ? cents(round(div(mul(num(discount), sum(charges.filter((l) => l.taxable))), base), 2)) : toCents(discount);
      const got = discountSplit(discount, lines);
      if (toCents(got.taxed) !== taxed || toCents(got.taxed) + toCents(got.untaxed) !== toCents(discount)) bad.push({ lines, discount, got, taxed });
    }
    expect(bad.slice(0, 3)).toEqual([]);
  });

  // Better ("b") is shown, priced on site before: its old adjustment is one of its lines.
  type SiteLine = { id: string; option_id: string | null; name: string; service_id: string | null; formula: string | null; quantity: number; unit_price: number; taxable: boolean; optional: boolean; selected: boolean };
  const site = (id: string, option_id: string | null, quantity: number, unit_price: number, extra: Partial<SiteLine> = {}): SiteLine => ({
    id, option_id, name: id, service_id: `svc-${id}`, formula: null, quantity, unit_price, taxable: true, optional: false, selected: true, ...extra,
  });
  const adjustment = (option_id: string | null, unit_price: number) => site("adjustment", option_id, 1, unit_price, { name: SITE_ADJUSTMENT_NAME, service_id: null });
  const lines = [
    site("dumpster", null, 1, 450, { taxable: false }),
    site("arch", "a", 30, 560, { selected: false }),
    site("designer", "b", 30.4, 735),
    site("ice", "b", 1, 400, { optional: true }),
    site("snow", "b", 1, 900, { optional: true, selected: false }),
    site("metal", "c", 30, 1285, { selected: false }),
    adjustment("b", 250),
  ];

  it("is measured against the shown option's lines, without the price set before", () => {
    expect(siteSubtotal(lines, "b")).toBe(450 + 22344 + 400);
    expect(siteSubtotal(lines, null)).toBe(450); // a quote without options has only shared lines
    expect(siteSubtotal([lines[0]!, adjustment(null, 300)], null)).toBe(450);
  });

  it("lands on the price to the cent, on that option only", () => {
    const opts = { taxRate: "0.0825" };
    const { extra } = sitePriceAdjustment(siteSubtotal(lines, "b"), 22999.99, { onOption: true });
    const priced = [...lines.slice(0, -1), adjustment("b", extra)];
    const totals = optionTotals(priced, "b", "b", opts);
    expect(totals.subtotal).toBe(22999.99);
    const sql = (l: SiteLine) => ({ quantity: String(l.quantity), unit_price: l.unit_price.toFixed(2), taxable: l.taxable, selected: l.selected });
    expect([toCents(totals.subtotal), toCents(totals.discount), toCents(totals.tax), toCents(totals.total)]).toEqual(
      Object.values(sqlQuoteTotals(priced.map(sql), { discount_amount: "0", tax_rate: "0.0825", promo: null })),
    );
    // The other options don't move, and setting the price again comes to the same line.
    for (const option of ["a", "c"]) expect(optionTotals(priced, option, "b", opts), option).toEqual(optionTotals(lines, option, "b", opts));
    expect(sitePriceAdjustment(siteSubtotal(priced, "b"), 22999.99, { onOption: true }).extra).toBe(extra);
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

  it("keeps the business's own letterhead only as pictures in its letterhead folder", () => {
    const header = { path: "00000000-0000-4000-8000-000000000001/letterhead/11111111-1111-4111-8111-111111111111.png", width: 1540, height: 300 };
    expect(templateSettings({})).toMatchObject({ letterhead: "built_in", letterhead_header: null, letterhead_footer: null });
    expect(templateSettings({ letterhead: "custom", letterhead_header: header })).toMatchObject({ letterhead: "custom", letterhead_header: header, letterhead_footer: null });
    const t = templateSettings({
      letterhead: "theirs",
      letterhead_header: { ...header, path: "00000000-0000-4000-8000-000000000001/logo/11111111-1111-4111-8111-111111111111.png" },
      letterhead_footer: { ...header, width: 0 },
    });
    expect(t).toMatchObject({ letterhead: "built_in", letterhead_header: null, letterhead_footer: null });
    expect(templateSettings({ letterhead_header: { ...header, height: 1e6 } }).letterhead_header).toBeNull();
    expect(letterheadSrc(header.path)).toBe("/api/public/letterhead/00000000-0000-4000-8000-000000000001/11111111-1111-4111-8111-111111111111.png");
  });

  it("prints the business's own letterhead only when the template uses it", () => {
    const picture = { path: "00000000-0000-4000-8000-000000000001/letterhead/11111111-1111-4111-8111-111111111111.png", width: 1540, height: 160 };
    expect(ownLetterhead({ letterhead: "built_in", letterhead_header: picture, letterhead_footer: picture })).toEqual({ header: null, footer: null });
    expect(ownLetterhead({ letterhead: "custom", letterhead_header: null, letterhead_footer: picture })).toEqual({ header: null, footer: picture });
  });

  it("keeps the contract sections as uuids, each once, up to fifty", () => {
    const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    expect(templateSettings({})).toMatchObject({ sections: [], invoice_sections: [] });
    const t = templateSettings({ sections: [id(2), id(1), id(2).toUpperCase(), "nope", 7, null], invoice_sections: id(1) });
    expect(t.sections).toEqual([id(2), id(1)]);
    expect(t.invoice_sections).toEqual([]);
    expect(templateSettings({ invoice_sections: Array.from({ length: 60 }, (_, i) => id(i)) }).invoice_sections).toHaveLength(50);
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

describe("rangeIntroText", () => {
  it("says the range in today's words for one estimate", () => {
    const words = "Thanks for having us look at your roof. From our measurements, your new roof will cost between $18,300 and $21,050. You can see what's included and let us know when you'd like us to come out:";
    expect(rangeIntroText("$18,300", "$21,050")).toBe(words);
    expect(rangeIntroText("$18,300", "$21,050", 0)).toBe(words);
    expect(rangeIntroText("$18,300", "$21,050", 1)).toBe(words);
  });

  it("says the range runs across the options when there are two or three", () => {
    const words = "Thanks for having us look at your roof. From our measurements, your new roof will cost between $17,550 and $45,250, depending on the option you pick. You can see the options and let us know when you'd like us to come out:";
    expect(rangeIntroText("$17,550", "$45,250", 2)).toBe(words);
    expect(rangeIntroText("$17,550", "$45,250", 3)).toBe(words);
  });
});

describe("optionsIntroText", () => {
  it("says how many options there are and the lowest price", () => {
    expect(optionsIntroText(3, "$16,800.00")).toBe("Thanks for the opportunity. Here's your quote, with 3 options from $16,800.00. You can compare them, choose the one you want and approve it online:");
  });
});
