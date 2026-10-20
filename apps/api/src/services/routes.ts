/**
 * A crew's route for a day: which of its visits are stops, where the day starts, and the plan
 * (packages/core/src/routing.ts) turned into each visit's stop number and times. Used by Organize
 * route on the schedule, by anytime visits added to an organized day, and by automatic routes
 * (settings.schedule.auto_routes), which organize each crew's coming week once and never redo a
 * day someone ordered by hand.
 */
import { addDays, localDate, localTime, planRoute, scheduleSettings, zonedTimeToUtc, type LatLng, type PlannedStop, type RouteStop } from "@crewtavo/core";
import type { Env } from "../env";
import { HttpError } from "../lib/http";
import { adminClient, type Db } from "../lib/supabase";
import { geocodeAddress } from "./external";

/** Ordering takes about a quarter second at 100 stops and grows fast (2.6 s at 200), blocking the server. */
export const MAX_ROUTE_STOPS = 100;
/** How many days ahead automatic routes organize. */
const AUTO_DAYS = 7;

const DAY_FIELDS =
  "id, title, kind, status, starts_at, ends_at, route_order, time_fixed, property:properties(id, line1, line2, city, region, postal_code, country, lat, lng), job:jobs(number, visit_duration_min, client:clients(display_name))";

export interface DayVisit {
  id: string;
  title: string;
  kind: string;
  status: string;
  starts_at: string | null;
  ends_at: string | null;
  route_order: number | null;
  time_fixed: boolean;
  property: { id: string; line1: string; line2: string | null; city: string | null; region: string | null; postal_code: string | null; country: string | null; lat: number | null; lng: number | null } | null;
  job: { number: number; visit_duration_min: number; client: { display_name: string } | null } | null;
}

export interface CompanyClock {
  tz: string;
  settings: Record<string, any>;
}

const STARTED = ["en_route", "in_progress", "completed"];

/** A crew's visits on a day (crewId null: the visits with no crew), cancelled ones left out. */
export async function loadDay(db: Db, companyId: string, crewId: string | null, date: string): Promise<DayVisit[]> {
  let query = db.from("visits").select(DAY_FIELDS).eq("company_id", companyId).eq("scheduled_on", date).neq("status", "cancelled");
  query = crewId ? query.eq("crew_id", crewId) : query.is("crew_id", null);
  const { data, error } = await query.order("id");
  if (error) throw new Error(error.message);
  return data as unknown as DayVisit[];
}

/**
 * Find map locations for stops whose property has none yet (imported clients, say), a few per
 * request, so they can be routed. Updates the visits in place.
 */
export async function locateMissing(db: Db, env: Env, visits: DayVisit[], limit = 8): Promise<void> {
  const missing = [...new Map(visits.filter((v) => v.status === "scheduled" && v.property && v.property.lat == null && v.property.line1).map((v) => [v.property!.id, v.property!])).values()].slice(0, limit);
  for (const p of missing) {
    const abroad = Boolean(p.country && !/^(us|usa|united states( of america)?)$/i.test(p.country.trim()));
    const address = [p.line1, p.line2, p.city, p.region, p.postal_code, abroad ? p.country : null].filter(Boolean).join(", ");
    const hit = await geocodeAddress(address, env.GOOGLE_MAPS_SERVER_KEY, { world: abroad }).catch(() => null);
    if (!hit) continue;
    const { error } = await db.from("properties").update({ lat: hit.lat, lng: hit.lng }).eq("id", p.id);
    if (error) continue;
    for (const v of visits) if (v.property?.id === p.id) Object.assign(v.property, { lat: hit.lat, lng: hit.lng });
  }
}

