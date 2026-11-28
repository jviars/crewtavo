/**
 * Team chat data: what the API answers (apps/api/src/routes/chat.ts), the queries and changes
 * screens use, and the live connection that keeps every open tab current (useChatLive, mounted
 * once by the app shell). Live events update the cached queries in place, so a new message shows
 * the moment it's sent, with no refetch.
 */
import { useInfiniteQuery, useQuery, useQueryClient, type InfiniteData, type QueryClient } from "@tanstack/react-query";
import { useEffect, useSyncExternalStore } from "react";
import type { ChatColor } from "@crewtavo/core/chat";
import { activeCompany, api, refreshSignIn, supabase } from "@/lib/api";
import { useSession, type Session } from "@/lib/session";
import { withDirectNames } from "./direct";

// ---------------------------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------------------------

export interface ChatChannel {
  id: string;
  /** direct: a conversation between people (DirectMessages.tsx), named by them (direct.ts). */
  kind: "text" | "announcement" | "direct";
  name: string;
  category: string;
  topic: string | null;
  crew_id: string | null;
  position: number;
  archived: boolean;
  can_post: boolean;
  can_manage: boolean;
  unread: number;
  mentions: number;
  last_message_at: string | null;
  created_at?: string;
  /** A direct conversation's other people (ids in state.people); null for a channel. */
  people?: string[] | null;
  /** A direct conversation closed until a new message comes. */
  closed?: boolean;
}

export interface ChatRole {
  key: string;
  label: string;
  custom: boolean;
  color: ChatColor;
  mentionable: boolean;
  show_separately: boolean;
}

export interface ChatState {
  enabled: boolean;
  /** Direct messages on for the business (Chat settings; on unless an owner or admin turned them off). */
  direct_messages: boolean;
  me: { user_id: string; role_key: string; admin: boolean } | null;
  channels: ChatChannel[];
  roles: ChatRole[];
  /** Everyone in my direct conversations, by id. */
  people: Record<string, ChatPerson>;
  /** The threads I follow: how many have new replies, and the mentions in them. */
  threads?: { unread: number; mentions: number };
}

export interface ChatPerson {
  id: string;
  name: string;
  avatar_color: string | null;
  /** Their photo in the files bucket, or null for initials. */
  avatar_url: string | null;
  role_key: string;
  role_label: string;
  color: ChatColor;
}

export interface ChatAttachment {
  path: string;
  name?: string;
  type?: string;
  size?: number;
  width?: number;
  height?: number;
}

export interface ChatReactionGroup {
  kind: string;
  users: string[];
}

export interface ChatMessage {
  id: string;
  channel_id: string;
  author_id: string | null;
  body: string;
  attachments: ChatAttachment[];
  job_id: string | null;
  reply_to: string | null;
  mention_users: string[];
  mention_roles: string[];
  mention_all: boolean;
  pinned_at: string | null;
  pinned_by: string | null;
  edited_at: string | null;
  deleted_at: string | null;
  created_at: string;
  author: ChatPerson | null;
  reply: { id: string; author: string; body: string; deleted: boolean } | null;
  reactions: ChatReactionGroup[];
  /** A thread reply's root (Threads.tsx), and whether it was also sent to the channel's main list. */
  thread_root?: string | null;
  also_in_channel?: boolean;
  /** A message with replies in a thread: how many, the last one's time, and who replied. */
  thread?: { replies: number; last_reply_at: string; people: ChatPerson[] } | null;
}

export interface ChatMember extends ChatPerson {
  role: string;
  show_separately: boolean;
  online: boolean;
}

interface MessagePage {
  messages: ChatMessage[];
  has_more: boolean;
}

/** Is team chat on for this business (Apps → Team chat)? It's the team's: a sub never has it. */
export const chatOn = (session: Pick<Session, "company" | "role">) =>
  session.role !== "subcontractor" && (session.company.settings as { team_chat?: { enabled?: boolean } } | null)?.team_chat?.enabled === true;

// ---------------------------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------------------------

