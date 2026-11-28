/**
 * Team chat's direct messages: who you can message, starting a conversation (the same people always
 * get the same one), closing one, leaving a group, and the owners' and admins' switch for the whole
 * business. A conversation is a channel of kind 'direct', so its messages, reactions, reading and
 * live updates go through routes/chat.ts like any channel's; only its people can see it
 * (supabase/migrations/20261129101000_chat_direct_messages.sql).
 */
import { ADMINS, isChatColor } from "@crewtavo/core";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { requireCompany, requireUser } from "../lib/auth";
import { forgetAudiences, toCompany, toUser } from "../lib/chatHub";
import { HttpError, must, readJson, uuid } from "../lib/http";
import { chatDbError, chatSwitches, publish, requireOn } from "./chat";

export const chatDirect = new Hono<AppEnv>();

const OFF = "Direct messages are turned off for this business. An owner or admin can turn them on in Chat settings.";

/** Everyone on the team I can message, with their role's look in chat. */
chatDirect.get("/chat/direct/people", requireUser, requireCompany(), async (c) => {
  const { db, companyId } = c.var;
  await requireOn(c);
  const rows = must(await db.rpc("chat_direct_people", { p_company: companyId }));
  return c.json({
    people: rows.map((p) => ({
      id: p.user_id,
      name: p.full_name,
      avatar_color: p.avatar_color,
      avatar_url: p.avatar_url,
      role_key: p.role_key,
      role_label: p.role_name,
      color: isChatColor(p.color) ? p.color : "default",
    })),
  });
});

/** The conversation with these people: the one there already is, or a new one. */
chatDirect.post("/chat/direct", requireUser, requireCompany(), async (c) => {
  const body = await readJson(c, z.object({ people: z.array(uuid).min(1, "Pick someone to message.").max(8, "A conversation can have up to 8 people besides you.") }));
  const { db, companyId, userId } = c.var;
  await requireOn(c);
  if (!(await chatSwitches(c.env, companyId)).direct) throw new HttpError(409, OFF);
  const { data, error } = await db.rpc("chat_start_direct", { p_company: companyId, p_people: body.people });
  if (error) throw chatDbError(error);
  // My other tabs list it at once; the others hear of it with its first message.
  toUser(companyId, userId, { type: "channels" });
  return c.json({ id: data }, 201);
});

/** Out of my list until a new message comes. */
chatDirect.post("/chat/direct/:id/close", requireUser, requireCompany(), async (c) => {
  const id = uuid.parse(c.req.param("id"));
  const { db, companyId, userId } = c.var;
  await requireOn(c);
  const { error } = await db.rpc("chat_close_direct", { p_channel: id });
  if (error) throw chatDbError(error);
  toUser(companyId, userId, { type: "channels" });
  return c.json({ ok: true });
});

/** Leave a group conversation for good. The others see one fewer person in it. */
chatDirect.post("/chat/direct/:id/leave", requireUser, requireCompany(), async (c) => {
  const id = uuid.parse(c.req.param("id"));
  const { db, companyId, userId } = c.var;
  await requireOn(c);
  const { error } = await db.rpc("chat_leave_direct", { p_channel: id });
  if (error) throw chatDbError(error);
  forgetAudiences();
  publish(c, id, { type: "channels" });
  toUser(companyId, userId, { type: "channels" });
  return c.json({ ok: true });
});

/** Owners and admins: direct messages on or off for the whole business. Off hides every conversation and keeps it. */
chatDirect.post("/chat/direct-messages", requireUser, requireCompany(ADMINS), async (c) => {
  const body = await readJson(c, z.object({ on: z.boolean() }));
  const { db, companyId } = c.var;
  await requireOn(c);
  const { data, error } = await db.rpc("chat_set_direct_messages", { p_company: companyId, p_on: body.on });
  if (error) throw chatDbError(error);
  forgetAudiences();
  toCompany(companyId, { type: "channels" });
  return c.json({ on: Boolean(data) });
});
