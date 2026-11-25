/**
 * Sending quotes and invoices to clients, starting a quote from a request, turning a quote into a
 * job, invoicing many jobs and payment reminders: the steps with side effects (email, texts, Stripe).
 * The sales routes (routes/sales.ts) and AI assistants' tools (assistant-tools/quotes.ts, invoices.ts)
 * both use these, with the person's own client. Also how a quote that offers options is priced before
 * the client chooses, and the most its deposit can be.
 */
import { laborRates, localDate, workLines, workToBill } from "@crewtavo/core";
import { hidesExactPrice, inRangeMode, optionsIntroText, rangeIntroText } from "@crewtavo/core/estimates";
import { optionBaseTotal, toCents, type Amount, type OptionLine, type TotalsPromo } from "@crewtavo/core/money";
import { clientRecipients, emailMatchKey, MAX_RECIPIENTS, phoneMatchKey, uniqueAddresses, type Recipient } from "@crewtavo/core/recipients";
import { z } from "zod";
import type { Env } from "../env";
import { stripeAccess, syncStripeInvoice } from "../integrations/stripe";
import { firstName, isEmail, renderEmail } from "../lib/email";
import { asJson, dbError, HttpError, must } from "../lib/http";
import { clientLinks, sentToClient } from "../lib/links";
import { NO_LINKS_FOR_ASSISTANTS } from "../lib/noAssistants";
import { sendEmail, sendSms } from "../lib/notify";
import { adminClient, type Db } from "../lib/supabase";
import { companyAddress } from "./automations";
import { loadOptions, manualApproval } from "./contracts";
import { logoImage } from "./logo";
import { addedByAssistant, addedByAssistantRefusal, clientReach, recipientsColumn, sendChoicesFor, sendToEach, stoppedNumbers } from "./recipients";
import { textWithStopLine } from "./stopLine";
import { noteRefusedText, numberStoppedRefusal, textsOffRefusal, textsOffTo } from "./textsOff";

/** Who's sending, from where: the person's client, their company, and the address client links use. */
export interface SalesScope {
  db: Db;
  env: Env;
  companyId: string;
  baseUrl: string;
  /** The person doesn't see invoices: the office copies they're handed leave out the client's money (lib/links `nm`). */
  noMoney?: boolean;
  /**
   * An AI assistant is sending (assistant-tools/quotes.ts, invoices.ts): only to the client's own
   * email or phone and their contacts' on file, and not those an assistant put on file itself
   * (sendTo), and never just for the link (lib/noAssistants.ts).
   */
  assistant?: boolean;
  /**
   * "Send me a copy": the sending person's own email on file (routes/sales.ts), never an address the
   * browser names. Empty when they asked for one and have no email on file.
   */
  copyTo?: string;
}

export const sendSchema = z.object({
  channel: z.enum(["email", "sms", "link"]).default("email"),
  // One address or number, as older callers give it. With neither this nor `recipients`, it goes to
  // the client's own and to their contacts ticked for emails or texts.
  to: z.string().trim().max(200).optional().describe("One email address or phone number to send it to instead of the client's."),
  // Every address or number to send it to (the client's, their contacts', any typed in), instead
  // of the default. Each is checked, and there are 10 at most.
  recipients: z
    .array(z.string().trim().max(200))
    .max(MAX_RECIPIENTS, `Send it to ${MAX_RECIPIENTS} people at most.`)
    .optional()
    .describe("Every email address (or phone number, for a text) to send it to, 10 at most. Leave out to send to the client and their contacts ticked for emails or texts."),
  subject: z.string().trim().max(200).optional(),
  message: z.string().max(4000).optional(),
  // An email copy to the person sending: the route reads their address (SalesScope.copyTo).
  copy: z.boolean().optional(),
});
export type SendBody = z.infer<typeof sendSchema>;

/**
 * What an AI assistant's send_quote and send_invoice take: email or text, to the client and their
 * contacts on file, in Crewtavo's usual words. No address and no words of its own, so text it reads
 * (a client's note, a website form) can't have it send a quote, or what it read elsewhere, to
 * anyone else; and no link only, since a link opens Crewtavo without anyone signing in.
 */
export const assistantSendSchema = z.object({
  channel: z.enum(["email", "sms"]).default("email"),
  recipients: z
    .array(z.string().trim().max(200))
    .max(MAX_RECIPIENTS, `Send it to ${MAX_RECIPIENTS} people at most.`)
    .optional()
    .describe("Who to send it to, 10 at most: the client's own email or phone, or their contacts' (get_client). Leave out to send to the client and their contacts ticked for emails or texts."),
});

/** An assistant asked to send to an address that isn't the client's or one of their contacts'. */
export const notOnFile = (to: string) =>
  `An AI assistant only sends quotes and invoices to the client and their contacts on file, and ${to} isn't one of them. Send it from Crewtavo instead.`;

type Deliverable = { id: string; number: number | null; client_id: string | null; total?: number; balance_due?: number; recurrence_rule?: string | null; client: { display_name: string; email: string | null; phone: string | null } | null };

