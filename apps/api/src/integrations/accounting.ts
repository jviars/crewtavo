import { lineTotal, taxLineLabel, taxName, toCents } from "@crewtavo/core";
import type { Db } from "../lib/supabase";
/**
 * Accounting sync: push clients, invoices and payments to QuickBooks Online or Zoho Books.
 * Called from the outbox task with the admin client; every query filters by company_id. An invoice
 * the books have already is sent again when it changes (a late fee, a minimum charge, an edit:
 * private.enqueue_accounting), through each one's update API, so the books keep up with it, and
 * voided there when it's voided here (private.enqueue_accounting_void).
 *
 * A link (sync_links) belongs to the books it was made in: the QuickBooks company or Zoho Books
 * organization connected then. Only links to the books connected now are used, and a change queued
 * for other books isn't sent to these (20261112000470_accounting_links_per_books.sql).
 *
 * QuickBooks item mapping lives in integrations.settings:
 *   { "environment": "production" | "sandbox", "item_map": { "<service uuid>": "<QBO Item Id>" }, "default_item_id": "1" }
 * default_item_id is the item lines go under when their service isn't mapped. Until one is saved
 * it's QuickBooks' first item, "1"; when QuickBooks says that item (or the saved one) isn't there to
 * use, one is found or added and saved (replaceDefaultItem).
 */
import { serviceUrl, type Env } from "../env";
import { providerTimeout, zohoApiDomain, type Provider } from "./registry";
import { accessToken, IntegrationError } from "./tokens";

type Accounting = "quickbooks" | "zoho_books";
type Entity = "client" | "invoice" | "payment";

interface Ctx {
  env: Env;
  admin: Db;
  companyId: string;
  provider: Accounting;
  integration: { external_account_id: string | null; settings: Record<string, unknown> };
}

const QBO_BASE = { production: "https://quickbooks.api.intuit.com", sandbox: "https://sandbox-quickbooks.api.intuit.com" };
const QBO_MINOR_VERSION = "75";
const NO_REALM = "QuickBooks company (realm) ID is missing; reconnect QuickBooks.";
const NO_ORGANIZATION = "Zoho Books organization ID is missing; reconnect Zoho Books.";

async function one<R extends { data: unknown; error: { message: string } | null }>(query: PromiseLike<R>, what: string): Promise<NonNullable<R["data"]>> {
  const { data, error } = await query;
  if (error) throw new IntegrationError(error.message);
  if (!data) throw new IntegrationError(`${what} not found`);
  return data as NonNullable<R["data"]>;
}

/**
 * The books connected now: the QuickBooks company (realm) or Zoho Books organization. An id from
 * other books means nothing in these, or worse, is some other record's there.
 */
function books(ctx: Ctx): string {
  const account = ctx.integration.external_account_id;
  if (!account) throw new IntegrationError(ctx.provider === "quickbooks" ? NO_REALM : NO_ORGANIZATION);
  return account;
}

/** A lookup that fails isn't "never sent": carrying on as if it were would send the record twice. */
async function linked(ctx: Ctx, entity: Entity, localId: string): Promise<string | null> {
  const { data, error } = await ctx.admin
    .from("sync_links")
    .select("external_id")
    .match({ company_id: ctx.companyId, provider: ctx.provider, account_id: books(ctx), entity, local_id: localId })
    .maybeSingle();
  if (error) throw new IntegrationError(error.message);
  return data?.external_id ?? null;
}

/** The provider took the record but the link to it wasn't saved. Retrying the job would send it again. */
export class SentButUnrecorded extends IntegrationError {
  override name = "SentButUnrecorded";
}

/**
 * Once the provider has the record, sending it again makes a copy in the books. So a link that
 * couldn't be saved is tried once more here, then fails the job for good (not to be retried),
 * naming the provider's record so it can be checked there.
 */
