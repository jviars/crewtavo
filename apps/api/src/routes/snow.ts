/**
 * Snow (Apps → Crewtavo - Snow): Install and Uninstall; what the forecast calls for at each snow
 * customer, with the official winter alerts where they are; one customer's weather in detail, or the
 * shop's; and scheduling a storm. The snow customers themselves, the season's storms and which subs can go out are read and
 * saved from the page itself (snow_sites, snow_events, snow_availability); the snow task tells the
 * crews the day before (snowWatch in tasks.ts). Forecasts come from the business's own source
 * (services/forecast.ts).
 */
import { ADMINS, addDays, DISPATCH, localDate, snowPlan } from "@crewtavo/core";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { requireCompany, requireUser } from "../lib/auth";
import { dbError, HttpError, must, readJson, uuid } from "../lib/http";
import { adminClient } from "../lib/supabase";
import { placeKey } from "../services/external";
import { forecasterFor, placeWeather, placeWeathers, snowToday, winterAlerts } from "../services/forecast";

export const snow = new Hono<AppEnv>();

/** Snow on its Apps page: Install and Uninstall (public.trade_app_set_enabled). */
snow.post("/snow/enabled", requireUser, requireCompany(ADMINS, "apps"), async (c) => {
  const body = await readJson(c, z.object({ enabled: z.boolean() }));
  const { error } = await c.var.db.rpc("trade_app_set_enabled", { p_company: c.var.companyId, p_app: "snow", p_enabled: body.enabled });
  if (error) throw dbError(error);
  return c.json({ enabled: body.enabled });
});

/** The business's today and tomorrow and its forecast source: what every snow forecast here goes by. And where its shop is on the map (Settings → Company), or null. */
async function snowDay(c: Context<AppEnv>) {
  const company = must(await adminClient(c.env).from("companies").select("timezone, weather_source:settings->weather_source, depot:settings->depot").eq("id", c.var.companyId).maybeSingle());
  const today = localDate(new Date(), company.timezone);
  const depot = company.depot as { lat?: unknown; lng?: unknown } | null;
  const shop = typeof depot?.lat === "number" && typeof depot.lng === "number" ? { lat: depot.lat, lng: depot.lng } : null;
  return { today, tomorrow: addDays(today, 1), shop, forecaster: await forecasterFor(c.env, adminClient(c.env), c.var.companyId, company) };
}

/** The business's snow customers (active jobs) with where they are, as the caller may see them. */
async function snowSites(c: Context<AppEnv>, only?: string[]) {
  let query = c.var.db.from("snow_sites").select("job_id, trigger_in, salt_trigger_in, repeat_in, job:jobs!inner(status, paused_at, property:properties(lat, lng))").eq("company_id", c.var.companyId).eq("job.status", "active").limit(1000);
  if (only) query = query.in("job_id", only);
  return must(await query).map((s) => ({
    job_id: s.job_id,
    paused: Boolean(s.job.paused_at),
    rules: { trigger_in: Number(s.trigger_in), salt_trigger_in: s.salt_trigger_in == null ? null : Number(s.salt_trigger_in), repeat_in: s.repeat_in == null ? null : Number(s.repeat_in) },
    place: s.job.property?.lat != null && s.job.property.lng != null ? { lat: s.job.property.lat, lng: s.job.property.lng } : null,
  }));
}

/**
 * The snow forecast at each active snow customer, in inches from 6pm today through tomorrow as the
 * snow task counts it, by job id: null where there's no map location or no forecast. `date` is
 * tomorrow, `source` whose forecast it is, and `alerts` the official winter alerts in force where
 * the customers are (the National Weather Service's, whatever the source). `today` is today's own
 * storm the same way: what has fallen since 6pm last night and what's still coming by 6pm tonight.
 */
