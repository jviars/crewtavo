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

/** What someone was marked paid for a period, as it was recorded then (their pay_period_lines row). */
export interface PaidLine { user_id: string; hours: number | string; overtime_hours: number | string; break_hours: number | string; amount: number | string; piece_amount: number | string }

export interface PayOptions {
  /**
   * True for an entry the person has already been paid for under another period (its day is in a
   * period they're marked paid for). Periods can overlap ("Last week", then "Last 2 weeks"), and
   * hours are only ever paid once: these are shown as already paid and left out of what's owed.
   */
  alreadyPaid?: (entry: PayEntry) => boolean;
  /** The lines of the people marked paid for this very period: they show what was recorded then. */
  paidLines?: readonly PaidLine[];
  /**
   * Time from the Monday of the period's first week up to the period's start, when the period
   * starts mid-week: it isn't in the period, but it counts towards that week's 40 hours.
   */
  weekBefore?: readonly PayEntry[];
}

/** A week's overtime starts after this many approved hours. */
export const OVERTIME_AFTER_HOURS = 40;

/**
 * Each person's pay for a period: approved hours, with breaks paid as the company pays them
 * (`breaks`, settings.clock.breaks; unpaid ones are shown as break_hours), the hourly amount at the
 * rate each entry is costed at, their piece pay (`piece`: job pay done in the period), the amount
 * (hourly and piece together), hours over 40 in a week (flagged for the payroll service; the amount
 * is at straight time), and what's not approved or still running. Hours already paid with another
 * period (`options.alreadyPaid`) aren't in any of that: they're already_paid_hours. Someone marked
 * paid for this period (`options.paidLines`) shows what they were paid for, as recorded.
 *
 * Overtime is judged on the whole week, Monday to Sunday, wherever the period cuts it: an hour is
 * overtime when it comes after the person's 40th approved hour of that week, in the order worked.
 * So a week's overtime goes to the period its late hours fall in (50 hours split 30 and 20 by a
 * month-end: none in the first month, 10 in the second), which needs the week's earlier time
 * (`options.weekBefore`) but nothing after the period: later hours never make earlier ones overtime.
 * That's also how it fits with hours being paid once. Overtime belongs to the hours it falls on, so
 * it's paid, and recorded, with the period that pays those hours. Hours already paid with another
 * period still count towards the week's 40, but their overtime was that period's and isn't counted
 * here again.
 */
