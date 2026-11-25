/**
 * Marketing → Social (docs/marketing-plan.md, phase E): posts to the business's own Facebook Page,
 * Instagram account and Google Business Profile, made from photos OK to share, a 4 or 5-star review
 * or words alone (SocialComposer), now or later. Scheduled posts can be changed or cancelled until
 * they start; each post says how it went on each network, with its link or what went wrong, and one
 * that may have posted is settled by a person. In the narrow column: where posts can go, and automatic
 * 5-star posts. Laid out as App-Marketing.dc.html's sections: posts are inbox rows on hairlines (a
 * draft or a scheduled post opens to edit), New post a quiet action on its section's heading; on a
 * phone each section is an inset card on the grouped screen (Mobile-Apps.dc.html › Marketing).
 *
 * Office staff can't read Apps, so what's connected comes from GET /api/social. ?compose=photos&photos=…
 * (a job's Photos card) and ?compose=review&review=… (Marketing → Reviews) open a new post with those
 * picked, and ?post=<id> (a notification) brings that post into view once, then leaves the address.
 */
import { AUTO_POSTS_PER_DAY, brandColor, cardColors, NETWORK_NAMES, NETWORKS, networkWords, timeZoneWords, type Network } from "@crewtavo/core/social";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Button, cx } from "@/components/ui/Button";
import { confirm } from "@/components/ui/Confirm";
import { DetailColumns } from "@/components/ui/DetailPage";
import { FormError } from "@/components/ui/Field";
import { Icon } from "@/components/ui/Icon";
import { InfoTip } from "@/components/ui/InfoTip";
import { SourceMark } from "./SourceMark";
import { InboxGroup, InboxList, InboxRow, ListFoot } from "@/components/ui/InboxList";
import { Menu } from "@/components/ui/Menu";
import { RelatedList, RelatedRow, Section } from "@/components/ui/Section";
import { InboxSkeleton, SectionSkeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { EntityStatus, StatusPill } from "@/components/ui/StatusPill";
import { api } from "@/lib/api";
import { clockText } from "@/lib/format";
import { useSession } from "@/lib/session";
import { toast } from "@/lib/toast";
import { undoable } from "@/lib/undo";
import styles from "./Presence.module.css";
import { ShareElsewhere } from "./ShareElsewhere";
import { SocialComposer, type ComposerStart } from "./SocialComposer";
import { CHECK_WORDS, networkChoices, networkLine, postSummary, socialKey, sourceWords, useSocialPosts, useSocialState, whenWords, type SocialPost, type SocialState } from "./socialData";

export function Social() {
  const session = useSession();
  const [params, setParams] = useSearchParams();
  const state = useSocialState();
  const done = useSocialPosts("done");
  const [composing, setComposing] = useState<{ post?: SocialPost | null; start?: ComposerStart | null } | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);

  // A notification's post: shown once, and the address let go so it isn't scrolled to again.
  useEffect(() => {
    const post = params.get("post");
    if (!post) return;
    setHighlight(post);
    setParams((now) => {
      const next = new URLSearchParams(now);
      next.delete("post");
      return next;
    }, { replace: true });
  }, [params, setParams]);

  // Opened from a job's photos or a review: a new post with them picked. A showcase's comes with
  // its caption (its title, write-up and link) too.
  useEffect(() => {
    const compose = params.get("compose");
    if (!compose || !state.data) return;
    setComposing({
      start: compose === "review"
        ? { source: "review", review: params.get("review") ?? undefined }
        : { source: "photos", photos: (params.get("photos") ?? "").split(",").filter(Boolean), job: params.get("job") ?? undefined, caption: params.get("caption") ?? undefined },
    });
    setParams({ tab: "social" }, { replace: true });
  }, [params, state.data, setParams]);

  if (state.isPending) {
    return (
      <div className={cx("m-grouped", styles.tab)}>
        <DetailColumns side={<SectionSkeleton rows={3} />}><InboxSkeleton rows={3} /></DetailColumns>
      </div>
    );
  }
  if (state.error) return <ErrorState error={state.error} onRetry={() => state.refetch()} />;
  const s = state.data;
  const nothing = !s.networks.facebook.connected && !s.networks.instagram.connected && !s.networks.google.ready;
  // Null while it isn't known yet.
  const noneDone = done.isPending ? null : done.isSuccess && !done.data.pages.some((p) => p.posts.length);

  return (
    <div className={cx("m-grouped", styles.tab)}>
      <DetailColumns
        side={
          <>
            <WherePosts state={s} />
            <AutoPosts state={s} timeZone={session.company.timezone} />
          </>
        }
      >
        <PostList list="upcoming" state={s} title="Drafts and scheduled" nothing={nothing} noneDone={noneDone} onNew={() => setComposing({})} onEdit={(post) => setComposing({ post })} highlight={highlight} />
        <PostList list="done" state={s} title="Posts" nothing={nothing} noneDone={noneDone} onNew={() => setComposing({})} onEdit={(post) => setComposing({ post })} highlight={highlight} />
      </DetailColumns>
      {composing && <SocialComposer key={composing.post?.id ?? "new"} open onClose={() => setComposing(null)} state={s} post={composing.post} start={composing.start} />}
    </div>
  );
}

