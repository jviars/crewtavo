/** Money collected week by week for Home's bars. Pure, so it's unit tested. */
import { addDays, localDate } from "@crewtavo/core/time";
import { shortDate } from "../finance/range";

export interface Week {
  /** The week's Monday (YYYY-MM-DD). */
  from: string;
  /** "Oct 26", under its bar. */
  label: string;
  total: number;
}

/**
 * What came in each of the last `weeks` weeks, Monday to Sunday in the company's time zone, ending
 * with this week so far. `today` is the company's local date. Weeks before the first money came in
 * are left off, so a business new to Crewtavo starts at its first week rather than a row of empty bars.
 */
export function collectedByWeek(payments: Array<{ amount: number | string; received_at: string }>, today: string, tz: string, weeks = 6): Week[] {
  const monday = addDays(today, -((new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7));
  const out = Array.from({ length: weeks }, (_, i) => {
    const from = addDays(monday, -7 * (weeks - 1 - i));
    return { from, label: shortDate(from), total: 0 };
  });
  const start = out[0]!.from;
  for (const p of payments) {
    const day = localDate(new Date(p.received_at), tz);
    if (day < start || day > today) continue;
    out[Math.floor((Date.parse(day) - Date.parse(start)) / (7 * 86_400_000))]!.total += Number(p.amount);
  }
  const first = out.findIndex((w) => w.total !== 0);
  return first < 0 ? [] : out.slice(first).map((w) => ({ ...w, total: Math.round(w.total * 100) / 100 }));
}
