/**
 * Reading iCalendar (RFC 5545) feeds: the private ICS links that Zoho Calendar, Outlook, iCloud,
 * Google and most other calendars publish. Repeating events are expanded inside a window, with
 * their exceptions (EXDATE, moved or cancelled instances), in each event's own time zone.
 *
 * Time zones come from the TZID when it's an IANA name ("America/Chicago", what Zoho, Google and
 * iCloud write), a Windows name ("Central Standard Time", what Outlook writes), or the file's own
 * VTIMEZONE rules. Times with no zone at all are read in the company's zone.
 */
import { RRule } from "rrule";
import { addDays, zoneOffsetMs } from "./time";

export interface IcsItem {
  /** Stable for each instance across refreshes: the UID, plus the original start for repeats. */
  key: string;
  title: string;
  location: string | null;
  description: string | null;
  url: string | null;
  allDay: boolean;
  /** Timed events: UTC instants (ISO). All-day events: YYYY-MM-DD, end exclusive. */
  start: string;
  end: string;
  /** False when the calendar marks the time as free (TRANSP:TRANSPARENT). */
  busy: boolean;
  tentative: boolean;
}

export interface IcsCalendar {
  name: string | null;
  events: IcsItem[];
  /** More events than `limit` fell in the window; the earliest were kept. */
  truncated: boolean;
}

export interface IcsOptions {
  from: Date;
  to: Date;
  /** IANA zone for times written without one (floating times), and for all-day dates. */
  zone: string;
  limit?: number;
}

const DAY = 86_400_000;
const MAX_REPEATS = 1500;

// ---------------------------------------------------------------------------------------------
// Lines, properties and components
// ---------------------------------------------------------------------------------------------

interface Prop {
  name: string;
  params: Record<string, string>;
  value: string;
}
interface Component {
  type: string;
  props: Prop[];
  children: Component[];
}

function splitOutsideQuotes(text: string, sep: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    if (ch === sep && !quoted) {
      parts.push(current);
      current = "";
    } else current += ch;
  }
  parts.push(current);
  return parts;
}

function parseLine(line: string): Prop | null {
  let quoted = false;
  let colon = -1;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    else if (line[i] === ":" && !quoted) {
      colon = i;
      break;
    }
  }
  if (colon < 1) return null;
  const [rawName = "", ...rawParams] = splitOutsideQuotes(line.slice(0, colon), ";");
  const params: Record<string, string> = {};
  for (const p of rawParams) {
    const eq = p.indexOf("=");
    if (eq > 0) params[p.slice(0, eq).trim().toUpperCase()] = p.slice(eq + 1).trim().replace(/^"(.*)"$/, "$1");
  }
  // Apple writes grouped names ("item1.URL"); the group doesn't matter here.
  return { name: rawName.trim().toUpperCase().replace(/^[^.]*\./, ""), params, value: line.slice(colon + 1) };
}

function parseComponents(text: string): Component[] {
  const lines = text.replace(/^﻿/, "").replace(/\r\n|\r/g, "\n").replace(/\n[ \t]/g, "").split("\n");
  const root: Component = { type: "ROOT", props: [], children: [] };
  const stack: Component[] = [root];
  for (const line of lines) {
    if (!line.trim()) continue;
    const prop = parseLine(line);
    if (!prop) continue;
    const top = stack[stack.length - 1]!;
    if (prop.name === "BEGIN") {
      const child: Component = { type: prop.value.trim().toUpperCase(), props: [], children: [] };
      top.children.push(child);
      stack.push(child);
    } else if (prop.name === "END") {
      if (stack.length > 1) stack.pop();
    } else top.props.push(prop);
  }
  return root.children;
}

const first = (c: Component, name: string) => c.props.find((p) => p.name === name);
const all = (c: Component, name: string) => c.props.filter((p) => p.name === name);

function unescapeText(value: string): string {
  return value.replace(/\\([\\;,nN])/g, (_, ch: string) => (ch === "n" || ch === "N" ? "\n" : ch));
}

function text(c: Component, name: string, max: number): string | null {
  const prop = first(c, name);
  if (!prop) return null;
  const value = unescapeText(prop.value).trim();
  return value ? value.slice(0, max) : null;
}

// ---------------------------------------------------------------------------------------------
// Dates, times and durations
// ---------------------------------------------------------------------------------------------

