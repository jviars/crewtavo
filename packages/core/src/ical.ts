/**
 * Reading iCalendar (RFC 5545) feeds: the private ICS links that Zoho Calendar, Outlook, iCloud,
 * Google and most other calendars publish. Repeating events are expanded inside a window, with
 * their exceptions (EXDATE, moved or cancelled instances), in each event's own time zone.
 *
 * Time zones come from the TZID when it's an IANA name ("America/Chicago", what Zoho, Google and
 * iCloud write), a Windows name ("Central Standard Time", what Outlook writes), or the file's own
 * VTIMEZONE rules. Times with no zone at all are read in the company's zone.
 *
 * A feed is written by someone else and read on the server's only thread, so the work is bounded:
 * rules that repeat more than hourly are ignored, repeats are worked out from just before the
 * window rather than from a start years ago, a file gets a fixed amount of work for its repeats,
 * and an event that can't be read is left out instead of failing the whole calendar.
 */
import { RRule, type Options, type Weekday } from "rrule";
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
  /** More events than `limit` fell in the window (the earliest were kept), or the work ran out. */
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
/** Hourly at most: calendars repeat a few times a day (BYHOUR=9,17), and every minute or second isn't an event. */
const MAX_PER_DAY = 24;
/** The last moment there is here (years have four digits). DURATION:P99999999W ends there instead of past it. */
const END_OF_TIME = Date.UTC(9999, 11, 31, 23, 59, 59);
/** A repeat that steps further than a century at a time isn't one (INTERVAL=999999999999). */
const MAX_STEP = 100 * 366 * DAY;
/** Different time zones one file may use; real calendars use a handful. */
const MAX_ZONES = 1000;

/**
 * Work allowed for repeats, roughly in microseconds: for a whole file's events, for one event's
 * repeats, for a whole file's VTIMEZONE rules and for one of them. Zones have their own, so an
 * event's times don't depend on how many repeats came before it. Real calendars use a small part
 * of it. A file built to keep the server busy runs out, and keeps what was found by then.
 */
const FILE_WORK = 300_000;
const SERIES_WORK = 50_000;
const ZONE_WORK = 300_000;
const OBSERVANCE_WORK = 20_000;
/** Setting up a walk through a rule costs about as much as a period of it. */
const WALK_COST = 5;

interface Work {
  left: number;
  /** Some repeats were left out because the work ran out. */
  short?: boolean;
}

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
  let start = 0;
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') quoted = !quoted;
    else if (text[i] === sep && !quoted) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

/** Most lines have no parameters; they share this rather than each making an empty one. */
const NO_PARAMS: Record<string, string> = Object.freeze({});

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
  const head = line.slice(0, colon);
  const [rawName = "", ...rawParams] = head.includes(";") ? splitOutsideQuotes(head, ";") : [head];
  const params: Record<string, string> = rawParams.length ? {} : NO_PARAMS;
  for (const p of rawParams) {
    const eq = p.indexOf("=");
    if (eq > 0) params[p.slice(0, eq).trim().toUpperCase()] = p.slice(eq + 1).trim().replace(/^"(.*)"$/, "$1");
  }
  const name = rawName.trim().toUpperCase();
  // Apple writes grouped names ("item1.URL"); the group doesn't matter here.
  return { name: name.includes(".") ? name.replace(/^[^.]*\./, "") : name, params, value: line.slice(colon + 1) };
}

/** Half of an emoji (a surrogate pair) on its own: Postgres won't take the JSON it ends up in. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

function parseComponents(text: string): Component[] {
  const lines = text.replace(LONE_SURROGATE, "").replace(/^﻿/, "").replace(/\r\n|\r/g, "\n").replace(/\n[ \t]/g, "").split("\n");
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
  // Escaped backslashes first, so "\\n" stays a backslash and an n. No callback: with millions of
  // escapes, one per match is slow.
  return value
    .split("\\\\")
    .map((part) => part.replace(/\\[nN]/g, "\n").replace(/\\([;,])/g, "$1"))
    .join("\\");
}

/** At most `max` UTF-16 units, without cutting an emoji in half. */
function clip(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, /[\ud800-\udbff]/.test(value[max - 1]!) ? max - 1 : max);
}

/** Spaces and escaped line breaks, which trimming removes once unescaped. */
const BLANK = /(?:\s|\\[nN])*/y;
/** Where the blanks starting at `from` end. */
function blankTo(value: string, from: number): number {
  BLANK.lastIndex = from;
  return BLANK.exec(value) ? BLANK.lastIndex : from;
}