export const TEMPLATE_NOT_SENT = "A quote template can't be sent. Make a quote from it first.";

/**
 * What a send says when the person didn't write their own message or subject: a roof estimate's
 * price range goes out with its own words (rangeMessage), not the quote's total.
 */
export interface DeliverDefaults {
  intro?: string;
  subject?: string;
  /** A sentence for an invoice's usual words, said after the amount and before the link (why it's the client's to pay, say). */
  note?: string;
}

/**
 * The words a price range goes out with when the person didn't write their own, in whole dollars
 * (core rangeIntroText, the same words the office's send dialog shows). With two or three options
 * (`optionCount`) the range runs across them.
 */
export function rangeMessage(company: { name: string; currency: string | null }, low: number, high: number, optionCount = 0): Required<Pick<DeliverDefaults, "intro" | "subject">> {
  const money = new Intl.NumberFormat("en-US", { style: "currency", currency: company.currency || "USD", maximumFractionDigits: 0 });
  return {
    intro: rangeIntroText(money.format(low), money.format(high), optionCount),
    subject: `Your roof estimate from ${company.name}`,
  };
}

/**
 * Each option's price before its add-ons, for the options that have one (core optionBaseTotal): what
 * the Client Hub shows on the option cards and what the price range is made from. An option with no
 * lines of its own yet has no price, so it isn't counted or quoted.
 */
export function optionPrices(quote: {
  tax_rate: number;
  discount_amount: number;
  promo: TotalsPromo | null;
  lines: readonly OptionLine[];
  options: ReadonlyArray<{ id: string }>;
}): number[] {
  const opts = { taxRate: quote.tax_rate, discountAmount: quote.discount_amount, promo: quote.promo };
  return quote.options.map((o) => optionBaseTotal(quote.lines, o.id, opts)).filter((total): total is number => total !== null);
}

/**
 * The words a quote that offers options goes out with when the person didn't write their own (core
 * optionsIntroText): how many options have a price (`prices`, from optionPrices) and the lowest of
 * them. Null with fewer than two, when the quote's own total says it.
 */
export function optionsMessage(currency: string | null, prices: readonly number[]): DeliverDefaults | null {
  if (prices.length < 2) return null;
  return { intro: optionsIntroText(prices.length, new Intl.NumberFormat("en-US", { style: "currency", currency: currency || "USD" }).format(Math.min(...prices))) };
}

/**
 * What a quote that offers options costs before the client chooses: how many options have a price
 * and the lowest of them (optionPrices), as its email said it (optionsMessage), never the total of
 * whichever option is shown. Null once it's signed (its total is the option they chose), while its
 * exact price is hidden behind a range (the range says it), and with fewer than two priced options
 * (its own total says it, as the email did). The Client Hub's home page and automations' {{total}}
 * say it this way.
 */
export function optionsFrom(quote: Parameters<typeof optionPrices>[0] & { status: string; range_low: Amount; priced_on_site_at: string | null; exact_sent_at?: string | null }): { count: number; from: number } | null {
  if (quote.status === "approved" || quote.status === "converted" || hidesExactPrice(quote)) return null;
  const prices = optionPrices(quote);
  return prices.length >= 2 ? { count: prices.length, from: Math.min(...prices) } : null;
}

/**
 * The most a quote's deposit can be, as the office's deposit input caps it (web QuotePage
 * depositCap): the cheapest option's price before its add-ons, so it's never more than they'd pay
 * whichever option they choose; the quote's total without options. Null while there's no price to
 * hold it to yet: options none of which has lines of its own (offered before the roof was measured),
 * or a quote with no lines.
 */
export function depositCap(quote: Parameters<typeof optionPrices>[0] & { total: Amount }): number | null {
  const prices = optionPrices(quote);
  if (prices.length) return Math.min(...prices);
  return quote.options.length || !quote.lines.length ? null : Number(quote.total ?? 0);
}

/**
 * Keeps the deposit asked for within depositCap once the estimate's price can have gone down (a
 * cheaper option offered, options filled in once measured, lines or the discount changed by an
 * assistant): a deposit larger than that is lowered to it, so the Client Hub never asks for more
 * than the price they choose, the contract's {Deposit} never says more than its {Total}, and billing
 * the deposit works once it's a job. Returns the new deposit, or null when it was within it.
 */
export async function keepDepositInCap(db: Db, companyId: string, quoteId: string): Promise<number | null> {
  const quote = must(
    await db
      .from("quotes")
      .select("deposit_amount, deposit_percent, total, tax_rate, discount_amount, promo:promo_codes(kind, value), lines:quote_line_items(option_id, quantity, unit_price, taxable, optional, selected), options:quote_options!quote_options_quote_fkey(id)")
      .eq("id", quoteId)
      .eq("company_id", companyId)
      .maybeSingle(),
    "Quote not found.",
  );
  // A percent is of the price they choose, so it's never more than it (the database works it out).
  if (quote.deposit_percent != null) return null;
  const cap = depositCap(quote);
  if (cap === null || toCents(quote.deposit_amount) <= Math.max(toCents(cap), 0)) return null;
  const lowered = Math.max(toCents(cap), 0) / 100;
  // Only while it's still the deposit read, so one typed meanwhile on another screen stays.
  const { error } = await db.from("quotes").update({ deposit_amount: lowered }).eq("id", quoteId).eq("company_id", companyId).eq("deposit_amount", quote.deposit_amount);
  if (error) throw dbError(error);
  return lowered;
}