/** A DATE, a UTC DATE-TIME, or a local wall-clock time (as if it were UTC) in a zone. */
type Stamp = { kind: "date"; date: string } | { kind: "utc"; ms: number } | { kind: "local"; wall: number; tzid: string | null };

function readValue(value: string, tzid: string | null): Stamp | null {
  const v = value.trim();
  const d = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (d) return { kind: "date", date: `${d[1]}-${d[2]}-${d[3]}` };
  const t = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/i.exec(v);
  if (!t) return null;
  const ms = Date.UTC(Number(t[1]), Number(t[2]) - 1, Number(t[3]), Number(t[4]), Number(t[5]), Number(t[6] ?? 0));
  if (Number.isNaN(ms)) return null;
  return t[7] ? { kind: "utc", ms } : { kind: "local", wall: ms, tzid };
}

function readStamp(prop: Prop | undefined): Stamp | null {
  return prop ? readValue(prop.value, prop.params.TZID ?? null) : null;
}

/** EXDATE and RDATE can hold several comma-separated values. */
function readStamps(props: Prop[]): Stamp[] {
  return props.flatMap((p) => (p.params.VALUE === "PERIOD" ? [] : p.value.split(",").map((v) => readValue(v, p.params.TZID ?? null)))).filter((s): s is Stamp => s !== null);
}

/** "P1DT2H30M" -> milliseconds. */
function readDuration(value: string | undefined): number | null {
  if (!value) return null;
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i.exec(value.trim());
  if (!m) return null;
  const ms = (Number(m[2] ?? 0) * 7 + Number(m[3] ?? 0)) * DAY + Number(m[4] ?? 0) * 3_600_000 + Number(m[5] ?? 0) * 60_000 + Number(m[6] ?? 0) * 1000;
  return m[1] === "-" ? -ms : ms;
}

/** "+0530" -> milliseconds. */
function readOffset(value: string | undefined): number {
  const m = /^([+-])(\d{2})(\d{2})(\d{2})?$/.exec(value?.trim() ?? "");
  if (!m) return 0;
  const ms = Number(m[2]) * 3_600_000 + Number(m[3]) * 60_000 + Number(m[4] ?? 0) * 1000;
  return m[1] === "-" ? -ms : ms;
}

const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const dateMs = (date: string) => Date.parse(`${date}T00:00:00Z`);

// ---------------------------------------------------------------------------------------------
// Time zones
// ---------------------------------------------------------------------------------------------

interface Zone {
  /** Local wall-clock time (as if UTC) -> the UTC instant. */
  toUtc(wall: number): number;
  /** UTC instant -> local wall-clock time (as if UTC). */
  toWall(utc: number): number;
}

const UTC_ZONE: Zone = { toUtc: (w) => w, toWall: (u) => u };

const validZones = new Map<string, boolean>();
export function isIanaZone(name: string): boolean {
  let ok = validZones.get(name);
  if (ok === undefined) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: name });
      ok = true;
    } catch {
      ok = false;
    }
    validZones.set(name, ok);
  }
  return ok;
}

function ianaZone(name: string): Zone {
  return {
    toUtc(wall) {
      // Two passes settle the hour around daylight-saving changes (as zonedTimeToUtc does).
      let result = wall - zoneOffsetMs(new Date(wall), name);
      result = wall - zoneOffsetMs(new Date(result), name);
      return result;
    },
    toWall: (utc) => utc + zoneOffsetMs(new Date(utc), name),
  };
}

