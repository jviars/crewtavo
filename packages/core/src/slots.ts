/**
 * Open times for a visit, as a client picks them (Client Hub → Reschedule, and later a booking page):
 * the business's workday on the days it works, around the busy times of whoever is on it, from
 * tomorrow for three weeks.
 * Pure: the caller reads the schedule and passes the busy times in.
 */
import { scheduleSettings } from "./routing";
import { addDays, localDate, zonedTimeToUtc } from "./time";

/** Not today: the first day offered is this many days out. */
export const SLOT_LEAD_DAYS = 1;
/** How many days are offered, from the first. */
export const SLOT_DAYS = 21;

/** A time someone is already taken, as instants (ms). */
export interface BusyTime {
  start: number;
  end: number;
}

/** A time offered: a start and end, or a whole day (both null) for an anytime visit. */
export interface OpenSlot {
  date: string;
  starts_at: string | null;
  ends_at: string | null;
}

export interface SlotRules {
  now: Date;
  timeZone: string;
  /** The workday, "07:00" to "18:00" (settings.working_hours). */
  hours: { start: string; end: string };
  /** The days the business works, 0 (Sunday) to 6 (workdays()); the others are never offered. */
  workdays?: number[];
  /** How long the visit takes. */
  lengthMin: number;
  /** When the people on it are already busy: their other visits, and busy calendar events. */
  busy: BusyTime[];
  /** Minutes between the starts offered (slotStep). */
  stepMin: number;
  /** The business's arrival window (0: none). Windows follow on, so they don't overlap. */
  windowMin?: number;
  /** A visit with no start time: whole days are offered instead of times. */
  anytime?: boolean;
  /** The visit's own time now, which isn't offered again. */
  current?: { date: string | null; starts_at: string | null };
  leadDays?: number;
  days?: number;
}

const minutesOf = (t: string) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(t);
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
};
const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

export function openSlots(r: SlotRules): OpenSlot[] {
  const first = addDays(localDate(r.now, r.timeZone), r.leadDays ?? SLOT_LEAD_DAYS);
  const startMin = minutesOf(r.hours.start);
  const endMin = minutesOf(r.hours.end);
  const step = Math.max(r.stepMin, r.windowMin ?? 0, 1);
  const need = Math.max(1, r.lengthMin) * 60_000;
  const current = r.current?.starts_at ? Date.parse(r.current.starts_at) : null;
  const out: OpenSlot[] = [];
  for (let i = 0; i < (r.days ?? SLOT_DAYS); i++) {
    const date = addDays(first, i);
    if (r.workdays && !r.workdays.includes(weekday(date))) continue;
    const dayEnd = zonedTimeToUtc(date, hhmm(endMin || 0), r.timeZone).getTime();
    // Starts on the step from the start of the workday, each long enough to finish by its end.
    const free: number[] = [];
    for (let m = startMin; m < endMin; m += step) {
      const start = zonedTimeToUtc(date, hhmm(m), r.timeZone).getTime();
      if (start + need <= dayEnd && !r.busy.some((b) => b.start < start + need && b.end > start)) free.push(start);
    }
    if (r.anytime) {
      // A whole day, while the people on it have the visit's length free some time that day.
      if (free.length && date !== r.current?.date) out.push({ date, starts_at: null, ends_at: null });
      continue;
    }
    for (const start of free) {
      if (start !== current) out.push({ date, starts_at: new Date(start).toISOString(), ends_at: new Date(start + need).toISOString() });
    }
  }
  return out;
}

/** The day of the week of a date, 0 (Sunday) to 6. */
export const weekday = (date: string) => new Date(`${date}T12:00:00Z`).getUTCDay();

/**
 * The days the business works (settings.working_hours.days, Settings → Company), 0 (Sunday) to 6:
 * every day until it picks, so a business that works Saturdays keeps being offered them as before.
 * Hand-edited days that aren't one are skipped.
 */
export function workdays(settings: unknown): number[] {
  return pickedWorkdays(settings) ?? [0, 1, 2, 3, 4, 5, 6];
}

/** The days the business picked to work, or null when it never did. */
function pickedWorkdays(settings: unknown): number[] | null {
  const days = (settings as { working_hours?: { days?: unknown } } | null)?.working_hours?.days;
  const valid = Array.isArray(days) ? days.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6) : [];
  return valid.length ? [...new Set(valid)].sort() : null;
}

/**
 * The days multi-day work skips ("Skip days you don't work"), 0 (Sunday) to 6: the ones the business
 * doesn't work. Never all seven, so there's always a day to book.
 */
export function daysOff(settings: unknown): number[] {
  const picked = pickedWorkdays(settings);
  // Never picked means every day (workdays()), but this skipped weekends before there was a choice, so it still does.
  return picked ? [0, 1, 2, 3, 4, 5, 6].filter((d) => !picked.includes(d)) : [0, 6];
}

/**
 * Minutes between the times offered: the schedule's time step when the business set one (Settings →
 * Schedule), else 30. Never under 15: a client picks from a list, and 5-minute starts would fill it.
 */
export function slotStep(settings: unknown): number {
  const set = (settings as { schedule?: { time_step?: unknown } } | null)?.schedule?.time_step;
  return typeof set === "number" ? Math.max(15, scheduleSettings(settings).timeStep) : 30;
}

/** Whether a client can move or cancel a visit online: it hasn't started, and it's past the lead time (not today). */
export const changeableOnline = (visit: { status: string; scheduled_on: string | null }, today: string, leadDays = SLOT_LEAD_DAYS) =>
  visit.status === "scheduled" && Boolean(visit.scheduled_on) && visit.scheduled_on! >= addDays(today, leadDays);

const clock = (ms: number, timeZone: string) => new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone });

/** "9:00 AM", or with the business's arrival window "9:00–11:00 AM" (one AM or PM when both ends share it). */
export function slotTime(startsAt: string, timeZone: string, windowMin = 0): string {
  const start = clock(Date.parse(startsAt), timeZone);
  if (!windowMin) return start;
  const end = clock(Date.parse(startsAt) + windowMin * 60_000, timeZone);
  const half = /\s[AP]M$/.exec(end)?.[0];
  return half && start.endsWith(half) ? `${start.slice(0, -half.length)}–${end}` : `${start}–${end}`;
}

/** "Tue, Nov 10, 9:00–11:00 AM", or "Tue, Nov 10" for a whole day. */
export function slotLabel(slot: { date: string; starts_at: string | null }, timeZone: string, windowMin = 0): string {
  const day = new Date(`${slot.date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  return slot.starts_at ? `${day}, ${slotTime(slot.starts_at, timeZone, windowMin)}` : day;
}