/** Where an invoice's email points to its link: "pay it online" only when the business takes payments online (hubPayment). */
async function invoiceLinkLine(s: SalesScope) {
  return (await stripeAccess(s.env, adminClient(s.env), s.companyId)) ? "You can view and pay it online:" : "You can view it online:";
}

/** How a send went: the office's copy of the link, whether it reached anyone, and who. */
export interface Delivered {
  link: string;
  sent: boolean;
  /** Why it reached nobody ("Link only" when only the link was asked for), with the provider's status and code. */
  reason?: string;
  status?: number;
  code?: number;
  id?: string;
  /** The addresses or numbers it went to. */
  sent_to?: string[];
  /** It reached some and not these. */
  not_sent?: Array<{ to: string; reason: string }>;
  /** The sender's own copy, when they asked for one: whether it went, and why not. */
  copy?: { to: string; sent: boolean; reason?: string };
}

/**
 * Email or text the client their link to a quote or invoice (or just make the link), and log it on
 * their timeline. Only an email or text to the client's own email or phone on file carries their
 * own link (lib/links sentToClient); one typed to any other address carries the office's copy. What
 * comes back to the person sending (Copy link) carries the office's copy too (lib/links
 * clientLinks), so they can't use it, or send it to themselves, to say yes to autopay or tip on the
 * client's saved card for them. The copy on the timeline carries no link at all (KEPT_LINK).
 */
export async function deliver(s: SalesScope, kind: "quote" | "invoice", record: Deliverable, body: SendBody, defaults: DeliverDefaults = {}): Promise<Delivered> {
  // Only a quote template has no client, and it's never sent: a quote is made from it first.
  if (!record.client_id) throw new HttpError(400, TEMPLATE_NOT_SENT);
  // With the server's key: the browser's role doesn't read the settings (lib/companySettings.ts).
  const company = must(await adminClient(s.env).from("companies").select("name, email, phone, address, currency, settings").eq("id", s.companyId).maybeSingle());
  const links = await clientLinks(s.env, s.baseUrl, { c: s.companyId, t: kind, id: record.id, ...(s.noMoney && { nm: 1 as const }) });
  const label = `${kind === "quote" ? "Quote" : "Invoice"} #${record.number}`;
  const money = new Intl.NumberFormat("en-US", { style: "currency", currency: company.currency || "USD" }).format(Number(kind === "quote" ? record.total ?? 0 : record.balance_due ?? 0));
  const amount = record.recurrence_rule ? `${money} per visit` : money;
  const greeting = `Hi ${firstName(record.client?.display_name)},`;
  const intro =
    body.message?.trim() ||
    defaults.intro ||
    (kind === "quote" ? `Thanks for the opportunity. Here's your quote (${amount}). You can review the details, choose any options and approve it online:` : `Here's your invoice for ${amount}. ${defaults.note ? `${defaults.note} ` : ""}${await invoiceLinkLine(s)}`);
  const message = (link: string) => `${greeting}\n\n${intro}\n\n${link}\n\nThanks,\n${company.name}`;
  // The client's own link only to their own email or phone on file; any other address gets the office's copy.
  const linkFor = (channel: "email" | "sms", to: string) => (sentToClient(channel, to, record.client) ? links.own : links.office);
  if (body.channel === "link") {
    if (s.assistant) throw new HttpError(403, NO_LINKS_FOR_ASSISTANTS);
    return { link: links.office, sent: false, reason: "Link only" };
  }
  const channel = body.channel;
  const admin = adminClient(s.env);
  const { data: onFile } = await s.db.from("clients").select("id, display_name, email, phone, sms_opt_out_at").eq("id", record.client_id).maybeSingle();
  const client = onFile ?? { id: record.client_id, display_name: record.client?.display_name ?? "This client", email: record.client?.email ?? null, phone: record.client?.phone ?? null, sms_opt_out_at: null };
  const people = await sendTo(admin, s.companyId, channel, client, body, company.settings, s.assistant === true);
  const subject = body.subject || defaults.subject || `${label} from ${company.name}`;
  const footer = [company.name, companyAddress(company.address as Record<string, string>), company.phone].filter(Boolean).join(" · ");
  const email = (to: string, text: string) =>
    sendEmail(s.env, { to, subject, ...renderEmail({ companyName: company.name, logo: logoImage(s.baseUrl, s.companyId, company.settings), text, footer }), replyTo: company.email ?? undefined, fromName: company.name }, s.companyId);
  const delivery =
    channel === "email"
      ? await sendToEach(people, (person) => email(person.to, message(linkFor("email", person.to))))
      : await sendToEach(people, async (person) => {
          const result = await textWithStopLine(admin, s.companyId, person.to, `${company.name}: ${intro} ${linkFor("sms", person.to)}`, (text) => sendSms(s.env, { to: person.to, body: text, company: s.companyId }));
          await noteRefusedText(admin, client, person.to, result, s.companyId);
          return result;
        });
  if (delivery.went.length) {
    await s.db.from("messages").insert({
      company_id: s.companyId,
      client_id: record.client_id,
      channel,
      subject: channel === "email" ? body.subject || defaults.subject || label : label,
      // No working link: everyone who reads the timeline (an AI assistant connected as someone
      // among them) would otherwise hold one that opens the client's page as the client (lib/links KEPT_LINK).
      body: message(links.kept),
      related_type: kind,
      related_id: record.id,
      external_id: delivery.id,
      recipients: recipientsColumn(delivery),
    });
  }
  // A separate email, not a Bcc: the client's own link says yes and pays as them, so the sender's
  // copy carries the office's. It isn't put on the timeline, and one that doesn't go never undoes the send.
  let copy: Delivered["copy"];
  if (channel === "email" && s.copyTo !== undefined && delivery.went.length) {
    const to = s.copyTo;
    if (!isEmail(to)) copy = { to, sent: false, reason: "There's no email address on your profile to send the copy to." };
    else if (delivery.went.some((person) => emailMatchKey(person.to) === emailMatchKey(to))) copy = { to, sent: true };
    else {
      const went = delivery.went.map((person) => person.to).join(", ");
      const result = await email(to, `Your copy of what was sent to ${went}.\n\n${message(links.office)}`).catch((error: unknown) => ({ sent: false, reason: error instanceof Error ? error.message : undefined }));
      copy = result.sent ? { to, sent: true } : { to, sent: false, reason: result.reason || "The copy couldn't be sent." };
    }
  }
  const first = delivery.failed[0];
  return {
    link: links.office,
    sent: delivery.went.length > 0,
    ...(delivery.id ? { id: delivery.id } : {}),
    // Sent to nobody: why, and the provider's status and code with it, as a send to one address gave them.
    ...(!delivery.went.length && first ? { reason: first.reason, ...(first.result.status ? { status: first.result.status } : {}), ...(first.result.code ? { code: first.result.code } : {}) } : {}),
    sent_to: delivery.went.map((person) => person.to),
    // Reached some and not others: who it didn't reach, and why.
    ...(delivery.went.length && delivery.failed.length ? { not_sent: delivery.failed.map((person) => ({ to: person.to, reason: person.reason })) } : {}),
    ...(copy ? { copy } : {}),
  };
}