/** The Windows zone names Outlook and Exchange write, for the places our customers are likeliest to be. */
const WINDOWS_ZONES: Record<string, string> = {
  "Dateline Standard Time": "Etc/GMT+12",
  "Hawaiian Standard Time": "Pacific/Honolulu",
  "Alaskan Standard Time": "America/Anchorage",
  "Pacific Standard Time": "America/Los_Angeles",
  "Pacific Standard Time (Mexico)": "America/Tijuana",
  "US Mountain Standard Time": "America/Phoenix",
  "Mountain Standard Time": "America/Denver",
  "Mountain Standard Time (Mexico)": "America/Mazatlan",
  "Central Standard Time": "America/Chicago",
  "Central Standard Time (Mexico)": "America/Mexico_City",
  "Canada Central Standard Time": "America/Regina",
  "Central America Standard Time": "America/Guatemala",
  "Eastern Standard Time": "America/New_York",
  "Eastern Standard Time (Mexico)": "America/Cancun",
  "US Eastern Standard Time": "America/Indiana/Indianapolis",
  "SA Pacific Standard Time": "America/Bogota",
  "Atlantic Standard Time": "America/Halifax",
  "Newfoundland Standard Time": "America/St_Johns",
  "Pacific SA Standard Time": "America/Santiago",
  "E. South America Standard Time": "America/Sao_Paulo",
  "Argentina Standard Time": "America/Argentina/Buenos_Aires",
  "UTC": "UTC",
  "Coordinated Universal Time": "UTC",
  "GMT Standard Time": "Europe/London",
  "Greenwich Standard Time": "Atlantic/Reykjavik",
  "W. Europe Standard Time": "Europe/Berlin",
  "Romance Standard Time": "Europe/Paris",
  "Central Europe Standard Time": "Europe/Budapest",
  "Central European Standard Time": "Europe/Warsaw",
  "E. Europe Standard Time": "Europe/Chisinau",
  "GTB Standard Time": "Europe/Bucharest",
  "FLE Standard Time": "Europe/Kiev",
  "Turkey Standard Time": "Europe/Istanbul",
  "Russian Standard Time": "Europe/Moscow",
  "South Africa Standard Time": "Africa/Johannesburg",
  "Egypt Standard Time": "Africa/Cairo",
  "Israel Standard Time": "Asia/Jerusalem",
  "Arabian Standard Time": "Asia/Dubai",
  "Arab Standard Time": "Asia/Riyadh",
  "Pakistan Standard Time": "Asia/Karachi",
  "India Standard Time": "Asia/Kolkata",
  "SE Asia Standard Time": "Asia/Bangkok",
  "China Standard Time": "Asia/Shanghai",
  "Singapore Standard Time": "Asia/Singapore",
  "Taipei Standard Time": "Asia/Taipei",
  "Tokyo Standard Time": "Asia/Tokyo",
  "Korea Standard Time": "Asia/Seoul",
  "W. Australia Standard Time": "Australia/Perth",
  "AUS Central Standard Time": "Australia/Darwin",
  "Cen. Australia Standard Time": "Australia/Adelaide",
  "E. Australia Standard Time": "Australia/Brisbane",
  "AUS Eastern Standard Time": "Australia/Sydney",
  "Tasmania Standard Time": "Australia/Hobart",
  "New Zealand Standard Time": "Pacific/Auckland",
};

interface Observance {
  start: number; // wall time of the first onset
  from: number;
  to: number;
  rule: RRule | null;
  dates: number[]; // RDATE onsets (wall)
}

/** A zone from the file's own VTIMEZONE: the latest STANDARD or DAYLIGHT onset decides the offset. */
function vtimezone(component: Component): Zone | null {
  const observances: Observance[] = [];
  for (const c of component.children) {
    if (c.type !== "STANDARD" && c.type !== "DAYLIGHT") continue;
    const start = readStamp(first(c, "DTSTART"));
    if (!start || start.kind === "date") continue;
    const wall = start.kind === "utc" ? start.ms : start.wall;
    const from = readOffset(first(c, "TZOFFSETFROM")?.value);
    const to = readOffset(first(c, "TZOFFSETTO")?.value);
    let rule: RRule | null = null;
    const rrule = first(c, "RRULE")?.value;
    if (rrule) rule = buildRule(rrule, wall, (utc) => utc + from);
    const dates = readStamps(all(c, "RDATE")).map((s) => (s.kind === "local" ? s.wall : s.kind === "utc" ? s.ms + from : dateMs(s.date)));
    observances.push({ start: wall, from, to, rule, dates });
  }
  if (!observances.length) return null;
  const earliest = observances.reduce((a, b) => (b.start < a.start ? b : a));

  /** Offset in force at a moment: the latest onset at or before it wins. */
  const offsetAt = (moment: number, shift: (o: Observance) => number) => {
    let best: { at: number; to: number } | null = null;
    for (const o of observances) {
      const limit = moment + shift(o);
      const onsets = [o.start, ...o.dates].filter((d) => d <= limit);
      const fromRule = o.rule?.before(new Date(limit), true);
      if (fromRule) onsets.push(fromRule.getTime());
      for (const onset of onsets) {
        const at = onset - shift(o);
        if (!best || at > best.at) best = { at, to: o.to };
      }
    }
    return best ? best.to : earliest.from;
  };
  const cache = new Map<string, number>();
  const memo = (kind: string, moment: number, shift: (o: Observance) => number) => {
    const k = `${kind}${Math.floor(moment / 3_600_000)}`;
    let v = cache.get(k);
    if (v === undefined) {
      v = offsetAt(moment, shift);
      if (cache.size > 5000) cache.clear();
      cache.set(k, v);
    }
    return v;
  };
  return {
    toUtc: (wall) => wall - memo("w", wall, () => 0),
    // An onset's UTC instant is its wall time minus the offset before it.
    toWall: (utc) => utc + memo("u", utc, (o) => o.from),
  };
}

