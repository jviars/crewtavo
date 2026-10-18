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
 * window rather than from a start years ago, times far from the window aren't converted, a file
 * gets a fixed amount of work for its repeats and for its time zones, and an event that can't be
 * read is left out instead of failing the whole calendar.
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
/**
 * The first and last days there are here: Postgres takes years 1 to 9999, written with four
 * digits. DURATION:P99999999W ends at the start of the last day instead of past it, so the end is
 * still in 9999 in every zone (14 hours ahead of UTC at most).
 */
const FIRST_DAY = new Date(0).setUTCFullYear(1, 0, 1);
const END_OF_TIME = Date.UTC(9999, 11, 31);
/** A repeat that steps further than a century at a time isn't one (INTERVAL=999999999999). */
const MAX_STEP = 100 * 366 * DAY;
/** Zone names to ask Intl about, and VTIMEZONEs to read, in one file; real calendars use a handful. */
const MAX_ZONES = 1000;
/** A UID longer than this (real ones are well under 300) is shortened in keys, once for all its instances. */
const MAX_UID = 1000;

/**
 * Work allowed, in units that take a microsecond or less: for a whole file's repeats, for one
 * event's, for a whole file's time zones (offsets looked up, and VTIMEZONE rules) and for one
 * VTIMEZONE rule. Zones have their own, so an event's times don't depend on how many repeats came
 * before it. Real calendars use a part of it (5000 series about 300,000; events in 40 zones about
 * 70,000). A file built to keep the server busy runs out, and keeps what was found by then.
 */
const FILE_WORK = 400_000;
const SERIES_WORK = 50_000;
const ZONE_WORK = 200_000;
const OBSERVANCE_WORK = 20_000;
/** Setting up a walk through a rule costs about as much as a period of it. */
const WALK_COST = 5;

