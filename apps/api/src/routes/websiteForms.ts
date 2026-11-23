/**
 * Website forms (Apps → Crewtavo - Website Forms), the way Formspree works: the business keeps its
 * own form on its own website and sets its action to an address here. A message becomes a request
 * on the client it's from (supabase/migrations/20261026000100_website_forms.sql), and the people the
 * form names get an email right away, replying to whoever sent it. Fields are read by their names
 * (packages/core/src/websiteForms.ts), so any form works, and Formspree's _gotcha, _subject, _next
 * and _replyto do what they do there.
 *
 * A careers form (Apps → Crewtavo - Careers, website_forms.kind careers) works the same way, but each
 * message is a job application: it lands in Applicants, with the résumé and any other files the form
 * sends (packages/core/src/careers.ts, services/careers.ts).
 *
 * Bots: a filled-in _gotcha is told it worked and kept nowhere, and each visitor and each business
 * has a limit. A form can ask for more (its bot check, services/formBotCheck.ts): Crewtavo's own
 * script on the page, or Cloudflare Turnstile with the business's keys. A check only watches: what
 * passed it and what came without it are noted for the app's page, and the form refuses messages
 * without it only once an owner or admin says so there, which they can't before one has passed. So
 * a page of the website that doesn't have the line yet never loses a lead by surprise.
 *
 *   POST    /f/:key                          a message, sent by a form (sent back to the thank-you
 *                                            page) or with fetch() and Accept: application/json
 *   OPTIONS /f/:key                          lets fetch() send from any website
 *   GET     /f/:key                          what the address is, for someone who opens it
 *   GET     /f/:key/thanks                   the thank-you page people see after sending
 *   GET     /f/:key/check.js                 Crewtavo's check, for the page the form is on
 *   POST    /f/:key/check                    a token for that page, as old as the one it hands
 *                                            over (and OPTIONS)
 *   GET     /api/website-forms               the app's page: the forms, whether email is set up, and
 *                                            whether there are promo codes (?kind=careers: Careers'
 *                                            page and its forms)
 *   POST    /api/website-forms/enabled       Install and Uninstall (kind: careers for Careers)
 *   POST    /api/website-forms               another form (kind: careers for a careers form)
 *   PATCH   /api/website-forms/:id           its name, who gets its email, its thank-you page, websites
 *                                            and bot check, and whether it refuses
 *                                            messages without the check (bot_check_refuses)
 *   PUT     /api/website-forms/turnstile     the business's Turnstile keys, tested with Cloudflare first
 *   DELETE  /api/website-forms/turnstile     removes them: its Turnstile forms go back to the hidden field
 *   POST    /api/website-forms/:id/address   a new address: the old one stops taking messages
 *   DELETE  /api/website-forms/:id
 *
 * server.ts sends /f/* here, before an old web address forwards to a new one, so forms on websites
 * keep working at the address they were given.
 */
import { ADMINS } from "@crewtavo/core";
import { readApplication } from "@crewtavo/core/careers";
import { BOT_CHECKS, cleanFields, readSubmission, siteAllowed, siteHost, webAddress, type BotCheck } from "@crewtavo/core/websiteForms";
import { emailKey } from "@crewtavo/core/email";
import { privacyUrl } from "@crewtavo/core/privacyPolicy";
import { brandColor } from "@crewtavo/core/social";
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
import { noteTextConsent } from "../services/textsOff";
import { clientIp } from "../lib/visitor";
import { bookingVisit } from "../services/analytics";
import { checkFiles, emailApplication, FILES_PAUSED, removeFiles, roomForFiles, storeFiles } from "../services/careers";
import { checkMessage, checkRefusal, checkScript, loadTurnstile, newCheckToken, saveTurnstile } from "../services/formBotCheck";
import { logoImage } from "../services/logo";
import { emailMessage, formPage, newFormKey, type FormCompany } from "../services/websiteForms";
import { geocodeLater } from "./public";

type Ctx = Context<AppEnv>;

type Kind = "contact" | "careers";
/** Which app a kind of form belongs to: its settings key and its Install function. */
const APP = { contact: { setting: "website_forms", install: "website_forms_set_enabled" }, careers: { setting: "careers", install: "careers_set_enabled" } } as const;

