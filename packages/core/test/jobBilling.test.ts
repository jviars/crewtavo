import { describe, expect, it } from "vitest";
import { billingAnswers, billingModeOf, billingText, invoiceDue, invoicePeriod, monthlyPlan, monthlyVisits, monthText, visitDay } from "../src/jobBilling";

describe("the two questions", () => {
  it("keep billing_mode in step: per_visit only for per visit, after each visit", () => {
    expect(billingModeOf("per_visit", "after_visit")).toBe("per_visit");
    expect(billingModeOf("per_visit", "monthly")).toBe("fixed_schedule");
    expect(billingModeOf("per_visit", "as_needed")).toBe("fixed_schedule");
    expect(billingModeOf("fixed", "monthly")).toBe("fixed_schedule");
  });

  it("read a job saved before they were asked the way the database moved it across", () => {
    expect(billingAnswers({ billing_mode: "per_visit" })).toEqual({ pricing: "per_visit", schedule: "after_visit" });
    expect(billingAnswers({ billing_mode: "fixed_schedule" })).toEqual({ pricing: "fixed", schedule: "monthly" });
    expect(billingAnswers({ billing_mode: "on_completion" })).toBeNull();
    expect(billingAnswers({ billing_mode: "progress" })).toBeNull();
    expect(billingAnswers({ billing_mode: "fixed_schedule", pricing: "per_visit", invoice_schedule: "as_needed" })).toEqual({ pricing: "per_visit", schedule: "as_needed" });
  });

  it("say how a job is billed in plain words", () => {
    expect(billingText({ billing_mode: "per_visit" })).toBe("Per visit, after each visit");
    expect(billingText({ billing_mode: "fixed_schedule", pricing: "fixed", invoice_schedule: "monthly", invoice_day: null })).toBe("Fixed price, monthly on the last day of the month");
    expect(billingText({ billing_mode: "fixed_schedule", pricing: "per_visit", invoice_schedule: "monthly", invoice_day: 2 })).toBe("Per visit, monthly on the 2nd");
    expect(billingText({ billing_mode: "fixed_schedule", pricing: "per_visit", invoice_schedule: "monthly", invoice_day: 11 })).toBe("Per visit, monthly on the 11th");
    expect(billingText({ billing_mode: "fixed_schedule", pricing: "per_visit", invoice_schedule: "as_needed" })).toBe("Per visit, as needed");
    expect(billingText({ billing_mode: "on_completion" })).toBe("When the job is done");
    expect(billingText({ billing_mode: "progress" })).toBe("Progress billing");
  });

  it("make a monthly plan of a recurring job at a fixed price, invoiced monthly", () => {
    expect(monthlyPlan({ kind: "recurring", billing_mode: "fixed_schedule", pricing: "fixed", invoice_schedule: "monthly" })).toBe(true);
    expect(monthlyPlan({ kind: "recurring", billing_mode: "fixed_schedule" })).toBe(true);
    expect(monthlyPlan({ kind: "recurring", billing_mode: "fixed_schedule", pricing: "fixed", invoice_schedule: "as_needed" })).toBe(false);
    expect(monthlyPlan({ kind: "one_off", billing_mode: "fixed_schedule", pricing: "fixed", invoice_schedule: "monthly" })).toBe(false);
  });
});

