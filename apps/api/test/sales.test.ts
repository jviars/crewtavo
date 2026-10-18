import { FORMULA_VARIABLES } from "@crewtavo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";

// A stand-in for the signed-in user's Supabase client: an owner, `state.measurement` and
// `state.lines` for the measurement and quote line queries, and every write recorded.
const state = vi.hoisted(() => ({
  measurement: null as unknown,
  lines: [] as unknown[],
  writes: [] as Array<{ table: string; op: string; row: unknown }>,
}));
vi.mock("../src/lib/supabase", () => {
  const query = (table: string) => {
    let op = "select";
    const result = () =>
      table === "memberships" ? { data: { role: "owner", role_id: null }, error: null }
      : op !== "select" ? { data: { id: "00000000-0000-4000-8000-0000000000aa" }, error: null }
      : table === "measurements" ? { data: state.measurement, error: null }
      : { data: table === "quote_line_items" ? state.lines : null, error: null };
    const builder: Record<string, unknown> = {};
    for (const name of ["select", "eq", "is", "in", "order", "limit"]) builder[name] = () => builder;
    for (const name of ["insert", "update"]) {
      builder[name] = (row: unknown) => {
        op = name;
        state.writes.push({ table, op, row });
        return builder;
      };
    }
    builder.maybeSingle = builder.single = () => Promise.resolve(result());
    builder.then = (resolve: (r: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(result()).then(resolve, reject);
    return builder;
  };
  const db = { auth: { getClaims: async () => ({ data: { claims: { sub: "user-1" } }, error: null }) }, from: query, rpc: async () => ({ data: null, error: null }) };
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
const RECT = [[-80.5764, 37.1318], [-80.57606, 37.1318], [-80.57606, 37.13194], [-80.5764, 37.13194], [-80.5764, 37.1318]];
const shapes = (...geometries: unknown[]) => ({ type: "FeatureCollection", features: geometries.map((geometry, i) => ({ type: "Feature", id: `f${i}`, geometry })) });

afterEach(() => {
  state.measurement = null;
  state.lines = [];
  state.writes = [];
});

describe("saving a measurement", () => {
  it("saves shapes it can measure", async () => {
    const res = await post("/measurements", { geojson: shapes({ type: "Polygon", coordinates: [RECT] }), roof_pitch: "30deg" });
    expect(res.status).toBe(201);
    expect((await res.json()).total_area_sqft).toBeGreaterThan(0);
  });

  it("says which shape is wrong instead of failing", async () => {
    // A shape with no points used to be a TypeError, so a 500.
    for (const coordinates of [null, "abc", [[["-80.5", "37.1"], [-80.4, 37.1], [-80.4, 37.2]]]]) {
      const res = await post("/measurements", { geojson: shapes({ type: "Polygon", coordinates: [RECT] }, { type: "Polygon", coordinates }) });
      expect(res.status, JSON.stringify(coordinates)).toBe(400);
      expect((await res.json()).error).toBe("Shape 2 needs its points as [longitude, latitude] numbers");
    }
    expect(state.writes).toEqual([]);
  });

  it("refuses a pitch that isn't a roof", async () => {
    for (const roof_pitch of ["abcdeg", "90deg"]) {
      const res = await post("/measurements", { geojson: shapes({ type: "Polygon", coordinates: [RECT] }), roof_pitch });
      expect(res.status, roof_pitch).toBe(400);
      expect((await res.json()).error).toBe("Roof pitch should look like 7/12.");
    }
    expect(state.writes).toEqual([]);
  });
});

describe("quote formulas", () => {
  it("checks a formula only against values a measurement supplies", async () => {
    const res = await post("/formulas/evaluate", { formula: "hours * 2", variables: { hours: 3 } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Unknown value "hours"');
    const ok = await post("/formulas/evaluate", { formula: "area_sqft * 1.1", variables: { area_sqft: 100 } });
    expect(ok.status).toBe(200);
    expect((await ok.json()).value).toBeCloseTo(110, 6);
  });

  it("fills lines from a measurement, and says which formulas can't be worked out", async () => {
    // Saved before pitches were checked; "Labor" has the formula the General preset used to load.
    state.measurement = { total_area_sqft: 2000, total_area_sqyd: 222.22, total_length_ft: 0, sections: [], roof_pitch: "abcdeg", waste_pct: 10 };
    state.lines = [
      { id: "line-1", name: "Labor", formula: "hours", service: null },
      { id: "line-2", name: "Shingles", formula: "area_sqft * pitch_factor / 100", service: null },
      { id: "line-3", name: "Underlayment", formula: "area_sqft * (1 + waste) / 100", service: null },
    ];
    const res = await post("/quotes/00000000-0000-4000-8000-0000000000b1/apply-measurement", { measurement_id: "00000000-0000-4000-8000-0000000000c1" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body.variables).sort()).toEqual([...FORMULA_VARIABLES].sort());
    expect(body.lines).toEqual([
      { id: "line-1", name: "Labor", error: 'Unknown value "hours"' },
      { id: "line-2", name: "Shingles", error: '"pitch_factor" has no value yet' },
      { id: "line-3", name: "Underlayment", field: "quantity", value: 22 },
    ]);
    expect(state.writes.filter((w) => w.table === "quote_line_items")).toEqual([{ table: "quote_line_items", op: "update", row: { quantity: 22 } }]);
  });
});