type SendClient = { id: string; display_name: string; email: string | null; phone: string | null; sms_opt_out_at: string | null };

/**
 * Who a quote or invoice goes to. The addresses or numbers named for this send (`recipients`, as
 * the Send dialog ticks and types them, and `to`, the one address older callers give) are the only
 * ones it goes to: every one is checked, and there are MAX_RECIPIENTS at most. With none named: the
 * client's own, and their contacts ticked for emails or texts (services/recipients.ts). Never a
 * number that texted STOP. Refuses, with what to fix, when that leaves nobody. `onFileOnly` (an AI
 * assistant sending) refuses any named address that isn't the client's own or a contact's, and
 * leaves out (or, named, refuses) one an assistant put on file itself (recipients.ts addedByAssistant).
 */
async function sendTo(admin: Db, companyId: string, channel: "email" | "sms", client: SendClient, body: SendBody, settings: unknown, onFileOnly = false): Promise<Recipient[]> {
  const reach = await clientReach(admin, companyId, client, settings);
  const named = uniqueAddresses(channel, [...(body.recipients ?? []), body.to]);
  // An assistant's send leaves out the addresses an assistant put on file itself.
  const added = onFileOnly ? await addedByAssistant(admin, companyId, [client.id]) : null;
  const byAssistant = (person: Recipient) => Boolean(added && (person.contact_id ? added.contacts.has(person.contact_id) : added.clients.has(client.id)));
  if (!named.length) {
    const everyone = clientRecipients(channel, client, reach.contacts, reach);
    const people = everyone.filter((person) => !byAssistant(person));
    if (people.length) return people.slice(0, MAX_RECIPIENTS);
    if (everyone.length) throw new HttpError(400, addedByAssistantRefusal(everyone.length === 1 ? everyone[0]!.to : null));
    if (channel === "email") throw new HttpError(400, "Add a valid email address for this client first.");
    throw new HttpError(400, client.phone ? textsOffRefusal(client.display_name) : "This client has no phone number.");
  }
  if (named.length > MAX_RECIPIENTS) throw new HttpError(400, `Send it to ${MAX_RECIPIENTS} people at most.`);
  // Whose each address or number is, for the timeline: the client's, a contact's, or one typed in.
  const key = channel === "email" ? emailMatchKey : phoneMatchKey;
  const whose = (to: string): Recipient => {
    if (sentToClient(channel, to, client)) return { to, name: client.display_name, contact_id: null };
    const contact = reach.contacts.find((c) => key(channel === "email" ? c.email : c.phone) === key(to));
    return contact ? { to, name: contact.name, contact_id: contact.id } : { to, name: to, contact_id: null };
  };
  if (onFileOnly) {
    const onFileTo = (to: string) => Boolean(key(to)) && (sentToClient(channel, to, client) || reach.contacts.some((c) => key(channel === "email" ? c.email : c.phone) === key(to)));
    const elsewhere = named.find((to) => !onFileTo(to));
    if (elsewhere) throw new HttpError(400, notOnFile(elsewhere));
    const putThere = named.map(whose).find(byAssistant);
    if (putThere) throw new HttpError(400, addedByAssistantRefusal(putThere.to));
  }
  if (channel === "email") {
    const wrong = named.find((to) => !isEmail(to));
    if (wrong) throw new HttpError(400, named.length === 1 ? "Add a valid email address for this client first." : `${wrong} isn't a valid email address.`);
    return named.map(whose);
  }
  const wrong = named.find((to) => !phoneMatchKey(to));
  if (wrong) throw new HttpError(400, `${wrong} isn't a phone number.`);
  // A client who texted STOP isn't texted at their own phone, a quote or invoice included; nor is
  // any other number that texted STOP.
  if (named.some((to) => textsOffTo(client, to))) throw new HttpError(400, textsOffRefusal(client.display_name));
  const stopped = new Set(await stoppedNumbers(admin, companyId, named));
  const refused = named.find((to) => stopped.has(phoneMatchKey(to)));
  if (refused) throw new HttpError(400, numberStoppedRefusal(refused));
  return named.map(whose);
}

