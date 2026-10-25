import { optionBaseTotal, quoteTotals } from "@crewtavo/core/money";
import { optionsRange, priceRange } from "@crewtavo/core/estimates";
import { describe, expect, it } from "vitest";
import { readApproval } from "../src/features/documents/build";
import { currentStep, STEPS, type TakeoffRow } from "../src/features/paving/data";
import { ROOF_STEPS, roofStep, type RoofStepQuote } from "../src/features/roofing/data";
import {
  autoFillKey,
  canMarkAgreed,
  copySentence,
  dayText,
  depositLabel,
  emptyOptions,
  emptyOptionsText,
  estimateShare,
  estimateSubject,
  hasFilledLines,
  homeownerName,
  isSignedCopy,
  jobLinesText,
  lowestOption,
  notesTitle,
  onWhen,
  isPriced,
  leaningChoices,
  optionPrices,
  optionsIntro,
  optionTicks,
  personName,
  rangeAcrossOptions,
  rangeIntro,
  rangeNow,
  rangeOutdated,
  rangePill,
  rangeState,
  rangeStepStatus,
  rangeWordsFor,
  salesPeople,
  sendWords,
  signedHeadline,
  signedSentence,
  visitStepStatus,
  type RangeQuote,
  type TeamMember,
  type VisitQuote,
} from "../src/features/roofing/flow/model";

const TZ = "America/New_York";
// Friday Oct 24 2026, 3 PM in New York.
const NOW = new Date("2026-10-24T19:00:00Z");

const takeoff = { id: "m1" };
const roofQuote = (patch: Partial<RoofStepQuote> = {}): RoofStepQuote => ({ status: "draft", lines: [{}], jobs: [], range_low: null, range_accepted_at: null, priced_on_site_at: null, ...patch });
const range = (patch: Partial<RangeQuote & { lines: unknown[] }> = {}): RangeQuote & { lines: unknown[] } => ({
  status: "draft",
  total: 18304,
  range_low: null,
  range_high: null,
  range_sent_at: null,
  range_accepted_at: null,
  priced_on_site_at: null,
  lines: [{}],
  ...patch,
});
const out = { status: "sent", range_low: 18300, range_high: 21050, range_sent_at: "2026-10-22T13:20:00Z" };

describe("the roofing project's steps", () => {
  it("has six steps of its own, and paving keeps its five", () => {
    expect(ROOF_STEPS.map((s) => s.id)).toEqual(["takeoff", "estimate", "range", "visit", "schedule", "invoice"]);
    expect(ROOF_STEPS.map((s) => s.label)).toEqual(["Measure", "Estimate", "Range", "Site visit", "Schedule", "Invoice"]);
    expect(STEPS.map((s) => s.id)).toEqual(["takeoff", "estimate", "proposal", "schedule", "invoice"]);
  });

  it("measures, then prices, then sends the range", () => {
    expect(roofStep(null, null)).toBe("takeoff");
    expect(roofStep(roofQuote(), null)).toBe("takeoff");
    expect(roofStep(roofQuote({ lines: [] }), takeoff)).toBe("estimate");
    expect(roofStep(roofQuote(), takeoff)).toBe("range");
    // A range saved on a draft whose email didn't go out still has to be sent.
    expect(roofStep(roofQuote({ range_low: 18300 }), takeoff)).toBe("range");
  });

  it("waits on the range until the homeowner says yes, then it's the site visit", () => {
    expect(roofStep(roofQuote({ status: "sent", range_low: 18300 }), takeoff)).toBe("range");
    expect(roofStep(roofQuote({ status: "changes_requested", range_low: 18300 }), takeoff)).toBe("range");
    expect(roofStep(roofQuote({ status: "sent", range_low: 18300, range_accepted_at: "2026-10-23T23:41:00Z" }), takeoff)).toBe("visit");
  });

  it("goes to the site visit when the exact price went out instead, or it was priced on site", () => {
    expect(roofStep(roofQuote({ status: "sent" }), takeoff)).toBe("visit");
    expect(roofStep(roofQuote({ status: "sent", range_low: 18300, priced_on_site_at: "2026-10-24T18:00:00Z" }), takeoff)).toBe("visit");
    // Priced on site before anything was sent.
    expect(roofStep(roofQuote({ priced_on_site_at: "2026-10-24T18:00:00Z" }), takeoff)).toBe("visit");
    // The office sent the exact price while the range was out.
    expect(roofStep(roofQuote({ status: "sent", range_low: 18300, exact_sent_at: "2026-10-23T14:00:00Z" }), takeoff)).toBe("visit");
  });

  it("schedules once signed, then invoices, then it's done", () => {
    expect(roofStep(roofQuote({ status: "approved" }), takeoff)).toBe("schedule");
    expect(roofStep(roofQuote({ status: "converted", jobs: [] }), takeoff)).toBe("schedule");
    expect(roofStep(roofQuote({ status: "converted", jobs: [{ status: "active" }] }), takeoff)).toBe("invoice");
    expect(roofStep(roofQuote({ status: "converted", jobs: [{ status: "active" }] }), takeoff, [{ status: "sent" }])).toBe("invoice");
    expect(roofStep(roofQuote({ status: "converted", jobs: [{ status: "completed" }] }), takeoff, [{ status: "paid" }, { status: "void" }])).toBe("done");
  });

  it("leaves paving's steps as they were", () => {
    const m = {} as TakeoffRow;
    expect(currentStep({ status: "draft", lines: [{}], jobs: [] }, m)).toBe("proposal");
    expect(currentStep({ status: "approved", lines: [{}], jobs: [] }, m)).toBe("schedule");
    expect(currentStep({ status: "converted", lines: [{}], jobs: [{ id: "j", status: "completed" }] }, m, [{ status: "paid" }])).toBe("done");
  });
});

