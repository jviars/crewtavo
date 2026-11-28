/**
 * How each person hears about Team chat: per channel or conversation ("All new messages", "Mentions
 * and replies" or "Nothing"), and their quiet hours and pause, during which chat notifications stay on
 * the bell (services/delivery.ts). Each person's own, through their own database client
 * (supabase/migrations/20261129101200_chat_notification_settings.sql).
 */
import { isTimeZoneName } from "@crewtavo/core";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { requireCompany, requireUser } from "../lib/auth";
import { toUser } from "../lib/chatHub";
import { dbError, HttpError, readJson, uuid } from "../lib/http";
import { adminClient } from "../lib/supabase";
import { chatDbError, requireOn } from "./chat";

export const chatPrefs = new Hono<AppEnv>();

const QUIET_COLUMNS = "quiet_on, starts, ends, days, time_zone, paused_until";
/** Until someone sets theirs: off, 9 PM to 7 AM every day, in the business's zone. */
const DEFAULT_QUIET = { quiet_on: false, starts: "21:00", ends: "07:00", days: [0, 1, 2, 3, 4, 5, 6], time_zone: null as string | null, paused_until: null as string | null };

chatPrefs.put("/chat/channels/:id/notify", requireUser, requireCompany(), async (c) => {
  const id = uuid.parse(c.req.param("id"));
  const body = await readJson(c, z.object({ notify: z.enum(["all", "mentions", "nothing"]).nullable() }));
  const { db, companyId, userId } = c.var;
  await requireOn(c);
  // null puts it back to its default (sent as null: the function takes both arguments).
  const { error } = await db.rpc("chat_set_notify", { p_channel: id, p_notify: body.notify as string });
  if (error) throw chatDbError(error);
  // My other tabs show it at once.
  toUser(companyId, userId, { type: "read", channel_id: id });
  return c.json({ notify: body.notify });
});

/** My quiet hours and pause, with the business's zone (theirs unless I picked another). */
chatPrefs.get("/chat/quiet", requireUser, requireCompany(), async (c) => {
  const { db, companyId, userId } = c.var;
  const [mine, company] = await Promise.all([
    db.from("chat_quiet_hours").select(QUIET_COLUMNS).eq("company_id", companyId).eq("user_id", userId).maybeSingle(),
    // The company's zone, read with the server's key as chat reads the company's settings (routes/chat.ts).
    adminClient(c.env).from("companies").select("timezone").eq("id", companyId).maybeSingle(),
  ]);
  if (mine.error) throw dbError(mine.error);
  if (company.error) throw dbError(company.error);
  const row = mine.data ? { ...mine.data, starts: mine.data.starts.slice(0, 5), ends: mine.data.ends.slice(0, 5) } : DEFAULT_QUIET;
  return c.json({ quiet: row, company_time_zone: company.data?.timezone ?? "UTC" });
});

const clock = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use a time like 21:00.");

chatPrefs.put("/chat/quiet", requireUser, requireCompany(), async (c) => {
  const body = await readJson(
    c,
    z.object({
      quiet_on: z.boolean(),
      starts: clock,
      ends: clock,
      days: z.array(z.number().int().min(0).max(6)).max(7),
      time_zone: z.string().max(64).refine(isTimeZoneName, "Pick a time zone from the list.").nullable(),
    }),
  );
  const { db, companyId, userId } = c.var;
  const { data, error } = await db
    .from("chat_quiet_hours")
    .upsert({ company_id: companyId, user_id: userId, ...body, days: [...new Set(body.days)].sort() }, { onConflict: "company_id,user_id" })
    .select(QUIET_COLUMNS)
    .single();
  if (error) throw chatDbError(error);
  return c.json({ quiet: { ...data, starts: data.starts.slice(0, 5), ends: data.ends.slice(0, 5) } });
});

/** Pause chat notifications until a time (at most a week away), or resume them (null). */
chatPrefs.post("/chat/pause", requireUser, requireCompany(), async (c) => {
  const body = await readJson(c, z.object({ until: z.iso.datetime({ offset: true }).nullable() }));
  const until = body.until ? new Date(body.until) : null;
  if (until && (until.getTime() <= Date.now() || until.getTime() > Date.now() + 7 * 86_400_000)) {
    throw new HttpError(400, "Pause for up to a week.");
  }
  const { db, companyId, userId } = c.var;
  const { data, error } = await db
    .from("chat_quiet_hours")
    .upsert({ company_id: companyId, user_id: userId, paused_until: until?.toISOString() ?? null }, { onConflict: "company_id,user_id" })
    .select("paused_until")
    .single();
  if (error) throw chatDbError(error);
  return c.json({ paused_until: data.paused_until });
});
