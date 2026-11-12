/**
 * Pay periods' sums where periods meet: hours paid with one period aren't owed in another that
 * overlaps it, someone marked paid for a period shows what that payment recorded, and a week's
 * overtime is judged on the whole week when a period cuts it.
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

describe("overtime when a period cuts a week", () => {
  // The week of Monday Sep 28, 2026: Wednesday is the 30th, so a month-end cuts it after three days.
  const day = (date: string, hours: number, extra: Partial<PayEntry> = {}): PayEntry => ({
    id: date, user_id: "u1", started_at: `${date}T12:00:00Z`, ended_at: new Date(Date.parse(`${date}T12:00:00Z`) + hours * 3_600_000).toISOString(), category: "visit", approved_at: "x", ...extra,
  });
  const september = [day("2026-09-28", 10), day("2026-09-29", 10), day("2026-09-30", 10)];
  const october = [day("2026-10-01", 10), day("2026-10-02", 10)];

  it("a 50-hour week split 30 and 20 by a month-end has its 10 hours of overtime in the second month", () => {
    expect(sum(september).people[0]).toMatchObject({ hours: 30, overtime_hours: 0 });
    // Looking at October's days alone, as before, the week's overtime showed in neither month.
    expect(sum(october).people[0]).toMatchObject({ hours: 20, overtime_hours: 0 });
    expect(sum(october, { weekBefore: september }).people[0]).toMatchObject({ hours: 20, hourly_amount: 400, overtime_hours: 10 });
    // The whole week in one period comes to the same 10.
    expect(sum([...september, ...october]).people[0]).toMatchObject({ hours: 50, overtime_hours: 10 });
  });

  it("goes to the month the late hours fall in: 45 hours by Wednesday and 5 on Thursday is 5 and 5", () => {
    const long = [day("2026-09-28", 15), day("2026-09-29", 15), day("2026-09-30", 15)];
    const thursday = [day("2026-10-01", 5)];
    expect(sum(long).people[0]).toMatchObject({ hours: 45, overtime_hours: 5 });
    expect(sum(thursday, { weekBefore: long }).people[0]).toMatchObject({ hours: 5, overtime_hours: 5 });
  });

  it("counts only approved, paid time before the period, once, and only in that week", () => {
    const before = [
      day("2026-09-21", 16), // the week before
      day("2026-09-28", 10, { approved_at: null }),
      day("2026-09-29", 10, { category: "break" }),
      day("2026-09-30", 10, { ended_at: null }),
      { ...october[0]! }, // sent twice by mistake
    ];
    expect(sum(october, { weekBefore: before }).people[0]).toMatchObject({ hours: 20, overtime_hours: 0 });
    expect(sum(october, { weekBefore: [...before, ...september] }).people[0]).toMatchObject({ overtime_hours: 10 });
  });

  it("isn't paid twice: hours another period paid count towards the week's 40, and keep their own overtime", () => {
    // September was paid (Mon to Wed, 45 hours, 5 of them overtime). The week as a period then
    // owes Thursday and Friday: all 10 of those hours are over 40, and September's 5 aren't counted again.
    const long = [day("2026-09-28", 15), day("2026-09-29", 15), day("2026-09-30", 15)];
    const rest = [day("2026-10-01", 5), day("2026-10-02", 5)];
    const pay = sum([...long, ...rest], { alreadyPaid: (e) => e.started_at < "2026-10-01" });
    expect(pay.people[0]).toMatchObject({ hours: 10, overtime_hours: 10, already_paid_hours: 45 });
    // Unpaid, the same week is 55 hours with 15 over: 5 with September's line and 10 here make the same 15.
    expect(sum([...long, ...rest]).people[0]).toMatchObject({ hours: 55, overtime_hours: 15 });
  });
});
