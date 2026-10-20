/**
 * Sveltia CMS on Apps: the business's own website editor (its site's /admin page), shown inside
 * Crewtavo on the Website page. Installing checks the address from the public internet only
 * (lib/publicHttp.ts): that the editor is there, which repository and branch its config saves to,
 * and whether the site lets another site show it in a frame. People sign in to the editor itself,
 * with GitHub or however the site is set up; Crewtavo never sees that sign-in.
 */
import type { IncomingMessage } from "node:http";
import type { WebsiteCms, WebsiteSite } from "@crewtavo/core/website";
import { asJson, HttpError } from "../lib/http";
import { NameNotFoundError, PrivateAddressError, privateHost, publicGet, readLimited, TooLargeError } from "../lib/publicHttp";
import type { Db } from "../lib/supabase";

/** A problem with the address that the person who typed it can act on. */
export class WebsiteError extends Error {
  override name = "WebsiteError";
  /** "no_editor": the page opened, but nothing on it says Sveltia or Decap (it can be saved anyway). */
  constructor(message: string, readonly code?: "no_editor") {
    super(message);
  }
}

const MAX_PAGE = 2 * 1024 * 1024;
const MAX_CONFIG = 512 * 1024;
const UNREACHABLE = "Couldn't reach your website. Check the address, or try again in a few minutes.";
const PRIVATE = "That address points inside a private network. Type your website's public address.";

