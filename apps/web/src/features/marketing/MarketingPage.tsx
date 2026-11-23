/**
 * Marketing (Apps → Crewtavo - Marketing): campaigns (the automated ones, AutomatedCampaigns, and
 * one-off emails to client segments, with what each brought in, and postcards), social posts (Social), job showcases
 * (Showcases), promo codes, Google review requests
 * (Reviews) and referral credits and asks (Referrals), and visits to the business's website once
 * Website Analytics is installed (WebsiteSection). Uninstalled, the page says so, and still shows website
 * visits when Website Analytics is installed (Home and Website Analytics open them here).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useSyncExternalStore } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { featureOn } from "@/components/shell/nav";
import { Button, cx } from "@/components/ui/Button";
import { DetailColumns } from "@/components/ui/DetailPage";
import { Icon } from "@/components/ui/Icon";
import { InboxGroup, InboxList, InboxRow } from "@/components/ui/InboxList";
import { Menu } from "@/components/ui/Menu";
import { SHEET_QUERY } from "@/components/ui/menuModel";
import { PageHeader } from "@/components/ui/PageHeader";
import { Section } from "@/components/ui/Section";
import { CardSkeleton, InboxSkeleton, Loading, StatsSkeleton } from "@/components/ui/Skeleton";
import { Stat, StatStrip } from "@/components/ui/StatStrip";
import { EmptyState, ErrorState, NoAccess } from "@/components/ui/States";
import { EntityStatus, statusText } from "@/components/ui/StatusPill";
import { supabase, unwrap } from "@/lib/api";
import { formatDate, formatDateTime, formatMoneyCents, timeAgo } from "@/lib/format";
import { useTabStrip } from "@/lib/tabStrip";
import { can, hasRole, useSession } from "@/lib/session";
import { undoable } from "@/lib/undo";
import { ConnectEmailHint } from "../settings/ConnectEmailHint";
import { AutomatedCampaigns, useAutomatedStates } from "./AutomatedCampaigns";
import { emailsSentHint } from "./automatedForm";
import { resultsSummary, useCampaignResults } from "./CampaignResults";
import styles from "./Marketing.module.css";
import { PostcardCampaigns } from "./PostcardCampaigns";
import { PromoCodes } from "./PromoCodes";
import { EARNED_HINT, Referrals } from "./Referrals";
import { Reviews } from "./Reviews";
import { SenderAddressNote } from "./SenderAddress";
import { Showcases } from "./Showcases";
import { Social } from "./Social";
import { analyticsOn } from "./website";

/** A phone's layout, as menus decide it (the width they turn into sheets at). */
function usePhone() {
  return useSyncExternalStore(
    (changed) => {
      const query = window.matchMedia?.(SHEET_QUERY);
      query?.addEventListener("change", changed);
      return () => query?.removeEventListener("change", changed);
    },
    () => Boolean(window.matchMedia?.(SHEET_QUERY).matches),
    () => false,
  );
}

type Tab = "campaigns" | "social" | "showcases" | "promos" | "reviews" | "referrals" | "website";
// Charts load with the tab, not with the rest of Marketing.
const WebsiteSection = lazy(() => import("./WebsiteSection").then((m) => ({ default: m.WebsiteSection })));

