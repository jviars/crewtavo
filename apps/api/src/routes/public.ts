/**
 * No-account routes: the Client Hub (signed quote/invoice links), public booking forms, and the
 * Stripe webhooks. These use the admin client, so every query filters by the company in the link
 * or form, and responses include only client-facing fields (never costs or internal notes).
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { handleStripeEvent, hubPayment, stripeAccess, stripeCheckout, type WebhookRoute } from "../integrations/stripe";
import { kickAutomations, runInBackground } from "../lib/background";
import { geocodeAddress } from "../services/external";
import { firstName } from "../lib/email";
import { appUrl, asJson, dbError, HttpError, must, readJson, uuid } from "../lib/http";
import { allow } from "../lib/limit";
import { clientLink, readClientLink, type LinkKind } from "../lib/links";
import { adminClient } from "../lib/supabase";
import { clientIp } from "../lib/visitor";
import { buildCalendar } from "../lib/ics";
import { StripeError, verifyStripeSignature, type StripeEvent } from "../services/stripe";

export const publicRoutes = new Hono<AppEnv>();

async function link(c: Parameters<typeof appUrl>[0], kinds: LinkKind[] = ["quote", "invoice", "client"]) {
  const payload = await readClientLink(c.env, c.req.param("token") ?? "");
  if (!payload || !kinds.includes(payload.t)) throw new HttpError(404, "This link has expired or isn't valid. Ask for a new one.");
  return payload;
}

/** Locate a new property in the background so routing and weather checks work for it. */
function geocodeLater(c: Parameters<typeof appUrl>[0], propertyId: string, address: { line1: string; city?: string; postal_code?: string }) {
  runInBackground(
    c,
    (async () => {
      const hit = await geocodeAddress([address.line1, address.city, address.postal_code].filter(Boolean).join(", "), c.env.GOOGLE_MAPS_SERVER_KEY);
      if (hit) await adminClient(c.env).from("properties").update({ lat: hit.lat, lng: hit.lng }).eq("id", propertyId);
    })(),
  );
}

/**
 * Booking forms, referrals and "request work" each make a request and tell the office, and the
 * first two add a client and look up the address (a billed Google call). So a script can't send
 * them by the thousand: a few an hour from one visitor, and a hundred an hour for each company.
 */
async function limitSubmissions(c: Parameters<typeof appUrl>[0], kind: "form" | "referral" | "hub-request", companyId: string) {
  if (!(await allow(c.env, `${kind}:ip:${clientIp(c)}`, 10, 60 * 60)) || !(await allow(c.env, `${kind}:company:${companyId}`, 100, 60 * 60))) {
    throw new HttpError(429, "Too many requests. Try again later, or call us.");
  }
}

async function verifyTurnstile(c: Parameters<typeof appUrl>[0], token: string | undefined) {
  if (!c.env.TURNSTILE_SECRET_KEY) return;
  const verify = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: new URLSearchParams({ secret: c.env.TURNSTILE_SECRET_KEY, response: token ?? "" }),
  }).catch(() => null);
  const result = verify ? ((await verify.json()) as { success?: boolean }) : { success: false };
  if (!result.success) throw new HttpError(400, "Please complete the verification and try again.");
}

const BRANDING = "name, phone, email, website, timezone, settings->branding, settings->hub_tips";

/**
 * Map drawings the office chose to show on this quote or invoice: the sizes, and whether there's a
 * picture (served by /hub/:token/drawings/:id, never as a storage link).
 */
async function hubDrawings(admin: ReturnType<typeof adminClient>, companyId: string, on: "quote_id" | "invoice_id", id: string) {
  const { data } = await admin
    .from("measurements")
    .select("id, title, sections, total_area_sqft, total_length_ft, roofing_squares, roof_pitch, snapshot_path, view")
    .eq("company_id", companyId)
    .eq(on, id)
    .eq(on === "quote_id" ? "show_on_quote" : "show_on_invoice", true)
    .order("created_at");
  return (data ?? []).map((m) => ({
    id: m.id,
    title: m.title,
    has_picture: Boolean(m.snapshot_path),
    sections: ((m.sections ?? []) as Array<{ label: string; kind: string; value: number; unit: string }>).map((s) => ({ label: s.label, kind: s.kind, value: s.value, unit: s.unit })),
    total_area_sqft: m.total_area_sqft,
    total_length_ft: m.total_length_ft,
    roofing_squares: m.roofing_squares,
    roof_pitch: m.roof_pitch,
    imagery: ((m.view ?? {}) as { attribution?: string }).attribution ?? null,
  }));
}

