/**
 * The office's quote screens with options (quotes/QuotePage.tsx, QuotesPage.tsx, the sales board):
 * the totals for the option looked at, the most the deposit can be, choosing the option they chose
 * before it's marked approved and the steps that follow, the approval the office keeps (read back as
 * a signature's is), the paper it prints, the range it sends, what the board and the list say and
 * price a quote that offers options at, and how the options bar marks the option shown.
 */
import { contractValues, type LibrarySection } from "@crewtavo/core/contracts";
import { DEFAULT_TEMPLATE, type TemplateSettings } from "@crewtavo/core/documents";
import { DEFAULT_RANGE, optionsRange, priceRange } from "@crewtavo/core/estimates";
import { optionBaseTotal, optionTotals, quoteTotals } from "@crewtavo/core/money";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { approvalSignatures, quoteContract, readApproval, signedContract, signedTemplate } from "../src/features/documents/data";
import { moveRefusal } from "../src/features/pipeline/PipelinePage";
import { hasOptionArt, listPrice, shownWords, sortOptions, withOptionLines, type QuoteOptionRow } from "../src/features/quotes/options";
import {
  approvalOption,
  approveSteps,
  historyIcon,
  contractFor,
  depositCap,
  firstChoice,
  needsChoice,
  offersOptions,
  officeApproval,
  optionChoices,
  paperDocument,
  printedOption,
  quoteToSend,
  tabTotals,
  totalsCaption,
  type PaperQuote,
} from "../src/features/quotes/QuotePage";
import { groupQuotes, isExpired, optionsNote, shortDate } from "../src/features/quotes/QuotesPage";
import { lowestOption, optionPrices, rangeNow } from "../src/features/roofing/flow/model";

// The quotes withOptionLines reads again for their lines, as the database has them.
const server = vi.hoisted(() => ({ lines: new Map<string, unknown[]>(), reads: [] as Array<{ table: string; ids: string[] }> }));
vi.mock("../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/api")>()),
  supabase: () => ({
    from: (table: string) => ({
      select: () => ({
        in: async (_column: string, ids: string[]) => {
          server.reads.push({ table, ids });
          return { data: ids.map((id) => ({ id, lines: server.lines.get(id) ?? [] })), error: null };
        },
      }),
    }),
  }),
}));

const COMPANY = "0f0f0f0f-0000-4000-8000-000000000000";
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const C = "cccccccc-0000-4000-8000-000000000003";
const WARRANTY = "11111111-0000-4000-8000-000000000001";
const CANCEL = "22222222-0000-4000-8000-000000000002";

let n = 0;
/** A quote line as the database keeps it while `shown` is the option shown. */
function line(name: string, quantity: number, unit_price: number, more: { option_id?: string | null; optional?: boolean; selected?: boolean; taxable?: boolean } = {}, shown = A) {
  const option = more.option_id ?? null;
  const optional = more.optional ?? false;
  return {
    id: `line-${++n}`,
    name,
    description: null,
    quantity,
    unit: "ea",
    unit_price,
    taxable: more.taxable ?? true,
    optional,
    selected: more.selected ?? (option !== null && option !== shown ? false : !optional),
    option_id: option,
    sort: n,
  };
}

function option(id: string, name: string, sort: number, more: Partial<QuoteOptionRow> = {}): QuoteOptionRow {
  return { id, quote_id: "quote", package_id: null, name, tier: null, picture: null, picture_width: null, picture_height: null, style: "shingle", highlights: [], warranty: "", section_ids: [], sort, ...more };
}

