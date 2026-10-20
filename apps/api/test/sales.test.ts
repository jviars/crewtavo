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
    // Just short of upright used to save more squares than the column holds, so a 500.
    for (const roof_pitch of ["abcdeg", "90deg", "89.99999deg", "1e9/1"]) {
      const res = await post("/measurements", { geojson: shapes({ type: "Polygon", coordinates: [RECT] }), roof_pitch });
      expect(res.status, roof_pitch).toBe(400);
      expect((await res.json()).error).toBe("Roof pitch should look like 7/12.");
    }
    expect(state.writes).toEqual([]);
  });

  it("keeps the map picture and where the map was", async () => {
    const snapshot_path = "00000000-0000-4000-8000-000000000001/measurements/0b5c9f1e-1d2a-4c3b-9e8f-7a6b5c4d3e2f.jpg";
    const view = { center: [-79.8717, 37.0547], zoom: 19.2, imagery: "state:VA", attribution: "Virginia imagery" };
    const res = await post("/measurements", { geojson: shapes({ type: "Polygon", coordinates: [RECT] }), snapshot_path, view, provider: "state:VA" });
    expect(res.status).toBe(201);
    expect(state.writes[0].row).toMatchObject({ snapshot_path, view, provider: "state:VA" });
    // Saving again without a new picture leaves the saved one alone.
    state.writes = [];
    await post("/measurements", { id: "00000000-0000-4000-8000-0000000000aa", geojson: shapes({ type: "Polygon", coordinates: [RECT] }) });
    expect(state.writes[0].row).not.toHaveProperty("snapshot_path");
  });

  it("keeps the plan sheet lined up on the map, and the imagery choice", async () => {
    const corners = [[-79.8722, 37.0551], [-79.8712, 37.0551], [-79.8712, 37.0544], [-79.8722, 37.0544]];
    const plan = { id: "0b5c9f1e-1d2a-4c3b-9e8f-7a6b5c4d3e2f", page: 3, corners, size: [4096, 2731], opacity: 0.7, paper: false };
    const view = { center: [-79.8717, 37.0547], zoom: 19, imagery: "naip", mode: "manual", overlays: ["contours"], plan };
    const res = await post("/measurements", { geojson: shapes({ type: "Polygon", coordinates: [RECT] }), view });
    expect(res.status).toBe(201);
    expect(state.writes[0].row).toMatchObject({ view });
    // A plan without its corners isn't kept half-saved.
    const bad = await post("/measurements", { geojson: shapes({ type: "Polygon", coordinates: [RECT] }), view: { ...view, plan: { ...plan, corners: corners.slice(0, 3) } } });
    expect(bad.status).toBe(400);
  });

  it("only takes a picture from this company's map pictures", async () => {
    // The Client Hub serves this file with the service key, so it can't point at a receipt or another company's file.
    for (const snapshot_path of [
      "00000000-0000-4000-8000-000000000002/measurements/0b5c9f1e-1d2a-4c3b-9e8f-7a6b5c4d3e2f.jpg",
      "00000000-0000-4000-8000-000000000001/receipts/0b5c9f1e-1d2a-4c3b-9e8f-7a6b5c4d3e2f.jpg",
      "00000000-0000-4000-8000-000000000001/measurements/../receipts/x.jpg",
    ]) {
      const res = await post("/measurements", { geojson: shapes({ type: "Polygon", coordinates: [RECT] }), snapshot_path });
      expect(res.status, snapshot_path).toBe(400);
      expect((await res.json()).error).toBe("That map picture isn't one of this company's.");
    }
    expect(state.writes).toEqual([]);
  });

  it("refuses a measurement too large to save", async () => {
    // Totals past numeric(14, 2), or squares past numeric(10, 2), used to fail in the database (a 500).
    const huge = [
      { geojson: shapes({ type: "Polygon", coordinates: [[[-100, 30], [-80, 30], [-80, 40], [-100, 40], [-100, 30]]] }) },
      { geojson: { type: "FeatureCollection", features: [{ type: "Feature", properties: { manual_value: 1e13 }, geometry: { type: "Polygon", coordinates: [RECT] } }] } },
      { geojson: { type: "FeatureCollection", features: [{ type: "Feature", properties: { manual_value: 1e12 }, geometry: { type: "LineString", coordinates: RECT } }] } },
      { geojson: { type: "FeatureCollection", features: [{ type: "Feature", properties: { manual_value: 1e10 }, geometry: { type: "Polygon", coordinates: [RECT] } }] }, roof_pitch: "12/12" },
    ];
    for (const body of huge) {
      const res = await post("/measurements", body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect((await res.json()).error).toBe("This measurement is too large to save. Check the shapes and measured values.");
    }
    expect(state.writes).toEqual([]);
    // A big job still fits.
    const res = await post("/measurements", { geojson: { type: "FeatureCollection", features: [{ type: "Feature", properties: { manual_value: 5e6 }, geometry: { type: "Polygon", coordinates: [RECT] } }] }, roof_pitch: "12/12", waste_pct: 15 });
    expect(res.status).toBe(201);
    expect((await res.json()).roofing_squares).toBe(81317.28);
  });
});

