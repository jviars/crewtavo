/**
 * Possible duplicates: clients who share an email, a phone, or a street with the same postal code,
 * as website and booking forms match them (public.client_duplicates). Each pair is merged, or
 * marked not duplicates so it stops showing. Office and up, with the invoices area: a merge moves
 * invoices and payments.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { InboxGroup, InboxList, InboxRow, ListFoot } from "@/components/ui/InboxList";
import { BackLink, PageHeader } from "@/components/ui/PageHeader";
import { InboxPageSkeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState, NoAccess } from "@/components/ui/States";
import { EntityStatus } from "@/components/ui/StatusPill";
import { supabase, unwrap } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { can, hasRole, useSession } from "@/lib/session";
import styles from "./clients.module.css";
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

  if (pairs.isPending) return <InboxPageSkeleton tabs={0} groups={2} rows={4} />;
  return (
    <>
      <BackLink to="/clients">Clients</BackLink>
      <PageHeader title="Possible duplicates" lede={pairs.data?.length ? "Clients who share an email, a phone or an address. Merge the ones that are the same person." : undefined} />
      {pairs.error ? (
        <ErrorState error={pairs.error} onRetry={() => pairs.refetch()} />
      ) : !pairs.data.length ? (
        <EmptyState icon="users" title="No possible duplicates">Clients who share an email, a phone or an address show here.</EmptyState>
      ) : (
        <InboxList label="Possible duplicates" foot={<ListFoot>{pairs.data.length === 1 ? "1 pair" : `${pairs.data.length} pairs`}</ListFoot>}>
          {pairs.data.map((p) => (
            <InboxGroup
              key={`${p.clients[0].id}-${p.clients[1].id}`}
              icon="copy"
              // The rows show the email and phone; an address shared is said in full.
              label={p.reasons.map((r, i) => (
                <span key={`${r.kind}-${r.value}`}>
                  {i > 0 && " · "}
                  {WHY[r.kind]}
                  {r.kind === "address" && <span className={styles.reasonValue}> {r.value}</span>}
                </span>
              ))}
              end={
                <>
                  <button type="button" className={`${styles.notDup} ${styles.tap}`} disabled={dismiss.isPending && dismiss.variables === p} aria-busy={(dismiss.isPending && dismiss.variables === p) || undefined} aria-label={`Not duplicates: ${p.clients[0].display_name} and ${p.clients[1].display_name}`} onClick={() => dismiss.mutate(p)}>Not duplicates</button>
                  {/* The one added first is kept unless the office picks the other. */}
                  <button type="button" className={styles.tap} aria-label={`Merge ${p.clients[0].display_name} and ${p.clients[1].display_name}`} onClick={() => setMerging([...p.clients].sort((a, b) => a.created_at.localeCompare(b.created_at)))}>Merge</button>
                </>
              }
            >
              {p.clients.map((c) => (
                <InboxRow
                  key={c.id}
                  to={`/clients/${c.id}`}
                  title={c.display_name}
                  subject={[c.email, c.phone].filter(Boolean).join(" · ") || undefined}
                  meta={[<EntityStatus kind="client" status={c.status} />, `Added ${formatDate(c.created_at)}`]}
                />
              ))}
            </InboxGroup>
          ))}
        </InboxList>
      )}
      {merging && <MergeClientsDialog client={merging[0]} other={merging[1]} onClose={() => setMerging(null)} />}
    </>
  );
}
