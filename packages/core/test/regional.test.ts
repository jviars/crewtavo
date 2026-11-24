import { describe, expect, it } from "vitest";
import { clockStyle, dateTag, monthFirst, patternFor, weekStartsSunday, writtenDate } from "../src/regional";

/**
 * Words the database writes dates in (private.date_text, supabase/tests/date_text_test.sql checks the
 * same examples) and their twins here: [date or moment, time zone, the US pattern, country, words].
 */
export const WRITTEN: ReadonlyArray<[string, string | null, string, string, string]> = [
  ["2026-10-06", null, "Mon DD, YYYY", "US", "Oct 06, 2026"],
  ["2026-10-06", null, "Mon DD, YYYY", "CA", "Oct 06, 2026"],
  ["2026-10-06", null, "Mon DD, YYYY", "GB", "6 Oct 2026"],
  ["2026-10-06", null, "Mon FMDD, YYYY", "AU", "6 Oct 2026"],
  ["2026-10-06", null, "Mon FMDD", "US", "Oct 6"],
  ["2026-10-06", null, "Mon FMDD", "GB", "6 Oct"],
  ["2026-10-06", null, "FMMon FMDD", "IE", "6 Oct"],
  ["2026-10-06", null, "Dy Mon FMDD", "US", "Tue Oct 6"],
  ["2026-10-06", null, "Dy Mon FMDD", "GB", "Tue 6 Oct"],
  ["2026-10-06", null, "FMMonth FMDD, YYYY", "US", "October 6, 2026"],
  ["2026-10-06", null, "FMMonth FMDD, YYYY", "NZ", "6 October 2026"],
  ["2026-10-06", null, "FMMonth FMDD", "ZA", "6 October"],
  ["2026-10-06", null, "FMMonth YYYY", "GB", "October 2026"],
  ["2026-10-06T21:05:00Z", "America/New_York", "FMHH12:MI AM", "US", "5:05 PM"],
  ["2026-10-06T21:05:00Z", "America/Toronto", "FMHH12:MI AM", "CA", "5:05 p.m."],
  ["2026-10-06T21:05:00Z", "Europe/London", "FMHH12:MI AM", "GB", "22:05"],
  ["2026-10-06T21:05:00Z", "Australia/Sydney", "FMHH12:MI AM", "AU", "8:05 am"],
  ["2026-10-06T08:05:00Z", "Europe/Berlin", "FMHH12:MI AM", "DE", "10:05"],
  ["2026-10-06T21:05:00Z", "Europe/London", "Dy Mon FMDD", "GB", "Tue 6 Oct"],
  ["2026-10-06T23:30:00Z", "Australia/Sydney", "Dy Mon FMDD", "AU", "Wed 7 Oct"],
];

describe("dates written the way the business's country writes them", () => {
  it("are the database's words, pattern for pattern", () => {
    for (const [value, zone, pattern, country, words] of WRITTEN) expect(writtenDate(value, pattern, country, zone ?? undefined), `${value} ${pattern} ${country}`).toBe(words);
  });

  it("leave a US business's patterns as they were", () => {
    for (const pattern of ["Mon DD, YYYY", "Mon FMDD", "Dy Mon FMDD", "FMMonth FMDD, YYYY", "FMHH12:MI AM", "FMMonth YYYY"]) {
      expect(patternFor(pattern, "US")).toBe(pattern);
      expect(patternFor(pattern, null)).toBe(pattern);
    }
  });

  it("put the month first in the US and Canada, the day first elsewhere", () => {
    expect([monthFirst("US"), monthFirst("CA"), monthFirst("PR"), monthFirst(null)]).toEqual([true, true, true, true]);
    expect([monthFirst("GB"), monthFirst("AU"), monthFirst("DE"), monthFirst("ZA")]).toEqual([false, false, false, false]);
  });

  it("keep time the country's way", () => {
    expect([clockStyle("US"), clockStyle("CA"), clockStyle("AU"), clockStyle("NZ"), clockStyle("GB"), clockStyle("IE"), clockStyle("DE"), clockStyle(null)]).toEqual(["AM", "a.m.", "am", "am", "24", "24", "24", "AM"]);
  });

  it("format on screens with an Intl tag that writes them the same way", () => {
    const at = new Date("2026-10-06T21:05:00Z");
    const day = (country: string) => at.toLocaleDateString(dateTag(country), { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
    const time = (country: string) => at.toLocaleTimeString(dateTag(country), { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
    expect([day("US"), day("CA"), day("GB"), day("AU"), day("DE"), day("JP")]).toEqual(["Oct 6, 2026", "Oct 6, 2026", "6 Oct 2026", "6 Oct 2026", "6 Oct 2026", "6 Oct 2026"]);
    expect([time("US"), time("CA"), time("GB"), time("AU"), time("NZ"), time("DE")]).toEqual(["9:05 PM", "9:05 p.m.", "21:05", "9:05 pm", "9:05 pm", "21:05"]);
    expect(dateTag("GB", "es")).toBe("es-US");
  });

  it("start the week on Sunday in the US and Canada, on Monday in the UK", () => {
    expect([weekStartsSunday("US"), weekStartsSunday("CA"), weekStartsSunday("GB"), weekStartsSunday("AU"), weekStartsSunday(null)]).toEqual([true, true, false, false, true]);
  });
});
