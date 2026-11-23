/**
 * Job showcases (supabase/migrations/20261113001410_showcases.sql): a finished job's before and
 * after photos and a write-up, on a public page by its link. The office writes one from the browser
 * (Make a showcase, on a finished job or visit); here, a write-up drafted by Claude when the
 * company's AI is set up, Publish and Unpublish, and the public page's data and photos.
 *
 * Publishing checks the photos (never a client's who asked that photos of their property not be
 * posted; one nobody marked OK to share only once someone says so here, which marks it) and the words
 * (never the client's name or street, as social posts), then makes the page's copies of the photos.
 */
import { OFFICE } from "@crewtavo/core";
import { marketingOn } from "@crewtavo/core/marketing";
import { privacyUrl } from "@crewtavo/core/privacyPolicy";
import { publishCheck, showcaseProblem, unsharedQuestion, type ShowcasePhotoFact } from "@crewtavo/core/showcases";
import { brandColor, mentionsClient } from "@crewtavo/core/social";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { requireCompany, requireUser } from "../lib/auth";
import { randomId } from "../lib/crypto";
import { appUrl, dbError, HttpError, must, param, readJson, uuid } from "../lib/http";
import { allow } from "../lib/limit";
import { LINK_PAUSED, linkCanSend } from "../lib/linkBudget";
import { shareJpeg, ShareImageError } from "../lib/shareImage";
import { storedFile } from "../lib/storedFile";
import { adminClient, type Db } from "../lib/supabase";
import { clientIp } from "../lib/visitor";
import { askerOf, complete, countAiAsk } from "../services/ai";
import { logoImage } from "../services/logo";
import { isJpeg } from "../services/photos";
import { clientWords, jobServices, photoFacts } from "../services/social";

export const showcases = new Hono<AppEnv>();

type Ctx = Parameters<typeof appUrl>[0];

/** A phone photo is a few MB; anything far bigger was never a photo. */
const PHOTO_MAX_BYTES = 30_000_000;
/** The page's copies: plenty for a phone or a laptop. */
const COPY_MAX_PX = 2048;
const COPY_MAX_BYTES = 8_000_000;

const NAMES_CLIENT_SHOWCASE = "The title or write-up names the client or their street. Take that out to publish: a showcase never says whose property it is.";

/** The public page's address. */
export const showcaseUrl = (base: string, token: string) => `${base.replace(/\/$/, "")}/s/${token}`;

async function requireMarketing(c: Ctx) {
  const company = must(await adminClient(c.env).from("companies").select("settings").eq("id", c.var.companyId).maybeSingle());
  if (!marketingOn(company.settings as Record<string, unknown> | null)) throw new HttpError(409, "Marketing is off, so showcases can't be published. An owner or admin can install it again in Apps.");
}

/**
 * What the write-up is drafted from: the business, the job's services by their line items' names,
 * and what the office typed for it. Never the job's title, which is often the client's name
 * ("Smith driveway"), nor the client or the address: none of that is sent to the AI at all.
 */
export function showcaseDraftPrompt(input: { company: { name: string; trade_preset: string }; services: readonly string[]; notes?: string | null }): string {
  return (
    `Business: ${input.company.name} (${input.company.trade_preset.replace(/_/g, " ")}).\n` +
    (input.services.length ? `Work done: ${input.services.join(", ")}\n` : "") +
    (input.notes ? `Notes from the office: ${input.notes}\n` : "")
  );
}