function text(c: Component, name: string, max: number): string | null {
  const prop = first(c, name);
  if (!prop) return null;
  const raw = prop.value;
  // Only the start is kept, so only the start is unescaped (an escape is two characters, and one
  // cut in half is taken whole). Its end is trimmed only when nothing but blanks come after it.
  const lead = blankTo(raw, 0);
  let end = Math.min(raw.length, lead + 2 * max + 2);
  let slashes = 0;
  while (end - slashes > lead && raw[end - slashes - 1] === "\\") slashes++;
  if (slashes % 2) end++;
  const value = unescapeText(raw.slice(lead, end));
  const trimmed = end >= raw.length || blankTo(raw, end) === raw.length ? value.trimEnd() : value;
  return trimmed ? clip(trimmed, max) : null;
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
const yearOf = (ms: number) => new Date(ms).getUTCFullYear();
const yearStart = (year: number) => new Date(0).setUTCFullYear(year, 0, 1);

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
  // No zone name has a space in it ("Customized Time Zone 12"), and asking Intl about one is slow.
  if (/\s/.test(name)) return false;
  let ok = validZones.get(name);
  if (ok === undefined) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: name });
      ok = true;
    } catch {
      ok = false;
    }
    if (validZones.size >= 10_000) validZones.clear();
    validZones.set(name, ok);
  }
  return ok;
}

function ianaZone(name: string, offset = (utc: number) => zoneOffsetMs(new Date(utc), name)): Zone {
  return {
    toUtc(wall) {
      // Two passes settle the hour around daylight-saving changes (as zonedTimeToUtc does).
      let result = wall - offset(wall);
      result = wall - offset(result);
      return result;
    },
    toWall: (utc) => utc + offset(utc),
  };
}

/**
 * A zone's offset, looked up once a day: it changes a couple of times a year, so a day with the
 * same offset at both ends has it all day. A day with a change in it is looked up exactly.
 */
function dailyOffsets(name: string): (utc: number) => number {
  const days = new Map<number, number | null>();
  return (utc) => {
    const day = Math.floor(utc / DAY);
    let offset = days.get(day);
    if (offset === undefined) {
      const start = zoneOffsetMs(new Date(day * DAY), name);
      offset = start === zoneOffsetMs(new Date(day * DAY + DAY - 1000), name) ? start : null;
      if (days.size >= 20_000) days.clear();
      days.set(day, offset);
    }
    return offset ?? zoneOffsetMs(new Date(utc), name);
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
  rule: Rule | null;
  /** DTSTART and RDATE onsets (wall), in order. */
  fixed: number[];
  /** The rule's onsets in each year (wall), worked out the first time a year is needed. */
  years: Map<number, number[]>;
  work: Work;
}

/**
 * An onset, at the moment it falls when looking by wall time or by UTC instant. `rank` is its
 * place in the file (an observance's DTSTART and RDATEs, then its rule), which settles ties.
 */
interface Change {
  at: number;
  to: number;
  rank: number;
}

/** In order of time; of changes at the same moment, the one first in the file goes last. */
const inOrder = (changes: Change[]) => changes.sort((a, b) => a.at - b.at || b.rank - a.rank);

/** The last change at or before `moment`, from a list in order. */
function changeAt(changes: Change[], moment: number): Change | null {
  let lo = 0;
  let hi = changes.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (changes[mid]!.at <= moment) lo = mid + 1;
    else hi = mid;
  }
  return lo ? changes[lo - 1]! : null;
}

/** The later of two changes; of two at the same moment, the one first in the file. */
const later = (a: Change | null, b: Change | null) => (!a || (b && (b.at > a.at || (b.at === a.at && b.rank < a.rank))) ? b : a);

