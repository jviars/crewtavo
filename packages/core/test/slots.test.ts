import { describe, expect, it } from "vitest";
import { changeableOnline, daysOff, openSlots, slotLabel, slotStep, slotTime, workdays, type SlotRules } from "../src/slots";
import { zonedTimeToUtc } from "../src/time";

const NY = "America/New_York";
// Monday, Nov 2, 2026, mid-afternoon in New York.
const now = new Date("2026-11-02T19:00:00Z");
const at = (date: string, time: string, tz = NY) => zonedTimeToUtc(date, time, tz).getTime();
const rules = (more: Partial<SlotRules> = {}): SlotRules => ({ now, timeZone: NY, hours: { start: "08:00", end: "12:00" }, lengthMin: 60, busy: [], stepMin: 60, days: 1, ...more });
const starts = (slots: ReturnType<typeof openSlots>, tz = NY) =>
  slots.map((s) => (s.starts_at ? new Date(s.starts_at).toLocaleString("en-US", { timeZone: tz, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).replace(/\s/g, " ") : s.date));
// Newer Intl puts a narrow no-break space before AM and PM.
const plain = (text: string) => text.replace(/\s/g, " ");

describe("open slots for a visit", () => {
  it("are in the workday, from tomorrow (never today), each long enough to finish by its end", () => {
    expect(starts(openSlots(rules()))).toEqual(["Nov 3, 8:00 AM", "Nov 3, 9:00 AM", "Nov 3, 10:00 AM", "Nov 3, 11:00 AM"]);
    expect(starts(openSlots(rules({ lengthMin: 90 })))).toEqual(["Nov 3, 8:00 AM", "Nov 3, 9:00 AM", "Nov 3, 10:00 AM"]);
    const slot = openSlots(rules())[0]!;
    expect(slot).toEqual({ date: "2026-11-03", starts_at: "2026-11-03T13:00:00.000Z", ends_at: "2026-11-03T14:00:00.000Z" });
  });

  it("run three weeks by default, and step on the time step", () => {
    const all = openSlots(rules({ days: undefined }));
    expect(new Set(all.map((s) => s.date)).size).toBe(21);
    expect(all.at(-1)!.date).toBe("2026-11-23");
    expect(starts(openSlots(rules({ stepMin: 30, lengthMin: 30, hours: { start: "08:00", end: "09:30" } })))).toEqual(["Nov 3, 8:00 AM", "Nov 3, 8:30 AM", "Nov 3, 9:00 AM"]);
  });

  it("go around the busy times of the people on the visit", () => {
    const busy = [{ start: at("2026-11-03", "09:30"), end: at("2026-11-03", "10:15") }];
    expect(starts(openSlots(rules({ busy })))).toEqual(["Nov 3, 8:00 AM", "Nov 3, 11:00 AM"]);
    // A busy day all day (a holiday on the team's calendar) offers nothing.
    expect(openSlots(rules({ busy: [{ start: at("2026-11-03", "00:00"), end: at("2026-11-04", "00:00") }] }))).toEqual([]);
  });

  it("leave out the visit's own time", () => {
    const current = { date: "2026-11-03", starts_at: new Date(at("2026-11-03", "09:00")).toISOString() };
    expect(starts(openSlots(rules({ current })))).toEqual(["Nov 3, 8:00 AM", "Nov 3, 10:00 AM", "Nov 3, 11:00 AM"]);
  });

  it("follow on as arrival windows, so they don't overlap", () => {
    const slots = openSlots(rules({ windowMin: 120, stepMin: 30 }));
    expect(starts(slots)).toEqual(["Nov 3, 8:00 AM", "Nov 3, 10:00 AM"]);
    expect(plain(slotLabel(slots[0]!, NY, 120))).toBe("Tue, Nov 3, 8:00–10:00 AM");
    expect(plain(slotLabel(slots[1]!, NY, 120))).toBe("Tue, Nov 3, 10:00 AM–12:00 PM");
    expect(plain(slotLabel(slots[0]!, NY))).toBe("Tue, Nov 3, 8:00 AM");
  });

  it("are whole days for an anytime visit, except its own day and days with no room", () => {
    const busy = [{ start: at("2026-11-04", "08:00"), end: at("2026-11-04", "12:00") }];
    const days = openSlots(rules({ anytime: true, days: 4, busy, current: { date: "2026-11-05", starts_at: null } }));
    expect(days).toEqual([
      { date: "2026-11-03", starts_at: null, ends_at: null },
      { date: "2026-11-06", starts_at: null, ends_at: null },
    ]);
    expect(slotLabel(days[0]!, NY)).toBe("Tue, Nov 3");
  });

  it("read the workday in the business's own time zone, across a clock change", () => {
    // Los Angeles: 8 AM there is 16:00 UTC in November.
    const la = openSlots(rules({ timeZone: "America/Los_Angeles", hours: { start: "08:00", end: "09:00" } }));
    expect(la.map((s) => s.starts_at)).toEqual(["2026-11-03T16:00:00.000Z"]);
    // Clocks go back on Sunday, Nov 1, 2026: 8 AM is 12:00 UTC the day before and 13:00 UTC after.
    const change = openSlots(rules({ now: new Date("2026-10-30T15:00:00Z"), days: 3, hours: { start: "08:00", end: "09:00" } }));
    expect(change.map((s) => s.starts_at)).toEqual(["2026-10-31T12:00:00.000Z", "2026-11-01T13:00:00.000Z", "2026-11-02T13:00:00.000Z"]);
    // Late evening in New York is already tomorrow in UTC, but the lead time counts from New York's today.
    expect(openSlots(rules({ now: new Date("2026-11-03T03:30:00Z") }))[0]!.date).toBe("2026-11-03");
  });
});

describe("the days the business works", () => {
  it("are every day until it picks, and only real days of the week count", () => {
    const everyDay = [0, 1, 2, 3, 4, 5, 6];
    expect(workdays({})).toEqual(everyDay);
    expect(workdays({ working_hours: { start: "08:00", end: "17:00", days: [6, 2, 2] } })).toEqual([2, 6]);
    expect(workdays({ working_hours: { days: [] } })).toEqual(everyDay);
    expect(workdays({ working_hours: { days: ["mon", 9, 1.5] } })).toEqual(everyDay);
  });

  it("leave the rest as days off for multi-day work, and weekends until it picks", () => {
    expect(daysOff({ working_hours: { days: [1, 2, 3, 4] } })).toEqual([0, 5, 6]);
    expect(daysOff({ working_hours: { days: [0, 1, 2, 3, 4, 5, 6] } })).toEqual([]);
    expect(daysOff({})).toEqual([0, 6]);
    expect(daysOff({ working_hours: { days: ["mon"] } })).toEqual([0, 6]);
  });

  it("are the only ones offered, as times or whole days", () => {
    // Tue Nov 3 to Mon Nov 9, for a business that works Tuesday and Saturday.
    const week = { days: 7, hours: { start: "08:00", end: "09:00" }, workdays: [2, 6] };
    expect(openSlots(rules(week)).map((s) => s.date)).toEqual(["2026-11-03", "2026-11-07"]);
    expect(openSlots(rules({ ...week, anytime: true })).map((s) => s.date)).toEqual(["2026-11-03", "2026-11-07"]);
    expect(openSlots(rules({ ...week, workdays: workdays({ working_hours: { days: [1, 2, 3, 4, 5] } }) })).map((s) => s.date)).toEqual(["2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06", "2026-11-09"]);
  });
});

describe("the step between slots", () => {
  it("is the schedule's time step when one is set (at least 15 minutes), else 30", () => {
    expect(slotStep({})).toBe(30);
    expect(slotStep(null)).toBe(30);
    expect(slotStep({ schedule: { time_step: 15 } })).toBe(15);
    expect(slotStep({ schedule: { time_step: 5 } })).toBe(15);
  });
});

describe("a visit a client can change online", () => {
  it("is scheduled for after today, and hasn't started", () => {
    expect(changeableOnline({ status: "scheduled", scheduled_on: "2026-11-03" }, "2026-11-02")).toBe(true);
    expect(changeableOnline({ status: "scheduled", scheduled_on: "2026-11-02" }, "2026-11-02")).toBe(false);
    for (const status of ["en_route", "in_progress", "completed", "cancelled"]) expect(changeableOnline({ status, scheduled_on: "2026-11-09" }, "2026-11-02")).toBe(false);
    expect(changeableOnline({ status: "scheduled", scheduled_on: null }, "2026-11-02")).toBe(false);
  });
});

describe("a slot's time", () => {
  it("shares AM or PM across a window, and keeps both when they differ", () => {
    const nine = new Date(at("2026-11-03", "09:00")).toISOString();
    expect(plain(slotTime(nine, NY))).toBe("9:00 AM");
    expect(plain(slotTime(nine, NY, 120))).toBe("9:00–11:00 AM");
    expect(plain(slotTime(nine, NY, 240))).toBe("9:00 AM–1:00 PM");
  });
});