describe("where the range stands", () => {
  it("knows each state", () => {
    expect(rangeState(range())).toBe("unsent");
    expect(rangeState(range({ range_low: 18300, range_high: 21050 }))).toBe("unsent");
    expect(rangeState(range(out))).toBe("waiting");
    expect(rangeState(range({ ...out, range_accepted_at: "2026-10-23T23:41:00Z" }))).toBe("accepted");
    expect(rangeState(range({ status: "sent" }))).toBe("exact");
    expect(rangeState(range({ ...out, priced_on_site_at: "2026-10-24T18:00:00Z" }))).toBe("exact");
    expect(rangeState(range({ ...out, exact_sent_at: "2026-10-23T14:00:00Z" }))).toBe("exact");
    expect(rangeState(range({ ...out, status: "approved" }))).toBe("signed");
    expect(rangeState(range({ status: "converted" }))).toBe("signed");
    expect(rangeState(range({ status: "lost" }))).toBe("closed");
  });

  it("lets the office mark a yes while the range waits for an answer, or before it went out", () => {
    expect(canMarkAgreed(range(out))).toBe(true);
    // They asked a question first, then said yes on the phone.
    expect(canMarkAgreed(range({ ...out, status: "changes_requested" }))).toBe(true);
    // The office told them the range on the phone before sending it, or its email didn't go.
    expect(canMarkAgreed(range())).toBe(true);
    expect(canMarkAgreed(range({ range_low: 18300, range_high: 21050 }))).toBe(true);
    expect(canMarkAgreed(range({ ...out, range_accepted_at: "2026-10-23T23:41:00Z" }))).toBe(false);
    expect(canMarkAgreed(range({ ...out, exact_sent_at: "2026-10-23T14:00:00Z" }))).toBe(false);
    expect(canMarkAgreed(range({ ...out, priced_on_site_at: "2026-10-24T18:00:00Z" }))).toBe(false);
    expect(canMarkAgreed(range({ ...out, status: "approved" }))).toBe(false);
    expect(canMarkAgreed(range({ ...out, status: "lost" }))).toBe(false);
    expect(canMarkAgreed(range({ status: "sent" }))).toBe(false);
  });

  it("needs a price to make a range from, an option's or the estimate's", () => {
    const line = (option_id: string | null, unit_price: number) => ({ option_id, quantity: 1, unit_price, taxable: true, optional: false, selected: true });
    const two = [{ id: "good" }, { id: "best" }];
    expect(isPriced({ total: 0, lines: [] })).toBe(false);
    expect(isPriced({ total: 16800, lines: [line(null, 16800)] })).toBe(true);
    // Offered before the roof was measured: no option has lines of its own yet.
    expect(isPriced({ total: 250, options: two, lines: [line(null, 250)] })).toBe(false);
    expect(isPriced({ total: 0, options: two, lines: [line("best", 34000)] })).toBe(true);
  });

  it("offers each option they could be leaning toward, with its tier and its own range", () => {
    const settings = { pct: 15, round: 50 };
    const options = [
      { id: "good", name: "Architectural shingle", tier: "Good" },
      { id: "best", name: "Standing-seam metal", tier: "Best" },
      { id: "cedar", name: "Cedar shakes", tier: "Premium" },
    ];
    const lines = [
      { option_id: null, quantity: 1, unit_price: 250, taxable: true, optional: false, selected: true },
      { option_id: "good", quantity: 1, unit_price: 16997.06, taxable: true, optional: false, selected: true },
      { option_id: "best", quantity: 1, unit_price: 34911.81, taxable: true, optional: false, selected: false },
    ];
    const choices = leaningChoices({ total: 17247.06, options, lines }, settings);
    expect(choices.map((c) => [c.option.id, c.tier, c.range])).toEqual([
      // The permit is on every option, so it's in each one's range: $17,247.06 and $35,161.81.
      ["good", "Good", { low: 17200, high: 19850 }],
      ["best", "Best", { low: 35150, high: 40450 }],
      // No lines of its own yet: no range.
      ["cedar", "Premium", null],
    ]);
  });

  it("notices the estimate changed since the range went out", () => {
    const settings = { pct: 15, round: 50 };
    // Without options the lines don't matter, only the total.
    const sent = (patch: Partial<RangeQuote> = {}) => ({ ...range(patch), lines: [] });
    expect(rangeOutdated(sent(out), settings)).toBe(false);
    expect(rangeOutdated(sent({ ...out, total: 18950 }), settings)).toBe(true);
    expect(rangeOutdated(sent(), settings)).toBe(false);
  });

  it("says where the step is", () => {
    expect(rangeStepStatus(range({ lines: [] }), "Dana Whitfield", TZ, NOW)).toBe("After the estimate");
    expect(rangeStepStatus(range(), "Dana Whitfield", TZ, NOW)).toBe("Not sent yet");
    expect(rangeStepStatus(range(out), "Dana Whitfield", TZ, NOW)).toBe("Sent Oct 22, waiting on Dana");
    expect(rangeStepStatus(range({ ...out, range_accepted_at: "2026-10-23T23:41:00Z" }), "Dana Whitfield", TZ, NOW)).toBe("Dana said yes Oct 23");
    expect(rangeStepStatus(range({ status: "sent" }), "Dana Whitfield", TZ, NOW)).toBe("Skipped: the exact price went out");
    expect(rangeStepStatus(range({ status: "approved" }), null, TZ, NOW)).toBe("Skipped");
    expect(rangeStepStatus(range({ ...out, status: "approved" }), null, TZ, NOW)).toBe("Sent Oct 22");
    expect(rangeStepStatus(range(out), null, TZ, NOW)).toBe("Sent Oct 22, waiting on the homeowner");
    expect(rangeStepStatus(range({ ...out, exact_sent_at: "2026-10-23T14:00:00Z" }), "Dana Whitfield", TZ, NOW)).toBe("The exact price went out Oct 23");
  });

  it("puts the year on dates from another year", () => {
    expect(dayText("2025-12-30T15:00:00Z", TZ, NOW)).toBe("Dec 30, 2025");
    expect(dayText("2026-10-24T02:00:00Z", TZ, NOW)).toBe("Oct 23");
  });

  it("splits the bar into the estimate and the room on top", () => {
    expect(estimateShare(18304, 21050)).toBeCloseTo(0.8695, 3);
    expect(estimateShare(100, 0)).toBe(1);
    expect(estimateShare(30000, 21050)).toBe(1);
  });

  it("says where a signed price sits on the range", () => {
    const r = { low: 18300, high: 21050 };
    expect(rangePill(19524, r)).toEqual({ label: "Inside the range", tone: "good" });
    expect(rangePill(21050, r).label).toBe("Inside the range");
    expect(rangePill(21050.01, r)).toEqual({ label: "Above the range", tone: "warning" });
    expect(rangePill(18000, r)).toEqual({ label: "Below the range", tone: "info" });
  });

  it("sends the range with the server's own words", () => {
    expect(rangeIntro({ low: 18300, high: 21050 })).toBe(
      "Thanks for having us look at your roof. From our measurements, your new roof will cost between $18,300 and $21,050. You can see what's included and let us know when you'd like us to come out:",
    );
    expect(estimateSubject("Ridgeline Roofing")).toBe("Your roof estimate from Ridgeline Roofing");
    // In the business's own currency, as the server words it.
    expect(rangeIntro({ low: 18300, high: 21050 }, 0, "CAD")).toContain("between CA$18,300 and CA$21,050.");
  });
});