/** A zone from the file's own VTIMEZONE: the latest STANDARD or DAYLIGHT onset decides the offset. */
function vtimezone(component: Component, work: Work): Zone | null {
  const observances: Observance[] = [];
  for (const c of component.children) {
    if (c.type !== "STANDARD" && c.type !== "DAYLIGHT") continue;
    const start = readStamp(first(c, "DTSTART"));
    if (!start || start.kind === "date") continue;
    const wall = start.kind === "utc" ? start.ms : start.wall;
    const from = readOffset(first(c, "TZOFFSETFROM")?.value);
    const to = readOffset(first(c, "TZOFFSETTO")?.value);
    const own: Work = { left: OBSERVANCE_WORK };
    const rrule = first(c, "RRULE")?.value;
    let rule = rrule ? buildRule(rrule, wall, (utc) => utc + from) : null;
    if (rule && rule.count !== null) {
      // Where a COUNT runs out is an UNTIL, and with one, onsets are found without walking from DTSTART.
      const onsets = expand(rule, rule.dtstart, END_OF_TIME, rule.count, work, { left: OBSERVANCE_WORK });
      if (!onsets.length) rule = null;
      else rule = { ...rule, count: null, until: onsets.length === rule.count ? onsets[onsets.length - 1]! : rule.until };
    }
    const dates = readStamps(all(c, "RDATE")).map((s) => (s.kind === "local" ? s.wall : s.kind === "utc" ? s.ms + from : dateMs(s.date)));
    // In order, they go into the zone's list of changes quickly. A zone changes a few times a year,
    // so more than an event's repeats is a file built to be slow: the latest are kept.
    observances.push({ start: wall, from, to, rule, fixed: [wall, ...dates].sort((a, b) => a - b).slice(-MAX_REPEATS), years: new Map(), work: own });
  }
  if (!observances.length) return null;
  const earliest = observances.reduce((a, b) => (b.start < a.start ? b : a));
  const ruled = observances.flatMap((o, i) => (o.rule ? [{ o, rule: o.rule, rank: 2 * i + 1 }] : []));
  const firstYear = ruled.reduce((year, { rule }) => Math.min(year, yearOf(rule.dtstart)), Infinity) - 1;

  /** A rule's onsets in a year (wall times), or null when the work ran out before the year was done. */
  const onsetsIn = (o: Observance, rule: Rule, year: number): number[] | null => {
    let onsets = o.years.get(year);
    if (!onsets) {
      if (o.work.left <= 0 || work.left <= 0) return null;
      onsets = expand(rule, yearStart(year), yearStart(year + 1) - 1, Infinity, work, o.work);
      if (o.work.left <= 0 || work.left <= 0) return null;
      o.years.set(year, onsets);
    }
    return onsets;
  };

  /**
   * The offset in force at a moment, looking by wall time (shift 0) or by UTC instant (an onset's
   * UTC instant is its wall time minus the offset before it). Every observance's onsets go in one
   * list, so a lookup is one search however many there are. Rules go on forever, so theirs are
   * worked out a year at a time, the first time a year is needed. (Outlook's rules start in 1601;
   * walking from there for each event's hour took seconds.)
   */
  const offsets = (shift: (o: Observance) => number) => {
    const fixed = inOrder(observances.flatMap((o, i) => o.fixed.map((onset) => ({ at: onset - shift(o), to: o.to, rank: 2 * i }))));
    const years = new Map<number, Change[] | null>();
    /** The rules' changes that fall in a year, or null once the work has run out. */
    const changesIn = (year: number): Change[] | null => {
      let changes = years.get(year);
      if (changes !== undefined) return changes;
      // Each rule is looked at, whether or not it has onsets then.
      work.left -= 3 * ruled.length;
      changes = work.left > 0 ? [] : null;
      const lo = yearStart(year);
      const hi = yearStart(year + 1);
      for (const { o, rule, rank } of ruled) {
        // An onset falls a few hours either side of its wall time, so it can be in the year before or after.
        for (let y = year - 1; y <= year + 1 && changes; y++) {
          const onsets = onsetsIn(o, rule, y);
          if (!onsets) changes = null;
          else
            for (const onset of onsets) {
              const at = onset - shift(o);
              if (at >= lo && at < hi) changes.push({ at, to: o.to, rank });
            }
        }
      }
      if (!changes) work.short = true;
      years.set(year, changes && inOrder(changes));
      return changes;
    };
    /** The rules' latest change before the end of a year, remembered for each year looked at. */
    const latest = new Map<number, Change | null>();
    const latestBy = (year: number): Change | null => {
      const passed: number[] = [];
      let change: Change | null = null;
      for (let y = year; y >= firstYear; y--) {
        const known = latest.get(y);
        if (known !== undefined) {
          change = known;
          break;
        }
        const changes = changesIn(y);
        if (!changes) return null;
        passed.push(y);
        if (changes.length) {
          change = changes[changes.length - 1]!;
          break;
        }
      }
      for (const y of passed) latest.set(y, change);
      return change;
    };
    return (moment: number) => {
      let change = changeAt(fixed, moment);
      if (ruled.length) {
        const year = yearOf(moment);
        const now = changesIn(year);
        change = later(change, (now && changeAt(now, moment)) ?? latestBy(year - 1));
      }
      return change ? change.to : earliest.from;
    };
  };
  const byWall = offsets(() => 0);
  const byUtc = offsets((o) => o.from);
  const cache = new Map<string, number>();
  const memo = (kind: string, moment: number, offsetAt: (moment: number) => number) => {
    const k = `${kind}${Math.floor(moment / 3_600_000)}`;
    let v = cache.get(k);
    if (v === undefined) {
      v = offsetAt(moment);
      if (cache.size > 5000) cache.clear();
      cache.set(k, v);
    }
    return v;
  };
  return {
    toUtc: (wall) => wall - memo("w", wall, byWall),
    toWall: (utc) => utc + memo("u", utc, byUtc),
  };
}

