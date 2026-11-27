/**
 * Who a message to a client goes to, as the database has it now: the client's own email or phone,
 * and their contacts ticked to get emails or texts (core clientRecipients decides; this reads what
 * it needs). Automations, quote and invoice sends and their reminders, autopay receipts and the
 * answers to a client's change requests all ask here, so a contact's ticks mean the same wherever
 * a message starts. Marketing, review and referral asks and anything about the client's saved card
 * go to the client alone and don't ask.
 *
 * Read with the server's own client: a number that texted STOP must never be missed because the
 * person sending can't read the list.
 */
import { clientRecipients, contactMessages, phoneMatchKey, sendChoices, type Recipient, type RecipientClient, type RecipientContact, type SendChoice } from "@crewtavo/core/recipients";
import type { SendResult } from "../lib/notify";
import type { Db } from "../lib/supabase";

/** As many contacts as one client's message looks at; a send goes to MAX_RECIPIENTS of them at most. */
const CONTACT_LIMIT = 50;

export interface Reach {
  contacts: RecipientContact[];
  /** The company sends to ticked contacts (companies.settings.contact_messages). */
  contactsOn: boolean;
  /** Of the client's and contacts' numbers, the ones that texted STOP to this company (phoneMatchKey). */
  stopped: string[];
}

/** The numbers among `phones` that texted STOP to the company, as phoneMatchKey spells them. */
export async function stoppedNumbers(admin: Db, companyId: string, phones: ReadonlyArray<string | null | undefined>): Promise<string[]> {
  const keys = [...new Set(phones.map(phoneMatchKey).filter(Boolean))];
  if (!keys.length) return [];
  const { data, error } = await admin.from("sms_stops").select("phone_key").eq("company_id", companyId).in("phone_key", keys);
  if (error) throw new Error(`Couldn't read who texted STOP: ${error.message}`);
  return (data ?? []).map((row) => row.phone_key);
}

/** How many clients addedByAssistant asks about at once. */
const ADDED_BATCH = 200;

/**
 * Of a client's addresses, the ones an AI assistant put on file and nobody else has changed since
 * (contact_from_assistant, 20261123100900_addresses_an_assistant_added.sql): the client's own, and
 * their contacts' by id. An assistant's own sends (a quote, an invoice, a campaign) leave these out,
 * so text it read can't have it add an address and send there what it read.
 */
export async function addedByAssistant(admin: Db, companyId: string, clientIds: readonly string[]): Promise<{ clients: Set<string>; contacts: Set<string> }> {
  const found = { clients: new Set<string>(), contacts: new Set<string>() };
  // A campaign's audience is thousands of clients: asked about a few hundred at a time, so the
  // request's address stays short.
  for (let i = 0; i < clientIds.length; i += ADDED_BATCH) {
    const batch = clientIds.slice(i, i + ADDED_BATCH);
    const [clients, contacts] = await Promise.all([
      admin.from("clients").select("id").eq("company_id", companyId).in("id", batch).eq("contact_from_assistant", true),
      admin.from("client_contacts").select("id").eq("company_id", companyId).in("client_id", batch).eq("contact_from_assistant", true),
    ]);
    if (clients.error || contacts.error) throw new Error(`Couldn't read which addresses an assistant added: ${(clients.error ?? contacts.error)!.message}`);
    for (const c of clients.data ?? []) found.clients.add(c.id);
    for (const c of contacts.data ?? []) found.contacts.add(c.id);
  }
  return found;
}


/** An assistant asked to send to an address it put on file itself (addedByAssistant). */
export const addedByAssistantRefusal = (to: string | null) =>
  `${to ? `${to} was` : "This client's email and phone were"} put on file by an AI assistant, so an assistant doesn't send to ${to ? "it" : "them"}. Send this from Crewtavo instead.`;

/**
 * What clientRecipients needs beyond the client: their contacts, whether the company sends to
 * them, and which of their numbers texted STOP. `settings` is the company's, when the caller has
 * it already.
 */
