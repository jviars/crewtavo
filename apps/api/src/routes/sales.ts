/**
 * The request -> quote -> job -> invoice workflow, measurements and quote formulas.
 * Plain reads and edits (lists, forms) go straight to Supabase from the browser; these routes are
 * the steps with rules, side effects or secrets.
 */
import {
  drawingPitchFactor,
  drawingSquares,
  edgeLengths,
  evaluateFormula,
  FormulaError,
  normalizePitch,
  OFFICE,
  pavingQuantities,
  pitchProblem,
  SALES,
  summarizeFeatureCollection,
  validateFormula,
  type FeatureCollection,
  type FormulaVariable,
  type MeasurementSummary,
  type Section,
} from "@crewtavo/core";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { requireCompany, requireUser } from "../lib/auth";
import { appUrl, asJson, dbError, HttpError, must, param, readJson, requireEnv, uuid } from "../lib/http";
import { clientLink } from "../lib/links";
import { roofSegments } from "../services/external";
import { invoiceJobs, quoteFromRequest, remindInvoices, sendInvoice, sendQuote, sendSchema, type SalesScope } from "../services/sales";

export const sales = new Hono<AppEnv>();

/** The person's client, their company, and the address client links use (services/sales.ts). */
const scope = (c: Context<AppEnv>): SalesScope => ({ db: c.var.db, env: c.env, companyId: c.var.companyId, baseUrl: appUrl(c) });

// ---------------------------------------------------------------------------------------------
// Requests and quotes
// ---------------------------------------------------------------------------------------------

/** Start a draft quote from a request, carrying over the client, property and any measurement. */
sales.post("/requests/:id/quote", requireUser, requireCompany(SALES, "sales"), async (c) => {
  return c.json(await quoteFromRequest(scope(c), param(c, "id")), 201);
});

/**
 * A saved measurement's roof slope (weighted by area when its sections have their own pitches), or
 * null when a pitch doesn't read (formulas that use it say so).
 */
function savedPitchFactor(sections: Section[], pitch: string | null): number | null {
  try {
    return drawingPitchFactor({ sections }, pitch);
  } catch {
    return null;
  }
}

/**
 * Fill quote line quantities (or prices) from a measurement using each line's formula.
 * Variables: FORMULA_VARIABLES (area_sqft, length_ft, pitch_factor, the roof edges and so on).
 */
sales.post("/quotes/:id/apply-measurement", requireUser, requireCompany(SALES, "sales"), async (c) => {
  const id = param(c, "id");
  const body = await readJson(c, z.object({ measurement_id: uuid, depth_in: z.number().positive().max(48).optional() }));
  const { db, companyId } = c.var;
  const m = must(
    await db
      .from("measurements")
      .select("total_area_sqft, total_area_sqyd, total_length_ft, sections, roof_pitch, waste_pct")
      .eq("id", body.measurement_id)
      .eq("company_id", companyId)
      .maybeSingle(),
    "Measurement not found.",
  );
  const sections = (m.sections ?? []) as unknown as Section[];
  const edges = edgeLengths({ sections });
  // Every value a formula may use (FORMULA_VARIABLES), and nothing else.
  const vars: Record<FormulaVariable, number | null> = {
    area_sqft: Number(m.total_area_sqft),
    area_sqyd: Number(m.total_area_sqyd),
    length_ft: Number(m.total_length_ft),
    count: sections.filter((s) => s.kind === "Count").length,
    depth_in: body.depth_in ?? sections.find((s) => s.depth_in)?.depth_in ?? null,
    pitch_factor: savedPitchFactor(sections, m.roof_pitch),
    waste: Number(m.waste_pct) / 100,
    waste_pct: Number(m.waste_pct),
    eave_ft: edges.eave,
    rake_ft: edges.rake,
    ridge_ft: edges.ridge,
    hip_ft: edges.hip,
    valley_ft: edges.valley,
    // A paving takeoff's items: asphalt, striping, stalls and the rest.
    ...pavingQuantities(sections),
  };

  const lines = must(await db.from("quote_line_items").select("id, name, formula, service:services(formula_target)").eq("quote_id", id));
  const results: Array<{ id: string; name: string; field?: string; value?: number; error?: string }> = [];
  for (const line of lines as Array<{ id: string; name: string; formula: string | null; service: { formula_target: string } | null }>) {
    if (!line.formula) continue;
    try {
      const value = Math.round(evaluateFormula(line.formula, vars) * 1000) / 1000;
      const field = line.service?.formula_target === "unit_price" ? "unit_price" : "quantity";
      const change = field === "unit_price" ? { unit_price: Math.round(value * 100) / 100 } : { quantity: value };
      const { error } = await db.from("quote_line_items").update(change).eq("id", line.id);
      if (error) throw dbError(error);
      results.push({ id: line.id, name: line.name, field, value });
    } catch (error) {
      if (!(error instanceof FormulaError)) throw error;
      results.push({ id: line.id, name: line.name, error: error.message });
    }
  }
  await db.from("measurements").update({ quote_id: id }).eq("id", body.measurement_id);
  return c.json({ variables: vars, lines: results });
});

