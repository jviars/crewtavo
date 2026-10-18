import { taxPercent } from "@crewtavo/core/money";

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const moneyCents = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const compact = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 });

export const formatMoney = (n: number | null | undefined) => money.format(n ?? 0);
export const formatMoneyCents = (n: number | null | undefined) => moneyCents.format(n ?? 0);
/** "$9.9K", "$1.2M"; amounts under $1,000 stay whole dollars ("$711", not "$710.8"). */
export const formatMoneyCompact = (n: number | null | undefined) => (Math.abs(n ?? 0) < 1000 ? money : compact).format(n ?? 0);

/** "Thu, Oct 15" */
export const formatDay = (value: string | Date) =>
  new Date(value).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });

/** "7:20 AM", in `timeZone` when given (the company's), otherwise the browser's. */
export const formatTime = (value: string | Date, timeZone?: string) =>
  new Date(String(value).replace(" ", "T")).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone });

export const formatNumber = (n: number, digits = 0) =>
  n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** A tax rate (stored as a fraction) as a percent, to the 0.0001% it's kept to: "8.875%", "8.25%". */
export const formatTaxRate = (rate: number | string | null | undefined) =>
  `${taxPercent(rate).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 4 })}%`;

/** "Oct 16, 2026" */
export const formatDate = (value: string | Date | null | undefined) =>
  value ? new Date(String(value).length === 10 ? `${value}T12:00:00` : value).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—";

/** "Thu, Oct 16, 7:00 AM", in `timeZone` when given (the company's), otherwise the browser's. */
export const formatDateTime = (value: string | Date, timeZone?: string) =>
  new Date(value).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone });

/** "3 days ago", "in 2 hours" */
export function timeAgo(value: string | Date): string {
  const seconds = (new Date(value).getTime() - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat("en-US", { numeric: "auto" });
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60]];
  for (const [unit, size] of units) if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  return "just now";
}

/** Today's date (YYYY-MM-DD) in a time zone. */
export const todayIn = (timeZone: string) => new Date().toLocaleDateString("en-CA", { timeZone });

/** The date (YYYY-MM-DD) a timestamp falls on in a time zone: 8:30 PM Oct 16 in New York is Oct 16, not the UTC Oct 17. */
export const dateIn = (value: string | Date, timeZone: string) => new Date(value).toLocaleDateString("en-CA", { timeZone });

export const addDaysIso = (date: string, days: number) => {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** One-line address from a property row. */
export const addressLine = (p: { line1?: string | null; city?: string | null; region?: string | null; postal_code?: string | null } | null | undefined) =>
  p ? [p.line1, [p.city, p.region].filter(Boolean).join(", "), p.postal_code].filter(Boolean).join(" · ") : "";