/** Installed: settings.website_forms.enabled (website_forms_set_enabled), or settings.careers.enabled (careers_set_enabled). */
const installed = (settings: unknown, kind: Kind) => (settings as Record<string, { enabled?: boolean } | undefined> | null)?.[APP[kind].setting]?.enabled === true;

// ---------------------------------------------------------------------------------------------
// The form's address
// ---------------------------------------------------------------------------------------------

export const formInbox = new Hono<AppEnv>();

interface FoundForm {
  id: string;
  key: string;
  kind: Kind;
  name: string;
  email_to: string[];
  redirect_url: string | null;
  allowed_sites: string[];
  bot_check: BotCheck;
  /** Refusing messages without the check since then (an owner or admin turned that on); null while it only watches. */
  bot_check_armed_at: string | null;
  company: FormCompany;
}

/** The form at this address, while its business has the app installed. */
async function findForm(c: Ctx, key = c.req.param("key") ?? ""): Promise<FoundForm | null> {
  if (!/^[a-z0-9]{8,32}$/.test(key)) return null;
  const { data, error } = await adminClient(c.env)
    .from("website_forms")
    .select("id, key, kind, name, email_to, redirect_url, allowed_sites, bot_check, bot_check_armed_at, company:companies(id, name, settings, website)")
    .eq("key", key)
    .maybeSingle();
  if (error) throw dbError(error);
  const company = data?.company as FormCompany | null | undefined;
  const kind: Kind = data?.kind === "careers" ? "careers" : "contact";
  if (!data || !company || !installed(company.settings, kind)) return null;
  const botCheck: BotCheck = (BOT_CHECKS as readonly string[]).includes(data.bot_check) ? (data.bot_check as BotCheck) : "off";
  return { ...data, kind, bot_check: botCheck, bot_check_armed_at: data.bot_check_armed_at ?? null, company };
}

const branding = (c: Ctx, company: FormCompany) => ({ name: company.name, logo: logoImage(appUrl(c), company.id, company.settings), privacy_url: privacyUrl(company.settings as Record<string, unknown> | null), color: brandColor(company.settings) });

/** Formspree's rule: a form that asks for JSON (fetch with Accept: application/json, or a JSON body) gets JSON back. */
const wantsJson = (c: Ctx) => /application\/json/i.test(c.req.header("accept") ?? "") || /application\/json/i.test(c.req.header("content-type") ?? "");

/** Any website may send with fetch(): there's no sign-in to protect, and Only these websites is checked by its Origin. */
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Accept", "Access-Control-Max-Age": "86400" };

/** It wasn't sent: JSON for fetch(), or a page that says why with a way back to the form. */
function refuse(c: Ctx, json: boolean, status: ContentfulStatusCode, message: string, company?: FormCompany | null, kind: Kind = "contact") {
  if (json) return c.json({ ok: false, error: message, errors: [{ message }] }, status, CORS);
  const page = formPage({ title: "Not sent", heading: kind === "careers" ? "Your application wasn't sent" : "Your message wasn't sent", text: message, company: company ? branding(c, company) : null, back: "Go back to the form", tone: "problem" });
  return c.html(page, status, CORS);
}

/** Where people go after sending: the form's _next, its own thank-you page, or Crewtavo's. */
const thanksPage = (c: Ctx, form: FoundForm, next: string | null) => ownNext(c, form, next) ?? form.redirect_url ?? `${appUrl(c)}/f/${form.key}/thanks`;

/**
 * A form's _next, when it goes to the form's own website or this Crewtavo; null otherwise. A form's
 * own website is one the business named: one the form takes messages from (Only these websites), the
 * site of the thank-you page it set, or its website on Settings → Company. Never the page a message
 * says it came from: any page can post to the form and say so, and then send people anywhere from
 * the business's own address.
 */
function ownNext(c: Ctx, form: FoundForm, next: string | null): string | null {
  if (!next) return null;
  const origin = (url: string | null | undefined) => {
    try {
      return url ? new URL(url).origin : null;
    } catch {
      return null;
    }
  };
  if (origin(next) === origin(appUrl(c))) return next;
  const sites = [...form.allowed_sites, siteHost(form.redirect_url), siteHost(form.company.website)].filter((host): host is string => Boolean(host));
  return sites.length && siteAllowed(next, sites) ? next : null;
}

