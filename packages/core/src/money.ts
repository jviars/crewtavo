/**
 * Money math that matches Postgres to the cent. The database works out quote and invoice totals
 * (private.quote_totals and invoice_totals); pages that show a total before it's saved, like the
 * Client Hub as a client picks options, use these so the number they see is the number stored.
 * Amounts are whole cents in BigInt, rounded the way numeric round() does: half away from zero.
 */

export type Amount = number | string | null | undefined;

export interface TotalsLine {
  quantity: Amount;
  unit_price: Amount;
  taxable?: boolean | null;
  /** Optional lines the client didn't choose are false. */
  selected?: boolean | null;
}

export interface TotalsPromo {
  kind: string; // 'percent' or 'amount'
  value: Amount;
}

const abs = (n: bigint) => (n < 0n ? -n : n);
const max = (a: bigint, b: bigint) => (a > b ? a : b);
const min = (a: bigint, b: bigint) => (a < b ? a : b);
const pow10 = (n: number) => 10n ** BigInt(n);

/** n / d rounded half away from zero (d > 0), as Postgres rounds numeric. */
function divRound(n: bigint, d: bigint): bigint {
  const q = (2n * abs(n) + d) / (2n * d);
  return n < 0n ? -q : q;
}

const DECIMAL = /^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i;

/**
 * A decimal as a whole number of 10^-scale units, rounded like a numeric(…, scale) column:
 * toUnits(1.5, 3) is 1500n. Reads the number as written (297.65, not its binary float).
 */
export function toUnits(value: Amount, scale: number): bigint {
  const m = DECIMAL.exec(String(value ?? "").trim());
  if (!m || !(m[2] || m[3])) return 0n;
  const digits = BigInt(`${m[2]}${m[3] ?? ""}` || "0");
  const shift = Number(m[4] ?? 0) - (m[3]?.length ?? 0) + scale;
  const units = shift >= 0 ? digits * pow10(shift) : divRound(digits, pow10(-shift));
  return m[1] === "-" ? -units : units;
}

const toDollars = (cents: bigint) => Number(cents) / 100;

/** Weight (in base-10000 digits) and first base-10000 digit of n * 10^-scale, as Postgres stores it. */
function leading(n: bigint, scale: number): [number, bigint] {
  if (n === 0n) return [0, 0n];
  const exp = abs(n).toString().length - 1 - scale;
  const weight = Math.floor(exp / 4);
  const shift = scale + 4 * weight;
  return [weight, shift >= 0 ? abs(n) / pow10(shift) : abs(n) * pow10(-shift)];
}

/**
 * Postgres numeric division of n1*10^-s1 by n2*10^-s2 (n2 > 0). It keeps at least 16 significant
 * digits and rounds there, which can decide a half cent later on (select_div_scale in numeric.c).
 * Returns the quotient as [units, scale].
 */
function pgDivide(n1: bigint, s1: number, n2: bigint, s2: number): [bigint, number] {
  const [w1, d1] = leading(n1, s1);
  const [w2, d2] = leading(n2, s2);
  const qweight = w1 - w2 - (d1 <= d2 ? 1 : 0);
  const scale = Math.min(Math.max(16 - qweight * 4, s1, s2, 0), 1000);
  const shift = s2 - s1 + scale;
  return [shift >= 0 ? divRound(n1 * pow10(shift), n2) : divRound(n1, n2 * pow10(-shift)), scale];
}

/** round(quantity * unit_price, 2) in cents. */
function lineCents(quantity: Amount, unitPrice: Amount): bigint {
  return divRound(toUnits(quantity, 3) * toUnits(unitPrice, 2), 1000n);
}

/** A line's total as the database rounds it: round(quantity * unit_price, 2). */
export function lineTotal(quantity: Amount, unitPrice: Amount): number {
  return toDollars(lineCents(quantity, unitPrice));
}

/** Whole cents in an amount, e.g. 12.5 -> 1250. */
export function toCents(value: Amount): number {
  return Number(toUnits(value, 2));
}

/**
 * Decimals a tax rate keeps as a fraction, as quotes.tax_rate and invoices.tax_rate do
 * (numeric(8, 6)): steps of 0.0001%, so New York City's 8.875% is 0.08875.
 */
const TAX_RATE_DECIMALS = 6;