async function remember(ctx: Ctx, entity: Entity, localId: string, externalId: string, syncToken?: string) {
  const link = {
    company_id: ctx.companyId,
    provider: ctx.provider,
    account_id: books(ctx),
    entity,
    local_id: localId,
    external_id: externalId,
    sync_token: syncToken ?? null,
    synced_at: new Date().toISOString(),
  };
  let { error } = await ctx.admin.from("sync_links").upsert(link);
  if (error) ({ error } = await ctx.admin.from("sync_links").upsert(link));
  // By these words requeue_accounting() knows the job as one never to send again.
  if (error) throw new SentButUnrecorded(`Sent ${entity} ${externalId} but couldn't record it: ${error.message}`);
}

/** The provider's record is already the copy of another of ours, so it isn't this one's. */
async function linkedElsewhere(ctx: Ctx, entity: Entity, externalId: string, localId: string): Promise<boolean> {
  const { data, error } = await ctx.admin
    .from("sync_links")
    .select("local_id")
    .match({ company_id: ctx.companyId, provider: ctx.provider, account_id: books(ctx), entity, external_id: externalId });
  if (error) throw new IntegrationError(error.message);
  return (data ?? []).some((link) => link.local_id !== localId);
}

// ---------------------------------------------------------------------------------------------
// Provider HTTP
// ---------------------------------------------------------------------------------------------
//
// A create we stopped waiting for (the timeout, or a dropped connection) may still go through at
// the provider, and the outbox then tries the job again. So before making an invoice or payment we
// look for the one we sent: the same customer, number or reference, date and amount. Our number
// alone isn't enough, since the books can have an invoice of their own with it. QuickBooks' request
// ids aren't used: a repeated one gets the first answer, which may be a refusal fixed since.

/**
 * Which QuickBooks the keys work with. A company's own Intuit keys say so themselves (development
 * keys only reach sandbox companies); the server's follow the settings, then QUICKBOOKS_ENVIRONMENT.
 */
export function qboEnvironment(env: Env, settings: Record<string, unknown>, extra?: Record<string, string>): keyof typeof QBO_BASE {
  if (extra?.client_id) return extra.environment === "sandbox" ? "sandbox" : "production";
  return settings.environment === "sandbox" ? "sandbox" : (env.QUICKBOOKS_ENVIRONMENT ?? "production");
}

async function qbo(ctx: Ctx, method: "GET" | "POST", path: string, body?: unknown) {
  const realm = ctx.integration.external_account_id;
  if (!realm) throw new IntegrationError(NO_REALM);
  const { token, secret } = await accessToken(ctx.env, ctx.admin, ctx.companyId, "quickbooks");
  const env = qboEnvironment(ctx.env, ctx.integration.settings, secret.extra);
  const url = `${serviceUrl(ctx.env, "quickbooks", QBO_BASE[env])}/v3/company/${realm}/${path}${path.includes("?") ? "&" : "?"}minorversion=${QBO_MINOR_VERSION}`;
  const response = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: providerTimeout(),
  });
  const json = (await response.json().catch(() => ({}))) as Record<string, any>;
  if (!response.ok) {
    const detail = json.Fault?.Error?.[0];
    throw new QuickBooksFault(`QuickBooks ${path}: ${response.status} ${detail?.Message ?? ""} ${detail?.Detail ?? ""}`.trim(), detail?.code === undefined ? null : String(detail.code));
  }
  return json;
}

/** QuickBooks turned a request down, with the code of its first fault ("2500", "610", ...) when it gave one. */
class QuickBooksFault extends IntegrationError {
  override name = "QuickBooksFault";
  constructor(message: string, readonly code: string | null) {
    super(message);
  }
}

const qboQuery = async (ctx: Ctx, entity: string, select: string): Promise<Array<Record<string, any>>> =>
  (await qbo(ctx, "GET", `query?query=${encodeURIComponent(select)}`)).QueryResponse?.[entity] ?? [];

