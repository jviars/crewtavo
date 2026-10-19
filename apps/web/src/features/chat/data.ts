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

// ---------------------------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------------------------

export interface ChatChannel {
  id: string;
  kind: "text" | "announcement";
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
  me: { user_id: string; role_key: string; admin: boolean } | null;
  channels: ChatChannel[];
  roles: ChatRole[];
}

export interface ChatPerson {
  id: string;
  name: string;
  avatar_color: string | null;
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

/** Is team chat on for this business (Apps → Team chat)? */
export const chatOn = (session: Pick<Session, "company">) => (session.company.settings as { team_chat?: { enabled?: boolean } } | null)?.team_chat?.enabled === true;

// ---------------------------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------------------------

export const chatKeys = {
  all: (company: string) => ["chat", company] as const,
  state: (company: string) => ["chat", company, "state"] as const,
  messages: (company: string, channel: string) => ["chat", company, "messages", channel] as const,
  members: (company: string, channel: string) => ["chat", company, "members", channel] as const,
  pins: (company: string, channel: string) => ["chat", company, "pins", channel] as const,
  settings: (company: string) => ["chat", company, "settings"] as const,
};

export function useChatState() {
  const session = useSession();
  const on = chatOn(session);
  return useQuery({
    queryKey: chatKeys.state(session.company.id),
    queryFn: () => api.get<ChatState>("/chat/state"),
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
  return { mentions: channels.reduce((n, c) => n + c.mentions, 0), unread: channels.some((c) => c.unread > 0) };
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

/** A new message: onto the newest page, once (the sender's own answer and the live event both bring it). */
export function addMessage(queryClient: QueryClient, company: string, message: ChatMessage) {
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
  queryClient.invalidateQueries({ queryKey: chatKeys.pins(company, message.channel_id) });
}

export function setReactions(queryClient: QueryClient, company: string, channel: string, messageId: string, reactions: ChatReactionGroup[]) {
  updatePages(queryClient, company, channel, (data) => ({
    ...data,
    pages: data.pages.map((p) => ({ ...p, messages: p.messages.map((m) => (m.id === messageId ? { ...m, reactions } : m)) })),
  }));
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
}

let live: LiveStore = { connected: false, online: new Set(), typing: new Map(), viewing: null };
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
          if (live.viewing === event.channel_id && document.visibilityState === "visible") void markRead(queryClient, company, event.channel_id);
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
          if (!token) throw new Error("signed out");
          const res = await fetch("/api/chat/live", {
            headers: { Authorization: `Bearer ${token}`, "X-Company-Id": activeCompany() ?? company, Accept: "text/event-stream" },
            signal: controller.signal,
            cache: "no-store",
          });
          if (res.status === 401) {
            await refreshSignIn();
            throw new Error("sign-in refreshed");
          }
          if (res.status === 409) return; // chat turned off; the session refresh unmounts this
          if (!res.ok || !res.body) throw new Error(`live ${res.status}`);
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
