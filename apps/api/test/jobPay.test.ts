/**
 * Job pay (routes/jobPay.ts, services/jobPay.ts) and piece pay in pay periods (services/pay.ts),
 * against a small stand-in for PostgREST: fetch is stubbed, tables live in memory, and the database's
 * functions answer what each test gives them. (What the functions themselves do, and who reaches
 * what in the database, is tested in supabase/tests/job_pay_test.sql.)
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import type { Env } from "../src/env";

const env: Env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7))),
  APP_URL: "https://ops.example.com",
};

const CO = "00000000-0000-4000-8000-0000000000a1";
const OWNER = "00000000-0000-4000-8000-000000000001";
const PAYROLL = "00000000-0000-4000-8000-000000000002"; // office, job costs without subs
const SUBS = "00000000-0000-4000-8000-000000000003"; // office, subs without job costs
const CREW = "00000000-0000-4000-8000-000000000004";
const AL = "00000000-0000-4000-8000-000000000005"; // Apex's sign-in
const DEE = "00000000-0000-4000-8000-000000000006";
const APEX = "00000000-0000-4000-8000-0000000000b1";
const JOB = "00000000-0000-4000-8000-0000000000c1";
const VISIT = "00000000-0000-4000-8000-0000000000d1";
const PAY = "00000000-0000-4000-8000-0000000000e1";
const DEE_PAY = "00000000-0000-4000-8000-0000000000e2";
const PAYROLL_ROLE = "00000000-0000-4000-8000-0000000000f1";
const SUBS_ROLE = "00000000-0000-4000-8000-0000000000f2";

const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const tokenFor = (sub: string) => `${part({ alg: "HS256", typ: "JWT" })}.${part({ sub, role: "authenticated", exp: Math.floor(Date.now() / 1000) + 600 })}.c2ln`;

type Row = Record<string, any>;
interface Call {
  method: string;
  path: string;
  url: URL;
  body: any;
}
interface World {
  tables: Record<string, Row[]>;
  /** The database's functions: what each answers (an { error } answers as PostgREST does). */
  rpc?: Record<string, (body: any) => unknown>;
}

/** One PostgREST condition (col=op.value) on a row. */
function test(row: Row, key: string, value: string): boolean {
  const [op, ...rest] = value.split(".");
  const arg = rest.join(".");
  const cell = row[key];
  switch (op) {
    case "eq":
      return String(cell) === arg;
    case "neq":
      return String(cell) !== arg;
    case "gte":
      return cell != null && String(cell) >= arg;
    case "lte":
      return cell != null && String(cell) <= arg;
    case "in":
      return arg.slice(1, -1).split(",").includes(String(cell));
    case "is":
      return arg === "null" ? cell == null : String(cell) === arg;
    case "not":
      return !test(row, key, arg);
    default:
      return true;
  }
}
/** Splits "a,b(c,d),e" at the top level. */
const topLevel = (s: string) => {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") depth--;
    else if (s[i] === "," && depth === 0) {
      out.push(s.slice(start, i));
      start = i + 1;
    }
  }
  return [...out, s.slice(start)];
};
/** or=(and(a.eq.x,b.gte.y),c.eq.z) */
function orMatches(row: Row, expr: string): boolean {
  return topLevel(expr.slice(1, -1)).some((term) => {
    const and = term.match(/^and\((.*)\)$/);
    const conds = and ? topLevel(and[1]!) : [term];
    return conds.every((c) => {
      const [key, ...value] = c.split(".");
      return test(row, key!, value.join("."));
    });
  });
}
const SKIP = new Set(["select", "order", "limit", "offset", "on_conflict", "columns"]);

