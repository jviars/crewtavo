/**
 * The line list shared by quotes, jobs and invoices (quotes/LineItems.tsx): which lines it shows on a
 * quote that offers options, where a new or moved line goes among all of the quote's lines, what the
 * lines shown come to (the option's own subtotal, as the database works it out once it's shown) and
 * the words on its chips.
 */
import { optionLabels, optionTotals, quoteTotals } from "@crewtavo/core/money";
import { describe, expect, it } from "vitest";
import { addOnLabel, lineSums, movedSorts, nextSort, placeName, visibleLines, type Line } from "../src/features/quotes/LineItems";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const C = "cccccccc-0000-4000-8000-000000000003";

let n = 0;
/** A quote line as the database keeps it with option A shown: other options' lines are never selected. */
function line(name: string, quantity: number, unit_price: number, more: Partial<Line> = {}): Line {
  const option = more.option_id ?? null;
  const optional = more.optional ?? false;
  return {
    id: `line-${++n}`,
    name,
    description: null,
    quantity,
    unit: "ea",
    unit_price,
    unit_cost: null,
    taxable: true,
    sort: n,
    optional,
    selected: option !== null && option !== A ? false : !optional,
    option_id: option,
    ...more,
  };
}

// Shared lines, then Good (A, shown, with its add-on picked), Better (B) and Best (C).
const tearOff = line("Tear-off", 22, 85, { unit_cost: 40 });
const permit = line("Permit", 1, 250, { taxable: false });
const skylight = line("Skylight", 1, 1200, { optional: true });
const good = line("Architectural shingles", 24.2, 410, { option_id: A, unit_cost: 190 });
const ridgeVent = line("Ridge vent", 48, 9, { option_id: A, optional: true, selected: true, unit_cost: 3 });
const better = line("Designer shingles", 24.2, 560, { option_id: B, unit_cost: 260 });
const guards = line("Gutter guards", 1, 600, { option_id: B, optional: true });
const best = line("Standing-seam metal", 24.2, 980, { option_id: C, unit_cost: 520 });
const lines = [tearOff, permit, skylight, good, ridgeVent, better, guards, best];
const money = { taxRate: "0.0825", discountAmount: 0, promo: null };
const asOptionLines = lines.map((l) => ({ ...l, option_id: l.option_id ?? null }));

describe("the lines shown", () => {
  it("shows the lines on every option and the option looked at, and every line without options", () => {
    expect(visibleLines(lines, B).map((l) => l.name)).toEqual(["Tear-off", "Permit", "Skylight", "Designer shingles", "Gutter guards"]);
    expect(visibleLines(lines, A).map((l) => l.name)).toEqual(["Tear-off", "Permit", "Skylight", "Architectural shingles", "Ridge vent"]);
    expect(visibleLines(lines, null)).toHaveLength(lines.length);
  });

  it("says where a line is", () => {
    const options = [{ id: A, name: "Good" }, { id: B, name: "Better" }];
    expect(placeName(null, options)).toBe("On every option");
    expect(placeName(B, options)).toBe("Only on Better");
  });

  it("calls a line group's add-ons 'Pick one' on a quote with options, never Good, Better or Best", () => {
    expect(addOnLabel({ optional: true, selected: false, option_group: "Good" }, { offers: true, tier: "Good" })).toBe("Pick one");
    expect(addOnLabel({ optional: true, selected: true, option_group: "Roof" }, { offers: true })).toBe("Pick one · chosen");
    expect(addOnLabel({ optional: true, selected: false, option_group: null }, { offers: true })).toBe("Optional");
    expect(addOnLabel({ optional: false, selected: true, option_group: null }, { offers: true })).toBeNull();
  });

  it("gives a line group's add-ons the tier words the Client Hub gives them on a quote without options", () => {
    const group = [
      line("Designer shingles", 24, 560, { optional: true, selected: false, option_group: "Roof" }),
      line("Architectural shingles", 24, 410, { optional: true, selected: true, option_group: "Roof" }),
      line("Metal", 24, 980, { optional: true, selected: false, option_group: "Roof" }),
    ];
    const tiers = optionLabels(group);
    expect(group.map((l) => addOnLabel(l, { tier: tiers.get(l.id) }))).toEqual(["Better", "Good · chosen", "Best"]);
    expect(addOnLabel({ optional: true, selected: false, option_group: null })).toBe("Optional");
    expect(addOnLabel({ optional: true, selected: true, option_group: null })).toBe("Optional · chosen");
    // A group of one has no tier word.
    expect(addOnLabel({ optional: true, selected: false, option_group: "Gutters" }, { tier: undefined })).toBe("Optional");
  });
});

