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
  /** Stretches it was paused, `from` up to (not including) `until`: their dates aren't visits and don't count toward COUNT. */
  paused?: ReadonlyArray<{ from: string; until: string }> | null;
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
    // "Ends after 12 visits" counts visits, so a date out of season doesn't count.
    if (months && !months.has(day.getUTCMonth() + 1)) continue;
    const date = day.toISOString().slice(0, 10);
    // Nor does one while it was paused, so a paused job still gets its 12.
    if (job.paused?.some((p) => date >= p.from && date < p.until)) continue;
    if (limit !== null && ++count > limit) break;
    if (date >= start) dates.push(date);
  }
  return dates;
}

/**
 * The day of the last visit of a rule that ends after a number of visits (COUNT), counted from the
 * job's first date, past the stretches it was paused; null for a rule without COUNT. The job's ends_on is kept at it (tasks.ts
 * materializeJob), so what reads ends_on (monthly invoices, exports) knows when the job ends.
 */
export function lastDate(job: RecurringJob): string | null {
  if (!/(^|;)COUNT=/.test(parseRule(job.recurrence_rule))) return null;
  return occurrenceDates({ ...job, ends_on: null }, job.starts_on, `${Number(job.starts_on.slice(0, 4)) + 100}-12-31`).at(-1) ?? null;
}

/** Human summary for the UI, e.g. "every 2 weeks on Tuesday". */
export function describeRule(rule: string): string {
  try {
    return RRule.fromString(parseRule(rule)).toText();
  } catch {
    return rule;
  }
}

/**
 * The repeats the job screen offers: every N days, weekly on some days, or monthly on a day of the
 * month or a weekday in it ("the last Friday"); and an end after a number of visits.
 */
export interface SimpleRepeat {
  freq: "DAILY" | "WEEKLY" | "MONTHLY";
  interval: number;
  /** MO, TU, WE, TH, FR, SA, SU (weekly). */
  days: string[];
  /** 1-28 (monthly by date). */
  monthDay: number;
  /** Monthly on a weekday instead: the week (1-4, or -1 for the last) and the day, "the first Monday". */
  weekday?: { week: number; day: string } | null;
  /** Ends after this many visits, counted from the first (COUNT); null keeps going. */
  count?: number | null;
}

const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];

/** A rule the job screen's editor can show (anything else reads as weekly on Monday there). */
export function parseSimpleRule(rule: string): SimpleRepeat {
  const parts = Object.fromEntries(rule.replace(/^RRULE:/i, "").split(";").map((p) => p.split("=")));
  const nth = parts.FREQ === "MONTHLY" ? /^([1-4]|-1)(MO|TU|WE|TH|FR|SA|SU)$/.exec(parts.BYDAY ?? "") : null;
  return {
    freq: parts.FREQ === "MONTHLY" ? "MONTHLY" : parts.FREQ === "DAILY" && !parts.BYDAY ? "DAILY" : "WEEKLY",
    interval: Math.max(1, Number(parts.INTERVAL ?? 1) || 1),
    days: parts.BYDAY && !nth ? String(parts.BYDAY).split(",").filter((d) => WEEKDAYS.includes(d)) : ["MO"],
    monthDay: Math.min(28, Math.max(1, Number(parts.BYMONTHDAY ?? 1) || 1)),
    weekday: nth ? { week: Number(nth[1]), day: nth[2]! } : null,
    count: parts.COUNT ? Math.max(1, Number(parts.COUNT) || 1) : null,
  };
}

/** "Every 2 weeks on Tuesday" as a rule; weekly with no days means Monday. */
export function buildSimpleRule(p: SimpleRepeat): string {
  const end = p.count ? `;COUNT=${p.count}` : "";
  if (p.freq === "DAILY") return `FREQ=DAILY;INTERVAL=${p.interval}${end}`;
  if (p.freq === "MONTHLY") return `FREQ=MONTHLY;INTERVAL=${p.interval};${p.weekday ? `BYDAY=${p.weekday.week}${p.weekday.day}` : `BYMONTHDAY=${p.monthDay}`}${end}`;
  return `FREQ=WEEKLY;INTERVAL=${p.interval};BYDAY=${(p.days.length ? p.days : ["MO"]).join(",")}${end}`;
}

/** The weekday of a date (YYYY-MM-DD) as a rule's day: "TU". */
export function ruleDay(date: string): string {
  return WEEKDAYS[(utcMidnight(date).getUTCDay() + 6) % 7];
}