function zoneResolver(components: Component[], fallback: string) {
  const definitions = new Map<string, Component>();
  for (const c of components) if (c.type === "VTIMEZONE") {
    const id = first(c, "TZID")?.value.trim();
    if (id) definitions.set(id, c);
  }
  const cache = new Map<string, Zone>();
  const fallbackZone = isIanaZone(fallback) ? ianaZone(fallback) : UTC_ZONE;
  return (tzid: string | null): Zone => {
    if (!tzid) return fallbackZone;
    const known = cache.get(tzid);
    if (known) return known;
    const id = tzid.trim();
    const definition = definitions.get(id);
    const location = definition && first(definition, "X-LIC-LOCATION")?.value.trim();
    const pattern = /([A-Za-z]+\/[A-Za-z_+-]+(?:\/[A-Za-z_+-]+)?)$/.exec(id)?.[1];
    let zone: Zone | null = null;
    if (isIanaZone(id)) zone = ianaZone(id);
    else if (WINDOWS_ZONES[id]) zone = ianaZone(WINDOWS_ZONES[id]!);
    else if (location && isIanaZone(location)) zone = ianaZone(location);
    else if (definition) zone = vtimezone(definition);
    if (!zone && pattern && isIanaZone(pattern)) zone = ianaZone(pattern);
    zone ??= fallbackZone;
    cache.set(tzid, zone);
    return zone;
  };
}

// ---------------------------------------------------------------------------------------------
// Repeats
// ---------------------------------------------------------------------------------------------

// Calendars repeat daily at most; faster rules would take ages to expand from a start years ago.
const SLOW_ENOUGH = /^FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)$/i;
const RULE_PARTS = new Set(["FREQ", "UNTIL", "COUNT", "INTERVAL", "BYSECOND", "BYMINUTE", "BYHOUR", "BYDAY", "BYMONTHDAY", "BYYEARDAY", "BYWEEKNO", "BYMONTH", "BYSETPOS", "WKST"]);

/**
 * An RRULE expanded in wall-clock time: dtstart is the local start as if it were UTC, so "every
 * Monday at 9" stays at 9 across daylight-saving changes. A UTC UNTIL is moved into the same frame.
 */
