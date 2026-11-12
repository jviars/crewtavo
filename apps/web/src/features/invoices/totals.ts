/**
 * The Invoices screen's figures and its list of jobs ready to invoice, and Deposits' Stripe fees.
 * The sums are the database's (supabase/migrations/20261112000300_money_totals.sql): added up here
 * from rows, they went wrong without a word once a business had more rows than the API hands over
 * in one request. Lists are read to their end (lib/everyRow.ts).
 */
import { supabase, unwrap } from "@/lib/api";
import { everyRow } from "@/lib/everyRow";

export interface InvoiceTotals {
  owed: number;
  owedCount: number;
  late: number;
  lateCount: number;
  /** Money in over the past 30 days, and how many payments (refunds aren't counted). */
  collected: number;
  payments: number;
  /** The same 30 days ago: what was owed and past due then, and money in over the 30 days before. */
  before: { owed: number; pastDue: number; collected: number };
}

/** What's owed and past due, and what came in over the past 30 days, with each as it was 30 days ago. `today` is the company's date. */
export async function invoiceTotals(companyId: string, today: string): Promise<InvoiceTotals> {
  const row = unwrap(await supabase().rpc("invoice_summary", { p_company: companyId, p_today: today }).single());
  return {
    owed: Number(row.owed),
    owedCount: Number(row.owed_count),
    late: Number(row.past_due),
    lateCount: Number(row.past_due_count),
    collected: Number(row.collected),
    payments: Number(row.payments),
    before: { owed: Number(row.owed_before), pastDue: Number(row.past_due_before), collected: Number(row.collected_before) },
  };
}

/** What Stripe kept on the payments received since the start of `since` (a date). */
export async function stripeFeesSince(companyId: string, since: string): Promise<number> {
  return Number(unwrap(await supabase().rpc("stripe_fees", { p_company: companyId, p_since: `${since}T00:00:00` })));
}

export interface ReadyJob {
  id: string;
  number: number;
  title: string;
  kind: string;
  billing_mode: string;
  pricing: string | null;
  client: { display_name: string; email: string | null } | null;
  financials: { contract_total: number } | null;
  /** A monthly job's months due (their first days), each invoiced on its own. */
  months?: string[];
}

const READY_FIELDS = "id, number, title, kind, billing_mode, pricing, client:clients(display_name, email), financials:job_financials(contract_total)";

/**
 * Jobs waiting for their invoice: finished one-off jobs, per-visit jobs invoiced after each visit
 * with completed visits not yet billed, and monthly jobs whose month is due (due_invoices). Not ones
 * autopay is about to bill and charge (a charge waiting for the job, or being made): invoicing them
 * by hand would only call the charge off.
 */
export async function readyJobs(companyId: string): Promise<ReadyJob[]> {
  const db = supabase();
  const [finished, perVisit, charges, due] = await Promise.all([
    db.from("jobs").select(READY_FIELDS).eq("company_id", companyId).eq("status", "requires_invoicing").order("number").limit(200),
    // The database picks these out (jobs_with_visits_to_invoice): there are too many finished visits to read them all here.
    everyRow((from, to) => db.rpc("jobs_with_visits_to_invoice", { p_company: companyId }, { count: "exact" }).select(READY_FIELDS).order("number").order("id").range(from, to)),
    // A server without autopay yet has nothing waiting: the list stays as it was rather than failing.
    everyRow((from, to) =>
      db.from("autopay_charges").select("job_id", { count: "exact" }).eq("company_id", companyId).in("status", ["waiting", "charging"]).is("invoice_id", null).not("job_id", "is", null).order("id").range(from, to),
    ).catch(() => []),
    // A server without monthly billing yet has none due: the list stays as it was.
    everyRow((from, to) => db.from("due_invoices").select("job_id, month", { count: "exact" }).eq("company_id", companyId).order("month").order("id").range(from, to)).catch(() => []),
  ]);
  const charged = new Set(charges.map((c) => c.job_id));
  const ready = (unwrap(finished) as unknown as ReadyJob[]).filter((j) => !charged.has(j.id));
  ready.push(...(perVisit as unknown as ReadyJob[]).filter((j) => !charged.has(j.id) && !ready.some((r) => r.id === j.id)));
  const months = new Map<string, string[]>();
  for (const d of due) if (!charged.has(d.job_id)) months.set(d.job_id!, [...(months.get(d.job_id!) ?? []), d.month!]);
  if (months.size) {
    const monthly = unwrap(await db.from("jobs").select(READY_FIELDS).in("id", [...months.keys()]).eq("status", "active")) as unknown as ReadyJob[];
    ready.push(...monthly.map((j) => ({ ...j, months: months.get(j.id) })));
  }
  return ready;
}
