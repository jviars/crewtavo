/**
 * Postgres numeric, reimplemented in BigInt for tests: a value is digits * 10^-scale and keeps its
 * display scale the way numeric does, because division picks its precision from the inputs
 * (select_div_scale in numeric.c). sqlQuoteTotals() follows private.quote_totals() line by line
 * (supabase/migrations/20261017001600_promo_codes.sql). No floats anywhere.
 */

export interface Num {
  n: bigint;
  s: number;
}

const abs = (n: bigint) => (n < 0n ? -n : n);
const scaleUp = (a: Num, s: number) => a.n * 10n ** BigInt(s - a.s);

/** Half away from zero, like numeric's round_var. */
function roundDiv(n: bigint, d: bigint): bigint {
  const q = abs(n) / d;
  const r = abs(n) % d;
  const out = r * 2n >= d ? q + 1n : q;
  return n < 0n ? -out : out;
}

/** A literal, or a cast to numeric(p, scale) when scale is given. */
export function num(text: string, scale?: number): Num {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m) throw new Error(`not a decimal: ${text}`);
  const frac = m[3] ?? "";
  const value = { n: BigInt(`${m[1]}${m[2]}${frac}`), s: frac.length };
  return scale === undefined ? value : round(value, scale);
}

export const ZERO = num("0");
export const add = (a: Num, b: Num): Num => ({ n: scaleUp(a, Math.max(a.s, b.s)) + scaleUp(b, Math.max(a.s, b.s)), s: Math.max(a.s, b.s) });
export const sub = (a: Num, b: Num): Num => add(a, { n: -b.n, s: b.s });
export const mul = (a: Num, b: Num): Num => ({ n: a.n * b.n, s: a.s + b.s });
export const cmp = (a: Num, b: Num) => Math.sign(Number(sub(a, b).n));
export const greatest = (a: Num, b: Num) => (cmp(a, b) >= 0 ? a : b);
export const least = (a: Num, b: Num) => (cmp(a, b) <= 0 ? a : b);

export function round(a: Num, s: number): Num {
  if (a.s <= s) return { n: scaleUp(a, s), s };
  return { n: roundDiv(a.n, 10n ** BigInt(a.s - s)), s };
}

/** Weight and first digit of the base-10000 digits Postgres stores, grouped from the decimal point. */
function firstGroup(a: Num): [number, number] {
  if (a.n === 0n) return [0, 0];
  const digits = abs(a.n).toString().padStart(a.s + 1, "0");
  let int = digits.slice(0, digits.length - a.s);
  let frac = digits.slice(digits.length - a.s);
  int = int.padStart(Math.ceil(int.length / 4) * 4, "0");
  frac = frac.padEnd(Math.ceil(frac.length / 4) * 4, "0");
  const groups = (int + frac).match(/.{4}/g)!.map(Number);
  const i = groups.findIndex((g) => g !== 0);
  return [int.length / 4 - 1 - i, groups[i]!];
}

/** numeric / numeric: at least 16 significant digits, never fewer decimals than either input. */
export function div(a: Num, b: Num): Num {
  const [w1, f1] = firstGroup(a);
  const [w2, f2] = firstGroup(b);
  let qweight = w1 - w2;
  if (f1 <= f2) qweight--;
  const rscale = Math.min(Math.max(16 - qweight * 4, a.s, b.s, 0), 1000);
  // (a.n / 10^a.s) / (b.n / 10^b.s), times 10^rscale
  const top = a.n * 10n ** BigInt(b.s + rscale);
  const bottom = b.n * 10n ** BigInt(a.s);
  return { n: roundDiv(bottom < 0n ? -top : top, abs(bottom)), s: rscale };
}

/** Cents in a value with at most two decimals. */
export function cents(a: Num): number {
  if (a.s > 2) throw new Error("more than two decimals");
  return Number(scaleUp(a, 2));
}

export interface SqlLine {
  quantity: string;
  unit_price: string;
  taxable: boolean;
  selected: boolean;
}

/** private.quote_totals() and private.promo_discount(), in the same order of operations. */
export function sqlQuoteTotals(lines: SqlLine[], q: { discount_amount: string; tax_rate: string; promo: { kind: string; value: string } | null }) {
  const price = (l: SqlLine) => num(l.unit_price, 2);
  const lineTotal = (l: SqlLine) => round(mul(num(l.quantity, 3), price(l)), 2);
  // coalesce(sum(round(quantity * unit_price, 2)) filter (where …), 0)
  const sum = (rows: SqlLine[]) => (rows.length ? rows.map(lineTotal).reduce(add) : ZERO);
  const selected = lines.filter((l) => l.selected);
  const charges = selected.filter((l) => cmp(price(l), ZERO) > 0);
  const vSub = sum(selected);
  const vTaxable = sum(selected.filter((l) => l.taxable));
  const vBase = sum(charges);
  const vBaseTaxable = sum(charges.filter((l) => l.taxable));

  let discountAmount = num(q.discount_amount, 2);
  if (q.promo) {
    const value = num(q.promo.value, 2);
    const promo = cmp(vBase, ZERO) <= 0 ? ZERO : q.promo.kind === "percent" ? round(div(mul(vBase, value), num("100")), 2) : least(value, vBase);
    discountAmount = round(promo, 2); // assigned to numeric(12, 2)
  }
  const vDiscount = least(discountAmount, greatest(vSub, ZERO));
  const share = cmp(vBase, ZERO) > 0 ? div(mul(vDiscount, vBaseTaxable), vBase) : ZERO;
  // tax_rate is numeric(8, 6) (20261019001000_tax_rate_precision.sql).
  const tax = round(mul(greatest(sub(vTaxable, share), ZERO), num(q.tax_rate, 6)), 2);
  const total = add(greatest(sub(vSub, vDiscount), ZERO), tax);
  return { subtotal: cents(vSub), discount: cents(vDiscount), tax: cents(tax), total: cents(total) };
}
