/**
 * Settings → Web address (services/address.ts): moving an instance to the owner's own address.
 *   GET    /api/address                  where things stand, with live DNS checks
 *   POST   /api/address/check            what Crewtavo can tell about an address before starting
 *   POST   /api/address/start            start setting up an address (password)
 *   POST   /api/address/finish           check again now (and switch over if it's ready)
 *   DELETE /api/address                  stop setting it up
 *   POST   /api/address/cloudflare       add the records in Cloudflare with a one-time token
 *   GET    /.well-known/crewtavo-instance  this instance's fingerprint (lib/address.ts)
 * Only owners and admins, and only in an instance (one business per deployment). Railway access,
 * which lets Crewtavo add the address and switch over by itself, is routes/railway.ts. The address
 * is where every reset, invite and client link points, so choosing one asks for the person's
 * password, as connecting Railway does: a session left open somewhere can't move it.
 */
import { ADMINS } from "@crewtavo/core";
import { Hono, type Context } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import type { AppEnv } from "../env";
import { confirmPassword, requireCompany, requireUser } from "../lib/auth";
import { instanceFingerprint } from "../lib/crypto";
import { HttpError, readJson } from "../lib/http";
import { allow } from "../lib/limit";
import { adminClient } from "../lib/supabase";
import { addCloudflareRecords, CloudflareError } from "../integrations/cloudflare";
import { RailwayError } from "../integrations/railway";
import { addressOverview, cancelChange, checkAddress, finishChange, recordsToAdd, startChange } from "../services/address";

export const address = new Hono<AppEnv>();
export const addressWellKnown = new Hono<AppEnv>();

const instanceOnly = createMiddleware<AppEnv>(async (c, next) => {
  if (c.env.CREWTAVO_SINGLE_COMPANY !== "1") throw new HttpError(404, "A web address is set for a whole Crewtavo instance, so it isn't available here.");
  await next();
});
const admins = [instanceOnly, requireUser, requireCompany(ADMINS, "settings")] as const;

/** Railway and Cloudflare say what went wrong in words worth showing; anything else stays generic. */
function plain(error: unknown): never {
  if (error instanceof RailwayError || error instanceof CloudflareError) throw new HttpError(400, error.message);
  throw error;
}

const domainBody = z.object({ domain: z.string().trim().min(1).max(300) });

/** Choosing the address without the password. */
export const ADDRESS_PASSWORD = "Enter your password to change Crewtavo's web address.";
/** Connecting Railway, which switches the address by itself, without the password. */
export const RAILWAY_PASSWORD = "Enter your password to connect Railway.";
/** The password a request carries, if any (checked by confirmAddressChange). */
export const passwordField = z.string().max(200).optional();

/**
 * The person's own password (lib/auth.ts confirmPassword), before anything that can move where
 * Crewtavo's links point: choosing an address here, and giving Crewtavo Railway access
 * (routes/railway.ts), which switches over by itself. One count of tries for both.
 */
export async function confirmAddressChange(c: Context<AppEnv>, given: string | undefined, missing = ADDRESS_PASSWORD) {
  if (!given) throw new HttpError(400, missing);
  return confirmPassword(c, given, "web-address", 10);
}

address.get("/address", ...admins, async (c) => c.json(await addressOverview(c.env, adminClient(c.env), c.var.companyId), 200, { "Cache-Control": "no-store" }));

address.post("/address/check", ...admins, async (c) => {
  const { domain } = await readJson(c, domainBody);
  if (!(await allow(c.env, `address-check:${c.var.userId}`, 120, 3600))) throw new HttpError(429, "That's a lot of checks. Wait a few minutes and try again.");
  return c.json(await checkAddress(c.env, domain));
});

address.post("/address/start", ...admins, async (c) => {
  const { domain, password } = await readJson(c, domainBody.extend({ password: passwordField }));
  await confirmAddressChange(c, password);
  return c.json(await startChange(c.env, adminClient(c.env), c.var.companyId, c.var.userId, domain).catch(plain));
});

address.post("/address/finish", ...admins, async (c) => c.json(await finishChange(c.env, adminClient(c.env), c.var.companyId).catch(plain)));

address.delete("/address", ...admins, async (c) => c.json(await cancelChange(c.env, adminClient(c.env), c.var.companyId).catch(plain)));

// ---------------------------------------------------------------------------------------------
// Cloudflare: add the records with a token used once and never stored
// ---------------------------------------------------------------------------------------------

address.post("/address/cloudflare", ...admins, async (c) => {
  const { token } = await readJson(c, z.object({ token: z.string().trim().min(20, "Paste the whole token.").max(400) }));
  const admin = adminClient(c.env);
  const { zone, records } = await recordsToAdd(admin, c.var.companyId);
  const added = await addCloudflareRecords(c.env, token, zone, records).catch(plain);
  return c.json({ added, overview: await addressOverview(c.env, admin, c.var.companyId) });
});

addressWellKnown.get("/.well-known/crewtavo-instance", async (c) => c.json({ instance: await instanceFingerprint(c.env) }, 200, { "Cache-Control": "no-store" }));
