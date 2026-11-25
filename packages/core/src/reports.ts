/**
 * The business's figures, worked out the same way on the Finance page (apps/web/src/features/
 * finance) and for AI assistants (the report tools): date ranges in the company's time zone, and
 * pure sums over the rows each report reads. Money is in dollars, rounded to the cent where it's
 * shown; hours are decimal hours.
 */
import { isUnpaidBreak, type BreakPay } from "./breaks";
import { lineTotal } from "./money";
import { lineParts } from "./paving";
import { addDays, zonedTimeToUtc } from "./time";

export const REPORT_PRESETS = [
  { key: "month", label: "This month" },
  { key: "last_month", label: "Last month" },
  { key: "30d", label: "Last 30 days" },
  { key: "90d", label: "Last 90 days" },
  { key: "quarter", label: "This quarter" },
  { key: "last_quarter", label: "Last quarter" },
  { key: "year", label: "This year" },
  { key: "last_year", label: "Last year" },
  { key: "custom", label: "Custom" },
] as const;
export type ReportPreset = (typeof REPORT_PRESETS)[number]["key"];

export interface ReportRange {
  key: ReportPreset;
  label: string;
  /** Inclusive local dates (YYYY-MM-DD). */
  from: string;
  to: string;
  /** The same window as UTC instants, for timestamp columns: [start, end). */
  start: string;
  end: string;
  days: number;
}

const iso = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);
const shortDate = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
/** A date's year and month (1–12) and day. */
const parts = (d: string) => d.split("-").map(Number) as [number, number, number];

/** How many whole calendar months a range is when it's exactly one month, quarter or year: 1, 3 or 12. */
function calendarMonths(from: string, to: string): 1 | 3 | 12 | null {
  const [y, m, d] = parts(from);
  if (d !== 1) return null;
  return ([1, 3, 12] as const).find((n) => (m - 1) % n === 0 && to === iso(y, m - 1 + n, 0)) ?? null;
}

/** A range that's a whole month, quarter or year, as it's said: "October 2026", "Q3 2026", "2025". Null for any other. */
export function calendarWords(from: string, to: string): string | null {
  const months = calendarMonths(from, to);
  const [y, m] = parts(from);
  if (months === 12) return String(y);
  if (months === 3) return `Q${(m + 2) / 3} ${y}`;
  if (months === 1) return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  return null;
}

export function resolveRange(key: ReportPreset, today: string, tz: string, custom?: { from?: string | null; to?: string | null }): ReportRange {
  const [y, m] = today.split("-").map(Number) as [number, number];
  let from: string;
  let to = today;
  switch (key) {
    case "last_month":
      from = iso(y, m - 2, 1);
      to = iso(y, m - 1, 0);
      break;
    case "30d":
      from = addDays(today, -29);
      break;
    case "90d":
      from = addDays(today, -89);
      break;
    case "quarter":
      from = iso(y, Math.floor((m - 1) / 3) * 3, 1);
      break;
    case "last_quarter": {
      const start = Math.floor((m - 1) / 3) * 3;
      from = iso(y, start - 3, 1);
      to = iso(y, start, 0);
      break;
    }
    case "year":
      from = iso(y, 0, 1);
      break;
    case "last_year":
      from = iso(y - 1, 0, 1);
      to = iso(y - 1, 11, 31);
      break;
    case "custom": {
      const valid = (s?: string | null) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);
      from = valid(custom?.from) ?? addDays(today, -29);
      to = valid(custom?.to) ?? today;
      if (to < from) [from, to] = [to, from];
      break;
    }
    default:
      from = iso(y, m - 1, 1);
  }
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
  return {
    key,
    label: key === "custom" ? (calendarWords(from, to) ?? `${shortDate(from)} – ${shortDate(to)}`) : REPORT_PRESETS.find((p) => p.key === key)!.label,
    from,
    to,
    start: zonedTimeToUtc(from, "00:00", tz).toISOString(),
    end: zonedTimeToUtc(addDays(to, 1), "00:00", tz).toISOString(),
    days,
  };
}

/** The calendar months each preset spans: "This month" counts as its whole month for stepping. */
const PRESET_MONTHS: Partial<Record<ReportPreset, 1 | 3 | 12>> = { month: 1, last_month: 1, quarter: 3, last_quarter: 3, year: 12, last_year: 12 };
const THIS: Record<1 | 3 | 12, ReportPreset> = { 1: "month", 3: "quarter", 12: "year" };
const LAST: Record<1 | 3 | 12, ReportPreset> = { 1: "last_month", 3: "last_quarter", 12: "last_year" };

/**
 * The range one step earlier (-1) or later (1), by its own length: a month, quarter or year (this
 * one so far, or a whole one) moves a calendar month, quarter or year; any other moves its number of
 * days. Where the step lands on a preset it's that preset ("Last month", "This quarter"), else a
 * custom range of its dates. Null going later from a range that already reaches today.
 */