/**
 * The people the Send dialog offers for a quote's or invoice's client, by email and by text: the
 * client and their contacts, with who starts ticked (services/recipients.ts sendChoicesFor).
 */
export async function sendChoicesOf(s: SalesScope, kind: "quote" | "invoice", id: string) {
  const record = must(await s.db.from(kind === "quote" ? "quotes" : "invoices").select("id, client_id").eq("id", id).eq("company_id", s.companyId).maybeSingle(), `${kind === "quote" ? "Quote" : "Invoice"} not found.`);
  if (!record.client_id) throw new HttpError(400, TEMPLATE_NOT_SENT);
  const client = must(await s.db.from("clients").select("id, display_name, email, phone, sms_opt_out_at").eq("id", record.client_id).eq("company_id", s.companyId).maybeSingle(), "Client not found.");
  return { ...(await sendChoicesFor(adminClient(s.env), s.companyId, client)), max: MAX_RECIPIENTS };
}

/**
 * Start a draft quote from a request, carrying over the client, property and any measurement. The
 * request becomes Quoted, unless `keepRequest`: a draft made by itself as the request came in
 * (services/quoteDrafts.ts) leaves it as it is, still new and still bookable, until someone sends
 * that quote (20261113001650_drafts_leave_requests.sql).
 */
export async function quoteFromRequest(s: SalesScope, requestId: string, options: { keepRequest?: boolean } = {}) {
  const request = must(await s.db.from("requests").select("id, client_id, property_id, title, details").eq("id", requestId).eq("company_id", s.companyId).maybeSingle(), "Request not found.");
  const company = must(await adminClient(s.env).from("companies").select("settings").eq("id", s.companyId).maybeSingle());
  const taxRate = Number((company.settings as { default_tax_rate?: number } | null)?.default_tax_rate ?? 0);
  const quote = must(
    await s.db
      .from("quotes")
      .insert({ company_id: s.companyId, client_id: request.client_id, property_id: request.property_id, request_id: request.id, title: request.title, tax_rate: taxRate })
      .select("id, number")
      .single(),
  );
  await Promise.all([
    ...(options.keepRequest ? [] : [s.db.from("requests").update({ status: "quoted" }).eq("id", requestId)]),
    s.db.from("measurements").update({ quote_id: quote.id }).eq("request_id", requestId).is("quote_id", null),
  ]);
  return quote;
}

/**
 * Send a quote (or take its link to share): it's then with the client. A roof estimate that's out as
 * a price range goes out with the range's words, so the message never gives away the exact total
 * its link hides. A quote that offers options says so, with the lowest price, rather than the total
 * of whichever option is shown.
 */