function serve(world: World) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const headers = new Headers(init?.headers);
    const text = typeof init?.body === "string" ? init.body : "";
    const body = text ? JSON.parse(text) : undefined;
    const method = (init?.method ?? "GET").toUpperCase();
    const call: Call = { method, url, path: url.pathname.replace(/^\/rest\/v1\//, ""), body };
    calls.push(call);
    if (url.pathname === "/auth/v1/user") return Response.json({ id: "someone", aud: "authenticated", role: "authenticated" });
    if (!url.pathname.startsWith("/rest/v1/")) return Response.json([]);
    if (call.path.startsWith("rpc/")) {
      const answer = world.rpc?.[call.path.slice(4)]?.(body);
      if (answer && typeof answer === "object" && "error" in answer) return Response.json((answer as { error: unknown }).error, { status: 400 });
      return Response.json(answer ?? []);
    }
    const rows = (world.tables[call.path] ??= []);
    const filters = [...url.searchParams].filter(([k]) => !SKIP.has(k));
    const picked = rows.filter((r) => filters.every(([k, v]) => (k === "or" ? orMatches(r, v) : test(r, k, v))));
    const one = (headers.get("accept") ?? "").includes("vnd.pgrst.object");
    if (method === "POST") {
      const added = (Array.isArray(body) ? body : [body]).map((r: Row) => ({ id: crypto.randomUUID(), ...r }));
      rows.push(...added);
      return Response.json(one ? added[0] : added, { status: 201 });
    }
    if (method === "PATCH") {
      for (const r of picked) Object.assign(r, body);
      return Response.json(picked);
    }
    if (one) return picked.length ? Response.json(picked[0]) : Response.json({ code: "PGRST116", message: "no rows" }, { status: 406 });
    return Response.json(picked);
  });
  const rpcCalls = (name: string) => calls.filter((c) => c.path === `rpc/${name}`).map((c) => c.body);
  return { calls, rpcCalls };
}
afterEach(() => vi.unstubAllGlobals());

const pay = (extra: Row = {}): Row => ({
  id: PAY, company_id: CO, job_id: JOB, subcontractor_id: APEX, user_id: null, status: "draft", total: 2775, earned_on: null, paid_at: null, paid_amount: null,
  method: null, reference: null, paid_by: null, pay_period_id: null, notes: null, lines: [], visits: [], ...extra,
});
/** Oscar Roofing: Oz owns it, Pam does payroll (job costs, no subs), Sal handles subs (subs, no job costs), Cy and Dee are on the crew, Al signs in for Apex. */
const oscar = (tables: Record<string, Row[]> = {}): Record<string, Row[]> => ({
  companies: [{ id: CO, name: "Oscar Roofing", timezone: "America/New_York", settings: {} }],
  memberships: [
    { company_id: CO, user_id: OWNER, role: "owner", role_id: null, subcontractor_id: null, active: true, labor_rate: null },
    { company_id: CO, user_id: PAYROLL, role: "office", role_id: PAYROLL_ROLE, subcontractor_id: null, active: true, labor_rate: null },
    { company_id: CO, user_id: SUBS, role: "office", role_id: SUBS_ROLE, subcontractor_id: null, active: true, labor_rate: null },
    { company_id: CO, user_id: CREW, role: "field_crew", role_id: null, subcontractor_id: null, active: true, labor_rate: 20 },
    { company_id: CO, user_id: DEE, role: "field_crew", role_id: null, subcontractor_id: null, active: true, labor_rate: 25 },
    { company_id: CO, user_id: AL, role: "subcontractor", role_id: null, subcontractor_id: APEX, active: true, labor_rate: null },
  ],
  company_roles: [
    { id: PAYROLL_ROLE, company_id: CO, permissions: ["job_costs", "timesheets"] },
    { id: SUBS_ROLE, company_id: CO, permissions: ["subs", "schedule"] },
  ],
  profiles: [
    { user_id: CREW, full_name: "Cy Crew" },
    { user_id: DEE, full_name: "Dee Crew" },
  ],
  job_pay: [pay(), pay({ id: DEE_PAY, subcontractor_id: null, user_id: DEE, total: 100 })],
  ...tables,
});

const as = (who: string, path: string, init: { method?: string; body?: unknown } = {}) =>
  app.request(
    `/api${path}`,
    {
      method: init.method ?? "GET",
      headers: { Authorization: `Bearer ${tokenFor(who)}`, "X-Company-Id": CO, "Content-Type": "application/json" },
      ...(init.method && init.method !== "GET" ? { body: JSON.stringify(init.body ?? {}) } : {}),
    },
    env,
  );

