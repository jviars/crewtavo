/** What the crew is doing on a job, from its line items: names, notes and quantities, never prices. */
import { useQuery } from "@tanstack/react-query";
import { Skeleton } from "@/components/ui/Skeleton";
import { supabase, unwrap } from "@/lib/api";

const qty = (n: number) => new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(n);

export function useJobScope(jobId: string | null | undefined) {
  return useQuery({
    queryKey: ["job", jobId, "scope"],
    enabled: Boolean(jobId),
    meta: { silent: true },
    queryFn: async () => unwrap(await supabase().rpc("job_scope", { p_job: jobId! })),
  });
}

export function ScopeOfWork({ jobId, title = "Scope of work", bare = false }: { jobId: string; title?: string; bare?: boolean }) {
  const scope = useJobScope(jobId);
  if (scope.isPending) return <Skeleton height={48} radius={8} />;
  if (!scope.data?.length) return null;
  const list = (
    <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 6 }}>
      {scope.data.map((l) => (
        <li key={l.id}>
          <strong>{l.name}</strong>
          {Number(l.quantity) !== 1 || l.unit !== "ea" ? <span className="tabular"> · {qty(Number(l.quantity))} {l.unit}</span> : null}
          {l.description && <span className="muted pre-wrap" style={{ display: "block" }}>{l.description}</span>}
        </li>
      ))}
    </ul>
  );
  if (bare) return <div className="stack-sm"><strong>{title}</strong>{list}</div>;
  return (
    <section className="stack">
      <h2 className="section-title">{title}</h2>
      <div className="card card-pad">{list}</div>
    </section>
  );
}
