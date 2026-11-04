/**
 * Possible duplicates: clients who share an email, a phone, or a street with the same postal code,
 * as website and booking forms match them (public.client_duplicates). Each pair is merged, or
 * marked not duplicates so it stops showing. Office and up, with the invoices area: a merge moves
 * invoices and payments.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { BackLink, PageHeader } from "@/components/ui/PageHeader";
import { ListPageSkeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState, NoAccess } from "@/components/ui/States";
import { EntityStatus } from "@/components/ui/StatusPill";
import { supabase, unwrap } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { can, hasRole, useSession } from "@/lib/session";
import { MergeClientsDialog } from "./MergeClientsDialog";

type Client = { id: string; display_name: string; email: string | null; phone: string | null; status: string; created_at: string };
type Pair = { clients: [Client, Client]; reasons: Array<{ kind: "email" | "phone" | "address"; value: string }> };
const WHY = { email: "Same email", phone: "Same phone", address: "Same address" } as const;

export function DuplicatesPage() {
  const session = useSession();
  return hasRole(session, "admin", "office") && can(session, "invoices") ? <Duplicates /> : <NoAccess title="Possible duplicates" />;
}

function Duplicates() {
  const { company } = useSession();
  const queryClient = useQueryClient();
  const [merging, setMerging] = useState<Client[] | null>(null);
  const key = ["clients", company.id, "duplicates"];
  const pairs = useQuery({
    queryKey: key,
    queryFn: async () => unwrap(await supabase().rpc("client_duplicates", { p_company: company.id })) as unknown as Pair[],
  });
  const dismiss = useMutation({
    meta: { success: "Marked not duplicates" },
    mutationFn: async (p: Pair) => unwrap(await supabase().rpc("dismiss_client_duplicate", { p_company: company.id, p_client: p.clients[0].id, p_other: p.clients[1].id })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: key }),
  });

  if (pairs.isPending) return <ListPageSkeleton columns={3} tabs={0} />;
  return (
    <>
      <BackLink to="/clients">Clients</BackLink>
      <PageHeader title="Possible duplicates" />
      {pairs.error ? (
        <div className="card"><ErrorState error={pairs.error} onRetry={() => pairs.refetch()} /></div>
      ) : !pairs.data.length ? (
        <div className="card"><EmptyState icon="users" title="No possible duplicates">Clients who share an email, a phone or an address show here.</EmptyState></div>
      ) : (
        <div className="card">
          <table className="table table-stack">
            <thead>
              <tr><th>Clients</th><th>Why</th><th><span className="sr-only">Actions</span></th></tr>
            </thead>
            <tbody>
              {pairs.data.map((p) => (
                <tr key={`${p.clients[0].id}-${p.clients[1].id}`}>
                  <td>
                    {p.clients.map((c) => (
                      <div key={c.id} className="row wrap" style={{ gap: 8 }}>
                        <Link className="cell-link" to={`/clients/${c.id}`}>{c.display_name}</Link>
                        <EntityStatus kind="client" status={c.status} />
                        <span className="muted small">Added {formatDate(c.created_at)}</span>
                      </div>
                    ))}
                  </td>
                  <td>
                    {p.reasons.map((r) => <div key={`${r.kind}-${r.value}`}>{WHY[r.kind]} <span className="muted">{r.value}</span></div>)}
                  </td>
                  <td>
                    <div className="row wrap" style={{ gap: 8, justifyContent: "flex-end" }}>
                      <Button size="sm" loading={dismiss.isPending && dismiss.variables === p} onClick={() => dismiss.mutate(p)}>Not duplicates</Button>
                      <Button size="sm" variant="primary" onClick={() => setMerging([...p.clients].sort((a, b) => a.created_at.localeCompare(b.created_at)))}>Merge</Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {/* The one added first is kept unless the office picks the other. */}
      {merging && <MergeClientsDialog client={merging[0]} other={merging[1]} onClose={() => setMerging(null)} />}
    </>
  );
}
