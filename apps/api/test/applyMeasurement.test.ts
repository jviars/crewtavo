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

describe("a depth for each line that uses one", () => {
  const STONE = "00000000-0000-4000-8000-0000000000e1";
  const HOT_MIX = "00000000-0000-4000-8000-0000000000e2";
  const MULCH = "00000000-0000-4000-8000-0000000000e3";
  const SEAL = "00000000-0000-4000-8000-0000000000e4";
  const TONS = "asphalt_sqyd * depth_in * 110 / 2000";
  // A 3,600 sq ft driveway (400 sq yd), drawn with a depth of 3 inches. The stone base and hot mix
  // have depths of their own in the price list; the mulch has none.
  const driveway = (drawn: number | null = 3) => {
    state.measurement = { total_area_sqft: 3600, total_area_sqyd: 400, total_length_ft: 0, sections: [{ feature_id: "a", kind: "Area", label: "Drive", value: 3600, unit: "sq ft", depth_in: drawn }], roof_pitch: null, waste_pct: 0 };
    state.lines = [
      { id: STONE, name: "Grade and compact stone base", formula: TONS, service: { formula_target: "quantity", default_depth_in: 6 } },
      { id: HOT_MIX, name: "Hot-mix asphalt surface", formula: TONS, service: { formula_target: "quantity", default_depth_in: 2 } },
      { id: MULCH, name: "Mulch", formula: "area_sqft * depth_in / 324", service: { formula_target: "quantity", default_depth_in: null } },
      { id: SEAL, name: "Sealcoat", formula: "sealcoat_sqft", service: null },
    ];
  };
  const filled = async (body: Record<string, unknown>) => {
    const res = await post(`/quotes/${QUOTE}/apply-measurement`, { measurement_id: MEASUREMENT, ...body });
    expect(res.status).toBe(200);
    return Object.fromEntries(((await res.json()).lines as Array<{ id: string; value?: number; depth_in?: number | null; error?: string }>).map((l) => [l.id, l]));
  };

  it("gives each line the depth confirmed for it: 6 inches of stone under 2 of asphalt", async () => {
    driveway();
    const lines = await filled({ depths: { [STONE]: 6, [HOT_MIX]: 2.5, [MULCH]: 3 } });
    expect(lines[STONE]).toMatchObject({ value: 132, depth_in: 6 });
    expect(lines[HOT_MIX]).toMatchObject({ value: 55, depth_in: 2.5 });
    expect(lines[MULCH]).toMatchObject({ value: 33.333, depth_in: 3 });
    // A line that reads no depth says nothing about one.
    expect(lines[SEAL]).toEqual({ id: SEAL, name: "Sealcoat", field: "quantity", value: 3600 });
    expect(state.writes.filter((w) => w.table === "quote_line_items" && w.id === STONE)).toEqual([{ table: "quote_line_items", op: "update", row: { quantity: 132 }, id: STONE }]);
  });

  it("starts from each item's own depth when asked to, with the one depth for the rest", async () => {
    driveway();
    const lines = await filled({ item_depths: true, depth_in: 4 });
    expect([lines[STONE]!.depth_in, lines[HOT_MIX]!.depth_in, lines[MULCH]!.depth_in]).toEqual([6, 2, 4]);
    // And the drawing's depth for a line with neither.
    expect((await filled({ item_depths: true }))[MULCH]).toMatchObject({ depth_in: 3, value: 33.333 });
    // A depth confirmed for one line wins over its item's.
    expect((await filled({ item_depths: true, depths: { [STONE]: 8 } }))[STONE]).toMatchObject({ depth_in: 8, value: 176 });
  });

  it("still applies one depth to every line when that's all that's sent, as an app from before sends it", async () => {
    driveway();
    const lines = await filled({ depth_in: 2 });
    expect([lines[STONE]!.value, lines[HOT_MIX]!.value, lines[MULCH]!.depth_in]).toEqual([44, 44, 2]);
    // Nothing sent: the drawing's depth for all, as before.
    const drawn = await filled({});
    expect([drawn[STONE]!.depth_in, drawn[HOT_MIX]!.depth_in, drawn[MULCH]!.depth_in]).toEqual([3, 3, 3]);
  });

  it("uses an item's own depth where there was none at all, and says so when there's still none", async () => {
    driveway(null);
    const lines = await filled({});
    expect(lines[STONE]).toMatchObject({ value: 132, depth_in: 6 });
    expect(lines[HOT_MIX]).toMatchObject({ value: 44, depth_in: 2 });
    expect(lines[MULCH]!.error).toBeTruthy();
    expect(lines[MULCH]!.value).toBeUndefined();
  });

  it("turns away a depth that isn't one, or isn't for a line", async () => {
    driveway();
    for (const depths of [{ [STONE]: 0 }, { [STONE]: 60 }, { [STONE]: "6" }, { stone: 6 }]) {
      const res = await post(`/quotes/${QUOTE}/apply-measurement`, { measurement_id: MEASUREMENT, depths });
      expect(res.status, JSON.stringify(depths)).toBe(400);
    }
    expect(state.writes.filter((w) => w.table === "quote_line_items")).toEqual([]);
  });
});

describe("pricing a lawn by its slope and trees", () => {
  const MOW = "00000000-0000-4000-8000-0000000000f1";
  // A flat 6,000 sq ft front lawn and a 4,000 sq ft back hill, a quarter of it steeper than 3:1.
  const lawn = (back: Record<string, number> | null) => {
    const area = (label: string, value: number, slope: Record<string, number> | null) => ({ feature_id: label, kind: "Area", label, value, unit: "sq ft", ...(slope ? { slope } : {}) });
    state.measurement = { total_area_sqft: 10000, total_area_sqyd: 1111.11, total_length_ft: 0, sections: [area("Front", 6000, { mean_pct: 4, steep_pct: 0 }), area("Back", 4000, back), { feature_id: "t", kind: "Count", label: "Tree 1", value: 1, unit: "ea", item: "tree" }], roof_pitch: null, waste_pct: 0 };
    state.lines = [{ id: MOW, name: "Weekly mow", formula: "max(45, area_sqft / 1000 * 4.5) * (1 + steep_pct / 100) + slope_pct + trees * 2", service: { formula_target: "unit_price", default_depth_in: null } }];
  };

  it("weights the slope by lawn size, and says so when a lawn has none", async () => {
    lawn({ mean_pct: 20, steep_pct: 25 });
    let res = await post(`/quotes/${QUOTE}/apply-measurement`, { measurement_id: MEASUREMENT });
    // $45 for 10,000 sq ft, 10% of it steep, a dollar per point of average slope (10.4) and $2 for the tree.
    expect((await res.json()).lines).toEqual([{ id: MOW, name: "Weekly mow", field: "unit_price", value: 61.9 }]);

    lawn(null);
    state.writes = [];
    res = await post(`/quotes/${QUOTE}/apply-measurement`, { measurement_id: MEASUREMENT });
    expect((await res.json()).lines[0].error).toMatch(/no slope reading/);
    expect(state.writes.filter((w) => w.table === "quote_line_items")).toEqual([]);
  });
});