/**
 * QuickBooks refused an invoice for something on it that isn't there (2500, Invalid Reference Id)
 * or was made inactive (610). If that's `current`, the item lines go under, another is found: an
 * active service item, "Services" before any other, or a new one called Services under an income
 * account (the one for services before the one for products) when the company has none. It's saved
 * as settings.default_item_id for every invoice after. Null when `current` is there to use, so the
 * refusal was about something else.
 */
async function replaceDefaultItem(ctx: Ctx, current: string): Promise<string | null> {
  // A query answers with active records only.
  if ((await qboQuery(ctx, "Item", `select Id from Item where Id = '${current.replace(/'/g, "\\'")}'`)).length) return null;
  const services = await qboQuery(ctx, "Item", "select Id, Name from Item where Type = 'Service' and Active = true");
  let item = services.find((i) => i.Name === "Services") ?? services[0];
  if (!item) {
    const accounts = await qboQuery(ctx, "Account", "select Id, Name, AccountSubType from Account where AccountType = 'Income' and Active = true");
    const account = accounts.find((a) => a.AccountSubType === "ServiceFeeIncome") ?? accounts.find((a) => a.AccountSubType === "SalesOfProductIncome") ?? accounts[0];
    if (!account) throw new IntegrationError("QuickBooks has no item to put invoice lines under, and no income account to add one to. Add a service item in QuickBooks, then press Try again.");
    item = (await qbo(ctx, "POST", "item", { Name: "Services", Type: "Service", IncomeAccountRef: { value: account.Id } })).Item;
  }
  const id = String(item!.Id);
  const settings = { ...ctx.integration.settings, default_item_id: id };
  const { error } = await ctx.admin.from("integrations").update({ settings }).match({ company_id: ctx.companyId, provider: "quickbooks" });
  if (error) throw new IntegrationError(error.message);
  ctx.integration.settings = settings;
  return id;
}

async function zoho(ctx: Ctx, method: "GET" | "POST" | "PUT", path: string, body?: unknown) {
  const { token, secret } = await accessToken(ctx.env, ctx.admin, ctx.companyId, "zoho_books");
  const org = ctx.integration.external_account_id;
  if (!org) throw new IntegrationError(NO_ORGANIZATION);
  // Checked here too: tokens saved before only Zoho's servers were accepted may name another.
  const apiDomain = zohoApiDomain(ctx.env, secret.extra?.api_domain);
  const response = await fetch(`${apiDomain}/books/v3/${path}${path.includes("?") ? "&" : "?"}organization_id=${org}`, {
    method,
    headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: providerTimeout(),
  });
  const json = (await response.json().catch(() => ({}))) as Record<string, any>;
  if (!response.ok || (json.code !== undefined && json.code !== 0)) {
    throw new IntegrationError(`Zoho Books ${path}: ${response.status} ${json.message ?? ""}`.trim());
  }
  return json;
}

// ---------------------------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------------------------

async function pushClient(ctx: Ctx, clientId: string): Promise<string> {
  const existing = await linked(ctx, "client", clientId);
  if (existing) return existing;
  const client = await one(
    ctx.admin.from("clients").select("id, display_name, company_name, email, phone").eq("company_id", ctx.companyId).eq("id", clientId).maybeSingle(),
    "Client",
  );

  if (ctx.provider === "quickbooks") {
    const name = String(client.display_name).slice(0, 100);
    // DisplayName must be unique in QuickBooks; reuse a customer that already has it.
    const query = encodeURIComponent(`select Id, SyncToken from Customer where DisplayName = '${name.replace(/'/g, "\\'")}'`);
    const found = (await qbo(ctx, "GET", `query?query=${query}`)).QueryResponse?.Customer?.[0];
    const customer = found ?? (await qbo(ctx, "POST", "customer", {
      DisplayName: name,
      CompanyName: client.company_name ?? undefined,
      PrimaryEmailAddr: client.email ? { Address: client.email } : undefined,
      PrimaryPhone: client.phone ? { FreeFormNumber: client.phone } : undefined,
    })).Customer;
    await remember(ctx, "client", clientId, customer.Id, customer.SyncToken);
    return customer.Id;
  }

  const contact = (await zoho(ctx, "POST", "contacts", {
    contact_name: client.display_name,
    company_name: client.company_name ?? undefined,
    contact_type: "customer",
    contact_persons: client.email || client.phone ? [{ email: client.email ?? undefined, phone: client.phone ?? undefined, is_primary_contact: true }] : undefined,
  })).contact;
  await remember(ctx, "client", clientId, contact.contact_id);
  return contact.contact_id;
}

