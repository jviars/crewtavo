import { addDays } from "@crewtavo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import type { Env } from "../src/env";
import { runAccountingJob } from "../src/integrations/accounting";
import { accessToken } from "../src/integrations/tokens";
import { encryptJson } from "../src/lib/crypto";
import type { Db } from "../src/lib/supabase";
import { processAutomations } from "../src/services/automations";
import { materializeJob, runTask } from "../src/tasks";

// The background tasks and the routes here make their own clients; they get the test's fake instead.
const current = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../src/lib/supabase", async (original) => ({
  ...(await original<typeof import("../src/lib/supabase")>()),
  adminClient: () => current.db,
  userClient: () => current.db,
}));

const env: Env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7))),
  QUICKBOOKS_CLIENT_ID: "qb-client",
  QUICKBOOKS_CLIENT_SECRET: "qb-secret",
  ZOHO_CLIENT_ID: "zoho-client",
  ZOHO_CLIENT_SECRET: "zoho-secret",
};
const COMPANY = "00000000-0000-4000-8000-000000000001";

/** One query the fake database was asked: its table and each builder call, in order. */
interface Query {
  table: string;
  calls: Array<[string, ...any[]]>;
}
type Answer = { data?: unknown; error?: { message: string } | null };

const call = (q: Query, name: string) => q.calls.find(([n]) => n === name);
const verb = (q: Query) => q.calls.find(([n]) => ["insert", "upsert", "update", "delete"].includes(n))?.[0] ?? "select";