function zoneResolver(components: Component[], fallback: string, work: Work) {
  const definitions = new Map<string, Component>();
  for (const c of components) if (c.type === "VTIMEZONE") {
    const id = first(c, "TZID")?.value.trim();
    if (id) definitions.set(id, c);
  }
  const cache = new Map<string, Zone>();
  const iana = (name: string) => ianaZone(name, dailyOffsets(name));
  const fallbackZone = isIanaZone(fallback) ? iana(fallback) : UTC_ZONE;
  return (tzid: string | null): Zone => {
    if (!tzid) return fallbackZone;
    const known = cache.get(tzid);
    if (known) return known;
    // More zones than any real calendar uses: the rest are read in the company's zone.
    if (cache.size >= MAX_ZONES) return fallbackZone;
    const id = tzid.trim();
    const definition = definitions.get(id);
    const location = definition && first(definition, "X-LIC-LOCATION")?.value.trim();
    // A name ending in one ("/mozilla.org/20050126_1/America/New_York"). The match never starts
    // just after a letter, and saying so keeps a long run of letters from taking ages.
    const pattern = /(?<![A-Za-z])([A-Za-z]+\/[A-Za-z_+-]+(?:\/[A-Za-z_+-]+)?)$/.exec(id)?.[1];
    let zone: Zone | null = null;
    if (isIanaZone(id)) zone = iana(id);
    else if (WINDOWS_ZONES[id]) zone = iana(WINDOWS_ZONES[id]!);
    else if (location && isIanaZone(location)) zone = iana(location);
    else if (definition) {
      try {
        zone = vtimezone(definition, work);
      } catch {
        zone = null; // read as if the file didn't define it
      }
    }
    if (!zone && pattern && isIanaZone(pattern)) zone = iana(pattern);
    zone ??= fallbackZone;
    cache.set(tzid, zone);
    return zone;
  };
}

// ---------------------------------------------------------------------------------------------
// Repeats
// ---------------------------------------------------------------------------------------------

const RULE_PARTS = new Set(["FREQ", "UNTIL", "COUNT", "INTERVAL", "BYSECOND", "BYMINUTE", "BYHOUR", "BYDAY", "BYMONTHDAY", "BYYEARDAY", "BYWEEKNO", "BYMONTH", "BYSETPOS", "WKST"]);
/** The values each list may hold (RFC 5545). Zero isn't one where the list counts from either end. */
const LIST_RANGES: [string, [number, number]][] = [
  ["bysecond", [0, 60]],
  ["byminute", [0, 59]],
  ["byhour", [0, 23]],
  ["bymonthday", [-31, 31]],
  ["byyearday", [-366, 366]],
  ["byweekno", [-53, 53]],
  ["bymonth", [1, 12]],
  ["bysetpos", [-366, 366]],
];

/** A repeat rule, read and checked. Times are wall-clock times as if UTC (see buildRule). */
interface Rule {
  options: Partial<Options>;
  freq: number;
  interval: number;
  count: number | null;
  dtstart: number;
  until: number | null;
  /** The most instances a period can have, and the fewest each has after the first (0 when one can have none). */
  most: number;
  least: number;
  /** Roughly what stepping through one period costs, in the same units as the work allowed. */
  cost: number;
}

/**
 * An RRULE expanded in wall-clock time: dtstart is the local start as if it were UTC, so "every
 * Monday at 9" stays at 9 across daylight-saving changes. A UTC UNTIL is moved into the same frame.
 * Calendars repeat daily at most, a few times a day; faster rules aren't used.
 */
