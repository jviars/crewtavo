/**
 * Packages for every trade and the options an estimate offers, in their plain parts: picking
 * packages on the cards (one, or two or three as options), the highlights and contract sections on
 * a package (features/roofing/data.ts), and the options bar's tabs, totals and what "Add options"
 * can offer (features/quotes/options.ts).
 */
import { STARTER_NOTE } from "@crewtavo/core/contracts";
import { optionTotals } from "@crewtavo/core/money";
import { getPreset, isExampleWarranty, PACKAGE_LIMITS } from "@crewtavo/core/presets";
import { describe, expect, it } from "vitest";
import { addAction, addedMessage, depositNote, optionsOpen, optionsPlan, optionTabs, sharedAtFirst, showAsk, skippedText, sortOptions, viewedOption } from "../src/features/quotes/options";
import {
  cleanHighlights,
  exampleWarrantyNote,
  highlightRoom,
  isRoofingCompany,
  MAX_OPTIONS,
  moveItem,
  packageExtras,
  packagePriceLine,
  packagesPath,
  pickPackage,
  sameList,
  squarePrice,
  toggleSection,
  typedOrSaved,
} from "../src/features/roofing/data";
import { setupMessage } from "../src/features/roofing/packages";
import { formatMoney, formatMoneyCents } from "../src/lib/format";

const FORMAT = { whole: formatMoney, cents: formatMoneyCents };

describe("picking packages", () => {
  it("picks the package tapped instead of the one picked, as it always has", () => {
    expect(pickPackage([], "metal")).toEqual({ value: ["metal"], full: false });
    expect(pickPackage(["shingle"], "metal")).toEqual({ value: ["metal"], full: false });
    expect(pickPackage(["shingle"], "shingle")).toEqual({ value: ["shingle"], full: false });
  });

  it("offers more as options, numbered in the order they're picked", () => {
    expect(pickPackage(["shingle"], "metal", { add: true }).value).toEqual(["shingle", "metal"]);
    // With two or more picked, a tap adds one or takes it off again.
    expect(pickPackage(["shingle", "metal"], "designer").value).toEqual(["shingle", "metal", "designer"]);
    expect(pickPackage(["shingle", "metal", "designer"], "metal").value).toEqual(["shingle", "designer"]);
    // Offering one that's already picked changes nothing.
    expect(pickPackage(["shingle", "metal"], "metal", { add: true }).value).toEqual(["shingle", "metal"]);
    // Back down to one, a tap picks instead again.
    expect(pickPackage(["shingle", "metal"], "metal").value).toEqual(["shingle"]);
    expect(pickPackage(["shingle"], "designer").value).toEqual(["designer"]);
  });

  it("adds or takes off with every tap on a screen that only offers options", () => {
    expect(pickPackage([], "shingle", { toggle: true }).value).toEqual(["shingle"]);
    expect(pickPackage(["shingle"], "metal", { toggle: true }).value).toEqual(["shingle", "metal"]);
    expect(pickPackage(["shingle"], "shingle", { toggle: true }).value).toEqual([]);
    expect(pickPackage(["current"], "current", { toggle: true, locked: ["current"] }).value).toEqual(["current"]);
  });

  it("stops at 3 options and says so", () => {
    expect(MAX_OPTIONS).toBe(3);
    expect(pickPackage(["a", "b", "c"], "d")).toEqual({ value: ["a", "b", "c"], full: true });
    expect(pickPackage(["a", "b", "c"], "d", { add: true })).toEqual({ value: ["a", "b", "c"], full: true });
    expect(pickPackage(["a", "b"], "c", { max: 2 })).toEqual({ value: ["a", "b"], full: true });
  });

  it("keeps the packages already on the estimate first, picked, and on", () => {
    const locked = ["current"];
    expect(pickPackage([], "metal", { locked }).value).toEqual(["current", "metal"]);
    expect(pickPackage(["metal"], "designer", { locked }).value).toEqual(["current", "metal", "designer"]);
    expect(pickPackage(["metal", "current"], "current", { locked }).value).toEqual(["current", "metal"]);
    expect(pickPackage(["current", "metal"], "metal", { locked }).value).toEqual(["current"]);
    // The limit counts them too.
    expect(pickPackage(["current", "metal"], "designer", { locked, max: 2 })).toEqual({ value: ["current", "metal"], full: true });
  });
});