// Shared lines, then Good (A, shown, its ridge vent picked), Better (B) and Best (C).
const lines = [
  line("Tear-off", 22, 85),
  line("Permit", 1, 250, { taxable: false }),
  line("Architectural shingles", 24.2, 410, { option_id: A }),
  line("Ridge vent", 48, 9, { option_id: A, optional: true, selected: true }),
  line("Designer shingles", 24.2, 560, { option_id: B }),
  line("Gutter guards", 1, 600, { option_id: B, optional: true }),
  line("Standing-seam metal", 24.2, 980, { option_id: C }),
];
const options = [
  option(C, "Standing-seam metal", 2, { warranty: "Lifetime on the panels." }),
  option(A, "Architectural shingle", 0, { warranty: "30 years on the shingles." }),
  option(B, "Designer shingle", 1, { warranty: "50 years on the shingles.", section_ids: [CANCEL], highlights: ["Thicker shingles"] }),
];
const money = { taxRate: "0.0825", discountAmount: 0, promo: null };
const db = quoteTotals(lines, money);

const quote = {
  number: 1042,
  status: "sent",
  title: "Roof replacement",
  message: null,
  subtotal: db.subtotal,
  discount_amount: 0,
  tax_amount: db.tax,
  total: db.total,
  tax_rate: "0.0825",
  deposit_amount: 1000,
  sent_at: "2026-10-20T15:00:00Z",
  created_at: "2026-10-19T15:00:00Z",
  approved_at: null,
  approval: null,
  option_id: A,
  promo: null,
  section_ids: [],
  client: { display_name: "Dana Reyes", billing_address: null },
  property: { line1: "12 Oak St", city: "Radford", region: "VA", postal_code: "24141" },
} satisfies PaperQuote & {
  section_ids: string[];
  client: { display_name: string; billing_address: unknown };
  property: { line1: string; city: string; region: string; postal_code: string };
};

const template: TemplateSettings = { ...DEFAULT_TEMPLATE, terms: "Pay {Total} when the work is done.", sections: [WARRANTY] };
const library: LibrarySection[] = [
  { id: WARRANTY, title: "Warranty", body: "<p>{Option}: {Warranty}</p>", place: "terms", initials: false },
  { id: CANCEL, title: "Your right to cancel", body: "<p>Cancel within 3 business days.</p>", place: "signatures", initials: true },
];
const business = { name: "Ridgeline Roofing", phone: "540-555-0100", timezone: "America/New_York" };

describe("the totals for the option looked at", () => {
  it("are the quote's own for the option shown, and for a quote without options", () => {
    expect(tabTotals(quote, lines, A)).toEqual({ subtotal: db.subtotal, discount: 0, tax: db.tax, total: db.total });
    expect(tabTotals(quote, lines, null).total).toBe(db.total);
  });

  it("are another option's as they'd be once it's shown, its add-ons not picked", () => {
    const better = tabTotals(quote, lines, B);
    expect(better).toEqual(optionTotals(lines, B, A, money));
    expect(better.subtotal).toBe(22 * 85 + 250 + 13552);
    expect(better.total).not.toBe(db.total);
  });

  it("take the quote's discount, or its promo code, off another option as they'd come off it", () => {
    // Designer shingle (B): $15,672 of lines, $15,422 of them taxed; standing-seam (C): $25,836, $25,586 taxed.
    const off = { ...quote, discount_amount: 500 };
    expect(tabTotals(off, lines, B)).toEqual({ subtotal: 15672, discount: 500, tax: 1231.72, total: 16403.72 });
    expect(tabTotals(off, lines, C)).toEqual({ subtotal: 25836, discount: 500, tax: 2069.99, total: 27405.99 });
    const promo = { ...quote, promo: { kind: "percent", value: 10 } };
    expect(tabTotals(promo, lines, B)).toEqual({ subtotal: 15672, discount: 1567.2, tax: 1145.08, total: 15249.88 });
    expect(tabTotals(promo, lines, C)).toEqual({ subtotal: 25836, discount: 2583.6, tax: 1899.76, total: 25152.16 });
  });

  it("say which option they're for", () => {
    expect(totalsCaption("Better", { shown: true, signed: false })).toBe("For Better, the option shown first");
    expect(totalsCaption("Best", { shown: false, signed: false })).toBe("For Best, if they choose it");
    expect(totalsCaption("Good", { shown: true, signed: true })).toBe("For Good, the option they chose");
    expect(totalsCaption("Best", { shown: false, signed: true })).toBe("For Best, if they had chosen it");
  });
});