describe("job pay routes", () => {
  it("are the office's: the crew and subs are refused every one", async () => {
    serve({ tables: oscar() });
    const routes: Array<[string, string, unknown?]> = [
      ["POST", "/job-pay/suggest", { job_id: JOB, subcontractor_id: APEX }],
      ["POST", "/job-pay", { job_id: JOB, subcontractor_id: APEX }],
      ["GET", `/job-pay/${PAY}`],
      ["POST", `/job-pay/${PAY}/accept`, {}],
      ["POST", `/job-pay/${PAY}/done`, {}],
      ["POST", `/job-pay/${PAY}/cancel`, {}],
      ["POST", "/job-pay/mark-paid", { ids: [PAY], method: "check" }],
      ["POST", "/job-pay/unmark-paid", { ids: [PAY] }],
      ["GET", "/subs/1099?year=2026"],
      ["GET", "/subs/1099/csv?year=2026"],
      ["GET", "/subs/workers-comp?from=2026-01-01&to=2026-12-31"],
      ["GET", "/subs/workers-comp/csv?from=2026-01-01&to=2026-12-31"],
    ];
    for (const who of [CREW, AL]) {
      for (const [method, path, body] of routes) expect((await as(who, path, { method, body })).status, `${method} ${path}`).toBe(403);
    }
  });

  it("need the subs area for a sub's pay and job costs for a team member's", async () => {
    const { rpcCalls } = serve({ tables: oscar(), rpc: { job_pay_suggest: () => [] } });
    const subPay = { job_id: JOB, subcontractor_id: APEX };
    const teamPay = { job_id: JOB, user_id: DEE };
    expect((await as(PAYROLL, "/job-pay/suggest", { method: "POST", body: subPay })).status).toBe(403);
    expect((await as(PAYROLL, "/job-pay/suggest", { method: "POST", body: teamPay })).status).toBe(200);
    expect((await as(SUBS, "/job-pay/suggest", { method: "POST", body: teamPay })).status).toBe(403);
    expect((await as(SUBS, "/job-pay/suggest", { method: "POST", body: subPay })).status).toBe(200);
    expect(rpcCalls("job_pay_suggest")).toHaveLength(2);
    // An existing pay: by whose it is.
    expect((await as(PAYROLL, `/job-pay/${PAY}/accept`, { method: "POST", body: {} })).status).toBe(403);
    expect((await as(SUBS, `/job-pay/${DEE_PAY}/cancel`, { method: "POST", body: {} })).status).toBe(403);
    // Marking paid and the reports are for subs' pay.
    expect((await as(PAYROLL, "/job-pay/mark-paid", { method: "POST", body: { ids: [PAY], method: "check" } })).status).toBe(403);
    expect((await as(PAYROLL, "/subs/1099?year=2026")).status).toBe(403);
    expect((await as(PAYROLL, "/subs/workers-comp?from=2026-01-01&to=2026-12-31")).status).toBe(403);
  });

  it("ask for one payee", async () => {
    serve({ tables: oscar() });
    const both = await as(OWNER, "/job-pay/suggest", { method: "POST", body: { job_id: JOB, subcontractor_id: APEX, user_id: DEE } });
    expect(both.status).toBe(400);
    expect(await both.json()).toEqual({ error: "Choose a sub or someone on your team." });
    expect((await as(OWNER, "/job-pay", { method: "POST", body: { job_id: JOB } })).status).toBe(400);
  });
});

