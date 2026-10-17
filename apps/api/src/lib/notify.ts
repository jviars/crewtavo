/**
 * Email and SMS. Email goes out through, in order:
 *   1. the company's own connected mailbox (Settings → Email): Gmail, Zoho, Microsoft 365... over
 *      SMTP with an app password, or the company's Resend key;
 *   2. the server's Resend account (RESEND_API_KEY, EMAIL_FROM), if whoever installed it set one;
 *   3. in development, the local Mailpit inbox (MAILPIT_URL).
 * SMS uses Twilio over REST. When nothing is set up, sends are skipped and the caller gets
 * { sent: false } plus the reason; the UI can then offer the link to copy instead.
 */
import type { Env } from "../env";
import { decryptJson } from "./crypto";
import { reportError } from "./monitoring";
import { smtpSend, SmtpError, type SmtpSettings } from "./smtp";
import { adminClient } from "./supabase";

export interface SendResult {
  sent: boolean;
  id?: string;
  reason?: string;
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

export const forgetMailbox = (companyId: string) => cache.delete(companyId);

/** Is there a server-wide way to send (Resend for the whole install, or Mailpit in development)? */
export const emailConfigured = (env: Env) => Boolean((env.RESEND_API_KEY && env.EMAIL_FROM) || env.MAILPIT_URL);
export const smsConfigured = (env: Env) => Boolean((env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM_NUMBER) || env.MAILPIT_URL);

/** Can this company send email (its own mailbox, or the server's)? */
export async function emailReady(env: Env, companyId?: string | null): Promise<boolean> {
  if (companyId && (await loadMailbox(env, companyId).catch(() => null))) return true;
  return emailConfigured(env);
}

/** Send through a mailbox's settings (also used by Settings → Email to test before saving). */
export async function sendWithMailbox(settings: MailboxSettings, secret: MailboxSecret, message: EmailMessage): Promise<SendResult> {
  const fromName = settings.from_name || message.fromName || null;
  if (settings.kind === "resend") {
    return resendSend(secret.api_key ?? "", fromName ? `${fromName.replace(/[<>"]/g, "")} <${settings.from_email}>` : settings.from_email, message);
  }
  const smtp: SmtpSettings = { host: settings.host!, port: settings.port!, security: settings.security ?? "tls", username: settings.username!, password: secret.password ?? "" };
  try {
    const { id } = await smtpSend(smtp, { from: { name: fromName, email: settings.from_email }, to: message.to, subject: message.subject, text: message.text, html: message.html, replyTo: message.replyTo, headers: message.headers });
    return { sent: true, id };
  } catch (error) {
    if (error instanceof SmtpError) return { sent: false, reason: error.message };
    throw error;
  }
}

export async function sendEmail(env: Env, message: EmailMessage, companyId?: string | null): Promise<SendResult> {
  if (companyId) {
    const mailbox = await loadMailbox(env, companyId).catch(() => null);
    if (mailbox) {
      const result = await sendWithMailbox(mailbox.settings, mailbox.secret, message);
      await noteMailboxHealth(env, companyId, mailbox, result);
      return result;
    }
  }
  if ((!env.RESEND_API_KEY || !env.EMAIL_FROM) && env.MAILPIT_URL) return mailpit(env, { ...message, from: env.EMAIL_FROM });
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return { sent: false, reason: "Email isn't set up yet. An admin can connect the company's email in Settings → Email." };
  return resendSend(env.RESEND_API_KEY, env.EMAIL_FROM, message);
}

/** Show a broken mailbox (changed password, revoked app password) in Settings, and clear it once it works again. */
async function noteMailboxHealth(env: Env, companyId: string, mailbox: Mailbox, result: SendResult) {
  const failedSignIn = !result.sent && /password|sign-in|didn't accept|turned off/i.test(result.reason ?? "");
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
  }).catch(() => null);
  if (!response) return { sent: false, reason: "Couldn't reach the email provider. Try again." };
  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { message?: string };
    return { sent: false, reason: `The email provider refused it (${response.status}${detail.message ? `: ${detail.message}` : ""}).` };
  }
  const body = (await response.json()) as { id?: string };
  return { sent: true, id: body.id };
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
  }).catch(() => null);
  if (!response?.ok) return { sent: false, reason: "Couldn't reach the local Mailpit inbox." };
  const body = (await response.json()) as { ID?: string };
  return { sent: true, id: body.ID };
}

export async function sendSms(env: Env, message: { to: string; body: string }): Promise<SendResult> {
  const { TWILIO_ACCOUNT_SID: sid, TWILIO_AUTH_TOKEN: token, TWILIO_FROM_NUMBER: from } = env;
  if ((!sid || !token || !from) && env.MAILPIT_URL) {
    const digits = message.to.replace(/[^0-9]/g, "") || "unknown";
    return mailpit(env, { to: `sms-${digits}@sms.local`, subject: `Text to ${message.to}`, text: message.body });
  }
  if (!sid || !token || !from) return { sent: false, reason: "Text messaging isn't set up (TWILIO_*)." };
  const response = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
    method: "POST",
    headers: { Authorization: `Basic ${btoa(`${sid}:${token}`)}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ To: message.to, From: from, Body: message.body }),
  }).catch(() => null);
  if (!response) return { sent: false, reason: "Couldn't reach the text provider. Try again." };
  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { message?: string };
    return { sent: false, reason: `The text provider refused it (${response.status}${detail.message ? `: ${detail.message}` : ""}).` };
  }
  const body = (await response.json()) as { sid?: string };
  return { sent: true, id: body.sid };
}