describe("the deposit", () => {
  // The architectural shingle before its ridge vent: $12,042 of lines, $11,792 taxed.
  const cheapest = { amount: 13014.84, name: "Architectural shingle" };

  it("can be at most the cheapest option before its add-ons, whichever add-ons they leave off", () => {
    const cap = depositCap(quote, lines, options);
    expect(cap).toEqual(cheapest);
    expect(cap.amount).toBe(optionBaseTotal(lines, A, money));
    // The option shown has its ridge vent picked, which they can still leave off.
    expect(cap.amount).toBeLessThan(db.total);
  });

  it("comes from another option when the one shown is the priciest", () => {
    const metal = lines.map((l) => ({ ...l, selected: l.option_id === null ? l.selected : l.option_id === C && !l.optional }));
    const shown = quoteTotals(metal, money);
    expect(depositCap({ ...quote, option_id: C, subtotal: shown.subtotal, tax_amount: shown.tax, total: shown.total }, metal, options)).toEqual(cheapest);
  });

  it("leaves out an option with no lines of its own yet", () => {
    const empty = [...options, option("dddddddd-0000-4000-8000-000000000004", "Not measured yet", 3)];
    expect(depositCap(quote, lines, empty).name).toBe("Architectural shingle");
  });

  it("is the quote's total without options", () => {
    expect(depositCap({ ...quote, option_id: null, total: 900 }, lines.slice(0, 2), [])).toEqual({ amount: 900, name: null });
  });
});

describe("which option did they choose?", () => {
  it("is asked before an open quote with options is approved or made a job", () => {
    expect(needsChoice("sent", true)).toBe(true);
    expect(needsChoice("draft", true)).toBe(true);
    expect(needsChoice("changes_requested", true)).toBe(true);
    expect(needsChoice("approved", true)).toBe(false);
    expect(needsChoice("sent", false)).toBe(false);
  });

  it("knows a quote offers options from its lines too, while its options are still being read", () => {
    expect(offersOptions(options, lines)).toBe(true);
    expect(offersOptions([], lines)).toBe(true);
    expect(offersOptions(options, lines.slice(0, 2))).toBe(true);
    expect(offersOptions([], lines.slice(0, 2))).toBe(false);
  });

  const unpriced = option("dddddddd-0000-4000-8000-000000000004", "Not measured yet", 3);
  const withUnpriced = [options[1]!, options[2]!, unpriced];

  it("offers every option in order with its tier word and price, and only the priced ones can be chosen", () => {
    const choices = optionChoices(withUnpriced, lines, quote);
    expect(choices.map((c) => [c.option.name, c.tier, c.priced])).toEqual([
      ["Architectural shingle", "Good", true],
      ["Designer shingle", "Better", true],
      // Measured later: no price yet, so it's last.
      ["Not measured yet", "Best", false],
    ]);
    expect(choices[1]!.total).toBe(optionTotals(lines, B, A, money).total);
    expect(optionChoices(options, lines, quote).map((c) => c.tier)).toEqual(["Good", "Better", "Best"]);
  });

  it("starts on the option shown first, or on none so one is picked on purpose", () => {
    const choices = optionChoices(withUnpriced, lines, quote);
    expect(firstChoice(choices, A)).toBe(A);
    expect(firstChoice(choices, B)).toBe(B);
    // Shown first but not priced yet: nothing is picked for them.
    expect(firstChoice(choices, unpriced.id)).toBeNull();
    expect(firstChoice(choices, null)).toBeNull();
    expect(firstChoice([], B)).toBeNull();
  });

  const open = (status: string, option_id: string | null = A, change_order_for: string | null = null) => ({ status, option_id, change_order_for });

  it("shows the option they chose, approves it, then makes the job", () => {
    expect(approveSteps(open("sent"), B, true)).toEqual(["show", "approve", "convert"]);
    expect(approveSteps(open("changes_requested"), B, false)).toEqual(["show", "approve"]);
    // The one shown already: nothing to switch.
    expect(approveSteps(open("draft"), A, true)).toEqual(["approve", "convert"]);
    // A quote without options.
    expect(approveSteps(open("sent", null), null, false)).toEqual(["approve"]);
  });

  it("only makes the job once it's approved, whichever option is picked again", () => {
    expect(approveSteps(open("approved", B), A, true)).toEqual(["convert"]);
    expect(approveSteps(open("approved", B), null, false)).toEqual([]);
  });

  it("adds a change order to its job as it's approved", () => {
    expect(approveSteps(open("sent", null, "job-1"), null, true)).toEqual(["approve"]);
    expect(approveSteps(open("approved", null, "job-1"), null, true)).toEqual([]);
  });

  it("won't approve a quote that's lost, archived or a job already", () => {
    expect(approveSteps(open("lost"), B, false)).toBeNull();
    expect(approveSteps(open("archived"), B, true)).toBeNull();
    expect(approveSteps(open("converted"), A, true)).toBeNull();
  });
});

