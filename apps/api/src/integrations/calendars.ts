/**
 * Other calendars on the schedule, and visits on Google Calendar.
 *
 * Calendars come from an ICS link (Zoho Calendar, Outlook, iCloud, Google's secret address, any
 * other) or from a connected Google account. Every 15 minutes each is read again and its events
 * for the next six months (and last month) replace what we had. Links are secrets: they're stored
 * encrypted, and only fetched after checking they point at a public address.
 *
 * With Google Calendar connected, visits can also go onto a calendar Crewtavo makes in that
 * account: the outbox (see the calendar_sync migration) brings each change across.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { addDays, eventDays, localDate, looksLikeIcs, parseIcs, plainText, type IcsItem } from "@crewtavo/core";
import type { Env } from "../env";
import { decryptJson } from "../lib/crypto";
import type { Db } from "../lib/supabase";
import { accessToken, IntegrationError } from "./tokens";

/** A problem with a calendar that the person who added it can act on. */
export class CalendarError extends Error {
  override name = "CalendarError";
}

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_EVENTS = 5000;
export const WINDOW_BACK_DAYS = 30;
export const WINDOW_AHEAD_DAYS = 180;

// ---------------------------------------------------------------------------------------------
// Fetching an ICS link
// ---------------------------------------------------------------------------------------------

/** A pasted link, tidied: webcal:// becomes https://, and a missing scheme means https. */
export function normalizeLink(input: string): URL {
  let text = input.trim().replace(/^<|>$/g, "").replace(/^"|"$/g, "");
  if (/^webcals?:\/\//i.test(text)) text = text.replace(/^webcals?:/i, "https:");
  if (!/^[a-z][a-z0-9+.-]*:/i.test(text)) text = `https://${text}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new CalendarError("That doesn't look like a link. Copy the calendar's whole ICS link and paste it again.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new CalendarError("Use a calendar link that starts with https:// or webcal://.");
  if (text.length > 2000) throw new CalendarError("That link is too long to be a calendar link.");
  url.hash = "";
  return url;
}

function privateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a = 0, b = 0] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) || (a === 198 && (b === 18 || b === 19));
  }
  const v6 = ip.toLowerCase().replace(/^\[|\]$/g, "");
  const mapped = /^::ffff:(?:(\d+\.\d+\.\d+\.\d+)|([0-9a-f]{1,4}):([0-9a-f]{1,4}))$/.exec(v6);
  if (mapped) {
    if (mapped[1]) return privateAddress(mapped[1]);
    const hi = parseInt(mapped[2]!, 16);
    const lo = parseInt(mapped[3]!, 16);
    return privateAddress(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  return v6 === "::" || v6 === "::1" || /^(fc|fd|fe[89ab]|ff)/.test(v6);
}

/** Calendars must be on the public internet: never this server, its network or its cloud's metadata service. */
async function assertPublic(url: URL) {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (/^localhost$|\.localhost$|\.internal$|\.local$/i.test(host)) throw new CalendarError("That link points at a private address. Use the calendar's public ICS link.");
  const addresses = isIP(host) ? [host] : await lookup(host, { all: true }).then((r) => r.map((a) => a.address)).catch(() => {
    throw new CalendarError(`Couldn't find ${host}. Check the link and try again.`);
  });
  if (!addresses.length || addresses.some(privateAddress)) throw new CalendarError("That link points at a private address. Use the calendar's public ICS link.");
}

