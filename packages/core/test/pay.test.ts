/**
 * Pay periods' sums where periods meet: hours paid with one period aren't owed in another that
 * overlaps it, and someone marked paid for a period shows what that payment recorded.
 */
import { describe, expect, it } from "vitest";
import { paySummary, type PayEntry } from "../src";

const tz = "America/New_York";
/** Monday to Friday from `monday` (a day of October 2026), `hours` approved hours a day from 8am. */
const week = (monday: number, hours = 8, user = "u1"): PayEntry[] =>
  [0, 1, 2, 3, 4].map((i) => {
    const start = `2026-10-${String(monday + i).padStart(2, "0")}T12:00:00Z`;
    return { id: `${user}-${monday + i}`, user_id: user, started_at: start, ended_at: new Date(Date.parse(start) + hours * 3_600_000).toISOString(), category: "visit", approved_at: "x" };
  });
const sum = (entries: PayEntry[], options: Parameters<typeof paySummary>[6] = {}) => paySummary(entries, () => 20, () => "Ana", tz, "short_paid", [], options);

describe("hours are paid once", () => {
  it("after last week is paid ($800), the last two weeks owe only the week that isn't", () => {
    const entries = [...week(5), ...week(12)];
    // Without the rule both weeks are owed: this is what used to be shown, and marked paid.
    expect(sum(entries).people[0]).toMatchObject({ hours: 80, amount: 1600, already_paid_hours: 0 });
    const paidLastWeek = (e: PayEntry) => e.started_at < "2026-10-12";
    const pay = sum(entries, { alreadyPaid: paidLastWeek });
    expect(pay.people[0]).toMatchObject({ hours: 40, hourly_amount: 800, amount: 800, already_paid_hours: 40, already_paid_amount: 800 });
    expect(pay).toMatchObject({ hours: 40, amount: 800, already_paid_hours: 40, already_paid_amount: 800 });
  });

  it("owes nothing, and waits on nothing, for days another period has paid", () => {
    const entries: PayEntry[] = [
      ...week(5),
      { id: "break", user_id: "u1", started_at: "2026-10-05T20:00:00Z", ended_at: "2026-10-05T21:00:00Z", category: "break", approved_at: "x" },
      { id: "late", user_id: "u1", started_at: "2026-10-09T22:00:00Z", ended_at: "2026-10-09T23:00:00Z", category: "shop", approved_at: null },
    ];
    expect(sum(entries, { alreadyPaid: () => true }).people[0]).toMatchObject({ hours: 0, amount: 0, break_hours: 0, unapproved_hours: 0, running: false, already_paid_hours: 40 });
  });

  it("shows someone marked paid for this period what the payment recorded, whatever overlaps it since", () => {
    // Paid for last week alone, then for the two weeks (the other 40 h): last week still says 40 h, $800 hourly.
    const line = { user_id: "u1", hours: 40, overtime_hours: 0, break_hours: 0.5, amount: 900, piece_amount: 100 };
    const pay = sum(week(5), { alreadyPaid: () => true, paidLines: [line] });
    expect(pay.people[0]).toMatchObject({ hours: 40, break_hours: 0.5, hourly_amount: 800, piece_amount: 100, amount: 900, already_paid_hours: 0, already_paid_amount: 0 });
    expect(pay).toMatchObject({ hours: 40, amount: 900, already_paid_hours: 0 });
    // And with no time left in the dates at all, the line still shows.
    expect(sum([], { paidLines: [line] }).people).toHaveLength(1);
  });
});