/** An address as typed (greenlawn.com, www.greenlawn.com/admin, https://greenlawn.com/cms/) as the editor's page. */
export function normalizeAddress(input: string): URL {
  let text = input.trim().replace(/^<|>$/g, "").replace(/^"|"$/g, "");
  // Only scheme:// counts as one: greenlawn.com:8443 is a name and a port.
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new WebsiteError("That doesn't look like a website address. Type it like greenlawn.com.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new WebsiteError("Type your website's address, like greenlawn.com.");
  if (privateHost(url)) throw new WebsiteError(PRIVATE);
  if (!url.hostname.includes(".") && !url.hostname.startsWith("[")) throw new WebsiteError("Type your website's whole address, like greenlawn.com.");
  // Crewtavo is on https://, so the editor has to be too: browsers don't show an http:// page inside it.
  url.protocol = "https:";
  url.username = "";
  url.password = "";
  url.hash = "";
  url.search = "";
  // Sveltia and Decap live at /admin/ unless someone put them elsewhere; a folder needs its slash.
  if (url.pathname === "/" || url.pathname === "") url.pathname = "/admin/";
  else if (!url.pathname.endsWith("/") && !/\.[a-z0-9]+$/i.test(url.pathname)) url.pathname += "/";
  return url;
}

/** Which editor a page loads: Sveltia's script (or name) on it, or Decap's (once called Netlify CMS). */
export function detectCms(html: string): WebsiteCms | null {
  if (/sveltia/i.test(html)) return "sveltia";
  if (/decap-cms|netlify-cms/i.test(html)) return "decap";
  return null;
}

const htmlDecode = (value: string) => value.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

/** Where the page says its config is (<link rel="cms-config-url" href="...">), or null for the default config.yml beside it. */
export function configHref(html: string): string | null {
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    if (!/\brel\s*=\s*["']?cms-config-url\b/i.test(tag)) continue;
    const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const value = href?.[1] ?? href?.[2] ?? href?.[3];
    if (value) return htmlDecode(value.trim());
  }
  return null;
}

const scalar = (value: string) => value.replace(/\s+#.*$/, "").trim().replace(/^(["'])(.*)\1$/, "$2").trim();

/**
 * The editor's backend from its config.yml: where it saves, the repository and the branch. Only
 * those three plain values under `backend:` are read, written either way YAML allows:
 *   backend:                         backend: { name: github, repo: greenlawn/site }
 *     name: github
 *     repo: greenlawn/site
 */
export function readBackend(yaml: string): Pick<WebsiteSite, "backend" | "repo" | "branch"> {
  const found: Record<string, string> = {};
  const lines = yaml.replace(/^﻿/, "").split(/\r?\n/);
  const start = lines.findIndex((line) => /^backend\s*:/.test(line));
  if (start >= 0) {
    const inline = /^backend\s*:\s*\{(.*)\}\s*(#.*)?$/.exec(lines[start]!);
    if (inline) {
      for (const pair of inline[1]!.split(",")) {
        const match = /^\s*([\w-]+)\s*:\s*(.*)$/.exec(pair);
        if (match) found[match[1]!] = scalar(match[2]!);
      }
    } else {
      // The keys right under it, at the first key's indent; deeper ones belong to other settings.
      let indent: string | null = null;
      for (const line of lines.slice(start + 1)) {
        if (!line.trim() || /^\s*#/.test(line)) continue;
        const match = /^(\s+)([\w-]+)\s*:\s*(.*)$/.exec(line);
        if (!match) {
          if (!/^\s/.test(line)) break;
          continue;
        }
        indent ??= match[1]!;
        if (match[1] === indent && match[3]) found[match[2]!] = scalar(match[3]);
      }
    }
  }
  const text = (key: string) => {
    const value = found[key];
    return value && value.length <= 200 ? value : null;
  };
  return { backend: text("name"), repo: text("repo"), branch: text("branch") };
}

/** A frame-ancestors source ("https://crm.greenlawn.com", "*.greenlawn.com", "https:", "*") allows `origin`. */
function sourceAllows(source: string, origin: URL): boolean {
  if (source === "*" || source === "https:") return true;
  const match = /^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*\.)?([^/:]+)(?::(\d+|\*))?/i.exec(source);
  if (!match || source.startsWith("'")) return false;
  const [, scheme, wildcard, host, port] = match;
  if (scheme && `${scheme.toLowerCase()}:` !== origin.protocol) return false;
  if (port && port !== "*" && port !== (origin.port || (origin.protocol === "https:" ? "443" : "80"))) return false;
  const name = host!.toLowerCase();
  return wildcard ? origin.hostname.endsWith(`.${name}`) : origin.hostname === name;
}

/**
 * Whether the site lets Crewtavo (at `appOrigin`) show it in a frame. A Content-Security-Policy with
 * frame-ancestors decides when there is one (browsers then ignore X-Frame-Options); otherwise any
 * X-Frame-Options (DENY, SAMEORIGIN) keeps it out.
 */
export function framingOf(headers: IncomingMessage["headers"], appOrigin: string): WebsiteSite["framing"] {
  const origin = new URL(appOrigin);
  const policies = [headers["content-security-policy"] ?? []].flat().flatMap((value) => value.split(","));
  const ancestors = policies
    .map((policy) => policy.split(";").map((d) => d.trim()).find((d) => /^frame-ancestors(\s|$)/i.test(d)))
    .filter((d): d is string => Boolean(d));
  if (ancestors.length) {
    return ancestors.every((directive) => directive.split(/\s+/).slice(1).some((source) => sourceAllows(source, origin))) ? "ok" : "blocked";
  }
  return headers["x-frame-options"] ? "blocked" : "ok";
}

/** What went wrong reaching the site, in words for the person who typed its address. */
function reachError(error: unknown, url: URL): WebsiteError {
  if (error instanceof WebsiteError) return error;
  if (error instanceof PrivateAddressError) return new WebsiteError(PRIVATE);
  if (error instanceof NameNotFoundError) return new WebsiteError(`Couldn't find ${url.hostname}. Check the spelling of your website's address.`);
  if (error instanceof TooLargeError) return new WebsiteError("That page is too big to be your website's editor. Check the address.");
  return new WebsiteError(UNREACHABLE);
}

/** GET a public https:// page, following up to five redirects (each checked again): the response and where it ended up. */
async function fetchPage(start: URL, accept: string): Promise<{ response: IncomingMessage; url: URL }> {
  let url = start;
  for (let hop = 0; hop < 5; hop++) {
    if (privateHost(url)) throw new WebsiteError(PRIVATE);
    if (url.protocol !== "https:") throw new WebsiteError("Your website's editor isn't on a secure (https://) address, so it can't open inside Crewtavo.");
    let response: IncomingMessage;
    try {
      response = await publicGet(url, { Accept: accept, "Accept-Encoding": "gzip, br", "User-Agent": "Crewtavo website check" }, AbortSignal.timeout(15_000));
    } catch (error) {
      throw reachError(error, url);
    }
    const status = response.statusCode ?? 0;
    const location = response.headers.location;
    if (status >= 300 && status < 400 && location) {
      response.destroy();
      url = new URL(location, url);
      continue;
    }
    return { response, url };
  }
  throw new WebsiteError("Your website's address redirected too many times.");
}

/** The editor's config, when it can be read: its backend, repository and branch. */
async function readConfig(href: URL): Promise<Pick<WebsiteSite, "backend" | "repo" | "branch"> | null> {
  try {
    const { response } = await fetchPage(href, "application/yaml, text/yaml, text/plain;q=0.9, */*;q=0.5");
    if (response.statusCode !== 200) {
      response.destroy();
      return null;
    }
    const backend = readBackend(await readLimited(response, MAX_CONFIG));
    return backend.backend || backend.repo ? backend : null;
  } catch {
    return null;
  }
}

/**
 * Check the website's editor at `address`: it opens, it's Sveltia or Decap (or `anyway`, for an
 * editor bundled where its name doesn't show), where it saves, and whether it can be framed by
 * Crewtavo at `appOrigin`.
 */
export async function checkSite(address: string, appOrigin: string, options: { anyway?: boolean } = {}): Promise<WebsiteSite> {
  const { response, url } = await fetchPage(normalizeAddress(address), "text/html, */*;q=0.5");
  const status = response.statusCode ?? 0;
  const page = url.toString().replace(/^https:\/\//, "");
  if (status < 200 || status > 299) {
    response.destroy();
    if (status === 404 || status === 410) throw new WebsiteError(`Nothing at ${page}. If your editor isn't at /admin, type its whole address, like greenlawn.com/cms.`);
    if (status === 401 || status === 403) throw new WebsiteError(`${page} asks for a password before it opens, so it can't be shown inside Crewtavo. Turn off the host's password protection for it, then try again.`);
    throw new WebsiteError(`Your website answered with an error (${status}). Try again in a few minutes.`);
  }
  let html: string;
  try {
    html = await readLimited(response, MAX_PAGE);
  } catch (error) {
    throw reachError(error, url);
  }
  const cms = detectCms(html);
  const config = await readConfig(new URL(configHref(html) ?? "config.yml", url));
  if (!cms && !config && !options.anyway) {
    throw new WebsiteError(`Couldn't find Sveltia CMS at ${page}. Check the address of the page you sign in to your website's editor on.`, "no_editor");
  }
  return {
    enabled: true,
    admin_url: url.toString(),
    cms,
    backend: config?.backend ?? null,
    repo: config?.repo ?? null,
    branch: config?.branch ?? null,
    framing: framingOf(response.headers, appOrigin),
    checked_at: new Date().toISOString(),
  };
}

/** Keep the editor in the company's settings (null takes it out), next to what's already there. */
export async function saveWebsite(admin: Db, companyId: string, site: WebsiteSite | null): Promise<void> {
  const { data, error: readError } = await admin.from("companies").select("settings").eq("id", companyId).maybeSingle();
  if (readError) throw new HttpError(500, "Couldn't save that. Try again.");
  const { website: _old, ...settings } = (data?.settings ?? {}) as Record<string, unknown>;
  const { error } = await admin.from("companies").update({ settings: asJson(site ? { ...settings, website: site } : settings) }).eq("id", companyId);
  if (error) throw new HttpError(500, "Couldn't save that. Try again.");
}
