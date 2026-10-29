import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { monthLabel, type CalendarEvent } from "../src/features/schedule/CalendarEventDialog";
import { fitBlock, place, TimeRange, type GridVisit } from "../src/features/schedule/TimeGrid";
import { entrySpan } from "../src/features/timesheets/entrySpan";

const tz = "America/New_York";
const visit = (id: string, status: string, start: string, end: string, crew_id: string | null = "crew-1"): GridVisit => ({
  id, title: id, kind: "job", status, crew_id, starts_at: `2026-10-16T${start}:00-04:00`, ends_at: `2026-10-16T${end}:00-04:00`,
});
const conflicts = (visits: GridVisit[]) => Object.fromEntries(place(visits, tz).map((p) => [p.v.id, p.conflict]));

describe("double bookings on the schedule", () => {
  it("marks both visits that overlap for one crew", () => {
    expect(conflicts([visit("a", "scheduled", "09:00", "11:00"), visit("b", "en_route", "10:00", "12:00")])).toEqual({ a: "visit", b: "visit" });
  });

  it("doesn't mark work that's done or a visit booked over it", () => {
    expect(conflicts([visit("done", "completed", "09:00", "11:00"), visit("next", "scheduled", "10:00", "12:00")])).toEqual({ done: false, next: false });
  });

  it("ignores cancelled visits, other crews and visits with no crew", () => {
    expect(conflicts([visit("a", "scheduled", "09:00", "11:00"), visit("x", "cancelled", "09:00", "11:00")])).toEqual({ a: false });
    expect(conflicts([visit("a", "scheduled", "09:00", "11:00"), visit("b", "scheduled", "09:00", "11:00", "crew-2")])).toEqual({ a: false, b: false });
    expect(conflicts([visit("a", "scheduled", "09:00", "11:00", null), visit("b", "scheduled", "09:00", "11:00", null)])).toEqual({ a: false, b: false });
  });
});

describe("what a visit block has room for", () => {
  const all = { time: true, people: true, client: true };

  it("gives the shortest block its title alone, on one whole line", () => {
    expect(fitBlock(22, all)).toEqual({ time: false, title: 1, people: false, hold: false, client: false });
  });

  it("keeps the time on a row of its own, with the people after the title when they have no row", () => {
    expect(fitBlock(34, all)).toMatchObject({ time: true, title: 1, people: false });
    expect(fitBlock(46, all)).toMatchObject({ time: true, title: 1, people: "inline" });
  });

  it("gives taller blocks the people's row, then the client, then more of the title", () => {
    expect(fitBlock(58, all)).toMatchObject({ people: "row", client: false, title: 1 });
    expect(fitBlock(70, all)).toMatchObject({ people: "row", client: true, title: 1 });
    expect(fitBlock(200, all).title).toBe(3);
  });
});

describe("time ranges on the schedule", () => {
  const html = (start: string, end?: string) => renderToStaticMarkup(createElement(TimeRange, { start, end }));

  it("writes AM or PM once when both ends share it, keeping the start's for narrow blocks", () => {
    expect(html("1:30 PM", "2:30 PM")).toBe('1:30<span class="tg-ampm"> PM</span><span class="tg-end"> – 2:30 PM</span>');
    expect(html("11:30 AM", "12:30 PM")).toBe('11:30<span> AM</span><span class="tg-end"> – 12:30 PM</span>');
    expect(html("9 AM")).toBe("9<span> AM</span>");
  });
});

describe("other calendars in the month view", () => {
  const call: CalendarEvent = {
    id: "e1", title: "Supplier call", location: null, description: null, url: null, all_day: false,
    starts_at: "2026-10-20T14:00:00+00:00", ends_at: "2026-10-20T15:00:00+00:00", starts_on: "2026-10-20", ends_on: "2026-10-20", busy: true, source: null,
  };

  it("shows an event's time in the company's zone, whatever zone the computer is in", () => {
    // Two companies far apart: at least one of them isn't in this computer's zone.
    expect(monthLabel(call, "2026-10-20", "America/Chicago")).toBe("9:00 AM Supplier call");
    expect(monthLabel(call, "2026-10-20", "Asia/Kathmandu")).toBe("7:45 PM Supplier call");
  });

  it("shows no time for all-day events, or on the later days of a long one", () => {
    expect(monthLabel({ ...call, all_day: true, starts_at: null, ends_at: null }, "2026-10-20", tz)).toBe("Supplier call");
    expect(monthLabel({ ...call, ends_on: "2026-10-21" }, "2026-10-21", tz)).toBe("Supplier call");
  });
});

describe("time entry form", () => {
  it("works out the start and end in the company's zone, past midnight the next day", () => {
    expect(entrySpan("2026-10-16", "08:00", "16:30", tz)).toEqual({ startAt: new Date("2026-10-16T12:00:00Z"), endAt: new Date("2026-10-16T20:30:00Z") });
    expect(entrySpan("2026-10-16", "22:00", "02:00", tz)?.endAt).toEqual(new Date("2026-10-17T06:00:00Z"));
  });

  it("waits instead of throwing while the date or a time is cleared", () => {
    expect(entrySpan("", "08:00", "16:30", tz)).toBeNull();
    expect(entrySpan("2026-10-16", "", "16:30", tz)).toBeNull();
    expect(entrySpan("2026-10-16", "08:00", "", tz)).toBeNull();
  });
});
