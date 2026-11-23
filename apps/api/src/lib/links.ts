/** Signed, expiring links for clients (and subcontractors) that work without an account. */
import type { Env } from "../env";
import { signToken, verifyToken } from "./crypto";

/**
 * quote / invoice: the Client Hub page for that document.
 * client: the client's Hub home (upcoming visits, quotes, invoices, request work).
 * unsub: marketing unsubscribe.  review: tracked review link.  refer: a client's referral page.
 * sub: a subcontractor's page for sending in their paperwork (routes/subs.ts), without signing in.
 */
export type LinkKind = "quote" | "invoice" | "client" | "unsub" | "review" | "refer" | "sub";

export interface ClientLink {
  c: string; // company id
  t: LinkKind;
  id: string; // record id (client id for client/unsub/refer, review request id for review, subcontractor id for sub)
  exp: number; // seconds since epoch
  pv?: 1; // office preview: may show drafts
  // "office": a copy of the client's Hub link the office made (Copy Client Hub link), every link a
  // signed-in person is handed (a send's Copy link, a send typed to an address that isn't the
  // client's, a rule's email or text to a contact; clientLinks), and every link minted from one. It
  // works as the client's own link, except that it can't say yes to a card it didn't save itself or
  // add a tip to a saved card. Missing means the client's own link (and see `own`).
  via?: "office";
  // 1: the client's own link, sent to their own email or phone (clientLinks' `own`, the autopay
  // invite, receipts and notices, an automation's email or text to them), and every link minted from
  // one. Only a link with it can say yes to a card it didn't save or tip on a saved card: one
  // without it (every link minted before it was added) can do all else the client's own can.
  own?: 1;
  // When the link was made, in milliseconds since epoch; a link minted from another keeps that
  // one's time (0 when it had none), so it can't outlive a reset. The office can reset one client's
  // links (clients.links_reset_at): a quote, invoice or client link made before the reset, or one
  // from before links carried a time, then stops opening (linksReplaced). Other kinds don't look.
  at?: number;
  // 1: an office copy made for someone who doesn't see invoices (an estimator, a crew, a role with
  // Invoices and payments off): its Hub home leaves out the client's invoices, balances, payments,
  // referral credit and the autopay they're on (routes/public.ts clientHome), and every link minted
  // from it keeps the mark. The client's own link never has it.
  nm?: 1;
}

const PATHS: Record<LinkKind, string> = {
  quote: "/hub/",
  invoice: "/hub/",
  client: "/hub/",
  unsub: "/u/",
  review: "/api/public/r/",
  refer: "/refer/",
  sub: "/paperwork/",
};

const LIFETIME_DAYS: Record<LinkKind, number> = { quote: 60, invoice: 90, client: 120, unsub: 3650, review: 365, refer: 3650, sub: 30 };
export const linkLifetimeDays = (kind: LinkKind) => LIFETIME_DAYS[kind];

/**
 * A signed link of `link.t`'s kind, good for `days` (the kind's own lifetime unless said). `exp`:
 * the link it's minted from runs out then, and this one never outlives it (it runs out at whichever
 * comes first), so opening a link can't hand out fresh ones that keep it going for good.
 */
export async function clientLink(env: Env, baseUrl: string, link: Omit<ClientLink, "exp"> & { exp?: number }, days?: number): Promise<string> {
  const lifetime = days ?? LIFETIME_DAYS[link.t];
  const now = Date.now();
  const own = Math.floor(now / 1000) + lifetime * 86_400;
  const exp = typeof link.exp === "number" && Number.isFinite(link.exp) ? Math.min(link.exp, own) : own;
  const token = await signToken(env, { ...link, at: link.at ?? now, exp });
  return `${baseUrl.replace(/\/$/, "")}${PATHS[link.t]}${token}`;
}

