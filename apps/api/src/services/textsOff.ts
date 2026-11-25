/**
 * Texts to someone who asked for them to stop: Crewtavo doesn't send them. Two records hold it:
 *
 * - clients.sms_opt_out_at, for a client's own phone, as it always was. It's what the office sees
 *   on the client ("Texts off"), and what review asks and automations go by.
 * - public.sms_stops, for any number stopped for the company: the client's own again, and a
 *   contact's or a stranger's, which have no client row to carry it. No text goes to a number in
 *   it, whoever it's kept under.
 *
 * A number gets there four ways (sms_stops.source): the person texted STOP ("keyword"), Twilio
 * refused a text because they had ("carrier": a STOP Crewtavo never saw), they texted words that
 * plainly ask to stop ("phrase", core asksToStopTexts), or someone in the office turned texts off
 * because the person asked by phone, email or in person ("office", setTexts below). Each change is
 * kept in sms_stop_changes with who or what made it.
 *
 * It comes off when the person texts START. The office can also turn texts back on by hand, only
 * if the person asked, and only for a stop Twilio doesn't have: after the keyword Twilio refuses the
 * number until they text START, so there's nothing for the office to turn on.
 *
 * A client's own stop is about their own phone. A text the office sends to another number (a
 * spouse's, a contact's, one typed in) isn't refused for it, unless that number is stopped itself.
 */
import { textsOff, textsOffReason, twilioHasStop, type StopHow } from "@crewtavo/core/marketing";
import { phoneMatchKey } from "@crewtavo/core/recipients";
import type { SendResult } from "../lib/notify";
import type { Db } from "../lib/supabase";

/** Twilio's error for a number that texted STOP. */
export const TWILIO_OPTED_OUT = 21610;

/** The last 10 digits, as the Twilio webhook matches a text to the clients it's from. */
export const phoneKey = (phone: string | null | undefined) => (phone ?? "").replace(/\D/g, "").slice(-10);

/**
 * The numbers worth comparing with phoneKey, for the database to find first: the ones whose last
 * four digits are the key's, however they're spaced ("07700 900 123" ends in 0 123). A regular
 * expression for PostgREST's match: .filter("phone", "match", lastDigits(key)).
 */
export const lastDigits = (key: string) => `${key.slice(-4).split("").join("[^0-9]*")}[^0-9]*$`;

/** The number texted is the client's own phone. */
export function isClientPhone(to: string | null | undefined, client: { phone?: string | null }) {
  const key = phoneKey(to);
  return key !== "" && key === phoneKey(client.phone);
}

/** A text to `to` isn't sent: it's the client's own phone, and their texts are off. */
export const textsOffTo = (client: { phone?: string | null; sms_opt_out_at?: string | null }, to: string | null | undefined) => textsOff(client) && isClientPhone(to, client);

/** The number is stopped for this company (public.sms_stops), so nothing is texted to it. */
export async function numberStopped(admin: Db, companyId: string, to: string | null | undefined): Promise<boolean> {
  const key = phoneMatchKey(to);
  if (!key) return false;
  const { data, error } = await admin.from("sms_stops").select("phone_key").eq("company_id", companyId).eq("phone_key", key).limit(1);
  if (error) throw new Error(`Couldn't read who texted STOP: ${error.message}`);
  return Boolean(data?.length);
}

/**
 * The client as the code that texts them reads them: with texts off when their phone is a stopped
 * number though the client isn't marked (it was a contact's or nobody's when it was stopped, or
 * their number was changed to it since). For the sends that go to the client's own phone and only
 * look at the client: review asks, and autopay's notices and invites.
 */
export async function withNumberStop<C extends { phone?: string | null; sms_opt_out_at?: string | null }>(admin: Db, companyId: string, client: C): Promise<C> {
  if (client.sms_opt_out_at || !client.phone) return client;
  return (await numberStopped(admin, companyId, client.phone)) ? { ...client, sms_opt_out_at: new Date().toISOString() } : client;
}

