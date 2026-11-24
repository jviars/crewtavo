import { businessCountry } from "@crewtavo/core/countries";
import { taxPercent } from "@crewtavo/core/money";
import { intlLocale, t } from "./i18n";

/** Currencies a business can pick (Settings → Company and sign-up): the API takes the same list. */
export { CURRENCIES } from "@crewtavo/core/money";

let currency = "USD";

/**
 * Numbers, dates and money in the app's language: "en-US", or "es-US" for Spanish (US-style
 * numbers and money with Spanish words: "jue, 15 de oct", "9:20 a.m."). Money's formatters are
 * made once per currency and language.
 */
const moneyFormats = new Map<string, { money: Intl.NumberFormat; moneyCents: Intl.NumberFormat; compact: Intl.NumberFormat }>();
function formats() {
  const tag = intlLocale();
  let found = moneyFormats.get(`${tag}|${currency}`);
  if (!found) {
    found = {
      money: new Intl.NumberFormat(tag, { style: "currency", currency, maximumFractionDigits: 0 }),
      moneyCents: new Intl.NumberFormat(tag, { style: "currency", currency }),
      compact: new Intl.NumberFormat(tag, { style: "currency", currency, notation: "compact", maximumFractionDigits: 1 }),
    };
    moneyFormats.set(`${tag}|${currency}`, found);
  }
  return found;
}

/** The business's currency (companies.currency), which the session sets; numbers stay US-style, only the symbol changes. */
export function setCurrency(code: string | null | undefined) {
  const next = (code || "USD").toUpperCase();
  if (next === currency) return;
  try {
    new Intl.NumberFormat("en-US", { style: "currency", currency: next });
    currency = next;
  } catch {
    // Not a currency code: keep what was there.
  }
}

/** The currency money shows in: "USD", "CAD". */
export const moneyCurrency = () => currency;

let country = "US";

/** The business's country (companies.country, or the guess from its time zone), which the session sets. */
export function setCountry(company: { country?: string | null; timezone?: string | null } | null | undefined) {
  country = company ? businessCountry(company) : "US";
}

/** Where the business works: "US", "CA", "GB" (core countries.ts). For code outside React; a screen can read the session's company. */
export const companyCountry = () => country;


export const formatMoney = (n: number | null | undefined) => formats().money.format(n ?? 0);
export const formatMoneyCents = (n: number | null | undefined) => formats().moneyCents.format(n ?? 0);
/** "$9.9K", "$1.2M"; amounts under $1,000 stay whole dollars ("$711", not "$710.8"). */
export const formatMoneyCompact = (n: number | null | undefined) => (Math.abs(n ?? 0) < 1000 ? formats().money : formats().compact).format(n ?? 0);

/** "Thu, Oct 15" */
export const formatDay = (value: string | Date) =>
  new Date(value).toLocaleDateString(intlLocale(), { weekday: "short", month: "short", day: "numeric" });

/** "7:20 AM", in `timeZone` when given (the company's), otherwise the browser's. */
export const formatTime = (value: string | Date, timeZone?: string) =>
  new Date(String(value).replace(" ", "T")).toLocaleTimeString(intlLocale(), { hour: "numeric", minute: "2-digit", timeZone });

export const formatNumber = (n: number, digits = 0) =>
  n.toLocaleString(intlLocale(), { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** A tax rate (stored as a fraction) as a percent, to the 0.0001% it's kept to: "8.875%", "8.25%". */
export const formatTaxRate = (rate: number | string | null | undefined) =>
  `${taxPercent(rate).toLocaleString(intlLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 4 })}%`;

/** "Oct 16, 2026" */
export const formatDate = (value: string | Date | null | undefined) =>
  value ? new Date(String(value).length === 10 ? `${value}T12:00:00` : value).toLocaleDateString(intlLocale(), { month: "short", day: "numeric", year: "numeric" }) : "—";

/** "Thu, Oct 16, 7:00 AM", in `timeZone` when given (the company's), otherwise the browser's. */
export const formatDateTime = (value: string | Date, timeZone?: string) =>
  new Date(value).toLocaleString(intlLocale(), { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone });

/** "3 days ago", "in 2 hours" */
export function timeAgo(value: string | Date): string {
  const seconds = (new Date(value).getTime() - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(intlLocale(), { numeric: "auto" });
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60]];
  for (const [unit, size] of units) if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit);
  return t("just now");
}

/** "Thursday", "jueves": a weekday's name in the app's language (0 is Sunday). */
export const weekdayName = (day: number, width: "long" | "short" = "long") =>
  new Date(Date.UTC(2026, 0, 4 + day, 12)).toLocaleDateString(intlLocale(), { weekday: width, timeZone: "UTC" });

const US_ZONES = ["America/New_York", "America/Chicago", "America/Denver", "America/Phoenix", "America/Los_Angeles", "America/Anchorage", "Pacific/Honolulu"];
// For browsers that can't list every zone.
const SOME_ZONES = ["America/Puerto_Rico", "America/Toronto", "America/Vancouver", "Europe/London", "Australia/Sydney"];
const ALL_ZONES = (() => {
  try {
    return (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? SOME_ZONES;
  } catch {
    return SOME_ZONES;
  }
})();

/** Time zones to pick from: the business's own first, then the US ones, then every other. */
export const timeZoneChoices = (current?: string | null) => [...new Set([current, ...US_ZONES, ...ALL_ZONES])].filter((z): z is string => Boolean(z));

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
