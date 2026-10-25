import { describe, expect, it } from "vitest";
import { snapshotLines } from "../src/estimates";
import {
  chosenTotals,
  countsOn,
  inOptionBase,
  lineTotal,
  optionBaseTotal,
  optionLines,
  optionTierLabels,
  optionTierOrder,
  optionTotals,
  quoteTotals,
  taxPercent,
  taxRateFromPercent,
  toCents,
  toUnits,
  type TotalsPromo,
} from "../src/money";
import { sqlQuoteTotals, type SqlLine } from "./numeric";

// The expected values below were checked in Postgres 16.
describe("money", () => {
  it("rounds a line half away from zero, from the decimal as written", () => {
    expect(lineTotal(1.5, 0.35)).toBe(0.53); // 0.525; floats make it 0.52
    expect(lineTotal(-1.5, 0.35)).toBe(-0.53);
    expect(lineTotal(0.5, 297.65)).toBe(148.83);
    expect(lineTotal("2.5", "19.99")).toBe(49.98);
    expect(lineTotal(1.0005, 100)).toBe(100.1); // quantity is numeric(14, 3): 1.001
  });

  it("reads amounts the way a numeric column would", () => {
    expect(toUnits(297.65, 2)).toBe(29765n);
    expect(toUnits("1e-7", 2)).toBe(0n);
    expect(toUnits(1e21, 0)).toBe(10n ** 21n);
    expect(toCents(0.005)).toBe(1);
    expect(toCents(-0.005)).toBe(-1);
    expect(toCents("12.5")).toBe(1250);
    expect(toCents(Number.NaN)).toBe(0);
    expect(toCents(null)).toBe(0);
    expect(toCents("")).toBe(0);
  });

  it("matches the stored total the audit found off by a cent", () => {
    const lines = [{ quantity: 0.5, unit_price: 297.65, taxable: false }, { quantity: 1, unit_price: 266.06, taxable: false }];
    expect(quoteTotals(lines, { taxRate: 0 }).total).toBe(414.89);
  });

  it("rounds the discount's taxable share like Postgres division", () => {
    // 1.00 * 20.00 / 30.00 is 0.66666666666666666667 in Postgres, so tax is 1.59 (exactly 1.595).
    const lines = [{ quantity: 1, unit_price: 20, taxable: true }, { quantity: 1, unit_price: 10, taxable: false }];
    expect(quoteTotals(lines, { taxRate: 0.0825, discountAmount: 1 })).toEqual({ subtotal: 30, discount: 1, tax: 1.59, total: 30.59 });
    const other = [{ quantity: 1, unit_price: 45, taxable: true }, { quantity: 1, unit_price: 25, taxable: false }];
    expect(quoteTotals(other, { taxRate: 0.07, discountAmount: 5 }).tax).toBe(2.92);
  });

  it("works out promo codes, options and credits like quote_totals", () => {
    const lines = [
      { quantity: 1, unit_price: 200, taxable: true },
      { quantity: 1, unit_price: 100, taxable: false, selected: false }, // an option not chosen
      { quantity: 1, unit_price: -50, taxable: true }, // a credit isn't part of the promo base
    ];
    expect(quoteTotals(lines, { taxRate: 0.1, promo: { kind: "percent", value: 15 } })).toEqual({ subtotal: 150, discount: 30, tax: 12, total: 132 });
    expect(quoteTotals(lines, { taxRate: 0, promo: { kind: "amount", value: 500 } }).discount).toBe(150); // never more than the subtotal
    expect(quoteTotals([], { taxRate: 0.08, discountAmount: 10 })).toEqual({ subtotal: 0, discount: 0, tax: 0, total: 0 });
  });

  it("keeps a tax rate to 0.0001%, as the columns do", () => {
    // New York City's 8.875% on $1,000.00 is $88.75 (8.88% would be $88.80), as in Postgres.
    const lines = [{ quantity: 1, unit_price: 1000, taxable: true }, { quantity: 1, unit_price: 50, taxable: false }];
    expect(quoteTotals(lines, { taxRate: 0.08875 })).toEqual({ subtotal: 1050, discount: 0, tax: 88.75, total: 1138.75 });
    expect(quoteTotals(lines, { taxRate: "0.088750" }).tax).toBe(88.75); // as PostgREST may send it
    expect(quoteTotals(lines, { taxRate: 0.07375 }).tax).toBe(73.75);
    expect(quoteTotals(lines, { taxRate: 0.088755 }).tax).toBe(88.76); // 88.755, half away from zero
    expect(quoteTotals(lines, { taxRate: 0.0887549 }).tax).toBe(88.76); // stored as 0.088755
    // A discount's taxable share, at a three-decimal rate.
    expect(quoteTotals(lines, { taxRate: 0.08875, discountAmount: 105 })).toEqual({ subtotal: 1050, discount: 105, tax: 79.88, total: 1024.88 });
  });

  it("turns tax rates into percents and back exactly", () => {
    expect(taxPercent(0.08875)).toBe(8.875);
    expect(taxPercent("0.088750")).toBe(8.875);
    expect(taxPercent(0.0825)).toBe(8.25);
    expect(taxPercent(0.07375)).toBe(7.375);
    expect(taxPercent(0.088755)).toBe(8.8755);
    expect(taxPercent(null)).toBe(0);
    expect(taxRateFromPercent(8.875)).toBe(0.08875);
    expect(taxRateFromPercent("9.125")).toBe(0.09125);
    expect(taxRateFromPercent(4.02)).toBe(0.0402); // 4.02 / 100 is 0.04019999999999999 in floats
    expect(taxRateFromPercent(8.87555)).toBe(0.088756); // rounded as numeric(8, 6) rounds it
    expect(taxRateFromPercent(taxPercent(0.08875))).toBe(0.08875);
  });

  // Property test: the helper (cents, from JSON numbers) against a BigInt reimplementation of the SQL.
  let seed = 20261017;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pick = <T,>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]!;
  const money = (lo: number, hi: number) => (Math.floor(lo * 100 + rnd() * (hi - lo) * 100) / 100).toFixed(2);
  const RATES = ["0", "0.0725", "0.0825", "0.06", "0.0888", "0.053", "0.0475", "0.1025", "0.0625", "0.07", "0.0875", "0.0333", "0.08875", "0.07375", "0.09125", "0.088755", "0.047125"];
  const PROMOS = [null, null, null, { kind: "percent", value: "15" }, { kind: "percent", value: "7.5" }, { kind: "percent", value: "33.33" }, { kind: "amount", value: "50.00" }, { kind: "amount", value: "1.00" }];

  const compare = (lines: SqlLine[], q: { discount_amount: string; tax_rate: string; promo: { kind: string; value: string } | null }) => {
    const promo: TotalsPromo | null = q.promo && { kind: q.promo.kind, value: Number(q.promo.value) };
    const got = quoteTotals(lines.map((l) => ({ ...l, quantity: Number(l.quantity), unit_price: Number(l.unit_price) })), { taxRate: Number(q.tax_rate), discountAmount: Number(q.discount_amount), promo });
    const want = sqlQuoteTotals(lines, q);
    return { got: { subtotal: toCents(got.subtotal), discount: toCents(got.discount), tax: toCents(got.tax), total: toCents(got.total) }, want };
  };

  it("matches quote_totals on random quotes", () => {
    const bad: unknown[] = [];
    for (let i = 0; i < 20_000; i++) {
      const round = rnd() < 0.5; // whole-dollar prices land on half cents more often
      const lines = Array.from({ length: 1 + Math.floor(rnd() * 5) }, () => ({
        quantity: pick(["1", "2", "3", "0.5", "1.5", "2.5", "12.5", "0", "-1", (Math.floor(rnd() * 100_000) / 1000).toFixed(3)]),
        unit_price: round ? pick(["10.00", "20.00", "30.00", "45.00", "7.00", "100.00", "15.00", "-25.00", "0.35", "297.65", "0.00"]) : rnd() < 0.1 ? money(-200, 0) : money(0, 500),
        taxable: rnd() < 0.6,
        selected: rnd() < 0.9,
      }));
      const q = { discount_amount: pick(["0", "1.00", "2.00", "5.00", "10.50", "25.00", "99.99", money(0, 300)]), tax_rate: pick(RATES), promo: pick(PROMOS) };
      const { got, want } = compare(lines, q);
      if (JSON.stringify(got) !== JSON.stringify(want)) bad.push({ lines, q, got, want });
    }
    expect(bad.slice(0, 3)).toEqual([]);
  });

  it("matches quote_totals on every small whole-dollar quote", () => {
    // One taxable and one untaxed line with a small discount: about 1 in 170 of these is decided by
    // how Postgres rounds the discount's taxable share.
    const prices = ["10.00", "20.00", "30.00", "15.00", "7.00", "45.00", "60.00", "35.00", "12.00", "25.00", "9.00", "40.00"];
    const bad: unknown[] = [];
    for (const a of prices) for (const b of prices) for (const d of ["1.00", "2.00", "3.00", "5.00", "10.00"]) for (const r of RATES) {
      const lines = [{ quantity: "1", unit_price: a, taxable: true, selected: true }, { quantity: "1", unit_price: b, taxable: false, selected: true }];
      const { got, want } = compare(lines, { discount_amount: d, tax_rate: r, promo: null });
      if (JSON.stringify(got) !== JSON.stringify(want)) bad.push({ a, b, d, r, got, want });
    }
    expect(bad.slice(0, 3)).toEqual([]);
  });
});

