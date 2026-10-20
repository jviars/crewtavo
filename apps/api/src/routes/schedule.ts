/**
 * Dashboard and scheduling: the calendar feed, moving visits, rain-day shifts, routing, find-a-time.
 * The scheduling itself is in services/schedule.ts, which AI assistants' tools use too.
 */
import { DISPATCH } from "@crewtavo/core";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { requireCompany, requireUser } from "../lib/auth";
import { dbError, HttpError, isoDate, must, param, readJson, uuid } from "../lib/http";
import { allow } from "../lib/limit";
import { geocodeAddress, suggestPlaces } from "../services/external";
import { geocodeLater, geocodeProperty } from "../services/properties";
import { bulkVisits, createVisits, findTime, generateVisits, MAX_ROUTE_STOPS, newVisitInput, previewRoute, saveRoute, scheduleRange, shiftDay, undoRoute, updateVisit, visitChangeInput, type Scope } from "../services/schedule";

export { MAX_ROUTE_STOPS } from "../services/schedule";

export const schedule = new Hono<AppEnv>();

const scope = (c: Context<AppEnv>): Scope => ({ db: c.var.db, companyId: c.var.companyId, role: c.var.role, permissions: c.var.permissions, userId: c.var.userId });

/**
 * New visit, task or event. With days > 1 it's multi-day work: one linked visit per work day
 * (weekends skipped unless asked), each at the same local time, with the same people and equipment.
 */
schedule.post("/visits", requireUser, requireCompany(DISPATCH), async (c) => {
  return c.json(await createVisits(scope(c), await readJson(c, newVisitInput)), 201);
});

schedule.get("/dashboard", requireUser, requireCompany(), async (c) => {
  const { data, error } = await c.var.db.rpc("dashboard", { p_company: c.var.companyId });
  if (error) throw dbError(error);
  // The function returns jsonb; spelling out its recursive Json type is too deep for Hono's typing.
  return c.json(data as Record<string, unknown>);
});

/** After a recurring job's schedule changes: create its upcoming visits now, and drop ones it no longer has. */
schedule.post("/jobs/:id/generate-visits", requireUser, requireCompany(DISPATCH, "schedule"), async (c) => {
  return c.json(await generateVisits(scope(c), c.env, param(c, "id")));
});

/**
 * Address -> coordinates (the shop address for route planning, and similar). `world` also looks
 * outside the US, for the measuring map; the answer says which country it found.
 */
schedule.post("/geocode", requireUser, requireCompany(), async (c) => {
  const body = await readJson(c, z.object({ address: z.string().trim().min(5).max(300), world: z.boolean().optional() }));
  const result = await geocodeAddress(body.address, c.env.GOOGLE_MAPS_SERVER_KEY, { world: body.world });
  return c.json(result ? { found: true, ...result } : { found: false });
});

