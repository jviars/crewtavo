import { describe, expect, it } from "vitest";
import { expenseCosts, jobProfit, materialUse, resolveRange, serviceFigures, type ServiceItem, type ServiceLineRow } from "../src";

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

  it("leaves out an expense already in the line items, and shares what logged materials ran over the estimate", () => {
    const job = invoice("j", { job_id: "j2" });
    const figures = serviceFigures([line(job, "Mulch", 10, 60, "s2")], items, {
      jobLines: [],
      time: [],
      // The supplier's invoice for the mulch the estimate covers, and a dump fee that's extra.
      expenses: [{ job_id: "j2", amount: 310, in_line_costs: true }, { job_id: "j2", amount: 40 }],
      rateOf: () => 0,
      costLines: [{ job_id: "j2", service_id: "s2", unit: "yd", quantity: 10, unit_cost: 30 }],
      materials: [{ job_id: "j2", service_id: "s2", name: "Mulch", unit: "yd", quantity: 12 }, { job_id: "j9", service_id: "s2", name: "Mulch", unit: "yd", quantity: 99 }],
    });
    // 10 yd at 30 on the line, 12 logged: 60 over, with the 40 dump fee. The 310 invoice isn't counted again.
    expect(figures.services[0]).toMatchObject({ item_costs: 300, expenses: 100, cost: 400, profit: 200 });
  });
});