describe("roofs and cutouts", () => {
  const INNER = [[-80.57631, 37.13183], [-80.57615, 37.13183], [-80.57615, 37.13191], [-80.57631, 37.13191], [-80.57631, 37.13183]];
  const feature = (geometry: unknown, properties: Record<string, unknown> = {}) => ({ type: "Feature", geometry, properties });

  it("takes a cutout out of the area under it", async () => {
    const yard = await post("/measurements", { geojson: { type: "FeatureCollection", features: [feature({ type: "Polygon", coordinates: [RECT] })] } });
    const cut = await post("/measurements", { geojson: { type: "FeatureCollection", features: [feature({ type: "Polygon", coordinates: [RECT] }, { label: "Yard" }), feature({ type: "Polygon", coordinates: [INNER] }, { label: "House", cutout: true })] } });
    expect(cut.status).toBe(201);
    const [whole, body] = [await yard.json(), await cut.json()];
    expect(body.total_area_sqft).toBeLessThan(whole.total_area_sqft);
    expect(body.sections[0].uncut_value).toBe(whole.total_area_sqft);
    expect(body.sections[1]).toMatchObject({ kind: "Cutout", label: "House" });
    expect(body.total_area_sqft + body.sections[1].value).toBeCloseTo(whole.total_area_sqft, 1);
  });

  it("gives each roof section its own pitch, and writes pitches one way", async () => {
    const res = await post("/measurements", {
      geojson: { type: "FeatureCollection", features: [feature({ type: "Polygon", coordinates: [RECT] }), feature({ type: "Polygon", coordinates: [RECT] }, { label: "Porch", pitch: "3:12" })] },
      roof_pitch: "6-12",
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    const one = body.total_area_sqft / 2;
    expect(body.roofing_squares).toBeCloseTo((one * Math.sqrt(1.25) + one * Math.sqrt(1 + 1 / 16)) / 100, 1);
    expect(state.writes.at(-1)?.row).toMatchObject({ roof_pitch: "6/12" });
    const bad = await post("/measurements", { geojson: { type: "FeatureCollection", features: [feature({ type: "Polygon", coordinates: [RECT] }, { label: "Porch", pitch: "low" })] }, roof_pitch: "6/12" });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe("The pitch for Porch should look like 7/12.");
  });

  it("hands formulas the roof edges and a weighted pitch", async () => {
    state.measurement = {
      total_area_sqft: 2000, total_area_sqyd: 222.22, total_length_ft: 180, roof_pitch: "6/12", waste_pct: 0,
      sections: [
        { kind: "Area", value: 1500, pitch: "6/12" },
        { kind: "Area", value: 500, pitch: "12/12" },
        { kind: "Length", value: 100, edge: "eave" },
        { kind: "Length", value: 50, edge: "rake" },
        { kind: "Length", value: 30, edge: "ridge" },
      ],
    };
    state.lines = [
      { id: "line-1", name: "Shingles", formula: "area_sqft * pitch_factor / 100", service: null },
      { id: "line-2", name: "Drip edge", formula: "eave_ft + rake_ft", service: null },
      { id: "line-3", name: "Ridge cap", formula: "ridge_ft + hip_ft", service: null },
    ];
    const res = await post("/quotes/00000000-0000-4000-8000-0000000000b1/apply-measurement", { measurement_id: "00000000-0000-4000-8000-0000000000c1" });
    const body = await res.json();
    expect(body.lines[0].value).toBeCloseTo((1500 * Math.sqrt(1.25) + 500 * Math.SQRT2) / 100, 2);
    expect(body.lines[1].value).toBe(150);
    expect(body.lines[2].value).toBe(30);
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
