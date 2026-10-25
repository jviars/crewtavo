/**
 * Job pay (supabase/migrations/20261025003001_job_pay.sql): a sub's price on a job and a team
 * member's piece pay. The office reads and changes rate cards, a pay's lines, the visits it covers and
 * its notes itself, under row-level security; starting pay with the lines its rates suggest, agreeing
 * it, marking the work done, cancelling it and marking it paid go through the database's functions,
 * called here as the person (they check who's asking again). Also each sub's totals for the year's
 * 1099 and the workers' comp audit (20261025003002_sub_pay_reports.sql), with their downloads.
 *
 * A sub's pay is for the office with the subs area; a team member's, with job costs (as pay periods,
 * which pay it: services/pay.ts).
 */
import { OFFICE, wcAuditCsv, wcAuditTotals, yearTotals, yearTotalsCsv, type Permission, type Role, type SubPayMethod, type SubYearTotalRow, type WcAuditRow } from "@crewtavo/core";
import { HttpError, must } from "../lib/http";
import type { Db } from "../lib/supabase";

export interface JobPayScope {
  db: Db;
  companyId: string;
  role: Role;
  permissions: readonly Permission[];
}

/** Whose pay: a sub's (subcontractor_id) or a team member's (user_id). */
export interface Payee {
  subcontractor_id?: string | null;
  user_id?: string | null;
}

const NOT_YOURS_SUB = "A sub's pay is for the office, with Subcontractors, their paperwork and pay. Ask an owner or admin.";
const NOT_YOURS_TEAM = "Pay for your team is for the office, with Job costs and profit. Ask an owner or admin.";

/** A sub's pay needs the subs area; a team member's, job costs. Exactly one payee. */
export function mayHandlePay(s: JobPayScope, payee: Payee) {
  if (!payee.subcontractor_id === !payee.user_id) throw new HttpError(400, "Choose a sub or someone on your team.");
  const area: Permission = payee.subcontractor_id ? "subs" : "job_costs";
  if (!OFFICE.includes(s.role) || !s.permissions.includes(area)) throw new HttpError(403, payee.subcontractor_id ? NOT_YOURS_SUB : NOT_YOURS_TEAM);
}

/** Marking paid and what subs were paid: subs' pay only. */
const mayHandleSubPay = (s: JobPayScope) => {
  if (!OFFICE.includes(s.role) || !s.permissions.includes("subs")) throw new HttpError(403, NOT_YOURS_SUB);
};

// With the offer (20261025004001_sub_offers.sql): respond_by through accepted_snapshot.
export const PAY_FIELDS =
  "id, job_id, subcontractor_id, user_id, status, total, earned_on, paid_at, paid_amount, method, reference, paid_by, pay_period_id, notes, created_by, created_at, updated_at, respond_by, offered_at, offered_by, offer_round, offer_outcome, answered_at, answered_by, decline_reason, insurance_warning, accepted_snapshot";
const PAY_WITH_PARTS = `${PAY_FIELDS}, lines:job_pay_lines(id, description, basis, unit, quantity, rate, amount, service_id, pay_rate_id, sort), visits:job_pay_visits(visit_id, assigned)` as const;

/** One pay as the person sees it (row-level security decides whether they do), with its lines and visits. */
export async function payById(s: JobPayScope, id: string) {
  const pay = must(
    await s.db.from("job_pay").select(PAY_WITH_PARTS).eq("company_id", s.companyId).eq("id", id).order("sort", { referencedTable: "job_pay_lines" }).maybeSingle(),
    "That pay wasn't found. It may have been deleted.",
  );
  mayHandlePay(s, pay);
  return pay;
}

/**
 * The lines a payee's rates come to on a job, each with a note of where its quantity came from; the
 * visits pay covers unless others are chosen (visit_ids, as the database works them out, crews
 * included); and for a sub, how many of their sign-ins go on those visits when it's agreed (sign_ins;
 * null for someone on the team).
 */
export async function suggestPay(s: JobPayScope, body: Payee & { job_id: string; visit_ids?: readonly string[] | null }) {
  mayHandlePay(s, body);
  const payee = {
    p_job: body.job_id,
    ...(body.subcontractor_id ? { p_subcontractor: body.subcontractor_id } : {}),
    ...(body.user_id ? { p_user: body.user_id } : {}),
  };
  const [suggested, covers] = await Promise.all([
    s.db.rpc("job_pay_suggest", { ...payee, ...(body.visit_ids ? { p_visits: [...body.visit_ids] } : {}) }),
    s.db.rpc("job_pay_covers", payee),
  ]);
  const lines = must(suggested);
  const cover = must(covers)[0];
  return {
    lines,
    total: Math.round(lines.reduce((sum, l) => sum + Number(l.amount), 0) * 100) / 100,
    check: lines.some((l) => l.check_it),
    visit_ids: cover?.visit_ids ?? [],
    sign_ins: cover?.sign_ins ?? null,
  };
}

