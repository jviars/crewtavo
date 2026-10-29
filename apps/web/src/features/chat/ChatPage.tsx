/**
 * Team chat (/chat and /chat/:channelId). Channels on the left, grouped by category, with what's
 * new in each; the open channel in the middle; who's in it on the right. On a phone the channel list
 * and a channel are separate screens. Live updates come from useChatLive (mounted by the app shell).
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, NavLink, useNavigate, useParams, useSearchParams } from "react-router-dom";
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
import { chatKeys, chatOn, markRead, setViewing, useChatState, useJobCards, useMembers, useMessages, usePins, type ChatChannel, type ChatMember, type ChatMessage, type ChatState } from "./data";
import { MembersPanel, PersonDialog } from "./Members";
import { MessageItem, MessageText, type MessageContext } from "./MessageItem";
import { ChannelIcon, channelLabel, dayLabel, isNewDay, startsGroup, timeLabel } from "./ui";
import s from "./chat.module.css";

const LAST_CHANNEL = "crewtavo.chat.channel";
const MEMBERS_OPEN = "crewtavo.chat.members";
const COLLAPSED = "crewtavo.chat.collapsed";

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

export function ChatPage() {
  const session = useSession();
  const { channelId } = useParams();
  const [params] = useSearchParams();
  const around = params.get("message");
  const navigate = useNavigate();
  const state = useChatState();
  const [membersOpen, setMembersOpen] = useState(() => wide() && window.matchMedia("(min-width: 1181px)").matches && stored(MEMBERS_OPEN, true));
  const on = chatOn(session);
  const channels = state.data?.channels ?? [];
  const channel = channels.find((c) => c.id === channelId);
  useDocumentTitle(channel ? channelLabel(channel) : "Team chat");

  // On a computer, /chat opens the channel you had open last (or the first one).
  useEffect(() => {
    if (channelId || !channels.length || !wide()) return;
    const last = stored<string | null>(LAST_CHANNEL, null);
    const target = channels.find((c) => c.id === last && !c.archived) ?? channels.find((c) => !c.archived) ?? channels[0];
    navigate(`/chat/${target.id}`, { replace: true });
  }, [channelId, channels, navigate]);
  useEffect(() => {
    if (channel) store(LAST_CHANNEL, channel.id);
  }, [channel]);

  if (!on) return <ChatOff />;
  if (state.error && !state.data) return <div className="card" style={{ margin: 24 }}><ErrorState error={state.error} onRetry={() => state.refetch()} /></div>;

  const toggleMembers = () => {
    setMembersOpen((open) => {
      store(MEMBERS_OPEN, !open);
      return !open;
    });
  };

  return (
    <div className={s.layout} data-view={channelId ? "channel" : "list"} data-members={(membersOpen && channel) || undefined}>
      <ChannelList state={state.data} current={channelId} />
      {channel ? (
        <Conversation key={channel.id} channel={channel} state={state.data!} around={around} membersOpen={membersOpen} onToggleMembers={toggleMembers} />
      ) : (
        <section className={s.conversation} aria-label="Channel">
          {state.isPending ? (
            <Loading label="Loading chat" className="stack" >
              <div style={{ padding: 24 }} className="stack-sm"><Skeleton width={220} height={22} /><Skeleton width="60%" height={14} /></div>
            </Loading>
          ) : channelId ? (
            <EmptyState icon="hash" title="That channel isn't here" action={<Link className="btn" to="/chat">See your channels</Link>}>It may have been archived, or your role can't see it.</EmptyState>
          ) : (
            <EmptyState icon="chat" title={channels.length ? "Pick a channel" : "No channels yet"}>
              {channels.length ? "Choose one on the left to start talking." : "Ask an owner or admin to add one in Chat settings."}
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
    <div className="card" style={{ margin: "24px auto", maxWidth: 560 }}>
      <EmptyState icon="chat" title="Team chat is off" action={canTurnOn ? <Link className="btn btn-primary" to="/apps/team_chat">Install it from Apps</Link> : undefined}>
        {canTurnOn ? "Channels for the whole team, each crew and the office, with photos and @mentions." : "Ask an owner or admin to install Team chat from Apps."}
      </EmptyState>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Channel list
// ---------------------------------------------------------------------------------------------

function ChannelList({ state, current }: { state: ChatState | undefined; current: string | undefined }) {
  const session = useSession();
  const [collapsed, setCollapsed] = useState<string[]>(() => stored(COLLAPSED, []));
  const channels = state?.channels ?? [];
  const groups = useMemo(() => {
    const map = new Map<string, { name: string; order: number; channels: ChatChannel[] }>();
    for (const c of channels) {
      const name = c.archived ? "Archived" : c.category;
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
    <aside className={s.side} aria-label="Channels">
      <div className={s.sideHead}>
        {/* On a phone the top bar already names the business. */}
        <span className={`${s.sideTitle} hide-mobile`}>{session.company.name}</span>
        <span className={`${s.sideTitle} mobile-only`}>Team chat</span>
        {state?.me?.admin && (
          <Link to="/chat/settings" className="icon-btn" aria-label="Chat settings" title="Chat settings"><Icon name="settings" size={18} /></Link>
        )}
      </div>
      <nav className={s.sideList} aria-label="Channels">
        {!state && (
          <Loading label="Loading channels" className="stack-sm">
            {[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} height={30} />)}
          </Loading>
        )}
        {groups.map((g) => {
          const open = !collapsed.includes(g.name);
          return (
            <div key={g.name}>
              <button type="button" className={s.category} aria-expanded={open} onClick={() => toggle(g.name)}>
                <Icon name="chevronDown" size={12} strokeWidth={2} />
                <span>{g.name}</span>
              </button>
              {g.channels.filter((c) => open || c.id === current || c.mentions > 0).map((c) => (
                <div key={c.id} className={s.channelWrap}>
                  {c.unread > 0 && c.id !== current && <span className={s.unreadPip} aria-hidden="true" />}
                  <NavLink
                    to={`/chat/${c.id}`}
                    className={s.channel}
                    data-unread={(c.unread > 0 && c.id !== current) || undefined}
                    aria-label={`${channelLabel(c)}${c.mentions ? `, ${c.mentions} ${c.mentions === 1 ? "mention" : "mentions"}` : c.unread ? ", unread" : ""}`}
                  >
                    <ChannelIcon channel={c} />
                    <span className={s.channelName}>{c.name}</span>
                    {!c.can_post && !c.archived && c.kind !== "announcement" && <Icon name="eye" size={14} label="Read only" />}
                    {c.mentions > 0 && c.id !== current && <span className="badge badge-red">{c.mentions}</span>}
                  </NavLink>
                </div>
              ))}
            </div>
          );
        })}
        {state && !state.me?.admin && <p className={s.sideNote}>You see the channels your role allows. Ask an owner or admin if one is missing.</p>}
      </nav>
    </aside>
  );
}

