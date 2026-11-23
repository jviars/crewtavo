/**
 * A one-time link from an email (invite, password reset, sign-in) opens the app with
 * ?token_hash=…&type=… (emailAuthLink in apps/api/src/lib/auth.ts), and the app redeems it
 * (session.tsx), so it works whatever the Supabase project's Site URL is. A sign-in that comes back
 * in the address's hash (#access_token=…&refresh_token=…, as Sign in with Google does) is taken the
 * same way: supabase-js doesn't take it by itself (lib/api.ts).
 *
 * Someone already signed in on this browser keeps that sign-in until they say otherwise. The link is
 * redeemed apart from it first, and when it's for a different account they're asked, with both
 * accounts named: anyone can make a link like this for their own account (or paste their own
 * sign-in into one), and it would otherwise switch this browser into that account without a word.
 * A link for the account that's signed in, or opened with nobody signed in, goes straight through,
 * as it always has.
 */
import { isPlaceholderEmail } from "@crewtavo/core/email";
import type { Session } from "@supabase/supabase-js";
import { t } from "@/lib/i18n";

export const LINK_TYPES = ["invite", "recovery", "magiclink", "signup", "email"] as const;
export type LinkType = (typeof LINK_TYPES)[number];

export interface EmailLink {
  tokenHash: string;
  type: LinkType;
  /** The "set your password" wording, for someone invited who never signed in. */
  welcome: boolean;
}

/** The emailed link in a page's query string (?token_hash=…&type=…), or null. */
export function readEmailLink(search: string): EmailLink | null {
  const query = new URLSearchParams(search);
  const tokenHash = query.get("token_hash");
  const type = LINK_TYPES.find((kind) => kind === query.get("type"));
  return tokenHash && type ? { tokenHash, type, welcome: query.get("welcome") === "1" } : null;
}

/** A sign-in handed over in the address's hash (#access_token=…&refresh_token=…), and what kind it says it is. */
export interface HashSignIn {
  accessToken: string;
  refreshToken: string;
  type: LinkType | null;
}

/** The sign-in in a page's hash, or null when it has none. */
export function readHashSignIn(hash: string): HashSignIn | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const accessToken = params.get("access_token");
  const refreshToken = params.get("refresh_token");
  return accessToken && refreshToken ? { accessToken, refreshToken, type: LINK_TYPES.find((kind) => kind === params.get("type")) ?? null } : null;
}

/** The parts of supabase-js's sign-in client this uses (the app's own, and one kept apart from it). */
export interface LinkAuth {
  getSession(): Promise<{ data: { session: Session | null } }>;
  verifyOtp(params: { token_hash: string; type: LinkType }): Promise<{ data: { session: Session | null }; error: unknown }>;
  setSession(tokens: { access_token: string; refresh_token: string }): Promise<{ data?: { session: Session | null }; error: unknown }>;
  signOut(options: { scope: "local" }): Promise<unknown>;
}

/** The question for someone signed in when a link is for another account: each account as they'd know it. */
export interface SwitchQuestion {
  /** The account signed in here now. */
  current: string;
  /** The account the link signs in to. */
  link: string;
}

/**
 * `problem`: what to tell the person (an expired link, no connection), or null. `kept`: the sign-in
 * that was here stays, so whatever the link was for (choosing a password, say) isn't for it.
 */
export interface Redeemed {
  problem: string | null;
  kept: boolean;
}

/** An account as its owner knows it: its email, or for a sub's sign-in with no email of their own, their name. */
export function accountName(session: Session): string {
  const { email, phone, user_metadata: meta } = session.user;
  if (email && !isPlaceholderEmail(email)) return email;
  const name = typeof meta?.full_name === "string" ? meta.full_name.trim() : "";
  return name || phone || t("an account without an email address");
}

/**
 * Trades the link's token (or the sign-in in its hash) for a sign-in. `auth` is the app's own
 * client; `apart` makes one that keeps nothing, for redeeming a link while someone is signed in;
 * `ask` asks them whether to switch (true to switch to the link's account).
 */
export async function redeemEmailLink(link: EmailLink | HashSignIn, { auth, apart, ask }: { auth: LinkAuth; apart: () => LinkAuth; ask: (question: SwitchQuestion) => Promise<boolean> }): Promise<Redeemed> {
  const expired = t("That link has expired or was already used. Ask whoever sent it for a new one, or sign in below.");
  const offline = t("Couldn't open that link. Check your connection and try again.");
  const open = (on: LinkAuth) =>
    "tokenHash" in link ? on.verifyOtp({ token_hash: link.tokenHash, type: link.type }) : on.setSession({ access_token: link.accessToken, refresh_token: link.refreshToken });
  let signedIn = false;
  try {
    const current = (await auth.getSession()).data.session;
    signedIn = Boolean(current);
    if (!current) {
      const { error } = await open(auth);
      return { problem: error ? expired : null, kept: false };
    }
    // Someone is signed in: see whose the link is before anything changes here.
    const other = apart();
    const { data, error } = await open(other);
    const opened = data?.session;
    if (error || !opened) return { problem: t("That link has expired or was already used. Ask whoever sent it for a new one."), kept: true };
    if (opened.user.id !== current.user.id && !(await ask({ current: accountName(current), link: accountName(opened) }))) {
      // They stay as they are, and the link's sign-in is ended rather than left open.
      await other.signOut({ scope: "local" }).catch(() => undefined);
      return { problem: null, kept: true };
    }
    // Their own link, or they chose to switch: the link's sign-in takes this one's place.
    const { error: unmoved } = await auth.setSession({ access_token: opened.access_token, refresh_token: opened.refresh_token });
    return { problem: unmoved ? offline : null, kept: Boolean(unmoved) };
  } catch {
    return { problem: offline, kept: signedIn };
  }
}
