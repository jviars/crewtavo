import { describe, expect, it } from "vitest";
import { place, type GridVisit } from "../src/features/schedule/TimeGrid";
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
