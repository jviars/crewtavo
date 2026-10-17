/**
 * Apps shown on the Apps page and how each connects.
 *   oauth   - the company signs in to the provider; tokens are stored encrypted (integration_secrets)
 *   api_key - the company pastes a key (or the deployment provides one in env)
 *   inbound - the app connects to us (Claude and ChatGPT via MCP at /mcp)
 */
import type { Env } from "../env";

export type Provider = "quickbooks" | "zoho_books" | "google_calendar" | "stripe" | "twilio" | "anthropic";

export interface CatalogEntry {
  provider: Provider;
  name: string;
  category: "Accounting" | "Calendar" | "Payments" | "Messaging" | "AI";
  description: string;
  auth: "oauth" | "api_key";
  docs: string;
  /** False when this deployment lacks the OAuth app or platform key the provider needs. */
  available: (env: Env) => boolean;
}

export const CATALOG: CatalogEntry[] = [
  {
    provider: "quickbooks",
    name: "QuickBooks Online",
    category: "Accounting",
    description: "Send clients, invoices and payments to QuickBooks when it's your book of record.",
    auth: "oauth",
    docs: "https://developer.intuit.com/app/developer/qbo/docs/get-started",
    available: (env) => Boolean(env.QUICKBOOKS_CLIENT_ID && env.QUICKBOOKS_CLIENT_SECRET),
  },
  {
    provider: "zoho_books",
    name: "Zoho Books",
    category: "Accounting",
    description: "Send clients, invoices and payments to Zoho Books in your data center.",
    auth: "oauth",
    docs: "https://www.zoho.com/books/api/v3/introduction/",
    available: (env) => Boolean(env.ZOHO_CLIENT_ID && env.ZOHO_CLIENT_SECRET),
  },
  {
    provider: "google_calendar",
    name: "Google Calendar",
    category: "Calendar",
    description: "Put each crew's visits on a Google Calendar.",
    auth: "oauth",
    docs: "https://developers.google.com/calendar/api",
    available: (env) => Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
  },
  {
    provider: "stripe",
    name: "Stripe",
    category: "Payments",
    description: "Card and bank (ACH) payments from invoices and the client portal.",
    auth: "api_key",
    docs: "https://docs.stripe.com/keys",
    available: (env) => Boolean(env.STRIPE_SECRET_KEY),
  },
  {
    provider: "twilio",
    name: "Twilio",
    category: "Messaging",
    description: "Text messages: reminders, on-my-way texts and two-way conversations.",
    auth: "api_key",
    docs: "https://www.twilio.com/docs/messaging",
    available: (env) => Boolean(env.TWILIO_ACCOUNT_SID),
  },
  {
    provider: "anthropic",
    name: "Claude (Anthropic)",
    category: "AI",
    description: "Draft quotes, rewrite messages and answer questions from your SOPs. Uses your key if you add one.",
    auth: "api_key",
    docs: "https://docs.claude.com/",
    available: () => true,
  },
];

export function catalogEntry(provider: string): CatalogEntry | undefined {
  return CATALOG.find((entry) => entry.provider === provider);
}

/** Context passed back on the OAuth callback (Zoho tells us which data center the account lives in). */
export interface CallbackContext {
  query: Record<string, string>;
}

export interface OAuthConfig {
  authorizeUrl: (env: Env) => string;
  tokenUrl: (env: Env, ctx?: CallbackContext, saved?: Record<string, string>) => string;
  revokeUrl?: (env: Env, saved?: Record<string, string>) => string;
  scope: string;
  clientId: (env: Env) => string | undefined;
  clientSecret: (env: Env) => string | undefined;
  /** "basic": client credentials in an Authorization header; "body": in the form body. */
  clientAuth: "basic" | "body";
  extraParams?: Record<string, string>;
}

export class IntegrationError extends Error {
  override name = "IntegrationError";
}

/** A provider pointed us at a server that isn't its own. The message is shown on the Apps page. */
export class UntrustedServerError extends IntegrationError {}