/** `foo` as an ILIKE pattern that matches it literally anywhere (its own % and _ aren't wildcards). */
const contains = (text: string) => `%${text.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

/**
 * Suggestions while someone types an address on the measuring map: the company's own clients'
 * properties first (by street or client name, as far as their role can see them), then places near
 * the map from OpenStreetMap (Photon). Place suggestions failing never fails the clients' list.
 */
schedule.get("/places/suggest", requireUser, requireCompany(), async (c) => {
  const q = (c.req.query("q") ?? "").replace(/\s+/g, " ").trim().slice(0, 120);
  if (q.length < 3) return c.json({ clients: [], places: [] });
  const lat = Number(c.req.query("lat"));
  const lng = Number(c.req.query("lng"));
  const near = Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : undefined;
  const { db, companyId } = c.var;
  const fields = "id, line1, city, region, postal_code, lat, lng";
  const [byStreet, byClient, places] = await Promise.all([
    db.from("properties").select(`${fields}, client:clients(id, display_name)`).eq("company_id", companyId).ilike("line1", contains(q)).limit(6),
    db.from("clients").select(`id, display_name, properties(${fields})`).eq("company_id", companyId).ilike("display_name", contains(q)).limit(4),
    (async () => {
      if (!(await allow(c.env, `place-suggest:${companyId}`, 2000, 60 * 60))) return null;
      return suggestPlaces(q, near).catch(() => null);
    })(),
  ]);
  type Row = { id: string; line1: string | null; city: string | null; region: string | null; postal_code: string | null; lat: number | null; lng: number | null };
  const clients = new Map<string, { property_id: string; client_id: string | null; client: string | null; label: string; detail: string | null; lat: number | null; lng: number | null }>();
  const add = (p: Row, client: { id: string; display_name: string } | null) => {
    if (!p.line1 || clients.has(p.id) || clients.size >= 6) return;
    clients.set(p.id, {
      property_id: p.id,
      client_id: client?.id ?? null,
      client: client?.display_name ?? null,
      label: p.line1,
      detail: [p.city, p.region].filter(Boolean).join(", ") || null,
      lat: p.lat,
      lng: p.lng,
    });
  };
  for (const p of (byStreet.data ?? []) as Array<Row & { client: { id: string; display_name: string } | null }>) add(p, p.client);
  for (const client of (byClient.data ?? []) as Array<{ id: string; display_name: string; properties: Row[] }>) for (const p of client.properties) add(p, client);
  return c.json({ clients: [...clients.values()], places: places ?? [], places_unavailable: places === null });
});

/** Find a property's map location from its address (for routing, weather and the measuring tool). */
schedule.post("/properties/:id/geocode", requireUser, requireCompany(), async (c) => {
  const id = param(c, "id");
  must(await c.var.db.from("properties").select("id").eq("id", id).eq("company_id", c.var.companyId).maybeSingle(), "Property not found.");
  const result = await geocodeProperty(c.var.db, c.env, c.var.companyId, id);
  return c.json(result ? { found: true, ...result } : { found: false });
});

/** Find many properties on the map, in the background (after an import). */
schedule.post("/properties/geocode", requireUser, requireCompany(), async (c) => {
  const body = await readJson(c, z.object({ ids: z.array(uuid).min(1).max(2000) }));
  geocodeLater(c.var.db, c.env, c.var.companyId, body.ids);
  return c.json({ queued: body.ids.length }, 202);
});

/** Visits between two dates (inclusive), plus the unscheduled queue and other calendars' events. */
schedule.get("/schedule", requireUser, requireCompany(), async (c) => {
  const from = c.req.query("from");
  const to = c.req.query("to") ?? from;
  const crew = c.req.query("crew_id");
  if (!isoDate.safeParse(from).success || !isoDate.safeParse(to).success) throw new HttpError(400, "from and to must be YYYY-MM-DD");
  return c.json(await scheduleRange(scope(c), from!, to!, crew));
});

schedule.patch("/visits/:id", requireUser, requireCompany(), async (c) => {
  return c.json(await updateVisit(scope(c), param(c, "id"), await readJson(c, visitChangeInput)));
});

/** Rain day: move every open visit from one date to another, keeping each visit's local time. */
schedule.post("/schedule/shift", requireUser, requireCompany(DISPATCH), async (c) => {
  return c.json(await shiftDay(scope(c), await readJson(c, z.object({ from_date: isoDate, to_date: isoDate, crew_id: uuid.optional() }))));
});

// No crew_id (or null) means the visits with no crew, never every crew's at once.
const routeDay = { date: isoDate, crew_id: uuid.nullish(), order: z.array(uuid).max(MAX_ROUTE_STOPS).optional() };

/**
 * Organize route: a crew's day in the shortest order (or `order`, someone's own), each stop's time
 * and the driving between stops, without saving anything.
 */
schedule.post("/schedule/route/preview", requireUser, requireCompany(DISPATCH), async (c) => {
  return c.json(await previewRoute(scope(c), c.env, await readJson(c, z.object(routeDay))));
});

/** Save a crew's route: the order (`by_hand` when someone arranged it) and each stop's time. */
schedule.post("/schedule/route", requireUser, requireCompany(DISPATCH), async (c) => {
  return c.json(await saveRoute(scope(c), await readJson(c, z.object({ ...routeDay, by_hand: z.boolean().default(false) }))));
});

/** Undo Organize route: the visits' order and times as they were. The day is then left as it is. */
schedule.post("/schedule/route/undo", requireUser, requireCompany(DISPATCH), async (c) => {
  const body = await readJson(
    c,
    z.object({
      date: isoDate,
      crew_id: uuid.nullish(),
      visits: z
        .array(z.object({ id: uuid, route_order: z.number().int().min(1).max(10_000).nullable(), starts_at: z.iso.datetime({ offset: true }).nullable(), ends_at: z.iso.datetime({ offset: true }).nullable() }))
        .max(MAX_ROUTE_STOPS),
    }),
  );
  return c.json(await undoRoute(scope(c), body));
});

/** Suggest open slots in working hours (company settings.working_hours, default 7:00-18:00). */
schedule.post("/schedule/find-time", requireUser, requireCompany(), async (c) => {
  const body = await readJson(
    c,
    z.object({ date_from: isoDate, days: z.number().int().min(1).max(14).default(7), duration_min: z.number().int().min(1).max(720), crew_id: uuid.optional() }),
  );
  return c.json(await findTime(scope(c), body));
});

/** On-demand work (snow, storm cleanup): one visit per chosen job on a date. */
schedule.post("/schedule/bulk-visits", requireUser, requireCompany(DISPATCH, "schedule"), async (c) => {
  const body = await readJson(c, z.object({ job_ids: z.array(uuid).min(1).max(500), date: isoDate, crew_id: uuid.optional() }));
  return c.json(await bulkVisits(scope(c), body), 201);
});
