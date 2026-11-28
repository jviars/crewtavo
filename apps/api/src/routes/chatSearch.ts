/**
 * Searching team chat (GET /chat/search), and the people a search can be narrowed to (GET
 * /chat/people). The database finds the matches as the person searching (public.chat_search,
 * supabase/migrations/20261129102000_chat_search.sql), so they only ever find messages they can
 * already read, and deleted ones never.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { requireCompany, requireUser } from "../lib/auth";
import { must, readQuery, uuid } from "../lib/http";
import { chatDbError, loadPeople, MESSAGE_COLUMNS, requireOn, shapeMessages, type MessageRow } from "./chat";

export const chatSearch = new Hono<AppEnv>();

const PAGE = 30;
const HAS = ["photo", "file", "job", "link"] as const;

chatSearch.get("/chat/search", requireUser, requireCompany(), async (c) => {
  const query = readQuery(
    c,
    z.object({
      q: z.string().max(200, "Search for fewer words.").default(""),
      channel: uuid.optional(),
      from: uuid.optional(),
      // "photo,link": a message has to have each.
      has: z
        .string()
        .max(100)
        .optional()
        .transform((v) => (v ?? "").split(",").filter((x): x is (typeof HAS)[number] => (HAS as readonly string[]).includes(x))),
      after: z.iso.datetime({ offset: true }).optional(),
      before: z.iso.datetime({ offset: true }).optional(),
      order: z.enum(["newest", "best"]).default("newest"),
      offset: z.coerce.number().int().min(0).max(2_000).default(0),
    }),
  );
  const { db, companyId } = c.var;
  await requireOn(c);
  const { data, error } = await db.rpc("chat_search", {
    p_company: companyId,
    p_query: query.q,
    p_channel: query.channel,
    p_author: query.from,
    p_has: query.has,
    p_after: query.after,
    p_before: query.before,
    p_order: query.order,
    p_limit: PAGE + 1,
    p_offset: query.offset,
  });
  if (error) throw chatDbError(error);
  const hits = (data ?? []).slice(0, PAGE);
  const rows = hits.length ? (must(await db.from("chat_messages").select(MESSAGE_COLUMNS).in("id", hits.map((h) => h.id))) as MessageRow[]) : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ordered = hits.map((h) => byId.get(h.id)).filter((r): r is MessageRow => Boolean(r));
  return c.json({ messages: await shapeMessages(db, companyId, ordered), has_more: (data ?? []).length > PAGE, next: query.offset + hits.length });
});

/** Everyone on the team who can write in chat (not subcontractors), as chat shows them, by name. */
chatSearch.get("/chat/people", requireUser, requireCompany(), async (c) => {
  const { db, companyId } = c.var;
  await requireOn(c);
  const members = must(await db.from("memberships").select("user_id").eq("company_id", companyId).eq("active", true).neq("role", "subcontractor"));
  const people = await loadPeople(db, companyId, members.map((m) => m.user_id));
  return c.json({ people: [...people.values()].sort((a, b) => a.name.localeCompare(b.name)) });
});