/**
 * The books' copy of the invoice, sent now if it hasn't been; with `update`, one already sent is
 * changed to match ours. One voided here is voided there, and isn't sent if the books never got it
 * (null then).
 */
async function pushInvoice(ctx: Ctx, invoiceId: string, update = false): Promise<string | null> {
  const existing = await linked(ctx, "invoice", invoiceId);
  if (existing && !update) return existing;
  const invoice = await one(
    ctx.admin
      .from("invoices")
      .select("id, number, status, client_id, issued_on, due_on, subject, tax_rate, tax_amount, discount_amount, credit_amount, invoice_line_items(name, description, quantity, unit_price, taxable, service_id, sort)")
      .eq("company_id", ctx.companyId)
      .eq("id", invoiceId)
      .maybeSingle(),
    "Invoice",
  );
  if (invoice.status === "void") {
    if (existing) await voidInBooks(ctx, existing);
    return existing;
  }
  const customerId = await pushClient(ctx, invoice.client_id);
  const lines = [...(invoice.invoice_line_items ?? [])].sort((a: any, b: any) => a.sort - b.sort);
  // Referral credits come off before tax with the discount, so the books see one discount for both.
  // One put on after the invoice was pushed goes with its update.
  const discount = Math.round((Number(invoice.discount_amount ?? 0) + Number(invoice.credit_amount ?? 0)) * 100) / 100;
  // The lines' amounts in cents, before the discount and tax: with the date, what tells the one we
  // sent from an invoice of theirs with our number.
  const charged = lines.reduce((sum: number, line: any) => sum + toCents(lineTotal(line.quantity, line.unit_price)), 0);

  if (ctx.provider === "quickbooks") {
    const itemMap = (ctx.integration.settings.item_map ?? {}) as Record<string, string>;
    const mapped = (line: any): string | undefined => (line.service_id && itemMap[line.service_id]) || undefined;
    const defaultItem = String(ctx.integration.settings.default_item_id ?? "1");
    const body = (fallback: string) => ({
      CustomerRef: { value: customerId },
      DocNumber: String(invoice.number),
      TxnDate: invoice.issued_on,
      DueDate: invoice.due_on ?? undefined,
      Line: [
        ...lines.map((line: any) => ({
          DetailType: "SalesItemLineDetail",
          Amount: lineTotal(line.quantity, line.unit_price), // rounded as the invoice's own totals are
          Description: line.description || line.name,
          SalesItemLineDetail: {
            ItemRef: { value: mapped(line) ?? fallback },
            Qty: Number(line.quantity),
            UnitPrice: Number(line.unit_price),
            TaxCodeRef: { value: line.taxable ? "TAX" : "NON" },
          },
        })),
        // Discounts (promo codes) and referral credits come off before tax, as they do here.
        ...(discount > 0 ? [{ DetailType: "DiscountLineDetail", Amount: discount, DiscountLineDetail: { PercentBased: false } }] : []),
      ],
      ApplyTaxAfterDiscount: true,
      // On an update, a tax gone to nothing is sent too, or QuickBooks keeps the one it had.
      ...(Number(invoice.tax_amount) > 0 || existing ? { TxnTaxDetail: { TotalTax: Number(invoice.tax_amount) } } : {}),
    });
    // Sent with the item lines go under; if QuickBooks says something on it isn't there to use and
    // that's the item, once more with the one found instead.
    const send = async (more: Record<string, unknown> = {}) => {
      try {
        return (await qbo(ctx, "POST", "invoice", { ...body(defaultItem), ...more })).Invoice;
      } catch (error) {
        const refused = error instanceof QuickBooksFault && (error.code === "2500" || error.code === "610") && lines.some((line: any) => !mapped(line));
        const found = refused ? await replaceDefaultItem(ctx, defaultItem) : null;
        if (!found) throw error;
        return (await qbo(ctx, "POST", "invoice", { ...body(found), ...more })).Invoice;
      }
    };
    if (existing) {
      // A sparse update replaces the lines; it needs the invoice's SyncToken, which any change in the
      // books moves on (a payment applied, an edit there), so it's read first. Sent again, it's the same change.
      const current = (await qbo(ctx, "GET", `invoice/${encodeURIComponent(existing)}`)).Invoice;
      await send({ Id: existing, SyncToken: current?.SyncToken, sparse: true });
      return existing;
    }
    // Sent already: QuickBooks has an invoice with our number for this customer, dated as ours and
    // with our lines' amounts (not our total: QuickBooks may work the tax out itself).
    const query = encodeURIComponent(`select * from Invoice where DocNumber = '${String(invoice.number).replace(/'/g, "\\'")}'`);
    const sent = ((await qbo(ctx, "GET", `query?query=${query}`)).QueryResponse?.Invoice ?? []).find(
      (i: any) =>
        i.CustomerRef?.value === customerId &&
        i.TxnDate === invoice.issued_on &&
        (i.Line ?? []).filter((l: any) => l.DetailType === "SalesItemLineDetail").reduce((sum: number, l: any) => sum + toCents(l.Amount), 0) === charged,
    );
    const created = sent ?? (await send());
    await remember(ctx, "invoice", invoiceId, created.Id, created.SyncToken);
    return created.Id;
  }

  const reference = String(invoice.number);
  // Zoho Books takes tax only as one of the taxes set up in its organization, by that tax's id, and
  // works the amount out itself; there's nowhere to send ours. So it goes as the invoice's
  // adjustment, which Zoho adds after everything else and shows under the name sent with it
  // ("Tax (5.3%)"): the invoice comes to our total there, and a payment in full fits. Zoho's own
  // tax reports don't count it.
  const tax = Number(invoice.tax_amount ?? 0);
  const body = {
    customer_id: customerId,
    reference_number: reference,
    date: invoice.issued_on,
    due_date: invoice.due_on ?? undefined,
    line_items: lines.map((line: any) => ({
      name: line.name,
      description: line.description ?? undefined,
      rate: Number(line.unit_price),
      quantity: Number(line.quantity),
    })),
    // On an update, a discount or tax gone to nothing is sent too, or Zoho keeps the one it had.
    ...(discount > 0 || existing ? { discount, discount_type: "entity_level", is_discount_before_tax: true } : {}),
    ...(tax > 0 || existing ? { adjustment: tax, adjustment_description: await taxLabel(ctx, invoice.tax_rate) } : {}),
  };
  // The lines sent (without Zoho's line ids) replace the ones it has. Sent again, it's the same change.
  const change = async (id: string) => (await zoho(ctx, "PUT", `invoices/${encodeURIComponent(id)}`, body)).invoice;
  // What it comes to there before the tax: the lines less the discount and credits.
  const beforeTax = charged - toCents(discount);
  let theirs: { invoice_id: string; status?: string; total?: number | string };
  if (existing) {
    theirs = { ...(await change(existing)), invoice_id: existing };
  } else {
    // Sent already: Zoho has an invoice for this customer with our number as its reference, dated as
    // ours and coming to what we send. Or to that without the tax, as one sent before the tax went
    // with it did.
    const sent = ((await zoho(ctx, "GET", `invoices?reference_number=${encodeURIComponent(reference)}&customer_id=${encodeURIComponent(customerId)}`)).invoices ?? [])
      .find((i: any) => i.reference_number === reference && i.customer_id === customerId && i.date === invoice.issued_on && [beforeTax, beforeTax + toCents(tax)].includes(toCents(i.total)));
    theirs = sent ?? (await zoho(ctx, "POST", "invoices", body)).invoice;
    await remember(ctx, "invoice", invoiceId, theirs.invoice_id);
    if (sent && toCents(sent.total) !== beforeTax + toCents(tax)) theirs = { ...(await change(theirs.invoice_id)), invoice_id: theirs.invoice_id };
  }
  // Zoho makes an invoice as a draft, which isn't owed in its books and takes no payment. Ours is
  // sent already, so Zoho's is marked sent (that emails nobody). Asked again, it's sent already.
  if (theirs.status === "draft") await zoho(ctx, "POST", `invoices/${encodeURIComponent(theirs.invoice_id)}/status/sent`);
  // An organization can have adjustments turned off, and Zoho then leaves ours out: the invoice is
  // there without its tax, and a payment in full won't fit. Said, with where to turn them on.
  if (tax > 0 && theirs.total !== undefined && toCents(theirs.total) === beforeTax) {
    throw new IntegrationError(`Zoho Books left the tax off invoice #${invoice.number}. Crewtavo sends it as an adjustment: turn on Adjustments in Zoho Books (Settings, Preferences, General), then press Try again.`);
  }
  return theirs.invoice_id;
}

