import { SITE_ADJUSTMENT_NAME, siteAdjustmentLines, siteSubtotal, sitePriceAdjustment, snapshotLines } from "@crewtavo/core/estimates";
import { discountSplit, optionTotals, quoteTotals, toCents } from "@crewtavo/core/money";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { contractTemplate } from "../src/features/documents/build";
import { templatesKey } from "../src/features/documents/data";
import { estimateKey } from "../src/features/roofing/estimate/data";
import type { EstimateLine } from "../src/features/roofing/estimate/types";
import {
  adjustmentNote,
  estimatePrice,
  estimateSubtotal,
  keptNote,
  keptPriceKey,
  keptPriceText,
  parsePrice,
  optionNet,
  priceInputText,
  priceToSave,
  rangeNote,
  rangeWords,
  readKeptPrice,
  readSigningOutcome,
  roofFacts,
  roundDown,
  savedSitePrice,
  shortDay,
  signBlocker,
  signedCopies,
  signedSentence,
  signedWhen,
  totalsAt,
  visitChanges,
} from "../src/features/roofing/visit/price";
import { checkSigningAgain, paperContract } from "../src/features/roofing/visit/data";

let n = 0;
const line = (patch: Partial<EstimateLine>): EstimateLine => ({
  id: `l${++n}`,
  option_id: null,
  service_id: `s${n}`,
  name: "Line",
  description: null,
  quantity: 1,
  unit: "ea",
  unit_price: 0,
  unit_cost: null,
  taxable: true,
  optional: false,
  selected: true,
  option_group: null,
  formula: null,
  sort: n,
  materials: null,
  material_cost: null,
  ...patch,
});
const adjustment = (amount: number) => line({ name: SITE_ADJUSTMENT_NAME, service_id: null, unit_price: amount });

// $13,552 + $1,870 + $135 + $450 = $16,007; the gutter guards weren't picked.
const shingles = line({ name: "Architectural shingle roof", quantity: 24.2, unit: "square", unit_price: 560, formula: "squares" });
const tearOff = line({ name: "Tear-off and disposal", quantity: 22, unit: "square", unit_price: 85, formula: "roof_squares" });
const boots = line({ name: "Pipe boot", quantity: 3, unit: "ea", unit_price: 45 });
const dumpster = line({ name: "Dumpster", quantity: 1, unit: "ea", unit_price: 450 });
const guards = line({ name: "Gutter guards", quantity: 100, unit: "ft", unit_price: 7, optional: true, selected: false });
const roof = [shingles, tearOff, boots, dumpster, guards];

const quote = (patch: Partial<{ tax_rate: number; discount_amount: number; promo_code_id: string | null; priced_on_site_at: string | null; lines: EstimateLine[] }> = {}) => ({
  tax_rate: 0,
  discount_amount: 0,
  promo_code_id: null,
  priced_on_site_at: null,
  lines: roof,
  ...patch,
});

// Node's ICU puts a narrow no-break space before AM/PM.
const plain = (s: string) => s.replace(/ /g, " ");

