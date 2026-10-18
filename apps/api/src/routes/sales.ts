/**
 * The request -> quote -> job -> invoice workflow, measurements and quote formulas.
 * Plain reads and edits (lists, forms) go straight to Supabase from the browser; these routes are
 * the steps with rules, side effects or secrets.
 */
import {
  evaluateFormula,
  FormulaError,
  OFFICE,
  pitchFactor,
  roofingSquares,
  SALES,
  summarizeFeatureCollection,
  validateFormula,
  type FeatureCollection,
  type FormulaVariable,
  type MeasurementSummary,
} from "@crewtavo/core";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { syncStripeInvoice } from "../integrations/stripe";
import { requireCompany, requireUser } from "../lib/auth";
import { runInBackground } from "../lib/background";
import { adminClient } from "../lib/supabase";
import { appUrl, asJson, dbError, HttpError, must, param, readJson, requireEnv, uuid } from "../lib/http";
import { firstName, isEmail, renderEmail } from "../lib/email";
import { clientLink } from "../lib/links";
import { sendEmail, sendSms } from "../lib/notify";
import { companyAddress } from "../services/automations";
import { roofSegments } from "../services/external";

export const sales = new Hono<AppEnv>();

// ---------------------------------------------------------------------------------------------
// Requests and quotes
// ---------------------------------------------------------------------------------------------

/** Start a draft quote from a request, carrying over the client, property and any measurement. */
sales.post("/requests/:id/quote", requireUser, requireCompany(SALES, "sales"), async (c) => {
  const id = param(c, "id");
  const { db, companyId } = c.var;
  const request = must(await db.from("requests").select("id, client_id, property_id, title, details").eq("id", id).eq("company_id", companyId).maybeSingle(), "Request not found.");
  const company = must(await db.from("companies").select("settings").eq("id", companyId).maybeSingle());
  const taxRate = Number((company.settings as { default_tax_rate?: number } | null)?.default_tax_rate ?? 0);
  const quote = must(
    await db
      .from("quotes")
      .insert({ company_id: companyId, client_id: request.client_id, property_id: request.property_id, request_id: request.id, title: request.title, tax_rate: taxRate })
      .select("id, number")
      .single(),
  );
  await Promise.all([
    db.from("requests").update({ status: "quoted" }).eq("id", id),
    db.from("measurements").update({ quote_id: quote.id }).eq("request_id", id).is("quote_id", null),
  ]);
  return c.json(quote, 201);
});

/** A saved measurement's roof slope, or null when its pitch doesn't read (formulas that use it say so). */
function savedPitchFactor(pitch: string | null): number | null {
  try {
    return pitchFactor(pitch);
  } catch {
    return null;
  }
}