export function stepRange(range: Pick<ReportRange, "key" | "from" | "to" | "days">, by: -1 | 1, today: string): { key: ReportPreset; from?: string; to?: string } | null {
  if (by > 0 && range.to >= today) return null;
  const months = PRESET_MONTHS[range.key] ?? (range.key === "custom" ? calendarMonths(range.from, range.to) : null);
  if (months) {
    const [y, m] = parts(range.from);
    const first = m - 1 + by * months;
    const from = iso(y, first, 1);
    const to = iso(y, first + months, 0);
    if (from <= today && today <= to) return { key: THIS[months] };
    const last = resolveRange(LAST[months], today, "UTC");
    return last.from === from && last.to === to ? { key: LAST[months] } : { key: "custom", from, to };
  }
  const from = addDays(range.from, by * range.days);
  const to = addDays(range.to, by * range.days);
  if (to < today) return { key: "custom", from, to };
  // Later as far as today: the same number of days, ending today.
  if (range.days === 30) return { key: "30d" };
  if (range.days === 90) return { key: "90d" };
  return { key: "custom", from: addDays(today, 1 - range.days), to: today };
}

/** The same length of time just before the range: for "vs previous period". */
export function previousRange(range: ReportRange): { from: string; to: string; start: string; end: string } {
  const length = Date.parse(range.end) - Date.parse(range.start);
  return {
    from: new Date(Date.parse(range.from) - range.days * 86_400_000).toISOString().slice(0, 10),
    to: addDays(range.from, -1),
    start: new Date(Date.parse(range.start) - length).toISOString(),
    end: range.start,
  };
}

export const hoursBetween = (start: string, end: string | null) => (end ? Math.max(0, (Date.parse(end) - Date.parse(start)) / 3_600_000) : 0);
const sum = <T>(rows: readonly T[], f: (r: T) => number) => rows.reduce((s, r) => s + (f(r) || 0), 0);
const cents = (n: number) => Math.round(n * 100) / 100;
/** Amounts of material: to the thousandth, as job_materials keeps them. */
const thousandths = (n: number) => Math.round(n * 1000) / 1000;
const percent = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);

// ---------------------------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------------------------

export interface OpenInvoiceRow { balance_due: number | string; due_on: string | null; client?: { id: string; display_name: string } | null }

/** Unpaid invoices by how late they are today. */
export function agingBuckets(open: readonly OpenInvoiceRow[], today: string) {
  const late = (due: string | null) => (due ? Math.floor((Date.parse(today) - Date.parse(due)) / 86_400_000) : 0);
  return [
    { key: "current", label: "Not yet due", test: (n: number) => n <= 0 },
    { key: "30", label: "1–30 days late", test: (n: number) => n >= 1 && n <= 30 },
    { key: "60", label: "31–60 days late", test: (n: number) => n >= 31 && n <= 60 },
    { key: "90", label: "61–90 days late", test: (n: number) => n >= 61 && n <= 90 },
    { key: "90+", label: "Over 90 days late", test: (n: number) => n > 90 },
  ].map((b) => {
    const rows = open.filter((i) => b.test(late(i.due_on)));
    return { key: b.key, label: b.label, count: rows.length, amount: cents(sum(rows, (i) => Number(i.balance_due))) };
  });
}

export interface PaymentRow { amount: number | string; tip_amount?: number | string | null; fee_amount?: number | string | null; method?: string; received_at: string }
export interface InvoiceRow { total: number | string; tax_amount?: number | string | null; issued_on: string | null }

/** Invoiced, collected, tips, fees, tax, what's owed and how late, by payment method and by client. */
export function moneyFigures(d: { invoices: readonly InvoiceRow[]; payments: readonly PaymentRow[]; open: readonly OpenInvoiceRow[] }, today: string) {
  const overdue = d.open.filter((i) => i.due_on && i.due_on < today);
  const methods = new Map<string, number>();
  for (const p of d.payments) methods.set(p.method ?? "other", (methods.get(p.method ?? "other") ?? 0) + Number(p.amount));
  const balances = new Map<string, { client_id: string; client: string; invoices: number; balance: number; oldest_due: string | null }>();
  for (const i of d.open) {
    if (!i.client) continue;
    const row = balances.get(i.client.id) ?? { client_id: i.client.id, client: i.client.display_name, invoices: 0, balance: 0, oldest_due: null };
    row.invoices++;
    row.balance = cents(row.balance + Number(i.balance_due));
    if (i.due_on && (!row.oldest_due || i.due_on < row.oldest_due)) row.oldest_due = i.due_on;
    balances.set(i.client.id, row);
  }
  return {
    invoiced: cents(sum(d.invoices, (i) => Number(i.total))),
    invoices: d.invoices.length,
    collected: cents(sum(d.payments, (p) => Number(p.amount))),
    payments: d.payments.length,
    tips: cents(sum(d.payments, (p) => Number(p.tip_amount ?? 0))),
    card_fees: cents(sum(d.payments, (p) => Number(p.fee_amount ?? 0))),
    sales_tax_billed: cents(sum(d.invoices, (i) => Number(i.tax_amount ?? 0))),
    outstanding_now: cents(sum(d.open, (i) => Number(i.balance_due))),
    past_due_now: cents(sum(overdue, (i) => Number(i.balance_due))),
    past_due_invoices: overdue.length,
    by_method: [...methods].map(([method, amount]) => ({ method, amount: cents(amount) })).sort((a, b) => b.amount - a.amount),
    client_balances: [...balances.values()].sort((a, b) => b.balance - a.balance),
    aging: agingBuckets(d.open, today),
  };
}

// ---------------------------------------------------------------------------------------------
// Sales
// ---------------------------------------------------------------------------------------------

