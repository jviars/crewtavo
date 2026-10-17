/** Dashboard and scheduling: the calendar feed, moving visits, rain-day shifts, routing, find-a-time. */
import { addDays, DISPATCH, localDate, localTime, orderStops, routeLengthM, zonedTimeToUtc } from "@crewtavo/core";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { requireCompany, requireUser } from "../lib/auth";
import { dbError, HttpError, isoDate, must, param, readJson, uuid } from "../lib/http";
import { adminClient } from "../lib/supabase";
import { geocodeAddress } from "../services/external";
import { materializeJob, recurringJob } from "../tasks";

export const schedule = new Hono<AppEnv>();

async function companyZone(c: { var: AppEnv["Variables"] }): Promise<{ tz: string; settings: Record<string, any> }> {
  const company = must(await c.var.db.from("companies").select("timezone, settings").eq("id", c.var.companyId).maybeSingle());
  return { tz: company.timezone, settings: (company.settings ?? {}) as Record<string, any> };
}

const VISIT_FIELDS =
  "id, title, kind, status, scheduled_on, starts_at, ends_at, route_order, hold_reason, crew_id, notes, series_id, series_day, series_total, job:jobs(id, number, title, client:clients(id, display_name)), property:properties(id, line1, city, lat, lng), assignees:visit_assignees(user_id), equipment:visit_equipment(equipment_id)";

const isWeekend = (date: string) => [0, 6].includes(new Date(`${date}T12:00:00Z`).getUTCDay());

/** Change a visit's people or equipment to `wanted`, touching only what was added or removed. */
async function syncLinks(c: { var: AppEnv["Variables"] }, table: "visit_assignees" | "visit_equipment", column: "user_id" | "equipment_id", visitId: string, wanted: string[], notYours: string) {
  const db = c.var.db;
  const current = (must(await db.from(table).select(column).eq("visit_id", visitId)) as unknown as Array<Record<string, string>>).map((r) => r[column]!);
  const next = [...new Set(wanted)];
  const removed = current.filter((x) => !next.includes(x));
  const added = next.filter((x) => !current.includes(x));
  if (removed.length) {
    const del = await db.from(table).delete().eq("visit_id", visitId).in(column, removed).select(column);
    if (del.error) throw dbError(del.error);
    if (del.data.length < removed.length) throw new HttpError(403, notYours);
  }
  if (added.length) {
    const ins = await db.from(table).insert(added.map((id) => ({ company_id: c.var.companyId, visit_id: visitId, [column]: id })) as never);
    if (ins.error) throw ins.error.code === "42501" ? new HttpError(403, notYours) : dbError(ins.error);
  }
}

/**
 * New visit, task or event. With days > 1 it's multi-day work: one linked visit per work day
 * (weekends skipped unless asked), each at the same local time, with the same people and equipment.
 */