/** A tax rate (a fraction, as stored) as a percent, exactly: 0.08875 is 8.875. */
export function taxPercent(rate: Amount): number {
  return Number(toUnits(rate, TAX_RATE_DECIMALS)) / 10 ** (TAX_RATE_DECIMALS - 2);
}

/** A percent as the tax rate to store, rounded as the column rounds it: 8.875 is 0.08875. */
export function taxRateFromPercent(percent: Amount): number {
  return Number(toUnits(percent, TAX_RATE_DECIMALS - 2)) / 10 ** TAX_RATE_DECIMALS;
}

const TIERS = ["Good", "Better", "Best"];

/**
 * "Good", "Better" and "Best" for the optional lines of each option group (lines that share one are
 * a single choice: the client picks one of them), cheapest first, when a group has two or three.
 */
export function optionLabels(lines: ReadonlyArray<{ id?: string; optional?: boolean; option_group?: string | null; quantity: Amount; unit_price: Amount }>): Map<string, string> {
  const labels = new Map<string, string>();
  const groups = new Map<string, Array<(typeof lines)[number]>>();
  for (const l of lines) if (l.id && l.optional && l.option_group) groups.set(l.option_group, [...(groups.get(l.option_group) ?? []), l]);
  for (const group of groups.values()) {
    if (group.length < 2 || group.length > 3) continue;
    [...group].sort((a, b) => lineTotal(a.quantity, a.unit_price) - lineTotal(b.quantity, b.unit_price)).forEach((l, i) => labels.set(l.id!, TIERS[i]));
  }
  return labels;
}

/**
 * A quote's totals, step for step as private.quote_totals() works them out: each line rounded to
 * the cent; a promo code's discount figured on the charges (lines with a positive price); the
 * discount spread over taxable and untaxed charges before tax; tax rounded to the cent.
 */
export function quoteTotals(lines: TotalsLine[], opts: { taxRate: Amount; discountAmount?: Amount; promo?: TotalsPromo | null }) {
  let sub = 0n;
  let taxable = 0n;
  let base = 0n;
  let baseTaxable = 0n;
  for (const l of lines) {
    if (l.selected === false) continue;
    const cents = lineCents(l.quantity, l.unit_price);
    const taxed = l.taxable !== false;
    sub += cents;
    if (taxed) taxable += cents;
    if (toUnits(l.unit_price, 2) > 0n) {
      base += cents;
      if (taxed) baseTaxable += cents;
    }
  }

  // private.promo_discount(): a percent of the charges, or a dollar amount up to them.
  let offered = toUnits(opts.discountAmount, 2);
  if (opts.promo) {
    const value = toUnits(opts.promo.value, 2);
    if (base <= 0n) offered = 0n;
    else if (opts.promo.kind === "percent") {
      const [units, scale] = pgDivide(base * value, 4, 100n, 0);
      offered = divRound(units, pow10(scale - 2));
    } else offered = min(value, base);
  }
  const discount = min(offered, max(sub, 0n));

  // round(greatest(taxable - discount * base_taxable / base, 0) * tax_rate, 2)
  const rate = toUnits(opts.taxRate, TAX_RATE_DECIMALS);
  let tax: bigint;
  if (base > 0n) {
    const [share, scale] = pgDivide(discount * baseTaxable, 4, base, 2);
    tax = divRound(max(taxable * pow10(scale - 2) - share, 0n) * rate, pow10(scale + TAX_RATE_DECIMALS - 2));
  } else {
    tax = divRound(max(taxable, 0n) * rate, pow10(TAX_RATE_DECIMALS));
  }
  const total = max(sub - discount, 0n) + tax;
  return { subtotal: toDollars(sub), discount: toDollars(discount), tax: toDollars(tax), total: toDollars(total) };
}

/**
 * A discount split into what comes off the taxed charges and what comes off the untaxed ones, in
 * proportion to them (the lines that count, priced above zero), as private.quote_totals spreads a
 * discount before tax: round(discount * taxed charges / charges, 2) off the taxed ones, the rest off
 * the untaxed. With no charges it all comes off the taxed. The database splits a discount into lines
 * this way too (carry_quote_discount for a job, quote_option_added when an estimate becomes option 1),
 * so the tax, and the total, don't move.
 */