export interface QuoteRow {
  status: string;
  total: number | string;
  sent_at: string | null;
  approved_at?: string | null;
  salesperson_id?: string | null;
  created_by?: string | null;
  lost_reason?: string | null;
  client?: { lead_source: string | null } | null;
}

const WON = ["approved", "converted"];

/** Quotes sent in the range: won, lost and waiting, conversion, by salesperson, by lead source, and why they were lost. */
export function salesFigures(d: { quotes: readonly QuoteRow[]; clients: ReadonlyArray<{ lead_source: string | null }> }, nameOf: (userId: string | null) => string) {
  const won = d.quotes.filter((q) => WON.includes(q.status));
  const lost = d.quotes.filter((q) => q.status === "lost");
  const open = d.quotes.filter((q) => ["sent", "changes_requested"].includes(q.status));
  const approvalDays = won.filter((q) => q.approved_at && q.sent_at).map((q) => (Date.parse(q.approved_at!) - Date.parse(q.sent_at!)) / 86_400_000);
  const people = new Map<string, { person: string; sent: number; won: number; won_value: number; sent_value: number }>();
  for (const q of d.quotes) {
    const id = q.salesperson_id ?? q.created_by ?? null;
    const row = people.get(id ?? "none") ?? { person: nameOf(id), sent: 0, won: 0, won_value: 0, sent_value: 0 };
    row.sent++;
    row.sent_value = cents(row.sent_value + Number(q.total));
    if (WON.includes(q.status)) {
      row.won++;
      row.won_value = cents(row.won_value + Number(q.total));
    }
    people.set(id ?? "none", row);
  }
  const source = (s: string | null | undefined) => s?.trim() || "Not recorded";
  const sources = new Map<string, { source: string; new_clients: number; quotes: number; won: number; won_value: number }>();
  const sourceRow = (key: string) => sources.get(key) ?? { source: key, new_clients: 0, quotes: 0, won: 0, won_value: 0 };
  for (const c of d.clients) {
    const row = sourceRow(source(c.lead_source));
    row.new_clients++;
    sources.set(row.source, row);
  }
  for (const q of d.quotes) {
    const row = sourceRow(source(q.client?.lead_source));
    row.quotes++;
    if (WON.includes(q.status)) {
      row.won++;
      row.won_value = cents(row.won_value + Number(q.total));
    }
    sources.set(row.source, row);
  }
  const reasons = new Map<string, number>();
  for (const q of lost) reasons.set(q.lost_reason?.trim() || "No reason given", (reasons.get(q.lost_reason?.trim() || "No reason given") ?? 0) + 1);
  return {
    sent: d.quotes.length,
    sent_value: cents(sum(d.quotes, (q) => Number(q.total))),
    won: won.length,
    won_value: cents(sum(won, (q) => Number(q.total))),
    lost: lost.length,
    awaiting_response: open.length,
    awaiting_value: cents(sum(open, (q) => Number(q.total))),
    conversion_percent: percent(won.length, d.quotes.length),
    average_quote: d.quotes.length ? cents(sum(d.quotes, (q) => Number(q.total)) / d.quotes.length) : null,
    average_days_to_approval: approvalDays.length ? Math.round((sum(approvalDays, (n) => n) / approvalDays.length) * 10) / 10 : null,
    by_salesperson: [...people.values()].sort((a, b) => b.won_value - a.won_value),
    by_lead_source: [...sources.values()].sort((a, b) => b.won_value - a.won_value),
    lost_reasons: [...reasons].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
  };
}

// ---------------------------------------------------------------------------------------------
// Job profit
// ---------------------------------------------------------------------------------------------

export interface CostedTime { id: string; job_id: string | null; user_id?: string; started_at: string; ended_at: string | null; approved_at?: string | null }

/**
 * The pay rate an entry is costed at: the one it was approved at, or (not approved yet) the
 * person's current rate, so a job's labor isn't free until its time is approved.
 */
export function laborRate(entry: CostedTime, approvedRates: Readonly<Record<string, number>>, currentRates: Readonly<Record<string, number>>): number {
  return approvedRates[entry.id] ?? (entry.user_id ? currentRates[entry.user_id] : undefined) ?? 0;
}

/**
 * A job line as job costs read it: unit_labor_cost is the labor estimate in its unit_cost. Its price
 * list item, unit and parts (what a paving calculator line is made of) are only needed to compare
 * logged materials with it (materialUse).
 */
export interface CostedLine {
  quantity: number | string;
  unit_cost: number | string | null;
  unit_labor_cost?: number | string | null;
  service_id?: string | null;
  name?: string | null;
  unit?: string | null;
  parts?: unknown;
}

/** A material logged on a job (job_materials): a load ticket, or what the crew used. */
export interface CostedMaterial { job_id?: string | null; service_id?: string | null; name: string; unit: string; quantity: number | string }

/** A job expense as job costs read it. in_line_costs: the office marked it as already in the line items' costs. */
export interface CostedExpense { job_id: string | null; amount: number | string; in_line_costs?: boolean | null }

/** One material on a job: what the lines estimated and what was logged. */
export interface MaterialUse {
  name: string;
  unit: string;
  /** Logged so far. */
  used: number;
  /** On the job's lines, in the same unit; null when the lines have no estimate to compare it with. */
  estimated: number | null;
  /** What one costs on the job's lines; null when the lines don't say. */
  unit_cost: number | null;
  estimated_cost: number | null;
  /** The logged amount at the lines' cost. Counted in the job's costs in place of estimated_cost. */
  actual_cost: number | null;
}

