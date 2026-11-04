/** Helpers for list screens: status filter counts. */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "./api";

type CountTable = "requests" | "quotes" | "jobs" | "invoices" | "campaigns" | "job_applicants";

/** Number of records in each status group, for the filter tabs. Jobs group by job_state, which splits active jobs into late, today, upcoming and unscheduled. */
export function useStatusCounts(table: CountTable, companyId: string, groups: Record<string, readonly string[] | null>, column: "status" | "job_state" = "status") {
  return useQuery({
    queryKey: [table, companyId, "counts", column, Object.keys(groups).join(",")],
    meta: { silent: true },
    queryFn: async () => {
      const entries = await Promise.all(Object.entries(groups).map(async ([key, statuses]) => [key, await statusCount(table, companyId, key, statuses, column)] as const));
      return Object.fromEntries(entries) as Record<string, number>;
    },
  });
}

/** How many records one tab (`key`) has: those in its statuses, or all of them for null. */
export async function statusCount(table: CountTable, companyId: string, key: string, statuses: readonly string[] | null, column: "status" | "job_state" = "status") {
  let q = supabase().from(table).select("id", { count: "exact", head: true }).eq("company_id", companyId);
  // Typed as status, which every table here has; job_state is on jobs alone.
  if (statuses) q = q.in(column as "status", [...statuses]);
  // Quote templates have a tab of their own ("templates"), and no other tab counts them.
  if (table === "quotes") q = q.filter("is_template", "eq", key === "templates");
  const { count } = await q;
  return count ?? 0;
}

/**
 * PostgREST can't OR across a table and its embedded client, so look up matching clients first and
 * build one filter: "title matches, or the client's name does".
 */
export async function titleOrClientFilter(companyId: string, term: string, titleColumn = "title"): Promise<string> {
  const { data } = await supabase().from("clients").select("id").eq("company_id", companyId).or(`display_name.ilike.%${term}%,company_name.ilike.%${term}%`).limit(60);
  const ids = (data ?? []).map((c) => c.id);
  return [`${titleColumn}.ilike.%${term}%`, ids.length ? `client_id.in.(${ids.join(",")})` : null].filter(Boolean).join(",");
}
