/**
 * The words of a message's voice notes as people read them: the server's transcript when it made
 * one (public.chat_transcripts, services/chatVoice.ts), else what the phone heard while it was
 * recorded (the attachment's own "words"). Read as whoever asks, so row-level security decides.
 */
import type { Db } from "./supabase";

/** Transcripts by message, then by the voice note's path. */
export async function loadTranscripts(db: Db, messageIds: string[]): Promise<Map<string, Map<string, string>>> {
  const out = new Map<string, Map<string, string>>();
  if (!messageIds.length) return out;
  const { data, error } = await db.from("chat_transcripts").select("message_id, path, words").in("message_id", messageIds);
  // Words are an extra: a message still shows without them.
  if (error) {
    console.warn("Couldn't read voice note transcripts", error.message);
    return out;
  }
  for (const row of data ?? []) {
    const byPath = out.get(row.message_id) ?? new Map<string, string>();
    byPath.set(row.path, row.words);
    out.set(row.message_id, byPath);
  }
  return out;
}

/** A message's files with the server's words on the voice notes it wrote out. */
export function withTranscripts<A extends { path: string; words?: string }>(attachments: A[], words: Map<string, string> | undefined): Array<A & { words_by?: "server" }> {
  if (!words?.size) return attachments;
  return attachments.map((a) => (words.has(a.path) ? { ...a, words: words.get(a.path)!, words_by: "server" as const } : a));
}
