/**
 * Other calendars on the schedule, and visits on Google Calendar.
 *
 * Calendars come from an ICS link (Zoho Calendar, Outlook, iCloud, Google's secret address, any
 * other) or from a connected Google account. Every 15 minutes each is read again and its events
 * for the next six months (and last month) replace what we had. Links are secrets: they're stored
 * encrypted, and only fetched from public addresses (checked as each connection is made).
 *
 * With Google Calendar connected, visits can also go onto a calendar Crewtavo makes in that
 * account: the outbox (see the calendar_sync migration) brings each change across.
 */
import dns from "node:dns";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { pipeline, type Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
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

/**
 * At most `max` characters, never cutting one in half: an emoji is two UTF-16 units, and half of
 * one can't be saved (the database turns down the whole batch it's in).
 */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = 0;
  let count = 0;
  for (const char of text) {
    if (count++ === max) break;
    end += char.length;
  }
  return text.slice(0, end);
}

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

const PRIVATE = "That link points at a private address. Use the calendar's public ICS link.";
const UNREACHABLE = "Couldn't reach that calendar. Check the link, or try again in a few minutes.";

/** An IPv6 address as its eight 16-bit groups. */
function ipv6Groups(ip: string): number[] {
  let text = ip.toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  // An IPv4 ending (::ffff:1.2.3.4) is the last two groups.
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    text = `${text.slice(0, dotted.index)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head = "", tail] = text.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const gap = tail === undefined ? 0 : 8 - left.length - right.length;
  return [...left, ...Array<string>(gap).fill("0"), ...right].map((group) => parseInt(group, 16));
}

const ipv4 = (hi: number, lo: number) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;

function privateAddress(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a = 0, b = 0] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0)) || (a === 198 && (b === 18 || b === 19));
  }
  const g = ipv6Groups(ip);
  const zeros = (from: number, to: number) => g.slice(from, to).every((group) => group === 0);
  // IPv6 addresses that stand for an IPv4 one are as private as it is: IPv4-compatible (::a.b.c.d,
  // which takes in :: and ::1), mapped (::ffff:a.b.c.d), translated (::ffff:0:a.b.c.d) and NAT64
  // (64:ff9b::a.b.c.d), and 6to4 (2002:a.b.c.d::/48).
  if (zeros(0, 6) || (zeros(0, 5) && g[5] === 0xffff) || (zeros(0, 4) && g[4] === 0xffff && g[5] === 0) || (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6))) {
    return privateAddress(ipv4(g[6], g[7]));
  }
  if (g[0] === 0x2002) return privateAddress(ipv4(g[1], g[2]));
  // Teredo (2001::/32) and local-use NAT64 (64:ff9b:1::/48) tunnel to IPv4 addresses too; no calendar needs them.
  if ((g[0] === 0x2001 && g[1] === 0) || (g[0] === 0x64 && g[1] === 0xff9b && g[2] === 1)) return true;
  // Unique local (fc00::/7), link-local (fe80::/10), site-local (fec0::/10) and multicast (ff00::/8).
  return g[0] >= 0xfc00;
}

/**
 * Calendars must be on the public internet: never this server, its network or its cloud's metadata
 * service. A name is checked as it's looked up for the connection itself (publicLookup), so the
 * address checked is the one connected to, even when the name's answer changes from one lookup to
 * the next.
 */
function assertPublic(url: URL) {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (/^localhost$|\.localhost$|\.internal$|\.local$/i.test(host) || (isIP(host) && privateAddress(host))) throw new CalendarError(PRIVATE);
}

/** Looks a link's name up for its connection, and refuses it if any address is private. */
const publicLookup: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return callback(new CalendarError(`Couldn't find ${hostname}. Check the link and try again.`), []);
    if (!addresses.length || addresses.some((a) => privateAddress(a.address))) return callback(new CalendarError(PRIVATE), []);
    if (options.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  });
};

/** Send a GET and wait for the response's headers. */
function get(url: URL, headers: Record<string, string>, signal: AbortSignal): Promise<IncomingMessage> {
  // Its own connection (no agent), so nothing reuses one made to another address.
  const options = { headers, lookup: publicLookup, agent: false as const, signal };
  return new Promise((resolve, reject) => {
    const request = url.protocol === "https:" ? httpsRequest(url, options, resolve) : httpRequest(url, options, resolve);
    request.on("error", reject).end();
  });
}

