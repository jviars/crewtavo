/**
 * Calendars in and out.
 *
 * Out: each person can get a private link that Google, Apple or Outlook Calendar subscribes to,
 * showing their visits (or, for people who dispatch, the whole schedule).
 *
 *   GET    /api/calendar-feed          whether you have a link, and the link
 *   POST   /api/calendar-feed          make a new link (the old one stops working)
 *   DELETE /api/calendar-feed          turn the link off
 *   GET    /api/calendar/<token>.ics   the feed itself (no sign-in; the token is the key)
 *
 * In: other calendars shown on the schedule (owners and admins, from the Apps page). See
 * integrations/calendars.ts for how they're read.
 *
 *   GET    /api/calendars                 the company's calendars, and Google Calendar's state
 *   POST   /api/calendars                 add a calendar by its ICS link
 *   PATCH  /api/calendars/:id             rename, recolor, assign to a crew, details on/off...
 *   POST   /api/calendars/:id/refresh     read it again now
 *   DELETE /api/calendars/:id             stop showing it
 *   GET    /api/calendars/google          calendars in the connected Google account
 *   POST   /api/calendars/google          show one of them on the schedule
 *   PUT    /api/calendars/google/visits   put visits on Google Calendar, or stop
 */
import { ADMINS, DISPATCH, looksLikeIcs, parseIcs } from "@crewtavo/core";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { requireCompany, requireUser } from "../lib/auth";
import { runInBackground } from "../lib/background";
import { decryptJson, encryptJson, randomId } from "../lib/crypto";
import { appUrl, asJson, dbError, HttpError, must, param, readJson, uuid } from "../lib/http";
import { buildCalendar, type IcsEvent } from "../lib/ics";
import { adminClient } from "../lib/supabase";
import {
  CalendarError,
  clip,
  createVisitsCalendar,
  deleteVisitsCalendar,
  fetchIcs,
  hideDetails,
  listGoogleCalendars,
  normalizeLink,
  pushUpcomingVisits,
  SOURCE_FIELDS,
  syncSource,
} from "../integrations/calendars";
import { CALENDAR_APPS, catalogEntry } from "../integrations/registry";
import { IntegrationError } from "../integrations/tokens";

export const calendar = new Hono<AppEnv>();