function buildRule(raw: string, dtstartWall: number, untilToWall: (utc: number) => number): RRule | null {
  const parts = raw
    .replace(/^RRULE:/i, "")
    .split(";")
    .map((p) => p.trim())
    .filter((p) => RULE_PARTS.has(p.split("=")[0]!.toUpperCase()));
  if (!parts.some((p) => SLOW_ENOUGH.test(p))) return null;
  let untilWall: number | undefined;
  const untilPart = parts.find((p) => /^UNTIL=/i.test(p));
  if (untilPart) {
    const stamp = readValue(untilPart.slice(6), null);
    if (stamp?.kind === "utc") untilWall = untilToWall(stamp.ms);
    else if (stamp?.kind === "local") untilWall = stamp.wall;
    else if (stamp?.kind === "date") untilWall = dateMs(stamp.date) + DAY - 1000; // through the end of that day
  }
  try {
    const options = RRule.parseString(parts.filter((p) => !/^UNTIL=/i.test(p)).join(";"));
    return new RRule({ ...options, dtstart: new Date(dtstartWall), until: untilWall === undefined ? null : new Date(untilWall), tzid: null });
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------------------------

/** Keys use the instance's original start: a date, or a UTC instant (held as ms while matching). */
const keyName = (key: string) => (/^\d+$/.test(key) ? new Date(Number(key)).toISOString() : key);

/** Descriptions from Google and Outlook are often HTML; keep the words and line breaks. */
export function plainText(value: string | null): string | null {
  if (!value || !/<[a-z][\s\S]*>/i.test(value)) return value;
  const out = value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h\d)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return out || null;
}

interface Instance {
  allDay: boolean;
  start: number; // UTC ms (timed) or date ms (all-day)
  end: number;
}

/** A stamp as UTC ms (or a date's ms) and its local date; `zoneOf` resolves local times. */
function identity(stamp: Stamp, zoneOf: (tzid: string | null) => Zone): { ms: number; date: string } {
  if (stamp.kind === "date") return { ms: dateMs(stamp.date), date: stamp.date };
  const ms = stamp.kind === "utc" ? stamp.ms : zoneOf(stamp.tzid).toUtc(stamp.wall);
  return { ms, date: stamp.kind === "local" ? isoDate(stamp.wall) : isoDate(ms) };
}

export function parseIcs(input: string, options: IcsOptions): IcsCalendar {
  const components = parseComponents(input);
  const calendar = components.find((c) => c.type === "VCALENDAR") ?? { type: "VCALENDAR", props: [], children: components };
  const zoneOf = zoneResolver(calendar.children, options.zone);
  const floating = zoneOf(null);
  const from = options.from.getTime();
  const to = options.to.getTime();
  const fromDate = isoDate(floating.toWall(from));
  const toDate = isoDate(floating.toWall(to));
  const limit = options.limit ?? 5000;

  // Group by UID: the series itself, plus instances that were moved or cancelled.
  const series = new Map<string, { master: Component | null; overrides: Component[] }>();
  let anonymous = 0;
  for (const event of calendar.children) {
    if (event.type !== "VEVENT") continue;
    const uid = first(event, "UID")?.value.trim() || `no-uid-${anonymous++}-${first(event, "DTSTART")?.value ?? ""}-${first(event, "SUMMARY")?.value ?? ""}`;
    const entry = series.get(uid) ?? { master: null, overrides: [] };
    if (first(event, "RECURRENCE-ID")) entry.overrides.push(event);
    else entry.master = event;
    series.set(uid, entry);
  }

  const items: IcsItem[] = [];
  const inWindow = (i: Instance) =>
    i.allDay ? isoDate(i.end) > fromDate && isoDate(i.start) <= toDate : (i.end > from && i.start < to) || (i.start === i.end && i.start >= from && i.start < to);

  const describe = (event: Component, key: string, instance: Instance): IcsItem => {
    const transp = first(event, "TRANSP")?.value.trim().toUpperCase();
    const msBusy = first(event, "X-MICROSOFT-CDO-BUSYSTATUS")?.value.trim().toUpperCase();
    const url = text(event, "URL", 1000);
    return {
      key,
      title: text(event, "SUMMARY", 200) ?? "Busy",
      location: text(event, "LOCATION", 300),
      description: plainText(text(event, "DESCRIPTION", 4000))?.slice(0, 2000) ?? null,
      url: url && /^https?:\/\//i.test(url) ? url : null,
      allDay: instance.allDay,
      start: instance.allDay ? isoDate(instance.start) : new Date(instance.start).toISOString(),
      end: instance.allDay ? isoDate(instance.end) : new Date(instance.end).toISOString(),
      busy: transp !== "TRANSPARENT" && msBusy !== "FREE",
      tentative: first(event, "STATUS")?.value.trim().toUpperCase() === "TENTATIVE",
    };
  };

  /** One event's own start and end (no repeats). */
  const single = (event: Component): (Instance & { zone: Zone; startWall: number; length: number }) | null => {
    const start = readStamp(first(event, "DTSTART"));
    if (!start) return null;
    const end = readStamp(first(event, "DTEND"));
    const duration = readDuration(first(event, "DURATION")?.value);
    if (start.kind === "date") {
      const s = dateMs(start.date);
      const e = end?.kind === "date" ? dateMs(end.date) : duration !== null ? s + Math.max(DAY, Math.round(duration / DAY) * DAY) : s + DAY;
      return { allDay: true, start: s, end: Math.max(e, s + DAY), zone: UTC_ZONE, startWall: s, length: Math.max(e, s + DAY) - s };
    }
    const zone = start.kind === "utc" ? UTC_ZONE : zoneOf(start.tzid);
    const startWall = start.kind === "utc" ? start.ms : start.wall;
    let endWall = startWall;
    if (end && end.kind !== "date") endWall = zone.toWall(identity(end, zoneOf).ms);
    else if (end?.kind === "date") endWall = dateMs(end.date);
    else if (duration !== null) endWall = startWall + duration;
    const length = Math.max(0, endWall - startWall);
    return { allDay: false, start: zone.toUtc(startWall), end: zone.toUtc(startWall + length), zone, startWall, length };
  };

  for (const [uid, { master, overrides }] of series) {
    const base = master ? single(master) : null;
    // Exceptions and exclusions written without a zone belong to the series' zone.
    const zoneFor = (tzid: string | null) => (tzid || !base ? zoneOf(tzid) : base.zone);
    const moved = new Map<string, Component>();
    for (const o of overrides) {
      const rid = readStamp(first(o, "RECURRENCE-ID"));
      if (rid) moved.set(rid.kind === "date" ? rid.date : String(identity(rid, zoneFor).ms), o);
    }
    const emitOverride = (key: string, o: Component) => {
      if (first(o, "STATUS")?.value.trim().toUpperCase() === "CANCELLED") return;
      const own = single(o);
      if (own && inWindow(own)) items.push(describe(o, `${uid}|${keyName(key)}`, own));
    };

    if (!master || !base) {
      // Only exceptions came through (some servers do this): show them as they are.
      for (const [key, o] of moved) emitOverride(key, o);
      continue;
    }
    if (first(master, "STATUS")?.value.trim().toUpperCase() === "CANCELLED") continue;
    const rrule = first(master, "RRULE")?.value;
    const rule = rrule ? buildRule(rrule, base.startWall, base.zone.toWall) : null;
    const extra = readStamps(all(master, "RDATE"));
    if (!rule && !extra.length) {
      if (inWindow(base)) items.push(describe(master, uid, base));
      for (const [key, o] of moved) emitOverride(key, o);
      continue;
    }

    const skip = new Set<string>();
    for (const ex of readStamps(all(master, "EXDATE"))) {
      const id = identity(ex, zoneFor);
      skip.add(ex.kind === "date" ? ex.date : String(id.ms));
      if (ex.kind === "date") skip.add(`d${ex.date}`); // a date EXDATE on a timed series removes that day
    }

    const walls = new Set<number>([base.startWall]);
    if (rule) {
      const lo = base.zone.toWall(from) - base.length - 2 * DAY;
      const hi = base.zone.toWall(to) + 2 * DAY;
      rule.between(new Date(lo), new Date(hi), true, (_, i) => i < MAX_REPEATS).forEach((d) => walls.add(d.getTime()));
    }
    for (const r of extra) walls.add(r.kind === "date" ? dateMs(r.date) : base.zone.toWall(identity(r, zoneFor).ms));

    const emitted = new Set<string>();
    for (const wall of [...walls].sort((a, b) => a - b)) {
      const instance: Instance = base.allDay
        ? { allDay: true, start: wall, end: wall + base.length }
        : { allDay: false, start: base.zone.toUtc(wall), end: base.zone.toUtc(wall + base.length) };
      const key = base.allDay ? isoDate(wall) : String(instance.start);
      if (skip.has(key) || (!base.allDay && skip.has(`d${isoDate(wall)}`))) continue;
      emitted.add(key);
      const override = moved.get(key);
      if (override) emitOverride(key, override);
      else if (inWindow(instance)) items.push(describe(master, `${uid}|${keyName(key)}`, instance));
    }
    // Instances moved here from a start outside the expanded range.
    for (const [key, o] of moved) if (!emitted.has(key) && !skip.has(key)) emitOverride(key, o);
  }

  items.sort((a, b) => (a.allDay ? `${a.start}T00:00:00.000Z` : a.start).localeCompare(b.allDay ? `${b.start}T00:00:00.000Z` : b.start));
  const name = first(calendar, "X-WR-CALNAME");
  return { name: name ? unescapeText(name.value).trim().slice(0, 80) || null : null, events: items.slice(0, limit), truncated: items.length > limit };
}

/** The local dates an event covers (inclusive), for finding it by day. */
export function eventDays(item: Pick<IcsItem, "allDay" | "start" | "end">, zone: string): { starts_on: string; ends_on: string } {
  if (item.allDay) return { starts_on: item.start, ends_on: item.end > item.start ? addDays(item.end, -1) : item.start };
  const z = isIanaZone(zone) ? ianaZone(zone) : UTC_ZONE;
  const start = Date.parse(item.start);
  const end = Math.max(start, Date.parse(item.end) - 1); // an event ending at midnight doesn't cover the next day
  return { starts_on: isoDate(z.toWall(start)), ends_on: isoDate(z.toWall(end)) };
}

/** Is this a calendar file at all? (A login page or an error comes back as HTML.) */
export function looksLikeIcs(input: string): boolean {
  return /^﻿?\s*BEGIN:VCALENDAR/i.test(input);
}
