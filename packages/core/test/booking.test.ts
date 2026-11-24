import { describe, expect, it } from "vitest";
import {
  askedTimeLine, BOOKING_HORIZON_DAYS, bookingDays, bookingLeadDays, bookingLength, bookingOpenings, bookingSpan, timeZoneLabel, type BookingLook,
} from "../src/slots";
import { localTime, zonedTimeToUtc } from "../src/time";

const NY = "America/New_York";
// Monday, Nov 2, 2026, 2 PM in New York.
const now = new Date("2026-11-02T19:00:00Z");
const at = (date: string, time: string, tz = NY) => zonedTimeToUtc(date, time, tz).getTime();
// A business open 8 to 12 every day, with hour-long visits that start on the half hour.
const settings = { working_hours: { start: "08:00", end: "12:00", days: [0, 1, 2, 3, 4, 5, 6] } };
const MORNING = ["08:00", "08:30", "09:00", "09:30", "10:00", "10:30", "11:00"];
const look = (more: Partial<BookingLook> = {}): BookingLook => ({ now, timeZone: NY, settings, form: { lead_time_days: 1, slot_minutes: 60, max_per_day: null }, busy: [], ...more });
const times = (slots: ReturnType<typeof bookingOpenings>, date: string, tz = NY) => slots.filter((s) => s.date === date).map((s) => localTime(new Date(s.starts_at!), tz));
const days = (slots: ReturnType<typeof bookingOpenings>) => [...new Set(slots.map((s) => s.date))];
const plain = (text: string | null) => (text ?? "").replace(/\s/g, " ");

