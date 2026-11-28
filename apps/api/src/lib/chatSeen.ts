/**
 * "Seen by" kept current: when someone reads an announcement channel or a direct conversation, its
 * people hear about it (a `seen` event), so "Seen by 12 of 15" and "Seen" update without a reload.
 * Reading happens a lot (every message that arrives while a channel is open), so each channel's
 * news goes at most once every few seconds, with everyone who read in the meantime. An announcement's
 * event says only that someone read it: who has is for its author and managers to ask
 * (public.chat_seen_counts). A conversation's says who read up to when, which its people can see.
 */
import { toChannel } from "./chatHub";
import type { Db } from "./supabase";

/** How often a channel's "seen" goes out at most. */
export const SEEN_MS = 3_000;

const waiting = new Map<string, { reads: Map<string, string>; timer: ReturnType<typeof setTimeout> }>();

/** Someone read a channel up to `at`. Only announcement channels and direct conversations show it. */
export function noteSeen(admin: Db, companyId: string, channel: { id: string; kind: string }, userId: string, at: string, report: (error: unknown) => void) {
  if (channel.kind !== "announcement" && channel.kind !== "direct") return;
  const key = `${companyId}:${channel.id}`;
  const hit = waiting.get(key);
  if (hit) {
    hit.reads.set(userId, at);
    return;
  }
  const reads = new Map([[userId, at]]);
  const timer = setTimeout(() => {
    waiting.delete(key);
    const event = channel.kind === "direct"
      ? { type: "seen" as const, channel_id: channel.id, reads: [...reads].map(([user_id, when]) => ({ user_id, at: when })) }
      : { type: "seen" as const, channel_id: channel.id };
    toChannel(admin, companyId, channel.id, event).catch(report);
  }, SEEN_MS);
  timer.unref?.();
  waiting.set(key, { reads, timer });
}

/** A channel's kind, which never changes, kept once looked up (with the reader's own client). */
const kinds = new Map<string, string>();
export async function channelKind(db: Db, channelId: string): Promise<string | null> {
  const known = kinds.get(channelId);
  if (known) return known;
  const { data } = await db.from("chat_channels").select("kind").eq("id", channelId).maybeSingle();
  if (data?.kind) {
    if (kinds.size > 5_000) kinds.clear();
    kinds.set(channelId, data.kind);
  }
  return data?.kind ?? null;
}

/** For tests. */
export function resetSeen() {
  for (const { timer } of waiting.values()) clearTimeout(timer);
  waiting.clear();
}
