/**
 * How a recurring job's repeat reads ("Every 2 weeks, Tuesday, 12 visits"), its season ("April to
 * October") and both together, as a quote says them. They're in core (recurrence.ts) so the API
 * says them the same way; the job page, quotes and documents import them from here.
 */
export { repeatText, scheduleText, seasonText } from "@crewtavo/core/recurrence";