export function discountSplit(discount: Amount, lines: readonly TotalsLine[]): { taxed: number; untaxed: number } {
  const off = toUnits(discount, 2);
  let base = 0n;
  let baseTaxable = 0n;
  for (const l of lines) {
    if (l.selected === false || toUnits(l.unit_price, 2) <= 0n) continue;
    const cents = lineCents(l.quantity, l.unit_price);
    base += cents;
    if (l.taxable !== false) baseTaxable += cents;
  }
  let taxed = off;
  if (base > 0n) {
    const [share, scale] = pgDivide(off * baseTaxable, 4, base, 2);
    taxed = divRound(share, pow10(scale - 2));
  }
  return { taxed: toDollars(taxed), untaxed: toDollars(off - taxed) };
}

// ---------------------------------------------------------------------------------------------
// Options: a quote that offers two or three (quote_options)
// ---------------------------------------------------------------------------------------------

/**
 * A quote line as the option math reads it. Lines with no option are on every option. The database
 * keeps the lines of options that aren't shown (quotes.option_id) unselected, and the shown option's
 * required lines selected, so its totals count `where selected` and still come out right.
 * `option_id` is required so a query that forgot to select it doesn't typecheck: without it, every
 * option's lines would read as shared.
 */
export interface OptionLine extends TotalsLine {
  /** The option it's on; null for a line on every option. */
  option_id: string | null;
  optional?: boolean | null;
}

type TotalsOptions = Parameters<typeof quoteTotals>[1];

/**
 * Whether a line counts while `shownOptionId` is the option shown: it's on every option or on that
 * one, and it isn't an add-on the customer left off. Everything that totals, prints or prices a quote
 * with options decides with this, so it agrees with the database's total. Lines with no option at
 * all (an invoice's, or a quote without options) count as they always have.
 */
export const countsOn = (line: { option_id?: string | null; optional?: boolean | null; selected?: boolean | null }, shownOptionId: string | null | undefined) =>
  (line.option_id == null || line.option_id === shownOptionId) && (!line.optional || line.selected !== false);

/**
 * Whether a line is part of an option's price before add-ons, which the price range is worked out
 * from (optionBaseTotal, and the lines saved with the range in estimates.ts snapshotLines): a shared
 * line that counts, or one of that option's required lines.
 */
export const inOptionBase = (line: { option_id?: string | null; optional?: boolean | null; selected?: boolean | null }, optionId: string | null) =>
  line.option_id == null ? countsOn(line, null) : line.option_id === optionId && !line.optional;

/**
 * The lines one option is made of: the shared ones and its own, picked the way they'd be with that
 * option shown. The shown option keeps the customer's add-on picks; another option starts with its
 * required lines on and its add-ons off, as the database sets them when that option becomes shown.
 */
export function optionLines<T extends OptionLine>(lines: readonly T[], optionId: string | null, shownOptionId: string | null | undefined): T[] {
  return lines
    .filter((l) => l.option_id == null || l.option_id === optionId)
    .map((l) => (l.option_id != null && optionId !== shownOptionId ? { ...l, selected: !l.optional } : l));
}

/** One option's totals, to the cent of what the database stores once that option is shown. */
export function optionTotals(lines: readonly OptionLine[], optionId: string | null, shownOptionId: string | null | undefined, opts: TotalsOptions) {
  return quoteTotals(
    optionLines(lines, optionId, shownOptionId).map((l) => ({ ...l, selected: countsOn(l, optionId) })),
    opts,
  );
}

/**
 * The totals once the customer signs for an option with these add-ons, as approve_hub_quote works
 * them out: it shows that option (its required lines on, its add-ons off), then picks the add-ons
 * that are shared or on that option, and only those. The Client Hub sends this total as the price
 * the homeowner agreed to, and the database turns the approval down when its own total differs.
 * `optionId` is null for a quote without options. A price set on site is a line on the option it
 * was set for (estimates.ts sitePriceAdjustment), so choosing another option doesn't count it.
 */
export function chosenTotals(
  lines: ReadonlyArray<OptionLine & { id: string }>,
  optionId: string | null,
  shownOptionId: string | null | undefined,
  pickedIds: readonly string[],
  opts: TotalsOptions,
) {
  const picked = new Set(pickedIds);
  return quoteTotals(
    optionLines(lines, optionId, shownOptionId).map((l) => ({ ...l, selected: l.optional ? picked.has(l.id) : true })),
    opts,
  );
}