export async function sendQuote(s: SalesScope, id: string, body: SendBody) {
  const quote = must(
    await s.db
      .from("quotes")
      .select(
        "id, number, status, total, tax_rate, discount_amount, client_id, range_low, range_high, range_accepted_at, priced_on_site_at, exact_sent_at, recurrence_rule, client:clients(display_name, email, phone), promo:promo_codes(kind, value), lines:quote_line_items(id, option_id, quantity, unit_price, taxable, optional, selected), options:quote_options!quote_options_quote_fkey(id)",
      )
      .eq("id", id)
      .eq("company_id", s.companyId)
      .maybeSingle(),
    "Quote not found.",
  );
  if (["converted", "lost", "archived"].includes(quote.status)) throw new HttpError(400, `This quote is ${quote.status}, so it can't be sent.`);
  if (!quote.lines.length) throw new HttpError(400, "Add at least one line item before sending.");
  // A payment schedule with a day still to set, or one already gone: the database won't mark the
  // quote sent (20261113001640_schedule_dates.sql), so nothing goes to the client for it either.
  const { data: problem } = await s.db.rpc("quote_send_problem", { p_quote: id });
  if (typeof problem === "string" && problem) throw new HttpError(400, problem);
  let defaults: DeliverDefaults = {};
  const prices = optionPrices(quote);
  if (inRangeMode(quote) || prices.length >= 2) {
    const company = must(await s.db.from("companies").select("name, currency").eq("id", s.companyId).maybeSingle());
    defaults = inRangeMode(quote) ? rangeMessage(company, Number(quote.range_low), Number(quote.range_high), prices.length) : (optionsMessage(company.currency, prices) ?? {});
  }
  const result = await deliver(s, "quote", quote, body, defaults);
  // Sent, or the office took the link to share themselves: the quote is now with the client.
  if (result.sent || body.channel === "link") {
    await s.db.from("quotes").update({ status: "sent", sent_at: new Date().toISOString() }).eq("id", id).in("status", ["draft", "changes_requested"]);
    // The exact price after their yes to the range (or one set on site): the follow-up that yes stopped starts again.
    if (quote.status === "sent" && !inRangeMode(quote) && (quote.range_accepted_at || quote.priced_on_site_at)) {
      const { error } = await s.db.rpc("quote_exact_sent", { p_quote: id });
      if (error) console.error("Couldn't start the follow-up for an exact price sent", error.message);
    }
  }
  return result;
}

/** Quotes the client hasn't answered yet: what convertQuote keeps the contract of first. */
const UNSIGNED = ["draft", "sent", "changes_requested"];

/**
 * Turn a quote into a job (convert_quote_to_job), as the office's "Convert to job" and "Create the
 * job now" and the assistants do it. A quote the client never signed (the office heard yes another
 * way and converts it straight from sent) first gets the approval "Mark approved" would keep
 * (contracts.ts manualApproval, `by` its name): the template and the contract it was sent with,
 * filled in, so its signed copy prints those words and not today's. Only the approval is written,
 * not the status, so a change order still joins its job in the database's one step; and only while
 * it's unsigned, so a signature that came in meanwhile keeps its own. One that offers options is
 * approved with the option chosen first (the database refuses it otherwise). One that says how often
 * becomes a recurring job, and its next visits are made now. Returns the job's id.
 */
export async function convertQuote(s: Pick<SalesScope, "db" | "companyId" | "env">, quoteId: string, by: string): Promise<string> {
  const quote = must(await s.db.from("quotes").select("id, status, approval, recurrence_rule, change_order_for, is_template").eq("id", quoteId).eq("company_id", s.companyId).maybeSingle(), "Quote not found.");
  if (quote.is_template) throw new HttpError(400, "A quote template can't be made a job. Make a quote from it first.");
  const before = quote.approval;
  const kept = UNSIGNED.includes(quote.status) && !(await loadOptions(s.db, s.companyId, quoteId)).length;
  if (kept) {
    const approval = await manualApproval(s.db, s.companyId, quoteId, { name: by, optionId: null });
    const { error } = await s.db.from("quotes").update({ approval: asJson(approval) }).eq("id", quoteId).eq("company_id", s.companyId).in("status", UNSIGNED);
    if (error) throw dbError(error);
  }
  const { data, error } = await s.db.rpc("convert_quote_to_job", { p_quote: quoteId });
  if (error) {
    // Not a job after all: it's still unsigned, so it goes back to the approval it had.
    if (kept) await s.db.from("quotes").update({ approval: before }).eq("id", quoteId).eq("company_id", s.companyId).in("status", UNSIGNED);
    throw dbError(error);
  }
  if (quote.recurrence_rule && !quote.change_order_for) {
    // The same visits the daily recurrence task would make (tasks.ts), so a role that sells but doesn't
    // dispatch still gets them now. The job is made either way: that task catches up if this fails.
    const admin = adminClient(s.env);
    try {
      // Loaded here: tasks.ts loads every service, so importing it up top makes a cycle through this one.
      const { materializeJob, recurringJob } = await import("../tasks");
      const job = await recurringJob(admin, data);
      if (job) await materializeJob(admin, job);
    } catch (error) {
      console.error("Couldn't make the converted job's visits", error);
    }
  }
  return data;
}

/**
 * Send an invoice (or take its link): a draft becomes sent, and goes to Stripe so the Pay button is
 * ready. `defaults` are for a send nobody wrote a message for (DeliverDefaults).
 */
