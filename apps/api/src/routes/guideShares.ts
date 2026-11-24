/**
 * Sharing a guide by link with people outside the team
 * (supabase/migrations/20261117000200_guide_sharing.sql; the page is /g/<token> in the web app).
 * Owners and admins who edit guides choose who may open a guide's link: only the people they add
 * by email address, or anyone who has it.
 *
 *   POST   /api/guides/:id/share                     the guide's link and who it's shared with (made the first time)
 *   PATCH  /api/guides/:id/share                     who may open it: restricted or anyone
 *   POST   /api/guides/:id/share/people              add people by address, and email each the link
 *   POST   /api/guides/:id/share/people/:person/email   email one of them the link again
 *   DELETE /api/guides/:id/share/people/:person      take someone off
 *   POST   /api/guides/:id/share/link                a new link: the old one stops working
 *
 *   POST   /api/public/guides/:token                 the guide, for whoever may open it
 *   POST   /api/public/guides/:token/code            email a code to an address that was added
 *   POST   /api/public/guides/:token/code/check      the code typed back: lets this browser in
 *   GET    /api/public/guides/:token/pictures/:name  one of the guide's own pictures, or its cover
 *
 * A link for certain people works the way a shared document's does. Someone opens it, types their
 * email address and gets a 6-digit code there; the right code lets that browser in for 30 days, to
 * every guide shared with that address. Taking them off the list shuts them out at once: the list
 * is read each time.
 *
 * Nobody learns from any of it who a guide is shared with. Asking for a code always gets the same
 * answer, and the email goes out after it, so how long the answer takes says nothing either. An
 * address that wasn't added still gets something to type a code against, with a code nobody has,
 * so its tries answer as a real one's do. Codes aren't stored: what the browser holds between
 * asking and typing is signed by the server and names the code only as a keyed hash. Asking is
 * limited for each address at each link and for each visitor, and each code gets five tries; a
 * limit that can't be counted refuses (allowStrict), since emails cost the sender's good name.
 *
 * The page never shows a file that isn't the guide's own: only the pictures its current version
 * names in its company's kb/ folder, and its cover (sharedPictures), as JPEGs with whatever a
 * camera wrote into them taken out. A picture's link never carries the reader's address: a page
 * for certain people loads its pictures with a pass that names only their row in the list. A link's
 * pictures send at most a day's worth (lib/linkBudget.ts), so a link posted somewhere public can't
 * run up the bill; a new link starts afresh.
 */
import { ADMINS } from "@crewtavo/core";
import { emailKey } from "@crewtavo/core/email";
import { GUIDE_CODE_MINUTES, GUIDE_CODE_TRIES, GUIDE_KEY_DAYS, GUIDE_SHARE_ACCESS, MAX_SHARE_ADD, MAX_SHARE_PEOPLE, guideCodeEmail, guideInviteEmail, guideShareUrl, pictureName, sharedPictures, type GuideShareAccess } from "@crewtavo/core/guideShares";
import { privacyUrl } from "@crewtavo/core/privacyPolicy";
import { brandColor } from "@crewtavo/core/social";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv, Env } from "../env";
import { requireCompany, requireUser } from "../lib/auth";
import { runInBackground } from "../lib/background";
import { keyedHash, randomId, safeEqual, signToken, verifyToken } from "../lib/crypto";
import { renderEmail } from "../lib/email";
import { appUrl, dbError, HttpError, must, param, readJson, uuid } from "../lib/http";
import { allow, allowStrict } from "../lib/limit";
import { LINK_PAUSED, linkCanSend } from "../lib/linkBudget";
import { emailReady, sendEmail } from "../lib/notify";
import { storedFile } from "../lib/storedFile";
import { adminClient, type Db } from "../lib/supabase";
import { clientIp } from "../lib/visitor";
import { withoutMetadata } from "../services/guideShares";
import { logoImage } from "../services/logo";
import { newSignInCode } from "../services/signInCodes";

export const guideShares = new Hono<AppEnv>();

type Ctx = Parameters<typeof appUrl>[0];

/** Who decides who a guide is shared with: owners and admins who edit guides. */
const sharer = requireCompany(ADMINS, "kb_edit");

// ---------------------------------------------------------------------------------------------
// The office: a guide's link and who it's shared with
// ---------------------------------------------------------------------------------------------