async function sha256(text: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
const feedUrl = (base: string, token: string) => `${base}/api/calendar/${token}.ics`;
const canSeeAll = (role: string) => (DISPATCH as readonly string[]).includes(role);

const VISIT_FIELDS =
  "id, title, status, scheduled_on, starts_at, ends_at, notes, updated_at, crew:crews(name), job:jobs(number, client:clients(display_name)), property:properties(line1, city, region)";
interface VisitRow {
  id: string;
  title: string;
  status: string;
  scheduled_on: string | null;
  starts_at: string | null;
  ends_at: string | null;
  notes: string | null;
  updated_at: string | null;
  crew: unknown;
  job: unknown;
  property: unknown;
}
const PAGE = 1000; // PostgREST's row limit per request
const MAX_EVENTS = 2000;

/** Every row up to MAX_EVENTS, a page at a time (each query must have a fixed order). */
async function pages<T>(page: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>): Promise<T[]> {
  const rows: T[] = [];
  while (rows.length < MAX_EVENTS) {
    const { data, error } = await page(rows.length, rows.length + PAGE - 1);
    if (error) throw dbError(error);
    const got = (data ?? []) as T[];
    rows.push(...got);
    if (got.length < PAGE) break;
  }
  return rows.slice(0, MAX_EVENTS);
}

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

  const from = shift(-30);
  const to = shift(180);
  const visitsIn = () =>
    admin.from("visits").select(VISIT_FIELDS).eq("company_id", feed.company_id).gte("scheduled_on", from).lte("scheduled_on", to).neq("status", "unscheduled");

  let visits: VisitRow[];
  if (everything) {
    visits = await pages<VisitRow>((a, b) => visitsIn().order("scheduled_on").order("id").range(a, b));
  } else {
    // Field crew see only the visits they're on (as in the app); crew leads also get their crews' visits.
    // Their visits come through the assignments, filtered to the feed's dates, rather than as a
    // list of ids in the URL (a long-serving crew member's list outgrows the header size limit).
    const crews = canSeeAll(member.role) ? (await admin.from("crew_members").select("crew_id").eq("company_id", feed.company_id).eq("user_id", feed.user_id)).data : null;
    const crewIds = (crews ?? []).map((r) => r.crew_id);
    const [assigned, crewVisits] = await Promise.all([
      pages<{ visit: VisitRow }>((a, b) =>
        admin
          .from("visit_assignees")
          .select(`visit:visits!inner(${VISIT_FIELDS})`)
          .eq("company_id", feed.company_id)
          .eq("user_id", feed.user_id)
          .gte("visit.scheduled_on", from)
          .lte("visit.scheduled_on", to)
          .neq("visit.status", "unscheduled")
          .order("visit_id")
          .range(a, b),
      ),
      crewIds.length ? pages<VisitRow>((a, b) => visitsIn().in("crew_id", crewIds).order("scheduled_on").order("id").range(a, b)) : Promise.resolve([]),
    ]);
    const byId = new Map([...assigned.map((r) => r.visit), ...crewVisits].map((v) => [v.id, v]));
    visits = [...byId.values()].sort((x, y) => (x.scheduled_on ?? "").localeCompare(y.scheduled_on ?? "") || x.id.localeCompare(y.id));
  }

  const base = appUrl(c);
  const events: IcsEvent[] = visits.map((v) => {
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

// ---------------------------------------------------------------------------------------------
// Other calendars on the schedule
// ---------------------------------------------------------------------------------------------

const manage = [requireUser, requireCompany(ADMINS, "apps")] as const;
const LINK_APPS = CALENDAR_APPS as unknown as [string, ...string[]];
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, "Pick a color.").nullable();
type Ctx = { env: AppEnv["Bindings"]; var: AppEnv["Variables"] };

/** Problems reading a calendar become a 400 with words the person can act on. */
async function readable<T>(work: () => T | Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof CalendarError || error instanceof IntegrationError) throw new HttpError(400, error.message);
    throw error;
  }
}

async function googleState(c: Ctx) {
  const { data } = await adminClient(c.env)
    .from("integrations")
    .select("status, account_label, settings, last_sync_at, last_error")
    .eq("company_id", c.var.companyId)
    .eq("provider", "google_calendar")
    .maybeSingle();
  const settings = (data?.settings ?? {}) as { push_calendar_id?: string; push_calendar_name?: string };
  return {
    connected: data?.status === "connected",
    status: data?.status ?? "disconnected",
    account_label: data?.account_label ?? null,
    last_sync_at: data?.last_sync_at ?? null,
    last_error: data?.last_error ?? null,
    visits_calendar: settings.push_calendar_id ? { name: settings.push_calendar_name ?? "Crewtavo visits" } : null,
    push_calendar_id: settings.push_calendar_id ?? null,
  };
}

/** What the Apps page sees: never the visits calendar's ID. */
const publicGoogle = ({ push_calendar_id: _, ...rest }: Awaited<ReturnType<typeof googleState>>) => rest;

calendar.get("/calendars", ...manage, async (c) => {
  const sources = must(await adminClient(c.env).from("calendar_sources").select(SOURCE_FIELDS).eq("company_id", c.var.companyId).order("created_at"));
  return c.json({ calendars: sources, google: publicGoogle(await googleState(c)) });
});

