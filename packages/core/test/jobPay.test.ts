import { describe, expect, it } from "vitest";
import {
  certificateText,
  isCorporation,
  isLivePay,
  isPayEditable,
  isSquareUnit,
  jobPayMethodLabel,
  jobPayStatusLabel,
  jobProfit,
  lineCosts,
  necThreshold,
  payLineAmount,
  payrollMethod,
  paySummary,
  PIECE_OVERTIME_NOTE,
  wcAuditCsv,
  wcAuditTotals,
  wcPartNote,
  yearTotals,
  yearTotalsCsv,
  type SubYearTotalRow,
  type WcAuditRow,
  type WcCertificate,
} from "../src";

describe("job pay", () => {
  it("names statuses and methods in plain words", () => {
    expect(jobPayStatusLabel("accepted")).toBe("Agreed");
    expect(jobPayStatusLabel("done")).toBe("Work done");
    expect(jobPayMethodLabel("card_or_app")).toBe("Card or payment app");
    expect(jobPayMethodLabel(null)).toBe("");
    expect(["draft", "accepted", "done", "paid"].every(isLivePay)).toBe(true);
    expect(["declined", "withdrawn", "expired", "cancelled"].some(isLivePay)).toBe(false);
    expect(["draft", "accepted"].every(isPayEditable) && !["done", "paid", "cancelled"].some(isPayEditable)).toBe(true);
  });

  it("counts squares as the database does", () => {
    expect(["sq", "SQ", "sq.", "square", "Squares"].every(isSquareUnit)).toBe(true);
    expect(["sq ft", "lf", "ea", null, ""].some(isSquareUnit)).toBe(false);
  });

  it("works a line out to the cent, rounding half a cent up, as the database does", () => {
    expect(payLineAmount(3, 0.335)).toBe(1.01);
    expect(payLineAmount("2.333", "10.555")).toBe(24.62);
    expect(payLineAmount(23.48, 60)).toBe(1408.8);
    expect(payLineAmount(0, 75)).toBe(0);
  });

  it("records a pay period's method as job pay does", () => {
    expect(payrollMethod("direct_deposit")).toBe("ach");
    expect(payrollMethod("payroll_service")).toBe("payroll");
    expect(payrollMethod("check")).toBe("check");
    expect(payrollMethod(null)).toBe("payroll");
  });
});

