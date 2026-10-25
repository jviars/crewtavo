import { describe, expect, it } from "vitest";
import { jobCosts } from "../src/features/jobs/jobCosts";
import {
  actionLabel,
  agreedToast,
  auditPresets,
  byPayOrder,
  defaultYear,
  draftAmount,
  draftOf,
  finishedOn,
  lastWorkDay,
  lineChange,
  lineNote,
  linesTotal,
  newLine,
  owedSelection,
  payActions,
  payeeOf,
  payPaperworkWarning,
  payStatusLine,
  perUnit,
  quantityWords,
  rateText,
  readQuantity,
  readRate,
  squaresText,
  startingVisits,
  thresholdText,
  visitsHint,
  warnsPaperwork,
  workDays,
  yearChoices,
  yearPaid,
  type PayLine, cutShortNote, overCounted } from "../src/features/subs/pay";
import { owedFor, PAY_COLUMNS, payRows, pieceJobs, waitingFor, type PayPerson } from "../src/features/timesheets/payCsv";

const line = (extra: Partial<PayLine> = {}): PayLine => ({
  id: "l1", description: "Architectural shingles", basis: "per_unit", unit: "sq", quantity: 27, rate: 75, amount: 2025, pay_rate_id: "r1", sort: 1, ...extra,
});

describe("rates in words", () => {
  it("says per square of a service, per unit, per job and per day", () => {
    expect(rateText({ basis: "per_unit", unit: "sq", rate: 75, service: { name: "Architectural shingles" } })).toBe("$75.00 per square of Architectural shingles");
    expect(rateText({ basis: "per_unit", unit: "lf", rate: "8.5", service: { name: "Seamless gutters" } })).toBe("$8.50 per lf of Seamless gutters");
    expect(rateText({ basis: "per_unit", unit: "ea", rate: 40, service: { name: "Pipe boots" } })).toBe("$40.00 each for Pipe boots");
    expect(rateText({ basis: "per_job", unit: "job", rate: 400 })).toBe("$400.00 per job");
    expect(rateText({ basis: "per_day", unit: "day", rate: 250 })).toBe("$250.00 per day");
    // Paving rates go to 4 places.
    expect(rateText({ basis: "per_unit", unit: "sqft", rate: 0.0425, service: { name: "Sealcoat" } })).toBe("$0.0425 per sqft of Sealcoat");
    expect(rateText({ basis: "per_unit", unit: "sq", rate: 75, service: null })).toContain("deleted");
  });

  it("says which squares a rate per square counts, and nothing for other rates", () => {
    expect(squaresText({ basis: "per_unit", unit: "squares", squares_basis: "job" })).toBe("The job's squares (what the client pays for)");
    expect(squaresText({ basis: "per_unit", unit: "SQ", squares_basis: "roof_no_waste" })).toBe("Roof squares without waste");
    expect(squaresText({ basis: "per_unit", unit: "lf", squares_basis: "job" })).toBeNull();
    expect(squaresText({ basis: "per_day", unit: "day", squares_basis: "job" })).toBeNull();
  });

  it("puts units and quantities in plain words", () => {
    expect(perUnit("sq")).toBe("per square");
    expect(perUnit("")).toBe("each");
    expect(perUnit("lf")).toBe("per lf");
    expect(quantityWords(24, "sq")).toBe("24 squares");
    expect(quantityWords(1, "square")).toBe("1 square");
    expect(quantityWords(3, "day")).toBe("3 days");
    expect(quantityWords(1, "job")).toBe("1 job");
    expect(quantityWords(23.475, "sq")).toBe("23.475 squares");
    expect(quantityWords(120, "lf")).toBe("120 lf");
  });

  it("reads rates to 4 places and quantities to 3, turning down what won't save", () => {
    expect(readRate("75")).toBe(75);
    expect(readRate("$1,250.50")).toBe(1250.5);
    expect(readRate("0.04255")).toBe(0.0426);
    expect(readRate("")).toBeNull();
    expect(readRate(".")).toBeNull();
    expect(readRate("-5")).toBeNull();
    expect(readRate("1000001")).toBeNull();
    expect(readQuantity("23.4755")).toBe(23.476);
    expect(readQuantity("abc")).toBeNull();
  });
});

