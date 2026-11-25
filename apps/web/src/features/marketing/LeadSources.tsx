/**
 * Beside Marketing → Campaigns: where new clients came from in the past 90 days, counted as Metrics
 * counts them (leadSource), since that's the question marketing answers (Jobber's Marketing opens
 * with its top sources). Metrics → Sales has the rest: quotes sent and won by source.
 */
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Section } from "@/components/ui/Section";
import { SectionSkeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { supabase } from "@/lib/api";
import { everyRow } from "@/lib/paging";
import { can, useSession } from "@/lib/session";
import styles from "./Marketing.module.css";
import { SourceMark } from "./SourceMark";
import { leadSource } from "./website";

const DAYS = 90;
const SHOWN = 6;

/** Sources by how many new clients each brought, most first; past the first few they're "Everything else". */
export function sourceCounts(clients: Array<{ lead_source: string | null; requests?: Array<{ web_visit: unknown }> | null }>, shown = SHOWN) {
  const counts = new Map<string, number>();
  for (const c of clients) {
    const key = leadSource(c.lead_source, c.requests);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const sorted = [...counts].map(([source, count]) => ({ source, count })).sort((a, b) => b.count - a.count || a.source.localeCompare(b.source));
  if (sorted.length <= shown) return sorted;
  const rest = sorted.slice(shown - 1).reduce((sum, s) => sum + s.count, 0);
  return [...sorted.slice(0, shown - 1), { source: "Everything else", count: rest }];
}

export function LeadSources() {
  const session = useSession();
  const sources = useQuery({
    queryKey: ["lead-sources", session.company.id],
    queryFn: async () => {
      const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
      // A page at a time (lib/paging.ts): a busy season can bring more than one request's 1,000.
      const rows = await everyRow(() => supabase().from("clients").select("id, lead_source, requests(web_visit)").eq("company_id", session.company.id).gte("created_at", since));
      return { total: rows.length, sources: sourceCounts(rows) };
    },
  });
  const most = sources.data?.sources[0]?.count ?? 0;
  return (
    <Section
      title="Where new clients came from"
      count={sources.data?.total || undefined}
      action={can(session, "reports") && <Link to="/metrics?tab=sales">Metrics</Link>}
    >
      <p className={styles.fine}>Past {DAYS} days</p>
      {sources.isPending && <SectionSkeleton rows={4} />}
      {sources.error && <ErrorState compact error={sources.error} onRetry={() => sources.refetch()} />}
      {sources.data?.total === 0 && <EmptyState inline title="No new clients in the past 90 days" />}
      {Boolean(sources.data?.total) && (
        <ul className={styles.sources} aria-label="New clients by where they came from">
          {sources.data!.sources.map((s) => (
            <li key={s.source}>
              <span className={styles.sourceName}>
                <span className={styles.sourceSlot}><SourceMark name={s.source} size={13} /></span>
                <span className={styles.sourceLabel}>{s.source}</span>
              </span>
              <span className={styles.sourceCount}>{s.count.toLocaleString()}</span>
              <span className={styles.sourceBar} aria-hidden="true"><span style={{ width: `${(s.count / most) * 100}%` }} /></span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