describe("the 1099 totals", () => {
  it("has the reporting threshold by year: $600 through 2025, $2,000 for 2026, and $2,000 to check after", () => {
    expect(necThreshold(2024)).toEqual({ amount: 600, note: null });
    expect(necThreshold(2025)).toEqual({ amount: 600, note: null });
    expect(necThreshold(2026)).toEqual({ amount: 2000, note: null });
    expect(necThreshold(2027).amount).toBe(2000);
    expect(necThreshold(2027).note).toMatch(/adjusts this for inflation\. Check the 1099-NEC instructions for 2027/);
  });

  const row = (extra: Partial<SubYearTotalRow>): SubYearTotalRow => ({
    subcontractor_id: "s1", name: "Apex Roofing", contact_name: "Al Apex", email: "al@apex.test", phone: "+15405550101",
    address: { line1: "5 Pine Rd", city: "Dover", region: "DE", postal_code: "19901" }, tax_classification: "individual", active: true,
    corporation: false, total: "3700.00", payments: 2, card_or_app_total: "0", card_or_app_payments: 0, ...extra,
  });

  it("says who needs one: not a corporation, and paid at least the year's threshold", () => {
    const totals = yearTotals([
      row({}),
      row({ subcontractor_id: "s2", name: "Birch Gutters Inc", tax_classification: "s_corp", corporation: true, total: 9000 }),
      row({ subcontractor_id: "s3", name: "Cedar Siding", tax_classification: null, total: "1999.99" }),
      row({ subcontractor_id: "s4", name: "Dock Decks", total: "2000", card_or_app_total: "450.5", card_or_app_payments: 1 }),
    ], 2026);
    expect(totals).toMatchObject({ year: 2026, threshold: 2000, threshold_note: null, total: 16699.99, needing_1099: 2 });
    expect(totals.subs.map((s) => [s.name, s.needs_1099, s.note])).toEqual([
      ["Apex Roofing", true, ""],
      ["Birch Gutters Inc", false, "A corporation usually doesn't get a 1099."],
      ["Cedar Siding", false, "No W-9 on file: get one to check. Under the $2,000.00 threshold for 2026."],
      ["Dock Decks", true, "$450.50 paid by card or payment app is left out: that's reported on a 1099-K."],
    ]);
    expect(yearTotals([row({ total: 700 })], 2025).subs[0]!.needs_1099).toBe(true);
    expect(yearTotals([row({ total: 700 })], 2026).subs[0]!.needs_1099).toBe(false);
  });

  it("counts payroll payments, and says the payroll service may file that 1099 already", () => {
    const sub = yearTotals([row({ total: "3700", payroll_total: "1200.00", payroll_payments: 1 })], 2026).subs[0]!;
    expect(sub).toMatchObject({ total: 3700, payroll_total: 1200, needs_1099: true });
    expect(sub.note).toBe("$1,200.00 was paid through payroll: check whether your payroll service already files their 1099.");
    expect(yearTotals([row({})], 2026).subs[0]!.payroll_total).toBe(0);
  });

  it("flags corporations by their W-9", () => {
    expect(["c_corp", "s_corp", "llc_c_corp", "llc_s_corp"].every(isCorporation)).toBe(true);
    expect(["individual", "partnership", "llc_partnership", "other", null].some(isCorporation)).toBe(false);
  });

  it("downloads for the bookkeeper, without tax ID numbers", () => {
    const csv = yearTotalsCsv(yearTotals([row({}), row({ subcontractor_id: "s2", name: "=Evil, Inc", tax_classification: "s_corp", corporation: true, total: 100, address: {} })], 2026));
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("Legal name,Contact,Email,Phone,Address,Address line 2,City,State,ZIP,Tax classification,Total paid in 2026,Payments,Needs a 1099,Note");
    expect(lines[1]).toBe("Apex Roofing,Al Apex,al@apex.test,'+15405550101,5 Pine Rd,,Dover,DE,19901,Individual or sole proprietor,3700.00,2,Yes,");
    expect(lines[2]).toBe(`"'=Evil, Inc",Al Apex,al@apex.test,'+15405550101,,,,,,S corporation,100.00,2,No,A corporation usually doesn't get a 1099.`);
    expect(csv).not.toMatch(/tax id|ssn|ein/i);
  });
});