const minutesOf = (iso: string, tz: string) => {
  const [h, m] = localTime(new Date(iso), tz).split(":").map(Number);
  return h! * 60 + m!;
};
const toMinutes = (hhmm: string | undefined, fallback: number) => {
  const [h, m] = (hhmm ?? "").split(":").map(Number);
  return Number.isFinite(h) ? h! * 60 + (m || 0) : fallback;
};
const hhmm = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(Math.round(minutes) % 60).padStart(2, "0")}`;
/** "3:40 pm" */
export const clockLabel = (minutes: number) => {
  const m = Math.round(minutes) % (24 * 60);
  const h = Math.floor(m / 60);
  return `${h % 12 || 12}:${String(m % 60).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
};
const lengthOf = (v: DayVisit) => (v.starts_at && v.ends_at ? Math.max(1, Math.round((Date.parse(v.ends_at) - Date.parse(v.starts_at)) / 60_000)) : (v.job?.visit_duration_min ?? 60));
const located = (v: DayVisit): LatLng | null => (v.property?.lat != null && v.property?.lng != null ? { lat: v.property.lat, lng: v.property.lng } : null);
/** The order the crew has now: stop numbers first, then times. */
const currentOrder = (a: DayVisit, b: DayVisit) =>
  a.route_order != null && b.route_order != null
    ? a.route_order - b.route_order
    : a.starts_at && b.starts_at
      ? a.starts_at.localeCompare(b.starts_at)
      : a.starts_at
        ? -1
        : b.starts_at
          ? 1
          : (a.route_order ?? 999) - (b.route_order ?? 999);

export interface PlannedVisit {
  visit: DayVisit;
  order: number;
  starts_at: string | null;
  ends_at: string | null;
  planned: PlannedStop;
}

export interface DayPlan {
  date: string;
  times: boolean;
  shop: LatLng | null;
  returnToShop: boolean;
  stops: PlannedVisit[];
  started: DayVisit[];
  milesBefore: number;
  milesAfter: number;
  /** Minutes after midnight. */
  finish: number;
  workEnd: number;
  warnings: string[];
  changes: Array<{ id: string; route_order: number; starts_at: string | null; ends_at: string | null }>;
}

/**
 * Plan a crew's day. Visits a crew has started or finished stay as they are; on today's route the
 * rest start from the last of those, after now. Without `order`, the shortest order; with it, that
 * order, with stops not in it fitted in. `keep` lists visits whose times stay put, like fixed ones.
 */
export function planDay(visits: DayVisit[], company: CompanyClock, date: string, options: { now?: Date; order?: string[]; keep?: Set<string> } = {}): DayPlan {
  const { tz, settings } = company;
  const s = scheduleSettings(settings);
  const now = options.now ?? new Date();
  const today = localDate(now, tz);
  if (date < today) throw new HttpError(400, "That day is over, so its route can't change.");
  const shop: LatLng | null = settings.depot?.lat != null ? { lat: settings.depot.lat, lng: settings.depot.lng } : null;
  const workStart = toMinutes(settings.working_hours?.start, 7 * 60);
  const workEnd = toMinutes(settings.working_hours?.end, 18 * 60);

  const started = visits.filter((v) => STARTED.includes(v.status)).sort(currentOrder);
  const open = visits.filter((v) => v.status === "scheduled");
  if (open.length > MAX_ROUTE_STOPS) {
    throw new HttpError(400, `That's ${open.length} stops. Route ordering handles up to ${MAX_ROUTE_STOPS} at a time, so split them across crews or days first.`);
  }

  // Today: from where the crew is (the last visit it started), no earlier than now.
  let dayStart = workStart;
  let from = shop;
  if (date === today) {
    const nowMin = minutesOf(now.toISOString(), tz);
    dayStart = Math.max(workStart, Math.ceil(nowMin / s.timeStep) * s.timeStep);
    const last = [...started].reverse().find((v) => located(v));
    if (last) from = located(last);
    for (const v of started) if (v.status !== "completed" && v.ends_at && localDate(new Date(v.ends_at), tz) === date) dayStart = Math.max(dayStart, minutesOf(v.ends_at, tz));
  }

  // Fixed: the customer expects the time, or it's timed with no address (a shop meeting).
  const isFixed = (v: DayVisit) => Boolean(v.starts_at) && (v.time_fixed || !v.property || Boolean(options.keep?.has(v.id)));
  const toStop = (v: DayVisit): RouteStop => ({ id: v.id, at: located(v), minutes: lengthOf(v), fixed: isFixed(v) ? minutesOf(v.starts_at!, tz) : null });
  const stops = open.map(toStop);
  const base = { from, dayStart, returnTo: s.returnToShop ? shop : null, speedMph: s.speedMph, setupMin: s.setupMin, step: s.timeStep };
  const before = planRoute({ ...base, stops, order: [...open].sort(currentOrder).map((v) => v.id) });
  const plan = planRoute({ ...base, stops, order: options.order });

  const byId = new Map(open.map((v) => [v.id, v]));
  const iso = (minutes: number) => zonedTimeToUtc(date, hhmm(minutes), tz).toISOString();
  const planned: PlannedVisit[] = plan.stops.map((p, i) => {
    const visit = byId.get(p.id)!;
    const keepTime = p.fixed;
    const timed = keepTime || (s.routeTimes && p.end < 24 * 60);
    return {
      visit,
      order: started.length + i + 1,
      starts_at: keepTime ? visit.starts_at : timed ? iso(p.start) : null,
      ends_at: keepTime ? visit.ends_at : timed ? iso(p.end) : null,
      planned: p,
    };
  });

  const warnings: string[] = [];
  for (const p of planned.filter((x) => x.planned.late)) warnings.push(`${p.visit.title} can't be reached by ${clockLabel(p.planned.start)}.`);
  const nowhere = planned.filter((p) => !p.planned.located).length;
  if (nowhere) warnings.push(`${nowhere === 1 ? "1 stop has" : `${nowhere} stops have`} no map location, so ${nowhere === 1 ? "it goes" : "they go"} last. Check the address on the client.`);
  if (s.routeTimes && planned.some((p) => p.planned.end > 24 * 60)) warnings.push("The route runs past midnight. Move some stops to another day.");
  else if (planned.length && plan.finish > workEnd) warnings.push(`Done around ${clockLabel(plan.finish)}, after the workday ends at ${clockLabel(workEnd)}.`);
  if (!shop) warnings.push("Add the shop address in Settings → Company so routes start and end there.");

  const sameTime = (a: string | null, b: string | null) => (a && b ? Date.parse(a) === Date.parse(b) : a === b);
  const changes = planned
    .filter((p) => p.visit.route_order !== p.order || !sameTime(p.visit.starts_at, p.starts_at) || !sameTime(p.visit.ends_at, p.ends_at))
    .map((p) => ({ id: p.visit.id, route_order: p.order, starts_at: p.starts_at, ends_at: p.ends_at }));

  return { date, times: s.routeTimes, shop, returnToShop: s.returnToShop, stops: planned, started, milesBefore: before.miles, milesAfter: plan.miles, finish: plan.finish, workEnd, warnings, changes };
}