export const chatKeys = {
  all: (company: string) => ["chat", company] as const,
  state: (company: string) => ["chat", company, "state"] as const,
  messages: (company: string, channel: string) => ["chat", company, "messages", channel] as const,
  members: (company: string, channel: string) => ["chat", company, "members", channel] as const,
  pins: (company: string, channel: string) => ["chat", company, "pins", channel] as const,
  thread: (company: string, root: string) => ["chat", company, "thread", root] as const,
  threads: (company: string) => ["chat", company, "threads"] as const,
  settings: (company: string) => ["chat", company, "settings"] as const,
};

export function useChatState() {
  const session = useSession();
  const on = chatOn(session);
  return useQuery({
    queryKey: chatKeys.state(session.company.id),
    queryFn: () => api.get<ChatState>("/chat/state"),
    select: withDirectNames,
    enabled: on,
    // The live connection keeps this current; this is the fallback when it can't connect.
    refetchInterval: 60_000,
    meta: { silent: true },
  });
}

/** Mentions waiting across every channel, and whether anything at all is unread (for the menu). */
export function useChatBadge(): { mentions: number; unread: boolean } {
  const state = useChatState();
  const channels = state.data?.channels ?? [];
  const threads = state.data?.threads ?? { unread: 0, mentions: 0 };
  return { mentions: channels.reduce((n, c) => n + c.mentions, 0) + threads.mentions, unread: channels.some((c) => c.unread > 0) || threads.unread > 0 };
}

/** A channel's messages, newest page first; older pages load as people scroll up. */
export function useMessages(channelId: string | undefined, around?: string | null) {
  const { company } = useSession();
  return useInfiniteQuery({
    queryKey: [...chatKeys.messages(company.id, channelId ?? "none"), around ?? null],
    enabled: Boolean(channelId),
    initialPageParam: around ? `around:${around}` : "",
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams();
      if (pageParam.startsWith("around:")) params.set("around", pageParam.slice(7));
      else if (pageParam) params.set("before", pageParam);
      return api.get<MessagePage>(`/chat/channels/${channelId}/messages${params.size ? `?${params}` : ""}`);
    },
    getNextPageParam: (last) => (last.has_more && last.messages.length ? last.messages[0].created_at : undefined),
    staleTime: 30_000,
  });
}

export function useMembers(channelId: string | undefined) {
  const { company } = useSession();
  return useQuery({
    queryKey: chatKeys.members(company.id, channelId ?? "none"),
    enabled: Boolean(channelId),
    queryFn: () => api.get<{ members: ChatMember[] }>(`/chat/channels/${channelId}/members`).then((r) => r.members),
    staleTime: 60_000,
  });
}

export function usePins(channelId: string | undefined, enabled: boolean) {
  const { company } = useSession();
  return useQuery({
    queryKey: chatKeys.pins(company.id, channelId ?? "none"),
    enabled: Boolean(channelId) && enabled,
    queryFn: () => api.get<{ messages: ChatMessage[] }>(`/chat/channels/${channelId}/pins`).then((r) => r.messages),
  });
}

export interface JobCard {
  id: string;
  number: number | null;
  title: string;
  status: string;
  client: { display_name: string } | null;
  property: { line1: string; city: string | null } | null;
}