describe("the price on site", () => {
  it("adds up the estimate's own lines, leaving out the price adjustment and options not picked", () => {
    expect(estimateSubtotal(roof)).toBe(16007);
    expect(estimateSubtotal([...roof, adjustment(493)])).toBe(16007);
  });

  it("takes a promo code's or the office's discount off the estimate, but not a discount set on site", () => {
    expect(estimatePrice(quote())).toBe(16007);
    expect(estimatePrice(quote({ promo_code_id: "p1", discount_amount: 500 }))).toBe(15507);
    expect(estimatePrice(quote({ discount_amount: 500 }))).toBe(15507);
    expect(estimatePrice(quote({ discount_amount: 7, priced_on_site_at: "2026-10-24T18:00:00Z" }))).toBe(16007);
  });

  it("charges for work added on site when the office gave a discount, instead of freezing the price", () => {
    // $500 off in the office, then a chimney found on the roof: the price follows the lines.
    const chimney = line({ name: "Chimney flashing", quantity: 1, unit_price: 650 });
    const office = quote({ discount_amount: 500, lines: [...roof, chimney] });
    expect(savedSitePrice(office)).toBeNull();
    expect(estimatePrice(office)).toBe(16157);
    expect(totalsAt(office, null)).toEqual({ subtotal: 16657, discount: 500, tax: 0, total: 16157 });
    // Saved as that price, so the server keeps the $500 off (a null price would clear it).
    expect(priceToSave(office, null)).toBe(16157);
    expect(priceToSave(office, 16000)).toBe(16000);
    expect(keptNote(office)).toBe("Before tax, with the $500 off already on the estimate.");
  });

  it("saves no price for the estimate as it is, and none over a promo code", () => {
    expect(priceToSave(quote(), null)).toBeNull();
    expect(priceToSave(quote(), 16000)).toBe(16000);
    expect(priceToSave(quote({ priced_on_site_at: "2026-10-24T18:00:00Z", discount_amount: 7 }), null)).toBeNull();
    expect(priceToSave(quote({ promo_code_id: "p1", discount_amount: 500 }), 15000)).toBeNull();
    expect(keptNote(quote())).toBeNull();
    expect(keptNote(quote({ promo_code_id: "p1", discount_amount: 500 }))).toBeNull();
  });

  it("starts from the price set on site last time, so it isn't dropped", () => {
    expect(savedSitePrice(quote())).toBeNull();
    expect(savedSitePrice(quote({ priced_on_site_at: "2026-10-24T18:00:00Z" }))).toBeNull();
    // A discount the office gave isn't a price set on site.
    expect(savedSitePrice(quote({ discount_amount: 500 }))).toBeNull();
    expect(savedSitePrice(quote({ priced_on_site_at: "2026-10-24T18:00:00Z", discount_amount: 7 }))).toBe(16000);
    expect(savedSitePrice(quote({ priced_on_site_at: "2026-10-24T18:00:00Z", lines: [...roof, adjustment(493)] }))).toBe(16500);
    // A promo code sets the discount itself; that isn't a price set by hand.
    expect(savedSitePrice(quote({ priced_on_site_at: "2026-10-24T18:00:00Z", promo_code_id: "p1", discount_amount: 500 }))).toBeNull();
  });

  it("works out what the homeowner pays at a price, the way the server and database will", () => {
    expect(totalsAt(quote(), null)).toEqual({ subtotal: 16007, discount: 0, tax: 0, total: 16007 });
    // Below the estimate: a discount.
    expect(totalsAt(quote(), 16000)).toEqual({ subtotal: 16007, discount: 7, tax: 0, total: 16000 });
    // Above it: a taxable adjustment line.
    expect(totalsAt(quote(), 16500)).toEqual({ subtotal: 16500, discount: 0, tax: 0, total: 16500 });
    // With 5% tax, on the price after the discount.
    expect(totalsAt(quote({ tax_rate: 0.05 }), 16000)).toEqual({ subtotal: 16007, discount: 7, tax: 800, total: 16800 });
    expect(totalsAt(quote({ tax_rate: 0.05 }), 16500).total).toBe(17325);
    // An old adjustment line is replaced, not added to.
    expect(totalsAt(quote({ lines: [...roof, adjustment(493)] }), 16200).total).toBe(16200);
    // A promo code keeps its own discount; a typed price doesn't apply.
    expect(totalsAt(quote({ promo_code_id: "p1", discount_amount: 500 }), 16000).total).toBe(15507);
  });

  it("rounds down to a whole hundred", () => {
    expect(roundDown(16007)).toBe(16000);
    expect(roundDown(19524.5)).toBe(19500);
    expect(roundDown(19500)).toBe(19500);
    expect(roundDown(99)).toBe(0);
  });

  it("reads a typed price to the cent, and turns away what isn't one", () => {
    expect(parsePrice("19,500")).toBe(19500);
    expect(parsePrice("$19,500.50")).toBe(19500.5);
    expect(parsePrice(" 19500 ")).toBe(19500);
    expect(parsePrice("19500.")).toBe(19500);
    expect(parsePrice(".5")).toBe(0.5);
    for (const bad of ["", "  ", "abc", "0", "0.00", "19.505", "1.2.3", "-500", "10000001"]) expect(parsePrice(bad), bad).toBeNull();
  });

  it("shows a price in the box with cents only when there are some", () => {
    expect(priceInputText(19524)).toBe("19,524");
    expect(priceInputText(19524.5)).toBe("19,524.50");
  });

  it("says what a set price does to the estimate", () => {
    expect(adjustmentNote(16007, 16500)).toBe("The extra $493 shows on the estimate as a price adjustment.");
    expect(adjustmentNote(16007, 16000)).toBe("The $7 off shows on the estimate as a discount.");
    expect(adjustmentNote(16007, 16007)).toBeNull();
    expect(adjustmentNote(16007, null)).toBeNull();
    // On an option it's a price adjustment either way, against what's left after the office's discount.
    expect(adjustmentNote(16007, 15514, { onOption: true, discount: 500 })).toBe("The extra $7 shows on the estimate as a price adjustment.");
    expect(adjustmentNote(16007, 15000, { onOption: true, discount: 500 })).toBe("The $507 off shows on the estimate as a price adjustment.");
    expect(adjustmentNote(16007, 15507, { onOption: true, discount: 500 })).toBeNull();
  });

  it("keeps a typed price for the tab, and the choice of the estimate as it is", () => {
    expect(readKeptPrice(null)).toBeUndefined();
    expect(readKeptPrice(keptPriceText(null))).toBeNull();
    expect(readKeptPrice(keptPriceText(19500.5))).toBe(19500.5);
    expect(readKeptPrice("abc")).toBeUndefined();
    expect(readKeptPrice("0")).toBeUndefined();
  });
});

