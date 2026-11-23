/**
 * Online booking: the times a booking form offers, and a client booking one (Settings → Online
 * booking, "Let clients pick a time"). The openings come from core's slot engine (bookingOpenings),
 * around the busy times of whoever the form books, read from the database as times only
 * (public.booking_busy_times). A booking is made by public.book_form_time, which checks the
 * opening again and makes the request and its visit together, one at a time for the company's day.
 *
 * A client always hears about a time they picked themselves, whatever the company's automation
 * rules say: on the page, by email, and by text when the company can text and they gave a number.
 * The "visit booked" rule's own message is then called off, so they aren't told twice.
 */
import { SALES } from "@crewtavo/core/roles";
import { BOOKING_WEEK_DAYS, bookingDays, bookingLength, bookingOpenings, slotLabel, timeZoneLabel, type OpenSlot } from "@crewtavo/core/slots";
import { addDays, arrivalWindowMin, localDate, zonedTimeToUtc } from "@crewtavo/core/time";
import type { Env } from "../env";
import { companyFooter, firstName, renderEmail } from "../lib/email";
import { buildCalendar } from "../lib/ics";
import { clientLink, KEPT_LINK } from "../lib/links";
import { asJson, dbError, HttpError, must } from "../lib/http";
import { emailReady, sendEmail, sendSms, smsReady } from "../lib/notify";
import { adminClient, type Db } from "../lib/supabase";
import { logoImage } from "./logo";
import { recipientsColumn, recipientsFor, sendToEach } from "./recipients";
import { createVisits, type Scope } from "./schedule";
import { textWithStopLine } from "./stopLine";
import { noteRefusedText } from "./textsOff";

/** What a booking form's openings are read from (intake_forms). */
export const BOOKING_FORM_FIELDS = "id, name, kind, lead_time_days, slot_minutes, max_per_day, requires_approval, pick_time, crew_id";

export interface BookingForm {
  id: string;
  name: string;
  kind: string;
  lead_time_days: number | null;
  slot_minutes: number | null;
  max_per_day: number | null;
  requires_approval: boolean;
  pick_time: boolean;
  crew_id: string | null;
}

export interface BookingCompany {
  id: string;
  name: string;
  phone: string | null;
  timezone: string | null;
  settings: unknown;
}

const TAKEN = "That time was just taken. Please pick another.";

/** A booking the form's rules turned away: the page shows the words and fresh openings. */
export class BookingRefused extends HttpError {
  constructor(message: string) {
    super(409, message);
  }
}

/** The visit a form books, as the office's "Schedule assessment" names one; a "Book a service" form's is the form's own name. */
export const bookedVisitTitle = (form: Pick<BookingForm, "kind" | "name">, requestTitle = form.name) =>
  (form.kind === "booking" ? requestTitle : `Assessment: ${requestTitle}`).slice(0, 200);

/** When whoever the form books is busy between two days, and how many of the form's bookings each of those days has. */
async function formSchedule(admin: Db, company: BookingCompany, form: BookingForm, from: string, to: string) {
  const tz = company.timezone || "UTC";
  const [busy, counts] = await Promise.all([
    admin.rpc("booking_busy_times", {
      p_company: company.id, p_crew: form.crew_id as string, p_from: zonedTimeToUtc(from, "00:00", tz).toISOString(), p_to: zonedTimeToUtc(addDays(to, 1), "00:00", tz).toISOString(),
    }),
    form.max_per_day ? admin.rpc("booking_day_counts", { p_company: company.id, p_form: form.id, p_from: from, p_to: to }) : { data: [], error: null },
  ]);
  if (busy.error) throw dbError(busy.error);
  if (counts.error) throw dbError(counts.error);
  return {
    busy: (busy.data ?? []).map((b) => ({ start: Date.parse(b.starts_at), end: Date.parse(b.ends_at) })),
    booked: Object.fromEntries((counts.data ?? []).map((d) => [d.day, d.booked])) as Record<string, number>,
  };
}

/**
 * The times a form offers on up to a week of days from `from` (the form's first day when it's not
 * given or earlier). Times only: nothing here says who or what fills the rest.
 */
export async function formOpenings(admin: Db, company: BookingCompany, form: BookingForm, look: { from?: string; days?: number; now?: Date } = {}) {
  const now = look.now ?? new Date();
  const tz = company.timezone || "UTC";
  const { first, last } = bookingDays(now, tz, form);
  const from = look.from && look.from > first ? look.from : first;
  const days = Math.min(look.days ?? BOOKING_WEEK_DAYS, BOOKING_WEEK_DAYS);
  const to = addDays(from, days - 1) > last ? last : addDays(from, days - 1);
  if (from > last) return { from, to: last, first, last, slots: [] as OpenSlot[] };
  const { busy, booked } = await formSchedule(admin, company, form, from, to);
  return { from, to, first, last, slots: bookingOpenings({ now, timeZone: tz, settings: company.settings, form, busy, booked, from, days }) };
}

