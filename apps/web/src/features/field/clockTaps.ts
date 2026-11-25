/**
 * Clock taps (start, stop, switch) from the clock card and the crew clock, as field actions: each is
 * saved with when it was tapped, so with no signal it waits on the phone and goes out in order with
 * the visit taps (lib/offline.ts, fieldActions.setClock).
 *
 * Until a tap has gone, the clock cards show what it will do: what the server last said, then each
 * waiting tap in the order it was made (clockAfter). Nothing here talks to the server.
 */
import type { QueryClient } from "@tanstack/react-query";
import type { VisitStatusChange } from "./fieldActions";
import type { ClockPlace, TimerCategory } from "./fieldData";
import { msg, t } from "@/lib/i18n";
import { dateLocale } from "@/lib/format";

/** What each kind of clock is called (fieldData exports it as CATEGORY_LABELS): shown with t(). */
export const CLOCK_LABELS: Record<TimerCategory, string> = { visit: msg("On a visit"), assessment: msg("Assessment"), drive: msg("Driving"), shop: msg("Shop time"), break: msg("On break"), other: msg("Other work") };

/** What a clock goes onto: a visit, or driving, the shop, a break or other work. */
export interface ClockTarget {
  category: TimerCategory;
  /** The visit, with its title to show while the tap waits. */
  visit?: { id: string; jobId: string | null; title: string };
}

export interface ClockChange {
  companyId: string;
  /** Whose phone it was tapped on. */
  userId: string;
  /** Whose clocks: their own, or the people a crew lead clocks in or out with one tap. */
  who: string[];
  /** What they go onto. Null stops the clock. */
  target: ClockTarget | null;
  /** When it was tapped. */
  at: string;
  /** Where the phone was then, where the company keeps that. */
  place?: ClockPlace;
  /** Made on the phone, one for each person clocked in, so a tap sent twice starts one clock each. */
  entryIds?: Record<string, string>;
  /**
   * Made by the phone itself at a visit's property (the clock at the property, geofence.ts), not
   * tapped: the clocks it starts and stops are marked so for Timesheets, it never ends a break, and
   * it starts a clock on a visit only when theirs is off or on driving.
   */
  geofence?: boolean;
  /** Only a clock on this visit moves (leaving its property); any other clock stays as it is. */
  fromVisit?: string;
}

/** A clock tap as it's saved: dated now, with an id for each clock it starts. */
export function clockChange(session: { userId: string; company: { id: string } }, who: string[], target: ClockTarget | null, place?: ClockPlace, at = new Date().toISOString()): ClockChange {
  return { companyId: session.company.id, userId: session.userId, who, target, at, ...(place && { place }), ...(target && { entryIds: Object.fromEntries(who.map((id) => [id, crypto.randomUUID()])) }) };
}

/** Whether a clock began before a moment. As moments, not text: the database writes a time another way than the phone does. */
export const startedBefore = (entry: { started_at: string }, at: string) => Date.parse(entry.started_at) < Date.parse(at);

/** A running clock as the clock cards show it. */
export interface ShownClock {
  id: string;
  category: string;
  started_at: string;
  visit: { id: string; title: string } | null;
}

/** A tap that changes clocks: one from a clock card, or a visit's On my way, Start or Complete. */
export type ClockTap = { key: "clock"; change: ClockChange } | { key: "visit-status"; change: VisitStatusChange; title?: string };

const travel = (at: string): ShownClock => ({ id: `tap:${at}`, category: "drive", started_at: at, visit: null });

/**
 * Someone's clock after a tap, given what it was before: what the tap will do once it's sent, as
 * setClock and setVisitStatus (and, for a finished visit, the database) do it. Applying a tap twice
 * changes nothing more, so a screen can show it at once and again over what the server says.
 */