async function readLimited(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw new CalendarError("That calendar is too big to read (over 10 MB). Try a calendar with fewer past events.");
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** Download a calendar file, following up to five redirects (each checked again). */
export async function fetchIcs(link: string | URL): Promise<string> {
  let url = typeof link === "string" ? normalizeLink(link) : link;
  for (let hop = 0; hop < 5; hop++) {
    await assertPublic(url);
    const headers: Record<string, string> = { Accept: "text/calendar, text/plain;q=0.9, */*;q=0.5", "User-Agent": "Crewtavo calendar sync" };
    const target = new URL(url);
    // A link with a name and password in it (some self-hosted calendars) signs in with them.
    if (target.username || target.password) {
      headers.Authorization = `Basic ${btoa(`${decodeURIComponent(target.username)}:${decodeURIComponent(target.password)}`)}`;
      target.username = "";
      target.password = "";
    }
    let response: Response;
    try {
      response = await fetch(target, { headers, redirect: "manual", signal: AbortSignal.timeout(20_000) });
    } catch {
      throw new CalendarError("Couldn't reach that calendar. Check the link, or try again in a few minutes.");
    }
    const location = response.headers.get("location");
    if (response.status >= 300 && response.status < 400 && location) {
      url = new URL(location, target);
      if (url.protocol !== "https:" && url.protocol !== "http:") break;
      continue;
    }
    if (response.status === 401 || response.status === 403) throw new CalendarError("That calendar needs a sign-in. Use its private or secret ICS link (the one with a long code in it).");
    if (response.status === 404 || response.status === 410) throw new CalendarError("No calendar at that link. It may have been turned off or replaced; copy the link again.");
    if (!response.ok) throw new CalendarError(`The calendar's server had a problem (${response.status}). It will try again later.`);
    const text = await readLimited(response);
    if (!looksLikeIcs(text)) throw new CalendarError("That link opened a web page, not a calendar. Use the ICS link (also called the iCal, webcal, private or secret address).");
    return text;
  }
  throw new CalendarError("That link redirected too many times.");
}

// ---------------------------------------------------------------------------------------------
// Google Calendar API
// ---------------------------------------------------------------------------------------------

const GCAL = "https://www.googleapis.com/calendar/v3";

type GoogleJson = Record<string, any>;

export class GoogleError extends IntegrationError {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function gcal(env: Env, admin: Db, companyId: string, method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<GoogleJson | null> {
  const { token } = await accessToken(env, admin, companyId, "google_calendar");
  const response = await fetch(`${GCAL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  if (response.status === 204) return null;
  const json = (await response.json().catch(() => ({}))) as GoogleJson;
  if (!response.ok) {
    const message = String(json.error?.message ?? response.statusText ?? "");
    const reasons = JSON.stringify([json.error?.errors, json.error?.details]);
    if (response.status === 403 && /insufficient|ACCESS_TOKEN_SCOPE/i.test(`${message} ${reasons}`)) {
      // Connected before Crewtavo asked for these permissions (or they were unticked at sign-in).
      await admin.from("integrations").update({ status: "error", last_error: "Reconnect Google Calendar to allow reading calendars and adding visits." })
        .eq("company_id", companyId).eq("provider", "google_calendar");
      throw new GoogleError(403, "Google Calendar needs to be reconnected to allow this. Disconnect it and connect it again.");
    }
    throw new GoogleError(response.status, `Google Calendar: ${response.status} ${message}`.trim());
  }
  return json;
}

export interface GoogleCalendar {
  id: string;
  name: string;
  color: string | null;
  primary: boolean;
}

/** The calendars in the connected account that we can read, except the one Crewtavo writes visits to. */
export async function listGoogleCalendars(env: Env, admin: Db, companyId: string, skip?: string | null): Promise<GoogleCalendar[]> {
  const calendars: GoogleCalendar[] = [];
  let page: string | undefined;
  do {
    const params = new URLSearchParams({ minAccessRole: "reader", maxResults: "250", fields: "items(id,summary,summaryOverride,backgroundColor,primary),nextPageToken" });
    if (page) params.set("pageToken", page);
    const json = (await gcal(env, admin, companyId, "GET", `/users/me/calendarList?${params}`))!;
    for (const c of json.items ?? []) {
      if (c.id === skip) continue;
      calendars.push({ id: c.id, name: String(c.summaryOverride ?? c.summary ?? c.id).slice(0, 80), color: /^#[0-9a-f]{6}$/i.test(c.backgroundColor ?? "") ? c.backgroundColor : null, primary: Boolean(c.primary) });
    }
    page = json.nextPageToken;
  } while (page && calendars.length < 500);
  return calendars.sort((a, b) => Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name));
}

/** After connecting: which Google account it is (its main calendar's ID is the address). */
export async function describeGoogleAccount(token: string) {
  const response = await fetch(`${GCAL}/users/me/calendarList/primary?fields=id,summary`, { headers: { Authorization: `Bearer ${token}`, Accept: "application/json" } });
  const json = (await response.json().catch(() => ({}))) as GoogleJson;
  return { external_account_id: null, account_label: (json.id as string | undefined) ?? (json.summary as string | undefined) ?? "Google account" };
}

async function googleEvents(env: Env, admin: Db, companyId: string, calendarId: string, from: Date, to: Date): Promise<IcsItem[]> {
  const items: IcsItem[] = [];
  let page: string | undefined;
  do {
    const params = new URLSearchParams({
      singleEvents: "true",
      timeMin: from.toISOString(),
      timeMax: to.toISOString(),
      maxResults: "2500",
      orderBy: "startTime",
      fields: "items(id,status,summary,location,description,htmlLink,start,end,transparency),nextPageToken",
    });
    if (page) params.set("pageToken", page);
    let json: GoogleJson;
    try {
      json = (await gcal(env, admin, companyId, "GET", `/calendars/${encodeURIComponent(calendarId)}/events?${params}`))!;
    } catch (error) {
      if (error instanceof GoogleError && (error.status === 404 || error.status === 410)) throw new CalendarError("This calendar is gone from the Google account, or no longer shared with it. Remove it here.");
      throw error;
    }
    for (const e of json.items ?? []) {
      if (e.status === "cancelled" || !e.start || !e.end) continue;
      const allDay = Boolean(e.start.date);
      items.push({
        key: String(e.id),
        title: String(e.summary ?? "Busy").slice(0, 200),
        location: e.location ? String(e.location).slice(0, 300) : null,
        description: plainText(e.description ? String(e.description).slice(0, 4000) : null)?.slice(0, 2000) ?? null,
        url: typeof e.htmlLink === "string" && e.htmlLink.startsWith("https://") ? e.htmlLink : null,
        allDay,
        start: allDay ? e.start.date : new Date(e.start.dateTime).toISOString(),
        end: allDay ? e.end.date : new Date(e.end.dateTime).toISOString(),
        busy: e.transparency !== "transparent",
        tentative: e.status === "tentative",
      });
    }
    page = json.nextPageToken;
  } while (page && items.length < MAX_EVENTS);
  return items.slice(0, MAX_EVENTS);
}

// ---------------------------------------------------------------------------------------------
// Keeping a calendar's events
// ---------------------------------------------------------------------------------------------

export const SOURCE_FIELDS = "id, kind, app, name, color, crew_id, show_details, blocks_time, enabled, host, event_count, last_synced_at, last_error, created_at";

interface SourceRow {
  id: string;
  company_id: string;
  kind: string;
  show_details: boolean;
  url_sealed: string | null;
  external_id: string | null;
}

async function shortKey(key: string): Promise<string> {
  if (key.length <= 400) return key;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(key));
  return `${key.slice(0, 200)}#${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** Replace a calendar's events with `items`: upsert what's there, then drop what wasn't this time. */
async function storeEvents(admin: Db, source: SourceRow, items: IcsItem[], tz: string) {
  const stamp = new Date().toISOString();
  const seen = new Set<string>();
  const rows = [];
  for (const item of items) {
    const key = await shortKey(item.key);
    if (seen.has(key)) continue;
    seen.add(key);
    const details = source.show_details;
    rows.push({
      company_id: source.company_id,
      source_id: source.id,
      key,
      title: details ? item.title : "Busy",
      location: details ? item.location : null,
      description: details ? item.description : null,
      url: details ? item.url : null,
      all_day: item.allDay,
      starts_at: item.allDay ? null : item.start,
      ends_at: item.allDay ? null : item.end,
      ...eventDays(item, tz),
      busy: item.busy,
      synced_at: stamp,
    });
  }
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await admin.from("calendar_events").upsert(rows.slice(i, i + 500), { onConflict: "source_id,key" });
    if (error) throw new Error(`Couldn't save calendar events: ${error.message}`);
  }
  const { error } = await admin.from("calendar_events").delete().eq("source_id", source.id).lt("synced_at", stamp);
  if (error) throw new Error(`Couldn't remove old calendar events: ${error.message}`);
  return rows.length;
}

/** Read a calendar's events now (ICS link or Google) and keep them. Returns how many there are. */
export async function syncSource(env: Env, admin: Db, sourceId: string): Promise<number> {
  const { data: source, error } = await admin
    .from("calendar_sources")
    .select("id, company_id, kind, show_details, enabled, url_sealed, external_id, company:companies(timezone)")
    .eq("id", sourceId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!source || !source.enabled) return 0;
  const tz = (source.company as unknown as { timezone: string } | null)?.timezone ?? "UTC";
  const today = localDate(new Date(), tz);
  const from = new Date(`${addDays(today, -WINDOW_BACK_DAYS)}T00:00:00Z`);
  const to = new Date(`${addDays(today, WINDOW_AHEAD_DAYS)}T00:00:00Z`);
  try {
    let items: IcsItem[];
    if (source.kind === "ics") {
      const { url } = await decryptJson<{ url: string }>(env, source.url_sealed!);
      items = parseIcs(await fetchIcs(url), { from, to, zone: tz, limit: MAX_EVENTS }).events;
    } else {
      items = await googleEvents(env, admin, source.company_id, source.external_id!, from, to);
    }
    const count = await storeEvents(admin, source, items, tz);
    await admin.from("calendar_sources").update({ last_synced_at: new Date().toISOString(), last_error: null, event_count: count }).eq("id", source.id);
    return count;
  } catch (err) {
    const message = err instanceof CalendarError || err instanceof IntegrationError ? err.message : "Couldn't refresh this calendar. It will try again in a few minutes.";
    await admin.from("calendar_sources").update({ last_error: message.slice(0, 500) }).eq("id", source.id);
    throw err;
  }
}

/** The 15-minute task: every calendar not read in the last 14 minutes, a few at a time. */
export async function syncDueCalendars(env: Env, admin: Db) {
  const due = new Date(Date.now() - 14 * 60_000).toISOString();
  const { data, error } = await admin
    .from("calendar_sources")
    .select("id")
    .eq("enabled", true)
    .or(`last_synced_at.is.null,last_synced_at.lt.${due}`)
    .order("last_synced_at", { ascending: true, nullsFirst: true })
    .limit(200);
  if (error) throw new Error(error.message);
  const queue = [...(data ?? [])];
  let synced = 0;
  let failed = 0;
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) {
      try {
        await syncSource(env, admin, next.id);
        synced++;
      } catch {
        failed++; // recorded on the calendar for the Apps page
      }
    }
  };
  await Promise.all([worker(), worker(), worker(), worker()]);
  return { calendars: data?.length ?? 0, synced, failed };
}

// ---------------------------------------------------------------------------------------------
// Visits -> Google Calendar
// ---------------------------------------------------------------------------------------------

/** Google event IDs allow 0-9 and a-v; a visit's UUID in hex fits, so each visit has a fixed event ID. */
export const googleEventId = (visitId: string) => `ctv${visitId.replace(/-/g, "").toLowerCase()}`;

/** Make the "<Company> (Crewtavo)" calendar in the connected account. Returns its ID. */
export async function createVisitsCalendar(env: Env, admin: Db, companyId: string): Promise<{ id: string; name: string }> {
  const { data: company } = await admin.from("companies").select("name, timezone").eq("id", companyId).single();
  const name = `${company?.name ?? "Crewtavo"} visits`.slice(0, 80);
  const created = (await gcal(env, admin, companyId, "POST", "/calendars", {
    summary: name,
    description: "Visits from Crewtavo, kept up to date as the schedule changes. Changes made here aren't copied back.",
    timeZone: company?.timezone ?? "UTC",
  }))!;
  return { id: String(created.id), name };
}

/** Remove the visits calendar from the Google account (best effort: it may already be gone). */
export async function deleteVisitsCalendar(env: Env, admin: Db, companyId: string, calendarId: string) {
  try {
    await gcal(env, admin, companyId, "DELETE", `/calendars/${encodeURIComponent(calendarId)}`);
  } catch (error) {
    if (!(error instanceof GoogleError && (error.status === 404 || error.status === 410))) throw error;
  }
}

/** Put one visit on (or take it off) the visits calendar, so Google matches Crewtavo. */
export async function pushVisit(env: Env, admin: Db, companyId: string, calendarId: string, visitId: string) {
  const cal = `/calendars/${encodeURIComponent(calendarId)}/events`;
  const eventId = googleEventId(visitId);
  const { data: visit } = await admin
    .from("visits")
    .select("id, title, kind, status, scheduled_on, starts_at, ends_at, notes, crew:crews(name), job:jobs(number, client:clients(display_name)), property:properties(line1, city, region, postal_code)")
    .eq("company_id", companyId)
    .eq("id", visitId)
    .maybeSingle();

  if (!visit || !visit.scheduled_on || visit.status === "unscheduled" || visit.status === "cancelled") {
    try {
      await gcal(env, admin, companyId, "DELETE", `${cal}/${eventId}`);
    } catch (error) {
      if (!(error instanceof GoogleError && (error.status === 404 || error.status === 410))) throw error;
    }
    return "removed" as const;
  }

  const job = visit.job as unknown as { number: number; client: { display_name: string } | null } | null;
  const crew = visit.crew as unknown as { name: string } | null;
  const place = visit.property as unknown as { line1: string; city: string | null; region: string | null; postal_code: string | null } | null;
  const base = env.APP_URL?.replace(/\/$/, "");
  const link = base ? `${base}/schedule?view=day&date=${visit.scheduled_on}` : null;
  const timed = Boolean(visit.starts_at);
  const end = visit.ends_at ?? (visit.starts_at ? new Date(Date.parse(visit.starts_at) + 3_600_000).toISOString() : null);
  const body = {
    summary: visit.status === "completed" ? `✓ ${visit.title}` : visit.title,
    location: place ? [place.line1, place.city, [place.region, place.postal_code].filter(Boolean).join(" ")].filter(Boolean).join(", ") : undefined,
    description: [job?.client?.display_name, job ? `Job #${job.number}` : null, crew ? `Crew: ${crew.name}` : null, visit.notes, link ? `Open in Crewtavo: ${link}` : null]
      .filter(Boolean)
      .join("\n"),
    start: timed ? { dateTime: visit.starts_at } : { date: visit.scheduled_on },
    end: timed ? { dateTime: end } : { date: addDays(visit.scheduled_on, 1) },
    transparency: timed ? "opaque" : "transparent",
    status: "confirmed",
    // The calendar is a mirror of the schedule; reminders for every visit would be noise.
    reminders: { useDefault: false, overrides: [] },
    extendedProperties: { private: { crewtavo_visit: visit.id } },
    ...(link ? { source: { title: "Crewtavo", url: link } } : {}),
  };

  try {
    await gcal(env, admin, companyId, "PUT", `${cal}/${eventId}`, body);
  } catch (error) {
    if (!(error instanceof GoogleError && error.status === 404)) throw error;
    try {
      await gcal(env, admin, companyId, "POST", cal, { ...body, id: eventId });
    } catch (insertError) {
      // Taken already (a removed event keeps its ID): bring it back.
      if (!(insertError instanceof GoogleError && insertError.status === 409)) throw insertError;
      await gcal(env, admin, companyId, "PUT", `${cal}/${eventId}`, body);
    }
  }
  return "saved" as const;
}

async function visitsCalendar(admin: Db, companyId: string): Promise<string | null> {
  const { data } = await admin.from("integrations").select("status, settings").eq("company_id", companyId).eq("provider", "google_calendar").maybeSingle();
  const id = (data?.settings as { push_calendar_id?: string } | null)?.push_calendar_id;
  return data?.status === "connected" && id ? id : null;
}

/** Run one queued visit change (outbox topic calendar.visit). Throws so the caller retries. */
export async function runCalendarJob(env: Env, admin: Db, row: { company_id: string; topic: string; payload: Record<string, string> }) {
  if (row.topic !== "calendar.visit") throw new IntegrationError(`Unknown topic ${row.topic}`);
  const calendarId = await visitsCalendar(admin, row.company_id);
  if (!calendarId) return; // turned off since it was queued
  await pushVisit(env, admin, row.company_id, calendarId, row.payload.visit_id!);
  await admin.from("integrations").update({ last_sync_at: new Date().toISOString(), last_error: null }).match({ company_id: row.company_id, provider: "google_calendar" });
}

/** When visits start going to Google: everything from last week through the next six months. */
export async function pushUpcomingVisits(env: Env, admin: Db, companyId: string) {
  const calendarId = await visitsCalendar(admin, companyId);
  if (!calendarId) return { pushed: 0 };
  const { data: company } = await admin.from("companies").select("timezone").eq("id", companyId).single();
  const today = localDate(new Date(), company?.timezone ?? "UTC");
  const { data: visits, error } = await admin
    .from("visits")
    .select("id")
    .eq("company_id", companyId)
    .gte("scheduled_on", addDays(today, -7))
    .lte("scheduled_on", addDays(today, WINDOW_AHEAD_DAYS))
    .not("status", "in", "(unscheduled,cancelled)")
    .order("scheduled_on")
    .limit(2000);
  if (error) throw new Error(error.message);
  let pushed = 0;
  for (const v of visits ?? []) {
    // Stop if visits were turned off or Google was disconnected meanwhile.
    if (pushed % 50 === 0 && pushed > 0 && !(await visitsCalendar(admin, companyId))) break;
    await pushVisit(env, admin, companyId, calendarId, v.id);
    pushed++;
  }
  await admin.from("integrations").update({ last_sync_at: new Date().toISOString(), last_error: null }).match({ company_id: companyId, provider: "google_calendar" });
  return { pushed };
}