const SHARE = "page_id, token, access";
const PERSON = "id, email, created_at, last_opened_at";
/** Invitations a business sends in an hour, across its guides. */
const INVITES_AN_HOUR = 100;

type ShareRow = { page_id: string; token: string; access: string };
type Guide = { id: string; title: string; status: string };

/** The guide, when it's this company's and the person can see it. */
async function guideOf(c: Ctx): Promise<Guide> {
  const id = param(c, "id");
  return must(await c.var.db.from("sop_pages").select("id, title, status").eq("id", id).eq("company_id", c.var.companyId).maybeSingle(), "This guide doesn't exist, or it was deleted.");
}

/** The guide's share, made the first time anyone asks: for nobody outside the team until someone is added. */
async function shareOf(c: Ctx, guide: Guide): Promise<ShareRow> {
  const { db, companyId } = c.var;
  const found = await db.from("sop_shares").select(SHARE).eq("page_id", guide.id).maybeSingle();
  if (found.error) throw dbError(found.error);
  if (found.data) return found.data;
  const made = await db.from("sop_shares").insert({ page_id: guide.id, company_id: companyId }).select(SHARE).single();
  // Two people opened Share at once: the other one's is the guide's.
  if (made.error?.code === "23505") return must(await db.from("sop_shares").select(SHARE).eq("page_id", guide.id).maybeSingle());
  return must(made);
}

async function shareState(c: Ctx, guide: Guide, share: ShareRow) {
  const people = must(await c.var.db.from("sop_share_people").select(PERSON).eq("page_id", guide.id).order("created_at").order("email"));
  return {
    access: (share.access === "anyone" ? "anyone" : "restricted") as GuideShareAccess,
    url: guideShareUrl(appUrl(c), share.token),
    /** A draft's link says the guide isn't available. */
    published: guide.status === "published",
    /** Without email, nobody can be sent a code: only a link for anyone works. */
    email_ready: await emailReady(c.env, c.var.companyId),
    people,
  };
}

guideShares.post("/guides/:id/share", requireUser, sharer, async (c) => {
  const guide = await guideOf(c);
  return c.json(await shareState(c, guide, await shareOf(c, guide)));
});

guideShares.patch("/guides/:id/share", requireUser, sharer, async (c) => {
  const body = await readJson(c, z.object({ access: z.enum(GUIDE_SHARE_ACCESS) }));
  const guide = await guideOf(c);
  await shareOf(c, guide);
  const share = must(await c.var.db.from("sop_shares").update({ access: body.access }).eq("page_id", guide.id).select(SHARE).maybeSingle(), "This guide doesn't exist, or it was deleted.");
  return c.json(await shareState(c, guide, share));
});

/** The email that tells someone a guide was shared with them, with its link. Whether it went, and why not. */
async function invite(c: Ctx, guide: Guide, share: ShareRow, to: string, company: { name: string; settings: unknown }, by: string | null) {
  const base = appUrl(c);
  const message = guideInviteEmail({ companyName: company.name, title: guide.title, url: guideShareUrl(base, share.token), by, access: share.access === "anyone" ? "anyone" : "restricted" });
  const email = renderEmail({ companyName: company.name, logo: logoImage(base, c.var.companyId, company.settings), text: message.text, button: "Open the guide" });
  return sendEmail(c.env, { to, subject: message.subject, text: email.text, html: email.html, fromName: company.name }, c.var.companyId);
}

/** What an invitation is sent as: the company, and the name of whoever shared it. */
async function sender(c: Ctx) {
  const admin = adminClient(c.env);
  const [company, profile] = await Promise.all([
    admin.from("companies").select("name, settings").eq("id", c.var.companyId).maybeSingle(),
    admin.from("profiles").select("full_name").eq("user_id", c.var.userId).maybeSingle(),
  ]);
  return { company: must(company), by: profile.data?.full_name?.trim() || null };
}

/** Why nobody is emailed a guide's link right now, or null when they can be. */
async function cantEmail(c: Ctx, guide: Guide): Promise<string | null> {
  if (guide.status !== "published") return "It's a draft, so nobody was emailed. Publish it, then email them the link.";
  if (!(await emailReady(c.env, c.var.companyId))) return "Email isn't set up in Crewtavo, so nobody was emailed. Connect it in Settings, then email them the link.";
  return null;
}

