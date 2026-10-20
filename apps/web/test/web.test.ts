import { describe, expect, it } from "vitest";
import { parseCsv, toCsv } from "../src/lib/csv";
import { bucketize, bucketizeShifted, bucketsFor, resolveRange } from "../src/features/finance/range";
import { previousRange } from "@crewtavo/core/reports";

describe("report ranges", () => {
  const tz = "America/New_York";

  it("resolves presets to inclusive local dates", () => {
    expect(resolveRange("month", "2026-10-16", tz)).toMatchObject({ from: "2026-10-01", to: "2026-10-16", days: 16 });
    expect(resolveRange("last_month", "2026-03-10", tz)).toMatchObject({ from: "2026-02-01", to: "2026-02-28" });
    expect(resolveRange("last_month", "2026-01-05", tz)).toMatchObject({ from: "2025-12-01", to: "2025-12-31" });
    expect(resolveRange("quarter", "2026-08-20", tz)).toMatchObject({ from: "2026-07-01", to: "2026-08-20" });
    expect(resolveRange("year", "2026-10-16", tz)).toMatchObject({ from: "2026-01-01" });
    expect(resolveRange("last_year", "2026-10-16", tz)).toMatchObject({ from: "2025-01-01", to: "2025-12-31", days: 365 });
    expect(resolveRange("30d", "2026-10-16", tz)).toMatchObject({ from: "2026-09-17", days: 30 });
  });

  it("uses the company's zone for timestamp boundaries", () => {
    const r = resolveRange("month", "2026-10-16", tz);
    expect(r.start).toBe("2026-10-01T04:00:00.000Z"); // midnight EDT
    expect(r.end).toBe("2026-10-17T04:00:00.000Z");
  });

  it("cleans up custom ranges", () => {
    expect(resolveRange("custom", "2026-10-16", tz, { from: "2026-05-10", to: "2026-05-01" })).toMatchObject({ from: "2026-05-01", to: "2026-05-10" });
    expect(resolveRange("custom", "2026-10-16", tz, { from: "garbage", to: null })).toMatchObject({ from: "2026-09-17", to: "2026-10-16" });
  });

  it("buckets by day, week or month depending on length", () => {
    expect(bucketsFor(resolveRange("month", "2026-10-16", tz))).toHaveLength(16);
    const weeks = bucketsFor(resolveRange("90d", "2026-10-16", tz));
    expect(weeks.length).toBeGreaterThanOrEqual(13);
    expect(weeks[0]!.from).toBe("2026-07-19");
    expect(bucketsFor(resolveRange("year", "2026-10-16", tz)).map((b) => b.label)).toEqual(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct"]);
  });

  it("sums rows into buckets using local dates", () => {
    const buckets = bucketsFor(resolveRange("month", "2026-10-16", tz));
    // 11:30pm on Oct 1 in New York is Oct 2 in UTC; it belongs to Oct 1.
    const totals = bucketize([{ at: "2026-10-02T03:30:00Z", n: 5 }, { at: "2026-10-03", n: 2 }, { at: "2026-11-01", n: 9 }], buckets, (r) => r.at, (r) => r.n, tz);
    expect(totals[0]).toBe(5);
    expect(totals[2]).toBe(2);
    expect(totals.reduce((a, b) => a + b, 0)).toBe(7);
  });

  it("lines the previous period up under this one", () => {
    const range = resolveRange("month", "2026-10-16", tz);
    const before = previousRange(range);
    expect(before).toMatchObject({ from: "2026-09-15", to: "2026-09-30" });
    const buckets = bucketsFor(range);
    // Sep 15 is the previous period's first day, so it sits under Oct 1; 11:30pm Sep 30 in New York under Oct 16.
    const totals = bucketizeShifted([{ at: "2026-09-15", n: 4 }, { at: "2026-10-01T03:30:00Z", n: 6 }, { at: "2026-09-14", n: 9 }], buckets, (r) => r.at, (r) => r.n, tz, range.days);
    expect(totals[0]).toBe(4);
    expect(totals[15]).toBe(6);
    expect(totals.reduce((a, b) => a + b, 0)).toBe(10);
  });
});

describe("csv", () => {
  it("round-trips quotes, commas and new lines", () => {
    const csv = toCsv([{ name: 'Smith, "Bob"', note: "line 1\nline 2" }], [{ key: "name", label: "Name" }, { key: "note", label: "Note" }]);
    expect(parseCsv(csv)).toEqual([["Name", "Note"], ['Smith, "Bob"', "line 1\nline 2"]]);
  });

  it("defuses spreadsheet formulas but keeps negative numbers", () => {
    const csv = toCsv([{ a: "=HYPERLINK(1)", b: -250.5, c: "-12", d: "+1 540 555" }], ["a", "b", "c", "d"].map((k) => ({ key: k, label: k })));
    expect(csv.split("\r\n")[1]).toBe("'=HYPERLINK(1),-250.5,-12,'+1 540 555");
  });
});
