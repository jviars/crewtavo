import { describe, expect, it } from "vitest";
import { chatQuietAt, nextMorning, quietZone, type ChatQuiet } from "../src/notifications";

const WEEKNIGHTS: ChatQuiet = { quiet_on: true, starts: "21:00:00", ends: "07:00:00", days: [1, 2, 3, 4, 5], time_zone: null, paused_until: null };
// 2026-11-27 is a Friday; Chicago is UTC-6 in November.
const chicago = (local: string) => new Date(`${local}-06:00`);

describe("Team chat's quiet hours", () => {
  it("are quiet from the start on a chosen day until the end the next morning, in the business's zone", () => {
    expect(chatQuietAt(chicago("2026-11-27T20:59:00"), WEEKNIGHTS, "America/Chicago")).toBe(false);
    expect(chatQuietAt(chicago("2026-11-27T21:00:00"), WEEKNIGHTS, "America/Chicago")).toBe(true);
    // Friday night's quiet runs into Saturday morning, though Saturday isn't a chosen day.
    expect(chatQuietAt(chicago("2026-11-28T06:59:00"), WEEKNIGHTS, "America/Chicago")).toBe(true);
    expect(chatQuietAt(chicago("2026-11-28T07:00:00"), WEEKNIGHTS, "America/Chicago")).toBe(false);
    // Saturday night isn't quiet, and Monday's small hours aren't (Sunday wasn't chosen).
    expect(chatQuietAt(chicago("2026-11-28T22:00:00"), WEEKNIGHTS, "America/Chicago")).toBe(false);
    expect(chatQuietAt(chicago("2026-11-30T03:00:00"), WEEKNIGHTS, "America/Chicago")).toBe(false);
  });

  it("are read in the person's own zone when they picked one", () => {
    const eastern = { ...WEEKNIGHTS, time_zone: "America/New_York" };
    // 20:30 in Chicago is 21:30 in New York.
    expect(chatQuietAt(chicago("2026-11-27T20:30:00"), eastern, "America/Chicago")).toBe(true);
    expect(quietZone({ time_zone: "Not/AZone" }, "America/Chicago")).toBe("America/Chicago");
    expect(quietZone(null, null)).toBe("UTC");
  });

  it("can be a stretch within a day, or the whole day", () => {
    const lunch = { ...WEEKNIGHTS, starts: "12:00", ends: "13:00" };
    expect(chatQuietAt(chicago("2026-11-27T12:30:00"), lunch, "America/Chicago")).toBe(true);
    expect(chatQuietAt(chicago("2026-11-27T13:00:00"), lunch, "America/Chicago")).toBe(false);
    const sundays = { ...WEEKNIGHTS, starts: "00:00", ends: "00:00", days: [0] };
    expect(chatQuietAt(chicago("2026-11-29T15:00:00"), sundays, "America/Chicago")).toBe(true);
    expect(chatQuietAt(chicago("2026-11-30T15:00:00"), sundays, "America/Chicago")).toBe(false);
  });

  it("are off until turned on, while a pause holds on its own until it ends", () => {
    const at = chicago("2026-11-27T22:00:00");
    expect(chatQuietAt(at, { ...WEEKNIGHTS, quiet_on: false }, "America/Chicago")).toBe(false);
    expect(chatQuietAt(at, null, "America/Chicago")).toBe(false);
    const paused = { ...WEEKNIGHTS, quiet_on: false, paused_until: chicago("2026-11-27T23:00:00").toISOString() };
    expect(chatQuietAt(at, paused, "America/Chicago")).toBe(true);
    expect(chatQuietAt(chicago("2026-11-27T23:00:00"), paused, "America/Chicago")).toBe(false);
  });

  it("pause until tomorrow morning means 8 the next morning, or this morning in the small hours", () => {
    expect(nextMorning(chicago("2026-11-27T22:15:00"), "America/Chicago").toISOString()).toBe(chicago("2026-11-28T08:00:00").toISOString());
    expect(nextMorning(chicago("2026-11-28T02:00:00"), "America/Chicago").toISOString()).toBe(chicago("2026-11-28T08:00:00").toISOString());
  });
});