guideShares.post("/guides/:id/share/people", requireUser, sharer, async (c) => {
  const body = await readJson(c, z.object({ emails: z.array(z.string().trim().max(254)).min(1, "Type an email address.").max(MAX_SHARE_ADD, `Add up to ${MAX_SHARE_ADD} people at a time.`) }));
  const bad = body.emails.find((e) => !emailKey(e));
  if (bad !== undefined) throw new HttpError(400, `${bad || "That"} isn't an email address.`);
  const emails = [...new Set(body.emails.map((e) => emailKey(e)!))];
  const guide = await guideOf(c);
  const share = await shareOf(c, guide);
  const { db, companyId } = c.var;
  const already = new Set(must(await db.from("sop_share_people").select("email").eq("page_id", guide.id)).map((p) => p.email));
  const fresh = emails.filter((e) => !already.has(e));
  // Said before anyone is added, so a list that's too long adds nobody rather than some.
  const room = MAX_SHARE_PEOPLE - already.size;
  if (fresh.length > room) {
    throw new HttpError(400, `A guide can be shared with up to ${MAX_SHARE_PEOPLE} people, and this one has ${already.size}${room > 0 ? `, so ${room} more can be added` : ""}. To reach more, let anyone with the link open it.`);
  }
  if (fresh.length) {
    // Someone else adding one of them just now isn't a problem: they're added once.
    const { error } = await db.from("sop_share_people").upsert(fresh.map((email) => ({ company_id: companyId, page_id: guide.id, email })), { onConflict: "page_id,email", ignoreDuplicates: true });
    if (error) throw dbError(error);
  }

  // Each new person is emailed the link, one by one, and the office hears who wasn't and why.
  const emailed: string[] = [];
  let problem = fresh.length ? await cantEmail(c, guide) : null;
  if (fresh.length && !problem) {
    const from = await sender(c);
    for (const to of fresh) {
      if (!(await allow(c.env, `guide-invite:company:${companyId}`, INVITES_AN_HOUR, 3600))) {
        problem = "That's a lot of invitations in an hour, so the rest weren't emailed. Email them the link later.";
        break;
      }
      const result = await invite(c, guide, share, to, from.company, from.by);
      if (result.sent) emailed.push(to);
      else problem ??= result.reason ?? "The email couldn't be sent.";
    }
  }
  return c.json({ ...(await shareState(c, guide, share)), added: fresh, emailed, not_emailed: fresh.filter((e) => !emailed.includes(e)), problem: emailed.length === fresh.length ? null : problem });
});

guideShares.post("/guides/:id/share/people/:person/email", requireUser, sharer, async (c) => {
  const guide = await guideOf(c);
  const share = await shareOf(c, guide);
  const person = must(await c.var.db.from("sop_share_people").select("email").eq("id", param(c, "person")).eq("page_id", guide.id).maybeSingle(), "They aren't on this guide any more.");
  const problem = await cantEmail(c, guide);
  if (problem) throw new HttpError(409, problem);
  if (!(await allow(c.env, `guide-invite:company:${c.var.companyId}`, INVITES_AN_HOUR, 3600))) throw new HttpError(429, "That's a lot of invitations in an hour. Try again later.");
  const from = await sender(c);
  const result = await invite(c, guide, share, person.email, from.company, from.by);
  if (!result.sent) throw new HttpError(502, result.reason ?? "The email couldn't be sent.");
  return c.json({ emailed: person.email });
});

guideShares.delete("/guides/:id/share/people/:person", requireUser, sharer, async (c) => {
  const guide = await guideOf(c);
  const { error } = await c.var.db.from("sop_share_people").delete().eq("id", param(c, "person")).eq("page_id", guide.id);
  if (error) throw dbError(error);
  return c.json(await shareState(c, guide, await shareOf(c, guide)));
});

/** A new link for a guide whose link went somewhere it shouldn't. The old one stops working at once. */
guideShares.post("/guides/:id/share/link", requireUser, sharer, async (c) => {
  const guide = await guideOf(c);
  await shareOf(c, guide);
  // The link is the server's to change (private.sop_share_guard): the person was checked above.
  const share = must(
    await adminClient(c.env).from("sop_shares").update({ token: newToken() }).eq("page_id", guide.id).eq("company_id", c.var.companyId).select(SHARE).maybeSingle(),
    "This guide doesn't exist, or it was deleted.",
  );
  return c.json(await shareState(c, guide, share));
});