publicRoutes.get("/hub/:token", async (c) => {
  const l = await link(c);
  const admin = adminClient(c.env);
  const company = must(await admin.from("companies").select(BRANDING).eq("id", l.c).maybeSingle());
  if (l.t === "client") return c.json(await clientHome(c, admin, l.c, l.id, company));
  if (l.t === "quote") {
    const quote = must(
      await admin
        .from("quotes")
        .select(
          "id, number, status, title, message, subtotal, discount_amount, tax_rate, tax_amount, total, deposit_amount, valid_until, approved_at, client_id, change_order_for, promo:promo_codes(code, kind, value, description), client:clients(display_name), property:properties(line1, city), lines:quote_line_items(id, name, description, quantity, unit, unit_price, taxable, optional, selected, option_group, sort)",
        )
        .eq("company_id", l.c)
        .eq("id", l.id)
        .maybeSingle(),
      "Quote not found.",
    );
    if (quote.status === "draft" && !l.pv) throw new HttpError(404, "This quote isn't ready yet.");
    (quote.lines as Array<{ sort: number }>).sort((a, b) => a.sort - b.sort);
    const drawings = await hubDrawings(admin, l.c, "quote_id", quote.id);
    return c.json({ kind: "quote", company, quote, drawings, preview: Boolean(l.pv), home: l.pv ? null : await homeLink(c, l.c, quote.client_id) });
  }
  const invoice = must(
    await admin
      .from("invoices")
      .select(
        "id, number, status, subject, notes, issued_on, due_on, subtotal, discount_amount, tax_amount, total, retainage_amount, amount_paid, balance_due, client_id, promo:promo_codes(code, kind, value, description), client:clients(display_name), lines:invoice_line_items(name, description, quantity, unit, unit_price, sort), payments(amount, tip_amount, received_at)",
      )
      .eq("company_id", l.c)
      .eq("id", l.id)
      .maybeSingle(),
    "Invoice not found.",
  );
  if ((invoice.status === "draft" && !l.pv) || invoice.status === "void") throw new HttpError(404, invoice.status === "void" ? "This invoice was cancelled. Contact us with any questions." : "This invoice isn't ready yet.");
  (invoice.lines as Array<{ sort: number }>).sort((a, b) => a.sort - b.sort);
  // The Hub lists what was paid and refunded against the total. A payment that was only a tip (or
  // the refund of one) doesn't change what's owed, so it isn't among them.
  invoice.payments = invoice.payments.filter((p) => Number(p.amount) !== 0);
  const online = await hubPayment(c.env, admin, l.c, invoice.id);
  // Invoices made in Stripe are paid exactly as Stripe billed them, so no tip.
  const tips = (company as { hub_tips?: unknown }).hub_tips === true && !online.imported;
  return c.json({
    kind: "invoice", company, invoice, preview: Boolean(l.pv), tips,
    drawings: await hubDrawings(admin, l.c, "invoice_id", invoice.id),
    can_pay: !l.pv && online.enabled && !online.processing && Number(invoice.balance_due) > 0,
    processing: online.processing,
    from_stripe: online.imported,
    home: l.pv ? null : await homeLink(c, l.c, invoice.client_id),
  });
});

publicRoutes.post("/hub/:token/approve", async (c) => {
  const l = await link(c);
  if (l.t !== "quote") throw new HttpError(400, "Only quotes can be approved.");
  if (l.pv) throw new HttpError(400, "A preview can't approve the quote. Only the client's own link can.");
  const body = await readJson(
    c,
    z.object({
      name: z.string().trim().min(2).max(120),
      selected_line_ids: z.array(z.uuid()).max(200).default([]),
      // Drawn on the screen (a small PNG); kept with the approval.
      signature: z.string().max(300_000).regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/).optional(),
    }),
  );
  const admin = adminClient(c.env);
  const quote = must(await admin.from("quotes").select("id, status").eq("company_id", l.c).eq("id", l.id).maybeSingle(), "Quote not found.");
  if (!["sent", "changes_requested"].includes(quote.status)) throw new HttpError(409, "This quote can't be approved anymore.");

  // One step in the database (20261018000830_hub_approval.sql): it claims the quote while it's still
  // waiting for an answer, then sets the optional lines to the client's choices and records the
  // approval with the amounts they came to. So two approvals at once, or one racing a change by the
  // office, record one, and only that one picks the options.
  const { data: approved, error } = await admin.rpc("approve_hub_quote", {
    p_company: l.c,
    p_quote: l.id,
    p_selected: body.selected_line_ids,
    p_approval: { name: body.name, selected_line_ids: body.selected_line_ids, signature: body.signature ?? null, signed_at: new Date().toISOString(), ip: clientIp(c) },
  });
  if (error) throw dbError(error);
  if (!approved) throw new HttpError(409, "This quote can't be approved anymore.");
  kickAutomations(c, l.c);
  return c.json({ status: "approved" });
});