describe("the range with options", () => {
  // Good is shown, so its roof is selected; Better's and Best's are kept unselected. Best has an add-on.
  const line = (option_id: string | null, unit_price: number, patch: { optional?: boolean; selected?: boolean } = {}) => ({ option_id, quantity: 1, unit_price, taxable: true, optional: false, selected: option_id === null || option_id === "good", ...patch });
  const lines = [line(null, 1900), line("good", 13552), line("better", 16698), line("best", 27830), line("best", 900, { optional: true, selected: false }), line("better", 0, { selected: false })];
  const options = [{ id: "good", name: "Architectural shingle", tier: null }, { id: "better", name: "Designer shingle", tier: null }, { id: "best", name: "Standing-seam metal", tier: null }];
  const opts = { taxRate: 0.06, discountAmount: 0, promo: null };
  const shown = quoteTotals(lines, opts).total;
  const quote = { total: shown, tax_rate: 0.06, discount_amount: 0, promo: null, options, lines };
  const settings = { pct: 15, round: 50 };

  it("runs from the cheapest option's low end to the priciest one's high end, as the server sends it", () => {
    const bases = options.map((o) => optionBaseTotal(lines, o.id, opts)!);
    expect(optionPrices(quote).map((p) => p.total)).toEqual(bases);
    expect(rangeNow(quote, settings)).toEqual(optionsRange(bases, settings));
    expect(rangeNow(quote, settings).low).toBe(priceRange(bases[0], settings).low);
    expect(rangeNow(quote, settings).high).toBe(priceRange(bases[2], settings).high);
    // Without options, it's around the total.
    expect(rangeNow({ total: shown }, settings)).toEqual(priceRange(shown, settings));
  });

  it("doesn't move when another option is shown, so a range sent stays up to date", () => {
    const sent = rangeNow(quote, settings);
    const out = { status: "sent", range_low: sent.low, range_high: sent.high, range_sent_at: "2026-10-22T13:20:00Z", range_accepted_at: null, priced_on_site_at: null };
    expect(rangeOutdated({ ...quote, ...out }, settings)).toBe(false);
    // Best shown instead (the database flips which option's lines are selected): the same range.
    const bestShown = lines.map((l) => (l.option_id === null ? l : { ...l, selected: l.option_id === "best" && !l.optional }));
    expect(rangeOutdated({ ...quote, ...out, lines: bestShown, total: quoteTotals(bestShown, opts).total }, settings)).toBe(false);
    // A line changed on an option: the range moves.
    expect(rangeOutdated({ ...quote, ...out, lines: lines.map((l, i) => (i === 3 ? { ...l, unit_price: 31000 } : l)) }, settings)).toBe(true);
  });

  it("leaves out an option with no lines yet", () => {
    const waiting = { ...quote, options: [...options, { id: "fourth", name: "Cedar shake", tier: null }] };
    expect(optionPrices(waiting).map((p) => p.id)).toEqual(["good", "better", "best"]);
    expect(rangeNow(waiting, settings)).toEqual(rangeNow(quote, settings));
  });

  it("says the range runs across the options, in the server's words", () => {
    expect(rangeIntro({ low: 18300, high: 34050 }, 3)).toBe(
      "Thanks for having us look at your roof. From our measurements, your new roof will cost between $18,300 and $34,050, depending on the option you pick. You can see the options and let us know when you'd like us to come out:",
    );
    // One option with a price is a range like any other.
    expect(rangeIntro({ low: 18300, high: 21050 }, 1)).toBe(rangeIntro({ low: 18300, high: 21050 }));
  });

  it("sends the exact price with how many options there are and the lowest", () => {
    expect(optionsIntro(optionPrices(quote))).toBe(
      `Thanks for the opportunity. Here's your quote, with 3 options from ${new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(optionPrices(quote)[0]!.total)}. You can compare them, choose the one you want and approve it online:`,
    );
    expect(optionsIntro([{ total: 100 }])).toBe("");
    expect(optionsIntro([])).toBe("");
  });

  it("prices each option with the office's discount or a promo code, as the server does", () => {
    // $500 off: Good is the shared $1,900 and its $13,552 roof, less $500, with 6% tax on the rest.
    const discounted = { ...quote, discount_amount: 500 };
    const withDiscount = { taxRate: 0.06, discountAmount: 500, promo: null };
    expect(optionPrices(discounted)[0]).toEqual({ id: "good", total: 15849.12 });
    expect(optionPrices(discounted).map((p) => p.total)).toEqual(options.map((o) => optionBaseTotal(lines, o.id, withDiscount)));
    expect(rangeNow(discounted, settings)).toEqual(optionsRange(optionPrices(discounted).map((p) => p.total), settings));
    expect(rangeNow(discounted, settings).low).toBeLessThan(rangeNow(quote, settings).low);
    // A 10% promo code is worked out on each option's own charges: $1,545.20 off Good's $15,452.
    const promoted = { ...quote, promo: { kind: "percent", value: 10 } };
    expect(optionPrices(promoted)[0]).toEqual({ id: "good", total: 14741.21 });
    expect(optionPrices(promoted).map((p) => p.total)).toEqual(options.map((o) => optionBaseTotal(lines, o.id, { taxRate: 0.06, discountAmount: 0, promo: promoted.promo })));
    expect(rangeNow(promoted, settings)).toEqual(optionsRange(optionPrices(promoted).map((p) => p.total), settings));
    // The ticks sit at those prices too.
    expect(optionTicks(promoted, rangeNow(promoted, settings).high).map((t) => t.total)).toEqual(optionPrices(promoted).map((p) => p.total));
    expect(lowestOption(promoted)).toBe(14741.21);
  });

  it("starts a list's price from the cheapest option", () => {
    expect(lowestOption(quote)).toBe(Math.min(...optionPrices(quote).map((p) => p.total)));
    expect(lowestOption({ total: 100 })).toBeNull();
    expect(lowestOption({ ...quote, options: [{ id: "fourth" }] })).toBeNull();
  });

  it("words what's sent only once the options are known, never as one estimate", () => {
    // From the quote page the options load first: until then there's nothing to word.
    const { options: _options, ...noOptions } = quote;
    expect(sendWords(noOptions, "range", settings)).toBeNull();
    expect(sendWords(noOptions, "exact", settings)).toBeNull();
    const ranged = sendWords(quote, "range", settings)!;
    expect(ranged.range).toEqual(optionsRange(options.map((o) => optionBaseTotal(lines, o.id, opts)!), settings));
    expect(ranged.range).not.toEqual(priceRange(shown, settings));
    expect(ranged.message).toBe(rangeIntro(ranged.range, 3));
    expect(ranged.message).toContain("depending on the option you pick");
    expect(sendWords(quote, "exact", settings)!.message).toBe(optionsIntro(optionPrices(quote)));
    // An estimate without options is worded as one.
    const single = sendWords({ ...noOptions, options: [] }, "range", settings)!;
    expect(single.range).toEqual(priceRange(shown, settings));
    expect(single.message).toBe(rangeIntro(priceRange(shown, settings)));
    expect(sendWords({ ...noOptions, options: [] }, "exact", settings)!.message).toBe("");
  });

  it("puts a tick on the range card at each option's price, cheapest first, with its tier word", () => {
    const high = rangeNow(quote, settings).high;
    const ticks = optionTicks(quote, high);
    expect(ticks.map((t) => t.label)).toEqual(["Good", "Better", "Best"]);
    expect(ticks.map((t) => t.total)).toEqual(optionPrices(quote).map((p) => p.total));
    expect(ticks.every((t) => t.at > 0 && t.at < 1)).toBe(true);
    expect(ticks[0]!.at).toBeLessThan(ticks[2]!.at);
    // An option's own tier word, and its name when another has one of its own.
    expect(optionTicks({ ...quote, options: options.map((o) => (o.id === "best" ? { ...o, tier: "Premium" } : o)) }, high).map((t) => t.label)).toEqual(["Architectural shingle", "Designer shingle", "Premium"]);
  });

  it("says a range sent across the options runs from the lowest option to the highest", () => {
    const sent = { low: 18300, high: 34050 };
    expect(rangeAcrossOptions(quote)).toBe(true);
    expect(rangeWordsFor(sent, quote)).toBe("$18,300 to $34,050, from the lowest option to the highest");
    // One estimate's range is just the range.
    expect(rangeAcrossOptions({ total: shown })).toBe(false);
    expect(rangeWordsFor(sent, { total: shown, options: [] })).toBe("$18,300 to $34,050");
    // Only one option with a price yet: the range is that option's, so it doesn't say "options".
    const onePriced = { ...quote, lines: lines.filter((l) => l.option_id === null || l.option_id === "good") };
    expect(rangeAcrossOptions(onePriced)).toBe(false);
    expect(rangeWordsFor(sent, onePriced)).toBe("$18,300 to $34,050");
  });
});

