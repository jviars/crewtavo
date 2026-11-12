/**
 * The Invoices tiles, Deposits' Stripe fees, the jobs ready to invoice (features/invoices/totals.ts)
 * and subs' pay (features/subs/payData.ts) against an API that hands over 1,000 rows a request at
 * most, as the real one does: sums come from the database's own functions, and lists are read to
 * their end. Before, each read asked for 2,000 or 5,000 rows, got 1,000, and worked from those.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const CAP = 1000;
type Row = Record<string, unknown>;
type Answer = { rows?: Row[]; value?: unknown; error?: { message: string; code?: string } };
const state = vi.hoisted(() => ({
  /** What each table and function holds, by name. */
  answers: {} as Record<string, Answer>,
  /** Every read made: its table or function, the function's arguments, and what was chained on. */
  reads: [] as Array<{ name: string; args?: Row; calls: Array<[string, ...unknown[]]> }>,
}));

/** A read as supabase-js builds one: every filter chains, and awaiting it answers with at most CAP rows of the range asked for. */
function read(name: string, args?: Row) {
  const entry = { name, args, calls: [] as Array<[string, ...unknown[]]> };
  state.reads.push(entry);
  const answer = (): { data: unknown; error: Answer["error"] | null; count: number | null } => {
    const a = state.answers[name] ?? { error: { message: `Could not find ${name} in the schema cache`, code: "PGRST202" } };
    if (a.error) return { data: null, error: a.error, count: null };
    if (!a.rows) return { data: a.value, error: null, count: null };
    const range = entry.calls.find((c) => c[0] === "range") as [string, number, number] | undefined;
    const from = range?.[1] ?? 0;
    const rows = a.rows.slice(from, Math.min(from + CAP, (range?.[2] ?? Infinity) + 1));
    return { data: entry.calls.some((c) => c[0] === "single") ? rows[0] : rows, error: null, count: a.rows.length };
  };
  const builder: Record<string, unknown> = { then: (done: (r: unknown) => unknown, failed?: (e: unknown) => unknown) => Promise.resolve(answer()).then(done, failed) };
  for (const method of ["select", "eq", "in", "is", "not", "order", "limit", "range", "single"]) {
    builder[method] = (...params: unknown[]) => {
      entry.calls.push([method, ...params]);
      return builder;
    };
  }
  return builder;
}

vi.mock("../src/lib/api", () => ({
  api: {},
  unwrap: (r: { data: unknown; error: unknown }) => {
    if (r.error) throw r.error;
    return r.data;
  },
  supabase: () => ({ from: (table: string) => read(table), rpc: (fn: string, args: Row) => read(fn, args) }),
}));
vi.mock("../src/lib/session", () => ({ can: () => true, hasRole: () => true }));
const { invoiceTotals, readyJobs, stripeFeesSince } = await import("../src/features/invoices/totals");
const { owedPay, teamRateCounts } = await import("../src/features/subs/payData");

const job = (n: number, more: Row = {}) => ({ id: `job-${n}`, number: n, title: `Job ${n}`, kind: "recurring", billing_mode: "per_visit", pricing: "per_visit", client: null, financials: null, ...more });
const readsOf = (name: string) => state.reads.filter((r) => r.name === name);

beforeEach(() => {
  state.answers = {};
  state.reads = [];
});

describe("the Invoices tiles", () => {
  it("are the database's sums for the company's today, not rows added up here", async () => {
    state.answers.invoice_summary = { rows: [{ owed: 61250.5, owed_count: 1840, past_due: 9100.25, past_due_count: 212, collected: 48000, payments: 2600, owed_before: 58000, past_due_before: 7000.1, collected_before: 51000 }] };
    expect(await invoiceTotals("co", "2026-11-12")).toEqual({
      owed: 61250.5, owedCount: 1840, late: 9100.25, lateCount: 212, collected: 48000, payments: 2600,
      before: { owed: 58000, pastDue: 7000.1, collected: 51000 },
    });
    expect(state.reads.map((r) => [r.name, r.args])).toEqual([["invoice_summary", { p_company: "co", p_today: "2026-11-12" }]]);
  });

  it("fail, as the screen's reads always could, on a database that doesn't have the function yet", async () => {
    await expect(invoiceTotals("co", "2026-11-12")).rejects.toMatchObject({ code: "PGRST202" });
  });
});

describe("Deposits' Stripe fees", () => {
  it("are the database's sum since the start of that day", async () => {
    state.answers.stripe_fees = { value: 1475 };
    expect(await stripeFeesSince("co", "2026-10-13")).toBe(1475);
    expect(readsOf("stripe_fees")[0]!.args).toEqual({ p_company: "co", p_since: "2026-10-13T00:00:00" });
  });
});