publicRoutes.post("/hub/:token/request-changes", async (c) => {
  const l = await link(c);
  if (l.t !== "quote") throw new HttpError(400, "Only quotes can have changes requested.");
  if (l.pv) throw new HttpError(400, "A preview can't ask for changes. Only the client's own link can.");
  const body = await readJson(c, z.object({ message: z.string().trim().min(3).max(2000) }));
  const admin = adminClient(c.env);
  const quote = must(await admin.from("quotes").select("client_id, status").eq("company_id", l.c).eq("id", l.id).maybeSingle(), "Quote not found.");
  if (quote.status !== "sent") throw new HttpError(409, "This quote isn't waiting for a response.");
  await admin.from("messages").insert({
    company_id: l.c, client_id: quote.client_id, channel: "note", direction: "in", status: "received",
    subject: "Changes requested", body: body.message, related_type: "quote", related_id: l.id, sent_by: null,
  });
  await admin.from("quotes").update({ status: "changes_requested" }).eq("id", l.id);
  kickAutomations(c, l.c);
  return c.json({ status: "changes_requested" });
});

// ---------------------------------------------------------------------------------------------
// Promo codes in the Client Hub: on a quote waiting for an answer, or an invoice not yet paid.
// ---------------------------------------------------------------------------------------------



async function hubDocument(c: Parameters<typeof appUrl>[0]) {
  const l = await link(c, ["quote", "invoice"]);
  if (l.pv) throw new HttpError(400, "Promo codes can't be added from a preview.");
  const admin = adminClient(c.env);
  const table = l.t === "quote" ? "quotes" : "invoices";
  must(await admin.from(table).select("id").eq("company_id", l.c).eq("id", l.id).maybeSingle(), "This link isn't valid anymore.");
  return { l, admin, kind: l.t as "quote" | "invoice" };
}

publicRoutes.post("/hub/:token/promo", async (c) => {
  if (!(await allow(c.env, `promo:${clientIp(c)}`, 10, 10 * 60))) throw new HttpError(429, "Too many tries. Wait a few minutes and try again.");
  const { code } = await readJson(c, z.object({ code: z.string().trim().min(1, "Enter a promo code.").max(40) }));
  const { l, admin, kind } = await hubDocument(c);
  if (kind === "quote") {
    const quote = must(await admin.from("quotes").select("status").eq("id", l.id).maybeSingle());
    if (!["sent", "changes_requested"].includes(quote.status)) throw new HttpError(409, "This quote isn't waiting for a response.");
  }
  const { data, error } = await admin.rpc("apply_promo_code", { p_kind: kind, p_id: l.id, p_code: code });
  if (error) throw dbError(error);
  return c.json(data as Record<string, unknown>);
});

publicRoutes.delete("/hub/:token/promo", async (c) => {
  // Like putting one on: each change to what's owed is a new Stripe invoice for an invoice.
  if (!(await allow(c.env, `promo:${clientIp(c)}`, 10, 10 * 60))) throw new HttpError(429, "Too many tries. Wait a few minutes and try again.");
  const { l, admin, kind } = await hubDocument(c);
  const { error } = await admin.rpc("remove_promo_code", { p_kind: kind, p_id: l.id });
  if (error) throw dbError(error);
  return c.json({ ok: true });
});

/** Pay from the Client Hub: Stripe's page for this invoice, which a client can only pay once. */
publicRoutes.post("/hub/:token/pay", async (c) => {
  const l = await link(c);
  if (l.t !== "invoice" || l.pv) throw new HttpError(400, "Only invoices can be paid.");
  // Each try can void a Stripe invoice and make another, so a script can't keep at it.
  if (!(await allow(c.env, `pay:ip:${clientIp(c)}`, 20, 10 * 60)) || !(await allow(c.env, `pay:invoice:${l.id}`, 10, 10 * 60))) {
    throw new HttpError(429, "Too many tries. Wait a few minutes and try again.");
  }
  const body = await readJson(c, z.object({ tip: z.number().min(0).max(100_000).default(0) }).default({ tip: 0 }));
  const admin = adminClient(c.env);
  const company = must(await admin.from("companies").select("settings->hub_tips").eq("id", l.c).maybeSingle());
  const online = await hubPayment(c.env, admin, l.c, l.id);
  const tipCents = (company as { hub_tips?: unknown }).hub_tips === true && !online.imported ? Math.round(body.tip * 100) : 0;
  try {
    return c.json({ url: await stripeCheckout(c.env, admin, l.c, l.id, tipCents) });
  } catch (error) {
    if (!(error instanceof StripeError)) throw error;
    console.error("Stripe checkout failed", error);
    throw new HttpError(502, "Online payments aren't working right now. Try again in a few minutes, or contact us to pay.");
  }
});