export function clockAfter(clock: ShownClock | null, tap: ClockTap, userId: string): ShownClock | null {
  if (tap.key === "clock") {
    const { who, target, at } = tap.change;
    if (!who.includes(userId)) return clock;
    // A clock that began after the tap (the office started it since) stays: the tap lost to it.
    if (clock && !startedBefore(clock, at)) return clock;
    // Leaving a property moves only a clock on that visit; the phone never ends a break by itself.
    if (tap.change.fromVisit && clock?.visit?.id !== tap.change.fromVisit) return clock;
    if (tap.change.geofence && clock?.category === "break") return clock;
    // Arriving at a property, it starts a clock only over none or driving: never off another visit, the shop or other work.
    if (tap.change.geofence && target?.visit && !tap.change.fromVisit && clock && clock.category !== "drive") return clock;
    if (!target) return null;
    if (target.visit && clock?.visit?.id === target.visit.id) return clock;
    return { id: `tap:${at}`, category: target.category, started_at: at, visit: target.visit ? { id: target.visit.id, title: target.visit.title } : null };
  }
  const v = tap.change;
  const day = v.day === true && !v.sub;
  const onVisit = clock?.visit?.id === v.visitId;
  // Finishing a visit ends every clock still running on it, or on the whole-day clock moves it to travel.
  if (v.status === "completed" && onVisit && clock && startedBefore(clock, v.at)) return day ? travel(v.at) : null;
  if (v.userId !== userId || v.clock === false) return clock;
  if (clock && !startedBefore(clock, v.at)) return clock;
  if (v.status === "in_progress") return onVisit ? clock : { id: `tap:${v.at}`, category: "visit", started_at: v.at, visit: { id: v.visitId, title: tap.title ?? t("Visit") } };
  // Complete stops whatever they were on; on the whole-day clock only a clock on this visit moves (above).
  if (v.status === "completed") return day ? clock : null;
  if (v.status === "en_route" && day) return clock?.category === "drive" && !clock.visit ? clock : travel(v.at);
  return clock;
}

/** A visit's title as this phone has it (My day or the visit's own screen), for a clock a waiting Start will put on it. */
function visitTitle(queryClient: QueryClient, visitId: string): string | undefined {
  const own = queryClient.getQueryData<{ title?: string } | null>(["field-visit", visitId]);
  if (own?.title) return own.title;
  for (const [, day] of queryClient.getQueriesData<{ today?: Array<{ id: string; title: string }>; tomorrow?: Array<{ id: string; title: string }> }>({ queryKey: ["field"] })) {
    const found = [...(day?.today ?? []), ...(day?.tomorrow ?? [])].find((v) => v.id === visitId);
    if (found) return found.title;
  }
  return undefined;
}

/** The clock and visit taps made in a company on this phone that haven't gone yet, in the order they were made. */
export function waitingClockTaps(queryClient: QueryClient, companyId: string): ClockTap[] {
  const taps: ClockTap[] = [];
  for (const m of queryClient.getMutationCache().getAll()) {
    const key = m.options.mutationKey?.[0];
    if (m.state.status !== "pending" || (key !== "clock" && key !== "visit-status")) continue;
    const change = m.state.variables as ClockChange | VisitStatusChange | undefined;
    if (change?.companyId !== companyId) continue;
    if (key === "clock") taps.push({ key, change: change as ClockChange });
    else taps.push({ key, change: change as VisitStatusChange, title: visitTitle(queryClient, (change as VisitStatusChange).visitId) });
  }
  return taps;
}

/** Someone's clock as the server has it, with the taps still waiting on this phone on top. */
export const withWaitingTaps = (queryClient: QueryClient, companyId: string, userId: string, clock: ShownClock | null) =>
  waitingClockTaps(queryClient, companyId).reduce((shown, tap) => clockAfter(shown, tap, userId), clock);

/** A crew's running clocks (the crew clock's rows), with the taps still waiting on top. */
export interface CrewClockRow extends ShownClock { user_id: string }
export function crewAfter(rows: readonly CrewClockRow[], people: readonly string[], taps: readonly ClockTap[]): CrewClockRow[] {
  return people.flatMap((id) => {
    const after = taps.reduce<ShownClock | null>((shown, tap) => clockAfter(shown, tap, id), rows.find((r) => r.user_id === id) ?? null);
    return after ? [{ ...after, user_id: id }] : [];
  });
}