/** A link's token: 32 hex characters, random (sop_shares.token). */
export const newToken = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");

// ---------------------------------------------------------------------------------------------
// The shared page: anyone with the link, or the people added
// ---------------------------------------------------------------------------------------------

const TOKEN = /^[0-9a-f]{32}$/;
const GONE = "This guide isn't available. The link may have changed, or the guide was taken down.";
const EMAIL_PROBLEM = "Enter your email address, like name@example.com.";
const CODE_WRONG = "That code isn't right. Check the email and try again.";
const CODE_EXPIRED = "That code has run out. Ask for a new one.";
const TOO_MANY_CODES = "Too many codes asked for. Wait a while and try again.";
const TOO_MANY_TRIES = "Too many tries. Ask for a new code.";
/** The visitor's own limits: a new code wouldn't help, only waiting does. */
const TOO_MANY_HERE = "Too many tries from this network. Wait an hour and try again.";
const NOT_SHARED = "This guide isn't shared with that address any more.";
/** A guide's pictures are JPEGs the browser made, at most 1,600 pixels across: a few hundred KB. */
const PICTURE_MAX_BYTES = 8_000_000;
/**
 * How long a shared page's pictures can be loaded before the page asks again: at least this long,
 * and up to twice it. A pass runs out on the hour-mark after next, so every page opened within the
 * same stretch gets the same pass and the same picture links: a page that asks again shows the
 * pictures it already has, instead of loading them all over.
 */
const PICTURE_HOURS = 6;
const pictureExpiry = (now = Date.now()) => (Math.floor(now / 1000 / (PICTURE_HOURS * 3600)) + 2) * PICTURE_HOURS * 3600;
/** A code asked for from one address (a shop's Wi-Fi, a phone carrier): a crew of new hires, not a script. */
const ASKS_AN_HOUR_HERE = 30;
const CHECKS_AN_HOUR_HERE = 60;
/** Codes the whole instance emails in an hour. */
const CODES_AN_HOUR = 200;

interface View {
  company_id: string;
  page_id: string;
  access: GuideShareAccess;
  allowed: boolean;
  /** Their row in the list, when it opened for someone who was added. */
  person_id?: string | null;
  title?: string;
  body_html?: string;
  cover_path?: string | null;
  revised_at?: string;
  category?: string | null;
}

/** The share at this link as this reader gets it (public.guide_share_view): null when it isn't there or the guide isn't published. */
async function viewOf(admin: Db, token: string, reader: { email?: string | null; person?: string | null } = {}, opened = false): Promise<View | null> {
  if (!TOKEN.test(token)) return null;
  const { data, error } = await admin.rpc("guide_share_view", {
    p_token: token,
    ...(reader.email ? { p_email: reader.email } : reader.person ? { p_person: reader.person } : {}),
    ...(opened ? { p_opened: true } : {}),
  });
  if (error) throw dbError(error);
  return (data as unknown as View | null) ?? null;
}

/** Visitors read guides at a pace no person needs to beat: the page, then its pictures. */
async function limitVisitor(c: Ctx) {
  if (!(await allow(c.env, `guide-share:${clientIp(c)}`, 240, 60))) throw new HttpError(429, "Too many requests. Try again in a minute.");
}

/** The address a browser proved with a code (the key it was given then), or null. */
async function provenEmail(env: Env, key: string | null | undefined): Promise<string | null> {
  if (!key || key.length > 600) return null;
  const payload = await verifyToken<{ k?: string; e?: string; exp: number }>(env, key).catch(() => null);
  return payload?.k === "guide-reader" && typeof payload.e === "string" ? emailKey(payload.e) : null;
}

/** The business as the page shows it: its name, logo and colour, and its country for writing dates its way; never anything of its team. */
async function brandOf(admin: Db, companyId: string) {
  const { data: company } = await admin.from("companies").select("name, phone, website, country, settings").eq("id", companyId).maybeSingle();
  if (!company) throw new HttpError(404, GONE);
  return { name: company.name, phone: company.phone, website: company.website, country: company.country, logo: logoImage("", companyId, company.settings)?.src ?? null, color: brandColor(company.settings), privacy_url: privacyUrl(company.settings as Record<string, unknown> | null) };
}