// ---------------------------------------------------------------------------------------------
// Public booking forms: /book/:company/:form in the web app
// ---------------------------------------------------------------------------------------------

async function findForm(c: Parameters<typeof appUrl>[0]) {
  const admin = adminClient(c.env);
  const company = must(await admin.from("companies").select("id, name, phone, timezone").eq("slug", c.req.param("company") ?? "").maybeSingle(), "Form not found.");
  const form = must(
    await admin
      .from("intake_forms")
      .select("id, name, kind, questions, service_area_zips, lead_time_days, slot_minutes")
      .eq("company_id", company.id)
      .eq("slug", c.req.param("form") ?? "")
      .eq("active", true)
      .maybeSingle(),
    "Form not found.",
  );
  return { admin, company, form };
}

publicRoutes.post("/public/forms/:company/:form/promo", async (c) => {
  if (!(await allow(c.env, `promo:${clientIp(c)}`, 10, 10 * 60))) throw new HttpError(429, "Too many tries. Wait a few minutes and try again.");
  const { code } = await readJson(c, z.object({ code: z.string().trim().min(1, "Enter a promo code.").max(40) }));
  const { admin, company } = await findForm(c);
  const { data, error } = await admin.rpc("check_promo_code", { p_company: company.id, p_code: code });
  if (error) throw dbError(error);
  return c.json({ code: code.toUpperCase().replace(/\s/g, ""), offer: data });
});

publicRoutes.get("/public/forms/:company/:form", async (c) => {
  const { company, form } = await findForm(c);
  return c.json({ company: { name: company.name, phone: company.phone }, form: { name: form.name, kind: form.kind, questions: form.questions } });
});

// Answers to a form's questions: text, or the options picked. Sized well past what a form asks (up
// to 30 questions, 4,000 characters for a long answer), so a script can't store megabytes with each.
const formAnswers = z
  .record(z.string().max(100), z.union([z.string().max(4000), z.number(), z.boolean(), z.array(z.string().max(500)).max(50)]))
  .refine((answers) => Object.keys(answers).length <= 50 && JSON.stringify(answers).length <= 50_000, "Too many answers.");

publicRoutes.post("/public/forms/:company/:form", async (c) => {
  const body = await readJson(
    c,
    z.object({
      name: z.string().trim().min(2).max(120),
      email: z.email().optional(),
      phone: z.string().trim().min(7).max(30).optional(),
      address: z.object({ line1: z.string().trim().min(3).max(200), city: z.string().max(100).optional(), postal_code: z.string().max(12).optional() }),
      answers: formAnswers.default({}),
      promo_code: z.string().trim().max(40).optional(),
      turnstile_token: z.string().optional(),
    }),
  );
  if (!body.email && !body.phone) throw new HttpError(400, "Add an email or phone number so we can reach you.");

  await verifyTurnstile(c, body.turnstile_token);

  const { admin, company, form } = await findForm(c);
  await limitSubmissions(c, "form", company.id);
  const zips = (form.service_area_zips ?? []) as string[];
  // A code that doesn't check out is dropped rather than blocking the request.
  let promo: string | null = null;
  if (body.promo_code) {
    const { error } = await admin.rpc("check_promo_code", { p_company: company.id, p_code: body.promo_code });
    if (!error) promo = body.promo_code.toUpperCase().replace(/\s/g, "");
  }
  if (zips.length && !zips.includes((body.address.postal_code ?? "").slice(0, 5))) {
    throw new HttpError(400, `Sorry, ${company.name} doesn't serve that area yet.`);
  }

  const client = must(
    await admin
      .from("clients")
      .insert({ company_id: company.id, status: "lead", display_name: body.name, email: body.email, phone: body.phone, lead_source: "Website form" })
      .select("id")
      .single(),
  );
  const property = must(
    await admin
      .from("properties")
      .insert({ company_id: company.id, client_id: client.id, line1: body.address.line1, city: body.address.city, postal_code: body.address.postal_code })
      .select("id")
      .single(),
  );
  const request = must(
    await admin
      .from("requests")
      .insert({
        company_id: company.id, client_id: client.id, property_id: property.id, intake_form_id: form.id,
        source: "web_form", title: form.name, answers: asJson(body.answers), promo_code: promo, created_by: null,
      })
      .select("id, number")
      .single(),
  );
  geocodeLater(c, property.id, body.address);
  kickAutomations(c, company.id);
  return c.json({ ok: true, reference: request.number }, 201);
});

// ---------------------------------------------------------------------------------------------
// Stripe webhooks
// ---------------------------------------------------------------------------------------------

