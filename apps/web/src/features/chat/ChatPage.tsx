/**
 * Team chat (/chat and /chat/:channelId). Channels on the left, grouped by category, with what's
 * new in each, then direct messages (DirectMessages.tsx); the open channel in the middle; who's in
 * it on the right, or an open thread (?thread=, Threads.tsx). /chat/threads lists the threads you
 * follow. On a phone the channel list and a channel are separate screens. Live updates come from
 * useChatLive (mounted by the app shell).
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Link, NavLink, useMatch, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { EVERYONE_TOKEN, roleToken, userToken } from "@crewtavo/core/chat";
import { hasRole, can, useSession } from "@/lib/session";
import { Button } from "@/components/ui/Button";
import { Dialog } from "@/components/ui/Dialog";
import { Icon } from "@/components/ui/Icon";
import { useDocumentTitle } from "@/components/ui/PageHeader";
import { Loading, Skeleton } from "@/components/ui/Skeleton";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { api } from "@/lib/api";
import { signedUrls } from "@/lib/files";
import { Composer, type MentionOption } from "./Composer";
import { DirectFaces, DirectMenu, DirectSection, NewMessageButton, useStartDirect } from "./DirectMessages";
import { directList, directPeople } from "./direct";
import d from "./direct.module.css";
import { chatKeys, chatOn, markRead, setViewing, useChatState, useJobCards, useLive, useMembers, useMessages, usePins, type ChatChannel, type ChatMember, type ChatMessage, type ChatState } from "./data";
import { MembersPanel, PersonDialog } from "./Members";
import { ThreadPanel, threadPath, ThreadsLink, ThreadsView } from "./Threads";
import { ChannelNotifyMenu, PauseMenu } from "./Notify";
import n from "./notify.module.css";
import { MessageItem, MessageText, type MessageContext } from "./MessageItem";
import { ChannelIcon, channelLabel, dayLabel, isNewDay, listTime, startsGroup, timeLabel } from "./ui";
import s from "./chat.module.css";
import { t } from "@/lib/i18n";

const LAST_CHANNEL = "crewtavo.chat.channel";
const MEMBERS_OPEN = "crewtavo.chat.members";
const COLLAPSED = "crewtavo.chat.collapsed";
/** The Direct messages section's key among the folded ones (not a category anyone can name). */
const DIRECT = "\u0000direct";

function stored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}
function store(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Private mode: it just won't be remembered.
  }
}

const wide = () => window.matchMedia("(min-width: 901px)").matches;

/**
 * With the phone's keyboard up, the chat fits the part of the screen still showing, so the box you
 * type in sits on the keyboard with the conversation above it. iOS doesn't shrink the page for the
 * keyboard (nor do Android's browsers by default): it slides the page up under it, which left the
 * chat sized for the whole screen with a blank band between the box and the keyboard, where the
 * hidden tab bar had been. The size and place of what's showing come from visualViewport.
 */
function useKeyboardFit(ref: RefObject<HTMLElement>) {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv || !window.matchMedia("(pointer: coarse)").matches) return;
    const fit = () => {
      const el = ref.current;
      if (!el) return;
      // Zoomed in with two fingers is a smaller view too, but not a keyboard.
      const up = vv.scale < 1.05 && window.innerHeight - vv.height > 120;
      if (up) {
        el.dataset.keyboard = "";
        el.style.setProperty("--keyboard-top", `${Math.round(vv.offsetTop)}px`);
        el.style.setProperty("--keyboard-height", `${Math.round(vv.height)}px`);
      } else if ("keyboard" in el.dataset) {
        delete el.dataset.keyboard;
        el.style.removeProperty("--keyboard-top");
        el.style.removeProperty("--keyboard-height");
      }
    };
    fit();
    vv.addEventListener("resize", fit);
    vv.addEventListener("scroll", fit);
    return () => {
      vv.removeEventListener("resize", fit);
      vv.removeEventListener("scroll", fit);
    };
  }, [ref]);
}

