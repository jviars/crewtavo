/** Report date ranges (in the company's time zone) and how to bucket them for charts. */
import { addDays, localDate } from "@crewtavo/core/time";

// The ranges themselves are shared with AI assistants' report tools (packages/core/src/reports.ts).
export { hoursBetween, REPORT_PRESETS as PRESETS, resolveRange, type ReportPreset as PresetKey, type ReportRange as Range } from "@crewtavo/core/reports";
import type { ReportRange as Range } from "@crewtavo/core/reports";

const iso = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);

export const shortDate = (d: string) => new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

export interface Bucket {
  key: string;
  label: string;
  /** Longer label for tooltips. */
  title: string;
  from: string;
  to: string;
}

/** Days for a month or less, weeks up to ~4 months, months beyond that. */
export function bucketsFor(range: Range): Bucket[] {
  const out: Bucket[] = [];
  if (range.days <= 31) {
    for (let d = range.from; d <= range.to; d = addDays(d, 1)) {
      const date = new Date(`${d}T12:00:00Z`);
      out.push({ key: d, label: String(date.getUTCDate()), title: date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" }), from: d, to: d });
    }
  } else if (range.days <= 120) {
    // Weeks starting Monday.
    const first = new Date(`${range.from}T12:00:00Z`);
    let d = addDays(range.from, -((first.getUTCDay() + 6) % 7));
    while (d <= range.to) {
      const end = addDays(d, 6);
      const from = d < range.from ? range.from : d;
      const to = end > range.to ? range.to : end;
      out.push({ key: d, label: shortDate(from), title: `Week of ${shortDate(from)}`, from, to });
      d = addDays(d, 7);
    }
  } else {
    let [y, m] = range.from.split("-").map(Number) as [number, number];
    for (;;) {
      const from = iso(y, m - 1, 1);
      if (from > range.to) break;
      const to = iso(y, m, 0);
      const date = new Date(`${from}T12:00:00Z`);
      out.push({
        key: from.slice(0, 7),
        label: date.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" }),
        title: date.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" }),
        from: from < range.from ? range.from : from,
        to: to > range.to ? range.to : to,
      });
      m++;
      if (m > 12) [y, m] = [y + 1, 1];
    }
  }
  return out;
}

/** Sum values into buckets by a local date (YYYY-MM-DD) or an instant (converted to the company's zone). */
export function bucketize<T>(rows: T[], buckets: Bucket[], dateOf: (row: T) => string | null | undefined, valueOf: (row: T) => number, tz: string) {
  const totals = buckets.map(() => 0);
  for (const row of rows) {
    const raw = dateOf(row);
    if (!raw) continue;
    const day = raw.length > 10 ? localDate(new Date(raw), tz) : raw;
    const i = buckets.findIndex((b) => day >= b.from && day <= b.to);
    if (i >= 0) totals[i] += valueOf(row);
  }
  return totals;
}
