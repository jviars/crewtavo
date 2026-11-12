/**
 * What the connect screen (OAuthConsentPage) tells someone before they let an app in: where the
 * connection really leads, and what the app will be able to read.
 *
 * Any app can register itself with the sign-in server under any name and logo ("Claude", with
 * Claude's logo), so the name proves nothing. What can't be faked is the address the sign-in server
 * will send the person's access to once they press Allow (the redirect address the app registered),
 * so the screen shows that address's host, and says when it isn't one Claude or ChatGPT use.
 */

/**
 * The hosts Claude's and ChatGPT's own connectors receive a sign-in at, over https, from their
 * documentation in November 2026:
 * - Claude (web, desktop and mobile): https://claude.ai/api/mcp/auth_callback, which Anthropic says
 *   may become https://claude.com/api/mcp/auth_callback (support article 11503834).
 * - ChatGPT: https://chatgpt.com/connector_platform_oauth_redirect and
 *   https://chatgpt.com/connector/oauth/{callback_id} (developers.openai.com/apps-sdk/build/auth).
 * Apps that run on the person's own computer (Claude Code, Codex, an editor) receive it at
 * localhost instead, which any program on that computer can do, so they get their own wording.
 * A host missing from here only means a caution is shown: nothing is blocked.
 */
export const KNOWN_ASSISTANT_HOSTS: Readonly<Record<string, string>> = { "claude.ai": "Claude", "claude.com": "Claude", "chatgpt.com": "ChatGPT" };

export interface ConsentDestination {
  /** The address to show: the host (with its port), or the whole address when it isn't a web address. */
  host: string;
  /** known: Claude's or ChatGPT's own address. local: an app on this computer. other: anywhere else. */
  kind: "known" | "local" | "other";
  /** Whose address a known one is. */
  owner: string | null;
  /** What to say under it: whose address it is, or why to think twice. */
  note: string;
}

const LOCAL_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

/** Where an app's connection leads, from the redirect address the sign-in server holds for it. */
export function consentDestination(redirectUri: string | null | undefined): ConsentDestination {
  let url: URL | null = null;
  try {
    url = new URL((redirectUri ?? "").trim());
  } catch {
    // Not an address at all: shown as it came, with the caution.
  }
  const web = url?.protocol === "https:" || url?.protocol === "http:";
  const owner = url?.protocol === "https:" && !url.port && Object.hasOwn(KNOWN_ASSISTANT_HOSTS, url.hostname) ? KNOWN_ASSISTANT_HOSTS[url.hostname]! : null;
  if (url && owner) return { host: url.hostname, kind: "known", owner, note: `${owner}'s own address.` };
  if (url && web && LOCAL_HOSTS.includes(url.hostname)) {
    return {
      host: url.host,
      kind: "local",
      owner: null,
      note: "That's an app on this computer, not Claude's or ChatGPT's own site. Allow it only if you started this from that app just now.",
    };
  }
  // An app's own kind of link (cursor://…) has no host worth the name: show where it starts.
  const host = url ? (web ? url.host : `${url.protocol}//${url.host || url.pathname.replace(/^\/+/, "").split("/")[0]}`) : (redirectUri ?? "").trim().slice(0, 80) || "an address we couldn't read";
  return {
    host,
    kind: "other",
    owner: null,
    note: `This isn't Claude's or ChatGPT's own address, whatever the app calls itself. Allow it only if you started this yourself and know who runs ${host}.`,
  };
}

/** What the app will be able to read once allowed: all of it, said plainly. */
export const CAN_READ =
  "Everything you can see in Crewtavo. Depending on your role, that includes clients and their addresses, gate and alarm codes, quotes, invoices and payments, the schedule and pay.";

/** And what it can't do yet. */
export const CANT_CHANGE = "It can't change anything until you allow it, in Crewtavo under Settings → AI assistants.";

/**
 * What it can change, for an app this person connected before and gave more than reading (the
 * sign-in server asks again when an app wants more than it was approved for): it keeps that.
 */
export const keepsAccess = (access: string) => `It keeps what you gave it before (${access}). Change that in Crewtavo, under Settings → AI assistants.`;
