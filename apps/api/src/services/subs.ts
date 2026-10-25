/**
 * Subcontractors' paperwork (supabase/migrations/20261025001001_subcontractors.sql): the link a sub
 * without an account sends their W-9 and certificates through, sending it to them by email or text,
 * and the reminders before a certificate runs out. The office reads and changes subs and their
 * documents itself, under row-level security; these are the parts with a signed link or a message.
 */
import { neededPaperwork, paperworkLinkIntro, paperworkLinkMessages, subDocumentLabel, type NeededPaperwork, type PaperworkRequirement } from "@crewtavo/core";
import type { Env } from "../env";
import { firstName, renderEmail } from "../lib/email";
import { HttpError, must } from "../lib/http";
import { clientLink, linkLifetimeDays } from "../lib/links";
import { reportError } from "../lib/monitoring";
import { sendEmail, sendSms, smsConfigured } from "../lib/notify";
import type { Db } from "../lib/supabase";
import { logoImage } from "./logo";

export interface SubPaperwork {
  needed: NeededPaperwork[];
  /** Sent in and not checked by the office yet (and not run out), so not asked for again. */
  waiting: PaperworkRequirement[];
}

/** A sub's paperwork that's missing, running out or run out, and what's waiting to be checked. */
export async function subPaperwork(db: Db, companyId: string, subId: string): Promise<SubPaperwork> {
  const rows = must(await db.from("sub_paperwork").select("requirement, state, expires_on, verified, waiting").eq("company_id", companyId).eq("subcontractor_id", subId));
  return neededPaperwork(rows);
}

/** The sub's own link to send in paperwork, good for 30 days. */
export async function paperworkLink(env: Env, baseUrl: string, companyId: string, subId: string) {
  const link = await clientLink(env, baseUrl, { c: companyId, t: "sub", id: subId });
  return { link, expires_at: new Date(Date.now() + linkLifetimeDays("sub") * 86_400_000).toISOString() };
}

const dateWords = (date: string) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(Date.parse(date));

interface Sub {
  id: string;
  company_id: string;
  name: string;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
}
interface Company {
  id: string;
  name: string;
  email: string | null;
  settings: unknown;
}

export interface SendOutcome {
  sent: boolean;
  reason: string | null;
}

/** Email and/or text a sub their link, from the company. Says what didn't go, and why. */
async function sendToSub(env: Env, baseUrl: string, company: Company, sub: Sub, message: { subject: string; text: string; sms: string }, channels: ReadonlyArray<"email" | "sms">) {
  const out: { email: SendOutcome | null; sms: SendOutcome | null } = { email: null, sms: null };
  if (channels.includes("email")) {
    if (!sub.email) out.email = { sent: false, reason: "Add an email address for this sub first." };
    else {
      const result = await sendEmail(
        env,
        { to: sub.email, subject: message.subject, ...renderEmail({ companyName: company.name, logo: logoImage(baseUrl, company.id, company.settings), text: message.text }), replyTo: company.email ?? undefined, fromName: company.name },
        company.id,
      );
      out.email = { sent: result.sent, reason: result.sent ? null : result.reason ?? "The email didn't go out." };
    }
  }
  if (channels.includes("sms")) {
    if (!sub.phone) out.sms = { sent: false, reason: "Add a phone number for this sub first." };
    else if (!smsConfigured(env)) out.sms = { sent: false, reason: "Texting isn't set up. Copy the link and text it yourself." };
    else {
      const result = await sendSms(env, { to: sub.phone, body: message.sms });
      out.sms = { sent: result.sent, reason: result.sent ? null : result.reason ?? "The text didn't go out." };
    }
  }
  return out;
}

const SUB_FIELDS = "id, company_id, name, contact_name, email, phone";

/**
 * Office → Subs → Send a link: the sub's link to send in what's missing or running out, by email
 * and/or text. The link always comes back, to copy and send another way.
 */