describe("options", () => {
  // A roof estimate offering three roofs, with the Better one shown (quotes.option_id = "b"). As the
  // database keeps it: the other options' lines are unselected, the shown one's add-on is picked.
  const line = (id: string, option_id: string | null, quantity: number, unit_price: number, extra: { optional?: boolean; selected?: boolean } = {}) => ({
    id, option_id, quantity, unit_price, taxable: true, optional: false, selected: true, ...extra,
  });
  const lines = [
    line("dumpster", null, 1, 450),
    line("ridge", null, 48, 9, { optional: true, selected: true }),
    line("arch", "a", 30, 560, { selected: false }),
    line("designer", "b", 30, 735),
    line("ice", "b", 1, 400, { optional: true, selected: true }),
    line("metal", "c", 30, 1285, { selected: false }),
    line("snow", "c", 1, 900, { optional: true, selected: false }),
  ];
  const opts = { taxRate: 0, discountAmount: 100 };

  it("counts the shared lines and the shown option's, without the add-ons left off", () => {
    expect(lines.filter((l) => countsOn(l, "b")).map((l) => l.id)).toEqual(["dumpster", "ridge", "designer", "ice"]);
    expect(lines.filter((l) => countsOn(l, null)).map((l) => l.id)).toEqual(["dumpster", "ridge"]);
    expect(countsOn({ optional: true, selected: false }, null)).toBe(false);
    expect(countsOn({ optional: false, selected: false }, undefined)).toBe(true); // a quote without options, as today
  });

  it("puts the shared lines that count and an option's required lines in its base", () => {
    expect(lines.filter((l) => inOptionBase(l, "b")).map((l) => l.id)).toEqual(["dumpster", "ridge", "designer"]);
    expect(lines.filter((l) => inOptionBase(l, "c")).map((l) => l.id)).toEqual(["dumpster", "ridge", "metal"]);
    expect(inOptionBase({ option_id: null, optional: true, selected: false }, "b")).toBe(false);
  });

  it("picks an option's lines the way they'd be with it shown", () => {
    expect(optionLines(lines, "c", "b").map((l) => [l.id, l.selected])).toEqual([["dumpster", true], ["ridge", true], ["metal", true], ["snow", false]]);
    expect(optionLines(lines, "b", "b").map((l) => [l.id, l.selected])).toEqual([["dumpster", true], ["ridge", true], ["designer", true], ["ice", true]]);
  });

  it("totals each option, keeping the shown one's add-ons", () => {
    expect(optionTotals(lines, "b", "b", opts).total).toBe(23232); // 450 + 432 + 22,050 + 400 − 100
    expect(optionTotals(lines, "a", "b", opts).total).toBe(17582);
    expect(optionTotals(lines, "c", "b", opts).total).toBe(39332); // its add-on starts off
  });

  it("works out an option's base for the range, whichever option is shown", () => {
    expect(optionBaseTotal(lines, "b", opts)).toBe(22832); // without the add-on
    expect(optionBaseTotal(lines, "c", opts)).toBe(39332);
    expect(optionBaseTotal(lines, "d", opts)).toBeNull(); // no lines of its own yet
    const plain = lines.filter((l) => l.option_id === null);
    expect(optionBaseTotal(plain, null, opts)).toBe(quoteTotals(plain, opts).total);
  });

  it("leaves an option with only add-ons out of the range, rather than pricing it at the shared lines", () => {
    const addOnly = [...lines, line("gutters", "d", 1, 1200, { optional: true, selected: false })];
    expect(optionBaseTotal(addOnly, "d", opts)).toBeNull();
    expect(optionBaseTotal([...addOnly, line("guards", "d", 1, 300)], "d", opts)).toBe(450 + 432 + 300 - 100);
  });

  it("totals the option the customer signs for, with the add-ons they picked", () => {
    // Metal, with its snow guards and without the shared ridge vent; Better's ice and water shield doesn't come along.
    expect(chosenTotals(lines, "c", "b", ["snow", "ice"], opts).total).toBe(450 + 38550 + 900 - 100);
    expect(chosenTotals(lines, "b", "b", ["ice", "ridge"], opts)).toEqual(optionTotals(lines, "b", "b", opts));
    expect(chosenTotals(lines, "b", "b", [], opts).total).toBe(450 + 22050 - 100);
    const plain = lines.filter((l) => l.option_id === null);
    expect(chosenTotals(plain, null, null, ["ridge"], opts)).toEqual(quoteTotals(plain, opts));
  });

  it("offers the options cheapest first, with the ones not priced yet last", () => {
    expect(optionTierOrder([{ id: "c", total: 39332 }, { id: "a", total: 17582 }, { id: "b", total: "23232.00" }])).toEqual(["a", "b", "c"]);
    expect(optionTierOrder([{ id: "x", total: null }, { id: "c", total: 500 }, { id: "y", total: "" }, { id: "a", total: 500 }])).toEqual(["c", "a", "x", "y"]);
  });

  it("names the options Good, Better and Best by total when none has a tier of its own", () => {
    const options = [
      { id: "c", total: 39332 },
      { id: "a", total: 17582 },
      { id: "b", tier: "  ", total: "23232.00" },
    ];
    expect(Object.fromEntries(optionTierLabels(options))).toEqual({ a: "Good", b: "Better", c: "Best" });
    expect(Object.fromEntries(optionTierLabels([{ id: "a", total: null }, { id: "b", total: 5 }]))).toEqual({ b: "Good", a: "Better" });
    expect(optionTierLabels([{ id: "a", total: 1 }]).size).toBe(0);
    expect(optionTierLabels(["a", "b", "c", "d"].map((id, i) => ({ id, total: i }))).size).toBe(0);
    expect(Object.fromEntries(optionTierLabels([{ id: "a", tier: "Basic", total: 1 }]))).toEqual({ a: "Basic" });
  });

  it("keeps the business's own tiers and never repeats one", () => {
    expect(Object.fromEntries(optionTierLabels([{ id: "a", total: 900 }, { id: "b", tier: " Premium ", total: 100 }]))).toEqual({ b: "Premium" });
    // A "Good" at $30,000 doesn't make the cheaper ones "Good" and "Better".
    const mixed = optionTierLabels([{ id: "a", tier: "Good", total: 30000 }, { id: "b", total: 10000 }, { id: "c", total: 20000 }]);
    expect(Object.fromEntries(mixed)).toEqual({ a: "Good" });
  });

  // Property test: an option's totals against the SQL, as the database holds the lines once that
  // option is shown (the switch turns its required lines on and its add-ons off).
  let seed = 20261025;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pick = <T,>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]!;
  const money = (lo: number, hi: number) => (Math.floor(lo * 100 + rnd() * (hi - lo) * 100) / 100).toFixed(2);
  type Line = SqlLine & { id: string; option_id: string | null; optional: boolean; service_id: null; name: string; unit: string };
  /** The lines as the database keeps them with `shown` shown; `picked` holds the add-on picks. */
  const stored = (all: Array<Line & { picked: boolean }>, shown: string | null, keepPicks: boolean): Line[] =>
    all.map(({ picked, ...l }) => ({
      ...l,
      selected: l.option_id === null ? !l.optional || picked : l.option_id === shown ? !l.optional || (keepPicks && picked) : false,
    }));

  it("matches quote_totals for every option, its base and the signed choice on random quotes", () => {
    const bad: unknown[] = [];
    for (let i = 0; i < 3_000; i++) {
      const ids = ["a", "b", "c"].slice(0, 1 + Math.floor(rnd() * 3));
      const all = Array.from({ length: 2 + Math.floor(rnd() * 8) }, (_, n) => ({
        id: `line${n}`,
        service_id: null,
        name: `Line ${n}`,
        unit: "ea",
        option_id: rnd() < 0.3 ? null : pick(ids),
        optional: rnd() < 0.3,
        picked: rnd() < 0.5,
        quantity: pick(["1", "2", "0.5", "1.5", "12.5", "24.2", (Math.floor(rnd() * 100_000) / 1000).toFixed(3)]),
        unit_price: rnd() < 0.1 ? money(-200, 0) : pick(["450.00", "560.00", "735.00", "1285.00", "9.00", "45.00", money(0, 900)]),
        taxable: rnd() < 0.7,
        selected: true,
      }));
      const q = {
        discount_amount: pick(["0", "100.00", "24.00", money(0, 500)]),
        tax_rate: pick(["0", "0.053", "0.0825", "0.08875", "0.07375"]),
        promo: pick([null, null, { kind: "percent", value: "10" }, { kind: "percent", value: "7.5" }, { kind: "amount", value: "250.00" }]),
      };
      const shown = pick(ids);
      const current = stored(all, shown, true);
      const opts = { taxRate: q.tax_rate, discountAmount: q.discount_amount, promo: q.promo };
      const snapshot = snapshotLines(current);
      const cents = (t: ReturnType<typeof quoteTotals>) => ({ subtotal: toCents(t.subtotal), discount: toCents(t.discount), tax: toCents(t.tax), total: toCents(t.total) });
      for (const option of ids) {
        const want = sqlQuoteTotals(stored(all, option, option === shown), q);
        const got = cents(optionTotals(current, option, shown, opts));
        if (JSON.stringify(got) !== JSON.stringify(want)) bad.push({ all, q, shown, option, got, want });
        // The range's base: that option shown with no add-ons, whichever option is shown now.
        const base = optionBaseTotal(current, option, opts);
        const baseWant = all.some((l) => l.option_id === option && !l.optional) ? sqlQuoteTotals(stored(all, option, false), q).total : null;
        if ((base === null ? null : toCents(base)) !== baseWant) bad.push({ all, q, shown, option, base, baseWant });
        // The lines saved with the range add up to the same base.
        const saved = snapshot.filter((s) => s.option_id === null || s.option_id === option);
        if (base !== null && toCents(quoteTotals(saved, opts).total) !== toCents(base)) bad.push({ all, q, shown, option, base, saved });
        // approve_hub_quote: show the chosen option (when it isn't already), then pick the add-ons
        // that are shared or on it; picks of another option's add-ons are ignored.
        const picks = all.filter((l) => l.optional && rnd() < 0.5).map((l) => l.id);
        const approved = current
          .map((l) => (option === shown || l.option_id === null ? l : { ...l, selected: l.option_id === option && !l.optional }))
          .map((l) => (l.optional && (l.option_id === null || l.option_id === option) ? { ...l, selected: picks.includes(l.id) } : l));
        const chosen = cents(chosenTotals(current, option, shown, picks, opts));
        const chosenWant = sqlQuoteTotals(approved, q);
        if (JSON.stringify(chosen) !== JSON.stringify(chosenWant)) bad.push({ all, q, shown, option, picks, chosen, chosenWant });
      }
    }
    expect(bad.slice(0, 3)).toEqual([]);
  });
});
