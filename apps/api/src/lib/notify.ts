/**
 * Email and SMS. Email goes out through, in order:
 *   1. the company's own connected mailbox (Settings → Email): Gmail, Zoho, Microsoft 365... over
 *      SMTP with an app password, or the company's Resend key;
 *   2. the server's Resend account (RESEND_API_KEY, EMAIL_FROM), if whoever installed it set one;
 *   3. in development, the local Mailpit inbox (MAILPIT_URL).
 * SMS goes through the company's Quo number when it connected one (Apps → Quo, lib/quo.ts), else
 * Twilio over REST: the company's own account when it connected one (Apps → Twilio), else the
 * server's (lib/twilio.ts). When nothing is set up, sends are skipped and the caller gets
 * { sent: false } plus the reason; the UI can then offer the link to copy instead.
 * How each send for a company went is noted (noteSending), so its owners and admins hear on the bell
 * and by push when its email or texts stop going out, and not only on Settings → Email.
 */
import { isPersonalMailDomain, isPlaceholderEmail } from "@crewtavo/core/email";
import { phoneE164, textedNumber } from "@crewtavo/core/phone";
import type { Env } from "../env";
import { decryptJson } from "./crypto";
import { reportError } from "./monitoring";
import { smtpReach, smtpSend, SmtpError, type SmtpReach, type SmtpSettings } from "./smtp";
import { companyQuo, forgetQuo, postQuoText, quoUserFor, type QuoAccount } from "./quo";
import { adminClient } from "./supabase";
import { companyTwilio, postMessage, textingCountry, twilioFor, type TwilioAccount } from "./twilio";

export interface SendResult {
  sent: boolean;
  id?: string;
  reason?: string;
  /** The provider's HTTP status when it turned the email or text down: 401/403 is the key, 429 a limit. */
  status?: number;
  /** Twilio's error code when it refused a text: 21610 is a number that texted STOP. */
  code?: number;
}

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  headers?: Record<string, string>;
  /** Display name for the sender, usually the company name. */
  fromName?: string;
}

/** Non-secret mailbox settings, stored in integrations.settings (provider "email"). */
export interface MailboxSettings {
  preset: string;
  kind: "smtp" | "resend";
  host?: string;
  port?: number;
  security?: "tls" | "starttls";
  username?: string;
  from_email: string;
  from_name?: string | null;
}
/** Secret part, AES-encrypted in integration_secrets. */
export interface MailboxSecret {
  password?: string;
  api_key?: string;
}

type Mailbox = { settings: MailboxSettings; secret: MailboxSecret; status: string };

const cache = new Map<string, { at: number; value: Mailbox | null }>();
const CACHE_MS = 60_000;
/** A provider that doesn't answer in time counts as unreachable, so the send is recorded as failed. */
const TIMEOUT_MS = 15_000;

