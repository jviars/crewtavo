/**
 * Subcontractors' paperwork links (services/subs.ts) and their own sign-ins (services/subAccess.ts).
 *
 * The office (owners, admins and office staff with the subs area) makes a sub's link and sends it
 * by email or text, gives a sub a sign-in, texts them a link to sign in with, or takes it away, and
 * deletes a sub here, so their sign-in goes with them. Everything else about subs and their
 * documents the web app reads and changes itself, under row-level security; a signed-in sub reads
 * their own paperwork and sends in new documents the same way.
 *
 * The link opens a page where the sub, without an account, sends in their W-9 and certificates,
 * the booking form's way: a one-time upload link for the file, then recording it if it really
 * arrived. These public routes use the admin client, so every query is held to the company and the
 * sub in the link, and they answer with only the company's name and logo, the sub's business name
 * and what's still needed.
 */
import { DISPATCH, endDateProblem, isSubDocumentKind, localDate, OFFICE, subDocumentLabel, SUB_DOCUMENT_EXPIRES, SUB_DOCUMENT_KINDS, type SubDocumentKind } from "@crewtavo/core";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { requireCompany, requireUser } from "../lib/auth";
import { signToken, verifyToken } from "../lib/crypto";
import { appUrl, dbError, HttpError, isoDate, must, param, readJson } from "../lib/http";
import { allow } from "../lib/limit";
import { readClientLink } from "../lib/links";
import { adminClient } from "../lib/supabase";
import { clientIp } from "../lib/visitor";
import { logoImage } from "../services/logo";
import { deleteSub, grantSubAccess, removeSubAccess, sendSignInLink, subAccess, subAccessList, subCodeEmailShared, subLogins, type SubAccessScope } from "../services/subAccess";
import { paperworkLink, sendPaperworkLink, subPaperwork } from "../services/subs";
import { UPLOAD_LIMIT } from "../services/uploads";

export const subs = new Hono<AppEnv>();

// ---------------------------------------------------------------------------------------------
// The office
// ---------------------------------------------------------------------------------------------

const office = requireCompany(OFFICE, "subs");

/** The sub, read as the signed-in person: their role and area decide whether it's found at all. */
async function officeSub(c: Context<AppEnv>) {
  const id = param(c, "id");
  return must(await c.var.db.from("subcontractors").select("id, active").eq("company_id", c.var.companyId).eq("id", id).maybeSingle(), "Subcontractor not found.");
}

// The sub's link, to copy.
subs.post("/subs/:id/upload-link", requireUser, office, async (c) => {
  const sub = await officeSub(c);
  if (!sub.active) throw new HttpError(400, "This sub is turned off. Turn them back on to send them a link.");
  return c.json(await paperworkLink(c.env, appUrl(c), c.var.companyId, sub.id));
});

// The sub's link by email and/or text, to their email and phone on file. The link comes back too.
subs.post("/subs/:id/send-upload-link", requireUser, office, async (c) => {
  const body = await readJson(
    c,
    z.object({
      channels: z.array(z.enum(["email", "sms"])).min(1, "Choose email or text.").max(2),
      message: z.string().trim().max(1000).nullable().optional(),
    }),
  );
  const sub = await officeSub(c);
  return c.json(await sendPaperworkLink({ db: c.var.db, env: c.env, companyId: c.var.companyId, baseUrl: appUrl(c) }, sub.id, body));
});

// ---------------------------------------------------------------------------------------------
// A sub's own sign-in
// ---------------------------------------------------------------------------------------------

const accessScope = (c: Context<AppEnv>): SubAccessScope => ({ db: c.var.db, env: c.env, companyId: c.var.companyId, baseUrl: appUrl(c) });

// Where each sub's sign-in stands (subs that never had one aren't listed).
subs.get("/subs/access", requireUser, office, async (c) => c.json(await subAccessList(accessScope(c))));

// Where one sub's sign-in stands.
subs.get("/subs/:id/access", requireUser, office, async (c) => c.json(await subAccess(accessScope(c), param(c, "id"))));

// Whether another of the company's subs' sign-ins has the same email, so codes by email go to neither.
subs.get("/subs/:id/code-email", requireUser, office, async (c) => c.json(await subCodeEmailShared(accessScope(c), param(c, "id"))));

