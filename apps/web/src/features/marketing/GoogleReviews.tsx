/**
 * Marketing → Reviews' Google reviews, once Google Business Profile is connected in Apps
 * (apps/api/src/services/googleReviews.ts brings them in): the numbers across the top as a flat
 * strip (Google's own average and count, the response rate, time to reply and asks that led to a
 * review), sections in the narrow column (the monthly trend, or what's in the way, or an invitation
 * to connect), and the reviews themselves under the ask settings, as inbox rows grouped by what
 * needs doing (Needs a reply, then Replied), each with its stars, the client it's matched to and its
 * reply. Replies post publicly on Google, so posting and changing one is confirmed first, and
 * Suggest a reply drafts one with Claude to read and change.
 *
 * Office staff can't read Apps, so what's connected comes from GET /api/reviews/google; the reviews
 * themselves are read through row-level security. ?review=<id> (a notification) shows that review
 * first with its reply open, and ?client=<id> (a client's page) shows only theirs.
 */
import { REPLY_MAX, replyTimeWords, responseRate, reviewerName, starsLabel, type ReviewMonth } from "@crewtavo/core/reviews";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { lazy, Suspense, useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Button, cx } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { Dialog } from "@/components/ui/Dialog";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { InboxGroup, InboxList, ListFoot, MetaLine, RowAge } from "@/components/ui/InboxList";
import { Menu, type MenuEntry } from "@/components/ui/Menu";
import { Section } from "@/components/ui/Section";
import { InboxSkeleton, Skeleton, StatsSkeleton } from "@/components/ui/Skeleton";
import { Stat, StatStrip } from "@/components/ui/StatStrip";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { EntityStatus } from "@/components/ui/StatusPill";
import { FilterTabs, Toolbar } from "@/components/ui/Toolbar";
import { api, supabase, unwrap } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { can, hasRole, useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { undoable } from "@/lib/undo";
import { ApprovalCallout, useCheckAgain, useSyncNow } from "../apps/GoogleBusinessPanel";
import { ClientPicker, type PickedClient } from "../clients/ClientForm";
import {
  canReply,
  canSync,
  clientDetail,
  countHint,
  filterReviews,
  filtersOn,
  firstNameOf,
  initials,
  NO_FILTERS,
  problemCopy,
  progressWords,
  rankSuggestions,
  repliedWords,
  sharedNames,
  tooSoon,
  waitingOnGoogle,
  type GoogleState,
  type ReviewFilters,
  type SuggestedClient,
} from "./googleReviewData";
import styles from "./Presence.module.css";
import { quotePickItem, QuoteReviewsCard, useQuoteReviews, useSetQuoteReviews } from "./QuoteReviews";
import { UsingChatGptPlan } from "@/features/apps/UsingChatGptPlan";

const ReviewTrend = lazy(() => import("./ReviewTrend").then((m) => ({ default: m.ReviewTrend })));

const PAGE = 25;
const FIELDS = "id, reviewer_name, reviewer_photo_url, reviewer_anonymous, rating, comment, posted_at, reply_comment, reply_updated_at, replied_by, client_id, match, client:clients(id, display_name)";

interface Review {
  id: string;
  reviewer_name: string | null;
  reviewer_photo_url: string | null;
  reviewer_anonymous: boolean;
  rating: number | null;
  comment: string | null;
  posted_at: string;
  reply_comment: string | null;
  reply_updated_at: string | null;
  replied_by: string | null;
  client_id: string | null;
  match: string;
  client: { id: string; display_name: string } | null;
}

export interface ReviewStats {
  count: number;
  average: number | null;
  by_stars: Record<string, number>;
  needs_reply: number;
  replied: number;
  count_12m: number;
  replied_12m: number;
  median_reply_hours: number | null;
  months: ReviewMonth[];
  unmatched: number;
  asks_12m: number;
  asks_reviewed_12m: number;
}

/**
 * What Google Business Profile is up to, for the tab. Followed every few seconds while a sync runs,
 * and now and then while the first one is under way between runs. Not while it waits on Google or a
 * person: the server says no progress then.
 */
export function useGoogleState() {
  const session = useSession();
  return useQuery({
    queryKey: ["google-reviews", session.company.id],
    queryFn: () => api.get<GoogleState>("/reviews/google"),
    refetchInterval: (q) => (q.state.data?.syncing ? 5000 : q.state.data?.progress ? 30_000 : false),
  });
}

export function useReviewStats(enabled: boolean) {
  const session = useSession();
  return useQuery({
    queryKey: ["review-stats", session.company.id],
    enabled,
    queryFn: async () => unwrap(await supabase().rpc("review_stats", { p_company: session.company.id })) as unknown as ReviewStats,
  });
}

/** Everything on the tab that changes when a review, its reply or its match does. */
function useRefresh() {
  const session = useSession();
  const queryClient = useQueryClient();
  return () => {
    for (const key of ["reviews", "review", "review-stats", "google-reviews", "review-requests"]) queryClient.invalidateQueries({ queryKey: [key, session.company.id] });
  };
}

/** A review's stars, lit and unlit, small enough to sit on its name's line. */
function Stars({ rating }: { rating: number | null }) {
  if (!rating) return <span className={styles.noStars}>No stars</span>;
  return (
    <span className={styles.stars} role="img" aria-label={starsLabel(rating)}>
      <span className={styles.starsOn}>{"★".repeat(rating)}</span>
      <span className={styles.starsOff}>{"★".repeat(5 - rating)}</span>
    </span>
  );
}

/** The numbers across the top: Google's own average and count, so they match what customers see. */
export function GoogleNumbers({ g, stats }: { g: GoogleState; stats: ReturnType<typeof useReviewStats> }) {
  if (stats.isPending) return <StatsSkeleton count={5} />;
  if (stats.error || !stats.data) return <ErrorState compact error={stats.error} onRetry={() => stats.refetch()} />;
  const s = stats.data;
  const average = g.google.average_rating ?? s.average;
  const total = g.google.total_reviews ?? s.count;
  const rate = responseRate(s.replied_12m, s.count_12m);
  return (
    <StatStrip label="Google reviews">
      {/* A figure there's nothing to work out yet (no reviews, no replies) is left out, not shown as "—". */}
      {average ? (
        <Stat
          label="Average rating"
          value={<><span className={styles.statStar} aria-hidden>★</span>{Number(average).toFixed(1)}</>}
          note={g.google.average_rating !== null ? "As Google shows it" : "From the reviews here"}
        />
      ) : null}
      <Stat label="Reviews" value={total.toLocaleString("en-US")} note={countHint(g, s.unmatched)} />
      {rate !== null && <Stat label="Response rate" value={`${rate}%`} note="Reviews in the last 12 months with a reply" />}
      {replyTimeWords(s.median_reply_hours) && <Stat label="Time to reply" value={replyTimeWords(s.median_reply_hours)!} note="Usually, over the last 12 months" />}
      <Stat
        label="Asks that led to a review"
        value={s.asks_reviewed_12m.toLocaleString("en-US")}
        note={s.asks_12m ? `Of ${s.asks_12m.toLocaleString("en-US")} asks in the last 12 months` : "No asks in the last 12 months"}
      />
    </StatStrip>
  );
}

/** Not connected: a short section saying what it adds, and who can connect it. */
function ConnectGoogleCard({ g }: { g: GoogleState }) {
  return (
    <Section title="Google reviews">
      <div className={styles.copy}>
        <p className={styles.note}>
          Connect Google Business Profile to see your reviews here, reply with a suggestion, and stop asking clients who already left one. Google approves each server first, which
          takes about 2 weeks.
        </p>
        {g.can_connect ? <Link className={styles.textLink} to="/apps/google_business">Connect Google Business Profile</Link> : <p className={styles.note}>Ask an owner or admin to connect it in Apps.</p>}
      </div>
    </Section>
  );
}

/**
 * The narrow column: an invitation to connect, or what's in the way (Google's approval, with Check
 * again for owners and admins, or a sign-in or location problem), then the monthly trend whenever
 * there are reviews here, with how many need a reply while replies can be posted.
 */
export function GoogleSide({ g, stats }: { g: GoogleState | undefined; stats: ReturnType<typeof useReviewStats> }) {
  const session = useSession();
  const refresh = useRefresh();
  const check = useCheckAgain(refresh);
  if (!g) return null;
  if (g.state === "not_connected") return <ConnectGoogleCard g={g} />;
  const waiting = waitingOnGoogle(g);
  const copy = waiting ? null : problemCopy(g, session.company.timezone);
  const s = stats.data;
  return (
    <>
      {waiting && (
        <div className={styles.copy}>
          <ApprovalCallout own={g.own_app} projectNumber={g.project_number} admin={g.can_connect} notEnabled={g.state === "not_enabled"}
            onCheck={g.can_connect ? () => check.mutate() : undefined} checking={check.isPending} />
          <FormError error={check.error} />
          {g.can_connect && <Link className={styles.textLink} to="/apps/google_business">Open Google Business Profile in Apps</Link>}
        </div>
      )}
      {copy && (
        <div className={`callout callout-${copy.tone}`} role="status">
          <Icon name={copy.tone === "info" ? "info" : "alert"} size={16} />
          <div className="grow stack-sm" style={{ gap: 4 }}>
            <span>{copy.title}</span>
            {copy.body && <span style={{ fontWeight: 400 }}>{copy.body}</span>}
            {copy.link && <Link to="/apps/google_business" style={{ fontWeight: 400 }}>{copy.link}</Link>}
          </div>
        </div>
      )}
      {/* Which reviews clients see on their quotes, once there are any to show. */}
      <QuoteReviewsCard hasReviews={Boolean(s && s.count > 0)} />
      {s && s.count > 0 && (
        <Section title="Reviews each month">
          <div className={styles.copy}>
            <Suspense fallback={<Skeleton height={150} />}><ReviewTrend months={s.months} timeZone={session.company.timezone} /></Suspense>
            {s.needs_reply > 0 && canReply(g) && <p className={styles.warnLine}>{s.needs_reply === 1 ? "1 review needs a reply" : `${s.needs_reply.toLocaleString("en-US")} reviews need a reply`}</p>}
          </div>
        </Section>
      )}
    </>
  );
}

type Shown = "all" | "needs";

/**
 * The filters past the two tabs, in one menu: the stars and whether it's matched to a client, each a
 * sub menu of choices with the one picked shown at its end, and Clear once any is on.
 */
function moreFilters(filters: ReviewFilters, change: (next: ReviewFilters) => void): MenuEntry[] {
  const starWords = (n: number) => (n === 1 ? "1 star" : `${n} stars`);
  const matchWords = { all: "Any", matched: "Matched", unmatched: "Not matched" } as const;
  return [
    {
      label: "Stars",
      icon: "star",
      end: filters.stars ? starWords(filters.stars) : "Any",
      items: [
        { label: "Any stars", checked: filters.stars === null, onSelect: () => change({ ...filters, stars: null }) },
        { separator: true },
        ...[5, 4, 3, 2, 1].map((n) => ({ label: starWords(n), checked: filters.stars === n, onSelect: () => change({ ...filters, stars: n }) })),
      ],
    },
    {
      label: "Client",
      icon: "user",
      end: matchWords[filters.matched],
      items: [
        { label: "Any review", checked: filters.matched === "all", onSelect: () => change({ ...filters, matched: "all" }) },
        { label: "Matched to a client", checked: filters.matched === "matched", onSelect: () => change({ ...filters, matched: "matched" }) },
        { label: "Not matched", checked: filters.matched === "unmatched", onSelect: () => change({ ...filters, matched: "unmatched" }) },
      ],
    },
    { separator: true, hidden: filters.stars === null && filters.matched === "all" },
    { label: "Clear filters", icon: "x", hidden: filters.stars === null && filters.matched === "all", onSelect: () => change({ ...filters, stars: null, matched: "all" }) },
  ];
}

/** The reviews, newest first, a page at a time, under a heading with when they last came in and Sync now. */
export function GoogleReviewList({ g }: { g: GoogleState }) {
  const session = useSession();
  const refresh = useRefresh();
  const [params, setParams] = useSearchParams();
  const focus = params.get("review");
  const forClientParam = params.get("client");
  const [filters, setFilters] = useState<ReviewFilters>(() => ({ ...NO_FILTERS, client: forClientParam }));
  const [limit, setLimit] = useState(PAGE);
  const [matching, setMatching] = useState<Review | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  // ?client= follows the address, so See their review on this same tab shows theirs, and brings the list into view.
  useEffect(() => {
    if (!forClientParam) return;
    setFilters({ ...NO_FILTERS, client: forClientParam });
    setLimit(PAGE);
    document.getElementById("google-reviews")?.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [forClientParam]);
  // Changing what's shown lets go of the link that brought the person here.
  const change = (next: ReviewFilters) => {
    setFilters(next);
    setLimit(PAGE);
    if (params.has("review") || params.has("client")) setParams({ tab: "reviews" }, { replace: true });
  };
  const key = ["reviews", session.company.id, filters, limit, g.location?.id ?? null];
  const list = useQuery({
    queryKey: key,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      let q = supabase().from("reviews").select(FIELDS, { count: "exact" }).eq("company_id", session.company.id).is("deleted_at", null);
      if (g.location) q = q.eq("location_id", g.location.id);
      const { data, error, count } = await filterReviews(q, filters).order("posted_at", { ascending: false }).order("id").limit(limit);
      return { rows: unwrap({ data, error }) as unknown as Review[], total: count ?? 0 };
    },
  });
  // The review a notification links to, first and whatever the filters, even past the first page.
  const focused = useQuery({
    queryKey: ["review", session.company.id, focus],
    enabled: Boolean(focus),
    queryFn: async () => unwrap(await supabase().from("reviews").select(FIELDS).eq("company_id", session.company.id).eq("id", focus!).maybeSingle()) as unknown as Review | null,
  });
  const forClient = useQuery({
    queryKey: ["client-name", filters.client],
    enabled: Boolean(filters.client),
    queryFn: async () => unwrap(await supabase().from("clients").select("display_name").eq("id", filters.client!).maybeSingle()),
  });
  // How many need a reply, for the filter's count (the same figures as the strip above).
  const stats = useReviewStats(true);
  const rows = list.data?.rows ?? [];
  const shown = focused.data ? [focused.data, ...rows.filter((r) => r.id !== focused.data!.id)] : rows;
  const repliers = [...new Set(shown.map((r) => r.replied_by).filter((id): id is string => Boolean(id)))];
  const people = useQuery({
    queryKey: ["profiles", repliers],
    enabled: repliers.length > 0,
    queryFn: async () => unwrap(await supabase().from("profiles").select("user_id, full_name").in("user_id", repliers)),
  });
  const names = new Map((people.data ?? []).map((p) => [p.user_id, p.full_name?.split(" ")[0] ?? ""] as const));
  useEffect(() => {
    if (focused.data) document.getElementById(`review-${focused.data.id}`)?.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }, [focused.data]);

  const sync = useSyncNow(() => setTimeout(refresh, 1500));
  // Picking a review to show on quotes, from its menu (QuoteReviews.tsx).
  const quotePicks = useQuoteReviews();
  const setPicks = useSetQuoteReviews();
  const pickFor = (id: string) => quotePickItem(id, quotePicks.data, (ids) => quotePicks.data && setPicks.mutate({ show: quotePicks.data.show, pdf: quotePicks.data.pdf, ids }));
  const setClient = useMutation({
    mutationFn: (v: { review: Review; client: { id: string; display_name: string } | null }) => api.put(`/reviews/${v.review.id}/client`, { client_id: v.client?.id ?? null }),
    onSuccess: (_, v) => {
      if (v.client) toast.success(`Matched to ${v.client.display_name}. They won't be asked for reviews again.`);
    },
    onSettled: refresh,
  });
  const queryClient = useQueryClient();
  type Page = { rows: Review[]; total: number };
  const notThem = (review: Review) =>
    undoable({
      title: `Asks can go to ${review.client?.display_name ?? "them"} again`,
      hide: () => {
        void queryClient.cancelQueries({ queryKey: key });
        queryClient.setQueryData<Page>(key, (old) => old && { ...old, rows: old.rows.map((r) => (r.id === review.id ? { ...r, client: null, client_id: null, match: "none" } : r)) });
      },
      restore: () => queryClient.setQueryData<Page>(key, (old) => old && { ...old, rows: old.rows.map((r) => (r.id === review.id ? review : r)) }),
      commit: () => setClient.mutateAsync({ review, client: null }),
    });

  const total = list.data?.total ?? 0;
  const live = canReply(g);
  const progress = progressWords(g.progress);
  const row = (r: Review, showStatus: boolean) => (
    <ReviewRow
      key={r.id}
      review={r}
      names={names}
      highlight={r.id === focused.data?.id}
      live={live}
      showStatus={showStatus}
      onMatch={() => { setMatching(r); setDialogOpen(true); }}
      onNotThem={() => notThem(r)}
      onChanged={refresh}
      quotePick={pickFor(r.id)}
    />
  );
  // Grouped by what needs doing while replies can be posted: those still to answer first.
  const rest = focused.data ? shown.slice(1) : shown;
  const grouped = live && !filters.needsReply;
  const waitingOnUs = grouped ? rest.filter((r) => !r.reply_comment) : [];
  const answered = grouped ? rest.filter((r) => r.reply_comment) : [];
  const shownFilter: Shown = filters.needsReply ? "needs" : "all";
  const needsCount = stats.data?.needs_reply;
  return (
    <Section
      id="google-reviews"
      title="Your Google reviews"
      flush
      action={
        <>
          <span className={styles.syncNote} data-progress={progress ? "" : undefined} role="status">{progress ?? (g.last_synced_at ? `Last synced ${timeAgo(g.last_synced_at)}` : null)}</span>
          {canSync(g) && <Button size="sm" variant="ghost" icon="refresh" loading={sync.isPending || g.syncing} onClick={() => sync.mutate()}>Sync now</Button>}
        </>
      }
    >
      <div className={styles.listBody}>
        <FormError error={tooSoon(sync.error) ? null : sync.error} />
        {/* Nothing to filter until there are reviews here. */}
        {g.reviews > 0 && <div className={styles.reviewTools}><Toolbar
          label="Show"
          filters={
            <FilterTabs<Shown>
              label="Show reviews"
              value={shownFilter}
              onChange={(v) => change({ ...filters, needsReply: v === "needs" })}
              options={[
                { value: "all", label: "All", count: g.reviews },
                { value: "needs", label: "Needs a reply", count: needsCount },
              ]}
            />
          }
          tools={
            <Menu
              items={moreFilters(filters, change)}
              align="end"
              label={filters.stars !== null || filters.matched !== "all" ? "More filters, some on" : "More filters"}
              title="Filter reviews"
              triggerClassName={cx("btn btn-sm btn-ghost toolbar-btn", (filters.stars !== null || filters.matched !== "all") && "is-on")}
              trigger={
                <>
                  <Icon name="filter" size={15} />
                  <span className="toolbar-btn-text">Filter</span>
                  {(filters.stars !== null || filters.matched !== "all") && <span className="badge toolbar-btn-count">{Number(filters.stars !== null) + Number(filters.matched !== "all")}</span>}
                </>
              }
            />
          }
        >
          {filters.client && (
            <button type="button" className="chip" aria-label="Show every client's reviews" onClick={() => change({ ...filters, client: null })}>
              {forClient.data?.display_name ?? "One client"}
              <Icon name="x" size={12} />
            </button>
          )}
        </Toolbar></div>}
        {list.isPending && <InboxSkeleton rows={3} />}
        {list.error && <ErrorState compact error={list.error} onRetry={() => list.refetch()} />}
        {list.data && !shown.length && (
          filtersOn(filters)
            ? <EmptyState inline title="No reviews match" action={<Button size="sm" onClick={() => change(NO_FILTERS)}>Clear filters</Button>} />
            : <EmptyState inline title="No reviews yet">{progress ?? "New Google reviews show here."}</EmptyState>
        )}
        {shown.length > 0 && (
          <InboxList
            label="Google reviews"
            inset
            stale={list.isPlaceholderData}
            className={styles.reviewList}
            foot={total > PAGE && (
              <ListFoot
                end={rows.length >= total ? <button type="button" className="il-more" onClick={() => setLimit(PAGE)}>Show less</button> : undefined}
                more={rows.length < total ? { onClick: () => setLimit((l) => l + PAGE), loading: list.isFetching } : undefined}
              >
                Showing {rows.length.toLocaleString("en-US")} of {total.toLocaleString("en-US")}
              </ListFoot>
            )}
          >
            {focused.data && (
              <InboxGroup label="From your notification" icon="bell" end={<button type="button" onClick={() => setParams({ tab: "reviews" }, { replace: true })}>Show all reviews</button>}>
                {row(focused.data, true)}
              </InboxGroup>
            )}
            {grouped ? (
              <>
                {waitingOnUs.length > 0 && <InboxGroup label="Needs a reply" count={waitingOnUs.length} tone="warning" icon="reply">{waitingOnUs.map((r) => row(r, false))}</InboxGroup>}
                {answered.length > 0 && <InboxGroup label="Replied" count={answered.length}>{answered.map((r) => row(r, false))}</InboxGroup>}
              </>
            ) : rest.length > 0 && (
              focused.data ? <InboxGroup label="Other reviews">{rest.map((r) => row(r, !filters.needsReply))}</InboxGroup> : <InboxGroup>{rest.map((r) => row(r, !filters.needsReply))}</InboxGroup>
            )}
          </InboxList>
        )}
      </div>
      <MatchDialog review={matching} open={dialogOpen} onClose={() => setDialogOpen(false)} onExited={() => setMatching(null)}
        onPick={(client) => { setDialogOpen(false); setClient.mutate({ review: matching!, client }); }} />
    </Section>
  );
}

const LONG = 320;

/**
 * One review. The status and the menu sit on the name's line, so on a phone the words and the reply
 * get the row's whole width beside the photo.
 */
function ReviewRow({ review: r, names, highlight, live, showStatus, onMatch, onNotThem, onChanged, quotePick }: {
  review: Review;
  names: ReadonlyMap<string, string>;
  highlight: boolean;
  live: boolean;
  /** The reply status on the name's line, where the group heading doesn't already say it. */
  showStatus: boolean;
  onMatch: () => void;
  onNotThem: () => void;
  onChanged: () => void;
  /** Show on quotes, or stop. */
  quotePick: ReturnType<typeof quotePickItem>;
}) {
  const navigate = useNavigate();
  const [more, setMore] = useState(false);
  const [broken, setBroken] = useState(false);
  const known = reviewerName(r);
  const name = known ?? "A Google user";
  const text = r.comment ?? "";
  const long = text.length > LONG;
  return (
    <li id={`review-${r.id}`} className={cx("il-row", styles.review)} data-highlight={highlight || undefined}>
      <span className="il-avatar" aria-hidden>
        {r.reviewer_photo_url && !broken
          ? <img className={styles.avatarPhoto} src={r.reviewer_photo_url} alt="" referrerPolicy="no-referrer" loading="lazy" onError={() => setBroken(true)} />
          : known ? initials(known) : <Icon name="user" size={16} />}
      </span>
      <div className={styles.reviewBody}>
        <div className={styles.reviewHead}>
          <div className={styles.reviewWho}>
            <strong>{name}</strong>
            <Stars rating={r.rating} />
            {showStatus && <EntityStatus kind="review" status={r.reply_comment ? "replied" : "needs_reply"} />}
          </div>
          <RowAge at={r.posted_at} />
          <Menu
            triggerClassName={cx("btn btn-sm btn-ghost btn-icon", styles.rowMore)}
            label="Review actions"
            title={name}
            items={[
              { label: r.client ? "Match to another client…" : "Match to a client…", icon: "user", kbd: "M", onSelect: onMatch },
              { label: "Not this client", icon: "x", hidden: !r.client, onSelect: onNotThem },
              { separator: true },
              // A 4 or 5-star review with words can be posted as a card (Marketing → Social).
              { label: "Post on social", icon: "share", kbd: "P", hidden: (r.rating ?? 0) < 4 || !text.trim(), onSelect: () => navigate(`/marketing?tab=social&compose=review&review=${r.id}`) },
              quotePick,
            ]}
          />
        </div>
        {text && (
          <p className={cx("pre-wrap", styles.reviewText)}>
            {long && !more ? `${text.slice(0, LONG).trimEnd()}…` : text}
            {long && <>{" "}<button type="button" className="link-btn small" onClick={() => setMore(!more)}>{more ? "Less" : "More"}</button></>}
          </p>
        )}
        <MetaLine
          className={styles.reviewMeta}
          parts={[
            r.client ? <Link to={`/clients/${r.client.id}`}>{r.client.display_name}</Link> : r.reviewer_anonymous ? "Anonymous, so not matched" : "Not matched to a client",
            r.client && r.match === "auto" && "Matched by name",
          ]}
        />
        <Reply review={r} names={names} live={live} open={highlight && !r.reply_comment} onChanged={onChanged} />
      </div>
    </li>
  );
}

/**
 * A review's reply: the one posted, with who and when, Edit and Delete; or the editor, with Suggest
 * a reply and Rewrite when Claude is set up. Posting and updating say first that everyone can read it.
 * `open` (the review a notification links to, with no reply yet) opens the editor, also when it
 * turns true after the row is already showing.
 */
function Reply({ review: r, names, live, open, onChanged }: { review: Review; names: ReadonlyMap<string, string>; live: boolean; open: boolean; onChanged: () => void }) {
  const session = useSession();
  const [editing, setEditing] = useState(open);
  const [text, setText] = useState(r.reply_comment ?? "");
  useEffect(() => {
    if (open) setEditing(true);
  }, [open]);
  const reviewer = reviewerName(r);
  const aiOn = session.config.features.ai;
  // The reply in the box came from "Suggest a reply": said under it until it's posted or put away.
  const [suggested, setSuggested] = useState(false);
  const post = useMutation({
    meta: { inline: true },
    mutationFn: (comment: string) => api.put(`/reviews/${r.id}/reply`, { comment }),
    onSuccess: () => {
      toast.success(r.reply_comment ? "Reply updated on Google" : "Reply posted on Google");
      setEditing(false);
      onChanged();
    },
  });
  const remove = useMutation({
    meta: { inline: true, success: "Reply deleted from Google" },
    mutationFn: () => api.delete(`/reviews/${r.id}/reply`),
    onSuccess: () => {
      setText("");
      onChanged();
    },
  });
  const suggest = useMutation({
    meta: { inline: true },
    mutationFn: () => api.post<{ text: string }>(`/reviews/${r.id}/suggest`, text.trim() ? { draft: text.trim() } : {}),
    onSuccess: (res) => {
      setText(res.text);
      setSuggested(true);
    },
  });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const comment = text.trim();
    if (!comment) return;
    const updating = Boolean(r.reply_comment);
    const ok = await confirm({
      title: updating ? "Update your reply on Google?" : "Post this reply on Google?",
      body: (
        <div className="stack-sm">
          <p style={{ margin: 0 }}>Everyone can read it on Google, under {reviewer ? `${reviewer}'s review` : "the review"}.</p>
          <blockquote className={cx("pre-wrap", styles.quote)}>{comment}</blockquote>
        </div>
      ),
      confirmLabel: updating ? "Update reply" : "Post reply",
    });
    if (ok) post.mutate(comment);
  };
  const askDelete = async () => {
    if (await confirm({ title: "Delete your reply on Google?", body: "It comes off the review on Google for everyone. The review stays.", confirmLabel: "Delete reply", danger: true })) remove.mutate();
  };

  if (r.reply_comment && !editing) {
    return (
      <div className={styles.reply}>
        <span className={styles.replyLabel}>Your reply</span>
        <p className={cx("pre-wrap", styles.replyText)}>{r.reply_comment}</p>
        <MetaLine
          className={styles.replyMeta}
          parts={[
            repliedWords(r, names),
            live && <button type="button" className="link-btn" onClick={() => { setText(r.reply_comment ?? ""); setEditing(true); }}>Edit</button>,
            live && <button type="button" className="link-btn" onClick={askDelete}>Delete</button>,
          ]}
        />
        <FormError error={remove.error} />
      </div>
    );
  }
  if (!live) return null;
  if (!editing) return <Button size="sm" className={styles.replyButton} icon="reply" onClick={() => setEditing(true)}>Reply</Button>;
  const canAddKey = hasRole(session, "admin") && can(session, "apps");
  return (
    <form className={styles.replyForm} onSubmit={submit}>
      <textarea className="textarea" aria-label={reviewer ? `Reply to ${reviewer}` : "Reply to the review"} style={{ minHeight: 90 }} value={text} maxLength={REPLY_MAX} onChange={(e) => setText(e.target.value)} placeholder="Thank them, and keep it short." autoFocus={!open} />
      <div className={styles.replyBar}>
        <Button type="submit" size="sm" variant="primary" loading={post.isPending} disabled={!text.trim()}>{r.reply_comment ? "Update reply" : "Post reply"}</Button>
        <Button size="sm" icon="sparkle" loading={suggest.isPending} disabled={!aiOn} onClick={() => suggest.mutate()}>{text.trim() ? "Rewrite" : "Suggest a reply"}</Button>
        <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setText(r.reply_comment ?? ""); }}>Cancel</Button>
        <span className="muted small grow" style={{ textAlign: "right", whiteSpace: "nowrap" }}>{text.length.toLocaleString("en-US")} / {REPLY_MAX.toLocaleString("en-US")}</span>
      </div>
      <UsingChatGptPlan />
      {!aiOn && (
        <span className="muted small">
          {canAddKey ? <><Link to="/apps">Add a Claude or OpenAI key in Apps</Link> to draft replies.</> : "An admin can add a Claude or OpenAI key on the Apps page to draft replies."}
        </span>
      )}
      {/* The words above came from AI: said to whoever posts them. */}
      {suggested && <span className="muted small" role="status">Written by AI from their review. It can be wrong: read it and make it yours before you post it.</span>}
      <FormError error={post.error ?? suggest.error} />
    </form>
  );
}

