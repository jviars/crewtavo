/**
 * Home's collected figures from each day's total. The database adds up what came in on each of the
 * company's days (public.collected_by_day), so a busy month counts every payment: read as rows,
 * anything past the API's 1,000 a request was left out without a word. Pure, so it's unit tested.
 */
import { addDays, zonedTimeToUtc } from "@crewtavo/core/time";
import { monthToDate } from "@/lib/trends";
import { collectedByWeek, type Week } from "./weeks";

/** What came in on one of the company's days (YYYY-MM-DD), refunds taken away. */
export interface CollectedDay {
  day: string;
  collected: number | string;
}

/** The first day Home's figures need: the earlier of the 1st of last month and the start of the bars' first week. */
export function collectedSince(today: string, weeks: number): string {
  const [y, m] = today.split("-").map(Number) as [number, number];
  const lastMonth = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10);
  const firstWeek = addDays(today, -7 * weeks);
  return lastMonth < firstWeek ? lastMonth : firstWeek;
}

/**
 * This month so far against the same days of last month, and the weeks for the bars. `today` is the
 * company's local date. Each day's total stands in as one payment at noon that day in the company's
 * zone, so the month and the weeks are worked out by the same sums as they always were.
 */
export function collectedHistory(days: CollectedDay[], today: string, tz: string, weeks: number): { sameDaysLastMonth: number; weeks: Week[] } {
  const rows = days.map((d) => ({ amount: d.collected, received_at: zonedTimeToUtc(d.day, "12:00", tz).toISOString() }));
  const month = monthToDate(rows, today, tz);
  return { sameDaysLastMonth: month[Number(today.slice(8)) - 1]?.before ?? 0, weeks: collectedByWeek(rows, today, tz, weeks) };
}
