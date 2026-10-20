/**
 * Website analytics (Apps → Crewtavo - Website Analytics): reading a page view the script on the
 * business's website sends (apps/api/src/routes/analytics.ts), and the names Marketing shows for
 * where visits came from and what they were on. Nothing here identifies a person: the database
 * keeps a daily hash for the visitor (supabase/migrations/20261020003000_website_analytics.sql).
 */

/** The parts of URL (browsers' and Node's) used here: core is built without either's types. */
export interface WebUrl {
  protocol: string;
  host: string;
  hostname: string;
  pathname: string;
  searchParams: { get(name: string): string | null; has(name: string): boolean };
}
declare const URL: new (url: string, base?: string) => WebUrl;

/** Kinds of places a visit comes from. */
export type Channel = "search" | "ads" | "social" | "ai" | "directory" | "email" | "campaign" | "referral" | "direct";
export type Device = "phone" | "tablet" | "computer";

export const CHANNEL_LABELS: Record<Channel, string> = {
  search: "Search",
  ads: "Ads",
  social: "Social",
  ai: "AI assistants",
  directory: "Directories",
  email: "Email",
  campaign: "Campaigns",
  referral: "Other websites",
  direct: "Direct",
};

export const DEVICE_LABELS: Record<Device, string> = { phone: "Phone", tablet: "Tablet", computer: "Computer" };

/** Where a visit came from: the name Marketing shows, its kind, the utm_campaign, and the other site's name. */
export interface Arrival {
  source: string;
  channel: Channel;
  campaign: string | null;
  referrer: string | null;
}

/** What a page view the script sent says, ready to count. */
export interface PageView {
  host: string;
  path: string;
  /** Null for a page within a visit (a link on the site, the site's own app moving between pages). */
  arrival: Arrival | null;
  device: Device;
}

/** Sites people arrive from, by name (after www., m. and the like come off), most specific first. */
const SITES: Array<[RegExp, string, Channel]> = [
  // AI assistants, before Google and Microsoft's own search.
  [/^(chatgpt\.com|chat\.openai\.com)$/, "ChatGPT", "ai"],
  [/^perplexity\.ai$/, "Perplexity", "ai"],
  [/^claude\.ai$/, "Claude", "ai"],
  [/^gemini\.google\.com$/, "Gemini", "ai"],
  [/^copilot\.microsoft\.com$/, "Copilot", "ai"],
  [/^(chat\.)?deepseek\.com$/, "DeepSeek", "ai"],
  [/^grok\.com$/, "Grok", "ai"],
  [/^meta\.ai$/, "Meta AI", "ai"],
  // Email on the web.
  [/^mail\.google\.com$/, "Gmail", "email"],
  [/^outlook\.(live|office|office365)\.com$/, "Outlook", "email"],
  [/^mail\.yahoo\.com$/, "Yahoo Mail", "email"],
  [/^mail\.aol\.com$/, "AOL Mail", "email"],
  [/^mail\.proton\.me$/, "Proton Mail", "email"],
  // Maps count as search: it's how people find a business near them.
  [/^maps\.google\.[a-z.]+$/, "Google Maps", "search"],
  [/^maps\.apple\.com$/, "Apple Maps", "search"],
  [/^google\.[a-z.]+$/, "Google", "search"],
  [/^bing\.com$/, "Bing", "search"],
  [/^duckduckgo\.com$/, "DuckDuckGo", "search"],
  [/^(search\.)?yahoo\.[a-z.]+$/, "Yahoo", "search"],
  [/^(search\.)?aol\.com$/, "AOL", "search"],
  [/^ecosia\.org$/, "Ecosia", "search"],
  [/^search\.brave\.com$/, "Brave Search", "search"],
  [/^startpage\.com$/, "Startpage", "search"],
  [/^qwant\.com$/, "Qwant", "search"],
  [/^kagi\.com$/, "Kagi", "search"],
  [/^yandex\.[a-z.]+$/, "Yandex", "search"],
  [/^baidu\.com$/, "Baidu", "search"],
  [/^(facebook\.com|fb\.com|fb\.me)$/, "Facebook", "social"],
  [/^instagram\.com$/, "Instagram", "social"],
  [/^(t\.co|twitter\.com|x\.com)$/, "X (Twitter)", "social"],
  [/^(linkedin\.com|lnkd\.in)$/, "LinkedIn", "social"],
  [/^(pinterest\.[a-z.]+|pin\.it)$/, "Pinterest", "social"],
  [/^reddit\.com$/, "Reddit", "social"],
  [/^(youtube\.com|youtu\.be)$/, "YouTube", "social"],
  [/^tiktok\.com$/, "TikTok", "social"],
  [/^nextdoor\.[a-z.]+$/, "Nextdoor", "social"],
  [/^threads\.(net|com)$/, "Threads", "social"],
  [/^bsky\.app$/, "Bluesky", "social"],
  [/^snapchat\.com$/, "Snapchat", "social"],
  [/^quora\.com$/, "Quora", "social"],
  [/^yelp\.[a-z.]+$/, "Yelp", "directory"],
  [/^(angi\.com|angieslist\.com)$/, "Angi", "directory"],
  [/^homeadvisor\.com$/, "HomeAdvisor", "directory"],
  [/^thumbtack\.com$/, "Thumbtack", "directory"],
  [/^bbb\.org$/, "BBB", "directory"],
  [/^houzz\.[a-z.]+$/, "Houzz", "directory"],
  [/^porch\.com$/, "Porch", "directory"],
  [/^homeguide\.com$/, "HomeGuide", "directory"],
  [/^yellowpages\.com$/, "Yellow Pages", "directory"],
  [/^mapquest\.com$/, "MapQuest", "directory"],
];