/** Provider calls give up after this long, so a provider that hangs fails like one that's down. */
export const providerTimeout = () => AbortSignal.timeout(15_000);

// Zoho's data centers: US, EU, India, Australia, Japan, China, Canada, Saudi Arabia, UK.
const ZOHO_TLDS = ["com", "eu", "in", "com.au", "jp", "com.cn", "ca", "sa", "uk"];
const ZOHO_ACCOUNTS = new Set([...ZOHO_TLDS.map((tld) => `accounts.zoho.${tld}`), "accounts.zohocloud.ca"]);
const ZOHO_APIS = new Set(ZOHO_TLDS.flatMap((tld) => [`www.zohoapis.${tld}`, `zohoapis.${tld}`]));

/** The origin of an https URL on one of `hosts` (default port, no user info), or null. */
function trustedOrigin(value: string, hosts: Set<string>): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.port || url.username || url.password || !hosts.has(url.hostname)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * The accounts server Zoho's callback names (?accounts-server=). It arrives in the browser's URL
 * and the client secret is sent there, so only Zoho's own accounts servers are accepted.
 */
export function zohoAccountsServer(value: string): string {
  const origin = trustedOrigin(value, ZOHO_ACCOUNTS);
  if (!origin) throw new UntrustedServerError("That sign-in came back from a server that isn't Zoho's, so Zoho Books wasn't connected. Try connecting again.");
  return origin;
}

/** The API domain from Zoho's token response: only Zoho's own API servers (zohoapis.*) are used. */
export function zohoApiDomain(value: string | undefined): string {
  if (!value) return "https://www.zohoapis.com";
  const origin = trustedOrigin(value, ZOHO_APIS);
  if (!origin) throw new UntrustedServerError("Zoho gave an API address that isn't one of Zoho's servers, so it wasn't used. Connect Zoho Books again.");
  return origin;
}

const zohoAccounts = (env: Env, saved?: Record<string, string>) =>
  saved?.accounts_server ? zohoAccountsServer(saved.accounts_server) : (env.ZOHO_ACCOUNTS_URL ?? "https://accounts.zoho.com").replace(/\/$/, "");

export const OAUTH: Partial<Record<Provider, OAuthConfig>> = {
  quickbooks: {
    authorizeUrl: () => "https://appcenter.intuit.com/connect/oauth2",
    tokenUrl: () => "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer",
    revokeUrl: () => "https://developer.api.intuit.com/v2/oauth2/tokens/revoke",
    scope: "com.intuit.quickbooks.accounting",
    clientId: (env) => env.QUICKBOOKS_CLIENT_ID,
    clientSecret: (env) => env.QUICKBOOKS_CLIENT_SECRET,
    clientAuth: "basic",
  },
  zoho_books: {
    authorizeUrl: (env) => `${zohoAccounts(env)}/oauth/v2/auth`,
    // Zoho's callback says which data center the account is in; tokens must come from there.
    tokenUrl: (env, ctx, saved) => `${ctx?.query["accounts-server"] ? zohoAccountsServer(ctx.query["accounts-server"]) : zohoAccounts(env, saved)}/oauth/v2/token`,
    revokeUrl: (env, saved) => `${zohoAccounts(env, saved)}/oauth/v2/token/revoke`,
    scope: "ZohoBooks.fullaccess.all",
    clientId: (env) => env.ZOHO_CLIENT_ID,
    clientSecret: (env) => env.ZOHO_CLIENT_SECRET,
    clientAuth: "body",
    extraParams: { access_type: "offline", prompt: "consent" },
  },
  google_calendar: {
    authorizeUrl: () => "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: () => "https://oauth2.googleapis.com/token",
    revokeUrl: () => "https://oauth2.googleapis.com/revoke",
    scope: "https://www.googleapis.com/auth/calendar.events",
    clientId: (env) => env.GOOGLE_CLIENT_ID,
    clientSecret: (env) => env.GOOGLE_CLIENT_SECRET,
    clientAuth: "body",
    extraParams: { access_type: "offline", prompt: "consent" },
  },
};