export function MarketingPage() {
  const session = useSession();
  const [params, setParams] = useSearchParams();
  const website = analyticsOn(session);
  const asked = (params.get("tab") as Tab) || "campaigns";
  const tab = asked === "website" && !website ? "campaigns" : asked;
  const setTab = (t: Tab) => setParams({ tab: t }, { replace: true });
  // Six tabs don't fit a phone: the one picked is scrolled into view, and the strip shows there are more.
  const tabs = useTabStrip<HTMLDivElement>(tab);
  const phone = usePhone();
  const summary = useQuery({
    queryKey: ["marketing-summary", session.company.id],
    meta: { silent: true },
    queryFn: async () =>
      unwrap(await supabase().rpc("marketing_summary", { p_company_id: session.company.id })) as {
        campaigns_sent: number; emails_sent_30d: number; automated_sent_30d: number; reviews_requested_30d: number; reviews_clicked_30d: number; referrals_total: number; referrals_won: number;
        credits_owed: number; referral_revenue: number | null; campaign_revenue: number | null; opted_out: number;
      },
  });

  if (!hasRole(session, "admin", "office") || !can(session, "marketing")) return <NoAccess title="Marketing" />;
  if (!featureOn(session.company.settings, "marketing")) return <MarketingOff />;
  const s = summary.data;
  // App-Marketing.dc.html: the month's figures flat on hairlines, each opening the section it counts.
  // Short labels, as the board has them, with the 30 days leading the note, so a phone's two across don't wrap them.
  const strip = summary.isPending ? <StatsSkeleton count={5} /> : s && (
    <StatStrip label="Marketing" className={styles.stats}>
      <Stat label="Emails sent" value={s.emails_sent_30d.toLocaleString("en-US")} note={`Past 30 days · ${emailsSentHint(s)}`} onClick={tab === "campaigns" ? undefined : () => setTab("campaigns")} />
      {/* Someone without the Invoices area has no revenue to see. */}
      {s.campaign_revenue !== null && <Stat label="Revenue from campaigns" value={formatMoneyCents(s.campaign_revenue)} note="Paid work after a click, before tax" />}
      <Stat label="Review requests" value={s.reviews_requested_30d.toLocaleString("en-US")} note={`Past 30 days · ${s.reviews_requested_30d ? `${Math.round((s.reviews_clicked_30d / s.reviews_requested_30d) * 100)}% opened the link` : "None sent yet"}`} onClick={tab === "reviews" ? undefined : () => setTab("reviews")} />
      <Stat label="Referrals" value={s.referrals_total.toLocaleString("en-US")} note={`${s.referrals_won} became ${s.referrals_won === 1 ? "a job" : "jobs"}${s.referral_revenue === null ? "" : ` · ${formatMoneyCents(s.referral_revenue)} paid, before tax`}`} onClick={tab === "referrals" ? undefined : () => setTab("referrals")} />
      <Stat label={`Referral credits ${statusText("credit", "earned").toLowerCase()}`} value={formatMoneyCents(s.credits_owed)} note={EARNED_HINT} />
    </StatStrip>
  );
  return (
    <>
      <PageHeader title="Marketing" />
      <SenderAddressNote what="campaigns, review asks and referral asks by email won't go out" />
      {/* On a phone the sections come first, under the title, and the figures only on Campaigns (Mobile-Apps.dc.html): each other section has its own. */}
      {!phone && strip}
      {/* Words only, as the board has them; on a phone they're chips that scroll sideways (Mobile-Apps.dc.html). */}
      <div ref={tabs} className={cx("underline-tabs underline-tabs-compact", styles.tabs)} role="tablist" aria-label="Marketing sections">
        <button type="button" role="tab" aria-selected={tab === "campaigns"} onClick={() => setTab("campaigns")}>Campaigns</button>
        <button type="button" role="tab" aria-selected={tab === "social"} onClick={() => setTab("social")}>Social</button>
        <button type="button" role="tab" aria-selected={tab === "showcases"} onClick={() => setTab("showcases")}>Showcases</button>
        <button type="button" role="tab" aria-selected={tab === "promos"} onClick={() => setTab("promos")}>Promo codes</button>
        <button type="button" role="tab" aria-selected={tab === "reviews"} onClick={() => setTab("reviews")}>Reviews</button>
        <button type="button" role="tab" aria-selected={tab === "referrals"} onClick={() => setTab("referrals")}>Referrals</button>
        {website && <button type="button" role="tab" aria-selected={tab === "website"} onClick={() => setTab("website")}>Website</button>}
      </div>
      {phone && tab === "campaigns" && strip}
      {tab === "campaigns" && <Campaigns />}
      {tab === "social" && <Social />}
      {tab === "showcases" && <Showcases />}
      {tab === "promos" && <PromoCodes />}
      {tab === "reviews" && <Reviews />}
      {tab === "referrals" && <Referrals />}
      {tab === "website" && (
        <Suspense fallback={<Loading label="Loading website visits" className="stack"><CardSkeleton height={320} /></Loading>}>
          <WebsiteSection />
        </Suspense>
      )}
    </>
  );
}