describe("the range", () => {
  it("words where the price sits, and who it was for", () => {
    expect(rangeNote("above", 475, "Dana", true)).toEqual({ text: "$475 above the range. Say why in your notes.", short: "$475 above the range" });
    expect(rangeNote("inside", 0, "Dana", true).text).toBe("Inside the range Dana said yes to");
    expect(rangeNote("inside", 0, "Dana", false).text).toBe("Inside the range Dana was sent");
    expect(rangeNote("below", 0, "", false)).toEqual({ text: "Under the range they were sent", short: "Under the range" });
    expect(rangeNote("below", 0, "", true).text).toBe("Under the range they said yes to");
  });

  it("writes the range out", () => {
    expect(rangeWords(18300, 21050)).toBe("$18,300 to $21,050");
  });

  it("dates the yes without a year this year", () => {
    const now = new Date("2026-10-24T18:00:00Z");
    expect(shortDay("2026-10-23T15:00:00Z", "America/New_York", now)).toBe("Oct 23");
    expect(shortDay("2025-12-01T15:00:00Z", "America/New_York", now)).toBe("Dec 1, 2025");
    // 1 AM UTC on the 24th is still the 23rd in Los Angeles.
    expect(shortDay("2026-10-24T01:00:00Z", "America/Los_Angeles", now)).toBe("Oct 23");
  });

  it("lists what changed since the range, but not the price adjustment", () => {
    const range = snapshotLines(roof);
    const chimney = line({ name: "Chimney flashing", unit: "ea", unit_price: 650 });
    const now = [shingles, tearOff, { ...boots, quantity: 4 }, chimney, adjustment(300)];
    const changes = visitChanges(range, now)!;
    expect(changes.map((c) => [c.kind, c.name, c.amount])).toEqual([
      ["changed", "Pipe boot", 45],
      ["added", "Chimney flashing", 650],
      ["removed", "Dumpster", -450],
    ]);
    expect(visitChanges([...range, ...snapshotLines([adjustment(100)])], roof)).toEqual([]);
    expect(visitChanges(null, roof)).toBeNull();
  });
});

