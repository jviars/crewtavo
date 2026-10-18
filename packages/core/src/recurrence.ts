/**
 * Recurring jobs. Rules are RFC 5545 RRULEs without DTSTART (the job's start date supplies it),
 * e.g. "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU". Occurrences are calendar dates in the company's zone;
 * the scheduler adds the visit's start time in that zone.
 */
import { RRule } from "rrule";
import { isIsoDate } from "./time";

export interface RecurringJob {
  starts_on: string;              // YYYY-MM-DD
  ends_on?: string | null;        // YYYY-MM-DD, inclusive
  recurrence_rule: string;
  active_months?: number[] | null; // 1-12; null = all year
}

const DAY_MS = 86_400_000;
/** Most dates one call returns, so a runaway rule can't flood the schedule. */
const MAX_DATES = 1000;
const FREQUENCIES = ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"];
/** Rule parts a job's schedule can use. Visits get their time of day from the job, so BYHOUR and the like are out. */
const PARTS = new Set(["FREQ", "INTERVAL", "COUNT", "UNTIL", "WKST", "BYDAY", "BYMONTHDAY", "BYMONTH"]);

/** Midnight UTC of a calendar day, as a timestamp (Date.UTC would turn year 50 into 1950). */
const utcDay = (year: number, month: number, day: number) => new Date(0).setUTCFullYear(year, month - 1, day);

const utcMidnight = (date: string) => {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(utcDay(y, m, d));
};

/** Throws if the rule can't be parsed or isn't one jobs can use. Returns a normalized rule string. */
export function parseRule(rule: string): string {
  const text = rule.trim().replace(/^RRULE:/i, "").toUpperCase();
  if (!/^FREQ=/.test(text) && !/;FREQ=/.test(text)) throw new RangeError("Recurrence rule needs a FREQ");
  if (/DTSTART/.test(text)) throw new RangeError("Leave DTSTART out; the job's start date is used");
  const parts = new Map<string, string>();
  for (const part of text.split(";")) {
    // One line of NAME=VALUE parts; a second line would let rrule read another rule.
    if (!/^[A-Z]+=[A-Z0-9,+-]+$/.test(part)) throw new RangeError(`Recurrence rule has "${part.slice(0, 40)}", which isn't a rule part`);
    const [name, value] = part.split("=");
    if (!PARTS.has(name)) throw new RangeError(`${name} isn't supported in a job's schedule`);
    parts.set(name, value);
  }
  if (!FREQUENCIES.includes(parts.get("FREQ")!)) throw new RangeError("Jobs repeat daily, weekly, monthly or yearly");
  const interval = parts.get("INTERVAL");
  if (interval !== undefined && !(/^\d+$/.test(interval) && Number(interval) >= 1 && Number(interval) <= 52)) {
    throw new RangeError("INTERVAL must be a whole number from 1 to 52");
  }
  RRule.parseString(text); // throws on bad input
  return text;
}

type ParsedRule = RRule["options"];

/** Whether a parsed rule (with the start date's defaults filled in) includes this day. */
function occursOn(o: ParsedRule, day: Date): boolean {
  const start = o.dtstart;
  const year = day.getUTCFullYear();
  const month = day.getUTCMonth() + 1;
  const date = day.getUTCDate();
  const weekday = (day.getUTCDay() + 6) % 7; // rrule counts from Monday = 0
  const days = Math.round((day.getTime() - start.getTime()) / DAY_MS);
  // Whole periods since the start: days, weeks (from the week's first day, WKST), months or years.
  const periods =
    o.freq === RRule.DAILY ? days
    : o.freq === RRule.WEEKLY ? Math.floor((days + (((start.getUTCDay() + 6) % 7) - o.wkst + 7) % 7) / 7)
    : o.freq === RRule.MONTHLY ? (year - start.getUTCFullYear()) * 12 + month - 1 - start.getUTCMonth()
    : year - start.getUTCFullYear();
  if (days < 0 || periods % o.interval !== 0) return false;
  if (o.bymonth?.length && !o.bymonth.includes(month)) return false;
  if (o.byweekday?.length && !o.byweekday.includes(weekday)) return false;
  if (o.bynweekday?.length) {
    // "2TU" is the month's second Tuesday ("-1FR" its last Friday); in a yearly rule without BYMONTH, the year's.
    const inYear = o.freq === RRule.YEARLY && !o.bymonth?.length;
    const first = inYear ? utcDay(year, 1, 1) : utcDay(year, month, 1);
    const last = inYear ? utcDay(year, 12, 31) : utcDay(year, month + 1, 0);
    const nth = Math.floor((day.getTime() - first) / DAY_MS / 7) + 1;
    const nthFromEnd = -Math.floor((last - day.getTime()) / DAY_MS / 7) - 1;
    if (!o.bynweekday.some(([wday, n]) => wday === weekday && (n === nth || n === nthFromEnd))) return false;
  }
  if (o.bymonthday.length || o.bynmonthday?.length) {
    const monthLength = new Date(utcDay(year, month + 1, 0)).getUTCDate();
    if (!o.bymonthday.includes(date) && !o.bynmonthday?.includes(date - monthLength - 1)) return false;
  }
  return true;
}

/**
 * Dates (YYYY-MM-DD) the job occurs on between `from` and `to`, inclusive, at most MAX_DATES.
 * rrule parses the rule, but each day of the window is checked here: rrule's own between() walks
 * forward until a date matches past `to`, so a rule that never matches (Feb 30) walks to year 9999.
 */
export function occurrenceDates(job: RecurringJob, from: string, to: string): string[] {
  if (!isIsoDate(job.starts_on) || !isIsoDate(from) || !isIsoDate(to)) throw new RangeError("Dates must be YYYY-MM-DD");
  const options = RRule.parseString(parseRule(job.recurrence_rule));
  const rule = new RRule({
    ...options,
    dtstart: utcMidnight(job.starts_on),
    until: job.ends_on ? utcMidnight(job.ends_on) : options.until,
  }).options;
  const start = from > job.starts_on ? from : job.starts_on;
  const months = job.active_months?.length ? new Set(job.active_months) : null;
  const dates: string[] = [];
  let count = 0;
  // With COUNT, occurrences before the window count too, so start at the job's start date.
  // COUNT=0 means no dates at all (as in rrule), not no limit, so check for null rather than 0.
  const limit = rule.count;
  const end = utcMidnight(to).getTime();
  for (let t = utcMidnight(limit !== null ? job.starts_on : start).getTime(); t <= end && dates.length < MAX_DATES; t += DAY_MS) {
    const day = new Date(t);
    if (rule.until && day > rule.until) break;
    if (!occursOn(rule, day)) continue;
    if (limit !== null && ++count > limit) break;
    const date = day.toISOString().slice(0, 10);
    if (date >= start && (!months || months.has(day.getUTCMonth() + 1))) dates.push(date);
  }
  return dates;
}

/** Human summary for the UI, e.g. "every 2 weeks on Tuesday". */
export function describeRule(rule: string): string {
  try {
    return RRule.fromString(parseRule(rule)).toText();
  } catch {
    return rule;
  }
}
