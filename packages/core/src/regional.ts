/**
 * Dates and times written the way the business's country writes them (companies.country, core
 * countries.ts): "Oct 16, 2026" and "2:05 PM" in the US, "16 Oct 2026" and "14:05" in the UK. Only
 * dates and times follow the country; numbers and money keep the app's language's own way
 * (i18n intlLocaleOf), so a number box always reads what's shown in it.
 *
 * Screens format with Intl, through dateTag. Words the database writes into messages (to_char in
 * SQL) and their twins here use writtenDate, which reads the same to_char patterns: a pattern is
 * written as the US writes it, and changed for a country that writes dates the other way round or
 * keeps time another way. private.date_text (supabase/migrations) is its twin, tested on the same
 * examples (packages/core/test/regional.test.ts, supabase/tests/date_text_test.sql).
 */

/** Where the month comes first ("Oct 16, 2026"): the US and its territories, Canada and the Philippines. */
const MONTH_FIRST = new Set(["US", "PR", "GU", "VI", "AS", "MP", "UM", "CA", "PH"]);

/** Whether a country writes the month before the day; a business with no country is taken to be in the US. */
export const monthFirst = (country: string | null | undefined) => !country || MONTH_FIRST.has(country);

/**
 * How a country writes the time of day: "2:05 PM" (the US), "2:05 p.m." (Canada), "2:05 pm"
 * (Australia, New Zealand, India) or "14:05" (the UK, Ireland and most of the world).
 */
export type ClockStyle = "AM" | "a.m." | "am" | "24";

export function clockStyle(country: string | null | undefined): ClockStyle {
  if (!country || country === "PH" || MONTH_FIRST.has(country)) return country === "CA" ? "a.m." : "AM";
  if (country === "AU" || country === "NZ" || country === "IN") return "am";
  return "24";
}

/**
 * The Intl tag a screen formats dates and times with, for a business in `country`: one whose
 * conventions match monthFirst and clockStyle. Spanish keeps "es-US", as the app's language has it.
 */
export function dateTag(country: string | null | undefined, language: string = "en"): string {
  if (language === "es") return "es-US";
  if (!country || country === "PH" || (MONTH_FIRST.has(country) && country !== "CA")) return "en-US";
  const own: Record<string, string> = { CA: "en-CA", GB: "en-GB", IE: "en-IE", AU: "en-AU", NZ: "en-NZ", ZA: "en-ZA", IN: "en-IN" };
  return own[country] ?? "en-GB";
}

/** Whether the week starts on Sunday (the US, Canada and others that hang the calendar that way) or on Monday. */
export const weekStartsSunday = (country: string | null | undefined) => !country || ["US", "CA", "PH", "MX", "BR", "JP", "IL", "PR"].includes(country);

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTH = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * The patterns the database writes dates and times in (as to_char reads them), written as the US
 * writes them, and each one as a day-first country writes it. Any other pattern is written as it is.
 */
export const DAY_FIRST_PATTERNS: Readonly<Record<string, string>> = {
  "Mon DD, YYYY": "FMDD Mon YYYY",
  "Mon FMDD, YYYY": "FMDD Mon YYYY",
  "Mon FMDD": "FMDD Mon",
  "FMMon FMDD": "FMDD Mon",
  "Dy Mon FMDD": "Dy FMDD Mon",
  "FMMonth FMDD, YYYY": "FMDD FMMonth YYYY",
  "FMMonth FMDD": "FMDD FMMonth",
};

/** The time patterns, by how the country keeps time. */
export const TIME_PATTERNS: Readonly<Record<ClockStyle, string>> = { AM: "FMHH12:MI AM", "a.m.": "FMHH12:MI a.m.", am: "FMHH12:MI am", "24": "HH24:MI" };

/** The pattern a country writes `usPattern` in: the date the other way round, the time its own way. */
export function patternFor(usPattern: string, country: string | null | undefined): string {
  if (usPattern === "FMHH12:MI AM") return TIME_PATTERNS[clockStyle(country)];
  return monthFirst(country) ? usPattern : (DAY_FIRST_PATTERNS[usPattern] ?? usPattern);
}

/** The wall-clock parts of `value` in `timeZone` (UTC when none), as to_char sees a timestamp. */
function parts(value: Date, timeZone?: string) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone: timeZone ?? "UTC", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23", weekday: "short" });
  const p = Object.fromEntries(f.formatToParts(value).map((x) => [x.type, x.value]));
  return { year: Number(p.year), month: Number(p.month), day: Number(p.day), hour: Number(p.hour) % 24, minute: Number(p.minute), weekday: DY.indexOf(p.weekday!) };
}

/**
 * to_char for the patterns the database writes words with, in the country's way (patternFor): a
 * date ("2026-10-16", read as that day) or a moment (a Date or an ISO timestamp, in `timeZone`).
 * Knows the fields those patterns use: Mon, Month, Dy, DD, YYYY, HH12, HH24, MI, AM/a.m./am, FM.
 */
export function writtenDate(value: string | Date, usPattern: string, country: string | null | undefined, timeZone?: string): string {
  const day = typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
  const t = day ? (() => { const [y, m, d] = (value as string).split("-").map(Number); return { year: y!, month: m!, day: d!, hour: 0, minute: 0, weekday: new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay() }; })() : parts(new Date(value), timeZone);
  const pattern = patternFor(usPattern, country);
  const two = (n: number) => String(n).padStart(2, "0");
  const h12 = t.hour % 12 || 12;
  let out = "";
  let fill = true;
  for (let i = 0; i < pattern.length; ) {
    const rest = pattern.slice(i);
    const take = (token: string, text: string) => {
      if (!rest.startsWith(token)) return false;
      out += text;
      i += token.length;
      return true;
    };
    if (rest.startsWith("FM")) {
      fill = false;
      i += 2;
      continue;
    }
    const done =
      take("Month", MONTH[t.month - 1]!) ||
      take("Mon", MON[t.month - 1]!) ||
      take("Dy", DY[t.weekday]!) ||
      take("DD", fill ? two(t.day) : String(t.day)) ||
      take("YYYY", String(t.year)) ||
      take("HH24", fill ? two(t.hour) : String(t.hour)) ||
      take("HH12", fill ? two(h12) : String(h12)) ||
      take("MI", two(t.minute)) ||
      take("a.m.", t.hour < 12 ? "a.m." : "p.m.") ||
      take("AM", t.hour < 12 ? "AM" : "PM") ||
      take("am", t.hour < 12 ? "am" : "pm");
    if (!done) {
      out += pattern[i];
      i += 1;
      // to_char's FM lasts to the next field; a literal doesn't end it.
      continue;
    }
    fill = true;
  }
  return out;
}