/** Jobs linked from messages. Someone who can't open a job (another crew's) gets nothing back for it. */
export function useJobCards(ids: string[]) {
  const { company } = useSession();
  const key = [...new Set(ids)].sort();
  return useQuery({
    queryKey: ["chat-jobs", company.id, key],
    enabled: key.length > 0,
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase()
        .from("jobs")
        .select("id, number, title, status, client:clients(display_name), property:properties(line1, city)")
        .eq("company_id", company.id)
        .in("id", key);
      if (error) throw new Error(error.message);
      return new Map((data as unknown as JobCard[]).map((j) => [j.id, j]));
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Changing the cache from live events and from the person's own changes
// ---------------------------------------------------------------------------------------------

type Pages = InfiniteData<MessagePage, string>;

function updatePages(queryClient: QueryClient, company: string, channel: string, change: (pages: Pages) => Pages) {
  queryClient.setQueriesData<Pages>({ queryKey: chatKeys.messages(company, channel) }, (data) => (data ? change(data) : data));
}

/** A new message: onto the newest page, once (the sender's own answer and the live event both bring it). A thread reply goes to its thread, and to the channel only when it was also sent there. */
export function addMessage(queryClient: QueryClient, company: string, message: ChatMessage) {
  if (message.thread_root) {
    addReply(queryClient, company, message);
    if (!message.also_in_channel) return;
  }
  updatePages(queryClient, company, message.channel_id, (data) => {
    if (data.pages.some((p) => p.messages.some((m) => m.id === message.id))) return replaceIn(data, message);
    const [first, ...rest] = data.pages;
    // A page around an older message isn't the newest; leave it, the next refetch brings this.
    if (data.pageParams[0]?.startsWith("around:")) return data;
    return { ...data, pages: [{ ...first, messages: [...first.messages, message] }, ...rest] };
  });
}

function replaceIn(data: Pages, message: ChatMessage): Pages {
  return { ...data, pages: data.pages.map((p) => ({ ...p, messages: p.messages.map((m) => (m.id === message.id ? message : m)) })) };
}

export function replaceMessage(queryClient: QueryClient, company: string, message: ChatMessage) {
  updatePages(queryClient, company, message.channel_id, (data) => replaceIn(data, message));
  updateThreads(queryClient, company, (m) => (m.id === message.id ? message : m));
  queryClient.invalidateQueries({ queryKey: chatKeys.pins(company, message.channel_id) });
}

export function setReactions(queryClient: QueryClient, company: string, channel: string, messageId: string, reactions: ChatReactionGroup[]) {
  updatePages(queryClient, company, channel, (data) => ({
    ...data,
    pages: data.pages.map((p) => ({ ...p, messages: p.messages.map((m) => (m.id === messageId ? { ...m, reactions } : m)) })),
  }));
  updateThreads(queryClient, company, (m) => (m.id === messageId ? { ...m, reactions } : m));
}

// ---------------------------------------------------------------------------------------------
// Threads (Threads.tsx): a message's replies, newest page first like a channel's
// ---------------------------------------------------------------------------------------------

export interface ThreadPage {
  root: ChatMessage;
  replies: ChatMessage[];
  has_more: boolean;
  following: boolean;
}
type ThreadPages = InfiniteData<ThreadPage, string>;

export function useThread(root: string | null) {
  const { company } = useSession();
  return useInfiniteQuery({
    queryKey: chatKeys.thread(company.id, root ?? "none"),
    enabled: Boolean(root),
    initialPageParam: "",
    queryFn: ({ pageParam }) => api.get<ThreadPage>(`/chat/messages/${root}/thread${pageParam ? `?before=${encodeURIComponent(pageParam)}` : ""}`),
    getNextPageParam: (last) => (last.has_more && last.replies.length ? last.replies[0].created_at : undefined),
    staleTime: 30_000,
  });
}

/** Each open thread's root and replies, changed by `change`. */
function updateThreads(queryClient: QueryClient, company: string, change: (m: ChatMessage) => ChatMessage) {
  queryClient.setQueriesData<ThreadPages>({ queryKey: ["chat", company, "thread"] }, (data) =>
    data ? { ...data, pages: data.pages.map((p) => ({ ...p, root: change(p.root), replies: p.replies.map(change) })) } : data,
  );
}

function addReply(queryClient: QueryClient, company: string, message: ChatMessage) {
  queryClient.setQueryData<ThreadPages>(chatKeys.thread(company, message.thread_root!), (data) => {
    if (!data) return data;
    if (data.pages.some((p) => p.replies.some((m) => m.id === message.id))) {
      return { ...data, pages: data.pages.map((p) => ({ ...p, replies: p.replies.map((m) => (m.id === message.id ? message : m)) })) };
    }
    const [first, ...rest] = data.pages;
    return { ...data, pages: [{ ...first, replies: [...first.replies, message] }, ...rest] };
  });
}

export function setFollowing(queryClient: QueryClient, company: string, root: string, following: boolean) {
  queryClient.setQueryData<ThreadPages>(chatKeys.thread(company, root), (data) => (data ? { ...data, pages: data.pages.map((p) => ({ ...p, following })) } : data));
}

/** Read the thread up to now: here at once, then on the server. */
export async function markThreadRead(queryClient: QueryClient, company: string, root: string) {
  await api.post(`/chat/messages/${root}/thread/read`).catch(() => undefined);
  queryClient.invalidateQueries({ queryKey: chatKeys.state(company) });
  queryClient.invalidateQueries({ queryKey: chatKeys.threads(company) });
  queryClient.invalidateQueries({ queryKey: ["notifications"] });
}

/** Read up to now: clear the channel's counts here at once, and tell the server. */
export async function markRead(queryClient: QueryClient, company: string, channel: string) {
  queryClient.setQueryData<ChatState>(chatKeys.state(company), (state) =>
    state ? { ...state, channels: state.channels.map((c) => (c.id === channel ? { ...c, unread: 0, mentions: 0 } : c)) } : state,
  );
  await api.post(`/chat/channels/${channel}/read`).catch(() => undefined);
  queryClient.invalidateQueries({ queryKey: ["notifications"] });
}

// ---------------------------------------------------------------------------------------------
// Who's online and who's typing (from the live connection, not the database)
// ---------------------------------------------------------------------------------------------

interface LiveStore {
  connected: boolean;
  online: Set<string>;
  /** channel -> person -> { name, until } */
  typing: Map<string, Map<string, { name: string; until: number }>>;
  /** Which channel this tab has open, so its new messages count as read. */
  viewing: string | null;
  /** Which thread this tab has open, likewise. */
  viewingThread: string | null;
}

let live: LiveStore = { connected: false, online: new Set(), typing: new Map(), viewing: null, viewingThread: null };
const subscribers = new Set<() => void>();
const emit = () => subscribers.forEach((fn) => fn());
const setLive = (patch: Partial<LiveStore>) => {
  live = { ...live, ...patch };
  emit();
};
const subscribe = (fn: () => void) => {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
};

export const useLive = () => useSyncExternalStore(subscribe, () => live);
export const setViewing = (channel: string | null) => {
  if (live.viewing !== channel) setLive({ viewing: channel });
};
export const setViewingThread = (root: string | null) => {
  if (live.viewingThread !== root) setLive({ viewingThread: root });
};

export function useTyping(channel: string | undefined, me: string | undefined): string[] {
  const state = useLive();
  const now = Date.now();
  return [...(channel ? state.typing.get(channel)?.entries() ?? [] : [])].filter(([id, t]) => id !== me && t.until > now).map(([, t]) => t.name);
}

let typingTimer: ReturnType<typeof setTimeout> | undefined;
function noteTyping(channel: string, user: string, name: string) {
  const typing = new Map(live.typing);
  const people = new Map(typing.get(channel) ?? []);
  people.set(user, { name, until: Date.now() + 6_000 });
  typing.set(channel, people);
  setLive({ typing });
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => setLive({ typing: new Map(live.typing) }), 6_100);
}
function stopTyping(channel: string, user: string) {
  const people = live.typing.get(channel);
  if (!people?.has(user)) return;
  const typing = new Map(live.typing);
  const next = new Map(people);
  next.delete(user);
  typing.set(channel, next);
  setLive({ typing });
}

// ---------------------------------------------------------------------------------------------
// The live connection
// ---------------------------------------------------------------------------------------------

type LiveEvent =
  | { type: "hello"; online: string[] }
  | { type: "message" | "message_updated"; channel_id: string; message: ChatMessage }
  | { type: "reactions"; channel_id: string; message_id: string; reactions: ChatReactionGroup[] }
  | { type: "typing"; channel_id: string; user_id: string; name: string }
  | { type: "read"; channel_id: string }
  | { type: "presence"; online: string[] }
  | { type: "channels" }
  | { type: "chat"; enabled: boolean };

/**
 * One streaming connection per tab while chat is on (GET /api/chat/live). It reconnects by itself,
 * waiting a little longer each time it fails, and catches up with a refetch whenever it reconnects
 * after losing the connection.
 */
export function useChatLive() {
  const session = useSession();
  const queryClient = useQueryClient();
  const on = chatOn(session);
  const company = session.company.id;
  const me = session.userId;
  const refresh = session.refresh;

  useEffect(() => {
    if (!on) return;
    const controller = new AbortController();
    let attempt = 0;
    let stopped = false;
    let lostOnce = false;
    let stateTimer: ReturnType<typeof setTimeout> | undefined;
    const refreshState = () => {
      clearTimeout(stateTimer);
      stateTimer = setTimeout(() => queryClient.invalidateQueries({ queryKey: chatKeys.state(company) }), 250);
    };

    const handle = (event: LiveEvent) => {
      switch (event.type) {
        case "hello":
        case "presence":
          setLive({ online: new Set(event.online) });
          return;
        case "message": {
          addMessage(queryClient, company, event.message);
          if (event.message.author_id) stopTyping(event.channel_id, event.message.author_id);
          const root = event.message.thread_root;
          const visible = document.visibilityState === "visible";
          if (root) {
            // A thread reply: read if its thread is open here, and the Threads view's counts change.
            if (live.viewingThread === root && visible) void markThreadRead(queryClient, company, root);
            else if (event.message.author_id !== me) {
              refreshState();
              queryClient.invalidateQueries({ queryKey: chatKeys.threads(company) });
            }
            if (!event.message.also_in_channel) return;
          }
          if (live.viewing === event.channel_id && visible) void markRead(queryClient, company, event.channel_id);
          else if (event.message.author_id !== me) refreshState();
          return;
        }
        case "message_updated":
          replaceMessage(queryClient, company, event.message);
          return;
        case "reactions":
          setReactions(queryClient, company, event.channel_id, event.message_id, event.reactions);
          return;
        case "typing":
          noteTyping(event.channel_id, event.user_id, event.name);
          return;
        case "read":
          refreshState();
          return;
        case "channels":
          queryClient.invalidateQueries({ queryKey: chatKeys.all(company) });
          return;
        case "chat":
          void refresh();
          queryClient.invalidateQueries({ queryKey: chatKeys.all(company) });
          return;
      }
    };

    const connect = async () => {
      while (!stopped) {
        try {
          const { data } = await supabase().auth.getSession();
          const token = data.session?.access_token;
          if (!token) throw new Error("signed out"); // i18n-ignore: not shown
          const res = await fetch("/api/chat/live", {
            headers: { Authorization: `Bearer ${token}`, "X-Company-Id": activeCompany() ?? company, Accept: "text/event-stream" },
            signal: controller.signal,
            cache: "no-store",
          });
          if (res.status === 401) {
            await refreshSignIn();
            throw new Error("sign-in refreshed"); // i18n-ignore: not shown
          }
          if (res.status === 409) return; // chat turned off; the session refresh unmounts this
          if (!res.ok || !res.body) throw new Error(`live ${res.status}`); // i18n-ignore: not shown
          attempt = 0;
          setLive({ connected: true });
          if (lostOnce) queryClient.invalidateQueries({ queryKey: chatKeys.all(company) });
          await readEvents(res.body, handle);
        } catch {
          if (stopped) return;
        }
        setLive({ connected: false });
        lostOnce = true;
        if (stopped) return;
        attempt += 1;
        const wait = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5)) * (0.75 + Math.random() / 2);
        await new Promise((resolve) => setTimeout(resolve, navigator.onLine ? wait : Math.max(wait, 5_000)));
      }
    };
    void connect();
    return () => {
      stopped = true;
      controller.abort();
      clearTimeout(stateTimer);
      setLive({ connected: false, online: new Set() });
    };
  }, [on, company, me, queryClient, refresh]);
}

/** Server-sent events from a fetch body: "event: x\ndata: {...}\n\n". */
export async function readEvents(body: ReadableStream<Uint8Array>, handle: (event: LiveEvent) => void) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let end: number;
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = frame
        .split("\n")
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n");
      if (!data || data === "{}") continue;
      try {
        handle(JSON.parse(data) as LiveEvent);
      } catch {
        // A frame we don't understand (a newer server): skip it.
      }
    }
  }
}
