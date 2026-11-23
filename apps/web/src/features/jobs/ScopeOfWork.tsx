/** What the crew is doing on a job, from its line items: names, notes and quantities, never prices. */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Section } from "@/components/ui/Section";
import { SectionSkeleton, Skeleton } from "@/components/ui/Skeleton";
import { supabase, unwrap } from "@/lib/api";
import { pendingJobLines, waitingScopeLine } from "../field/fieldActions";
import { t } from "@/lib/i18n";

const qty = (n: number) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(n);

export const scopeKey = (jobId: string | null | undefined) => ["job", jobId, "scope"];

export function useJobScope(jobId: string | null | undefined) {
  const queryClient = useQueryClient();
  return useQuery({
    queryKey: scopeKey(jobId),
    enabled: Boolean(jobId),
    meta: { silent: true },
    queryFn: async () => {
      const lines = unwrap(await supabase().rpc("job_scope", { p_job: jobId! }));
      // Work added on this phone that hasn't gone yet is newer than what the server has.
      const waiting = pendingJobLines(queryClient, jobId!).filter((w) => !lines.some((l) => l.id === w.lineId));
      return [...lines, ...waiting.map(waitingScopeLine)];
    },
  });
}

export function ScopeOfWork({ jobId, title = t("Scope of work"), bare = false }: { jobId: string; title?: string; bare?: boolean }) {
  const scope = useJobScope(jobId);
  if (scope.isPending) return bare ? <Skeleton height={48} radius={8} /> : <SectionSkeleton rows={3} />;
  if (!scope.data?.length) return null;
  const amount = (l: { quantity: number | string; unit: string }) => (Number(l.quantity) !== 1 || l.unit !== "ea" ? `${qty(Number(l.quantity))} ${l.unit}` : null);
  if (bare) {
    return (
      <div className="stack-sm">
        <strong>{title}</strong>
        <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 6 }}>
          {scope.data.map((l) => (
            <li key={l.id}>
              <strong>{l.name}</strong>
              {amount(l) && <span className="tabular"> · {amount(l)}</span>}
              {l.description && <span className="muted pre-wrap" style={{ display: "block" }}>{l.description}</span>}
            </li>
          ))}
        </ul>
      </div>
    );
  }
  // Hairline rows: the work, how much of it, and its notes under it.
  return (
    <Section title={title} count={scope.data.length}>
      <ul className="rel" role="list" aria-label={title}>
        {scope.data.map((l) => (
          <li key={l.id} className="rel-row">
            <div className="rel-body">
              <span className="rel-head">
                <span className="rel-title">{l.name}</span>
                {amount(l) && <span className="rel-detail tabular"> · {amount(l)}</span>}
              </span>
              {l.description && <div className="rel-sub pre-wrap">{l.description}</div>}
            </div>
          </li>
        ))}
      </ul>
    </Section>
  );
}