describe("where lines go", () => {
  it("numbers a new line after every line, another option's too", () => {
    // Looking at Good, the last line shown is the ridge vent; Best's line comes after it.
    expect(nextSort(visibleLines(lines, A))).toBe(ridgeVent.sort + 1);
    expect(nextSort(lines)).toBe(best.sort + 1);
    expect(nextSort([])).toBe(0);
  });

  it("swaps two lines next to each other, as on a job or an invoice", () => {
    const job = [
      { id: "a", sort: 0 },
      { id: "b", sort: 1 },
      { id: "c", sort: 2 },
    ];
    expect(movedSorts(job, ["a", "b", "c"], "b", -1)).toEqual([
      { id: "b", sort: 0 },
      { id: "a", sort: 1 },
    ]);
    expect(movedSorts(job, ["a", "b", "c"], "b", 1)).toEqual([
      { id: "c", sort: 1 },
      { id: "b", sort: 2 },
    ]);
  });

  it("moves a line past the next one shown and leaves another option's list as it was", () => {
    // Shared s1, Good's a1, Better's b1, shared s2. Looking at Good: s1, a1, s2.
    const all = [
      { id: "s1", sort: 0 },
      { id: "a1", sort: 1 },
      { id: "b1", sort: 2 },
      { id: "s2", sort: 3 },
    ];
    const changes = movedSorts(all, ["s1", "a1", "s2"], "a1", 1);
    const after = all.map((l) => ({ ...l, sort: changes.find((c) => c.id === l.id)?.sort ?? l.sort })).sort((x, y) => x.sort - y.sort).map((l) => l.id);
    expect(after).toEqual(["s1", "b1", "s2", "a1"]);
    // Better's list (s1, b1, s2) is unchanged; Good's is s1, s2, a1.
    expect(after.filter((id) => id !== "a1")).toEqual(["s1", "b1", "s2"]);
    expect(after.filter((id) => id !== "b1")).toEqual(["s1", "s2", "a1"]);
  });

  it("gets past equal sort numbers from old data, and can't move past the ends", () => {
    const old = [
      { id: "a", sort: 0 },
      { id: "b", sort: 0 },
      { id: "c", sort: 0 },
    ];
    expect(movedSorts(old, ["a", "b", "c"], "c", -1)).toEqual([
      { id: "c", sort: 1 },
      { id: "b", sort: 2 },
    ]);
    expect(movedSorts(old, ["a", "b", "c"], "a", -1)).toEqual([]);
    expect(movedSorts(old, ["a", "b", "c"], "c", 1)).toEqual([]);
    expect(movedSorts(old, ["a", "b"], "missing", 1)).toEqual([]);
  });
});

describe("what the lines shown come to", () => {
  it("comes to the shown option's subtotal, as the database adds up the selected lines", () => {
    const sums = lineSums(visibleLines(lines, A), { optionId: A, shownOptionId: A, withOptions: true });
    expect(sums.price).toBe(quoteTotals(lines, money).subtotal);
    // The picked ridge vent counts; the skylight nobody picked doesn't.
    expect(sums.price).toBe(22 * 85 + 250 + 9922 + 432);
  });

  it("comes to each other option's subtotal as it would be once shown, its add-ons not picked", () => {
    for (const option of [B, C]) {
      const sums = lineSums(visibleLines(lines, option), { optionId: option, shownOptionId: A, withOptions: true });
      expect(sums.price).toBe(optionTotals(asOptionLines, option, A, money).subtotal);
    }
    expect(lineSums(visibleLines(lines, B), { optionId: B, shownOptionId: A, withOptions: true }).price).toBe(22 * 85 + 250 + 13552);
  });

  it("costs only the lines that count", () => {
    const sums = lineSums(visibleLines(lines, A), { optionId: A, shownOptionId: A, withOptions: true });
    expect(sums.cost).toBeCloseTo(22 * 40 + 24.2 * 190 + 48 * 3, 6);
    expect(sums.costed).toBe(true);
    expect(lineSums(visibleLines(lines, C), { optionId: C, shownOptionId: A, withOptions: true }).cost).toBeCloseTo(22 * 40 + 24.2 * 520, 6);
  });

  it("counts every line of a job or an invoice", () => {
    const job = [line("Labor", 12, 95), line("Materials", 1, 860)];
    expect(lineSums(job)).toEqual({ price: 12 * 95 + 860, cost: 0, costed: false });
  });

  it("leaves out an add-on the client didn't pick on a quote without options", () => {
    const plain = [line("Sealcoat", 1, 1500), line("Crack fill", 1, 300, { optional: true, selected: false })];
    expect(lineSums(plain, { withOptions: true }).price).toBe(1500);
  });
});
