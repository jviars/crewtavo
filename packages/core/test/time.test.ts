import { describe, expect, it } from "vitest";
import { arrivalWindowMin, parseZonedTime, zonedTimeToUtc } from "../src/time";

describe("times typed in a form", () => {
  it("reads a date and time in the company's zone", () => {
    expect(parseZonedTime("2026-10-16", "07:30", "America/New_York")).toEqual(new Date("2026-10-16T11:30:00Z"));
  });

  it("gives null for a cleared or partial field instead of an invalid date", () => {
    // zonedTimeToUtc("") is an invalid date, which throws a RangeError when it's formatted.
    expect(() => zonedTimeToUtc("", "08:00", "America/New_York")).toThrow(RangeError);
    expect(parseZonedTime("", "08:00", "America/New_York")).toBeNull();
    expect(parseZonedTime("2026-10", "08:00", "America/New_York")).toBeNull();
    expect(parseZonedTime("2026-10-16", "", "America/New_York")).toBeNull();
  });
});

describe("the arrival window", () => {
  it("is the business's minutes, or none for anything else", () => {
    expect(arrivalWindowMin({ arrival_window_min: 120 })).toBe(120);
    expect(arrivalWindowMin({ arrival_window_min: "60" })).toBe(60);
    for (const settings of [null, {}, { arrival_window_min: 0 }, { arrival_window_min: -30 }, { arrival_window_min: "soon" }]) expect(arrivalWindowMin(settings)).toBe(0);
    expect(arrivalWindowMin({ arrival_window_min: 100_000 })).toBe(12 * 60);
  });
});