/**
 * This Crewtavo's own address for the office's email about a message, or null without APP_URL: the
 * address a message came to is whatever its sender wrote, so it never goes in that email as the way
 * to the request (emailMessage).
 */
const ownAddress = (c: Ctx) => (c.env.APP_URL ? appUrl(c) : null);

const sentOk = (c: Ctx, json: boolean, next: string) => (json ? c.json({ ok: true, next }, 200, CORS) : c.redirect(next, 303));

const TOO_MANY = { contact: "Too many messages. Try again later, or call us.", careers: "Too many applications. Try again later, or call us." } as const;

/**
 * The visitor's limit: nobody sends more than a few an hour; a script sends hundreds. Counted before
 * anything they sent is read (app.ts runs it ahead of its size limit), because a post can be 32 MB,
 * and reading one, or measuring one that doesn't say its size, holds all of it in memory. The
 * refusal when they're over it, said the way refuse() says it; null when they're not.
 */
export async function formVisitorLimit(c: Context): Promise<Response | null> {
  const ctx = c as Ctx;
  if (await allow(ctx.env, `website-form:ip:${clientIp(ctx)}`, 10, 60 * 60)) return null;
  // In the form's own words, with its business's name, when the address is a form's.
  const form = await findForm(ctx, ctx.req.path.split("/")[2]).catch(() => null);
  return refuse(ctx, wantsJson(ctx), 429, TOO_MANY[form?.kind ?? "contact"], form?.company, form?.kind);
}

/** The business's limit, for messages that are kept: a flood from many visitors stops here. */
const companyUnderLimit = (c: Ctx, companyId: string) => allow(c.env, `website-form:company:${companyId}`, 100, 60 * 60);

/** More than any form sends, files and all (app.ts's limit for form addresses): said the way refuse() says it. */
export function formTooLarge(c: Context) {
  return refuse(c as Ctx, wantsJson(c as Ctx), 413, "That's too much to send in one go. Attach smaller files, up to 10 MB each, and try again.");
}

/** What the form sent: a form post (urlencoded or multipart, files and all) or JSON. Null when it's neither. */
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

/** One more turned away, for the form's page. Counted after the answer, which it never changes. */
function countBlocked(c: Ctx, form: FoundForm) {
  runInBackground(c, (async () => {
    const { error } = await adminClient(c.env).rpc("website_form_blocked", { p_form: form.id });
    if (error) throw dbError(error);
  })());
}

/** What the check made of a message that's being kept: it passed (true), it didn't (false), or there was nothing to say (null). */
type CheckNote = boolean | null;

/**
 * The form's bot check, once a message is otherwise ready to keep (one of a good token's uses is
 * taken here). A message that doesn't pass is refused, and counted, only by a form an owner or admin
 * told to refuse. Otherwise it's kept, and `note` says what to note about it once it has been.
 */
async function botCheck(c: Ctx, json: boolean, form: FoundForm, sent: Array<[string, unknown]>): Promise<{ refused: Response } | { refused: null; note: CheckNote }> {
  if (form.bot_check === "off") return { refused: null, note: null };
  const result = await checkMessage(c.env, adminClient(c.env), form, sent, clientIp(c));
  // A check that couldn't be made says nothing about the page the message came from.
  if (result === "unchecked") return { refused: null, note: null };
  if (result === "passed") return { refused: null, note: true };
  if (!form.bot_check_armed_at) return { refused: null, note: false };
  countBlocked(c, form);
  const refusal = checkRefusal(result, form.bot_check, form.kind);
  return { refused: refuse(c, json, refusal.status, refusal.message, form.company, form.kind) };
}

/**
 * Note what the check made of a message, now that it's kept: for the app's page, which shows when
 * one last came through with the check and how many came without. Only for the check and address
 * it was judged by (the database sees to that). After the answer, which it never changes.
 */
