/**
 * Coming from Jobber (jobberImport.ts): its report exports read for the open work. The headers are
 * those Jobber's help center lists for each report (Quotes, Invoices, One-off jobs, Recurring jobs,
 * Visits; November 2026), in the order an "all columns" export gives them; the rows are made up.
 */
import { describe, expect, it } from "vitest";
import {
  findJobberClient, fitJobberTotal, jobberDate, jobberFileKind, jobberImportRow, jobberLineItems, jobberRepeatRule, planJobberImport,
  readJobberInvoices, readJobberJobs, readJobberQuotes, readJobberVisits, ruleFromVisits,
} from "../src/jobberImport";

/** A CSV file as rows (quoted fields may hold commas and new lines), as the web's parseCsv reads it. */
function csv(text: string): string[][] {
  const rows: string[][] = [[]];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') (field += '"'), i++;
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") rows[rows.length - 1].push(field), (field = "");
    else if (ch === "\n") rows[rows.length - 1].push(field), (field = ""), rows.push([]);
    else field += ch;
  }
  rows[rows.length - 1].push(field);
  return rows.filter((r) => r.some((c) => c.trim()));
}

const QUOTES = csv(`Quote #,Client name,Client email address,Client phone number,Service street,Service city,Service state/province,Service ZIP/postal code,Salesperson,Title,Status,Line items,Subtotal ($),Total ($),Discount ($),Required deposit ($),Collected deposit ($),Job #s,Sent by user,Viewed in client hub,Drafted date,Sent date,Sent to,Changes requested date,Approved date,Converted date,Archived date
101,Mary Ann Smith,mary@example.com,(540) 555-0101,12 Oak St,Roanoke,VA,24011,Sam,Spring cleanup,Awaiting response,"Mulch install (3, $180.00), Edging (1, $45.00)",225.00,243.00,0.00,50.00,0.00,,Sam,,Oct 1 2026,"Oct 2, 2026",mary@example.com,,,,
102,Acme Paving,office@acme.test,,900 Industrial Rd,Salem,VA,24153,,Lot sealcoat,Approved,Sealcoat (1; $2400.00),2400.00,2400.00,0.00,600.00,600.00,,,,2026-09-12,2026-09-13,,,2026-09-20,,
103,Lee Park,lee@example.com,,4 Elm Ct,Roanoke,VA,24012,,Gutter clean,Converted,"Gutters (1, $150.00)",150.00,150.00,0,0,0,J55,,,2026-08-01,2026-08-02,,,2026-08-03,2026-08-04,
104,Lee Park,lee@example.com,,4 Elm Ct,Roanoke,VA,24012,,Fall leaves,Draft,"Leaf removal (2, $200.00)",200.00,200.00,20.00,0,0,,,,2026-10-20,,,,,,
105,Dana Ruiz,,,77 Pine Ave,Vinton,VA,24179,,Hedges,Changes requested,"Hedge trim (1, $80.00)",80.00,80.00,0,0,0,,,,2026-10-05,2026-10-06,,2026-10-08,,,
106,Lee Park,lee@example.com,,4 Elm Ct,Roanoke,VA,24012,,Old one,Archived,,0,0,0,0,0,,,,2025-01-01,,,,,,2025-06-01`);