describe("the approval kept when the office marks it approved", () => {
  const better = options.find((o) => o.id === B)!;
  const total = optionTotals(lines, B, A, money).total;
  const contract = quoteContract(contractFor(quote, template, better, total), business, library);

  it("fills the contract in for the option they chose, with its sections", () => {
    const values = contractValues({ total, optionName: "Designer shingle", warranty: "50 years on the shingles." });
    expect(contract.terms).toBe(`Pay ${values.Total} when the work is done.`);
    expect(contract.sections.map((s) => s.title)).toEqual(["Warranty", "Your right to cancel"]);
    expect(contract.sections[0]!.html).toBe("<p>Designer shingle: 50 years on the shingles.</p>");
  });

  it("keeps the option, the template and the contract, and reads back as a signed one does", () => {
    const approval = JSON.parse(JSON.stringify(officeApproval({ name: "Sam Office", template, option: better, tier: "Better", contract })));
    const read = readApproval(approval)!;
    expect(read.method).toBe("manual");
    expect(read.option).toEqual({ id: B, name: "Designer shingle", tier: "Better", picture: null, style: "shingle", highlights: ["Thicker shingles"], warranty: "50 years on the shingles." });
    expect(read.contract?.sections.map((s) => [s.title, s.initials, s.initialed])).toEqual([
      ["Warranty", false, false],
      ["Your right to cancel", true, false],
    ]);
    expect(read.initials).toBeNull();
    // Nobody initialed it, and the customer's line stays blank to sign by hand.
    expect(signedContract(read)!.sections.every((s) => s.initialed === null)).toBe(true);
    expect(approvalSignatures(approval).customer).toBeNull();
    // The terms print as they were approved, filled in.
    expect(signedTemplate({ status: "approved", template_id: null, approval })!.terms).toBe(contract.terms);
  });

  it("keeps an option's picture only when it's a package picture with its size", () => {
    const path = `${COMPANY}/packages/eeeeeeee-0000-4000-8000-000000000005.jpg`;
    expect(approvalOption({ ...better, picture: path, picture_width: 1600, picture_height: 1200 }, null).picture).toEqual({ path, width: 1600, height: 1200 });
    expect(approvalOption({ ...better, picture: path }, null).picture).toBeNull();
    expect(approvalOption({ ...better, picture: "elsewhere/x.jpg", picture_width: 10, picture_height: 10 }, null).picture).toBeNull();
    // Without a tier word worked out for it, the option's own.
    expect(approvalOption({ ...better, tier: "Premium" }, null).tier).toBe("Premium");
  });

  it("keeps no option on a quote without options", () => {
    const plain = quoteContract(contractFor(quote, template, null, 900), business, library);
    const approval = officeApproval({ name: "Sam Office", template, option: null, tier: null, contract: plain });
    expect(approval.option).toBeNull();
    expect(approval.contract.sections.map((s) => s.title)).toEqual(["Warranty"]);
  });
});

