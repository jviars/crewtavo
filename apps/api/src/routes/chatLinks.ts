/**
 * Link previews in team chat (GET /chat/preview?message=&url=): the title, description, site and
 * small picture of a public web page linked in a message, for its card under the message. The link
 * has to be in a message the person can read (their own database client, so row-level security
 * decides), and the page is read by lib/linkPreview.ts from the public internet only.
 *
 * Previews are kept for each business in chat_link_previews (a week; a day for a page with nothing
 * to show), which only the server reads and writes. Asking for pages not kept yet is limited for
 * each person. Links to this Crewtavo's own records get their cards in the browser instead, read
 * with the viewer's own access (features/chat/LinkCards.tsx).
 */
import { messageLinks } from "@crewtavo/core/chatContent";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { requireCompany, requireUser } from "../lib/auth";
import { runInBackground } from "../lib/background";
import { appUrl, dbError, HttpError, uuid } from "../lib/http";
import { allow } from "../lib/limit";
import { fetchPreview, previewable, type LinkPreview } from "../lib/linkPreview";
import { adminClient } from "../lib/supabase";
import { messageById, requireOn } from "./chat";

export const chatLinks = new Hono<AppEnv>();

const KEPT_MS = 7 * 86_400_000;
const NOTHING_KEPT_MS = 86_400_000;
/** Pages not kept yet, for one person: this many in this many seconds. */
const ASKS = 30;
const ASK_WINDOW_S = 5 * 60;

chatLinks.get("/chat/preview", requireUser, requireCompany(), async (c) => {
  const query = z.object({ url: z.string().min(1).max(2048), message: uuid }).parse(c.req.query());
  const { db, companyId, userId } = c.var;
  await requireOn(c);
  const message = await messageById(db, query.message);
  if (message.deleted_at || !messageLinks(message.body).includes(query.url)) throw new HttpError(404, "That link isn't in this message.");
  const url = previewable(query.url);
  // Crewtavo's own pages aren't read from outside: records get cards of their own.
  if (!url || url.origin === new URL(appUrl(c)).origin) return c.json({ preview: null });

  const admin = adminClient(c.env);
  const key = url.toString();
  const kept = await admin.from("chat_link_previews").select("ok, final_url, title, description, site_name, image, fetched_at").eq("company_id", companyId).eq("url", key).maybeSingle();
  if (kept.error) throw dbError(kept.error);
  const age = kept.data ? Date.now() - Date.parse(kept.data.fetched_at) : Infinity;
  if (kept.data && age < (kept.data.ok ? KEPT_MS : NOTHING_KEPT_MS)) {
    const row = kept.data;
    const preview: LinkPreview | null = row.ok ? { url: row.final_url ?? key, title: row.title, description: row.description, site_name: row.site_name, image: row.image } : null;
    return c.json({ preview }, 200, { "Cache-Control": "private, max-age=3600" });
  }

  if (!(await allow(c.env, `chat-preview:${userId}`, ASKS, ASK_WINDOW_S))) {
    throw new HttpError(429, "That's a lot of link previews at once. They'll show in a few minutes.");
  }
  const preview = await fetchPreview(url);
  const saved = await admin.from("chat_link_previews").upsert({
    company_id: companyId,
    url: key,
    ok: Boolean(preview),
    final_url: preview?.url.slice(0, 2048) ?? null,
    title: preview?.title ?? null,
    description: preview?.description ?? null,
    site_name: preview?.site_name ?? null,
    image: preview?.image && preview.image.length <= 200_000 ? preview.image : null,
    fetched_at: new Date().toISOString(),
  });
  if (saved.error) throw dbError(saved.error);
  // Those past their week go as new ones come.
  runInBackground(
    c,
    (async () => {
      const { error } = await admin.from("chat_link_previews").delete().eq("company_id", companyId).lt("fetched_at", new Date(Date.now() - KEPT_MS).toISOString());
      if (error) throw new Error(error.message);
    })(),
  );
  return c.json({ preview }, 200, { "Cache-Control": "private, max-age=3600" });
});
