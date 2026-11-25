/**
 * Open times for a visit, as a client picks them (Client Hub → Reschedule, and later a booking page):
 * the business's workday on the days it works, around the busy times of whoever is on it, from
 * tomorrow for three weeks.
 * Pure: the caller reads the schedule and passes the busy times in.
 */
import { dateTag, endWithStop } from "./regional";
import { scheduleSettings } from "./routing";
import { addDays, arrivalWindowMin, localDate, zonedTimeToUtc } from "./time";

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

// The times and days below are written the way the business's country writes them (core regional
// dateTag): "Tue, Nov 10, 9:00–11:00 AM" in the US, "Tue 10 Nov, 9:00–11:00" in the UK. Without a
// country, the US's way.
const clock = (ms: number, timeZone: string, country?: string | null) => new Date(ms).toLocaleTimeString(dateTag(country), { hour: "numeric", minute: "2-digit", timeZone });

/** The half of the day a time ends with, " AM", " p.m.", " pm", which two times can share; none on a 24-hour clock. */
const HALF = /\s(?:[AP]M|[ap]\.m\.|[ap]m)$/;

/** "9:00 AM", or with the business's arrival window "9:00–11:00 AM" (one AM or PM when both ends share it). */
export function slotTime(startsAt: string, timeZone: string, windowMin = 0, country?: string | null): string {
  const start = clock(Date.parse(startsAt), timeZone, country);
  if (!windowMin) return start;
  const end = clock(Date.parse(startsAt) + windowMin * 60_000, timeZone, country);
  const half = HALF.exec(end)?.[0];
  return half && start.endsWith(half) ? `${start.slice(0, -half.length)}–${end}` : `${start}–${end}`;
}

