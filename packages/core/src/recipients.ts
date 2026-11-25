/**
 * Who a message to a client goes to. A client has one email and one phone, and other contacts (a
 * spouse, a property manager) each ticked to get emailed reminders and receipts (notify_email) or
 * text reminders (notify_sms). Everything that sends a client something about their work (visit
 * reminders, on-my-way texts, quotes and invoices and their follow-ups, receipts, the answer to a
 * change they asked for) asks clientRecipients, so the ticks mean the same everywhere. Marketing
 * (campaigns, review asks, referral asks) and anything about the client's saved card go to the
 * client alone and don't come here.
 *
 * Contacts are only included while the company has it on (companies.settings.contact_messages): a
 * company that had contacts before this existed keeps it off until an owner or admin says yes.
 */
import { isPlaceholderEmail } from "./email";

/** The most people one send goes to: the client, their contacts, and addresses typed in. */
export const MAX_RECIPIENTS = 10;

/**
 * companies.settings.contact_messages. `enabled`: contacts ticked to get reminders get them.
 * `pending`: the company had contacts before the ticks did anything, and nobody has decided yet, so
 * the office is asked once. A company with nothing saved is new: on, and nothing to ask.
 */
export interface ContactMessages {
  enabled: boolean;
  pending: boolean;
}

export function contactMessages(settings: Record<string, unknown> | null | undefined): ContactMessages {
  const saved = settings?.contact_messages as { enabled?: unknown; pending?: unknown } | null | undefined;
  if (!saved || typeof saved !== "object") return { enabled: true, pending: false };
  return { enabled: saved.enabled !== false, pending: saved.pending === true && saved.enabled === false };
}

/** An email address for comparing: trimmed, in lower case. Empty when there's none. */
export const emailMatchKey = (value: string | null | undefined) => (value ?? "").trim().toLowerCase();

/**
 * A phone number for comparing: its last 10 digits, so "(540) 555-0101", "1-540-555-0101" and
 * "+15405550101" are one number (phoneE164 spells all three the same too). The Twilio webhook
 * matches a text to who sent it this way, and public.sms_stops keeps numbers by it. Empty when it
 * isn't a phone number.
 *
 * A UK number kept as the office typed it, "07700 900123", has the same last 10 digits as
 * Twilio's +447700900123, as a Canadian one has as a US one. A country whose numbers have 9 digits
 * after the 0 doesn't: Australia's "0412 345 678" is 0412345678 here and 1412345678 from Twilio,
 * so its numbers match only when they're kept with their country code.
 */
export function phoneMatchKey(value: string | null | undefined): string {
  const digits = (value ?? "").replace(/\D/g, "");
  return digits.length < 7 ? "" : digits.slice(-10);
}

const looksLikeEmail = (value: string | null | undefined): value is string => Boolean(value && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.trim())) && !isPlaceholderEmail(value);

export interface RecipientClient {
  display_name: string;
  email: string | null;
  phone: string | null;
  /** They texted STOP from their own phone. */
  sms_opt_out_at?: string | null;
}

export interface RecipientContact {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  notify_email: boolean;
  notify_sms: boolean;
}

export interface Recipient {
  /** The email address or phone number, as it's kept. */
  to: string;
  name: string;
  /** Null for the client's own email or phone. */
  contact_id: string | null;
}

export interface RecipientOptions {
  /** The company sends to ticked contacts (contactMessages().enabled). */
  contactsOn: boolean;
  /** Numbers that texted STOP to this company (phoneMatchKey of each): none of them is texted. */
  stopped?: Iterable<string>;
}

/**
 * Who gets a message to the client by `channel`, the client first, each address or number once.
 *
 * Email: the client's address, and every contact ticked for emails that has one.
 * Text: the client's phone, and every contact ticked for texts that has one; never a number that
 * texted STOP. The client's own STOP (sms_opt_out_at) takes their phone off, and with it any contact
 * kept under that same number.
 */
