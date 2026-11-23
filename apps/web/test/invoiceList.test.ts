/** The Invoices list as inbox rows (Page-Invoices.dc.html): its groups, how late a row reads, and the strip's changes. */
import { describe, expect, it } from "vitest";
import { daysLate, groupInvoices, lateWords } from "../src/features/invoices/InvoicesPage";
import { changeFrom } from "../src/features/invoices/InvoiceTools";

const today = "2026-11-21";
const row = (over: Partial<{ id: string; status: string; due_on: string | null; issued_on: string; total: number; balance_due: number }>) => ({
  id: "x", status: "sent", due_on: "2026-12-01", issued_on: "2026-11-01", total: 100, balance_due: 100, ...over,
});

describe("how late an invoice is", () => {
  it("counts the days past its due date while something is still owed", () => {
    expect(daysLate(row({ due_on: "2026-11-11", status: "overdue" }), today)).toBe(10);
    expect(daysLate(row({ due_on: "2026-11-11", status: "partially_paid" }), today)).toBe(10);
    // Due today, not yet due, due on receipt, nothing owed, or not an owed status: not late.
    expect(daysLate(row({ due_on: today }), today)).toBe(0);
    expect(daysLate(row({ due_on: "2026-12-01" }), today)).toBe(0);
    expect(daysLate(row({ due_on: null }), today)).toBe(0);
    expect(daysLate(row({ due_on: "2026-11-11", balance_due: 0 }), today)).toBe(0);
    for (const status of ["draft", "paid", "void", "written_off"]) expect(daysLate(row({ due_on: "2026-11-11", status }), today)).toBe(0);
  });

  it("says it short: days, then weeks, then months", () => {
    expect(lateWords(1)).toBe("1 day late");
    expect(lateWords(10)).toBe("10 days late");
    expect(lateWords(14)).toBe("2 weeks late");
    expect(lateWords(59)).toBe("8 weeks late");
    expect(lateWords(95)).toBe("3 months late");
  });
});

describe("the list's groups", () => {
  it("puts what's owed past due first, then the rest awaiting payment, in the list's order", () => {
    const rows = [row({ id: "a" }), row({ id: "b", due_on: "2026-11-11", status: "overdue" }), row({ id: "c", due_on: null }), row({ id: "d", due_on: "2026-10-25", status: "partially_paid" })];
    const groups = groupInvoices(rows, "open", today);
    expect(groups.map((g) => [g.key, g.label, g.tone, g.rows.map((r) => r.id)])).toEqual([
      ["late", "Past due", "danger", ["b", "d"]],
      ["owed", "Awaiting payment", undefined, ["a", "c"]],
    ]);
  });

  it("leaves out a group with nothing in it", () => {
    expect(groupInvoices([row({ id: "a" })], "open", today).map((g) => g.key)).toEqual(["owed"]);
    expect(groupInvoices([], "paid", today)).toEqual([]);
  });

  it("puts drafts ready to send before the ones with no lines yet", () => {
    const groups = groupInvoices([row({ id: "empty", status: "draft", total: 0 }), row({ id: "ready", status: "draft" })], "draft", today);
    expect(groups.map((g) => [g.label, g.rows.map((r) => r.id)])).toEqual([["Ready to send", ["ready"]], ["No line items yet", ["empty"]]]);
  });

  it("puts settled ones by the month they were issued, across a new year too", () => {
    const rows = [row({ id: "now", status: "paid", issued_on: "2026-11-02" }), row({ id: "oct", status: "paid", issued_on: "2026-10-31" }), row({ id: "old", status: "paid", issued_on: "2026-09-30" })];
    expect(groupInvoices(rows, "paid", today).map((g) => [g.label, g.rows.map((r) => r.id)])).toEqual([["This month", ["now"]], ["Last month", ["oct"]], ["Earlier", ["old"]]]);
    expect(groupInvoices([row({ id: "dec", status: "void", issued_on: "2025-12-20" })], "void", "2026-01-05")[0]).toMatchObject({ label: "Last month" });
  });
});

describe("a figure's change in the strip", () => {
  it("is green when it went the better way and red when not", () => {
    expect(changeFrom(108, 100)).toEqual({ text: "+8%", tone: "good", after: "vs 30 days ago" });
    expect(changeFrom(108, 100, "down")).toMatchObject({ text: "+8%", tone: "danger" });
    expect(changeFrom(50, 100, "down")).toMatchObject({ text: "−50%", tone: "good" });
  });

  it("says no change, a multiple past ten times, and nothing without an earlier figure", () => {
    expect(changeFrom(100, 100)).toEqual({ text: "No change", after: "vs 30 days ago" });
    expect(changeFrom(2400, 100)?.text).toBe("24×");
    expect(changeFrom(100, 0)).toBeUndefined();
    expect(changeFrom(10, 5, "up", "vs the 30 days before")).toMatchObject({ after: "vs the 30 days before" });
  });
});