/**
 * An option's total before any add-ons, for the price range: the shared lines as they're picked plus
 * the option's required lines. Which option is shown doesn't move it. Null for an option with no
 * required lines of its own yet (made before the roof was measured, or only add-ons), which a range
 * leaves out, so it can't pull the low end down to the shared lines alone.
 */
export function optionBaseTotal(lines: readonly OptionLine[], optionId: string | null, opts: TotalsOptions): number | null {
  if (optionId !== null && !lines.some((l) => l.option_id === optionId && !l.optional)) return null;
  const base = lines.filter((l) => inOptionBase(l, optionId)).map((l) => ({ ...l, selected: true }));
  return quoteTotals(base, opts).total;
}

/**
 * A quote's options in the order they're offered: cheapest first, with options that have no total
 * yet after the priced ones, each group in the order given. quote_options.sort and the Good, Better
 * and Best of optionTierLabels both follow it.
 */
export function optionTierOrder(options: ReadonlyArray<{ id: string; total: Amount }>): string[] {
  const priced = (o: { total: Amount }) => o.total !== null && o.total !== undefined && String(o.total).trim() !== "";
  return options
    .map((o, i) => ({ o, i, priced: priced(o) }))
    .sort((a, b) => Number(b.priced) - Number(a.priced) || (a.priced && b.priced ? toCents(a.o.total) - toCents(b.o.total) : 0) || a.i - b.i)
    .map(({ o }) => o.id);
}

/**
 * The tier word on each option's card. An option keeps its own tier ("Premium"). When a quote offers
 * two or three options and none has a tier of its own, they're "Good", "Better" and "Best" in the
 * order of optionTierOrder. When some have their own, the others get none, so the words never
 * repeat or run against the prices (a "Best" cheaper than the business's own "Good").
 */
export function optionTierLabels(options: ReadonlyArray<{ id: string; tier?: string | null; total: Amount }>): Map<string, string> {
  const labels = new Map<string, string>();
  for (const o of options) {
    const own = o.tier?.trim();
    if (own) labels.set(o.id, own);
  }
  if (!labels.size && options.length >= 2 && options.length <= 3) optionTierOrder(options).forEach((id, rank) => labels.set(id, TIERS[rank]));
  return labels;
}

/**
 * Currencies a business can pick (Settings → Company and sign-up), which is all the API takes when a
 * business is set up. Every one counts in hundredths, as the money columns and Stripe's amounts do:
 * one without cents (the yen) or with thousandths (the Kuwaiti dinar) can't be added here until
 * invoices and Stripe charges handle it (apps/api/src/services/stripe.ts cents).
 */
export const CURRENCIES = [
  { code: "USD", name: "US dollar" },
  { code: "CAD", name: "Canadian dollar" },
  { code: "AUD", name: "Australian dollar" },
  { code: "NZD", name: "New Zealand dollar" },
  { code: "GBP", name: "British pound" },
  { code: "EUR", name: "Euro" },
  { code: "ZAR", name: "South African rand" },
];

/** Whether a currency code is one a business can pick, in either case: "cad" is, "JPY" isn't. */
export const currencyOffered = (code: string | null | undefined) => CURRENCIES.some((c) => c.code === String(code ?? "").toUpperCase());

/** The symbols that aren't "$", by currency (a space after a letter, as "R 1,250.00" is written). */
const PREFIXES: Readonly<Record<string, string>> = { GBP: "£", EUR: "€", ZAR: "R " };

/**
 * What goes before an amount in words written out the same wherever they're made: what a client
 * signs ({Total}, {Deposit}), agrees to (autopay's bank account paragraph) and what a sub is offered.
 * The symbol people there write, as a screen shows it: "$" for every dollar (US, Canadian, Australian,
 * New Zealand), "£", "€", "R " for rand. The database's private.money_prefix says the same.
 */
export const moneyPrefix = (currency?: string | null) => PREFIXES[String(currency ?? "").trim().toUpperCase()] ?? "$";

/**
 * Why a payment can't be recorded against an invoice's balance, or null: it has to be more than
 * zero and not more than what's owed (a refund is a payment of its own, recorded in Crewtavo).
 */
export function paymentProblem(amount: number, balance: number, currency = "USD"): string | null {
  if (!(amount > 0)) return "Enter an amount greater than zero.";
  if (amount > balance + 0.005) return `That's more than the ${new Intl.NumberFormat("en-US", { style: "currency", currency, currencyDisplay: "narrowSymbol" }).format(balance)} balance.`;
  return null;
}