/** A write-up from Claude, from the job's services and the office's notes (showcaseDraftPrompt: never the job's title, the client's name or the address). */
showcases.post("/showcases/draft", requireUser, requireCompany(OFFICE, "marketing"), async (c) => {
  const body = await readJson(c, z.object({ job_id: uuid, notes: z.string().trim().max(600).optional() }));
  const admin = adminClient(c.env);
  // The job is read for whose words to keep out of the draft, not for anything to send.
  const job = must(await c.var.db.from("jobs").select("client_id").eq("company_id", c.var.companyId).eq("id", body.job_id).maybeSingle(), "Job not found.");
  await countAiAsk(c.env, c.var.companyId, c.var.userId);
  const [company, services, words] = await Promise.all([
    must(await c.var.db.from("companies").select("name, trade_preset").eq("id", c.var.companyId).maybeSingle()),
    jobServices(admin, c.var.companyId, [body.job_id]),
    clientWords(admin, c.var.companyId, [job.client_id]),
  ]);
  const text = await complete(c.env, {
    asker: askerOf(c),
    system:
      "You write the short write-up for a local service business's before-and-after project page (lawn care, paving, roofing and similar). " +
      "Write plainly, like the owner would: what the problem was, what the crew did and how it turned out, in two or three short sentences, with no hype, no emoji, no prices and no placeholders. " +
      "Never name the client or their street, and don't guess at details you weren't given. " +
      'Reply with JSON only: {"title": "...", "description": "..."}. The title is under 60 characters, like "Driveway resealed in Oak Ridge" without a place name unless given.',
    prompt: showcaseDraftPrompt({ company, services, notes: body.notes }),
    effort: "low",
    maxTokens: 800,
  });
  const match = text.match(/\{[\s\S]*\}/);
  let parsed: { title?: string; description?: string };
  try {
    parsed = JSON.parse(match ? match[0] : text) as { title?: string; description?: string };
  } catch {
    throw new HttpError(502, "The AI's draft came back in an unexpected shape. Try again.");
  }
  if (!parsed.title || !parsed.description) throw new HttpError(502, "The AI's draft came back in an unexpected shape. Try again.");
  const draft = { title: parsed.title.trim().slice(0, 120), description: parsed.description.trim().slice(0, 2000) };
  // The model was told not to; this makes sure.
  if (mentionsClient(`${draft.title}\n${draft.description}`, words).blocked.length) throw new HttpError(502, "The AI's draft named the client. Try again, or write it yourself.");
  return c.json(draft);
});

/** The page's copy of one photo: its drawing or the photo as taken, without EXIF, under a name nobody can guess. */
async function makeCopy(admin: Db, companyId: string, showcaseId: string, photo: { path: string; marked_path: string | null }, useMarked: boolean): Promise<string> {
  const bytes = await storedFile(admin, (useMarked && photo.marked_path) || photo.path, PHOTO_MAX_BYTES);
  if (!bytes) throw new HttpError(400, "One of the photos couldn't be read. Take it off and try again.");
  let made;
  try {
    made = await shareJpeg(bytes, { max: COPY_MAX_PX });
  } catch (error) {
    if (error instanceof ShareImageError) throw new HttpError(400, "One of the photos can't be shown on the page: only JPEG and PNG photos can. Take it off and try again.");
    throw error;
  }
  const path = `${companyId}/showcases/${showcaseId}/${randomId(16)}.jpg`;
  const { error } = await admin.storage.from("files").upload(path, made.body, { contentType: "image/jpeg", upsert: true });
  if (error) throw new Error(`Couldn't save a showcase photo: ${error.message}`);
  return path;
}

/** Removes a showcase's copies, so nothing of it is served once it's unpublished. */
async function removeCopies(admin: Db, showcaseId: string) {
  const { data } = await admin.from("showcase_photos").select("id, public_path").eq("showcase_id", showcaseId).not("public_path", "is", null);
  const paths = (data ?? []).map((p) => p.public_path!).filter(Boolean);
  if (paths.length) await admin.storage.from("files").remove(paths);
  await admin.from("showcase_photos").update({ public_path: null }).eq("showcase_id", showcaseId);
}

/**
 * Publish: the photos checked (`confirm_unshared` says the office was asked about any not marked OK
 * to share, and marks them, with who said so), the words checked, the copies made, and the page goes
 * live at its link. Publishing again makes the copies afresh.
 */
