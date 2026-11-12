/**
 * Pay rates, which nobody reads through the Data API (they're private to the office): the rate each
 * time entry is costed at, for job profit, reports and pay. Approved time keeps the rate it was
 * approved at (snapshotted on the entry); time not approved yet is costed at the person's current
 * rate, so a job's labor isn't free until someone approves it. Read with the server's key, so who
 * may ask is checked by the caller: office and up with "Job costs and profit" (job_costs).
 */
import type { Db } from "../lib/supabase";

/** Each person's current pay rate (memberships.labor_rate), by user id. */
export async function currentRates(admin: Db, companyId: string): Promise<Record<string, number>> {
  const { data, error } = await admin.from("memberships").select("user_id, labor_rate").eq("company_id", companyId);
  if (error) throw new Error(error.message);
  return Object.fromEntries((data ?? []).filter((m) => m.labor_rate !== null).map((m) => [m.user_id, Number(m.labor_rate)]));
}

/** The rate each time entry is costed at, by entry id, for some jobs or a range of start times. */
export async function timeRates(admin: Db, companyId: string, filter: { job_ids?: readonly string[]; from?: string; to?: string }): Promise<Record<string, number>> {
  const current = await currentRates(admin, companyId);
  const rates: Record<string, number> = {};
  // A page at a time (PostgREST returns 1,000 rows at most) to the last one: an entry left without a
  // rate is costed at nothing, so stopping part-way would understate labor. id keeps the pages in step.
  for (let offset = 0; ; offset += 1000) {
    let query = admin.from("time_entries").select("id, user_id, labor_rate").eq("company_id", companyId);
    if (filter.job_ids) query = query.in("job_id", [...filter.job_ids]);
    if (filter.from && filter.to) query = query.gte("started_at", filter.from).lt("started_at", filter.to);
    const { data, error } = await query.order("id").range(offset, offset + 999);
    if (error) throw new Error(error.message);
    for (const r of data ?? []) {
      const rate = r.labor_rate !== null ? Number(r.labor_rate) : current[r.user_id];
      if (rate !== undefined) rates[r.id] = rate;
    }
    if ((data ?? []).length < 1000) break;
  }
  return rates;
}