const INVOICES = csv(`Invoice #,Client name,Client email,Sent to,Billing street,Billing city,Billing state/province,Billing ZIP/postal code,Service street,Service state/province,Service ZIP/postal code,Subject,Created date,Issued date,Due date,Marked paid date,Days to paid,Visits assigned to,Job #s,Status,Line items,Total ($),Tip ($),Balance ($),Tax (%),Deposit ($),Discount ($),Tax amount ($),Viewed in client hub,Invoice custom fields
2001,Mary Ann Smith,mary@example.com,mary@example.com,PO Box 9,Roanoke,VA,24011,12 Oak St,VA,24011,For services rendered,2026-10-01,2026-10-01,2026-10-31,,,Sam,J50,Awaiting payment,"Weekly mowing (4, $180.00), Trimming (1, $20.00)","$214.00",0,$114.00,7,0,0,14.00,No,
2002,Acme Paving,office@acme.test,,,,,,900 Industrial Rd,VA,24153,Crack fill,2026-08-01,2026-08-01,2026-08-31,,,,J51,Past due,"Crack fill (1, $500.00), Permit (1, $25.00)",559.00,0,559.00,8,0,0,34.00,Yes,
2003,Lee Park,lee@example.com,,,,,,,,,,2026-09-01,2026-09-01,2026-09-15,2026-09-10,9,,,Paid,"Gutters (1, $150.00)",150.00,0,0.00,0,0,0,0,Yes,
2004,Dana Ruiz,,,,,,,,,,Hedges,2026-10-10,2026-10-10,,,,,,Draft,"Hedge trim (1, $80.00)",80.00,0,80.00,0,0,0,0,No,
2005,Dana Ruiz,,,,,,,,,,Snow removal,2026-01-05,2026-01-05,2026-02-04,,,,,Bad debt,"Plow (1, $90.00)",90.00,0,90.00,0,0,0,0,No,
2006,Dana Ruiz,,,,,,,,,,Bundle,2026-10-15,2026-10-15,Nov 14 2026,,,,,Awaiting payment,"Bundle of things, see notes",99.99,0,99.99,0,0,0,0,No,`);

const ONE_OFF = csv(`Created date,Client name,Lead source,Title,Schedule start date,Closed date,Job #,Visits assigned to,Total revenue ($),Client email,Custom fields,Client phone,Line items,Billing street,Billing state/province,Billing city,Billing zip/postal code,Service street,Service city,Service state/province,Service zip/postal code,Invoice #s,Quote #,Quote discount ($),Online booking
2026-10-03,Mary Ann Smith,,Patio pavers,2026-11-10,,J60,Sam,"1,250.00",mary@example.com,,,"Pavers (50, $1000.00), Labor (1, $250.00)",,,,,12 Oak St,Roanoke,VA,24011,,101,0,No
2026-09-03,Acme Paving,,Striping,2026-09-10,2026-09-12,J61,,800.00,office@acme.test,,,"Striping (1, $800.00)",,,,,900 Industrial Rd,Salem,VA,24153,I2002,,0,No
2026-10-20,Dana Ruiz,,Fence fix,,,J62,,300.00,,,,Custom work,,,,,55 Birch Ln,Vinton,VA,24179,,,0,No`);

const RECURRING = csv(`Job #,Job title,Client name,Client email,Client phone number,Service street,Service city,Service state/province,Service zip/postal code,Billing street,Billing state/province,Billing city,Billing zip/postal code,Billing type,Automatic invoicing,Visits assigned to,Line items,Total ($),Completed visits,Number of invoices,Schedule start date,Schedule end date,Custom fields
J50,Weekly mowing,Mary Ann Smith,mary@example.com,,12 Oak St,Roanoke,VA,24011,,,,,Per visit,Enabled,Sam,"Mowing (1, $45.00)",2340.00,20,5,2026-03-02,2026-11-30,
J70,Biweekly pool,Dana Ruiz,,,77 Pine Ave,Vinton,VA,24179,,,,,Fixed price,Disabled,,"Pool service (1, $1200.00)",1200.00,4,1,2026-05-05,,
J71,Monthly pest,Lee Park,lee@example.com,,4 Elm Ct,Roanoke,VA,24012,,,,,Per visit,Enabled,,"Pest control (1, $60.00)",720.00,9,9,2026-01-15,,
J72,Odd one,Lee Park,lee@example.com,,4 Elm Ct,Roanoke,VA,24012,,,,,Per visit,Enabled,,Stuff,100.00,1,1,2026-01-15,,
J73,Last summer,Lee Park,lee@example.com,,4 Elm Ct,Roanoke,VA,24012,,,,,Per visit,Enabled,,,0,10,10,2025-05-01,2025-09-30,`);

