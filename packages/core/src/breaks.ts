/**
 * Whether break time is paid, as the company sets it (settings.clock.breaks). Platform-free, so
 * Timesheets, Reports and the API count paid hours the same way.
 *
 * Under federal rules (29 CFR 785.18 and 785.19), short rest breaks of about 20 minutes or less are
 * paid work time, and a real meal break, with the person fully off duty, needn't be. That's the
 * default: a quick water break in the heat is paid, a half-hour lunch isn't.
 */
export type BreakPay = "short_paid" | "paid" | "unpaid";

export const BREAK_PAY_LABELS: Record<BreakPay, string> = {
  short_paid: "Paid if 20 minutes or less",
  paid: "Always paid",
  unpaid: "Never paid",
};

/** The longest break that's still paid under the federal rule. */
export const SHORT_BREAK_MINUTES = 20;

/** The company's rule, from its settings. */
export function breakPay(settings: unknown): BreakPay {
  const value = (settings as { clock?: { breaks?: unknown } } | null | undefined)?.clock?.breaks;
  return value === "paid" || value === "unpaid" ? value : "short_paid";
}

/**
 * Whether a time entry is break time the company doesn't pay for, so it's left out of paid hours.
 * A break still running is judged on its length so far.
 */
export function isUnpaidBreak(entry: { category: string; started_at: string; ended_at: string | null }, pay: BreakPay, now = Date.now()): boolean {
  if (entry.category !== "break" || pay === "paid") return false;
  if (pay === "unpaid") return true;
  const minutes = ((entry.ended_at ? Date.parse(entry.ended_at) : now) - Date.parse(entry.started_at)) / 60_000;
  return minutes > SHORT_BREAK_MINUTES;
}
