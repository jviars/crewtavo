/**
 * The measuring map for assistants: a property's saved drawings with their sizes and the values
 * quote formulas read from them, a drawing made from outlines the assistant already has (any trade:
 * a lawn, a lot, a roof; saved the way Measure saves one and marked as the assistant's, for a person
 * to open and fix), and a quote's lines priced from a drawing by the price list's formulas, as "Fill
 * quantities from this" does.
 */
import {
  isRoofEdge,
  itemFits,
  LAWN_ITEMS,
  PAVING_ITEMS,
  pavingItem,
  pickedSlope,
  readSlope,
  ROOF_EDGES,
  roundCoordinates,
  SALES,
  SLOPE_CHOICE_IDS,
  type Feature,
  type Geometry,
  type GroundSlope,
  type Position,
  type Section,
} from "@crewtavo/core";
import { businessCountry } from "@crewtavo/core/countries";
import { z } from "zod";
import { applyMeasurement, measurementVariables, saveMeasurement, type MeasurementValues } from "../services/measurements";
import { companyArg, requireRole, rows, tool, type ToolContext } from "./tool";

/** A drawing's `provider` when an assistant drew it; saving it in Measure changes it to the imagery. */
export const ASSISTANT_PROVIDER = "assistant";

const point = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);
const MAX_SHAPES = 500;
const ITEMS = [...PAVING_ITEMS, ...LAWN_ITEMS];
const itemsFor = (geometry: string) => ITEMS.filter((i) => i.geometry === geometry).map((i) => i.id).join(", ");
const item = (geometry: string) => z.string().optional().describe(`What it is, for a takeoff: one of ${itemsFor(geometry)}.`);

const link = (ctx: ToolContext, id: string) => `${ctx.origin}/measure?measurement=${id}`;
/**
 * A ring closed the way GeoJSON wants it: back to its first point. Its points at the 9 decimals a
 * drawing keeps (saveMeasurement), so one that ends a hair off its start still closes on it.
 */
const polygon = (outline: Position[]): Geometry => {
  const ring = roundCoordinates(outline);
  const [first, last] = [ring[0], ring[ring.length - 1]];
  return { type: "Polygon", coordinates: [first[0] === last[0] && first[1] === last[1] ? ring : [...ring, first]] };
};
/** The values quote formulas read from a drawing, without the many that are zero or missing for it. */
const valuesOf = (m: MeasurementValues) => Object.fromEntries(Object.entries(measurementVariables(m)).filter(([, v]) => v !== null && v !== 0));