showcases.post("/showcases/:id/publish", requireUser, requireCompany(OFFICE, "marketing"), async (c) => {
  const body = await readJson(c, z.object({ confirm_unshared: z.boolean().default(false) }));
  await requireMarketing(c);
  const id = param(c, "id");
  const admin = adminClient(c.env);
  const showcase = must(await c.var.db.from("showcases").select("id, job_id, title, description, status, token").eq("company_id", c.var.companyId).eq("id", id).maybeSingle(), "Showcase not found.");
  const { data: picked, error } = await admin.from("showcase_photos").select("id, attachment_id, use_marked").eq("showcase_id", id).order("sort").order("id");
  if (error) throw dbError(error);
  const problem = showcaseProblem({ title: showcase.title, description: showcase.description, photos: picked?.length ?? 0 });
  if (problem) throw new HttpError(400, problem);
  const ids = picked!.map((p) => p.attachment_id);
  const facts = (await photoFacts(admin, c.var.companyId, ids)) as unknown as ShowcasePhotoFact[];
  const check = publishCheck(showcase.job_id, ids, facts);
  if (!check.ok) throw new HttpError(400, check.reason);
  if (check.unshared && !body.confirm_unshared) throw new HttpError(409, `${unsharedQuestion(check.unshared, ids.length)} Publish again and say so to show them.`);
  const { data: job } = await admin.from("jobs").select("client_id").eq("id", showcase.job_id).maybeSingle();
  if (mentionsClient(`${showcase.title}\n${showcase.description}`, await clientWords(admin, c.var.companyId, [job?.client_id])).blocked.length) {
    throw new HttpError(400, NAMES_CLIENT_SHOWCASE);
  }
  // The office said yes: those photos are OK to share from now on, recorded as theirs.
  for (const fact of facts.filter((f) => !f.shareable)) {
    const { error: share } = await c.var.db.rpc("set_photo_shareable", { p_attachment: fact.id, p_shareable: true });
    if (share) throw new HttpError(400, share.message);
  }
  await removeCopies(admin, id);
  const { data: rows } = await admin.from("attachments").select("id, path, marked_path").eq("company_id", c.var.companyId).in("id", ids);
  for (const p of picked!) {
    const photo = rows?.find((r) => r.id === p.attachment_id);
    if (!photo) throw new HttpError(400, "One of the photos isn't there anymore. Take it off and try again.");
    const path = await makeCopy(admin, c.var.companyId, id, photo, p.use_marked);
    await admin.from("showcase_photos").update({ public_path: path }).eq("id", p.id);
  }
  const { error: published } = await admin
    .from("showcases")
    .update({ status: "published", published_at: new Date().toISOString(), published_by: c.var.userId, unpublished_at: null, unpublished_reason: null })
    .eq("id", id);
  if (published) throw dbError(published);
  return c.json({ status: "published", url: showcaseUrl(appUrl(c), showcase.token), marked_ok: check.unshared });
});

/** Unpublish: the link shows "This showcase isn't available", and the page's copies are deleted. */
showcases.post("/showcases/:id/unpublish", requireUser, requireCompany(OFFICE, "marketing"), async (c) => {
  const id = param(c, "id");
  must(await c.var.db.from("showcases").select("id").eq("company_id", c.var.companyId).eq("id", id).maybeSingle(), "Showcase not found.");
  const admin = adminClient(c.env);
  // Unpublished by someone, not taken down by itself: no reason to show.
  const { error } = await admin.from("showcases").update({ status: "unpublished", unpublished_at: new Date().toISOString(), unpublished_reason: null }).eq("id", id);
  if (error) throw dbError(error);
  await removeCopies(admin, id);
  return c.json({ status: "unpublished" });
});

// ---------------------------------------------------------------------------------------------
// The public page (/s/:token in the web app)
// ---------------------------------------------------------------------------------------------

const TOKEN = /^[0-9a-f]{32}$/;
const GONE = "This showcase isn't available";