interface Work {
  left: number;
  /** The work ran out: some repeats were left out, or some times worked out roughly. */
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

/** The properties read here. Any other line is left out before its parameters are split up. */
const KNOWN = new Set([
  "BEGIN", "END", "UID", "DTSTART", "DTEND", "DURATION", "RRULE", "RDATE", "EXDATE", "RECURRENCE-ID", "SUMMARY", "LOCATION", "DESCRIPTION", "URL",
  "STATUS", "TRANSP", "X-MICROSOFT-CDO-BUSYSTATUS", "X-WR-CALNAME", "TZID", "X-LIC-LOCATION", "TZOFFSETFROM", "TZOFFSETTO",
]);

// Apple writes grouped names ("item1.URL"); the group doesn't matter here.
const propName = (raw: string) => {
  const name = raw.trim().toUpperCase();
  return name.includes(".") ? name.replace(/^[^.]*\./, "") : name;
};

function parseLine(line: string): Prop | null {
  // With no quote before it, a name ends at the first ";" or ":". A line nothing here reads is left
  // out there, and one with no parameters (most of them) ends its name at the colon.
  let named = line.indexOf(":");
  const semi = line.indexOf(";");
  if (semi >= 0 && (named < 0 || semi < named)) named = semi;
  if (named < 1) return null;
  if (line.lastIndexOf('"', named) < 0) {
    const name = propName(line.slice(0, named));
    if (!KNOWN.has(name)) return null;
    if (line[named] === ":") return { name, params: NO_PARAMS, value: line.slice(named + 1) };
    // With no quotes, the parameters end at the next colon.
    const colon = line.indexOf(":", named);
    if (colon > 0 && line.lastIndexOf('"', colon) < 0) {
      const params: Record<string, string> = {};
      for (const p of line.slice(named + 1, colon).split(";")) {
        const eq = p.indexOf("=");
        if (eq > 0) params[p.slice(0, eq).trim().toUpperCase()] = p.slice(eq + 1).trim();
      }
      return { name, params, value: line.slice(colon + 1) };
    }
  }
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
  const name = propName(rawName);
  if (!KNOWN.has(name)) return null;
  const params: Record<string, string> = rawParams.length ? {} : NO_PARAMS;
  for (const p of rawParams) {
    const eq = p.indexOf("=");
    if (eq > 0) params[p.slice(0, eq).trim().toUpperCase()] = p.slice(eq + 1).trim().replace(/^"(.*)"$/, "$1");
  }
  return { name, params, value: line.slice(colon + 1) };
}

/** A NUL, or half of an emoji (a surrogate pair) on its own: Postgres won't take the JSON either ends up in. */
const UNSTORABLE = /\u0000|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

function parseComponents(text: string): Component[] {
  // Every line break as "\n" (split and joined: a regex takes most of a second over millions of them).
  let unix = text.replace(UNSTORABLE, "").replace(/^﻿/, "");
  if (unix.includes("\r")) unix = unix.split("\r\n").join("\n").split("\r").join("\n");
  const lines = unix.replace(/\n[ \t]/g, "").split("\n");
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

const zoneNames = new Map<string, string | null>();
/**
 * The name Intl gives a zone, or null when it isn't one. Every spelling of a zone has the same
 * offsets ("america/chicago" is America/Chicago, US/Central too), and going by one name keeps a
 * file from making a formatter for each of a thousand spellings, kept for good (in time.ts).
 */
function zoneName(name: string): string | null {
  // No zone name has a space in it ("Customized Time Zone 12"), and asking Intl about one is slow.
  if (/\s/.test(name)) return null;
  let canonical = zoneNames.get(name);
  if (canonical === undefined) {
    try {
      canonical = new Intl.DateTimeFormat("en-US", { timeZone: name }).resolvedOptions().timeZone;
    } catch {
      canonical = null;
    }
    if (zoneNames.size >= 10_000) zoneNames.clear();
    zoneNames.set(name, canonical);
  }
  return canonical;
}

export const isIanaZone = (name: string): boolean => zoneName(name) !== null;

/**
 * A zone's offset at an instant. Every zone was on its local mean time until well after 1800, and
 * zoneOffsetMs reads a year before 100 as 1900 and something, so earlier instants take 1800's.
 */
const MEAN_TIME = Date.UTC(1800, 0, 1);
const offsetAt = (utc: number, name: string) => zoneOffsetMs(new Date(Math.max(utc, MEAN_TIME)), name);

function ianaZone(name: string, offset = (utc: number) => offsetAt(utc, name)): Zone {
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

/** Looking up an offset in Intl takes about 6 microseconds. */
const LOOKUP_COST = 6;

/** A day's offsets: the same all day, or a change at a second (`at`), or (twice in a day) null. */
type DayOffsets = number | { at: number; before: number; after: number } | null;

/**
 * A zone's offset, looked up once a day: it changes a couple of times a year, so a day with the
 * same offset at its start and the next day's has it all day, and a day with a change in it is
 * searched once for the second it changes. Each lookup is charged to `work`. Once that has run out
 * (only a file built to be slow gets there), a day not looked up yet takes the last offset found,
 * and the file says it left something out.
 */
function dailyOffsets(name: string, work: Work): (utc: number) => number {
  const days = new Map<number, DayOffsets>();
  // Midnights, each the end of one day and the start of the next.
  const midnights = new Map<number, number>();
  let last = 0;
  const ask = (utc: number) => {
    work.left -= LOOKUP_COST;
    return offsetAt(utc, name);
  };
  const midnight = (day: number) => {
    let offset = midnights.get(day);
    if (offset === undefined) midnights.set(day, (offset = ask(day * DAY)));
    return offset;
  };
  return (utc) => {
    const day = Math.floor(utc / DAY);
    let known = days.get(day);
    if (known === undefined) {
      if (work.left <= 0) {
        work.short = true;
        return last;
      }
      if (days.size >= 20_000) {
        days.clear();
        midnights.clear();
      }
      // Intl works in whole seconds, and so does a change.
      let before = day * DAY;
      let after = before + DAY;
      const start = midnight(day);
      const end = midnight(day + 1);
      if (start === end) known = start;
      else {
        let then = end;
        while (after - before > 1000) {
          const mid = before + Math.floor((after - before) / 2000) * 1000;
          const offset = ask(mid);
          if (offset === start) before = mid;
          else [after, then] = [mid, offset];
        }
        known = then === end ? { at: after, before: start, after: end } : null;
      }
      days.set(day, known);
    }
    last = known === null ? ask(utc) : typeof known === "number" ? known : Math.floor(utc / 1000) * 1000 < known.at ? known.before : known.after;
    return last;
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

/**
 * A VTIMEZONE rule's onsets (wall) that can fall in each year, with the days either side: worked
 * out the first time a year is needed.
 */
interface Onsets {
  rule: Rule | null;
  years: Map<number, number[]>;
  work: Work;
}

/** A file's VTIMEZONE rules: their onsets by rule, start and offset, and their texts as read. */
interface ZoneRules {
  onsets: Map<string, Onsets>;
  texts: RuleTexts;
}

/**
 * The same rule from the same start and offset has the same onsets in every zone of a file, and
 * they're worked out once: Outlook writes the same two rules in each "Customized Time Zone".
 */
function ruleOnsets(rules: ZoneRules, rrule: string, wall: number, from: number, work: Work): Onsets {
  // The offset before only moves a UTC UNTIL.
  const key = `${wall} ${/UNTIL=/i.test(rrule) ? from : ""} ${rrule}`;
  let onsets = rules.onsets.get(key);
  if (!onsets) {
    let rule = work.left > 0 ? buildRule(rrule, wall, (utc) => utc + from, rules.texts) : null;
    if (rule && rule.count !== null) {
      // Where a COUNT runs out is an UNTIL, and with one, onsets are found without walking from DTSTART.
      const all = expand(rule, rule.dtstart, END_OF_TIME, rule.count, work, { left: OBSERVANCE_WORK });
      if (!all.length) rule = null;
      else rule = { ...rule, count: null, until: all.length === rule.count ? all[all.length - 1]! : rule.until };
    }
    onsets = { rule, years: new Map(), work: { left: OBSERVANCE_WORK } };
    rules.onsets.set(key, onsets);
  }
  return onsets;
}

interface Observance extends Onsets {
  start: number; // wall time of the first onset
  from: number;
  to: number;
  /** DTSTART and RDATE onsets (wall), in order. */
  fixed: number[];
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
function vtimezone(component: Component, work: Work, rules: ZoneRules): Zone | null {
  const observances: Observance[] = [];
  for (const c of component.children) {
    if (c.type !== "STANDARD" && c.type !== "DAYLIGHT") continue;
    const start = readStamp(first(c, "DTSTART"));
    if (!start || start.kind === "date") continue;
    const wall = start.kind === "utc" ? start.ms : start.wall;
    const from = readOffset(first(c, "TZOFFSETFROM")?.value);
    const to = readOffset(first(c, "TZOFFSETTO")?.value);
    const rrule = first(c, "RRULE")?.value;
    const onsets = rrule ? ruleOnsets(rules, rrule, wall, from, work) : { rule: null, years: new Map(), work: { left: 0 } };
    const dates = readStamps(all(c, "RDATE")).map((s) => (s.kind === "local" ? s.wall : s.kind === "utc" ? s.ms + from : dateMs(s.date)));
    // In order, they go into the zone's list of changes quickly. A zone changes a few times a year,
    // so more than an event's repeats is a file built to be slow: the latest are kept.
    observances.push({ ...onsets, start: wall, from, to, fixed: [wall, ...dates].sort((a, b) => a - b).slice(-MAX_REPEATS) });
  }
  if (!observances.length) return null;
  const earliest = observances.reduce((a, b) => (b.start < a.start ? b : a));
  const ruled = observances.flatMap((o, i) => (o.rule ? [{ o, rule: o.rule, rank: 2 * i + 1 }] : []));
  const firstYear = ruled.reduce((year, { rule }) => Math.min(year, yearOf(rule.dtstart)), Infinity) - 1;

  /**
   * A rule's onsets (wall times) that can fall in a year: an onset falls up to 100 hours either side
   * of its wall time, so those in the days either side too. Null when the work ran out first.
   */
  const onsetsIn = (o: Observance, rule: Rule, year: number): number[] | null => {
    let onsets = o.years.get(year);
    if (!onsets) {
      if (o.work.left <= 0 || work.left <= 0) return null;
      onsets = expand(rule, yearStart(year) - 5 * DAY, yearStart(year + 1) + 5 * DAY, Infinity, work, o.work);
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
      // Each rule is looked at, whether or not it has onsets then, and so is each onset.
      work.left -= 3 * ruled.length;
      changes = work.left > 0 ? [] : null;
      const lo = yearStart(year);
      const hi = yearStart(year + 1);
      for (const { o, rule, rank } of ruled) {
        const onsets = changes && onsetsIn(o, rule, year);
        if (!onsets) changes = null;
        else {
          work.left -= onsets.length;
          for (const onset of onsets) {
            const at = onset - shift(o);
            if (at >= lo && at < hi) changes!.push({ at, to: o.to, rank });
          }
          if (work.left <= 0) changes = null;
        }
      }
      // Putting them in order takes a while when there are many.
      if (changes) work.left -= (changes.length * Math.log2(changes.length + 1)) / 4;
      else work.short = true;
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

/** What a VTIMEZONE says about its offsets, leaving out its names (TZNAME) and notes (X- lines). */
const zoneContent = (c: Component) =>
  JSON.stringify(
    c.children
      .filter((o) => o.type === "STANDARD" || o.type === "DAYLIGHT")
      .map((o) => [first(o, "DTSTART")?.value, first(o, "TZOFFSETFROM")?.value, first(o, "TZOFFSETTO")?.value, first(o, "RRULE")?.value, all(o, "RDATE").map((p) => [p.params.VALUE === "PERIOD", p.value])]),
  );

function zoneResolver(components: Component[], fallback: string, work: Work) {
  const definitions = new Map<string, Component>();
  for (const c of components) if (c.type === "VTIMEZONE") {
    const id = first(c, "TZID")?.value.trim();
    if (id) definitions.set(id, c);
  }
  // Zones by TZID, by the name Intl gives them, and by what a VTIMEZONE says: Outlook writes the
  // same zone again and again ("Customized Time Zone 1", "2"...), and each is read once.
  const cache = new Map<string, Zone>();
  const named = new Map<string, Zone>();
  const read = new Map<string, Zone | null>();
  const rules: ZoneRules = { onsets: new Map(), texts: { read: new Map(), work } };
  const iana = (name: string) => {
    let zone = named.get(name);
    if (!zone) named.set(name, (zone = ianaZone(name, dailyOffsets(name, work))));
    return zone;
  };
  // Asking Intl about a name and reading a VTIMEZONE take a while. A file gets MAX_ZONES of them,
  // more than any real calendar needs; zones past that are read in the company's zone.
  let asked = 0;
  const intlName = (name: string | null | undefined) => (!name || /\s/.test(name) ? null : asked++ < MAX_ZONES ? zoneName(name) : null);
  const readZone = (definition: Component): Zone | null => {
    const content = zoneContent(definition);
    let zone = read.get(content);
    if (zone === undefined) {
      if (asked++ >= MAX_ZONES) return null;
      try {
        zone = vtimezone(definition, work, rules);
      } catch {
        zone = null; // read as if the file didn't define it
      }
      read.set(content, zone);
    }
    return zone;
  };
  const fallbackName = zoneName(fallback);
  const fallbackZone = fallbackName ? iana(fallbackName) : UTC_ZONE;
  return (tzid: string | null): Zone => {
    if (!tzid) return fallbackZone;
    // TZID="  Z " is Z, however it's spaced.
    const id = tzid.trim();
    const known = cache.get(id);
    if (known) return known;
    const definition = definitions.get(id);
    const location = definition && first(definition, "X-LIC-LOCATION")?.value.trim();
    // Not WINDOWS_ZONES[id]: TZID=constructor would find Object.
    const name = intlName(id) ?? (Object.hasOwn(WINDOWS_ZONES, id) ? zoneName(WINDOWS_ZONES[id]!) : null) ?? intlName(location);
    let zone = name ? iana(name) : definition ? readZone(definition) : null;
    if (!zone) {
      // A name ending in one ("/mozilla.org/20050126_1/America/New_York"). The match never starts
      // just after a letter, and saying so keeps a long run of letters from taking ages.
      const ending = intlName(/(?<![A-Za-z])([A-Za-z]+\/[A-Za-z_+-]+(?:\/[A-Za-z_+-]+)?)$/.exec(id)?.[1]);
      if (ending) zone = iana(ending);
    }
    zone ??= fallbackZone;
    cache.set(id, zone);
    return zone;
  };
}

// ---------------------------------------------------------------------------------------------
// Repeats
// ---------------------------------------------------------------------------------------------

const size = (list: unknown) => (list === undefined || list === null ? 0 : Array.isArray(list) ? list.length : 1);

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
  /**
   * The most instances a period can have, and (in a monthly or yearly rule) the fewest each has
   * after the first: 0 when one can have none.
   */
  most: number;
  least: number;
  /**
   * A daily or weekly rule with no other lists has `each` instances in every `block` periods
   * counting from DTSTART (BYDAY=MO,TU,WE,TH,FR on a daily rule: five every seven days); null for others.
   */
  block: number;
  each: number | null;
  /** Roughly what stepping through one period costs, in the same units as the work allowed. */
  cost: number;
  /** The same instances, for a daily rule that picks its days by month and the like, a year at a time. */
  yearly?: Rule;
}

/** The days of the week, Monday first, without a number in front. */
const WEEK = [RRule.MO, RRule.TU, RRule.WE, RRule.TH, RRule.FR, RRule.SA, RRule.SU];

/**
 * An RRULE expanded in wall-clock time: dtstart is the local start as if it were UTC, so "every
 * Monday at 9" stays at 9 across daylight-saving changes. A UTC UNTIL is moved into the same frame.
 * Calendars repeat daily at most, a few times a day; faster rules aren't used.
 */
function buildRule(raw: string, dtstartWall: number, untilToWall: (utc: number) => number, texts: RuleTexts): Rule | null {
  let read = texts.read.get(raw);
  if (read === undefined) {
    texts.work.left -= RULE_COST;
    read = readRule(raw);
    texts.read.set(raw, read);
  }
  if (!read) return null;
  const { options, until: stamp, perDay } = read;
  let untilWall: number | null = null;
  if (stamp?.kind === "utc") untilWall = untilToWall(stamp.ms);
  else if (stamp?.kind === "local") untilWall = stamp.wall;
  else if (stamp?.kind === "date") untilWall = dateMs(stamp.date) + DAY - 1000; // through the end of that day
  if (Number.isNaN(dtstartWall) || Number.isNaN(untilWall)) return null; // a date like the 45th of the 13th month
  const rule = ruleOf(options, dtstartWall, untilWall, perDay);
  // A daily rule with a COUNT that picks its days by month, day of the month or of the year, or
  // week number, would be walked from DTSTART a day at a time. rrule picks a year's days with the
  // same lists, so a yearly rule has the same instances in the same order, a year at a time.
  if (rule.freq === RRule.DAILY && rule.interval === 1 && rule.count !== null && rule.each === null && !size(options.bysetpos)) {
    const weekdays = (options.byweekday ?? []) as Weekday[];
    // A yearly rule picks DTSTART's day of the month when no list picks days; every day of the week is every day.
    const picked = weekdays.length || size(options.bymonthday) || size(options.byyearday) || size(options.byweekno);
    const byweekday = weekdays.length ? [...new Set(weekdays.map((d) => d.weekday))].map((d) => WEEK[d]!) : picked ? options.byweekday : WEEK;
    rule.yearly = ruleOf({ ...options, freq: RRule.YEARLY, byweekday }, dtstartWall, untilWall, perDay);
  }
  return rule;
}

/** A rule's text, read and checked: the same for every event that has it. */
interface RuleText {
  options: Partial<Options>;
  until: Stamp | null;
  /** Instances on each day it falls on: one for each BYHOUR, BYMINUTE and BYSECOND together. */
  perDay: number;
}

/** Each rule text a file has is read once, for a few microseconds of its work. */
interface RuleTexts {
  read: Map<string, RuleText | null>;
  work: Work;
}
const RULE_COST = 4;

function readRule(raw: string): RuleText | null {
  const parts = raw
    .replace(/^RRULE:/i, "")
    .split(";")
    .map((p) => p.trim())
    .filter((p) => RULE_PARTS.has(p.split("=")[0]!.toUpperCase()));
  // RRule goes by the last FREQ when there are several, so there must be just one.
  if (parts.filter((p) => /^FREQ=/i.test(p)).length !== 1) return null;
  const untilPart = parts.find((p) => /^UNTIL=/i.test(p));
  const until = untilPart ? readValue(untilPart.slice(6), null) : null;
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
  const perDay = (size(options.byhour) || 1) * (size(options.byminute) || 1) * (size(options.bysecond) || 1);
  if (perDay > MAX_PER_DAY) return null;
  return { options, until, perDay };
}

/** What's worked out from a rule that was read and checked. */
function ruleOf(options: Partial<Options>, dtstartWall: number, untilWall: number | null, perDay: number): Rule {
  const { freq = RRule.DAILY, interval = 1, count = null } = options;
  const lists = options as Record<string, unknown>;

  // The days a period can have one on. Each list narrows it down; with none, it's DTSTART's day.
  // (BYDAY=2TU is one day a month, or a year in a yearly rule without BYMONTH; daily and weekly rules ignore the 2.)
  const weekdays = (options.byweekday ?? []) as Weekday[];
  const nth = freq <= RRule.MONTHLY ? weekdays.filter((d) => d.n).length : 0;
  const plain = new Set(weekdays.filter((d) => !d.n || freq > RRule.MONTHLY).map((d) => d.weekday)).size;
  const months = size(options.bymonth);
  const { longest, shortest, cost } = PERIODS[freq]!;
  // A week number is up to 7 days, and week 1 and the last week also take a few days from the years either side.
  const weeks = size(options.byweekno) && 7 * size(options.byweekno) + 6;
  let days = 1;
  // A weekly rule with no BYDAY has every day of the week when another list picks the days.
  if (freq === RRule.WEEKLY) days = plain || (size(options.bymonthday) || size(options.byyearday) || weeks ? 7 : 1);
  else if (freq !== RRule.DAILY) {
    const yearly = freq === RRule.YEARLY;
    const narrowed = [
      size(options.bymonthday) * (yearly ? months || 12 : 1),
      size(options.byyearday),
      weeks,
      weekdays.length && plain * (!yearly ? 5 : months ? 5 * months : 53) + nth * (yearly ? months || 1 : 1),
    ].filter((n) => n > 0);
    days = narrowed.length ? Math.min(...narrowed, longest) : yearly ? months || 1 : 1;
  }
  // rrule gives one for each BYSETPOS the period has, and one for each counted from its end even
  // when it hasn't (the period's first again: -2 when it has just one).
  const positions = (options.bysetpos ?? []) as number[];
  const most = positions.length ? Math.min(positions.filter((p) => p > 0).length, days * perDay) + positions.filter((p) => p < 0).length : days * perDay;
  const least = freq <= RRule.MONTHLY ? fewest(options, freq, dtstartWall, perDay) : 0;
  // A daily step lands on each weekday once in seven steps, unless it's a whole number of weeks.
  // A daily rule's BYSETPOS picks from each day's times, the same ones every day.
  const daily = freq === RRule.DAILY && positions.length ? positions.filter((p) => p > 0 && p <= perDay).length + positions.filter((p) => p < 0).length : perDay;
  let block = 1;
  let each: number | null = null;
  if (freq >= RRule.WEEKLY && !["bymonth", "bymonthday", "byyearday", "byweekno"].some((name) => size(lists[name])) && (freq === RRule.DAILY || !positions.length)) {
    if (freq === RRule.WEEKLY || !weekdays.length) each = (plain || 1) * daily;
    else {
      block = interval % 7 ? 7 : 1;
      each = (block === 7 ? plain : weekdays.some((d) => d.weekday === (new Date(dtstartWall).getUTCDay() + 6) % 7) ? 1 : 0) * daily;
    }
  }

  // On top of a period's base cost: each day is looked up in the lists, BYDAY like 2TU is placed
  // again in each month (rrule marks the days anew), BYSETPOS goes through all the period's days
  // for each position, and a daily or weekly step moves the date a month at a time.
  const setpos = size(options.bysetpos);
  const periodCost =
    cost +
    ((months + size(options.bymonthday) + weekdays.length + 2 * size(options.byyearday)) * longest) / 1000 +
    (nth && 3 + (nth * (freq === RRule.YEARLY ? months || 1 : 1)) / 8) +
    size(options.byweekno) / 8 +
    setpos * (0.5 + longest / 128) +
    (freq >= RRule.WEEKLY ? (interval * shortest) / 200 : 0);
  return { options, freq, interval, count, dtstart: dtstartWall, until: untilWall, most, least, block, each, cost: periodCost };
}

/** The days in each month of a common year: the fewest it can have. */
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/**
 * The fewest instances a monthly or yearly period after the first has, or 0 when one can have none
 * (or it's hard to say). Values counted from the same end (BYMONTHDAY=1,15, or BYDAY=2TU,4TU) are
 * different days, so a period has at least as many as either end's values that it always has.
 */
function fewest(options: Partial<Options>, freq: number, dtstart: number, perDay: number): number {
  const list = (value: unknown) => (value === undefined || value === null ? [] : ((Array.isArray(value) ? value : [value]) as number[]));
  const ends = (values: number[], always: number) => Math.max(values.filter((v) => v > 0 && v <= always).length, values.filter((v) => v < 0 && -v <= always).length);
  const yearly = freq === RRule.YEARLY;
  const weekdays = (options.byweekday ?? []) as Weekday[];
  let monthdays = list(options.bymonthday);
  const yeardays = list(options.byyearday);
  let months = list(options.bymonth);
  // Lists that leave some periods with none, or that a day has to match together.
  if (size(options.byweekno) || (!yearly && (months.length || yeardays.length))) return 0;
  const lists = [monthdays, yeardays, weekdays].filter((l) => l.length).length;
  if (lists > 1) return 0;
  if (!lists) {
    // With no days given, rrule repeats DTSTART's day of the month (and month, in a yearly rule).
    monthdays = [new Date(dtstart).getUTCDate()];
    if (yearly && !months.length) months = [new Date(dtstart).getUTCMonth() + 1];
  }
  // Summed over the period's months, given the days each month always has.
  const inMonths = (inMonth: (always: number) => number) =>
    yearly ? (months.length ? months : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]).reduce((n, m) => n + inMonth(MONTH_DAYS[m - 1]!), 0) : inMonth(28);
  let days: number;
  if (yeardays.length) days = months.length ? 0 : ends(yeardays, 365);
  else if (monthdays.length) days = inMonths((always) => ends(monthdays, always));
  else if (weekdays.some((d) => d.n) && weekdays.some((d) => !d.n)) days = 0; // 2TU and every Friday: both at once
  else if (weekdays.some((d) => d.n)) {
    // Each weekday's own list: 2TU,-1TU are different Tuesdays unless the month has just 4.
    const byDay = new Map<number, number[]>();
    for (const d of weekdays) byDay.set(d.weekday, [...(byDay.get(d.weekday) ?? []), d.n!]);
    const per = (always: number) => [...byDay.values()].reduce((n, ns) => n + ends(ns, always), 0);
    days = yearly && !months.length ? per(52) : inMonths(() => per(4));
  } else days = new Set(weekdays.map((d) => d.weekday)).size * (yearly && !months.length ? 52 : inMonths(() => 4));
  const setpos = list(options.bysetpos);
  return setpos.length ? ends(setpos, days * perDay) : days * perDay;
}

/** Days in the longest and the shortest of each kind of period, and roughly what stepping through a plain one costs. */
const PERIODS: Record<number, { longest: number; shortest: number; cost: number }> = {
  [RRule.YEARLY]: { longest: 366, shortest: 365, cost: 25 },
  [RRule.MONTHLY]: { longest: 31, shortest: 28, cost: 8 },
  [RRule.WEEKLY]: { longest: 7, shortest: 7, cost: 5 },
  [RRule.DAILY]: { longest: 1, shortest: 1, cost: 4 },
};

/**
 * The latest start at or before `target` that changes nothing about the rule: a whole number of
 * periods (of blocks, for a daily or weekly rule) after DTSTART, on the same weekday, day of the
 * month and time of day.
 */
function alignedStart(rule: Rule, target: number): number {
  const { freq, interval, dtstart } = rule;
  if (target <= dtstart) return dtstart;
  if (freq === RRule.DAILY || freq === RRule.WEEKLY) {
    const step = rule.block * interval * PERIODS[freq]!.shortest * DAY;
    return dtstart + Math.floor((target - dtstart) / step) * step;
  }
  const d = new Date(dtstart);
  const t = new Date(target);
  const months = freq === RRule.MONTHLY ? interval : 12 * interval;
  let k = Math.floor(((t.getUTCFullYear() - d.getUTCFullYear()) * 12 + t.getUTCMonth() - d.getUTCMonth()) / months);
  // Not every month has a 31st, or every year a February 29th; a few periods earlier will do.
  // (Not Date.UTC: it reads a year before 100 as 1900 and something.)
  for (let tries = 0; k > 0 && tries < 50; k--, tries++) {
    const start = new Date(dtstart).setUTCFullYear(d.getUTCFullYear(), d.getUTCMonth() + k * months, d.getUTCDate());
    if (start <= target && new Date(start).getUTCDate() === d.getUTCDate()) return start;
  }
  return dtstart;
}

/**
 * Where a walk through a rule's instances from lo to hi starts, the rule it walks and the COUNT it
 * has left then; null when it surely has none there. Nothing is walked (or charged) to find out.
 */
function walkFrom(rule: Rule, lo: number, hi: number): { rule: Rule; start: number; count: number | null } | null {
  if (hi < rule.dtstart || (rule.until !== null && rule.until < lo)) return null;
  const { shortest, longest } = PERIODS[rule.freq]!;
  const step = rule.interval * shortest * DAY;
  // Instances before the walk's start are left out, and they're all before lo. A weekly walk's
  // first week only begins at its start, which BYSETPOS would count from, so it starts a week early.
  const start = alignedStart(rule, rule.freq === RRule.WEEKLY ? lo - 7 * DAY : lo);
  // A COUNT counts from DTSTART. With the same number in every block of periods, the ones before
  // the walk's start are counted rather than walked...
  if (rule.count === null) return { rule, start, count: null };
  if (rule.each !== null) {
    const count = rule.count - rule.each * Math.round((start - rule.dtstart) / (rule.block * step));
    return count > 0 ? { rule, start, count } : null;
  }
  // ...and otherwise the walk has to start at DTSTART, unless the COUNT can't run out by hi, or
  // it surely ran out before lo (period n ends within n + 1 of the longest periods of DTSTART).
  if (rule.count >= (Math.floor((hi - rule.dtstart) / step) + 4) * rule.most) return { rule, start, count: null };
  if (rule.least && rule.dtstart + (Math.ceil(rule.count / rule.least) + 1) * rule.interval * longest * DAY < lo) return null;
  return rule.yearly ? walkFrom(rule.yearly, lo, hi) : { rule, start: rule.dtstart, count: rule.count };
}

/**
 * A rule's instances from lo to hi (wall times, both included), the first `max` of them. The walk
 * starts just before lo, a whole number of periods after DTSTART, and is charged to `file` and `own`.
 */
function expand(rule: Rule, lo: number, hi: number, max: number, file: Work, own: Work): number[] {
  const found: number[] = [];
  const from = max > 0 ? walkFrom(rule, lo, hi) : null;
  if (!from) return found;
  const allowed = Math.min(file.left, own.left);
  if (allowed <= 0) {
    file.short = true;
    return found;
  }
  const { start, count } = from;
  rule = from.rule;
  const step = rule.interval * PERIODS[rule.freq]!.shortest * DAY;
  const periods = (from: number) => Math.floor((hi - from) / step) + 4;
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
    // One that's kept is looked at again: worked out in UTC, and checked against exclusions.
    if (at >= lo) {
      found.push(at);
      units -= 0.5;
    }
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

/** An event's own start and end: its times in UTC are worked out only when asked for. */
interface Own {
  allDay: boolean;
  zone: Zone;
  startWall: number;
  end: Stamp | null;
  duration: number | null;
  /** The most its length can be, before its end is worked out. */
  longest: number;
  /** Its length in its zone, once worked out. */
  length?: number;
  /** Whether it can be within two weeks of the window; only then are its times in UTC worked out. */
  near: boolean;
  instance: Instance;
}

/** The times of an event that's too far from the window to be in it. */
const FAR: Instance = Object.freeze({ allDay: false, start: NaN, end: NaN });

/** A moved or cancelled instance of a series. */
interface Moved {
  o: Component;
  rid: Stamp;
  own: Own | null;
  /** Whether it can show in the window. */
  shows: boolean;
}

const cancelled = (event: Component) => first(event, "STATUS")?.value.trim().toUpperCase() === "CANCELLED";
const NOTHING_MOVED: ReadonlyMap<string, { o: Component; own: Own | null }> = new Map();
const nowhere = () => false;

/** A stamp as UTC ms (or a date's ms); `zoneOf` resolves local times. */
function identity(stamp: Stamp, zoneOf: (tzid: string | null) => Zone): number {
  if (stamp.kind === "date") return dateMs(stamp.date);
  return stamp.kind === "utc" ? stamp.ms : zoneOf(stamp.tzid).toUtc(stamp.wall);
}

/** A stamp as it's written, before any zone: a date's midnight, or a wall time as if it were UTC. */
const written = (stamp: Stamp) => (stamp.kind === "date" ? dateMs(stamp.date) : stamp.kind === "utc" ? stamp.ms : stamp.wall);

/** A zone moves a time by 100 hours at most, so times written further apart than this are different instants in any zones. */
const APART = 9 * DAY;

/** Whether a list in order has a value within APART of `at`. */
function nearOne(sorted: number[], at: number): boolean {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! < at - APART) lo = mid + 1;
    else hi = mid;
  }
  return lo < sorted.length && sorted[lo]! <= at + APART;
}

/** A short, steady stand-in for a long text: 64 bits of it, in hex. */
function digest(text: string): string {
  let a = 0xdeadbeef ^ text.length;
  let b = 0x41c6ce57 ^ text.length;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 2654435761);
    b = Math.imul(b ^ c, 1597334677);
  }
  a = Math.imul(a ^ (a >>> 16), 2246822507) ^ Math.imul(b ^ (b >>> 13), 3266489909);
  b = Math.imul(b ^ (b >>> 16), 2246822507) ^ Math.imul(a ^ (a >>> 13), 3266489909);
  return (b >>> 0).toString(16).padStart(8, "0") + (a >>> 0).toString(16).padStart(8, "0");
}

/**
 * The UID as each instance's key has it. One that's most of a file would be in every key, and the
 * keys of up to 5000 instances would take gigabytes to store: it's cut short, and a digest of all
 * of it keeps it apart from others.
 */
const keyUid = (uid: string) => (uid.length <= MAX_UID ? uid : `${clip(uid, 200)}#${digest(uid)}`);

export function parseIcs(input: string, options: IcsOptions): IcsCalendar {
  const work: Work = { left: FILE_WORK };
  const zoneWork: Work = { left: ZONE_WORK };
  const texts: RuleTexts = { read: new Map(), work };
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
      // A date can be written in the year 0 (a timed one can't: 0000 reads as 1900).
      start: instance.allDay ? isoDate(Math.max(instance.start, FIRST_DAY)) : new Date(instance.start).toISOString(),
      end: instance.allDay ? isoDate(instance.end) : new Date(instance.end).toISOString(),
      busy: d.busy,
      tentative: d.tentative,
    };
  };

  /** An event's length in its zone, worked out the first time it's needed. */
  const lengthOf = (own: Own): number => {
    if (own.length === undefined) {
      const { end, duration, startWall, zone } = own;
      let endWall = startWall;
      if (end && end.kind !== "date") endWall = zone.toWall(identity(end, zoneOf));
      else if (end?.kind === "date") endWall = dateMs(end.date);
      else if (duration !== null) endWall = startWall + duration;
      own.length = Math.max(0, Math.min(endWall, END_OF_TIME) - startWall);
    }
    return own.length;
  };

  /**
   * One event's own start and end. A zone moves a time by 100 hours at most (TZOFFSETTO:+995959),
   * and an end by its own zone's and then the start's, so an event more than two weeks from the
   * window can't be in it (it isn't `near`), and its times aren't worked out: for an old event in a
   * file's own zone, that's working out the zone's year.
   */
  const single = (event: Component): Own | null => {
    const start = readStamp(first(event, "DTSTART"));
    if (!start) return null;
    const end = readStamp(first(event, "DTEND"));
    const duration = readDuration(first(event, "DURATION")?.value);
    if (start.kind === "date") {
      const s = dateMs(start.date);
      const e = end?.kind === "date" ? dateMs(end.date) : duration !== null ? s + Math.max(DAY, Math.round(duration / DAY) * DAY) : s + DAY;
      const length = Math.min(Math.max(e, s + DAY), END_OF_TIME) - s;
      return { allDay: true, zone: UTC_ZONE, startWall: s, end, duration, longest: length, length, near: true, instance: { allDay: true, start: s, end: s + length } };
    }
    const zone = start.kind === "utc" ? UTC_ZONE : zoneOf(start.tzid);
    const startWall = start.kind === "utc" ? start.ms : start.wall;
    const endAt = !end ? startWall + (duration ?? 0) : end.kind === "date" ? dateMs(end.date) : end.kind === "utc" ? end.ms : end.wall;
    const near = startWall - 14 * DAY < to && Math.max(startWall, endAt) + 14 * DAY >= from;
    const longest = Math.max(0, Math.min(end && end.kind !== "date" ? endAt + APART : endAt, END_OF_TIME) - startWall);
    const own: Own = { allDay: false, zone, startWall, end, duration, longest, near, instance: FAR };
    if (near) own.instance = { allDay: false, start: zone.toUtc(startWall), end: Math.min(zone.toUtc(startWall + lengthOf(own)), END_OF_TIME) };
    return own;
  };

  /** A series' instances in the window: its repeats, less exclusions, with moved ones in their new place. */
  const expandSeries = (uid: string, master: Component | null, overrides: Component[]): Found[] => {
    const out: Found[] = [];
    const add = (event: Component, original: string | null, instance: Instance) =>
      out.push({ at: instance.allDay ? dayOf(instance.start) : instance.start, event, uid, original, instance });
    const base = master ? single(master) : null;
    // Exceptions and exclusions written without a zone belong to the series' zone.
    const zoneFor = (tzid: string | null) => (tzid || !base ? zoneOf(tzid) : base.zone);
    const keyOf = (s: Stamp) => (s.kind === "date" ? s.date : String(identity(s, zoneFor)));

    // Moved and cancelled instances, each in place of the one that started at its RECURRENCE-ID.
    const changes: Moved[] = [];
    for (const o of overrides) {
      const rid = readStamp(first(o, "RECURRENCE-ID"));
      const own = rid && !cancelled(o) ? single(o) : null;
      if (rid) changes.push({ o, rid, own, shows: !!own?.near });
    }
    /**
     * The changes that can make a difference: ones that can show in the window, and ones written
     * near the times the series' repeats are looked for (`repeats`). The rest aren't converted. One
     * written within days of a change that shows is kept too, as it could be the same instance
     * written again, and the last one written is the one that counts.
     */
    const showing = changes.length ? changes.flatMap((c) => (c.shows ? [written(c.rid)] : [])).sort((a, b) => a - b) : [];
    const changesNear = (repeats: (at: number) => boolean) => (changes.length ? changes.filter((c) => c.shows || repeats(written(c.rid)) || nearOne(showing, written(c.rid))) : changes);
    const movedFrom = (kept: Moved[]): ReadonlyMap<string, { o: Component; own: Own | null }> => {
      if (!kept.length) return NOTHING_MOVED;
      const moved = new Map<string, { o: Component; own: Own | null }>();
      for (const { o, rid, own } of kept) moved.set(keyOf(rid), { o, own });
      return moved;
    };
    const emitOverride = (key: string, o: Component, own: Own | null) => {
      const instance = own?.near ? own.instance : null;
      if (instance && inWindow(instance)) add(o, key, instance);
    };

    if (!master || !base) {
      // Only exceptions came through (some servers do this): show them as they are.
      for (const [key, { o, own }] of movedFrom(changesNear(nowhere))) emitOverride(key, o, own);
      return out;
    }
    if (cancelled(master)) return out;
    const rrule = first(master, "RRULE")?.value;
    const extra = readStamps(all(master, "RDATE"));
    // Repeats that could overlap the window, or start before the latest that can still be kept; the
    // others can't show (moved ones are seen to below). Until the series' end is worked out, lo is
    // only known to be after `before`.
    const window = rrule || extra.length ? { from: base.zone.toWall(from), hi: base.zone.toWall(Math.min(to, latest)) + 2 * DAY } : null;
    const hi = window?.hi ?? 0;
    const before = (window?.from ?? 0) - base.longest - 2 * DAY;
    // Once the file's work has run out, repeats aren't worked out: the event shows as itself. A UTC
    // UNTIL days from the window stays on its side of it in any zone, and isn't converted.
    const rule = rrule && work.left > 0 ? buildRule(rrule, base.startWall, (utc) => (utc + 5 * DAY < before || utc - 5 * DAY > hi ? utc : base.zone.toWall(utc)), texts) : null;
    if (!rule && !extra.length) {
      const instance = base.near ? base.instance : null;
      if (instance && inWindow(instance)) add(master, null, instance);
      for (const [key, { o, own }] of movedFrom(changesNear(nowhere))) emitOverride(key, o, own);
      return out;
    }

    const nearRepeats = (lo: number) => (at: number) => (at >= lo - APART && at <= hi + APART) || Math.abs(at - base.startWall) <= APART;
    // A series that ended (or ran out of its COUNT) long before the window, with nothing moved into
    // it, has nothing to show, and nothing about it is converted.
    if (!base.near && !(rule && walkFrom(rule, before, hi)) && !extra.some((r) => nearRepeats(before)(written(r))) && !changesNear(nearRepeats(before)).length) return out;

    const lo = (window?.from ?? 0) - lengthOf(base) - 2 * DAY;
    const kept = changesNear(nearRepeats(lo));
    const moved = movedFrom(kept);
    // Exclusions matter only for the repeats looked at, and for the moved ones kept.
    const keptAt = kept.map((c) => written(c.rid)).sort((a, b) => a - b);
    const skip = new Set<string>();
    for (const ex of readStamps(all(master, "EXDATE"))) {
      if (!nearRepeats(lo)(written(ex)) && !nearOne(keptAt, written(ex))) continue;
      skip.add(keyOf(ex));
      if (ex.kind === "date") skip.add(`d${ex.date}`); // a date EXDATE on a timed series removes that day
    }

    const walls = new Set<number>([base.startWall]);
    if (rule) for (const wall of expand(rule, lo, hi, MAX_REPEATS, work, { left: SERIES_WORK })) walls.add(wall);
    let dates = 0;
    for (const r of extra) {
      if (r.kind !== "date" && (written(r) < lo - APART || written(r) > hi + APART)) continue;
      const wall = r.kind === "date" ? dateMs(r.date) : base.zone.toWall(identity(r, zoneFor));
      if (wall >= lo && wall <= hi && dates++ < MAX_REPEATS) walls.add(wall);
    }

    const emitted = new Set<string>();
    for (const wall of [...walls].sort((a, b) => a - b)) {
      // The first start, when it's far from the window and nothing is moved, can't change anything.
      if (wall === base.startWall && !base.near && !moved.size) continue;
      const end = Math.min(wall + lengthOf(base), END_OF_TIME);
      const instance: Instance = base.allDay
        ? { allDay: true, start: wall, end }
        : { allDay: false, start: base.zone.toUtc(wall), end: Math.min(base.zone.toUtc(end), END_OF_TIME) };
      const key = base.allDay ? isoDate(wall) : String(instance.start);
      if (skip.has(key) || (!base.allDay && skip.size && skip.has(`d${isoDate(wall)}`))) continue;
      emitted.add(key);
      const override = moved.get(key);
      if (override) emitOverride(key, override.o, override.own);
      else if (inWindow(instance)) add(master, key, instance);
    }
    // Instances moved here from a start outside the expanded range.
    for (const [key, { o, own }] of moved) if (!emitted.has(key) && !skip.has(key)) emitOverride(key, o, own);
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
      instances = expandSeries(keyUid(uid), master, overrides);
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
  const name = zoneName(zone);
  const z = name ? ianaZone(name) : UTC_ZONE;
  const start = Date.parse(item.start);
  const end = Math.max(start, Date.parse(item.end) - 1); // an event ending at midnight doesn't cover the next day
  // Only the days Postgres takes, whatever the times.
  const day = (utc: number) => isoDate(Math.min(Math.max(z.toWall(utc), FIRST_DAY), END_OF_TIME));
  return { starts_on: day(start), ends_on: day(end) };
}

/** Is this a calendar file at all? (A login page or an error comes back as HTML.) */
export function looksLikeIcs(input: string): boolean {
  return /^﻿?\s*BEGIN:VCALENDAR/i.test(input);
}