function buildRule(raw: string, dtstartWall: number, untilToWall: (utc: number) => number): Rule | null {
  const parts = raw
    .replace(/^RRULE:/i, "")
    .split(";")
    .map((p) => p.trim())
    .filter((p) => RULE_PARTS.has(p.split("=")[0]!.toUpperCase()));
  // RRule goes by the last FREQ when there are several, so there must be just one.
  if (parts.filter((p) => /^FREQ=/i.test(p)).length !== 1) return null;
  let untilWall: number | null = null;
  const untilPart = parts.find((p) => /^UNTIL=/i.test(p));
  if (untilPart) {
    const stamp = readValue(untilPart.slice(6), null);
    if (stamp?.kind === "utc") untilWall = untilToWall(stamp.ms);
    else if (stamp?.kind === "local") untilWall = stamp.wall;
    else if (stamp?.kind === "date") untilWall = dateMs(stamp.date) + DAY - 1000; // through the end of that day
  }
  if (Number.isNaN(dtstartWall) || Number.isNaN(untilWall)) return null; // a date like the 45th of the 13th month
  let options: Partial<Options>;
  try {
    options = RRule.parseString(parts.filter((p) => !/^UNTIL=/i.test(p)).join(";"));
  } catch {
    return null;
  }
  const { freq, interval = 1, count = null } = options;
  if (freq === undefined || !(freq <= RRule.DAILY) || !Number.isInteger(interval) || interval < 1) return null;
  if (interval * PERIODS[freq]!.shortest * DAY > MAX_STEP) return null;
  if (count !== null && !(Number.isInteger(count) && count >= 0)) return null;
  const lists = options as Record<string, unknown>;
  for (const [name, [min, max]] of LIST_RANGES) {
    if (lists[name] === undefined || lists[name] === null) continue;
    const values: unknown[] = Array.isArray(lists[name]) ? lists[name] : [lists[name]];
    if (!values.every((v) => Number.isInteger(v) && (v as number) >= min && (v as number) <= max && (v !== 0 || min === 0))) return null;
    lists[name] = values.length > 1 ? [...new Set(values)] : values; // a value written twice only doubles the work
  }
  if (options.byweekday !== undefined && options.byweekday !== null) {
    const days = new Map<string, Weekday>();
    for (const day of (Array.isArray(options.byweekday) ? options.byweekday : [options.byweekday]) as (Weekday | undefined)[]) {
      if (typeof day?.weekday !== "number" || (day.n !== undefined && !(Math.abs(day.n) <= 53))) return null;
      days.set(`${day.weekday}:${day.n ?? ""}`, day);
    }
    options.byweekday = [...days.values()];
  }
  const size = (list: unknown) => (list === undefined || list === null ? 0 : Array.isArray(list) ? list.length : 1);
  // One instance for each BYHOUR, BYMINUTE and BYSECOND together on each day it falls on.
  const perDay = (size(options.byhour) || 1) * (size(options.byminute) || 1) * (size(options.bysecond) || 1);
  if (perDay > MAX_PER_DAY) return null;

  // The days a period can have one on. Each list narrows it down; with none, it's DTSTART's day.
  // (BYDAY=2TU is one day a month, or a year in a yearly rule without BYMONTH; daily and weekly rules ignore the 2.)
  const weekdays = (options.byweekday ?? []) as Weekday[];
  const nth = freq <= RRule.MONTHLY ? weekdays.filter((d) => d.n).length : 0;
  const plain = new Set(weekdays.filter((d) => !d.n || freq > RRule.MONTHLY).map((d) => d.weekday)).size;
  const months = size(options.bymonth);
  const { longest, shortest, cost } = PERIODS[freq]!;
  let days = 1;
  if (freq === RRule.WEEKLY) days = plain || 1;
  else if (freq !== RRule.DAILY) {
    const yearly = freq === RRule.YEARLY;
    const narrowed = [
      size(options.bymonthday) * (yearly ? months || 12 : 1),
      size(options.byyearday),
      7 * size(options.byweekno),
      weekdays.length && plain * (!yearly ? 5 : months ? 5 * months : 53) + nth * (yearly ? months || 1 : 1),
    ].filter((n) => n > 0);
    days = narrowed.length ? Math.min(...narrowed, longest) : yearly ? months || 1 : 1;
  }
  const most = Math.min(days * perDay, size(options.bysetpos) || Infinity);
  // A plain daily or weekly rule has the same number in every period after the first.
  const even = freq === RRule.WEEKLY || (freq === RRule.DAILY && !weekdays.length);
  const least = even && !["bymonth", "bymonthday", "byyearday", "byweekno", "bysetpos"].some((name) => size(lists[name])) ? days * perDay : 0;

  // On top of a period's base cost: each day is looked up in the lists, each BYDAY like 2TU is
  // placed again in each month, BYSETPOS goes through the period's days once for each position,
  // and a daily or weekly step moves the date a month at a time.
  const setpos = size(options.bysetpos);
  const periodCost =
    cost +
    ((months + size(options.bymonthday) + weekdays.length + 2 * size(options.byyearday)) * longest) / 1000 +
    (nth * (freq === RRule.YEARLY ? months || 1 : 1) + size(options.byweekno)) / 8 +
    setpos * (0.3 + (longest + setpos) / 1000) +
    (freq >= RRule.WEEKLY ? (interval * shortest) / 300 : 0);
  return { options, freq, interval, count, dtstart: dtstartWall, until: untilWall, most, least, cost: periodCost };
}

/** Days in the longest and the shortest of each kind of period, and roughly what stepping through a plain one costs. */
const PERIODS: Record<number, { longest: number; shortest: number; cost: number }> = {
  [RRule.YEARLY]: { longest: 366, shortest: 365, cost: 25 },
  [RRule.MONTHLY]: { longest: 31, shortest: 28, cost: 5 },
  [RRule.WEEKLY]: { longest: 7, shortest: 7, cost: 5 },
  [RRule.DAILY]: { longest: 1, shortest: 1, cost: 5 },
};

