import { describe, expect, it } from "vitest";
import { eventDays, looksLikeIcs, parseIcs, plainText } from "../src/ical";

const ics = (...lines: string[]) => ["BEGIN:VCALENDAR", "VERSION:2.0", ...lines, "END:VCALENDAR"].join("\r\n");
const window = { from: new Date("2026-10-01T00:00:00Z"), to: new Date("2026-12-31T00:00:00Z"), zone: "America/Chicago" };

describe("parseIcs", () => {
  it("reads a Zoho-style weekly series with an exclusion, a moved instance and a cancelled one", () => {
    const text = ics(
      "PRODID:-//Zoho Corporation//Zoho Calendar//EN",
      "X-WR-CALNAME:Office",
      "BEGIN:VEVENT",
      "UID:weekly-1@zoho.com",
      "SUMMARY:Team huddle",
      "DTSTART;TZID=America/Chicago:20260907T080000",
      "DTEND;TZID=America/Chicago:20260907T083000",
      // Through 8:00 CST on Nov 2 (14:00 UTC), after the clocks change.
      "RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20261102T140000Z",
      "EXDATE;TZID=America/Chicago:20261012T080000",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:weekly-1@zoho.com",
      "RECURRENCE-ID;TZID=America/Chicago:20261019T080000",
      "SUMMARY:Team huddle (moved)",
      "DTSTART;TZID=America/Chicago:20261020T090000",
      "DTEND;TZID=America/Chicago:20261020T093000",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:weekly-1@zoho.com",
      "RECURRENCE-ID;TZID=America/Chicago:20261026T080000",
      "STATUS:CANCELLED",
      "DTSTART;TZID=America/Chicago:20261026T080000",
      "DTEND;TZID=America/Chicago:20261026T083000",
      "END:VEVENT",
    );
    const result = parseIcs(text, window);
    expect(result.name).toBe("Office");
    expect(result.events.map((e) => [e.title, e.start])).toEqual([
      ["Team huddle", "2026-10-05T13:00:00.000Z"],
      ["Team huddle (moved)", "2026-10-20T14:00:00.000Z"],
      // Nov 2 is after the clocks change: 8:00 CST is 14:00 UTC.
      ["Team huddle", "2026-11-02T14:00:00.000Z"],
    ]);
    // The moved instance keeps the key of the slot it came from, so refreshes update it in place.
    expect(result.events[1]!.key).toBe("weekly-1@zoho.com|2026-10-19T13:00:00.000Z");
    expect(result.events.every((e) => e.busy && !e.allDay)).toBe(true);
  });

  it("reads Outlook's Windows zone names, free time and all-day events", () => {
    const text = ics(
      "BEGIN:VTIMEZONE",
      "TZID:Eastern Standard Time",
      "BEGIN:STANDARD",
      "DTSTART:16010101T020000",
      "TZOFFSETFROM:-0400",
      "TZOFFSETTO:-0500",
      "RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=1SU;BYMONTH=11",
      "END:STANDARD",
      "BEGIN:DAYLIGHT",
      "DTSTART:16010101T020000",
      "TZOFFSETFROM:-0500",
      "TZOFFSETTO:-0400",
      "RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=2SU;BYMONTH=3",
      "END:DAYLIGHT",
      "END:VTIMEZONE",
      "BEGIN:VEVENT",
      "UID:040000008200E00074C5B7101A82E008",
      "SUMMARY:Supplier call",
      "DTSTART;TZID=Eastern Standard Time:20261015T100000",
      "DTEND;TZID=Eastern Standard Time:20261015T110000",
      "X-MICROSOFT-CDO-BUSYSTATUS:FREE",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:holiday-1",
      "SUMMARY:Thanksgiving",
      "DTSTART;VALUE=DATE:20261126",
      "DTEND;VALUE=DATE:20261127",
      "TRANSP:TRANSPARENT",
      "END:VEVENT",
    );
    const [call, holiday] = parseIcs(text, window).events;
    expect(call).toMatchObject({ title: "Supplier call", start: "2026-10-15T14:00:00.000Z", end: "2026-10-15T15:00:00.000Z", busy: false });
    expect(holiday).toMatchObject({ title: "Thanksgiving", allDay: true, start: "2026-11-26", end: "2026-11-27", busy: false });
  });

  it("follows a file's own VTIMEZONE rules when the zone name isn't one it knows", () => {
    const text = ics(
      "BEGIN:VTIMEZONE",
      "TZID:Mountain Time (Custom)",
      "BEGIN:STANDARD",
      "DTSTART:19701101T020000",
      "TZOFFSETFROM:-0600",
      "TZOFFSETTO:-0700",
      "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
      "END:STANDARD",
      "BEGIN:DAYLIGHT",
      "DTSTART:19700308T020000",
      "TZOFFSETFROM:-0700",
      "TZOFFSETTO:-0600",
      "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
      "END:DAYLIGHT",
      "END:VTIMEZONE",
      "BEGIN:VEVENT",
      "UID:daily",
      "SUMMARY:Yard open",
      "DTSTART;TZID=Mountain Time (Custom):20261030T070000",
      "DURATION:PT1H",
      "RRULE:FREQ=DAILY;COUNT=4",
      "END:VEVENT",
    );
    expect(parseIcs(text, window).events.map((e) => e.start)).toEqual([
      "2026-10-30T13:00:00.000Z",
      "2026-10-31T13:00:00.000Z",
      "2026-11-01T14:00:00.000Z",
      "2026-11-02T14:00:00.000Z",
    ]);
  });

  it("handles folded lines, escapes, UTC and floating times, and HTML descriptions", () => {
    const text = ics(
      "BEGIN:VEVENT",
      "UID:g1@google.com",
      "SUMMARY:Estimate\\, Rivera house",
      "DESCRIPTION:<b>Gate code</b> 1234<br>Bring the long ",
      " ladder",
      "LOCATION:12 Oak St\\nSpringfield",
      "DTSTART:20261021T150000Z",
      "DTEND:20261021T160000Z",
      "URL:javascript:alert(1)",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:floating",
      "SUMMARY:Floating",
      "DTSTART:20261022T090000",
      "END:VEVENT",
    );
    const [estimate, floating] = parseIcs(text, window).events;
    expect(estimate).toMatchObject({ title: "Estimate, Rivera house", description: "Gate code 1234\nBring the long ladder", location: "12 Oak St\nSpringfield", url: null });
    // No zone: read in the company's (Chicago, UTC-5 in October). No end: it takes no time.
    expect(floating).toMatchObject({ start: "2026-10-22T14:00:00.000Z", end: "2026-10-22T14:00:00.000Z" });
  });

  it("keeps to the window, repeats all-day events by date, and stops at the limit", () => {
    const text = ics(
      "BEGIN:VEVENT",
      "UID:old",
      "SUMMARY:Long ago",
      "DTSTART:20200101T100000Z",
      "DTEND:20200101T110000Z",
      "END:VEVENT",
      "BEGIN:VEVENT",
      "UID:payday",
      "SUMMARY:Payday",
      "DTSTART;VALUE=DATE:20250115",
      "RRULE:FREQ=MONTHLY;BYMONTHDAY=15",
      "EXDATE;VALUE=DATE:20261115",
      "END:VEVENT",
    );
    const result = parseIcs(text, window);
    expect(result.events.map((e) => [e.key, e.start, e.end])).toEqual([
      ["payday|2026-10-15", "2026-10-15", "2026-10-16"],
      ["payday|2026-12-15", "2026-12-15", "2026-12-16"],
    ]);
    expect(parseIcs(text, { ...window, limit: 1 })).toMatchObject({ truncated: true, events: [{ start: "2026-10-15" }] });
  });

  it("ignores rules that repeat faster than daily", () => {
    const text = ics("BEGIN:VEVENT", "UID:m", "DTSTART:20100101T000000Z", "RRULE:FREQ=MINUTELY", "END:VEVENT");
    expect(parseIcs(text, window).events).toEqual([]);
  });
});

describe("calendar helpers", () => {
  it("finds the local days an event covers", () => {
    expect(eventDays({ allDay: true, start: "2026-10-01", end: "2026-10-04" }, "UTC")).toEqual({ starts_on: "2026-10-01", ends_on: "2026-10-03" });
    // 11pm to midnight in Chicago stays on the 1st.
    expect(eventDays({ allDay: false, start: "2026-10-02T04:00:00Z", end: "2026-10-02T05:00:00Z" }, "America/Chicago")).toEqual({ starts_on: "2026-10-01", ends_on: "2026-10-01" });
  });

  it("recognizes calendar files and plain text", () => {
    expect(looksLikeIcs("﻿BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(looksLikeIcs("<!doctype html><title>Sign in</title>")).toBe(false);
    expect(plainText("no tags here")).toBe("no tags here");
    expect(plainText("<p>One</p><p>Two &amp; three</p>")).toBe("One\nTwo & three");
  });
});
