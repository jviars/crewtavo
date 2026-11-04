import { describe, expect, it } from "vitest";
import { serviceFigures, type ServiceItem, type ServiceLineRow } from "../src";

const items: ServiceItem[] = [
  { id: "s1", name: "Mowing", category: "Lawn", unit_cost: 20, labor_cost: 15 },
  { id: "s2", name: "Mulch", category: "Beds", unit_cost: 30, labor_cost: null },
];
const invoice = (id: string, more: Partial<NonNullable<ServiceLineRow["invoice"]>> = {}) => ({ id, job_id: null, kind: "standard", status: "sent", issued_on: "2026-10-05", discount_amount: 0, credit_amount: 0, ...more });
const line = (inv: ServiceLineRow["invoice"], name: string, quantity: number, unit_price: number, service_id: string | null = null): ServiceLineRow => ({ invoice: inv, name, quantity, unit_price, service_id });

// A final invoice for job j1, less its deposit.
const final = invoice("a", { job_id: "j1" });
// The rest of j1's billing: its deposit, and an invoice before the period.
const deposit = invoice("d", { job_id: "j1", kind: "deposit" });
const earlier = invoice("e", { job_id: "j1", issued_on: "2026-09-01" });
// No job, with a promo discount line, a promo code discount and a referral credit.
const counter = invoice("b", { issued_on: "2026-10-20", status: "paid", discount_amount: 10, credit_amount: 20 });
const rows = [
  line(final, "Mowing", 2, 50, "s1"),
  line(final, "Mulch", 1, 100, "s2"),
  line(final, "Less deposit (invoice #3)", 1, -50),
  line(deposit, "Deposit for Spring cleanup", 1, 50),
  line(invoice("v", { status: "void" }), "Mowing", 10, 100, "s1"),
  line(invoice("dr", { status: "draft" }), "Mowing", 10, 100, "s1"),
  line(invoice("r", { kind: "retainage" }), "Retainage release: Spring cleanup", 1, 75),
  line(counter, "mowing ", 1, 80),
  line(counter, "Haul away", 1, 40),
  line(counter, "Spring promo", 1, -30),
];

describe("revenue by service", () => {
  it("counts sold lines after discounts and credits, leaving out voids, drafts and part billings", () => {
    const figures = serviceFigures(rows, items);
    expect(figures.revenue).toBe(260);
    expect(figures.profit).toBeNull();
    expect(figures.services.map((s) => [s.name, s.category, s.count, s.revenue])).toEqual([
      // 100 on the final invoice (its deposit line isn't a discount), and 80 by name, halved by 60 off 120.
      ["Mowing", "Lawn", 2, 140],
      ["Mulch", "Beds", 1, 100],
      // A line not from the price list.
      ["Other", null, 1, 20],
    ]);
    expect(figures.services[0]).toMatchObject({ quantity: 3, cost: null, margin_percent: null });
    expect(figures.lines.filter((l) => l.key === "s1").map((l) => [l.issued_on, l.revenue])).toEqual([["2026-10-05", 100], ["2026-10-20", 40]]);
  });

  it("doesn't count a fully discounted invoice, or a negative balance", () => {
    const free = invoice("f", { discount_amount: 500 });
    expect(serviceFigures([line(free, "Mowing", 1, 100, "s1"), line(free, "Credit", 1, -40)], items).revenue).toBe(0);
  });

  it("splits a job's labor and expenses by each line's share of all it's been invoiced", () => {
    const figures = serviceFigures(rows, items, {
      jobLines: [...rows.filter((r) => r.invoice?.job_id === "j1"), line(earlier, "Mowing", 2, 50, "s1")],
      time: [{ id: "t1", job_id: "j1", started_at: "2026-10-05T12:00:00Z", ended_at: "2026-10-05T16:00:00Z" }],
      expenses: [{ job_id: "j1", amount: 30 }, { job_id: "j9", amount: 999 }],
      rateOf: () => 25,
      crewPay: [{ job_id: "j1", amount: 50 }],
    });
    // j1 was invoiced 300 in all, 100 of it Mowing and 100 Mulch in this period: a third of its
    // 150 labor (100 of time, 50 of crew pay) and 30 expenses each. Its own labor takes the labor
    // estimate out of Mowing's unit cost (2 x 5); the jobless Mowing line costs its full 20.
    expect(figures.services.find((s) => s.name === "Mowing")).toMatchObject({ revenue: 140, item_costs: 30, labor: 50, expenses: 10, cost: 90, profit: 50, margin_percent: 35.7 });
    expect(figures.services.find((s) => s.name === "Mulch")).toMatchObject({ revenue: 100, item_costs: 30, labor: 50, expenses: 10, cost: 90, profit: 10, margin_percent: 10 });
    expect(figures.services.find((s) => s.name === "Other")).toMatchObject({ revenue: 20, cost: 0, profit: 20 });
    expect(figures).toMatchObject({ revenue: 260, profit: 80, margin_percent: 30.8 });
  });

  it("keeps a line's labor estimate when the job has no labor of its own", () => {
    const job = invoice("j", { job_id: "j2" });
    const figures = serviceFigures([line(job, "Mowing", 1, 100, "s1")], items, { jobLines: [], time: [], expenses: [], rateOf: () => 0 });
    expect(figures.services[0]).toMatchObject({ item_costs: 20, labor: 0, profit: 80 });
  });
});