/** The first week from the form's first day that has an opening (the last week looked at when none does). */
export async function firstOpenWeek(admin: Db, company: BookingCompany, form: BookingForm, now = new Date()) {
  let week = await formOpenings(admin, company, form, { now });
  while (!week.slots.length && week.to < week.last) week = await formOpenings(admin, company, form, { now, from: addDays(week.to, 1) });
  return week;
}

/** The next few times a client would be offered, for the office to check a form's settings against. */
export async function nextOpenings(admin: Db, company: BookingCompany, form: BookingForm, count = 6, now = new Date()): Promise<OpenSlot[]> {
  const tz = company.timezone || "UTC";
  const { first, last } = bookingDays(now, tz, form);
  // The whole horizon's busy times at once: this is the office's own check, not a visitor's.
  const { busy, booked } = await formSchedule(admin, company, form, first, last);
  const found: OpenSlot[] = [];
  for (let from = first; from <= last && found.length < count; from = addDays(from, BOOKING_WEEK_DAYS)) {
    found.push(...bookingOpenings({ now, timeZone: tz, settings: company.settings, form, busy, booked, from }));
  }
  return found.slice(0, count);
}

/** What the booking page needs to offer times: the business's zone, how long a visit is and how far ahead it books. */
export function bookingView(company: BookingCompany, form: BookingForm, zips: readonly string[], now = new Date()) {
  const tz = company.timezone || "UTC";
  return {
    timezone: tz,
    timezone_label: timeZoneLabel(tz, now),
    minutes: bookingLength(form),
    window_min: arrivalWindowMin(company.settings),
    needs_ok: form.requires_approval,
    // With a service area, times are shown once the postal code is in it.
    needs_postal_code: zips.length > 0,
    ...bookingDays(now, tz, form),
  };
}

export interface BookingMade {
  client_id: string;
  property_id: string | null;
  matched: boolean;
  new_property: boolean;
  request_id: string;
  number: number;
  visit_id: string | null;
  starts_at: string;
  ends_at: string;
  booked: boolean;
}

/**
 * Books the time a client picked on a form: the request with the time asked for, and with a form
 * that books at once, its visit. The time has to be one the form offers now; the database checks
 * again what two people sending at once could both have seen (public.book_form_time).
 */
export async function bookFormTime(
  admin: Db,
  company: BookingCompany,
  form: BookingForm,
  booking: { name: string; email?: string; phone?: string; address: unknown; answers: unknown; starts_at: string; promo: string | null; web_visit: unknown },
  now = new Date(),
): Promise<BookingMade> {
  const tz = company.timezone || "UTC";
  const start = new Date(booking.starts_at);
  const day = await formOpenings(admin, company, form, { now, from: localDate(start, tz), days: 1 });
  if (!day.slots.some((s) => Date.parse(s.starts_at!) === start.getTime())) throw new BookingRefused(TAKEN);
  const { data, error } = await admin.rpc("book_form_time", {
    p_company: company.id, p_form: form.id, p_name: booking.name, // Null, not left out, when one wasn't typed: the database is asked for the function by the names it's sent.
    p_email: (booking.email ?? null) as string, p_phone: (booking.phone ?? null) as string,
    p_address: asJson(booking.address), p_answers: asJson(booking.answers), p_starts_at: start.toISOString(),
    p_promo: booking.promo ?? undefined, p_web_visit: booking.web_visit ? asJson(booking.web_visit) : undefined,
  });
  if (error) {
    if (error.code === "CBTKN" || error.code === "CBFUL") throw new BookingRefused(TAKEN);
    if (error.code === "CBONE") {
      // Without the time: whoever typed this email or phone may not be the person who booked.
      throw new BookingRefused(`There's already a booking with this email or phone. To change it, ${company.phone ? `call us at ${company.phone}` : "get in touch with us"}.`);
    }
    throw dbError(error);
  }
  return data as unknown as BookingMade;
}

/** How a client's own booking was confirmed to them. */
export interface Confirmation {
  emailed: boolean;
  texted: boolean;
}

/**
 * Tells the client about the time they picked: booked, or asked for and waiting on the office.
 * By email to the client and their contacts ticked for emails, and by text when the company can
 * text and `text` says they gave a number (services/recipients.ts decides who; a number that texted
 * STOP is never texted). What went is kept on their timeline. Never throws: the booking stands
 * whether or not a message could go.
 */