// Payments, refunds, disputes and deposits, and invoices made in Stripe (integrations/stripe.ts).
// A company with its own key has its own address and signing secret; STRIPE_WEBHOOK_SECRET is the
// deployment's.
async function stripeWebhook(c: Context<AppEnv>, route: WebhookRoute, secret: string | undefined) {
  if (!secret) throw new HttpError(501, "Stripe webhooks aren't configured.");
  const payload = await c.req.text();
  if (!(await verifyStripeSignature(payload, c.req.header("stripe-signature"), secret))) throw new HttpError(400, "Bad signature.");
  const admin = adminClient(c.env);
  const companyId = await handleStripeEvent(c.env, admin, route, JSON.parse(payload) as StripeEvent);
  if (companyId) kickAutomations(c, companyId);
  if (route.companyId) {
    await admin.from("integrations").update({ last_sync_at: new Date().toISOString(), last_error: null }).match({ company_id: route.companyId, provider: "stripe" });
  }
  return c.json({ received: true });
}

publicRoutes.post("/webhooks/stripe", (c) => stripeWebhook(c, {}, c.env.STRIPE_WEBHOOK_SECRET));

publicRoutes.post("/webhooks/stripe/:company", async (c) => {
  const companyId = c.req.param("company");
  if (!uuid.safeParse(companyId).success) throw new HttpError(404, "Not found");
  const access = await stripeAccess(c.env, adminClient(c.env), companyId);
  return stripeWebhook(c, { companyId }, access?.own ? access.webhookSecret : undefined);
});

// ---------------------------------------------------------------------------------------------
// Client Hub home: a client's open quotes, invoices and upcoming visits, and "request work"
// ---------------------------------------------------------------------------------------------

const homeLink = (c: Parameters<typeof appUrl>[0], companyId: string, clientId: string) => clientLink(c.env, appUrl(c), { c: companyId, t: "client", id: clientId });
const firstNames = (rows: Array<{ user_id: string }>, names: Map<string, string>) => rows.map((r) => names.get(r.user_id)).filter(Boolean) as string[];

async function clientHome(c: Parameters<typeof appUrl>[0], admin: ReturnType<typeof adminClient>, companyId: string, clientId: string, company: unknown) {
  const client = must(await admin.from("clients").select("id, display_name, properties(id, line1, city)").eq("company_id", companyId).eq("id", clientId).maybeSingle(), "This link isn't valid anymore.");
  const settings = must(await admin.from("companies").select("timezone, settings").eq("id", companyId).maybeSingle());
  const today = new Date().toLocaleDateString("en-CA", { timeZone: settings.timezone || "UTC" });
  const [quotes, invoices, jobs, payments, requests, services] = await Promise.all([
    admin.from("quotes").select("id, number, title, status, total, valid_until, sent_at, approved_at").eq("company_id", companyId).eq("client_id", clientId).in("status", ["sent", "changes_requested", "approved", "converted"]).order("created_at", { ascending: false }).limit(20),
    admin.from("invoices").select("id, number, subject, status, total, balance_due, due_on, issued_on").eq("company_id", companyId).eq("client_id", clientId).in("status", ["sent", "partially_paid", "overdue", "paid"]).order("issued_on", { ascending: false }).limit(20),
    admin.from("jobs").select("id").eq("company_id", companyId).eq("client_id", clientId),
    admin.from("payments").select("amount, tip_amount, method, received_at, invoice:invoices(number)").eq("company_id", companyId).eq("client_id", clientId).gt("amount", 0).order("received_at", { ascending: false }).limit(5),
    admin.from("requests").select("number, title, status, created_at").eq("company_id", companyId).eq("client_id", clientId).in("status", ["new", "assessment_scheduled", "assessment_complete"]).order("created_at", { ascending: false }).limit(5),
    admin.from("services").select("category").eq("company_id", companyId).eq("active", true).not("category", "is", null).limit(200),
  ]);
  const jobIds = (jobs.data ?? []).map((j) => j.id);
  const visitFields = "id, title, scheduled_on, starts_at, ends_at, status, completed_at, property:properties(line1), assignees:visit_assignees(user_id)";
  const [upcoming, done] = jobIds.length
    ? await Promise.all([
        admin.from("visits").select(visitFields).eq("company_id", companyId).in("job_id", jobIds).in("status", ["scheduled", "en_route", "in_progress"]).gte("scheduled_on", today).order("scheduled_on").order("starts_at", { nullsFirst: false }).limit(10),
        admin.from("visits").select(visitFields).eq("company_id", companyId).in("job_id", jobIds).eq("status", "completed").order("completed_at", { ascending: false, nullsFirst: false }).limit(5),
      ])
    : [{ data: [] }, { data: [] }];
  // Crews by first name only.
  const people = [...new Set([...(upcoming.data ?? []), ...(done.data ?? [])].flatMap((v) => (v.assignees as Array<{ user_id: string }>).map((a) => a.user_id)))];
  const names = new Map<string, string>();
  if (people.length) {
    const { data } = await admin.from("profiles").select("user_id, full_name").in("user_id", people);
    for (const p of data ?? []) if (p.full_name) names.set(p.user_id, firstName(p.full_name));
  }
  const visit = (v: NonNullable<typeof upcoming.data>[number]) => ({
    id: v.id, title: v.title, scheduled_on: v.scheduled_on, starts_at: v.starts_at, ends_at: v.ends_at, status: v.status, completed_at: v.completed_at,
    address: (v.property as unknown as { line1: string } | null)?.line1 ?? null,
    crew: firstNames(v.assignees as Array<{ user_id: string }>, names),
  });

  const base = appUrl(c);
  const sign = (t: "quote" | "invoice", id: string) => clientLink(c.env, base, { c: companyId, t, id });
  const companySettings = (settings.settings ?? {}) as { referral_offer?: string; referral_reward?: { amount?: number } };
  const referralOn = Boolean(companySettings.referral_offer || Number(companySettings.referral_reward?.amount ?? 0) > 0);
  return {
    kind: "client",
    company,
    client: { name: client.display_name, first_name: firstName(client.display_name), properties: client.properties },
    quotes: await Promise.all((quotes.data ?? []).map(async (q) => ({ ...q, link: await sign("quote", q.id) }))),
    invoices: await Promise.all((invoices.data ?? []).map(async (i) => ({ ...i, link: await sign("invoice", i.id) }))),
    visits: (upcoming.data ?? []).map(visit),
    past_visits: (done.data ?? []).map(visit),
    payments: (payments.data ?? []).map((p) => ({ amount: p.amount, tip_amount: p.tip_amount, method: p.method, received_at: p.received_at, invoice: (p.invoice as unknown as { number: number } | null)?.number ?? null })),
    requests: requests.data ?? [],
    services: [...new Set((services.data ?? []).map((s) => s.category as string))].slice(0, 8),
    refer: referralOn ? { link: await clientLink(c.env, base, { c: companyId, t: "refer", id: clientId }), offer: companySettings.referral_offer ?? null } : null,
  };
}

