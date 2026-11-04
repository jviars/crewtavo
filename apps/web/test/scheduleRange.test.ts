/** The days each schedule view shows (features/schedule/range.ts), and the List's day, week or month. */
import { describe, expect, it } from "vitest";
import { spanDays, stepMonth, weekStart } from "../src/features/schedule/range";

const ends = (days: string[]) => [days[0], days[days.length - 1], days.length];

describe("the days a view shows", () => {
  it("a day is just that day", () => {
    expect(spanDays("day", "2026-11-04")).toEqual(["2026-11-04"]);
  });

  it("a week runs Monday to Sunday, even from a Sunday", () => {
    expect(weekStart("2026-11-08")).toBe("2026-11-02");
    expect(ends(spanDays("week", "2026-11-04"))).toEqual(["2026-11-02", "2026-11-08", 7]);
  });

  it("the month grid fills six whole weeks, and the List only the month's own days", () => {
    expect(ends(spanDays("month", "2026-11-18"))).toEqual(["2026-10-26", "2026-12-06", 42]);
    expect(ends(spanDays("month", "2026-11-18", false))).toEqual(["2026-11-01", "2026-11-30", 30]);
    expect(ends(spanDays("month", "2028-02-10", false))).toEqual(["2028-02-01", "2028-02-29", 29]);
    expect(ends(spanDays("month", "2026-12-31", false))).toEqual(["2026-12-01", "2026-12-31", 31]);
  });

  it("steps a month at a time without skipping short months", () => {
    expect(stepMonth("2026-01-31", 1)).toBe("2026-02-15");
    expect(stepMonth("2026-01-05", -1)).toBe("2025-12-15");
  });
});
