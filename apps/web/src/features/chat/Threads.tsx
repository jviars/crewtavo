/**
 * Threads. "Reply in thread" on a message opens its thread: on a computer a panel on the right (in
 * place of the member list), on a phone a screen of its own with Back. It has the message, its
 * replies and the same box to write in (photos, mentions, Markdown, paste), which can also send the
 * reply to the channel. A thread can be followed or not: its followers hear of new replies.
 *
 * The Threads view (/chat/threads, at the top of the channel list) lists the threads you follow, those
 * with new replies first. Replies come from routes/chatThreads.ts, and stay current from the live
 * connection (data.ts).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "@/components/ui/Button";
import { Icon } from "@/components/ui/Icon";
import { Loading, Skeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { api } from "@/lib/api";
import { signedUrls } from "@/lib/files";
import { useSession } from "@/lib/session";
import { Composer, type MentionOption } from "./Composer";
import { chatKeys, markThreadRead, setFollowing, setViewingThread, useJobCards, useThread, type ChatChannel, type ChatMessage, type ChatState } from "./data";
import { chatPlainText } from "@crewtavo/core/chat";
import { MessageItem, type MessageContext } from "./MessageItem";
import { channelLabel, isNewDay, listTime, startsGroup, dayLabel } from "./ui";
import s from "./chat.module.css";
import th from "./threads.module.css";
import { t } from "@/lib/i18n";

/** Where a thread opens: its channel, with the thread on the side. */
export const threadPath = (channelId: string, rootId: string, message?: string) => `/chat/${channelId}?thread=${rootId}${message ? `&message=${message}` : ""}`;