/** The company's connected mailbox, if any (cached for a minute; campaigns send many at once). */
export async function loadMailbox(env: Env, companyId: string): Promise<Mailbox | null> {
  const hit = cache.get(companyId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const admin = adminClient(env);
  const [row, secret] = await Promise.all([
    admin.from("integrations").select("status, settings").eq("company_id", companyId).eq("provider", "email").maybeSingle(),
    admin.from("integration_secrets").select("ciphertext").eq("company_id", companyId).eq("provider", "email").maybeSingle(),
  ]);
  let value: Mailbox | null = null;
  if (row.data && row.data.status !== "disconnected" && secret.data) {
    try {
      value = { settings: row.data.settings as unknown as MailboxSettings, secret: await decryptJson<MailboxSecret>(env, secret.data.ciphertext), status: row.data.status };
    } catch (error) {
      reportError(error, { feature: "mailbox" });
    }
  }
  cache.set(companyId, { at: Date.now(), value });
  return value;
}

/** Whether any company has a mailbox (anyMailbox), cached alongside. */
let someMailbox: { at: number; value: boolean } | null = null;

export const forgetMailbox = (companyId: string) => {
  cache.delete(companyId);
  someMailbox = null;
  // The next email says afresh how sending is going.
  working.delete(`${companyId}:email`);
};

/**
 * Whether any company here sends email from its own mailbox (cached for a minute), for what the
 * sign-in page offers before anyone is known (GET /api/config). Null when it can't be told.
 */
export async function anyMailbox(env: Env): Promise<boolean | null> {
  if (someMailbox && Date.now() - someMailbox.at < CACHE_MS) return someMailbox.value;
  const { data, error } = await adminClient(env).from("integrations").select("company_id").eq("provider", "email").neq("status", "disconnected").limit(1);
  if (error) {
    reportError(new Error(`Couldn't tell whether any company has a mailbox: ${error.message}`), { feature: "mailbox" });
    return null;
  }
  someMailbox = { at: Date.now(), value: Boolean(data?.length) };
  return someMailbox.value;
}

/** Is there a server-wide way to send (Resend for the whole install, or Mailpit in development)? */
export const emailConfigured = (env: Env) => Boolean((env.RESEND_API_KEY && env.EMAIL_FROM) || env.MAILPIT_URL);
/** The same for texts: the server's own Twilio account (or Mailpit in development). A company may have its own: smsReady. */
export const smsConfigured = (env: Env) => Boolean((env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM_NUMBER) || env.MAILPIT_URL);

/** Can this company send email (its own mailbox, or the server's)? */
export async function emailReady(env: Env, companyId?: string | null): Promise<boolean> {
  if (companyId && (await loadMailbox(env, companyId).catch(() => null))) return true;
  return emailConfigured(env);
}

/** Can this company send texts (its Quo number, its own Twilio account, or the server's)? */
export async function smsReady(env: Env, companyId?: string | null): Promise<boolean> {
  if (companyId && (await companyQuo(env, companyId).catch(() => null))) return true;
  if (companyId && (await companyTwilio(env, companyId).catch(() => null))) return true;
  return smsConfigured(env);
}

/** `"Name" <email>`: quoted, so a comma in the name ("Acme Lawn Care, LLC") doesn't split it in two. */
export function fromAddress(name: string | null | undefined, email: string): string {
  const clean = (name ?? "").replace(/[\r\n<>]+/g, " ").trim();
  return clean ? `"${clean.replace(/[\\"]/g, "\\$&")}" <${email}>` : email;
}

const smtpOf = (settings: MailboxSettings, secret: MailboxSecret): SmtpSettings => ({
  host: settings.host!, port: settings.port!, security: settings.security ?? "tls", username: settings.username!, password: secret.password ?? "",
});

/**
 * Send through a mailbox's settings (also used by Settings → Email to test before saving). `reach`
 * is smtpReach(env): a mail server on a private network only when the server allows that one.
 */
export async function sendWithMailbox(settings: MailboxSettings, secret: MailboxSecret, message: EmailMessage, reach: SmtpReach = "public"): Promise<SendResult> {
  const fromName = settings.from_name || message.fromName || null;
  if (settings.kind === "resend") {
    return resendSend(secret.api_key ?? "", fromAddress(fromName, settings.from_email), message);
  }
  const smtp = smtpOf(settings, secret);
  try {
    const { id } = await smtpSend(smtp, { from: { name: fromName, email: settings.from_email }, to: message.to, subject: message.subject, text: message.text, html: message.html, replyTo: message.replyTo, headers: message.headers }, undefined, reach);
    return { sent: true, id };
  } catch (error) {
    if (error instanceof SmtpError) return { sent: false, reason: error.message };
    throw error;
  }
}

/**
 * Does the company's mailbox still sign in? Checked without sending, as Settings → Email does before
 * saving. A Resend key can't be checked without sending, so it passes. A refused sign-in shows in Settings.
 */
export async function checkMailbox(env: Env, companyId: string, mailbox: Mailbox): Promise<boolean> {
  if (mailbox.settings.kind !== "smtp") return true;
  let result: SendResult = { sent: true };
  try {
    await smtpSend(smtpOf(mailbox.settings, mailbox.secret), null, undefined, smtpReach(env));
  } catch (error) {
    if (!(error instanceof SmtpError)) throw error;
    result = { sent: false, reason: error.message };
  }
  await noteMailboxHealth(env, companyId, mailbox, result);
  // A sign-in that still works doesn't mean emails are going out again, so only a refusal is passed on.
  if (!result.sent) await noteSending(env, companyId, "email", result);
  return result.sent;
}

/**
 * Whether one of the company's owners connected its mailbox (integrations.connected_by, which every
 * save in Settings → Email sets), going by who's an owner now: someone who has since stopped being
 * one doesn't count, and nor does a mailbox whose saver can't be told. Whoever connects a mailbox
 * can read what goes out through it, so a way into an owner's or admin's account only goes through
 * one an owner connected (sendEmail's `adminAccount`). Asked afresh each time, never cached.
 */
export async function mailboxOwnerSet(env: Env, companyId: string): Promise<boolean> {
  const admin = adminClient(env);
  const { data: row, error } = await admin.from("integrations").select("connected_by").eq("company_id", companyId).eq("provider", "email").maybeSingle();
  if (error || !row?.connected_by) return false;
  const { data: owner, error: ownerError } = await admin
    .from("memberships")
    .select("user_id")
    .eq("company_id", companyId)
    .eq("user_id", row.connected_by)
    .eq("role", "owner")
    .eq("active", true)
    .maybeSingle();
  return !ownerError && Boolean(owner);
}

export interface SendOptions {
  /**
   * The email is a way into an account with admin-level access (a sign-in, reset or invitation link
   * for an owner or an admin): it goes through the company's mailbox only when an owner connected
   * it (mailboxOwnerSet), and otherwise through the server's own email, when there is one.
   */
  adminAccount?: boolean;
}

/** Why an owner's or admin's link didn't go through the company's mailbox. Its words never read as a refused sign-in (sendProblem). */
export const NOT_OWNERS_MAILBOX =
  "The company's email was connected by someone who isn't an owner, so links into owners' and admins' accounts don't go through it. An owner can connect it again in Settings → Email.";

export async function sendEmail(env: Env, message: EmailMessage, companyId?: string | null, options: SendOptions = {}): Promise<SendResult> {
  // A sub's stand-in address (a sign-in without an email of their own) never gets anything.
  if (isPlaceholderEmail(message.to)) return { sent: false, reason: "They have no email address. Text them instead." };
  let passedOver = false;
  if (companyId) {
    const mailbox = await loadMailbox(env, companyId).catch(() => null);
    if (mailbox && (!options.adminAccount || (await mailboxOwnerSet(env, companyId)))) {
      const result = await sendWithMailbox(mailbox.settings, mailbox.secret, message, smtpReach(env));
      await noteMailboxHealth(env, companyId, mailbox, result);
      await noteSending(env, companyId, "email", result);
      return result;
    }
    passedOver = Boolean(mailbox);
  }
  if ((!env.RESEND_API_KEY || !env.EMAIL_FROM) && env.MAILPIT_URL) return mailpit(env, { ...message, from: env.EMAIL_FROM });
  if (passedOver && (!env.RESEND_API_KEY || !env.EMAIL_FROM)) return { sent: false, reason: NOT_OWNERS_MAILBOX };
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return { sent: false, reason: "Email isn't set up yet. An owner can connect the company's email in Settings → Email." };
  const result = await resendSend(env.RESEND_API_KEY, env.EMAIL_FROM, message);
  if (companyId) await noteSending(env, companyId, "email", result);
  return result;
}

/** A send that worked is reported to the database again after this long; in between, it's taken as still working. */
const WORKING_MS = 10 * 60_000;
/** When each company's email and texts were last reported working, by company and channel. */
const working = new Map<string, number>();

const SENDING_WARNING = {
  email: {
    title: "Emails aren't going out",
    lead: "The last few emails didn't go.",
    fix: "Quotes, invoices and reminders won't reach anyone by email until it's fixed, in Settings → Email.",
  },
  sms: {
    title: "Texts aren't going out",
    lead: "The last few texts didn't go.",
    fix: "Reminders and other texts won't reach anyone until it's fixed. Check the Twilio account, and the Twilio keys this Crewtavo was set up with.",
  },
};
/** The same for a company on its own Twilio account, which it fixes itself on the Apps page. */
const OWN_TWILIO_FIX = "Reminders and other texts won't reach anyone until it's fixed. Check your Twilio account, then connect it again in Apps → Twilio.";
/** And on its Quo number. */
const OWN_QUO_FIX = "Reminders and other texts won't reach anyone until it's fixed. Check your Quo workspace, then connect it again in Apps → Quo if its key changed.";

/**
 * Tells the database how a company's email or text went, so its owners and admins hear when sending
 * stops (public.note_sending): at once when the sign-in is refused, and after a few failures in a
 * row otherwise, once, on the bell and by push. A send that works clears it. An address or number
 * that can't be sent to says nothing about the company's sending, so it isn't counted. Never throws:
 * whether the message went is already known, and this mustn't change it.
 */
export async function noteSending(env: Env, companyId: string, channel: "email" | "sms", result: SendResult, own: boolean | "quo" = false): Promise<void> {
  const problem = result.sent ? null : sendProblem(result);
  if (problem === "unset" || problem === "recipient") return;
  const key = `${companyId}:${channel}`;
  if (!problem && Date.now() - (working.get(key) ?? 0) < WORKING_MS) return;
  // After a failure, the next send that works is always reported, to clear it.
  if (problem) working.delete(key);
  try {
    const words = SENDING_WARNING[channel];
    const reason = (result.reason ?? "").trim().slice(0, 500);
    const { error } = await adminClient(env).rpc(
      "note_sending",
      problem
        ? {
            p_company: companyId, p_channel: channel, p_ok: false, p_error: reason, p_refused: problem === "sign_in",
            p_title: words.title, p_body: [problem === "sign_in" ? "" : words.lead, reason, channel === "sms" && own === "quo" ? OWN_QUO_FIX : channel === "sms" && own ? OWN_TWILIO_FIX : words.fix].filter(Boolean).join(" "),
          }
        : { p_company: companyId, p_channel: channel, p_ok: true },
    );
    if (error) throw new Error(error.message);
    if (!problem) working.set(key, Date.now());
  } catch (error) {
    reportError(error, { feature: "sending-health" });
  }
}

/** The company's email or texts were just seen to work (its mailbox connected again): clear any warning now. */
export async function sendingWorks(env: Env, companyId: string, channel: "email" | "sms"): Promise<void> {
  working.delete(`${companyId}:${channel}`);
  await noteSending(env, companyId, channel, { sent: true });
}

/** Twilio's codes for a number that can't be texted: not a number, not a mobile, unreachable, or it texted STOP. */
const TWILIO_BAD_NUMBER = [21211, 21214, 21217, 21610, 21612, 21614];

/**
 * Why an email or text didn't go, for whoever decides whether to try again: "unset" (nothing is set
 * up to send with), "recipient" (that one address or number can't be sent to, so another try won't
 * help and nothing is wrong with the company's sending), "sign_in" (the mailbox, key or account was
 * refused) or "provider" (anything else: unreachable, a limit, an outage).
 */
export function sendProblem(result: SendResult): "unset" | "recipient" | "sign_in" | "provider" {
  const reason = result.reason ?? "";
  if (/isn't set up/i.test(reason)) return "unset";
  if (TWILIO_BAD_NUMBER.includes(result.code ?? 0) || /wouldn't send to that address|isn't a valid email address|email address isn't valid|have no email address/i.test(reason)) return "recipient";
  if (result.status === 401 || result.status === 403 || /password|sign-in|didn't accept|turned off/i.test(reason)) return "sign_in";
  return "provider";
}

/**
 * Show a broken mailbox (changed password, revoked app password, a Resend key that's revoked or not
 * allowed to send) in Settings, and clear it once it works again.
 */
async function noteMailboxHealth(env: Env, companyId: string, mailbox: Mailbox, result: SendResult) {
  const failedSignIn = !result.sent && sendProblem(result) === "sign_in";
  const next = result.sent ? "connected" : failedSignIn ? "error" : mailbox.status;
  if (next === mailbox.status) return;
  mailbox.status = next;
  await adminClient(env)
    .from("integrations")
    .update({ status: next, last_error: result.sent ? null : (result.reason ?? "").slice(0, 500) })
    .eq("company_id", companyId)
    .eq("provider", "email");
}

async function resendSend(apiKey: string, from: string, message: EmailMessage): Promise<SendResult> {
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to: [message.to],
      subject: message.subject,
      text: message.text,
      html: message.html,
      reply_to: message.replyTo,
      headers: message.headers,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => null);
  if (!response) return { sent: false, reason: "Couldn't reach Resend. Try again." };
  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { message?: string };
    return { sent: false, status: response.status, reason: resendProblem(response.status, detail.message ?? "") };
  }
  const body = (await response.json().catch(() => ({}))) as { id?: string };
  return { sent: true, id: body.id };
}

/**
 * Resend's refusals in words the person setting up email can act on. These show in Settings → Email
 * and wherever a send fails; anything not listed keeps Resend's own message.
 */
export function resendProblem(status: number, message: string): string {
  const keyDomain = message.match(/not authorized to send emails from ([a-z0-9.-]+[a-z0-9])/i)?.[1];
  if (keyDomain) {
    return `This Resend API key can only send from a different domain, not ${keyDomain}. In Resend, create a new API key with Sending access for all domains (or for ${keyDomain}) and use it instead, or send from an address on the domain the key is for.`;
  }
  const unverified = message.match(/the\s+`?([a-z0-9.-]+[a-z0-9])`?\s+domain is not verified/i)?.[1];
  if (unverified && isPersonalMailDomain(unverified)) {
    return `Resend can't send from a ${unverified} address. Send from an address on your own domain (the one you added in Resend), like office@yourcompany.com.`;
  }
  if (unverified) {
    return `${unverified} isn't verified in Resend yet. In Resend, open Domains, check every DNS record for it is added, and wait until it shows Verified (usually within 15 minutes). Or send from an address on a domain that's already verified.`;
  }
  if (/only send testing emails to your own email/i.test(message)) {
    return "This Resend account has no verified domain yet, so it only sends tests to its owner. Add your domain under Domains in Resend, wait until it shows Verified, and send from an address on it.";
  }
  if (/suspended/i.test(message)) return "Resend has suspended this API key. Check the Resend account, or ask Resend's support why.";
  if (status === 401 || /api key is (invalid|not active)|missing api key/i.test(message)) {
    return "Resend didn't accept this API key. It may have been deleted, or only part of it was copied. Create a new one under API keys in Resend and paste the whole key (it starts with re_).";
  }
  if (/daily .*quota/i.test(message)) {
    return "This Resend account has reached its daily sending limit (100 emails on the free plan). Sending starts again after midnight UTC, or upgrade the Resend plan to send more.";
  }
  if (/monthly .*quota/i.test(message)) {
    return "This Resend account has reached its monthly sending limit (3,000 emails on the free plan). Upgrade the Resend plan to keep sending this month.";
  }
  // A bounced address, not Resend's: said so, not in Resend's own words (an ask to a client's typo).
  if (status === 422 && /`to`|\bto\b field/i.test(message)) return "That email address isn't valid, so Resend didn't send it.";
  if (status === 429) return "Resend got too many emails at once. Try again in a minute.";
  if (status >= 500) return "Resend is having trouble right now. Try again in a few minutes.";
  return `Resend refused it (${status}${message ? `: ${message}` : ""}).`;
}

/** Development transport: Mailpit's HTTP send API. */
async function mailpit(env: Env, message: EmailMessage & { from?: string }): Promise<SendResult> {
  const fromMatch = (message.from || `${message.fromName ?? "Crewtavo"} <noreply@crewtavo.local>`).match(/^(.*)<(.+)>$/);
  const response = await fetch(`${env.MAILPIT_URL!.replace(/\/$/, "")}/api/v1/send`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      From: fromMatch ? { Name: fromMatch[1].trim(), Email: fromMatch[2].trim() } : { Email: message.from || "noreply@crewtavo.local" },
      To: [{ Email: message.to }],
      Subject: message.subject,
      Text: message.text,
      HTML: message.html,
      ReplyTo: message.replyTo ? [{ Email: message.replyTo }] : undefined,
      Headers: message.headers,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch(() => null);
  if (!response?.ok) return { sent: false, reason: "Couldn't reach the local Mailpit inbox." };
  const body = (await response.json().catch(() => ({}))) as { ID?: string };
  return { sent: true, id: body.ID };
}

/**
 * Send a text, from the company's own Twilio account when it has one, else the server's. `company`
 * says whose account when someone is sending by hand and watching how it goes. Given as
 * `companyId` (sends nobody is watching: notifications, automations, review asks), how it went is
 * also noted, so its owners hear when texts stop going out (noteSending).
 */
export async function sendSms(env: Env, message: SmsMessage, companyId?: string | null): Promise<SendResult> {
  const whose = companyId ?? message.company ?? null;
  // A company with its Quo number texts from it, whatever else it has (lib/quo.ts). When that
  // can't be read, nothing is sent: it mustn't go out from another number instead.
  let quo: QuoAccount | null = null;
  if (whose) {
    try {
      quo = await companyQuo(env, whose);
    } catch (error) {
      reportError(error, { feature: "quo" });
      return { sent: false, reason: "Couldn't read how this business sends texts. Try again in a minute." };
    }
  }
  if (quo) {
    const result = await quoTextOut(env, quo, message);
    await noteQuoHealth(env, quo, result);
    if (companyId) await noteSending(env, companyId, "sms", result, "quo");
    return result;
  }
  const account = await twilioFor(env, whose);
  const result = await textOut(env, account, { ...message, to: await numberToText(env, whose, message.to) });
  if (account?.own && whose) await noteTwilioHealth(env, whose, account, result);
  if (companyId) await noteSending(env, companyId, "sms", result, Boolean(account?.own));
  return result;
}

export interface SmsMessage {
  to: string;
  body: string;
  /** Whose number it goes from, when someone is sending by hand and watching how it goes. */
  company?: string | null;
  /**
   * Someone wrote it themselves (Messages): on Quo it's sent as them when they're on the number
   * (by their sign-in email), and the conversation stays open in Quo's inbox. Anything else
   * Crewtavo sends by itself goes to Quo's Done view, unless the company turned that off.
   */
  by?: { userId: string } | null;
}

/**
 * Quo's refusals, said the way the rest of Crewtavo reads a text that wasn't sent (sendProblem,
 * services/textsOff.ts): a number that opted out as Twilio's 21610, one that isn't a number or
 * can't get texts as Twilio's 21211 and 21612, and a key Quo no longer takes as a 401.
 */
const QUO_CODES: Record<string, number> = {
  "User Opted Out": 21610,
  "Invalid `to` Phone Number": 21211,
  "Unreachable `to` Phone Number": 21612,
};

/** In words for the office, for Quo's refusals that aren't plain. */
const QUO_WORDS: Record<string, string> = {
  "User Opted Out": "They opted out of texts from your Quo number.",
  "Not Enough Credits": "Your Quo workspace is out of prepaid credits for texts sent through its API. Add credits in Quo's billing settings.",
  "Subscription Expired": "Your Quo subscription has expired.",
  "Not Phone Number User": "The Quo number's owner isn't a member of it anymore, so Quo won't send from it. Check the number's members in Quo.",
  "A2P Registration Not Approved": "Quo hasn't approved your business for texting yet (A2P 10DLC registration). Check its status in Quo.",
  "A2P 10DLC Daily Message Cap Reached": "Your Quo number reached its daily texting limit. Quo's support can raise it.",
  "International Messaging Not Allowed": "International texting isn't turned on for your Quo number.",
  "Not TFN Registered": "Your Quo toll-free number isn't registered for texting yet.",
};

async function quoTextOut(env: Env, account: QuoAccount, message: SmsMessage): Promise<SendResult> {
  if (!message.body.trim()) return { sent: false, reason: "There's nothing to text." };
  // Quo takes numbers only in E.164 ("+15405550101"), completed for the company's country as Twilio's are.
  const to = phoneE164(await numberToText(env, account.companyId, message.to));
  if (!to) return { sent: false, reason: `${message.to} isn't a whole phone number.`, code: 21211 };
  const senderUserId = message.by ? await quoUserFor(env, account, await signInEmail(env, message.by.userId)) : null;
  // To Quo's Done view only when nothing from that number may be waiting for an answer: Done moves
  // the whole conversation, a question they texted included.
  const quiet = !message.by && account.settings.quiet !== false && !(await textedLately(env, account.companyId, to));
  const sent = await postQuoText(env, account, { to, body: message.body.slice(0, 1600), quiet, senderUserId });
  if (sent.ok) {
    // Before anything else: Quo reports every text the number sends, and this one is Crewtavo's.
    const { error } = await adminClient(env).from("quo_sent").upsert({ company_id: account.companyId, message_id: sent.id });
    if (error) reportError(new Error(`Couldn't note a text sent through Quo: ${error.message}`), { feature: "quo" });
    return { sent: true, id: sent.id };
  }
  if (sent.status === 0) return { sent: false, reason: "Couldn't reach Quo. Try again." };
  const code = sent.title ? QUO_CODES[sent.title] : undefined;
  const words = (sent.title && QUO_WORDS[sent.title]) || sent.message;
  return {
    sent: false,
    // A key Quo turned down, or a number nobody may send from, is the company's to fix; Quo's other 403s (a daily cap) aren't.
    ...(sent.status === 401 || sent.title === "Not Phone Number User" ? { status: sent.status } : {}),
    reason: `Quo refused it (${sent.status}${words ? `: ${words}` : ""}).`,
    ...(code ? { code } : {}),
  };
}

/** How far back a text from a number keeps Crewtavo's own texts to it in Quo's inbox. */
const LATELY_MS = 3 * 86_400_000;

/** The number texted the company in the last few days (or that can't be told). */
async function textedLately(env: Env, companyId: string, to: string): Promise<boolean> {
  const key = to.replace(/\D/g, "").slice(-10);
  if (key.length < 7) return false;
  const since = new Date(Date.now() - LATELY_MS).toISOString();
  const pattern = `${key.slice(-4).split("").join("[^0-9]*")}[^0-9]*$`;
  const [client, stranger] = await Promise.all([
    adminClient(env).from("messages").select("id").eq("company_id", companyId).eq("direction", "in").eq("channel", "sms").gte("created_at", since).filter("from_phone", "match", pattern).limit(1),
    adminClient(env).from("unknown_texts").select("id").eq("company_id", companyId).eq("phone_key", key).gte("created_at", since).limit(1),
  ]);
  if (client.error || stranger.error) return true;
  return Boolean(client.data?.length || stranger.data?.length);
}

/** A person's sign-in email, or null when it can't be read. */
async function signInEmail(env: Env, userId: string): Promise<string | null> {
  const { data, error } = await adminClient(env).auth.admin.getUserById(userId);
  return error ? null : (data.user?.email ?? null);
}

/** Show a Quo key that stopped working on the Apps page (status "error"), and clear it once a text goes through again. */
async function noteQuoHealth(env: Env, account: QuoAccount, result: SendResult) {
  const refused = !result.sent && result.status === 401;
  const next = result.sent ? "connected" : refused ? "error" : account.status;
  if (next === account.status) return;
  account.status = next;
  // Never over a disconnect that happened while the text was on its way.
  await adminClient(env)
    .from("integrations")
    .update({ status: next, last_error: result.sent ? null : (result.reason ?? "").slice(0, 500) })
    .eq("company_id", account.companyId)
    .eq("provider", "quo")
    .neq("status", "disconnected");
  forgetQuo(account.companyId);
}

/**
 * The number Twilio is given. Numbers are kept as the office typed them, which outside North
 * America leaves out the country code Twilio needs ("07700 900123"): the company's country
 * completes it (core textedNumber), where replies and STOPs from the completed number still find
 * the client. A US or Canadian company's go as typed, as they always have, and so does every
 * number when the company's country can't be read.
 */
async function numberToText(env: Env, companyId: string | null, to: string): Promise<string> {
  if (!companyId || /^\+[0-9]+$/.test(to)) return to;
  return textedNumber(to, await textingCountry(env, companyId).catch(() => null));
}

/**
 * Show a company's own Twilio account that stopped signing in (a changed Auth Token, a closed
 * account) on its Apps page, and clear it once a text goes through again.
 */
async function noteTwilioHealth(env: Env, companyId: string, account: TwilioAccount, result: SendResult) {
  const refused = !result.sent && sendProblem(result) === "sign_in";
  const next = result.sent ? "connected" : refused ? "error" : account.status;
  if (!next || next === account.status) return;
  account.status = next;
  await adminClient(env)
    .from("integrations")
    .update({ status: next, last_error: result.sent ? null : (result.reason ?? "").slice(0, 500) })
    .eq("company_id", companyId)
    .eq("provider", "twilio");
}

async function textOut(env: Env, account: TwilioAccount | null, message: { to: string; body: string }): Promise<SendResult> {
  if (!account && env.MAILPIT_URL) {
    const digits = message.to.replace(/[^0-9]/g, "") || "unknown";
    return mailpit(env, { to: `sms-${digits}@sms.local`, subject: `Text to ${message.to}`, text: message.body });
  }
  if (!account) return { sent: false, reason: "Texting isn't set up yet. An admin can connect Quo or Twilio in Apps." };
  const response = await postMessage(account, message);
  if (!response) return { sent: false, reason: "Couldn't reach the text provider. Try again." };
  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { message?: string; code?: number };
    return {
      sent: false,
      status: response.status,
      reason: `The text provider refused it (${response.status}${detail.message ? `: ${detail.message}` : ""}).`,
      ...(typeof detail.code === "number" ? { code: detail.code } : {}),
    };
  }
  const body = (await response.json().catch(() => ({}))) as { sid?: string };
  return { sent: true, id: body.sid };
}