describe("suggesting and starting pay", () => {
  const lines = [
    { pay_rate_id: "r1", description: "Architectural shingles", basis: "per_unit", unit: "sq", service_id: "s1", quantity: 27, rate: 75, amount: 2025, note: "27 squares of Architectural shingles on the job, change orders included.", check_it: false, sort: 1 },
    { pay_rate_id: "r2", description: "Day rate", basis: "per_day", unit: "day", service_id: null, quantity: 0, rate: 200, amount: 0, note: "Choose the visits it covers to count the days.", check_it: true, sort: 2 },
  ];

  it("suggests lines from the payee's rates, with the total and whether any needs a look", async () => {
    const { rpcCalls } = serve({ tables: oscar(), rpc: { job_pay_suggest: () => lines, job_pay_covers: () => [{ visit_ids: [VISIT], sign_ins: 1 }] } });
    const res = await as(OWNER, "/job-pay/suggest", { method: "POST", body: { job_id: JOB, subcontractor_id: APEX, visit_ids: [VISIT] } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ lines, total: 2025, check: true, visit_ids: [VISIT], sign_ins: 1 });
    expect(rpcCalls("job_pay_suggest")).toEqual([{ p_job: JOB, p_subcontractor: APEX, p_visits: [VISIT] }]);
  });

  it("says which visits the database covers unless others are chosen, and how many sign-ins a sub has", async () => {
    const { rpcCalls } = serve({ tables: oscar(), rpc: { job_pay_suggest: () => [], job_pay_covers: () => [{ visit_ids: [VISIT], sign_ins: null }] } });
    const res = await as(OWNER, "/job-pay/suggest", { method: "POST", body: { job_id: JOB, user_id: DEE } });
    expect(await res.json()).toEqual({ lines: [], total: 0, check: false, visit_ids: [VISIT], sign_ins: null });
    // Whatever visits are chosen, the default is asked for the payee alone.
    expect(rpcCalls("job_pay_covers")).toEqual([{ p_job: JOB, p_user: DEE }]);
    expect(rpcCalls("job_pay_suggest")).toEqual([{ p_job: JOB, p_user: DEE }]);
  });

  it("starts a draft with them, and answers with the pay", async () => {
    const world: World = { tables: oscar({ job_pay: [] }) };
    world.rpc = {
      job_pay_start: () => {
        world.tables.job_pay!.push(pay({ lines: [{ id: "l1", description: "Architectural shingles", amount: 2025 }] }));
        return PAY;
      },
    };
    const { rpcCalls } = serve(world);
    const res = await as(OWNER, "/job-pay", { method: "POST", body: { job_id: JOB, user_id: null, subcontractor_id: APEX } });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ id: PAY, status: "draft", total: 2775, lines: [{ description: "Architectural shingles" }] });
    expect(rpcCalls("job_pay_start")).toEqual([{ p_job: JOB, p_subcontractor: APEX }]);
  });

  it("says what the database says when they already have pay on the job", async () => {
    serve({ tables: oscar(), rpc: { job_pay_start: () => ({ error: { code: "22023", message: "They already have pay on this job. Open it to change it." } }) } });
    const res = await as(OWNER, "/job-pay", { method: "POST", body: { job_id: JOB, subcontractor_id: APEX } });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "They already have pay on this job. Open it to change it." });
  });
});

describe("moving pay along", () => {
  it("agrees it with the visits it covers, marks it done and cancels it", async () => {
    const world: World = { tables: oscar() };
    const set = (status: string, extra: Row = {}) => () => Object.assign(world.tables.job_pay![0]!, { status, ...extra });
    world.rpc = { job_pay_accept: set("accepted"), job_pay_mark_done: set("done", { earned_on: "2026-10-14" }), job_pay_cancel: set("cancelled") };
    const { rpcCalls } = serve(world);
    const accepted = await as(SUBS, `/job-pay/${PAY}/accept`, { method: "POST", body: { visit_ids: [VISIT] } });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ id: PAY, status: "accepted" });
    expect(rpcCalls("job_pay_accept")).toEqual([{ p_pay: PAY, p_visits: [VISIT] }]);
    expect(await (await as(SUBS, `/job-pay/${PAY}/done`, { method: "POST", body: { earned_on: "2026-10-14" } })).json()).toMatchObject({ status: "done", earned_on: "2026-10-14" });
    expect(rpcCalls("job_pay_mark_done")).toEqual([{ p_pay: PAY, p_earned_on: "2026-10-14" }]);
    expect(await (await as(SUBS, `/job-pay/${PAY}/cancel`, { method: "POST" })).json()).toMatchObject({ status: "cancelled" });
    expect(rpcCalls("job_pay_cancel")).toEqual([{ p_pay: PAY }]);
  });

  it("can't reach pay the person can't see", async () => {
    serve({ tables: oscar({ job_pay: [] }) });
    const res = await as(OWNER, `/job-pay/${PAY}/accept`, { method: "POST", body: {} });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "That pay wasn't found. It may have been deleted." });
  });

  it("checks the day the work was done", async () => {
    serve({ tables: oscar() });
    expect((await as(OWNER, `/job-pay/${PAY}/done`, { method: "POST", body: { earned_on: "Oct 14" } })).status).toBe(400);
  });
});

