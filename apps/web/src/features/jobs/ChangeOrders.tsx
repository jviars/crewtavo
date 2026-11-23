/** Change orders on a job: extra work priced as a quote, approved by the client, added to the job. */
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { RelatedRow, Section } from "@/components/ui/Section";
import { EntityStatus } from "@/components/ui/StatusPill";
import { supabase, unwrap } from "@/lib/api";
import { formatMoney } from "@/lib/format";
import { useListAnimation } from "@/lib/motion";
import { useSession } from "@/lib/session";

export function useStartChangeOrder(job: { id: string; title: string; client: { id: string } | null; property: { id: string } | null }) {
  const session = useSession();
  const navigate = useNavigate();
  return useMutation({
    meta: { success: "Change order started", tone: "quote" },
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
  const listRef = useListAnimation<HTMLUListElement>();
  if (!orders.data?.length) return null;
  return (
    <Section title="Change orders" count={orders.data.length} action={<Button icon="plus" loading={starting} onClick={onStart}>New change order</Button>}>
      <ul className="rel" role="list" aria-label="Change orders" ref={listRef}>
        {orders.data.map((o) => (
          <RelatedRow
            key={o.id}
            to={`/quotes/${o.id}`}
            lead={`#${o.number}`}
            title={o.title.replace(/^Change order: /, "")}
            end={<><EntityStatus kind="quote" status={o.status === "converted" ? "approved" : o.status} /><b>{formatMoney(o.total)}</b></>}
          />
        ))}
      </ul>
    </Section>
  );
}