// A message to the office from the portal (also used for "ask to change a visit").
publicRoutes.post("/hub/:token/message", async (c) => {
  if (!(await allow(c.env, `hub-message:${clientIp(c)}`, 20, 60 * 60))) throw new HttpError(429, "Too many messages. Try again later, or call us.");
  const l = await link(c);
  if (l.pv) throw new HttpError(400, "Messages can't be sent from a preview.");
  const body = await readJson(c, z.object({ message: z.string().trim().min(2, "Write a message first.").max(4000), visit_id: z.uuid().optional() }));
  const admin = adminClient(c.env);
  const clientId =
    l.t === "client"
      ? l.id
      : must(await admin.from(l.t === "quote" ? "quotes" : "invoices").select("client_id").eq("company_id", l.c).eq("id", l.id).maybeSingle(), "This link isn't valid anymore.").client_id;
  must(await admin.from("clients").select("id").eq("company_id", l.c).eq("id", clientId).maybeSingle(), "This link isn't valid anymore.");
  let subject = "Message from the client portal";
  let related: { related_type: string; related_id: string } | Record<string, never> = l.t === "client" ? {} : { related_type: l.t, related_id: l.id };
  if (body.visit_id) {
    const visit = must(await admin.from("visits").select("id, title, scheduled_on, job:jobs(client_id)").eq("company_id", l.c).eq("id", body.visit_id).maybeSingle(), "Visit not found.");
    if ((visit.job as unknown as { client_id: string } | null)?.client_id !== clientId) throw new HttpError(404, "Visit not found.");
    subject = `Asked to change the visit on ${visit.scheduled_on ?? "an unscheduled day"}: ${visit.title}`;
    related = { related_type: "visit", related_id: visit.id };
  }
  const { error } = await admin.from("messages").insert({
    company_id: l.c, client_id: clientId, channel: "note", direction: "in", status: "received", subject, body: body.message, sent_by: null, ...related,
  });
  if (error) throw dbError(error);
  return c.json({ ok: true }, 201);
});