export type StopSource = "keyword" | "carrier" | "phrase" | "office";

/** How a number came to be stopped, or started again: by what, and for the office by whom. */
export interface StopDetails {
  source: StopSource;
  how?: StopHow | null;
  /** What they texted (a phrase), or the office's note. */
  note?: string | null;
  by?: string | null;
  byName?: string | null;
}

const detailColumns = (details: StopDetails) => ({
  source: details.source,
  how: details.how ?? null,
  note: details.note?.trim().slice(0, 500) || null,
  set_by: details.by ?? null,
  set_by_name: details.byName?.trim().slice(0, 200) || null,
});

/** Keeps the change (sms_stop_changes). The stop itself is already saved, so failing here only loses the record of it. */
async function noteChange(admin: Db, companyId: string, phone: string | null | undefined, on: boolean, details: StopDetails) {
  const { error } = await admin
    .from("sms_stop_changes")
    .insert({ company_id: companyId, phone_key: phoneMatchKey(phone), phone: (phone ?? "").trim().slice(0, 40), texts_on: on, ...detailColumns(details) });
  if (error) console.error(`Couldn't keep a record of texts turned ${on ? "back on" : "off"}: ${error.message}`);
}

/**
 * The number is stopped for the company: remembered, once, with how it came about (the person
 * texted STOP unless `details` says otherwise). True when that's news. A number the office or a
 * phrase had stopped that then texts STOP is Twilio's to refuse from then on, and is kept as that.
 */
export async function noteStop(admin: Db, companyId: string, phone: string | null | undefined, details: StopDetails = { source: "keyword" }): Promise<boolean> {
  const key = phoneMatchKey(phone);
  if (!key) return false;
  const { data, error } = await admin
    .from("sms_stops")
    .upsert({ company_id: companyId, phone_key: key, phone: (phone ?? "").trim().slice(0, 40), ...detailColumns(details) }, { onConflict: "company_id,phone_key", ignoreDuplicates: true })
    .select("phone_key");
  if (error) throw new Error(`Couldn't record a STOP: ${error.message}`);
  if (data?.length) {
    await noteChange(admin, companyId, phone, false, details);
    return true;
  }
  if (twilioHasStop(details.source)) {
    const { data: now } = await admin.from("sms_stops").update({ source: details.source }).eq("company_id", companyId).eq("phone_key", key).in("source", ["phrase", "office"]).select("phone_key");
    if (now?.length) await noteChange(admin, companyId, phone, false, details);
  }
  return false;
}

/** The number can be texted again: it texted START, or the office turned texts back on (`details`). True when it had been stopped. */
export async function clearStop(admin: Db, companyId: string, phone: string | null | undefined, details: StopDetails = { source: "keyword" }): Promise<boolean> {
  const key = phoneMatchKey(phone);
  if (!key) return false;
  const { data, error } = await admin.from("sms_stops").delete().eq("company_id", companyId).eq("phone_key", key).select("phone_key");
  if (error) throw new Error(`Couldn't clear a STOP: ${error.message}`);
  if (data?.length) await noteChange(admin, companyId, phone, true, details);
  return Boolean(data?.length);
}

/**
 * After a text to `to` that wasn't sent: Twilio said the number texted STOP. With the company, the
 * number is remembered (sms_stops); and when it's the client's own phone, they have texts off from now.
 */
export async function noteRefusedText(admin: Db, client: { id: string; phone?: string | null }, to: string, result: SendResult, companyId?: string | null) {
  if (result.sent || result.code !== TWILIO_OPTED_OUT) return;
  if (companyId) await noteStop(admin, companyId, to, { source: "carrier" }).catch((error) => console.error(error instanceof Error ? error.message : error));
  if (!isClientPhone(to, client)) return;
  await admin.from("clients").update({ sms_opt_out_at: new Date().toISOString() }).eq("id", client.id).is("sms_opt_out_at", null);
}