function noteCheck(c: Ctx, form: FoundForm, note: CheckNote) {
  if (note === null) return;
  runInBackground(c, (async () => {
    const { error } = await adminClient(c.env).rpc("website_form_check_noted", { p_form: form.id, p_check: form.bot_check, p_key: form.key, p_passed: note });
    if (error) throw dbError(error);
  })());
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
    if (form.kind === "careers") return await takeApplication(c, json, form, sent);
    const cleaned = cleanFields(sent);
    if (!cleaned.ok) return refuse(c, json, 413, cleaned.error, company);
    const read = readSubmission(cleaned.fields);
    if (!read.ok) return refuse(c, json, 422, read.error, company);
    const message = read.submission;

    const next = thanksPage(c, form, message.next);
    const done = () => sentOk(c, json, next);
    // A bot that filled in the hidden field is told it worked, and nothing is kept.
    if (message.bot) {
      countBlocked(c, form);
      return done();
    }
    // Before the business's limit, so what the check turns away doesn't use up real messages' share.
    const checked = await botCheck(c, json, form, sent);
    if (checked.refused) return checked.refused;
    if (!(await companyUnderLimit(c, company.id))) return refuse(c, json, 429, TOO_MANY.contact, company);

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
      // Checked as a promo code: a valid one waits on the request for the quote; one that isn't never loses the message.
      p_promo: message.promo ?? undefined,
    });
    if (error) throw dbError(error);
    noteCheck(c, form, checked.note);
    const made = data as {
      request_id: string; client_id?: string | null; property_id: string | null; new_property: boolean;
      promo_code: string | null; rejected_promo_code: string | null; promo_problem: string | null;
    };
    const promo = made.promo_code ? { code: made.promo_code, problem: null } : made.rejected_promo_code ? { code: made.rejected_promo_code, problem: made.promo_problem ?? "It isn't valid." } : null;
    if (made.new_property && made.property_id && message.address.line1) geocodeLater(c, made.property_id, { line1: message.address.line1, city: message.address.city, postal_code: message.address.postal_code });
    kickAutomations(c, company.id);
    // Where their number came from, for the office: the business's own website form (which Crewtavo doesn't write, so it can't say what the form told them).
    if (message.phone && made.client_id) runInBackground(c, noteTextConsent(adminClient(c.env), company.id, made.client_id, message.phone, "website_form"));
    if (form.email_to.length) {
      runInBackground(c, emailMessage(c.env, { base: ownAddress(c), company, form, submission: message, requestId: made.request_id, promo }));
    }
    return done();
  } catch (error) {
    if (error instanceof HttpError) return refuse(c, json, error.status as ContentfulStatusCode, error.message, form?.company, form?.kind);
    console.error("Website form message failed", error);
    reportError(error, { route: "/f/:key" });
    return refuse(c, json, 500, "Something went wrong on our side. Try again in a minute, or call us.", form?.company, form?.kind);
  }
});

/**
 * A job application, to a careers form: its files are checked, then stored under the applicant, who
 * lands in Applicants with a notice to the people who see them (job_application). Files that were
 * stored for an application that then wasn't kept are removed again.
 */
async function takeApplication(c: Ctx, json: boolean, form: FoundForm, sent: Array<[string, unknown]>) {
  const company = form.company;
  const files = checkFiles(sent);
  const cleaned = cleanFields(sent);
  if (!cleaned.ok) return refuse(c, json, 413, cleaned.error, company, "careers");
  const read = readApplication(cleaned.fields);
  if (!read.ok) return refuse(c, json, 422, read.error, company, "careers");
  const application = read.application;

  const done = () => sentOk(c, json, thanksPage(c, form, application.next));
  if (application.bot) {
    countBlocked(c, form);
    return done();
  }
  // Before anything of theirs is stored.
  const checked = await botCheck(c, json, form, sent);
  if (checked.refused) return checked.refused;
  if (!(await companyUnderLimit(c, company.id))) return refuse(c, json, 429, TOO_MANY.careers, company, "careers");
  // Their files are kept, so they count against the business's day of strangers' files.
  if (!(await roomForFiles(c.env, company.id, clientIp(c), files))) return refuse(c, json, 429, FILES_PAUSED, company, "careers");

  const admin = adminClient(c.env);
  const visit = await bookingVisit(c, company.id);
  const applicantId = crypto.randomUUID();
  const stored = await storeFiles(admin, company.id, applicantId, files);
  const { error } = await admin.rpc("job_application", {
    p_form: form.id,
    p_id: applicantId,
    p_name: application.name ?? undefined,
    p_email: application.email ?? undefined,
    p_phone: application.phone ?? undefined,
    p_details: asJson(application.details),
    p_answers: asJson(application.answers),
    p_files: asJson(stored),
    p_web_visit: visit ?? undefined,
  });
  if (error) {
    await removeFiles(admin, stored);
    throw dbError(error);
  }
  noteCheck(c, form, checked.note);
  if (form.email_to.length) {
    runInBackground(c, emailApplication(c.env, { base: ownAddress(c), company, form, application, files: stored, applicantId }));
  }
  return done();
}