export async function confirmBooking(
  env: Env,
  admin: Db,
  booking: { companyId: string; clientId: string; requestId: string; visitId: string | null; title: string; startsAt: string; booked: boolean; text: boolean; sentBy?: string | null },
  baseUrl: string | null,
): Promise<Confirmation> {
  const result: Confirmation = { emailed: false, texted: false };
  try {
    const [company, found] = await Promise.all([
      admin.from("companies").select("id, name, email, phone, timezone, settings, address").eq("id", booking.companyId).maybeSingle(),
      admin.from("clients").select("id, display_name, email, phone, sms_opt_out_at").eq("company_id", booking.companyId).eq("id", booking.clientId).maybeSingle(),
    ]);
    const co = company.data;
    const client = found.data;
    if (!co || !client) return result;
    const tz = co.timezone || "UTC";
    const when = slotLabel({ date: localDate(new Date(booking.startsAt), tz), starts_at: booking.startsAt }, tz, arrivalWindowMin(co.settings));
    const about = booking.visitId ? { related_type: "visit", related_id: booking.visitId } : { related_type: "request", related_id: booking.requestId };
    const [subject, line] = booking.booked
      ? [`You're booked for ${when}`, `You're booked: ${booking.title} on ${when}.`]
      : [`We got your request for ${when}`, `We got your request for ${booking.title} on ${when}. This time isn't confirmed yet: we'll let you know as soon as it is.`];
    const call = co.phone ? ` or call ${co.phone}` : "";

    if (await emailReady(env, co.id)) {
      const people = await recipientsFor(admin, co.id, client, "email", co.settings);
      if (people.length) {
        // The client's own page, where a booked visit can be moved or cancelled. Only ever sent to
        // the addresses on their record, never shown to whoever filled in the form.
        const hub = baseUrl && booking.booked ? await clientLink(env, baseUrl, { c: co.id, t: "client", id: client.id }) : null;
        // The same words with their link to send, and none in the copy kept on their timeline (lib/links KEPT_LINK).
        const words = (link: string | null) =>
          [
            `Hi ${firstName(client.display_name)},`,
            line,
            ...(link ? [`Need to change it? You can ask to move or cancel it here:\n${link}`] : []),
            `Questions? Reply to this email${call}.`,
            co.name,
          ].join("\n\n");
        const text = words(hub);
        const email = renderEmail({ companyName: co.name, logo: baseUrl ? logoImage(baseUrl, co.id, co.settings) : null, text, footer: companyFooter(co) });
        const delivery = await sendToEach(people, (person) => sendEmail(env, { to: person.to, subject, text: email.text, html: email.html, replyTo: co.email ?? undefined, fromName: co.name }, co.id));
        if (delivery.went.length) {
          result.emailed = true;
          await admin.from("messages").insert({
            company_id: co.id, client_id: client.id, channel: "email", direction: "out", status: "sent", subject, body: words(hub && KEPT_LINK),
            ...about, external_id: delivery.id, sent_by: booking.sentBy ?? null, recipients: recipientsColumn(delivery),
          });
        }
      }
    }
    if (booking.text && (await smsReady(env, co.id))) {
      const people = await recipientsFor(admin, co.id, client, "sms", co.settings);
      if (people.length) {
        const body = `${co.name}: ${line}${co.phone ? ` Questions? Call ${co.phone}.` : ""}`;
        const delivery = await sendToEach(people, async (person) => {
          const sent = await textWithStopLine(admin, co.id, person.to, body, (text) => sendSms(env, { to: person.to, body: text }, co.id));
          await noteRefusedText(admin, client, person.to, sent, co.id);
          return sent;
        });
        if (delivery.went.length) {
          result.texted = true;
          await admin.from("messages").insert({
            company_id: co.id, client_id: client.id, channel: "sms", direction: "out", status: "sent", body,
            ...about, external_id: delivery.id, sent_by: booking.sentBy ?? null, recipients: recipientsColumn(delivery),
          });
        }
      }
    }
  } catch (error) {
    console.error("A booking's confirmation didn't go out", error);
  }
  return result;
}

/** The "visit booked" rule's message about this visit doesn't go: the client was told here. */
export async function callOffBookedNotice(admin: Db, visitId: string) {
  const { error } = await admin.rpc("call_off_visit_notice", { p_visit: visitId });
  if (error) console.error("A booked visit's own notice couldn't be called off", error);
}

/** An add-to-calendar file for a time booked online. */
export function bookingCalendar(company: { name: string }, visit: { id: string; title: string; starts_at: string; ends_at: string }, address: { line1: string; city?: string } | null) {
  return buildCalendar(company.name, [
    {
      uid: `${visit.id}@crewtavo`,
      title: `${company.name}: ${visit.title}`,
      start: new Date(visit.starts_at),
      end: new Date(visit.ends_at),
      location: address ? [address.line1, address.city].filter(Boolean).join(", ") : null,
    },
  ]);
}

