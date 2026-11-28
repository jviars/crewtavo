/**
 * Team chat's minute (tasks.ts, chat_later): scheduled messages whose time has come are sent, each
 * as its author (public.chat_send_due, supabase/migrations/20261129103500_chat_scheduled_and_reminders.sql),
 * and reminders whose time has come go on their people's bells (public.chat_send_due_reminders;
 * push, email and text follow by the notify task). What's sent goes out live to the channel, and
 * each author's and person's open tabs hear their lists changed.
 */
import type { Env } from "../env";
import { toChannel, toUser } from "../lib/chatHub";
import { reportError } from "../lib/monitoring";
import { adminClient } from "../lib/supabase";
import { MESSAGE_COLUMNS, shapeMessages, type MessageRow } from "../routes/chat";
import { writeOut } from "./chatVoice";

export async function sendDueChat(env: Env) {
  const admin = adminClient(env);
  const due = await admin.rpc("chat_send_due", { p_limit: 50 });
  if (due.error) throw new Error(due.error.message);
  let sent = 0;
  let dropped = 0;
  for (const row of due.data ?? []) {
    toUser(row.company_id, row.author_id, { type: "scheduled", channel_id: row.channel_id });
    if (!row.message_id) {
      dropped++;
      continue;
    }
    sent++;
    try {
      // Only the message this run sent, where it was scheduled to go, as its author.
      const { data } = await admin.from("chat_messages").select(MESSAGE_COLUMNS).eq("id", row.message_id).eq("company_id", row.company_id).eq("channel_id", row.channel_id).eq("author_id", row.author_id).maybeSingle();
      if (!data) continue;
      const [message] = await shapeMessages(admin, row.company_id, [data as MessageRow]);
      await toChannel(admin, row.company_id, row.channel_id, { type: "message", channel_id: row.channel_id, message });
      // Its voice notes written out, as for one sent now.
      void writeOut(env, row.company_id, message).catch((error) => reportError(error, { feature: "chat-voice-words" }));
    } catch (error) {
      // Sent: only the live copy didn't go. Tabs catch up as they next read the channel.
      reportError(error, { feature: "chat-later" });
    }
  }
  const reminders = await admin.rpc("chat_send_due_reminders", { p_limit: 100 });
  if (reminders.error) throw new Error(reminders.error.message);
  for (const row of reminders.data ?? []) toUser(row.company_id, row.user_id, { type: "reminders" });
  return { sent, dropped, reminded: (reminders.data ?? []).filter((r) => r.told).length };
}