formInbox.get("/f/:key", async (c) => {
  const form = await findForm(c);
  if (!form) return c.html(formPage({ title: "Form not found", heading: "This form isn't here", text: "It may have moved, or isn't taking messages right now.", tone: "problem" }), 404);
  return c.html(formPage({
    title: form.name,
    heading: `${form.company.name}'s ${form.name}`,
    text: form.kind === "careers"
      ? `This address takes job applications from a form on ${form.company.name}'s website. Use the form there to apply.`
      : `This address takes messages from a form on ${form.company.name}'s website. Use the form there to send one.`,
    company: branding(c, form.company),
  }));
});

formInbox.get("/f/:key/thanks", async (c) => {
  const form = await findForm(c);
  if (!form) return c.html(formPage({ title: "Form not found", heading: "This form isn't here", text: "It may have moved, or isn't taking messages right now.", tone: "problem" }), 404);
  return c.html(formPage({
    title: "Thanks!",
    heading: form.kind === "careers" ? "Thanks! Your application was sent." : "Thanks! Your message was sent.",
    text: form.kind === "careers" ? `${form.company.name} will be in touch.` : `${form.company.name} will get back to you soon.`,
    company: branding(c, form.company),
    back: "Back to the website",
  }));
});

// Crewtavo's own check (services/formBotCheck.ts): the script the business puts on the form's page,
// and the token it asks for as the page loads.

const SCRIPT = { "Content-Type": "text/javascript; charset=utf-8", "X-Content-Type-Options": "nosniff", "Access-Control-Allow-Origin": "*" };

formInbox.get("/f/:key/check.js", async (c) => {
  const form = await findForm(c);
  if (!form) return c.body("/* This form isn't taking messages right now. */\n", 404, { ...SCRIPT, "Cache-Control": "no-store" });
  // Briefly kept, so a form that gets a new address stops being asked about soon after.
  return c.body(checkScript(`${appUrl(c)}/f/${form.key}/check`, form.key), 200, { ...SCRIPT, "Cache-Control": "public, max-age=300" });
});

formInbox.options("/f/:key/check", (c) => c.body(null, 204, CORS));

formInbox.post("/f/:key/check", async (c) => {
  const answer = { ...CORS, "Cache-Control": "no-store" };
  // A page asks once as it loads and every half hour after; a script asks without end.
  if (!(await allow(c.env, `form-check:ip:${clientIp(c)}`, 60, 60 * 60))) return c.json({ ok: false, error: "Too many checks. Try again later." }, 429, answer);
  const form = await findForm(c);
  if (!form) return c.json({ ok: false, error: "This form isn't taking messages right now." }, 404, answer);
  if (!siteAllowed(c.req.header("origin") ?? c.req.header("referer"), form.allowed_sites)) {
    return c.json({ ok: false, error: "This form only takes messages from its own website." }, 403, answer);
  }
  // The token the page had, when it had one (was=<token>, sent as a plain form post so any website
  // can ask without a preflight): the new one is as old as it, so a refresh doesn't look like a new page.
  const was = new URLSearchParams(await c.req.text().catch(() => "")).get("was");
  return c.json({ ok: true, token: await newCheckToken(c.env, form.key, was) }, 200, answer);
});

// ---------------------------------------------------------------------------------------------
// The app's page: owners and admins who connect apps
// ---------------------------------------------------------------------------------------------

export const websiteForms = new Hono<AppEnv>();

const FORM_COLUMNS = "id, key, name, email_to, redirect_url, allowed_sites, bot_check, bot_check_passed_at, bot_check_missed, bot_check_missed_at, bot_check_armed_at, bots_blocked, last_blocked_at, created_at";
const kindOf = (value: unknown): Kind => (value === "careers" ? "careers" : "contact");