/**
 * Show a tap at once on the clock cards this phone holds: the person's own clock and the crew
 * clock. Called as the tap is made (it may wait for signal), and for a visit's status taps too.
 */
export function showClockTap(queryClient: QueryClient, tap: ClockTap) {
  const { companyId } = tap.change;
  for (const [key, shown] of queryClient.getQueriesData<ShownClock | null>({ queryKey: ["running-timer", companyId] })) {
    // Not loaded yet (no signal since the app opened): the tap is still shown, over nothing.
    queryClient.setQueryData<ShownClock | null>(key, clockAfter(shown ?? null, tap, String(key[2])));
  }
  for (const [key, rows] of queryClient.getQueriesData<CrewClockRow[]>({ queryKey: ["crew-clock", companyId] })) {
    // Only over a crew this phone has loaded: the rest of them aren't known to be off the clock.
    if (rows) queryClient.setQueryData<CrewClockRow[]>(key, crewAfter(rows, String(key[2]).split(",").filter(Boolean), [tap]));
  }
}

/** "2:15 PM" on the phone's own clock, for saying which tap is meant. */
const tappedAt = (at: string) => new Date(at).toLocaleTimeString(dateLocale(), { hour: "numeric", minute: "2-digit" });

/** What a clock tap's confirmation says once the server has it (a toast: no closing period). None when it lost (clockLost says that). */
export function clockSaved(result: { lost: readonly string[] } | undefined, change: ClockChange, options: { day?: boolean; nameOf?: (id: string) => string } = {}): string | null {
  if (result?.lost.length) return null;
  const own = change.who.length === 1 && change.who[0] === change.userId;
  if (!own) {
    const name = change.who.length === 1 && options.nameOf ? options.nameOf(change.who[0]!) : null;
    if (name) return change.target ? t("Clocked in {name}", { name }) : t("Clocked out {name}", { name });
    return change.target
      ? t.plural(change.who.length, { one: "Clocked in {count} people", other: "Clocked in {count} people" })
      : t.plural(change.who.length, { one: "Clocked out {count} people", other: "Clocked out {count} people" });
  }
  if (!change.target) return options.day ? t("Clock stopped for the day") : t("Clock stopped");
  return t("{what}: clock started", { what: change.target.visit?.title ?? t(CLOCK_LABELS[change.target.category]) });
}

/**
 * A clock tap that lost to something newer: by the time it arrived, a clock that began after the
 * tap was running (the office or a crew lead started one, on Timesheets or another phone). The newer
 * clock stays as it is and the tap changes nothing more. Null when the tap went through.
 */
export function clockLost(result: { lost: readonly string[] }, change: ClockChange, nameOf?: (id: string) => string): { title: string; body: string } | null {
  if (!result.lost.length) return null;
  const own = result.lost.length === 1 && result.lost[0] === change.userId;
  const one = result.lost.length === 1;
  const what = change.target ? (change.target.visit?.title ?? t(CLOCK_LABELS[change.target.category])) : t("Stop");
  const time = tappedAt(change.at);
  const name = one && nameOf ? nameOf(result.lost[0]!) : null;
  return {
    title: own
      ? t("Your clock was changed after you tapped")
      : name
        ? t("{name}'s clock was changed after you tapped", { name })
        : t.plural(result.lost.length, { one: "{count} people's clock was changed after you tapped", other: "{count} people's clocks were changed after you tapped" }),
    body: own
      ? t("{what} at {time} arrived after a newer clock had started, so your clock stays as it is now. Check Timesheets if that's wrong.", { what, time })
      : one
        ? t("{what} at {time} arrived after a newer clock had started, so it stays as it is now. Check Timesheets if that's wrong.", { what, time })
        : t("{what} at {time} arrived after a newer clock had started, so they stay as they are now. Check Timesheets if that's wrong.", { what, time }),
  };
}