snow.get("/snow/forecast", requireUser, requireCompany(DISPATCH, "schedule"), async (c) => {
  const [{ today, tomorrow, forecaster }, sites] = await Promise.all([snowDay(c), snowSites(c)]);
  const places = sites.flatMap((s) => (s.place ? [s.place] : []));
  const [weather, alerts] = await Promise.all([placeWeathers(places, forecaster, 3), winterAlerts(places).catch(() => [])]);
  const fallen = await snowToday(places, weather, today, forecaster);
  const inches: Record<string, number | null> = {};
  const now: Record<string, number | null> = {};
  for (const s of sites) {
    const key = s.place ? placeKey(s.place.lat, s.place.lng) : "";
    inches[s.job_id] = weather.get(key)?.snow_by_day[tomorrow] ?? null;
    now[s.job_id] = fallen.get(key) ?? null;
  }
  return c.json({ date: tomorrow, source: forecaster.source, inches, alerts, today: { date: today, inches: now } });
});

/**
 * The weather in detail at one job's property, or with no job at the business's own shop, for the
 * Snow page's weather view: now, hour by hour and day by day (PlaceWeather), with the snow coming by
 * tomorrow as the alerts count it. Asked by job or for the shop, not by coordinates, so it's only
 * ever a place the person may see.
 */
snow.get("/snow/weather", requireUser, requireCompany(DISPATCH, "schedule"), async (c) => {
  const asked = c.req.query("job");
  const jobId = uuid.safeParse(asked);
  if (asked && !jobId.success) throw new HttpError(400, "Pick a job to see its weather.");
  const [{ tomorrow, forecaster, shop }, job] = await Promise.all([
    snowDay(c),
    jobId.success ? c.var.db.from("jobs").select("id, property:properties(lat, lng)").eq("company_id", c.var.companyId).eq("id", jobId.data).maybeSingle() : null,
  ]);
  const place = job ? must(job, "That job wasn't found.").property : shop;
  if (!job && !place) throw new HttpError(400, "Your shop has no map location yet, so there's no forecast for it. Add its address in Settings → Company.");
  if (place?.lat == null || place.lng == null) throw new HttpError(400, "This job's property has no map location yet, so there's no forecast for it. Fix the address on the property.");
  const weather = await placeWeather(place.lat, place.lng, forecaster).catch(() => null);
  // 424, not 502: the app reads a 502 as Crewtavo itself restarting, and says so on every screen.
  if (!weather) throw new HttpError(424, "The forecast couldn't be loaded right now. Try again in a minute.");
  return c.json({ ...weather, tomorrow, snow_by_tomorrow_in: weather.snow_by_day[tomorrow] ?? null });
});

/**
 * Schedule them, on the Snow page: tomorrow's visits for these snow customers (or, for `day`
 * "today", today's, for a storm that's here), as many as the forecast calls for now (worked out
 * here, not taken from the page), with their people on them (public.snow_schedule, which checks
 * who's asking and never doubles a visit). A customer the forecast no longer calls for anything at
 * is left alone.
 */
snow.post("/snow/schedule", requireUser, requireCompany(DISPATCH, "schedule"), async (c) => {
  const body = await readJson(c, z.object({ job_ids: z.array(uuid).min(1).max(1000), day: z.enum(["today", "tomorrow"]).default("tomorrow") }));
  const [{ today, tomorrow, forecaster }, sites] = await Promise.all([snowDay(c), snowSites(c, body.job_ids)]);
  const date = body.day === "today" ? today : tomorrow;
  const places = sites.flatMap((s) => (s.place && !s.paused ? [s.place] : []));
  const weather = await placeWeathers(places, forecaster, 3);
  const fallen = body.day === "today" ? await snowToday(places, weather, today, forecaster) : null;
  const plan = sites.flatMap((s) => {
    const key = s.place && !s.paused ? placeKey(s.place.lat, s.place.lng) : "";
    const inches = fallen ? fallen.get(key) : weather.get(key)?.snow_by_day[tomorrow];
    const called = snowPlan(s.rules, inches);
    return called && inches != null ? [{ job_id: s.job_id, inches, pushes: called.pushes, kind: called.kind }] : [];
  });
  if (!plan.length) return c.json({ created: 0, date });
  const { data, error } = await c.var.db.rpc("snow_schedule", { p_company: c.var.companyId, p_date: date, p_plan: plan });
  if (error) throw dbError(error);
  return c.json({ created: data ?? 0, date });
});