/** Why a text to a client whose texts are off isn't sent, when someone sends it by hand. */
export const textsOffRefusal = (name: string) => `${textsOffReason(name)} Send it by email instead.`;

/** Why a text to any other stopped number isn't sent, when someone sends it by hand. */
export const numberStoppedRefusal = (to: string) => `${to} asked not to be texted, so Crewtavo can't text it.`;

/**
 * A number someone typed on a public form: kept on the client as where it came from, when it's
 * the number on their record. On Crewtavo's own forms (a booking form, a referral page) it's typed
 * under the line that says the business may text it (core textDisclosure); a form on the
 * business's own website is its own to word. A form's word outranks "entered by the office"; an earlier form's is kept, as
 * the first time they agreed. Never stops the request it came with.
 */
export async function noteTextConsent(admin: Db, companyId: string, clientId: string, phone: string | null | undefined, source: "booking_form" | "referral_form" | "website_form"): Promise<void> {
  const key = phoneMatchKey(phone);
  if (!key) return;
  try {
    const { data: client, error } = await admin.from("clients").select("phone, sms_consent_source").eq("company_id", companyId).eq("id", clientId).maybeSingle();
    if (error) throw new Error(error.message);
    if (!client || phoneMatchKey(client.phone) !== key || (client.sms_consent_source && client.sms_consent_source !== "office")) return;
    const { error: noteError } = await admin.from("clients").update({ sms_consent_at: new Date().toISOString(), sms_consent_source: source }).eq("company_id", companyId).eq("id", clientId);
    if (noteError) throw new Error(noteError.message);
  } catch (error) {
    console.error(`Couldn't note where a client's number came from: ${error instanceof Error ? error.message : error}`);
  }
}

// ---------------------------------------------------------------------------------------------
// The office's switch
// ---------------------------------------------------------------------------------------------

/** Why the office's switch can't do what was asked, in words for whoever flipped it. */
export class TextsRefusal extends Error {}

/** Why the office can't turn texts back on for a number that texted STOP. */
export const startOnly = (name: string, phone: string) =>
  `${name} texted STOP from ${phone}. Twilio, which sends your texts, refuses that number until they text START to your texting number, so it can't be turned back on from here.`;

/** The clients of the company whose own phone is this number (compared as phoneMatchKey compares). */
async function clientsWithPhone(admin: Db, companyId: string, key: string): Promise<Array<{ id: string; sms_opt_out_at: string | null }>> {
  const { data, error } = await admin.from("clients").select("id, phone, sms_opt_out_at").eq("company_id", companyId).not("phone", "is", null).filter("phone", "match", lastDigits(key)).limit(200);
  if (error) throw new Error(`Couldn't read whose number that is: ${error.message}`);
  return (data ?? []).filter((row) => phoneMatchKey(row.phone) === key);
}

/** "by phone", "in person": how they asked, as the note on the client's timeline says it. */
const HOW_WORDS: Record<StopHow, string> = { phone: "by phone", email: "by email", in_person: "in person", text: "by text", other: "" };

/** A note on the client's timeline, where the office reads what happened: who turned texts off or on, for which number, and how they were asked. */
async function noteOnTimeline(admin: Db, input: SetTexts, name: string, phone: string) {
  const who = input.byName?.trim() || "Someone in the office";
  const how = HOW_WORDS[input.how ?? "other"];
  const extra = input.note?.trim() ? ` Note: ${input.note.trim()}` : "";
  const body = input.on
    ? `${who} turned texts back on for ${name} (${phone}), because they asked.${extra}`
    : `${who} turned texts off for ${name} (${phone}): they asked${how ? ` ${how}` : ""} not to be texted.${extra}`;
  const { error } = await admin.from("messages").insert({ company_id: input.companyId, client_id: input.clientId, channel: "note", direction: "internal", sent_by: input.by, body });
  if (error) console.error(`Couldn't note a change to texts on the client's timeline: ${error.message}`);
}