const DAY_NAMES: Record<string, string> = { MO: "Monday", TU: "Tuesday", WE: "Wednesday", TH: "Thursday", FR: "Friday", SA: "Saturday", SU: "Sunday" };
const NTH: Record<string, string> = { "1": "first", "2": "second", "3": "third", "4": "fourth", "5": "fifth", "-1": "last" };

const ordinal = (n: number) => {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${suffix}`;
};
const joined = (items: string[]) => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`);
const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** How often a rule repeats, in its parts, or null for one only RRule can word. */
function cadenceText(parts: Record<string, string | undefined>): string | null {
  const interval = Math.max(1, Number(parts.INTERVAL ?? 1) || 1);
  const every = (unit: string, once: string) => (interval === 1 ? once : `Every ${interval} ${unit}s`);
  const days = parts.BYDAY ? parts.BYDAY.split(",") : [];
  const plainDays = days.every((d) => WEEKDAYS.includes(d));

  if (parts.BYMONTH || parts.BYHOUR) return null;
  if (parts.FREQ === "DAILY" && !days.length) return every("day", "Daily");
  if (parts.FREQ === "WEEKLY" && plainDays) {
    const ordered = WEEKDAYS.filter((d) => days.includes(d));
    if (interval === 1 && ordered.join() === "MO,TU,WE,TH,FR") return "Every weekday";
    return [every("week", "Weekly"), joined(ordered.map((d) => DAY_NAMES[d]!))].filter(Boolean).join(", ");
  }
  if (parts.FREQ === "MONTHLY") {
    const head = every("month", "Monthly");
    if (!days.length && !parts.BYMONTHDAY) return head;
    if (!days.length && !parts.BYSETPOS) {
      const day = Number(parts.BYMONTHDAY);
      if (Number.isInteger(day) && day >= 1 && day <= 31) return `${head}, the ${ordinal(day)}`;
      if (day === -1) return `${head}, the last day`;
    }
    // "1MO", or "MO" with BYSETPOS=1: the first Monday.
    const nth = days.length === 1 && !parts.BYMONTHDAY ? /^([+-]?\d)?([A-Z]{2})$/.exec(days[0]!) : null;
    const position = nth ? String(Number(nth[1] ?? parts.BYSETPOS)) : "";
    if (nth && DAY_NAMES[nth[2]!] && NTH[position]) return `${head}, ${NTH[position]} ${DAY_NAMES[nth[2]!]}`;
  }
  if (parts.FREQ === "YEARLY" && !days.length && !parts.BYMONTHDAY) return every("year", "Yearly");
  return null;
}

/**
 * How a recurring job's repeat reads on the job page, in sentence case: "Weekly, Monday and Thursday",
 * "Every 2 weeks, Tuesday, 12 visits", "Monthly, first Monday", "Monthly, the 15th", "Every 3 days".
 * RRule's own wording ("every month on the 1st Monday") is for rules this doesn't know, capitalized.
 */
export function repeatText(rule: string): string {
  const parts: Record<string, string | undefined> = Object.fromEntries(rule.replace(/^RRULE:/i, "").split(";").map((p) => p.split("=")));
  const text = cadenceText(parts);
  if (text === null) return capitalized(describeRule(rule));
  const count = Number(parts.COUNT);
  return parts.COUNT !== undefined && Number.isInteger(count) ? `${text}, ${count} ${count === 1 ? "visit" : "visits"}` : text;
}

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** A season as it reads: "April to October" for months in a row, else "June, July and December"; null for all year. */
export function seasonText(months: readonly number[] | null | undefined): string | null {
  const sorted = [...new Set(months ?? [])].sort((a, b) => a - b);
  if (!sorted.length || sorted.length === 12) return null;
  const inRow = sorted.every((m, i) => i === 0 || m === sorted[i - 1]! + 1);
  if (inRow && sorted.length > 2) return `${MONTH_NAMES[sorted[0]! - 1]} to ${MONTH_NAMES[sorted.at(-1)! - 1]}`;
  return joined(sorted.map((m) => MONTH_NAMES[m - 1]!));
}

/** How often recurring work is done, as a quote tells the client: "Every 2 weeks, Tuesday, April to October". */
export function scheduleText(rule: string, months?: readonly number[] | null): string {
  return [repeatText(rule), seasonText(months)].filter(Boolean).join(", ");
}