export function ThreadPanel({ channel, rootId, ctx, options, onClose }: { channel: ChatChannel; rootId: string; ctx: MessageContext; options: MentionOption[]; onClose: () => void }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const company = session.company.id;
  const [params] = useSearchParams();
  const thread = useThread(rootId);
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [focusKey, setFocusKey] = useState(`open:${rootId}`);
  const [flash, setFlash] = useState<string | null>(params.get("message"));

  const pages = thread.data?.pages ?? [];
  const root = pages[0]?.root ?? null;
  const following = pages[0]?.following ?? false;
  const replies = useMemo(() => [...pages].reverse().flatMap((p) => p.replies).filter((m) => !m.deleted_at), [pages]);
  const all = useMemo(() => (root ? [root, ...replies] : replies), [root, replies]);

  // Read while it's open, and again when you come back to the tab.
  useEffect(() => {
    setViewingThread(rootId);
    void markThreadRead(queryClient, company, rootId);
    const back = () => document.visibilityState === "visible" && markThreadRead(queryClient, company, rootId);
    document.addEventListener("visibilitychange", back);
    return () => {
      setViewingThread(null);
      document.removeEventListener("visibilitychange", back);
    };
  }, [rootId, company, queryClient]);

  // Opened from a notification: that reply in view, lit up briefly.
  useLayoutEffect(() => {
    if (!flash || !all.some((m) => m.id === flash)) return;
    document.getElementById(`thread-message-${flash}`)?.scrollIntoView({ block: "center" });
    const timer = setTimeout(() => setFlash(null), 1800);
    return () => clearTimeout(timer);
  }, [flash, all]);

  const paths = useMemo(() => [...new Set(all.flatMap((m) => m.attachments.map((a) => a.path)))].sort(), [all]);
  const photos = useQuery({ queryKey: ["chat-photos", company, paths], enabled: paths.length > 0, staleTime: 50 * 60_000, queryFn: () => signedUrls(paths, 3600) });
  const jobs = useJobCards(all.map((m) => m.job_id).filter((id): id is string => Boolean(id)));

  const follow = useMutation({
    meta: { inline: true },
    mutationFn: (on: boolean) => api.post<{ following: boolean }>(`/chat/messages/${rootId}/follow`, { following: on }),
    onMutate: (on) => setFollowing(queryClient, company, rootId, on),
    onError: (_e, on) => setFollowing(queryClient, company, rootId, !on),
    onSettled: () => queryClient.invalidateQueries({ queryKey: chatKeys.threads(company) }),
  });

  const threadCtx: MessageContext = {
    ...ctx,
    photos: { ...ctx.photos, ...(photos.data ?? {}) },
    jobs: jobs.data ?? ctx.jobs,
    onThread: null,
    seen: null,
    onReply: (m) => {
      setReplyTo(m);
      setFocusKey(`reply:${m.id}`);
    },
    onJumpTo: (id) => {
      if (all.some((m) => m.id === id)) {
        setFlash(id);
        document.getElementById(`thread-message-${id}`)?.scrollIntoView({ block: "center" });
      } else ctx.onJumpTo(id);
    },
  };

  return (
    <aside className={th.panel} aria-label={t("Thread")}>
      <header className={th.head}>
        <button type="button" className={th.back} aria-label={t("Back to {channel}", { channel: channelLabel(channel) })} onClick={onClose}><Icon name="chevronLeft" size={20} /></button>
        <div className={th.title}>
          <h2>{t("Thread")}</h2>
          <span>{channelLabel(channel)}</span>
        </div>
        {root && (
          <button type="button" className={`btn btn-sm ${following ? "btn-ghost" : ""} ${th.follow}`} aria-pressed={following} onClick={() => follow.mutate(!following)}
            title={following ? t("You hear about new replies. Stop following to not be told.") : t("Follow to hear about new replies")}>
            <Icon name={following ? "bell" : "bellOff"} size={14} />{following ? t("Following") : t("Follow")}
          </button>
        )}
        <button type="button" className={`icon-btn ${th.close}`} aria-label={t("Close the thread")} onClick={onClose}><Icon name="x" size={16} /></button>
      </header>
      <div className={th.scroller}>
        <div className={th.messages}>
          {thread.isPending && (
            <Loading label={t("Loading the thread")} className="stack">
              <div style={{ padding: "16px 8px" }} className="stack"><Skeleton width={160} height={12} /><Skeleton width="80%" height={13} /></div>
            </Loading>
          )}
          {thread.error && <div style={{ padding: 16 }}><ErrorState compact error={thread.error} onRetry={() => thread.refetch()} /></div>}
          {root && (
            <div id={`thread-message-${root.id}`} className={th.root}>
              {root.deleted_at ? <p className={th.gone}>{t("This message was deleted.")}</p> : <MessageItem message={root} head flash={flash === root.id} ctx={threadCtx} />}
            </div>
          )}
          {root && (
            <div className={th.count} role="separator">
              <span>{t.plural(replies.length, { one: "{count} reply", other: "{count} replies" })}</span>
            </div>
          )}
          {thread.hasNextPage && (
            <Button size="sm" variant="ghost" className={th.older} loading={thread.isFetchingNextPage} onClick={() => thread.fetchNextPage()}>{t("Show earlier replies")}</Button>
          )}
          {replies.map((m, i) => {
            const prev = replies[i - 1];
            const day = isNewDay(prev, m);
            return (
              <div key={m.id} id={`thread-message-${m.id}`}>
                {day && i > 0 && <div className={s.day} role="separator">{dayLabel(m.created_at)}</div>}
                <MessageItem message={m} head={day || startsGroup(prev, m) || Boolean(m.reply)} flash={flash === m.id} ctx={threadCtx} />
              </div>
            );
          })}
        </div>
      </div>
      {root && !root.deleted_at && (
        <Composer channel={channel} options={options} replyTo={replyTo} onCancelReply={() => setReplyTo(null)} focusKey={focusKey} thread={{ root: rootId }} />
      )}
    </aside>
  );
}

// ---------------------------------------------------------------------------------------------
// The Threads view
// ---------------------------------------------------------------------------------------------

interface FollowedThread {
  root: ChatMessage;
  channel_id: string;
  replies: number;
  last_reply_at: string;
  unread: number;
  mentions: number;
}

export function useFollowedThreads() {
  const { company } = useSession();
  return useQuery({
    queryKey: chatKeys.threads(company.id),
    queryFn: () => api.get<{ threads: FollowedThread[] }>("/chat/threads").then((r) => r.threads),
    staleTime: 30_000,
  });
}