const sameText = (a: string | null | undefined, b: string | null | undefined) => (a ?? "").trim().toLowerCase() === (b ?? "").trim().toLowerCase();

/**
 * Logged materials against the job's lines. A material logged for a price list item that's on the
 * job, in the line's unit, is compared with those lines; one called what a paving calculator line's
 * material is called (a part: tons of top coat, gallons of tack), in its unit, with that part. For
 * each, the logged amount at the line's own cost takes the place of the estimate in the job's costs:
 * `adjustment` is the difference, added to the lines' costs. A material that's on none of the lines
 * (or in another unit) is listed with nothing to compare, and isn't counted: its cost may already be
 * inside a line's, and nothing says so.
 */
export function materialUse(lines: readonly CostedLine[], logged: readonly CostedMaterial[], actualLabor: boolean): { rows: MaterialUse[]; adjustment: number } {
  const groups = new Map<string, { service_id: string | null; name: string; unit: string; used: number }>();
  for (const m of logged) {
    const key = `${m.service_id ?? `name:${m.name.trim().toLowerCase()}`}|${m.unit.trim().toLowerCase()}`;
    const group = groups.get(key) ?? { service_id: m.service_id ?? null, name: m.name.trim(), unit: m.unit.trim(), used: 0 };
    group.used += Number(m.quantity);
    groups.set(key, group);
  }
  // What one of a line costs in materials: without its labor estimate once the job has labor of its own, as lineCosts counts it.
  const materialCost = (l: CostedLine) => Number(l.unit_cost ?? 0) - (actualLabor ? Math.min(Math.max(0, Number(l.unit_cost ?? 0)), Number(l.unit_labor_cost ?? 0)) : 0);
  let adjustment = 0;
  const rows = [...groups.values()].map((g): MaterialUse => {
    const mine = g.service_id ? lines.filter((l) => l.service_id === g.service_id && sameText(l.unit, g.unit) && Number(l.quantity) > 0) : [];
    let estimated = sum(mine, (l) => Number(l.quantity));
    let estimatedCost = sum(mine, (l) => Number(l.quantity) * materialCost(l));
    if (!mine.length) {
      // A paving calculator line's materials, by what the calculator calls them.
      const parts = lines.flatMap((l) => lineParts(l.parts).filter((p) => p.material && p.quantity > 0 && sameText(p.name, g.name) && sameText(p.unit, g.unit)).map((p) => ({ quantity: p.quantity * Number(l.quantity), cost: p.unit_cost })));
      estimated = sum(parts, (p) => p.quantity);
      estimatedCost = sum(parts, (p) => p.quantity * p.cost);
    }
    if (!(estimated > 0)) return { name: g.name, unit: g.unit, used: thousandths(g.used), estimated: null, unit_cost: null, estimated_cost: null, actual_cost: null };
    const unitCost = estimatedCost / estimated;
    const actual = g.used * unitCost;
    adjustment += actual - estimatedCost;
    return { name: g.name, unit: g.unit, used: thousandths(g.used), estimated: thousandths(estimated), unit_cost: cents(unitCost), estimated_cost: cents(estimatedCost), actual_cost: cents(actual) };
  });
  return { rows: rows.sort((a, b) => Number(b.estimated !== null) - Number(a.estimated !== null) || a.name.localeCompare(b.name)), adjustment: cents(adjustment) };
}

/** A job's expenses as its costs count them: one marked as already in the line items' costs isn't counted again. */
export function expenseCosts(expenses: ReadonlyArray<Pick<CostedExpense, "amount" | "in_line_costs">>) {
  return { counted: sum(expenses, (e) => (e.in_line_costs ? 0 : Number(e.amount))), in_lines: sum(expenses, (e) => (e.in_line_costs ? Number(e.amount) : 0)) };
}

/**
 * A job's line costs. Once the job has labor of its own that costs something (time on it at a rate,
 * or sub and crew pay), each line counts without the labor estimate its cost has in it, so that labor
 * isn't counted twice. Time that costs nothing yet (no rate, or a clock still running) doesn't count.
 */
export function lineCosts(lines: readonly CostedLine[], actualLabor: boolean) {
  const full = sum(lines, (l) => Number(l.quantity) * Number(l.unit_cost ?? 0));
  const labor = actualLabor ? sum(lines, (l) => Number(l.quantity) * Math.min(Math.max(0, Number(l.unit_cost ?? 0)), Number(l.unit_labor_cost ?? 0))) : 0;
  return { materials: full - labor, left_out: labor };
}

/** What a job's time costs: each entry's hours at the rate it's costed at. A clock still running costs nothing yet. */
export const laborCost = (time: readonly CostedTime[], rateOf: (entry: CostedTime) => number) => sum(time, (t) => hoursBetween(t.started_at, t.ended_at) * rateOf(t));