describe("the site visit step", () => {
  const visit = (patch: Partial<VisitQuote> = {}): VisitQuote => ({ ...range(out), approved_at: null, approval: null, sent_at: "2026-10-22T13:20:00Z", ...patch });

  it("says where it stands before signing", () => {
    expect(visitStepStatus(visit({ lines: [] }), "Dana Whitfield", TZ, NOW)).toBe("After the estimate");
    expect(visitStepStatus(visit({ status: "draft", range_low: null, range_high: null }), "Dana Whitfield", TZ, NOW)).toBe("After the range");
    expect(visitStepStatus(visit(), "Dana Whitfield", TZ, NOW)).toBe("After Dana says yes");
    expect(visitStepStatus(visit({ range_accepted_at: "2026-10-23T23:41:00Z" }), "Dana Whitfield", TZ, NOW)).toBe("Ready to book");
    expect(visitStepStatus(visit({ range_low: null, range_high: null }), "Dana Whitfield", TZ, NOW)).toBe("Sent Oct 22, waiting on Dana");
    expect(visitStepStatus(visit({ priced_on_site_at: "2026-10-24T18:00:00Z" }), "Dana Whitfield", TZ, NOW)).toBe("Priced on site Oct 24");
    // Sent from the office instead of the range: nobody priced it on site.
    expect(visitStepStatus(visit({ exact_sent_at: "2026-10-23T14:00:00Z" }), "Dana Whitfield", TZ, NOW)).toBe("Sent Oct 23, waiting on Dana");
    expect(visitStepStatus(visit({ range_accepted_at: "2026-10-23T12:00:00Z", exact_sent_at: "2026-10-23T14:00:00Z" }), "Dana Whitfield", TZ, NOW)).toBe("Sent Oct 23, waiting on Dana");
    expect(visitStepStatus(visit({ status: "lost" }), "Dana Whitfield", TZ, NOW)).toBe("Lost");
  });

  it("says who signed once it's signed", () => {
    const approval = readApproval({ name: "Dana Whitfield", signature: "data:image/png;base64,AAAA", signed_at: "2026-10-24T18:14:00Z", method: "in_person" });
    expect(visitStepStatus(visit({ status: "approved", approved_at: "2026-10-24T18:14:00Z", approval }), "Dana Whitfield", TZ, NOW)).toBe("Signed Oct 24 by Dana Whitfield");
    const manual = readApproval({ name: "Sarah Lopez", method: "manual" });
    expect(visitStepStatus(visit({ status: "approved", approved_at: "2026-10-24T18:14:00Z", approval: manual }), "Dana Whitfield", TZ, NOW)).toBe("Marked approved Oct 24");
  });
});

