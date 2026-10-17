/** Report date ranges (in the company's time zone) and how to bucket them for charts. */
import { addDays, localDate, zonedTimeToUtc } from "@crewtavo/core/time";

export const PRESETS = [
  { key: "month", label: "This month" },
  { key: "last_month", label: "Last month" },
  { key: "30d", label: "Last 30 days" },
  { key: "90d", label: "Last 90 days" },
  { key: "quarter", label: "This quarter" },
  { key: "year", label: "This year" },
  { key: "last_year", label: "Last year" },
  { key: "custom", label: "Custom" },
] as const;
export type PresetKey = (typeof PRESETS)[number]["key"];

export interface Range {
  key: PresetKey;
  label: string;
  /** Inclusive local dates (YYYY-MM-DD). */
  from: string;
  to: string;
  /** The same window as UTC instants, for timestamp columns: [start, end). */
  start: string;
  end: string;
  days: number;
}

const iso = (y: number, m: number, d: number) => new Date(Date.UTC(y, m, d)).toISOString().slice(0, 10);

export function resolveRange(key: PresetKey, today: string, tz: string, custom?: { from?: string | null; to?: string | null }): Range {
  const [y, m] = today.split("-").map(Number) as [number, number];
  let from: string;
  let to = today;
  switch (key) {
    case "last_month":
      from = iso(y, m - 2, 1);
      to = iso(y, m - 1, 0);
      break;
    case "30d":
      from = addDays(today, -29);
      break;
    case "90d":
      from = addDays(today, -89);
      break;
    case "quarter":
      from = iso(y, Math.floor((m - 1) / 3) * 3, 1);
      break;
    case "year":
      from = iso(y, 0, 1);
      break;
    case "last_year":
      from = iso(y - 1, 0, 1);
      to = iso(y - 1, 11, 31);
      break;
    case "custom": {
      const valid = (s?: string | null) => (s && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);
      from = valid(custom?.from) ?? addDays(today, -29);
      to = valid(custom?.to) ?? today;
      if (to < from) [from, to] = [to, from];
      break;
    }
    default:
      from = iso(y, m - 1, 1);
  }
  const days = Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000) + 1;
  return {
    key,
    label: key === "custom" ? `${shortDate(from)} – ${shortDate(to)}` : PRESETS.find((p) => p.key === key)!.label,
    from,
    to,
    start: zonedTimeToUtc(from, "00:00", tz).toISOString(),
    end: zonedTimeToUtc(addDays(to, 1), "00:00", tz).toISOString(),
    days,
  };
}

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

export const hoursBetween = (start: string, end: string | null) => (end ? Math.max(0, (Date.parse(end) - Date.parse(start)) / 3_600_000) : 0);
