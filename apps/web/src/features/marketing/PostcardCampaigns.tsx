/**
 * Marketing → Campaigns' postcards (PostcardPage): New postcard, and each campaign as a row on the
 * section's hairline with where it's at, test campaigns tagged as such (App-Marketing.dc.html).
 */
import { POSTCARD_SIZE_INFO, type PostcardSize } from "@crewtavo/core/postcards";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { FormError } from "@/components/ui/Field";
import { InboxGroup, InboxList, InboxRow } from "@/components/ui/InboxList";
import { Section } from "@/components/ui/Section";
import { InboxSkeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { EntityStatus } from "@/components/ui/StatusPill";
import { supabase, unwrap } from "@/lib/api";
import { dateLocale, formatDate, timeAgo } from "@/lib/format";
import { useSession } from "@/lib/session";
import { PostcardsUsOnly } from "../apps/LobPanel";
import styles from "./Marketing.module.css";

/** A new postcard's message, to change. */
export const POSTCARD_STARTER = "Hi {{client.first_name}},\n\nOur schedule fills up fast this time of year. Book your visit today and we'll get you on the calendar.\n\n{{link}}\n\n{{company.name}}\n{{company.phone}}";

export function PostcardCampaigns() {
  const session = useSession();
  const navigate = useNavigate();
  const list = useQuery({
    queryKey: ["postcard-campaigns", session.company.id],
    refetchInterval: (q) => ((q.state.data as Array<{ status: string }> | undefined)?.some((c) => c.status === "sending") ? 5000 : false),
    queryFn: async () =>
      unwrap(
        await supabase()
          .from("postcard_campaigns")
          .select("id, name, size, status, mode, recipients_count, made_count, failed_count, finished_at, created_at")
          .eq("company_id", session.company.id)
          .order("created_at", { ascending: false })
          .limit(200),
      ),
  });
  const create = useMutation({
    meta: { inline: true },
    mutationFn: async () =>
      unwrap(
        await supabase()
          .from("postcard_campaigns")
          .insert({ company_id: session.company.id, name: `Postcard ${new Date().toLocaleDateString(dateLocale(), { month: "short", day: "numeric" })}`, message: POSTCARD_STARTER, audience: { statuses: ["active"] } })
          .select("id")
          .single(),
      ),
    onSuccess: (row) => navigate(`/marketing/postcards/${row.id}`),
  });
  type Row = NonNullable<typeof list.data>[number];
  const when = (c: Row) => {
    const made = c.mode === "live" ? "mailed" : "made in test mode";
    // Its status says Draft beside it: the line says what size, and when it was started.
    if (c.status === "draft") return `${POSTCARD_SIZE_INFO[c.size as PostcardSize]?.label ?? c.size} · Edited ${timeAgo(c.created_at)}`;
    if (c.status === "sending") return `${c.made_count.toLocaleString("en-US")} of ${c.recipients_count.toLocaleString("en-US")} ${made}…`;
    return `${c.made_count.toLocaleString("en-US")} ${made}${c.failed_count ? `, ${c.failed_count} failed` : ""}${c.finished_at ? ` · ${formatDate(c.finished_at)}` : ""}`;
  };
  return (
    <Section title="Postcards" count={list.data?.length || undefined} flush action={<Button loading={create.isPending} onClick={() => create.mutate()}>New postcard</Button>}>
      <PostcardsUsOnly />
      <FormError error={create.error} />
      {list.isPending ? (
        <InboxSkeleton rows={1} />
      ) : list.error ? (
        <ErrorState compact error={list.error} onRetry={() => list.refetch()} />
      ) : !list.data.length ? (
        <EmptyState inline title="No postcards yet">Mail a postcard with one of your job photos to the clients you pick, printed and mailed by Lob</EmptyState>
      ) : (
        <InboxList label="Postcards" inset className={styles.flat}>
          <InboxGroup>
            {list.data.map((c) => (
              <InboxRow
                key={c.id}
                to={`/marketing/postcards/${c.id}`}
                title={c.name}
                avatar={false}
                badge={c.mode === "test" && c.status !== "draft" ? <span className="tag">Test</span> : null}
                // Quiet under the name, as a one-off campaign's when is.
                meta={when(c)}
                aside={<EntityStatus kind="campaign" status={c.status} />}
              />
            ))}
          </InboxGroup>
        </InboxList>
      )}
    </Section>
  );
}