describe("marking subs paid", () => {
  it("marks one or several paid, how, on a day and with a reference", async () => {
    const paid = [pay({ status: "paid", paid_amount: 2775 }), pay({ id: "p2", status: "paid", paid_amount: 600 })];
    const { rpcCalls } = serve({ tables: oscar(), rpc: { job_pay_mark_paid: () => paid } });
    const res = await as(SUBS, "/job-pay/mark-paid", { method: "POST", body: { ids: [PAY, DEE_PAY], method: "check", paid_on: "2026-10-20", reference: " 1042 " } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ total: 3375, paid: [{ id: PAY }, { id: "p2" }] });
    expect(rpcCalls("job_pay_mark_paid")).toEqual([{ p_pays: [PAY, DEE_PAY], p_method: "check", p_paid_on: "2026-10-20", p_reference: "1042" }]);
  });

  it("gives one its own amount, and today unless a day is given", async () => {
    const { rpcCalls } = serve({ tables: oscar(), rpc: { job_pay_mark_paid: () => [pay({ status: "paid", paid_amount: 2700 })] } });
    expect((await as(SUBS, "/job-pay/mark-paid", { method: "POST", body: { ids: [PAY], method: "ach", amount: 2700 } })).status).toBe(200);
    expect(rpcCalls("job_pay_mark_paid")).toEqual([{ p_pays: [PAY], p_method: "ach", p_amount: 2700 }]);
  });

  it("refuses one amount for several, a way of paying it doesn't know, and says what the database says", async () => {
    serve({ tables: oscar(), rpc: { job_pay_mark_paid: () => ({ error: { code: "22023", message: "Pay for people on your team is paid with their pay period, under Timesheets → Pay." } }) } });
    const several = await as(SUBS, "/job-pay/mark-paid", { method: "POST", body: { ids: [PAY, DEE_PAY], method: "check", amount: 100 } });
    expect(several.status).toBe(400);
    expect(await several.json()).toEqual({ error: "Mark them paid one at a time to give each its own amount." });
    expect((await as(SUBS, "/job-pay/mark-paid", { method: "POST", body: { ids: [PAY], method: "venmo" } })).status).toBe(400);
    expect((await as(SUBS, "/job-pay/mark-paid", { method: "POST", body: { ids: [], method: "check" } })).status).toBe(400);
    const team = await as(SUBS, "/job-pay/mark-paid", { method: "POST", body: { ids: [DEE_PAY], method: "check" } });
    expect(team.status).toBe(400);
    expect(await team.json()).toEqual({ error: "Pay for people on your team is paid with their pay period, under Timesheets → Pay." });
  });

  it("takes the mark back", async () => {
    const { rpcCalls } = serve({ tables: oscar(), rpc: { job_pay_unmark_paid: () => [pay({ status: "done" })] } });
    const res = await as(OWNER, "/job-pay/unmark-paid", { method: "POST", body: { ids: [PAY] } });
    expect(await res.json()).toMatchObject({ unmarked: [{ id: PAY, status: "done" }] });
    expect(rpcCalls("job_pay_unmark_paid")).toEqual([{ p_pays: [PAY] }]);
  });
});

