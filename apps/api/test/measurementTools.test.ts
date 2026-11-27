/**
 * The assistant's measuring-map tools (assistant-tools/measurements.ts): a lawn drawn from outlines
 * is saved the way Measure saves one, with its slope from USGS, marked as the assistant's; saved
 * drawings list with their lawn values and a link to fix them in Measure.
 */
import { createClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { measurementTools } from "../src/assistant-tools/measurements";
import type { ToolContext } from "../src/assistant-tools/tool";

const HOUSE = "11111111-1111-4111-8111-111111111111";
const DRAWING = "33333333-3333-4333-8333-333333333333";
const USGS_STATS = { statistics: [{ mean: 12, count: 100 }], histograms: [{ min: 0, max: 40, counts: [70, 0, 0, 30] }] };

/** The Data API answering `rows`, and USGS answering `usgs` (or failing), keeping what was sent to each. */
function world(rows: unknown, usgs: unknown = USGS_STATS) {
  const sent: Array<{ method: string; path: string; body: unknown }> = [];
  const asked: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.hostname === "elevation.nationalmap.gov") {
      asked.push(String(init?.body));
      if (usgs instanceof Error) throw usgs;
      return Response.json(usgs);
    }
    const method = init?.method ?? "GET";
    sent.push({ method, path: decodeURIComponent(`${url.pathname}${url.search}`), body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
    return Response.json(method === "POST" ? { id: DRAWING } : rows, { status: method === "POST" ? 201 : 200 });
  });
  const ctx = { db: createClient("http://127.0.0.1:8080", "sb_publishable_test"), companyId: "company-1", role: "owner", permissions: [], origin: "https://crew.example", timezone: "America/New_York" } as unknown as ToolContext;
  return { sent, asked, ctx };
}