function PostList({ list, state, title, nothing, noneDone, onNew, onEdit, highlight }: { list: "upcoming" | "done"; state: SocialState; title: string; nothing: boolean; noneDone: boolean | null; onNew: () => void; onEdit: (post: SocialPost) => void; highlight: string | null }) {
  const posts = useSocialPosts(list);
  const rows = posts.data?.pages.flatMap((p) => p.posts) ?? [];
  // New post sits on the first section's heading, as App-Marketing.dc.html's New campaign does.
  const action = list === "upcoming" ? <Button icon="plus" onClick={onNew}>New post</Button> : undefined;
  if (posts.isPending || (list === "upcoming" && noneDone === null && !rows.length)) return <Section title={title} action={action} flush><InboxSkeleton rows={2} /></Section>;
  if (posts.error) return <ErrorState error={posts.error} onRetry={() => posts.refetch()} />;
  if (!rows.length) {
    if (list === "done") return null;
    // The big empty state only when there's nothing at all: posts that went are listed below.
    if (!noneDone) return <Section title={title} action={action}><p className={styles.note}>Nothing scheduled.</p></Section>;
    return (
      <EmptyState icon="share" title="No posts yet" action={<Button icon="plus" onClick={onNew}>New post</Button>}>
        {nothing ? "Connect Facebook & Instagram to post here. You can still download photos and share them anywhere." : "Post job photos, a 4 or 5-star review or an update, now or later."}
      </EmptyState>
    );
  }
  return (
    <Section title={title} count={posts.hasNextPage ? undefined : rows.length} action={action} flush>
      <InboxList
        label={title}
        inset
        foot={posts.hasNextPage && <ListFoot more={{ onClick: () => posts.fetchNextPage(), loading: posts.isFetchingNextPage }}>Showing {rows.length}</ListFoot>}
      >
        <InboxGroup>
          {rows.map((post) => <PostRow key={post.id} post={post} state={state} onEdit={onEdit} highlight={highlight === post.id} />)}
        </InboxGroup>
      </InboxList>
    </Section>
  );
}