describe("the workers' comp audit", () => {
  const rows: WcAuditRow[] = [
    {
      job_pay_id: "p1", subcontractor_id: "s1", sub_name: "Apex Roofing", job_id: "j1", job_number: 12, job_title: "New roof", status: "paid", amount: "2700.00",
      work_dates: ["2026-10-12", "2026-10-13", "2026-10-14"], covered_dates: ["2026-10-12", "2026-10-14"], coverage: "partly", covered_amount: "1800.00", uncovered_amount: "900.00",
      documents: [
        { id: "d1", kind: "workers_comp", carrier: "Acme Mutual", policy_number: "WC-1", starts_on: "2026-01-01", expires_on: "2026-10-12", replaced: true },
        { id: "d2", kind: "wc_exemption", carrier: null, policy_number: null, starts_on: null, expires_on: "2027-10-13", replaced: false },
      ],
    },
    {
      job_pay_id: "p2", subcontractor_id: "s2", sub_name: "Birch Gutters Inc", job_id: "j2", job_number: null, job_title: "Garage roof", status: "done", amount: 600, pay_amount: "1200.00",
      work_dates: ["2026-10-15"], covered_dates: [], coverage: "no", covered_amount: 0, uncovered_amount: 600, documents: [],
    },
  ];

  it("adds up the work, paid and not paid yet, and what was covered and what wasn't", () => {
    expect(wcAuditTotals(rows)).toEqual({ amount: 3300, paid: 2700, not_paid_yet: 600, covered: 1800, not_covered: 1500, subs: 2, not_covered_subs: 2 });
    expect(wcAuditTotals([])).toEqual({ amount: 0, paid: 0, not_paid_yet: 0, covered: 0, not_covered: 0, subs: 0, not_covered_subs: 0 });
  });

  it("says when a row is part of pay with work outside the dates", () => {
    expect(wcPartNote(rows[1]!)).toBe("Part of $1,200.00 pay: some of the work is outside these dates.");
    expect(wcPartNote(rows[0]!)).toBeNull();
    expect(wcPartNote({ amount: "600.00", pay_amount: 600 })).toBeNull();
  });

  it("lists the certificates in words", () => {
    expect(certificateText((rows[0]!.documents as WcCertificate[])[0]!)).toBe("Workers' comp certificate, Acme Mutual WC-1, Jan 1, 2026 to Oct 12, 2026 (replaced)");
    expect(certificateText({ id: "d2", kind: "wc_exemption", carrier: null, policy_number: null, starts_on: null, expires_on: "2027-10-13", replaced: false }))
      .toBe("Workers' comp exemption, no start date to Oct 13, 2027");
    expect(certificateText({ id: "d3", kind: "workers_comp", carrier: "Acme Mutual", policy_number: "WC-3", starts_on: null, expires_on: "2027-03-01", replaced: false, dates_assumed: true }))
      .toBe("Workers' comp certificate, Acme Mutual WC-3, no start date to Mar 1, 2027, no start date on file, so a one-year policy is assumed");
    // An exemption missing a date is bounded too, and says how.
    const exemption = { id: "d4", kind: "wc_exemption", carrier: null, policy_number: null, replaced: false, dates_assumed: true };
    expect(certificateText({ ...exemption, starts_on: null, expires_on: "2027-10-13" })).toBe("Workers' comp exemption, no start date to Oct 13, 2027, no start date on file, so a year up to its end date is assumed");
    expect(certificateText({ ...exemption, starts_on: null, expires_on: null })).toBe("Workers' comp exemption, no dates on file, so it's counted from the day it was added");
    expect(certificateText({ ...exemption, starts_on: "2026-01-01", expires_on: null })).toBe("Workers' comp exemption, Jan 1, 2026 to no end date, no end date on file, so it's counted as still in force");
  });

  it("downloads for the auditor", () => {
    const lines = wcAuditCsv(rows).split("\r\n");
    expect(lines[0]).toBe(`Subcontractor,Job,Status,Days worked,"Amount (paid, or agreed if not paid yet)",Workers' comp,Covered,Not covered,Certificates,Note`);
    expect(lines[1]).toBe(
      "Apex Roofing,#12 New roof,Paid,2026-10-12; 2026-10-13; 2026-10-14,2700.00,Partly covered,1800.00,900.00,\"Workers' comp certificate, Acme Mutual WC-1, Jan 1, 2026 to Oct 12, 2026 (replaced); Workers' comp exemption, no start date to Oct 13, 2027\",",
    );
    expect(lines[2]).toBe("Birch Gutters Inc,Garage roof,Work done,2026-10-15,600.00,Not covered,0.00,600.00,,\"Part of $1,200.00 pay: some of the work is outside these dates.\"");
  });
});