/** One job's costs as jobCost reads them: its own rows, already picked out. */
export interface JobCostInput {
  /** The job's price: its contract total. */
  price: number;
  lines: readonly CostedLine[];
  /** Time on the job at its rates (laborCost). */
  labor: number;
  /** Sub and crew pay that's agreed, done or paid (public.job_pay_costs): one row per job pay, nothing when there's none. */
  crewPay: ReadonlyArray<{ amount: number | string | null }>;
  expenses: ReadonlyArray<Pick<CostedExpense, "amount" | "in_line_costs">>;
  /** Materials logged on the job (job_materials). */
  logged?: readonly CostedMaterial[];
  /**
   * Extra work on a repeating job's visits (visitExtras.ts costedExtras): what it's billed at, on top
   * of the price, and its lines, costed as the job's are.
   */
  extras?: { price: number; lines: readonly CostedLine[] };
}

/**
 * A job's costs and profit: the one calculation behind the job page, Finance → Profit and Services,
 * AI assistants' job_profit and the office's job profit alerts. Costs are the lines at cost, labor
 * (time at its rates), sub and crew pay, and expenses. Once a job has labor of its own that costs
 * something (time at a rate, or sub and crew pay), its lines count without the labor estimate their
 * cost has in it, so that labor isn't counted twice. A material logged against a line counts at the
 * logged amount in place of the line's estimate (materialUse), and an expense marked as already in the
 * line items' costs isn't added on top of them. Amounts aren't rounded: each screen rounds as it shows.
 */
export function jobCost(input: JobCostInput) {
  const crew = sum(input.crewPay, (p) => Number(p.amount ?? 0));
  const actualLabor = input.labor > 0 || input.crewPay.length > 0;
  const lines = lineCosts([...input.lines, ...(input.extras?.lines ?? [])], actualLabor);
  const logged = materialUse(input.lines, input.logged ?? [], actualLabor);
  const spent = expenseCosts(input.expenses);
  const materials = lines.materials + logged.adjustment;
  const cost = materials + input.labor + crew + spent.counted;
  const extras = input.extras?.price ?? 0;
  const price = input.price + extras;
  const profit = price - cost;
  return {
    /** The price with extra work: what the costs are set against. */
    price,
    /** What extra work on visits is billed at (counted in `price`). */
    extras,
    /** The lines at cost (without their labor estimate when the job has labor of its own), with logged materials in place of their estimate. */
    materials,
    /** The lines' labor estimate, left out because the job has labor of its own (0 when it hasn't). */
    left_out: lines.left_out,
    labor: input.labor,
    crew,
    /** Expenses that count: not those marked as already in the line items' costs. */
    expenses: spent.counted,
    expenses_in_lines: spent.in_lines,
    actual_labor: actualLabor,
    /** Each logged material against the lines' estimate for it. */
    material_rows: logged.rows,
    /** What logged materials changed the lines' costs by. */
    material_adjustment: logged.adjustment,
    cost,
    profit,
    /** Profit as a percent of the price, unrounded; null without a price. */
    margin: price > 0 ? (profit / price) * 100 : null,
    /** Whether anything has actually been spent on it yet: time at a rate, sub or crew pay, an expense or a logged material. */
    has_actual_costs: actualLabor || input.expenses.length > 0 || (input.logged?.length ?? 0) > 0,
  };
}
export type JobCost = ReturnType<typeof jobCost>;

/** One job's own rows, as they're read from the database, before anything is added up. */
export interface JobCostRows {
  /** The job's price: its contract total. */
  price: number;
  lines: readonly CostedLine[];
  /** The time on the job (time_entries). A clock still running costs nothing yet. */
  time: ReadonlyArray<Pick<CostedTime, "id" | "started_at" | "ended_at">>;
  /** The rate each of those entries is costed at, by entry id (the server's timeRates). One with no rate costs nothing. */
  rates: Readonly<Record<string, number>>;
  /** The job's expenses (expenses), each with whether it's already in the line items' costs. */
  expenses: ReadonlyArray<Pick<CostedExpense, "amount" | "in_line_costs">>;
  /** Materials logged on the job (job_materials). */
  logged?: readonly CostedMaterial[];
  /** What public.job_pay_costs says its sub and crew pay costs (the hourly check: job_pay_costs_for_check, the same sum): nothing when there's none. */
  pay: ReadonlyArray<{ amount: number | string | null }>;
  extras?: JobCostInput["extras"];
}

/**
 * A job's costs from its own rows: the one way they're put together, for the job page and for the
 * hourly profit check alike, so the page that warns "below your margin" and the check that tells
 * people about it can't disagree. Time is costed at its rates, pay as the database sums it, and
 * the rest is jobCost.
 */
export function costJobRows(rows: JobCostRows): JobCost {
  return jobCost({
    price: rows.price,
    lines: rows.lines,
    labor: laborCost(rows.time as readonly CostedTime[], (entry) => rows.rates[entry.id] ?? 0),
    crewPay: rows.pay,
    expenses: rows.expenses,
    logged: rows.logged,
    extras: rows.extras,
  });
}

// ---------------------------------------------------------------------------------------------
// Job profit alerts
// ---------------------------------------------------------------------------------------------

/**
 * The company's "Tell me when a job's profit falls below X%" (settings.profit_alert_percent): a whole
 * percent from 1 to 99, or null when it's off.
 */
export function profitAlertPercent(settings: unknown): number | null {
  const value = Number((settings as { profit_alert_percent?: unknown } | null)?.profit_alert_percent);
  return Number.isInteger(value) && value >= 1 && value <= 99 ? value : null;
}