/**
 * Fill quote line quantities (or prices) from a measurement using each line's formula.
 * Variables: area_sqft, area_sqyd, length_ft, count, depth_in, pitch_factor, waste, waste_pct.
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
  const sections = (m.sections ?? []) as Array<{ kind: string; depth_in?: number | null }>;
  // Every value a formula may use (FORMULA_VARIABLES), and nothing else.
  const vars: Record<FormulaVariable, number | null> = {
    area_sqft: Number(m.total_area_sqft),
    area_sqyd: Number(m.total_area_sqyd),
    length_ft: Number(m.total_length_ft),
    count: sections.filter((s) => s.kind === "Count").length,
    depth_in: body.depth_in ?? sections.find((s) => s.depth_in)?.depth_in ?? null,
    pitch_factor: savedPitchFactor(m.roof_pitch),
    waste: Number(m.waste_pct) / 100,
    waste_pct: Number(m.waste_pct),
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

const sendSchema = z.object({
  channel: z.enum(["email", "sms", "link"]).default("email"),
  to: z.string().trim().max(200).optional(), // defaults to the client's email or phone
  subject: z.string().trim().max(200).optional(),
  message: z.string().max(4000).optional(),
});

async function deliver(
  c: Parameters<typeof appUrl>[0],
  kind: "quote" | "invoice",
  record: { id: string; number: number | null; client_id: string; total?: number; balance_due?: number; client: { display_name: string; email: string | null; phone: string | null } | null },
  body: z.infer<typeof sendSchema>,
) {
  const company = must(await c.var.db.from("companies").select("name, email, phone, address, currency").eq("id", c.var.companyId).maybeSingle());
  const link = await clientLink(c.env, appUrl(c), { c: c.var.companyId, t: kind, id: record.id });
  const label = `${kind === "quote" ? "Quote" : "Invoice"} #${record.number}`;
  const amount = new Intl.NumberFormat("en-US", { style: "currency", currency: company.currency || "USD" }).format(Number(kind === "quote" ? record.total ?? 0 : record.balance_due ?? 0));
  const greeting = `Hi ${firstName(record.client?.display_name)},`;
  const intro = body.message?.trim() || (kind === "quote" ? `Thanks for the opportunity. Here's your quote (${amount}). You can review the details, choose any options and approve it online:` : `Here's your invoice for ${amount}. You can view and pay it online:`);
  const text = `${greeting}\n\n${intro}\n\n${link}\n\nThanks,\n${company.name}`;
  let result: { sent: boolean; reason?: string; id?: string } = { sent: false, reason: "Link only" };
  if (body.channel === "email") {
    const to = body.to || record.client?.email;
    if (!to || !isEmail(to)) throw new HttpError(400, "Add a valid email address for this client first.");
    const subject = body.subject || `${label} from ${company.name}`;
    const footer = [company.name, companyAddress(company.address as Record<string, string>), company.phone].filter(Boolean).join(" · ");
    result = await sendEmail(c.env, { to, subject, ...renderEmail({ companyName: company.name, text, footer }), replyTo: company.email ?? undefined, fromName: company.name }, c.var.companyId);
  } else if (body.channel === "sms") {
    const to = body.to || record.client?.phone;
    if (!to) throw new HttpError(400, "This client has no phone number.");
    result = await sendSms(c.env, { to, body: `${company.name}: ${intro} ${link}` });
  }
  if (result.sent) {
    await c.var.db.from("messages").insert({
      company_id: c.var.companyId,
      client_id: record.client_id,
      channel: body.channel,
      subject: body.channel === "email" ? body.subject || label : label,
      body: text,
      related_type: kind,
      related_id: record.id,
      external_id: result.id ?? null,
    });
  }
  return { link, ...result };
}

sales.post("/quotes/:id/send", requireUser, requireCompany(SALES, "sales"), async (c) => {
  const id = param(c, "id");
  const body = await readJson(c, sendSchema);
  const quote = must(
    await c.var.db.from("quotes").select("id, number, status, total, client_id, client:clients(display_name, email, phone), lines:quote_line_items(id)").eq("id", id).eq("company_id", c.var.companyId).maybeSingle(),
    "Quote not found.",
  );
  if (["converted", "lost", "archived"].includes(quote.status)) throw new HttpError(400, `This quote is ${quote.status}, so it can't be sent.`);
  if (!quote.lines.length) throw new HttpError(400, "Add at least one line item before sending.");
  const result = await deliver(c, "quote", quote, body);
  // Sent, or the office took the link to share themselves: the quote is now with the client.
  if (result.sent || body.channel === "link") {
    await c.var.db.from("quotes").update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", id).in("status", ["draft", "changes_requested"]);
  }
  return c.json(result);
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
  const jobs = must(await c.var.db.from("jobs").select("id, number, title, kind, billing_mode").eq("company_id", c.var.companyId).in("id", body.job_ids));
  const results: Array<{ job_id: string; number: number | null; ok: boolean; invoice_id?: string; sent?: boolean; error?: string }> = [];
  for (const job of jobs) {
    const kind = job.billing_mode === "per_visit" || job.kind === "recurring" ? "visits" : "standard";
    const created = await c.var.db.rpc("create_invoice_for_job", { p_job: job.id, p_kind: kind });
    if (created.error) {
      results.push({ job_id: job.id, number: job.number, ok: false, error: dbError(created.error).message });
      continue;
    }
    const invoiceId = created.data as string;
    let sent = false;
    let error: string | undefined;
    if (body.send) {
      const invoice = must(await c.var.db.from("invoices").select("id, number, status, total, balance_due, client_id, client:clients(display_name, email, phone)").eq("id", invoiceId).maybeSingle());
      try {
        const result = await deliver(c, "invoice", invoice, { channel: "email" });
        sent = result.sent;
        if (sent) await c.var.db.from("invoices").update({ status: "sent" }).eq("id", invoiceId);
        else error = result.reason ?? "Not sent";
      } catch (e) {
        error = e instanceof HttpError ? e.message : "Couldn't send it";
      }
    }
    results.push({ job_id: job.id, number: job.number, ok: true, invoice_id: invoiceId, sent, error });
  }
  return c.json({ results });
});

// Friendly reminders for unpaid invoices, by email.
sales.post("/invoices/remind", requireUser, requireCompany(OFFICE, "invoices"), async (c) => {
  const body = await readJson(c, z.object({ invoice_ids: z.array(uuid).min(1).max(100) }));
  const company = must(await c.var.db.from("companies").select("name, currency").eq("id", c.var.companyId).maybeSingle());
  const invoices = must(
    await c.var.db
      .from("invoices")
      .select("id, number, status, total, balance_due, due_on, client_id, client:clients(display_name, email, phone)")
      .eq("company_id", c.var.companyId)
      .in("id", body.invoice_ids)
      .in("status", ["sent", "partially_paid", "overdue"]),
  );
  let sent = 0;
  const skipped: Array<{ number: number | null; reason: string }> = [];
  // Don't ask again while a bank payment is on its way.
  const { data: paying } = await c.var.db.from("stripe_invoices").select("invoice_id").eq("company_id", c.var.companyId).eq("status", "processing").in("invoice_id", invoices.map((i) => i.id));
  const processing = new Set((paying ?? []).map((row) => row.invoice_id));
  for (const invoice of invoices) {
    if (Number(invoice.balance_due) <= 0) continue;
    if (processing.has(invoice.id)) {
      skipped.push({ number: invoice.number, reason: "A bank payment is on its way" });
      continue;
    }
    const amount = new Intl.NumberFormat("en-US", { style: "currency", currency: company.currency || "USD" }).format(Number(invoice.balance_due));
    const due = invoice.due_on ? new Date(`${invoice.due_on}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" }) : null;
    try {
      const result = await deliver(c, "invoice", invoice, {
        channel: "email",
        subject: `Reminder: invoice #${invoice.number} from ${company.name}`,
        message: `A friendly reminder that ${amount} is still owed on invoice #${invoice.number}${due ? `, which was due ${due}` : ""}. You can view and pay it online:`,
      });
      if (result.sent) sent++;
      else skipped.push({ number: invoice.number, reason: result.reason ?? "Not sent" });
    } catch (e) {
      skipped.push({ number: invoice.number, reason: e instanceof HttpError ? e.message : "Couldn't send it" });
    }
  }
  return c.json({ sent, skipped });
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
  const id = param(c, "id");
  const body = await readJson(c, sendSchema);
  const invoice = must(
    await c.var.db.from("invoices").select("id, number, status, total, balance_due, client_id, client:clients(display_name, email, phone), lines:invoice_line_items(id)").eq("id", id).eq("company_id", c.var.companyId).maybeSingle(),
    "Invoice not found.",
  );
  if (invoice.status === "void") throw new HttpError(400, "This invoice is void.");
  if (!invoice.lines.length) throw new HttpError(400, "Add at least one line item before sending.");
  const result = await deliver(c, "invoice", invoice, body);
  if (invoice.status === "draft" && (result.sent || body.channel === "link")) {
    await c.var.db.from("invoices").update({ status: "sent" }).eq("id", id);
    // Put it in Stripe now rather than at the next outbox run, so the client's Pay button is ready.
    runInBackground(c, syncStripeInvoice(c.env, adminClient(c.env), c.var.companyId, id));
  }
  return c.json(result);
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

sales.post("/measurements", requireUser, requireCompany([...SALES, "crew_lead"]), async (c) => {
  const body = await readJson(
    c,
    z.object({
      id: uuid.optional(),
      title: z.string().trim().min(1).max(200).default("Measurement"),
      property_id: uuid.nullable().optional(),
      request_id: uuid.nullable().optional(),
      quote_id: uuid.nullable().optional(),
      provider: z.string().max(40).default("google"),
      geojson: featureCollection,
      roof_pitch: z.string().max(20).nullable().optional(),
      waste_pct: z.number().min(0).max(100).default(0),
    }),
  );
  // Totals always come from the shapes, recomputed here; nothing the browser computed is trusted.
  let summary: MeasurementSummary;
  try {
    summary = summarizeFeatureCollection(body.geojson as FeatureCollection);
  } catch (error) {
    if (error instanceof RangeError) throw new HttpError(400, error.message);
    throw error;
  }
  let squares: number | null = null;
  try {
    squares = body.roof_pitch ? Math.round(roofingSquares(summary.total_area_sqft, body.roof_pitch, body.waste_pct) * 100) / 100 : null;
  } catch {
    throw new HttpError(400, "Roof pitch should look like 7/12.");
  }
  const { id, ...fields } = body;
  const row = {
    ...fields,
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
