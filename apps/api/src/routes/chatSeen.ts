/**
 * "Seen by" (supabase/migrations/20261129101300_chat_seen.sql). In an announcement channel, how many
 * of the channel's people have read each message, and who, for its author and the channel's managers;
 * in a direct conversation, how far each of the others has read, for its people. The database answers
 * only those allowed to ask; everyone else gets nothing back. Kept current by lib/chatSeen.ts.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { requireCompany, requireUser } from "../lib/auth";
import { must, uuid } from "../lib/http";
import { loadPeople, requireOn } from "./chat";

export const chatSeen = new Hono<AppEnv>();

/** For the messages on screen: counts in an announcement channel, read marks in a conversation. */
chatSeen.get("/chat/channels/:id/seen", requireUser, requireCompany(), async (c) => {
  const id = uuid.parse(c.req.param("id"));
  const query = z.object({ messages: z.string().max(4_000).default("") }).parse(c.req.query());
  const ids = [...new Set(query.messages.split(",").filter(Boolean))].slice(0, 100).map((m) => uuid.parse(m));
  const { db } = c.var;
  await requireOn(c);
  const [counts, marks] = await Promise.all([
    ids.length ? db.rpc("chat_seen_counts", { p_channel: id, p_messages: ids }) : Promise.resolve({ data: [], error: null }),
    db.rpc("chat_read_marks", { p_channel: id }),
  ]);
  return c.json({ counts: must(counts), marks: must(marks) });
});

/** Who has seen one announcement, and who hasn't yet. */
chatSeen.get("/chat/messages/:id/seen", requireUser, requireCompany(), async (c) => {
  const id = uuid.parse(c.req.param("id"));
  const { db, companyId } = c.var;
  await requireOn(c);
  const rows = must(await db.rpc("chat_seen_list", { p_message: id }));
  const people = await loadPeople(db, companyId, rows.map((r) => r.user_id));
  const list = rows.flatMap((r) => {
    const person = people.get(r.user_id);
    return person ? [{ person, seen_at: r.seen_at }] : [];
  });
  // The latest to see it first; those who haven't yet by name.
  const seen = list.filter((x) => x.seen_at).sort((a, b) => b.seen_at!.localeCompare(a.seen_at!));
  const notYet = list.filter((x) => !x.seen_at).sort((a, b) => a.person.name.localeCompare(b.person.name));
  return c.json({ seen, not_yet: notYet });
});