websiteForms.get("/website-forms", requireUser, requireCompany(ADMINS, "apps"), async (c) => {
  const { db, companyId } = c.var;
  const kind = kindOf(c.req.query("kind"));
  const [company, forms, codes, turnstile] = await Promise.all([
    adminClient(c.env).from("companies").select("settings").eq("id", companyId).maybeSingle(),
    db.from("website_forms").select(FORM_COLUMNS).eq("company_id", companyId).eq("kind", kind).order("created_at"),
    // A contact form to paste has a promo code box only for a business with codes.
    kind === "contact" ? db.from("promo_codes").select("id", { count: "exact", head: true }).eq("company_id", companyId).eq("active", true) : null,
    // The business's Turnstile keys, when it saved them: only the server reads where they're kept, and only the site key leaves it.
    loadTurnstile(c.env, adminClient(c.env), companyId),
  ]);
  const rows = must(forms);
  // The latest message to each form, so the page can say it's working: a request, or an applicant.
  const latest = await Promise.all(
    rows.map((f) => db.from(kind === "careers" ? "job_applicants" : "requests").select("created_at").eq("company_id", companyId).eq("website_form_id", f.id).order("created_at", { ascending: false }).limit(1).maybeSingle()),
  );
  const base = appUrl(c);
  return c.json({
    enabled: installed(must(company).settings, kind),
    email_ready: await emailReady(c.env, companyId),
    ...(codes ? { promo_codes: (codes.count ?? 0) > 0 } : {}),
    turnstile_site_key: turnstile?.siteKey ?? null,
    // Saved, but this server can't read the secret key any more: nothing is checked until they're entered again.
    turnstile_keys_unreadable: Boolean(turnstile && !turnstile.secret),
    forms: rows.map((f, i) => ({ ...f, url: `${base}/f/${f.key}`, last_message_at: latest[i]?.data?.created_at ?? null })),
  });
});

websiteForms.post("/website-forms/enabled", requireUser, requireCompany(ADMINS, "apps"), async (c) => {
  const body = await readJson(c, z.object({ enabled: z.boolean(), kind: z.enum(["contact", "careers"]).default("contact") }));
  const { error } = await c.var.db.rpc(APP[body.kind].install, { p_company: c.var.companyId, p_enabled: body.enabled });
  if (error) throw dbError(error);
  return c.json({ enabled: body.enabled });
});

/** Another form, emailing whoever the first one of its kind does (or the business's own address). */
websiteForms.post("/website-forms", requireUser, requireCompany(ADMINS, "apps"), async (c) => {
  const body = await readJson(c, z.object({ name: z.string().trim().min(1, "Give the form a name.").max(80), kind: z.enum(["contact", "careers"]).default("contact") }));
  const { db, companyId } = c.var;
  const [first, company] = await Promise.all([
    db.from("website_forms").select("email_to").eq("company_id", companyId).eq("kind", body.kind).order("created_at").limit(1).maybeSingle(),
    db.from("companies").select("email").eq("id", companyId).maybeSingle(),
  ]);
  const own = emailKey(company.data?.email);
  const emailTo = first.data?.email_to ?? (own ? [own] : []);
  const row = must(await db.from("website_forms").insert({ company_id: companyId, name: body.name, email_to: emailTo, key: newFormKey(), kind: body.kind }).select(FORM_COLUMNS).single());
  return c.json({ ...row, url: `${appUrl(c)}/f/${row.key}`, last_message_at: null }, 201);
});

const changes = z.object({
  name: z.string().trim().min(1, "Give the form a name.").max(80).optional(),
  email_to: z.array(z.string().trim().max(254)).max(5, "Up to 5 people can get each message.").optional(),
  redirect_url: z.string().trim().max(500).nullable().optional(),
  allowed_sites: z.array(z.string().trim().max(500)).max(10, "Up to 10 websites.").optional(),
  bot_check: z.enum(BOT_CHECKS).optional(),
  // Refuse messages that come without the check (true), or go back to only watching (false).
  bot_check_refuses: z.boolean().optional(),
});

const NO_TURNSTILE_KEYS = "Add your Cloudflare Turnstile keys first, then turn it on for this form.";
const TURNSTILE_KEYS_UNREADABLE = "This Crewtavo can't read your Turnstile keys any more. Enter them again, then turn it on for this form.";
const NO_CHECK_TO_REFUSE_BY = "This form has no check for a message to come without. Choose one first.";
const NO_TEST_YET = "No message has come through with the check yet. Send a test from your website first, then turn this on.";
const CHECK_JUST_CHANGED = "A check that was just changed hasn't seen a message yet. Save it, send a test from your website, then turn this on.";