describe("a pay's lines", () => {
  it("checks a typed line and saves only what changed", () => {
    const l = line();
    expect(lineChange(l, draftOf(l))).toEqual({ patch: {}, problem: null });
    expect(lineChange(l, { ...draftOf(l), quantity: "24" })).toEqual({ patch: { quantity: 24 }, problem: null });
    expect(lineChange(l, { description: " Tear-off ", quantity: "27", rate: "80.125" })).toEqual({ patch: { description: "Tear-off", rate: 80.125 }, problem: null });
    expect(lineChange(l, { ...draftOf(l), description: "  " }).problem).toBe("Say what it's for.");
    expect(lineChange(l, { ...draftOf(l), quantity: "" }).problem).toMatch(/quantity/);
    expect(lineChange(l, { ...draftOf(l), rate: "x" }).problem).toMatch(/rate/);
    expect(lineChange(l, { ...draftOf(l), description: "x".repeat(201) }).problem).toMatch(/200/);
  });

  it("works amounts out as the database does, and totals with what's being typed", () => {
    expect(draftAmount({ quantity: "23.48", rate: "75" })).toBe(1761);
    expect(draftAmount({ quantity: "3", rate: "0.335" })).toBe(1.01);
    expect(draftAmount({ quantity: "", rate: "75" })).toBeNull();
    const lines = [line(), line({ id: "l2", description: "Day rate", basis: "per_day", unit: "day", quantity: 2, rate: 250, amount: 500 })];
    expect(linesTotal(lines)).toBe(2525);
    expect(linesTotal(lines, { l1: { description: "Shingles", quantity: "24", rate: "75" } })).toBe(2300);
    // A line being typed that isn't a number yet counts as saved.
    expect(linesTotal(lines, { l1: { description: "Shingles", quantity: "", rate: "75" } })).toBe(2525);
  });

  it("adds a line at the end for anything the rates don't cover", () => {
    expect(newLine([{ sort: 1 }, { sort: 4 }])).toEqual({ description: "Other work", basis: "per_job", unit: "job", quantity: 1, rate: 0, sort: 5 });
    expect(newLine([]).sort).toBe(1);
  });

  it("shows where a line's quantity came from, and what's suggested once it's changed (a share of the squares isn't a warning)", () => {
    const suggestions = [{ pay_rate_id: "r1", description: "Architectural shingles", quantity: 27, unit: "sq", note: "27 squares of Architectural shingles on the job.", check_it: false }];
    expect(lineNote(line(), suggestions)).toEqual({ text: "27 squares of Architectural shingles on the job.", check: false });
    expect(lineNote(line({ quantity: 13.5 }), suggestions)).toEqual({ text: "27 squares of Architectural shingles on the job. Suggested: 27 squares.", check: false });
    expect(lineNote(line({ pay_rate_id: null }), suggestions)).toBeNull();
    expect(lineNote(line(), undefined)).toBeNull();
    expect(lineNote(line(), [{ ...suggestions[0]!, check_it: true }])!.check).toBe(true);
  });
});