export async function sendInvoice(s: SalesScope, id: string, body: SendBody, defaults: DeliverDefaults = {}) {
  const invoice = must(
    await s.db.from("invoices").select("id, number, status, total, balance_due, client_id, client:clients(display_name, email, phone), lines:invoice_line_items(id)").eq("id", id).eq("company_id", s.companyId).maybeSingle(),
    "Invoice not found.",
  );
  if (invoice.status === "void") throw new HttpError(400, "This invoice is void.");
  if (!invoice.lines.length) throw new HttpError(400, "Add at least one line item before sending.");
  const result = await deliver(s, "invoice", invoice, body, defaults);
  if (invoice.status === "draft" && (result.sent || body.channel === "link")) {
    await s.db.from("invoices").update({ status: "sent" }).eq("id", id);
    // Put it in Stripe now rather than at the next outbox run, so the client's Pay button is ready.
    void syncStripeInvoice(s.env, adminClient(s.env), s.companyId, id).catch((error) => console.error("Stripe sync failed", error));
  }
  return result;
}

/** The most jobs invoiceJobs takes in one call (each can send an email), and what's said for more: for a person, and for an assistant. */
export const BATCH_JOBS = 50;
export const TOO_MANY_JOBS = `Invoice at most ${BATCH_JOBS} jobs at a time: send the first ${BATCH_JOBS}, then the next.`;

/**
 * One invoice per finished job (completed visits for per-visit jobs), and optionally email each. A
 * monthly job gets one for each month that's due (due_invoices: the month's visits, or a fixed
 * price's lines once), and a fixed price invoiced as needed its lines. Each invoice succeeds or fails
 * on its own. A job whose autopay charge is waiting is left to it: autopay bills and charges those
 * visits (or that month) itself (services/autopay.ts), and billing them here first would leave it
 * nothing to charge. With `work`, each invoice also gets its job's logged work (addLoggedWork)
 * before it's sent.
 */
export async function invoiceJobs(s: SalesScope, jobIds: readonly string[], send: boolean, work?: { rateId?: string }) {
  const jobs = must(await s.db.from("jobs").select("id, number, title, kind, billing_mode, pricing").eq("company_id", s.companyId).in("id", [...jobIds]));
  const ids = jobs.map((j) => j.id);
  const timeZone = work ? must(await s.db.from("companies").select("timezone").eq("id", s.companyId).maybeSingle()).timezone || "UTC" : "UTC";
  const [{ data: waiting }, { data: due }] = await Promise.all([
    s.db.from("autopay_charges").select("job_id").eq("company_id", s.companyId).eq("status", "waiting").in("job_id", ids),
    s.db.from("due_invoices").select("job_id, month").eq("company_id", s.companyId).in("job_id", ids).order("month"),
  ]);
  const autopay = new Set((waiting ?? []).map((row) => row.job_id));
  const results: Array<{ job_id: string; number: number | null; month?: string; ok: boolean; invoice_id?: string; sent?: boolean; error?: string }> = [];
  for (const job of jobs) {
    if (autopay.has(job.id)) {
      results.push({ job_id: job.id, number: job.number, ok: false, error: "This job is charged automatically tonight." });
      continue;
    }
    const kind = job.kind === "recurring" && job.pricing === "fixed" ? "standard" : job.billing_mode === "per_visit" || job.kind === "recurring" ? "visits" : "standard";
    const months = (due ?? []).filter((d) => d.job_id === job.id).map((d) => d.month as string);
    for (const month of months.length ? months : [undefined]) {
      const created = await s.db.rpc("create_invoice_for_job", { p_job: job.id, p_kind: kind, ...(month && { p_month: month }) });
      if (created.error) {
        results.push({ job_id: job.id, number: job.number, ...(month && { month }), ok: false, error: dbError(created.error).message });
        continue;
      }
      const invoiceId = created.data as string;
      if (work) {
        try {
          await addLoggedWork(s, invoiceId, job.id, work.rateId, timeZone);
        } catch (e) {
          // Not sent without it: the draft is there to finish by hand.
          results.push({ job_id: job.id, number: job.number, ...(month && { month }), ok: false, invoice_id: invoiceId, error: `Its logged work couldn't be added (${e instanceof Error ? e.message : "try again"}). The invoice is in Drafts.` });
          continue;
        }
      }
      let sent = false;
      let error: string | undefined;
      if (send) {
        const invoice = must(await s.db.from("invoices").select("id, number, status, total, balance_due, client_id, client:clients(display_name, email, phone)").eq("id", invoiceId).maybeSingle());
        try {
          const result = await deliver(s, "invoice", invoice, { channel: "email" });
          sent = result.sent;
          if (sent) await s.db.from("invoices").update({ status: "sent" }).eq("id", invoiceId);
          else error = result.reason ?? "Not sent";
        } catch (e) {
          error = e instanceof HttpError ? e.message : "Couldn't send it";
        }
      }
      results.push({ job_id: job.id, number: job.number, ...(month && { month }), ok: true, invoice_id: invoiceId, sent, error });
    }
  }
  return { results };
}

/**
 * A job's logged hours and materials no invoice bills yet (core workToBill, as the invoice's Add
 * logged work step reads them), with the price list items hours can be billed at.
 */