/**
 * The business's Turnstile keys, for all its forms. Cloudflare is asked about the secret key before
 * anything is saved. Forms already on Turnstile start over, refusing nothing (the database does
 * that), since the widget on the website may still be the old one.
 */
websiteForms.put("/website-forms/turnstile", requireUser, requireCompany(ADMINS, "apps"), async (c) => {
  const body = await readJson(c, z.object({
    site_key: z.string().trim().min(1, "Paste the site key.").max(200),
    secret_key: z.string().trim().min(1, "Paste the secret key.").max(200),
  }));
  await saveTurnstile(c.env, adminClient(c.env), c.var.companyId, body.site_key, body.secret_key);
  return c.json({ turnstile_site_key: body.site_key });
});

/** Without keys nothing can be checked: the forms that used them go back to the hidden field only (the database does that). */
websiteForms.delete("/website-forms/turnstile", requireUser, requireCompany(ADMINS, "apps"), async (c) => {
  const { error } = await adminClient(c.env).from("website_form_turnstile").delete().eq("company_id", c.var.companyId);
  if (error) throw dbError(error);
  return c.body(null, 204);
});

websiteForms.patch("/website-forms/:id", requireUser, requireCompany(ADMINS, "apps"), async (c) => {
  const id = uuid.parse(c.req.param("id"));
  const body = await readJson(c, changes);
  const update: { name?: string; email_to?: string[]; redirect_url?: string | null; allowed_sites?: string[]; bot_check?: BotCheck } = {};
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
  if (body.bot_check !== undefined) {
    if (body.bot_check === "turnstile") {
      const keys = await loadTurnstile(c.env, adminClient(c.env), c.var.companyId);
      if (!keys?.secret) throw new HttpError(400, keys ? TURNSTILE_KEYS_UNREADABLE : NO_TURNSTILE_KEYS);
    }
    // A changed check starts over: nothing passed, nothing refused (the database clears what was noted).
    update.bot_check = body.bot_check;
  }
  const { db, companyId } = c.var;
  const form = () => db.from("website_forms").select(FORM_COLUMNS).eq("id", id).eq("company_id", companyId).maybeSingle();
  const refuses = body.bot_check_refuses;
  if (refuses) {
    // Refusing is for a check that has proved it's on the website: one message, at least, came through with it.
    const current = must(await form(), "That form isn't here anymore.");
    if (update.bot_check !== undefined && update.bot_check !== current.bot_check) throw new HttpError(400, CHECK_JUST_CHANGED);
    if (current.bot_check === "off") throw new HttpError(400, NO_CHECK_TO_REFUSE_BY);
    if (!current.bot_check_passed_at) throw new HttpError(400, NO_TEST_YET);
  }
  let row = Object.keys(update).length || refuses === undefined
    ? must(await db.from("website_forms").update(update).eq("id", id).eq("company_id", companyId).select(FORM_COLUMNS).maybeSingle(), "That form isn't here anymore.")
    : null;
  if (refuses !== undefined) {
    // Whether a form refuses is the server's to write (the database keeps it from the browser), for
    // the owners and admins this route is for. Turning it on holds only while the form still has a
    // check a message has passed, and keeps the day it started when it's already on.
    const admin = adminClient(c.env);
    const { error } = refuses
      ? await admin.from("website_forms").update({ bot_check_armed_at: new Date().toISOString() }).eq("id", id).eq("company_id", companyId)
          .neq("bot_check", "off").not("bot_check_passed_at", "is", null).is("bot_check_armed_at", null)
      : await admin.from("website_forms").update({ bot_check_armed_at: null }).eq("id", id).eq("company_id", companyId);
    if (error) throw dbError(error);
    row = must(await form(), "That form isn't here anymore.");
    if (refuses && !row.bot_check_armed_at) throw new HttpError(400, NO_TEST_YET);
  }
  return c.json({ ...row!, url: `${appUrl(c)}/f/${row!.key}` });
});

/**
 * A new address for a form bots have found. The old one stops taking messages at once, and the
 * form's check starts over (the database does that): Crewtavo's own line has the address in it.
 */
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