/**
 * Whether a job is below the company's line: a one-off job (a repeating job's price is for a visit or
 * a month, so its profit over its life can't be set against it) with a price and something actually
 * spent on it, whose margin, as the job page shows it (a whole percent), is under the line.
 */
export function belowProfitLine(job: { kind: string }, cost: Pick<JobCost, "price" | "margin" | "has_actual_costs">, percent: number | null): boolean {
  if (percent === null || job.kind === "recurring" || !(cost.price > 0) || !cost.has_actual_costs || cost.margin === null) return false;
  return Math.round(cost.margin) < percent;
}

/**
 * What the hourly check does with one job: whether it's below the line now, and whether to tell the
 * office. They're told once as a job goes below, and not again until it has come back up and gone
 * below again. Right after the line changes (`quiet`), jobs already below it are only listed (the
 * Jobs page's Below your margin), not told about one by one.
 */
export function profitAlertDecision(wasBelow: boolean, below: boolean, quiet: boolean): { below: boolean; tell: boolean } {
  return { below, tell: below && !wasBelow && !quiet };
}

/** The alert's words: "Job #12 for Maria Lopez is at 8% profit, below your 20%". */
export function profitAlertText(job: { number: number | null; client: string | null }, margin: number, percent: number): string {
  const who = job.client?.trim() ? ` for ${job.client.trim()}` : "";
  return `Job #${job.number ?? "?"}${who} is at ${Math.round(margin)}% profit, below your ${percent}%`;
}

/** Rows of many jobs, each job's own by its id. */
function byJob<T extends { job_id?: string | null }>(rows: readonly T[]): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    if (!r.job_id) continue;
    const mine = out.get(r.job_id);
    if (mine) mine.push(r);
    else out.set(r.job_id, [r]);
  }
  return out;
}

/**
 * Each job's revenue (contract total), costs and profit, as jobCost works them out. `crewPay`: job
 * pay that's agreed, done or paid, from public.job_pay_costs; `materials`: the jobs' job_materials rows.
 */
export function jobProfit(
  jobs: ReadonlyArray<{ id: string; number?: number | null; title: string; client?: { display_name: string } | null; financials?: { contract_total: number | string | null } | null; lines: readonly CostedLine[] }>,
  time: readonly CostedTime[],
  expenses: readonly CostedExpense[],
  rateOf: (entry: CostedTime) => number,
  marginTarget: number | null = null,
  crewPay: ReadonlyArray<{ job_id: string; amount: number | string | null }> = [],
  materials: readonly CostedMaterial[] = [],
) {
  const [times, pays, spends, logs] = [byJob(time), byJob(crewPay), byJob(expenses), byJob(materials)];
  const costed = jobs.map((j) => {
    const c = jobCost({
      price: Number(j.financials?.contract_total ?? 0),
      lines: j.lines,
      labor: laborCost(times.get(j.id) ?? [], rateOf),
      crewPay: pays.get(j.id) ?? [],
      expenses: spends.get(j.id) ?? [],
      logged: logs.get(j.id) ?? [],
    });
    return {
      id: j.id,
      number: j.number ?? null,
      title: j.title,
      client: j.client?.display_name ?? "",
      revenue: cents(c.price),
      labor: cents(c.labor),
      crew_pay: cents(c.crew),
      expenses: cents(c.expenses),
      /** Expenses marked as already in the line items' costs, so not in `expenses` or `cost`. */
      expenses_in_line_costs: cents(c.expenses_in_lines),
      materials: cents(c.materials),
      /** What logged materials changed `materials` by: their cost at the lines' rates, less the lines' estimate for them. */
      logged_materials_adjustment: c.material_adjustment,
      /** The lines' labor estimate, left out because the job has labor of its own (0 when it hasn't). */
      line_labor_left_out: cents(c.left_out),
      actual_labor: c.actual_labor,
      cost: cents(c.cost),
      profit: cents(c.profit),
      margin_percent: c.price > 0 ? Math.round((c.profit / c.price) * 1000) / 10 : null,
    };
  });
  const revenue = sum(costed, (j) => j.revenue);
  const profit = sum(costed, (j) => j.profit);
  return {
    jobs: costed,
    revenue: cents(revenue),
    profit: cents(profit),
    margin_percent: percent(profit, revenue),
    margin_target: marginTarget,
    below_target: marginTarget ? costed.filter((j) => j.margin_percent !== null && j.margin_percent < marginTarget).map((j) => j.id) : [],
  };
}

// ---------------------------------------------------------------------------------------------
// Revenue and profit by service
// ---------------------------------------------------------------------------------------------

/** An invoice line, with the invoice fields revenue by service reads. */
export interface ServiceLineRow {
  service_id: string | null;
  name: string;
  quantity: number | string;
  unit_price: number | string;
  invoice: { id: string; job_id: string | null; kind: string; status: string; issued_on: string; discount_amount: number | string | null; credit_amount: number | string | null } | null;
}
export interface ServiceItem { id: string; name: string; category: string | null; unit_cost: number | string | null; labor_cost: number | string | null }
export interface ServiceLine { key: string; item: ServiceItem | null; job_id: string | null; issued_on: string; quantity: number; revenue: number }