// A sign-in without a link (for a sub who already has their own, say), or one given back.
subs.post("/subs/:id/access", requireUser, office, async (c) => c.json(await grantSubAccess(accessScope(c), param(c, "id")), 201));

// Their sign-in stops working here at once. Their visits, paperwork and history stay.
subs.delete("/subs/:id/access", requireUser, office, async (c) => c.json(await removeSubAccess(accessScope(c), param(c, "id"))));

// The sub deleted, and their sign-in with them: every phone it's on is signed out.
subs.delete("/subs/:id", requireUser, office, async (c) => c.json(await deleteSub(accessScope(c), param(c, "id"))));

// A one-time link that signs the sub in (giving them a sign-in first if they have none), texted,
// emailed or neither. The link comes back to copy either way.
subs.post("/subs/:id/sign-in-link", requireUser, office, async (c) => {
  const body = await readJson(c, z.object({ send: z.enum(["text", "email", "none"]).default("text") }));
  if (!(await allow(c.env, `sub-sign-in-link:${c.var.userId}`, 20, 3600))) throw new HttpError(429, "Too many sign-in links. Wait a while and try again.");
  return c.json(await sendSignInLink(accessScope(c), param(c, "id"), body.send));
});

// The subs who can sign in, to put on a visit: for anyone who schedules the whole team.
subs.get("/subs/logins", requireUser, requireCompany(DISPATCH, "schedule"), async (c) => c.json(await subLogins(c.env, c.var.companyId)));

// ---------------------------------------------------------------------------------------------
// The sub's page (no account)
// ---------------------------------------------------------------------------------------------

const EXPIRED = "This link has expired or isn't valid. Ask for a new one.";
const TOO_MANY = "Too many tries. Try again later, or call us.";

/** The sub in the link: still on the company's books and turned on. Counts the visit by IP first and by link after. */
async function linkSub(c: Context<AppEnv>, limit: { kind: string; max: number }) {
  if (!(await allow(c.env, `paperwork-${limit.kind}:ip:${clientIp(c)}`, limit.max, 60 * 60))) throw new HttpError(429, TOO_MANY);
  const payload = await readClientLink(c.env, c.req.param("token") ?? "");
  if (!payload || payload.t !== "sub" || !z.uuid().safeParse(payload.id).success || !z.uuid().safeParse(payload.c).success) throw new HttpError(404, EXPIRED);
  if (!(await allow(c.env, `paperwork-${limit.kind}:sub:${payload.id}`, limit.max, 60 * 60))) throw new HttpError(429, TOO_MANY);
  const admin = adminClient(c.env);
  const { data: sub, error } = await admin.from("subcontractors").select("id, company_id, name, active").eq("company_id", payload.c).eq("id", payload.id).maybeSingle();
  if (error) throw dbError(error);
  if (!sub?.active) throw new HttpError(404, EXPIRED);
  return { admin, sub, companyId: payload.c };
}

// What the page shows: who's asking, the sub's business name, and what's still needed.
subs.get("/public/paperwork/:token", async (c) => {
  const { admin, sub, companyId } = await linkSub(c, { kind: "page", max: 60 });
  const company = must(await admin.from("companies").select("name, settings").eq("id", companyId).maybeSingle(), EXPIRED);
  const paperwork = await subPaperwork(admin, companyId, sub.id);
  return c.json({
    company: { name: company.name, logo: logoImage("", companyId, company.settings)?.src ?? null },
    sub: { name: sub.name },
    ...paperwork,
    kinds: SUB_DOCUMENT_KINDS.map((k) => ({ key: k.key, label: k.label, expires: SUB_DOCUMENT_EXPIRES[k.key] })),
    max_bytes: UPLOAD_LIMIT,
  });
});

// PDFs and pictures, the way phones and scanners make them.
const FILE_TYPES: Record<string, string[]> = {
  pdf: ["application/pdf"],
  jpg: ["image/jpeg"],
  jpeg: ["image/jpeg"],
  png: ["image/png"],
  heic: ["image/heic", "image/heif"],
  heif: ["image/heif", "image/heic"],
  webp: ["image/webp"],
};
const ALLOWED_TYPES = new Set(Object.values(FILE_TYPES).flat());
const ONLY_THESE = "Send a PDF or a photo (JPG, PNG or HEIC).";
const extensionOf = (name: string) => name.match(/\.([a-z0-9]{1,8})$/i)?.[1]?.toLowerCase() ?? "";