/**
 * What stands for a client's link in the copy the team keeps of what was sent: the client's timeline,
 * and a rule's notes, tasks and notices. A link opens the client's page without a sign-in, as the
 * client, for months, and everyone who reads these would hold one: crews read a visit's messages, and
 * an AI assistant connected as someone reads what they do. The client has their link; someone in the
 * office who needs one copies it from the quote, invoice or client page.
 */
export const KEPT_LINK = "[Client Hub link]";

/**
 * One client link minted for each place it goes: `own`, the client's own (own: 1), only for the email
 * or text that goes out to their own email or phone (sentToClient); `office`, the office's copy (via
 * "office"), for what a send hands back to the person who sent it to copy, and for a send to any other
 * address. So no one on the team holds a link that can say yes to autopay or tip on the client's
 * saved card for them. `kept`, for the copy kept on the client's timeline, is no link at all
 * (KEPT_LINK).
 *
 * `nm` (lib/links above) only ever marks the office's copy: the client's own link shows them their
 * money.
 */
export async function clientLinks(env: Env, baseUrl: string, link: Omit<ClientLink, "exp" | "via" | "own">, days?: number): Promise<{ own: string; office: string; kept: string }> {
  const { nm, ...rest } = link;
  const [own, office] = await Promise.all([
    clientLink(env, baseUrl, { ...rest, own: 1 }, days),
    clientLink(env, baseUrl, { ...rest, via: "office", ...(nm && { nm }) }, days),
  ]);
  return { own, office, kept: KEPT_LINK };
}

/** An email's address for comparing: trimmed, in lower case. */
const emailKey = (value: string | null | undefined) => (value ?? "").trim().toLowerCase();

/** A phone number's digits for comparing, without the leading country code 1 of a US or Canadian number. */
const phoneKey = (value: string | null | undefined) => {
  const digits = (value ?? "").replace(/\D/g, "");
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
};

/**
 * Whether a send goes to the client's own contact on file, so it can carry their own link: an email
 * to their email (any case, spaces aside), or a text to their phone (the same digits, with or
 * without the leading 1). A send typed to any other address gets the office's copy.
 */
export function sentToClient(channel: "email" | "sms", to: string | null | undefined, client: { email: string | null; phone: string | null } | null | undefined): boolean {
  if (!client) return false;
  const [sent, onFile] = channel === "email" ? [emailKey(to), emailKey(client.email)] : [phoneKey(to), phoneKey(client.phone)];
  return Boolean(onFile) && sent === onFile;
}

export const readClientLink = (env: Env, token: string) => verifyToken<ClientLink>(env, token);

/**
 * Whether the office has reset the client's links since this one was made (clients.links_reset_at,
 * set by POST /clients/:id/links/reset): made before the reset, or before links carried a time.
 * Never without a reset, so links already out keep opening until someone asks for one.
 */
export function linksReplaced(link: Pick<ClientLink, "at">, resetAt: string | null | undefined): boolean {
  if (!resetAt) return false;
  const reset = Date.parse(resetAt);
  return Number.isFinite(reset) && (link.at ?? 0) < reset;
}

/** A review ask's short link token (review_requests.link_token): 12 letters and digits. */
export const REVIEW_TOKEN = /^[0-9A-Za-z]{12}$/;

/** A review ask's short link, in the ask and its reminders: about 50 characters, where a signed one is about 265. */
export const reviewLink = (baseUrl: string, token: string) => `${baseUrl.replace(/\/$/, "")}${PATHS.review}${token}`;

/**
 * A request from a link preview or crawler, not a person opening the link: a text's or chat app's
 * preview (iMessage sends "facebookexternalhit/1.1 Facebot Twitterbot/1.0"), Slack, WhatsApp and
 * the like. A tracked link still answers it, but doesn't count it as an open.
 */
export function linkPreview(userAgent: string | null | undefined): boolean {
  return /facebookexternalhit|facebot|twitterbot|slackbot|whatsapp|telegrambot|discordbot|linkedinbot|skypeuripreview|bot\b|crawler|spider|preview/i.test(userAgent ?? "");
}