export type Previous = Array<{ id: string; route_order: number | null; starts_at: string | null; ends_at: string | null }>;

/**
 * Write a day's plan to its visits and remember the day as organized. Returns what the changed
 * visits had before, for Undo.
 */
export async function saveDay(db: Db, companyId: string, crewId: string | null, day: DayPlan, mark: { byHand: boolean; userId: string | null }): Promise<Previous> {
  if (day.times && day.stops.some((p) => !p.planned.fixed && p.planned.end > 24 * 60)) throw new HttpError(400, "That route runs past midnight. Move some stops to another day first.");
  const previous: Previous = [];
  const byId = new Map(day.stops.map((p) => [p.visit.id, p.visit]));
  for (const change of day.changes) {
    const { id, ...fields } = change;
    const { error } = await db.from("visits").update(fields).eq("id", id).eq("company_id", companyId);
    if (error) throw error.code === "42501" || error.code === "22023" ? new HttpError(403, error.message) : new Error(error.message);
    const v = byId.get(id)!;
    previous.push({ id, route_order: v.route_order, starts_at: v.starts_at, ends_at: v.ends_at });
  }
  await markDay(db, companyId, crewId, day.date, { ...mark, miles: day.milesAfter });
  return previous;
}

export async function markDay(db: Db, companyId: string, crewId: string | null, date: string, mark: { byHand: boolean; userId: string | null; miles?: number | null }) {
  const { error } = await db.from("routes").upsert(
    {
      company_id: companyId,
      crew_id: crewId,
      route_date: date,
      by_hand: mark.byHand,
      ...(mark.miles != null && { miles: Math.round(mark.miles * 10) / 10 }),
      organized_at: new Date().toISOString(),
      organized_by: mark.userId,
    },
    { onConflict: "company_id,crew_id,route_date" },
  );
  if (error) throw error.code === "42501" ? new HttpError(403, "You can plan your own crew's route.") : new Error(error.message);
}

