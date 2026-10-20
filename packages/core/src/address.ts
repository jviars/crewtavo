/**
 * The instance's own web address (Settings → Web address): what the screen and the API share.
 * An owner picks an address like crm.theirbusiness.com; Crewtavo adds it on Railway (or says what
 * to do elsewhere), checks the DNS records as they go in, and switches APP_URL over once the new
 * address answers. DNS provider instructions live in dns.ts.
 */

export type AddressPlatform = "railway" | "compose" | "server";

/** waiting: records going in / Railway verifying. switching: APP_URL is changing and Crewtavo restarting. */
export type AddressStatus = "waiting" | "switching" | "done" | "failed";

export interface DnsRecordCheck {
  type: "CNAME" | "TXT" | "A" | "AAAA";
  /** Why it's there: sends visitors to Crewtavo, or proves to Railway the domain is theirs. */
  purpose: "route" | "verify";
  /** The full name, e.g. app.example.com or _railway-verify.app.example.com. */
  name: string;
  /** What to type in the provider's Name/Host box: the part before the domain ("app"), or "@" for the domain itself. */
  host: string;
  /** The value to enter. Null when only Railway knows it (the owner added the domain there by hand). */
  value: string | null;
  /** ok: in place. missing: nothing there yet. wrong: something else is there (see hint). */
  status: "ok" | "missing" | "wrong";
  /** What DNS answers for this name and type right now. */
  found: string[];
  /** For "wrong" (and some "missing"): what to change, in plain words. */
  hint: string | null;
}

export interface AddressChange {
  domain: string;
  status: AddressStatus;
  /** Crewtavo has Railway access and will finish the switch itself. */
  automatic: boolean;
  started_at: string;
  updated_at: string;
  /** The address before the switch. */
  from_url: string | null;
  error: string | null;
  /** The domain the records live under (example.com for app.example.com), and who hosts its DNS. */
  zone: string | null;
  provider: string | null;
  records: DnsRecordCheck[];
  /** Railway's HTTPS certificate for the address, when Crewtavo can see it. */
  certificate: "pending" | "issued" | "failed" | null;
  /** https://domain answers as this Crewtavo. */
  reachable: boolean;
  /** APP_URL is already the new address. */
  live: boolean;
}

export interface AddressOverview {
  /** The address Crewtavo uses in links and emails (APP_URL). */
  current: string | null;
  platform: AddressPlatform;
  railway: {
    /** Crewtavo holds Railway access for this project right now. */
    connected: boolean;
    /** Connected with everything Crewtavo asks for now: false for a sign-in from before it asked for billing access. */
    current: boolean;
    /** Login with Railway can be offered (false once Railway refused to register this instance). */
    oauth: boolean;
    /** Railway pages for doing it by hand, when the project's IDs are known. */
    settingsUrl: string | null;
    variablesUrl: string | null;
    tokensUrl: string | null;
    projectName: string | null;
    /** Why the last Railway sign-in didn't work, until one does. */
    error: string | null;
    /**
     * Domains on the crewtavo service in Railway that Crewtavo doesn't use yet, such as one just
     * bought there: Railway runs their DNS, so switching needs no records. Empty unless connected.
     */
    domains: Array<{ domain: string; verified: boolean; certificate: "pending" | "issued" | "failed" }>;
  } | null;
  /** A likely address, from the company's website or email domain. */
  suggestion: string | null;
  change: AddressChange | null;
}

/** POST /api/address/check: what Crewtavo can tell about an address before starting. */
export interface AddressCheck {
  domain: string;
  zone: string | null;
  provider: string | null;
  /** The address is the domain itself (example.com) rather than a name under it. */
  root: boolean;
  /** Worth knowing, but it can go ahead. */
  warnings: string[];
  /** Why it can't be used; null when it can. */
  problem: string | null;
}

/**
 * A DNS host's own instructions. `match` holds nameserver suffixes (domaincontrol.com for GoDaddy).
 * `rootCname`: whether the domain itself (example.com) can point at Railway (CNAME flattening or ALIAS).
 */
export interface DnsProvider {
  id: string;
  label: string;
  match: string[];
  /** Where the DNS records are edited (a general page when the provider has no direct link). */
  dnsUrl: string | null;
  /** Short steps to add a record there; {host}, {type} and {value} are filled in by the screen. */
  steps: string[];
  /** How the provider's Name/Host box works, e.g. "GoDaddy adds your domain itself: type just app". */
  hostNote: string | null;
  rootCname: boolean;
  /** Anything worth knowing, e.g. Cloudflare's proxy. */
  note?: string;
}