// ---------------------------------------------------------------------------------------------
// A conversation
// ---------------------------------------------------------------------------------------------

function Conversation({ channel, state, around, membersOpen, onToggleMembers }: { channel: ChatChannel; state: ChatState; around: string | null; membersOpen: boolean; onToggleMembers: () => void }) {
  const session = useSession();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const company = session.company.id;
  const me = state.me?.user_id ?? session.userId;
  const messages = useMessages(channel.id, around);
  const members = useMembers(channel.id);
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
  const options: MentionOption[] = useMemo(() => {
    const people = (members.data ?? [])
      .filter((m) => m.id !== me)
      .map((m) => ({ kind: "user" as const, label: m.name, token: userToken(m.id), avatar: m.avatar_color, photo: m.avatar_url, hint: m.role_label }));
    const roles = state.roles
      .filter((r) => r.key !== "owner" && (r.mentionable || trusted))
      .map((r) => ({ kind: "role" as const, label: r.label, token: roleToken(r.key), color: r.color, hint: "Role" }));
    const everyone = channel.can_manage ? [{ kind: "everyone" as const, label: "everyone", token: EVERYONE_TOKEN, hint: "Everyone in this channel" }] : [];
    return [...people, ...roles, ...everyone];
  }, [members.data, state.roles, me, trusted, channel.can_manage]);

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
        document.getElementById(`message-${id}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
      } else navigate(`/chat/${channel.id}?message=${id}`);
    },
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

  return (
    <>
    <section className={s.conversation} aria-label={channelLabel(channel)}>
      <header className={s.convHead}>
        <Link to="/chat" className={`icon-btn ${s.back}`} aria-label="All channels"><Icon name="arrowLeft" size={20} /></Link>
        <div className={s.convTitle}>
          <ChannelIcon channel={channel} size={20} />
          <h1>{channel.name}</h1>
        </div>
        {channel.can_manage ? (
          <button type="button" className={s.convTopic} onClick={() => setTopicOpen(true)} title="Change the topic">{channel.topic || "Add a topic"}</button>
        ) : (
          channel.topic && <p className={s.convTopic}>{channel.topic}</p>
        )}
        <div className={s.convTools}>
          <button type="button" className="icon-btn" aria-label="Pinned messages" title="Pinned messages" onClick={() => setPinsOpen(true)}><Icon name="pushpin" size={19} /></button>
          <button type="button" className={`icon-btn${membersOpen ? ` ${s.toolOn}` : ""}`} aria-label={membersOpen ? "Hide the member list" : `Members${membersCount ? ` (${membersCount})` : ""}`} aria-pressed={membersOpen} title="Members" onClick={onToggleMembers}>
            <Icon name="users" size={19} />
          </button>
        </div>
      </header>

      <div className={s.scroller} ref={scroller}>
        <div className={s.messages}>
          <div ref={top} />
          {messages.isFetchingNextPage && <span className="muted small" style={{ alignSelf: "center", margin: 8 }}>Loading older messages…</span>}
          {messages.error && <div style={{ padding: 16 }}><ErrorState compact error={messages.error} onRetry={() => messages.refetch()} /></div>}
          {messages.isPending && (
            <Loading label="Loading messages" className="stack" >
              <div style={{ padding: "16px" }} className="stack">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="row" style={{ gap: 14, alignItems: "flex-start" }}>
                    <Skeleton width={40} height={40} radius={20} />
                    <div className="stack-sm grow"><Skeleton width={180} height={14} /><Skeleton width="70%" height={14} /></div>
                  </div>
                ))}
              </div>
            </Loading>
          )}
          {atStart && !around && (
            <div className={s.welcome}>
              <span className={s.welcomeIcon}><ChannelIcon channel={channel} size={30} /></span>
              <h2>Welcome to {channelLabel(channel)}</h2>
              <p>This is the start of {channelLabel(channel)}.{channel.topic ? ` ${channel.topic}` : ""}</p>
            </div>
          )}
          {all.map((m, i) => {
            const prev = all[i - 1];
            const day = isNewDay(prev, m);
            const fresh = m.id === newBefore;
            return (
              <div key={m.id} style={{ display: "contents" }}>
                {day && <div className={s.day} role="separator">{dayLabel(m.created_at)}</div>}
                {fresh && <div className={s.newLine} role="separator" aria-label="New messages"><span>New</span></div>}
                <MessageItem message={m} head={day || fresh || startsGroup(prev, m) || Boolean(m.reply)} flash={flash === m.id} ctx={ctx} />
              </div>
            );
          })}
          {around && (
            <Button className={s.jumpLatest} size="sm" variant="dark" icon="arrowRight" onClick={() => navigate(`/chat/${channel.id}`, { replace: true })}>Jump to the latest</Button>
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
      />
      <PinsDialog open={pinsOpen} channel={channel} ctx={ctx} onClose={() => setPinsOpen(false)} />
      <TopicDialog open={topicOpen} channel={channel} onClose={() => setTopicOpen(false)} />
    </section>
    {membersOpen && <div className={s.membersBackdrop} onClick={onToggleMembers} aria-hidden="true" />}
    {membersOpen && <MembersPanel members={members.data} onPerson={setPersonId} onClose={onToggleMembers} />}
    </>
  );
}

function PinsDialog({ open, channel, ctx, onClose }: { open: boolean; channel: ChatChannel; ctx: MessageContext; onClose: () => void }) {
  const pins = usePins(channel.id, open);
  return (
    <Dialog open={open} onClose={onClose} title="Pinned messages" description={channel.can_manage ? "Pin a message from its menu (···) to keep it here." : undefined}>
      <div className="dialog-body">
        {pins.isPending && <span className="muted">Loading…</span>}
        {pins.data?.length === 0 && <EmptyState compact icon="pushpin" title="Nothing pinned yet">Important messages, like gate codes or a change of plan, can be pinned to the channel.</EmptyState>}
        <div className={s.pinList}>
          {pins.data?.map((m) => (
            <button key={m.id} type="button" className={s.pinItem} onClick={() => { ctx.onJumpTo(m.id); onClose(); }}>
              <span className="small"><strong>{m.author?.name ?? "Crewtavo"}</strong> <span className="muted">{dayLabel(m.created_at)}, {timeLabel(m.created_at)}</span></span>
              <span style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{m.body ? <MessageText body={m.body} ctx={ctx} /> : m.attachments.length ? "Photo" : "Job"}</span>
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
    <Dialog open={open} onClose={onClose} title={`Topic for ${channelLabel(channel)}`} size="sm">
      <form className="dialog-body stack-sm" onSubmit={(e) => { e.preventDefault(); void save(); }}>
        <textarea className="textarea" value={topic} maxLength={300} rows={3} onChange={(e) => setTopic(e.target.value)} aria-label="Topic" placeholder="What this channel is for" />
        {error && <span className="field-error">{error}</span>}
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" loading={saving}>Save</Button>
        </div>
      </form>
    </Dialog>
  );
}