guideShares.post("/public/guides/:token", async (c) => {
  await limitVisitor(c);
  c.header("X-Robots-Tag", "noindex");
  c.header("Cache-Control", "no-store");
  const body = await readJson(c, z.object({ key: z.string().max(600).nullish() }));
  const admin = adminClient(c.env);
  const token = c.req.param("token") ?? "";
  const email = await provenEmail(c.env, body.key);
  const view = await viewOf(admin, token, { email }, true);
  if (!view) throw new HttpError(404, GONE);
  const company = await brandOf(admin, view.company_id);
  // For certain people, and this browser hasn't proved it's one of them: the page asks for an address.
  if (!view.allowed) return c.json({ locked: true, company });
  const restricted = view.access !== "anyone";
  // A page for certain people loads its pictures with a pass of its own: an <img> can't send the key. It names their row in the list, never their address.
  const pass = restricted && view.person_id ? await signToken(c.env, { k: "guide-pic", t: token, p: view.person_id, exp: pictureExpiry() }) : null;
  const src = (path: string) => `/api/public/guides/${token}/pictures/${pictureName(path)}${pass ? `?k=${encodeURIComponent(pass)}` : ""}`;
  const html = view.body_html ?? "";
  const pictures = sharedPictures(view.company_id, html, view.cover_path);
  return c.json({
    locked: false,
    company,
    title: view.title ?? "",
    category: view.category ?? null,
    revised_at: view.revised_at ?? null,
    html,
    cover: view.cover_path && pictures.includes(view.cover_path) ? src(view.cover_path) : null,
    pictures: Object.fromEntries(pictures.filter((p) => p !== view.cover_path || html.includes(p)).map((p) => [p, src(p)])),
    // Who it's open as, for "Not you?": only ever the address this browser proved.
    email: restricted ? email : null,
  });
});

guideShares.post("/public/guides/:token/code", async (c) => {
  c.header("X-Robots-Tag", "noindex");
  c.header("Cache-Control", "no-store");
  const body = await readJson(c, z.object({ email: z.string().max(254) }));
  const email = emailKey(body.email);
  if (!email) throw new HttpError(400, EMAIL_PROBLEM);
  if (!(await allowStrict(c.env, `guide-code:ip:${clientIp(c)}`, ASKS_AN_HOUR_HERE, 3600))) throw new HttpError(429, TOO_MANY_HERE);
  const admin = adminClient(c.env);
  const token = c.req.param("token") ?? "";
  const view = await viewOf(admin, token, { email });
  if (!view) throw new HttpError(404, GONE);
  if (view.access === "anyone") throw new HttpError(409, "This guide doesn't need a code. Reload the page to read it.");
  // An address's limits are counted at a link that is one, for that link: someone without the link can't use them up.
  const within = (await allowStrict(c.env, `guide-code:email:${token}:${email}`, 3, 15 * 60)) && (await allowStrict(c.env, `guide-code:email-day:${token}:${email}`, 8, 86_400));
  if (!within) throw new HttpError(429, TOO_MANY_CODES);

  // The same answer whether or not the address was added: an address that wasn't gets a code nobody has.
  const code = newSignInCode();
  const nonce = randomId(12);
  const challenge = await signToken(c.env, {
    k: "guide-code", t: token, e: email, n: nonce,
    h: await keyedHash(c.env, `guide-code:${nonce}:${view.allowed ? code : randomId(16)}`),
    exp: Math.floor(Date.now() / 1000) + GUIDE_CODE_MINUTES * 60,
  });
  // The email goes after the answer, so how long the answer takes doesn't say whether one was sent.
  if (view.allowed) runInBackground(c, sendCode(c.env, appUrl(c), view, email, code));
  return c.json({ sent: true, challenge });
});

async function sendCode(env: Env, base: string, view: View, to: string, code: string) {
  if (!(await allowStrict(env, "guide-code:all", CODES_AN_HOUR, 3600))) {
    console.warn("A guide's code wasn't emailed: this Crewtavo has sent its limit of them for the hour.");
    return;
  }
  const { data: company } = await adminClient(env).from("companies").select("name, settings").eq("id", view.company_id).maybeSingle();
  if (!company) return;
  const message = guideCodeEmail({ companyName: company.name, title: view.title || "a guide", code });
  const email = renderEmail({ companyName: company.name, logo: logoImage(base, view.company_id, company.settings), text: message.text, code });
  const result = await sendEmail(env, { to, subject: message.subject, text: email.text, html: email.html, fromName: company.name }, view.company_id);
  if (!result.sent) console.warn(`A guide's code wasn't emailed: ${result.reason ?? "unknown reason"}`);
}