describe("the invoice day", () => {
  it("covers the days since last month's invoice day (private.invoice_period)", () => {
    expect(invoicePeriod(null, "2026-11-20")).toEqual({ month: "2026-11-01", start: "2026-11-01", end: "2026-11-30" });
    expect(invoicePeriod(15, "2026-11-20")).toEqual({ month: "2026-11-01", start: "2026-10-16", end: "2026-11-15" });
    expect(invoicePeriod(28, "2028-03-01")).toEqual({ month: "2028-03-01", start: "2028-02-29", end: "2028-03-28" });
    expect(invoicePeriod(1, "2026-01-31")).toEqual({ month: "2026-01-01", start: "2025-12-02", end: "2026-01-01" });
    expect(invoicePeriod(null, "2028-02-03").end).toBe("2028-02-29");
    expect(monthText("2026-11-01")).toBe("November 2026");
  });

  it("comes in the company's time zone, from 8 in the morning", () => {
    // 2026-11-30 13:30 UTC is 7:30 in Chicago and 6:30 in Denver; 2026-12-01 02:00 UTC is still Nov 30 in Chicago.
    expect(invoiceDue(null, new Date("2026-11-30T13:30:00Z"), "America/Chicago")).toBeNull();
    expect(invoiceDue(null, new Date("2026-11-30T14:05:00Z"), "America/Chicago")).toEqual({ month: "2026-11-01", start: "2026-11-01", end: "2026-11-30" });
    expect(invoiceDue(null, new Date("2026-12-01T02:00:00Z"), "America/Chicago")?.month).toBe("2026-11-01");
    expect(invoiceDue(null, new Date("2026-12-01T02:00:00Z"), "UTC")).toBeNull();
    expect(invoiceDue(15, new Date("2026-11-15T23:00:00Z"), "Pacific/Auckland")).toBeNull();
    expect(invoiceDue(16, new Date("2026-11-15T23:00:00Z"), "Pacific/Auckland")?.end).toBe("2026-11-16");
  });

  it("is the same month every hour of the day, so a second run finds the reminder it made", () => {
    const hours = [14, 17, 21, 23].map((h) => invoiceDue(15, new Date(`2026-11-15T${h}:00:00Z`), "America/Chicago")?.month);
    expect(new Set(hours)).toEqual(new Set(["2026-11-01"]));
  });
});

describe("a monthly per-visit invoice", () => {
  const period = invoicePeriod(15, "2026-11-15");
  const visits = [
    { id: "in-1", kind: "job", status: "completed", invoice_id: null, scheduled_on: "2026-10-16", completed_at: "2026-10-16T15:00:00Z" },
    { id: "in-2", kind: "job", status: "completed", invoice_id: null, scheduled_on: "2026-11-15", completed_at: "2026-11-15T22:00:00Z" },
    // Unscheduled, done the evening of Nov 15 in Chicago (Nov 16 in UTC): in the month.
    { id: "evening", kind: "job", status: "completed", invoice_id: null, scheduled_on: null, completed_at: "2026-11-16T03:00:00Z" },
    { id: "before", kind: "job", status: "completed", invoice_id: null, scheduled_on: "2026-10-15", completed_at: "2026-10-15T15:00:00Z" },
    { id: "after", kind: "job", status: "completed", invoice_id: null, scheduled_on: "2026-11-16", completed_at: "2026-11-16T15:00:00Z" },
    { id: "open", kind: "job", status: "scheduled", invoice_id: null, scheduled_on: "2026-11-10", completed_at: null },
    { id: "billed", kind: "job", status: "completed", invoice_id: "inv-1", scheduled_on: "2026-11-03", completed_at: "2026-11-03T15:00:00Z" },
    { id: "task", kind: "task", status: "completed", invoice_id: null, scheduled_on: "2026-11-04", completed_at: "2026-11-04T15:00:00Z" },
  ];

  it("bills the month's finished visits not yet invoiced", () => {
    expect(visitDay(visits[2]!, "America/Chicago")).toBe("2026-11-15");
    expect(monthlyVisits(visits, period, "America/Chicago").map((v) => v.id)).toEqual(["in-1", "in-2", "evening"]);
  });

  it("finds nothing left on a second run, once the first invoice holds them", () => {
    const billed = visits.map((v) => (monthlyVisits(visits, period, "America/Chicago").includes(v) ? { ...v, invoice_id: "inv-2" } : v));
    expect(monthlyVisits(billed, period, "America/Chicago")).toEqual([]);
  });
});
