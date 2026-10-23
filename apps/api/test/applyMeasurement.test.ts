import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";

// A stand-in for the signed-in user's Supabase client: an owner, `state.measurement` and
// `state.lines` for the measurement and quote line queries (`.in("id", …)` narrows the lines the way
// the database would), and every write recorded with the line it was for.
const state = vi.hoisted(() => ({
  measurement: null as unknown,
  lines: [] as Array<{ id: string; [column: string]: unknown }>,
  writes: [] as Array<{ table: string; op: string; row: unknown; id?: string }>,
}));
vi.mock("../src/lib/supabase", () => {
  const query = (table: string) => {
    let op = "select";
    let ids: string[] | null = null;
    let write: { table: string; op: string; row: unknown; id?: string } | null = null;
    const result = () =>
      table === "memberships" ? { data: { role: "owner", role_id: null }, error: null }
      : op !== "select" ? { data: null, error: null }
      : table === "measurements" ? { data: state.measurement, error: null }
      : { data: table === "quote_line_items" ? state.lines.filter((l) => !ids || ids.includes(l.id)) : null, error: null };
    const builder: Record<string, unknown> = {};
    for (const name of ["select", "is", "order", "limit"]) builder[name] = () => builder;
    builder.eq = (column: string, value: string) => {
      if (write && column === "id") write.id = value;
      return builder;
    };
    builder.in = (column: string, values: string[]) => {
      if (column === "id") ids = values;
      return builder;
    };
    for (const name of ["insert", "update"]) {
      builder[name] = (row: unknown) => {
        op = name;
        write = { table, op, row };
        state.writes.push(write);
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

const QUOTE = "00000000-0000-4000-8000-0000000000b1";
const MEASUREMENT = "00000000-0000-4000-8000-0000000000c1";
const SHIELD = "00000000-0000-4000-8000-0000000000d1";
const VENT = "00000000-0000-4000-8000-0000000000d2";
const TEAR_OFF = "00000000-0000-4000-8000-0000000000d3";

afterEach(() => {
  state.measurement = null;
  state.lines = [];
  state.writes = [];
});

describe("filling a roof estimate's lines from the roof", () => {
  // 2,000 sq ft with 10% waste: 22 squares. No edges are drawn, so edge formulas come to 0.
  const roof = () => {
    state.measurement = { total_area_sqft: 2000, total_area_sqyd: 222.22, total_length_ft: 0, sections: [], roof_pitch: null, waste_pct: 10 };
    state.lines = [
      { id: SHIELD, name: "Ice and water shield", formula: "eave_ft + valley_ft", service: null },
      { id: VENT, name: "Ridge vent", formula: "area_sqft * (1 + waste) / 100", service: null },
      { id: TEAR_OFF, name: "Tear-off and disposal (2 layers)", formula: "(area_sqft / 100) * 2", service: null },
    ];
  };
  const lineWrites = () => state.writes.filter((w) => w.table === "quote_line_items");

  it("fills only the lines asked for, so the rest keep what was set by hand", async () => {
    roof();
    const res = await post(`/quotes/${QUOTE}/apply-measurement`, { measurement_id: MEASUREMENT, line_ids: [VENT] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lines).toEqual([{ id: VENT, name: "Ridge vent", field: "quantity", value: 22 }]);
    expect(lineWrites()).toEqual([{ table: "quote_line_items", op: "update", row: { quantity: 22 }, id: VENT }]);
  });

  it("still fills every measured line without a list (Update from the roof)", async () => {
    roof();
    const res = await post(`/quotes/${QUOTE}/apply-measurement`, { measurement_id: MEASUREMENT });
    expect(res.status).toBe(200);
    expect((await res.json()).lines.map((l: { id: string }) => l.id)).toEqual([SHIELD, VENT, TEAR_OFF]);
    expect(lineWrites().map((w) => w.id)).toEqual([SHIELD, VENT, TEAR_OFF]);
  });

  it("turns away a list that isn't line ids", async () => {
    roof();
    for (const line_ids of [[], ["line-1"], "all"]) {
      const res = await post(`/quotes/${QUOTE}/apply-measurement`, { measurement_id: MEASUREMENT, line_ids });
      expect(res.status, JSON.stringify(line_ids)).toBe(400);
    }
    expect(lineWrites()).toEqual([]);
  });
});