const VISITS = csv(`Job #,Date,Visit title,Client name,Client email,Client phone,Service street,Service city,Service state/province,Service ZIP/postal code,Visit completed,Assigned to,Line items,One-off job ($),Visit based ($),Scheduled duration,Time tracked,Job type,Custom fields
J70,2026-10-06,Pool,Dana Ruiz,,,77 Pine Ave,Vinton,VA,24179,Yes,,,,,1.5,01:30,Recurring,
J70,2026-10-20,Pool,Dana Ruiz,,,77 Pine Ave,Vinton,VA,24179,Yes,,,,,1.5,01:25,Recurring,
J70,2026-11-03,Pool,Dana Ruiz,,,77 Pine Ave,Vinton,VA,24179,No,,,,,1.5,,Recurring,
J70,2026-11-17,Pool,Dana Ruiz,,,77 Pine Ave,Vinton,VA,24179,No,,,,,1.5,,Recurring,
J71,2026-09-15,Pest,Lee Park,lee@example.com,,4 Elm Ct,Roanoke,VA,24012,Yes,,,,,0.5,,Recurring,
J71,2026-10-15,Pest,Lee Park,lee@example.com,,4 Elm Ct,Roanoke,VA,24012,Yes,,,,,0.5,,Recurring,
J71,2026-11-16,Pest,Lee Park,lee@example.com,,4 Elm Ct,Roanoke,VA,24012,No,,,,,0.5,,Recurring,
J72,2026-10-01,Odd,Lee Park,lee@example.com,,4 Elm Ct,Roanoke,VA,24012,No,,,,,1,,Recurring,`);

const TODAY = "2026-11-03";

describe("which Jobber export a file is", () => {
  it("knows each report by its headers, whatever their case and spacing", () => {
    expect(jobberFileKind(QUOTES[0])).toBe("quotes");
    expect(jobberFileKind(INVOICES[0])).toBe("invoices");
    expect(jobberFileKind(ONE_OFF[0])).toBe("one_off_jobs");
    expect(jobberFileKind(RECURRING[0])).toBe("recurring_jobs");
    expect(jobberFileKind(VISITS[0])).toBe("visits");
    expect(jobberFileKind(["J-ID", "Display Name", "E-mails"])).toBe("clients");
    expect(jobberFileKind(["QUOTE  #", "client NAME", "STATUS"])).toBe("quotes");
    expect(jobberFileKind(["Name", "Price"])).toBeNull();
  });

  it("reads dates the ways Jobber writes them", () => {
    expect(["2026-10-03", "Oct 3, 2026", "October 3 2026", "3 Oct 2026", "10/03/2026", "2026-10-03 14:30"].map(jobberDate)).toEqual(Array(6).fill("2026-10-03"));
    expect(jobberDate("25/12/2026")).toBe("2026-12-25");
    expect(jobberDate("Feb 30, 2026")).toBeNull();
    expect(jobberDate("soon")).toBeNull();
  });
});

