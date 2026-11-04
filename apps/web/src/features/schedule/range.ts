/** The days a schedule view shows, and stepping it a day, a week or a month at a time. */
import { addDaysIso } from "@/lib/format";

/** How much a view shows: Day and Map a day, Week a week, Month a month, and List any of the three. */
export type Span = "day" | "week" | "month";

/** Monday of the week containing `date`. */
export function weekStart(date: string) {
  const d = new Date(`${date}T12:00:00Z`);
  return addDaysIso(date, -((d.getUTCDay() + 6) % 7));
}

/** The 15th of the month after (1) or before (-1) `date`'s: a day every month has. */
export function stepMonth(date: string, dir: 1 | -1) {
  const d = new Date(`${date.slice(0, 7)}-15T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + dir);
  return d.toISOString().slice(0, 10);
}

/**
 * The days shown: `anchor`'s day, its week from Monday, or its month. The month grid fills six
 * whole weeks; the list (`grid` false) shows only the month's own days.
 */
export function spanDays(span: Span, anchor: string, grid = true): string[] {
  const run = (from: string, n: number) => Array.from({ length: n }, (_, i) => addDaysIso(from, i));
  if (span === "day") return [anchor];
  if (span === "week") return run(weekStart(anchor), 7);
  const first = `${anchor.slice(0, 7)}-01`;
  if (grid) return run(weekStart(first), 42);
  const last = addDaysIso(`${stepMonth(anchor, 1).slice(0, 7)}-01`, -1);
  return run(first, Number(last.slice(8)));
}