guideShares.post("/public/guides/:token/code/check", async (c) => {
  c.header("X-Robots-Tag", "noindex");
  c.header("Cache-Control", "no-store");
  const body = await readJson(c, z.object({ challenge: z.string().max(1000), code: z.string().max(20) }));
  if (!(await allowStrict(c.env, `guide-code-check:ip:${clientIp(c)}`, CHECKS_AN_HOUR_HERE, 3600))) throw new HttpError(429, TOO_MANY_HERE);
  const token = c.req.param("token") ?? "";
  const asked = await verifyToken<{ k?: string; t?: string; e?: string; n?: string; h?: string; exp: number }>(c.env, body.challenge).catch(() => null);
  if (!asked || asked.k !== "guide-code" || asked.t !== token || !asked.e || !asked.n || !asked.h) throw new HttpError(400, CODE_EXPIRED);
  if (!(await allowStrict(c.env, `guide-code-try:${asked.n}`, GUIDE_CODE_TRIES, GUIDE_CODE_MINUTES * 60))) throw new HttpError(429, TOO_MANY_TRIES);
  const typed = body.code.replace(/\D/g, "");
  if (!safeEqual(asked.h, await keyedHash(c.env, `guide-code:${asked.n}:${typed}`))) throw new HttpError(400, CODE_WRONG);
  // A code opens the guide once: typed again (by someone who saw it), it has run out.
  if (!(await allowStrict(c.env, `guide-code-used:${asked.n}`, 1, GUIDE_CODE_MINUTES * 60))) throw new HttpError(400, CODE_EXPIRED);
  const view = await viewOf(adminClient(c.env), token, { email: asked.e });
  if (!view) throw new HttpError(404, GONE);
  if (!view.allowed) throw new HttpError(403, NOT_SHARED);
  const key = await signToken(c.env, { k: "guide-reader", e: asked.e, exp: Math.floor(Date.now() / 1000) + GUIDE_KEY_DAYS * 86_400 });
  return c.json({ key, email: asked.e });
});

guideShares.on(["GET", "HEAD"], "/public/guides/:token/pictures/:name", async (c) => {
  await limitVisitor(c);
  const token = c.req.param("token") ?? "";
  const name = c.req.param("name") ?? "";
  const missing = () => new HttpError(404, "Picture not found.");
  if (!/^[0-9A-Za-z_-]+\.jpe?g$/.test(name)) throw missing();
  const pass = c.req.query("k");
  const shown = pass && pass.length <= 600 ? await verifyToken<{ k?: string; t?: string; p?: string; exp: number }>(c.env, pass).catch(() => null) : null;
  const person = shown?.k === "guide-pic" && shown.t === token && typeof shown.p === "string" && uuid.safeParse(shown.p).success ? shown.p : null;
  const admin = adminClient(c.env);
  const view = await viewOf(admin, token, { person });
  if (!view?.allowed) throw missing();
  const path = sharedPictures(view.company_id, view.body_html ?? "", view.cover_path).find((p) => pictureName(p) === name);
  const bytes = path ? await storedFile(admin, path, PICTURE_MAX_BYTES) : null;
  const clean = bytes ? withoutMetadata(bytes) : null;
  if (!clean) throw missing();
  const within = await linkCanSend(c.env, `guide:${token}`, c.req.method === "HEAD" ? 0 : clean.length, {
    company: view.company_id,
    title: "A shared guide's pictures are paused for the day",
    body: `The link to “${view.title || "a guide"}” has sent a lot of pictures in the last day, far more than people reading it need, so its pictures are paused until tomorrow; its words still show. If the link went somewhere it shouldn't, make a new one from the guide's Share.`,
    open: `/kb/${view.page_id}`,
  });
  if (!within) throw new HttpError(429, LINK_PAUSED);
  // Short-lived in caches: taking someone off, or a new link, should take the pictures away soon after the page.
  const headers = { "Content-Type": "image/jpeg", "Content-Length": String(clean.length), "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex", "Cache-Control": `${view.access === "anyone" ? "public" : "private"}, max-age=300` };
  return c.req.method === "HEAD" ? c.body(null, 200, headers) : c.body(clean, 200, headers);
});