// The picture of a map drawing on a quote or invoice. Only drawings shown to the client, and only
// through the link to the quote or invoice they're on.
publicRoutes.get("/hub/:token/drawings/:file", async (c) => {
  const l = await link(c, ["quote", "invoice"]);
  const id = (c.req.param("file") ?? "").replace(/\.jpg$/i, "");
  if (!z.uuid().safeParse(id).success) throw new HttpError(404, "Drawing not found.");
  const admin = adminClient(c.env);
  const drawing = must(await admin.from("measurements").select("snapshot_path, show_on_quote, show_on_invoice, quote_id, invoice_id").eq("company_id", l.c).eq("id", id).maybeSingle(), "Drawing not found.");
  const shown = l.t === "quote" ? drawing.show_on_quote && drawing.quote_id === l.id : drawing.show_on_invoice && drawing.invoice_id === l.id;
  if (!shown || !drawing.snapshot_path) throw new HttpError(404, "Drawing not found.");
  const { data, error } = await admin.storage.from("files").download(drawing.snapshot_path);
  if (error || !data) throw new HttpError(404, "Drawing not found.");
  return c.body(await data.arrayBuffer(), 200, { "Content-Type": data.type || "image/jpeg", "Cache-Control": "private, max-age=3600" });
});

// "Add to calendar" for one of the client's visits.
publicRoutes.get("/hub/:token/visits/:file", async (c) => {
  const l = await link(c, ["client"]);
  const id = (c.req.param("file") ?? "").replace(/\.ics$/i, "");
  if (!z.uuid().safeParse(id).success) throw new HttpError(404, "Visit not found.");
  const admin = adminClient(c.env);
  const visit = must(
    await admin.from("visits").select("id, title, scheduled_on, starts_at, ends_at, status, job:jobs(client_id), property:properties(line1, city), company:companies(name)").eq("company_id", l.c).eq("id", id).maybeSingle(),
    "Visit not found.",
  );
  if ((visit.job as unknown as { client_id: string } | null)?.client_id !== l.id || !visit.scheduled_on) throw new HttpError(404, "Visit not found.");
  const place = visit.property as unknown as { line1: string; city: string | null } | null;
  const companyName = (visit.company as unknown as { name: string }).name;
  const ics = buildCalendar(companyName, [
    {
      uid: `${visit.id}@crewtavo`,
      title: `${companyName}: ${visit.title}`,
      ...(visit.starts_at && visit.ends_at ? { start: new Date(visit.starts_at), end: new Date(visit.ends_at) } : { date: visit.scheduled_on }),
      location: place ? [place.line1, place.city].filter(Boolean).join(", ") : null,
      cancelled: visit.status === "cancelled",
    },
  ]);
  return c.body(ics, 200, { "Content-Type": "text/calendar; charset=utf-8", "Content-Disposition": 'attachment; filename="visit.ics"' });
});

publicRoutes.post("/hub/:token/request", async (c) => {
  const l = await link(c, ["client"]);
  const body = await readJson(
    c,
    z.object({
      title: z.string().trim().min(3).max(200),
      details: z.string().trim().max(4000).optional(),
      property_id: z.uuid().optional(),
      timing: z.enum(["asap", "month", "flexible"]).optional(),
      promo_code: z.string().trim().max(40).optional(),
    }),
  );
  await limitSubmissions(c, "hub-request", l.c);
  const admin = adminClient(c.env);
  must(await admin.from("clients").select("id").eq("company_id", l.c).eq("id", l.id).maybeSingle(), "This link isn't valid anymore.");
  if (body.property_id) {
    must(await admin.from("properties").select("id").eq("company_id", l.c).eq("client_id", l.id).eq("id", body.property_id).maybeSingle(), "That address isn't on your account.");
  }
  let promo: string | null = null;
  if (body.promo_code) {
    // The answer says whether a code is real, so this counts toward the same limit as checking one.
    if (!(await allow(c.env, `promo:${clientIp(c)}`, 10, 10 * 60))) throw new HttpError(429, "Too many tries. Wait a few minutes and try again.");
    const { error } = await admin.rpc("check_promo_code", { p_company: l.c, p_code: body.promo_code });
    if (error) throw dbError(error);
    promo = body.promo_code.toUpperCase().replace(/\s/g, "");
  }
  const request = must(
    await admin
      .from("requests")
      .insert({
        company_id: l.c, client_id: l.id, property_id: body.property_id ?? null, source: "hub", title: body.title, details: body.details ?? null, created_by: null,
        answers: body.timing ? { when: { asap: "As soon as possible", month: "In the next month", flexible: "Flexible" }[body.timing] } : {},
        promo_code: promo,
      })
      .select("number")
      .single(),
  );
  kickAutomations(c, l.c);
  return c.json({ ok: true, reference: request.number }, 201);
});

// ---------------------------------------------------------------------------------------------
// Marketing: unsubscribe, review link clicks and referral pages
// ---------------------------------------------------------------------------------------------

publicRoutes.get("/public/unsubscribe/:token", async (c) => {
  const l = await link(c, ["unsub"]);
  const admin = adminClient(c.env);
  const [company, client] = await Promise.all([
    admin.from("companies").select("name").eq("id", l.c).maybeSingle(),
    admin.from("clients").select("marketing_opt_out").eq("company_id", l.c).eq("id", l.id).maybeSingle(),
  ]);
  if (!company.data || !client.data) throw new HttpError(404, "This link isn't valid anymore.");
  return c.json({ company: company.data.name, unsubscribed: client.data.marketing_opt_out });
});

