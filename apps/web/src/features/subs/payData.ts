/**
 * Job pay's queries and types (supabase/migrations/20261025003001_job_pay.sql). Rate cards, a pay's
 * lines, the visits it covers and its notes are read and changed straight in the database under
 * row-level security: a sub's pay is for the office with the Subcontractors area, a team member's
 * for the office with Job costs, and nobody else. Starting, agreeing, marking done, cancelling and
 * marking paid go through the API (routes/jobPay.ts), which calls the database's own functions, and
 * so do a sub's offers: sending one, changing an agreed price and taking one back (routes/subOffers.ts).
 */
import type { SubPayMethod, SubYearTotal, WcAuditRow } from "@crewtavo/core/jobPay";
import { useQuery, type QueryClient } from "@tanstack/react-query";
import { api, supabase, unwrap } from "@/lib/api";
import { can, hasRole, type Session } from "@/lib/session";
import type { PayLine, Suggestion } from "./pay";

/** Who handles which pay: a sub's with the subs area, a team member's with job costs. */
export const handlesSubPay = (session: Pick<Session, "role" | "permissions">) => hasRole(session, "admin", "office") && can(session, "subs");
export const handlesTeamPay = (session: Pick<Session, "role" | "permissions">) => hasRole(session, "admin", "office") && can(session, "job_costs");

export interface PayRate {
  id: string;
  subcontractor_id: string | null;
  user_id: string | null;
  basis: "per_unit" | "per_job" | "per_day";
  service_id: string | null;
  unit: string | null;
  squares_basis: "job" | "roof_no_waste";
  rate: number;
  description: string | null;
  active: boolean;
  created_at: string;
  service: { name: string; unit: string | null } | null;
}
const RATE_FIELDS = "id, subcontractor_id, user_id, basis, service_id, unit, squares_basis, rate, description, active, created_at, service:services(name, unit)";

export interface JobPay {
  id: string;
  job_id: string;
  subcontractor_id: string | null;
  user_id: string | null;
  status: string;
  total: number;
  earned_on: string | null;
  paid_at: string | null;
  paid_amount: number | null;
  method: string | null;
  reference: string | null;
  pay_period_id: string | null;
  notes: string | null;
  created_at: string;
  /** The offer (20261025004001_sub_offers.sql): when it runs out, when it went out, and how it ended. */
  respond_by: string | null;
  offered_at: string | null;
  offer_round: number;
  offer_outcome: string | null;
  answered_at: string | null;
  decline_reason: string | null;
  /** What was wrong with their insurance when it went out (it only warns). */
  insurance_warning: unknown;
  /** The price last agreed, kept while a new one waits for their answer. */
  accepted_snapshot: { total: number; lines: unknown[]; at?: string } | null;
  sub: { id: string; name: string } | null;
  job: { id: string; number: number; title: string } | null;
  lines: PayLine[];
  /** cancelled_while_agreed: cancelled after the price was agreed, so the pay isn't done by itself. */
  visits: Array<{ visit_id: string; assigned: string[]; cancelled_while_agreed?: boolean }>;
}
export const PAY_FIELDS =
  "id, job_id, subcontractor_id, user_id, status, total, earned_on, paid_at, paid_amount, method, reference, pay_period_id, notes, created_at, respond_by, offered_at, offer_round, offer_outcome, answered_at, decline_reason, insurance_warning, accepted_snapshot, sub:subcontractors(id, name), job:jobs(id, number, title), lines:job_pay_lines(id, description, basis, unit, quantity, rate, amount, service_id, pay_rate_id, sort), visits:job_pay_visits(visit_id, assigned, cancelled_while_agreed)";

/** Whose: a sub (subcontractor_id) or someone on the team (user_id). */
export interface PayeeRef { subcontractor_id?: string | null; user_id?: string | null }
const payeeKey = (p: PayeeRef) => p.subcontractor_id ?? p.user_id ?? "";

