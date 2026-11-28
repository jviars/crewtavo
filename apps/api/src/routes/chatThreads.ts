/**
 * Team chat's threads: a message's replies (sent through POST /chat/channels/:id/messages with a
 * thread_root, in routes/chat.ts), reading a thread, following it or not, and the Threads view: the
 * threads you follow, those with new replies first. Row-level security and the functions in
 * supabase/migrations/20261129101100_chat_threads.sql decide what each person can see.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { requireCompany, requireUser } from "../lib/auth";
import { toUser } from "../lib/chatHub";
import { HttpError, must, readJson, uuid } from "../lib/http";
import { chatDbError, MESSAGE_COLUMNS, messageById, requireOn, shapeMessages, type MessageRow } from "./chat";

export const chatThreads = new Hono<AppEnv>();

/** As many replies as a thread opens with; older ones load as people scroll up. */
const PAGE = 100;

/** A thread: the message it's under, its replies oldest first, and whether I follow it. */
chatThreads.get("/chat/messages/:id/thread", requireUser, requireCompany(), async (c) => {
  const id = uuid.parse(c.req.param("id"));
  const query = z.object({ before: z.iso.datetime({ offset: true }).optional() }).parse(c.req.query());
  const { db, companyId, userId } = c.var;
  await requireOn(c);
  const root = await messageById(db, id);
  if (root.thread_root) throw new HttpError(400, "That's a reply in a thread. Open the message it replies to.");
  let q = db.from("chat_messages").select(MESSAGE_COLUMNS).eq("thread_root", id).order("created_at", { ascending: false }).limit(PAGE + 1);
  if (query.before) q = q.lt("created_at", query.before);
  const [page, follow] = await Promise.all([
    q,
    db.from("chat_thread_follows").select("following").eq("root_id", id).eq("user_id", userId).maybeSingle(),
  ]);
  const rows = must(page) as MessageRow[];
  if (follow.error) throw chatDbError(follow.error);
  const replies = rows.slice(0, PAGE).reverse();
  const [shapedRoot, ...shaped] = await shapeMessages(db, companyId, [root, ...replies]);
  return c.json({ root: shapedRoot, replies: shaped, has_more: rows.length > PAGE, following: follow.data?.following ?? root.author_id === userId });
});

/** I've read this thread up to now (and its notifications). */
chatThreads.post("/chat/messages/:id/thread/read", requireUser, requireCompany(), async (c) => {
  const id = uuid.parse(c.req.param("id"));
  const { db, companyId, userId } = c.var;
  const { error } = await db.rpc("chat_thread_read", { p_root: id });
  if (error) throw chatDbError(error);
  // My other tabs update their counts.
  toUser(companyId, userId, { type: "read", channel_id: id });
  return c.json({ ok: true });
});

/** Follow a thread, or stop: no more notifications of its replies, and out of Threads. */
chatThreads.post("/chat/messages/:id/follow", requireUser, requireCompany(), async (c) => {
  const id = uuid.parse(c.req.param("id"));
  const body = await readJson(c, z.object({ following: z.boolean() }));
  const { db, companyId, userId } = c.var;
  await requireOn(c);
  const { data, error } = await db.rpc("chat_follow", { p_root: id, p_following: body.following });
  if (error) throw chatDbError(error);
  toUser(companyId, userId, { type: "read", channel_id: id });
  return c.json({ following: Boolean(data) });
});

/** The Threads view: the threads I follow, with new replies first, each with its root message. */
chatThreads.get("/chat/threads", requireUser, requireCompany(), async (c) => {
  const { db, companyId } = c.var;
  await requireOn(c);
  const threads = must(await db.rpc("chat_threads", { p_company: companyId })).slice(0, 100);
  const ids = threads.map((t) => t.root_id);
  const roots = ids.length ? (must(await db.from("chat_messages").select(MESSAGE_COLUMNS).in("id", ids)) as MessageRow[]) : [];
  const shaped = new Map((await shapeMessages(db, companyId, roots)).map((m) => [m.id, m]));
  return c.json({
    threads: threads.flatMap((t) => {
      const root = shaped.get(t.root_id);
      return root ? [{ root, channel_id: t.channel_id, replies: t.replies, last_reply_at: t.last_reply_at, unread: t.unread, mentions: t.mentions }] : [];
    }),
  });
});