/** Stands in for supabase-js: records every query and rpc, and answers each with the test's handlers. */
function fakeDb(answer: (q: Query) => Answer = () => ({}), rpc: (fn: string, args: Record<string, any>) => Answer = () => ({})) {
  const queries: Query[] = [];
  const rpcs: Array<{ fn: string; args: Record<string, any> }> = [];
  const chain = (q: Query): unknown =>
    new Proxy(
      {},
      {
        get: (_, name) =>
          name === "then"
            ? (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
                Promise.resolve()
                  .then(() => ({ data: null, error: null, ...answer(q) }))
                  .then(resolve, reject)
            : (...args: unknown[]) => {
                q.calls.push([String(name), ...args]);
                return chain(q);
              },
      },
    );
  const db = {
    from: (table: string) => {
      const q: Query = { table, calls: [] };
      queries.push(q);
      return chain(q);
    },
    rpc: async (fn: string, args: Record<string, any>) => {
      rpcs.push({ fn, args });
      return { data: null, error: null, ...rpc(fn, args) };
    },
    auth: { getClaims: async () => ({ data: { claims: { sub: "00000000-0000-4000-8000-0000000000aa" } }, error: null }) },
  };
  current.db = db;
  return { db: db as unknown as Db, queries, rpcs };
}

/** What Supabase's API does with a select: the range asked for, but never more than 1,000 rows. */
function upTo1000<T>(rows: T[], q: Query): Answer {
  const range = call(q, "range");
  const from = range?.[1] ?? 0;
  const to = Math.min(range?.[2] ?? Infinity, from + 999);
  return { data: rows.slice(from, to + 1) };
}

const recurringJob = (id: string, rule: string, startsOn: string) => ({
  id,
  company_id: COMPANY,
  title: "Weekly mowing",
  property_id: null,
  starts_on: startsOn,
  ends_on: null,
  recurrence_rule: rule,
  active_months: null,
  visit_start_time: null,
  visit_duration_min: 60,
  default_crew_id: "crew-1",
  company: { timezone: "UTC" },
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("recurring visits", () => {
  it("don't come back after someone deletes one", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-17T15:00:00Z") });
    const deleted = "2026-10-19";
    const { db, queries } = fakeDb((q) => (q.table === "recurrence_skips" ? { data: [{ recurrence_key: deleted }] } : { data: [] }));
    await materializeJob(db, recurringJob("job-1", "FREQ=DAILY", "2026-10-01"));

    const skips = queries.find((q) => q.table === "recurrence_skips")!;
    expect(skips.calls).toContainEqual(["eq", "job_id", "job-1"]);
    const upsert = queries.find((q) => verb(q) === "upsert")!;
    const keys = (call(upsert, "upsert")![1] as Array<{ recurrence_key: string }>).map((r) => r.recurrence_key);
    expect(keys).toContain("2026-10-18");
    expect(keys).toContain("2026-10-20");
    expect(keys).not.toContain(deleted);
    expect(keys).toHaveLength(60); // today and the next 60 days, less the deleted one
  });

  it("create nothing when every upcoming date was deleted", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-17T15:00:00Z") });
    const { db, queries } = fakeDb((q) => (q.table === "recurrence_skips" ? { data: [{ recurrence_key: "2026-10-20" }] } : { data: [] }));
    expect(await materializeJob(db, { ...recurringJob("job-1", "FREQ=DAILY", "2026-10-20"), ends_on: "2026-10-20" })).toEqual({ created: 0, removed: 0 });
    expect(queries.some((q) => verb(q) === "upsert")).toBe(false);
  });
});

describe("lists past 1,000 rows", () => {
  it("schedule every recurring job, not just the first 1,000", async () => {
    const jobs = Array.from({ length: 2500 }, (_, i) => recurringJob(`job-${String(i).padStart(4, "0")}`, "FREQ=WEEKLY", addDays("2026-10-01", i % 7)));
    const { queries } = fakeDb((q) => (q.table === "jobs" ? upTo1000(jobs, q) : { data: [] }));
    const result = await runTask("recurrence", env);

    expect(result).toMatchObject({ jobs: 2500, problems: [] });
    const scheduled = new Set(queries.filter((q) => verb(q) === "upsert").map((q) => (call(q, "upsert")![1] as Array<{ job_id: string }>)[0]!.job_id));
    expect(scheduled.size).toBe(2500);
    for (const q of queries.filter((q) => q.table === "jobs")) expect(q.calls).toContainEqual(["order", "id"]);
  });

  it("show a busy month's whole schedule", async () => {
    const visits = Array.from({ length: 1500 }, (_, i) => ({ id: `visit-${String(i).padStart(4, "0")}`, scheduled_on: addDays("2026-11-01", i % 42) }));
    const { queries } = fakeDb((q) => {
      if (q.table === "memberships") return { data: { role: "office", role_id: null } };
      if (q.table === "visits" && call(q, "gte")) return upTo1000(visits, q);
      return { data: [] };
    });
    const res = await app.request("/api/schedule?from=2026-11-01&to=2026-12-12", { headers: { Authorization: "Bearer token", "X-Company-Id": COMPANY } }, env);

    expect(res.status).toBe(200);
    const body = (await res.json()) as { visits: Array<{ id: string }> };
    expect(body.visits.map((v) => v.id)).toEqual(visits.map((v) => v.id));
    const pages = queries.filter((q) => q.table === "visits" && call(q, "gte"));
    expect(pages.map((q) => call(q, "range")!.slice(1))).toEqual([[0, 999], [1000, 1999]]);
    for (const q of pages) expect(q.calls.at(-2)).toEqual(["order", "id"]); // ties broken the same way on every page
  });
});

describe("accounting sync", () => {
  const expiring = () => encryptJson(env, { access_token: "old", refresh_token: "refresh-1", expires_at: Date.now() + 60_000 });
  const integrationWrites = (queries: Query[]) => queries.filter((q) => q.table === "integrations" && verb(q) === "update").map((q) => call(q, "update")![1]);

  it.each([
    ["an outage", () => Response.json({ error: "temporarily_unavailable" }, { status: 503 })],
    ["a timeout", () => Promise.reject(new TypeError("fetch failed"))],
  ])("keeps the app connected when refreshing its sign-in hits %s", async (_, response) => {
    const ciphertext = await expiring();
    const { db, queries } = fakeDb((q) => (q.table === "integration_secrets" ? { data: { ciphertext } } : {}));
    vi.stubGlobal("fetch", async () => response());
    await expect(accessToken(env, db, COMPANY, "quickbooks")).rejects.toThrow();
    expect(integrationWrites(queries)).toEqual([]);
  });

  it.each([
    ["quickbooks", 400, "invalid_grant"],
    ["zoho_books", 200, "invalid_code"], // Zoho refuses with a 200
  ] as const)("asks for a reconnect when %s refuses the sign-in", async (provider, status, error) => {
    const ciphertext = await expiring();
    const { db, queries } = fakeDb((q) => (q.table === "integration_secrets" ? { data: { ciphertext } } : {}));
    vi.stubGlobal("fetch", async () => Response.json({ error }, { status }));
    await expect(accessToken(env, db, COMPANY, provider)).rejects.toThrow(error);
    expect(integrationWrites(queries)).toEqual([{ status: "error", last_error: "Sign-in expired. Reconnect on the Apps page." }]);
  });

  it("retries changes queued while the app isn't connected instead of dropping them", async () => {
    const row = { id: 7, company_id: COMPANY, topic: "accounting.invoice", payload: { invoice_id: "inv-1" }, attempts: 1 };
    const { queries } = fakeDb(
      () => ({ data: null }),
      (fn) => (fn === "claim_outbox" ? { data: [row] } : {}),
    );
    expect(await runTask("outbox", env)).toEqual({ claimed: 1, done: 0, failed: 1 });
    const update = call(queries.find((q) => q.table === "outbox")!, "update")![1];
    expect(update).not.toHaveProperty("done_at");
    expect(update).toMatchObject({ last_error: expect.stringContaining("isn't connected"), dead_at: null });
  });

  it("keeps the app connected when one record never goes through", async () => {
    const row = { id: 8, company_id: COMPANY, topic: "accounting.invoice", payload: { invoice_id: "inv-gone" }, attempts: 8 };
    const { queries } = fakeDb(
      (q) => (q.table === "integrations" && verb(q) === "select" ? { data: { provider: "quickbooks", external_account_id: "realm-1", settings: {} } } : { data: null }),
      (fn) => (fn === "claim_outbox" ? { data: [row] } : {}),
    );
    expect(await runTask("outbox", env)).toEqual({ claimed: 1, done: 0, failed: 1 });
    expect(call(queries.find((q) => q.table === "outbox")!, "update")![1].dead_at).toEqual(expect.any(String));
    const marked = queries.find((q) => q.table === "integrations" && verb(q) === "update")!;
    expect(call(marked, "update")![1]).toEqual({ last_error: "Invoice not found" });
    expect(marked.calls).toContainEqual(["eq", "status", "connected"]);
  });

  describe("sending an invoice", () => {
    const connected = { provider: "quickbooks", external_account_id: "realm-1", settings: {} };
    const invoice = {
      id: "inv-1", number: 1042, client_id: "client-1", issued_on: "2026-10-17", due_on: null, subject: null, tax_rate: 0, tax_amount: 0, discount_amount: 0,
      invoice_line_items: [{ name: "Mowing", description: null, quantity: 1, unit_price: 45, taxable: false, service_id: null, sort: 0 }],
    };
    const answers = (ciphertext: string, links: (entity: string) => Answer, saveLink: Answer) => (q: Query): Answer => {
      if (q.table === "integrations") return verb(q) === "select" ? { data: connected } : {};
      if (q.table === "integration_secrets") return { data: { ciphertext } };
      if (q.table === "invoices") return { data: invoice };
      if (q.table === "sync_links") return verb(q) === "upsert" ? saveLink : links(call(q, "match")![1].entity);
      return { data: null };
    };

    it("fails when QuickBooks took it but the link couldn't be saved", async () => {
      const ciphertext = await encryptJson(env, { access_token: "token", refresh_token: "refresh-1", expires_at: Date.now() + 3_600_000 });
      const sent: string[] = [];
      vi.stubGlobal("fetch", async (url: string) => {
        sent.push(url);
        return Response.json({ Invoice: { Id: "qbo-77", SyncToken: "0" } });
      });
      const { db } = fakeDb(answers(ciphertext, (entity) => ({ data: entity === "client" ? { external_id: "cust-1" } : null }), { error: { message: "connection reset" } }));
      await expect(runAccountingJob(env, db, { company_id: COMPANY, topic: "accounting.invoice", payload: { invoice_id: "inv-1" } })).rejects.toThrow(
        "Sent invoice qbo-77 but couldn't record it: connection reset",
      );
      expect(sent).toHaveLength(1);
    });

    it("doesn't send it when it can't tell whether it was sent already", async () => {
      const ciphertext = await encryptJson(env, { access_token: "token", expires_at: Date.now() + 3_600_000 });
      const fetch = vi.fn();
      vi.stubGlobal("fetch", fetch);
      const { db } = fakeDb(answers(ciphertext, () => ({ error: { message: "connection reset" } }), {}));
      await expect(runAccountingJob(env, db, { company_id: COMPANY, topic: "accounting.invoice", payload: { invoice_id: "inv-1" } })).rejects.toThrow("connection reset");
      expect(fetch).not.toHaveBeenCalled();
    });
  });
});

describe("automation runs", () => {
  it("are skipped once another worker has claimed them", async () => {
    const run = (id: number, locked_until: string) => ({ id, company_id: COMPANY, rule_id: `rule-${id}`, subject_type: "client", subject_id: "client-1", result: [], status: "running", attempts: 1, locked_until });
    const runs = [run(1, "2026-10-17T15:05:00.123456+00:00"), run(2, "2026-10-17T15:05:00.123456+00:00")];
    // The batch took so long that, by run 2, another worker had claimed it.
    const { queries, rpcs } = fakeDb(
      () => ({ data: null }), // the rule is gone, so a run that goes ahead is skipped
      (fn, args) => (fn === "claim_automation_runs" ? { data: runs } : fn === "extend_automation_run" ? { data: args.p_id === 1 } : {}),
    );
    expect(await processAutomations(env, { limit: 50 })).toEqual({ claimed: 2, done: 0, skipped: 1, failed: 0, lost: 1 });

    expect(rpcs.filter((r) => r.fn === "extend_automation_run").map((r) => r.args)).toEqual([
      { p_id: 1, p_locked_until: "2026-10-17T15:05:00.123456+00:00" },
      { p_id: 2, p_locked_until: "2026-10-17T15:05:00.123456+00:00" },
    ]);
    expect(queries.filter((q) => q.table === "automation_rules").map((q) => call(q, "eq"))).toEqual([["eq", "id", "rule-1"]]);
    expect(queries.filter((q) => q.table === "automation_runs").map((q) => call(q, "eq"))).toEqual([["eq", "id", 1]]);
  });
});