sales.post("/quotes/:id/convert", requireUser, requireCompany(SALES, "sales"), async (c) => {
  const { data, error } = await c.var.db.rpc("convert_quote_to_job", { p_quote: param(c, "id") });
  if (error) throw dbError(error);
  return c.json({ job_id: data }, 201);
});

sales.post("/quotes/:id/send", requireUser, requireCompany(SALES, "sales"), async (c) => {
  return c.json(await sendQuote(scope(c), param(c, "id"), await readJson(c, sendSchema)));
});

/** The client's link for a quote or invoice, without sending it or changing its status (preview, PDF). */
sales.get("/:kind{quotes|invoices}/:id/link", requireUser, requireCompany(SALES), async (c) => {
  const kind = c.req.param("kind") === "quotes" ? "quote" : "invoice";
  const id = param(c, "id");
  const table = kind === "quote" ? "quotes" : "invoices";
  must(await c.var.db.from(table).select("id").eq("id", id).eq("company_id", c.var.companyId).maybeSingle(), `${kind === "quote" ? "Quote" : "Invoice"} not found.`);
  // A one-day preview link that also works while the document is still a draft.
  return c.json({ link: await clientLink(c.env, appUrl(c), { c: c.var.companyId, t: kind, id, pv: 1 }, 1) });
});

// ---------------------------------------------------------------------------------------------
// Jobs and invoices
// ---------------------------------------------------------------------------------------------

sales.post("/jobs/:id/invoice", requireUser, requireCompany(OFFICE, "invoices"), async (c) => {
  const body = await readJson(c, z.object({ kind: z.enum(["standard", "deposit", "progress", "visits", "retainage"]).default("standard"), amount: z.number().positive().max(100_000_000).optional() }));
  const { data, error } = await c.var.db.rpc("create_invoice_for_job", { p_job: param(c, "id"), p_kind: body.kind, ...(body.amount ? { p_amount: body.amount } : {}) });
  if (error) throw dbError(error);
  return c.json({ invoice_id: data }, 201);
});

// Batch invoicing: one invoice per finished job (completed visits for per-visit jobs), and
// optionally email each one. Each job succeeds or fails on its own.
sales.post("/invoices/batch", requireUser, requireCompany(OFFICE, "invoices"), async (c) => {
  const body = await readJson(c, z.object({ job_ids: z.array(uuid).min(1).max(50), send: z.boolean().default(false) }));
  return c.json(await invoiceJobs(scope(c), body.job_ids, body.send));
});

// Friendly reminders for unpaid invoices, by email.
sales.post("/invoices/remind", requireUser, requireCompany(OFFICE, "invoices"), async (c) => {
  const body = await readJson(c, z.object({ invoice_ids: z.array(uuid).min(1).max(100) }));
  return c.json(await remindInvoices(scope(c), body.invoice_ids));
});

// Promo codes: the database checks the code's rules and recalculates the totals.
const promoBody = z.object({ code: z.string().trim().min(1, "Enter a promo code.").max(40) });
for (const [path, kind, roles, area] of [["quotes", "quote", SALES, "sales"], ["invoices", "invoice", OFFICE, "invoices"]] as const) {
  sales.post(`/${path}/:id/promo`, requireUser, requireCompany(roles, area), async (c) => {
    const { code } = await readJson(c, promoBody);
    const { data, error } = await c.var.db.rpc("apply_promo_code", { p_kind: kind, p_id: param(c, "id"), p_code: code });
    if (error) throw dbError(error);
    return c.json(data as Record<string, unknown>);
  });
  sales.delete(`/${path}/:id/promo`, requireUser, requireCompany(roles, area), async (c) => {
    const { error } = await c.var.db.rpc("remove_promo_code", { p_kind: kind, p_id: param(c, "id") });
    if (error) throw dbError(error);
    return c.json({ ok: true });
  });
}

sales.post("/invoices/:id/send", requireUser, requireCompany(OFFICE, "invoices"), async (c) => {
  return c.json(await sendInvoice(scope(c), param(c, "id"), await readJson(c, sendSchema)));
});

// ---------------------------------------------------------------------------------------------
// Measurements
// ---------------------------------------------------------------------------------------------

const featureCollection = z.object({
  type: z.literal("FeatureCollection"),
  features: z
    .array(
      z.object({
        type: z.literal("Feature"),
        id: z.union([z.string(), z.number()]).optional(),
        // The points are checked shape by shape in summarizeFeatureCollection.
        geometry: z.object({ type: z.enum(["Polygon", "MultiPolygon", "LineString", "Point", "MultiPoint"]), coordinates: z.unknown() }),
        properties: z.record(z.string(), z.unknown()).nullable().optional(),
      }),
    )
    .max(500),
});