schedule.post("/visits", requireUser, requireCompany(DISPATCH), async (c) => {
  const body = await readJson(
    c,
    z.object({
      title: z.string().trim().min(1).max(200),
      kind: z.enum(["job", "assessment", "task", "event"]).default("job"),
      job_id: uuid.nullable().optional(),
      request_id: uuid.nullable().optional(),
      property_id: uuid.nullable().optional(),
      crew_id: uuid.nullable().optional(),
      status: z.enum(["unscheduled", "scheduled", "en_route", "in_progress", "completed", "cancelled"]).default("scheduled"),
      notes: z.string().max(5000).nullable().optional(),
      scheduled_on: isoDate.nullable().optional(),
      starts_at: z.iso.datetime({ offset: true }).nullable().optional(),
      ends_at: z.iso.datetime({ offset: true }).nullable().optional(),
      days: z.number().int().min(1).max(30).default(1),
      skip_weekends: z.boolean().default(true),
      assignee_ids: z.array(uuid).max(20).default([]),
      equipment_ids: z.array(uuid).max(30).default([]),
    }),
  );
  if (body.starts_at && body.ends_at && Date.parse(body.ends_at) <= Date.parse(body.starts_at)) throw new HttpError(400, "The visit has to end after it starts.");
  const { tz } = await companyZone(c);
  const first = body.starts_at ? localDate(new Date(body.starts_at), tz) : body.scheduled_on ?? null;
  const days = first && body.status !== "unscheduled" ? body.days : 1;
  const dates: Array<string | null> = [];
  for (let d = first; dates.length < days; d = addDays(d!, 1)) {
    if (!d) {
      dates.push(null);
      break;
    }
    if (days > 1 && body.skip_weekends && isWeekend(d) && dates.length > 0) continue;
    dates.push(d);
  }
  const seriesId = days > 1 ? crypto.randomUUID() : null;
  const startTime = body.starts_at ? localTime(new Date(body.starts_at), tz) : null;
  const length = body.starts_at && body.ends_at ? Date.parse(body.ends_at) - Date.parse(body.starts_at) : null;
  const rows = dates.map((date, i) => {
    const start = date && startTime ? zonedTimeToUtc(date, startTime, tz) : null;
    return {
      company_id: c.var.companyId,
      title: body.title,
      kind: body.kind,
      job_id: body.job_id ?? null,
      request_id: body.request_id ?? null,
      property_id: body.property_id ?? null,
      crew_id: body.crew_id ?? null,
      status: body.status,
      notes: body.notes ?? null,
      scheduled_on: body.status === "unscheduled" ? null : date,
      starts_at: start?.toISOString() ?? null,
      ends_at: start && length ? new Date(start.getTime() + length).toISOString() : null,
      series_id: seriesId,
      series_day: seriesId ? i + 1 : null,
      series_total: seriesId ? dates.length : null,
    };
  });
  const created = await c.var.db.from("visits").insert(rows).select("id");
  if (created.error) throw created.error.code === "42501" ? new HttpError(403, "You can schedule your own crew's work. Pick your crew.") : dbError(created.error);
  const notYours = "You can put people and equipment from your own crew on its visits.";
  for (const v of created.data) {
    if (body.assignee_ids.length) await syncLinks(c, "visit_assignees", "user_id", v.id, body.assignee_ids, notYours);
    if (body.equipment_ids.length) await syncLinks(c, "visit_equipment", "equipment_id", v.id, body.equipment_ids, notYours);
  }
  return c.json({ ids: created.data.map((v) => v.id), series_id: seriesId }, 201);
});

schedule.get("/dashboard", requireUser, requireCompany(), async (c) => {
  const { data, error } = await c.var.db.rpc("dashboard", { p_company: c.var.companyId });
  if (error) throw dbError(error);
  // The function returns jsonb; spelling out its recursive Json type is too deep for Hono's typing.
  return c.json(data as Record<string, unknown>);
});

/** After a recurring job's schedule changes: create its upcoming visits now, and drop ones it no longer has. */
schedule.post("/jobs/:id/generate-visits", requireUser, requireCompany(DISPATCH, "schedule"), async (c) => {
  const id = param(c, "id");
  const owned = must(await c.var.db.from("jobs").select("id, kind, status").eq("id", id).eq("company_id", c.var.companyId).maybeSingle(), "Job not found.");
  if (owned.kind !== "recurring" || owned.status !== "active") return c.json({ created: 0, removed: 0 });
  const admin = adminClient(c.env);
  const job = await recurringJob(admin, id);
  if (!job) throw new HttpError(404, "Job not found.");
  try {
    return c.json(await materializeJob(admin, job, true));
  } catch (error) {
    throw new HttpError(400, error instanceof Error ? error.message : "Couldn't schedule the visits.");
  }
});

/** Address -> coordinates (the shop address for route planning, and similar). */
schedule.post("/geocode", requireUser, requireCompany(), async (c) => {
  const body = await readJson(c, z.object({ address: z.string().trim().min(5).max(300) }));
  const result = await geocodeAddress(body.address, c.env.GOOGLE_MAPS_SERVER_KEY);
  return c.json(result ? { found: true, ...result } : { found: false });
});