// ---------------------------------------------------------------------------------------------
// Payment schedules (quotes.payment_schedule). The database's private.schedule_amounts and
// private.schedule_fits do the same sums, and are what's kept with an approval.
// ---------------------------------------------------------------------------------------------

/**
 * When a payment in a quote's schedule is due: as the client approves (the deposit), on a date,
 * when the work starts (the job's first visit goes in progress), when the work is done (the job's
 * final invoice), or when the office invoices it by hand.
 */
export const SCHEDULE_DUE = ["approval", "date", "work_starts", "work_done", "by_hand"] as const;
export type ScheduleDue = (typeof SCHEDULE_DUE)[number];
/** A payment as a percent of the total, a dollar amount, or (the last one only) the rest. */
export type ScheduleKind = "percent" | "amount" | "rest";

export interface ScheduleRow {
  kind: ScheduleKind;
  /** The percent (above 0, up to 100) or the amount; null for the rest. */
  value?: Amount;
  due: ScheduleDue;
  /**
   * The day, for a payment due on a date (YYYY-MM-DD). A copy or a quote from a template has none
   * until it's set again, and a quote can't be sent without it.
   */
  on?: string | null;
  /**
   * In place of a day: the payment is due this many days (1 to 365) after the quote is approved.
   * Approving works the day out and keeps it as `on`.
   */
  after?: number | null;
}

/** The most days after approval a payment can be due. */
export const SCHEDULE_AFTER_MAX = 365;

/** The most payments a schedule has. */
export const SCHEDULE_MAX = 12;

/** Each payment in dollars, and whether the schedule fits the total. */
export interface ScheduleSums<T extends ScheduleRow = ScheduleRow> {
  rows: Array<T & { amount: number }>;
  /** It comes to the total exactly (ending with "the rest": it leaves at least a cent for it). */
  fits: boolean;
  /** What's still to place, negative when it's over. 0 when it ends with the rest and there's some left for it. */
  left: number;
}

/** A schedule's rows as stored, or none: anything that isn't an array of objects reads as no schedule. */
export function scheduleRows(value: unknown): ScheduleRow[] {
  return Array.isArray(value) ? (value.filter((r) => r && typeof r === "object" && !Array.isArray(r)) as ScheduleRow[]) : [];
}

/**
 * Each payment's amount for a total, to the cent as the database works it out: a percent is
 * round(total × percent / 100, 2), an amount is itself, and none is more than what's still left.
 * The last payment is what's left, so the payments always come to the total; when the schedule
 * fits, that only takes up a cent or two of rounding. It fits when the percents and amounts come to
 * the total exactly (within half a cent), or, ending with "the rest", leave at least a cent for it.
 */
export function scheduleAmounts<T extends ScheduleRow>(rows: readonly T[], total: Amount): ScheduleSums<T> {
  const totalCents = max(toUnits(total, 2), 0n);
  // What's left exactly, in ten-thousandths of a cent, so no rounding decides whether it fits.
  let exact = totalCents * 10_000n;
  let left = totalCents;
  const out: Array<T & { amount: number }> = [];
  rows.forEach((row, i) => {
    let raw = 0n;
    if (row.kind === "percent") {
      exact -= totalCents * toUnits(row.value, 2);
      raw = divRound(totalCents * toUnits(row.value, 2), 10_000n);
    } else if (row.kind === "amount") {
      exact -= toUnits(row.value, 2) * 10_000n;
      raw = toUnits(row.value, 2);
    }
    const cents = i === rows.length - 1 ? max(left, 0n) : min(max(raw, 0n), max(left, 0n));
    left -= cents;
    out.push({ ...row, amount: toDollars(cents) });
  });
  const rest = rows.at(-1)?.kind === "rest";
  const fits = rows.length > 0 && (rest ? exact >= 5_000n : abs(exact) < 5_000n);
  return { rows: out, fits, left: rest && exact >= 5_000n ? 0 : toDollars(divRound(exact, 10_000n)) };
}

/**
 * Said in the schedule editor. A schedule takes any share when they approve, and some states cap
 * what a contractor may take up front on home-improvement work: the limit is the business's to
 * know. California: a down payment "shall not exceed one thousand dollars ($1,000) or 10 percent of
 * the contract amount, whichever amount is less" (Bus. & Prof. Code 7159.5(a)(3)). Maryland: "A
 * person may not receive a deposit of more than one-third of the home improvement contract price
 * before or at the time of execution" (Bus. Reg. 8-617(b)).
 */
