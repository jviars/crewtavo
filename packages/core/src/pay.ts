/**
 * Time entries and pay: checking an entry before it's saved (Timesheets and AI assistants' time
 * tools), and a pay period's summary for each person (Timesheets → Pay and the pay tools). Crewtavo
 * doesn't pay anyone; the summary is what the business pays through its own payroll.
 */
import { addDays, localDate, parseZonedTime } from "./time";

/**
 * A time entry's start and end from a date and clock times, in the company's zone. An end at or
 * before the start means the next day (night work). Null while a field is empty.
 */
export function entrySpan(date: string, start: string, end: string, timeZone: string): { startAt: Date; endAt: Date } | null {
  const startAt = parseZonedTime(date, start, timeZone);
  if (!startAt) return null;
  const endAt = parseZonedTime(end <= start ? addDays(date, 1) : date, end, timeZone);
  return endAt ? { startAt, endAt } : null;
}

export const MAX_ENTRY_HOURS = 16;

/** Why a time entry can't be saved as it is, or null: between a minute and 16 hours, not in the future, not over another of the person's entries. */
export function timeEntryProblem(entry: { startAt: Date; endAt: Date | null }, others: ReadonlyArray<{ started_at: string; ended_at: string | null }> = [], now = new Date()): string | null {
  if (entry.startAt.getTime() > now.getTime()) return "You can't add time in the future.";
  if (entry.endAt) {
    const hours = (entry.endAt.getTime() - entry.startAt.getTime()) / 3_600_000;
    if (!(hours > 0) || hours > MAX_ENTRY_HOURS) return `A single entry has to be between a minute and ${MAX_ENTRY_HOURS} hours.`;
  }
  const end = (entry.endAt ?? now).getTime();
  const clash = others.find((o) => Date.parse(o.started_at) < end && (o.ended_at ? Date.parse(o.ended_at) : now.getTime()) > entry.startAt.getTime());
  return clash ? "That overlaps another entry of theirs. Change or delete that one first." : null;
}

/** The Monday of a date's week (YYYY-MM-DD). */
export const mondayOf = (date: string) => addDays(date, -((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7));

export interface PayEntry { id: string; user_id: string; started_at: string; ended_at: string | null; category: string; approved_at: string | null }

/**
 * Each person's pay for a period: approved hours (breaks aren't paid, but are shown), the amount
 * at the rate each entry is costed at, hours over 40 in a week (flagged for the payroll service;
 * the amount is at straight time), and what's not approved or still running.
 */
export function paySummary(entries: readonly PayEntry[], rateOf: (entry: PayEntry) => number, nameOf: (userId: string) => string, timeZone: string) {
  const h = (ms: number) => ms / 3_600_000;
  const people = new Map<string, { user_id: string; name: string; hours: number; break_hours: number; overtime_hours: number; amount: number; unapproved_hours: number; running: boolean; weeks: Map<string, number> }>();
  for (const e of entries) {
    const row = people.get(e.user_id) ?? { user_id: e.user_id, name: nameOf(e.user_id), hours: 0, break_hours: 0, overtime_hours: 0, amount: 0, unapproved_hours: 0, running: false, weeks: new Map() };
    people.set(e.user_id, row);
    if (!e.ended_at) {
      row.running = true;
      continue;
    }
    const hours = Math.max(0, h(Date.parse(e.ended_at) - Date.parse(e.started_at)));
    if (e.category === "break") {
      row.break_hours += hours;
      continue;
    }
    if (!e.approved_at) {
      row.unapproved_hours += hours;
      continue;
    }
    row.hours += hours;
    row.amount += hours * rateOf(e);
    const week = mondayOf(localDate(new Date(e.started_at), timeZone));
    row.weeks.set(week, (row.weeks.get(week) ?? 0) + hours);
  }
  const round = (n: number) => Math.round(n * 100) / 100;
  const lines = [...people.values()].map(({ weeks, ...p }) => ({
    ...p,
    hours: round(p.hours),
    break_hours: round(p.break_hours),
    overtime_hours: round([...weeks.values()].reduce((s, w) => s + Math.max(0, w - 40), 0)),
    amount: round(p.amount),
    unapproved_hours: round(p.unapproved_hours),
  }));
  return {
    people: lines.sort((a, b) => a.name.localeCompare(b.name)),
    hours: round(lines.reduce((s, l) => s + l.hours, 0)),
    amount: round(lines.reduce((s, l) => s + l.amount, 0)),
    overtime_hours: round(lines.reduce((s, l) => s + l.overtime_hours, 0)),
    unapproved_hours: round(lines.reduce((s, l) => s + l.unapproved_hours, 0)),
    running_clocks: lines.filter((l) => l.running).length,
  };
}