describe("line items and totals", () => {
  it("reads Name (quantity, $total) items", () => {
    expect(jobberLineItems("Mulch install (3, $180.00), Edging (1, $45.00)")).toEqual([
      { name: "Mulch install", description: null, quantity: 3, unit_price: 60, taxable: false },
      { name: "Edging", description: null, quantity: 1, unit_price: 45, taxable: false },
    ]);
    expect(jobberLineItems("Mow, edge and blow (1, $1,050.50)\nHaul away (2, $40)")?.map((l) => [l.name, l.quantity, l.unit_price])).toEqual([["Mow, edge and blow", 1, 1050.5], ["Haul away", 2, 20]]);
    // A total that doesn't divide into cents keeps the total, as one of them.
    expect(jobberLineItems("Bags (3, $10.00)")).toEqual([{ name: "Bags", description: "Quantity 3", quantity: 1, unit_price: 10, taxable: false }]);
    expect(jobberLineItems("Custom work")).toBeNull();
    expect(jobberLineItems("Gutters (1, $150.00) and more")).toBeNull();
  });

  it("works out the tax so the total matches Jobber's to the cent", () => {
    const lines = jobberLineItems("Weekly mowing (4, $180.00), Trimming (1, $20.00)");
    expect(fitJobberTotal(lines, { total: 214, taxPercent: 7, name: "x" })).toMatchObject({ tax_rate: 0.07, discount_amount: 0, itemized: true, lines: [{ taxable: true }, { taxable: true }] });
    // No tax column: the rate the total implies.
    expect(fitJobberTotal(jobberLineItems("Mulch install (3, $180.00), Edging (1, $45.00)"), { total: 243, subtotal: 225, name: "x" }).tax_rate).toBe(0.08);
    // Only some lines were taxed in Jobber: its tax as a line of its own.
    const some = fitJobberTotal(jobberLineItems("Crack fill (1, $500.00), Permit (1, $25.00)"), { total: 559, taxPercent: 8, taxAmount: 34, name: "x" });
    expect(some).toMatchObject({ tax_rate: 0, itemized: true });
    expect(some.lines.map((l) => [l.name, l.unit_price, l.taxable])).toEqual([["Crack fill", 500, false], ["Permit", 25, false], ["Tax", 34, false]]);
    // Lines that don't add up: one line of the total, saying what Jobber had.
    expect(fitJobberTotal(jobberLineItems("A (1, $10.00)"), { total: 99, name: "Bundle", text: "A (1, $10.00)" })).toEqual({
      lines: [{ name: "Bundle", description: "A (1, $10.00)", quantity: 1, unit_price: 99, taxable: false }], discount_amount: 0, tax_rate: 0, itemized: false,
    });
    // A quote's total before its discount.
    expect(fitJobberTotal(jobberLineItems("Leaf removal (2, $200.00)"), { total: 200, subtotal: 200, discount: 20, name: "x" })).toMatchObject({ discount_amount: 20, tax_rate: 0, itemized: true });
  });
});

