/** Helpers for list screens: status filter counts. */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "./api";

type CountTable = "requests" | "quotes" | "jobs" | "invoices" | "campaigns" | "job_applicants";

/** Number of records in each status group, for the filter tabs. */
export function useStatusCounts(table: CountTable, companyId: string, groups: Record<string, readonly string[] | null>) {
  return useQuery({
    queryKey: [table, companyId, "counts", Object.keys(groups).join(",")],
    meta: { silent: true },
    queryFn: async () => {
      const entries = await Promise.all(
        Object.entries(groups).map(async ([key, statuses]) => {
          let q = supabase().from(table).select("id", { count: "exact", head: true }).eq("company_id", companyId);
          if (statuses) q = q.in("status", [...statuses]);
          const { count } = await q;
          return [key, count ?? 0] as const;
        }),
      );
      return Object.fromEntries(entries) as Record<string, number>;
    },
  });
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
