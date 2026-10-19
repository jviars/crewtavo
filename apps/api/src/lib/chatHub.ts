/**
 * Live team chat. Each open Crewtavo tab keeps one streaming connection (GET /api/chat/live), and
 * this hub sends it what happens in the channels its person can see, the moment it happens: new and
 * changed messages, reactions, who's typing and who's online. Every write goes through the API
 * (routes/chat.ts), which publishes it here after the database has accepted it.
 *
 * One process holds every connection, which is how an instance runs (one crewtavo service; see
 * deploy/README.md). With extra replicas, each sends only the events written through it, so tabs
 * on another replica would see changes when they next refetch, which they do as they reconnect.
 */
import type { Db } from "./supabase";

export type ChatEvent =
  | { type: "message"; channel_id: string; message: unknown }
  | { type: "message_updated"; channel_id: string; message: unknown }
  | { type: "reactions"; channel_id: string; message_id: string; reactions: unknown }
  | { type: "typing"; channel_id: string; user_id: string; name: string }
  | { type: "read"; channel_id: string }
  | { type: "presence"; online: string[] }
  | { type: "channels" }
  | { type: "chat"; enabled: boolean };

interface Listener {
  userId: string;
  send: (event: ChatEvent) => void;
}

const listeners = new Map<string, Set<Listener>>();

/** Who can see a channel, kept briefly: a burst of typing or messages asks the database once. */
const audiences = new Map<string, { at: number; users: Set<string> }>();
const AUDIENCE_MS = 15_000;

/** Start sending a person's events to `send`. Returns the function that stops it. */
export function subscribe(companyId: string, userId: string, send: (event: ChatEvent) => void): () => void {
  const wasOnline = isOnline(companyId, userId);
  const listener: Listener = { userId, send };
  const set = listeners.get(companyId) ?? new Set<Listener>();
  set.add(listener);
  listeners.set(companyId, set);
  if (!wasOnline) toCompany(companyId, { type: "presence", online: onlineUsers(companyId) });
  let done = false;
  return () => {
    if (done) return;
    done = true;
    set.delete(listener);
    if (!set.size) listeners.delete(companyId);
    if (!isOnline(companyId, userId)) toCompany(companyId, { type: "presence", online: onlineUsers(companyId) });
  };
}

export function onlineUsers(companyId: string): string[] {
  return [...new Set([...(listeners.get(companyId) ?? [])].map((l) => l.userId))];
}

const isOnline = (companyId: string, userId: string) => [...(listeners.get(companyId) ?? [])].some((l) => l.userId === userId);

function deliver(companyId: string, event: ChatEvent, to: (userId: string) => boolean) {
  for (const listener of listeners.get(companyId) ?? []) {
    if (!to(listener.userId)) continue;
    try {
      listener.send(event);
    } catch {
      // A connection that just closed; its own cleanup removes it.
    }
  }
}

/** Everyone connected in the company: presence, chat turned on or off, channels changed. */
export function toCompany(companyId: string, event: ChatEvent) {
  deliver(companyId, event, () => true);
}

/** One person's open tabs (what they read in one shows in the others). */
export function toUser(companyId: string, userId: string, event: ChatEvent) {
  deliver(companyId, event, (id) => id === userId);
}

/**
 * Everyone connected who can see the channel. `admin` is the service-role client: who can see a
 * channel is the database's answer (public.chat_audience), the same rule its row-level security uses.
 */
export async function toChannel(admin: Db, companyId: string, channelId: string, event: ChatEvent, options: { except?: string } = {}) {
  const connected = listeners.get(companyId);
  if (!connected?.size) return;
  const audience = await audienceOf(admin, channelId);
  deliver(companyId, event, (id) => id !== options.except && audience.has(id));
}

async function audienceOf(admin: Db, channelId: string): Promise<Set<string>> {
  const hit = audiences.get(channelId);
  if (hit && Date.now() - hit.at < AUDIENCE_MS) return hit.users;
  const { data, error } = await admin.rpc("chat_audience", { p_channel: channelId });
  if (error) throw new Error(error.message);
  const users = new Set(((data ?? []) as unknown as Array<string | { chat_audience: string }>).map((row) => (typeof row === "string" ? row : row.chat_audience)));
  audiences.set(channelId, { at: Date.now(), users });
  return users;
}

/** Roles, rules or chat itself changed: work out who sees what again. */
export function forgetAudiences() {
  audiences.clear();
}

/** For tests. */
export function resetHub() {
  listeners.clear();
  audiences.clear();
}