describe("schedules", () => {
  it("reads how Jobber says a job repeats", () => {
    const tuesday = "2026-05-05";
    expect(jobberRepeatRule("Weekly", tuesday)).toBe("FREQ=WEEKLY;INTERVAL=1;BYDAY=TU");
    expect(jobberRepeatRule("Every two weeks", tuesday)).toBe("FREQ=WEEKLY;INTERVAL=2;BYDAY=TU");
    expect(jobberRepeatRule("BiWeekly", tuesday)).toBe("FREQ=WEEKLY;INTERVAL=2;BYDAY=TU");
    expect(jobberRepeatRule("Every 2 weeks on Monday and Thursday", tuesday)).toBe("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH");
    expect(jobberRepeatRule("Monthly", tuesday)).toBe("FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=5");
    expect(jobberRepeatRule("Monthly on the 15th", tuesday)).toBe("FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=15");
    expect(jobberRepeatRule("Every 3 months", tuesday)).toBe("FREQ=MONTHLY;INTERVAL=3;BYMONTHDAY=5");
    expect(jobberRepeatRule("Yearly", tuesday)).toBe("FREQ=YEARLY;INTERVAL=1");
    expect(jobberRepeatRule("Monthly", "2026-05-31")).toBeNull();
    expect(jobberRepeatRule("As needed", tuesday)).toBeNull();
    expect(jobberRepeatRule("Custom", tuesday)).toBeNull();
  });

  it("works out a schedule from visit dates only when they follow one exactly", () => {
    expect(ruleFromVisits(["2026-10-20", "2026-10-06", "2026-11-03"])).toEqual({ rule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU", starts_on: "2026-10-06" });
    expect(ruleFromVisits(["2026-10-05", "2026-10-08", "2026-10-12", "2026-10-15"])).toEqual({ rule: "FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,TH", starts_on: "2026-10-05" });
    expect(ruleFromVisits(["2026-09-15", "2026-10-15", "2026-11-15"])).toEqual({ rule: "FREQ=MONTHLY;INTERVAL=1;BYMONTHDAY=15", starts_on: "2026-09-15" });
    // One moved a day, or too few to tell.
    expect(ruleFromVisits(["2026-09-15", "2026-10-15", "2026-11-16"])).toBeNull();
    expect(ruleFromVisits(["2026-10-06", "2026-10-13"])).toBeNull();
  });
});

describe("Jobber's quotes report", () => {
  const read = readJobberQuotes(QUOTES);

  it("brings in the open quotes, with their lines, and leaves out the rest", () => {
    expect(read.records.map((q) => [q.number, q.status])).toEqual([["101", "sent"], ["102", "approved"], ["104", "draft"], ["105", "changes_requested"]]);
    expect(read.left_out).toEqual({ Converted: 1, Archived: 1 });
    expect(read.problems).toEqual([]);
    const [mulch, , leaves] = read.records;
    expect(mulch).toMatchObject({
      source_id: "jobber:101", title: "Spring cleanup", tax_rate: 0.08, deposit_amount: 50, created_on: "2026-10-01", sent_on: "2026-10-02", one_line: false,
      client: { name: "Mary Ann Smith", email: "mary@example.com", street: "12 Oak St", city: "Roanoke" },
    });
    expect(mulch.lines.map((l) => [l.name, l.quantity, l.unit_price])).toEqual([["Mulch install", 3, 60], ["Edging", 1, 45]]);
    expect(leaves).toMatchObject({ discount_amount: 20, tax_rate: 0 });
  });

  it("says what the office should know, and imports what it can't read as one line", () => {
    const sealcoat = read.records[1];
    // "(1; $2400.00)" isn't how lines are written: the subtotal comes in as one line.
    expect(sealcoat).toMatchObject({ approved_on: "2026-09-20", one_line: true, lines: [{ name: "Lot sealcoat", unit_price: 2400 }] });
    expect(sealcoat.notes).toContain("Jobber collected a $600.00 deposit on it: take it off the invoice.");
  });

  it("reports rows it can't bring in", () => {
    const bad = readJobberQuotes(csv(`Quote #,Client name,Status\n,Ann,Draft\n7,Ann,Pondering\n8,,Draft\n9,Ann,Draft\n9,Ann,Draft`));
    expect(bad.records.map((q) => q.number)).toEqual(["9"]);
    expect(bad.problems.map((p) => [p.row, p.reason])).toEqual([
      [1, "No number, so it can't be told from the others."],
      [2, `Its status "Pondering" isn't one of Jobber's.`],
      [3, "No client name or email."],
      [5, "It's in the file twice: the first one comes in."],
    ]);
  });
});

describe("Jobber's invoices report", () => {
  const read = readJobberInvoices(INVOICES, TODAY);

  it("brings in what's sent and unpaid, with what's been paid of it", () => {
    expect(read.records.map((i) => [i.number, i.total, i.paid])).toEqual([["2001", 214, 100], ["2002", 559, 0], ["2006", 99.99, 0]]);
    expect(read.left_out).toEqual({ Paid: 1, Draft: 1, "Bad debt": 1 });
    expect(read.records[0]).toMatchObject({ source_id: "jobber:2001", subject: "For services rendered", issued_on: "2026-10-01", due_on: "2026-10-31", tax_rate: 0.07, one_line: false });
    expect(read.records[2]).toMatchObject({ due_on: "2026-11-14", one_line: true, lines: [{ name: "Bundle", description: "Bundle of things, see notes", unit_price: 99.99 }] });
  });

  it("an invoice with no due date is due when it was issued", () => {
    const [one] = readJobberInvoices(csv(`Invoice #,Client name,Issued date,Status,Total ($),Balance ($)\n9,Ann,2026-10-01,Awaiting payment,50,50`), TODAY).records;
    expect(one).toMatchObject({ issued_on: "2026-10-01", due_on: "2026-10-01", lines: [{ name: "Invoice #9 from Jobber", unit_price: 50 }] });
    expect(one.notes).toContain("No due date in the file: it's due the day it was issued.");
  });

  it("knows the job an invoice is for when it names one, and says so when it names several", () => {
    expect(read.records.map((i) => [i.number, i.job_number])).toEqual([["2001", "J50"], ["2002", "J51"], ["2006", null]]);
    const [both] = readJobberInvoices(csv(`Invoice #,Client name,Job #s,Status,Total ($),Balance ($)\n9,Ann,"#J7, #J8",Awaiting payment,50,50`), TODAY).records;
    expect(both.job_number).toBeNull();
    expect(both.notes).toContain("It's for Jobber jobs #J7, #J8, and an invoice here is for one job: it came in without one.");
  });
});

describe("Jobber's jobs reports", () => {
  it("brings in the one-off jobs not closed", () => {
    const read = readJobberJobs(ONE_OFF, "one_off", TODAY);
    expect(read.records.map((j) => [j.number, j.title, j.kind, j.recurrence_rule])).toEqual([["J60", "Patio pavers", "one_off", null], ["J62", "Fence fix", "one_off", null]]);
    expect(read.left_out).toEqual({ Closed: 1 });
    expect(read.records[0].lines.map((l) => [l.name, l.quantity, l.unit_price, l.taxable])).toEqual([["Pavers", 50, 20, true], ["Labor", 1, 250, true]]);
    expect(read.records[1]).toMatchObject({ one_line: true, lines: [{ name: "Fence fix", unit_price: 300, description: "Custom work" }] });
    // Its schedule start date is to come: a visit that day. No date, no visit.
    expect(read.records.map((j) => j.visit_dates)).toEqual([["2026-11-10"], []]);
  });

  it("gives a one-off job its visits still to do, from the visits report or its start date", () => {
    const visits = readJobberVisits(csv(`Job #,Date,Visit completed\nJ90,2026-10-28,Yes\nJ90,2026-11-12,No\nJ90,2026-11-05,No\nJ90,2026-11-05,No`));
    const read = readJobberJobs(
      csv(`Job #,Client name,Title,Status,Schedule start date\nJ90,Ann,Deck build,Upcoming,2026-10-28\nJ91,Ann,Late one,Late,2026-10-20\nJ92,Ann,Gone by,Active,2026-10-21\nJ93,Ann,Done,Requires invoicing,2026-10-22`),
      "one_off", TODAY, visits,
    );
    expect(read.records.map((j) => [j.number, j.visit_dates])).toEqual([["J90", ["2026-11-05", "2026-11-12"]], ["J91", ["2026-10-20"]], ["J92", []], ["J93", []]]);
    // A day gone by that Jobber doesn't call late may have had its visit: the office says.
    expect(read.records[2].notes).toContain("Jobber had it scheduled for 2026-10-21: schedule its visit if the work's still to do.");
    expect(read.records[3].notes).toEqual([]);
    // A recurring job's visits come from its schedule.
    expect(readJobberJobs(RECURRING, "recurring", TODAY, readJobberVisits(VISITS)).records.every((j) => j.visit_dates.length === 0)).toBe(true);
  });

  it("gives recurring jobs the schedule their visits follow, and says which need one", () => {
    const read = readJobberJobs(RECURRING, "recurring", TODAY, readJobberVisits(VISITS));
    expect(read.left_out).toEqual({ Ended: 1 });
    const byNumber = Object.fromEntries(read.records.map((j) => [j.number, j]));
    // No Repeating column and no visits in the file: the office sets it.
    expect(byNumber.J50).toMatchObject({ needs_schedule: true, recurrence_rule: null, starts_on: "2026-03-02", ends_on: "2026-11-30", pricing: "per_visit" });
    expect(byNumber.J70).toMatchObject({ needs_schedule: false, recurrence_rule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=TU", starts_on: "2026-10-06", pricing: "fixed", visit_duration_min: 90 });
    // A visit moved a day: no rule fits exactly.
    expect(byNumber.J71).toMatchObject({ needs_schedule: true, recurrence_rule: null });
    expect(byNumber.J72).toMatchObject({ needs_schedule: true, lines: [] });
    expect(byNumber.J72.notes).toContain("Its line items couldn't be read: add them to the job.");
    // A per-visit job keeps its own lines, not the total of all its visits.
    expect(byNumber.J50.lines).toEqual([{ name: "Mowing", description: null, quantity: 1, unit_price: 45, taxable: true }]);
  });

  it("goes by the visits still to come when there are enough of them", () => {
    const visits = readJobberVisits(csv(`Job #,Date,Visit completed\nJ80,2026-09-02,Yes\nJ80,2026-11-10,No\nJ80,2026-11-17,No\nJ80,2026-11-24,No`));
    const [job] = readJobberJobs(csv(`Job #,Job title,Client name,Billing type\nJ80,Weekly clean,Ann,Per visit`), "recurring", TODAY, visits).records;
    expect(job).toMatchObject({ recurrence_rule: "FREQ=WEEKLY;INTERVAL=1;BYDAY=TU", starts_on: "2026-11-10", needs_schedule: false });
  });

  it("reads a Repeating column when the file has one", () => {
    const read = readJobberJobs(csv(`Job #,Job title,Client name,Billing type,Schedule start date,Repeating\nJ9,Mowing,Ann,Per visit,2026-05-04,Weekly\nJ10,Cleanup,Ann,Per visit,2026-05-04,As needed`), "recurring", TODAY);
    expect(read.records.map((j) => [j.number, j.recurrence_rule, j.needs_schedule])).toEqual([["J9", "FREQ=WEEKLY;INTERVAL=1;BYDAY=MO", false], ["J10", null, true]]);
  });
});

describe("finding each row's client", () => {
  const clients = [
    { id: "c1", display_name: "Mary Ann Smith", email: "Mary@Example.com" },
    { id: "c2", display_name: "Lee Park", email: null },
    { id: "c3", display_name: "Lee Park", email: null },
    { id: "c4", display_name: "Acme Paving", email: null },
  ];
  const properties = [
    { id: "p1", client_id: "c1", line1: "12 Oak Street", city: "Roanoke" },
    { id: "p2", client_id: "c2", line1: "4 Elm Ct", city: "Roanoke" },
    { id: "p3", client_id: "c3", line1: "9 Ash Rd", city: "Salem" },
    { id: "p4", client_id: "c4", line1: "1 Main St", city: "Salem" },
  ];
  const ref = (name: string, email: string | null, street: string | null) => ({ name, email, street, city: null, region: null, postal_code: null });

  it("by email, then name, then street, with the property at that street", () => {
    expect(findJobberClient(ref("M. Smith", "mary@example.com", "12 Oak St"), clients, properties)).toEqual({ client_id: "c1", property_id: "p1", new_property: null });
    expect(findJobberClient(ref("Lee Park", null, "4 Elm Ct"), clients, properties)).toEqual({ client_id: "c2", property_id: "p2", new_property: null });
    // A street they don't have yet becomes a new property; with no street, their only one.
    expect(findJobberClient(ref("acme paving", null, "900 Industrial Rd"), clients, properties)).toMatchObject({ client_id: "c4", property_id: null, new_property: { line1: "900 Industrial Rd" } });
    expect(findJobberClient(ref("Acme Paving", null, null), clients, properties)).toEqual({ client_id: "c4", property_id: "p4", new_property: null });
  });

  it("says when the client isn't here yet, or can't be told apart", () => {
    expect(findJobberClient(ref("Dana Ruiz", null, null), clients, properties)).toEqual({ problem: "Dana Ruiz isn't a client here yet.", missing: true });
    expect(findJobberClient(ref("Lee Park", null, "1 Nowhere Rd"), clients, properties)).toEqual({ problem: "2 clients here could be Lee Park, and none is the one at its street.", missing: false });
  });
});

describe("the whole import", () => {
  const clients = [
    { id: "c1", display_name: "Mary Ann Smith", email: "mary@example.com" },
    { id: "c2", display_name: "Acme Paving", email: "office@acme.test" },
    { id: "c3", display_name: "Lee Park", email: "lee@example.com" },
  ];
  const properties = [{ id: "p1", client_id: "c1", line1: "12 Oak Street", city: "Roanoke" }];
  const files = { quotes: QUOTES, invoices: INVOICES, one_off_jobs: ONE_OFF, recurring_jobs: RECURRING, visits: VISITS };

  it("finds each open record's client, leaves out what's been brought in, and counts who's missing", () => {
    const plan = planJobberImport(files, { clients, properties, imported: { quotes: new Set(["jobber:101"]), invoices: new Set(), jobs: new Set() }, today: TODAY });
    expect(plan.quotes.already).toBe(1);
    expect(plan.quotes.ready.map((r) => [r.record.number, r.found.client_id])).toEqual([["102", "c2"], ["104", "c3"]]);
    // Dana isn't a client here: her quote waits for the clients file.
    expect(plan.quotes.problems).toEqual([{ row: 5, number: "105", reason: "Dana Ruiz isn't a client here yet." }]);
    expect(plan.quotes.missing_clients).toBe(1);
    expect(plan.invoices.ready.map((r) => r.record.number)).toEqual(["2001", "2002"]);
    expect(plan.invoices.missing_clients).toBe(1);
    // Recurring and one-off jobs are one list; Mary's job is at her property, Acme's at a new one.
    expect(plan.jobs.ready.map((r) => [r.record.number, r.record.kind])).toEqual([["J50", "recurring"], ["J71", "recurring"], ["J72", "recurring"], ["J60", "one_off"]]);
    expect(plan.jobs.ready[0].found).toEqual({ client_id: "c1", property_id: "p1", new_property: null });
    expect(plan.jobs.left_out).toEqual({ Closed: 1, Ended: 1 });
  });

  it("hands import_jobber each record in its shape", () => {
    const plan = planJobberImport(files, { clients, properties, imported: { quotes: new Set(), invoices: new Set(), jobs: new Set() }, today: TODAY });
    const invoice = plan.invoices.ready[0];
    expect(jobberImportRow("invoices", invoice.record, "c1", null)).toEqual({
      source_id: "jobber:2001", number: "2001", client_id: "c1", created_on: "2026-10-01", subject: "For services rendered", issued_on: "2026-10-01", due_on: "2026-10-31",
      discount_amount: 0, tax_rate: 0.07, total: 214, paid: 100, lines: invoice.record.lines, job_source_id: "jobber:J50",
    });
    const job = plan.jobs.ready.find((r) => r.record.number === "J60")!;
    expect(jobberImportRow("jobs", job.record, "c1", "p1")).toMatchObject({ source_id: "jobber:J60", property_id: "p1", kind: "one_off", recurrence_rule: null, title: "Patio pavers", visit_dates: ["2026-11-10"] });
    expect(jobberImportRow("quotes", plan.quotes.ready[0].record, "c1", "p1")).toMatchObject({ source_id: "jobber:101", status: "sent", tax_rate: 0.08, sent_on: "2026-10-02" });
  });
});