/** utm_source values that name a site the table above knows, without its address. */
const SOURCE_ALIASES: Record<string, string> = {
  google: "google.com", adwords: "google.com", bing: "bing.com", yahoo: "yahoo.com", duckduckgo: "duckduckgo.com",
  facebook: "facebook.com", fb: "facebook.com", meta: "facebook.com", instagram: "instagram.com", ig: "instagram.com",
  twitter: "x.com", x: "x.com", linkedin: "linkedin.com", pinterest: "pinterest.com", reddit: "reddit.com", youtube: "youtube.com",
  tiktok: "tiktok.com", nextdoor: "nextdoor.com", threads: "threads.net", yelp: "yelp.com", angi: "angi.com", homeadvisor: "homeadvisor.com",
  thumbtack: "thumbtack.com", bbb: "bbb.org", houzz: "houzz.com", chatgpt: "chatgpt.com", openai: "chatgpt.com", perplexity: "perplexity.ai",
  claude: "claude.ai", gemini: "gemini.google.com", copilot: "copilot.microsoft.com", gmail: "mail.google.com", outlook: "outlook.live.com",
};

/** A site's name without the parts that differ between its desktop, phone and link-tracking addresses. */
export function siteName(host: string): string {
  return host.toLowerCase().replace(/\.$/, "").replace(/^(www\d*|m|l|lm|mobile|mbasic|touch|out|go)\./, "");
}

function knownSite(host: string): { source: string; channel: Channel } | null {
  const name = siteName(host);
  for (const [pattern, source, channel] of SITES) if (pattern.test(name)) return { source, channel };
  return null;
}

