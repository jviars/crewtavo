/**
 * The business's figures, worked out the same way on the Finance page (apps/web/src/features/
 * finance) and for AI assistants (the report tools): date ranges in the company's time zone, and
 * pure sums over the rows each report reads. Money is in dollars, rounded to the cent where it's
 * shown; hours are decimal hours.
 */
import { addDays, zonedTimeToUtc } from "./time";

export const REPORT_PRESETS = [
  { key: "month", label: "This month" },
  { key: "last_month", label: "Last month" },
  { key: "30d", label: "Last 30 days" },
  { key: "90d", label: "Last 90 days" },
  { key: "quarter", label: "This quarter" },
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
    label: key === "custom" ? `${shortDate(from)} – ${shortDate(to)}` : REPORT_PRESETS.find((p) => p.key === key)!.label,
    from,
    to,
    start: zonedTimeToUtc(from, "00:00", tz).toISOString(),
    end: zonedTimeToUtc(addDays(to, 1), "00:00", tz).toISOString(),
    days,
  };
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

/** Each job's revenue (contract total), costs (labor, expenses and materials at cost) and profit. */
export function jobProfit(
  jobs: ReadonlyArray<{ id: string; number?: number | null; title: string; client?: { display_name: string } | null; financials?: { contract_total: number | string | null } | null; lines: ReadonlyArray<{ quantity: number | string; unit_cost: number | string | null }> }>,
  time: readonly CostedTime[],
  expenses: ReadonlyArray<{ job_id: string | null; amount: number | string }>,
  rateOf: (entry: CostedTime) => number,
  marginTarget: number | null = null,
) {
  const costed = jobs.map((j) => {
    const labor = sum(time.filter((t) => t.job_id === j.id), (t) => hoursBetween(t.started_at, t.ended_at) * rateOf(t));
    const spent = sum(expenses.filter((e) => e.job_id === j.id), (e) => Number(e.amount));
    const materials = sum(j.lines, (l) => Number(l.quantity) * Number(l.unit_cost ?? 0));
    const revenue = Number(j.financials?.contract_total ?? 0);
    const cost = labor + spent + materials;
    return {
      id: j.id,
      number: j.number ?? null,
      title: j.title,
      client: j.client?.display_name ?? "",
      revenue: cents(revenue),
      labor: cents(labor),
      expenses: cents(spent),
      materials: cents(materials),
      cost: cents(cost),
      profit: cents(revenue - cost),
      margin_percent: revenue > 0 ? Math.round(((revenue - cost) / revenue) * 1000) / 10 : null,
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
// Team hours
// ---------------------------------------------------------------------------------------------

export interface TimeRow extends CostedTime { user_id: string; category: string; running?: boolean }

/** Hours by person and category, what's on visits, what's waiting for approval, and labor cost. */
export function teamHours(entries: readonly TimeRow[], nameOf: (userId: string) => string, rateOf: (entry: TimeRow) => number) {
  const people = new Map<string, { user_id: string; name: string; total: number; visit: number; drive: number; other: number; approved: number; cost: number; running: boolean }>();
  for (const e of entries) {
    const h = hoursBetween(e.started_at, e.ended_at);
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
  const total = sum(entries, (e) => hoursBetween(e.started_at, e.ended_at));
  const onVisits = sum(entries.filter((e) => e.category === "visit" || e.category === "assessment"), (e) => hoursBetween(e.started_at, e.ended_at));
  const pending = sum(entries.filter((e) => !e.approved_at && !e.running), (e) => hoursBetween(e.started_at, e.ended_at));
  const categories = new Map<string, number>();
  for (const e of entries) categories.set(e.category, (categories.get(e.category) ?? 0) + hoursBetween(e.started_at, e.ended_at));
  const h = (n: number) => Math.round(n * 100) / 100;
  return {
    hours: h(total),
    on_visits_hours: h(onVisits),
    on_visits_percent: percent(onVisits, total),
    awaiting_approval_hours: h(pending),
    labor_cost: cents(sum([...people.values()], (p) => p.cost)),
    by_person: [...people.values()].map((p) => ({ ...p, total: h(p.total), visit: h(p.visit), drive: h(p.drive), other: h(p.other), approved: h(p.approved), cost: cents(p.cost) })).sort((a, b) => b.total - a.total),
    by_category: [...categories].map(([category, hours]) => ({ category, hours: h(hours) })).sort((a, b) => b.hours - a.hours),
  };
}