/** "Tue, Nov 10, 9:00–11:00 AM", or "Tue, Nov 10" for a whole day. */
export function slotLabel(slot: { date: string; starts_at: string | null }, timeZone: string, windowMin = 0, country?: string | null): string {
  const day = new Date(`${slot.date}T12:00:00Z`).toLocaleDateString(dateTag(country), { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
  return slot.starts_at ? `${day}, ${slotTime(slot.starts_at, timeZone, windowMin, country)}` : day;
}

// ---------------------------------------------------------------------------------------------
// Online booking: the times a booking form offers (Settings → Online booking, "Let clients pick a time")
// ---------------------------------------------------------------------------------------------

/** How far ahead a booking form offers times: the next 60 days. */
export const BOOKING_HORIZON_DAYS = 60;
/** The most days one look at a form's openings covers: a week. */
export const BOOKING_WEEK_DAYS = 7;
/** A form with no lead time books today too, but never a time less than this many minutes away. */
export const BOOKING_NOTICE_MIN = 60;
/** A visit booked online is this long unless the form says (intake_forms.slot_minutes). */
export const BOOKING_DEFAULT_MIN = 60;

/** The part of a booking form that decides its openings (intake_forms). */
export interface BookingRules {
  lead_time_days?: number | null;
  slot_minutes?: number | null;
  max_per_day?: number | null;
}

/** How long a visit booked from the form is, in minutes: what the form says, between 15 minutes and 8 hours. */
export function bookingLength(form: BookingRules): number {
  const set = Number(form.slot_minutes);
  return Number.isFinite(set) && set > 0 ? Math.min(Math.max(Math.round(set), 15), 480) : BOOKING_DEFAULT_MIN;
}

/** How many days ahead the first day offered is (0: today), at most a month. */
export function bookingLeadDays(form: BookingRules): number {
  const set = Number(form.lead_time_days);
  return Number.isFinite(set) && set > 0 ? Math.min(Math.round(set), 30) : 0;
}

const daysApart = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** The first and last day a form offers, where the business is: from its lead time, for the horizon. */
export function bookingDays(now: Date, timeZone: string, form: BookingRules): { first: string; last: string } {
  const first = addDays(localDate(now, timeZone), bookingLeadDays(form));
  return { first, last: addDays(first, BOOKING_HORIZON_DAYS - 1) };
}

export interface BookingLook {
  now: Date;
  timeZone: string;
  /** The company's settings: its working hours and days, time step and arrival window. */
  settings: unknown;
  form: BookingRules;
  /** When whoever the form books is busy (public.booking_busy_times). */
  busy: BusyTime[];
  /** How many bookings from this form each day already has (public.booking_day_counts), by date. */
  booked?: Record<string, number>;
  /** The first day to look at; days before the form's first are skipped. */
  from?: string;
  /** How many days to look at, from `from`: a week at most. */
  days?: number;
}

/**
 * The times a booking form offers on up to a week of days: the business's workday on the days it
 * works, from the form's lead time for the next 60 days, each as long as the form's visits, around
 * the busy times of whoever it books, and no day that already has the form's most bookings.
 */
export function bookingOpenings(look: BookingLook): OpenSlot[] {
  const { first, last } = bookingDays(look.now, look.timeZone, look.form);
  const from = look.from && look.from > first ? look.from : first;
  if (from > last) return [];
  const days = Math.max(0, Math.min(look.days ?? BOOKING_WEEK_DAYS, BOOKING_WEEK_DAYS, daysApart(from, last) + 1));
  const settings = (look.settings ?? {}) as { working_hours?: { start?: string; end?: string } };
  const most = Number(look.form.max_per_day);
  const soonest = look.now.getTime() + BOOKING_NOTICE_MIN * 60_000;
  // A clock time that doesn't exist the night the clocks go forward lands on one that does: offered once.
  const seen = new Set<string>();
  const once = (slot: OpenSlot) => !seen.has(slot.starts_at!) && Boolean(seen.add(slot.starts_at!));
  return openSlots({
    now: look.now,
    timeZone: look.timeZone,
    hours: { start: settings.working_hours?.start ?? "07:00", end: settings.working_hours?.end ?? "18:00" },
    workdays: workdays(look.settings),
    lengthMin: bookingLength(look.form),
    busy: look.busy,
    stepMin: slotStep(look.settings),
    windowMin: arrivalWindowMin(look.settings),
    leadDays: daysApart(localDate(look.now, look.timeZone), from),
    days,
  }).filter((slot) => Date.parse(slot.starts_at!) >= soonest && !(Number.isFinite(most) && most > 0 && (look.booked?.[slot.date] ?? 0) >= most) && once(slot));
}

/** "Eastern Time (New York)": a time zone as a booking page names it, so nobody reads the times as their own. */
export function timeZoneLabel(timeZone: string, at = new Date()): string {
  const place = timeZone.split("/").pop()!.replace(/_/g, " ");
  try {
    const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longGeneric" }).formatToParts(at).find((p) => p.type === "timeZoneName")?.value;
    return timeZone === "UTC" ? "UTC" : name && !/^GMT/.test(name) ? `${name} (${place})` : `${place} time`;
  } catch {
    return timeZone;
  }
}

/** "Tue, Jan 14, 10:00 to 11:00 AM": a time asked for or booked, start to end, as the office reads it. */
export function bookingSpan(startsAt: string, endsAt: string | null, timeZone: string, country?: string | null): string {
  const day = new Date(startsAt).toLocaleDateString(dateTag(country), { weekday: "short", month: "short", day: "numeric", timeZone });
  const start = clock(Date.parse(startsAt), timeZone, country);
  if (!endsAt) return `${day}, ${start}`;
  const end = clock(Date.parse(endsAt), timeZone, country);
  const half = HALF.exec(end)?.[0];
  return `${day}, ${half && start.endsWith(half) ? start.slice(0, -half.length) : start} to ${end}`;
}

/**
 * What the office is told about a time a client picked online, on the request and in its
 * notification: asked for and waiting while the request is new, booked once it isn't. Null for a
 * request with no time.
 */
export function askedTimeLine(request: { status: string; asked_starts_at?: string | null; asked_ends_at?: string | null }, timeZone: string, country?: string | null): string | null {
  if (!request.asked_starts_at) return null;
  const when = bookingSpan(request.asked_starts_at, request.asked_ends_at ?? null, timeZone, country);
  return request.status === "new" ? `${endWithStop(`Asked for ${when}`)} It waits for your OK.` : endWithStop(`Booked online for ${when}`);
}