/** A payee's rate card, active ones first. */
export function usePayRates(companyId: string, payee: PayeeRef) {
  return useQuery({
    queryKey: ["job-pay", companyId, "rates", payeeKey(payee)],
    queryFn: async () => {
      let q = supabase().from("pay_rates").select(RATE_FIELDS).eq("company_id", companyId);
      q = payee.subcontractor_id ? q.eq("subcontractor_id", payee.subcontractor_id) : q.eq("user_id", payee.user_id ?? "");
      const rows = unwrap(await q.order("created_at").limit(500)) as unknown as PayRate[];
      return [...rows].sort((a, b) => Number(b.active) - Number(a.active));
    },
  });
}

/** How many active rates each team member has (Settings → People). */
export function useTeamRateCounts(companyId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["job-pay", companyId, "rates", "team-counts"],
    enabled,
    queryFn: async () => {
      const rows = unwrap(await supabase().from("pay_rates").select("user_id").eq("company_id", companyId).eq("active", true).not("user_id", "is", null).limit(5000));
      const counts: Record<string, number> = {};
      for (const r of rows) if (r.user_id) counts[r.user_id] = (counts[r.user_id] ?? 0) + 1;
      return counts;
    },
  });
}

/** Active price-list services, for a rate per unit. */
export function useServices(companyId: string) {
  return useQuery({
    queryKey: ["services", companyId, "for-rates"],
    staleTime: 5 * 60_000,
    queryFn: async () => unwrap(await supabase().from("services").select("id, name, unit, active").eq("company_id", companyId).order("sort").order("name").limit(2000)),
  });
}

const withSortedLines = (rows: JobPay[]) => rows.map((p) => ({ ...p, lines: [...p.lines].sort((a, b) => a.sort - b.sort || a.id.localeCompare(b.id)) }));

/** The pay on a job that the person handles (row-level security leaves out the rest). */
export function useJobPays(companyId: string, jobId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["job-pay", companyId, "job", jobId],
    enabled,
    queryFn: async () => withSortedLines(unwrap(await supabase().from("job_pay").select(PAY_FIELDS).eq("company_id", companyId).eq("job_id", jobId).order("created_at").limit(200)) as unknown as JobPay[]),
  });
}

/** A sub's pay on every job, newest first. */
export function useSubPays(companyId: string, subId: string) {
  return useQuery({
    queryKey: ["job-pay", companyId, "sub", subId],
    queryFn: async () => withSortedLines(unwrap(await supabase().from("job_pay").select(PAY_FIELDS).eq("company_id", companyId).eq("subcontractor_id", subId).order("created_at", { ascending: false }).limit(1000)) as unknown as JobPay[]),
  });
}

/** Subs' pay for work that's done and not paid yet, oldest first. */
export function useOwed(companyId: string, enabled: boolean) {
  return useQuery({
    queryKey: ["job-pay", companyId, "owed"],
    enabled,
    queryFn: async () =>
      unwrap(
        await supabase().from("job_pay").select(PAY_FIELDS).eq("company_id", companyId).eq("status", "done").not("subcontractor_id", "is", null).order("earned_on").order("created_at").limit(1000),
      ) as unknown as JobPay[],
  });
}

/**
 * What a payee's rates suggest on a job (POST /api/job-pay/suggest), each line with where its quantity
 * came from; the visits pay covers unless others are chosen (the database's, crews included); and for
 * a sub, how many sign-ins of theirs go on those visits when it's agreed (null for the team).
 */
export interface SuggestRow extends Suggestion {
  basis: string;
  service_id: string | null;
  rate: number;
  amount: number;
  sort: number;
}
export interface SuggestResult { lines: SuggestRow[]; total: number; check: boolean; visit_ids: string[]; sign_ins: number | null }

