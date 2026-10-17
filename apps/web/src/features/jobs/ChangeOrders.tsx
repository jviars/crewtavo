/** Change orders on a job: extra work priced as a quote, approved by the client, added to the job. */
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { EntityStatus } from "@/components/ui/StatusPill";
import { supabase, unwrap } from "@/lib/api";
import { formatMoney } from "@/lib/format";
import { useSession } from "@/lib/session";

export function useStartChangeOrder(job: { id: string; title: string; client: { id: string } | null; property: { id: string } | null }) {
  const session = useSession();
  const navigate = useNavigate();
  return useMutation({
    meta: { success: "Change order started. Add what's changing, then send it." },
    mutationFn: async () =>
      unwrap(
        await supabase()
          .from("quotes")
          .insert({ company_id: session.company.id, client_id: job.client!.id, property_id: job.property?.id ?? null, title: `Change order: ${job.title}`.slice(0, 200), change_order_for: job.id })
          .select("id")
          .single(),
      ),
    onSuccess: (q) => navigate(`/quotes/${q.id}`),
  });
}

export function ChangeOrders({ jobId, onStart, starting }: { jobId: string; onStart: () => void; starting: boolean }) {
  const orders = useQuery({
    queryKey: ["job", jobId, "change-orders"],
    queryFn: async () => unwrap(await supabase().from("quotes").select("id, number, title, status, total").eq("change_order_for", jobId).order("created_at")),
  });
  if (!orders.data?.length) return null;
  return (
    <section className="stack">
      <div className="section-head">
        <h2 className="section-title">Change orders</h2>
        <Button size="sm" variant="ghost" icon="plus" loading={starting} onClick={onStart}>New change order</Button>
      </div>
      <div className="card">
        {orders.data.map((o) => (
          <Link key={o.id} to={`/quotes/${o.id}`} className="card-row">
            <strong className="grow">#{o.number} · {o.title.replace(/^Change order: /, "")}</strong>
            <span className="tabular">{formatMoney(o.total)}</span>
            <EntityStatus kind="quote" status={o.status === "converted" ? "approved" : o.status} />
          </Link>
        ))}
      </div>
    </section>
  );
}