// Core builds without DOM or Node types; every runtime Crewtavo runs in has URL.
declare const URL: new (input: string) => { hostname: string; username: string; password: string; port: string };

const RAILWAY_HOSTS = /(^|\.)(railway\.app|railway\.internal|rlwy\.net)$/;
/** Websites that aren't the business's own domain: a page on a social network or a site builder. */
const NOT_THEIRS = /(^|\.)(facebook\.com|fb\.com|instagram\.com|linkedin\.com|x\.com|twitter\.com|tiktok\.com|youtube\.com|yelp\.com|nextdoor\.com|google\.com|business\.site|g\.page|angi\.com|homeadvisor\.com|thumbtack\.com|houzz\.com|linktr\.ee|wixsite\.com|squarespace\.com|weebly\.com|wordpress\.com|godaddysites\.com|square\.site|webflow\.io|carrd\.co|netlify\.app|vercel\.app|github\.io)$/;
const FREE_MAIL = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "outlook.com", "hotmail.com", "live.com", "msn.com",
  "icloud.com", "me.com", "mac.com", "aol.com", "proton.me", "protonmail.com", "zoho.com", "gmx.com", "mail.com", "yandex.com",
]);

/**
 * An address as typed ("https://App.Example.com/", "app.example.com.") as a bare lowercase host
 * name, or null when it isn't one. International names come back in their xn-- form.
 */
export function normalizeDomain(input: string): string | null {
  let text = input.trim().toLowerCase();
  if (!text) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(text)) text = `https://${text}`;
  let host: string;
  try {
    const url = new URL(text);
    if (url.username || url.password || url.port) return null;
    host = url.hostname.replace(/\.$/, "");
  } catch {
    return null;
  }
  if (host.length > 253 || !host.includes(".")) return null;
  const labels = host.split(".");
  if (!labels.every((l) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l))) return null;
  // A name, not an IP address.
  if (!/^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(labels.at(-1)!)) return null;
  return host;
}

/** Why an address can't be this instance's own, or null. */
export function addressProblem(domain: string): string | null {
  if (RAILWAY_HOSTS.test(domain)) return "That's a Railway address. Use a domain your business owns, like crm.yourbusiness.com.";
  if (domain === "localhost" || domain.endsWith(".localhost") || domain.endsWith(".local") || domain.endsWith(".internal")) {
    return "That address only works inside a network. Use a domain your business owns, like crm.yourbusiness.com.";
  }
  return null;
}

/**
 * The name Crewtavo goes on in front of the business's domain: crm.theirbusiness.com. A name under
 * the domain leaves their website and email at the domain itself as they are.
 */
export const ADDRESS_PREFIX = "crm";

/**
 * The address for a domain typed after crm. in the address box. People paste their website
 * ("https://www.greenlawn.com/about") or work email, or type crm. again: all come back as
 * crm.greenlawn.com. Null until it's a whole domain.
 */
export function prefixedAddress(typed: string): string | null {
  const domain = normalizeDomain(typed.split("@").pop()!)?.replace(/^(www|crm)\./, "");
  return domain?.includes(".") ? `${ADDRESS_PREFIX}.${domain}` : null;
}

/** crm.<their domain>, from the company's website or else its email address (not a free mailbox). */
export function suggestAddress(website: string | null | undefined, email: string | null | undefined): string | null {
  const fromSite = website ? normalizeDomain(website)?.replace(/^(www|app|crm)\./, "") : null;
  if (fromSite && !NOT_THEIRS.test(fromSite) && !addressProblem(fromSite)) return `${ADDRESS_PREFIX}.${fromSite}`;
  const fromEmail = email?.includes("@") ? normalizeDomain(email.split("@").pop()!) : null;
  if (fromEmail && !FREE_MAIL.has(fromEmail) && !addressProblem(fromEmail)) return `${ADDRESS_PREFIX}.${fromEmail}`;
  return null;
}

/** What to type in a provider's Name box for `name` under `zone`: "app", or "@" for the domain itself. */
export function hostLabel(name: string, zone: string | null): string {
  if (!zone || name === zone) return zone ? "@" : name;
  return name.endsWith(`.${zone}`) ? name.slice(0, -(zone.length + 1)) : name;
}

/** https://domain, the form APP_URL takes. */
export const addressUrl = (domain: string) => `https://${domain}`;
