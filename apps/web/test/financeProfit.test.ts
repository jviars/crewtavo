/**
 * Finance → Profit (features/finance/jobCosts.ts) with more jobs than it used to cost: time,
 * expenses, pay rates and sub and crew pay were read for the first 300 jobs only, so every job
 * after them looked as if it had cost nothing. Against the database of fakeDb.ts, which also sends
 * 1,000 rows a request at most.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FakeDb, type Row } from "./fakeDb";

const state = vi.hoisted(() => ({ db: null as unknown, rateCalls: [] as string[][] }));
vi.mock("../src/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/api")>()),
  // POST /time/rates: $20 an hour for every entry on the jobs asked about, 300 jobs at most.
  api: {
    post: async (path: string, body: { job_ids: string[] }) => {
      expect(path).toBe("/time/rates");
      expect(body.job_ids.length).toBeLessThanOrEqual(300);
      state.rateCalls.push(body.job_ids);
      const jobs = new Set(body.job_ids);
      return Object.fromEntries((state.db as FakeDb).tables.time_entries!.filter((t) => jobs.has(t.job_id as string)).map((t) => [t.id, 20]));
    },
  },
  supabase: () => state.db,
}));
const { byJobs, JOBS_AT_ONCE, loadProfit } = await import("../src/features/finance/jobCosts");

const COMPANY = "c1";
const RANGE = { start: "2026-10-01T04:00:00.000Z", end: "2026-11-01T04:00:00.000Z" };
const JOBS = 1250;
const job = (n: number) => `job-${String(n).padStart(4, "0")}`;

/** 1,250 jobs of $1,000 finished in October, each with two hours of time ($40), a $10 expense and $50 of sub pay: $900 profit. */
function october(): Record<string, Row[]> {
  const jobs = Array.from({ length: JOBS }, (_, i) => ({
    id: job(i), company_id: COMPANY, number: i + 1, title: `Job ${i + 1}`, status: i % 2 ? "completed" : "requires_invoicing", updated_at: "2026-10-15T12:00:00.000Z",
    financials: { contract_total: 1000 }, client: { display_name: `Client ${i}` }, lines: [],
  }));
  return {
    jobs: [...jobs, { ...jobs[0]!, id: "still-going", status: "active" }, { ...jobs[0]!, id: "september", updated_at: "2026-09-30T12:00:00.000Z" }],
    companies: [{ id: COMPANY, settings: { margin_target: 30 } }],
    time_entries: jobs.flatMap((j, i) => [0, 1].map((k) => ({ id: `t-${i}-${k}`, job_id: j.id, started_at: "2026-10-14T13:00:00.000Z", ended_at: "2026-10-14T14:00:00.000Z" }))),
    expenses: jobs.map((j, i) => ({ id: `x-${i}`, job_id: j.id, amount: 10 })),
  };
}

let db: FakeDb;
beforeEach(() => {
  db = new FakeDb(october(), { job_pay_costs: ({ p_jobs }: { p_jobs: string[] }) => p_jobs.map((id) => ({ job_id: id, amount: 50, payees: 1 })) });
  // The one company's settings, as `.single()` gives them.
  const from = db.from.bind(db);
  db.from = (table: string) => (table === "companies" ? ({ select: () => ({ eq: () => ({ single: async () => ({ data: db.tables.companies![0], error: null }) }) }) } as never) : from(table));
  state.db = db;
  state.rateCalls = [];
});

describe("Finance → Profit with 1,250 completed jobs", () => {
  it("costs every job, not the first 300", async () => {
    const { jobs, target } = await loadProfit({ companyId: COMPANY, range: RANGE, costs: true });
    expect(target).toBe(30);
    expect(jobs).toHaveLength(JOBS);
    // Each job: $40 of labor, $50 of sub pay and a $10 expense against $1,000.
    for (const j of [jobs.find((x) => x.id === job(0))!, jobs.find((x) => x.id === job(300))!, jobs.find((x) => x.id === job(1249))!]) {
      expect(j).toMatchObject({ revenue: 1000, labor: 40, crew_pay: 50, expenses: 10, cost: 100, profit: 900, margin: 90 });
    }
    expect(jobs.filter((j) => j.cost !== 100)).toEqual([]);
    expect(jobs.reduce((s, j) => s + j.profit, 0)).toBe(JOBS * 900);
    // As it was, the 950 jobs after the first 300 cost nothing: $1,220,000 of profit shown, not $1,125,000.
    expect(jobs.reduce((s, j) => s + j.profit, 0)).toBe(1_125_000);
  });

  it("asks about the jobs 200 at a time, and reads all the time on each lot", async () => {
    await loadProfit({ companyId: COMPANY, range: RANGE, costs: true });
    expect(JOBS_AT_ONCE).toBe(200);
    expect(state.rateCalls.map((ids) => ids.length).sort((a, b) => b - a)).toEqual([200, 200, 200, 200, 200, 200, 50]);
    expect(new Set(state.rateCalls.flat()).size).toBe(JOBS);
    expect(db.calls.filter((c) => c.name === "job_pay_costs").map((c) => (c.args.p_jobs as string[]).length).sort((a, b) => b - a)).toEqual([200, 200, 200, 200, 200, 200, 50]);
    // The jobs themselves are more than one request brings.
    expect(db.requests.filter((r) => r.table === "jobs").map((r) => [r.order, r.sent])).toEqual([["id.asc", 1000], ["id.asc", 250]]);
    expect(db.requests.filter((r) => r.table === "time_entries").reduce((n, r) => n + r.sent, 0)).toBe(JOBS * 2);
    expect(db.requests.every((r) => r.order.endsWith("id.asc"))).toBe(true);
  });

  it("reads no pay rates or sub pay for someone without job costs", async () => {
    const { jobs } = await loadProfit({ companyId: COMPANY, range: RANGE, costs: false });
    expect(jobs).toHaveLength(JOBS);
    expect(state.rateCalls).toEqual([]);
    expect(db.calls).toEqual([]);
    expect(jobs.every((j) => j.labor === 0 && j.crew_pay === 0 && j.expenses === 10)).toBe(true);
  });

  it("asks nothing more when no job was finished", async () => {
    const { jobs } = await loadProfit({ companyId: COMPANY, range: { start: "2025-01-01T05:00:00.000Z", end: "2025-02-01T05:00:00.000Z" }, costs: true });
    expect(jobs).toEqual([]);
    expect(db.requests.map((r) => r.table)).toEqual(["jobs"]);
    expect(state.rateCalls).toEqual([]);
  });
});

describe("reading for many jobs", () => {
  it("puts the lots together in order", async () => {
    const ids = Array.from({ length: 450 }, (_, i) => job(i));
    const lots: number[] = [];
    const found = await byJobs(ids, async (jobs) => {
      lots.push(jobs.length);
      return jobs;
    });
    expect(lots).toEqual([200, 200, 50]);
    expect(found).toEqual(ids);
    expect(await byJobs([], async () => ["never asked"])).toEqual([]);
  });
});
