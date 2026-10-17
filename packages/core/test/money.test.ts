import { describe, expect, it } from "vitest";
import { lineTotal, quoteTotals, toCents, toUnits, type TotalsPromo } from "../src/money";
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

  // Property test: the helper (cents, from JSON numbers) against a BigInt reimplementation of the SQL.
  let seed = 20261017;
  const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  const pick = <T,>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]!;
  const money = (lo: number, hi: number) => (Math.floor(lo * 100 + rnd() * (hi - lo) * 100) / 100).toFixed(2);
  const RATES = ["0", "0.0725", "0.0825", "0.06", "0.0888", "0.053", "0.0475", "0.1025", "0.0625", "0.07", "0.0875", "0.0333"];
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
