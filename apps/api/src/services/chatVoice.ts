/**
 * Team chat voice notes written out by the server, with the business's own OpenAI key (Apps →
 * ChatGPT), once an owner or admin has turned it on in Chat settings (companies.settings
 * .chat_voice_words; it's off until then, and the key is checked with OpenAI before it goes on).
 * Without it, a voice note keeps the words the phone heard while it was recorded, if any.
 *
 * Each voice note on a message is written out after the message is sent, and its words kept in
 * public.chat_transcripts (a message's files can't change after sending), then the message goes
 * out again to everyone looking at the channel with those words. Writing out has an hourly
 * allowance of its own, as reading receipts has (services/ai.ts), so a busy day of voice notes
 * doesn't use up the asks for everyone's other AI features. Past it, the phone's words stay.
 */
import { isAudio } from "@crewtavo/core/chatField";
import type { Context } from "hono";
import type { AppEnv, Env } from "../env";
import { OpenAiProblem, TRANSCRIBE_MODELS, transcribeWithKey } from "../integrations/openai";
import { loadSecret } from "../integrations/tokens";
import { runInBackground } from "../lib/background";
import { toChannel } from "../lib/chatHub";
import { allow } from "../lib/limit";
import { reportError } from "../lib/monitoring";
import { adminClient, type Db } from "../lib/supabase";
import { MESSAGE_COLUMNS, shapeMessages, type ChatMessageOut, type MessageRow } from "../routes/chat";

/** Voice notes one person's messages may have written out in an hour, and everyone at one company between them. */
export const VOICE_WORDS_PER_PERSON = 60;
export const VOICE_WORDS_PER_COMPANY = 300;
/** OpenAI takes recordings up to 25 MB; a five-minute voice note is a few. */
const MOST_BYTES = 25 * 1024 * 1024;

/** Whether the company writes voice notes out (settings.chat_voice_words). */
export const voiceWordsOn = (settings: unknown) => (settings as { chat_voice_words?: unknown } | null)?.chat_voice_words === true;

interface Voiced {
  id: string;
  channel_id: string;
  author_id: string | null;
  attachments: Array<{ path: string; name?: string; type?: string }>;
}

/** After a message is sent (routes/chat.ts, and a scheduled one): its voice notes written out, without holding up the answer. */
export function afterMessage(c: Context<AppEnv>, message: ChatMessageOut) {
  if (!message.attachments.some(isAudio)) return;
  runInBackground(c, writeOut(c.env, c.var.companyId, message));
}

/**
 * Writes out a message's voice notes, keeps the words and sends the message out again with them.
 * Nothing (0) when the company hasn't turned it on, has no OpenAI key, or is past the hour's allowance.
 */
export async function writeOut(env: Env, companyId: string, message: Voiced): Promise<number> {
  const notes = message.attachments.filter(isAudio);
  if (!notes.length) return 0;
  const admin = adminClient(env);
  const { data: company, error } = await admin.from("companies").select("settings").eq("id", companyId).maybeSingle();
  if (error) throw new Error(error.message);
  if (!voiceWordsOn(company?.settings)) return 0;
  const key = (await loadSecret(env, admin, companyId, "chatgpt").catch(() => null))?.api_key;
  if (!key) return 0;

  let saved = 0;
  for (const note of notes) {
    if (!(await allowed(env, companyId, message.author_id))) break;
    const file = await admin.storage.from("files").download(note.path);
    if (file.error || !file.data || file.data.size > MOST_BYTES) continue;
    const words = await transcribe(env, key, file.data, note.path.split("/").pop() || "voice-note.webm");
    if (!words) continue;
    const { error: keepError } = await admin.from("chat_transcripts").upsert({ company_id: companyId, channel_id: message.channel_id, message_id: message.id, path: note.path, words: words.slice(0, 20000) });
    // The message was deleted meanwhile: its words aren't kept.
    if (keepError) continue;
    saved++;
  }
  if (saved) await sendAgain(admin, companyId, message.id);
  return saved;
}

async function allowed(env: Env, companyId: string, authorId: string | null) {
  return (!authorId || (await allow(env, `voicewords:person:${authorId}`, VOICE_WORDS_PER_PERSON, 3600))) && (await allow(env, `voicewords:company:${companyId}`, VOICE_WORDS_PER_COMPANY, 3600));
}

/** The words, trying each model in turn while the key can't use one. Empty when OpenAI couldn't (the phone's words stay). */
async function transcribe(env: Env, apiKey: string, body: Blob, fileName: string): Promise<string> {
  for (const model of TRANSCRIBE_MODELS) {
    try {
      return await transcribeWithKey(env, apiKey, { body, fileName }, { model, timeoutMs: 60_000 });
    } catch (error) {
      if (error instanceof OpenAiProblem && (error.kind === "model" || error.kind === "unsupported")) continue;
      // The key turned down, out of credit, busy: said once in the server's log, never with the key.
      if (error instanceof OpenAiProblem) console.warn(`Couldn't write out a voice note: ${error.message}`);
      else reportError(error, { feature: "chat-voice-words" });
      return "";
    }
  }
  return "";
}

/** The message as it is now, with its words, to everyone looking at its channel. */
async function sendAgain(admin: Db, companyId: string, messageId: string) {
  const { data } = await admin.from("chat_messages").select(MESSAGE_COLUMNS).eq("id", messageId).maybeSingle();
  if (!data || (data as MessageRow).deleted_at) return;
  const [message] = await shapeMessages(admin, companyId, [data as MessageRow]);
  await toChannel(admin, companyId, message.channel_id, { type: "message_updated", channel_id: message.channel_id, message });
}