/** Find a property's map location from its address (for routing, weather and the measuring tool). */
schedule.post("/properties/:id/geocode", requireUser, requireCompany(), async (c) => {
  const id = param(c, "id");
  const property = must(
    await c.var.db.from("properties").select("id, line1, line2, city, region, postal_code, country").eq("id", id).eq("company_id", c.var.companyId).maybeSingle(),
    "Property not found.",
  );
  const address = [property.line1, property.line2, property.city, property.region, property.postal_code].filter(Boolean).join(", ");
  const result = await geocodeAddress(address, c.env.GOOGLE_MAPS_SERVER_KEY);
  if (!result) return c.json({ found: false });
  const { error } = await c.var.db.from("properties").update({ lat: result.lat, lng: result.lng }).eq("id", id);
  if (error) throw dbError(error);
  return c.json({ found: true, ...result });
});

type CalendarEventRow = {
  id: string;
  title: string;
  location: string | null;
  description: string | null;
  url: string | null;
  all_day: boolean;
  starts_at: string | null;
  ends_at: string | null;
  starts_on: string;
  ends_on: string;
  busy: boolean;
  source: { id: string; name: string; color: string | null; crew_id: string | null; blocks_time: boolean } | null;
};

/**
 * Events from other calendars (Zoho, Outlook, Google...) on these days. Row-level security shows
 * them to people who see the whole schedule; for a crew, its own calendars and the whole team's.
 */
async function calendarEvents(c: { var: AppEnv["Variables"] }, from: string, to: string, crew?: string) {
  const { data, error } = await c.var.db
    .from("calendar_events")
    .select("id, title, location, description, url, all_day, starts_at, ends_at, starts_on, ends_on, busy, source:calendar_sources(id, name, color, crew_id, blocks_time)")
    .eq("company_id", c.var.companyId)
    .lte("starts_on", to)
    .gte("ends_on", from)
    .order("starts_on")
    .limit(3000);
  if (error) throw dbError(error);
  return (data as unknown as CalendarEventRow[]).filter((e) => e.source && (!crew || !e.source.crew_id || e.source.crew_id === crew));
}

/** Visits between two dates (inclusive), plus the unscheduled queue and other calendars' events. */
schedule.get("/schedule", requireUser, requireCompany(), async (c) => {
  const from = c.req.query("from");
  const to = c.req.query("to") ?? from;
  const crew = c.req.query("crew_id");
  if (!isoDate.safeParse(from).success || !isoDate.safeParse(to).success) throw new HttpError(400, "from and to must be YYYY-MM-DD");
  if (to! < from! || addDays(from!, 62) < to!) throw new HttpError(400, "Ask for at most two months at a time.");

  let visits = c.var.db.from("visits").select(VISIT_FIELDS).eq("company_id", c.var.companyId).gte("scheduled_on", from!).lte("scheduled_on", to!);
  if (crew) visits = visits.eq("crew_id", crew);
  const [scheduled, unscheduled, crews, events] = await Promise.all([
    visits.order("scheduled_on").order("starts_at", { nullsFirst: false }).order("route_order", { nullsFirst: false }),
    c.var.db.from("visits").select(VISIT_FIELDS).eq("company_id", c.var.companyId).eq("status", "unscheduled").limit(200),
    c.var.db.from("crews").select("id, name, color").eq("company_id", c.var.companyId).eq("active", true).order("name"),
    calendarEvents(c, from!, to!, crew),
  ]);
  return c.json({ visits: must(scheduled), unscheduled: must(unscheduled), crews: must(crews), events });
});

/** The steps a crew takes a visit through, in order. */
const CREW_STEPS: Record<string, number> = { unscheduled: 0, scheduled: 0, en_route: 1, in_progress: 2, completed: 3 };