/**
 * The latest start at or before `target` that changes nothing about the rule: a whole number of
 * periods after DTSTART, on the same weekday, day of the month and time of day.
 */
function alignedStart(rule: Rule, target: number): number {
  const { freq, interval, dtstart } = rule;
  if (target <= dtstart) return dtstart;
  if (freq === RRule.DAILY || freq === RRule.WEEKLY) {
    const step = interval * PERIODS[freq]!.shortest * DAY;
    return dtstart + Math.floor((target - dtstart) / step) * step;
  }
  const d = new Date(dtstart);
  const t = new Date(target);
  const months = freq === RRule.MONTHLY ? interval : 12 * interval;
  let k = Math.floor(((t.getUTCFullYear() - d.getUTCFullYear()) * 12 + t.getUTCMonth() - d.getUTCMonth()) / months);
  // Not every month has a 31st, or every year a February 29th; a few periods earlier will do.
  for (let tries = 0; k > 0 && tries < 50; k--, tries++) {
    const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + k * months, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
    if (start <= target && new Date(start).getUTCDate() === d.getUTCDate()) return start;
  }
  return dtstart;
}

/**
 * A rule's instances from lo to hi (wall times, both included), the first `max` of them. The walk
 * starts just before lo, a whole number of periods after DTSTART, and is charged to `file` and `own`.
 */
function expand(rule: Rule, lo: number, hi: number, max: number, file: Work, own: Work): number[] {
  const found: number[] = [];
  if (hi < rule.dtstart || (rule.until !== null && rule.until < lo) || max <= 0) return found;
  const step = rule.interval * PERIODS[rule.freq]!.shortest * DAY;
  const periods = (from: number) => Math.floor((hi - from) / step) + 4;
  // A COUNT counts from DTSTART, so the walk has to start there, unless it can't run out by hi...
  const count = rule.count !== null && rule.count < periods(rule.dtstart) * rule.most ? rule.count : null;
  // ...or it surely ran out before lo: a plain rule's period n ends before n + 1 steps from DTSTART.
  if (count !== null && rule.least && rule.dtstart + (Math.ceil(count / rule.least) + 1) * step < lo) return found;
  // Instances before the walk's start are left out, and they're all before lo. A weekly walk's
  // first week only begins at its start, which BYSETPOS would count from, so it starts a week early.
  const start = count === null ? alignedStart(rule, rule.freq === RRule.WEEKLY ? lo - 7 * DAY : lo) : rule.dtstart;
  const allowed = Math.min(file.left, own.left);
  if (allowed <= 0) {
    file.short = true;
    return found;
  }
  let units = allowed - WALK_COST;
  const walk = new RRule({ ...rule.options, dtstart: new Date(start), until: rule.until === null ? null : new Date(rule.until), count, tzid: null }, true);
  // Past hi only a later instance ends a walk, and a rule that never matches (February 30th) has
  // none: rrule would step through every day to the year 9999. It reads the interval each time it
  // steps to the next period, and an interval of 0 is its own way out, so the steps are counted
  // and paid for there, before rrule takes them.
  let steps = 4 * periods(start); // two reads a period, for twice as many periods as reaching hi takes
  const interval = walk.options.interval;
  Object.defineProperty(walk.options, "interval", { get: () => (steps-- > 0 && (units -= rule.cost / 2) > 0 ? interval : 0) });
  walk.all((date) => {
    const at = date.getTime();
    if (at > hi || --units <= 0) return false;
    if (at >= lo) found.push(at);
    return found.length < max;
  });
  const used = allowed - Math.max(units, 0);
  file.left -= used;
  own.left -= used;
  if (units <= 0) file.short = true;
  return found;
}

// ---------------------------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------------------------

/** Keys use the instance's original start: a date, or a UTC instant (held as ms while matching). */
const keyName = (key: string) => (/^\d+$/.test(key) ? new Date(Number(key)).toISOString() : key);

/** `pattern` (which ends in ">") replaced only up to the last ">": nothing after it can match, and searching there is slow. */
function beforeLastTag(value: string, pattern: RegExp, replacement: string): string {
  const end = value.lastIndexOf(">") + 1;
  return value.slice(0, end).replace(pattern, replacement) + value.slice(end);
}