interface SubFilesToken { purpose: "sub-files"; c: string; s: string; k: SubDocumentKind; p: string; n: string; exp: number }

// A one-time link to upload one document's file, straight to Storage, in the sub's own folder.
subs.post("/public/paperwork/:token/uploads", async (c) => {
  const body = await readJson(
    c,
    z.object({
      kind: z.string().refine(isSubDocumentKind, "Choose what you're sending."),
      file: z.object({ name: z.string().trim().min(1).max(255), size: z.number().int().positive().max(UPLOAD_LIMIT), type: z.string().max(150).optional() }),
    }),
  );
  const { admin, sub, companyId } = await linkSub(c, { kind: "upload", max: 20 });
  const ext = extensionOf(body.file.name);
  if (!FILE_TYPES[ext] || (body.file.type && !FILE_TYPES[ext]!.includes(body.file.type.toLowerCase()))) throw new HttpError(400, ONLY_THESE);
  const path = `${companyId}/subs/${sub.id}/${crypto.randomUUID()}.${ext}`;
  const { data, error } = await admin.storage.from("files").createSignedUploadUrl(path);
  if (error || !data) throw new HttpError(503, "We couldn't get ready for your file. Try again in a minute.");
  const filesToken = await signToken(c.env, {
    purpose: "sub-files", c: companyId, s: sub.id, k: body.kind as SubDocumentKind, p: path, n: body.file.name, exp: Math.floor(Date.now() / 1000) + 3 * 60 * 60,
  } satisfies SubFilesToken);
  return c.json({ path, token: data.token, files_token: filesToken }, 201);
});

// After the upload: the document goes on the sub's paperwork, waiting for the office to check it
// (the database tells the office). Only a file that really arrived, as a PDF or picture. A
// certificate needs the date it ends, and not one already past by the company's today: anyone with
// the link can call this, and an undated one would read OK for good.
subs.post("/public/paperwork/:token/files", async (c) => {
  const body = await readJson(
    c,
    z.object({
      files_token: z.string().max(4000),
      expires_on: isoDate.nullable().optional(),
      carrier: z.string().trim().max(120).nullable().optional(),
      policy_number: z.string().trim().max(80).nullable().optional(),
    }),
  );
  const { admin, sub, companyId } = await linkSub(c, { kind: "files", max: 30 });
  const token = await verifyToken<SubFilesToken>(c.env, body.files_token);
  if (!token || token.purpose !== "sub-files" || token.c !== companyId || token.s !== sub.id || !isSubDocumentKind(token.k)) {
    throw new HttpError(400, "That upload has run out. Send the file again.");
  }
  const expires = SUB_DOCUMENT_EXPIRES[token.k] ? body.expires_on ?? null : null;
  const company = must(await admin.from("companies").select("timezone").eq("id", companyId).maybeSingle(), EXPIRED);
  const dateProblem = endDateProblem(token.k, expires, localDate(new Date(), company.timezone || "UTC"));
  if (dateProblem) throw new HttpError(400, dateProblem);
  const { data: info } = await admin.storage.from("files").info(token.p);
  if (!info) return c.json({ added: 0 });
  const type = (info.contentType ?? "").toLowerCase().split(";")[0]!.trim();
  if (!ALLOWED_TYPES.has(type)) {
    await admin.storage.from("files").remove([token.p]);
    throw new HttpError(400, ONLY_THESE);
  }
  const { data, error } = await admin
    .from("sub_documents")
    .upsert(
      {
        company_id: companyId, subcontractor_id: sub.id, kind: token.k, title: subDocumentLabel(token.k), path: token.p, file_name: token.n.slice(0, 255),
        content_type: type, size_bytes: info.size ?? null, expires_on: expires, carrier: body.carrier || null, policy_number: body.policy_number || null, uploaded_via: "link",
      },
      { onConflict: "path", ignoreDuplicates: true },
    )
    .select("id");
  if (error) throw dbError(error);
  return c.json({ added: data?.length ?? 0 });
});