describe("signing", () => {
  const ready = { name: "Dana Whitfield", signature: "data:image/png;base64,AAAA", companyNeeded: true, companySignature: "data:image/png;base64,BBBB", company: "Ridgeline Roofing" };

  it("says what's still missing on the button", () => {
    expect(signBlocker(ready)).toBeNull();
    expect(signBlocker({ ...ready, signature: null })).toBe("Sign above to finish");
    expect(signBlocker({ ...ready, name: " D " })).toBe("Type your name to finish");
    expect(signBlocker({ ...ready, companySignature: null })).toBe("Sign for Ridgeline Roofing to finish");
    expect(signBlocker({ ...ready, companyNeeded: false, companySignature: null })).toBeNull();
  });

  it("puts the package and the roof's size on the document, worded like the homeowner's copy", () => {
    expect(roofFacts("Architectural shingle", { roofing_squares: 22, roof_pitch: "6/12" })).toEqual(["Architectural shingle", "22.0 squares", "6/12 pitch"]);
    expect(roofFacts(" Standing-seam metal ", null)).toEqual(["Standing-seam metal"]);
    expect(roofFacts(null, { roofing_squares: null, roof_pitch: "6/12" })).toEqual([]);
  });

  it("reads how signing went from the router or the tab, and nothing else", () => {
    expect(readSigningOutcome({ emailed: true })).toEqual({ emailed: true, email_reason: null });
    expect(readSigningOutcome({ emailed: false, email_reason: "Add an email address for Dana Whitfield first." })).toEqual({ emailed: false, email_reason: "Add an email address for Dana Whitfield first." });
    expect(readSigningOutcome({ emailed: false, email_reason: " " })).toEqual({ emailed: false, email_reason: null });
    expect(readSigningOutcome(null)).toBeNull();
    expect(readSigningOutcome({ emailed: "yes" })).toBeNull();
    expect(readSigningOutcome("signed")).toBeNull();
  });

  it("prints no terms on the paper when they didn't load, never the template's with their fill-ins unfilled", () => {
    const template = { terms: "I, {Customer name}, agree to the work above." };
    // Still loading: no paper yet.
    expect(paperContract(null, false)).toBeNull();
    const failed = paperContract(null, true);
    expect(failed).toEqual({ terms: "", sections: [], hash: null });
    expect(contractTemplate(template, failed).terms).toBe("");
    // What it would have printed without one.
    expect(contractTemplate(template, null).terms).toContain("{Customer name}");
    // Loaded, it's the contract itself, even when loading it again failed after.
    const contract = { terms: "I, Dana Whitfield, agree to the work above.", sections: [], hash: "h1" };
    expect(paperContract(contract, false)).toBe(contract);
    expect(paperContract(contract, true)).toBe(contract);
  });
});

describe("checking it again after the server said it changed", () => {
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("loads the template again with the estimate and the terms, and is done only once they're all in", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const keys = {
      estimate: estimateKey("q1"),
      details: [...estimateKey("q1"), "details"],
      // The office changed the template's terms (or the sections it picks) while the homeowner read.
      templates: templatesKey("c1"),
      library: ["contract-sections", "c1", "by-id", ["s1"]],
      company: ["contract-company", "c1"],
    };
    const loads: Record<string, number> = {};
    let gate: Promise<void> | null = null;
    const unsubscribe = Object.entries(keys).map(([name, queryKey]) =>
      new QueryObserver(client, {
        queryKey,
        queryFn: async () => {
          loads[name] = (loads[name] ?? 0) + 1;
          if (name === "templates" && gate) await gate;
          return loads[name];
        },
      }).subscribe(() => {}),
    );
    await tick();
    expect(loads).toEqual({ estimate: 1, details: 1, templates: 1, library: 1, company: 1 });

    let open = () => {};
    gate = new Promise<void>((resolve) => (open = resolve));
    let done = false;
    const checking = checkSigningAgain(client, "q1", "c1").then(() => (done = true));
    await tick();
    expect(loads).toEqual({ estimate: 2, details: 2, templates: 2, library: 2, company: 2 });
    // The templates are still coming: signing waits for them.
    expect(done).toBe(false);
    open();
    await checking;
    expect(done).toBe(true);
    expect(client.getQueryData(keys.templates)).toBe(2);
    unsubscribe.forEach((stop) => stop());
  });
});

