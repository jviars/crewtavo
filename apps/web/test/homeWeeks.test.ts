import { describe, expect, it } from "vitest";
import { collectedByWeek } from "../src/features/home/weeks";

const tz = "America/New_York";

describe("collected by week on Home", () => {
  // A Thursday: this week started Monday, Oct 12.
  const today = "2026-10-15";

  it("adds up each week, Monday to Sunday in the company's zone, ending with this week so far", () => {
    const weeks = collectedByWeek(
      [
        { amount: 100, received_at: "2026-09-07T15:00:00Z" }, // Mon, Sep 7: the first of six weeks
        { amount: 50, received_at: "2026-09-14T03:30:00Z" }, // Sun, Sep 13, 11:30pm in New York
        { amount: 200, received_at: "2026-10-12T15:00:00Z" },
        { amount: -20, received_at: "2026-10-13T15:00:00Z" }, // a refund
        { amount: 999, received_at: "2026-08-31T15:00:00Z" }, // before the first week: left out
      ],
      today,
      tz,
    );
    expect(weeks.map((w) => w.label)).toEqual(["Sep 7", "Sep 14", "Sep 21", "Sep 28", "Oct 5", "Oct 12"]);
    expect(weeks.map((w) => w.total)).toEqual([150, 0, 0, 0, 0, 180]);
  });

  it("starts at the first week money came in, and is empty before any", () => {
    const weeks = collectedByWeek([{ amount: 80, received_at: "2026-10-06T15:00:00Z" }], today, tz);
    expect(weeks.map((w) => w.from)).toEqual(["2026-10-05", "2026-10-12"]);
    expect(collectedByWeek([], today, tz)).toEqual([]);
  });
});
