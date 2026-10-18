import { RRule } from "rrule";
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

// A feed is written by someone else and read on the server's only thread: whatever it holds, a
// parse has to finish quickly, and one bad event mustn't lose the rest of the calendar.
describe("parseIcs on feeds built to be slow, or just broken", () => {
  const DAY = 86_400_000;
  const hours = (n: number) => Array.from({ length: n }, (_, i) => i).join(",");
  // What the 15-minute sync reads (30 days back, 180 ahead), and what adding a calendar reads for its name.
  const sync = { from: new Date("2026-09-18T00:00:00Z"), to: new Date("2027-04-16T00:00:00Z"), zone: "America/Chicago" };
  const nameOnly = { from: new Date("2026-10-18T12:00:00Z"), to: new Date("2026-10-18T12:00:00Z"), zone: "UTC", limit: 1 };
  // How long something takes: the quickest of up to three tries, so a busy machine doesn't fail a test.
  const took = (run: () => unknown, bound: number) => {
    let ms = Infinity;
    for (let i = 0; i < 3 && ms >= bound; i++) {
      const started = Date.now();
      run();
      ms = Math.min(ms, Date.now() - started);
    }
    return ms;
  };
  const timed = (text: string, options: Parameters<typeof parseIcs>[1] = sync) => {
    let result: ReturnType<typeof parseIcs> | undefined;
    const ms = took(() => (result = parseIcs(text, options)), 1000);
    return { ...result!, ms };
  };
  const vevent = (uid: string, ...lines: string[]) => ["BEGIN:VEVENT", `UID:${uid}`, ...lines, "END:VEVENT"];
  const plain = vevent("plain", "SUMMARY:Site visit", "DTSTART:20261020T150000Z", "DTEND:20261020T160000Z");
  const lone = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
  const outlookZone = (id: string) => [
    "BEGIN:VTIMEZONE", `TZID:${id}`,
    "BEGIN:STANDARD", "DTSTART:16010101T020000", "TZOFFSETFROM:-0400", "TZOFFSETTO:-0500", "RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=1SU;BYMONTH=11", "END:STANDARD",
    "BEGIN:DAYLIGHT", "DTSTART:16010101T020000", "TZOFFSETFROM:-0500", "TZOFFSETTO:-0400", "RRULE:FREQ=YEARLY;INTERVAL=1;BYDAY=2SU;BYMONTH=3", "END:DAYLIGHT",
    "END:VTIMEZONE",
  ];
  const stamp = (ms: number) => new Date(ms).toISOString().replace(/[-:]/g, "").slice(0, 15);

  it("ignores rules that repeat more than hourly, without stepping through them", () => {
    // Every second since a year ago took 16 seconds, with every other request waiting.
    const perSecond = ics(...vevent("s", "DTSTART:20250901T000000Z", "DURATION:PT1S", `RRULE:FREQ=DAILY;BYHOUR=${hours(24)};BYMINUTE=${hours(60)};BYSECOND=${hours(60)}`));
    for (const options of [sync, nameOnly]) {
      const result = timed(perSecond, options);
      expect(result.ms).toBeLessThan(1000);
      expect(result.events).toEqual([]);
    }
    const day = { from: new Date("2026-10-01T00:00:00Z"), to: new Date("2026-10-02T00:00:00Z"), zone: "UTC" };
    // Hourly is the most; twice an hour is too often, and only the event itself shows.
    expect(parseIcs(ics(...vevent("h", "DTSTART:20261001T000000Z", `RRULE:FREQ=DAILY;BYHOUR=${hours(24)}`)), day).events).toHaveLength(24);
    expect(parseIcs(ics(...vevent("h", "DTSTART:20261001T000000Z", `RRULE:FREQ=DAILY;BYHOUR=${hours(24)};BYMINUTE=0,30`)), day).events.map((e) => e.key)).toEqual(["h"]);
  });

  it("goes by the rule as read: one FREQ, and an INTERVAL of at least 1", () => {
    const only = (rule: string) => parseIcs(ics(...vevent("r", "DTSTART:20261020T090000Z", `RRULE:${rule}`)), sync).events.map((e) => [e.key, e.start]);
    // INTERVAL=-1 used to step backwards forever.
    for (const rule of ["FREQ=DAILY;INTERVAL=-1", "FREQ=WEEKLY;INTERVAL=0;BYDAY=MO", "FREQ=DAILY;FREQ=SECONDLY", "FREQ=SECONDLY;FREQ=DAILY", "FREQ=DAILY;BYHOUR=99", "FREQ=MONTHLY;BYMONTHDAY=x", "FREQ=YEARLY;BYMONTH=13"]) {
      expect(only(rule)).toEqual([["r", "2026-10-20T09:00:00.000Z"]]);
    }
    // A value written twice is the same rule.
    expect(only("FREQ=WEEKLY;BYDAY=TU,TU,FR;COUNT=4")).toEqual(only("FREQ=WEEKLY;BYDAY=TU,FR;COUNT=4"));
  });

  it("doesn't walk a rule that never matches to the year 9999", () => {
    const never = ics(
      ...[0, 1, 2, 3, 4].flatMap((i) => vevent(`feb30-${i}`, "DTSTART:20260901T090000Z", "RRULE:FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30")),
      ...vevent("weekly", "DTSTART:20260901T090000Z", "RRULE:FREQ=WEEKLY;BYMONTH=4;BYMONTHDAY=31"),
      ...vevent("yearly", "DTSTART:20260901T090000Z", "RRULE:FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30"),
      ...plain,
    );
    for (const options of [sync, nameOnly]) {
      const result = timed(never, options);
      expect(result.ms).toBeLessThan(1000);
      expect(result.events.map((e) => e.key)).toEqual(options === sync ? ["plain"] : []);
    }
  });

  it("works repeats out from near the window, with the same results as from their start", () => {
    const starts = (options: Parameters<typeof parseIcs>[1], ...lines: string[]) => parseIcs(ics(...vevent("x", ...lines)), options).events.map((e) => e.start);
    const october = { from: new Date("2026-10-01T00:00:00Z"), to: new Date("2026-11-01T00:00:00Z"), zone: "America/Chicago" };
    const days = Array.from({ length: 31 }, (_, i) => Date.UTC(2026, 9, i + 1));

    // Every third day since February 29th 2024, at 6 in Chicago (11:00 UTC in October).
    expect(starts(october, "DTSTART;TZID=America/Chicago:20240229T060000", "DURATION:PT2H", "RRULE:FREQ=DAILY;INTERVAL=3")).toEqual(
      days.filter((d) => ((d - Date.UTC(2024, 1, 29)) / DAY) % 3 === 0).map((d) => `${new Date(d).toISOString().slice(0, 10)}T11:00:00.000Z`),
    );
    // Mondays and Thursdays of every other week since January 4th 2021.
    expect(starts(october, "DTSTART:20210104T170000Z", "DURATION:PT1H", "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH")).toEqual(
      days.filter((d) => [1, 4].includes(new Date(d).getUTCDay()) && Math.floor((d - Date.UTC(2021, 0, 4)) / (7 * DAY)) % 2 === 0).map((d) => `${new Date(d).toISOString().slice(0, 10)}T17:00:00.000Z`),
    );
    const quarter = { from: new Date("2026-10-01T00:00:00Z"), to: new Date("2027-01-01T00:00:00Z"), zone: "UTC" };
    // The 31st, since January 2018: only months that have one.
    expect(starts(quarter, "DTSTART;TZID=America/Chicago:20180131T120000", "DURATION:PT1H", "RRULE:FREQ=MONTHLY")).toEqual(["2026-10-31T17:00:00.000Z", "2026-12-31T18:00:00.000Z"]);
    // The last weekday of each month, since 2019 (after the clocks change in London).
    expect(starts(quarter, "DTSTART;TZID=Europe/London:20190131T170000", "DURATION:PT1H", "RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1")).toEqual([
      "2026-10-30T17:00:00.000Z",
      "2026-11-30T17:00:00.000Z",
      "2026-12-31T17:00:00.000Z",
    ]);
    // February 29th, since 2000.
    expect(starts({ ...quarter, to: new Date("2030-01-01T00:00:00Z") }, "DTSTART;VALUE=DATE:20000229", "RRULE:FREQ=YEARLY")).toEqual(["2028-02-29"]);
    // A few times a day since a start at noon.
    expect(starts({ ...quarter, to: new Date("2026-10-02T00:00:00Z") }, "DTSTART:20200105T120000Z", "DURATION:PT10M", "RRULE:FREQ=DAILY;BYHOUR=6,12,18;BYMINUTE=0,30")).toEqual(
      ["06:00", "06:30", "12:00", "12:30", "18:00", "18:30"].map((t) => `2026-10-01T${t}:00.000Z`),
    );
    // A COUNT counts from the start: Mondays since 2015, ending on October 19th.
    const count = (Date.UTC(2026, 9, 19) - Date.UTC(2015, 0, 5)) / (7 * DAY) + 1;
    expect(starts(october, "DTSTART:20150105T090000Z", "DURATION:PT1H", `RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=${count}`)).toEqual(["2026-10-05T09:00:00.000Z", "2026-10-12T09:00:00.000Z", "2026-10-19T09:00:00.000Z"]);
    // One that can't run out by then needn't be counted from the year 1000.
    const week = { from: new Date("2026-10-01T00:00:00Z"), to: new Date("2026-10-08T00:00:00Z"), zone: "UTC" };
    const ancient = ics(...[1, 2, 3].flatMap((i) => vevent(`old-${i}`, "DTSTART:10000101T090000Z", "DURATION:PT1H", "RRULE:FREQ=DAILY;COUNT=999999999")));
    const result = timed(ancient, week);
    expect(result.ms).toBeLessThan(1000);
    expect(result.events).toHaveLength(21);
  });

  it("keeps a whole file to a fixed amount of work, and still reads what isn't repeats", () => {
    // Thousands of rules that never match, then thousands that each take a while: either way the
    // parse ends quickly, says it left some out, and the plain event at the end is still there.
    const first = vevent("plain", "SUMMARY:Site visit", "DTSTART:20260918T000000Z", "DURATION:PT15M");
    for (const rule of ["FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30", `FREQ=DAILY;BYHOUR=${hours(24)}`]) {
      const text = ics(...Array.from({ length: 3000 }, (_, i) => vevent(`r${i}`, "DTSTART:20000101T003000Z", `RRULE:${rule}`)).flat(), ...first);
      const result = timed(text);
      expect(result.ms).toBeLessThan(1000);
      expect(result.truncated).toBe(true);
      expect(result.events[0]!.key).toBe("plain");
    }
  });

  it("works out a VTIMEZONE's changes a year at a time, not from 1601 for every event", () => {
    // Outlook's "Customized Time Zone" (US Eastern rules since 1601): 3000 events took over a minute.
    const base = Date.UTC(2025, 0, 1, 8);
    const events = (tzid: string) => Array.from({ length: 3000 }, (_, i) => vevent(`e${i}`, `DTSTART;TZID="${tzid}":${stamp(base + i * 7 * 3_600_000)}`, `DTEND;TZID="${tzid}":${stamp(base + i * 7 * 3_600_000 + 5_400_000)}`, "RRULE:FREQ=WEEKLY;COUNT=2")).flat();
    const wide = { from: new Date("2025-01-01T00:00:00Z"), to: new Date("2028-01-01T00:00:00Z"), zone: "UTC", limit: 10_000 };
    const custom = timed(ics(...outlookZone("Customized Time Zone"), ...events("Customized Time Zone")), wide);
    expect(custom.ms).toBeLessThan(1000);
    const iana = parseIcs(ics(...events("America/New_York")), wide);
    // The file's rules and the real zone agree, at every hour of the day (the hours the clocks change too).
    expect(custom.events).toHaveLength(6000);
    expect(custom.events).toEqual(iana.events);
  });

  it("follows VTIMEZONE rules that ended, or ran out after a COUNT, like the real zone", () => {
    const zone = [
      "BEGIN:VTIMEZONE", "TZID:Eastern (with history)",
      "BEGIN:STANDARD", "DTSTART:19671029T020000", "RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU;UNTIL=20061029T060000Z", "TZOFFSETFROM:-0400", "TZOFFSETTO:-0500", "END:STANDARD",
      "BEGIN:DAYLIGHT", "DTSTART:19670430T020000", "RRULE:FREQ=YEARLY;BYMONTH=4;BYDAY=-1SU;COUNT=7", "TZOFFSETFROM:-0500", "TZOFFSETTO:-0400", "END:DAYLIGHT",
      "BEGIN:DAYLIGHT", "DTSTART:19740106T020000", "RDATE:19750223T020000", "TZOFFSETFROM:-0500", "TZOFFSETTO:-0400", "END:DAYLIGHT",
      "BEGIN:DAYLIGHT", "DTSTART:19760425T020000", "RRULE:FREQ=YEARLY;BYMONTH=4;BYDAY=-1SU;UNTIL=19860427T070000Z", "TZOFFSETFROM:-0500", "TZOFFSETTO:-0400", "END:DAYLIGHT",
      "BEGIN:DAYLIGHT", "DTSTART:19870405T020000", "RRULE:FREQ=YEARLY;BYMONTH=4;BYDAY=1SU;UNTIL=20060402T070000Z", "TZOFFSETFROM:-0500", "TZOFFSETTO:-0400", "END:DAYLIGHT",
      "BEGIN:DAYLIGHT", "DTSTART:20070311T020000", "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU", "TZOFFSETFROM:-0500", "TZOFFSETTO:-0400", "END:DAYLIGHT",
      "BEGIN:STANDARD", "DTSTART:20071104T020000", "RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU", "TZOFFSETFROM:-0400", "TZOFFSETTO:-0500", "END:STANDARD",
      "END:VTIMEZONE",
    ];
    // Noon on a few days a month, 1968 to 2030.
    const events = (tzid: string) =>
      Array.from({ length: 63 }, (_, y) => 1968 + y).flatMap((year) =>
        [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11].flatMap((month) => [1, 10, 20, 28].flatMap((day) => vevent(`${year}-${month}-${day}`, `DTSTART;TZID=${tzid}:${stamp(Date.UTC(year, month, day, 12))}`, "DURATION:PT1H"))),
      );
    const ever = { from: new Date("1968-01-01T00:00:00Z"), to: new Date("2031-01-01T00:00:00Z"), zone: "UTC", limit: 10_000 };
    const custom = parseIcs(ics(...zone, ...events("Eastern (with history)")), ever);
    expect(custom.events).toHaveLength(63 * 48);
    expect(custom.events).toEqual(parseIcs(ics(...events("America/New_York")), ever).events);
  });

  it("ignores VTIMEZONE rules that change more than hourly", () => {
    const text = ics(
      "BEGIN:VTIMEZONE", "TZID:Weird Zone", "BEGIN:STANDARD", "DTSTART:20160101T000000", "TZOFFSETFROM:+0000", "TZOFFSETTO:+0000", `RRULE:FREQ=DAILY;BYHOUR=${hours(24)};BYMINUTE=${hours(60)}`, "END:STANDARD", "END:VTIMEZONE",
      ...vevent("a", "SUMMARY:Delivery", "DTSTART;TZID=Weird Zone:20261020T090000", "DTEND;TZID=Weird Zone:20261020T100000"),
    );
    const result = timed(text);
    expect(result.ms).toBeLessThan(1000);
    expect(result.events.map((e) => e.start)).toEqual(["2026-10-20T09:00:00.000Z"]);
  });

  it("doesn't take a huge INTERVAL a day at a time, in events or VTIMEZONE rules", () => {
    // One such zone took 26 seconds to read (twice when a calendar is added), and twenty didn't finish in 90.
    const huge = ["FREQ=DAILY;INTERVAL=999999999999", "FREQ=WEEKLY;INTERVAL=99999999999", "FREQ=DAILY;INTERVAL=36500", "FREQ=WEEKLY;INTERVAL=5200"];
    const zones = Array.from({ length: 20 }, (_, i) => [
      "BEGIN:VTIMEZONE", `TZID:Fake Zone ${i}`,
      "BEGIN:STANDARD", `DTSTART:${i % 2 ? "16010101T020000" : "10000101T000000"}`, "TZOFFSETFROM:-0500", "TZOFFSETTO:-0500", `RRULE:${huge[Math.floor(i / 2) % 4]}`, "END:STANDARD",
      "END:VTIMEZONE",
      ...vevent(`z${i}`, `DTSTART;TZID=Fake Zone ${i}:20261020T090000`, `DTEND;TZID=Fake Zone ${i}:20261020T100000`),
    ]).flat();
    const events = Array.from({ length: 300 }, (_, i) => vevent(`e${i}`, "DTSTART:10000101T090000Z", `RRULE:${huge[i % 4]}`)).flat();
    const text = ics(...zones, ...events, ...plain);
    for (const options of [sync, nameOnly]) expect(timed(text, options).ms).toBeLessThan(1000);
    expect(parseIcs(text, sync).events.map((e) => [e.key, e.start])).toEqual([...zones.filter((l) => l.startsWith("UID:")).map((l) => [l.slice(4), "2026-10-20T14:00:00.000Z"]), ["plain", "2026-10-20T15:00:00.000Z"]]);
    // Long steps that are real still repeat.
    const starts = (...lines: string[]) => parseIcs(ics(...vevent("x", ...lines)), sync).events.map((e) => e.start);
    expect(starts("DTSTART:20011020T150000Z", "RRULE:FREQ=YEARLY;INTERVAL=25")).toEqual(["2026-10-20T15:00:00.000Z"]);
    expect(starts("DTSTART:20221024T150000Z", "RRULE:FREQ=WEEKLY;INTERVAL=104")).toEqual(["2026-10-19T15:00:00.000Z"]);
    expect(starts("DTSTART:20240125T150000Z", "RRULE:FREQ=DAILY;INTERVAL=1000")).toEqual([new Date(Date.UTC(2024, 0, 25, 15) + 1000 * DAY).toISOString()]);
  });

  it("counts what BYSETPOS and BYDAY lists cost, however long they are", () => {
    const every = (n: number) => [...Array.from({ length: n }, (_, i) => -n + i), ...Array.from({ length: n }, (_, i) => i + 1)].join(",");
    const nth = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"].flatMap((day) => Array.from({ length: 53 }, (_, i) => `${i + 1}${day},-${i + 1}${day}`)).join(",");
    // 300 events with rules that never match, or match every day, with every position: each of
    // these took 3 to 9 seconds (2500 of the first, 25).
    for (const rule of [
      `FREQ=MONTHLY;BYMONTHDAY=31;BYMONTH=2;BYSETPOS=${every(366)}`,
      `FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=30;BYSETPOS=${every(366)}`,
      `FREQ=WEEKLY;BYMONTH=2;BYMONTHDAY=30;BYSETPOS=${every(366)}`,
      `FREQ=DAILY;BYSETPOS=${Array.from({ length: 366 }, (_, i) => i + 1).join(",")}`,
      `FREQ=YEARLY;BYMONTH=1,2,3,4,5,6,7,8,9,10,11,12;BYDAY=${nth};BYMONTHDAY=31;BYYEARDAY=1`,
    ]) {
      const result = timed(ics(...Array.from({ length: 300 }, (_, i) => vevent(`s${i}`, "DTSTART:20200101T090000Z", `RRULE:${rule}`)).flat(), ...vevent("plain", "SUMMARY:Site visit", "DTSTART:20260918T000000Z")));
      expect(result.ms).toBeLessThan(1000);
      expect(result.events[0]!.key).toBe("plain");
    }
    // The rules people write are read as before.
    const starts = (rule: string) => parseIcs(ics(...vevent("x", "DTSTART:20260101T170000Z", `RRULE:${rule}`)), { ...sync, to: new Date("2026-12-01T00:00:00Z") }).events.map((e) => e.start.slice(0, 10));
    expect(starts("FREQ=MONTHLY;BYDAY=TH;BYSETPOS=1,3")).toEqual(["2026-10-01", "2026-10-15", "2026-11-05", "2026-11-19"]);
    expect(starts("FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1,-2")).toEqual(["2026-09-29", "2026-09-30", "2026-10-29", "2026-10-30", "2026-11-27", "2026-11-30"]);
    expect(starts("FREQ=MONTHLY;BYDAY=1MO,-1FR")).toEqual(["2026-09-25", "2026-10-05", "2026-10-30", "2026-11-02", "2026-11-27"]);
  });

  it("reads a TZID that's a long run of letters in one pass", () => {
    // 60,000 letters took 3.5 seconds; twenty different 20,000-letter ones, 8.
    const text = ics(
      ...vevent("one", `DTSTART;TZID=${"a".repeat(60_000)}:20261020T090000`),
      ...Array.from({ length: 20 }, (_, i) => vevent(`t${i}`, `DTSTART;TZID=${"b".repeat(20_000)}${i}x:20261020T090000`)).flat(),
    );
    for (const options of [sync, nameOnly]) expect(timed(text, options).ms).toBeLessThan(1000);
    // They're read in the company's zone; names that end in a real zone are still found.
    expect(parseIcs(text, sync).events[0]!.start).toBe("2026-10-20T14:00:00.000Z");
    const zoned = (tzid: string) => parseIcs(ics(...vevent("x", `DTSTART;TZID=${tzid}:20261020T090000`)), sync).events[0]!.start;
    expect(zoned("/mozilla.org/20050126_1/America/New_York")).toBe("2026-10-20T13:00:00.000Z");
    expect(zoned("/citadel.org/20190914_1/Europe/London")).toBe("2026-10-20T08:00:00.000Z");
  });

  it("finds the offset in a VTIMEZONE with thousands of parts in one search", () => {
    // Each part takes over at its hour: even ones at -5, odd ones at -4. 10,000 parts and 7,000
    // events took 1.3 seconds; 40,000 and 25,000, 26.
    const start = Date.UTC(2020, 0, 1);
    const parts = Array.from({ length: 20_000 }, (_, i) => [i % 2 ? "BEGIN:DAYLIGHT" : "BEGIN:STANDARD", `DTSTART:${stamp(start + i * 3_600_000)}`, `TZOFFSETFROM:${i % 2 ? "-0500" : "-0400"}`, `TZOFFSETTO:${i % 2 ? "-0400" : "-0500"}`, i % 2 ? "END:DAYLIGHT" : "END:STANDARD"]).flat();
    const events = Array.from({ length: 10_000 }, (_, i) => vevent(`e${i}`, `DTSTART;TZID=Custom:${stamp(start + i * 3_600_000 + 1_800_000)}`, "DURATION:PT10M")).flat();
    const wide = { from: new Date("2020-01-01T00:00:00Z"), to: new Date("2022-01-01T00:00:00Z"), zone: "UTC", limit: 10_000 };
    const result = timed(["BEGIN:VCALENDAR", "BEGIN:VTIMEZONE", "TZID:Custom", ...parts, "END:VTIMEZONE", ...events, "END:VCALENDAR"].join("\r\n"), wide);
    expect(result.ms).toBeLessThan(1000);
    expect(result.events).toHaveLength(10_000);
    expect(result.events.every((e, i) => Date.parse(e.start) === start + i * 3_600_000 + 1_800_000 + (i % 2 ? 4 : 5) * 3_600_000)).toBe(true);
  });

  it("settles VTIMEZONE onsets at the same moment by the file's order, as before", () => {
    const part = (kind: string, start: string, to: string, ...more: string[]) => [`BEGIN:${kind}`, `DTSTART:${start}`, `TZOFFSETFROM:${to === "-0500" ? "-0400" : "-0500"}`, `TZOFFSETTO:${to}`, ...more, `END:${kind}`];
    const start = (...parts: string[][]) => parseIcs(ics("BEGIN:VTIMEZONE", "TZID:Tied", ...parts.flat(), "END:VTIMEZONE", ...vevent("x", "DTSTART;TZID=Tied:20261020T090000")), sync).events[0]!.start;
    const standard = (...more: string[]) => part("STANDARD", more.length ? "20000312T020000" : "20200101T000000", "-0500", ...more);
    const daylight = (...more: string[]) => part("DAYLIGHT", more.length ? "20000312T020000" : "20200101T000000", "-0400", ...more);
    const rule = "RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU";
    expect(start(standard(), daylight())).toBe("2026-10-20T14:00:00.000Z");
    expect(start(daylight(), standard())).toBe("2026-10-20T13:00:00.000Z");
    expect(start(standard(rule), daylight(rule))).toBe("2026-10-20T14:00:00.000Z");
    expect(start(daylight(rule), standard(rule))).toBe("2026-10-20T13:00:00.000Z");
    // A rule's onset and another part's RDATE.
    expect(start(part("STANDARD", "20000101T000000", "-0500", "RDATE:20260308T020000"), daylight(rule))).toBe("2026-10-20T14:00:00.000Z");
    expect(start(daylight(rule), part("STANDARD", "20000101T000000", "-0500", "RDATE:20260308T020000"))).toBe("2026-10-20T13:00:00.000Z");
  });

  it("has the work a big calendar needs, and a zone's offsets don't depend on what came before it", () => {
    const zone = outlookZone("Customized Time Zone");
    const two = (n: number) => String(n).padStart(2, "0");
    const crew = vevent("crew", "DTSTART;TZID=America/Chicago:20250106T070000", "DURATION:PT1H", "RRULE:FREQ=WEEKLY;BYDAY=MO");
    const invite = vevent("invite", 'DTSTART;TZID="Customized Time Zone":20261005T100000', 'DTEND;TZID="Customized Time Zone":20261005T110000');
    // Weekly meetings since 2015 set to end after 800 (so still going), and daily ones that ended
    // after a few hundred days years ago; then a weekly crew meeting, and an invite in Outlook's
    // zone. Before, the crew meetings were lost and the invite came out at the wrong time.
    const meetings = [
      ...Array.from({ length: 120 }, (_, i) => vevent(`wc-${i}`, `DTSTART;TZID=America/Chicago:2015${two((i % 12) + 1)}0${(i % 9) + 1}T090000`, "DURATION:PT30M", "RRULE:FREQ=WEEKLY;COUNT=800")),
      ...Array.from({ length: 200 }, (_, i) => vevent(`ended-${i}`, `DTSTART;TZID="Customized Time Zone":2016${two((i % 12) + 1)}10T080000`, "DURATION:PT30M", `RRULE:FREQ=DAILY;COUNT=${200 + (i % 5) * 100}`)),
      crew,
      invite,
    ];
    // 300 routes every day since 2024, more than the 5000 kept: before, the last were lost from the first days.
    const routes = [...Array.from({ length: 300 }, (_, i) => vevent(`route-${i}`, `DTSTART;TZID=America/Chicago:2024${two((i % 12) + 1)}${two((i % 27) + 1)}T${two(6 + (i % 10))}0000`, "DURATION:PT30M", "RRULE:FREQ=DAILY")), crew];
    // 5000 anniversaries since 2000, as Outlook writes them: the last ones lost their repeats.
    const anniversaries = Array.from({ length: 5000 }, (_, i) =>
      vevent(`a-${i}`, `DTSTART;TZID="Customized Time Zone":${2000 + (i % 21)}${two((i % 12) + 1)}${two((i % 28) + 1)}T090000`, "DURATION:PT1H", `RRULE:FREQ=YEARLY;BYMONTHDAY=${(i % 28) + 1};BYMONTH=${(i % 12) + 1}`),
    );
    for (const groups of [meetings, routes, anniversaries]) {
      const result = timed(ics(...zone, ...groups.flat()));
      expect(result.ms).toBeLessThan(1000);
      if (groups === anniversaries) expect(result.truncated).toBe(false);
      // The same as reading them twenty at a time, which is well within the work allowed.
      const twenties = Array.from({ length: Math.ceil(groups.length / 20) }, (_, i) => groups.slice(20 * i, 20 * i + 20).flat());
      const apart = twenties.flatMap((some) => parseIcs(ics(...zone, ...some), sync).events).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
      expect(result.events).toEqual(apart.slice(0, 5000));
      if (groups === meetings) {
        expect(result.events.filter((e) => e.key.startsWith("crew|"))).toHaveLength(30);
        expect(result.events.find((e) => e.key === "invite")).toMatchObject({ start: "2026-10-05T14:00:00.000Z", end: "2026-10-05T15:00:00.000Z" });
      }
    }
    // And many of Outlook's zones, with years of events in each.
    const many = (tzid: (z: number) => string) =>
      Array.from({ length: 60 }, (_, z) => Array.from({ length: 50 }, (_, i) => vevent(`z${z}-${i}`, `DTSTART;TZID="${tzid(z)}":${stamp(Date.UTC(2017, 0, 1, 8 + (i % 24)) + (i * 80 + z) * DAY)}`, "DURATION:PT1H")).flat()).flat();
    const wide = { from: new Date("2017-01-01T00:00:00Z"), to: new Date("2028-01-01T00:00:00Z"), zone: "UTC", limit: 10_000 };
    const outlook = parseIcs(ics(...Array.from({ length: 60 }, (_, z) => outlookZone(`Customized Time Zone ${z}`)).flat(), ...many((z) => `Customized Time Zone ${z}`)), wide);
    expect(outlook.truncated).toBe(false);
    expect(outlook.events).toEqual(parseIcs(ics(...many(() => "America/New_York")), wide).events);
  });

  it("counts a COUNT from DTSTART, as rrule does, without always walking from there", () => {
    // Some can't have run out by the window, some ran out years before it, some run out in it.
    const rules: [string, string][] = [
      ["20160105T090000Z", "FREQ=DAILY;COUNT=600"],
      ["20160105T090000Z", "FREQ=DAILY;COUNT=3950"],
      ["20150105T090000Z", "FREQ=WEEKLY;COUNT=800"],
      ["20160105T090000Z", "FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=1680"],
      ["20160105T090000Z", "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;COUNT=560"],
      ["20170105T120000Z", "FREQ=DAILY;BYHOUR=9,17;COUNT=7000"],
      ["20180105T090000Z", "FREQ=DAILY;INTERVAL=3;COUNT=1000"],
      ["20170105T090000Z", "FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR;COUNT=2540"],
      ["19900109T090000Z", "FREQ=MONTHLY;BYDAY=2TU;COUNT=500"],
      ["20180131T090000Z", "FREQ=MONTHLY;BYMONTHDAY=31;COUNT=56"],
      ["20170131T090000Z", "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=120"],
      ["20050327T090000Z", "FREQ=YEARLY;BYMONTH=3,10;BYDAY=-1SU;COUNT=44"],
      ["20170102T090000Z", "FREQ=YEARLY;BYWEEKNO=1,20,40;BYDAY=MO;COUNT=30"],
      ["20150101T090000Z", "FREQ=YEARLY;BYYEARDAY=1,100,-1;COUNT=40"],
      // Every weekday (as Thunderbird writes it), Mondays, Wednesdays and Fridays every third day,
      // Thursdays every other week, and every other week's Tuesdays and Thursdays at two times; then
      // monthly and yearly ones that ran out years ago.
      ["20160104T090000Z", "FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR;COUNT=3000"],
      ["20160104T090000Z", "FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR;COUNT=2830"],
      ["20160105T170000Z", "FREQ=DAILY;INTERVAL=3;BYDAY=MO,WE,FR;BYHOUR=9,17;COUNT=1300"],
      ["20160107T090000Z", "FREQ=DAILY;INTERVAL=14;BYDAY=TH,FR;COUNT=290"],
      ["20160105T090000Z", "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,TH;BYHOUR=17,9;COUNT=1150"],
      ["20120110T090000Z", "FREQ=MONTHLY;BYDAY=2TU;COUNT=100"],
      ["20180115T090000Z", "FREQ=MONTHLY;BYMONTHDAY=15;COUNT=106"],
      ["20120601T090000Z", "FREQ=YEARLY;BYMONTH=6;BYMONTHDAY=1;COUNT=10"],
      // Odd ones: a week has every day when BYMONTHDAY picks them, rrule gives the one day of a
      // month twice for BYSETPOS=-2,1, and once a day for BYSETPOS=1,2.
      ["20100104T090000Z", "FREQ=WEEKLY;BYMONTHDAY=1,2,3,4,5,6,7,8,9,10;COUNT=1950"],
      ["20160120T090000Z", "FREQ=MONTHLY;BYSETPOS=-2,1;COUNT=250"],
      ["20050514T090000Z", "FREQ=DAILY;BYSETPOS=1,2;COUNT=11493"],
      // Daily rules that pick days by month and the like, or a day's times by position, since the
      // 1990s: each was walked a day at a time from its start, ran out of its work, and lost its repeats.
      ["19951201T130000Z", "FREQ=DAILY;BYMONTH=12;COUNT=1000"],
      ["19900103T090000Z", "FREQ=DAILY;BYMONTHDAY=1,15;COUNT=900"],
      ["19900103T090000Z", "FREQ=DAILY;BYMONTH=1,7;BYDAY=MO,WE;COUNT=1400"],
      ["19900103T090000Z", "FREQ=DAILY;BYYEARDAY=1,100,300,-1;BYHOUR=9,17;COUNT=300"],
      ["19900101T090000Z", "FREQ=DAILY;BYWEEKNO=1,20,40;BYDAY=MO;COUNT=110"],
      ["20050707T230000Z", "FREQ=DAILY;BYSETPOS=1;BYHOUR=9,17;COUNT=7900"],
      ["20050707T120000Z", "FREQ=DAILY;BYDAY=MO,FR;BYSETPOS=-1,1;BYHOUR=9,17;COUNT=4600"],
      ["20050707T120000Z", "FREQ=DAILY;INTERVAL=7;BYDAY=TH;BYSETPOS=-3;BYHOUR=9,17;COUNT=1070"],
    ];
    for (const [dtstart, rule] of rules) {
      const from = Date.UTC(Number(dtstart.slice(0, 4)), Number(dtstart.slice(4, 6)) - 1, Number(dtstart.slice(6, 8)), Number(dtstart.slice(9, 11)));
      const all = new RRule({ ...RRule.parseString(rule), dtstart: new Date(from) })
        .all()
        .filter((d) => d.getTime() + 3_600_000 > sync.from.getTime() && d < sync.to)
        .map((d) => d.toISOString());
      // rrule gives a day's times in the order BYHOUR has them, and some twice; a calendar has each once, in order.
      const expected = [...new Set(all)].sort();
      const got = parseIcs(ics(...vevent("x", `DTSTART:${dtstart}`, "DURATION:PT1H", `RRULE:${rule}`)), sync).events.map((e) => e.start);
      expect([rule, got]).toEqual([rule, expected]);
    }
  });

  it("counts a COUNT rather than walking it from years ago, and skips ones that ran out", () => {
    const two = (n: number) => String(n).padStart(2, "0");
    // Every weekday since 2016 for 3000 days (still going), one shift for each hour: each was walked
    // a day at a time from 2016, and the work ran out with the last four shifts' repeats left out.
    const shifts = Array.from({ length: 16 }, (_, i) => vevent(`shift-${i}`, `DTSTART;TZID=America/Chicago:201601${two(4 + (i % 5))}T${two(6 + i)}0000`, "DURATION:PT1H", "RRULE:FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR;COUNT=3000"));
    // A calendar kept for years: 2000 series that ran out after a COUNT, as Google, Outlook and
    // Thunderbird write them, then live ones. Before, the live ones lost their repeats.
    const shapes = ["FREQ=MONTHLY;BYDAY=2TU", "FREQ=MONTHLY;BYMONTHDAY=15", "FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1", "FREQ=YEARLY;BYMONTH=6;BYMONTHDAY=1", "FREQ=YEARLY", "FREQ=DAILY;BYDAY=MO,TU,WE,TH,FR"];
    const history = [
      ...Array.from({ length: 2000 }, (_, i) => vevent(`old-${i}`, `DTSTART;TZID=America/Chicago:${2010 + (i % 7)}${two((i % 12) + 1)}${two((i % 28) + 1)}T090000`, "DURATION:PT1H", `RRULE:${shapes[i % 6]};COUNT=${[10, 20, 52, 100][i % 4]}`)),
      ...Array.from({ length: 50 }, (_, i) => vevent(`live-${i}`, `DTSTART;TZID=America/Chicago:2024${two((i % 12) + 1)}01T${two(7 + (i % 10))}0000`, "DURATION:PT1H", i % 2 ? "RRULE:FREQ=WEEKLY;BYDAY=MO,TH" : "RRULE:FREQ=MONTHLY;BYDAY=1FR")),
    ];
    for (const groups of [shifts, history]) {
      const result = timed(ics(...groups.flat()));
      expect(result.ms).toBeLessThan(1000);
      expect(result.truncated).toBe(false);
      // The same as reading them twenty at a time, which is well within the work allowed.
      const twenties = Array.from({ length: Math.ceil(groups.length / 20) }, (_, i) => groups.slice(20 * i, 20 * i + 20).flat());
      expect(result.events).toEqual(twenties.flatMap((some) => parseIcs(ics(...some), sync).events).sort((a, b) => Date.parse(a.start) - Date.parse(b.start)));
      if (groups === shifts) expect(result.events).toHaveLength(16 * 150);
      else expect(result.events.filter((e) => e.key.startsWith("live-")).length).toBeGreaterThan(1500);
    }
  });

  it("reads many of Outlook's zones, with years of events in each, without running out", () => {
    // 100 "Customized Time Zone"s with US Eastern rules, each the same or a little different (a
    // TZNAME), with meetings since 2005, or a weekly series since 2005 or 1990 that skips a week each
    // year. Every year since was worked out for each zone, the work ran out, and the last zones'
    // events came out an hour off, with nothing to say so.
    const zone = (z: number, named: boolean) => outlookZone(`Customized Time Zone ${z}`).flatMap((l) => (named && l === "BEGIN:STANDARD" ? [l, `TZNAME:Zone ${z}`] : [l]));
    const meetings = (tzid: (z: number) => string) =>
      Array.from({ length: 100 }, (_, z) => Array.from({ length: 30 }, (_, i) => vevent(`z${z}-${i}`, `DTSTART;TZID="${tzid(z)}":${stamp(Date.UTC(2005, 0, 4, 8 + (z % 10)) + (i * 274 + z) * DAY)}`, "DURATION:PT1H")).flat()).flat();
    const weekly = (since: number) => (tzid: (z: number) => string) =>
      Array.from({ length: 100 }, (_, z) =>
        vevent(`w${z}`, `DTSTART;TZID="${tzid(z)}":${stamp(Date.UTC(since, 0, 4 + 7 * z, 10))}`, "DURATION:PT1H", "RRULE:FREQ=WEEKLY", ...Array.from({ length: 2026 - since }, (_, y) => `EXDATE;TZID="${tzid(z)}":${stamp(Date.UTC(since, 0, 4 + 7 * z + 364 * y, 10))}`)),
      ).flat();
    const custom = (z: number) => `Customized Time Zone ${z}`;
    const year = { ...sync, from: new Date("2026-01-01T00:00:00Z"), limit: 10_000 };
    for (const [named, events] of [[true, meetings], [false, weekly(2005)], [true, weekly(2005)], [true, weekly(1990)]] as const) {
      for (const options of [sync, year]) {
        const result = timed(ics(...Array.from({ length: 100 }, (_, z) => zone(z, named)).flat(), ...events(custom)), options);
        expect(result.ms).toBeLessThan(1000);
        expect(result.truncated).toBe(false);
        expect(result.events.length).toBeGreaterThan(events === meetings ? 10 : 2000);
        expect(result.events).toEqual(parseIcs(ics(...events(() => "America/New_York")), options).events);
      }
    }
    // 1200 of them, more than the zones a file may have: they say the same, so they're read once,
    // and none is read in the company's zone (6 hours off in Berlin).
    const berlin = { ...sync, zone: "Europe/Berlin" };
    const many = (tzid: (z: number) => string) => Array.from({ length: 1200 }, (_, z) => vevent(`m${z}`, `DTSTART;TZID="${tzid(z)}":${stamp(Date.UTC(2026, 9, 1, 9) + z * 3_600_000)}`, "DURATION:PT1H")).flat();
    const outlook = timed(ics(...Array.from({ length: 1200 }, (_, z) => zone(z, false)).flat(), ...many(custom)), berlin);
    expect(outlook.ms).toBeLessThan(1000);
    expect(outlook.events).toEqual(parseIcs(ics(...many(() => "America/New_York")), berlin).events);
  });

  it("keeps dates before the year 100 to ones Postgres takes, and repeats from them as before", () => {
    const zones = ["America/Chicago", "Europe/Berlin", "Asia/Tokyo", "Pacific/Kiritimati", "UTC"];
    const text = ics(
      ...plain,
      // There's no year 0 in Postgres, and a time just after 0100-01-01 west of UTC came out in the year -3501.
      ...vevent("year-0", "DTSTART;VALUE=DATE:00000101", "DTEND;VALUE=DATE:20270101"),
      ...vevent("year-100", "DTSTART;TZID=America/Chicago:01000101T000000", "DTEND;TZID=America/Chicago:20270101T000000"),
      ...vevent("year-100-floating", "DTSTART:01000101T000000", "DTEND:20270101T000000"),
    );
    for (const zone of zones) {
      const { events } = parseIcs(text, { ...sync, zone });
      expect(events).toHaveLength(4);
      for (const e of events) {
        const days = eventDays(e, zone);
        for (const day of [days.starts_on, days.ends_on, e.start.slice(0, 10)]) expect(day >= "0001-01-01" && /^\d{4}-\d{2}-\d{2}$/.test(day)).toBe(true);
        expect(days.starts_on <= days.ends_on).toBe(true);
      }
    }
    const chicago = parseIcs(text, sync).events;
    expect(chicago.find((e) => e.key === "year-0")!.start).toBe("0001-01-01");
    // Chicago's local mean time, 5:50:36 behind.
    expect(chicago.filter((e) => e.key.startsWith("year-100")).map((e) => [e.start, eventDays(e, "America/Chicago").starts_on])).toEqual([
      ["0100-01-01T05:50:36.000Z", "0100-01-01"],
      ["0100-01-01T05:50:36.000Z", "0100-01-01"],
    ]);
    // A birthday written without its year, as the year 0 or 1, repeats as it did.
    for (const year of ["0000", "0001", "0050", "1604"]) {
      expect(parseIcs(ics(...vevent("b", `DTSTART;VALUE=DATE:${year}0415`, "RRULE:FREQ=YEARLY")), sync).events.map((e) => e.start)).toEqual(["2027-04-15"]);
    }
  });

  it("trims a title the same however much blank follows it", () => {
    const title = (summary: string) => parseIcs(ics(...vevent("x", `SUMMARY:${summary}`, "DTSTART:20261020T150000Z")), sync).events[0]!.title;
    expect(title(`Hi ${"\\n".repeat(300)}`)).toBe("Hi");
    expect(title(`Hi${"\\n".repeat(301)}`)).toBe("Hi");
    expect(title(`Hi${" ".repeat(150)}${"\\n".repeat(150)}`)).toBe("Hi");
    // Blanks followed by more words are kept up to the limit, as before.
    expect(title(`Hi${" ".repeat(300)}there`)).toBe(`Hi${" ".repeat(198)}`);
    expect(title(`Hi${"\\n".repeat(300)}there`)).toBe(`Hi${"\n".repeat(198)}`);
    const description = parseIcs(ics(...vevent("x", `DESCRIPTION:Notes${"\\n".repeat(5000)}`, "DTSTART:20261020T150000Z")), sync).events[0]!.description;
    expect(description).toBe("Notes");
  });

  it("reads each event's text once, not once for every repeat", () => {
    // HTML-looking text with no tags ("<a<a<a...") and a description of millions of line breaks.
    const tricky = ics(
      ...Array.from({ length: 10 }, (_, i) => vevent(`t${i}`, "DTSTART:20260901T150000Z", "DTEND:20260901T153000Z", "RRULE:FREQ=DAILY", `DESCRIPTION:${"<a".repeat(2000)}`)).flat(),
      ...vevent("big", "DTSTART:20260901T160000Z", "RRULE:FREQ=DAILY", `DESCRIPTION:${"x\\n".repeat(3_000_000)}`),
    );
    const result = timed(tricky);
    expect(result.ms).toBeLessThan(1000);
    expect(result.events.find((e) => e.key.startsWith("t0|"))!.description).toBe("<a".repeat(1000));
    expect(result.events.find((e) => e.key.startsWith("big|"))!.description).toBe("x\n".repeat(1000));
  });

  it("strips HTML in one pass, however broken the tags", () => {
    for (const text of ["<a".repeat(20_000), `<b>x</b>${"<li".repeat(10_000)}`, `<b>x</b>${"<<".repeat(10_000)}`, `<p>${"<br".repeat(10_000)}>`]) {
      expect(took(() => plainText(text), 50)).toBeLessThan(50);
    }
    // The same results as before.
    expect(plainText("<a".repeat(3))).toBe("<a<a<a");
    expect(plainText(`<b>x</b>${"<li".repeat(3)}`)).toBe("x<li<li<li");
    expect(plainText("<ul><li>Gloves</li><li class=\"x\">Ladder</li></ul>")).toBe("• Gloves\n• Ladder");
    expect(plainText("Line one<br>Line two<br />end")).toBe("Line one\nLine two\nend");
    expect(plainText("a <b>bold</b> and <i>it")).toBe("a bold and it");
    expect(plainText("<a<b>c")).toBe("c");
    expect(plainText("1 < 2 and 3 > 2")).toBe("1 < 2 and 3 > 2");
    expect(plainText("<a href='https://x.example'>link</a> <<b>>")).toBe("link >");
  });

  it("never cuts an emoji in half, which Postgres won't store", () => {
    const text = ics(
      "X-WR-CALNAME:" + "n".repeat(79) + "📅",
      ...vevent(
        "e",
        "SUMMARY:" + "t".repeat(199) + "🚀",
        "LOCATION:" + "l".repeat(299) + "😀 Suite 4",
        "DESCRIPTION:" + "x".repeat(1999) + "🎉 and more",
        "DTSTART:20261020T150000Z",
      ),
      ...vevent("html", "SUMMARY:Party 🎉", "DESCRIPTION:<p>" + "y".repeat(1999) + "🙂</p>tail", "DTSTART:20261021T150000Z"),
    );
    const { name, events } = parseIcs(text, sync);
    expect(name).toBe("n".repeat(79));
    expect(events[0]).toMatchObject({ title: "t".repeat(199), location: "l".repeat(299), description: "x".repeat(1999) });
    expect(events[1]).toMatchObject({ title: "Party 🎉", description: "y".repeat(1999) });
    expect(lone.test(JSON.stringify({ name, events }))).toBe(false);
  });

  it("drops halves of emoji, and NULs, that were in the file already", () => {
    const { events } = parseIcs(ics(...vevent("e", "SUMMARY:Bad \ud83c half", "LOCATION:\udf89 here", "DTSTART:20261020T150000Z")), sync);
    expect(events[0]).toMatchObject({ title: "Bad  half", location: "here" });
    // Postgres won't store a NUL either: one failed its 500-row batch, at every refresh.
    const text = ics("X-WR-CALNAME:Cal\u0000name", ...vevent("n\u0000uid", "SUMMARY:Bad\u0000title", "LOCATION:a\u0000b", "DESCRIPTION:a\u0000", "URL:https://x.example/\u0000a", "DTSTART:20261020T150000Z"));
    expect(parseIcs(text, sync)).toMatchObject({ name: "Calname", events: [{ key: "nuid", title: "Badtitle", location: "ab", description: "a", url: "https://x.example/a" }] });
  });

  it("reads every spelling of a zone alike, and a TZID like constructor in the company's zone", () => {
    const start = (tzid: string) => parseIcs(ics(...vevent("x", `DTSTART;TZID=${tzid}:20261020T090000`)), sync).events.map((e) => e.start);
    for (const tzid of ["America/New_York", "america/new_york", "AMERICA/new_YORK", "US/Eastern", "EST5EDT", '"  America/New_York "']) expect(start(tzid)).toEqual(["2026-10-20T13:00:00.000Z"]);
    // Names Object has: they were taken for Windows names, and the events went missing.
    for (const tzid of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf"]) expect(start(tzid)).toEqual(["2026-10-20T14:00:00.000Z"]);
  });

  it("reads a file the same whatever its line breaks, and only the lines it uses", () => {
    const lines = ["BEGIN:VCALENDAR", "X-WR-CALNAME:Breaks", ...vevent("x", "SUMMARY:Long", " title", "item1.URL:https://x.example/", 'X-ODD;A="a:b";B=1:value', 'DTSTART;TZID="America/Chicago":20261020T090000', "DURATION:PT1H"), "END:VCALENDAR"];
    const crlf = parseIcs(lines.join("\r\n"), sync);
    expect(crlf).toMatchObject({ name: "Breaks", events: [{ title: "Longtitle", url: "https://x.example/", start: "2026-10-20T14:00:00.000Z" }] });
    for (const sep of ["\n", "\r"]) expect(parseIcs(lines.join(sep), sync)).toEqual(crlf);
  });

  it("keeps events that last for years, and ends absurd ones at the last date there is instead of failing the calendar", () => {
    const text = ics(
      ...plain,
      ...vevent("bad-1", "DTSTART:20261021T150000Z", "DURATION:P99999999W"),
      ...vevent("bad-2", "DTSTART;TZID=America/Chicago:20261021T090000", "DURATION:P99999999W"),
      ...vevent("bad-3", "DTSTART;VALUE=DATE:20261021", "DURATION:P99999999W"),
      ...vevent("bad-4", "DTSTART:20261021T150000Z", "DURATION:P99999999W", "RRULE:FREQ=WEEKLY"),
      ...vevent("bad-5", "DTSTART:20261021T150000Z", "DURATION:PT99999999999999999H"),
      ...vevent("bad-6", "DTSTART:20200101T150000Z", "DURATION:P99999999W"),
      ...vevent("bad-7", "DTSTART:20261021T150000Z", "DTEND:99991231T000000Z"),
      ...vevent("bad-8", "DTSTART;TZID=Pacific/Kiritimati:20261021T090000", "DURATION:P99999999W", "RRULE:FREQ=WEEKLY;BYDAY=WE"),
      ...vevent("bad-9", "DTSTART;TZID=America/New_York:20261021T150000", "DTEND:99991231T235959Z"),
    );
    for (const options of [sync, nameOnly]) {
      const { events } = parseIcs(text, options);
      // Postgres takes four-digit years only, and a company east of UTC saw the year 10000 ("+010000-01").
      for (const e of events) {
        expect(e.end <= (e.allDay ? "9999-12-31" : "9999-12-31T23:59:59.000Z") && e.end >= e.start).toBe(true);
        for (const zone of ["America/Chicago", "Europe/Berlin", "Asia/Tokyo", "Pacific/Kiritimati"]) expect(eventDays(e, zone).ends_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
      if (options === sync) expect(events.map((e) => e.key)).toEqual(expect.arrayContaining(["plain", "bad-1", "bad-9"]));
    }
    // A lease and a secondment that began years before the window are still on now.
    const long = ics(
      ...vevent("lease", "DTSTART;VALUE=DATE:20200101", "DTEND;VALUE=DATE:20300101"),
      ...vevent("secondment", "DTSTART:20210301T140000Z", "DTEND:20280301T220000Z"),
      ...vevent("term", "DTSTART;TZID=America/Chicago:20190901T080000", "DURATION:P520W", "RRULE:FREQ=YEARLY;COUNT=3"),
    );
    expect(parseIcs(long, sync).events.map((e) => [e.key, e.start, e.end])).toEqual([
      ["term|2019-09-01T13:00:00.000Z", "2019-09-01T13:00:00.000Z", "2029-08-19T13:00:00.000Z"],
      ["lease", "2020-01-01", "2030-01-01"],
      ["term|2020-09-01T13:00:00.000Z", "2020-09-01T13:00:00.000Z", "2030-08-20T13:00:00.000Z"],
      ["secondment", "2021-03-01T14:00:00.000Z", "2028-03-01T22:00:00.000Z"],
      ["term|2021-09-01T13:00:00.000Z", "2021-09-01T13:00:00.000Z", "2031-08-20T13:00:00.000Z"],
    ]);
  });

  it("reads a VTIMEZONE once, however its TZID is spaced", () => {
    // A 1 MB zone named by 1000 TZIDs that differ only in spaces: it was read again for each, which
    // took 4 seconds (45 for 9 MB).
    const zone = ["BEGIN:VTIMEZONE", "TZID:Z", "BEGIN:STANDARD", "DTSTART:19700101T000000", "TZOFFSETFROM:+0100", "TZOFFSETTO:+0100", ...Array.from({ length: 20_000 }, (_, i) => `X-PAD-${i}:${"a".repeat(40)}`), "END:STANDARD", "END:VTIMEZONE"];
    const events = Array.from({ length: 1000 }, (_, i) => vevent(`e${i}`, `DTSTART;TZID="${" ".repeat(i % 40)}Z${" ".repeat(Math.floor(i / 40))}":20261020T100000`, "DURATION:PT1H")).flat();
    for (const options of [sync, nameOnly]) {
      const result = timed(ics(...zone, ...events), options);
      expect(result.ms).toBeLessThan(1000);
      if (options === sync) expect(new Set(result.events.map((e) => e.start))).toEqual(new Set(["2026-10-20T09:00:00.000Z"]));
    }
  });

  it("converts only the times that can matter, however many a series has", () => {
    // Values in a zone on each of 100,000 days long ago: each was converted on its own day, and a
    // file of them took up to 10 seconds. Only those near the window can matter.
    const days = Array.from({ length: 100_000 }, (_, i) => stamp(Date.UTC(1700, 0, 1, 9) + i * DAY));
    const daily = (...lines: string[]) => vevent("s", "DTSTART;TZID=America/Chicago:20261001T090000", "DURATION:PT1H", ...lines);
    // (Too many lines to pass to ics() one by one.)
    const starts = (lines: string[]) => {
      const result = timed(["BEGIN:VCALENDAR", ...lines, "END:VCALENDAR"].join("\r\n"));
      expect(result.ms).toBeLessThan(1000);
      expect(result.truncated).toBe(false);
      return result.events.map((e) => e.start);
    };
    // Excluded (the one in the window still is), or added.
    const excluded = starts(daily("RRULE:FREQ=DAILY", `EXDATE;TZID=America/Chicago:${days.join(",")},20261020T090000`));
    expect(excluded).toHaveLength(196);
    expect(excluded).not.toContain("2026-10-20T14:00:00.000Z");
    expect(starts(daily(`RDATE;TZID=Europe/Berlin:${days.join(",")},20261020T160000`))).toEqual(["2026-10-01T14:00:00.000Z", "2026-10-20T14:00:00.000Z"]);
    // Moved long ago, and one moved within the window.
    const moved = starts([
      ...daily("RRULE:FREQ=DAILY"),
      ...days.slice(0, 30_000).flatMap((d) => vevent("s", `RECURRENCE-ID;TZID=Europe/Berlin:${d}`, `DTSTART;TZID=Asia/Tokyo:${d}`)),
      ...vevent("s", "RECURRENCE-ID;TZID=America/Chicago:20261020T090000", "DTSTART;TZID=America/Chicago:20261021T120000", "DURATION:PT1H"),
    ]);
    expect(moved).toHaveLength(197);
    expect(moved).toContain("2026-10-21T17:00:00.000Z");
    expect(moved).not.toContain("2026-10-20T14:00:00.000Z");
    // Series that ran out, ended or can't be read, each starting on its own day and ending in another zone.
    const rules = ["RRULE:FREQ=WEEKLY;COUNT=2", "RRULE:FREQ=DAILY;UNTIL=17000101T000000Z", "RRULE:X"];
    expect(starts([...days.slice(0, 30_000).flatMap((d, i) => vevent(`e${i}`, `DTSTART;TZID=America/Chicago:${d}`, `DTEND;TZID=Asia/Tokyo:${d}`, rules[i % 3]!)), ...plain])).toEqual(["2026-10-20T15:00:00.000Z"]);

    // The same instance moved twice: the last one written counts, even when it's far from the window.
    const series = vevent("t", "DTSTART;TZID=America/Chicago:20200101T090000", "DURATION:PT1H", "RRULE:FREQ=DAILY;COUNT=3");
    const into = vevent("t", "RECURRENCE-ID;TZID=America/Chicago:20200102T090000", "DTSTART;TZID=America/Chicago:20261020T090000", "DURATION:PT1H");
    const away = vevent("t", "RECURRENCE-ID:20200102T150000Z", "STATUS:CANCELLED", "DTSTART:20200102T150000Z");
    expect(parseIcs(ics(...series, ...into, ...away), sync).events).toEqual([]);
    expect(parseIcs(ics(...series, ...away, ...into), sync).events.map((e) => [e.key, e.start])).toEqual([["t|2020-01-02T15:00:00.000Z", "2026-10-20T14:00:00.000Z"]]);
  });

  it("keeps every key short, whatever the UID", () => {
    // A 2 MB UID on an hourly series: its 1500 keys of 2 MB each took 13 GB to store, and the
    // server ran out of memory.
    const uid = "u".repeat(2_000_000);
    const hourly = (id: string) => ics(...vevent(id, "DTSTART:20261001T000000Z", `RRULE:FREQ=DAILY;BYHOUR=${hours(24)}`));
    const result = timed(hourly(uid));
    expect(result.ms).toBeLessThan(1000);
    const keys = result.events.map((e) => e.key);
    expect(keys).toHaveLength(1500);
    expect(new Set(keys).size).toBe(1500);
    expect(keys.every((k) => k.startsWith(`${"u".repeat(200)}#`) && k.length < 250)).toBe(true);
    // The same each time, apart from another UID's, and a UID of 1000 characters is kept as it is.
    expect(parseIcs(hourly(uid), sync).events[0]!.key).toBe(keys[0]);
    expect(parseIcs(hourly(`${uid}v`), sync).events[0]!.key).not.toBe(keys[0]);
    expect(parseIcs(hourly("k".repeat(1000)), sync).events[0]!.key).toBe(`${"k".repeat(1000)}|2026-10-01T00:00:00.000Z`);
  });

  it("keeps a file's repeats and zones to about the time they're charged", () => {
    // Every week, day and position of a year, in 130 series and in a VTIMEZONE's 60 parts, with 5000
    // yearly series in that zone since 1601: BYSETPOS and a zone's onsets were charged a part of
    // what they take, and this took 1.5 seconds.
    const weeks = [...Array.from({ length: 53 }, (_, i) => i + 1), ...Array.from({ length: 53 }, (_, i) => -(i + 1))].join(",");
    const every = `BYWEEKNO=${weeks};BYDAY=MO,TU,WE,TH,FR,SA,SU;BYSETPOS=${[...Array.from({ length: 366 }, (_, i) => i + 1), ...Array.from({ length: 366 }, (_, i) => -(i + 1))].join(",")}`;
    const series = Array.from({ length: 130 }, (_, i) => vevent(`s${i}`, "DTSTART:20000101T090000Z", "DURATION:PT30M", `RRULE:FREQ=YEARLY;${every}`)).flat();
    const parts = Array.from({ length: 60 }, (_, p) => ["BEGIN:STANDARD", "DTSTART:16010101T000000", `TZOFFSETFROM:+0${p % 10}00`, `TZOFFSETTO:+0${(p + 1) % 10}00`, `RRULE:FREQ=YEARLY;${every}`, "END:STANDARD"]).flat();
    const yearly = Array.from({ length: 5000 }, (_, i) => vevent(`y${i}`, `DTSTART;TZID=T:${stamp(Date.UTC(1601 + (i % 400), 0, 1, 9))}`, `DTEND;TZID=T:${stamp(Date.UTC(1601 + (i % 400), 0, 1, 10))}`, "RRULE:FREQ=YEARLY")).flat();
    const result = timed(ics(...series, "BEGIN:VTIMEZONE", "TZID:T", ...parts, "END:VTIMEZONE", ...yearly, ...plain));
    expect(result.ms).toBeLessThan(1000);
    expect(result.truncated).toBe(true);
    expect(result.events.map((e) => e.key)).toContain("plain");
  });

  it("leaves out an event it can't read and keeps the rest", () => {
    // There's no 13th month; one of these failed the whole calendar.
    const text = ics(...plain, ...vevent("bad-date", "DTSTART;VALUE=DATE:20261345"), ...vevent("bad-series", "DTSTART;VALUE=DATE:20261345", "RRULE:FREQ=DAILY"));
    expect(parseIcs(text, sync).events.map((e) => e.key)).toEqual(["plain"]);
  });
});

describe("calendar helpers", () => {
  it("finds the local days an event covers", () => {
    expect(eventDays({ allDay: true, start: "2026-10-01", end: "2026-10-04" }, "UTC")).toEqual({ starts_on: "2026-10-01", ends_on: "2026-10-03" });
    // 11pm to midnight in Chicago stays on the 1st.
    expect(eventDays({ allDay: false, start: "2026-10-02T04:00:00Z", end: "2026-10-02T05:00:00Z" }, "America/Chicago")).toEqual({ starts_on: "2026-10-01", ends_on: "2026-10-01" });
    // Only days Postgres takes, however far a time is.
    expect(eventDays({ allDay: false, start: "2026-10-21T15:00:00.000Z", end: "9999-12-31T23:59:59.000Z" }, "Asia/Tokyo")).toEqual({ starts_on: "2026-10-22", ends_on: "9999-12-31" });
  });

  it("recognizes calendar files and plain text", () => {
    expect(looksLikeIcs("﻿BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(looksLikeIcs("<!doctype html><title>Sign in</title>")).toBe(false);
    expect(plainText("no tags here")).toBe("no tags here");
    expect(plainText("<p>One</p><p>Two &amp; three</p>")).toBe("One\nTwo & three");
  });
});
