/**
 * Postcard campaigns (services/postcards.ts): what Send needs and has (GET /postcards/setup), Send
 * and Stop, and the front picture Lob fetches while it makes the cards. A draft itself is written
 * from the browser (postcard_campaigns, under row-level security).
 */
import { ADMINS, OFFICE } from "@crewtavo/core";
import { addressLine } from "@crewtavo/core/postcards";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { kickPostcards } from "../lib/background";
import { requireCompany, requireUser } from "../lib/auth";
import { HttpError, param, readJson } from "../lib/http";
import { allow } from "../lib/limit";
import { adminClient } from "../lib/supabase";
import { clientIp } from "../lib/visitor";
import { isJpeg } from "../services/photos";
import { bookingLink, companyLob, frontImage, keyLabelProblem, mailProof, returnAddress, returnAddressProblem, startPostcards, stopPostcards } from "../services/postcards";
import { imagesPublic } from "../services/social";

export const postcards = new Hono<AppEnv>();

/**
 * What a postcard campaign's page needs to say before Send: Lob's key (test or live, never the key),
 * whether Lob can fetch the front from this server, and the return address printed on each card.
 */
postcards.get("/postcards/setup", requireUser, requireCompany(OFFICE, "marketing"), async (c) => {
  const admin = adminClient(c.env);
  const [lob, company] = await Promise.all([
    companyLob(c.env, admin, c.var.companyId).catch(() => null),
    admin.from("companies").select("name, address, country, slug, website").eq("id", c.var.companyId).maybeSingle(),
  ]);
  const from = company.data ? returnAddress(company.data) : null;
  return c.json({
    // The key's own kind, read from the key; `problem` when Apps says it's the other kind.
    lob: lob ? { mode: lob.mode, problem: keyLabelProblem(lob) } : null,
    public_address: imagesPublic(c.env),
    return_address: from ? addressLine(from) : null,
    // What Lob would refuse about it (a state it can't read, say), or null.
    return_address_problem: company.data ? returnAddressProblem(company.data) : null,
    link: company.data ? await bookingLink(c.env, admin, c.var.companyId, company.data) : "",
    can_connect: ADMINS.includes(c.var.role) && c.var.permissions.includes("apps"),
    // A live key spends money: sending with one is an owner's or admin's.
    can_send_live: ADMINS.includes(c.var.role),
    // Lob's API doesn't say what a card costs: that's in the business's own Lob account.
    price: null,
  });
});

/** The card and audience as the page showed them: the server sends nothing when that isn't what's saved. */
const DRAFT = z.object({
  message: z.string().max(4000),
  size: z.string().max(10),
  front_attachment_id: z.string().max(64).nullable(),
  front_marked: z.boolean(),
  front_path: z.string().max(600).nullable(),
  audience: z.record(z.string(), z.unknown()),
});
const ASK = z.object({ confirm: z.number().int().min(0).nullable().optional(), mode: z.enum(["test", "live"]).optional(), draft: DRAFT.optional() });

/**
 * Send: for a live key, `confirm` is the number of cards the office was asked to confirm, and only
 * an owner or admin may; `mode` is the kind of key the page said it is; `draft` is what the page showed.
 */
postcards.post("/postcards/:id/send", requireUser, requireCompany(OFFICE, "marketing"), async (c) => {
  const body = await readJson(c, ASK);
  const id = param(c, "id");
  const result = await startPostcards(c.env, c.var.db, c.var.companyId, id, { confirm: body.confirm ?? null, shown: body.mode ?? null, sendLive: ADMINS.includes(c.var.role), draft: body.draft ?? null });
  kickPostcards(c, id);
  return c.json(result);
});

/**
 * Mail one to us first: one card of the draft to the company's own address, live or test. The same
 * checks as Send; with a live key `confirm` is 1, the one card Lob charges for, and only an owner
 * or admin may.
 */
postcards.post("/postcards/:id/proof", requireUser, requireCompany(OFFICE, "marketing"), async (c) => {
  const body = await readJson(c, ASK);
  return c.json(await mailProof(c.env, c.var.db, c.var.companyId, param(c, "id"), c.var.userId, { confirm: body.confirm ?? null, shown: body.mode ?? null, sendLive: ADMINS.includes(c.var.role), draft: body.draft ?? null }));
});

postcards.post("/postcards/:id/stop", requireUser, requireCompany(OFFICE, "marketing"), async (c) => c.json(await stopPostcards(c.env, c.var.db, c.var.companyId, param(c, "id"))));

// The front of a campaign's cards, fetched by Lob while it makes them: by its random token alone, so
// it names nothing and can't be guessed, and only once the campaign has been sent. A copy made at
// Send, without EXIF. Limited per visitor like the other pictures anyone can ask for.
postcards.on(["GET", "HEAD"], "/public/postcards/:file", async (c) => {
  const file = c.req.param("file") ?? "";
  if (!/^[A-Za-z0-9_-]{32}\.jpg$/.test(file)) throw new HttpError(404, "Picture not found.");
  if (!(await allow(c.env, `postcard-front:${clientIp(c)}`, 300, 60))) throw new HttpError(429, "Too many requests. Try again in a minute.");
  const bytes = await frontImage(adminClient(c.env), file.slice(0, 32));
  if (!bytes || !isJpeg(bytes)) throw new HttpError(404, "Picture not found.");
  const headers = { "Content-Type": "image/jpeg", "Content-Length": String(bytes.length), "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex", "Cache-Control": "public, max-age=3600" };
  return c.req.method === "HEAD" ? c.body(null, 200, headers) : c.body(bytes, 200, headers);
});