describe("the paper", () => {
  const paper = (q: PaperQuote, viewed: string | null) => paperDocument({ quote: q, lines, options, viewed, date: "2026-10-20", contract: null });

  it("prints the option looked at, with its own totals, and compares the options while they decide", () => {
    const doc = paper(quote, B);
    expect(doc.lines.map((l) => l.name)).toEqual(["Tear-off", "Permit", "Designer shingles"]);
    expect(doc.total).toBe(optionTotals(lines, B, A, money).total);
    expect(doc.subtotal).toBe(22 * 85 + 250 + 13552);
    expect(doc.options?.map((o) => [o.name, o.tier, o.chosen])).toEqual([
      ["Architectural shingle", "Good", false],
      ["Designer shingle", "Better", true],
      ["Standing-seam metal", "Best", false],
    ]);
    // Nothing under the address while they decide: not the package, not the roof's size.
    expect(doc.facts).toEqual([]);
  });

  it("prints the option shown, with the quote's own totals, when it's the one looked at", () => {
    const doc = paper(quote, A);
    expect(doc.lines.map((l) => l.name)).toEqual(["Tear-off", "Permit", "Architectural shingles", "Ridge vent"]);
    expect(doc.total).toBe(db.total);
  });

  it("prints the option it was signed for once it's signed, whichever is looked at", () => {
    const better = options.find((o) => o.id === B)!;
    const chose = lines.map((l) => ({ ...l, selected: l.option_id === null ? !l.optional : l.option_id === B && !l.optional }));
    const totals = quoteTotals(chose, money);
    const contract = quoteContract(contractFor(quote, template, better, totals.total), business, library);
    const approval = JSON.parse(JSON.stringify(officeApproval({ name: "Sam Office", template, option: better, tier: "Better", contract })));
    const signed: PaperQuote = { ...quote, status: "approved", option_id: B, approval, subtotal: totals.subtotal, tax_amount: totals.tax, total: totals.total };
    expect(printedOption(signed, C)).toBe(B);
    const doc = paperDocument({ quote: signed, lines: chose, options, viewed: C, date: "2026-10-20", contract: null });
    expect(doc.lines.map((l) => l.name)).toEqual(["Tear-off", "Permit", "Designer shingles"]);
    expect(doc.total).toBe(totals.total);
    expect(doc.options).toBeUndefined();
    expect(doc.facts).toEqual(["Your choice: Better · Designer shingle"]);
  });

  it("prints a quote without options as it is", () => {
    const plain: PaperQuote = { ...quote, option_id: null };
    const doc = paperDocument({ quote: plain, lines: lines.slice(0, 2), options: [], viewed: null, date: "2026-10-20", contract: null });
    expect(doc.lines.map((l) => l.name)).toEqual(["Tear-off", "Permit"]);
    expect(doc.options).toBeUndefined();
    expect(doc.facts).toEqual([]);
  });
});

describe("sending the range", () => {
  it("runs from the lowest option to the highest, as the server's range does", () => {
    const sent = quoteToSend({ ...quote, lines }, sortOptions(options));
    const bases = [A, B, C].map((id) => optionBaseTotal(lines, id, money)!);
    expect(optionPrices(sent)).toEqual([A, B, C].map((id, i) => ({ id, total: bases[i] })));
    expect(rangeNow(sent, DEFAULT_RANGE)).toEqual(optionsRange(bases, DEFAULT_RANGE));
    // Not the range around the option shown first, as it would be without its options.
    expect(rangeNow({ ...quote, lines }, DEFAULT_RANGE)).toEqual(priceRange(quote.total, DEFAULT_RANGE));
    expect(rangeNow(sent, DEFAULT_RANGE)).not.toEqual(priceRange(quote.total, DEFAULT_RANGE));
  });
});