calendar.post("/calendars", ...manage, async (c) => {
  const body = await readJson(
    c,
    z.object({
      url: z.string().trim().min(8).max(2000),
      app: z.enum(LINK_APPS).default("ics_calendar"),
      name: z.string().trim().max(80).optional(),
      color: color.optional(),
      crew_id: uuid.nullable().optional(),
      show_details: z.boolean().default(true),
      blocks_time: z.boolean().default(true),
    }),
  );
  const admin = adminClient(c.env);
  const url = await readable(() => normalizeLink(body.url));
  // Read it once now, so a wrong link is caught here rather than in 15 minutes.
  const text = await readable(() => fetchIcs(url));
  const own = looksLikeIcs(text) ? parseIcs(text, { from: new Date(), to: new Date(), zone: "UTC", limit: 1 }).name : null;
  // A name when neither the person nor the calendar gave one: "Zoho calendar", "Outlook calendar"...
  const entry = catalogEntry(body.app);
  const fallback = body.app === "ics_calendar" || !entry ? "Calendar" : `${entry.name.replace(/ Calendar$/, "")} calendar`;
  const { data: source, error } = await admin
    .from("calendar_sources")
    .insert({
      company_id: c.var.companyId,
      kind: "ics",
      app: body.app,
      name: clip(body.name || own || fallback, 80),
      color: body.color ?? null,
      crew_id: body.crew_id ?? null,
      show_details: body.show_details,
      blocks_time: body.blocks_time,
      url_sealed: await encryptJson(c.env, { url: url.toString() }),
      host: url.hostname,
      created_by: c.var.userId,
    })
    .select("id")
    .single();
  if (error) throw dbError(error);
  await syncSource(c.env, admin, source.id).catch(() => null); // a problem shows on the calendar
  return c.json(must(await admin.from("calendar_sources").select(SOURCE_FIELDS).eq("id", source.id).single()), 201);
});

calendar.patch("/calendars/:id", ...manage, async (c) => {
  const id = param(c, "id");
  const body = await readJson(
    c,
    z.object({
      name: z.string().trim().min(1).max(80).optional(),
      color: color.optional(),
      crew_id: uuid.nullable().optional(),
      show_details: z.boolean().optional(),
      blocks_time: z.boolean().optional(),
      enabled: z.boolean().optional(),
    }),
  );
  const admin = adminClient(c.env);
  const before = must(await admin.from("calendar_sources").select("id, show_details, enabled").eq("id", id).eq("company_id", c.var.companyId).maybeSingle(), "Calendar not found.");
  const { error } = await admin.from("calendar_sources").update(body.enabled === false ? { ...body, event_count: 0 } : body).eq("id", id);
  if (error) throw dbError(error);
  if (body.enabled === false) {
    await admin.from("calendar_events").delete().eq("source_id", id);
  } else {
    // Off: the names, places and notes kept so far go now, whether or not the calendar can be read again.
    if (body.show_details === false) await hideDetails(admin, id);
    if ((body.enabled && !before.enabled) || (body.show_details !== undefined && body.show_details !== before.show_details)) {
      // Names are only kept while details are on, so turning them on (or the calendar back on) reads it again.
      await syncSource(c.env, admin, id).catch(() => null);
    }
  }
  return c.json(must(await admin.from("calendar_sources").select(SOURCE_FIELDS).eq("id", id).single()));
});

calendar.post("/calendars/:id/refresh", ...manage, async (c) => {
  const id = param(c, "id");
  const admin = adminClient(c.env);
  must(await admin.from("calendar_sources").select("id").eq("id", id).eq("company_id", c.var.companyId).maybeSingle(), "Calendar not found.");
  await readable(() => syncSource(c.env, admin, id));
  return c.json(must(await admin.from("calendar_sources").select(SOURCE_FIELDS).eq("id", id).single()));
});

calendar.delete("/calendars/:id", ...manage, async (c) => {
  const id = param(c, "id");
  const { data, error } = await adminClient(c.env).from("calendar_sources").delete().eq("id", id).eq("company_id", c.var.companyId).select("id");
  if (error) throw dbError(error);
  if (!data.length) throw new HttpError(404, "Calendar not found.");
  return c.json({ ok: true });
});

// ---- Google Calendar ---------------------------------------------------------------------------

