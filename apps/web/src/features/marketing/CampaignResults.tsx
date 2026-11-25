/**
 * What a campaign brought in, one-off or automated (public.campaign_results): emails sent, how many
 * were opened and clicked, the work booked after a click and what it has been paid (CampaignStats);
 * and who it went to, with what each did (campaign_recipient_results), a page at a time, narrowed to
 * those who opened, clicked or booked (CampaignRecipients). Opens are approximate, and the page says so.
 */
import { bookingWords, campaignRates, nextRecipientPage, RECIPIENT_PAGE, resultsLine, type CampaignResults as Results } from "@crewtavo/core/campaigns";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { ListFoot } from "@/components/ui/InboxList";
import { InfoTip } from "@/components/ui/InfoTip";
import { Section } from "@/components/ui/Section";
import { SectionSkeleton, StatsSkeleton } from "@/components/ui/Skeleton";
import { Stat, StatStrip } from "@/components/ui/StatStrip";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { FilterTabs } from "@/components/ui/Toolbar";
import { EntityStatus } from "@/components/ui/StatusPill";
import { supabase, unwrap } from "@/lib/api";
import { formatDateTime, formatMoneyCents } from "@/lib/format";
import { useSession } from "@/lib/session";
import styles from "./Marketing.module.css";

/** Every campaign's numbers, drafts left out: the one-off list and the automated cards read them. */
const OPENS_TIP = "Approximate: Apple Mail and some others load images to protect privacy, so some emails show as opened when they weren't.";
const BOOKINGS_TIP = "Requests and approved quotes from people who clicked a link, within 30 days. A request and the quote made from it count once.";
const REVENUE_TIP = "What that work has been paid so far, before tax. Work booked another way counts when it was set up after the click and paid within 30 days of it, so invoices for work they already had, like recurring visits, don't.";

export function useCampaignResults() {
  const session = useSession();
  return useQuery({
    queryKey: ["campaign-results", session.company.id],
    meta: { silent: true },
    queryFn: async () => unwrap(await supabase().rpc("campaign_results", { p_company: session.company.id })) as unknown as Results[],
  });
}

/** "120 sent · 46% opened · 9% clicked · 3 bookings · $4,200.00", the money only for someone with Invoices. */
export function resultsSummary(r: Results | undefined): string {
  if (!r?.sent) return resultsLine(r);
  return [resultsLine(r), r.bookings ? bookingWords(r.bookings) : null, r.revenue ? formatMoneyCents(r.revenue) : null].filter(Boolean).join(" · ");
}

interface Recipient {
  id: number;
  client_id: string | null;
  name: string | null;
  email: string;
  status: string;
  error: string | null;
  sent_at: string | null;
  opened_at: string | null;
  clicked_at: string | null;
  open_count: number;
  click_count: number;
  quote_number: number | null;
  bookings: number;
  revenue: number | null;
}

interface RecipientPage {
  total: number;
  recipients: Recipient[];
}

/** Who to list: everyone, or those who opened, clicked or booked (public.campaign_recipient_results' p_filter). */
export const RECIPIENT_FILTERS = [
  { value: "all", label: "Everyone", empty: "No one yet" },
  { value: "opened", label: "Opened", empty: "No one has opened it yet" },
  { value: "clicked", label: "Clicked", empty: "No one has clicked a link yet" },
  { value: "booked", label: "Booked", empty: "No bookings yet" },
] as const;
type RecipientFilter = (typeof RECIPIENT_FILTERS)[number]["value"];

/** The numbers, across the page, and what they count. */
export function CampaignStats({ campaignId, live = false }: { campaignId: string; live?: boolean }) {
  const session = useSession();
  const results = useQuery({
    queryKey: ["campaign-results", session.company.id, campaignId],
    refetchInterval: live ? 3000 : false,
    queryFn: async () => ((unwrap(await supabase().rpc("campaign_results", { p_company: session.company.id, p_campaign: campaignId })) as unknown as Results[])[0] ?? null),
  });
  const r = results.data;
  const rates = r ? campaignRates(r) : null;
  const emails = (n: number | undefined) => `${(n ?? 0).toLocaleString()} ${n === 1 ? "email" : "emails"}`;
  return (
    <>
      {results.isPending ? <StatsSkeleton count={5} /> : results.error ? (
        <ErrorState compact error={results.error} onRetry={() => results.refetch()} />
      ) : (
        <StatStrip label="What it brought in">
          <Stat label="Sent" value={(r?.sent ?? 0).toLocaleString()} />
          {/* How each figure is counted is an (i) on its label, so the page isn't paragraphs under the numbers. */}
          <Stat label={<>Opened<InfoTip text={OPENS_TIP} /></>} value={`${rates?.opened ?? 0}%`} note={emails(r?.opened)} />
          <Stat label="Clicked" value={`${rates?.clicked ?? 0}%`} note={emails(r?.clicked)} />
          <Stat label={<>Bookings<InfoTip text={BOOKINGS_TIP} /></>} value={(r?.bookings ?? 0).toLocaleString()} note="Requests and approved quotes" />
          {/* Someone without the Invoices area has no revenue to see. */}
          {r?.revenue != null && <Stat label={<>Revenue<InfoTip text={REVENUE_TIP} /></>} value={formatMoneyCents(r.revenue)} note="Paid so far, before tax" />}
        </StatStrip>
      )}
    </>
  );
}