describe("signed", () => {
  const company = { name: "Mike Torres", user_id: "u1", signature: "data:image/png;base64,BBBB", signed_at: "2026-10-24T18:14:00Z" };

  it("says how it was signed, and for how much", () => {
    expect(signedHeadline(readApproval({ name: "Dana", method: "in_person" }), 19524)).toBe("Signed on site for $19,524");
    expect(signedHeadline(readApproval({ name: "Dana", signature: "data:image/png;base64,AAAA" }), 19524.5)).toBe("Signed online for $19,524.50");
    expect(signedHeadline(readApproval({ name: "Sarah", method: "manual" }), 19524)).toBe("Marked approved for $19,524");
  });

  it("says who signed and when", () => {
    const onSite = readApproval({ name: "Dana Whitfield", signature: "data:image/png;base64,AAAA", signed_at: "2026-10-23T18:14:00Z", method: "in_person", company });
    expect(signedSentence(onSite, null, "Ridgeline Roofing", TZ, NOW)).toBe("Dana Whitfield and Mike Torres signed yesterday at 2:14 PM.");
    const earlier = readApproval({ name: "Dana Whitfield", signature: "data:image/png;base64,AAAA", signed_at: "2026-10-20T18:14:00Z", method: "in_person" });
    expect(signedSentence(earlier, null, "Ridgeline Roofing", TZ, NOW)).toBe("Dana Whitfield signed on Oct 20 at 2:14 PM.");
    const online = readApproval({ name: "Dana Whitfield", signature: "data:image/png;base64,AAAA", signed_at: "2026-10-24T13:12:00Z", company });
    expect(signedSentence(online, null, "Ridgeline Roofing", TZ, NOW)).toBe("Dana Whitfield signed online today at 9:12 AM. Mike Torres signed for Ridgeline Roofing.");
    const manual = readApproval({ name: "Sarah Lopez", method: "manual" });
    expect(signedSentence(manual, "2026-10-24T13:12:00Z", "Ridgeline Roofing", TZ, NOW)).toBe("Sarah Lopez marked it approved today at 9:12 AM, without a signature.");
    expect(onWhen("2026-10-20T18:14:00Z", TZ, NOW)).toBe("on Oct 20 at 2:14 PM");
  });

  it("finds the signed copies that went out", () => {
    expect(isSignedCopy({ channel: "email", subject: "Your signed estimate from Ridgeline Roofing" })).toBe(true);
    expect(isSignedCopy({ channel: "sms", subject: "Signed estimate #1042" })).toBe(true);
    expect(isSignedCopy({ channel: "email", subject: "Your roof estimate from Ridgeline Roofing" })).toBe(false);
    expect(copySentence([{ channel: "email" }], "Dana Whitfield")).toBe("A copy was emailed to Dana.");
    expect(copySentence([{ channel: "sms" }], "Dana Whitfield")).toBe("A link to it was texted to Dana.");
    expect(copySentence([{ channel: "email" }, { channel: "sms" }], null)).toBe("A copy was emailed and texted to the homeowner.");
    expect(copySentence([], "Dana")).toBeNull();
  });
});