describe("jobs ready to invoice", () => {
  it("lists every per-visit job with visits to bill, however many, without reading the visits", async () => {
    state.answers.jobs = { rows: [job(1, { kind: "one_off", billing_mode: "on_completion", pricing: null })] };
    state.answers.jobs_with_visits_to_invoice = { rows: Array.from({ length: 1200 }, (_, i) => job(i + 10)) };
    state.answers.autopay_charges = { rows: [] };
    state.answers.due_invoices = { rows: [] };
    const ready = await readyJobs("co");
    expect(ready).toHaveLength(1201);
    expect(new Set(ready.map((j) => j.id)).size).toBe(1201);
    expect(readsOf("visits")).toEqual([]);
    // Each page in an order that can't tie, so none repeats or goes missing between pages.
    for (const r of readsOf("jobs_with_visits_to_invoice")) expect(r.calls.filter((c) => c[0] === "order").map((c) => c[1])).toEqual(["number", "id"]);
    expect(readsOf("jobs_with_visits_to_invoice").map((r) => r.calls.find((c) => c[0] === "range")!.slice(1))).toEqual([[0, 999], [1000, 1999]]);
  });

  it("leaves out jobs autopay is about to bill, past the first 1,000 charges too, and gives a monthly job its months", async () => {
    state.answers.jobs = { rows: [job(1, { kind: "one_off", billing_mode: "on_completion" }), job(5, { billing_mode: "fixed_schedule", pricing: "fixed" })] };
    state.answers.jobs_with_visits_to_invoice = { rows: [job(2), job(3)] };
    // 1,100 charges waiting; the one for job 3 is the last of them.
    state.answers.autopay_charges = { rows: [...Array.from({ length: 1099 }, (_, i) => ({ job_id: `other-${i}` })), { job_id: "job-3" }] };
    state.answers.due_invoices = { rows: [{ job_id: "job-5", month: "2026-10-01" }, { job_id: "job-5", month: "2026-11-01" }] };
    const ready = await readyJobs("co");
    expect(ready.map((j) => j.id)).toContain("job-2");
    expect(ready.map((j) => j.id)).not.toContain("job-3");
    expect(ready.find((j) => j.months)?.months).toEqual(["2026-10-01", "2026-11-01"]);
  });

  it("carries on without autopay or monthly billing, but fails rather than list part of the jobs", async () => {
    state.answers.jobs = { rows: [job(1)] };
    state.answers.jobs_with_visits_to_invoice = { rows: [job(2)] };
    expect((await readyJobs("co")).map((j) => j.id)).toEqual(["job-1", "job-2"]);
    delete state.answers.jobs_with_visits_to_invoice;
    await expect(readyJobs("co")).rejects.toMatchObject({ code: "PGRST202" });
  });
});

describe("subs' and the team's pay", () => {
  it("counts every active rate, past the first 1,000", async () => {
    state.answers.pay_rates = { rows: Array.from({ length: 1300 }, (_, i) => ({ user_id: `u${i % 13}` })) };
    const counts = await teamRateCounts("co");
    expect(Object.keys(counts)).toHaveLength(13);
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(1300);
    expect(readsOf("pay_rates")).toHaveLength(2);
  });

  it("reads all the pay that's owed, oldest first, with the id to settle ties", async () => {
    state.answers.job_pay = { rows: Array.from({ length: 2100 }, (_, i) => ({ id: `p${i}`, total: 10 })) };
    const owed = await owedPay("co");
    expect(owed).toHaveLength(2100);
    expect(owed.reduce((sum, p) => sum + p.total, 0)).toBe(21000);
    expect(readsOf("job_pay")[0]!.calls.filter((c) => c[0] === "order").map((c) => c[1])).toEqual(["earned_on", "created_at", "id"]);
  });
});

describe("the database's Invoices tiles against the sums the screen used to do", () => {
  it("agree on the invoices and payments of supabase/tests/money_totals_test.sql (without its busy day)", async () => {
    const { receivablesTrend } = await import("../src/lib/trends");
    const tz = "America/Los_Angeles";
    // A to D and G as that test has them today, Nov 12: open ones with their balance, paid ones with none.
    const invoices = [
      { id: "a", issued_on: "2026-09-01", due_on: "2026-10-01", balance_due: 300 },
      { id: "b", issued_on: "2026-10-20", due_on: "2099-01-01", balance_due: 300 },
      { id: "c", issued_on: "2026-09-15", due_on: "2026-11-01", balance_due: 400 },
      { id: "d", issued_on: "2026-09-10", due_on: "2026-10-05", balance_due: 0 },
      { id: "g", issued_on: "2026-08-01", due_on: "2026-08-31", balance_due: 0 },
    ];
    // Los Angeles is 7 hours behind UTC until Nov 1, 2026, and 8 after.
    const payments = [
      { amount: 200, received_at: "2026-10-20T19:00:00Z", invoice_id: "a" },
      { amount: 250, received_at: "2026-10-25T19:00:00Z", invoice_id: "d" },
      { amount: 150, received_at: "2026-09-20T19:00:00Z", invoice_id: "g" },
      { amount: 1000, received_at: "2026-09-14T06:30:00Z" },
      { amount: 40, received_at: "2026-10-14T06:30:00Z" },
      { amount: 60, received_at: "2026-10-14T07:30:00Z" },
      { amount: -20, received_at: "2026-11-01T20:00:00Z" },
      { amount: 70, received_at: "2026-11-13T07:30:00Z" },
    ];
    const at = (day: string) => receivablesTrend({ invoices, payments, today: day, tz, weeks: 1 })[0]!;
    // invoice_summary gives 2060 collected with the busy day's 1,500, and 1150, 750 and 190 for 30 days ago.
    expect(at("2026-11-12").collected).toBe(2060 - 1500);
    expect(at("2026-10-13")).toMatchObject({ owed: 1150, pastDue: 750, collected: 190 });
  });
});