export async function loggedWork(db: Db, companyId: string, jobId: string) {
  const [time, materials, invoices, services] = await Promise.all([
    db.from("time_entries").select("id, user_id, started_at, ended_at, category, approved_at").eq("company_id", companyId).eq("job_id", jobId).not("ended_at", "is", null).order("started_at").limit(2000),
    db.from("job_materials").select("id, name, quantity, unit, service_id, logged_at").eq("company_id", companyId).eq("job_id", jobId).order("logged_at").limit(2000),
    db.from("invoices").select("lines:invoice_line_items(time_entry_ids, material_ids)").eq("company_id", companyId).eq("job_id", jobId).neq("status", "void").limit(500),
    db.from("services").select("id, name, unit, unit_price, taxable, active").eq("company_id", companyId),
  ]);
  const prices = must(services);
  return { ...workToBill({ time: must(time), materials: must(materials), billed: must(invoices).flatMap((i) => i.lines), services: prices }), rates: laborRates(prices) };
}

/**
 * Batch invoicing's "Add logged hours and materials": a job's logged work on its new invoice, as Add
 * logged work starts out ticked (core workLines): the hours at `rateId` (else the first item sold by
 * the hour; none without one), and the materials that have a price.
 */
async function addLoggedWork(s: SalesScope, invoiceId: string, jobId: string, rateId: string | undefined, timeZone: string) {
  const work = await loggedWork(s.db, s.companyId, jobId);
  const rate = work.rates.find((r) => r.id === rateId) ?? work.rates[0] ?? null;
  const lines = workLines({ hours: rate ? work.hours : [], rate, materials: work.materials.filter((m) => m.unit_price !== null), timeZone });
  if (!lines.length) return;
  const sort = Math.max(0, ...must(await s.db.from("invoice_line_items").select("sort").eq("invoice_id", invoiceId)).map((l) => l.sort));
  must(await s.db.from("invoice_line_items").insert(lines.map((l, i) => ({ ...l, company_id: s.companyId, invoice_id: invoiceId, sort: sort + i + 1 }))).select("id"));
}

/**
 * Friendly reminders for unpaid invoices, by email; not while a bank payment is on its way, nor
 * while autopay is charging it or will try the card again (its own notice already went).
 */
export async function remindInvoices(s: SalesScope, invoiceIds: readonly string[]) {
  const company = must(await s.db.from("companies").select("name, currency, timezone").eq("id", s.companyId).maybeSingle());
  const today = localDate(new Date(), company.timezone || "UTC");
  const invoices = must(
    await s.db
      .from("invoices")
      .select("id, number, status, total, balance_due, due_on, client_id, client:clients(display_name, email, phone)")
      .eq("company_id", s.companyId)
      .in("id", [...invoiceIds])
      .in("status", ["sent", "partially_paid", "overdue"]),
  );
  const linkLine = await invoiceLinkLine(s);
  let sent = 0;
  const skipped: Array<{ number: number | null; reason: string }> = [];
  // Don't ask again while a bank payment is on its way.
  const { data: paying } = await s.db.from("stripe_invoices").select("invoice_id").eq("company_id", s.companyId).eq("status", "processing").in("invoice_id", invoices.map((i) => i.id));
  const processing = new Set((paying ?? []).map((row) => row.invoice_id));
  const { data: charges } = await s.db
    .from("autopay_charges")
    .select("invoice_id, status")
    .eq("company_id", s.companyId)
    .in("status", ["charging", "processing", "failed"])
    .in("invoice_id", invoices.map((i) => i.id));
  const autopay = new Map((charges ?? []).map((row) => [row.invoice_id, row.status]));
  for (const invoice of invoices) {
    if (Number(invoice.balance_due) <= 0) continue;
    if (processing.has(invoice.id) || autopay.get(invoice.id) === "processing") {
      skipped.push({ number: invoice.number, reason: "A bank payment is on its way" });
      continue;
    }
    if (autopay.has(invoice.id)) {
      skipped.push({ number: invoice.number, reason: autopay.get(invoice.id) === "charging" ? "It's being charged automatically" : "Autopay will try the card again" });
      continue;
    }
    const amount = new Intl.NumberFormat("en-US", { style: "currency", currency: company.currency || "USD" }).format(Number(invoice.balance_due));
    // An early reminder says when it's due; once that day has passed, when it was.
    const due = invoice.due_on
      ? `${invoice.due_on < today ? "was" : "is"} due ${new Date(`${invoice.due_on}T12:00:00Z`).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" })}`
      : null;
    try {
      const result = await deliver(s, "invoice", invoice, {
        channel: "email",
        subject: `Reminder: invoice #${invoice.number} from ${company.name}`,
        message: `A friendly reminder that ${amount} is still owed on invoice #${invoice.number}${due ? `, which ${due}` : ""}. ${linkLine}`,
      });
      if (result.sent) sent++;
      else skipped.push({ number: invoice.number, reason: result.reason ?? "Not sent" });
    } catch (e) {
      skipped.push({ number: invoice.number, reason: e instanceof HttpError ? e.message : "Couldn't send it" });
    }
  }
  return { sent, skipped };
}