export function ChatPage() {
  const session = useSession();
  const { channelId } = useParams();
  const [params] = useSearchParams();
  const thread = params.get("thread");
  // A thread's message is found in the thread; the channel stays where it was.
  const around = thread ? null : params.get("message");
  const threadsView = Boolean(useMatch("/chat/threads"));
  const navigate = useNavigate();
  const state = useChatState();
  const [membersOpen, setMembersOpen] = useState(() => wide() && window.matchMedia("(min-width: 1181px)").matches && stored(MEMBERS_OPEN, true));
  const on = chatOn(session);
  const layout = useRef<HTMLDivElement>(null);
  useKeyboardFit(layout);
  const channels = state.data?.channels ?? [];
  const channel = channels.find((c) => c.id === channelId);
  useDocumentTitle(channel ? channelLabel(channel) : t("Team chat"));

  // On a computer, /chat opens the channel you had open last (or the first one).
  useEffect(() => {
    if (channelId || threadsView || !channels.length || !wide()) return;
    const last = stored<string | null>(LAST_CHANNEL, null);
    const target = channels.find((c) => c.id === last && !c.archived && !c.closed) ?? channels.find((c) => !c.archived && c.kind !== "direct") ?? channels[0];
    navigate(`/chat/${target.id}`, { replace: true });
  }, [channelId, threadsView, channels, navigate]);
  useEffect(() => {
    if (channel) store(LAST_CHANNEL, channel.id);
  }, [channel]);

  if (!on) return <ChatOff />;
  if (state.error && !state.data) return <div className={s.off}><ErrorState error={state.error} onRetry={() => state.refetch()} /></div>;

  const toggleMembers = () => {
    setMembersOpen((open) => {
      store(MEMBERS_OPEN, !open);
      return !open;
    });
  };

  return (
    <div ref={layout} className={s.layout} data-view={channelId || threadsView ? "channel" : "list"} data-members={(membersOpen && channel && !thread) || undefined} data-thread={(channel && thread) || undefined}>
      <ChannelList state={state.data} current={channelId} threadsView={threadsView} />
      {threadsView ? (
        <ThreadsView state={state.data} />
      ) : channel ? (
        <Conversation key={channel.id} channel={channel} state={state.data!} around={around} thread={thread} membersOpen={membersOpen} onToggleMembers={toggleMembers} />
      ) : (
        <section className={s.conversation} aria-label={t("Channel")}>
          {state.isPending ? (
            <Loading label={t("Loading chat")} className="stack" >
              <div style={{ padding: 24 }} className="stack-sm"><Skeleton width={220} height={22} /><Skeleton width="60%" height={14} /></div>
            </Loading>
          ) : channelId ? (
            <EmptyState icon="hash" title={t("That channel isn't here")} action={<Link className="btn" to="/chat">{t("See your channels")}</Link>}>{t("It may have been archived, or your role can't see it.")}</EmptyState>
          ) : (
            <EmptyState icon="chat" title={channels.length ? t("Pick a channel") : t("No channels yet")}>
              {channels.length ? t("Choose one on the left to start talking.") : t("Ask an owner or admin to add one in Chat settings.")}
            </EmptyState>
          )}
        </section>
      )}
    </div>
  );
}

