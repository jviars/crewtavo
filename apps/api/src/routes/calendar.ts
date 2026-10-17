/**
 * Calendar feeds: each person can get a private link that Google, Apple or Outlook Calendar
 * subscribes to, showing their visits (or, for people who dispatch, the whole schedule).
 *
 *   GET    /api/calendar-feed          whether you have a link, and the link
 *   POST   /api/calendar-feed          make a new link (the old one stops working)
 *   DELETE /api/calendar-feed          turn the link off
 *   GET    /api/calendar/<token>.ics   the feed itself (no sign-in; the token is the key)
 */
import { DISPATCH } from "@crewtavo/core";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { requireCompany, requireUser } from "../lib/auth";
import { decryptJson, encryptJson, randomId } from "../lib/crypto";
import { appUrl, dbError, HttpError, readJson } from "../lib/http";
import { buildCalendar, type IcsEvent } from "../lib/ics";
import { adminClient } from "../lib/supabase";

export const calendar = new Hono<AppEnv>();

async function sha256(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
const feedUrl = (base: string, token: string) => `${base}/api/calendar/${token}.ics`;
const canSeeAll = (role: string) => (DISPATCH as readonly string[]).includes(role);

calendar.get("/calendar-feed", requireUser, requireCompany(), async (c) => {
  const admin = adminClient(c.env);
  const { data, error } = await admin.from("calendar_feeds").select("scope, token_sealed, created_at, last_used_at").eq("company_id", c.var.companyId).eq("user_id", c.var.userId).maybeSingle();
  if (error) throw dbError(error);
  if (!data) return c.json({ feed: null, can_see_all: canSeeAll(c.var.role) });
  const { token } = await decryptJson<{ token: string }>(c.env, data.token_sealed);
  return c.json({ feed: { url: feedUrl(appUrl(c), token), scope: data.scope, created_at: data.created_at, last_used_at: data.last_used_at }, can_see_all: canSeeAll(c.var.role) });
});

calendar.post("/calendar-feed", requireUser, requireCompany(), async (c) => {
  const { scope } = await readJson(c, z.object({ scope: z.enum(["mine", "all"]).default("mine") }));
  if (scope === "all" && !canSeeAll(c.var.role)) throw new HttpError(403, "Your role shows your own visits only.");
  const token = randomId(32);
  const row = {
    company_id: c.var.companyId,
    user_id: c.var.userId,
    scope,
    token_hash: await sha256(token),
    token_sealed: await encryptJson(c.env, { token }),
    created_at: new Date().toISOString(),
    last_used_at: null,
  };
  const { error } = await adminClient(c.env).from("calendar_feeds").upsert(row, { onConflict: "company_id,user_id" });
  if (error) throw dbError(error);
  return c.json({ feed: { url: feedUrl(appUrl(c), token), scope, created_at: row.created_at, last_used_at: null } }, 201);
});

calendar.delete("/calendar-feed", requireUser, requireCompany(), async (c) => {
  const { error } = await adminClient(c.env).from("calendar_feeds").delete().eq("company_id", c.var.companyId).eq("user_id", c.var.userId);
  if (error) throw dbError(error);
  return c.json({ ok: true });
});

calendar.get("/calendar/:file", async (c) => {
  const token = (c.req.param("file") ?? "").replace(/\.ics$/i, "");
  if (!/^[A-Za-z0-9_-]{40,60}$/.test(token)) throw new HttpError(404, "Calendar not found.");
  const admin = adminClient(c.env);
  const feed = (await admin.from("calendar_feeds").select("id, company_id, user_id, scope, last_used_at").eq("token_hash", await sha256(token)).maybeSingle()).data;
  if (!feed) throw new HttpError(404, "Calendar not found.");
  // The person must still be on the team; their current role decides what they may see.
  const member = (await admin.from("memberships").select("role").eq("company_id", feed.company_id).eq("user_id", feed.user_id).eq("active", true).maybeSingle()).data;
  if (!member) throw new HttpError(404, "Calendar not found.");
  const everything = feed.scope === "all" && canSeeAll(member.role);

  const company = (await admin.from("companies").select("name, timezone").eq("id", feed.company_id).single()).data!;
  const today = new Date().toLocaleDateString("en-CA", { timeZone: company.timezone });
  const shift = (days: number) => new Date(Date.parse(`${today}T12:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

  let query = admin
    .from("visits")
    .select("id, title, status, scheduled_on, starts_at, ends_at, notes, updated_at, crew:crews(name), job:jobs(number, client:clients(display_name)), property:properties(line1, city, region)")
    .eq("company_id", feed.company_id)
    .gte("scheduled_on", shift(-30))
    .lte("scheduled_on", shift(180))
    .neq("status", "unscheduled")
    .order("scheduled_on")
    .limit(2000);
  if (!everything) {
    // Field crew see only the visits they're on (as in the app); crew leads also get their crews' visits.
    const [assigned, crews] = await Promise.all([
      admin.from("visit_assignees").select("visit_id").eq("company_id", feed.company_id).eq("user_id", feed.user_id).limit(5000),
      canSeeAll(member.role) ? admin.from("crew_members").select("crew_id").eq("company_id", feed.company_id).eq("user_id", feed.user_id) : Promise.resolve({ data: [] as Array<{ crew_id: string }> }),
    ]);
    const ids = (assigned.data ?? []).map((r) => r.visit_id);
    const crewIds = (crews.data ?? []).map((r) => r.crew_id);
    const parts = [ids.length ? `id.in.(${ids.join(",")})` : null, crewIds.length ? `crew_id.in.(${crewIds.join(",")})` : null].filter(Boolean);
    if (!parts.length) return ics(c, `${company.name}: my visits`, []);
    query = query.or(parts.join(","));
  }
  const { data: visits, error } = await query;
  if (error) throw dbError(error);

  const base = appUrl(c);
  const events: IcsEvent[] = (visits ?? []).map((v) => {
    const job = v.job as unknown as { number: number; client: { display_name: string } | null } | null;
    const place = v.property as unknown as { line1: string; city: string | null; region: string | null } | null;
    const crew = v.crew as unknown as { name: string } | null;
    const details = [
      job?.client?.display_name,
      job ? `Job #${job.number}` : null,
      crew ? `Crew: ${crew.name}` : null,
      v.notes,
      `Open in Crewtavo: ${everything ? `${base}/schedule?view=day&date=${v.scheduled_on}` : `${base}/field/visits/${v.id}`}`,
    ].filter(Boolean);
    return {
      uid: `${v.id}@crewtavo`,
      title: v.status === "completed" ? `✓ ${v.title}` : v.title,
      ...(v.starts_at && v.ends_at ? { start: new Date(v.starts_at), end: new Date(v.ends_at) } : { date: v.scheduled_on! }),
      location: place ? [place.line1, place.city, place.region].filter(Boolean).join(", ") : null,
      description: details.join("\n"),
      cancelled: v.status === "cancelled",
      updated: v.updated_at ? new Date(v.updated_at) : undefined,
    };
  });

  if (!feed.last_used_at || Date.now() - Date.parse(feed.last_used_at) > 3_600_000) {
    await admin.from("calendar_feeds").update({ last_used_at: new Date().toISOString() }).eq("id", feed.id);
  }
  return ics(c, everything ? `${company.name} schedule` : `${company.name}: my visits`, events);
});

function ics(c: Parameters<typeof appUrl>[0], name: string, events: IcsEvent[]) {
  return c.body(buildCalendar(name, events), 200, {
    "Content-Type": "text/calendar; charset=utf-8",
    "Content-Disposition": 'inline; filename="crewtavo.ics"',
    "Cache-Control": "private, max-age=300",
  });
}