schedule.patch("/visits/:id", requireUser, requireCompany(), async (c) => {
  const id = param(c, "id");
  const body = await readJson(
    c,
    z.object({
      title: z.string().trim().min(1).max(200).optional(),
      starts_at: z.iso.datetime({ offset: true }).nullable().optional(),
      ends_at: z.iso.datetime({ offset: true }).nullable().optional(),
      scheduled_on: isoDate.nullable().optional(),
      crew_id: uuid.nullable().optional(),
      status: z.enum(["unscheduled", "scheduled", "en_route", "in_progress", "completed", "cancelled"]).optional(),
      notes: z.string().max(5000).nullable().optional(),
      assignee_ids: z.array(uuid).max(20).optional(),
      equipment_ids: z.array(uuid).max(30).optional(),
      /** For multi-day work: when this day moves, move the days after it by as much. */
      shift_series: z.boolean().optional(),
      /** A crew's tap: never moves the visit back a step (see below). */
      forward_only: z.boolean().optional(),
    }),
  );
  const { assignee_ids, equipment_ids, shift_series, forward_only, ...fields } = body;
  // A crew only moves a visit forward. A tap sent again later (the phone closed the app before it
  // heard back, say) can arrive after the taps that followed it, so it's skipped, not applied
  // backwards: a finished visit isn't reopened, and a cancelled one stays cancelled.
  if (forward_only && fields.status) {
    const now = must(await c.var.db.from("visits").select("status").eq("id", id).eq("company_id", c.var.companyId).maybeSingle(), "Visit not found.");
    if (now.status === "cancelled" || (CREW_STEPS[now.status] ?? 0) > (CREW_STEPS[fields.status] ?? 0)) {
      return c.json({ ...must(await c.var.db.from("visits").select(VISIT_FIELDS).eq("id", id).maybeSingle()), skipped: true });
    }
  }
  const reschedules = assignee_ids !== undefined || equipment_ids !== undefined || ["starts_at", "ends_at", "scheduled_on", "crew_id"].some((k) => k in fields);
  // Which visits and people: the database decides (every crew with the "schedule" area, a crew
  // lead's own crew without it). See private.schedules_crew().
  if (reschedules && !DISPATCH.includes(c.var.role)) throw new HttpError(403, "Your role can't reschedule or reassign visits.");
  if (fields.starts_at && fields.ends_at && Date.parse(fields.ends_at) <= Date.parse(fields.starts_at)) throw new HttpError(400, "The visit has to end after it starts.");
  const before = shift_series
    ? must(await c.var.db.from("visits").select("scheduled_on, series_id, series_day").eq("id", id).eq("company_id", c.var.companyId).maybeSingle(), "Visit not found.")
    : null;
  if (Object.keys(fields).length) {
    const { data, error } = await c.var.db.from("visits").update(fields).eq("id", id).eq("company_id", c.var.companyId).select("id, scheduled_on");
    if (error) throw dbError(error);
    if (!data.length) throw new HttpError(404, "Visit not found.");
    // Later days of the same multi-day job follow on the work days after it, keeping their own times
    // (and skipping weekends if the job didn't use them).
    const moved = before?.series_id && before.scheduled_on && data[0]!.scheduled_on && before.scheduled_on !== data[0]!.scheduled_on;
    if (moved && before?.series_id) {
      const { tz } = await companyZone(c);
      const all = must(await c.var.db.from("visits").select("id, series_day, scheduled_on, starts_at, ends_at, status").eq("series_id", before.series_id).order("series_day"));
      const skipWeekends = !all.some((v) => v.id !== id && v.scheduled_on && isWeekend(v.scheduled_on));
      let prev = data[0]!.scheduled_on!;
      for (const v of all.filter((x) => (x.series_day ?? 0) > (before.series_day ?? 0))) {
        let date = addDays(prev, 1);
        while (skipWeekends && isWeekend(date)) date = addDays(date, 1);
        prev = date;
        if (["completed", "cancelled"].includes(v.status) || v.scheduled_on === date) continue;
        const start = v.starts_at ? zonedTimeToUtc(date, localTime(new Date(v.starts_at), tz), tz) : null;
        const length = v.starts_at && v.ends_at ? Date.parse(v.ends_at) - Date.parse(v.starts_at) : null;
        const { error: shiftError } = await c.var.db
          .from("visits")
          .update(start ? { starts_at: start.toISOString(), ends_at: length ? new Date(start.getTime() + length).toISOString() : null } : { scheduled_on: date })
          .eq("id", v.id);
        if (shiftError) throw dbError(shiftError);
      }
    }
  }

  // Only who and what was added or removed changes, so a crew lead keeps people the office put on
  // their visit, and the people notified are the ones whose day actually changed.
  const notYours = "You can change who's on your own crew's visits, using people and equipment from your crew. Ask the office for this one.";
  if (assignee_ids) await syncLinks(c, "visit_assignees", "user_id", id, assignee_ids, notYours);
  if (equipment_ids) await syncLinks(c, "visit_equipment", "equipment_id", id, equipment_ids, notYours);
  return c.json(must(await c.var.db.from("visits").select(VISIT_FIELDS).eq("id", id).maybeSingle()));
});