export function useSuggestion(body: { job_id: string; visit_ids?: readonly string[] | null } & PayeeRef, enabled: boolean) {
  return useQuery({
    queryKey: ["job-pay", "suggest", body.job_id, payeeKey(body), body.visit_ids ? [...body.visit_ids].sort().join(",") : "theirs"],
    enabled: enabled && Boolean(payeeKey(body)),
    staleTime: 30_000,
    meta: { silent: true },
    queryFn: () => api.post<SuggestResult>("/job-pay/suggest", body),
  });
}

export const startPay = (body: { job_id: string; visit_ids: readonly string[] | null } & PayeeRef) => api.post<JobPay>("/job-pay", body);
export const acceptPay = (id: string) => api.post<JobPay>(`/job-pay/${id}/accept`, {});
export const markPayDone = (id: string, earnedOn: string | null) => api.post<JobPay>(`/job-pay/${id}/done`, { earned_on: earnedOn });
export const cancelPay = (id: string) => api.post<JobPay>(`/job-pay/${id}/cancel`, {});
export const markPaid = (body: { ids: readonly string[]; method: SubPayMethod; paid_on: string; reference: string | null; amount: number | null }) =>
  api.post<{ paid: JobPay[]; total: number }>("/job-pay/mark-paid", body);
/** A draft to the sub as an offer, to answer by `respondBy` (an ISO time) if given. */
export const sendOffer = (id: string, respondBy: string | null) => api.post<JobPay>(`/job-pay/${id}/offer`, { respond_by: respondBy });
/** A new price for agreed pay, to the sub as an offer; the agreed one stands until they take it. */
export const changeOffer = (id: string, body: { lines: ReadonlyArray<{ description: string; basis: string; unit: string | null; quantity: number; rate: number; service_id: string | null; pay_rate_id: string | null }>; respond_by: string | null }) =>
  api.post<JobPay>(`/job-pay/${id}/offer/change`, body);
/** Takes back an offer they haven't answered. */
export const withdrawOffer = (id: string) => api.post<JobPay>(`/job-pay/${id}/offer/withdraw`, {});
export const unmarkPaid = (ids: readonly string[]) => api.post<{ unmarked: JobPay[] }>("/job-pay/unmark-paid", { ids });
export async function deletePay(id: string) {
  unwrap(await supabase().from("job_pay").delete().eq("id", id));
}

/** Each sub's total for a year (GET /api/subs/1099). */
export interface YearTotals { year: number; threshold: number; threshold_note: string | null; subs: SubYearTotal[]; total: number; needing_1099: number }
export const useYearTotals = (year: number) => useQuery({ queryKey: ["job-pay", "1099", year], queryFn: () => api.get<YearTotals>(`/subs/1099?year=${year}`) });

/** The workers' comp audit (GET /api/subs/workers-comp). */
export interface WcAudit { from: string; to: string; rows: WcAuditRow[]; totals: { amount: number; paid: number; not_paid_yet: number; covered: number; not_covered: number; subs: number; not_covered_subs: number } }
export const useWcAudit = (from: string, to: string, enabled: boolean) =>
  useQuery({ queryKey: ["job-pay", "workers-comp", from, to], enabled, queryFn: () => api.get<WcAudit>(`/subs/workers-comp?from=${from}&to=${to}`) });

/** After any change to job pay: the job's costs, what's owed, the sub's history and the pay period follow. */
export function refreshPay(queryClient: QueryClient, jobId?: string) {
  queryClient.invalidateQueries({ queryKey: ["pay"] });
  queryClient.invalidateQueries({ queryKey: ["finance"] });
  // A sub agreed onto a job goes on its visits.
  queryClient.invalidateQueries({ queryKey: ["schedule"] });
  if (jobId) queryClient.invalidateQueries({ queryKey: ["job", jobId] });
  // Resolves once job pay itself is fresh, for a line that waits to show its saved value.
  return queryClient.invalidateQueries({ queryKey: ["job-pay"] });
}