function PostRow({ post, state, onEdit, highlight }: { post: SocialPost; state: SocialState; onEdit: (post: SocialPost) => void; highlight: boolean }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const [sharing, setSharing] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: socialKey(session.company.id) });
  const act = useMutation({
    meta: { inline: true },
    mutationFn: (action: { kind: "cancel" | "retry" } | { kind: "resolve"; network: Network; posted: boolean }) =>
      action.kind === "resolve" ? api.post(`/social/posts/${post.id}/networks/${action.network}/resolve`, { posted: action.posted }) : api.post(`/social/posts/${post.id}/${action.kind}`),
    onSuccess: (_, action) => toast.success(action.kind === "cancel" ? "Post cancelled" : action.kind === "retry" ? "Posting again" : "posted" in action && action.posted ? "Marked as posted" : "Posting it again"),
    onSettled: refresh,
  });
  const remove = useMutation({ meta: { inline: true }, mutationFn: () => api.delete(`/social/posts/${post.id}`), onSettled: refresh });
  const key = [...socialKey(session.company.id), "posts", "upcoming"];
  const deleteDraft = () =>
    undoable({
      title: "Draft deleted",
      hide: () => {
        void queryClient.cancelQueries({ queryKey: key });
        queryClient.setQueryData<{ pages: Array<{ posts: SocialPost[]; more: boolean }>; pageParams: unknown[] }>(key, (old) => old && { ...old, pages: old.pages.map((p) => ({ ...p, posts: p.posts.filter((x) => x.id !== post.id) })) });
      },
      restore: refresh,
      commit: () => remove.mutateAsync(),
    });
  const cancel = async () => {
    if (await confirm({ title: "Cancel this post?", body: post.status === "posting" ? "Where it hasn't gone yet, it won't." : "It won't post. You can't undo this.", confirmLabel: "Cancel post", cancelLabel: "Keep it", danger: true })) act.mutate({ kind: "cancel" });
  };
  const resolve = async (network: Network, posted: boolean) => {
    if (!posted && !(await confirm({ title: `Post it to ${NETWORK_NAMES[network]} again?`, body: "Only if it isn't there: otherwise it posts twice.", confirmLabel: "Post it" }))) return;
    act.mutate({ kind: "resolve", network, posted });
  };
  const summary = postSummary(post);
  const results = NETWORKS.map((n) => post.results.find((r) => r.network === n)).filter((r): r is NonNullable<typeof r> => Boolean(r));
  const editable = (post.status === "draft" || post.status === "scheduled") && state.marketing_on;
  const retryable = ["failed", "partly_posted", "check"].includes(post.status) && results.some((r) => r.status === "failed" || r.status === "skipped");
  // The caption, so the post a notification links to can be brought into view (the shared row takes no ref).
  const ref = useRef<HTMLSpanElement>(null);
  // Once, when it's the post a notification links to: never again on a refetch.
  useEffect(() => {
    if (highlight) ref.current?.scrollIntoView({ block: "center" });
  }, [highlight]);
  // When it goes first; a review's post says whose review on a line of its own.
  // Where it goes as each network's logo, as Buffer and Later badge a post; the words are its title and for a screen reader.
  const networks = post.networks.length > 0 && (
    <span className={styles.networkMarks} title={summary.networks}>
      {post.networks.map((n) => <SourceMark key={n} name={n} size={13} />)}
      <span className="sr-only">{summary.networks}</span>
    </span>
  );
  const details = [whenWords(post, session.company.timezone), networks, post.source !== "review" && sourceWords(post), post.automatic && "Automatic"];
  // Queued says nothing the line above doesn't while a post waits its turn.
  const shownResults = post.status === "draft" || post.status === "scheduled" ? results.filter((r) => r.status !== "waiting") : results;
  const posted = shownResults.filter((r) => r.status === "posted");
  const failed = act.error ?? remove.error;
  // A draft or a scheduled post opens to edit: the whole row is its button. One that's gone has nothing to open.
  const target = editable ? { onClick: () => onEdit(post) } : {};
  return (
    <InboxRow
      {...target}
      className={cx(styles.post, highlight && "post-highlight")}
      title={<span ref={ref} className={styles.caption}>{post.caption.trim() || sourceWords(post)}</span>}
      avatar={<PostThumb post={post} />}
      subject={post.source === "review" && (
        <span title={post.review?.words}>
          {post.review ? <>{post.review.words ? `“${post.review.words}” ` : ""}— {post.review.name ?? "A Google user"}</> : "A Google review that isn't here anymore"}
        </span>
      )}
      // On a phone the status leads the quiet line, so the right edge keeps only the menu.
      meta={[<span className={cx("mobile-only", styles.metaStatus)}><EntityStatus kind="post" status={post.status} /></span>, ...details]}
      aside={
        <>
          <span className="hide-mobile"><EntityStatus kind="post" status={post.status} /></span>
          <Menu
            triggerClassName={cx("btn btn-sm btn-ghost btn-icon", styles.asideMore)}
            label="Post actions"
            title={post.caption.trim() ? post.caption.trim().slice(0, 60) : sourceWords(post)}
            items={[
              { label: "Edit", icon: "edit", kbd: "E", hidden: !editable, onSelect: () => onEdit(post) },
              { label: "Post again", icon: "refresh", hidden: !retryable || !state.marketing_on, onSelect: () => act.mutate({ kind: "retry" }) },
              { label: "Share elsewhere", icon: "share", kbd: "S", onSelect: () => setSharing(true) },
              { separator: true },
              { label: "Cancel post", icon: "x", danger: true, hidden: post.status !== "scheduled" && post.status !== "posting", onSelect: cancel },
              { label: "Delete", icon: "trash", danger: true, hidden: post.status !== "draft", onSelect: deleteDraft },
            ]}
          />
          <ShareElsewhere open={sharing} onClose={() => setSharing(false)} caption={post.caption} post={post} />
        </>
      }
    >
      {(post.note || shownResults.length > 0 || failed) && (
        <>
          {post.note && <p className={styles.postNote}>{post.note}</p>}
          {shownResults.length > 0 && (
            <ul className={styles.results} aria-label="Where it went">
              {/* Where it went, on one line with a link to each; then each place that didn't, saying why. */}
              {posted.length > 0 && (
                <li>
                  <span className={styles.resultLine}>
                    <StatusPill label="Posted to" tone="good" />
                    {posted.map((r, i) => (
                      <span key={r.network} className={styles.resultPlace}>
                        {r.permalink ? <a href={r.permalink} target="_blank" rel="noreferrer" aria-label={networkLine(r).text ?? NETWORK_NAMES[r.network]}><SourceMark name={r.network} size={12} />{NETWORK_NAMES[r.network]} <Icon name="external" size={12} /></a> : <span className={styles.placeName}><SourceMark name={r.network} size={12} />{NETWORK_NAMES[r.network]}</span>}
                        {i < posted.length - 1 && <span aria-hidden>,</span>}
                      </span>
                    ))}
                  </span>
                </li>
              )}
              {shownResults.filter((r) => r.status !== "posted").map((r) => {
                const line = networkLine(r);
                return (
                  <li key={r.network}>
                    <span className={styles.resultLine}>
                      <StatusPill label={`${NETWORK_NAMES[r.network]}: ${line.label}`} tone={r.status === "failed" ? "danger" : r.status === "unknown" || r.status === "retry" ? "warning" : "muted"} />
                      {line.text ? <span>{line.text}</span> : null}
                    </span>
                    {r.status === "unknown" && (
                      <span className={styles.resultActions}>
                        <Button size="sm" onClick={() => resolve(r.network, true)}>{CHECK_WORDS[r.network].there}</Button>
                        <Button size="sm" onClick={() => resolve(r.network, false)}>It isn't there, post it</Button>
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <FormError error={failed} />
        </>
      )}
    </InboxRow>
  );
}

/** A network's logo on the round tile a related row leads with (Where it posts). */
function NetworkTile({ network }: { network: Network }) {
  return <span className="rel-icon"><SourceMark name={network} size={16} /></span>;
}

/** A post's picture: its first photo, a review's card in small, or what it is. */
function PostThumb({ post }: { post: SocialPost }) {
  const session = useSession();
  if (post.thumb) return <div className="post-thumb"><img src={post.thumb} alt="" /></div>;
  if (post.source === "review") {
    const colors = cardColors(brandColor(session.company.settings));
    // A review that's gone has no stars to show.
    const n = Math.max(0, Math.min(5, post.review?.rating ?? 0));
    return (
      <div className="post-thumb post-card" style={{ background: colors.background, color: colors.text }} aria-hidden>
        {n > 0 && <span className="post-card-stars">{"★".repeat(n)}</span>}
        {post.review?.name && <span className="post-card-name">{post.review.name}</span>}
      </div>
    );
  }
  return <div className="post-thumb"><Icon name={post.source === "photos" ? "camera" : "edit"} size={20} /></div>;
}

/** Where to go in Apps for what's in Google Business Profile's way, without saying its name twice. */
const GOOGLE_FIX: Record<string, string> = { not_connected: "Connect it", approval: "See where it's at", not_enabled: "See where it's at" };
/** What's in the way already says what to do in Apps ("Pick your location in Apps."): those words are the link, said once. */
const GOOGLE_SAYS_FIX = new Set(["signin", "pick", "location"]);

/** Where posts can go: each network, or what it needs and who can do it. */
function WherePosts({ state }: { state: SocialState }) {
  const { facebook, instagram, google } = state.networks;
  const connect = state.can_connect;
  const ask = (what: string) => <p className={styles.note}>Ask an owner or admin to {what}.</p>;
  // Connected but missing a permission it posts with: it can't post until it's reconnected.
  const missing = [...new Set([...facebook.missing, ...instagram.missing])];
  const pill = (connected: boolean, problem: string | null, lacks: readonly string[]) =>
    connected && !lacks.length ? <StatusPill label="Connected" tone="good" />
    : connected || problem === "signin" ? <StatusPill label="Needs attention" tone={problem === "signin" ? "danger" : "warning"} />
    : <StatusPill label="Not connected" tone="muted" />;
  const googleWaits = google.reason === "approval" || google.reason === "not_enabled";
  return (
    <Section title="Where it posts">
      <RelatedList label="Where posts go">
        <RelatedRow lead={<NetworkTile network="facebook" />} title="Facebook" detail={facebook.page_name} end={pill(facebook.connected, facebook.problem, facebook.missing)} />
        <RelatedRow lead={<NetworkTile network="instagram" />} title="Instagram" detail={instagram.username ? `@${instagram.username}` : null} end={pill(instagram.connected, instagram.problem, instagram.missing)} />
        <RelatedRow lead={<NetworkTile network="google" />} title="Google Business Profile" end={google.ready ? <StatusPill label="Connected" tone="good" /> : <StatusPill label={googleWaits ? "Waiting on Google" : "Not connected"} tone={googleWaits ? "warning" : "muted"} />} />
      </RelatedList>
      <div className={cx(styles.copy, styles.afterList)}>
        {!facebook.connected && (connect ? <Link className={cx("btn btn-sm", styles.connect)} to="/apps/meta">{facebook.problem === "signin" ? "Reconnect Facebook & Instagram" : facebook.problem === "pick" ? "Pick your Page" : "Connect Facebook & Instagram"}</Link> : ask(facebook.problem === "signin" ? "reconnect Facebook & Instagram" : "connect Facebook & Instagram"))}
        {facebook.connected && missing.length > 0 && (
          <p className={styles.note}>
            Meta wasn't given {missing.length === 1 ? "a permission" : "permissions"} posts need: {missing.map((p, i) => <span key={p}>{i ? ", " : ""}<strong>{p}</strong></span>)}.{" "}
            {connect ? <><Link to="/apps/meta">Reconnect Facebook & Instagram</Link> and allow {missing.length === 1 ? "it" : "them"}.</> : "Ask an owner or admin to reconnect Facebook & Instagram."}
          </p>
        )}
        {facebook.connected && instagram.problem === "not_linked" && <p className={styles.note}>Your Instagram account isn't linked to your Page.{connect && <> <Link to="/apps/meta">Check again</Link> once it is.</>}</p>}
        {facebook.connected && instagram.problem === "off" && (
          <p className={styles.note}>Instagram is linked to your Page, but posts don't go to it.{connect ? <> In <Link to="/apps/meta">Facebook & Instagram</Link>, choose <strong>Change Page</strong> and tick <strong>Post to Instagram too</strong>.</> : " Ask an owner or admin to turn it on in Apps."}</p>
        )}
        {instagram.needs_business_permissions && <p className={styles.note}>Your Page is in a business portfolio, so Instagram needs two more permissions.{connect ? <> <Link to="/apps/meta">Reconnect with business Page permissions</Link>.</> : " Ask an owner or admin to reconnect."}</p>}
        {facebook.connected && !facebook.live_confirmed && (
          <div className="callout callout-warning"><Icon name="alert" size={16} /><div className="grow">Posts stay hidden from the public until your Meta app is Live.{connect && <> <Link to="/apps/meta">Switch it to Live</Link></>}</div></div>
        )}
        {!google.ready && google.message && (connect ? (
          <p className={styles.note}>
            {GOOGLE_SAYS_FIX.has(google.reason ?? "")
              ? <Link to="/apps/google_business">{google.message}</Link>
              : <>{google.message} <Link to="/apps/google_business">{GOOGLE_FIX[google.reason ?? ""] ?? "Open it in Apps"}</Link></>}
          </p>
        ) : <p className={styles.note}>{google.message} Ask an owner or admin to look at it in Apps.</p>)}
        {!state.images_public && (
          <p className={styles.note}>Crewtavo's address isn't public, so Meta and Google can't fetch photos or review cards from it. Words alone can still post, and Share elsewhere works for the rest.</p>
        )}
      </div>
    </Section>
  );
}

/**
 * Post 5-star reviews automatically: saved at once, and turning it off cancels the ones scheduled,
 * after saying how many. A place it's set to that can't post now (disconnected, Instagram unlinked, a
 * permission missing) shows unticked with why, and stays saved, so they go there again once it can;
 * with nowhere left that can post, it says Paused rather than On.
 */
function AutoPosts({ state, timeZone }: { state: SocialState; timeZone: string }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const saved = state.auto.networks;
  const choices = networkChoices(state, "review");
  const ready = (n: Network) => Boolean(choices.find((c) => c.network === n)?.enabled);
  const [networks, setNetworks] = useState<Network[]>(saved.length ? saved : NETWORKS.filter(ready));
  // What's ticked follows what was saved, so a change that didn't save doesn't look saved.
  const savedKey = saved.join(",");
  useEffect(() => {
    if (savedKey) setNetworks(savedKey.split(",") as Network[]);
  }, [savedKey]);
  const save = useMutation({
    meta: { inline: true },
    mutationFn: (auto: { enabled: boolean; networks: Network[] }) => api.put<{ enabled: boolean; cancelled: number }>("/social/settings", { auto }),
    onSuccess: (res) => toast.success(res.enabled ? "Automatic posts are on" : res.cancelled ? `Automatic posts are off. ${res.cancelled === 1 ? "1 scheduled post was" : `${res.cancelled} scheduled posts were`} cancelled` : "Automatic posts are off"),
    onError: () => {
      if (saved.length) setNetworks(saved);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: socialKey(session.company.id) }),
  });
  const upcoming = queryClient.getQueryData<{ pages: Array<{ posts: SocialPost[] }> }>([...socialKey(session.company.id), "posts", "upcoming"]);
  const scheduledAuto = upcoming?.pages.flatMap((p) => p.posts).filter((p) => p.automatic && p.status === "scheduled").length ?? 0;
  const turn = async (enabled: boolean) => {
    if (!enabled && scheduledAuto > 0) {
      const ok = await confirm({ title: `Cancel the ${scheduledAuto === 1 ? "automatic post" : `${scheduledAuto} automatic posts`} still scheduled?`, body: "Turning automatic posts off cancels them. Posts you made yourself stay.", confirmLabel: "Turn off", cancelLabel: "Leave it on", danger: true });
      if (!ok) return;
    }
    save.mutate({ enabled, networks });
  };
  // The places set that can post now: none left while it's on is Paused.
  const live = networks.filter(ready);
  const paused = state.auto.enabled && !live.length;
  // While they're on they need somewhere to go: the last place that can post can't be unticked, only turned off.
  const last = state.auto.enabled && live.length === 1;
  return (
    <Section
      title="Post 5-star reviews automatically"
      action={
        <label className={styles.headSwitch}>
          <span>{paused ? "Paused" : state.auto.enabled ? "On" : "Off"}</span>
          <input type="checkbox" role="switch" className="switch" aria-label="Post 5-star reviews automatically" checked={state.auto.enabled} disabled={save.isPending || !state.marketing_on || (!state.auto.enabled && (!networks.some(ready) || !state.images_public))} onChange={(e) => turn(e.target.checked)} />
        </label>
      }
    >
      <div className={styles.copy}>
        {paused && (
          <div className="callout callout-warning">
            <Icon name="pause" size={16} />
            <div className="grow">
              Paused: {networkWords(networks)} can't post now, so new 5-star reviews aren't scheduled. They start again once {networks.length === 1 ? "it's" : "they're"} connected{NETWORKS.some(ready) ? ", or tick another place below" : ""}.
            </div>
          </div>
        )}
        {/* What it does in a line; exactly when is an (i), so the side column stays quiet. */}
        <p className={styles.note}>
          New 5-star reviews with words post the next day, at most {AUTO_POSTS_PER_DAY} a day. You can change or cancel each one before it goes.
          <InfoTip text={`At ${clockText(10)}, ${clockText(13)} or ${clockText(16)} (${timeZoneWords(timeZone)}), the same day for a review in before ${clockText(8)}.`} />
        </p>
        <fieldset className={styles.fieldset}>
          <legend>Post to</legend>
          {choices.map((c) => (
            <label key={c.network} className="checkbox">
              <input
                type="checkbox"
                checked={networks.includes(c.network) && c.enabled}
                disabled={!c.enabled || save.isPending || (last && live.includes(c.network))}
                onChange={(e) => {
                  const next = e.target.checked ? [...networks, c.network] : networks.filter((x) => x !== c.network);
                  setNetworks(next);
                  if (state.auto.enabled && next.some(ready)) save.mutate({ enabled: true, networks: next });
                }}
              />
              <span className={styles.networkChoice}>
                <SourceMark name={c.network} size={14} />
                {NETWORK_NAMES[c.network]}
                {state.auto.enabled && networks.includes(c.network) && !c.enabled && c.reason && <span className={styles.checkNote}>{c.reason}</span>}
              </span>
            </label>
          ))}
        </fieldset>
        {!NETWORKS.some(ready) && !paused && <p className={styles.note}>Connect Facebook & Instagram or Google Business Profile first.</p>}
        {/* Why isn't said twice: Where it posts, just before this, says it. */}
        {!state.images_public && <p className={styles.note}>Automatic posts need Crewtavo's address to be public.</p>}
        {last && <p className={styles.note}>They need one place to post. To stop them, turn them off.</p>}
        <FormError error={save.error} />
      </div>
    </Section>
  );
}