describe("the times a booking form offers", () => {
  it("are in the company's working hours, each as long as the form's visits, a week at a time", () => {
    const week = bookingOpenings(look());
    expect(days(week)).toEqual(["2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08", "2026-11-09"]);
    expect(times(week, "2026-11-03")).toEqual(MORNING);
    expect(week[0]).toEqual({ date: "2026-11-03", starts_at: "2026-11-03T13:00:00.000Z", ends_at: "2026-11-03T14:00:00.000Z" });
    // A 90-minute visit has to finish by noon; never more than a week, whatever is asked.
    expect(times(bookingOpenings(look({ form: { lead_time_days: 1, slot_minutes: 90 } })), "2026-11-03")).toEqual(MORNING.slice(0, 6));
    // On the quarter hour for an office that schedules in 15-minute steps.
    expect(times(bookingOpenings(look({ settings: { ...settings, schedule: { time_step: 15 } } })), "2026-11-03").slice(0, 3)).toEqual(["08:00", "08:15", "08:30"]);
    expect(days(bookingOpenings(look({ days: 30 })))).toHaveLength(7);
    expect(days(bookingOpenings(look({ days: 1 })))).toEqual(["2026-11-03"]);
  });

  it("only on the days the business works, with its default hours when none are set", () => {
    const weekdays = { ...settings, working_hours: { ...settings.working_hours, days: [1, 2, 3, 4, 5] } };
    expect(days(bookingOpenings(look({ settings: weekdays })))).toEqual(["2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-09"]);
    const unset = bookingOpenings(look({ settings: {}, days: 1 }));
    expect([localTime(new Date(unset[0]!.starts_at!), NY), localTime(new Date(unset.at(-1)!.starts_at!), NY)]).toEqual(["07:00", "17:00"]);
  });

  it("start after the form's lead time, and today only with an hour's notice", () => {
    expect(bookingOpenings(look({ form: { lead_time_days: 3, slot_minutes: 60 } }))[0]!.date).toBe("2026-11-05");
    // No lead time, at 9:30 AM: 10:00 is half an hour away, so 10:30 is the first.
    const morning = new Date(at("2026-11-02", "09:30"));
    expect(times(bookingOpenings(look({ now: morning, form: { lead_time_days: 0, slot_minutes: 60 } })), "2026-11-02")).toEqual(["10:30", "11:00"]);
    // In the afternoon nothing is left today.
    expect(bookingOpenings(look({ form: { lead_time_days: 0, slot_minutes: 60 } }))[0]!.date).toBe("2026-11-03");
    // A week asked for from before the first day starts at the first day.
    expect(bookingOpenings(look({ from: "2026-10-01" }))[0]!.date).toBe("2026-11-03");
  });

  it("go around what's already on the schedule, and a day off on a calendar", () => {
    const busy = [
      { start: at("2026-11-03", "09:30"), end: at("2026-11-03", "10:15") },
      { start: at("2026-11-04", "00:00"), end: at("2026-11-05", "00:00") },
    ];
    const week = bookingOpenings(look({ busy }));
    expect(times(week, "2026-11-03")).toEqual(["08:00", "08:30", "10:30", "11:00"]);
    expect(days(week)).not.toContain("2026-11-04");
    // A visit that ends as this one starts isn't in the way.
    expect(times(bookingOpenings(look({ busy: [{ start: at("2026-11-03", "08:00"), end: at("2026-11-03", "09:00") }] })), "2026-11-03")).toEqual(MORNING.slice(2));
  });

  it("leave out a day that already has the form's most bookings", () => {
    const form = { lead_time_days: 1, slot_minutes: 60, max_per_day: 2 };
    const week = bookingOpenings(look({ form, booked: { "2026-11-03": 2, "2026-11-04": 1, "2026-11-05": 5 } }));
    expect(days(week)).toEqual(["2026-11-04", "2026-11-06", "2026-11-07", "2026-11-08", "2026-11-09"]);
    // No limit: the counts don't matter.
    expect(days(bookingOpenings(look({ booked: { "2026-11-03": 9 } })))).toContain("2026-11-03");
  });

  it("run for 60 days from the first, and no further", () => {
    const { first, last } = bookingDays(now, NY, { lead_time_days: 1 });
    expect([first, last]).toEqual(["2026-11-03", "2027-01-01"]);
    expect(BOOKING_HORIZON_DAYS).toBe(60);
    // The last week is cut at the last day, and after it there's nothing.
    expect(days(bookingOpenings(look({ from: "2026-12-30" })))).toEqual(["2026-12-30", "2026-12-31", "2027-01-01"]);
    expect(bookingOpenings(look({ from: "2027-01-02" }))).toEqual([]);
  });

  it("are told in the company's time zone: the day is the company's day, not UTC's or the visitor's", () => {
    // 7 PM UTC on Nov 2 is already 8 AM on Nov 3 in Auckland.
    const nz = "Pacific/Auckland";
    const week = bookingOpenings(look({ timeZone: nz, form: { lead_time_days: 0, slot_minutes: 60 } }));
    // An hour's notice from 8:00 there: 9:00 on, on the 3rd.
    expect(times(week, "2026-11-03", nz)).toEqual(MORNING.slice(2));
    expect(week[0]!.starts_at).toBe("2026-11-02T20:00:00.000Z");
    // Late evening in New York is tomorrow in UTC; the lead time still counts from New York's today.
    expect(bookingOpenings(look({ now: new Date("2026-11-03T03:30:00Z") }))[0]!.date).toBe("2026-11-03");
  });

  it("keep the same clock time across a clock change, in autumn and in spring", () => {
    // Clocks go back on Sunday, Nov 1, 2026: 8 AM is 12:00 UTC the day before and 13:00 UTC after.
    const fall = bookingOpenings(look({ now: new Date("2026-10-30T15:00:00Z") }));
    expect(fall.filter((s) => localTime(new Date(s.starts_at!), NY) === "08:00").slice(0, 3).map((s) => s.starts_at)).toEqual([
      "2026-10-31T12:00:00.000Z", "2026-11-01T13:00:00.000Z", "2026-11-02T13:00:00.000Z",
    ]);
    expect(times(fall, "2026-11-01")).toEqual(MORNING);
    // Clocks go forward on Sunday, Mar 14, 2027: 8 AM is 13:00 UTC before and 12:00 UTC after.
    const spring = bookingOpenings(look({ now: new Date("2027-03-12T15:00:00Z") }));
    expect(spring.filter((s) => localTime(new Date(s.starts_at!), NY) === "08:00").slice(0, 3).map((s) => s.starts_at)).toEqual([
      "2027-03-13T13:00:00.000Z", "2027-03-14T12:00:00.000Z", "2027-03-15T12:00:00.000Z",
    ]);
    // The hour that doesn't exist that night is never offered, by a business that works nights.
    const nights = { working_hours: { start: "01:00", end: "05:00", days: [0, 1, 2, 3, 4, 5, 6] } };
    const night = bookingOpenings(look({ now: new Date("2027-03-12T15:00:00Z"), settings: nights })).filter((s) => s.date === "2027-03-14");
    expect(new Set(night.map((s) => s.starts_at)).size).toBe(night.length);
    for (const s of night) expect(Date.parse(s.ends_at!) - Date.parse(s.starts_at!)).toBe(3_600_000);
  });

  it("follow on as arrival windows when the business gives its clients one", () => {
    const windows = bookingOpenings(look({ settings: { ...settings, arrival_window_min: 120 }, days: 1 }));
    expect(times(windows, "2026-11-03")).toEqual(["08:00", "10:00"]);
  });
});

