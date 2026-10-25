/**
 * Time entries and pay: checking an entry before it's saved (Timesheets and AI assistants' time
 * tools), and a pay period's summary for each person, hourly and piece pay (Timesheets → Pay and the
 * pay tools). Crewtavo doesn't pay anyone; the summary is what the business pays through its own
 * payroll.
 */
import { isUnpaidBreak, type BreakPay } from "./breaks";
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

/** A team member's job pay in a period (per square, per job, per day): done and earned on a day in it, or paid with it. */
export interface PiecePay { user_id: string; total: number | string }

/** With piece pay in a period: overtime on it is the payroll service's to work out. */
export const PIECE_OVERTIME_NOTE =
  "Hours over 40 in a week are flagged for your payroll service. With piece pay, overtime is worked out from total pay and hours, which your payroll service does.";

/**
 * Each person's pay for a period: approved hours, with breaks paid as the company pays them
 * (`breaks`, settings.clock.breaks; unpaid ones are shown as break_hours), the hourly amount at the
 * rate each entry is costed at, their piece pay (`piece`: job pay done in the period), the amount
 * (hourly and piece together), hours over 40 in a week (flagged for the payroll service; the amount
 * is at straight time), and what's not approved or still running.
 */
export function paySummary(entries: readonly PayEntry[], rateOf: (entry: PayEntry) => number, nameOf: (userId: string) => string, timeZone: string, breaks: BreakPay, piece: readonly PiecePay[] = []) {
  const h = (ms: number) => ms / 3_600_000;
  const people = new Map<string, { user_id: string; name: string; hours: number; break_hours: number; overtime_hours: number; amount: number; piece: number; unapproved_hours: number; running: boolean; weeks: Map<string, number> }>();
  const rowOf = (userId: string) => {
    const row = people.get(userId) ?? { user_id: userId, name: nameOf(userId), hours: 0, break_hours: 0, overtime_hours: 0, amount: 0, piece: 0, unapproved_hours: 0, running: false, weeks: new Map() };
    people.set(userId, row);
    return row;
  };
  for (const p of piece) rowOf(p.user_id).piece += Number(p.total);
  for (const e of entries) {
    const row = rowOf(e.user_id);
    if (!e.ended_at) {
      row.running = true;
      continue;
    }
    const hours = Math.max(0, h(Date.parse(e.ended_at) - Date.parse(e.started_at)));
    if (isUnpaidBreak(e, breaks)) {
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
  const lines = [...people.values()].map(({ weeks, piece: pieceAmount, ...p }) => ({
    ...p,
    hours: round(p.hours),
    break_hours: round(p.break_hours),
    overtime_hours: round([...weeks.values()].reduce((s, w) => s + Math.max(0, w - 40), 0)),
    hourly_amount: round(p.amount),
    piece_amount: round(pieceAmount),
    amount: round(round(p.amount) + round(pieceAmount)),
    unapproved_hours: round(p.unapproved_hours),
  }));
  const pieceAmount = round(lines.reduce((s, l) => s + l.piece_amount, 0));
  return {
    people: lines.sort((a, b) => a.name.localeCompare(b.name)),
    hours: round(lines.reduce((s, l) => s + l.hours, 0)),
    hourly_amount: round(lines.reduce((s, l) => s + l.hourly_amount, 0)),
    piece_amount: pieceAmount,
    amount: round(lines.reduce((s, l) => s + l.amount, 0)),
    overtime_hours: round(lines.reduce((s, l) => s + l.overtime_hours, 0)),
    unapproved_hours: round(lines.reduce((s, l) => s + l.unapproved_hours, 0)),
    running_clocks: lines.filter((l) => l.running).length,
    /** PIECE_OVERTIME_NOTE when anyone has piece pay in the period. */
    overtime_note: pieceAmount > 0 ? PIECE_OVERTIME_NOTE : null,
  };
}
