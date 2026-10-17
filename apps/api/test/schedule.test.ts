import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";

// A stand-in for the signed-in user's Supabase client: records each query's filters and answers
// with `visits` for the visits query.
const state = vi.hoisted(() => ({ visits: [] as unknown[], queries: [] as Array<{ table: string; calls: unknown[][] }> }));
vi.mock("../src/lib/supabase", () => {
  const query = (table: string) => {
    const calls: unknown[][] = [];
    state.queries.push({ table, calls });
    const result = () =>
      table === "memberships" ? { data: { role: "owner", role_id: null }, error: null }
      : table === "companies" ? { data: { timezone: "America/New_York", settings: {} }, error: null }
      : { data: table === "visits" && !calls.some((c) => c[0] === "update") ? state.visits : null, error: null };
    const builder: Record<string, unknown> = {};
    for (const name of ["select", "eq", "is", "not", "in", "update", "order", "limit"]) {
      builder[name] = (...args: unknown[]) => (calls.push([name, ...args]), builder);
    }
    builder.maybeSingle = () => Promise.resolve(result());
    builder.then = (resolve: (r: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(result()).then(resolve, reject);
    return builder;
  };
  const db = { auth: { getClaims: async () => ({ data: { claims: { sub: "user-1" } }, error: null }) }, from: query, rpc: async () => ({ data: [], error: null }) };
  return { userClient: () => db, adminClient: () => db, publishableKey: () => "key" };
});
const { app } = await import("../src/app");

const env = { SUPABASE_URL: "https://example.supabase.co", SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test", SUPABASE_SECRET_KEY: "sb_secret_test" } as Env;
const optimize = (body: unknown) =>
  app.request("/api/schedule/optimize", {
    method: "POST",
    headers: { Authorization: "Bearer token", "X-Company-Id": "00000000-0000-4000-8000-000000000001", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, env);
const stops = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `v${i}`, property: { lat: 40 + i / 1000, lng: -74 } }));
const visitFilters = () => state.queries.find((q) => q.table === "visits")!.calls.filter((c) => c[1] === "crew_id");

afterEach(() => {
  state.visits = [];
  state.queries = [];
});

describe("route ordering", () => {
  it("orders only the visits with no crew for the No crew lane", async () => {
    state.visits = stops(3);
    for (const crew_id of [null, undefined]) {
      state.queries = [];
      const res = await optimize({ date: "2026-10-16", crew_id });
      expect(res.status).toBe(200);
      expect(visitFilters()).toEqual([["is", "crew_id", null]]);
    }
  });

  it("orders one crew's visits", async () => {
    state.visits = stops(3);
    const crew = "00000000-0000-4000-8000-0000000000c1";
    expect((await optimize({ date: "2026-10-16", crew_id: crew })).status).toBe(200);
    expect(visitFilters()).toEqual([["eq", "crew_id", crew]]);
  });

  it("refuses more stops than it can order quickly", async () => {
    state.visits = stops(101);
    const res = await optimize({ date: "2026-10-16", crew_id: null });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/101 stops.*up to 100/);
    expect(state.queries.some((q) => q.calls.some((c) => c[0] === "update"))).toBe(false);
  });
});
