import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";

// Stand-ins for the signed-in user's Supabase client, which answers the membership check with
// `member` (and its custom role with `permissions`), and the service-role client, which answers
// the time entries query with `entries`, a page at a time. Both record each query's calls.
const state = vi.hoisted(() => ({
  member: { role: "owner", role_id: null as string | null },
  permissions: [] as string[],
  entries: [] as Array<{ id: string; labor_rate: number }>,
  queries: [] as Array<{ client: "user" | "admin"; table: string; calls: unknown[][] }>,
}));
vi.mock("../src/lib/supabase", () => {
  const client = (kind: "user" | "admin") => ({
    auth: { getClaims: async () => ({ data: { claims: { sub: "user-1" } }, error: null }) },
    rpc: async () => ({ data: null, error: null }),
    from: (table: string) => {
      const calls: unknown[][] = [];
      state.queries.push({ client: kind, table, calls });
      const result = () => {
        if (table === "memberships") return { data: state.member, error: null };
        if (table === "company_roles") return { data: { permissions: state.permissions }, error: null };
        const [, from, to] = (calls.find((c) => c[0] === "range") ?? ["range", 0, 999]) as [string, number, number];
        return { data: kind === "admin" && table === "time_entries" ? state.entries.slice(from, to + 1) : [], error: null };
      };
      const builder: Record<string, unknown> = {};
      for (const name of ["select", "eq", "not", "in", "gte", "lt", "order", "range"]) {
        builder[name] = (...args: unknown[]) => (calls.push([name, ...args]), builder);
      }
      builder.maybeSingle = () => Promise.resolve(result());
      builder.then = (resolve: (r: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(result()).then(resolve, reject);
      return builder;
    },
  });
  const user = client("user");
  const admin = client("admin");
  return { userClient: () => user, adminClient: () => admin, publishableKey: () => "key" };
});
const { app } = await import("../src/app");

const env = { SUPABASE_URL: "https://example.supabase.co", SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test", SUPABASE_SECRET_KEY: "sb_secret_test" } as Env;
const COMPANY = "00000000-0000-4000-8000-000000000001";
const JOB = "00000000-0000-4000-8000-0000000000a1";
const rates = (body: unknown) =>
  app.request("/api/time/rates", {
    method: "POST",
    headers: { Authorization: "Bearer token", "X-Company-Id": COMPANY, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, env);
const timeQueries = () => state.queries.filter((q) => q.table === "time_entries");

afterEach(() => {
  state.member = { role: "owner", role_id: null };
  state.permissions = [];
  state.entries = [];
  state.queries = [];
});

describe("pay rates on time entries", () => {
  it("gives the office the rates on a job's time, read with the service role for their company", async () => {
    state.entries = [{ id: "te-1", labor_rate: 22 }, { id: "te-2", labor_rate: 34.5 }];
    const res = await rates({ job_ids: [JOB] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ "te-1": 22, "te-2": 34.5 });
    const [query, ...others] = timeQueries();
    expect(others).toEqual([]);
    expect(query!.client).toBe("admin");
    expect(query!.calls).toContainEqual(["eq", "company_id", COMPANY]);
    expect(query!.calls).toContainEqual(["in", "job_id", [JOB]]);
  });

  it("reads the time started in a range, a page at a time", async () => {
    state.entries = Array.from({ length: 2500 }, (_, i) => ({ id: `te-${i}`, labor_rate: 20 }));
    const res = await rates({ from: "2026-10-01T04:00:00.000Z", to: "2026-10-17T04:00:00.000Z" });
    expect(Object.keys(await res.json())).toHaveLength(2500);
    expect(timeQueries()).toHaveLength(3);
    expect(timeQueries()[0]!.calls).toContainEqual(["gte", "started_at", "2026-10-01T04:00:00.000Z"]);
    expect(timeQueries()[0]!.calls).toContainEqual(["lt", "started_at", "2026-10-17T04:00:00.000Z"]);
  });

  it("refuses crew leads, field crew, estimators and office roles without job costs, before reading any rate", async () => {
    state.entries = [{ id: "te-1", labor_rate: 22 }];
    for (const role of ["crew_lead", "field_crew", "estimator"]) {
      state.member = { role, role_id: null };
      expect((await rates({ job_ids: [JOB] })).status).toBe(403);
    }
    state.member = { role: "office", role_id: "00000000-0000-4000-8000-0000000000b1" };
    state.permissions = ["reports", "timesheets"];
    expect((await rates({ job_ids: [JOB] })).status).toBe(403);
    expect(timeQueries()).toEqual([]);
  });

  it("needs the jobs or the dates", async () => {
    expect((await rates({})).status).toBe(400);
    expect((await rates({ from: "2026-10-01T04:00:00.000Z" })).status).toBe(400);
    expect(timeQueries()).toEqual([]);
  });
});