describe("the sales board and the quote list", () => {
  it("won't mark a quote with options approved from the board", () => {
    expect(moveRefusal({ kind: "quote", options: 3 }, "won")).toBe("Open the quote to pick the option they chose.");
    expect(moveRefusal({ kind: "quote", options: 0 }, "won")).toBeNull();
    expect(moveRefusal({ kind: "quote", options: 2 }, "lost")).toBeNull();
    expect(moveRefusal({ kind: "request", options: 0 }, "draft")).toBeNull();
  });

  it("says how many options a quote offers, whichever is shown first", () => {
    expect(optionsNote("sent", 3, { name: "Designer shingle", tier: "Better" })).toBe("3 options");
    expect(optionsNote("draft", 2, { name: "Architectural shingle", tier: null })).toBe("2 options");
    expect(optionsNote("lost", 3, { name: "Designer shingle", tier: "Better" })).toBe("3 options");
    expect(optionsNote("draft", 1, null)).toBe("1 option");
    expect(optionsNote("sent", 0, null)).toBeNull();
  });

  it("names the option they chose once it's signed", () => {
    expect(optionsNote("approved", 3, { name: "Designer shingle", tier: "Better" })).toBe("Better · Designer shingle");
    expect(optionsNote("converted", 2, { name: "Standing-seam metal", tier: null })).toBe("Standing-seam metal");
  });

  // Good (A) is the cheapest before add-ons: $12,042 of lines, $11,792 taxed.
  const cheapest = optionBaseTotal(lines, A, money)!;
  const offered = { ...quote, options, lines };

  it("price a quote with options from its cheapest option until it's signed, as the roofing and paving lists do", () => {
    expect(listPrice(offered)).toEqual({ amount: cheapest, from: true });
    expect(cheapest).toBe(13014.84);
    expect(listPrice(offered).amount).toBe(lowestOption(offered));
    // Not the option shown first, with its ridge vent picked, nor whichever one the office shows.
    expect(listPrice(offered).amount).not.toBe(quote.total);
    const metalFirst = { ...offered, option_id: C };
    expect(listPrice(metalFirst)).toEqual({ amount: cheapest, from: true });
    expect(listPrice({ ...offered, status: "draft" }).from).toBe(true);
    expect(listPrice({ ...offered, status: "lost" })).toEqual({ amount: cheapest, from: true });
  });

  it("price it at its total once it's signed, which is the option they chose", () => {
    expect(listPrice({ ...offered, status: "approved", total: 18456.12 })).toEqual({ amount: 18456.12, from: false });
    expect(listPrice({ ...offered, status: "converted" })).toEqual({ amount: quote.total, from: false });
  });

  it("price a quote without options, or whose options have no price yet, at its total", () => {
    expect(listPrice({ ...quote, options: [], lines: lines.slice(0, 2) })).toEqual({ amount: quote.total, from: false });
    expect(listPrice({ ...quote, options, lines: lines.slice(0, 2) })).toEqual({ amount: quote.total, from: false });
    // Its lines weren't read (withOptionLines reads them only for quotes priced from an option).
    expect(listPrice({ ...quote, options: [], lines: [] })).toEqual({ amount: quote.total, from: false });
  });

  describe("reading the lines to price them", () => {
    const listed = (id: string, status: string, count: number) => ({ id, status, total: 100, tax_rate: "0.0825", discount_amount: 0, promo: null, options: options.slice(0, count) });

    beforeEach(() => {
      server.reads.length = 0;
      server.lines.clear();
    });

    it("reads them only for the quotes with options that aren't signed, and keeps the list in order", async () => {
      for (const id of ["open", "lost"]) server.lines.set(id, lines);
      const read = await withOptionLines([listed("plain", "sent", 0), listed("open", "sent", 3), listed("signed", "approved", 3), listed("lost", "lost", 2)]);
      expect(server.reads).toEqual([{ table: "quotes", ids: ["open", "lost"] }]);
      expect(read.map((q) => [q.id, q.lines.length])).toEqual([["plain", 0], ["open", lines.length], ["signed", 0], ["lost", lines.length]]);
      expect(read.map((q) => listPrice(q))).toEqual([
        { amount: 100, from: false },
        { amount: cheapest, from: true },
        { amount: 100, from: false },
        // Two of the options offered: Standing-seam metal (C) and Good (A).
        { amount: cheapest, from: true },
      ]);
    });

    it("reads nothing for a list without options", async () => {
      const read = await withOptionLines([listed("plain", "sent", 0), listed("signed", "converted", 2)]);
      expect(server.reads).toEqual([]);
      expect(read.every((q) => q.lines.length === 0)).toBe(true);
    });

    it("reads a long list 200 quotes at a time", async () => {
      const many = Array.from({ length: 450 }, (_, i) => listed(`q${i}`, "sent", 2));
      await withOptionLines(many);
      expect(server.reads.map((r) => r.ids.length)).toEqual([200, 200, 50]);
      expect(server.reads.flatMap((r) => r.ids)).toEqual(many.map((q) => q.id));
    });
  });
});