describe("piece pay in a pay period", () => {
  const tz = "America/New_York";
  it("adds a team member's piece pay to their hourly pay, and says overtime on it is the payroll service's", () => {
    const entries = [
      ...[19, 20, 21, 22, 23].map((d, i) => ({ id: `w${i}`, user_id: "u1", started_at: `2026-10-${d}T12:00:00Z`, ended_at: `2026-10-${d}T21:00:00Z`, category: "visit", approved_at: "x" })),
    ];
    const pay = paySummary(entries, () => 20, (id) => (id === "u1" ? "Ana" : "Bo"), tz, "paid", [
      { user_id: "u1", total: "234.80" },
      { user_id: "u1", total: 100 },
      { user_id: "u2", total: "480.00" },
    ]);
    expect(pay.people).toEqual([
      { user_id: "u1", name: "Ana", hours: 45, break_hours: 0, overtime_hours: 5, hourly_amount: 900, piece_amount: 334.8, amount: 1234.8, unapproved_hours: 0, running: false },
      { user_id: "u2", name: "Bo", hours: 0, break_hours: 0, overtime_hours: 0, hourly_amount: 0, piece_amount: 480, amount: 480, unapproved_hours: 0, running: false },
    ]);
    expect(pay).toMatchObject({ hours: 45, hourly_amount: 900, piece_amount: 814.8, amount: 1714.8, overtime_hours: 5, overtime_note: PIECE_OVERTIME_NOTE });
    expect(PIECE_OVERTIME_NOTE).toMatch(/worked out from total pay and hours/);
  });
});

describe("job costs", () => {
  const job = { id: "j1", number: 12, title: "New roof", financials: { contract_total: 12150 }, lines: [{ quantity: 27, unit_cost: 300, unit_labor_cost: 120 }, { quantity: 1, unit_cost: null, unit_labor_cost: null }] };

  it("counts each line's whole cost while the job has no labor of its own", () => {
    expect(lineCosts(job.lines, false)).toEqual({ materials: 8100, left_out: 0 });
    expect(jobProfit([job], [], [], () => 0).jobs[0]).toMatchObject({ labor: 0, crew_pay: 0, materials: 8100, line_labor_left_out: 0, actual_labor: false, cost: 8100, profit: 4050 });
  });

  it("counts labor once: with sub and crew pay, lines count without their labor estimate", () => {
    const profit = jobProfit([job], [], [{ job_id: "j1", amount: 25 }], () => 0, 30, [{ job_id: "j1", amount: "2934.80" }, { job_id: "j2", amount: 99 }]);
    expect(profit.jobs[0]).toMatchObject({ labor: 0, crew_pay: 2934.8, expenses: 25, materials: 4860, line_labor_left_out: 3240, actual_labor: true, cost: 7819.8, profit: 4330.2 });
  });

  it("and with time on the job, too", () => {
    const time = [{ id: "t1", job_id: "j1", user_id: "u1", started_at: "2026-10-12T12:00:00Z", ended_at: "2026-10-12T20:00:00Z", approved_at: "x" }];
    expect(jobProfit([job], time, [], () => 25).jobs[0]).toMatchObject({ labor: 200, crew_pay: 0, materials: 4860, actual_labor: true, cost: 5060 });
  });

  it("keeps the lines' labor estimate while the job's time costs nothing yet (no rate, or a clock still running)", () => {
    const unrated = [{ id: "t1", job_id: "j1", user_id: "u1", started_at: "2026-10-12T12:00:00Z", ended_at: "2026-10-12T20:00:00Z", approved_at: "x" }];
    expect(jobProfit([job], unrated, [], () => 0).jobs[0]).toMatchObject({ labor: 0, materials: 8100, line_labor_left_out: 0, actual_labor: false, cost: 8100 });
    const running = [{ id: "t2", job_id: "j1", user_id: "u1", started_at: "2026-10-12T12:00:00Z", ended_at: null, approved_at: null }];
    expect(jobProfit([job], running, [], () => 25).jobs[0]).toMatchObject({ labor: 0, materials: 8100, actual_labor: false });
  });

  it("never counts more labor out of a line than its cost", () => {
    expect(lineCosts([{ quantity: 2, unit_cost: 100, unit_labor_cost: 150 }], true)).toEqual({ materials: 0, left_out: 200 });
  });
});
