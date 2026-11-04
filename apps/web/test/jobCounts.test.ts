/**
 * The Jobs list's tab counts (lib/listing.ts groupCounts): one count per state from the database,
 * added up for each tab.
 */
import { describe, expect, it } from "vitest";
import { groupCounts } from "../src/lib/listing";

describe("the Jobs list's tab counts", () => {
  it("add up the states each tab shows, and all of them for a tab with none", () => {
    const byState = { late: 2, today: 1, upcoming: 4, paused: 1, completed: 7 };
    expect(groupCounts({ active: ["late", "today", "upcoming", "unscheduled"], late: ["late"], unscheduled: ["unscheduled"], everything: null }, byState))
      .toEqual({ active: 7, late: 2, unscheduled: 0, everything: 15 });
  });
});