export const measurementTools = {
  list_measurements: tool({
    description:
      "Saved drawings from the measuring map, newest first, for a property, client, quote or request: each one's size, the values quote formulas read from it (area_sqft, length_ft, a lawn's slope_pct, steep_pct, bed_sqft, trees; a paving takeoff's asphalt_sqft, stalls; a roof's squares; and so on, the ones it has), and a link to open it in Measure. by_assistant: an assistant drew it and nobody has saved it in Measure since. A property's own lot size and map point are on get_client.",
    input: z.object({
      property_id: z.uuid().optional(),
      client_id: z.uuid().optional(),
      quote_id: z.uuid().optional(),
      request_id: z.uuid().optional(),
      limit: z.number().int().min(1).max(50).default(10),
      ...companyArg,
    }),
    run: async (ctx, a) => {
      let q = ctx.db
        .from("measurements")
        .select("id, title, created_at, provider, property_id, quote_id, request_id, total_area_sqft, total_area_sqyd, total_length_ft, sections, roof_pitch, waste_pct")
        .eq("company_id", ctx.companyId);
      if (a.property_id) q = q.eq("property_id", a.property_id);
      if (a.quote_id) q = q.eq("quote_id", a.quote_id);
      if (a.request_id) q = q.eq("request_id", a.request_id);
      if (a.client_id) {
        const ids = (await rows(ctx.db.from("properties").select("id").eq("company_id", ctx.companyId).eq("client_id", a.client_id))).map((p) => p.id);
        if (!ids.length) return [];
        q = q.in("property_id", ids);
      }
      return (await rows(q.order("created_at", { ascending: false }).limit(a.limit))).map((m) => ({
        id: m.id,
        title: m.title,
        created_at: m.created_at,
        property_id: m.property_id,
        quote_id: m.quote_id,
        request_id: m.request_id,
        by_assistant: m.provider === ASSISTANT_PROVIDER,
        values: valuesOf({ ...m, sections: Array.isArray(m.sections) ? m.sections : [] } as MeasurementValues),
        link: link(ctx, m.id),
      }));
    },
  }),

  save_measurement: tool({
    description:
      "Draw and save a measurement on the measuring map from outlines you already have, as [longitude, latitude] points, for any trade: areas (a lawn, a lot, a roof section), cutouts (what's inside an area but not part of it: the house, a pool; or a lawn's bed), lines (edging, curb, striping, a roof's eaves and ridges) and counts (trees, stalls, drains; the property's map point will do when you only know how many). Each shape can say what it is for a takeoff (`item`), so its formula values add up (a lawn's beds, trees and obstacles; a paving lot's asphalt and stalls). Crewtavo works out the sizes the way Measure does. A lawn (plain areas, no paving items or roof pitch) also gets each area's slope from free USGS elevation (in the United States only, by the property's country or else the business's); where there's none, `slope` (flat, hilly or steep) stands in. It's saved on the property (and the quote or request, when given), marked as drawn by an assistant. It's only as right as the outlines you give: say so, and give the person the link to check and fix it in Measure. Then fill_quote_from_measurement prices a quote from it.",
    area: "clients",
    input: z.object({
      title: z.string().trim().min(1).max(200).default("Measurement"),
      property_id: z.uuid().optional(),
      quote_id: z.uuid().optional(),
      request_id: z.uuid().optional(),
      areas: z
        .array(z.object({
          outline: z.array(point).min(3).max(500),
          item: item("area"),
          slope: z.enum(SLOPE_CHOICE_IDS as [string, ...string[]]).optional().describe("A lawn's slope, where none can be read (outside the US): flat (under 5%), hilly, or steep (much of it steeper than 3:1)."),
        }))
        .max(100)
        .default([]),
      cutouts: z.array(z.object({ outline: z.array(point).min(3).max(500), item: item("cutout") })).max(100).default([]),
      lines: z
        .array(z.object({ points: z.array(point).min(2).max(500), item: item("line"), edge: z.enum(ROOF_EDGES).optional().describe("A roof's edge, for drip edge and ridge cap.") }))
        .max(200)
        .default([]),
      counts: z.array(z.object({ at: point, item: item("count") })).max(MAX_SHAPES).default([]),
      roof_pitch: z.string().trim().max(20).optional().describe('A roof\'s pitch, like "6/12": its squares and the sloped lengths of rakes, hips and valleys follow it.'),
      waste_pct: z.number().min(0).max(100).default(0).describe("A roof's waste, in percent."),
      depth_in: z.number().positive().max(48).optional().describe("Depth in inches, for mulch, stone or asphalt formulas that read depth_in."),
      ...companyArg,
    }),
    run: async (ctx, a) => {
      requireRole(ctx, [...SALES, "crew_lead"]);
      const shapes = a.areas.length + a.cutouts.length + a.lines.length + a.counts.length;
      if (!shapes) throw new Error("Give at least one shape: an area, a cutout, a line or a count.");
      if (shapes > MAX_SHAPES) throw new Error(`That's ${shapes} shapes; a drawing holds up to ${MAX_SHAPES}.`);
      // Each item where its kind of shape can be it, with what to use instead when it can't.
      const check = (id: string | undefined, kind: Section["kind"], what: string) => {
        if (id && !itemFits(id, kind)) throw new Error(`${what}: "${id}" isn't an item it can be. ${kind === "Cutout" ? "A cutout" : `A${kind === "Area" ? "n area" : kind === "Length" ? " line" : " count"}`} can be ${itemsFor(kind === "Area" ? "area" : kind === "Cutout" ? "cutout" : kind === "Length" ? "line" : "count") || "none"}.`);
        return id ? { item: id } : {};
      };
      const areaItems = a.areas.map((s, n) => check(s.item, "Area", `Area ${n + 1}`));
      const cutItems = a.cutouts.map((s, n) => check(s.item, "Cutout", `Cutout ${n + 1}`));
      const lineItems = a.lines.map((s, n) => check(s.item, "Length", `Line ${n + 1}`));
      const countItems = a.counts.map((s, n) => check(s.item, "Count", `Count ${n + 1}`));
      const areas = a.areas.map((s) => polygon(s.outline));
      const cuts = a.cutouts.map((s) => polygon(s.outline));
      // A lawn: plain areas, no paving and no roof. Each area's slope, less what's cut out of it: null
      // outside the US, undefined when USGS didn't answer; a slope given stands in for either.
      const lawn = !a.roof_pitch && !a.lines.some((l) => l.edge) && ![...a.areas, ...a.cutouts, ...a.lines, ...a.counts].some((s) => pavingItem(s.item));
      // USGS is only asked in the United States: the property's country when it has one, else the business's.
      const property = lawn && a.property_id ? (await ctx.db.from("properties").select("country").eq("id", a.property_id).eq("company_id", ctx.companyId).maybeSingle()).data : null;
      const country = property?.country ?? businessCountry({ country: ctx.country, timezone: ctx.timezone });
      const read = await Promise.all(areas.map((g, n) => (lawn && !a.areas[n].item ? readSlope(g, cuts, { country }).catch(() => undefined) : Promise.resolve(null))));
      const slopes = read.map((r, n): GroundSlope | null | undefined => r ?? (a.areas[n].slope ? pickedSlope(a.areas[n].slope as "flat" | "hilly" | "steep") : r));
      const depth = a.depth_in ? { depth_in: a.depth_in } : {};
      const feature = (geometry: Geometry, properties: Record<string, unknown>): Feature => ({ type: "Feature", geometry, properties: { ...depth, ...properties } });
      const features = [
        ...areas.map((g, n) => feature(g, { ...areaItems[n], ...(slopes[n] ? { slope: slopes[n] } : {}) })),
        ...cuts.map((g, n) => feature(g, { cutout: true, ...cutItems[n] })),
        ...a.lines.map((l, n) => feature({ type: "LineString", coordinates: l.points }, { ...lineItems[n], ...(l.edge && isRoofEdge(l.edge) ? { edge: l.edge } : {}) })),
        ...a.counts.map((c, n) => feature({ type: "Point", coordinates: c.at }, countItems[n])),
      ];
      // Opened in Measure, the map starts on the first shape.
      const first = a.areas[0]?.outline ?? a.cutouts[0]?.outline ?? a.lines[0]?.points ?? [a.counts[0].at];
      const center = [first.reduce((t, p) => t + p[0], 0) / first.length, first.reduce((t, p) => t + p[1], 0) / first.length];
      const saved = await saveMeasurement(ctx.db, ctx.companyId, {
        title: a.title,
        property_id: a.property_id ?? null,
        quote_id: a.quote_id ?? null,
        request_id: a.request_id ?? null,
        provider: ASSISTANT_PROVIDER,
        geojson: { type: "FeatureCollection", features },
        roof_pitch: a.roof_pitch ?? null,
        waste_pct: a.waste_pct,
        view: { center, zoom: 19 },
      });
      const lawnAreas = slopes.flatMap((s, n) => (lawn && !a.areas[n].item ? [{ s, n }] : []));
      const unread = lawnAreas.filter(({ s }) => s === undefined).map(({ n }) => n + 1);
      const abroad = lawnAreas.some(({ s }) => s === null);
      return {
        id: saved.id,
        link: link(ctx, saved.id),
        area_sqft: saved.summary.total_area_sqft,
        length_ft: saved.summary.total_length_ft,
        ...(saved.squares !== null ? { squares: saved.squares } : {}),
        values: valuesOf({ total_area_sqft: saved.summary.total_area_sqft, total_area_sqyd: saved.summary.total_area_sqyd, total_length_ft: saved.summary.total_length_ft, sections: saved.summary.sections, roof_pitch: a.roof_pitch ?? null, waste_pct: a.waste_pct }),
        ...(abroad
          ? { slope_note: "No slope reading outside the US: give each lawn's slope (flat, hilly or steep), or the person picks it on the lawn's card in Measure." }
          : unread.length
            ? { slope_note: `USGS didn't answer for area ${unread.join(", ")}; opening the drawing in Measure reads it again.` }
            : {}),
      };
    },
  }),

  fill_quote_from_measurement: tool({
    description:
      "Price a quote's lines from a saved drawing with the price list's formulas, as Fill quantities from this does on the quote: each line from a price list item with a formula gets its quantity or price (mowing from the lawn's size and steep_pct, trim-around from trees and obstacles, sealcoat from sealcoat_sqft, shingles from squares, and so on). A line whose formula needs a value the drawing doesn't have says so and keeps what it had. Add the lines first (update_quote with service_id); the drawing becomes the quote's.",
    area: "quotes",
    input: z.object({
      quote_id: z.uuid(),
      measurement_id: z.uuid(),
      line_ids: z.array(z.uuid()).min(1).max(500).optional().describe("Only these lines; every line with a formula when left out."),
      ...companyArg,
    }),
    run: async (ctx, a) => {
      requireRole(ctx, SALES, "sales");
      const { variables, lines } = await applyMeasurement(ctx.db, ctx.companyId, a.quote_id, a.measurement_id, undefined, a.line_ids);
      // The values the drawing has, without the many that are zero or missing for it.
      return { lines, values: Object.fromEntries(Object.entries(variables).filter(([, v]) => v !== null && v !== 0)) };
    },
  }),
};