/** utm_medium as one of our kinds, or null when it isn't one we know. */
export function channelForMedium(medium: string | null | undefined): Channel | null {
  const m = (medium ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (!m) return null;
  if (/^(cpc|ppc|cpm|cpv|cpa|paid|paid_?\w*|\w*_paid|display|banner|retargeting|remarketing|ads?)$/.test(m)) return "ads";
  if (/^(e_?mail|newsletter)$/.test(m)) return "email";
  if (/^(social|social_?media|sm|social_?network|social_?post|organic_?social)$/.test(m)) return "social";
  if (/^(organic|seo|search)$/.test(m)) return "search";
  if (/^(ai|llm|chatbot|assistant)$/.test(m)) return "ai";
  if (m === "referral") return "referral";
  return "campaign";
}

const clip = (value: string | null | undefined, max: number) => {
  const text = (value ?? "").replace(/[\u0000-\u001f]/g, "").trim();
  return text ? text.slice(0, max) : null;
};

/** One site or the other is part of the same website (pinelawn.com, www.pinelawn.com, crm.pinelawn.com). */
function sameSite(a: string, b: string): boolean {
  const x = a.toLowerCase().replace(/^www\./, "");
  const y = b.toLowerCase().replace(/^www\./, "");
  return x === y || x.endsWith(`.${y}`) || y.endsWith(`.${x}`);
}

/**
 * Where a page view came from, or null when it's a page within a visit: no campaign link, ad click
 * or other website in front of it (a link on the site, a bookmark, an address typed in). The
 * database starts a visit at a page with nothing new as Direct.
 */
export function arrivalOf(page: WebUrl, referrer: string | null | undefined): Arrival | null {
  const q = page.searchParams;
  const campaign = clip(q.get("utm_campaign"), 100);
  let from: WebUrl | null = null;
  try {
    from = referrer ? new URL(referrer) : null;
  } catch {
    from = null;
  }
  if (from && from.protocol !== "https:" && from.protocol !== "http:") from = null;
  const external = from && !sameSite(from.hostname, page.hostname) ? from : null;
  const referrerName = external ? siteName(external.hostname).slice(0, 255) : null;

  // A campaign link (utm_source=...): its source, by the site's name when it's one we know.
  const tagged = clip(q.get("utm_source") ?? q.get("ref"), 100);
  if (tagged) {
    const lower = tagged.toLowerCase();
    const known = knownSite(SOURCE_ALIASES[lower] ?? lower);
    return {
      source: known?.source ?? tagged,
      channel: channelForMedium(q.get("utm_medium")) ?? known?.channel ?? "campaign",
      campaign,
      referrer: referrerName,
    };
  }
  // An ad's click (the ad networks add these to the link).
  if (q.has("gclid") || q.has("gbraid") || q.has("wbraid")) return { source: "Google Ads", channel: "ads", campaign, referrer: referrerName };
  if (q.has("msclkid")) return { source: "Microsoft Ads", channel: "ads", campaign, referrer: referrerName };
  if (q.has("ttclid")) return { source: "TikTok Ads", channel: "ads", campaign, referrer: referrerName };
  if (external) {
    const known = knownSite(external.hostname);
    return { source: known?.source ?? referrerName!, channel: known?.channel ?? "referral", campaign, referrer: referrerName };
  }
  // Facebook adds fbclid to every link people follow from it, ads or not.
  if (q.has("fbclid")) return { source: "Facebook", channel: "social", campaign, referrer: null };
  if (campaign) return { source: "Campaign", channel: "campaign", campaign, referrer: null };
  return null;
}

/** A page's path as Marketing lists it: no query or #, no trailing slash, index.html as its folder. */
export function pagePath(page: WebUrl): string {
  let path = page.pathname.replace(/\/{2,}/g, "/").replace(/\/index\.html?$/i, "/");
  if (path.length > 1) path = path.replace(/\/+$/, "");
  return (path || "/").slice(0, 300);
}

/**
 * Phone, tablet or computer, from the browser's name and the screen's width (CSS pixels): phones
 * are under 576, tablets under 992, as Plausible splits them. iPads that say they're a Mac count as
 * computers.
 */
export function deviceOf(agent: string, width: number | null | undefined): Device {
  if (/iPad|Tablet|PlayBook|Silk|Kindle|Android(?!.*Mobile)/i.test(agent)) return "tablet";
  if (/Mobi|iPhone|iPod|Android.*Mobile|Windows Phone|Opera Mini|IEMobile/i.test(agent)) return "phone";
  if (width && width > 0) return width < 576 ? "phone" : width < 992 ? "tablet" : "computer";
  return "computer";
}

/** Crawlers, link previews, uptime checks, scripts and headless browsers: never visitors. */
const BOTS =
  /bot\b|bot\/|crawl|spider|slurp|archiver|facebookexternalhit|facebookcatalog|meta-externalagent|embedly|quora link preview|outbrain|vkshare|w3c_validator|whatsapp|telegram|discord|slack|skypeuripreview|bingpreview|google-?(web-?preview|read-aloud|inspectiontool|site-verification|structured-data)|mediapartners|adsbot|feedfetcher|headless|phantomjs|puppeteer|playwright|selenium|webdriver|cypress|lighthouse|pagespeed|gtmetrix|pingdom|uptime|statuscake|site24x7|newrelic|datadog|monitor|semrush|ahrefs|mj12|dotbot|petalbot|bytespider|gptbot|chatgpt-user|oai-searchbot|claude|anthropic|perplexity|ccbot|applebot|yandex|baidu|sogou|exabot|ia_archiver|curl|wget|python|java\/|okhttp|go-http|axios|node-fetch|undici|httpclient|libwww|scrapy|postman|insomnia/i;

export function isBot(agent: string | null | undefined): boolean {
  const ua = (agent ?? "").trim();
  return ua.length < 20 || BOTS.test(ua) || !/mozilla|opera/i.test(ua);
}

/** Pages on this computer or a private network: a website being built, not a visit. */
function localHost(host: string): boolean {
  return /^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.test|\[.*\]|\d+(\.\d+){3})$/i.test(host) || !host.includes(".");
}

/**
 * A page view from the script (`u` the page's address, `r` the page before it, `w` the screen's
 * width), or null when it isn't one to count: a page on this computer, or not a web page at all.
 */
export function readPageView(sent: { u: string; r?: string | null; w?: number | null }, agent: string): PageView | null {
  let page: WebUrl;
  try {
    page = new URL(sent.u);
  } catch {
    return null;
  }
  if ((page.protocol !== "https:" && page.protocol !== "http:") || localHost(page.hostname)) return null;
  return { host: page.hostname.toLowerCase(), path: pagePath(page), arrival: arrivalOf(page, sent.r), device: deviceOf(agent, sent.w) };
}

/** The script's line in a page's HTML (as written, inside JSON with \/, or as Next.js's Script leaves it). */
export function hasScriptLine(html: string, scriptUrl: string): boolean {
  const url = new URL(scriptUrl);
  const text = html.replace(/\\\//g, "/").replace(/&#x2F;|&#47;/gi, "/");
  return text.toLowerCase().includes(`${url.host}${url.pathname}`.toLowerCase());
}