/** Chat is off: say so, and where to install it for those who can. */
function ChatOff() {
  const session = useSession();
  const canTurnOn = hasRole(session, "admin") && can(session, "apps");
  return (
    <div className={s.off}>
      <EmptyState icon="chat" title={t("Team chat is off")} action={canTurnOn ? <Link className="btn btn-primary" to="/apps/team_chat">{t("Install it from Apps")}</Link> : undefined}>
        {canTurnOn ? t("Channels for the whole team, each crew and the office, with photos and @mentions.") : t("Ask an owner or admin to install Team chat from Apps.")}
      </EmptyState>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Channel list
// ---------------------------------------------------------------------------------------------

function ChannelList({ state, current, threadsView }: { state: ChatState | undefined; current: string | undefined; threadsView: boolean }) {
  const session = useSession();
  const [collapsed, setCollapsed] = useState<string[]>(() => stored(COLLAPSED, []));
  const channels = state?.channels ?? [];
  const direct = useMemo(() => directList(channels, current), [channels, current]);
  const groups = useMemo(() => {
    const map = new Map<string, { name: string; order: number; channels: ChatChannel[] }>();
    for (const c of channels) {
      if (c.kind === "direct") continue;
      const name = c.archived ? t("Archived") : c.category;
      const g = map.get(name) ?? { name, order: c.archived ? Number.MAX_SAFE_INTEGER : c.position, channels: [] };
      g.order = Math.min(g.order, c.archived ? Number.MAX_SAFE_INTEGER : c.position);
      g.channels.push(c);
      map.set(name, g);
    }
    return [...map.values()].sort((a, b) => a.order - b.order);
  }, [channels]);
  const toggle = (name: string) => {
    const next = collapsed.includes(name) ? collapsed.filter((n) => n !== name) : [...collapsed, name];
    setCollapsed(next);
    store(COLLAPSED, next);
  };
  return (
    <aside className={s.side} aria-label={t("Channels")}>
      <div className={s.sideHead}>
        {/* On a phone the top bar already names the business: the list has the screen's large title. */}
        <span className={`${s.sideTitle} hide-mobile`}>{session.company.name}</span>
        <h1 className={`${s.sideTitle} mobile-only`}>{t("Team chat")}</h1>
        {state && <PauseMenu />}
        {state?.direct_messages && <NewMessageButton />}
        {state?.me?.admin && (
          <Link to="/chat/settings" className={s.settings} aria-label={t("Chat settings")} title={t("Chat settings")}><Icon name="settings" size={16} /></Link>
        )}
      </div>
      <nav className={s.sideList} aria-label={t("Channels")}>
        {state && <ThreadsLink state={state} active={threadsView} />}
        {!state && (
          <Loading label={t("Loading channels")} className="stack-sm">
            {[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} height={30} />)}
          </Loading>
        )}
        {groups.map((g) => {
          const open = !collapsed.includes(g.name);
          return (
            <div key={g.name}>
              <button type="button" className={s.category} aria-expanded={open} onClick={() => toggle(g.name)}>
                <span>{g.name}</span>
                <Icon name="chevronDown" size={12} bold />
              </button>
              {g.channels.filter((c) => open || c.id === current || c.mentions > 0).map((c) => {
                const muted = c.notify === "nothing";
                const unread = c.unread > 0 && c.id !== current && !muted;
                const readOnly = !c.can_post && !c.archived && c.kind !== "announcement";
                return (
                  <NavLink
                    key={c.id}
                    to={`/chat/${c.id}`}
                    className={muted ? `${s.channel} ${n.muted}` : s.channel}
                    data-unread={unread || undefined}
                    aria-label={`${channelLabel(c)}${c.mentions ? `, ${c.mentions} ${c.mentions === 1 ? "mention" : "mentions"}` : c.unread ? ", unread" : ""}`}
                  >
                    <span className={s.hash} aria-hidden="true"><ChannelIcon channel={c} size={14} /></span>
                    <span className={s.channelText}>
                      <span className={s.channelName}>{c.name}</span>
                      {/* On a phone: what the channel is for under its name. */}
                      <span className={s.channelSub}>{[readOnly || !c.can_post ? t("Read only") : null, c.topic].filter(Boolean).join(" · ")}</span>
                    </span>
                    <span className={s.channelEnd}>
                      {c.last_message_at && <time className={s.channelTime} dateTime={c.last_message_at}>{listTime(c.last_message_at)}</time>}
                      {readOnly && <span className="hide-mobile"><Icon name="eye" size={13} label={t("Read only")} /></span>}
                      {muted && <span className={n.mutedIcon}><Icon name="bellOff" size={13} label={t("Notifications off")} /></span>}
                      {c.mentions > 0 && c.id !== current && <span className={s.mentions} aria-hidden="true">{c.mentions}</span>}
                      {unread && <span className={s.dot} aria-hidden="true" />}
                    </span>
                  </NavLink>
                );
              })}
            </div>
          );
        })}
        {state && (state.direct_messages || direct.length > 0) && (
          <DirectSection channels={direct} state={state} current={current} open={!collapsed.includes(DIRECT)} onToggle={() => toggle(DIRECT)} />
        )}
        {state && !state.me?.admin && <p className={s.sideNote}>{t("You see the channels your role allows. Ask an owner or admin if one is missing.")}</p>}
      </nav>
    </aside>
  );
}

// ---------------------------------------------------------------------------------------------
// A conversation
// ---------------------------------------------------------------------------------------------

function Conversation({ channel, state, around, thread, membersOpen, onToggleMembers }: {
  channel: ChatChannel; state: ChatState; around: string | null; thread: string | null; membersOpen: boolean; onToggleMembers: () => void;
}) {
  const session = useSession();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const company = session.company.id;
  const me = state.me?.user_id ?? session.userId;
  const messages = useMessages(channel.id, around);
  const members = useMembers(channel.id);
  const live = useLive();
  const [replyTo, setReplyTo] = useState<ChatMessage | null>(null);
  const [focusKey, setFocusKey] = useState("");
  const [personId, setPersonId] = useState<string | null>(null);
  const [pinsOpen, setPinsOpen] = useState(false);
  const [topicOpen, setTopicOpen] = useState(false);
  const [mentionInsert, setMentionInsert] = useState<{ option: MentionOption; nonce: number } | null>(null);
  // Where "New" goes: as many of the latest messages as were unread when the channel opened.
  const [unreadAtOpen] = useState(channel.unread);
  const top = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [flash, setFlash] = useState<string | null>(around);

  const all = useMemo(() => {
    const pages = messages.data?.pages ?? [];
    return [...pages].reverse().flatMap((p) => p.messages).filter((m) => !m.deleted_at);
  }, [messages.data]);

  // Reading: this channel counts as read while it's open, and again when you come back to the tab.
  useEffect(() => {
    setViewing(channel.id);
    void markRead(queryClient, company, channel.id);
    const back = () => document.visibilityState === "visible" && markRead(queryClient, company, channel.id);
    document.addEventListener("visibilitychange", back);
    return () => {
      setViewing(null);
      document.removeEventListener("visibilitychange", back);
    };
  }, [channel.id, company, queryClient]);

  // Older messages load as you scroll up to the top.
  useEffect(() => {
    const el = top.current;
    if (!el) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && messages.hasNextPage && !messages.isFetchingNextPage) void messages.fetchNextPage();
    }, { root: scroller.current, rootMargin: "400px 0px 0px 0px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, [messages]);

  // Opened from a notification: bring that message into view and light it up briefly.
  useLayoutEffect(() => {
    if (!flash || !all.some((m) => m.id === flash)) return;
    document.getElementById(`message-${flash}`)?.scrollIntoView({ block: "center" });
    const timer = setTimeout(() => setFlash(null), 1800);
    return () => clearTimeout(timer);
  }, [flash, all]);

  const photoPaths = useMemo(() => [...new Set(all.flatMap((m) => m.attachments.map((a) => a.path)))].sort(), [all]);
  const photos = useQuery({
    queryKey: ["chat-photos", company, photoPaths],
    enabled: photoPaths.length > 0,
    staleTime: 50 * 60_000,
    queryFn: () => signedUrls(photoPaths, 3600),
  });
  const jobs = useJobCards(all.map((m) => m.job_id).filter((id): id is string => Boolean(id)));

  const memberById = useMemo(() => new Map((members.data ?? []).map((m) => [m.id, m])), [members.data]);
  const authors = useMemo(() => new Map(all.flatMap((m) => (m.author ? [[m.author.id, m.author] as const] : []))), [all]);
  const roleOf = (key: string) => {
    const r = state.roles.find((x) => x.key === key);
    return r ? { label: r.label, color: r.color } : null;
  };
  const trusted = channel.can_manage || state.me?.admin || hasRole(session, "admin", "office");
  const isDirect = channel.kind === "direct";
  const options: MentionOption[] = useMemo(() => {
    const people = (members.data ?? [])
      .filter((m) => m.id !== me)
      .map((m) => ({ kind: "user" as const, label: m.name, token: userToken(m.id), avatar: m.avatar_color, photo: m.avatar_url, hint: m.role_label }));
    // A direct conversation's mentions are of its people only.
    if (isDirect) return people;
    const roles = state.roles
      .filter((r) => r.key !== "owner" && (r.mentionable || trusted))
      .map((r) => ({ kind: "role" as const, label: r.label, token: roleToken(r.key), color: r.color, hint: t("Role") }));
    const everyone = channel.can_manage ? [{ kind: "everyone" as const, label: t("everyone"), token: EVERYONE_TOKEN, hint: t("Everyone in this channel") }] : [];
    return [...people, ...roles, ...everyone];
  }, [members.data, state.roles, me, trusted, channel.can_manage, isDirect]);
  const startDirect = useStartDirect();
  const message = state.direct_messages ? (p: ChatMember) => startDirect.mutate([p.id]) : null;

  const ctx: MessageContext = {
    me,
    myRoleKey: state.me?.role_key ?? session.role,
    canManage: channel.can_manage,
    canPost: channel.can_post,
    personName: (id) => memberById.get(id)?.name ?? authors.get(id)?.name ?? "someone",
    role: roleOf,
    mentionables: options,
    jobs: jobs.data,
    photos: photos.data ?? {},
    onReply: (m) => {
      setReplyTo(m);
      setFocusKey(`reply:${m.id}`);
    },
    onPerson: setPersonId,
    onJumpTo: (id) => {
      if (all.some((m) => m.id === id)) {
        setFlash(id);
        document.getElementById(`message-${id}`)?.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      } else navigate(`/chat/${channel.id}?message=${id}`);
    },
    onThread: (rootId) => navigate(threadPath(channel.id, rootId)),
  };

  const person: ChatMember | null = personId
    ? memberById.get(personId) ?? (authors.get(personId) ? { ...authors.get(personId)!, role: "", show_separately: false, online: false } : null)
    : null;

  // Where the "New" line goes.
  let newBefore: string | null = null;
  if (unreadAtOpen > 0) {
    let left = unreadAtOpen;
    for (let i = all.length - 1; i >= 0; i--) {
      if (all[i].author_id === me) continue;
      left -= 1;
      if (left === 0) {
        newBefore = all[i].id;
        break;
      }
    }
  }
  const atStart = !messages.hasNextPage && !messages.isPending;
  const membersCount = members.data?.length;
  const online = (members.data ?? []).filter((m) => m.online || live.online.has(m.id)).length;

  return (
    <>
    <section className={s.conversation} aria-label={channelLabel(channel)}>
      <header className={s.convHead}>
        <Link to="/chat" className={s.back} aria-label={t("All channels")}><Icon name="chevronLeft" size={20} /></Link>
        <div className={s.convTitle}>
          <h1>
            {isDirect
              ? <span className={d.headFaces} aria-hidden="true"><DirectFaces people={directPeople(channel, state.people)} size={20} /></span>
              : <span className={s.convHash} aria-hidden="true"><ChannelIcon channel={channel} size={15} /></span>}
            <span>{channel.name}</span>
          </h1>
          {membersCount !== undefined && (
            <span className={s.convSub}>{[t.plural(membersCount, { one: "{count} member", other: "{count} members" }), online ? t.plural(online, { one: "{count} online", other: "{count} online" }) : null].filter(Boolean).join(" · ")}</span>
          )}
        </div>
        {channel.can_manage ? (
          <button type="button" className={s.convTopic} onClick={() => setTopicOpen(true)} title={t("Change the topic")}>{channel.topic || t("Add a topic")}</button>
        ) : (
          channel.topic && <p className={s.convTopic}>{channel.topic}</p>
        )}
        <div className={s.convTools}>
          {!isDirect && (
            <button type="button" className="btn btn-sm btn-ghost" aria-label={t("Pinned messages")} title={t("Pinned messages")} onClick={() => setPinsOpen(true)}>
              <Icon name="pushpin" size={15} /><span className={s.toolText}>{t("Pinned")}</span>
            </button>
          )}
          <button type="button" className="btn btn-sm btn-ghost btn-icon" aria-label={membersOpen ? t("Hide the member list") : membersCount ? t("Members ({count})", { count: membersCount }) : t("Members")} aria-pressed={membersOpen} title={t("Members")} onClick={onToggleMembers}>
            <Icon name="users" size={15} />
          </button>
          <ChannelNotifyMenu channel={channel} />
          {isDirect && <DirectMenu channel={channel} />}
        </div>
      </header>

      <div className={s.scroller} ref={scroller}>
        <div className={s.messages}>
          <div ref={top} />
          {messages.isFetchingNextPage && <span className={s.older}>{t("Loading older messages…")}</span>}
          {messages.error && <div style={{ padding: 16 }}><ErrorState compact error={messages.error} onRetry={() => messages.refetch()} /></div>}
          {messages.isPending && (
            <Loading label={t("Loading messages")} className="stack" >
              <div style={{ padding: "16px 8px" }} className="stack">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="row" style={{ gap: 10, alignItems: "flex-start" }}>
                    <Skeleton width={32} height={32} radius={16} />
                    <div className="stack-sm grow"><Skeleton width={160} height={12} /><Skeleton width="70%" height={13} /></div>
                  </div>
                ))}
              </div>
            </Loading>
          )}
          {atStart && !around && (
            <div className={s.welcome}>
              <span className={s.welcomeIcon}><ChannelIcon channel={channel} size={20} /></span>
              {isDirect ? (
                <>
                  <h2>{channel.name}</h2>
                  <p>{t("This is the start of your conversation with {names}. Only the people in it can read it.", { names: channel.name })}</p>
                </>
              ) : (
                <>
                  <h2>{t("Welcome to {channel}", { channel: channelLabel(channel) })}</h2>
                  <p>{t("This is the start of {channel}.", { channel: channelLabel(channel) })}{channel.topic ? ` ${channel.topic}` : ""}</p>
                </>
              )}
            </div>
          )}
          {all.map((m, i) => {
            const prev = all[i - 1];
            const day = isNewDay(prev, m);
            const fresh = m.id === newBefore;
            return (
              <div key={m.id} style={{ display: "contents" }}>
                {day && <div className={s.day} role="separator">{dayLabel(m.created_at)}</div>}
                {fresh && <div className={s.newLine} role="separator" aria-label={t("New messages")}><span>{t("New")}</span></div>}
                <MessageItem message={m} head={day || fresh || startsGroup(prev, m) || Boolean(m.reply)} flash={flash === m.id} ctx={ctx} />
              </div>
            );
          })}
          {around && (
            <Button className={s.jumpLatest} size="sm" variant="dark" icon="arrowRight" onClick={() => navigate(`/chat/${channel.id}`, { replace: true })}>{t("Jump to the latest")}</Button>
          )}
        </div>
      </div>

      <Composer
        channel={channel}
        options={options}
        replyTo={replyTo}
        onCancelReply={() => setReplyTo(null)}
        focusKey={focusKey}
        insert={mentionInsert}
      />

      <PersonDialog
        person={person}
        onClose={() => setPersonId(null)}
        onMention={channel.can_post ? (p) => { setMentionInsert({ option: { kind: "user", label: p.name, token: userToken(p.id), avatar: p.avatar_color, photo: p.avatar_url }, nonce: Date.now() }); setFocusKey(`mention:${Date.now()}`); } : null}
        onMessage={message}
      />
      <PinsDialog open={pinsOpen} channel={channel} ctx={ctx} onClose={() => setPinsOpen(false)} />
      <TopicDialog open={topicOpen} channel={channel} onClose={() => setTopicOpen(false)} />
    </section>
    {thread ? (
      <ThreadPanel key={thread} channel={channel} rootId={thread} ctx={ctx} options={options} onClose={() => navigate(`/chat/${channel.id}`)} />
    ) : (
      <>
        {membersOpen && <div className={s.membersBackdrop} onClick={onToggleMembers} aria-hidden="true" />}
        {membersOpen && <MembersPanel members={members.data} onPerson={setPersonId} onClose={onToggleMembers} onMessage={message} />}
      </>
    )}
    </>
  );
}