/**
 * Void the books' copy of an invoice voided here. An invoice with payments can't be voided here
 * until they're refunded or removed, and neither of those is sent to the books, so the books may
 * still have a payment on it: both take it off the invoice and keep it as the customer's unapplied
 * credit, for the refund to be entered against by hand. Asked again, it's void already.
 */
async function voidInBooks(ctx: Ctx, externalId: string) {
  const id = encodeURIComponent(externalId);
  if (ctx.provider === "quickbooks") {
    // QuickBooks wants the SyncToken the invoice has now. It keeps a voided invoice, at nothing and noted "Voided".
    const current = (await qbo(ctx, "GET", `invoice/${id}`)).Invoice;
    if (Number(current?.TotalAmt) === 0 && String(current?.PrivateNote ?? "").includes("Voided")) return;
    await qbo(ctx, "POST", "invoice?operation=void", { Id: externalId, SyncToken: current?.SyncToken });
    return;
  }
  const current = (await zoho(ctx, "GET", `invoices/${id}`)).invoice;
  if (current?.status !== "void") await zoho(ctx, "POST", `invoices/${id}/status/void`);
}

/** The tax as the business's documents name it, with the invoice's rate: "VAT (20%)". */
async function taxLabel(ctx: Ctx, rate: number | string | null): Promise<string> {
  const { data: company, error } = await ctx.admin.from("companies").select("country, tax_name:settings->tax_name").eq("id", ctx.companyId).maybeSingle();
  if (error) throw new IntegrationError(error.message);
  return taxLineLabel(taxName(company, company?.country), rate);
}

