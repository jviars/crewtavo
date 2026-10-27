/**
 * Website forms (Apps → Crewtavo - Website Forms), the way Formspree works: the business keeps its
 * own form on its own website and sets its action to an address here. A message becomes a request
 * on the client it's from (supabase/migrations/20261026000100_website_forms.sql), and the people the
 * form names get an email right away, replying to whoever sent it. Fields are read by their names
 * (packages/core/src/websiteForms.ts), so any form works, and Formspree's _gotcha, _subject, _next
 * and _replyto do what they do there.
 *
 *   POST    /f/:key                          a message, sent by a form (sent back to the thank-you
 *                                            page) or with fetch() and Accept: application/json
 *   OPTIONS /f/:key                          lets fetch() send from any website
 *   GET     /f/:key                          what the address is, for someone who opens it
 *   GET     /f/:key/thanks                   the thank-you page people see after sending
 *   GET     /api/website-forms               the app's page: the forms, and whether email is set up
 *   POST    /api/website-forms/enabled       Install and Uninstall
 *   POST    /api/website-forms               another form
 *   PATCH   /api/website-forms/:id           its name, who gets its email, its thank-you page, websites
 *   POST    /api/website-forms/:id/address   a new address: the old one stops taking messages
 *   DELETE  /api/website-forms/:id
 *
 * server.ts sends /f/* here, before an old web address forwards to a new one, so forms on websites
 * keep working at the address they were given.
 */