async function requireGoogle(c: Ctx) {
  const state = await googleState(c);
  if (!state.connected) throw new HttpError(400, state.status === "error" ? "Google Calendar needs to be reconnected first." : "Connect Google Calendar first.");
  return state;
}

calendar.get("/calendars/google", ...manage, async (c) => {
  const state = await requireGoogle(c);
  const admin = adminClient(c.env);
  const [calendars, added] = await Promise.all([
    readable(() => listGoogleCalendars(c.env, admin, c.var.companyId, state.push_calendar_id)),
    admin.from("calendar_sources").select("id, external_id").eq("company_id", c.var.companyId).eq("kind", "google"),
  ]);
  const shown = new Map((added.data ?? []).map((s) => [s.external_id, s.id]));
  return c.json({ calendars: calendars.map((cal) => ({ ...cal, source_id: shown.get(cal.id) ?? null })) });
});

calendar.post("/calendars/google", ...manage, async (c) => {
  const body = await readJson(c, z.object({ calendar_id: z.string().min(1).max(300), crew_id: uuid.nullable().optional(), show_details: z.boolean().default(true) }));
  const state = await requireGoogle(c);
  const admin = adminClient(c.env);
  const found = (await readable(() => listGoogleCalendars(c.env, admin, c.var.companyId, state.push_calendar_id))).find((cal) => cal.id === body.calendar_id);
  if (!found) throw new HttpError(404, "That calendar isn't in the connected Google account anymore.");
  const { data: source, error } = await admin
    .from("calendar_sources")
    .insert({
      company_id: c.var.companyId,
      kind: "google",
      app: "google_calendar",
      name: found.name,
      color: found.color,
      crew_id: body.crew_id ?? null,
      show_details: body.show_details,
      external_id: found.id,
      created_by: c.var.userId,
    })
    .select("id")
    .single();
  if (error) throw error.code === "23505" ? new HttpError(409, "That calendar is already on the schedule.") : dbError(error);
  await syncSource(c.env, admin, source.id).catch(() => null);
  return c.json(must(await admin.from("calendar_sources").select(SOURCE_FIELDS).eq("id", source.id).single()), 201);
});

/** Visits onto Google Calendar (a calendar Crewtavo makes and keeps), or off again. */
calendar.put("/calendars/google/visits", ...manage, async (c) => {
  const { enabled } = await readJson(c, z.object({ enabled: z.boolean() }));
  const state = await requireGoogle(c);
  const admin = adminClient(c.env);
  const { data: row } = await admin.from("integrations").select("settings").eq("company_id", c.var.companyId).eq("provider", "google_calendar").single();
  const settings = { ...((row?.settings ?? {}) as Record<string, unknown>) };
  if (enabled && !state.push_calendar_id) {
    const created = await readable(() => createVisitsCalendar(c.env, admin, c.var.companyId));
    settings.push_calendar_id = created.id;
    settings.push_calendar_name = created.name;
    const { error } = await admin.from("integrations").update({ settings: asJson(settings) }).eq("company_id", c.var.companyId).eq("provider", "google_calendar");
    if (error) throw dbError(error);
    // Upcoming visits go across now; later changes follow through the outbox within a few minutes.
    runInBackground(c, pushUpcomingVisits(c.env, admin, c.var.companyId));
  } else if (!enabled && state.push_calendar_id) {
    await readable(() => deleteVisitsCalendar(c.env, admin, c.var.companyId, state.push_calendar_id!));
    delete settings.push_calendar_id;
    delete settings.push_calendar_name;
    const { error } = await admin.from("integrations").update({ settings: asJson(settings) }).eq("company_id", c.var.companyId).eq("provider", "google_calendar");
    if (error) throw dbError(error);
    await admin.from("outbox").update({ done_at: new Date().toISOString() }).match({ company_id: c.var.companyId, topic: "calendar.visit" }).is("done_at", null);
  }
  return c.json({ google: publicGoogle(await googleState(c)) });
});
