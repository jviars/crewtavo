/**
 * Saved for later in team chat: a person's own saved messages (GET /chat/saved, newest saved
 * first) and saving or taking one out (PUT /chat/messages/:id/saved). Each person reads and writes
 * only their own, and only for messages they can read (chat_saved's row-level security,
 * supabase/migrations/20261129102300_chat_saved.sql). Their other open tabs hear about it at once.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { requireCompany, requireUser } from "../lib/auth";
import { toUser } from "../lib/chatHub";
import { HttpError, must, param, readJson } from "../lib/http";
import { chatDbError, MESSAGE_COLUMNS, requireOn, shapeMessages, type MessageRow } from "./chat";

export const chatSaved = new Hono<AppEnv>();

/** The newest this many come with their messages; the ids of all of them come for the marks. */
const LISTED = 200;
const MARKED = 2_000;

chatSaved.get("/chat/saved", requireUser, requireCompany(), async (c) => {
  const { db, companyId } = c.var;
  await requireOn(c);
  const saved = must(await db.from("chat_saved").select("message_id, created_at").eq("company_id", companyId).order("created_at", { ascending: false }).limit(MARKED));
  const newest = saved.slice(0, LISTED);
  const rows = newest.length ? (must(await db.from("chat_messages").select(MESSAGE_COLUMNS).in("id", newest.map((s) => s.message_id)).is("deleted_at", null)) as MessageRow[]) : [];
  const messages = new Map((await shapeMessages(db, companyId, rows)).map((m) => [m.id, m]));
  return c.json({
    ids: saved.map((s) => s.message_id),
    items: newest.flatMap((s) => {
      const message = messages.get(s.message_id);
      return message ? [{ saved_at: s.created_at, message }] : [];
    }),
  });
});

chatSaved.put("/chat/messages/:id/saved", requireUser, requireCompany(), async (c) => {
  const id = param(c, "id");
  const body = await readJson(c, z.object({ saved: z.boolean() }));
  const { db, companyId, userId } = c.var;
  await requireOn(c);
  if (body.saved) {
    // The database puts in the message's own channel and business (chat_saved_fill).
    const { error } = await db.from("chat_saved").upsert({ company_id: companyId, channel_id: id, message_id: id, user_id: userId }, { onConflict: "user_id,message_id", ignoreDuplicates: true });
    if (error?.code === "42501") throw new HttpError(403, "You can't save that message.");
    if (error) throw chatDbError(error);
  } else {
    const { error } = await db.from("chat_saved").delete().match({ message_id: id, user_id: userId });
    if (error) throw chatDbError(error);
  }
  toUser(companyId, userId, { type: "saved", message_id: id, saved: body.saved });
  return c.json({ saved: body.saved });
});