describe("what's on a package's card", () => {
  it("saves highlights trimmed, without empty lines, within the limits", () => {
    expect(cleanHighlights([" Algae-resistant shingles ", "", "   ", "Lifetime warranty"])).toEqual(["Algae-resistant shingles", "Lifetime warranty"]);
    expect(cleanHighlights(Array.from({ length: 10 }, (_, i) => `Line ${i + 1}`))).toHaveLength(PACKAGE_LIMITS.highlights);
    const long = cleanHighlights(["a".repeat(500), "b".repeat(500), "c".repeat(500), "d"]);
    expect(long.map((l) => l.length)).toEqual([500, 500, 200]);
    expect(long.join("").length).toBe(PACKAGE_LIMITS.highlightChars);
  });

  it("keeps the lines being typed while the save comes back with what they come to", () => {
    // A line typed and left saves; the empty line added after it stays, and so does its focus.
    const typed = ["Algae-resistant shingles", ""];
    expect(typedOrSaved(typed, ["Algae-resistant shingles"])).toBe(typed);
    expect(typedOrSaved([" Lifetime warranty ", "", "Ridge vent"], ["Lifetime warranty", "Ridge vent"])).toEqual([" Lifetime warranty ", "", "Ridge vent"]);
    // Changed somewhere else, or put back after a save failed: the saved ones.
    expect(typedOrSaved(["Algae-resistant shingles", ""], ["Something else"])).toEqual(["Something else"]);
    expect(typedOrSaved(["Algae-resistant shingles"], [])).toEqual([]);
  });

  it("lets each highlight have what the others leave", () => {
    expect(highlightRoom(["a".repeat(1000), "bb"], 1)).toBe(200);
    expect(highlightRoom(["a".repeat(1000), " bb "], 0)).toBe(1198);
    expect(highlightRoom(["a".repeat(1300), ""], 1)).toBe(0);
  });

  it("moves a highlight up or down", () => {
    expect(moveItem(["a", "b", "c"], 0, 1)).toEqual(["b", "a", "c"]);
    expect(moveItem(["a", "b", "c"], 2, 0)).toEqual(["c", "a", "b"]);
    expect(moveItem(["a", "b", "c"], 2, 9)).toEqual(["a", "b", "c"]);
    expect(moveItem(["a", "b"], 5, 0)).toEqual(["a", "b"]);
    expect(sameList(["a", "b"], ["a", "b"])).toBe(true);
    expect(sameList(["a", "b"], ["b", "a"])).toBe(false);
  });

  it("keeps a package's contract sections in the library's order", () => {
    const library = [{ id: "payment" }, { id: "changes" }, { id: "warranty" }];
    expect(toggleSection(library, ["warranty"], "payment", true)).toEqual(["payment", "warranty"]);
    expect(toggleSection(library, ["payment", "warranty"], "payment", false)).toEqual(["warranty"]);
    // A section deleted from the library drops off.
    expect(toggleSection(library, ["gone", "changes"], "warranty", true)).toEqual(["changes", "warranty"]);
    const many = Array.from({ length: 60 }, (_, i) => ({ id: `s${i}` }));
    expect(toggleSection(many, many.map((s) => s.id), "s0", true)).toHaveLength(PACKAGE_LIMITS.sections);
  });

  it("prices a package's card by the square for a roof, else by its main service", () => {
    const roof = { name: "Architectural shingles", unit: "sq", unit_price: 560 };
    expect(squarePrice(roof, FORMAT)).toBe("$560 a square");
    expect(squarePrice({ unit: "ft", unit_price: 9.5 }, FORMAT)).toBe("$9.50 / ft");
    expect(squarePrice(null, FORMAT)).toBeNull();
    expect(packagePriceLine({ roof, items: [] }, true, FORMAT)).toBe("$560 a square");
    expect(packagePriceLine({ roof: null, items: [] }, true, FORMAT)).toBe("No roof picked yet");
    expect(packagePriceLine({ roof: { name: "Sealcoat", unit: "sq ft", unit_price: 0.25 }, items: [] }, false, FORMAT)).toBe("Sealcoat, $0.25 / sq ft");
    expect(packagePriceLine({ roof: null, items: [{ kind: "included" }, { kind: "included" }, { kind: "quick" }] }, false, FORMAT)).toBe("2 services");
    expect(packagePriceLine({ roof: null, items: [{ kind: "quick" }] }, false, FORMAT)).toBe("Nothing in it yet");
  });

  it("sends a roofer to Roofing → Packages and everyone else to Packages", () => {
    expect(isRoofingCompany({ trade_preset: "roofing_exteriors" })).toBe(true);
    expect(isRoofingCompany({ trade_preset: "paving" })).toBe(false);
    expect(packagesPath({ trade_preset: "roofing_exteriors" })).toBe("/roofing/packages");
    expect(packagesPath({ trade_preset: "lawn_exterior" })).toBe("/packages");
  });

  it("counts quick adds on a roof's card only, since only a roofer's estimates show them", () => {
    const pkg = { highlights: ["Ice and water shield", "Ridge vent"], items: [{ kind: "included" }, { kind: "quick" }, { kind: "quick" }], is_default: true };
    expect(packageExtras(pkg, true)).toBe("2 highlights · 2 quick adds · Default");
    expect(packageExtras({ ...pkg, highlights: [], items: [], is_default: false }, true)).toBe("No quick adds");
    // Any other trade: the highlights, never quick adds (or the default, which only roof estimates start from).
    expect(packageExtras(pkg, false)).toBe("2 highlights");
    expect(packageExtras({ ...pkg, highlights: ["Edging"] }, false)).toBe("1 highlight");
    expect(packageExtras({ ...pkg, highlights: [] }, false)).toBe("");
  });

  it("says which packages still have setup's example warranty, until each has the business's own", () => {
    const examples = (getPreset("roofing_exteriors").packages ?? []).map((p) => ({ name: p.name, warranty: p.warranty ?? "" }));
    expect(examples.length).toBe(3);
    expect(examples.every((p) => isExampleWarranty(p.warranty))).toBe(true);
    expect(exampleWarrantyNote(examples)).toBe(`The warranties on your packages are from setup. ${STARTER_NOTE}`);
    const own = (p: { name: string; warranty: string }, i: number) => (i === 0 ? { ...p, warranty: "Lifetime on our workmanship." } : p);
    expect(exampleWarrantyNote(examples.map(own))).toBe(`The warranties on ${examples[1]!.name} and ${examples[2]!.name} are from setup. ${STARTER_NOTE}`);
    expect(exampleWarrantyNote([...examples.slice(0, 1), { name: "Cedar shake", warranty: "" }])).toBe(`The warranty on ${examples[0]!.name} is from setup. ${STARTER_NOTE}`);
    // Changed, even a little, it's the business's own.
    expect(exampleWarrantyNote(examples.map((p) => ({ ...p, warranty: `${p.warranty} Transferable once.` })))).toBeNull();
    expect(exampleWarrantyNote([])).toBeNull();
  });

  it("says setup's packages come with example warranties, only when it made packages", () => {
    expect(setupMessage({ packages_created: 3, services_added: ["Ridge vent", "Drip edge"] })).toBe(
      "Added 3 packages and 2 services. Their warranties are example wording, so have your attorney review them.",
    );
    expect(setupMessage({ packages_created: 1, services_added: [] })).toBe("Added 1 package. Its warranty is example wording, so have your attorney review it.");
    // Only services added (the price list was missing some): nothing about warranties.
    expect(setupMessage({ packages_created: 0, services_added: ["Ridge vent"] })).toBe("Added 1 service");
    expect(setupMessage({ packages_created: 0, services_added: [] })).toBe("You already have them");
  });
});