// A 40 m by 30 m yard in Virginia, a house in the middle of it, and a bed in one corner.
const box = (lng: number, lat: number, w: number, h: number) => [[lng, lat], [lng + w, lat], [lng + w, lat + h], [lng, lat + h]] as Array<[number, number]>;
const YARD = box(-79.87, 37.05, 0.00045, 0.00027);
const HOME = box(-79.86985, 37.05008, 0.00012, 0.0001);
const BED = box(-79.87, 37.05, 0.00005, 0.00005);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the assistant's drawings", () => {
  it("saves a lawn with its slope, beds, edging, trees and obstacles, marked as the assistant's", async () => {
    const { ctx, sent, asked } = world([]);
    const save = measurementTools.save_measurement;
    const result = await save.run(ctx, save.input.parse({
      property_id: HOUSE,
      areas: [{ outline: YARD }],
      cutouts: [{ outline: HOME }, { outline: BED, item: "bed" }],
      lines: [{ points: [YARD[0], YARD[1]], item: "edging" }],
      counts: [{ at: [-79.8699, 37.0502], item: "tree" }, { at: [-79.8698, 37.0502], item: "tree" }, { at: [-79.8697, 37.0501], item: "obstacle" }],
    }));
    // USGS was asked about the lawn less the house (a hole) and the corner bed (a notch in its outline).
    const [outer, hole] = JSON.parse(new URLSearchParams(asked[0]).get("geometry")!).rings;
    expect(outer.length).toBeGreaterThan(5);
    expect(hole).toHaveLength(5);
    const row = sent.find((s) => s.method === "POST")!.body as { provider: string; property_id: string; sections: Array<{ kind: string; item?: string; slope?: unknown }>; view: { center: number[] } };
    expect(row).toMatchObject({ provider: "assistant", property_id: HOUSE, view: { zoom: 19 } });
    expect(row.sections.map((s) => [s.kind, s.item ?? null])).toEqual([["Area", null], ["Cutout", null], ["Cutout", "bed"], ["Length", "edging"], ["Count", "tree"], ["Count", "tree"], ["Count", "obstacle"]]);
    expect(row.sections[0].slope).toEqual({ mean_pct: 12, steep_pct: 20.1 });
    expect(result).toMatchObject({ id: DRAWING, link: `https://crew.example/measure?measurement=${DRAWING}`, values: { slope_pct: 12, steep_pct: 20.1, trees: 2, obstacles: 1 } });
    const values = (result as { values: Record<string, number> }).values;
    expect(values.bed_sqft).toBeGreaterThan(250);
    expect((result as { area_sqft: number }).area_sqft).toBeLessThan(40 * 30 * 10.764);
  });

  it("takes a lawn's slope by hand where none is read, and says when there's none", async () => {
    const save = measurementTools.save_measurement;
    const lawn = box(-0.13, 51.5, 0.0004, 0.0003);
    const london = world([]);
    const picked = await save.run(london.ctx, save.input.parse({ areas: [{ outline: lawn, slope: "hilly" }] }));
    expect(london.asked).toEqual([]);
    expect(picked).toMatchObject({ values: { slope_pct: 15, steep_pct: 10 } });
    expect(picked).not.toHaveProperty("slope_note");
    expect((london.sent.find((s) => s.method === "POST")!.body as { sections: Array<{ slope?: unknown }> }).sections[0].slope).toEqual({ mean_pct: 15, steep_pct: 10, picked: "hilly" });
    const none = await save.run(world([]).ctx, save.input.parse({ areas: [{ outline: lawn }] }));
    expect(none).toMatchObject({ slope_note: expect.stringContaining("outside the US") });

    vi.useFakeTimers();
    const down = world([], new TypeError("Failed to fetch"));
    const saving = save.run(down.ctx, save.input.parse({ areas: [{ outline: YARD }] }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(await saving).toMatchObject({ slope_note: expect.stringContaining("didn't answer for area 1") });
    expect(down.sent.some((s) => s.method === "POST")).toBe(true);
  });

  it("reads a lawn's slope from USGS only in the United States: the property's country, else the business's", async () => {
    const save = measurementTools.save_measurement;
    // USGS answers for Toronto too, with coarse numbers that look real.
    const toronto = box(-79.3832, 43.6532, 0.0004, 0.0003);
    // A Canadian business: no reading, so the slope given stands, or the note asks for one.
    const canada = world([]);
    const picked = await save.run({ ...canada.ctx, country: "CA", timezone: "America/Toronto" } as ToolContext, save.input.parse({ areas: [{ outline: toronto, slope: "flat" }] }));
    expect(canada.asked).toEqual([]);
    expect(picked).toMatchObject({ values: { slope_pct: 2 } });
    const none = await save.run({ ...world([]).ctx, country: "CA", timezone: "America/Toronto" } as ToolContext, save.input.parse({ areas: [{ outline: toronto }] }));
    expect(none).toMatchObject({ slope_note: expect.stringContaining("outside the US") });
    // A business whose country was never asked is taken from its time zone.
    const zone = world([]);
    await save.run({ ...zone.ctx, country: null, timezone: "America/Toronto" } as ToolContext, save.input.parse({ areas: [{ outline: toronto }] }));
    expect(zone.asked).toEqual([]);
    // Its property across the border, in the US, is read; a US business's property in Canada isn't.
    const south = world([{ country: "US" }]);
    await save.run({ ...south.ctx, country: "CA", timezone: "America/Toronto" } as ToolContext, save.input.parse({ property_id: HOUSE, areas: [{ outline: YARD }] }));
    expect(south.sent[0]!.path).toContain(`/properties?select=country&id=eq.${HOUSE}`);
    expect(south.asked).toHaveLength(1);
    const north = world([{ country: "CA" }]);
    await save.run({ ...north.ctx, country: "US" } as ToolContext, save.input.parse({ property_id: HOUSE, areas: [{ outline: toronto }] }));
    expect(north.asked).toEqual([]);
    // A US business is asked as it always was.
    const us = world([]);
    await save.run({ ...us.ctx, country: "US" } as ToolContext, save.input.parse({ areas: [{ outline: YARD }] }));
    expect(us.asked).toHaveLength(1);
  });

  it("keeps every point to the 9 decimals the measuring map takes, so the drawing opens whole in Measure", async () => {
    // Outlines the way a geocoder or arithmetic gives them: 13 to 15 decimals. Terra Draw's own count of them.
    const decimals = (n: number) => {
      let [e, places] = [1, 0];
      while (Math.round(n * e) / e !== n) [e, places] = [e * 10, places + 1];
      return places;
    };
    const fine = (points: Array<[number, number]>) => points.map(([lng, lat]) => [lng + 1 / 3e7, lat + 1 / 7e7] as [number, number]);
    const { ctx, sent } = world([]);
    const save = measurementTools.save_measurement;
    await save.run(ctx, save.input.parse({
      areas: [{ outline: fine(YARD) }],
      cutouts: [{ outline: fine(HOME) }],
      lines: [{ points: fine([YARD[0], YARD[1]]), item: "edging" }],
      counts: [{ at: fine([[-79.8699, 37.0502]])[0], item: "tree" }],
    }));
    const row = sent.find((s) => s.method === "POST")!.body as { geojson: { features: Array<{ geometry: { coordinates: unknown[] } }> } };
    const numbers = row.geojson.features.flatMap((f) => f.geometry.coordinates.flat(3) as number[]);
    expect(numbers).toHaveLength((5 + 5 + 2 + 1) * 2);
    expect(Math.max(...numbers.map(decimals))).toBeLessThanOrEqual(9);
    // An outline's last point is still its first.
    const ring = row.geojson.features[0].geometry.coordinates[0] as number[][];
    expect(ring[4]).toEqual(ring[0]);
  });

  it("saves a paving lot or a roof just the same, without asking for a lawn's slope", async () => {
    const save = measurementTools.save_measurement;
    const lot = world([]);
    const paved = await save.run(lot.ctx, save.input.parse({ areas: [{ outline: YARD, item: "asphalt" }], counts: [{ at: [-79.8699, 37.0502], item: "stall" }] }));
    expect(lot.asked).toEqual([]);
    expect((paved as { values: Record<string, number> }).values).toMatchObject({ stalls: 1 });
    expect((paved as { values: Record<string, number> }).values.asphalt_sqft).toBeGreaterThan(10_000);

    const house = world([]);
    const roof = await save.run(house.ctx, save.input.parse({ areas: [{ outline: HOME }], lines: [{ points: [HOME[0], HOME[1]], edge: "eave" }], roof_pitch: "6/12", waste_pct: 10 }));
    expect(house.asked).toEqual([]);
    expect((roof as { squares: number }).squares).toBeGreaterThan(1);
    expect((roof as { values: Record<string, number> }).values.eave_ft).toBeGreaterThan(30);
  });

  it("prices a line that reads a depth at its item's own depth, as Fill quantities does on the quote", async () => {
    // A 2,700 sq ft drive drawn at 2 inches (the asphalt's), with a stone base whose price list item says 6.
    const STONE = "44444444-4444-4444-8444-444444444444";
    const ASPHALT = "55555555-5555-4555-8555-555555555555";
    const drawing = { total_area_sqft: 2700, total_area_sqyd: 300, total_length_ft: 0, roof_pitch: null, waste_pct: 0, sections: [{ feature_id: "a", kind: "Area", label: "Area 1", value: 2700, unit: "sq ft", depth_in: 2, manual_override: false }] };
    const lines = [
      { id: STONE, name: "Stone base", formula: "area_sqft * depth_in / 12 / 27", service: { formula_target: "quantity", default_depth_in: 6 } },
      { id: ASPHALT, name: "Asphalt", formula: "area_sqyd * depth_in * 110 / 2000", service: { formula_target: "quantity", default_depth_in: null } },
    ];
    const { ctx } = world([]);
    const writes: Array<{ path: string; body: unknown }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if ((init?.method ?? "GET") !== "GET") {
        writes.push({ path: decodeURIComponent(`${url.pathname}${url.search}`), body: JSON.parse(String(init?.body)) });
        return new Response(null, { status: 204 });
      }
      return Response.json(url.pathname.endsWith("/measurements") ? [drawing] : lines);
    });
    const fill = measurementTools.fill_quote_from_measurement;
    const result = (await fill.run({ ...ctx, permissions: ["sales"] } as ToolContext, fill.input.parse({ quote_id: HOUSE, measurement_id: DRAWING }))) as { lines: unknown[]; values: Record<string, number> };
    // 6 inches of stone (50 cu yd), not the 2 typed for the asphalt (16.7); the asphalt at the drawing's 2 (33 tons).
    expect(result.lines).toEqual([
      { id: STONE, name: "Stone base", field: "quantity", value: 50, depth_in: 6 },
      { id: ASPHALT, name: "Asphalt", field: "quantity", value: 33, depth_in: 2 },
    ]);
    expect(writes.find((w) => w.path.includes(STONE))?.body).toEqual({ quantity: 50 });
    expect(result.values).toMatchObject({ area_sqft: 2700, depth_in: 2 });
  });

  it("says which items a shape can be when it's given one it can't", async () => {
    const save = measurementTools.save_measurement;
    await expect(save.run(world([]).ctx, save.input.parse({ areas: [{ outline: YARD, item: "tree" }] }))).rejects.toThrow(/Area 1: "tree" isn't an item it can be. An area can be asphalt/);
    await expect(save.run(world([]).ctx, save.input.parse({}))).rejects.toThrow("at least one shape");
  });

  it("leaves it to the roles that measure", async () => {
    const { ctx } = world([]);
    const save = measurementTools.save_measurement;
    await expect(save.run({ ...ctx, role: "field_crew" } as ToolContext, save.input.parse({ areas: [{ outline: YARD }] }))).rejects.toThrow("role");
    const fill = measurementTools.fill_quote_from_measurement;
    await expect(fill.run({ ...ctx, role: "crew_lead" } as ToolContext, fill.input.parse({ quote_id: HOUSE, measurement_id: DRAWING }))).rejects.toThrow("role");
  });

  it("lists saved drawings with the values formulas read from them and a link to fix them", async () => {
    const sections = [
      { feature_id: "a", kind: "Area", label: "Area 1", value: 3000, unit: "sq ft", slope: { mean_pct: 8, steep_pct: 2 } },
      { feature_id: "t", kind: "Count", label: "Tree 1", value: 1, unit: "ea", item: "tree" },
    ];
    const { ctx, sent } = world([{ id: DRAWING, title: "Lawn", provider: "assistant", property_id: HOUSE, total_area_sqft: 3000, total_area_sqyd: 333.33, total_length_ft: 0, sections, roof_pitch: null, waste_pct: 0 }]);
    const list = measurementTools.list_measurements;
    expect(await list.run(ctx, list.input.parse({ property_id: HOUSE }))).toEqual([
      expect.objectContaining({ id: DRAWING, by_assistant: true, link: `https://crew.example/measure?measurement=${DRAWING}`, values: expect.objectContaining({ area_sqft: 3000, slope_pct: 8, steep_pct: 2, trees: 1, count: 1 }) }),
    ]);
    expect(sent[0]!.path).toContain(`property_id=eq.${HOUSE}`);
  });
});