async function pushPayment(ctx: Ctx, paymentId: string): Promise<string | null> {
  const existing = await linked(ctx, "payment", paymentId);
  if (existing) return existing;
  const payment = await one(
    ctx.admin.from("payments").select("id, client_id, invoice_id, amount, method, received_at").eq("company_id", ctx.companyId).eq("id", paymentId).maybeSingle(),
    "Payment",
  );
  // Refunds are recorded in the books by hand for now. Tips aren't sent: they aren't on the invoice
  // in the books, and sent with the payment they'd sit there as the customer's credit. So a payment
  // that was only a tip (Stripe charged just the tip) has nothing to send; QuickBooks and Zoho
  // refuse a payment of nothing anyway.
  if (Number(payment.amount) <= 0) return null;
  const customerId = await pushClient(ctx, payment.client_id);
  const invoiceExternal = payment.invoice_id ? await pushInvoice(ctx, payment.invoice_id) : null;
  const date = String(payment.received_at).slice(0, 10);

  if (ctx.provider === "quickbooks") {
    // Sent already: QuickBooks has a payment from this customer that day for our amount, on our
    // invoice (or none), that isn't the copy of another of ours: two the same can come in one day.
    // (Its reference number takes 21 characters, too few for our id.)
    const query = encodeURIComponent(`select * from Payment where CustomerRef = '${customerId.replace(/'/g, "\\'")}' and TxnDate = '${date}'`);
    const applied = (p: any) => (p.Line ?? []).flatMap((l: any) => l.LinkedTxn ?? []).map((t: any) => t.TxnId).join();
    let sent: any;
    for (const p of (await qbo(ctx, "GET", `query?query=${query}`)).QueryResponse?.Payment ?? []) {
      if (toCents(p.TotalAmt) !== toCents(payment.amount) || applied(p) !== (invoiceExternal ?? "")) continue;
      if (await linkedElsewhere(ctx, "payment", p.Id, paymentId)) continue;
      sent = p;
      break;
    }
    const created = sent ?? (await qbo(ctx, "POST", "payment", {
      CustomerRef: { value: customerId },
      TotalAmt: Number(payment.amount),
      TxnDate: date,
      Line: invoiceExternal ? [{ Amount: Number(payment.amount), LinkedTxn: [{ TxnId: invoiceExternal, TxnType: "Invoice" }] }] : [],
    })).Payment;
    await remember(ctx, "payment", paymentId, created.Id, created.SyncToken);
    return created.Id;
  }

  // Sent already: Zoho has a payment with our id as its reference.
  const sent = ((await zoho(ctx, "GET", `customerpayments?reference_number=${encodeURIComponent(paymentId)}`)).customerpayments ?? [])
    .find((p: any) => p.reference_number === paymentId);
  if (!sent && invoiceExternal && payment.invoice_id) {
    // Zoho refuses a payment for more than its invoice has left, and one against a draft. Invoices
    // sent before their tax went with them are both, so one like that is brought up to date first.
    const theirs = (await zoho(ctx, "GET", `invoices/${encodeURIComponent(invoiceExternal)}`)).invoice;
    if (theirs && (theirs.status === "draft" || toCents(theirs.balance ?? 0) < toCents(payment.amount))) await pushInvoice(ctx, payment.invoice_id, true);
  }
  const created = sent ?? (await zoho(ctx, "POST", "customerpayments", {
    customer_id: customerId,
    payment_mode: payment.method === "ach" ? "Bank Transfer" : payment.method === "card" ? "Credit Card" : payment.method,
    amount: Number(payment.amount),
    date,
    reference_number: paymentId,
    invoices: invoiceExternal ? [{ invoice_id: invoiceExternal, amount_applied: Number(payment.amount) }] : [],
  })).payment;
  await remember(ctx, "payment", paymentId, created.payment_id);
  return created.payment_id;
}