export function paySummary(entries: readonly PayEntry[], rateOf: (entry: PayEntry) => number, nameOf: (userId: string) => string, timeZone: string, breaks: BreakPay, piece: readonly PiecePay[] = [], options: PayOptions = {}) {
  const h = (ms: number) => ms / 3_600_000;
  const people = new Map<string, { user_id: string; name: string; hours: number; break_hours: number; overtime_hours: number; amount: number; piece: number; unapproved_hours: number; running: boolean; already_paid_hours: number; already_paid_amount: number; worked: Array<{ week: string; at: number; hours: number; owed: boolean }> }>();
  const rowOf = (userId: string) => {
    const row = people.get(userId) ?? { user_id: userId, name: nameOf(userId), hours: 0, break_hours: 0, overtime_hours: 0, amount: 0, piece: 0, unapproved_hours: 0, running: false, already_paid_hours: 0, already_paid_amount: 0, worked: [] };
    people.set(userId, row);
    return row;
  };
  for (const p of piece) rowOf(p.user_id).piece += Number(p.total);
  const paidHere = new Map((options.paidLines ?? []).map((l) => [l.user_id, l]));
  for (const id of paidHere.keys()) rowOf(id);
  // Approved, paid time, for the week's count of 40: `owed` when this period is the one paying it.
  const worked = (e: PayEntry, hours: number, owed: boolean) => rowOf(e.user_id).worked.push({ week: mondayOf(localDate(new Date(e.started_at), timeZone)), at: Date.parse(e.started_at), hours, owed });
  const inPeriod = new Set(entries.map((e) => e.id));
  for (const e of options.weekBefore ?? []) {
    if (inPeriod.has(e.id) || !e.ended_at || !e.approved_at || isUnpaidBreak(e, breaks)) continue;
    worked(e, Math.max(0, h(Date.parse(e.ended_at) - Date.parse(e.started_at))), false);
  }
  for (const e of entries) {
    const row = rowOf(e.user_id);
    const settled = options.alreadyPaid?.(e) ?? false;
    if (!e.ended_at) {
      row.running ||= !settled;
      continue;
    }
    const hours = Math.max(0, h(Date.parse(e.ended_at) - Date.parse(e.started_at)));
    if (settled) {
      // Settled with that other period, and locked with it: nothing of it is owed or waited on here.
      if (e.approved_at && !isUnpaidBreak(e, breaks)) {
        row.already_paid_hours += hours;
        row.already_paid_amount += hours * rateOf(e);
        worked(e, hours, false);
      }
      continue;
    }
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
    worked(e, hours, true);
  }
  /** The hours this period pays that come after the 40th of their week. */
  const overtime = (spans: ReadonlyArray<{ week: string; at: number; hours: number; owed: boolean }>) => {
    const soFar = new Map<string, number>();
    let over = 0;
    for (const span of [...spans].sort((a, b) => a.at - b.at)) {
      const before = soFar.get(span.week) ?? 0;
      soFar.set(span.week, before + span.hours);
      if (span.owed) over += Math.max(0, before + span.hours - OVERTIME_AFTER_HOURS) - Math.max(0, before - OVERTIME_AFTER_HOURS);
    }
    return over;
  };
  const round = (n: number) => Math.round(n * 100) / 100;
  const lines = [...people.values()].map(({ worked: spans, piece: pieceAmount, ...p }) => {
    const line = {
      ...p,
      hours: round(p.hours),
      break_hours: round(p.break_hours),
      overtime_hours: round(overtime(spans)),
      hourly_amount: round(p.amount),
      piece_amount: round(pieceAmount),
      amount: round(round(p.amount) + round(pieceAmount)),
      unapproved_hours: round(p.unapproved_hours),
      already_paid_hours: round(p.already_paid_hours),
      already_paid_amount: round(p.already_paid_amount),
    };
    const paid = paidHere.get(p.user_id);
    if (!paid) return line;
    // Paid for this period: what the line recorded is what they were paid for. It isn't worked out
    // again, so a later period that overlaps this one can't change what this one says.
    return {
      ...line,
      hours: Number(paid.hours),
      break_hours: Number(paid.break_hours),
      overtime_hours: Number(paid.overtime_hours),
      hourly_amount: round(Number(paid.amount) - Number(paid.piece_amount)),
      piece_amount: Number(paid.piece_amount),
      amount: Number(paid.amount),
      already_paid_hours: 0,
      already_paid_amount: 0,
    };
  });
  const pieceAmount = round(lines.reduce((s, l) => s + l.piece_amount, 0));
  return {
    people: lines.sort((a, b) => a.name.localeCompare(b.name)),
    hours: round(lines.reduce((s, l) => s + l.hours, 0)),
    hourly_amount: round(lines.reduce((s, l) => s + l.hourly_amount, 0)),
    piece_amount: pieceAmount,
    amount: round(lines.reduce((s, l) => s + l.amount, 0)),
    overtime_hours: round(lines.reduce((s, l) => s + l.overtime_hours, 0)),
    unapproved_hours: round(lines.reduce((s, l) => s + l.unapproved_hours, 0)),
    /** Hours in these dates that were paid with another period, so they aren't in the figures above. */
    already_paid_hours: round(lines.reduce((s, l) => s + l.already_paid_hours, 0)),
    already_paid_amount: round(lines.reduce((s, l) => s + l.already_paid_amount, 0)),
    running_clocks: lines.filter((l) => l.running).length,
    /** PIECE_OVERTIME_NOTE when anyone has piece pay in the period. */
    overtime_note: pieceAmount > 0 ? PIECE_OVERTIME_NOTE : null,
  };
}