export async function dayRoute(db: Db, companyId: string, crewId: string | null, date: string) {
  let query = db.from("routes").select("by_hand, organized_at, miles").eq("company_id", companyId).eq("route_date", date);
  query = crewId ? query.eq("crew_id", crewId) : query.is("crew_id", null);
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

/**
 * With automatic routes on: fit new anytime visits (`only` these, or every unnumbered one) into the
 * day's route, where they add the least driving. The rest keeps its order; visits someone put at a
 * time keep it, and other unnumbered anytime visits are left out. Nothing happens on a day that
 * hasn't been organized, or whose route was undone.
 */
export async function fitIntoRoute(db: Db, companyId: string, crewId: string | null, date: string, company: CompanyClock, userId: string | null, options: { now?: Date; only?: string[] } = {}): Promise<number> {
  const now = options.now ?? new Date();
  if (!scheduleSettings(company.settings).autoRoutes || date < localDate(now, company.tz)) return 0;
  const route = await dayRoute(db, companyId, crewId, date);
  if (!route) return 0;
  const visits = await loadDay(db, companyId, crewId, date);
  const open = visits.filter((v) => v.status === "scheduled");
  const order = open.filter((v) => v.route_order != null).sort((a, b) => a.route_order! - b.route_order!).map((v) => v.id);
  const unnumbered = open.filter((v) => v.route_order == null && !v.starts_at);
  const newcomers = unnumbered.filter((v) => !options.only || options.only.includes(v.id));
  if (!order.length || !newcomers.length) return 0;
  const left = new Set(unnumbered.filter((v) => !newcomers.includes(v)).map((v) => v.id));
  const keep = new Set(open.filter((v) => v.route_order == null && v.starts_at).map((v) => v.id));
  const day = planDay(visits.filter((v) => !left.has(v.id)), company, date, { now, order, keep });
  await saveDay(db, companyId, crewId, day, { byHand: route.by_hand, userId });
  return newcomers.length;
}

/**
 * The "routes" task (hourly): for each company with automatic routes, each crew's next week. A day
 * not organized yet is organized (shortest order); an organized day gets its new anytime visits
 * fitted in. Today is left alone: crews may be partway through it.
 */
export async function autoRoutes(env: Env, now = new Date()) {
  const admin = adminClient(env);
  const { data: companies, error } = await admin.from("companies").select("id, timezone, settings").eq("settings->schedule->>auto_routes", "true");
  if (error) throw new Error(error.message);
  let organized = 0;
  let fitted = 0;
  const problems: string[] = [];
  for (const company of companies ?? []) {
    const clock = { tz: company.timezone, settings: (company.settings ?? {}) as Record<string, any> };
    const today = localDate(now, clock.tz);
    const first = addDays(today, 1);
    const last = addDays(today, AUTO_DAYS);
    const [visits, routes] = await Promise.all([
      admin.from("visits").select("crew_id, scheduled_on, route_order, starts_at").eq("company_id", company.id).eq("status", "scheduled").not("crew_id", "is", null).gte("scheduled_on", first).lte("scheduled_on", last).limit(5000),
      admin.from("routes").select("crew_id, route_date").eq("company_id", company.id).gte("route_date", first).lte("route_date", last),
    ]);
    if (visits.error || routes.error) {
      problems.push(`${company.id}: ${(visits.error ?? routes.error)!.message}`);
      continue;
    }
    const done = new Set(routes.data.map((r) => `${r.crew_id}|${r.route_date}`));
    const days = new Map<string, { crew: string; date: string; newcomers: number }>();
    for (const v of visits.data) {
      const key = `${v.crew_id}|${v.scheduled_on}`;
      const day = days.get(key) ?? { crew: v.crew_id!, date: v.scheduled_on!, newcomers: 0 };
      if (v.route_order == null && !v.starts_at) day.newcomers++;
      days.set(key, day);
    }
    for (const [key, day] of days) {
      try {
        if (!done.has(key)) {
          const plan = planDay(await loadDay(admin, company.id, day.crew, day.date), clock, day.date, { now });
          await saveDay(admin, company.id, day.crew, plan, { byHand: false, userId: null });
          organized++;
        } else if (day.newcomers) {
          fitted += await fitIntoRoute(admin, company.id, day.crew, day.date, clock, null, { now });
        }
      } catch (err) {
        problems.push(`${company.id} ${key}: ${err instanceof Error ? err.message : err}`);
      }
    }
  }
  return { companies: companies?.length ?? 0, organized, fitted, problems };
}