export function clientRecipients(channel: "email" | "sms", client: RecipientClient, contacts: readonly RecipientContact[], options: RecipientOptions): Recipient[] {
  const list: Recipient[] = [];
  const seen = new Set<string>();
  const add = (key: string, recipient: Recipient) => {
    if (!key || seen.has(key)) return;
    seen.add(key);
    list.push(recipient);
  };
  const others = options.contactsOn ? contacts : [];
  if (channel === "email") {
    if (looksLikeEmail(client.email)) add(emailMatchKey(client.email), { to: client.email.trim(), name: client.display_name, contact_id: null });
    for (const c of others) {
      if (c.notify_email && looksLikeEmail(c.email)) add(emailMatchKey(c.email), { to: c.email.trim(), name: c.name, contact_id: c.id });
    }
    return list;
  }
  // Numbers nobody texts are marked as seen before anyone is added, so a contact can't bring one back.
  for (const key of options.stopped ?? []) seen.add(key);
  const own = phoneMatchKey(client.phone);
  if (client.sms_opt_out_at) seen.add(own);
  if (client.phone?.trim()) add(own, { to: client.phone.trim(), name: client.display_name, contact_id: null });
  for (const c of others) {
    if (c.notify_sms && c.phone?.trim()) add(phoneMatchKey(c.phone), { to: c.phone.trim(), name: c.name, contact_id: c.id });
  }
  return list;
}

/** One line in the Send dialog: someone the quote or invoice can go to, and whether they start ticked. */
export interface SendChoice extends Recipient {
  ticked: boolean;
  /** Why they can't be picked (their number's texts are off), if they can't. */
  blocked?: string;
}

/**
 * The people the Send dialog offers for a quote or invoice: the client and every contact with an
 * address or number, each once. Ticked to start with: whoever clientRecipients would send to.
 */
export function sendChoices(channel: "email" | "sms", client: RecipientClient, contacts: readonly RecipientContact[], options: RecipientOptions): SendChoice[] {
  const key = channel === "email" ? emailMatchKey : phoneMatchKey;
  const ticked = new Set(clientRecipients(channel, client, contacts, options).map((r) => key(r.to)));
  // Everyone reachable this way, whatever their ticks: the office can add them to this one send.
  const everyone = clientRecipients(channel, { ...client, sms_opt_out_at: null }, contacts.map((c) => ({ ...c, notify_email: true, notify_sms: true })), { contactsOn: true });
  const stopped = new Set(options.stopped ?? []);
  if (channel === "sms" && client.sms_opt_out_at) stopped.add(phoneMatchKey(client.phone));
  return everyone.map((r) => ({
    ...r,
    ticked: ticked.has(key(r.to)),
    ...(channel === "sms" && stopped.has(key(r.to)) ? { blocked: "Texts off" } : {}),
  }));
}

/**
 * The addresses or numbers a send names, tidied: trimmed, empty ones dropped, each once (compared
 * as clientRecipients compares them), in the order given. More than MAX_RECIPIENTS is the caller's
 * to refuse.
 */
export function uniqueAddresses(channel: "email" | "sms", addresses: readonly (string | null | undefined)[]): string[] {
  const key = channel === "email" ? emailMatchKey : (value: string) => phoneMatchKey(value) || value.trim();
  const seen = new Set<string>();
  const list: string[] = [];
  for (const raw of addresses) {
    const value = (raw ?? "").trim();
    if (!value || seen.has(key(value))) continue;
    seen.add(key(value));
    list.push(value);
  }
  return list;
}

/** "Ana Smith", "Ana Smith and Bo Lee", "Ana Smith, Bo Lee and 2 others": who a message went to, in a line. */
export function recipientNames(recipients: ReadonlyArray<{ to: string; name?: string | null }>): string {
  const names = recipients.map((r) => r.name?.trim() || r.to);
  if (names.length <= 2) return names.join(" and ");
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`;
  return `${names[0]}, ${names[1]} and ${names.length - 2} others`;
}