async function readLimited(response: IncomingMessage): Promise<string> {
  const encoding = String(response.headers["content-encoding"] ?? "").trim().toLowerCase();
  // deflate isn't asked for, but some servers send it anyway (fetch used to unpack it).
  const unzip =
    encoding === "gzip" || encoding === "x-gzip" ? createGunzip() : encoding === "br" ? createBrotliDecompress() : encoding === "deflate" ? createInflate() : null;
  const body: Readable = unzip ? pipeline(response, unzip, () => undefined) : response;
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of body as AsyncIterable<Buffer>) {
      size += chunk.byteLength;
      if (size > MAX_BYTES) throw new CalendarError("That calendar is too big to read (over 10 MB). Try a calendar with fewer past events.");
      chunks.push(chunk);
    }
    // Cut off partway (or too slow to finish).
    if (!response.complete) throw new CalendarError(UNREACHABLE);
  } catch (error) {
    throw error instanceof CalendarError ? error : new CalendarError(UNREACHABLE);
  } finally {
    response.destroy();
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** Download a calendar file, following up to five redirects (each checked again). */
export async function fetchIcs(link: string | URL): Promise<string> {
  let url = typeof link === "string" ? normalizeLink(link) : link;
  for (let hop = 0; hop < 5; hop++) {
    assertPublic(url);
    const headers: Record<string, string> = { Accept: "text/calendar, text/plain;q=0.9, */*;q=0.5", "Accept-Encoding": "gzip, br", "User-Agent": "Crewtavo calendar sync" };
    const target = new URL(url);
    // A link with a name and password in it (some self-hosted calendars) signs in with them.
    if (target.username || target.password) {
      headers.Authorization = `Basic ${btoa(`${decodeURIComponent(target.username)}:${decodeURIComponent(target.password)}`)}`;
      target.username = "";
      target.password = "";
    }
    let response: IncomingMessage;
    try {
      response = await get(target, headers, AbortSignal.timeout(20_000));
    } catch (error) {
      throw error instanceof CalendarError ? error : new CalendarError(UNREACHABLE);
    }
    const status = response.statusCode ?? 0;
    const location = response.headers.location;
    if (status < 200 || status > 299) response.destroy();
    if (status >= 300 && status < 400 && location) {
      url = new URL(location, target);
      if (url.protocol !== "https:" && url.protocol !== "http:") break;
      continue;
    }
    if (status === 401 || status === 403) throw new CalendarError("That calendar needs a sign-in. Use its private or secret ICS link (the one with a long code in it).");
    if (status === 404 || status === 410) throw new CalendarError("No calendar at that link. It may have been turned off or replaced; copy the link again.");
    if (status < 200 || status > 299) throw new CalendarError(`The calendar's server had a problem (${status}). It will try again later.`);
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
  /** `reason`: Google's own words for why (its error details). */
  constructor(readonly status: number, message: string, readonly reason = "") {
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
    throw new GoogleError(response.status, `Google Calendar: ${response.status} ${message}`.trim(), reasons);
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
      calendars.push({ id: c.id, name: clip(String(c.summaryOverride ?? c.summary ?? c.id), 80), color: /^#[0-9a-f]{6}$/i.test(c.backgroundColor ?? "") ? c.backgroundColor : null, primary: Boolean(c.primary) });
    }
    page = json.nextPageToken;
  } while (page && calendars.length < 500);
  return calendars.sort((a, b) => Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name));
}

/** After connecting: which Google account it is (its main calendar's ID is the address). */
export async function describeGoogleAccount(token: string) {
  const response = await fetch(`${GCAL}/users/me/calendarList/primary?fields=id,summary`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(20_000),
  });
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
      const notes = plainText(e.description ? clip(String(e.description), 4000) : null);
      items.push({
        key: String(e.id),
        title: clip(String(e.summary ?? "Busy"), 200),
        location: e.location ? clip(String(e.location), 300) : null,
        description: notes === null ? null : clip(notes, 2000),
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
  return `${clip(key, 200)}#${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}`;
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

/** Details turned off: the events kept so far become "Busy", with no name, place, notes or link (as storeEvents keeps them). */
export async function hideDetails(admin: Db, sourceId: string) {
  const { error } = await admin.from("calendar_events").update({ title: "Busy", location: null, description: null, url: null }).eq("source_id", sourceId);
  if (error) throw new Error(`Couldn't hide calendar details: ${error.message}`);
}

/** Whether a calendar's details are on right now. */
async function detailsOn(admin: Db, sourceId: string): Promise<boolean> {
  const { data, error } = await admin.from("calendar_sources").select("show_details").eq("id", sourceId).maybeSingle();
  if (error) throw new Error(error.message);
  return Boolean(data?.show_details);
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
    // Details can be turned off while the calendar is read, or while its events are saved: those
    // stay off either way.
    const details = await detailsOn(admin, source.id);
    const count = await storeEvents(admin, { ...source, show_details: details }, items, tz);
    if (details && !(await detailsOn(admin, source.id))) await hideDetails(admin, source.id);
    await admin.from("calendar_sources").update({ last_synced_at: new Date().toISOString(), last_error: null, event_count: count }).eq("id", source.id);
    return count;
  } catch (err) {
    const message = err instanceof CalendarError || err instanceof IntegrationError ? err.message : "Couldn't refresh this calendar. It will try again in a few minutes.";
    await admin.from("calendar_sources").update({ last_error: clip(message, 500) }).eq("id", source.id);
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
  const name = clip(`${company?.name ?? "Crewtavo"} visits`, 80);
  const created = (await gcal(env, admin, companyId, "POST", "/calendars", {
    summary: name,
    description: "Visits from Crewtavo, kept up to date as the schedule changes. Changes made here aren't copied back.",
    timeZone: company?.timezone ?? "UTC",
  }))!;
  return { id: String(created.id), name };
}

/**
 * Google won't take visits on the visits calendar at all: it's gone from the account (or this is
 * another account), or the account can only read it. Busy (rate limits) and other trouble isn't that.
 */
const calendarRefused = (error: unknown) =>
  error instanceof GoogleError && (error.status === 404 || (error.status === 403 && /requiredAccessLevel|writer access|forbidden/i.test(`${error.message} ${error.reason}`)));

const REFUSED = "The visits calendar is gone from this Google account, or the account can't add to it. Turn visits off and on again to make a new one.";

/** Remove the visits calendar from the Google account (best effort: it may already be gone, or not this account's to remove). */
export async function deleteVisitsCalendar(env: Env, admin: Db, companyId: string, calendarId: string) {
  try {
    await gcal(env, admin, companyId, "DELETE", `/calendars/${encodeURIComponent(calendarId)}`);
  } catch (error) {
    if (!(error instanceof GoogleError && error.status === 410) && !calendarRefused(error)) throw error;
  }
}

/** Put one visit on (or take it off) the visits calendar, so Google matches Crewtavo. */
export async function pushVisit(env: Env, admin: Db, companyId: string, calendarId: string, visitId: string) {
  const cal = `/calendars/${encodeURIComponent(calendarId)}/events`;
  const eventId = googleEventId(visitId);
  const { data: visit, error } = await admin
    .from("visits")
    .select("id, title, kind, status, scheduled_on, starts_at, ends_at, notes, crew:crews(name), job:jobs(number, client:clients(display_name)), property:properties(line1, city, region, postal_code)")
    .eq("company_id", companyId)
    .eq("id", visitId)
    .maybeSingle();
  // Not read isn't gone: taking the event off for it would be wrong.
  if (error) throw new Error(error.message);

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

/**
 * What the outbox holds for the visits calendar (topic calendar.visit): one visit's change, a batch
 * of visits left over from bringing the calendar in line, or another look at what's on Google.
 */
type VisitJob = { visit_id?: string; visit_ids?: string[]; recheck?: boolean };

/** A batch sends this many visits each outbox run (as many as one run takes; see drainOutbox). */
const BATCH = 100;

/** Run one queued job for the visits calendar. Throws so the caller retries. */
export async function runCalendarJob(env: Env, admin: Db, row: { id?: number; company_id: string; topic: string; payload: Record<string, unknown> }) {
  if (row.topic !== "calendar.visit") throw new IntegrationError(`Unknown topic ${row.topic}`);
  const calendarId = await visitsCalendar(admin, row.company_id);
  if (!calendarId) return; // turned off since it was queued
  const job = row.payload as VisitJob;
  if (job.recheck) return recheckVisits(env, admin, row.company_id, calendarId);
  if (job.visit_ids) return pushBatch(env, admin, row.company_id, calendarId, job.visit_ids, row.id);
  try {
    await pushed(admin, row.company_id, (await pushVisit(env, admin, row.company_id, calendarId, job.visit_id!)) === "saved");
  } catch (error) {
    // Say so once, rather than trying the visit again for hours.
    if (calendarRefused(error)) return refused(admin, row.company_id);
    throw error;
  }
}

/**
 * Pushes went through: note when, and clear the last problem, unless it still holds. Taking visits
 * off doesn't show the visits calendar is back (Google says they're not there either way), and
 * pushing visits doesn't answer a look at the calendar that couldn't be done.
 */
async function pushed(admin: Db, companyId: string, saved: boolean) {
  const match = { company_id: companyId, provider: "google_calendar" };
  const { data } = await admin.from("integrations").select("last_error").match(match).maybeSingle();
  const holds = data?.last_error === UNCHECKED || (data?.last_error === REFUSED && !saved);
  await admin.from("integrations").update(holds ? { last_sync_at: new Date().toISOString() } : { last_sync_at: new Date().toISOString(), last_error: null }).match(match);
}

const VISIT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The days the visits calendar covers (last week through the next six months), and the visits on them. */
async function upcoming(admin: Db, companyId: string) {
  const { data: company } = await admin.from("companies").select("timezone").eq("id", companyId).single();
  const today = localDate(new Date(), company?.timezone ?? "UTC");
  const from = addDays(today, -7);
  const to = addDays(today, WINDOW_AHEAD_DAYS);
  const { data: visits, error } = await admin
    .from("visits")
    .select("id")
    .eq("company_id", companyId)
    .gte("scheduled_on", from)
    .lte("scheduled_on", to)
    .not("status", "in", "(unscheduled,cancelled)")
    .order("scheduled_on")
    .limit(2000);
  if (error) throw new Error(error.message);
  return { from, to, visits: (visits ?? []).map((v) => v.id) };
}

/**
 * The visits that have an event on the visits calendar from the first of those days on (events
 * people added there themselves aren't). Later ones too: a visit gets there whatever its date.
 */
async function visitsOnGoogle(env: Env, admin: Db, companyId: string, calendarId: string, days: { from: string }): Promise<string[]> {
  const ids: string[] = [];
  let page: string | undefined;
  do {
    // A day before covers every time zone.
    const params = new URLSearchParams({ timeMin: `${addDays(days.from, -1)}T00:00:00Z`, maxResults: "2500", fields: "items(id,extendedProperties),nextPageToken" });
    if (page) params.set("pageToken", page);
    const json = (await gcal(env, admin, companyId, "GET", `/calendars/${encodeURIComponent(calendarId)}/events?${params}`))!;
    for (const e of json.items ?? []) {
      const visit = e.extendedProperties?.private?.crewtavo_visit;
      if (typeof visit === "string" && VISIT_ID.test(visit) && e.id === googleEventId(visit)) ids.push(visit);
    }
    page = json.nextPageToken;
  } while (page && ids.length < MAX_EVENTS);
  return ids;
}

/** What's waiting in the outbox for the visits calendar, not counting jobs under way (as enqueue_calendar_push doesn't) or `except`. */
async function waiting(admin: Db, companyId: string, except?: number) {
  const { data, error } = await admin
    .from("outbox")
    .select("id, payload, locked_until")
    .match({ company_id: companyId, topic: "calendar.visit" })
    .is("done_at", null)
    .is("dead_at", null);
  if (error) throw new Error(`Couldn't queue visits for Google Calendar: ${error.message}`);
  const now = Date.now();
  const jobs = (data ?? []).filter((row) => row.id !== except && (!row.locked_until || Date.parse(row.locked_until) < now)).map((row) => row.payload as VisitJob);
  return { visits: new Set(jobs.flatMap((job) => job.visit_ids ?? (job.visit_id ? [job.visit_id] : []))), recheck: jobs.some((job) => job.recheck) };
}

async function enqueue(admin: Db, companyId: string, jobs: VisitJob[]) {
  if (!jobs.length) return;
  const { error } = await admin.from("outbox").insert(jobs.map((payload) => ({ company_id: companyId, topic: "calendar.visit", payload })));
  if (error) throw new Error(`Couldn't queue visits for Google Calendar: ${error.message}`);
}

/**
 * Leave visits to the outbox, which tries them again in a few minutes: each on its own, or
 * (`together`) as one batch, so a long list doesn't hold up everything queued after it. Visits
 * already waiting there (outside the job `except`) aren't added again. Returns how many were added.
 */
async function queueVisits(admin: Db, companyId: string, visitIds: string[], { together = false, except }: { together?: boolean; except?: number } = {}) {
  if (!visitIds.length) return 0;
  const { visits } = await waiting(admin, companyId, except);
  const ids = visitIds.filter((id) => !visits.has(id));
  await enqueue(admin, companyId, together && ids.length > 1 ? [{ visit_ids: ids }] : ids.map((id) => ({ visit_id: id })));
  return ids.length;
}

/** Google won't take visits on that calendar: the Apps page says what to do. */
async function refused(admin: Db, companyId: string) {
  await admin.from("integrations").update({ last_error: REFUSED }).match({ company_id: companyId, provider: "google_calendar" });
}

/** A batch's turn: its first hundred visits go, and the rest wait their turn again. One that doesn't go is queued on its own. */
async function pushBatch(env: Env, admin: Db, companyId: string, calendarId: string, ids: string[], jobId?: number) {
  const failed: string[] = [];
  let failedInARow = 0;
  let saved = false;
  for (const id of ids.slice(0, BATCH)) {
    try {
      if ((await pushVisit(env, admin, companyId, calendarId, id)) === "saved") saved = true;
      failedInARow = 0;
    } catch (err) {
      // Google refused the sign-in, or visits were turned off: nothing more to send.
      if (!(await visitsCalendar(admin, companyId))) return;
      if (calendarRefused(err)) return refused(admin, companyId);
      // Google is still having trouble: the whole batch tries again later.
      if (++failedInARow === 5) throw err;
      failed.push(id);
    }
  }
  await queueVisits(admin, companyId, failed, { except: jobId });
  await queueVisits(admin, companyId, ids.slice(BATCH), { together: true, except: jobId });
  await pushed(admin, companyId, saved);
}

const UNCHECKED = "Couldn't check what's on Google Calendar, so visits cancelled or deleted lately may still show there. Turn visits off and on again to rebuild it.";

/** Look at the visits calendar again (it couldn't be read last time), and queue the visits on it that aren't upcoming anymore so they come off or move. */
async function recheckVisits(env: Env, admin: Db, companyId: string, calendarId: string) {
  const days = await upcoming(admin, companyId);
  let listed: string[];
  try {
    listed = await visitsOnGoogle(env, admin, companyId, calendarId, days);
  } catch (err) {
    if (!(await visitsCalendar(admin, companyId))) return;
    if (calendarRefused(err)) return refused(admin, companyId);
    console.error("Couldn't read the visits calendar", err);
    throw new IntegrationError(UNCHECKED); // on the Apps page if it never works
  }
  const current = new Set(days.visits);
  await queueVisits(admin, companyId, listed.filter((id) => !current.has(id)), { together: true });
}

/**
 * Bring the visits calendar in line with the schedule from last week through the next six months:
 * when visits start going to Google, and after it's reconnected (changes made while it needed
 * reconnecting weren't queued). Events for visits cancelled, deleted, unscheduled or moved away
 * meanwhile, whatever their date, are found on Google and brought in line too. What Google doesn't take now is left to
 * the outbox and the rest still go; if the calendar can't be read now, the outbox looks again later.
 */
export async function pushUpcomingVisits(env: Env, admin: Db, companyId: string) {
  const calendarId = await visitsCalendar(admin, companyId);
  if (!calendarId) return { pushed: 0, queued: 0 };
  const days = await upcoming(admin, companyId);
  let onGoogle: string[] = [];
  let recheck = false;
  try {
    onGoogle = await visitsOnGoogle(env, admin, companyId, calendarId, days);
  } catch (err) {
    if (!(await visitsCalendar(admin, companyId))) return { pushed: 0, queued: 0 };
    if (calendarRefused(err)) {
      await refused(admin, companyId);
      return { pushed: 0, queued: 0 };
    }
    console.error("Couldn't read the visits calendar", err);
    recheck = true;
  }
  const ids = [...new Set([...days.visits, ...onGoogle])];
  const retry: string[] = [];
  let pushed = 0;
  let failedInARow = 0;
  for (const [i, id] of ids.entries()) {
    // Stop if visits were turned off or Google was disconnected meanwhile.
    if (i % 50 === 0 && i > 0 && !(await visitsCalendar(admin, companyId))) return { pushed, queued: 0 };
    try {
      await pushVisit(env, admin, companyId, calendarId, id);
      pushed++;
      failedInARow = 0;
    } catch (err) {
      // Google refused the sign-in (gcal and accessToken mark it), or visits were turned off: nothing more to send.
      if (!(await visitsCalendar(admin, companyId))) return { pushed, queued: 0 };
      // Nor when the calendar won't take any: the outbox would only fail them all again.
      if (calendarRefused(err)) {
        await refused(admin, companyId);
        return { pushed, queued: 0 };
      }
      console.error("Couldn't put a visit on Google Calendar", id, err);
      retry.push(id);
      // Google is having trouble: the outbox takes the rest, as one batch.
      if (++failedInARow === 5) {
        retry.push(...ids.slice(i + 1));
        break;
      }
    }
  }
  const queued = await queueVisits(admin, companyId, retry, { together: true });
  if (recheck && !(await waiting(admin, companyId)).recheck) await enqueue(admin, companyId, [{ recheck: true }]);
  await admin.from("integrations").update({ last_sync_at: new Date().toISOString(), last_error: null }).match({ company_id: companyId, provider: "google_calendar" });
  return { pushed, queued };
}