/** Descriptions from Google and Outlook are often HTML; keep the words and line breaks. */
export function plainText(value: string | null): string | null {
  if (!value) return value;
  // A tag is a "<" and a letter with a ">" later on (a regex for that backtracks on "<a<a<a...").
  const open = value.search(/<[a-z]/i);
  if (open < 0 || value.indexOf(">", open + 2) < 0) return value;
  const breaks = value.replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|li|h\d)>/gi, "\n");
  const out = beforeLastTag(beforeLastTag(breaks, /<li[^>]*>/gi, "• "), /<[^>]+>/g, "")
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

/** An instance in the window. Only the first `limit` of them are made into items. */
interface Found {
  /** Where it sorts: its start, or the start of its day for all-day events. */
  at: number;
  event: Component;
  uid: string;
  /** The original start it's keyed by, for a repeat. */
  original: string | null;
  instance: Instance;
}

/** What an event says about itself, the same for each of its instances. */
interface Details {
  title: string;
  location: string | null;
  description: string | null;
  url: string | null;
  busy: boolean;
  tentative: boolean;
}

/** A stamp as UTC ms (or a date's ms); `zoneOf` resolves local times. */
function identity(stamp: Stamp, zoneOf: (tzid: string | null) => Zone): number {
  if (stamp.kind === "date") return dateMs(stamp.date);
  return stamp.kind === "utc" ? stamp.ms : zoneOf(stamp.tzid).toUtc(stamp.wall);
}

