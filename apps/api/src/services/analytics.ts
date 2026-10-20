/**
 * Website analytics (Apps → Crewtavo - Website Analytics): the script the business puts on its
 * website, the check that looks for it there, and the visit behind a booking request. Counting
 * happens in the database (supabase/migrations/20261020003000_website_analytics.sql); the routes
 * are in routes/analytics.ts.
 */
import type { IncomingMessage } from "node:http";
import { hasScriptLine } from "@crewtavo/core/analytics";
import type { Json } from "@crewtavo/core/database";
import type { Context } from "hono";
import type { AppEnv } from "../env";
import { NameNotFoundError, PrivateAddressError, privateHost, publicGet, readLimited, TooLargeError } from "../lib/publicHttp";
import { reportError } from "../lib/monitoring";
import { adminClient, type Db } from "../lib/supabase";
import { clientIp } from "../lib/visitor";

export const ANALYTICS_DOCS = "https://crewtavo.com/docs/connections/website-analytics/";

/** What the app keeps in companies.settings.website_analytics (web_analytics_save). */
export interface AnalyticsSettings {
  enabled?: boolean;
  /** The website's address, as last checked. */
  site?: string | null;
  /** Once a check found the line: the website's name. Only its pages count. */
  host?: string | null;
  check?: WebsiteCheck | null;
}

/** What Check found on the website's home page. */
export interface WebsiteCheck {
  at: string;
  found: boolean;
  /** The page it read, after the website's redirects. */
  url: string;
  /** Why it couldn't look, in words for the person who pressed Check. */
  problem?: string;
}

export const analyticsSettings = (settings: unknown): AnalyticsSettings =>
  ((settings as { website_analytics?: AnalyticsSettings } | null)?.website_analytics ?? {});

/**
 * The script on the business's website. It sends each page view to `endpoint`, including the pages
 * a website made as one app opens without reloading (Next.js, Astro's view transitions), and
 * nothing for people who asked sites not to track them (Do Not Track, Global Privacy Control),
 * for automated browsers, or for a page shown inside another one, like a site builder's editor.
 * GoDaddy's builder only takes code in a frame on each page, so there the line names its page
 * (data-page="/services") and the address comes from the page around the frame.
 * fetch with keepalive, not sendBeacon: blockers stop a beacon to another site as a "ping".
 * Old browsers run it too (ES5), and it stays small: it loads on every page.
 */
export function trackerScript(endpoint: string): string {
  return `/* Crewtavo website analytics: counts visits without cookies. ${ANALYTICS_DOCS} */
(function () {
  var w = window, d = document, n = navigator, l = location, h = w.history, me = d.currentScript;
  var site = me && me.getAttribute("data-site"), page = me && me.getAttribute("data-page");
  if (n.doNotTrack == "1" || w.doNotTrack == "1" || n.globalPrivacyControl || n.webdriver || (w.top !== w && !page) || w.__crewtavoVisits) return;
  w.__crewtavoVisits = 1;
  var last;
  function address() {
    if (!page) return l.href.split("#")[0];
    try { return new URL(page, d.referrer || l.href).href; } catch (e) { return l.href; }
  }
  function view(from) {
    var here = address();
    if (here === last) return;
    last = here;
    try {
      fetch(${JSON.stringify(endpoint)}, { method: "POST", body: JSON.stringify({ s: site || undefined, u: here, r: from || undefined, w: screen.width }), keepalive: true, mode: "no-cors", credentials: "omit" });
    } catch (e) {}
  }
  function next() { view(last); }
  if (h && h.pushState) {
    var push = h.pushState;
    h.pushState = function () { var result = push.apply(this, arguments); next(); return result; };
    w.addEventListener("popstate", next);
  }
  if (d.prerendering) d.addEventListener("prerenderingchange", function () { view(d.referrer); }, { once: true });
  else view(d.referrer);
})();
`;
}

const attribute = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** The line to paste. A server with several businesses needs to know whose website it is (data-site). */
export function snippet(scriptUrl: string, site: string | null): string {
  return `<script defer${site ? ` data-site="${attribute(site)}"` : ""} src="${attribute(scriptUrl)}"></script>`;
}

/** Where the website is: the address last checked, the business's own (Settings → Company), or its Sveltia CMS editor's site. */
export function websiteOf(company: { website: string | null; settings: unknown }): string | null {
  const saved = analyticsSettings(company.settings).site;
  if (saved) return saved;
  if (company.website?.trim()) return company.website.trim();
  const editor = (company.settings as { website?: { admin_url?: unknown } } | null)?.website?.admin_url;
  if (typeof editor === "string") {
    try {
      return new URL(editor).origin;
    } catch {
      return null;
    }
  }
  return null;
}

/** A problem with the website's address that the person who typed it can fix. */
export class AddressError extends Error {
  override name = "AddressError";
}