/** Marketing isn't installed: say so, where to install it for those who can, and website visits, which are Website Analytics'. */
function MarketingOff() {
  const session = useSession();
  const canTurnOn = hasRole(session, "admin") && can(session, "apps");
  // Close pending quotes isn't marketing, so it keeps going while it's on: say so, and where it's turned off.
  const states = useAutomatedStates();
  const followUp = states.data?.find((x) => x.template_key === "quote_followup");
  return (
    <>
      <PageHeader title="Marketing" />
      {/* Not boxed: the page says it's off, what still works, and how to bring it back. */}
      <EmptyState icon="marketing" title="Marketing is off" action={canTurnOn && <Link className="btn btn-primary" to="/apps/marketing">Install Marketing</Link>}>
        {canTurnOn ? "Ask happy clients for reviews and referrals, send campaigns and post to your social pages. Install it to bring back everything you had." : "Ask an owner or admin to install Marketing from Apps."}
        {" "}Referral credits clients have earned, or earn later from links already shared, still go on their invoices.
        {followUp?.enabled && <>{" "}Following up on sent quotes keeps going.</>}
        {followUp?.enabled && can(session, "automations") && <>{" "}<Link to={`/automations/${followUp.rule_id}`}>Turn it off in Automations</Link>.</>}
      </EmptyState>
      {analyticsOn(session) && (
        <Section title="Website visits" flush>
          <Suspense fallback={<Loading label="Loading website visits" className="stack"><CardSkeleton height={320} /></Loading>}>
            <WebsiteSection />
          </Suspense>
        </Section>
      )}
    </>
  );
}

/**
 * The start of a one-off campaign row's quiet line, under its subject: when it went or goes. A sent
 * one's count follows in its results ("8 sent · 0% opened · 0% clicked"), so this says only when
 * (and how many failed), and the count only until its results are in.
 */
export function campaignRowWhen(
  c: { status: string; sent_count: number; failed_count: number; recipients_count: number; finished_at: string | null; scheduled_at: string | null; created_at: string },
  withResults: boolean,
): string {
  const failed = c.failed_count ? `${c.failed_count} failed` : null;
  if (c.status === "sent") return withResults ? [`Sent ${formatDate(c.finished_at)}`, failed].filter(Boolean).join(" · ") : `${c.sent_count} sent${failed ? `, ${failed}` : ""} · ${formatDate(c.finished_at)}`;
  if (c.status === "scheduled") return `Sends ${formatDateTime(c.scheduled_at!)}`;
  if (c.status === "sending") return `${c.sent_count} of ${c.recipients_count} sent…`;
  return `Edited ${timeAgo(c.created_at)}`;
}