/**
 * The office books a request at the time its client asked for online, with one press: the same
 * assessment "Schedule assessment" makes, at a fixed time, for the form's crew, as the person (the
 * database decides whether they may). The client is told it's confirmed. A time taken since asks
 * first (`taken`), and books anyway with `force`.
 */
export async function bookAskedTime(s: Scope, env: Env, requestId: string, force: boolean, baseUrl: string | null) {
  if (!SALES.includes(s.role)) throw new HttpError(403, "Your role can't schedule assessments.");
  const request = must(
    await s.db
      .from("requests")
      .select("id, title, status, client_id, property_id, assigned_to, asked_starts_at, asked_ends_at, form:intake_forms(kind, name, crew_id), visits(id, kind, status)")
      .eq("company_id", s.companyId)
      .eq("id", requestId)
      .maybeSingle(),
    "Request not found.",
  );
  const form = request.form as unknown as { kind: string; name: string; crew_id: string | null } | null;
  if (!request.asked_starts_at || !request.asked_ends_at) throw new HttpError(400, "This request didn't ask for a time.");
  if (request.status !== "new" || (request.visits as Array<{ kind: string; status: string }>).some((v) => v.kind === "assessment" && v.status !== "cancelled")) {
    throw new HttpError(409, "This request has been scheduled or closed since. Refresh the page.");
  }
  if (Date.parse(request.asked_starts_at) <= Date.now()) throw new HttpError(409, "The time they asked for has passed. Schedule the assessment for another time.");
  const admin = adminClient(env);
  if (!force) {
    const { data, error } = await admin.rpc("booking_busy_times", {
      p_company: s.companyId, p_crew: form?.crew_id as string, p_from: request.asked_starts_at, p_to: request.asked_ends_at, p_except_request: request.id,
    });
    if (error) throw dbError(error);
    const from = Date.parse(request.asked_starts_at);
    const to = Date.parse(request.asked_ends_at);
    if ((data ?? []).some((b) => Date.parse(b.starts_at) < to && Date.parse(b.ends_at) > from)) return { booked: false as const, taken: true as const };
  }
  const title = bookedVisitTitle(form ?? { kind: "assessment", name: request.title }, request.title);
  const made = await createVisits(s, {
    title, kind: "assessment", request_id: request.id, property_id: request.property_id, crew_id: form?.crew_id ?? null, status: "scheduled",
    starts_at: request.asked_starts_at, ends_at: request.asked_ends_at, time_fixed: true, days: 1, skip_weekends: false,
    // With no crew to send, the request's salesperson goes out.
    assignee_ids: !form?.crew_id && request.assigned_to ? [request.assigned_to] : [], equipment_ids: [],
  });
  const visitId = made.ids[0]!;
  const moved = await s.db.from("requests").update({ status: "assessment_scheduled" }).eq("id", request.id).eq("status", "new");
  if (moved.error) throw dbError(moved.error);
  const told = await confirmBooking(env, admin, { companyId: s.companyId, clientId: request.client_id, requestId: request.id, visitId, title, startsAt: request.asked_starts_at, booked: true, text: true, sentBy: s.userId ?? null }, baseUrl);
  await callOffBookedNotice(admin, visitId);
  return { booked: true as const, visit_id: visitId, ...told };
}

/**
 * When the people on a visit are busy between two times, for a client moving it from their Hub:
 * its crew's and people's other visits and busy calendar times (public.visit_busy_times). A visit
 * booked online with no crew and nobody on it was booked against the company's whole schedule, so
 * it moves against the whole schedule too (public.booking_busy_times with no crew).
 */
export async function visitBusyTimes(admin: Db, companyId: string, visitId: string, from: string, to: string): Promise<Array<{ starts_at: string; ends_at: string }>> {
  const found = await admin.from("visits").select("crew_id, request:requests(asked_starts_at), assignees:visit_assignees(user_id)").eq("company_id", companyId).eq("id", visitId).maybeSingle();
  if (found.error) throw dbError(found.error);
  const visit = found.data as unknown as { crew_id: string | null; request: { asked_starts_at: string | null } | null; assignees: unknown[] | null } | null;
  const wholeCompany = Boolean(visit && !visit.crew_id && !visit.assignees?.length && visit.request?.asked_starts_at);
  const { data, error } = wholeCompany
    ? await admin.rpc("booking_busy_times", { p_company: companyId, p_crew: null as unknown as string, p_from: from, p_to: to, p_except_visit: visitId })
    : await admin.rpc("visit_busy_times", { p_company: companyId, p_visit: visitId, p_from: from, p_to: to });
  if (error) throw dbError(error);
  return data ?? [];
}