/** Deposit, progress and retainage invoices bill work the job's other invoices list in full. */
const PART_BILLINGS = ["deposit", "progress", "retainage"];
// shortcut: found by the name create_invoice_for_job gives them, so a renamed one counts as a discount; upgrade if these lines get a kind.
const PRIOR_BILLING = /^Less (deposit|progress billing) \(invoice #/;

/**
 * Each sold line's revenue: its amount before tax, less its share (by amount) of the invoice's
 * discounts and credits: negative lines, the promo discount and referral credits. The line that
 * takes earlier deposits off a final invoice isn't a discount. A line bills the price list item it
 * links to, or else the one with its exact name (visit invoices made before
 * 20261106000530_visit_lines_keep_service.sql, lines typed in, Jobber's); the rest are
 * "other". Drafts, voided invoices and part billings (PART_BILLINGS) don't count.
 */
export function serviceLines(rows: readonly ServiceLineRow[], items: readonly ServiceItem[]): ServiceLine[] {
  const byId = new Map(items.map((s) => [s.id, s]));
  const byName = new Map<string, ServiceItem>();
  for (const s of items) if (!byName.has(s.name.trim().toLowerCase())) byName.set(s.name.trim().toLowerCase(), s);
  const invoices = new Map<string, ServiceLineRow[]>();
  for (const r of rows) {
    if (!r.invoice || r.invoice.status === "draft" || r.invoice.status === "void" || PART_BILLINGS.includes(r.invoice.kind)) continue;
    const lines = invoices.get(r.invoice.id) ?? [];
    lines.push(r);
    invoices.set(r.invoice.id, lines);
  }
  const out: ServiceLine[] = [];
  for (const lines of invoices.values()) {
    const invoice = lines[0]!.invoice!;
    const amounts = lines.map((l) => lineTotal(l.quantity, l.unit_price));
    const sold = sum(amounts, (a) => Math.max(a, 0));
    // As invoice_totals caps them: the promo discount at the subtotal, credits are already capped.
    let off = Math.min(Number(invoice.discount_amount ?? 0), Math.max(sum(amounts, (a) => a), 0)) + Number(invoice.credit_amount ?? 0);
    lines.forEach((l, n) => { if (amounts[n]! < 0 && !PRIOR_BILLING.test(l.name)) off -= amounts[n]!; });
    const kept = sold > 0 ? Math.max(0, sold - off) / sold : 0;
    lines.forEach((l, n) => {
      if (amounts[n]! <= 0) return;
      const item = (l.service_id && byId.get(l.service_id)) || byName.get(l.name.trim().toLowerCase()) || null;
      out.push({ key: item?.id ?? "other", item, job_id: invoice.job_id, issued_on: invoice.issued_on, quantity: Number(l.quantity), revenue: amounts[n]! * kept });
    });
  }
  return out;
}

/**
 * Revenue by price list item for the invoice lines in `rows` (serviceLines' rules), and with `costs`,
 * what each cost and made. A line costs its item's unit cost (without the labor in it once the job
 * has labor of its own, as jobProfit counts lines) and a share of its job's labor (time at its
 * rates, and sub and crew pay) and expenses. Time and expenses aren't logged against a line, so the
 * job's are split by each line's share of everything the job's been invoiced (`costs.jobLines`:
 * every line on the job's invoices, whenever they were issued). As jobProfit and the job page count
 * them: an expense marked as already in the line items' costs isn't counted again, and what logged
 * materials came to over or under the job's estimate (`costs.costLines`: the jobs' own lines, and
 * `costs.materials`: what was logged on them; materialUse) is split the same way as its expenses.
 */
export function serviceFigures(
  rows: readonly ServiceLineRow[],
  items: readonly ServiceItem[],
  costs?: {
    jobLines: readonly ServiceLineRow[];
    time: readonly CostedTime[];
    expenses: readonly CostedExpense[];
    rateOf: (entry: CostedTime) => number;
    crewPay?: ReadonlyArray<{ job_id: string; amount: number | string | null }>;
    costLines?: ReadonlyArray<CostedLine & { job_id: string }>;
    materials?: readonly CostedMaterial[];
  },
) {
  const lines = serviceLines(rows, items);
  const jobs = new Map<string, { invoiced: number; inRange: number; labor: number; spent: number; actual: boolean }>();
  const job = (id: string) => jobs.get(id) ?? jobs.set(id, { invoiced: 0, inRange: 0, labor: 0, spent: 0, actual: false }).get(id)!;
  if (costs) {
    for (const l of lines) if (l.job_id) job(l.job_id).inRange += l.revenue;
    for (const l of serviceLines(costs.jobLines, items)) if (l.job_id && jobs.has(l.job_id)) job(l.job_id).invoiced += l.revenue;
    // Each job's own costs as jobCost counts them. Its lines are only read to set logged materials
    // against: what they came to over or under the job's estimate goes with the job's other costs
    // that aren't any one line's.
    const [times, pays, spends, logs, costLines] = [byJob(costs.time), byJob(costs.crewPay ?? []), byJob(costs.expenses), byJob(costs.materials ?? []), byJob(costs.costLines ?? [])];
    for (const [id, j] of jobs) {
      const c = jobCost({ price: 0, lines: costLines.get(id) ?? [], labor: laborCost(times.get(id) ?? [], costs.rateOf), crewPay: pays.get(id) ?? [], expenses: spends.get(id) ?? [], logged: logs.get(id) ?? [] });
      j.labor = c.labor + c.crew;
      j.actual = c.actual_labor;
      j.spent = c.expenses + c.material_adjustment;
    }
  }
  const services = new Map<string, { service_id: string | null; name: string; category: string | null; count: number; quantity: number; revenue: number; item_costs: number; labor: number; expenses: number }>();
  for (const l of lines) {
    const row = services.get(l.key) ?? { service_id: l.item?.id ?? null, name: l.item?.name ?? "Other", category: l.item?.category ?? null, count: 0, quantity: 0, revenue: 0, item_costs: 0, labor: 0, expenses: 0 };
    row.count++;
    row.quantity += l.quantity;
    row.revenue += l.revenue;
    if (costs) {
      const j = l.job_id ? jobs.get(l.job_id) : undefined;
      // The job's whole invoiced amount, at least what's in this period (in case jobLines missed some).
      const whole = j ? Math.max(j.invoiced, j.inRange) : 0;
      const share = whole > 0 ? l.revenue / whole : 0;
      row.item_costs += lineCosts([{ quantity: l.quantity, unit_cost: l.item?.unit_cost ?? null, unit_labor_cost: l.item?.labor_cost ?? null }], j?.actual ?? false).materials;
      row.labor += j ? j.labor * share : 0;
      row.expenses += j ? j.spent * share : 0;
    }
    services.set(l.key, row);
  }
  // Without `costs` they're unknown (null), not zero.
  const known = (n: number) => (costs ? cents(n) : null);
  const out = [...services.values()].map((s) => {
    const cost = s.item_costs + s.labor + s.expenses;
    return {
      ...s,
      quantity: Math.round(s.quantity * 1000) / 1000,
      revenue: cents(s.revenue),
      item_costs: known(s.item_costs),
      labor: known(s.labor),
      expenses: known(s.expenses),
      cost: known(cost),
      profit: known(s.revenue - cost),
      margin_percent: costs && s.revenue > 0 ? Math.round(((s.revenue - cost) / s.revenue) * 1000) / 10 : null,
    };
  });
  const revenue = sum(out, (s) => s.revenue);
  const profit = sum(out, (s) => s.profit ?? 0);
  return {
    revenue: cents(revenue),
    profit: known(profit),
    margin_percent: costs ? percent(profit, revenue) : null,
    services: out.sort((a, b) => b.revenue - a.revenue),
    /** Each line's revenue on its issue date, for charting a service over time. */
    lines,
  };
}

// ---------------------------------------------------------------------------------------------
// Team hours
// ---------------------------------------------------------------------------------------------

export interface TimeRow extends CostedTime { user_id: string; category: string; running?: boolean }

/**
 * Paid hours by person and category, what's on visits, what's waiting for approval, and labor
 * cost. Breaks count as the company pays them (`breaks`); the unpaid ones are left out of the
 * hours and cost but kept in by_category, and their total is unpaid_break_hours.
 */
export function teamHours(entries: readonly TimeRow[], nameOf: (userId: string) => string, rateOf: (entry: TimeRow) => number, breaks: BreakPay) {
  const paid = (e: TimeRow) => (isUnpaidBreak(e, breaks) ? 0 : hoursBetween(e.started_at, e.ended_at));
  const people = new Map<string, { user_id: string; name: string; total: number; visit: number; drive: number; other: number; approved: number; cost: number; running: boolean }>();
  for (const e of entries) {
    const h = paid(e);
    const row = people.get(e.user_id) ?? { user_id: e.user_id, name: nameOf(e.user_id), total: 0, visit: 0, drive: 0, other: 0, approved: 0, cost: 0, running: false };
    row.total += h;
    if (e.category === "visit" || e.category === "assessment") row.visit += h;
    else if (e.category === "drive") row.drive += h;
    else row.other += h;
    if (e.approved_at) row.approved += h;
    if (e.running) row.running = true;
    row.cost += h * rateOf(e);
    people.set(e.user_id, row);
  }
  const total = sum(entries, paid);
  const onVisits = sum(entries.filter((e) => e.category === "visit" || e.category === "assessment"), paid);
  const pending = sum(entries.filter((e) => !e.approved_at && !e.running), paid);
  const unpaidBreaks = sum(entries.filter((e) => isUnpaidBreak(e, breaks)), (e) => hoursBetween(e.started_at, e.ended_at));
  const categories = new Map<string, number>();
  for (const e of entries) categories.set(e.category, (categories.get(e.category) ?? 0) + hoursBetween(e.started_at, e.ended_at));
  const h = (n: number) => Math.round(n * 100) / 100;
  return {
    hours: h(total),
    on_visits_hours: h(onVisits),
    on_visits_percent: percent(onVisits, total),
    awaiting_approval_hours: h(pending),
    unpaid_break_hours: h(unpaidBreaks),
    labor_cost: cents(sum([...people.values()], (p) => p.cost)),
    by_person: [...people.values()].map((p) => ({ ...p, total: h(p.total), visit: h(p.visit), drive: h(p.drive), other: h(p.other), approved: h(p.approved), cost: cents(p.cost) })).sort((a, b) => b.total - a.total),
    by_category: [...categories].map(([category, hours]) => ({ category, hours: h(hours) })).sort((a, b) => b.hours - a.hours),
  };
}