/** Visitors read showcases at a pace no person needs to beat: the page, then its photos. */
async function limitVisitor(c: Ctx) {
  if (!(await allow(c.env, `showcase:${clientIp(c)}`, 240, 60))) throw new HttpError(429, "Too many requests. Try again in a minute.");
}

type View = { company_id: string; title: string; description: string; town: string | null; region: string | null; published_at: string; photos: Array<{ id: number; role: string }> };

async function viewOf(admin: Db, token: string): Promise<View | null> {
  if (!TOKEN.test(token)) return null;
  const { data, error } = await admin.rpc("showcase_view", { p_token: token });
  if (error) throw dbError(error);
  return (data as unknown as View | null) ?? null;
}

showcases.get("/public/showcases/:token", async (c) => {
  await limitVisitor(c);
  c.header("X-Robots-Tag", "noindex");
  const admin = adminClient(c.env);
  const token = c.req.param("token") ?? "";
  const view = await viewOf(admin, token);
  if (!view) throw new HttpError(404, GONE);
  const { data: company } = await admin.from("companies").select("name, phone, website, slug, settings").eq("id", view.company_id).maybeSingle();
  if (!company) throw new HttpError(404, GONE);
  // Get a quote: the business's booking form (its first active one), on this same site.
  const { data: form } = company.slug ? await admin.from("intake_forms").select("slug").eq("company_id", view.company_id).eq("active", true).order("created_at").limit(1).maybeSingle() : { data: null };
  return c.json({
    company: { name: company.name, phone: company.phone, website: company.website, logo: logoImage("", view.company_id, company.settings)?.src ?? null, color: brandColor(company.settings), privacy_url: privacyUrl(company.settings as Record<string, unknown> | null) },
    title: view.title,
    description: view.description,
    town: view.town ? [view.town, view.region].filter(Boolean).join(", ") : null,
    published_at: view.published_at,
    photos: view.photos.map((p) => ({ role: p.role, src: `/api/public/showcases/${token}/${p.id}.jpg` })),
    // Only the business's own booking form: a showcase with none has no button.
    book_url: form ? `/book/${company.slug}/${form.slug}` : null,
  });
});

showcases.on(["GET", "HEAD"], "/public/showcases/:token/:file", async (c) => {
  await limitVisitor(c);
  const token = c.req.param("token") ?? "";
  const file = /^(\d{1,15})\.jpg$/.exec(c.req.param("file") ?? "");
  const admin = adminClient(c.env);
  const view = file ? await viewOf(admin, token) : null;
  const photoId = file ? Number(file[1]) : NaN;
  if (!view || !view.photos.some((p) => p.id === photoId)) throw new HttpError(404, "Photo not found.");
  const { data } = await admin.from("showcase_photos").select("public_path").eq("id", photoId).maybeSingle();
  const bytes = data?.public_path ? await storedFile(admin, data.public_path, COPY_MAX_BYTES) : null;
  if (!bytes || !isJpeg(bytes)) throw new HttpError(404, "Photo not found.");
  // At most a day's worth through one showcase's link (lib/linkBudget.ts).
  const within = await linkCanSend(c.env, `showcase:${token}`, c.req.method === "HEAD" ? 0 : bytes.length, {
    company: view.company_id,
    title: "A showcase's photos are paused for the day",
    body: `The link to the showcase “${view.title}” has sent a lot of photos in the last day, far more than visitors need, so its photos are paused until tomorrow; its words still show. If that's more than you expected, unpublishing it takes the page down.`,
    open: "/marketing?tab=showcases",
  });
  if (!within) throw new HttpError(429, LINK_PAUSED);
  // Short-lived in caches: unpublishing should take the photos down soon after the page.
  const headers = { "Content-Type": "image/jpeg", "Content-Length": String(bytes.length), "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex", "Cache-Control": "public, max-age=300" };
  return c.req.method === "HEAD" ? c.body(null, 200, headers) : c.body(bytes, 200, headers);
});