export async function clientReach(admin: Db, companyId: string, client: { id: string; phone: string | null }, settings?: unknown): Promise<Reach> {
  const [company, rows] = await Promise.all([
    settings === undefined ? admin.from("companies").select("settings").eq("id", companyId).maybeSingle() : null,
    admin.from("client_contacts").select("id, name, email, phone, notify_email, notify_sms").eq("company_id", companyId).eq("client_id", client.id).order("is_primary", { ascending: false }).order("name").limit(CONTACT_LIMIT),
  ]);
  if (company?.error) throw new Error(`Couldn't read the company's settings: ${company.error.message}`);
  if (rows.error) throw new Error(`Couldn't read the client's contacts: ${rows.error.message}`);
  const contacts = rows.data ?? [];
  const stopped = await stoppedNumbers(admin, companyId, [client.phone, ...contacts.map((c) => c.phone)]);
  return { contacts, contactsOn: contactMessages((settings ?? company?.data?.settings) as Record<string, unknown> | null).enabled, stopped };
}

/** Who a message to the client goes to by `channel` now (core clientRecipients). */
export async function recipientsFor(admin: Db, companyId: string, client: RecipientClient & { id: string }, channel: "email" | "sms", settings?: unknown): Promise<Recipient[]> {
  const reach = await clientReach(admin, companyId, client, settings);
  return clientRecipients(channel, client, reach.contacts, reach);
}

/** The people the Send dialog offers for the client, by email and by text (core sendChoices). */
export async function sendChoicesFor(admin: Db, companyId: string, client: RecipientClient & { id: string }): Promise<{ email: SendChoice[]; sms: SendChoice[]; contacts_on: boolean }> {
  const reach = await clientReach(admin, companyId, client);
  return { email: sendChoices("email", client, reach.contacts, reach), sms: sendChoices("sms", client, reach.contacts, reach), contacts_on: reach.contactsOn };
}

/** How one send to several people went: who it reached, who it didn't and why. */
export interface Delivery {
  /** Each with the provider's id for its own text, when there is one. */
  went: Array<Recipient & { id?: string }>;
  failed: Array<Recipient & { reason: string; result: SendResult }>;
  /** The provider's id of the first one that went, kept on the message. */
  id: string | null;
}

/** Sends to each in turn. One that fails doesn't stop the rest. */
export async function sendToEach(recipients: readonly Recipient[], send: (recipient: Recipient) => Promise<SendResult>, fallback = "It wasn't sent."): Promise<Delivery> {
  const delivery: Delivery = { went: [], failed: [], id: null };
  for (const recipient of recipients) {
    const result = await send(recipient);
    if (result.sent) {
      delivery.went.push(result.id ? { ...recipient, id: result.id } : recipient);
      delivery.id ??= result.id ?? null;
    } else delivery.failed.push({ ...recipient, reason: result.reason ?? fallback, result });
  }
  return delivery;
}

/** messages.recipients for a send: who it went to, then who it didn't reach (marked failed). Null when it went to nobody. */
export function recipientsColumn(delivery: Pick<Delivery, "went" | "failed">, ids = false): Array<{ to: string; name: string; id?: string; failed?: true }> | null {
  // `ids` (texts): each one's id lets a report on one person's text mark that person (services/quo.ts).
  const all = [...delivery.went.map((r) => ({ to: r.to, name: r.name, ...(ids && r.id ? { id: r.id } : {}) })), ...delivery.failed.map((r) => ({ to: r.to, name: r.name, failed: true as const }))];
  return all.length ? all : null;
}

/** "ana@example.com and bo@example.com": the addresses or numbers, for an automation's result line. */
export function addressList(recipients: ReadonlyArray<{ to: string }>): string {
  const all = recipients.map((r) => r.to);
  return all.length <= 1 ? (all[0] ?? "") : `${all.slice(0, -1).join(", ")} and ${all[all.length - 1]}`;
}
