/**
 * The public demo (services/demo.ts), only when CREWTAVO_DEMO=1 (lib/demoMode.ts):
 *   POST /api/demo/start   { trade, terms_version, turnstile_token?, locale? }  a sample business in that trade, signed in as its owner
 *   POST /api/demo/switch  { as: "owner" | "crew" }  be someone else in your business
 *   POST /api/demo/end     delete your business now ("Start over")
 */
import { TERMS_VERSION } from "@crewtavo/core";
import { LOCALES } from "@crewtavo/core/i18n";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { requireUser } from "../lib/auth";
import { HttpError, readJson } from "../lib/http";
import { allowStrict } from "../lib/limit";
import { reportError } from "../lib/monitoring";
import { clientIp } from "../lib/visitor";
import { demoEnabled, endDemo, startDemo, switchDemoPerson } from "../services/demo";

export const demo = new Hono<AppEnv>();

demo.use("/demo/*", async (c, next) => {
  if (!demoEnabled(c.env)) throw new HttpError(404, "Not found");
  await next();
});

/**
 * Each business is a few hundred rows and four accounts: plenty for anyone trying it, not for a
 * script. Counted strictly (a count that can't be made refuses), since each start costs the most of
 * anything a visitor can do.
 */
const LIMITS = [
  // Enough for an office or a phone carrier sharing one address, not for a script.
  { key: (ip: string) => `demo-start:hour:${ip}`, max: 10, seconds: 3600, message: "You've started a lot of demos. Wait a little and try again." },
  { key: (ip: string) => `demo-start:day:${ip}`, max: 30, seconds: 86_400, message: "You've started a lot of demos today. Try again tomorrow." },
  { key: () => "demo-start:all:hour", max: 300, seconds: 3600, message: "The demo is very busy right now. Try again in a few minutes." },
  { key: () => "demo-start:all:day", max: 2000, seconds: 86_400, message: "The demo is very busy today. Try again later." },
];

demo.post("/demo/start", async (c) => {
  const body = await readJson(
    c,
    z.object({
      trade: z.string().trim().min(1).max(60),
      terms_version: z.string().max(40).optional(),
      turnstile_token: z.string().max(4000).optional(),
      // The language the start screen was in: every person in the business gets it.
      locale: z.enum(LOCALES).optional(),
    }),
  );
  if (!body.terms_version) throw new HttpError(400, "Agree to the Crewtavo Terms to start the demo.");
  if (body.terms_version !== TERMS_VERSION) throw new HttpError(409, "The Crewtavo Terms changed since this page opened. Reload the page and try again.");
  await verifyTurnstile(c, body.turnstile_token);
  const ip = clientIp(c);
  for (const limit of LIMITS) {
    if (!(await allowStrict(c.env, limit.key(ip), limit.max, limit.seconds))) throw new HttpError(429, limit.message);
  }
  try {
    return c.json(await startDemo(c.env, body.trade, body.locale), 201);
  } catch (error) {
    if (error instanceof HttpError) throw error;
    console.error("Demo start failed", error);
    reportError(error, { route: "demo/start", trade: body.trade });
    throw new HttpError(503, "Couldn't set up the demo business. Try again in a moment.");
  }
});

demo.post("/demo/switch", requireUser, async (c) => {
  const body = await readJson(c, z.object({ as: z.enum(["owner", "crew"]) }));
  return c.json(await switchDemoPerson(c.env, c.var.userId, body.as));
});

demo.post("/demo/end", requireUser, async (c) => {
  await endDemo(c.env, c.var.userId);
  return c.json({ ok: true });
});

/** Cloudflare Turnstile, when the server has its keys (TURNSTILE_SITE_KEY and TURNSTILE_SECRET_KEY): the start screen shows it. */
async function verifyTurnstile(c: Context<AppEnv>, token: string | undefined) {
  if (!c.env.TURNSTILE_SECRET_KEY) return;
  const verify = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: new URLSearchParams({ secret: c.env.TURNSTILE_SECRET_KEY, response: token ?? "", remoteip: clientIp(c) }),
    signal: AbortSignal.timeout(8000),
  }).catch(() => null);
  const result = verify?.ok ? ((await verify.json().catch(() => ({}))) as { success?: boolean }) : { success: false };
  if (!result.success) throw new HttpError(400, "Please complete the check that you're not a robot, then try again.");
}