describe("the options bar", () => {
  const option = (id: string, sort: number, tier: string | null = null) => ({ id, sort, tier, name: id });
  const options = [option("best", 2), option("good", 0), option("better", 1)];
  const lines = [
    { id: "tear", option_id: null, quantity: 1, unit_price: 1000, taxable: true, optional: false, selected: true },
    { id: "g", option_id: "good", quantity: 25, unit_price: 400, taxable: true, optional: false, selected: false },
    { id: "b", option_id: "better", quantity: 25, unit_price: 480, taxable: true, optional: false, selected: true },
    { id: "b-vent", option_id: "better", quantity: 1, unit_price: 500, taxable: true, optional: true, selected: false },
    { id: "m", option_id: "best", quantity: 25, unit_price: 600, taxable: true, optional: false, selected: false },
    // Left picked on an option that isn't shown: that option's add-ons start unpicked.
    { id: "m-snow", option_id: "best", quantity: 1, unit_price: 800, taxable: true, optional: true, selected: true },
  ];
  const quote = { option_id: "better", tax_rate: 0.08, discount_amount: 0, promo: null };

  it("shows a tab per option in order, with its tier and its own total", () => {
    const tabs = optionTabs(options, lines, quote);
    expect(tabs.map((t) => [t.option.id, t.tier, t.total, t.shown])).toEqual([
      ["good", "Good", 11880, false], // (1,000 + 10,000) × 1.08
      ["better", "Better", 14040, true], // (1,000 + 12,000) × 1.08, the vent not picked
      ["best", "Best", 17280, false], // (1,000 + 15,000) × 1.08, the snow guards not counted
    ]);
    for (const t of tabs) expect(t.total).toBe(optionTotals(lines, t.option.id, quote.option_id, { taxRate: quote.tax_rate, discountAmount: quote.discount_amount, promo: null }).total);
  });

  it("counts the shown option's picked add-ons, and a discount on every tab", () => {
    const picked = lines.map((l) => (l.id === "b-vent" ? { ...l, selected: true } : l));
    expect(optionTabs(options, picked, quote).map((t) => t.total)).toEqual([11880, 14580, 17280]);
    expect(optionTabs(options, lines, { ...quote, discount_amount: 1000 }).map((t) => t.total)).toEqual([10800, 12960, 16200]);
    expect(optionTabs(options, lines, { ...quote, promo: { kind: "percent", value: 10 } }).map((t) => t.total)).toEqual([10692, 12636, 15552]);
  });

  it("keeps an option's own tier and has no total for one without lines", () => {
    const own = [option("good", 0, "Basic"), option("better", 1, "Premium"), option("new", 2)];
    const tabs = optionTabs(own, lines, { ...quote, option_id: "good" });
    expect(tabs.map((t) => [t.option.id, t.tier, t.total, t.shown])).toEqual([
      ["good", "Basic", 11880, true],
      ["better", "Premium", 14040, false],
      ["new", null, null, false],
    ]);
  });

  it("looks at the tab picked, else the one shown first, else the first", () => {
    const sorted = sortOptions(options);
    expect(sorted.map((o) => o.id)).toEqual(["good", "better", "best"]);
    expect(viewedOption(sorted, "best", "better")).toBe("best");
    expect(viewedOption(sorted, "gone", "better")).toBe("better");
    expect(viewedOption(sorted, null, null)).toBe("good");
    expect(viewedOption([], "best", "better")).toBeNull();
  });

  it("locks the packages already on the estimate when adding options", () => {
    const packages = ["shingle", "designer", "metal"];
    const offered = (id: string, sort: number, package_id: string | null) => ({ id, sort, package_id });
    // An estimate priced from one package: it becomes option 1, with room for 2 more.
    expect(optionsPlan([], 6, "shingle", packages)).toEqual({ converting: true, empty: false, locked: ["shingle"], taken: 1, max: 3 });
    // Its package was deleted, or it was priced by hand: still option 1.
    expect(optionsPlan([], 6, "deleted", packages)).toEqual({ converting: true, empty: false, locked: [], taken: 1, max: 2 });
    expect(optionsPlan([], 6, null, packages)).toEqual({ converting: true, empty: false, locked: [], taken: 1, max: 2 });
    // Options already offered.
    expect(optionsPlan([offered("a", 0, "shingle"), offered("b", 1, "metal")], 9, "shingle", packages)).toEqual({ converting: false, empty: false, locked: ["shingle", "metal"], taken: 2, max: 3 });
    expect(optionsPlan([offered("a", 0, "shingle"), offered("b", 1, null)], 9, "shingle", packages)).toEqual({ converting: false, empty: false, locked: ["shingle"], taken: 2, max: 2 });
    expect(optionsPlan([offered("a", 0, "shingle"), offered("b", 1, "metal"), offered("c", 2, null)], 9, "shingle", packages).max).toBe(2);
    // A new estimate with nothing on it: one package prices it.
    expect(optionsPlan([], 0, "shingle", packages)).toEqual({ converting: false, empty: true, locked: [], taken: 0, max: 3 });
  });

  it("numbers the locked packages in the order the options are offered", () => {
    const unsorted = [{ id: "c", sort: 2, package_id: "metal" }, { id: "a", sort: 0, package_id: "shingle" }, { id: "b", sort: 1, package_id: "designer" }];
    expect(optionsPlan(unsorted, 9, null, ["shingle", "designer", "metal"]).locked).toEqual(["shingle", "designer", "metal"]);
  });

  it("uses one package on an empty estimate, and otherwise offers two or three", () => {
    const nameOf = (id: string) => ({ shingle: "Architectural shingle", metal: "Standing-seam metal" })[id] ?? id;
    const empty = { empty: true, taken: 0 };
    expect(addAction(empty, [], false, nameOf)).toEqual({ ready: false, label: "Offer options" });
    expect(addAction(empty, ["shingle"], false, nameOf)).toEqual({ ready: true, label: "Use Architectural shingle" });
    expect(addAction(empty, ["shingle", "metal"], false, nameOf)).toEqual({ ready: true, label: "Offer 2 options" });
    // The estimate as it is becomes option 1, so one more makes two.
    const converting = { empty: false, taken: 1 };
    expect(addAction(converting, ["metal"], false, nameOf)).toEqual({ ready: true, label: "Offer 2 options" });
    expect(addAction(converting, [], false, nameOf).ready).toBe(false);
    expect(addAction({ empty: false, taken: 2 }, ["metal"], false, nameOf)).toEqual({ ready: true, label: "Offer 3 options" });
    // Starting over takes one or more.
    expect(addAction(converting, ["metal"], true, nameOf)).toEqual({ ready: true, label: "Start over as Standing-seam metal" });
    expect(addAction(converting, ["shingle", "metal"], true, nameOf)).toEqual({ ready: true, label: "Start over with 2 options" });
    expect(addAction(converting, [], true, nameOf)).toEqual({ ready: false, label: "Start over" });
  });

  it("keeps the extras found on the job on every option when the estimate becomes option 1", () => {
    const shingle = { roof_service_id: "shingles", items: [{ service_id: "tearoff", kind: "included" }, { service_id: "pipe-boots", kind: "included" }, { service_id: "decking", kind: "quick" }] };
    const metal = { roof_service_id: "panels", items: [{ service_id: "tearoff", kind: "included" }, { service_id: "ridge-vent", kind: "included" }] };
    const line = (id: string, service_id: string | null, name = id, formula: string | null = null) => ({ id, name, service_id, formula });
    const lines = [
      line("roof", "shingles", "Architectural shingles", "squares"),
      line("tear", "tearoff", "Tear-off", "roof_squares"),
      line("boots", "pipe-boots", "Pipe boots"),
      line("deck", "decking", "Decking sheets"), // a quick add, found on site
      line("vent", "ridge-vent", "Ridge vent"), // added by hand, but the metal package has it
      line("haul", null, "Extra haul-away"), // typed by hand
      line("site", null, "Price adjustment"), // a price set on site goes with option 1
    ];
    expect(sharedAtFirst(lines, shingle, [])).toEqual(["deck", "vent", "haul"]);
    expect(sharedAtFirst(lines, shingle, [metal])).toEqual(["deck", "haul"]);
    // Priced by hand, or its package deleted: nothing to tell by, so every line stays on option 1.
    expect(sharedAtFirst(lines, null, [metal])).toEqual([]);
  });

  it("asks before showing another option first once the customer has the estimate", () => {
    expect(showAsk("office", { status: "draft", priced_on_site_at: null }, "Designer shingle")).toBeNull();
    expect(showAsk("office", { status: "sent", priced_on_site_at: null }, "Designer shingle")).toEqual({
      title: "Show Designer shingle first?",
      body: "They already have this estimate. Their link will open on Designer shingle, and any add-ons they picked are cleared.",
      confirmLabel: "Show it first",
    });
    expect(showAsk("office", { status: "changes_requested", priced_on_site_at: "2026-10-24T15:00:00Z" }, "Metal")?.body).toBe(
      "They already have this estimate. Their link will open on Metal, and any add-ons they picked and the price set on site are cleared.",
    );
    expect(showAsk("office", { status: "draft", priced_on_site_at: "2026-10-24T15:00:00Z" }, "Metal")?.body).toBe("Changing the option clears the price set on site.");
    // On the iPad, with the homeowner: only a price set on site is asked about.
    expect(showAsk("visit", { status: "sent", priced_on_site_at: null }, "Metal")).toBeNull();
    expect(showAsk("visit", { status: "sent", priced_on_site_at: "2026-10-24T15:00:00Z" }, "Metal")).toEqual({ title: "Change the option?", body: "Changing the option clears the price you set.", confirmLabel: "Change it" });
  });

  it("changes options only while the estimate is open", () => {
    expect(["draft", "sent", "changes_requested"].every(optionsOpen)).toBe(true);
    expect(["approved", "converted", "lost", "archived"].some(optionsOpen)).toBe(false);
  });

  it("says which lines were left off", () => {
    expect(skippedText([])).toBeNull();
    expect(
      skippedText([
        { package: "Metal", name: "Valley metal", reason: "None on this roof" },
        { package: "Shingle", name: "Valley metal", reason: "None on this roof" },
        { package: "Metal", name: "Snow guards", reason: "Unknown value: snow_ft" },
      ]),
    ).toBe("Left off, with nothing to measure on this job: Valley metal. Couldn't work out Snow guards from the measurements. Add it by hand.");
    // Filling in options after measuring: one whose package was deleted.
    expect(skippedText([{ package: "Designer shingle", name: "Designer shingle", reason: "Its package was deleted, so add its lines by hand." }])).toBe("Designer shingle's package was deleted, so add its lines by hand.");
    expect(
      skippedText([
        { package: "Good", name: "Good", reason: "Its package was deleted, so add its lines by hand." },
        { package: "Best", name: "Best", reason: "Its package was deleted, so add its lines by hand." },
      ]),
    ).toBe("The packages of Good and Best were deleted, so add their lines by hand.");
  });

  it("says what went on the estimate, and when its lines wait for the measurement", () => {
    const one = { options: [], skipped: [] };
    expect(addedMessage(one, { name: "Metal", startOver: false, lines: 9, roofing: true })).toEqual({ title: "Metal is on the estimate", description: null });
    expect(addedMessage(one, { name: "Metal", startOver: true, lines: 0, roofing: true })).toEqual({ title: "Estimate started over from Metal", description: "Its lines fill in once the roof is measured." });
    expect(addedMessage(one, { name: "Sealcoat", startOver: false, lines: 0, roofing: false }).description).toBe("That package has nothing in it yet.");
    // Couldn't count the lines: say only what's known.
    expect(addedMessage(one, { name: "Metal", startOver: false, lines: null, roofing: true }).description).toBeNull();
    const skipped = [{ package: "Metal", name: "Valley metal", reason: "None on this roof" }];
    expect(addedMessage({ options: [], skipped }, { name: "Metal", startOver: false, lines: 0, roofing: true }).description).toBe("Left off, with nothing to measure on this job: Valley metal.");
    const options = [{ id: "a" }, { id: "b" }] as never[];
    expect(addedMessage({ options, skipped: [] }, { name: "", startOver: false, lines: 0, roofing: true })).toEqual({ title: "2 options on the estimate", description: "Their lines fill in once the roof is measured." });
    expect(addedMessage({ options, skipped }, { name: "", startOver: false, lines: 12, roofing: true }).description).toBe("Left off, with nothing to measure on this job: Valley metal.");
    // A cheaper option lowered the deposit (the server answers with it only then).
    expect(addedMessage({ options, skipped: [], deposit_amount: 1500 }, { name: "", startOver: false, lines: 12, roofing: true }).description).toBe("The deposit is now $1,500.00, so it's no more than the cheapest option.");
    expect(addedMessage({ options, skipped, deposit_amount: 1500 }, { name: "", startOver: false, lines: 12, roofing: true }).description).toBe(
      "Left off, with nothing to measure on this job: Valley metal. The deposit is now $1,500.00, so it's no more than the cheapest option.",
    );
    expect(depositNote({})).toBeNull();
  });
});
