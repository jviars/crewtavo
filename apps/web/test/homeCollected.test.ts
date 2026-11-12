/**
 * Home's collected figures from each day's total (features/home/collected.ts): the database adds
 * up each of the company's days, and the bars and the month come out as they did from the payments.
 */
import { localDate } from "@crewtavo/core/time";
import { describe, expect, it } from "vitest";
import { collectedHistory, collectedSince } from "../src/features/home/collected";
import { collectedByWeek } from "../src/features/home/weeks";
import { monthToDate } from "../src/lib/trends";

/** Each day's total in the company's zone, as public.collected_by_day gives it. */
function byDay(payments: Array<{ amount: number; received_at: string }>, tz: string) {
  const days = new Map<string, number>();
  for (const p of payments) {
    const day = localDate(new Date(p.received_at), tz);
    days.set(day, Math.round(((days.get(day) ?? 0) + p.amount) * 100) / 100);
  }
  return [...days].map(([day, collected]) => ({ day, collected })).sort((a, b) => a.day.localeCompare(b.day));
}

describe("Home's collected figures from each day's total", () => {
  it("asks from the earlier of the 1st of last month and the start of the bars' first week", () => {
    expect(collectedSince("2026-10-15", 6)).toBe("2026-09-01");
    expect(collectedSince("2026-10-31", 6)).toBe("2026-09-01");
    // Early in a month, six weeks back is before last month began.
    expect(collectedSince("2026-11-03", 6)).toBe("2026-09-22");
    expect(collectedSince("2026-01-20", 6)).toBe("2025-12-01");
  });

  it("gives the same weeks and the same days of last month as adding up the payments did, in zones either side of UTC", () => {
    for (const [tz, today] of [["America/Los_Angeles", "2026-10-15"], ["Pacific/Auckland", "2026-10-31"], ["America/New_York", "2026-03-31"], ["Asia/Kolkata", "2026-11-03"]] as const) {
      // 3,000 payments, more than one request hands over, a few hours apart back from the end of today, with a refund now and then.
      const end = Date.parse(`${today}T23:00:00Z`) + 14 * 3_600_000;
      const payments = Array.from({ length: 3000 }, (_, i) => ({ amount: i % 37 === 0 ? -12.5 : 19.99 + (i % 7), received_at: new Date(end - i * 31 * 60_000).toISOString() }));
      const since = collectedSince(today, 6);
      const days = byDay(payments, tz).filter((d) => d.day >= since && d.day <= today);
      const got = collectedHistory(days, today, tz, 6);
      expect(got.weeks, tz).toEqual(collectedByWeek(payments, today, tz, 6));
      expect(got.weeks, tz).toHaveLength(6);
      expect(got.sameDaysLastMonth, tz).toBeCloseTo(monthToDate(payments, today, tz)[Number(today.slice(8)) - 1]!.before, 2);
    }
  });

  it("keeps a late-evening payment on the company's day, whatever day it is in UTC", () => {
    // 11pm on Sunday, Oct 11 in Los Angeles is already Monday in UTC: the database files it under Oct 11.
    const got = collectedHistory([{ day: "2026-10-11", collected: 80 }, { day: "2026-10-12", collected: "20.50" }], "2026-10-15", "America/Los_Angeles", 6);
    expect(got.weeks.map((w) => [w.from, w.total])).toEqual([["2026-10-05", 80], ["2026-10-12", 20.5]]);
  });

  it("has no bars and nothing to compare before any money came in", () => {
    expect(collectedHistory([], "2026-10-15", "America/Chicago", 6)).toEqual({ sameDaysLastMonth: 0, weeks: [] });
  });
});
