/**
 * Recurring jobs. Rules are RFC 5545 RRULEs without DTSTART (the job's start date supplies it),
 * e.g. "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU". Occurrences are calendar dates in the company's zone;
 * the scheduler adds the visit's start time in that zone.
 */
import { RRule } from "rrule";
import { addDays, isIsoDate } from "./time";

export interface RecurringJob {
  starts_on: string;              // YYYY-MM-DD
  ends_on?: string | null;        // YYYY-MM-DD, inclusive
  recurrence_rule: string;
  active_months?: number[] | null; // 1-12; null = all year
}

const utcMidnight = (date: string) => {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d));
};

/** Throws if the rule can't be parsed. Returns a normalized rule string. */
export function parseRule(rule: string): string {
  const text = rule.trim().replace(/^RRULE:/i, "");
  if (!/^FREQ=/i.test(text) && !/;FREQ=/i.test(text)) throw new RangeError("Recurrence rule needs a FREQ");
  if (/DTSTART/i.test(text)) throw new RangeError("Leave DTSTART out; the job's start date is used");
  RRule.parseString(text); // throws on bad input
  return text.toUpperCase();
}

/** Dates (YYYY-MM-DD) the job occurs on between `from` and `to`, inclusive. */
export function occurrenceDates(job: RecurringJob, from: string, to: string): string[] {
  if (!isIsoDate(job.starts_on) || !isIsoDate(from) || !isIsoDate(to)) throw new RangeError("Dates must be YYYY-MM-DD");
  const options = RRule.parseString(parseRule(job.recurrence_rule));
  const rule = new RRule({
    ...options,
    dtstart: utcMidnight(job.starts_on),
    until: job.ends_on ? utcMidnight(job.ends_on) : options.until,
  });
  const start = from > job.starts_on ? from : job.starts_on;
  const months = job.active_months?.length ? new Set(job.active_months) : null;
  return rule
    .between(utcMidnight(start), utcMidnight(addDays(to, 1)), true)
    .map((d) => d.toISOString().slice(0, 10))
    .filter((d) => d <= to && (!months || months.has(Number(d.slice(5, 7)))));
}

/** Human summary for the UI, e.g. "every 2 weeks on Tuesday". */
export function describeRule(rule: string): string {
  try {
    return RRule.fromString(parseRule(rule)).toText();
  } catch {
    return rule;
  }
}