describe("what subs were paid", () => {
  const totals = [
    { subcontractor_id: APEX, name: "Apex Roofing", contact_name: "Al Apex", email: "al@apex.test", phone: null, address: { line1: "5 Pine Rd", city: "Dover", region: "DE", postal_code: "19901" },
      tax_classification: "individual", active: true, corporation: false, total: 3700, payments: 2, card_or_app_total: 500, card_or_app_payments: 1 },
    { subcontractor_id: "s2", name: "Birch Gutters Inc", contact_name: null, email: null, phone: null, address: {}, tax_classification: "s_corp", active: true, corporation: true,
      total: 9000, payments: 3, card_or_app_total: 0, card_or_app_payments: 0 },
  ];

  it("totals the year by sub, says who needs a 1099 at the year's threshold, and downloads it", async () => {
    const { rpcCalls } = serve({ tables: oscar(), rpc: { sub_1099_totals: () => totals } });
    const res = await as(SUBS, "/subs/1099?year=2026");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ year: 2026, threshold: 2000, threshold_note: null, total: 12700, needing_1099: 1 });
    expect(body.subs.map((s: { name: string; needs_1099: boolean }) => [s.name, s.needs_1099])).toEqual([["Apex Roofing", true], ["Birch Gutters Inc", false]]);
    expect(rpcCalls("sub_1099_totals")).toEqual([{ p_company: CO, p_year: 2026 }]);
    const csv = await (await as(SUBS, "/subs/1099/csv?year=2026")).json();
    expect(csv.filename).toBe("1099-totals-2026.csv");
    expect(csv.csv.split("\r\n")[1]).toBe("Apex Roofing,Al Apex,al@apex.test,,5 Pine Rd,,Dover,DE,19901,Individual or sole proprietor,3700.00,2,Yes,$500.00 paid by card or payment app is left out: that's reported on a 1099-K.");
  });

  it("from 2027 says to check the IRS figure", async () => {
    serve({ tables: oscar(), rpc: { sub_1099_totals: () => [] } });
    expect((await (await as(SUBS, "/subs/1099?year=2027")).json()).threshold_note).toMatch(/Check the 1099-NEC instructions for 2027/);
  });

  it("needs a year", async () => {
    serve({ tables: oscar() });
    expect((await as(SUBS, "/subs/1099")).status).toBe(400);
    expect((await as(SUBS, "/subs/1099?year=26")).status).toBe(400);
  });

  const audit = [
    { job_pay_id: PAY, subcontractor_id: APEX, sub_name: "Apex Roofing", job_id: JOB, job_number: 12, job_title: "New roof", status: "paid", amount: 2700, work_dates: ["2026-10-12", "2026-10-13", "2026-10-14"],
      covered_dates: ["2026-10-12", "2026-10-14"], coverage: "partly", covered_amount: 1800, uncovered_amount: 900,
      documents: [{ id: "d1", kind: "workers_comp", carrier: "Acme Mutual", policy_number: "WC-1", starts_on: "2026-01-01", expires_on: "2026-10-12", replaced: true }] },
  ];

  it("gives the workers' comp audit for the dates, with its totals and download", async () => {
    const { rpcCalls } = serve({ tables: oscar(), rpc: { sub_wc_audit: () => audit } });
    const res = await as(SUBS, "/subs/workers-comp?from=2026-01-01&to=2026-12-31");
    expect(await res.json()).toMatchObject({ from: "2026-01-01", to: "2026-12-31", rows: [{ coverage: "partly" }], totals: { amount: 2700, covered: 1800, not_covered: 900, subs: 1 } });
    expect(rpcCalls("sub_wc_audit")).toEqual([{ p_company: CO, p_from: "2026-01-01", p_to: "2026-12-31" }]);
    const csv = await (await as(SUBS, "/subs/workers-comp/csv?from=2026-01-01&to=2026-12-31")).json();
    expect(csv.filename).toBe("workers-comp-audit-2026-01-01-to-2026-12-31.csv");
    expect(csv.csv.split("\r\n")).toHaveLength(2);
    expect((await as(SUBS, "/subs/workers-comp?from=2026-12-31&to=2026-01-01")).status).toBe(400);
    expect((await as(SUBS, "/subs/workers-comp?from=2026-01-01")).status).toBe(400);
  });
});