describe("signed", () => {
  const approvedAt = "2026-10-24T18:14:00Z";

  it("finds the signed copies sent since signing, and not the range or older copies", () => {
    const copies = signedCopies(
      [
        { channel: "email", subject: "Your roof estimate from Ridgeline Roofing", created_at: "2026-10-20T15:00:00Z" },
        { channel: "email", subject: "Your signed estimate from Ridgeline Roofing", created_at: "2026-10-01T15:00:00Z" },
        { channel: "email", subject: "Your signed estimate from Ridgeline Roofing", created_at: "2026-10-24T18:14:02Z" },
        { channel: "sms", subject: "Signed estimate #1042", created_at: "2026-10-24T18:20:00Z" },
      ],
      approvedAt,
    );
    expect(copies.email?.created_at).toBe("2026-10-24T18:14:02Z");
    expect(copies.sms?.subject).toBe("Signed estimate #1042");
    expect(signedCopies([{ channel: "email", subject: "Your roof estimate from Ridgeline Roofing", created_at: "2026-10-24T18:30:00Z" }], approvedAt)).toEqual({ email: null, sms: null });
  });

  it("says when, in the business's time zone", () => {
    const now = new Date("2026-10-24T20:00:00Z");
    expect(plain(signedWhen(approvedAt, "America/New_York", now))).toBe("at 2:14 PM");
    expect(plain(signedWhen("2026-10-22T18:14:00Z", "America/New_York", now))).toBe("on Oct 22 at 2:14 PM");
    expect(plain(signedWhen("2025-10-22T18:14:00Z", "America/New_York", now))).toBe("on Oct 22, 2025 at 2:14 PM");
  });

  it("says who signed, for how much and when", () => {
    const base = { client: "Dana Whitfield", amount: 19524, signedAt: approvedAt, timeZone: "America/New_York", now: new Date("2026-10-24T20:00:00Z") };
    const say = (s: Parameters<typeof signedSentence>[0]) => {
      const parts = signedSentence(s);
      return plain(`${parts.lead} [${parts.amount}]${parts.rest}`);
    };
    expect(say({ ...base, method: "in_person", companySigner: "Mike Torres", byMe: true })).toBe("Dana Whitfield and you signed the estimate for [$19,524] at 2:14 PM. It's saved on the project with both signatures.");
    expect(say({ ...base, method: "in_person", companySigner: "Mike Torres", byMe: false })).toBe("Dana Whitfield and Mike Torres signed the estimate for [$19,524] at 2:14 PM. It's saved on the project with both signatures.");
    expect(say({ ...base, method: "in_person", companySigner: null, byMe: false })).toBe("Dana Whitfield signed the estimate for [$19,524] at 2:14 PM. It's saved on the project.");
    expect(say({ ...base, method: null, companySigner: null, byMe: false, amount: 19524.5 })).toBe("Dana Whitfield signed the estimate online for [$19,524.50] at 2:14 PM. It's saved on the project.");
    expect(say({ ...base, method: "manual", companySigner: null, byMe: false })).toBe("The estimate for [$19,524] was marked approved at 2:14 PM.");
    expect(say({ ...base, client: " ", method: "in_person", companySigner: null, byMe: true, signedAt: null })).toBe("The homeowner and you signed the estimate for [$19,524]. It's saved on the project with both signatures.");
  });
});