describe("the job", () => {
  it("names the deposit and its share when it's a round one", () => {
    expect(depositLabel(5857.2, 19524)).toBe("Bill the 30% deposit, $5,857.20");
    expect(depositLabel(5000, 20000)).toBe("Bill the 25% deposit, $5,000");
    expect(depositLabel(1000, 0)).toBe("Bill the deposit, $1,000");
  });

  it("says which lines come along to the job: every one, or the option chosen and the ones on every option", () => {
    expect(jobLinesText({ option_id: null, options: [] })).toBe("Every line comes along, so nothing gets typed twice.");
    const options = [{ id: "good", name: "Architectural shingle" }, { id: "better", name: "Designer shingle " }];
    expect(jobLinesText({ option_id: "better", options })).toBe("The lines for Designer shingle and the ones on every option come along, so nothing gets typed twice.");
    expect(jobLinesText({ option_id: "good", options })).not.toContain("Every line");
    // The chosen option isn't loaded (or is gone): still never "every line".
    expect(jobLinesText({ option_id: "gone", options })).toBe("The lines they signed for come along, so nothing gets typed twice.");
  });
});

describe("the team", () => {
  const team: TeamMember[] = [
    { user_id: "u1", role: "estimator", active: true, profile: { full_name: "Mike Torres" } },
    { user_id: "u2", role: "office", active: true, profile: { full_name: "Sarah Lopez" } },
    { user_id: "u3", role: "field_crew", active: true, profile: { full_name: "Ana Cruz" } },
    { user_id: "u4", role: "estimator", active: false, profile: { full_name: "Jess Carver" } },
    { user_id: "u5", role: "owner", active: true, profile: { full_name: "", email: "boss@example.com" } },
  ];

  it("offers the people who price work, by name, keeping the one already picked", () => {
    expect(salesPeople(team).map((p) => p.name)).toEqual(["boss@example.com", "Mike Torres", "Sarah Lopez"]);
    expect(salesPeople(team, "u4").map((p) => `${p.name}${p.active ? "" : " (gone)"}`)).toEqual(["boss@example.com", "Jess Carver (gone)", "Mike Torres", "Sarah Lopez"]);
    expect(personName(team, "u1")).toBe("Mike Torres");
    expect(personName(team, "nobody")).toBeNull();
    expect(personName(undefined, "u1")).toBeNull();
  });

  it("titles the notes for whoever goes out", () => {
    expect(notesTitle("Mike Torres")).toBe("Notes for Mike");
    expect(notesTitle(null)).toBe("Notes for the site visit");
    expect(homeownerName("Dana Whitfield")).toBe("Dana");
    expect(homeownerName("  ")).toBe("the homeowner");
  });
});