export const DEPOSIT_LAW_NOTE =
  "Some states cap the deposit on a home-improvement contract: California at $1,000 or 10% of the contract price, whichever is less, and Maryland at one-third of it, for example. Check your state's rules before you ask for more.";

/**
 * What's wrong with a schedule, in the editor's words (the database refuses to save it with the
 * same ones), or null. `total` is the quote's total, which the payments have to come to.
 */
export function scheduleProblem(rows: readonly ScheduleRow[], total: Amount, currency = "USD"): string | null {
  if (!rows.length) return null;
  const money = (n: number) => new Intl.NumberFormat("en-US", { style: "currency", currency, currencyDisplay: "narrowSymbol" }).format(n);
  if (rows.length > SCHEDULE_MAX) return `A payment schedule has ${SCHEDULE_MAX} payments at most.`;
  for (const [i, row] of rows.entries()) {
    const which = `Payment ${i + 1}`;
    if (!SCHEDULE_DUE.includes(row.due)) return `${which} needs to say when it's due.`;
    if (row.due === "date" && row.after != null) {
      if (!(Number.isInteger(Number(row.after)) && Number(row.after) >= 1 && Number(row.after) <= SCHEDULE_AFTER_MAX)) return `${which} needs a number of days, 1 to ${SCHEDULE_AFTER_MAX}.`;
    } else if (row.due === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(row.on ?? "")) return `${which} needs its date.`;
    if (row.kind === "rest" && i !== rows.length - 1) return "Only the last payment can be the rest.";
    if (row.kind === "percent" && !(Number(row.value) > 0 && Number(row.value) <= 100)) return `${which} needs a percent above 0, up to 100.`;
    if (row.kind === "amount" && !(Number(row.value) > 0 && Number(row.value) <= 100_000_000)) return `${which} needs an amount.`;
    if (row.kind !== "percent" && row.kind !== "amount" && row.kind !== "rest") return `${which} needs an amount.`;
  }
  if (rows.filter((r) => r.due === "approval").length > 1) return "Only one payment can be due when the quote is approved.";
  if (rows.filter((r) => r.due === "work_done").length > 1) return "Only one payment can be due when the work is done.";
  const sums = scheduleAmounts(rows, total);
  if (sums.fits) return null;
  if (rows.at(-1)?.kind === "rest") return "The payments before the last come to the whole total, so nothing is left for the rest.";
  return sums.left > 0 ? `The payments come to ${money(sums.left)} less than the total.` : `The payments come to ${money(-sums.left)} more than the total.`;
}

/**
 * Why a schedule can't go to the client as it is, or null: a dated payment with no day (a copy's or
 * a template's, to be set again), or one whose day is before `today` (YYYY-MM-DD where the company
 * is). The database refuses to mark the quote sent with the same words
 * (private.schedule_date_problem); `day` writes the date as "Mar 1, 2026".
 */
export function scheduleDateProblem(rows: readonly ScheduleRow[], today: string, day: (iso: string) => string): string | null {
  for (const [i, row] of rows.entries()) {
    if (row.due !== "date" || row.after != null) continue;
    if (!row.on) return `Payment ${i + 1} needs its date.`;
    if (row.on < today) return `Payment ${i + 1} is due on ${day(row.on)}, which has already passed. Give it a new date.`;
  }
  return null;
}

/** "Payment 2 of 3", as a schedule's payment is named on the job, its invoice and the office's notice. */
export const schedulePaymentName = (position: number, count: number) => `Payment ${position} of ${count}`;

/**
 * When a payment is due, in words: "When the quote is approved", "On Mar 3, 2027" (`day` writes the
 * date), "30 days after the quote is approved" until approving gives that one its day.
 */
export function scheduleDueText(row: Pick<ScheduleRow, "due" | "on" | "after">, day: (iso: string) => string): string {
  switch (row.due) {
    case "approval":
      return "When the quote is approved";
    case "date":
      if (row.on) return `On ${day(row.on)}`;
      return row.after != null ? `${row.after} ${Number(row.after) === 1 ? "day" : "days"} after the quote is approved` : "On a date";
    case "work_starts":
      return "When the work starts";
    case "work_done":
      return "When the work is done";
    default:
      return "When it's invoiced";
  }
}