function PinsDialog({ open, channel, ctx, onClose }: { open: boolean; channel: ChatChannel; ctx: MessageContext; onClose: () => void }) {
  const pins = usePins(channel.id, open);
  return (
    <Dialog open={open} onClose={onClose} title={t("Pinned messages")} description={channel.can_manage ? t("Pin a message from its menu (···) to keep it here.") : undefined}>
      <div className="dialog-body">
        {pins.isPending && <span className="muted small">{t("Loading…")}</span>}
        {pins.data?.length === 0 && <EmptyState compact icon="pushpin" title={t("Nothing pinned yet")}>{t("Important messages, like gate codes or a change of plan, can be pinned to the channel.")}</EmptyState>}
        <div className={s.pinList}>
          {pins.data?.map((m) => (
            <button key={m.id} type="button" className={s.pinItem} onClick={() => { ctx.onJumpTo(m.id); onClose(); }}>
              <span className={s.pinWho}><strong>{m.author?.name ?? "Crewtavo"}</strong> · {dayLabel(m.created_at)}, {timeLabel(m.created_at)}</span>
              <div className={s.body}>{m.body ? <MessageText body={m.body} ctx={ctx} /> : m.attachments.length ? t("Photo") : t("Job")}</div>
            </button>
          ))}
        </div>
      </div>
    </Dialog>
  );
}

function TopicDialog({ open, channel, onClose }: { open: boolean; channel: ChatChannel; onClose: () => void }) {
  const { company } = useSession();
  const queryClient = useQueryClient();
  const [topic, setTopic] = useState(channel.topic ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) setTopic(channel.topic ?? "");
  }, [open, channel.topic]);
  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.patch(`/chat/channels/${channel.id}`, { topic: topic.trim() });
      await queryClient.invalidateQueries({ queryKey: chatKeys.state(company.id) });
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title={t("Topic for {channel}", { channel: channelLabel(channel) })} size="sm">
      <form className="dialog-body stack-sm" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <textarea className="textarea" value={topic} maxLength={300} rows={3} onChange={(e) => setTopic(e.target.value)} aria-label={t("Topic")} placeholder={t("What this channel is for")} />
        {error && <span className="field-error">{error}</span>}
        <div className="form-actions">
          <Button variant="ghost" onClick={onClose}>{t("Cancel")}</Button>
          <Button type="submit" variant="primary" loading={saving}>{t("Save")}</Button>
        </div>
      </form>
    </Dialog>
  );
}