describe("piece pay in pay periods", () => {
  // Cy: 8 approved hours at $20 and the New roof's piece pay; Dee: piece pay only.
  const period = (tables: Record<string, Row[]> = {}) =>
    oscar({
      time_entries: [{ id: "t1", company_id: CO, user_id: CREW, started_at: "2026-10-13T12:00:00Z", ended_at: "2026-10-13T20:00:00Z", category: "visit", approved_at: "2026-10-14T00:00:00Z", labor_rate: 20 }],
      job_pay: [
        { id: "jp1", company_id: CO, user_id: CREW, job_id: JOB, total: 234.8, status: "done", earned_on: "2026-10-13", pay_period_id: null, job: { number: 12, title: "New roof" } },
        { id: "jp2", company_id: CO, user_id: DEE, job_id: JOB, total: 100, status: "done", earned_on: "2026-10-16", pay_period_id: null, job: { number: 12, title: "New roof" } },
        { id: "jp3", company_id: CO, user_id: DEE, job_id: JOB, total: 999, status: "done", earned_on: "2026-10-20", pay_period_id: null, job: { number: 12, title: "New roof" } },
        { id: "jp4", company_id: CO, user_id: null, subcontractor_id: APEX, job_id: JOB, total: 2775, status: "done", earned_on: "2026-10-14", pay_period_id: null, job: { number: 12, title: "New roof" } },
      ],
      ...tables,
    });

  it("adds each team member's done piece pay in the period to their hourly pay, with the jobs it's for", async () => {
    serve({ tables: period() });
    const res = await as(PAYROLL, "/pay/summary?from=2026-10-12&to=2026-10-18");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ hours: 8, hourly_amount: 160, piece_amount: 334.8, amount: 494.8 });
    expect(body.overtime_note).toMatch(/worked out from total pay and hours/);
    expect(body.people.map((p: Record<string, unknown>) => [p.name, p.hours, p.hourly_amount, p.piece_amount, p.amount])).toEqual([
      ["Cy Crew", 8, 160, 234.8, 394.8],
      ["Dee Crew", 0, 0, 100, 100],
    ]);
    expect(body.people[1].piece).toEqual([{ id: "jp2", user_id: DEE, job_id: JOB, job_number: 12, job_title: "New roof", total: 100, status: "done", earned_on: "2026-10-16" }]);
  });

  it("marks the period paid with the piece pay on each line (the database marks that pay paid)", async () => {
    const world: World = { tables: period({ pay_periods: [], pay_period_lines: [] }) };
    const { calls } = serve(world);
    const res = await as(PAYROLL, "/pay/mark-paid", { method: "POST", body: { from: "2026-10-12", to: "2026-10-18", method: "payroll_service", paid_on: "2026-10-19" } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("paid");
    expect(body.paid.map((p: Record<string, unknown>) => [p.name, p.piece_amount, p.paid_amount])).toEqual([["Cy Crew", 234.8, 394.8], ["Dee Crew", 100, 100]]);
    const lines = calls.find((c) => c.path === "pay_period_lines" && c.method === "POST")!.body as Row[];
    expect(lines.map((l) => [l.user_id, l.hours, l.amount, l.piece_amount, l.paid_amount, l.method])).toEqual([
      [CREW, 8, 394.8, 234.8, 394.8, "payroll_service"],
      [DEE, 0, 100, 100, 100, "payroll_service"],
    ]);
  });

  it("in a period already paid for some, counts the piece pay paid with it (not another period's), and marks the rest at what it counts", async () => {
    const tables = period({
      pay_periods: [{
        id: "pp1", company_id: CO, starts_on: "2026-10-12", ends_on: "2026-10-18", status: "open", paid_at: null, notes: null,
        lines: [{ user_id: CREW, paid_amount: 394.8, piece_amount: 234.8, method: "payroll_service", reference: "Run 42", paid_at: "2026-10-19T16:00:00Z" }],
      }],
      pay_period_lines: [],
    });
    // Cy's piece pay was paid with this period; another of his, paid with another period, isn't this one's.
    Object.assign(tables.job_pay![0]!, { status: "paid", pay_period_id: "pp1" });
    tables.job_pay!.push({ id: "jp5", company_id: CO, user_id: CREW, job_id: JOB, total: 50, status: "paid", earned_on: "2026-10-14", pay_period_id: "pp0", job: { number: 12, title: "New roof" } });
    const { calls } = serve({ tables });
    const summary = await (await as(PAYROLL, "/pay/summary?from=2026-10-12&to=2026-10-18")).json();
    expect(summary.period_id).toBe("pp1");
    expect(summary.people.map((p: Record<string, any>) => [p.name, p.piece_amount, p.piece.map((x: { id: string }) => x.id), Boolean(p.paid)])).toEqual([
      ["Cy Crew", 234.8, ["jp1"], true],
      ["Dee Crew", 100, ["jp2"], false],
    ]);
    const pieceQuery = calls.find((c) => c.path === "job_pay" && c.url.searchParams.has("or"))!;
    expect(pieceQuery.url.searchParams.get("or")).toBe("(and(status.eq.done,earned_on.gte.2026-10-12,earned_on.lte.2026-10-18),and(status.eq.paid,pay_period_id.eq.pp1))");

    expect((await as(PAYROLL, "/pay/mark-paid", { method: "POST", body: { from: "2026-10-12", to: "2026-10-18", method: "check" } })).status).toBe(200);
    const lines = calls.find((c) => c.path === "pay_period_lines" && c.method === "POST")!.body as Row[];
    expect(lines.map((l) => [l.user_id, l.piece_amount, l.amount])).toEqual([[CREW, 234.8, 394.8], [DEE, 100, 100]]);
  });

  it("isn't for the office without job costs", async () => {
    serve({ tables: period() });
    expect((await as(SUBS, "/pay/summary?from=2026-10-12&to=2026-10-18")).status).toBe(403);
  });

  it("leaves out a sub whose hours the office keeps: they're paid by the job, so they neither hold the period up nor get a line", async () => {
    const tables = period({ pay_periods: [], pay_period_lines: [] });
    // Al (Apex's sign-in, Uses the clock): one day approved, one not, and a clock still running.
    tables.time_entries!.push(
      { id: "t2", company_id: CO, user_id: AL, started_at: "2026-10-13T12:00:00Z", ended_at: "2026-10-13T20:00:00Z", category: "visit", approved_at: "2026-10-14T00:00:00Z", labor_rate: null },
      { id: "t3", company_id: CO, user_id: AL, started_at: "2026-10-14T12:00:00Z", ended_at: "2026-10-14T20:00:00Z", category: "visit", approved_at: null, labor_rate: null },
      { id: "t4", company_id: CO, user_id: AL, started_at: "2026-10-15T12:00:00Z", ended_at: null, category: "visit", approved_at: null, labor_rate: null },
    );
    const { calls } = serve({ tables });
    const summary = await (await as(PAYROLL, "/pay/summary?from=2026-10-12&to=2026-10-18")).json();
    expect(summary.people.map((p: { user_id: string }) => p.user_id)).toEqual([CREW, DEE]);
    expect(summary).toMatchObject({ hours: 8, unapproved_hours: 0 });

    const res = await as(PAYROLL, "/pay/mark-paid", { method: "POST", body: { from: "2026-10-12", to: "2026-10-18", method: "check" } });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("paid");
    const lines = calls.find((c) => c.path === "pay_period_lines" && c.method === "POST")!.body as Row[];
    expect(lines.map((l) => l.user_id)).toEqual([CREW, DEE]);
    expect(calls.find((c) => c.path === "pay_periods" && c.method === "PATCH")!.body).toMatchObject({ status: "paid" });

    // Named on purpose, they're refused, with why.
    const named = await as(PAYROLL, "/pay/mark-paid", { method: "POST", body: { from: "2026-10-12", to: "2026-10-18", method: "check", user_ids: [CREW, AL] } });
    expect(named.status).toBe(400);
    expect((await named.json()).error).toMatch(/Subs are paid by the job/);
  });
});
