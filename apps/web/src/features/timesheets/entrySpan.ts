import { addDays, parseZonedTime } from "@crewtavo/core/time";

/**
 * A time entry's start and end from the form's date and clock times, in the company's zone. An
 * end at or before the start means the next day (night work). Null while a field is empty, so a
 * cleared date shows as a field error instead of breaking the page.
 */
export function entrySpan(date: string, start: string, end: string, timeZone: string): { startAt: Date; endAt: Date } | null {
  const startAt = parseZonedTime(date, start, timeZone);
  if (!startAt) return null;
  const endAt = parseZonedTime(end <= start ? addDays(date, 1) : date, end, timeZone);
  return endAt ? { startAt, endAt } : null;
}
