/**
 * The business's website editor (Apps → Sveltia CMS): its site's /admin page, shown inside Crewtavo
 * on the Website page. Sveltia CMS and Decap CMS share how they're set up, so either works. What
 * the API found when it was installed lives in companies.settings.website; nothing in it is secret.
 */

export type WebsiteCms = "sveltia" | "decap";

export interface WebsiteSite {
  enabled: true;
  /** The editor's page, after the site's redirects: https://www.greenlawn.com/admin/ */
  admin_url: string;
  /** Which editor the page loads, when it could tell. */
  cms: WebsiteCms | null;
  /** From the editor's config: where it saves (github, gitlab, gitea...), the repository and its branch. */
  backend: string | null;
  repo: string | null;
  branch: string | null;
  /** "blocked": the site doesn't let other sites show it (X-Frame-Options or a CSP frame-ancestors), so it opens in a new tab. */
  framing: "ok" | "blocked";
  checked_at: string;
}

export const CMS_NAMES: Record<WebsiteCms, string> = { sveltia: "Sveltia CMS", decap: "Decap CMS" };

/** The installed editor in a company's settings, or null. */
export function websiteOf(settings: Record<string, unknown> | null | undefined): WebsiteSite | null {
  const site = settings?.website as Partial<WebsiteSite> | undefined;
  if (!site?.enabled || typeof site.admin_url !== "string" || !site.admin_url.startsWith("https://")) return null;
  return site as WebsiteSite;
}

/** The website's name as people say it: greenlawn.com. */
export function siteName(site: Pick<WebsiteSite, "admin_url">): string {
  const host = site.admin_url.replace(/^[a-z]+:\/\//i, "").split(/[/?#]/)[0] ?? "";
  return host.replace(/:\d+$/, "").replace(/^www\./, "").toLowerCase();
}

/** Where the repository lives, to link to it: github.com/owner/name and the like, when it's on a known host. */
export function repoUrl(site: Pick<WebsiteSite, "backend" | "repo">): string | null {
  // owner/name (GitLab: group/subgroup/name), and no . or .. segments.
  if (!site.repo || !/^[\w.-]+(\/[\w.-]+)+$/.test(site.repo) || site.repo.split("/").some((part) => /^\.+$/.test(part))) return null;
  const host = site.backend === "github" ? "github.com" : site.backend === "gitlab" ? "gitlab.com" : null;
  return host ? `https://${host}/${site.repo}` : null;
}
