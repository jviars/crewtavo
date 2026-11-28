/**
 * Threads in team chat: what a message that started one says under it ("3 replies", the last one's
 * time, who replied), for routes/chat.ts's messages and routes/chatThreads.ts's threads. Counted by
 * public.chat_thread_summaries, which answers only for channels the person can see
 * (supabase/migrations/20261129101100_chat_threads.sql).
 */
import { dbError } from "./http";
import type { Db } from "./supabase";

export interface ThreadSummary {
  replies: number;
  last_reply_at: string;
  /** Who replied, the latest first (up to five). */
  people: string[];
}

/** Summaries for the messages among `ids` that have replies. */
export async function threadSummaries(db: Db, ids: string[]): Promise<Map<string, ThreadSummary>> {
  const out = new Map<string, ThreadSummary>();
  if (!ids.length) return out;
  const { data, error } = await db.rpc("chat_thread_summaries", { p_roots: ids });
  if (error) throw dbError(error);
  for (const row of data ?? []) out.set(row.root_id, { replies: row.replies, last_reply_at: row.last_reply_at, people: row.people ?? [] });
  return out;
}

/** The main list of a channel: messages not in a thread, and thread replies also sent to the channel (PostgREST's or=). */
export const IN_CHANNEL = "thread_root.is.null,also_in_channel.is.true";