describe("a booking form's own numbers", () => {
  it("are kept within reason: 15 minutes to 8 hours, an hour unless it says, at most a month's lead", () => {
    expect([bookingLength({}), bookingLength({ slot_minutes: 0 }), bookingLength({ slot_minutes: 5 }), bookingLength({ slot_minutes: 90 }), bookingLength({ slot_minutes: 9000 })]).toEqual([60, 60, 15, 90, 480]);
    expect([bookingLeadDays({}), bookingLeadDays({ lead_time_days: -2 }), bookingLeadDays({ lead_time_days: 2 }), bookingLeadDays({ lead_time_days: 400 })]).toEqual([0, 0, 2, 30]);
  });
});

describe("how a picked time is said", () => {
  it("names the time zone so nobody reads the times as their own", () => {
    expect(timeZoneLabel(NY, now)).toBe("Eastern Time (New York)");
    expect(timeZoneLabel("America/Los_Angeles", now)).toBe("Pacific Time (Los Angeles)");
    expect(timeZoneLabel("UTC", now)).toBe("UTC");
    expect(timeZoneLabel("Not/AZone", now)).toBe("Not/AZone");
  });

  it("gives the office the start and the end, and whether it's booked or waiting", () => {
    const start = new Date(at("2026-11-03", "10:00")).toISOString();
    const end = new Date(at("2026-11-03", "11:00")).toISOString();
    expect(plain(bookingSpan(start, end, NY))).toBe("Tue, Nov 3, 10:00 to 11:00 AM");
    expect(plain(bookingSpan(new Date(at("2026-11-03", "11:30")).toISOString(), new Date(at("2026-11-03", "13:00")).toISOString(), NY))).toBe("Tue, Nov 3, 11:30 AM to 1:00 PM");
    expect(plain(askedTimeLine({ status: "new", asked_starts_at: start, asked_ends_at: end }, NY))).toBe("Asked for Tue, Nov 3, 10:00 to 11:00 AM. It waits for your OK.");
    expect(plain(askedTimeLine({ status: "assessment_scheduled", asked_starts_at: start, asked_ends_at: end }, NY))).toBe("Booked online for Tue, Nov 3, 10:00 to 11:00 AM.");
    expect(askedTimeLine({ status: "new", asked_starts_at: null }, NY)).toBeNull();
  });

  it("says it the way the business's country writes dates and keeps time", () => {
    const start = new Date(at("2026-11-03", "10:00")).toISOString();
    const end = new Date(at("2026-11-03", "11:00")).toISOString();
    expect(bookingSpan(start, end, NY, "US")).toBe(bookingSpan(start, end, NY));
    expect(plain(bookingSpan(start, end, "America/Toronto", "CA"))).toBe("Tue, Nov 3, 10:00 to 11:00 a.m.");
    const london = (time: string) => zonedTimeToUtc("2026-11-03", time, "Europe/London").toISOString();
    expect(plain(bookingSpan(london("10:00"), london("13:00"), "Europe/London", "GB"))).toBe("Tue 3 Nov, 10:00 to 13:00");
    expect(plain(askedTimeLine({ status: "new", asked_starts_at: london("10:00"), asked_ends_at: london("11:00") }, "Europe/London", "GB")!)).toBe("Asked for Tue 3 Nov, 10:00 to 11:00. It waits for your OK.");
  });
});