/** New pay: a draft covering the visits chosen (else the ones they're on), with the lines its rates suggest. */
export async function startPay(s: JobPayScope, body: Payee & { job_id: string; visit_ids?: readonly string[] | null }) {
  mayHandlePay(s, body);
  const id = must(
    await s.db.rpc("job_pay_start", {
      p_job: body.job_id,
      ...(body.subcontractor_id ? { p_subcontractor: body.subcontractor_id } : {}),
      ...(body.user_id ? { p_user: body.user_id } : {}),
      ...(body.visit_ids ? { p_visits: [...body.visit_ids] } : {}),
    }),
  );
  return payById(s, id);
}

/** The office agrees the pay (for a sub, a price agreed by phone), with the visits it covers if given. */
export async function acceptPay(s: JobPayScope, id: string, visitIds?: readonly string[] | null) {
  await payById(s, id);
  must(await s.db.rpc("job_pay_accept", { p_pay: id, ...(visitIds ? { p_visits: [...visitIds] } : {}) }));
  return payById(s, id);
}

/** Agreed work marked done: on the day given, else when its last visit was completed, else today. */
export async function markPayDone(s: JobPayScope, id: string, earnedOn?: string | null) {
  await payById(s, id);
  must(await s.db.rpc("job_pay_mark_done", { p_pay: id, ...(earnedOn ? { p_earned_on: earnedOn } : {}) }));
  return payById(s, id);
}

/** Called off: a sub comes off the visits it put them on that aren't done. */
export async function cancelPay(s: JobPayScope, id: string) {
  await payById(s, id);
  must(await s.db.rpc("job_pay_cancel", { p_pay: id }));
  return payById(s, id);
}

/**
 * Subs' pay for done work, marked paid (one or several): how, on which day (today unless given), a
 * reference, and an amount for one (else each one's total). A team member's is paid with their pay
 * period, which the database says if one is asked for here.
 */
export async function markPayPaid(s: JobPayScope, body: { ids: readonly string[]; method: SubPayMethod; paid_on?: string | null; reference?: string | null; amount?: number | null }) {
  mayHandleSubPay(s);
  if (body.amount != null && body.ids.length > 1) throw new HttpError(400, "Mark them paid one at a time to give each its own amount.");
  const paid = must(
    await s.db.rpc("job_pay_mark_paid", {
      p_pays: [...body.ids],
      p_method: body.method,
      ...(body.paid_on ? { p_paid_on: body.paid_on } : {}),
      ...(body.reference ? { p_reference: body.reference } : {}),
      ...(body.amount != null ? { p_amount: body.amount } : {}),
    }),
  );
  return { paid, total: Math.round(paid.reduce((sum, p) => sum + Number(p.paid_amount ?? 0), 0) * 100) / 100 };
}

/** Paid marks taken back: the work is done and owed again. */
export async function unmarkPayPaid(s: JobPayScope, ids: readonly string[]) {
  mayHandleSubPay(s);
  return { unmarked: must(await s.db.rpc("job_pay_unmark_paid", { p_pays: [...ids] })) };
}

// ---------------------------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------------------------

/** Each sub paid in a calendar year (the company's), whether they need a 1099, and the year's threshold. */
export async function subYearTotals(s: JobPayScope, year: number) {
  mayHandleSubPay(s);
  const rows = must(await s.db.rpc("sub_1099_totals", { p_company: s.companyId, p_year: year }));
  return yearTotals(rows as SubYearTotalRow[], year);
}

/** The same, as a CSV for the bookkeeper. */
export async function subYearTotalsCsv(s: JobPayScope, year: number) {
  return { filename: `1099-totals-${year}.csv`, csv: yearTotalsCsv(await subYearTotals(s, year)) };
}

/** Subs' pay with work from `from` to `to` (the company's dates), covered by workers' comp or not, with the totals. */
export async function wcAudit(s: JobPayScope, from: string, to: string) {
  mayHandleSubPay(s);
  if (to < from) throw new HttpError(400, "The report has to end on or after it starts.");
  const rows = must(await s.db.rpc("sub_wc_audit", { p_company: s.companyId, p_from: from, p_to: to })) as WcAuditRow[];
  return { from, to, rows, totals: wcAuditTotals(rows) };
}

/** The same, as a CSV for the auditor. */
export async function wcAuditCsvFile(s: JobPayScope, from: string, to: string) {
  const report = await wcAudit(s, from, to);
  return { filename: `workers-comp-audit-${from}-to-${to}.csv`, csv: wcAuditCsv(report.rows), totals: report.totals };
}