/**
 * The change was queued for other books than the ones connected now (another QuickBooks company or
 * Zoho organization, or the other app). It isn't sent to these, and trying again won't change that.
 */
export class OtherBooks extends IntegrationError {
  override name = "OtherBooks";
  constructor() {
    super("Queued for other books than the ones connected now. It goes when those are connected again.");
  }
}

const ACCOUNTING: Accounting[] = ["quickbooks", "zoho_books"];

/** Run one outbox row. Throws on failure so the caller can schedule a retry. */
export async function runAccountingJob(env: Env, admin: Db, row: { company_id: string; topic: string; payload: Record<string, string> }) {
  // The books the row was queued for (private.enqueue_accounting). A row that doesn't say goes to
  // whichever accounting app is connected, as they all did before.
  const madeFor = row.payload.account_id ? { provider: row.payload.provider, account: row.payload.account_id } : null;
  const connected = (providers: string[]) =>
    admin
      .from("integrations")
      .select("provider, external_account_id, settings")
      .eq("company_id", row.company_id)
      .in("provider", providers)
      .eq("status", "connected")
      .order("provider")
      .limit(1)
      .maybeSingle();
  const { data: integration, error } = await connected(madeFor?.provider ? [madeFor.provider] : ACCOUNTING);
  if (error) throw new IntegrationError(error.message);
  if (!integration && madeFor) {
    // Its own app is signed out. With the other one connected instead, these aren't its books.
    const other = await connected(ACCOUNTING);
    if (other.error) throw new IntegrationError(other.error.message);
    if (other.data) throw new OtherBooks();
  }
  // Disconnected or waiting to be reconnected since it was queued: fail, so it's retried rather than dropped.
  if (!integration) throw new IntegrationError("The accounting app isn't connected. Reconnect it on the Apps page.");
  if (madeFor && integration.external_account_id !== madeFor.account) throw new OtherBooks();

  const ctx: Ctx = {
    env,
    admin,
    companyId: row.company_id,
    provider: integration.provider as Accounting,
    integration: { external_account_id: integration.external_account_id, settings: (integration.settings ?? {}) as Record<string, unknown> },
  };
  // Queued when it's sent, and again when it changes after: one the books have is updated. Queued as
  // accounting.void when it's voided (private.enqueue_accounting_void), so the version before this
  // one, which would have updated it and called that done, leaves it for this one during an update.
  if (row.topic === "accounting.invoice" || row.topic === "accounting.void") await pushInvoice(ctx, row.payload.invoice_id, true);
  else if (row.topic === "accounting.payment") await pushPayment(ctx, row.payload.payment_id);
  else throw new IntegrationError(`Unknown topic ${row.topic}`);

  // last_error stays: it's about a change that never went through (see drainOutbox in tasks.ts),
  // which this one going through doesn't fix. Reconnecting or disconnecting clears it.
  await admin
    .from("integrations")
    .update({ last_sync_at: new Date().toISOString(), status: "connected" })
    .match({ company_id: row.company_id, provider: integration.provider });
}