publicRoutes.post("/public/unsubscribe/:token", async (c) => {
  const l = await link(c, ["unsub"]);
  const body = (await c.req.json().catch(() => null)) as { resubscribe?: unknown } | null;
  const resubscribe = body?.resubscribe === true;
  const { error } = await adminClient(c.env).from("clients").update({ marketing_opt_out: !resubscribe }).eq("company_id", l.c).eq("id", l.id);
  if (error) throw dbError(error);
  return c.json({ unsubscribed: !resubscribe });
});

/** Tracked review link: record the click, then send the client to the review page. */
publicRoutes.get("/public/r/:token", async (c) => {
  const payload = await readClientLink(c.env, c.req.param("token") ?? "");
  if (!payload || payload.t !== "review") return c.text("This link has expired.", 404);
  const admin = adminClient(c.env);
  const { data: company } = await admin.from("companies").select("settings").eq("id", payload.c).maybeSingle();
  const url = (company?.settings as { review_url?: string } | null)?.review_url;
  if (!url || !/^https:\/\//.test(url)) return c.text("This business hasn't set up reviews yet.", 404);
  await admin.from("review_requests").update({ status: "clicked", clicked_at: new Date().toISOString() }).eq("company_id", payload.c).eq("id", payload.id).is("clicked_at", null);
  return c.redirect(url, 302);
});

publicRoutes.get("/public/refer/:token", async (c) => {
  const l = await link(c, ["refer"]);
  const admin = adminClient(c.env);
  const [company, client] = await Promise.all([
    admin.from("companies").select("name, phone, website, settings").eq("id", l.c).maybeSingle(),
    admin.from("clients").select("display_name").eq("company_id", l.c).eq("id", l.id).maybeSingle(),
  ]);
  if (!company.data || !client.data) throw new HttpError(404, "This referral link isn't valid anymore.");
  const settings = (company.data.settings ?? {}) as { referral_offer?: string };
  return c.json({
    company: { name: company.data.name, phone: company.data.phone, website: company.data.website },
    referrer: firstName(client.data.display_name),
    offer: settings.referral_offer ?? null,
  });
});

publicRoutes.post("/public/refer/:token", async (c) => {
  const l = await link(c, ["refer"]);
  const body = await readJson(
    c,
    z.object({
      name: z.string().trim().min(2).max(120),
      email: z.email().optional(),
      phone: z.string().trim().min(7).max(30).optional(),
      address: z.object({ line1: z.string().trim().min(3).max(200), city: z.string().trim().max(100).optional(), postal_code: z.string().trim().max(12).optional() }),
      details: z.string().trim().max(4000).optional(),
      turnstile_token: z.string().optional(),
    }),
  );
  if (!body.email && !body.phone) throw new HttpError(400, "Add an email or phone number so we can reach you.");
  await verifyTurnstile(c, body.turnstile_token);
  await limitSubmissions(c, "referral", l.c);
  const admin = adminClient(c.env);
  const referrer = must(await admin.from("clients").select("id, display_name").eq("company_id", l.c).eq("id", l.id).maybeSingle(), "This referral link isn't valid anymore.");
  const { data: company } = await admin.from("companies").select("settings").eq("id", l.c).maybeSingle();
  const reward = Number((company?.settings as { referral_reward?: { amount?: number } } | null)?.referral_reward?.amount ?? 0);

  const client = must(
    await admin
      .from("clients")
      .insert({ company_id: l.c, status: "lead", display_name: body.name, email: body.email, phone: body.phone, lead_source: "Referral", referred_by: referrer.id })
      .select("id")
      .single(),
  );
  const property = must(
    await admin.from("properties").insert({ company_id: l.c, client_id: client.id, line1: body.address.line1, city: body.address.city, postal_code: body.address.postal_code }).select("id").single(),
  );
  const request = must(
    await admin
      .from("requests")
      .insert({ company_id: l.c, client_id: client.id, property_id: property.id, source: "referral", title: `Referral from ${referrer.display_name}`, details: body.details ?? null, created_by: null })
      .select("id, number")
      .single(),
  );
  await admin.from("referrals").insert({
    company_id: l.c, referrer_client_id: referrer.id, referred_client_id: client.id, request_id: request.id, referred_name: body.name,
    reward_amount: Math.max(0, reward), reward_status: reward > 0 ? "pending" : "none",
  });
  geocodeLater(c, property.id, body.address);
  kickAutomations(c, l.c);
  return c.json({ ok: true, reference: request.number }, 201);
});