/** Match to a client: anyone, with the clients whose name fits the reviewer's first. */
function MatchDialog({ review, open, onClose, onExited, onPick }: { review: Review | null; open: boolean; onClose: () => void; onExited: () => void; onPick: (client: { id: string; display_name: string }) => void }) {
  const session = useSession();
  const [picked, setPicked] = useState<PickedClient>(null);
  const reviewer = review ? reviewerName(review) : null;
  const first = firstNameOf(reviewer);
  const suggestions = useQuery({
    queryKey: ["review-suggestions", session.company.id, review?.id],
    enabled: open && Boolean(reviewer) && first.length > 1,
    queryFn: async () => {
      // What tells two clients of the same name apart, as the client picker shows it.
      const rows = unwrap(
        await supabase().from("clients").select("id, display_name, company_name, email, phone, properties(line1)").eq("company_id", session.company.id).ilike("display_name", `${first}%`).order("display_name").limit(20),
      ) as SuggestedClient[];
      return rankSuggestions({ name: review!.reviewer_name, anonymous: review!.reviewer_anonymous }, rows).slice(0, 5);
    },
  });
  const twins = sharedNames(suggestions.data ?? []);
  return (
    <Dialog open={open} onClose={onClose} onExited={() => { setPicked(null); onExited(); }} title="Match to a client" description={review ? `Who left ${reviewer ? `${reviewer}'s review` : "this review"}? They won't be asked for reviews again.` : undefined}>
      <form className="dialog-body stack" onSubmit={(e: FormEvent) => { e.preventDefault(); if (picked) onPick({ id: picked.id, display_name: picked.display_name }); }}>
        {(suggestions.data?.length ?? 0) > 0 && (
          <div className={styles.options} role="group" aria-labelledby="names-that-fit">
            <span id="names-that-fit" className={styles.optionsLabel}>Names that fit</span>
            {suggestions.data!.map((c) => {
              const detail = clientDetail(c);
              // Two of the same name: a click picks this one below, and Match matches it.
              const twin = twins.has(c.id);
              const on = twin && picked?.id === c.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  className={styles.option}
                  aria-pressed={twin ? on : undefined}
                  onClick={() => (twin ? setPicked({ id: c.id, display_name: c.display_name }) : onPick(c))}
                >
                  <span className={styles.optionFace} aria-hidden>{initials(c.display_name)}</span>
                  <span className={styles.optionText}>
                    <span className={styles.optionName}>{c.display_name}</span>
                    {detail && <span className={styles.optionDetail}>{detail}</span>}
                  </span>
                  {on ? <Icon name="check" size={16} /> : !twin && <Icon name="chevronRight" size={16} />}
                </button>
              );
            })}
            {twins.size > 0 && <span className="muted small">Two clients have that name: pick the right one, then Match.</span>}
          </div>
        )}
        <ClientPicker value={picked} onChange={setPicked} allowCreate={false} />
        <div className="form-actions">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={!picked}>Match</Button>
        </div>
      </form>
    </Dialog>
  );
}