export function parseIcs(input: string, options: IcsOptions): IcsCalendar {
  const work: Work = { left: FILE_WORK };
  const zoneWork: Work = { left: ZONE_WORK };
  const components = parseComponents(input);
  const calendar = components.find((c) => c.type === "VCALENDAR") ?? { type: "VCALENDAR", props: [], children: components };
  const zoneOf = zoneResolver(calendar.children, options.zone, zoneWork);
  const floating = zoneOf(null);
  const from = options.from.getTime();
  const to = options.to.getTime();
  const dayOf = (ms: number) => Math.floor(ms / DAY) * DAY;
  const fromDay = dayOf(floating.toWall(from));
  const toDay = dayOf(floating.toWall(to));
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

  const inWindow = (i: Instance) =>
    i.allDay ? dayOf(i.end) > fromDay && dayOf(i.start) <= toDay : (i.end > from && i.start < to) || (i.start === i.end && i.start >= from && i.start < to);
  /** The start of the last instance that can still be kept (see below). */
  let latest = to;

  const known = new Map<Component, Details>();
  const details = (event: Component): Details => {
    let d = known.get(event);
    if (!d) {
      const transp = first(event, "TRANSP")?.value.trim().toUpperCase();
      const msBusy = first(event, "X-MICROSOFT-CDO-BUSYSTATUS")?.value.trim().toUpperCase();
      const url = text(event, "URL", 1000);
      const description = plainText(text(event, "DESCRIPTION", 4000));
      d = {
        title: text(event, "SUMMARY", 200) ?? "Busy",
        location: text(event, "LOCATION", 300),
        description: description ? clip(description, 2000) : null,
        url: url && /^https?:\/\//i.test(url) ? url : null,
        busy: transp !== "TRANSPARENT" && msBusy !== "FREE",
        tentative: first(event, "STATUS")?.value.trim().toUpperCase() === "TENTATIVE",
      };
      known.set(event, d);
    }
    return d;
  };

  const describe = ({ event, uid, original, instance }: Found): IcsItem => {
    const d = details(event);
    return {
      key: original === null ? uid : `${uid}|${keyName(original)}`,
      title: d.title,
      location: d.location,
      description: d.description,
      url: d.url,
      allDay: instance.allDay,
      start: instance.allDay ? isoDate(instance.start) : new Date(instance.start).toISOString(),
      end: instance.allDay ? isoDate(instance.end) : new Date(instance.end).toISOString(),
      busy: d.busy,
      tentative: d.tentative,
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
      const length = Math.min(Math.max(e, s + DAY), END_OF_TIME) - s;
      return { allDay: true, start: s, end: s + length, zone: UTC_ZONE, startWall: s, length };
    }
    const zone = start.kind === "utc" ? UTC_ZONE : zoneOf(start.tzid);
    const startWall = start.kind === "utc" ? start.ms : start.wall;
    let endWall = startWall;
    if (end && end.kind !== "date") endWall = zone.toWall(identity(end, zoneOf));
    else if (end?.kind === "date") endWall = dateMs(end.date);
    else if (duration !== null) endWall = startWall + duration;
    const length = Math.max(0, Math.min(endWall, END_OF_TIME) - startWall);
    return { allDay: false, start: zone.toUtc(startWall), end: Math.min(zone.toUtc(startWall + length), END_OF_TIME), zone, startWall, length };
  };

  /** A series' instances in the window: its repeats, less exclusions, with moved ones in their new place. */
  const expandSeries = (uid: string, master: Component | null, overrides: Component[]): Found[] => {
    const out: Found[] = [];
    const add = (event: Component, original: string | null, instance: Instance) =>
      out.push({ at: instance.allDay ? dayOf(instance.start) : instance.start, event, uid, original, instance });
    const base = master ? single(master) : null;
    // Exceptions and exclusions written without a zone belong to the series' zone.
    const zoneFor = (tzid: string | null) => (tzid || !base ? zoneOf(tzid) : base.zone);
    const moved = new Map<string, Component>();
    for (const o of overrides) {
      const rid = readStamp(first(o, "RECURRENCE-ID"));
      if (rid) moved.set(rid.kind === "date" ? rid.date : String(identity(rid, zoneFor)), o);
    }
    const emitOverride = (key: string, o: Component) => {
      if (first(o, "STATUS")?.value.trim().toUpperCase() === "CANCELLED") return;
      const own = single(o);
      if (own && inWindow(own)) add(o, key, own);
    };

    if (!master || !base) {
      // Only exceptions came through (some servers do this): show them as they are.
      for (const [key, o] of moved) emitOverride(key, o);
      return out;
    }
    if (first(master, "STATUS")?.value.trim().toUpperCase() === "CANCELLED") return out;
    const rrule = first(master, "RRULE")?.value;
    // Once the file's work has run out, repeats aren't worked out: the event shows as itself.
    const rule = rrule && work.left > 0 ? buildRule(rrule, base.startWall, base.zone.toWall) : null;
    const extra = readStamps(all(master, "RDATE"));
    if (!rule && !extra.length) {
      if (inWindow(base)) add(master, null, base);
      for (const [key, o] of moved) emitOverride(key, o);
      return out;
    }

    const skip = new Set<string>();
    for (const ex of readStamps(all(master, "EXDATE"))) {
      skip.add(ex.kind === "date" ? ex.date : String(identity(ex, zoneFor)));
      if (ex.kind === "date") skip.add(`d${ex.date}`); // a date EXDATE on a timed series removes that day
    }

    // Repeats that could overlap the window, or start before the latest that can still be kept; the
    // others can't show (moved ones are seen to below).
    const lo = base.zone.toWall(from) - base.length - 2 * DAY;
    const hi = base.zone.toWall(Math.min(to, latest)) + 2 * DAY;
    const walls = new Set<number>([base.startWall]);
    if (rule) for (const wall of expand(rule, lo, hi, MAX_REPEATS, work, { left: SERIES_WORK })) walls.add(wall);
    let dates = 0;
    for (const r of extra) {
      const wall = r.kind === "date" ? dateMs(r.date) : base.zone.toWall(identity(r, zoneFor));
      if (wall >= lo && wall <= hi && dates++ < MAX_REPEATS) walls.add(wall);
    }

    const emitted = new Set<string>();
    for (const wall of [...walls].sort((a, b) => a - b)) {
      const end = Math.min(wall + base.length, END_OF_TIME);
      const instance: Instance = base.allDay
        ? { allDay: true, start: wall, end }
        : { allDay: false, start: base.zone.toUtc(wall), end: Math.min(base.zone.toUtc(end), END_OF_TIME) };
      const key = base.allDay ? isoDate(wall) : String(instance.start);
      if (skip.has(key) || (!base.allDay && skip.size && skip.has(`d${isoDate(wall)}`))) continue;
      emitted.add(key);
      const override = moved.get(key);
      if (override) emitOverride(key, override);
      else if (inWindow(instance)) add(master, key, instance);
    }
    // Instances moved here from a start outside the expanded range.
    for (const [key, o] of moved) if (!emitted.has(key) && !skip.has(key)) emitOverride(key, o);
    return out;
  };

  // Only the earliest `limit` are kept, so a long list is trimmed to them as it grows. Once it has
  // been, nothing starting after the last one kept can make it in either.
  const found: Found[] = [];
  let dropped = false;
  const byStart = (a: Found, b: Found) => a.at - b.at;
  for (const [uid, { master, overrides }] of series) {
    let instances: Found[];
    try {
      instances = expandSeries(uid, master, overrides);
    } catch {
      continue; // an event that can't be read is left out; the rest of the calendar still comes through
    }
    for (const instance of instances) {
      found.push(instance);
      if (found.length >= Math.max(2 * limit, 1000)) {
        found.sort(byStart);
        found.length = Math.max(limit, 0);
        dropped = true;
        if (found.length) latest = Math.min(latest, found[found.length - 1]!.at);
      }
    }
  }

  found.sort(byStart);
  return {
    name: text(calendar, "X-WR-CALNAME", 80),
    events: found.slice(0, limit).map(describe),
    truncated: dropped || found.length > limit || work.short === true || zoneWork.short === true,
  };
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
