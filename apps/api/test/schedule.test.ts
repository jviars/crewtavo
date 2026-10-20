import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";

// A stand-in for the signed-in user's Supabase client: records each query's filters and answers
// with `visits` for the visits query.
const state = vi.hoisted(() => ({ visits: [] as unknown[], route: null as unknown, schedule: {} as Record<string, unknown>, queries: [] as Array<{ table: string; calls: unknown[][] }> }));
vi.mock("../src/lib/supabase", () => {
  const query = (table: string) => {
    const calls: unknown[][] = [];
    state.queries.push({ table, calls });
    const result = () =>
      table === "memberships" ? { data: { role: "owner", role_id: null }, error: null }
      : table === "companies" ? { data: { timezone: "America/New_York", settings: { depot: { lat: 40, lng: -74 }, working_hours: { start: "08:00", end: "17:00" }, schedule: state.schedule } }, error: null }
      : table === "routes" && !calls.some((c) => c[0] === "upsert") ? { data: state.route, error: null }
      : { data: table === "visits" && !calls.some((c) => c[0] === "update") ? state.visits : null, error: null };
    const builder: Record<string, unknown> = {};
    for (const name of ["select", "eq", "neq", "is", "not", "in", "insert", "update", "upsert", "order", "limit"]) {
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
const post = (path: string, body: unknown) =>
  app.request(`/api${path}`, {
    method: "POST",
    headers: { Authorization: "Bearer token", "X-Company-Id": "00000000-0000-4000-8000-000000000001", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, env);
const preview = (body: unknown) => post("/schedule/route/preview", body);
// Lawns due north of the shop, 30 minutes each.
const vid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
const stops = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: vid(i),
    title: `Lawn ${i}`,
    kind: "job",
    status: "scheduled",
    starts_at: null,
    ends_at: null,
    route_order: null,
    time_fixed: false,
    property: { id: `p${i}`, line1: `${i} Main St`, city: "Radford", lat: 40 + (n - i) / 100, lng: -74 },
    job: { number: i, visit_duration_min: 30, client: null },
  }));
const DATE = "2099-06-03";
const visitFilters = () => state.queries.find((q) => q.table === "visits")!.calls.filter((c) => c[1] === "crew_id");
const writes = (table: string, method: string) => state.queries.filter((q) => q.table === table).flatMap((q) => q.calls.filter((c) => c[0] === method));

afterEach(() => {
  state.visits = [];
  state.route = null;
  state.schedule = {};
  state.queries = [];
});

describe("routes", () => {
  it("plans only the visits with no crew for the No crew lane", async () => {
    state.visits = stops(3);
    for (const crew_id of [null, undefined]) {
      state.queries = [];
      const res = await preview({ date: DATE, crew_id });
      expect(res.status).toBe(200);
      expect(visitFilters()).toEqual([["is", "crew_id", null]]);
    }
  });

  it("plans one crew's visits", async () => {
    state.visits = stops(3);
    const crew = "00000000-0000-4000-8000-0000000000c1";
    expect((await preview({ date: DATE, crew_id: crew })).status).toBe(200);
    expect(visitFilters()).toEqual([["eq", "crew_id", crew]]);
  });

  it("previews the nearest-first order with times, without saving", async () => {
    state.visits = stops(3);
    const body = await (await preview({ date: DATE, crew_id: null })).json();
    expect(body.stops.map((s: { id: string }) => s.id)).toEqual([vid(2), vid(1), vid(0)]);
    expect(body.stops.map((s: { order: number }) => s.order)).toEqual([1, 2, 3]);
    // 8:00 workday, a short drive, rounded up to the 5-minute step (in New York, EDT in June).
    expect(body.stops[0].starts_at).toBe("2099-06-03T12:05:00.000Z");
    expect(body.stops[0].ends_at).toBe("2099-06-03T12:35:00.000Z");
    expect(body.times).toBe(true);
    expect(writes("visits", "update")).toEqual([]);
    expect(writes("routes", "upsert")).toEqual([]);
  });

  it("saves the route and remembers the day, with what to undo", async () => {
    state.visits = stops(2);
    const res = await post("/schedule/route", { date: DATE, crew_id: null, order: [vid(0), vid(1)], by_hand: true });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.saved).toBe(2);
    expect(body.previous).toEqual([
      { id: vid(0), route_order: null, starts_at: null, ends_at: null },
      { id: vid(1), route_order: null, starts_at: null, ends_at: null },
    ]);
    expect(writes("visits", "update").map((c) => (c[1] as { route_order: number }).route_order)).toEqual([1, 2]);
    expect(writes("routes", "upsert")[0]![1]).toMatchObject({ crew_id: null, route_date: DATE, by_hand: true });
  });

  it("keeps a fixed time", async () => {
    const [a, b] = stops(2);
    state.visits = [a, { ...b!, starts_at: "2099-06-03T13:00:00.000Z", ends_at: "2099-06-03T13:30:00.000Z", time_fixed: true }];
    const body = await (await preview({ date: DATE, crew_id: null })).json();
    const fixed = body.stops.find((s: { id: string }) => s.id === vid(1));
    expect(fixed).toMatchObject({ fixed: true, starts_at: "2099-06-03T13:00:00.000Z" });
  });

  it("won't change a day that's over", async () => {
    state.visits = stops(2);
    const res = await preview({ date: "2020-01-06", crew_id: null });
    expect(res.status).toBe(400);
  });

  it("fits a new anytime visit into an organized route, with automatic routes on", async () => {
    const [a, b, c] = stops(3);
    state.visits = [{ ...a!, route_order: 2 }, { ...b!, route_order: 1 }, c];
    state.schedule = { auto_routes: true };
    state.route = { by_hand: false, organized_at: "2099-06-02T20:00:00Z", miles: 4 };
    const res = await post("/visits", { title: "Mow 0 Main St", kind: "task", scheduled_on: DATE, crew_id: null });
    expect(res.status).toBe(201);
    const updates = writes("visits", "update").map((call) => call[1] as { route_order: number; starts_at: string | null });
    // The newcomer gets a place and a time; the route keeps its order around it.
    expect(updates.length).toBeGreaterThan(0);
    expect(updates.every((u) => u.starts_at)).toBe(true);
    expect(writes("routes", "upsert")[0]![1]).toMatchObject({ by_hand: false });
  });

  it("leaves new visits alone with automatic routes off", async () => {
    const [a, b, c] = stops(3);
    state.visits = [{ ...a!, route_order: 2 }, { ...b!, route_order: 1 }, c];
    state.route = { by_hand: false, organized_at: "2099-06-02T20:00:00Z", miles: 4 };
    expect((await post("/visits", { title: "Mow 0 Main St", kind: "task", scheduled_on: DATE, crew_id: null })).status).toBe(201);
    expect(writes("visits", "update")).toEqual([]);
  });

  it("refuses more stops than it can order quickly", async () => {
    state.visits = stops(101);
    const res = await post("/schedule/route", { date: DATE, crew_id: null });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/101 stops.*up to 100/);
    expect(writes("visits", "update")).toEqual([]);
  });
});