describe("the price on site, with options", () => {
  // Good is shown and chosen; Better's roof and Best's are kept unselected. The tear-off, boots and
  // dumpster are on every option, and Better has a ridge vent add-on nobody picked.
  const shared = [tearOff, boots, dumpster].map((l) => ({ ...l, option_id: null }));
  const good = line({ option_id: "good", name: "Architectural shingle roof", quantity: 24.2, unit: "square", unit_price: 560, formula: "squares" });
  const better = line({ option_id: "better", name: "Designer shingle roof", quantity: 24.2, unit: "square", unit_price: 690, formula: "squares", selected: false });
  const vent = line({ option_id: "better", name: "Ridge vent", quantity: 1, unit_price: 380, optional: true, selected: false });
  const best = line({ option_id: "best", name: "Standing-seam metal roof", quantity: 24.2, unit: "square", unit_price: 1150, formula: "squares", selected: false });
  const lines = [good, better, vent, best, ...shared];
  const offered = (patch: Partial<{ tax_rate: number; discount_amount: number; priced_on_site_at: string | null; lines: EstimateLine[]; option_id: string | null }> = {}) => ({
    tax_rate: 0.07,
    discount_amount: 0,
    promo_code_id: null,
    priced_on_site_at: null,
    option_id: "good",
    lines,
    ...patch,
  });
  const money = (q: ReturnType<typeof offered>) => ({ taxRate: q.tax_rate, discountAmount: q.discount_amount, promo: null });
  // What the server books for a price (services/roofPackages.ts setSitePrice): lines on the option shown.
  const booked = (q: ReturnType<typeof offered>, price: number) => {
    const { extra } = sitePriceAdjustment((toCents(siteSubtotal(q.lines, q.option_id)) - toCents(q.discount_amount)) / 100, price, { onOption: true });
    const rest = q.lines.filter((l) => !(l.name === SITE_ADJUSTMENT_NAME && l.option_id === q.option_id));
    const work = rest.filter((l) => (l.option_id === null || l.option_id === q.option_id) && (!l.optional || l.selected));
    return [...rest, ...siteAdjustmentLines(extra, work).map((a) => line({ option_id: q.option_id, name: SITE_ADJUSTMENT_NAME, service_id: null, ...a }))];
  };

  it("prices the option chosen and the shared lines, not the other options", () => {
    expect(estimateSubtotal(lines, "good")).toBe(13552 + 1870 + 135 + 450);
    expect(estimatePrice(offered())).toBe(16007);
    // The database's own total for the option shown, to the cent.
    expect(totalsAt(offered(), null)).toEqual(optionTotals(lines, "good", "good", money(offered())));
    expect(estimatePrice(offered({ option_id: "better" }))).toBe(16698 + 1870 + 135 + 450);
  });

  it("works out a price set on site as the line the server books on that option, the office's discount kept", () => {
    const q = offered({ discount_amount: 500 });
    expect(optionNet(q)).toBe(15507);
    for (const price of [15000, 15507, 16500]) {
      const after = booked(q, price);
      const totals = optionTotals(after, "good", "good", money(q));
      // The option comes to the price agreed before tax, and the screen says what the database will.
      expect(toCents(totals.subtotal) - toCents(totals.discount)).toBe(toCents(price));
      expect(totalsAt(q, price)).toEqual(totals);
      // Coming back, the screen starts from it.
      expect(savedSitePrice({ ...q, lines: after, priced_on_site_at: "2026-10-24T18:00:00Z" })).toBe(price);
    }
    // Another option's price isn't touched.
    const after = booked(q, 15000);
    expect(optionTotals(after, "better", "good", money(q)).total).toBe(optionTotals(lines, "better", "good", money(q)).total);
  });

  it("keeps the office's discount when the price set on site is taken back", () => {
    const q = offered({ discount_amount: 500, priced_on_site_at: "2026-10-24T18:00:00Z", lines: booked(offered({ discount_amount: 500 }), 15000) });
    expect(estimatePrice(q)).toBe(15507);
    expect(keptNote(q)).toBe("Before tax, with the $500 off already on the estimate.");
    expect(totalsAt(q, null).total).toBe(optionTotals(lines, "good", "good", money(q)).total);
  });

  it("prices a lower price off the taxed and untaxed work as the server books it, and as the estimate priced on site became option 1", () => {
    // The dumpster isn't taxed. Priced $1,000 lower before there were options, then made option 1:
    // the database made its discount a taxed and an untaxed line (quote_option_added).
    const untaxed = lines.map((l) => (l.id === dumpster.id ? { ...l, taxable: false } : l));
    const work = untaxed.filter((l) => l.option_id === null || l.option_id === "good");
    const split = discountSplit(1000, work);
    const converted = offered({
      priced_on_site_at: "2026-10-24T18:00:00Z",
      lines: [...untaxed, line({ option_id: "good", name: SITE_ADJUSTMENT_NAME, service_id: null, unit_price: -split.taxed }), line({ option_id: "good", name: SITE_ADJUSTMENT_NAME, service_id: null, unit_price: -split.untaxed, taxable: false })],
    });
    // What the database says, which is what the price came to as a discount, tax and all.
    const stored = optionTotals(converted.lines, "good", "good", money(converted));
    expect(stored.total).toBe(quoteTotals(work, { taxRate: 0.07, discountAmount: 1000 }).total);
    // The iPad starts from that price and shows that total; saving it again books the same lines.
    expect(savedSitePrice(converted)).toBe(15007);
    expect(totalsAt(converted, 15007)).toEqual(stored);
    const again = booked(converted, 15007);
    expect(again.filter((l) => l.name === SITE_ADJUSTMENT_NAME).map((l) => [l.unit_price, l.taxable])).toEqual([[-split.taxed, true], [-split.untaxed, false]]);
    expect(optionTotals(again, "good", "good", money(converted))).toEqual(stored);
  });

  it("keeps a typed price for the quote and the option it was for", () => {
    expect(keptPriceKey("q1", null)).toBe("crewtavo.site-price.q1");
    expect(keptPriceKey("q1", "good")).toBe("crewtavo.site-price.q1.good");
    expect(keptPriceKey("q1", "better")).not.toBe(keptPriceKey("q1", "good"));
  });

  it("lists what changed since the range on the option looked at and the shared lines", () => {
    const range = snapshotLines(lines);
    const now = lines.map((l) => (l.id === better.id ? { ...l, quantity: 25 } : l));
    expect(visitChanges(range, now, "good")).toEqual([]);
    expect(visitChanges(range, now, "better")!.map((c) => [c.name, c.kind])).toEqual([["Designer shingle roof", "changed"]]);
  });
});