function Campaigns() {
  const session = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const campaigns = useQuery({
    queryKey: ["campaigns", session.company.id],
    refetchInterval: (q) => ((q.state.data as Array<{ status: string }> | undefined)?.some((c) => c.status === "sending") ? 5000 : false),
    queryFn: async () =>
      unwrap(
        await supabase()
          .from("campaigns")
          .select("id, name, subject, status, recipients_count, sent_count, failed_count, scheduled_at, finished_at, created_at")
          .eq("company_id", session.company.id)
          .eq("kind", "one_off")
          .order("created_at", { ascending: false }),
      ),
  });
  const results = useCampaignResults();
  const create = useMutation({
    mutationFn: async () => unwrap(await supabase().from("campaigns").insert({ company_id: session.company.id, name: `Campaign ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" })}`, audience: { statuses: ["active"] } }).select("id").single()),
    onSuccess: (c) => {
      queryClient.invalidateQueries({ queryKey: ["campaigns", session.company.id] });
      navigate(`/marketing/campaigns/${c.id}`);
    },
  });
  const remove = useMutation({
    meta: { inline: true },
    mutationFn: async (id: string) => unwrap(await supabase().from("campaigns").delete().eq("id", id)),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ["campaigns", session.company.id] }),
  });
  type Campaign = NonNullable<typeof campaigns.data>[number];
  const key = ["campaigns", session.company.id];
  // Gone at once, with Undo; deleted for real once the toast leaves.
  const deleteCampaign = (campaign: Campaign) =>
    undoable({
      title: "Campaign deleted",
      hide: () => {
        void queryClient.cancelQueries({ queryKey: key });
        queryClient.setQueryData<Campaign[]>(key, (old) => old?.filter((c) => c.id !== campaign.id));
      },
      restore: () => queryClient.setQueryData<Campaign[]>(key, (old) => (old && !old.some((c) => c.id === campaign.id) ? [...old, campaign].sort((a, b) => b.created_at.localeCompare(a.created_at)) : old)),
      commit: () => remove.mutateAsync(campaign.id),
    });

  // One group on the grouped phone page: each section an inset card (Mobile-Apps.dc.html › Marketing).
  return (
    <DetailColumns grouped>
      {!session.config.features.email && (
        <div className="callout callout-info"><Icon name="info" size={16} /><div className="grow">Email isn't connected yet, so campaigns can't be sent.<ConnectEmailHint /></div></div>
      )}
      <AutomatedCampaigns results={results} />
      <Section title="One-off campaigns" count={campaigns.data?.length || undefined} flush action={<Button loading={create.isPending} onClick={() => create.mutate()}>New campaign</Button>}>
        {campaigns.isPending ? <InboxSkeleton rows={2} /> : campaigns.error ? (
          <ErrorState compact error={campaigns.error} onRetry={() => campaigns.refetch()} />
        ) : !campaigns.data?.length ? (
          <EmptyState inline title="No campaigns yet" action={<Button size="sm" icon="plus" onClick={() => create.mutate()}>Write a campaign</Button>} />
        ) : (
          <InboxList label="One-off campaigns" inset className={styles.flat}>
            <InboxGroup>
              {campaigns.data.map((c) => (
                <InboxRow
                  key={c.id}
                  to={`/marketing/campaigns/${c.id}`}
                  title={c.name}
                  avatar={false}
                  subject={c.subject || "No subject yet"}
                  // When, then what it brought in: on a phone that's a line of its own, so neither is cut short.
                  meta={[campaignRowWhen(c, Boolean(results.data)), (c.status === "sent" || c.status === "cancelled") && results.data ? <span className="meta-break">{resultsSummary(results.data.find((r) => r.campaign_id === c.id))}</span> : null]}
                  aside={
                    <>
                      <EntityStatus kind="campaign" status={c.status} />
                      {c.status === "sending" && <div className="progress" style={{ width: 90 }}><span style={{ width: `${c.recipients_count ? (c.sent_count / c.recipients_count) * 100 : 0}%` }} /></div>}
                    </>
                  }
                  actions={
                    <Menu
                      triggerClassName="btn btn-sm btn-ghost btn-icon"
                      label={`Actions for ${c.name}`}
                      title={c.name}
                      items={[
                        { label: c.status === "draft" ? "Edit" : "View", icon: c.status === "draft" ? "edit" : "eye", onSelect: () => navigate(`/marketing/campaigns/${c.id}`) },
                        { separator: true },
                        { label: "Delete", icon: "trash", danger: true, hidden: c.status === "sending", onSelect: () => deleteCampaign(c) },
                      ]}
                    />
                  }
                />
              ))}
            </InboxGroup>
          </InboxList>
        )}
      </Section>
      <PostcardCampaigns />
    </DetailColumns>
  );
}