/** Rain day: move every open visit from one date to another, keeping each visit's local time. */
schedule.post("/schedule/shift", requireUser, requireCompany(DISPATCH), async (c) => {
  const body = await readJson(c, z.object({ from_date: isoDate, to_date: isoDate, crew_id: uuid.optional() }));
  // Without "Schedule the whole team", a crew lead shifts their own crew (the database checks it's theirs).
  if (!c.var.permissions.includes("schedule") && !body.crew_id) throw new HttpError(400, "Pick your crew to move its visits.");
  const { tz } = await companyZone(c);
  let query = c.var.db
    .from("visits")
    .select("id, starts_at, ends_at")
    .eq("company_id", c.var.companyId)
    .eq("scheduled_on", body.from_date)
    .not("status", "in", "(completed,cancelled)");
  if (body.crew_id) query = query.eq("crew_id", body.crew_id);
  const visits = must(await query);

  const updates = visits.map((v) => {
    if (!v.starts_at) return { id: v.id, scheduled_on: body.to_date };
    const start = zonedTimeToUtc(body.to_date, localTime(new Date(v.starts_at), tz), tz);
    const duration = v.ends_at ? new Date(v.ends_at).getTime() - new Date(v.starts_at).getTime() : 60 * 60_000;
    return { id: v.id, starts_at: start.toISOString(), ends_at: new Date(start.getTime() + duration).toISOString() };
  });
  for (const { id, ...fields } of updates) {
    const { error } = await c.var.db.from("visits").update({ ...fields, hold_reason: null }).eq("id", id);
    if (error) throw dbError(error);
  }
  return c.json({ moved: updates.length });
});

/** Ordering takes about a quarter second at 100 stops and grows fast (2.6 s at 200), blocking the server. */
export const MAX_ROUTE_STOPS = 100;

/** Order a day's anytime visits for one crew (or the visits with no crew) to shorten the drive. */
schedule.post("/schedule/optimize", requireUser, requireCompany(DISPATCH), async (c) => {
  const body = await readJson(
    c,
    // No crew_id (or null) means the visits with no crew, never every crew's at once.
    z.object({ date: isoDate, crew_id: uuid.nullish(), start: z.object({ lat: z.number(), lng: z.number() }).optional() }),
  );
  if (!c.var.permissions.includes("schedule")) {
    const mine = body.crew_id ? must(await c.var.db.rpc("my_crew_ids", { p_company: c.var.companyId })) : [];
    if (!body.crew_id || !(mine as string[]).includes(body.crew_id)) throw new HttpError(403, "You can plan your own crew's route. Pick your crew.");
  }
  let query = c.var.db
    .from("visits")
    .select("id, property:properties(lat, lng)")
    .eq("company_id", c.var.companyId)
    .eq("scheduled_on", body.date)
    .is("starts_at", null)
    .not("status", "in", "(completed,cancelled)");
  query = body.crew_id ? query.eq("crew_id", body.crew_id) : query.is("crew_id", null);
  const rows = must(await query) as Array<{ id: string; property: { lat: number | null; lng: number | null } | null }>;
  const stops = rows
    .filter((r) => r.property?.lat != null && r.property?.lng != null)
    .map((r) => ({ id: r.id, lat: r.property!.lat!, lng: r.property!.lng! }));
  if (!stops.length) return c.json({ order: [], miles_before: 0, miles_after: 0, skipped: rows.length });
  if (stops.length > MAX_ROUTE_STOPS) {
    throw new HttpError(400, `That's ${stops.length} stops. Route ordering handles up to ${MAX_ROUTE_STOPS} at a time, so split them across crews or days first.`);
  }

  const { settings } = await companyZone(c);
  const start = body.start ?? settings.depot ?? stops[0];
  const ordered = orderStops(start, stops);
  for (const [index, stop] of ordered.entries()) {
    const { error } = await c.var.db.from("visits").update({ route_order: index + 1 }).eq("id", stop.id);
    if (error) throw dbError(error);
  }
  const miles = (m: number) => Math.round((m / 1609.344) * 10) / 10;
  return c.json({
    order: ordered.map((s) => s.id),
    miles_before: miles(routeLengthM(start, stops)),
    miles_after: miles(routeLengthM(start, ordered)),
    skipped: rows.length - stops.length, // visits whose property has no map location
  });
});

