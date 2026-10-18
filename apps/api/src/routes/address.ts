/**
 * Settings → Web address (services/address.ts): moving an instance to the owner's own address.
 *   GET    /api/address                  where things stand, with live DNS checks
 *   POST   /api/address/check            what Crewtavo can tell about an address before starting
 *   POST   /api/address/start            start setting up an address
 *   POST   /api/address/finish           check again now (and switch over if it's ready)
 *   DELETE /api/address                  stop setting it up
 *   POST   /api/address/railway/connect  Login with Railway: returns Railway's consent page
 *   GET    /api/address/railway/callback Railway sends the browser back here
 *   POST   /api/address/railway/token    or a project token instead
 *   DELETE /api/address/railway          forget Railway access
 *   POST   /api/address/cloudflare       add the records in Cloudflare with a one-time token
 *   GET    /.well-known/crewtavo-instance  this instance's fingerprint (lib/address.ts)
 * Only owners and admins, and only in an instance (one business per deployment).
 */
import { ADMINS } from "@crewtavo/core";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import type { AppEnv } from "../env";
import { platformOf } from "../lib/address";
import { requireCompany, requireUser } from "../lib/auth";
import { instanceFingerprint, randomId, signToken, verifyToken } from "../lib/crypto";
import { appUrl, HttpError, readJson } from "../lib/http";
import { allow } from "../lib/limit";
import { adminClient } from "../lib/supabase";
import { addCloudflareRecords, CloudflareError } from "../integrations/cloudflare";
import { authorizationUrl, exchangeCode, pkce, RailwayError } from "../integrations/railway";
import {
  addressOverview,
  cancelChange,
  checkAddress,
  connectRailway,
  finishChange,
  forgetRailway,
  noteRailwayError,
  railwayClient,
  recordsToAdd,
  startChange,
} from "../services/address";

export const address = new Hono<AppEnv>();
export const addressWellKnown = new Hono<AppEnv>();

const COOKIE = "crewtavo_railway";
const COOKIE_PATH = "/api/address/railway";

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

address.get("/address", ...admins, async (c) => c.json(await addressOverview(c.env, adminClient(c.env), c.var.companyId), 200, { "Cache-Control": "no-store" }));

address.post("/address/check", ...admins, async (c) => {
  const { domain } = await readJson(c, domainBody);
  if (!(await allow(c.env, `address-check:${c.var.userId}`, 120, 3600))) throw new HttpError(429, "That's a lot of checks. Wait a few minutes and try again.");
  return c.json(await checkAddress(c.env, domain));
});

address.post("/address/start", ...admins, async (c) => {
  const { domain } = await readJson(c, domainBody);
  return c.json(await startChange(c.env, adminClient(c.env), c.var.companyId, c.var.userId, domain).catch(plain));
});

address.post("/address/finish", ...admins, async (c) => c.json(await finishChange(c.env, adminClient(c.env), c.var.companyId).catch(plain)));

address.delete("/address", ...admins, async (c) => c.json(await cancelChange(c.env, adminClient(c.env), c.var.companyId).catch(plain)));

// ---------------------------------------------------------------------------------------------
// Railway access
// ---------------------------------------------------------------------------------------------

const onRailway = createMiddleware<AppEnv>(async (c, next) => {
  if (platformOf(c.env) !== "railway") throw new HttpError(400, "This Crewtavo doesn't run on Railway.");
  await next();
});

/** Step 1: Railway's consent page. The signed state names who asked; the cookie holds the PKCE verifier. */
address.post("/address/railway/connect", ...admins, onRailway, async (c) => {
  const admin = adminClient(c.env);
  const { data: company } = await admin.from("companies").select("name").eq("id", c.var.companyId).maybeSingle();
  const client = await railwayClient(c.env, admin, c.var.companyId, `${appUrl(c)}${COOKIE_PATH}/callback`, `Crewtavo for ${company?.name ?? "your business"}`).catch(plain);
  const { verifier, challenge } = await pkce();
  const nonce = randomId();
  const state = await signToken(c.env, { company: c.var.companyId, user: c.var.userId, purpose: "railway", nonce, exp: Math.floor(Date.now() / 1000) + 600 });
  setCookie(c, COOKIE, `${nonce}.${verifier}`, { httpOnly: true, secure: true, sameSite: "Lax", path: COOKIE_PATH, maxAge: 600 });
  return c.json({ authorization_url: authorizationUrl(client, state, challenge) });
});

/** Step 2: Railway sends the browser back. No bearer token: who asked comes from the signed state. */
address.get("/address/railway/callback", instanceOnly, async (c) => {
  const query = c.req.query();
  // Only a code goes in the address bar; the screen shows Railway's reason from GET /api/address.
  const back = (railway: "connected" | "expired" | "cancelled" | "error") => c.redirect(`${appUrl(c)}/settings?${new URLSearchParams({ tab: "address", railway })}`);
  const state = query.state ? await verifyToken<{ company: string; user: string; purpose: string; nonce: string; exp: number }>(c.env, query.state) : null;
  const [nonce, verifier] = (getCookie(c, COOKIE) ?? "").split(".");
  deleteCookie(c, COOKIE, { path: COOKIE_PATH });
  if (!state || state.purpose !== "railway" || !nonce || !verifier || nonce !== state.nonce) return back("expired");
  if (query.error || !query.code) return back("cancelled");

  const admin = adminClient(c.env);
  try {
    const client = await railwayClient(c.env, admin, state.company, `${appUrl(c)}${COOKIE_PATH}/callback`, "Crewtavo");
    const access = await exchangeCode(client, query.code, verifier);
    await connectRailway(c.env, admin, state.company, state.user, access);
    return back("connected");
  } catch (error) {
    if (!(error instanceof RailwayError)) console.error("Railway sign-in failed", error);
    await noteRailwayError(admin, state.company, error instanceof RailwayError ? error.message : "Railway sign-in didn't work. Try again.").catch(() => undefined);
    return back("error");
  }
});

address.post("/address/railway/token", ...admins, onRailway, async (c) => {
  const { token } = await readJson(c, z.object({ token: z.string().trim().min(10, "Paste the whole token.").max(400) }));
  const admin = adminClient(c.env);
  await connectRailway(c.env, admin, c.var.companyId, c.var.userId, { method: "token", token }).catch(plain);
  return c.json(await addressOverview(c.env, admin, c.var.companyId));
});

address.delete("/address/railway", ...admins, async (c) => {
  const admin = adminClient(c.env);
  await forgetRailway(c.env, admin, c.var.companyId);
  return c.json(await addressOverview(c.env, admin, c.var.companyId));
});

// ---------------------------------------------------------------------------------------------
// Cloudflare: add the records with a token used once and never stored
// ---------------------------------------------------------------------------------------------

address.post("/address/cloudflare", ...admins, async (c) => {
  const { token } = await readJson(c, z.object({ token: z.string().trim().min(20, "Paste the whole token.").max(400) }));
  const admin = adminClient(c.env);
  const { zone, records } = await recordsToAdd(admin, c.var.companyId);
  const added = await addCloudflareRecords(token, zone, records).catch(plain);
  return c.json({ added, overview: await addressOverview(c.env, admin, c.var.companyId) });
});

addressWellKnown.get("/.well-known/crewtavo-instance", async (c) => c.json({ instance: await instanceFingerprint(c.env) }, 200, { "Cache-Control": "no-store" }));