describe("job costs count labor and materials once", () => {
  // A job priced with the paving calculator: one line at the bid's cost, with its crew days as labor
  // and what it's made of. And a job priced from the price list by the ton.
  const parts = [
    { id: "top", name: "Top coat asphalt", unit: "ton", quantity: 147, unit_cost: 100, material: true, work: "asphalt" },
    { id: "liquid", name: "Tack coat", unit: "gal", quantity: 134, unit_cost: 4.5, material: true },
    { id: "fullCrew", name: "Full crew", unit: "day", quantity: 2, unit_cost: 5000 },
  ];
  const paving = { id: "j1", title: "Lot", financials: { contract_total: 39303 }, lines: [{ quantity: 1, unit_cost: 25303, unit_labor_cost: 10000, service_id: null, unit: "job", parts }] };
  const byTon = { id: "j2", title: "Drive", financials: { contract_total: 5720 }, lines: [{ quantity: 40, unit_cost: 92, unit_labor_cost: 30, service_id: "hot", unit: "ton" }] };
  const day = [{ id: "t1", job_id: "j1", started_at: "2026-10-05T12:00:00Z", ended_at: "2026-10-05T20:00:00Z" }];

  it("takes the calculator's crew days out of the line once the job has clocked time", () => {
    expect(jobProfit([paving], [], [], () => 0).jobs[0]).toMatchObject({ materials: 25303, labor: 0, line_labor_left_out: 0, cost: 25303 });
    // Eight hours at $800 for the whole crew: the $10,000 estimated for crew days isn't added to it.
    expect(jobProfit([paving], day, [], () => 800).jobs[0]).toMatchObject({ materials: 15303, labor: 6400, line_labor_left_out: 10000, cost: 21703, profit: 17600 });
  });

  it("sets load tickets against the calculator line's materials, by what the calculator calls them", () => {
    const tickets = [
      { job_id: "j1", name: "Top coat asphalt", unit: "ton", quantity: 80 },
      { job_id: "j1", name: "top coat asphalt ", unit: "Ton", quantity: "72.5" },
      { job_id: "j1", name: "Tack coat", unit: "gal", quantity: 120 },
      { job_id: "j1", name: "Top coat asphalt", unit: "load", quantity: 3 },
      { job_id: "j1", name: "Full crew", unit: "day", quantity: 2 },
    ];
    const use = materialUse(paving.lines, tickets, false);
    expect(use.rows).toEqual([
      { name: "Tack coat", unit: "gal", used: 120, estimated: 134, unit_cost: 4.5, estimated_cost: 603, actual_cost: 540 },
      { name: "Top coat asphalt", unit: "ton", used: 152.5, estimated: 147, unit_cost: 100, estimated_cost: 14700, actual_cost: 15250 },
      // Loads aren't tons, and crew days aren't a material: nothing to compare, nothing counted.
      { name: "Full crew", unit: "day", used: 2, estimated: null, unit_cost: null, estimated_cost: null, actual_cost: null },
      { name: "Top coat asphalt", unit: "load", used: 3, estimated: null, unit_cost: null, estimated_cost: null, actual_cost: null },
    ]);
    // 5.5 tons over at $100, 14 gallons under at $4.50.
    expect(use.adjustment).toBe(487);
    expect(jobProfit([paving], day, [], () => 800, null, [], [...tickets, { job_id: "j2", name: "Top coat asphalt", unit: "ton", quantity: 500 }]).jobs[0]).toMatchObject({ materials: 15790, logged_materials_adjustment: 487, cost: 22190 });
  });

  it("sets a material logged for a price list item against that item's lines, at the line's cost", () => {
    const logged = [{ job_id: "j2", service_id: "hot", name: "Hot-mix asphalt surface", unit: "ton", quantity: 44 }];
    expect(materialUse(byTon.lines, logged, false)).toEqual({ rows: [{ name: "Hot-mix asphalt surface", unit: "ton", used: 44, estimated: 40, unit_cost: 92, estimated_cost: 3680, actual_cost: 4048 }], adjustment: 368 });
    // With labor of its own, the line counts without its labor estimate, and so does what was logged.
    expect(materialUse(byTon.lines, logged, true)).toMatchObject({ rows: [{ unit_cost: 62, estimated_cost: 2480, actual_cost: 2728 }], adjustment: 248 });
    // In another unit, or for an item that isn't on the job, there's nothing to compare and nothing is counted.
    expect(materialUse(byTon.lines, [{ service_id: "hot", name: "Hot-mix asphalt surface", unit: "load", quantity: 3 }, { service_id: "stone", name: "Stone", unit: "ton", quantity: 9 }], false)).toMatchObject({ adjustment: 0, rows: [{ estimated: null }, { estimated: null }] });
    expect(jobProfit([byTon], [], [], () => 0, null, [], logged).jobs[0]).toMatchObject({ materials: 4048, logged_materials_adjustment: 368, cost: 4048, profit: 1672 });
    expect(jobProfit([byTon], [], [], () => 0).jobs[0]).toMatchObject({ materials: 3680, logged_materials_adjustment: 0 });
  });

  it("doesn't count an expense marked as already in the line items a second time", () => {
    const expenses = [{ job_id: "j2", amount: "3795.00", in_line_costs: true }, { job_id: "j2", amount: 120 }, { job_id: "j1", amount: 55, in_line_costs: false }];
    expect(expenseCosts(expenses.filter((e) => e.job_id === "j2"))).toEqual({ counted: 120, in_lines: 3795 });
    const profit = jobProfit([byTon, paving], [], expenses, () => 0);
    expect(profit.jobs[0]).toMatchObject({ expenses: 120, expenses_in_line_costs: 3795, materials: 3680, cost: 3800, profit: 1920 });
    expect(profit.jobs[1]).toMatchObject({ expenses: 55, expenses_in_line_costs: 0 });
  });
});

describe("a custom range's name", () => {
  it("is its first and last day, written the way the business's country writes them", () => {
    const custom = { from: "2026-10-03", to: "2026-10-09" };
    expect(resolveRange("custom", "2026-11-21", "America/New_York", custom).label).toBe("Oct 3 – Oct 9");
    expect(resolveRange("custom", "2026-11-21", "America/New_York", custom, "US").label).toBe("Oct 3 – Oct 9");
    expect(resolveRange("custom", "2026-11-21", "Europe/London", custom, "GB").label).toBe("3 Oct – 9 Oct");
    expect(resolveRange("month", "2026-11-21", "Europe/London", custom, "GB").label).toBe(resolveRange("month", "2026-11-21", "America/New_York").label);
  });
});