describe("the options bar", () => {
  it("marks the option shown as the one the customer sees first, in the office", () => {
    expect(shownWords("office", false)).toEqual({ chip: "Shown first", note: "The customer sees this one first." });
  });

  it("doesn't call the option shown their choice on the iPad, since the office may have set it", () => {
    const visit = shownWords("visit", false);
    expect(visit.chip).toBe("Pricing this one");
    expect(visit.chip).not.toMatch(/picked|chose|choice/i);
    expect(visit.note).toBe("The price you set and the signing are for this one. If they want another, tap it, then “They chose this one”.");
  });

  it("marks the option they chose once it's signed, wherever it's shown", () => {
    expect(shownWords("visit", true)).toEqual({ chip: "Chosen", note: "Signed estimates keep their option." });
    expect(shownWords("office", true).chip).toBe("Chosen");
  });

  it("shows an option's picture, or a roof style's drawing, but not the plain pattern of an option with neither", () => {
    expect(hasOptionArt({ picture: "acme/packages/a.jpg", style: "other" })).toBe(true);
    expect(hasOptionArt({ picture: null, style: "shingle" })).toBe(true);
    expect(hasOptionArt({ picture: null, style: "other" })).toBe(false);
  });
});

describe("the quote list as an inbox", () => {
  const row = (id: string, status: string) => ({ id, status });

  it("puts what needs doing first: changes asked for, then quotes ready to become jobs, then the rest", () => {
    const groups = groupQuotes([row("a", "draft"), row("b", "sent"), row("c", "approved"), row("d", "changes_requested"), row("e", "sent")]);
    expect(groups.map((g) => g.key)).toEqual(["changes_requested", "approved", "sent", "draft"]);
    expect(groups.map((g) => g.tone)).toEqual(["warning", "good", undefined, undefined]);
    expect(groups[0]!.label).toBe("Changes requested");
    expect(groups[1]!.label).toBe("Approved: ready to become jobs");
    // The list's own order stays within a group.
    expect(groups[2]!.rows.map((r) => r.id)).toEqual(["b", "e"]);
  });

  it("groups closed quotes by how they ended, and leaves out empty groups", () => {
    expect(groupQuotes([row("a", "lost"), row("b", "converted"), row("c", "archived")]).map((g) => g.key)).toEqual(["converted", "lost", "archived"]);
    expect(groupQuotes([])).toEqual([]);
  });

  it("says a quote out or still a draft has expired once its day has gone by, not before", () => {
    expect(isExpired({ status: "sent", valid_until: "2026-11-20" }, "2026-11-21")).toBe(true);
    expect(isExpired({ status: "draft", valid_until: "2026-11-20" }, "2026-11-21")).toBe(true);
    expect(isExpired({ status: "sent", valid_until: "2026-11-21" }, "2026-11-21")).toBe(false);
    expect(isExpired({ status: "approved", valid_until: "2026-11-01" }, "2026-11-21")).toBe(false);
    expect(isExpired({ status: "sent", valid_until: null }, "2026-11-21")).toBe(false);
  });

  it("gives a day without its year in the year it is, and a plain date as that day anywhere", () => {
    const now = new Date("2026-11-21T15:00:00Z");
    expect(shortDate("2026-11-19T03:00:00Z", "America/New_York", now)).toBe("Nov 18");
    expect(shortDate("2026-11-19", "Pacific/Honolulu", now)).toBe("Nov 19");
    expect(shortDate("2025-12-02", "America/New_York", now)).toBe("Dec 2, 2025");
  });
});