/** Where the map was when the drawing was saved, so reopening it starts there. */
const lngLat = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);
const mapView = z.object({
  center: lngLat,
  zoom: z.number().min(0).max(24),
  imagery: z.string().max(40).optional(),
  // Auto, or a source someone picked; and slope or contours on top.
  mode: z.enum(["auto", "manual"]).optional(),
  overlays: z.array(z.string().max(20)).max(5).optional(),
  attribution: z.string().max(300).optional(),
  // A plan sheet lined up on the map (apps/web/src/features/measure/PlanOnMap.tsx): which file and
  // page, where its corners are, and the size of the picture those corners were worked out for.
  plan: z
    .object({
      id: uuid,
      page: z.number().int().min(1).max(10_000),
      corners: z.tuple([lngLat, lngLat, lngLat, lngLat]),
      size: z.tuple([z.number().positive().max(100_000), z.number().positive().max(100_000)]),
      opacity: z.number().min(0).max(1),
      paper: z.boolean(),
      hidden: z.boolean().optional(),
    })
    .optional(),
});

sales.post("/measurements", requireUser, requireCompany([...SALES, "crew_lead"]), async (c) => {
  const body = await readJson(
    c,
    z.object({
      id: uuid.optional(),
      title: z.string().trim().min(1).max(200).default("Measurement"),
      property_id: uuid.nullable().optional(),
      request_id: uuid.nullable().optional(),
      quote_id: uuid.nullable().optional(),
      invoice_id: uuid.nullable().optional(),
      provider: z.string().max(40).default("naip"),
      geojson: featureCollection,
      roof_pitch: z.string().max(20).nullable().optional(),
      waste_pct: z.number().min(0).max(100).default(0),
      view: mapView.optional(),
      // The picture of the drawing the browser just uploaded. Left out, the saved one stays.
      snapshot_path: z.string().max(200).optional(),
    }),
  );
  if (body.snapshot_path && !new RegExp(`^${c.var.companyId}/measurements/[0-9a-f-]{36}\\.(jpg|png)$`).test(body.snapshot_path)) {
    throw new HttpError(400, "That map picture isn't one of this company's.");
  }
  // Totals always come from the shapes, recomputed here; nothing the browser computed is trusted.
  // Cutouts come off the areas under them, and each roof section can have its own pitch.
  let summary: MeasurementSummary;
  try {
    summary = summarizeFeatureCollection(body.geojson as FeatureCollection, { pitch: body.roof_pitch });
  } catch (error) {
    if (error instanceof RangeError) throw new HttpError(400, error.message);
    throw error;
  }
  const problem = pitchProblem(summary, body.roof_pitch);
  if (problem) throw new HttpError(400, problem);
  const raw = drawingSquares(summary, body.roof_pitch, body.waste_pct);
  const squares = raw === null ? null : Math.round(raw * 100) / 100;
  // As much as the columns hold: under a trillion square feet or feet, a hundred million squares.
  if (summary.total_area_sqft >= 1e12 || summary.total_length_ft >= 1e12 || (squares ?? 0) >= 1e8) {
    throw new HttpError(400, "This measurement is too large to save. Check the shapes and measured values.");
  }
  const { id, view, ...fields } = body;
  const row = {
    ...fields,
    // Written the one way ("4/12" for 4-12 or 4:12), so the quote and the client read the same.
    roof_pitch: fields.roof_pitch ? normalizePitch(fields.roof_pitch) : fields.roof_pitch,
    ...(view ? { view: asJson(view) } : {}),
    geojson: asJson(fields.geojson),
    company_id: c.var.companyId,
    sections: asJson(summary.sections),
    total_area_sqft: summary.total_area_sqft,
    total_area_sqyd: summary.total_area_sqyd,
    total_length_ft: summary.total_length_ft,
    roofing_squares: squares,
  };
  const result = id
    ? await c.var.db.from("measurements").update(row).eq("id", id).eq("company_id", c.var.companyId).select("id").maybeSingle()
    : await c.var.db.from("measurements").insert(row).select("id").single();
  const saved = must(result, "Measurement not found.");
  return c.json({ id: saved.id, ...summary, roofing_squares: squares }, id ? 200 : 201);
});

sales.post("/formulas/evaluate", requireUser, requireCompany(), async (c) => {
  const body = await readJson(c, z.object({ formula: z.string().max(300), variables: z.record(z.string(), z.number().nullable()) }));
  try {
    // Only values a measurement supplies, so a formula that checks out here works on quotes.
    validateFormula(body.formula);
    return c.json({ value: evaluateFormula(body.formula, body.variables) });
  } catch (error) {
    if (error instanceof FormulaError) throw new HttpError(400, error.message);
    throw error;
  }
});

/** Roof planes and suggested pitch from Google's Solar API. */
sales.post("/roof-insights", requireUser, requireCompany(SALES, "sales"), async (c) => {
  const body = await readJson(c, z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) }));
  const key = requireEnv(c.env, "GOOGLE_MAPS_SERVER_KEY", "Roof insights");
  const result = await roofSegments(key, body.lat, body.lng);
  if (!result) throw new HttpError(404, "Google has no roof data for this location. Measure the pitch on site.");
  return c.json(result);
});