/** Who it went to and what each did, newest first, narrowed to those who opened, clicked or booked. */
export function CampaignRecipients({ campaignId, live = false }: { campaignId: string; live?: boolean }) {
  const [filter, setFilter] = useState<RecipientFilter>("all");
  // A page at a time, each from where the last left off, so a campaign of thousands can be read to the end.
  const people = useInfiniteQuery({
    queryKey: ["campaign-recipients", campaignId, filter],
    refetchInterval: live ? 3000 : false,
    initialPageParam: 0,
    queryFn: async ({ pageParam }) =>
      unwrap(await supabase().rpc("campaign_recipient_results", { p_campaign: campaignId, p_limit: RECIPIENT_PAGE, p_offset: pageParam, p_filter: filter })) as unknown as RecipientPage,
    getNextPageParam: (last, pages) => (last.recipients.length ? nextRecipientPage(pages.reduce((n, p) => n + p.recipients.length, 0), last.total)?.p_offset : undefined),
  });
  const total = people.data?.pages.at(-1)?.total ?? 0;
  // A send in between pages moves the rest down one: each person is listed once.
  const recipients = [...new Map((people.data?.pages ?? []).flatMap((p) => p.recipients).map((p) => [p.id, p])).values()];

  return (
    <Section title="Recipients" count={people.data ? total.toLocaleString() : undefined} flush>
      <div className={styles.filters}>
        <FilterTabs label="Show" value={filter} onChange={setFilter} options={RECIPIENT_FILTERS.map((f) => ({ value: f.value, label: f.label }))} />
      </div>
      {people.isPending && <SectionSkeleton rows={3} />}
      {people.error && <ErrorState compact error={people.error} onRetry={() => people.refetch()} />}
      {people.data && recipients.length === 0 && <EmptyState inline title={RECIPIENT_FILTERS.find((f) => f.value === filter)!.empty} />}
      {recipients.length > 0 && (
        <ul className="rel" aria-label="Recipients">
          {recipients.map((p) => {
            const notes = [
              p.email,
              p.quote_number != null ? `Quote #${p.quote_number}` : null,
              p.sent_at ? `Sent ${formatDateTime(p.sent_at)}` : null,
              p.clicked_at ? `Clicked ${formatDateTime(p.clicked_at)}${p.click_count > 1 ? ` (${p.click_count} times)` : ""}` : p.opened_at ? `Opened ${formatDateTime(p.opened_at)}` : null,
              p.error,
            ].filter(Boolean);
            const booked = [p.bookings ? bookingWords(p.bookings) : null, p.revenue ? formatMoneyCents(p.revenue) : null].filter(Boolean).join(" · ");
            return (
              <li key={p.id} className={styles.recipient}>
                <div className={styles.recipientBody}>
                  {p.client_id ? <Link to={`/clients/${p.client_id}`} className={styles.recipientName}>{p.name ?? p.email}</Link> : <span className={styles.recipientName}>{p.name ?? p.email}</span>}
                  <div className={styles.recipientMeta}>{notes.join(" · ")}</div>
                  {booked && <div className={styles.recipientBooked}>{booked}</div>}
                </div>
                <EntityStatus kind="recipient" status={p.status === "sent" && p.clicked_at ? "clicked" : p.status === "sent" && p.opened_at ? "opened" : p.status} />
              </li>
            );
          })}
        </ul>
      )}
      {people.hasNextPage && (
        <ListFoot more={{ onClick: () => void people.fetchNextPage(), loading: people.isFetchingNextPage, label: "Show more" }}>
          {recipients.length.toLocaleString()} of {total.toLocaleString()}
        </ListFoot>
      )}
    </Section>
  );
}