export interface SetTexts {
  companyId: string;
  clientId: string;
  /** One of the client's contacts, when it's their number and not the client's own. */
  contactId?: string | null;
  on: boolean;
  how?: StopHow | null;
  note?: string | null;
  /** Who in the office is setting it. */
  by: string;
  byName: string | null;
}

/**
 * The office's "Texts" switch for a client or one of their contacts: off because the person asked
 * (by phone, email, in person, or in a text that wasn't the keyword), or back on because they asked
 * for that. It's about the number, so every client record whose own phone it is follows, and so
 * does a contact kept under it. Recorded with who set it and how they were asked (sms_stops,
 * sms_stop_changes), and noted on the client's timeline.
 *
 * Turning texts back on is refused (TextsRefusal) for a number that texted STOP: Twilio has that
 * too and won't deliver until they text START.
 */
export async function setTexts(admin: Db, input: SetTexts): Promise<{ on: boolean; phone: string }> {
  const { companyId } = input;
  const { data: client, error } = await admin.from("clients").select("id, display_name, phone, sms_opt_out_at").eq("company_id", companyId).eq("id", input.clientId).maybeSingle();
  if (error) throw new Error(`Couldn't read the client: ${error.message}`);
  if (!client) throw new TextsRefusal("That client isn't here anymore.");
  let name = client.display_name;
  let phone = client.phone;
  if (input.contactId) {
    const { data: contact, error: contactError } = await admin.from("client_contacts").select("id, name, phone").eq("company_id", companyId).eq("client_id", client.id).eq("id", input.contactId).maybeSingle();
    if (contactError) throw new Error(`Couldn't read the contact: ${contactError.message}`);
    if (!contact) throw new TextsRefusal("That contact isn't here anymore.");
    name = contact.name;
    phone = contact.phone;
  }
  const key = phoneMatchKey(phone);
  if (!key || !phone) throw new TextsRefusal(`${name} has no phone number.`);
  const details: StopDetails = { source: "office", how: input.on ? null : (input.how ?? "other"), note: input.note, by: input.by, byName: input.byName };
  const own = await clientsWithPhone(admin, companyId, key);

  if (!input.on) {
    await noteStop(admin, companyId, phone, details);
    const unmarked = own.filter((row) => !row.sms_opt_out_at).map((row) => row.id);
    if (unmarked.length) {
      const { error: markError } = await admin.from("clients").update({ sms_opt_out_at: new Date().toISOString() }).eq("company_id", companyId).in("id", unmarked).is("sms_opt_out_at", null);
      if (markError) throw new Error(`Couldn't turn texts off: ${markError.message}`);
    }
    await noteOnTimeline(admin, input, name, phone);
    return { on: false, phone };
  }

  const { data: stop, error: stopError } = await admin.from("sms_stops").select("source").eq("company_id", companyId).eq("phone_key", key).maybeSingle();
  if (stopError) throw new Error(`Couldn't read the stop list: ${stopError.message}`);
  if (stop && twilioHasStop(stop.source)) throw new TextsRefusal(startOnly(name, phone));
  const cleared = await clearStop(admin, companyId, phone, details);
  const marked = own.filter((row) => row.sms_opt_out_at).map((row) => row.id);
  if (marked.length) {
    const { error: markError } = await admin.from("clients").update({ sms_opt_out_at: null }).eq("company_id", companyId).in("id", marked);
    if (markError) throw new Error(`Couldn't turn texts back on: ${markError.message}`);
    // Texts off on the client alone (a number changed since, or a merge brought it): still a change to keep.
    if (!cleared) await noteChange(admin, companyId, phone, true, details);
  }
  if (cleared || marked.length) await noteOnTimeline(admin, input, name, phone);
  return { on: true, phone };
}
