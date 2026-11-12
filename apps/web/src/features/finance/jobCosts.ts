/**
 * What jobs cost, read for many jobs at once: the jobs finished in a period (Finance → Profit) and
 * the jobs behind a period's invoices (Services). Time, expenses, pay rates and sub and crew pay are
 * looked up by the jobs' ids, which travel in the request's address, so they're asked for a lot of
 * jobs at a time (byJobs) and put together: every job is costed, however many there are.
 */
import { jobProfit } from "@crewtavo/core/reports";
import { api, supabase, unwrap } from "@/lib/api";
import { everyRow } from "@/lib/paging";

export type Rates = Record<string, number>;
/** The pay rate approved time was costed at, by entry, for people with job costs (only the server reads it). */
export const timeRates = (costs: boolean, filter: { job_ids: string[] } | { from: string; to: string }): Promise<Rates> =>
  costs ? api.post<Rates>("/time/rates", filter) : Promise.resolve({});

/** 200 jobs a request keeps the address short enough (and /time/rates takes 300 at most). */
export const JOBS_AT_ONCE = 200;

/** What `read` finds for each lot of JOBS_AT_ONCE of the jobs, as one list. */
export async function byJobs<T>(ids: readonly string[], read: (jobs: string[]) => PromiseLike<T[]>): Promise<T[]> {
  return (await Promise.all(Array.from({ length: Math.ceil(ids.length / JOBS_AT_ONCE) }, (_, i) => read(ids.slice(i * JOBS_AT_ONCE, (i + 1) * JOBS_AT_ONCE))))).flat();
}

/** The rate of each time entry on the jobs, for people with job costs (nothing for anyone else). */
export const jobRates = (costs: boolean, ids: readonly string[]): Promise<Rates> =>
  costs ? byJobs(ids, (jobs) => timeRates(true, { job_ids: jobs }).then((r) => [r])).then((r): Rates => Object.assign({}, ...r)) : Promise.resolve({});

/**
 * Finance → Profit: the jobs completed in the period (or waiting to be invoiced) with each one's
 * revenue, costs, profit and margin, and the company's target margin. `costs`: the person has job
 * costs, so pay rates and sub and crew pay are read too.
 */
export async function loadProfit({ companyId, range, costs }: { companyId: string; range: { start: string; end: string }; costs: boolean }) {
  const db = supabase();
  const [jobs, settings] = await Promise.all([
    everyRow(() => db.from("jobs").select("id, number, title, status, financials:job_financials(contract_total), client:clients(display_name), lines:job_line_items(quantity, unit_cost, unit_labor_cost)").eq("company_id", companyId).in("status", ["requires_invoicing", "completed"]).gte("updated_at", range.start).lt("updated_at", range.end)),
    db.from("companies").select("settings").eq("id", companyId).single(),
  ]);
  const ids = jobs.map((j) => j.id);
  const [time, expenses, rates, crewPay] = await Promise.all([
    byJobs(ids, (lot) => everyRow(() => db.from("time_entries").select("id, job_id, started_at, ended_at").in("job_id", lot))),
    byJobs(ids, (lot) => everyRow(() => db.from("expenses").select("job_id, amount").in("job_id", lot))),
    jobRates(costs, ids),
    // Sub and crew pay that's agreed, done or paid: for those with job costs, nothing for anyone else.
    costs ? byJobs(ids, (lot) => db.rpc("job_pay_costs", { p_jobs: lot }).then(unwrap)) : Promise.resolve([]),
  ]);
  const target = Number(((unwrap(settings).settings ?? {}) as Record<string, unknown>).margin_target ?? 0) || null;
  // Costed as AI assistants' job_profit costs it (packages/core/src/reports.ts).
  const costed = jobProfit(jobs, time, expenses, (t) => Number(rates[t.id] ?? 0), target, crewPay).jobs.map((j) => ({ ...j, margin: j.margin_percent }));
  return { jobs: costed, target };
}
