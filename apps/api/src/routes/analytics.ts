/**
 * Website analytics (Apps → Crewtavo - Website Analytics). The business pastes one line into its
 * website: a script from its own Crewtavo, at a plain address (/v.js) blockers have less reason to
 * stop than an analytics company's. Each page view goes to /v, and the database counts it without
 * cookies or anything that tells who the visitor was (services/analytics.ts has the rest).
 *
 *   GET  /v.js                    the script
 *   POST /v                       one page view; 202 whether it counted or not
 *   GET  /api/analytics/setup     the app's page: the line to paste, the website, its last check and visit
 *   POST /api/analytics/enabled   Install and Uninstall
 *   POST /api/analytics/check     look for the line on the website
 *
 * Marketing reads the numbers with the web_stats function.
 */
import { ADMINS } from "@crewtavo/core";
import { isBot, readPageView } from "@crewtavo/core/analytics";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { requireCompany, requireUser } from "../lib/auth";
import { appUrl, asJson, dbError, HttpError, must, readJson } from "../lib/http";
import { reportError } from "../lib/monitoring";
import { adminClient } from "../lib/supabase";
import { clientIp } from "../lib/visitor";
import {
  AddressError, analyticsSettings, checkWebsite, PAGE_VIEWS_PER_ADDRESS, PAGE_VIEWS_PER_SERVER, snippet, trackerScript, underLimit, websiteAddress, websiteOf,
  type WebsiteCheck,
} from "../services/analytics";

/** The script and page views, at the top of the address (server.ts sends /v.js and /v here). */
export const pageViews = new Hono<AppEnv>();

pageViews.get("/v.js", (c) =>
  c.body(trackerScript(`${appUrl(c)}/v`), 200, {
    "Content-Type": "text/javascript; charset=utf-8",
    // A change to the script reaches websites within the hour.
    "Cache-Control": "public, max-age=3600",
  }),
);

const sentView = z.object({
  s: z.string().trim().min(1).max(80).optional(),
  u: z.string().max(2000),
  r: z.string().max(2000).optional(),
  w: z.number().int().min(0).max(20_000).optional(),
});

pageViews.post("/v", async (c) => {
  // The script doesn't read the answer, so it says nothing either way.
  const done = () => c.body(null, 202, { "Access-Control-Allow-Origin": "*" });
  const agent = c.req.header("user-agent") ?? "";
  // People who asked not to be tracked, and robots, aren't counted (the script stops most first).
  if (c.req.header("dnt") === "1" || c.req.header("sec-gpc") === "1" || isBot(agent)) return done();
  const ip = clientIp(c);
  if (!underLimit(`ip:${ip}`, PAGE_VIEWS_PER_ADDRESS) || !underLimit("server", PAGE_VIEWS_PER_SERVER)) return done();
  const text = await c.req.text();
  if (text.length > 5000) return done();
  let sent: z.infer<typeof sentView>;
  try {
    sent = sentView.parse(JSON.parse(text));
  } catch {
    return done();
  }
  const view = readPageView(sent, agent);
  if (!view) return done();
  const from = view.arrival;
  const { error } = await adminClient(c.env).rpc("web_record_hit", {
    p_ip: ip,
    p_agent: agent,
    p_host: view.host,
    p_path: view.path,
    p_device: view.device,
    ...(sent.s ? { p_site: sent.s } : {}),
    ...(from ? { p_source: from.source, p_channel: from.channel } : {}),
    ...(from?.campaign ? { p_campaign: from.campaign } : {}),
    ...(from?.referrer ? { p_referrer: from.referrer } : {}),
  });
  if (error) {
    console.error("Couldn't count a page view", error);
    reportError(new Error(`Counting a page view failed: ${error.message}`), { analytics: true });
  }
  return done();
});

// ---------------------------------------------------------------------------------------------
// The app's page: owners and admins who connect apps
// ---------------------------------------------------------------------------------------------

export const analytics = new Hono<AppEnv>();

const scriptUrl = (c: Parameters<typeof appUrl>[0]) => `${appUrl(c)}/v.js`;

analytics.get("/analytics/setup", requireUser, requireCompany(ADMINS, "apps"), async (c) => {
  const company = must(await c.var.db.from("companies").select("slug, website, settings").eq("id", c.var.companyId).maybeSingle());
  const saved = analyticsSettings(company.settings);
  const admin = adminClient(c.env);
  // The latest page view: the last two days' are kept one by one, then only each day's counts.
  const [hit, day] = await Promise.all([
    admin.from("web_hits").select("at").eq("company_id", c.var.companyId).order("at", { ascending: false }).limit(1).maybeSingle(),
    admin.from("web_daily").select("day").eq("company_id", c.var.companyId).eq("kind", "total").order("day", { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (hit.error) throw dbError(hit.error);
  if (day.error) throw dbError(day.error);
  return c.json({
    enabled: saved.enabled === true,
    // One business on this server (a Crewtavo instance): the line needs no name.
    snippet: snippet(scriptUrl(c), c.env.CREWTAVO_SINGLE_COMPANY === "1" ? null : company.slug),
    site: websiteOf(company),
    counting: saved.host ?? null,
    check: saved.check ?? null,
    last_visit_at: hit.data?.at ?? null,
    last_visit_day: hit.data ? null : (day.data?.day ?? null),
  });
});

analytics.post("/analytics/enabled", requireUser, requireCompany(ADMINS, "apps"), async (c) => {
  const body = await readJson(c, z.object({ enabled: z.boolean() }));
  const { error } = await c.var.db.rpc("web_analytics_save", { p_company: c.var.companyId, p_changes: { enabled: body.enabled } });
  if (error) throw dbError(error);
  return c.json({ enabled: body.enabled });
});

/**
 * Check: read the website's page and look for the line. Found, only that website's pages count from
 * then on (a copy of the site somewhere else doesn't add to the numbers). The address is kept for
 * next time either way, with what was found.
 */
analytics.post("/analytics/check", requireUser, requireCompany(ADMINS, "apps"), async (c) => {
  const body = await readJson(c, z.object({ site: z.string().trim().min(3, "Type your website's address, like greenlawn.com.").max(500).optional() }));
  const company = must(await c.var.db.from("companies").select("website, settings").eq("id", c.var.companyId).maybeSingle());
  const address = body.site ?? websiteOf(company);
  if (!address) throw new HttpError(400, "Type your website's address, like greenlawn.com.");
  let site: string;
  try {
    site = websiteAddress(address).href;
  } catch (error) {
    if (error instanceof AddressError) throw new HttpError(400, error.message);
    throw error;
  }
  const { host, ...found } = await checkWebsite(site, scriptUrl(c));
  const check: WebsiteCheck = { at: new Date().toISOString(), ...found };
  const { error } = await c.var.db.rpc("web_analytics_save", {
    p_company: c.var.companyId,
    p_changes: asJson({ site, check, ...(check.found ? { host } : {}) }),
  });
  if (error) throw dbError(error);
  return c.json({ site, check, counting: check.found ? host : (analyticsSettings(company.settings).host ?? null) });
});