describe("what can be done with pay", () => {
  it("offers the next steps by status, and never marks a team member's paid here", () => {
    expect(payActions("draft", "sub")).toEqual(["accept", "delete"]);
    expect(payActions("accepted", "sub")).toEqual(["done", "cancel"]);
    expect(payActions("done", "sub")).toEqual(["paid", "cancel"]);
    expect(payActions("done", "team")).toEqual(["cancel"]);
    expect(payActions("paid", "sub")).toEqual(["unpaid"]);
    expect(payActions("paid", "team")).toEqual([]);
    expect(payActions("cancelled", "sub")).toEqual(["delete"]);
    expect(payActions("offered", "sub")).toEqual(["accept", "cancel"]);
  });

  it("names them plainly, promising a sub goes on the job only when they sign in", () => {
    expect(actionLabel("accept", "sub", 1)).toBe("Agree and put them on the job");
    expect(actionLabel("accept", "sub", 0)).toBe("Agree to this pay");
    expect(actionLabel("accept", "sub", null)).toBe("Agree to this pay");
    expect(actionLabel("accept", "sub")).toBe("Agree to this pay");
    expect(actionLabel("accept", "team")).toBe("Agree to this pay");
    expect(agreedToast("sub", "Apex Roofing", 2)).toBe("Agreed. Apex Roofing is on the job.");
    expect(agreedToast("sub", "Cedar Siding", 0)).toBe("Pay agreed");
    expect(agreedToast("sub", "Cedar Siding", undefined)).toBe("Pay agreed");
    expect(agreedToast("team", "Cy", null)).toBe("Pay agreed");
    expect(visitsHint("sub", 1)).toBe("When they take the offer, or you agree the pay, they go on these visits.");
    expect(visitsHint("sub", 1, true)).toMatch(/^Ticking a visit puts them on it/);
    expect(visitsHint("sub", 0)).toMatch(/^They don't sign in, so they aren't put on these visits/);
    // Not known (the person can't see sign-ins): nothing claimed either way.
    expect(visitsHint("sub", null)).toBe(visitsHint("team", null));
    expect(visitsHint("team", null)).not.toMatch(/they go on|don't sign in/);
    expect(actionLabel("done", "sub")).toBe("Mark work done");
    expect(actionLabel("paid", "sub")).toBe("Mark paid");
    expect(actionLabel("unpaid", "sub")).toBe("Take back paid");
  });

  it("says where the pay stands", () => {
    const base = { subcontractor_id: "s1", earned_on: null, paid_at: null, paid_amount: null, method: null, reference: null };
    expect(payeeOf(base)).toBe("sub");
    expect(payeeOf({ subcontractor_id: null })).toBe("team");
    expect(payStatusLine({ ...base, status: "draft" }, "America/Chicago")).toMatch(/don't see it/);
    expect(payStatusLine({ ...base, status: "done", earned_on: "2026-10-20" }, "America/Chicago")).toBe("Work done Oct 20, 2026. Owed.");
    expect(payStatusLine({ ...base, subcontractor_id: null, status: "done", earned_on: "2026-10-20" }, "America/Chicago")).toMatch(/pay period, under Timesheets → Pay/);
    expect(payStatusLine({ ...base, subcontractor_id: null, status: "done", earned_on: "2026-10-20" }, "America/Chicago", "2026-10-20")).toMatch(/^Work done Oct 20, 2026\./);
    // Finished in a pay period they'd been paid for already: counted in the next.
    expect(payStatusLine({ ...base, subcontractor_id: null, status: "done", earned_on: "2026-10-12" }, "America/Chicago", "2026-10-09"))
      .toBe("Work finished Oct 9, 2026. They'd been paid for that pay period already, so it counts from Oct 12, 2026, with their next one under Timesheets → Pay.");
    expect(payStatusLine({ ...base, status: "done", earned_on: "2026-10-12" }, "America/Chicago", "2026-10-09")).toBe("Work done Oct 12, 2026. Owed.");
    // Paid at noon the company's day, shown on that day.
    expect(payStatusLine({ ...base, status: "paid", paid_at: "2026-10-21T17:00:00Z", paid_amount: 2700, method: "ach", reference: "T-77" }, "America/Chicago"))
      .toBe("Paid $2,700.00 on Oct 21, 2026 (Bank transfer · T-77).");
  });

  it("lists owed and agreed pay before drafts, paid and cancelled", () => {
    const rows = ["cancelled", "paid", "draft", "accepted", "done"].map((status, i) => ({ status, created_at: `2026-10-0${i + 1}` }));
    expect([...rows].sort(byPayOrder).map((r) => r.status)).toEqual(["done", "accepted", "draft", "paid", "cancelled"]);
  });
});

describe("visits pay covers", () => {
  const visits = [
    { id: "v1", status: "completed", scheduled_on: "2026-10-12", assignees: [{ user_id: "al" }] },
    { id: "v2", status: "scheduled", scheduled_on: "2026-10-14", assignees: [{ user_id: "al" }, { user_id: "cy" }] },
    { id: "v3", status: "cancelled", scheduled_on: "2026-10-20", assignees: [{ user_id: "al" }] },
    { id: "v4", status: "scheduled", scheduled_on: null, assignees: [] },
  ];
  it("starts with the visits the database covers (a crew's visit too), among the job's", () => {
    // v4 has nobody on it by name: it's their crew's, which only the database knows.
    expect(startingVisits(visits, ["v4", "v1"])).toEqual(["v1", "v4"]);
    expect(startingVisits(visits, ["v9"])).toEqual([]);
    expect(startingVisits(visits, undefined)).toEqual([]);
  });
  it("finds the day the work finished, once every visit it covers is", () => {
    const done = [
      { id: "a", status: "completed", scheduled_on: "2026-10-08", completed_at: "2026-10-09T03:30:00Z" },
      { id: "b", status: "completed", scheduled_on: "2026-10-07", completed_at: "2026-10-07T18:00:00Z" },
      { id: "c", status: "cancelled", scheduled_on: "2026-10-10", completed_at: null },
      { id: "d", status: "scheduled", scheduled_on: "2026-10-12", completed_at: null },
    ];
    // 11:30 pm on Oct 8 in New York.
    expect(finishedOn(done, ["a", "b", "c"], "America/New_York")).toBe("2026-10-08");
    expect(finishedOn(done, ["a", "d"], "America/New_York")).toBeNull();
    expect(finishedOn(done, [], "America/New_York")).toBeNull();
  });
  it("finds the last day of work it covers", () => {
    expect(lastWorkDay(visits, ["v1", "v2", "v3", "v4"])).toBe("2026-10-14");
    expect(lastWorkDay(visits, ["v4"])).toBeNull();
  });
});

describe("the paperwork warning on a job", () => {
  const ok = [
    { requirement: "w9", state: "ok", expires_on: null },
    { requirement: "liability", state: "ok", expires_on: "2027-03-01" },
    { requirement: "workers_comp", state: "ok", expires_on: "2027-03-01" },
  ];
  it("says nothing when it's all current through the work", () => {
    expect(payPaperworkWarning(ok, "2026-11-10", "2026-10-25")).toBeNull();
  });
  it("warns about anything missing, run out, or ending before their last day, and never says it stops them", () => {
    const missing = payPaperworkWarning([ok[0]!, { requirement: "liability", state: "expired", expires_on: "2026-10-01" }], "2026-11-10", "2026-10-25")!;
    expect(missing).toBe("Their liability insurance has run out and workers' comp isn't on file. You can still give them the work, but without current certificates your insurance company may charge you for it at your audit.");
    const ending = payPaperworkWarning([ok[0]!, ok[1]!, { requirement: "workers_comp", state: "expiring", expires_on: "2026-11-02" }], "2026-11-10", "2026-10-25")!;
    expect(ending).toMatch(/^Their workers' comp ends Nov 2, 2026, before their last day on this job \(Nov 10, 2026\)\./);
    expect(ending).toMatch(/You can still give them the work/);
    // With no visits to go by, an end date still to come isn't a gap.
    expect(payPaperworkWarning([ok[0]!, ok[1]!, { requirement: "workers_comp", state: "expiring", expires_on: "2026-11-02" }], null, "2026-10-25")).toBeNull();
  });
  it("warns before and during the work, not once it's done or for a sub who's been turned off", () => {
    expect(["draft", "offered", "accepted"].every((s) => warnsPaperwork(s, true))).toBe(true);
    expect(warnsPaperwork("accepted", undefined)).toBe(true);
    expect(["done", "paid", "cancelled"].some((s) => warnsPaperwork(s, true))).toBe(false);
    // A sub who's been turned off has no paperwork status, which would read as nothing on file.
    expect(warnsPaperwork("accepted", false)).toBe(false);
  });
  it("mentions a missing W-9 on its own terms", () => {
    expect(payPaperworkWarning(ok.slice(1), "2026-11-10", "2026-10-25")).toBe("For this sub, there's no W-9 on file (you'll need it for their 1099). You can still give them the work.");
    expect(payPaperworkWarning([], null, "2026-10-25")).toMatch(/^For this sub, there's no W-9 on file \(you'll need it for their 1099\), liability insurance isn't on file and workers' comp isn't on file\./);
  });
});

describe("owed and paid", () => {
  it("adds up what's picked to the cent", () => {
    const rows = [{ id: "a", total: "0.10" }, { id: "b", total: 0.2 }, { id: "c", total: 100 }];
    expect(owedSelection(rows, new Set(["a", "b"]))).toEqual({ count: 2, total: 0.3 });
    expect(owedSelection(rows, new Set())).toEqual({ count: 0, total: 0 });
  });
  it("adds up a sub's year by the company's paid date, card payments left out of the 1099 part", () => {
    const rows = [
      { status: "paid", total: 1000, paid_amount: 1000, paid_at: "2026-03-01T18:00:00Z", method: "check" },
      { status: "paid", total: 500, paid_amount: 450, paid_at: "2026-06-01T18:00:00Z", method: "card_or_app" },
      // New Year's Eve in Chicago, January 1 in UTC: last year's.
      { status: "paid", total: 300, paid_amount: 300, paid_at: "2027-01-01T03:00:00Z", method: "ach" },
      { status: "done", total: 275.5, paid_amount: null, paid_at: null, method: null },
      { status: "accepted", total: 900, paid_amount: null, paid_at: null, method: null },
    ];
    expect(yearPaid(rows, 2026, "America/Chicago")).toEqual({ paid: 1750, for1099: 1300, payments: 3, owed: 275.5 });
    expect(yearPaid(rows, 2027, "America/Chicago").paid).toBe(0);
  });
});

describe("year-end totals and the workers' comp audit", () => {
  it("offers this year and the three before, opening on last year in January and February", () => {
    expect(yearChoices("2026-10-25")).toEqual([2026, 2025, 2024, 2023]);
    expect(defaultYear("2027-01-15")).toBe(2026);
    expect(defaultYear("2027-02-28")).toBe(2026);
    expect(defaultYear("2027-03-01")).toBe(2027);
  });
  it("says the year's threshold plainly", () => {
    expect(thresholdText(2025, 600)).toBe("For 2025, a 1099-NEC goes to each sub you paid $600 or more, unless they're a corporation.");
    expect(thresholdText(2026, 2000)).toBe("For 2026, a 1099-NEC goes to each sub you paid $2,000 or more, unless they're a corporation.");
  });
  it("offers policy periods to pick", () => {
    expect(auditPresets("2026-10-25").map((p) => [p.label, p.from, p.to])).toEqual([
      ["Last 12 months", "2025-10-26", "2026-10-25"],
      ["2026", "2026-01-01", "2026-12-31"],
      ["2025", "2025-01-01", "2025-12-31"],
    ]);
  });
  it("lists the days worked, shortened when there are many", () => {
    expect(workDays(["2026-10-02", "2026-10-03"])).toBe("Oct 2, Oct 3");
    expect(workDays(["2025-12-30", "2026-01-02"])).toBe("Dec 30, 2025, Jan 2, 2026");
    expect(workDays(["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07"])).toBe("Oct 1 to Oct 7 (7 days)");
    expect(workDays([])).toBe("");
  });
});

describe("the job's costs", () => {
  const lines = [{ quantity: 27, unit_cost: 180, unit_labor_cost: 70 }, { quantity: 1, unit_cost: 50, unit_labor_cost: null }];
  it("counts the whole line cost when the job has no labor of its own", () => {
    const c = jobCosts({ contract: 10000, lines, labor: 0, expenses: 100, crewPay: [] });
    expect(c).toMatchObject({ materials: 4910, leftOut: 0, crew: 0, total: 5010, profit: 4990, margin: 50, actualLabor: false, note: null });
  });
  it("counts materials only once there's sub and crew pay, and says why", () => {
    const c = jobCosts({ contract: 10000, lines, labor: 0, expenses: 100, crewPay: [{ amount: "2025.00", payees: 1 }] });
    expect(c).toMatchObject({ materials: 3020, leftOut: 1890, crew: 2025, total: 5145, profit: 4855, actualLabor: true });
    expect(c.note).toBe("Line item costs count materials only, since this job has its own labor: the $1,890.00 of labor estimated in them isn't counted twice.");
  });
  it("does the same for time on the job, and says nothing when the lines had no labor in them", () => {
    expect(jobCosts({ contract: 0, lines, labor: 300, expenses: 0, crewPay: [] })).toMatchObject({ materials: 3020, margin: null, actualLabor: true });
    expect(jobCosts({ contract: 100, lines: [{ quantity: 1, unit_cost: 50 }], labor: 10, expenses: 0, crewPay: [] }).note).toBeNull();
  });
  it("keeps the labor estimate while the job's time costs nothing yet (no rate set, or a clock running)", () => {
    expect(jobCosts({ contract: 10000, lines, labor: 0, expenses: 0, crewPay: [] })).toMatchObject({ materials: 4910, leftOut: 0, actualLabor: false, note: null });
  });
});

describe("Timesheets → Pay's download", () => {
  const person = (extra: Partial<PayPerson> = {}): PayPerson => ({
    user_id: "cy", name: "Cy", hours: 8, break_hours: 0.5, overtime_hours: 0, hourly_amount: 160, piece_amount: 234.8, amount: 394.8, unapproved_hours: 0, running: false,
    piece: [{ id: "p1", job_id: "j1", job_number: 12, job_title: "Smith roof", total: 234.8, status: "done", earned_on: "2026-10-14" }], paid: null, ...extra,
  });
  it("has hourly, piece and total pay columns", () => {
    expect(PAY_COLUMNS.map((c) => c.label)).toEqual(expect.arrayContaining(["Hourly pay at their rate", "Piece pay", "Total pay"]));
    expect(payRows([person({ paid: { paid_amount: 394.8, method: "check", reference: "1042", paid_at: "2026-10-19T16:00:00Z" } })], (m) => (m === "check" ? "Check" : ""))).toEqual([
      { person: "Cy", hours: "8.00", overtime: "0.00", breaks: "0.50", hourly: "160.00", piece: "234.80", amount: "394.80", paid: "394.80", method: "Check", reference: "1042", not_approved: "0.00" },
    ]);
  });
  it("counts someone with only piece pay as owed, and lists the jobs it's from", () => {
    expect(owedFor({ hours: 0, piece_amount: 100 })).toBe(true);
    expect(owedFor({ hours: 0, piece_amount: 0 })).toBe(false);
    expect(pieceJobs(person(), (n) => `$${n.toFixed(2)}`)).toBe("Job #12 Smith roof, $234.80");
  });
  it("waits on unapproved time for anyone being marked paid, piece pay alone included", () => {
    const pieceOnly = person({ user_id: "dee", name: "Dee", hours: 0, hourly_amount: 0, amount: 234.8, unapproved_hours: 3 });
    expect(waitingFor([person(), pieceOnly]).map((p) => p.name)).toEqual(["Dee"]);
    expect(waitingFor([person({ running: true })])).toHaveLength(1);
    expect(waitingFor([person()])).toEqual([]);
  });
});

describe("checks across a job's pay", () => {
  const shingles = (quantity: number) => ({ basis: "per_unit", service_id: "s-roof", quantity, unit: "sq" });
  const job = [{ service_id: "s-roof", name: "Architectural shingles", quantity: 24, unit: "sq", unit_price: 450 }, { service_id: "s-roof", name: "Shingle credit", quantity: 2, unit: "sq", unit_price: -50 }];

  it("warns when the per-unit pay in play counts more of a service than the job has", () => {
    // A sub's 24 and a crew member's 24, the defaults agreed for both: the roof paid twice.
    expect(overCounted([{ status: "accepted", lines: [shingles(24)] }, { status: "draft", lines: [shingles(24)] }], job)).toEqual([
      "Pay on this job counts 48 squares of Architectural shingles, and the job has 24 squares. Each person's line should be their share.",
    ]);
    // Shares that add up, pay that's over, and per-job lines don't.
    expect(overCounted([{ status: "accepted", lines: [shingles(18)] }, { status: "draft", lines: [shingles(6)] }], job)).toEqual([]);
    expect(overCounted([{ status: "declined", lines: [shingles(24)] }, { status: "accepted", lines: [shingles(24)] }], job)).toEqual([]);
    expect(overCounted([{ status: "accepted", lines: [{ basis: "per_job", service_id: null, quantity: 1, unit: "job" }, shingles(24)] }], job)).toEqual([]);
  });

  it("says why agreed pay whose visits were cut wasn't marked done by itself", () => {
    const visits = [{ id: "v1", status: "completed" }, { id: "v2", status: "cancelled" }];
    const pay = { status: "accepted", visits: [{ visit_id: "v1" }, { visit_id: "v2", cancelled_while_agreed: true }] };
    expect(cutShortNote(pay, visits)).toBe("Some visits it covers were cancelled after the price was agreed, so it wasn't marked done by itself. Check the lines, then mark the work done.");
    // Work still to do, cancelled before it was agreed, or already done: nothing to say.
    expect(cutShortNote(pay, [{ id: "v1", status: "scheduled" }, { id: "v2", status: "cancelled" }])).toBeNull();
    expect(cutShortNote({ ...pay, visits: [{ visit_id: "v1" }, { visit_id: "v2" }] }, visits)).toBeNull();
    expect(cutShortNote({ ...pay, status: "done" }, visits)).toBeNull();
  });
});