export async function sendPaperworkLink(
  s: { db: Db; env: Env; companyId: string; baseUrl: string },
  subId: string,
  body: { channels: ReadonlyArray<"email" | "sms">; message?: string | null },
) {
  const sub = must(await s.db.from("subcontractors").select(`${SUB_FIELDS}, active`).eq("company_id", s.companyId).eq("id", subId).maybeSingle(), "Subcontractor not found.");
  if (!sub.active) throw new HttpError(400, "This sub is turned off. Turn them back on to send them a link.");
  const company = must(await s.db.from("companies").select("id, name, email, settings").eq("id", s.companyId).maybeSingle());
  const { link, expires_at } = await paperworkLink(s.env, s.baseUrl, s.companyId, subId);
  const { needed } = await subPaperwork(s.db, s.companyId, subId);
  const intro = body.message?.trim() || paperworkLinkIntro(needed);
  const message = paperworkLinkMessages({ companyName: company.name, subName: sub.name, contactName: sub.contact_name, intro, link });
  const sent = await sendToSub(s.env, s.baseUrl, company, sub, message, body.channels);
  return { link, expires_at, ...sent };
}

/** A row of public.emit_sub_document_alerts(). */
export interface SubAlert {
  company_id: string;
  subcontractor_id: string;
  document_id: string;
  kind: string;
  expires_on: string;
  days_left: number;
  alert: string;
  remind_sub: boolean;
}

/**
 * The hourly upkeep's reminders to subs whose certificate is running out (the office has already
 * been told, by public.emit_sub_document_alerts, which claimed each one). One message per sub, by
 * email and by text where there's a way to send it, with their link to send the new one.
 */
export async function remindSubs(env: Env, admin: Db, alerts: readonly SubAlert[]) {
  const counts = { subs: 0, email: 0, sms: 0, failed: 0 };
  const due = alerts.filter((a) => a.remind_sub);
  const baseUrl = (env.APP_URL ?? "").replace(/\/$/, "");
  if (!due.length || !baseUrl) return counts;
  const subIds = [...new Set(due.map((a) => a.subcontractor_id))];
  const [subs, companies] = await Promise.all([
    admin.from("subcontractors").select(SUB_FIELDS).in("id", subIds),
    admin.from("companies").select("id, name, email, settings").in("id", [...new Set(due.map((a) => a.company_id))]),
  ]);
  if (subs.error || companies.error) throw new Error((subs.error ?? companies.error)!.message);
  for (const sub of subs.data ?? []) {
    const company = companies.data?.find((c) => c.id === sub.company_id);
    if (!company) continue;
    const items = due.filter((a) => a.subcontractor_id === sub.id && a.company_id === sub.company_id);
    counts.subs++;
    try {
      const { link } = await paperworkLink(env, baseUrl, company.id, sub.id);
      const lines = items.map((a) => `${subDocumentLabel(a.kind)} ${a.days_left < 0 ? "ended" : "ends"} ${dateWords(a.expires_on)}`);
      const ended = items.every((a) => a.days_left < 0);
      const intro = `${items.length === 1 ? `The ${subDocumentLabel(items[0]!.kind).toLowerCase()} we have on file for ${sub.name}` : `Some of the paperwork we have on file for ${sub.name}`} ${ended ? "has run out" : "is about to run out"}:`;
      const text = `Hi ${firstName(sub.contact_name || sub.name)},\n\n${intro}\n\n${lines.join("\n")}\n\nPlease send us ${items.length === 1 ? "the new one" : "the new ones"} here:\n\n${link}\n\nThanks,\n${company.name}`;
      const sms = `${company.name}: ${lines.join(", ")}. Please send us ${items.length === 1 ? "the new one" : "the new ones"}: ${link}`;
      const subject = items.length === 1 ? `Your ${subDocumentLabel(items[0]!.kind).toLowerCase()} on file with ${company.name} ${ended ? "has run out" : "is running out"}` : `Your paperwork on file with ${company.name}`;
      const channels = [...(sub.email ? (["email"] as const) : []), ...(sub.phone && smsConfigured(env) ? (["sms"] as const) : [])];
      // The database only asks for subs there's a way to reach; one that can't be is a miss to count.
      if (!channels.length) {
        counts.failed++;
        continue;
      }
      const sent = await sendToSub(env, baseUrl, company, sub, { subject, text, sms }, channels);
      if (sent.email?.sent) counts.email++;
      if (sent.sms?.sent) counts.sms++;
      if (sent.email?.sent === false || sent.sms?.sent === false) counts.failed++;
    } catch (err) {
      counts.failed++;
      reportError(err, { task: "followups", step: "remind_subs" });
    }
  }
  return counts;
}