/** An address as typed (greenlawn.com, www.greenlawn.com/home) as the page to read. */
export function websiteAddress(input: string): URL {
  let text = input.trim().replace(/^<|>$/g, "").replace(/^"|"$/g, "");
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new AddressError("That doesn't look like a website address. Type it like greenlawn.com.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new AddressError("Type your website's address, like greenlawn.com.");
  if (!url.hostname.includes(".") || privateHost(url)) throw new AddressError("Type your website's public address, like greenlawn.com.");
  url.username = "";
  url.password = "";
  url.hash = "";
  return url;
}

const MAX_PAGE = 5 * 1024 * 1024;

function reachProblem(error: unknown, url: URL): string {
  if (error instanceof PrivateAddressError) return "That address points inside a private network. Type your website's public address.";
  if (error instanceof NameNotFoundError) return `Couldn't find ${url.hostname}. Check the spelling of your website's address.`;
  if (error instanceof TooLargeError) return "Your home page is too big to read through.";
  return "Couldn't reach your website. Check the address, or try again in a few minutes.";
}

/**
 * Read the website's page from the public internet only (lib/publicHttp.ts), following up to five
 * redirects, and look for the script's line in it. A website that can't be read says why; one that
 * turns Crewtavo away (some block anything that isn't a browser) can still count visits.
 */
export async function checkWebsite(address: string, scriptUrl: string): Promise<Omit<WebsiteCheck, "at"> & { host: string }> {
  let url = websiteAddress(address);
  const result = (found: boolean, problem?: string) => ({ url: url.href, host: url.hostname.toLowerCase(), found, ...(problem ? { problem } : {}) });
  for (let hop = 0; hop < 5; hop++) {
    if (privateHost(url)) return result(false, reachProblem(new PrivateAddressError(url.hostname), url));
    let response: IncomingMessage;
    try {
      response = await publicGet(url, { Accept: "text/html, */*;q=0.5", "Accept-Encoding": "gzip, br", "User-Agent": "Mozilla/5.0 (compatible; Crewtavo website check)" }, AbortSignal.timeout(15_000));
    } catch (error) {
      return result(false, reachProblem(error, url));
    }
    const status = response.statusCode ?? 0;
    const location = response.headers.location;
    if (status >= 300 && status < 400 && location) {
      response.destroy();
      try {
        url = new URL(location, url);
      } catch {
        return result(false, "Your website redirected somewhere that isn't a web address.");
      }
      if (url.protocol !== "https:" && url.protocol !== "http:") return result(false, "Your website redirected somewhere that isn't a web address.");
      continue;
    }
    if (status < 200 || status > 299) {
      response.destroy();
      return result(false, status === 401 || status === 403 || status === 429 || status === 503
        ? `Your website didn't let Crewtavo look at it (it answered ${status}). If the line is on it, visits still show up here a minute after someone opens it.`
        : `Your website answered with an error (${status}). Check the address.`);
    }
    try {
      return result(hasScriptLine(await readLimited(response, MAX_PAGE), scriptUrl));
    } catch (error) {
      return result(false, reachProblem(error, url));
    }
  }
  return result(false, "Your website redirected too many times.");
}

/**
 * The website visit behind a booking request: same visitor (address and browser, as the page views
 * were counted), their latest page in the last few hours, and where that visit started and came
 * from. Null when the business doesn't count visits, or there's none to find. Never holds up a
 * booking: a problem here is logged and the request goes in without it.
 */
export async function bookingVisit(c: Context<AppEnv>, companyId: string): Promise<Json | null> {
  const { data, error } = await adminClient(c.env).rpc("web_visit_for", { p_company: companyId, p_ip: clientIp(c), p_agent: c.req.header("user-agent") ?? "" });
  if (error) {
    console.error("Couldn't look up the website visit for a booking", error);
    reportError(new Error(`Website visit lookup failed: ${error.message}`), { analytics: true });
    return null;
  }
  return data ?? null;
}

/** Every hour: count finished days and delete their page views (the retention rule), and old salts. */
export async function rollUpVisits(admin: Db): Promise<Record<string, unknown>> {
  const { data, error } = await admin.rpc("web_rollup");
  if (error) throw new Error(error.message);
  return (data ?? {}) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------------------------
// Page views a minute: from one address (a person clicking through fast still fits), and for the
// whole server, so a flood can't take over the database. Kept in this server's memory: counting
// each page view in Postgres as well would double the work of counting it.
// ---------------------------------------------------------------------------------------------

export const PAGE_VIEWS_PER_ADDRESS = 60;
export const PAGE_VIEWS_PER_SERVER = 6000;
const WINDOW_MS = 60_000;
const counts = new Map<string, { count: number; until: number }>();

/** Count one page view for `key`; false once `max` were counted this minute. */
export function underLimit(key: string, max: number, now = Date.now()): boolean {
  const entry = counts.get(key);
  if (entry && entry.until > now) return ++entry.count <= max;
  if (counts.size >= 20_000) {
    for (const [k, v] of counts) if (v.until <= now) counts.delete(k);
    // Still full: addresses by the thousand at once. Start over rather than grow.
    if (counts.size >= 20_000) counts.clear();
  }
  counts.set(key, { count: 1, until: now + WINDOW_MS });
  return true;
}

/** Tests start each case with nothing counted. */
export function forgetPageViewLimits() {
  counts.clear();
}
