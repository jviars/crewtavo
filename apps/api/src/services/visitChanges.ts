/**
 * Clients' requests to move or cancel a visit (Client Hub → Reschedule or Cancel), as the office
 * answers them. Approving moves the visit to the time asked for, or cancels it, through updateVisit
 * like any change on the schedule; declining leaves it be. Either way the client is emailed, when the
 * business can send email and they have an address.
 *
 * A recurring job's visit moves or is cancelled alone: it keeps the date it was made for
 * (recurrence_key), so the recurrence task never makes that date again, as with one deleted.
 *
 * The schedule screen (routes/schedule.ts) and AI assistants (assistant-tools/schedule.ts) both come
 * here as the person asking, so the database decides who may: whoever may move the visit.
 */
import { arrivalWindowMin, localTime, slotLabel, zonedTimeToUtc } from "@crewtavo/core";
import { isPlaceholderEmail } from "@crewtavo/core/email";
import type { Env } from "../env";
import { companyFooter, firstName, isEmail, renderEmail } from "../lib/email";
import { dbError, HttpError, must } from "../lib/http";
import { emailReady, sendEmail } from "../lib/notify";
import { adminClient } from "../lib/supabase";
import { logoImage } from "./logo";
import { companyZone, updateVisit, type Scope } from "./schedule";

const FIELDS =
  "id, kind, starts_at, ends_at, scheduled_on, message, reason, created_at, visit:visits(id, title, status, scheduled_on, starts_at, ends_at, crew_id), client:clients(id, display_name)";

type Visit = { id: string; title: string; status: string; scheduled_on: string | null; starts_at: string | null; ends_at: string | null };
const length = (v: { starts_at: string | null; ends_at: string | null }) => (v.starts_at && v.ends_at ? Date.parse(v.ends_at) - Date.parse(v.starts_at) : null);

/** The requests waiting for an answer that the person may answer, oldest first. */
export async function pendingVisitChanges(s: Scope) {
  return must(await s.db.from("visit_change_requests").select(FIELDS).eq("company_id", s.companyId).eq("status", "pending").order("created_at").limit(100));
}

export async function answerVisitChange(s: Scope, env: Env, id: string, answer: { approve: boolean; note?: string | null }, baseUrl: string | null) {
  const ask = must(
    await s.db.from("visit_change_requests").select(FIELDS).eq("company_id", s.companyId).eq("id", id).eq("status", "pending").maybeSingle(),
    "That request isn't waiting for an answer.",
  );
  const visit = ask.visit as unknown as Visit;
  if (answer.approve) {
    if (visit.status !== "scheduled") throw new HttpError(409, "This visit has started or changed since. Decline the request, or change the visit yourself.");
    if (ask.kind === "cancel") await updateVisit(s, visit.id, { status: "cancelled" });
    else if (ask.scheduled_on) {
      const { tz } = await companyZone(s);
      // At the time asked for; a whole day keeps the visit's own time, if it has one now. Either way
      // it keeps its own length.
      const start = ask.starts_at ? new Date(ask.starts_at) : visit.starts_at ? zonedTimeToUtc(ask.scheduled_on, localTime(new Date(visit.starts_at), tz), tz) : null;
      const ms = length(visit) ?? length(ask) ?? 3_600_000;
      await updateVisit(s, visit.id, start ? { starts_at: start.toISOString(), ends_at: new Date(start.getTime() + ms).toISOString() } : { scheduled_on: ask.scheduled_on });
    }
    // Without a time ("Tell us what suits you"), the office moves the visit itself: approving tells the client.
  }
  const status = answer.approve ? "approved" : "declined";
  const { data, error } = await s.db
    .from("visit_change_requests")
    .update({ status, note: answer.approve ? null : answer.note?.trim() || null })
    .eq("id", id)
    .eq("status", "pending")
    .select("id");
  if (error) throw dbError(error);
  if (!data.length) throw new HttpError(409, "Someone answered this request already.");
  const emailed = await tellClient(env, s, ask.id, answer.approve ? null : answer.note?.trim() || "", baseUrl);
  return { status, emailed };
}

/**
 * The client's email about the answer, from the business as its other emails go, kept on their
 * timeline. Skipped (false) when the business can't send email or the client has no address. `note`
 * is null for an approval.
 */
async function tellClient(env: Env, s: Scope, requestId: string, note: string | null, baseUrl: string | null): Promise<boolean> {
  const admin = adminClient(env);
  const [company, row] = await Promise.all([
    admin.from("companies").select("id, name, email, phone, timezone, settings, address").eq("id", s.companyId).maybeSingle(),
    admin.from("visit_change_requests").select("kind, visit:visits(id, title, scheduled_on, starts_at), client:clients(id, display_name, email)").eq("company_id", s.companyId).eq("id", requestId).maybeSingle(),
  ]);
  const co = company.data;
  const visit = row.data?.visit as unknown as Pick<Visit, "id" | "title" | "scheduled_on" | "starts_at"> | null;
  const client = row.data?.client as unknown as { id: string; display_name: string; email: string | null } | null;
  if (!co || !visit || !client || !isEmail(client.email) || isPlaceholderEmail(client.email) || !(await emailReady(env, s.companyId))) return false;
  // The visit as it is now: moved, for an approved reschedule.
  const when = visit.scheduled_on ? slotLabel({ date: visit.scheduled_on, starts_at: visit.starts_at }, co.timezone || "UTC", arrivalWindowMin(co.settings)) : "a day still to be set";
  const cancel = row.data!.kind === "cancel";
  const [subject, line] =
    note === null
      ? cancel
        ? [`Your visit on ${when} is cancelled`, `Your ${visit.title} visit on ${when} is cancelled, as you asked.`]
        : [`Your visit is now ${when}`, `Your ${visit.title} visit is now ${when}.`]
      : [`About your visit on ${when}`, `We can't ${cancel ? "cancel" : "move"} your ${visit.title} visit, so it stays on ${when}.${note ? `\n\n${note}` : ""}`];
  const text = [`Hi ${firstName(client.display_name)},`, line, `Questions? Reply to this email${co.phone ? ` or call ${co.phone}` : ""}.`, co.name].join("\n\n");
  const email = renderEmail({ companyName: co.name, logo: baseUrl ? logoImage(baseUrl, co.id, co.settings) : null, text, footer: companyFooter(co) });
  const result = await sendEmail(env, { to: client.email!.trim(), subject, text: email.text, html: email.html, replyTo: co.email ?? undefined, fromName: co.name }, co.id);
  if (!result.sent) return false;
  await admin.from("messages").insert({
    company_id: co.id, client_id: client.id, channel: "email", direction: "out", status: "sent", subject, body: text,
    related_type: "visit", related_id: visit.id, external_id: result.id ?? null, sent_by: s.userId ?? null,
  });
  return true;
}