import { ADMINS } from "@crewtavo/core";
import { cleanFields, readSubmission, siteAllowed, siteHost, webAddress } from "@crewtavo/core/websiteForms";
import { emailKey } from "@crewtavo/core/email";
import { Hono, type Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { z } from "zod";
import type { AppEnv } from "../env";
import { requireCompany, requireUser } from "../lib/auth";
import { kickAutomations, runInBackground } from "../lib/background";
import { appUrl, asJson, dbError, HttpError, must, readJson, uuid } from "../lib/http";
import { allow } from "../lib/limit";
import { reportError } from "../lib/monitoring";
import { emailReady } from "../lib/notify";
import { adminClient } from "../lib/supabase";
import { clientIp } from "../lib/visitor";
import { bookingVisit } from "../services/analytics";
import { logoImage } from "../services/logo";
import { emailMessage, formPage, newFormKey, type FormCompany } from "../services/websiteForms";
import { geocodeLater } from "./public";

type Ctx = Context<AppEnv>;

/** Installed: settings.website_forms.enabled (website_forms_set_enabled). */
const installed = (settings: unknown) => (settings as { website_forms?: { enabled?: boolean } } | null)?.website_forms?.enabled === true;

// ---------------------------------------------------------------------------------------------
// The form's address
// ---------------------------------------------------------------------------------------------

export const formInbox = new Hono<AppEnv>();

interface FoundForm {
  id: string;
  key: string;
  name: string;
  email_to: string[];
  redirect_url: string | null;
  allowed_sites: string[];
  company: FormCompany;
}

/** The form at this address, while its business has the app installed. */
async function findForm(c: Ctx): Promise<FoundForm | null> {
  const key = c.req.param("key") ?? "";
  if (!/^[a-z0-9]{8,32}$/.test(key)) return null;
  const { data, error } = await adminClient(c.env)
    .from("website_forms")
    .select("id, key, name, email_to, redirect_url, allowed_sites, company:companies(id, name, settings)")
    .eq("key", key)
    .maybeSingle();
  if (error) throw dbError(error);
  const company = data?.company as FormCompany | null | undefined;
  if (!data || !company || !installed(company.settings)) return null;
  return { ...data, company };
}

const branding = (c: Ctx, company: FormCompany) => ({ name: company.name, logo: logoImage(appUrl(c), company.id, company.settings) });

/** Formspree's rule: a form that asks for JSON (fetch with Accept: application/json, or a JSON body) gets JSON back. */
const wantsJson = (c: Ctx) => /application\/json/i.test(c.req.header("accept") ?? "") || /application\/json/i.test(c.req.header("content-type") ?? "");

/** Any website may send with fetch(): there's no sign-in to protect, and Only these websites is checked by its Origin. */
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Accept", "Access-Control-Max-Age": "86400" };

/** It wasn't sent: JSON for fetch(), or a page that says why with a way back to the form. */
function refuse(c: Ctx, json: boolean, status: ContentfulStatusCode, message: string, company?: FormCompany | null) {
  if (json) return c.json({ ok: false, error: message, errors: [{ message }] }, status, CORS);
  const page = formPage({ title: "Not sent", heading: "Your message wasn't sent", text: message, company: company ? branding(c, company) : null, back: "Go back to the form", tone: "problem" });
  return c.html(page, status, CORS);
}

/** What the form sent: a form post (urlencoded or multipart) or JSON. Null when it's neither. */
async function sentFields(c: Ctx): Promise<Array<[string, unknown]> | null> {
  const type = (c.req.header("content-type") ?? "").toLowerCase();
  if (type.includes("application/json")) {
    const body: unknown = await c.req.json().catch(() => null);
    return body && typeof body === "object" && !Array.isArray(body) ? Object.entries(body) : null;
  }
  if (type.includes("application/x-www-form-urlencoded") || type.includes("multipart/form-data")) {
    const form = await c.req.formData().catch(() => null);
    return form ? [...form.entries()] : null;
  }
  return null;
}

formInbox.options("/f/:key", (c) => c.body(null, 204, CORS));

formInbox.post("/f/:key", async (c) => {
  const json = wantsJson(c);
  let form: FoundForm | null = null;
  try {
    form = await findForm(c);
    if (!form) return refuse(c, json, 404, "This form isn't taking messages right now. Call or email the business instead.");
    const company = form.company;
    // Only these websites: the page the message came from, as the browser tells it.
    if (!siteAllowed(c.req.header("origin") ?? c.req.header("referer"), form.allowed_sites)) {
      return refuse(c, json, 403, "This form only takes messages from its own website.", company);
    }
    const sent = await sentFields(c);
    if (!sent) return refuse(c, json, 400, "The form didn't send anything Crewtavo can read. Its method should be POST.", company);
    const cleaned = cleanFields(sent);
    if (!cleaned.ok) return refuse(c, json, 413, cleaned.error, company);
    const read = readSubmission(cleaned.fields);
    if (!read.ok) return refuse(c, json, 422, read.error, company);
    const message = read.submission;

    const next = message.next ?? form.redirect_url ?? `${appUrl(c)}/f/${form.key}/thanks`;
    const done = () => (json ? c.json({ ok: true, next }, 200, CORS) : c.redirect(next, 303));
    // A bot that filled in the hidden field is told it worked, and nothing is kept.
    if (message.bot) return done();
    if (!(await allow(c.env, `website-form:ip:${clientIp(c)}`, 10, 60 * 60)) || !(await allow(c.env, `website-form:company:${company.id}`, 100, 60 * 60))) {
      return refuse(c, json, 429, "Too many messages. Try again later, or call us.", company);
    }

    // The website visit that brought them in, when the business counts its website's visits.
    const visit = await bookingVisit(c, company.id);
    const { data, error } = await adminClient(c.env).rpc("website_form_request", {
      p_form: form.id,
      p_name: message.name ?? undefined,
      p_email: message.email ?? undefined,
      p_phone: message.phone ?? undefined,
      p_company_name: message.companyName ?? undefined,
      p_address: message.address,
      p_title: message.subject ?? undefined,
      p_details: message.message ?? undefined,
      p_answers: asJson(message.answers),
      p_contact: asJson(message.contact),
      p_web_visit: visit ?? undefined,
    });
    if (error) throw dbError(error);
    const made = data as { request_id: string; property_id: string | null; new_property: boolean };
    if (made.new_property && made.property_id && message.address.line1) geocodeLater(c, made.property_id, { line1: message.address.line1, city: message.address.city, postal_code: message.address.postal_code });
    kickAutomations(c, company.id);
    if (form.email_to.length) {
      runInBackground(c, emailMessage(c.env, { base: appUrl(c), company, form, submission: message, requestId: made.request_id }));
    }
    return done();
  } catch (error) {
    if (error instanceof HttpError) return refuse(c, json, error.status as ContentfulStatusCode, error.message, form?.company);
    console.error("Website form message failed", error);
    reportError(error, { route: "/f/:key" });
    return refuse(c, json, 500, "Something went wrong on our side. Try again in a minute, or call us.", form?.company);
  }
});

formInbox.get("/f/:key", async (c) => {
  const form = await findForm(c);
  if (!form) return c.html(formPage({ title: "Form not found", heading: "This form isn't here", text: "It may have moved, or isn't taking messages right now.", tone: "problem" }), 404);
  return c.html(formPage({
    title: form.name,
    heading: `${form.company.name}'s ${form.name}`,
    text: `This address takes messages from a form on ${form.company.name}'s website. Use the form there to send one.`,
    company: branding(c, form.company),
  }));
});

formInbox.get("/f/:key/thanks", async (c) => {
  const form = await findForm(c);
  if (!form) return c.html(formPage({ title: "Form not found", heading: "This form isn't here", text: "It may have moved, or isn't taking messages right now.", tone: "problem" }), 404);
  return c.html(formPage({
    title: "Thanks!",
    heading: "Thanks! Your message was sent.",
    text: `${form.company.name} will get back to you soon.`,
    company: branding(c, form.company),
    back: "Back to the website",
  }));
});

// ---------------------------------------------------------------------------------------------
// The app's page: owners and admins who connect apps
// ---------------------------------------------------------------------------------------------

export const websiteForms = new Hono<AppEnv>();

const FORM_COLUMNS = "id, key, name, email_to, redirect_url, allowed_sites, created_at";

websiteForms.get("/website-forms", requireUser, requireCompany(ADMINS, "apps"), async (c) => {
  const { db, companyId } = c.var;
  const [company, forms] = await Promise.all([
    db.from("companies").select("settings").eq("id", companyId).maybeSingle(),
    db.from("website_forms").select(FORM_COLUMNS).eq("company_id", companyId).order("created_at"),
  ]);
  const rows = must(forms);
  // The latest message to each form, so the page can say it's working.
  const latest = await Promise.all(
    rows.map((f) => db.from("requests").select("created_at").eq("company_id", companyId).eq("website_form_id", f.id).order("created_at", { ascending: false }).limit(1).maybeSingle()),
  );
  const base = appUrl(c);
  return c.json({
    enabled: installed(must(company).settings),
    email_ready: await emailReady(c.env, companyId),
    forms: rows.map((f, i) => ({ ...f, url: `${base}/f/${f.key}`, last_message_at: latest[i]?.data?.created_at ?? null })),
  });
});

websiteForms.post("/website-forms/enabled", requireUser, requireCompany(ADMINS, "apps"), async (c) => {
  const body = await readJson(c, z.object({ enabled: z.boolean() }));
  const { error } = await c.var.db.rpc("website_forms_set_enabled", { p_company: c.var.companyId, p_enabled: body.enabled });
  if (error) throw dbError(error);
  return c.json({ enabled: body.enabled });
});

/** Another form, emailing whoever the first one does (or the business's own address). */
websiteForms.post("/website-forms", requireUser, requireCompany(ADMINS, "apps"), async (c) => {
  const body = await readJson(c, z.object({ name: z.string().trim().min(1, "Give the form a name.").max(80) }));
  const { db, companyId } = c.var;
  const [first, company] = await Promise.all([
    db.from("website_forms").select("email_to").eq("company_id", companyId).order("created_at").limit(1).maybeSingle(),
    db.from("companies").select("email").eq("id", companyId).maybeSingle(),
  ]);
  const own = emailKey(company.data?.email);
  const emailTo = first.data?.email_to ?? (own ? [own] : []);
  const row = must(await db.from("website_forms").insert({ company_id: companyId, name: body.name, email_to: emailTo, key: newFormKey() }).select(FORM_COLUMNS).single());
  return c.json({ ...row, url: `${appUrl(c)}/f/${row.key}`, last_message_at: null }, 201);
});

const changes = z.object({
  name: z.string().trim().min(1, "Give the form a name.").max(80).optional(),
  email_to: z.array(z.string().trim().max(254)).max(5, "Up to 5 people can get each message.").optional(),
  redirect_url: z.string().trim().max(500).nullable().optional(),
  allowed_sites: z.array(z.string().trim().max(500)).max(10, "Up to 10 websites.").optional(),
});

websiteForms.patch("/website-forms/:id", requireUser, requireCompany(ADMINS, "apps"), async (c) => {
  const id = uuid.parse(c.req.param("id"));
  const body = await readJson(c, changes);
  const update: { name?: string; email_to?: string[]; redirect_url?: string | null; allowed_sites?: string[] } = {};
  if (body.name !== undefined) update.name = body.name;
  if (body.email_to !== undefined) {
    const typed = body.email_to.filter(Boolean);
    const bad = typed.find((e) => !emailKey(e));
    if (bad) throw new HttpError(400, `${bad} isn't an email address.`);
    update.email_to = [...new Set(typed.map((e) => emailKey(e)!))];
  }
  if (body.redirect_url !== undefined) {
    const typed = body.redirect_url?.trim() || null;
    const url = typed && webAddress(/^[a-z][a-z0-9+.-]*:/i.test(typed) ? typed : `https://${typed}`);
    if (typed && !url) throw new HttpError(400, "Type your thank-you page's whole address, like https://greenlawn.com/thanks.");
    update.redirect_url = url || null;
  }
  if (body.allowed_sites !== undefined) {
    const typed = body.allowed_sites.filter(Boolean);
    const bad = typed.find((s) => !siteHost(s));
    if (bad) throw new HttpError(400, `${bad} isn't a website address. Type it like greenlawn.com.`);
    update.allowed_sites = [...new Set(typed.map((s) => siteHost(s)!))];
  }
  const row = must(await c.var.db.from("website_forms").update(update).eq("id", id).eq("company_id", c.var.companyId).select(FORM_COLUMNS).maybeSingle(), "That form isn't here anymore.");
  return c.json({ ...row, url: `${appUrl(c)}/f/${row.key}` });
});

/** A new address for a form bots have found. The old one stops taking messages at once. */
websiteForms.post("/website-forms/:id/address", requireUser, requireCompany(ADMINS, "apps"), async (c) => {
  const id = uuid.parse(c.req.param("id"));
  const row = must(await c.var.db.from("website_forms").update({ key: newFormKey() }).eq("id", id).eq("company_id", c.var.companyId).select(FORM_COLUMNS).maybeSingle(), "That form isn't here anymore.");
  return c.json({ ...row, url: `${appUrl(c)}/f/${row.key}` });
});

websiteForms.delete("/website-forms/:id", requireUser, requireCompany(ADMINS, "apps"), async (c) => {
  const id = uuid.parse(c.req.param("id"));
  const { error } = await c.var.db.from("website_forms").delete().eq("id", id).eq("company_id", c.var.companyId);
  if (error) throw dbError(error);
  return c.body(null, 204);
});