describe("putting the package on", () => {
  const quote = { id: "q1", roof_package_id: "p1", lines: [] as Array<{ option_id: string | null }>, options: [] as Array<{ id: string }> };
  const ready = { editable: true, busy: false, hadLines: false };

  it("puts it on once, for a measured estimate with a package and no lines", () => {
    expect(autoFillKey(quote, takeoff, ready)).toBe("q1:p1:m1");
    expect(autoFillKey({ ...quote, lines: [{ option_id: null }] }, takeoff, ready)).toBeNull();
    expect(autoFillKey({ ...quote, roof_package_id: null }, takeoff, ready)).toBeNull();
    expect(autoFillKey(quote, null, ready)).toBeNull();
    expect(autoFillKey(quote, takeoff, { ...ready, editable: false })).toBeNull();
    // Not while edits are saving, and never for one whose lines were all taken off by hand.
    expect(autoFillKey(quote, takeoff, { ...ready, busy: true })).toBeNull();
    expect(autoFillKey(quote, takeoff, { ...ready, hadLines: true })).toBeNull();
    // A new measurement is a new try.
    expect(autoFillKey(quote, { id: "m2" }, ready)).toBe("q1:p1:m2");
  });

  it("fills the options picked before the roof was measured, once for those options and that measurement", () => {
    const offered = { ...quote, options: [{ id: "o3" }, { id: "o1" }, { id: "o2" }] };
    expect(autoFillKey(offered, takeoff, ready)).toBe("q1:o1,o2,o3:m1");
    // Lines on every option added by hand before measuring don't stop it.
    expect(autoFillKey({ ...offered, lines: [{ option_id: null }] }, takeoff, ready)).toBe("q1:o1,o2,o3:m1");
    expect(autoFillKey({ ...offered, lines: [{ option_id: "o1" }, { option_id: "o2" }, { option_id: "o3" }] }, takeoff, ready)).toBeNull();
    expect(autoFillKey(offered, null, ready)).toBeNull();
    expect(autoFillKey(offered, takeoff, { ...ready, busy: true })).toBeNull();
    expect(autoFillKey({ ...offered, options: [{ id: "o1" }, { id: "o4" }] }, takeoff, ready)).toBe("q1:o1,o4:m1");
  });

  it("never fills an option emptied by hand", () => {
    const offered = { ...quote, options: [{ id: "o1" }, { id: "o2" }, { id: "o3" }] };
    // Better's lines all taken off on the estimate step (Good's are there): no fill, here or on the next visit.
    expect(autoFillKey({ ...offered, lines: [{ option_id: "o1" }, { option_id: null }] }, takeoff, ready)).toBeNull();
    expect(autoFillKey({ ...offered, lines: [{ option_id: "o1" }] }, takeoff, { ...ready, hadLines: true })).toBeNull();
    // Every option emptied on this screen: still none.
    expect(autoFillKey(offered, takeoff, { ...ready, hadLines: true })).toBeNull();
    // What counts as having had them: with options, an option's own line.
    expect(hasFilledLines({ ...offered, lines: [{ option_id: null }] })).toBe(false);
    expect(hasFilledLines({ ...offered, lines: [{ option_id: "o2" }] })).toBe(true);
    expect(hasFilledLines({ ...quote, lines: [{ option_id: null }] })).toBe(true);
    expect(hasFilledLines(quote)).toBe(false);
  });

  it("says which options have nothing of their own, and how they get priced", () => {
    const opts = [{ id: "o1", name: "Architectural shingle" }, { id: "o2", name: "Designer shingle" }, { id: "o3", name: "Standing-seam metal" }];
    expect(emptyOptions(opts, [{ option_id: "o1" }, { option_id: null }]).map((o) => o.id)).toEqual(["o2", "o3"]);
    expect(emptyOptions(opts, [{ option_id: "o1" }, { option_id: "o2" }, { option_id: "o3" }])).toEqual([]);
    // Before the roof is measured.
    expect(emptyOptionsText(["Good", "Better", "Best"], 3, { measured: false, fromPackages: true })).toEqual({ text: "Each option is priced from its package once the roof is measured.", action: "Measure the roof" });
    expect(emptyOptionsText(["Better", "Best"], 3, { measured: false, fromPackages: true })!.text).toBe("Better and Best are priced from their packages once the roof is measured.");
    expect(emptyOptionsText(["Best"], 3, { measured: false, fromPackages: true })!.text).toBe("Best is priced from its package once the roof is measured.");
    // Measured: priced from their packages when asked, or by hand when their packages are gone.
    expect(emptyOptionsText(["Better"], 3, { measured: true, fromPackages: true })).toEqual({ text: "Better has nothing on it yet.", action: "Price it from its package" });
    expect(emptyOptionsText(["Good", "Better", "Best"], 3, { measured: true, fromPackages: true })).toEqual({ text: "Good, Better and Best have nothing on them yet.", action: "Price them from their packages" });
    expect(emptyOptionsText(["Best"], 3, { measured: true, fromPackages: false })).toEqual({ text: "Best has nothing on it yet. Add its lines from your price list.", action: null });
    expect(emptyOptionsText([], 3, { measured: true, fromPackages: true })).toBeNull();
  });
});