/** Suggest open slots in working hours (company settings.working_hours, default 7:00-18:00). */
schedule.post("/schedule/find-time", requireUser, requireCompany(), async (c) => {
  const body = await readJson(
    c,
    z.object({ date_from: isoDate, days: z.number().int().min(1).max(14).default(7), duration_min: z.number().int().min(15).max(720), crew_id: uuid.optional() }),
  );
  const { tz, settings } = await companyZone(c);
  const hours = { start: settings.working_hours?.start ?? "07:00", end: settings.working_hours?.end ?? "18:00" };
  const dateTo = addDays(body.date_from, body.days - 1);

  let query = c.var.db
    .from("visits")
    .select("starts_at, ends_at, scheduled_on")
    .eq("company_id", c.var.companyId)
    .gte("scheduled_on", body.date_from)
    .lte("scheduled_on", dateTo)
    .not("starts_at", "is", null)
    .not("status", "eq", "cancelled");
  if (body.crew_id) query = query.eq("crew_id", body.crew_id);
  const busy = must(await query).map((v) => ({ start: new Date(v.starts_at).getTime(), end: new Date(v.ends_at ?? v.starts_at).getTime() }));
  // Busy time on other calendars counts too (a crew's own calendars, and the whole team's).
  for (const e of await calendarEvents(c, body.date_from, dateTo, body.crew_id)) {
    if (!e.busy || !e.source?.blocks_time) continue;
    if (e.starts_at && e.ends_at) busy.push({ start: Date.parse(e.starts_at), end: Date.parse(e.ends_at) });
    else busy.push({ start: zonedTimeToUtc(e.starts_on, "00:00", tz).getTime(), end: zonedTimeToUtc(addDays(e.ends_on, 1), "00:00", tz).getTime() });
  }

  const slots: Array<{ starts_at: string; ends_at: string }> = [];
  const need = body.duration_min * 60_000;
  const quarter = 15 * 60_000;
  const now = Math.ceil(Date.now() / quarter) * quarter;
  for (let day = body.date_from; day <= dateTo && slots.length < 10; day = addDays(day, 1)) {
    const dayStart = Math.max(zonedTimeToUtc(day, hours.start, tz).getTime(), now);
    const dayEnd = zonedTimeToUtc(day, hours.end, tz).getTime();
    const blocks = busy.filter((b) => b.end > dayStart && b.start < dayEnd).sort((a, b) => a.start - b.start);
    let cursor = dayStart;
    for (const block of [...blocks, { start: dayEnd, end: dayEnd }]) {
      if (block.start - cursor >= need && slots.length < 10) {
        slots.push({ starts_at: new Date(cursor).toISOString(), ends_at: new Date(cursor + need).toISOString() });
      }
      cursor = Math.max(cursor, block.end);
    }
  }
  return c.json({ timezone: tz, slots });
});

/** On-demand work (snow, storm cleanup): one visit per chosen job on a date. */
schedule.post("/schedule/bulk-visits", requireUser, requireCompany(DISPATCH, "schedule"), async (c) => {
  const body = await readJson(c, z.object({ job_ids: z.array(uuid).min(1).max(500), date: isoDate, crew_id: uuid.optional() }));
  const jobs = must(
    await c.var.db.from("jobs").select("id, title, property_id, default_crew_id").eq("company_id", c.var.companyId).in("id", body.job_ids),
  );
  const { error } = await c.var.db.from("visits").insert(
    jobs.map((j) => ({
      company_id: c.var.companyId,
      job_id: j.id,
      property_id: j.property_id,
      title: j.title,
      scheduled_on: body.date,
      crew_id: body.crew_id ?? j.default_crew_id,
    })),
  );
  if (error) throw dbError(error);
  return c.json({ created: jobs.length }, 201);
});