describe("a quote's history", () => {
  it("has an icon for what happened", () => {
    expect(historyIcon("quote.sent")).toBe("send");
    expect(historyIcon("quote.approved")).toBe("check");
    expect(historyIcon("quote.range_accepted")).toBe("check");
    expect(historyIcon("quote.changes_requested")).toBe("messages");
    expect(historyIcon("quote.converted")).toBe("job");
    expect(historyIcon("quote.lost")).toBe("x");
    expect(historyIcon("quote.something_new")).toBe("history");
  });
});

describe("the line items on a touch screen", () => {
  const css = readFileSync(join(__dirname, "../src/styles/features.css"), "utf8");
  const block = css.slice(css.indexOf("/* ---------- Line item editor"), css.indexOf("/* ---------- Schedule"));

  it("gives each line's menu a 44px target, its column as wide so the rows keep to the heads", () => {
    const touch = block.slice(block.indexOf("@media (max-width: 900px)"));
    expect(touch).toMatch(/\.btn\.line-more \{ width: 44px; height: 44px; \}/);
    expect(touch).toMatch(/\.lines-head, \.line-edit \{ grid-template-columns: minmax\(0, 1fr\) 72px 72px 96px 104px 44px; \}/);
    expect(touch).toMatch(/\.line-view \{ grid-template-columns: minmax\(0, 1fr\) 44px; \}/);
    expect(block).not.toMatch(/line-more \{ width: 40px/);
  });
});

describe("the quotes list and the contract section, as the boards draw them", () => {
  const src = (path: string) => readFileSync(join(__dirname, "../src/features", path), "utf8");

  it("ends a row's menu with archiving in red after a separator, the Menus board's row menu", () => {
    const list = src("quotes/QuotesPage.tsx");
    const items = list.slice(list.indexOf('{ label: "Open quote"'), list.indexOf("]}", list.indexOf('{ label: "Open quote"')));
    expect(items.indexOf('"Open quote"')).toBeLessThan(items.indexOf('"Copy link"'));
    expect(items).toMatch(/\{ separator: true \},\s*\{ label: "Archive", icon: "archive", kbd: "E", danger: true,/);
    expect(items.match(/danger: true/g)).toHaveLength(1);
  });

  it("lets the Contract heading be an h3 inside a roofing step, and an h2 on the quote page", () => {
    const sections = src("quotes/QuoteSections.tsx");
    expect(sections).toContain("level = 2 }: QuoteSectionsProps");
    expect(sections.match(/<Section title="Contract" level=\{level\}/g)).toHaveLength(3);
    expect(src("roofing/flow/EstimateStep.tsx")).toMatch(/<QuoteSections [^>]*level=\{3\} \/>/);
    expect(src("quotes/QuotePage.tsx")).toMatch(/<QuoteSections quote=\{q\}(?![^>]*level=)[^>]*\/>/);
  });
});