/** The channel list's first row: the threads you follow, with how many have new replies. */
export function ThreadsLink({ state, active }: { state: ChatState; active: boolean }) {
  const counts = state.threads ?? { unread: 0, mentions: 0 };
  return (
    <Link to="/chat/threads" className={`${s.channel} ${th.threadsLink}`} aria-current={active ? "page" : undefined} data-unread={(counts.unread > 0 && !active) || undefined}
      aria-label={`${t("Threads")}${counts.mentions ? `, ${t.plural(counts.mentions, { one: "{count} mention", other: "{count} mentions" })}` : counts.unread ? `, ${t.plural(counts.unread, { one: "{count} with new replies", other: "{count} with new replies" })}` : ""}`}>
      <span className={s.hash} aria-hidden="true"><Icon name="messages" size={14} /></span>
      <span className={s.channelText}>
        <span className={s.channelName}>{t("Threads")}</span>
        <span className={s.channelSub}>{counts.unread ? t.plural(counts.unread, { one: "{count} with new replies", other: "{count} with new replies" }) : t("Threads you follow")}</span>
      </span>
      <span className={s.channelEnd}>
        {counts.mentions > 0 && <span className={s.mentions} aria-hidden="true">{counts.mentions}</span>}
        {counts.unread > 0 && !active && <span className={s.dot} aria-hidden="true" />}
      </span>
    </Link>
  );
}

export function ThreadsView({ state }: { state: ChatState | undefined }) {
  const navigate = useNavigate();
  const threads = useFollowedThreads();
  const channels = new Map((state?.channels ?? []).map((c) => [c.id, c]));
  // Names for the @mentions in each message's preview: whoever chat already knows.
  const nameFor = useMemo(() => {
    const names = new Map<string, string>();
    for (const p of Object.values(state?.people ?? {})) names.set(p.id, p.name);
    for (const item of threads.data ?? []) {
      if (item.root.author) names.set(item.root.author.id, item.root.author.name);
      for (const p of item.root.thread?.people ?? []) names.set(p.id, p.name);
    }
    return (part: { kind: "user"; id: string } | { kind: "role"; key: string } | { kind: "everyone" }) =>
      part.kind === "user" ? names.get(part.id) ?? t("someone") : part.kind === "role" ? state?.roles.find((r) => r.key === part.key)?.label ?? t("role") : t("everyone");
  }, [state, threads.data]);
  return (
    <section className={`${s.conversation} ${th.view}`} aria-label={t("Threads")}>
      <header className={s.convHead}>
        <Link to="/chat" className={s.back} aria-label={t("All channels")}><Icon name="chevronLeft" size={20} /></Link>
        <div className={s.convTitle}>
          <h1><span className={s.convHash} aria-hidden="true"><Icon name="messages" size={15} /></span><span>{t("Threads")}</span></h1>
        </div>
        <p className={s.convTopic}>{t("Threads you started, replied in or were mentioned in. New replies first.")}</p>
      </header>
      <div className={th.list}>
        {threads.isPending && (
          <Loading label={t("Loading threads")} className="stack-sm">
            {[0, 1, 2].map((i) => <Skeleton key={i} height={64} />)}
          </Loading>
        )}
        {threads.error && <ErrorState error={threads.error} onRetry={() => threads.refetch()} />}
        {threads.data?.length === 0 && (
          <EmptyState icon="messages" title={t("No threads yet")}>{t("Threads you start, reply in or are mentioned in show here. Use Reply in thread on a message to start one.")}</EmptyState>
        )}
        {threads.data?.map((item) => {
          const channel = channels.get(item.channel_id);
          const root = item.root;
          return (
            <button key={root.id} type="button" className={th.item} data-new={item.unread > 0 || undefined} onClick={() => navigate(threadPath(item.channel_id, root.id))}>
              <span className={th.itemHead}>
                <strong>{channel ? channelLabel(channel) : t("A channel")}</strong>
                {item.unread > 0 && <span className={th.newBadge}>{t.plural(item.unread, { one: "{count} new reply", other: "{count} new replies" })}</span>}
                {item.mentions > 0 && <span className={s.mentions} aria-label={t.plural(item.mentions, { one: "{count} mention", other: "{count} mentions" })}>{item.mentions}</span>}
                <time className={th.itemTime} dateTime={item.last_reply_at}>{listTime(item.last_reply_at)}</time>
              </span>
              <span className={th.itemBody}>
                <strong>{root.author?.name ?? "Crewtavo"}</strong>{" "}
                {root.deleted_at ? <em>{t("This message was deleted.")}</em> : chatPlainText(root.body, nameFor) || t("Photo")}
              </span>
              <span className={th.itemFoot}>{t.plural(item.replies, { one: "{count} reply", other: "{count} replies" })}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
