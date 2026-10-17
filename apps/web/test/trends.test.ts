import { describe, expect, it } from "vitest";
import { monthToDate, receivablesTrend } from "../src/lib/trends";

const tz = "America/New_York";

describe("month-to-date collections", () => {
  it("runs this month up to today beside last month", () => {
    const rows = monthToDate(
      [
        { amount: 100, received_at: "2026-10-01T14:00:00Z" },
        { amount: 50, received_at: "2026-10-03T03:30:00Z" }, // Oct 2, 11:30pm in New York
        { amount: 200, received_at: "2026-09-02T15:00:00Z" },
        { amount: 25, received_at: "2026-08-31T15:00:00Z" }, // before last month: ignored
      ],
      "2026-10-04",
      tz,
    );
    expect(rows).toHaveLength(31);
    expect(rows.slice(0, 5).map((r) => r.now)).toEqual([100, 150, 150, 150, null]);
    expect(rows[0]!.before).toBe(0);
    expect(rows[1]!.before).toBe(200);
    expect(rows[30]!.before).toBe(200);
    expect(rows[3]!.label).toBe("By Oct 4");
  });

  it("folds the tail of a longer last month into the final day", () => {
    const rows = monthToDate([{ amount: 40, received_at: "2026-10-31T15:00:00Z" }], "2026-11-10", tz);
    expect(rows).toHaveLength(30);
    expect(rows[28]!.before).toBe(0);
    expect(rows[29]!.before).toBe(40);
  });
});

describe("receivables trend", () => {
  const today = "2026-10-16";

  it("walks balances back through payments and issue dates", () => {
    const series = receivablesTrend({
      today,
      tz,
      weeks: 3,
      invoices: [
        // Open now with $300 left after a $200 payment on Oct 12; due Oct 5.
        { id: "a", issued_on: "2026-09-20", due_on: "2026-10-05", balance_due: 300 },
        // Paid off on Oct 14; was $1,000 before that.
        { id: "b", issued_on: "2026-10-01", due_on: "2026-10-31", balance_due: 0 },
        // Issued yesterday.
        { id: "c", issued_on: "2026-10-15", due_on: "2026-11-15", balance_due: 80 },
      ],
      payments: [
        { amount: 200, received_at: "2026-10-12T16:00:00Z", invoice_id: "a" },
        { amount: 1000, received_at: "2026-10-14T16:00:00Z", invoice_id: "b" },
        { amount: 60, received_at: "2026-09-10T16:00:00Z", invoice_id: null },
      ],
    });
    expect(series.map((p) => p.label)).toEqual(["Oct 2", "Oct 9", "Today"]);
    // Oct 2: a owed 500 (not yet due), b owed 1,000, c not issued.
    expect(series[0]).toMatchObject({ owed: 1500, pastDue: 0, collected: 60 });
    // Oct 9: same balances, a is now past due.
    expect(series[1]).toMatchObject({ owed: 1500, pastDue: 500, collected: 60 });
    // Today: a 300 (past due), c 80; the Sept 10 payment has aged out of the 30 days.
    expect(series[2]).toMatchObject({ owed: 380, pastDue: 300, collected: 1200 });
  });
});