/**
 * Changes the task gave up on for these books go again (public.requeue_accounting): after its
 * eight tries, or because other books were connected at the time. For when the owner has fixed
 * what was wrong: on connecting those books again, or Try again on the app's page. Never a change
 * the books took but whose link wasn't saved. Says how many were queued.
 */
export async function retryAccounting(admin: Db, companyId: string, provider: Accounting, account: string): Promise<number> {
  const { data, error } = await admin.rpc("requeue_accounting", { p_company: companyId, p_provider: provider, p_account: account });
  if (error) throw new IntegrationError(error.message);
  return data ?? 0;
}

/** After connecting: find the QuickBooks company name or the Zoho organization. */
export async function describeAccount(env: Env, provider: Provider, token: string, query: Record<string, string>, extra?: Record<string, string>) {
  if (provider === "quickbooks") {
    const realm = query.realmId;
    if (!realm) throw new IntegrationError("QuickBooks didn't return a company ID.");
    const base = serviceUrl(env, "quickbooks", QBO_BASE[qboEnvironment(env, {}, extra)]);
    const response = await fetch(`${base}/v3/company/${realm}/companyinfo/${realm}?minorversion=${QBO_MINOR_VERSION}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: providerTimeout(),
    });
    const json = (await response.json().catch(() => ({}))) as Record<string, any>;
    return { external_account_id: realm, account_label: json.CompanyInfo?.CompanyName ?? `QuickBooks ${realm}` };
  }
  if (provider === "zoho_books") {
    const apiDomain = zohoApiDomain(env, extra?.api_domain);
    const response = await fetch(`${apiDomain}/books/v3/organizations`, { headers: { Authorization: `Zoho-oauthtoken ${token}` }, signal: providerTimeout() });
    const json = (await response.json().catch(() => ({}))) as Record<string, any>;
    const org = json.organizations?.find((o: any) => o.is_default_org) ?? json.organizations?.[0];
    if (!org) throw new IntegrationError("No Zoho Books organization found for that account.");
    return { external_account_id: String(org.organization_id), account_label: org.name as string };
  }
  return { external_account_id: null, account_label: null };
}
