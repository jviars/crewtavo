/**
 * Stripe for a company. A company connects its own secret key on the Apps page (Crewtavo adds the
 * webhook to its Stripe account), or a deployment sets STRIPE_SECRET_KEY for everyone. Then:
 *   - a sent invoice gets a matching Stripe invoice, kept in step by the outbox (syncStripeInvoice)
 *     or made when the client goes to pay from the Client Hub (stripeCheckout);
 *   - webhooks record payments, bank payments on their way, refunds, disputes and deposits, and
 *     bring in invoices made in Stripe (handleStripeEvent);
 *   - importFromStripe brings in past invoices and deposits, quietly.
 * Uses the admin client; every query filters by company.
 */
import type { Env } from "../env";
import { asJson, HttpError } from "../lib/http";
import type { Db } from "../lib/supabase";
import {
  cents,
  chargeOf,
  importedLines,
  paymentMethod,
  STRIPE_VERSION,
  stripeApi,
  stripeDay,
  StripeError,
  stripeLineItems,
  stripeList,
  type BillableInvoice,
  type StripeBalanceTransaction,
  type StripeCharge,
  type StripeEvent,
  type StripeInvoice,
  type StripeInvoiceLine,
  type StripePayout,
} from "../services/stripe";
import { IntegrationError, loadSecret, saveSecret, type StoredSecret } from "./tokens";

/** What the webhook Crewtavo adds to a Stripe account listens for. */
export const STRIPE_EVENTS = [
  "invoice.finalized",
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.voided",
  "invoice.marked_uncollectible",
  "payment_intent.processing",
  "charge.refunded",
  "charge.dispute.created",
  "charge.dispute.closed",
  "payout.created",
  "payout.updated",
  "payout.paid",
  "payout.failed",
  "payout.canceled",
  // Checkout pages opened before invoices went through Stripe can still be paid, and bank
  // payments made on them take days to clear.
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
];

const LIVE = ["creating", "open", "processing"];
const OWED = ["sent", "partially_paid", "overdue"];
export const PROCESSING_MESSAGE = "A bank payment for this invoice is already on its way. It usually clears in a few business days.";

export interface StripeAccess {
  key: string;
  /** The company's own key, from the Apps page (rather than the deployment's). */
  own: boolean;
  webhookSecret?: string;
}

export async function stripeAccess(env: Env, admin: Db, companyId: string): Promise<StripeAccess | null> {
  const secret = await loadSecret(env, admin, companyId, "stripe").catch(() => null);
  if (secret?.api_key) return { key: secret.api_key, own: true, webhookSecret: secret.extra?.webhook_secret };
  return env.STRIPE_SECRET_KEY ? { key: env.STRIPE_SECRET_KEY, own: false } : null;
}

interface Ctx {
  admin: Db;
  companyId: string;
  key: string;
  own: boolean;
  timezone: string;
  currency: string;
}

async function context(env: Env, admin: Db, companyId: string, access?: StripeAccess | null): Promise<Ctx | null> {
  const found = access ?? (await stripeAccess(env, admin, companyId));
  if (!found) return null;
  const { data: company } = await admin.from("companies").select("timezone, currency").eq("id", companyId).maybeSingle();
  if (!company) return null;
  return { admin, companyId, key: found.key, own: found.own, timezone: company.timezone || "UTC", currency: (company.currency || "USD").toLowerCase() };
}

function fail(error: { message: string } | null) {
  if (error) throw new IntegrationError(error.message);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const isoAt = (seconds: number | null | undefined) => new Date((seconds ?? Date.now() / 1000) * 1000).toISOString();

// ---------------------------------------------------------------------------------------------
// Connecting
// ---------------------------------------------------------------------------------------------

interface StripeAccount {
  id: string;
  email?: string | null;
  business_profile?: { name?: string | null } | null;
  settings?: { dashboard?: { display_name?: string | null } | null } | null;
}

/** Stripe only sends webhooks to public https addresses. */
const reachable = (base: string) => /^https:\/\//.test(base) && !/^https:\/\/(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(base);

/**
 * Check a secret key, add (or replace) Crewtavo's webhook in that Stripe account, and store both
 * encrypted. Without a public address (local development) the key is saved without a webhook.
 */
export async function connectStripe(env: Env, admin: Db, input: { companyId: string; userId: string; key: string; baseUrl: string }) {
  const key = input.key.trim();
  if (!/^(sk|rk)_(live|test)_\w+$/.test(key)) {
    throw new HttpError(400, "That isn't a Stripe secret key. Copy the one that starts with sk_live_ from Developers → API keys in Stripe.");
  }
  let account: StripeAccount | null = null;
  try {
    account = await stripeApi<StripeAccount>(key, "GET", "/v1/account");
  } catch (error) {
    if (error instanceof StripeError && error.status === 401) throw new HttpError(400, "Stripe didn't accept that key. Copy it again from Developers → API keys in Stripe.");
    // A restricted key may not be allowed to read the account. Adding the webhook still tests it.
    if (!(error instanceof StripeError && error.status === 403)) throw error;
  }

  const previous = await loadSecret(env, admin, input.companyId, "stripe").catch(() => null);
  if (previous) await removeStripeWebhook(previous);
  let webhook: { id: string; secret: string } | null = null;
  const url = `${input.baseUrl}/api/webhooks/stripe/${input.companyId}`;
  if (reachable(input.baseUrl)) {
    try {
      for await (const endpoint of stripeList<{ id: string; url: string }>(key, "/v1/webhook_endpoints")) {
        if (endpoint.url === url) await stripeApi(key, "DELETE", `/v1/webhook_endpoints/${endpoint.id}`);
      }
      webhook = await stripeApi<{ id: string; secret: string }>(key, "POST", "/v1/webhook_endpoints", {
        url,
        enabled_events: STRIPE_EVENTS,
        api_version: STRIPE_VERSION,
        description: "Crewtavo: invoices, payments and deposits",
        metadata: { crewtavo_company_id: input.companyId },
      });
    } catch (error) {
      if (error instanceof StripeError && (error.status === 401 || error.status === 403)) {
        throw new HttpError(400, "That key can't add a webhook. Use your standard secret key, or a restricted key that can write webhook endpoints, customers, invoices and invoice items.");
      }
      throw new HttpError(400, `Stripe wouldn't add the webhook: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const label = account?.settings?.dashboard?.display_name || account?.business_profile?.name || account?.email || "Stripe account";
  const { data: existing } = await admin.from("integrations").select("settings, external_account_id").match({ company_id: input.companyId, provider: "stripe" }).maybeSingle();
  // The last import's summary belongs to the account it came from.
  const keep = existing?.external_account_id && existing.external_account_id === account?.id ? ((existing.settings ?? {}) as Record<string, unknown>) : {};
  const { error } = await admin.from("integrations").upsert({
    company_id: input.companyId,
    provider: "stripe",
    status: "connected",
    account_label: label,
    external_account_id: account?.id ?? null,
    settings: asJson({ ...keep, livemode: key.includes("_live_"), webhook: Boolean(webhook) }),
    connected_by: input.userId,
    connected_at: new Date().toISOString(),
    last_error: null,
  });
  fail(error);
  await saveSecret(env, admin, input.companyId, "stripe", { api_key: key, extra: webhook ? { webhook_id: webhook.id, webhook_secret: webhook.secret } : {} });
  return { account_label: label, webhook: Boolean(webhook) };
}

/** Best effort: take Crewtavo's webhook out of the Stripe account before forgetting the key. */
export async function removeStripeWebhook(secret: StoredSecret) {
  if (!secret.api_key || !secret.extra?.webhook_id) return;
  await stripeApi(secret.api_key, "DELETE", `/v1/webhook_endpoints/${secret.extra.webhook_id}`).catch(() => undefined);
}

// ---------------------------------------------------------------------------------------------
// Crewtavo invoices in Stripe
// ---------------------------------------------------------------------------------------------

type Billable = BillableInvoice & { id: string; status: string; notes: string | null; client_id: string; due_on: string | null };
const BILLABLE =
  "id, number, status, subject, notes, client_id, due_on, subtotal, discount_amount, tax_rate, tax_amount, retainage_pct, retainage_amount, amount_paid, balance_due, promo:promo_codes(code), lines:invoice_line_items(name, quantity, unit, unit_price, sort)";

async function billable(ctx: Ctx, invoiceId: string): Promise<Billable | null> {
  const { data, error } = await ctx.admin.from("invoices").select(BILLABLE).eq("company_id", ctx.companyId).eq("id", invoiceId).maybeSingle();
  fail(error);
  return data as unknown as Billable | null;
}

interface Linked {
  id: string;
  stripe_id: string | null;
  origin: string;
  status: string;
  amount_due: number;
  tip_amount: number;
  hosted_url: string | null;
  created_at: string;
}
const LINKED = "id, stripe_id, origin, status, amount_due, tip_amount, hosted_url, created_at";

/** An invoice's Stripe invoices, newest first, and the live one (if any). */
async function linkedTo(ctx: Ctx, invoiceId: string): Promise<{ linked: Linked[]; live: Linked | undefined }> {
  const { data, error } = await ctx.admin.from("stripe_invoices").select(LINKED).eq("company_id", ctx.companyId).eq("invoice_id", invoiceId).order("created_at", { ascending: false });
  fail(error);
  const linked = data ?? [];
  const live = linked.find((row) => LIVE.includes(row.status));
  // Still "creating" after two minutes: the server stopped partway. Clear it so it can be made again.
  if (live?.status === "creating" && Date.now() - Date.parse(live.created_at) > 2 * 60_000) {
    if (live.stripe_id) {
      await stripeApi(ctx.key, "DELETE", `/v1/invoices/${live.stripe_id}`).catch(() => stripeApi(ctx.key, "POST", `/v1/invoices/${live.stripe_id}/void_invoice`).catch(() => undefined));
    }
    await ctx.admin.from("stripe_invoices").delete().eq("id", live.id).eq("status", "creating");
    return { linked: linked.filter((row) => row.id !== live.id), live: undefined };
  }
  return { linked, live };
}

/** The client's Stripe customer: linked already, the customer with their email, or a new one. */
async function customerFor(ctx: Ctx, clientId: string, again = false): Promise<string> {
  const link = { company_id: ctx.companyId, provider: "stripe", entity: "client", local_id: clientId };
  if (!again) {
    const { data } = await ctx.admin.from("sync_links").select("external_id").match(link).maybeSingle();
    if (data) return data.external_id;
  }
  const { data: client, error } = await ctx.admin.from("clients").select("display_name, email, phone").eq("company_id", ctx.companyId).eq("id", clientId).maybeSingle();
  fail(error);
  if (!client) throw new IntegrationError("Client not found");
  // Businesses moving from Stripe invoicing already have their clients there.
  let id = client.email ? (await stripeApi<{ data: Array<{ id: string }> }>(ctx.key, "GET", "/v1/customers", { email: client.email, limit: 1 })).data[0]?.id : undefined;
  id ??= (await stripeApi<{ id: string }>(ctx.key, "POST", "/v1/customers", { name: client.display_name, email: client.email, phone: client.phone, metadata: { crewtavo_client_id: clientId } })).id;
  fail((await ctx.admin.from("sync_links").upsert({ ...link, external_id: id, synced_at: new Date().toISOString() })).error);
  return id;
}

/**
 * Make the Stripe invoice for what's owed now (plus a tip), finalized but not emailed by Stripe:
 * Crewtavo sends the invoice, and the Client Hub's Pay button opens Stripe's page for it.
 * Returns null when another request is already making one.
 */
async function createStripeInvoice(ctx: Ctx, invoice: Billable, tipCents: number): Promise<Linked | null> {
  const amount = cents(invoice.balance_due) + tipCents;
  const { data: row, error } = await ctx.admin
    .from("stripe_invoices")
    .insert({ company_id: ctx.companyId, invoice_id: invoice.id, origin: "crewtavo", status: "creating", amount_due: amount / 100, tip_amount: tipCents / 100 })
    .select(LINKED)
    .single();
  if (error?.code === "23505") return null;
  fail(error);
  if (!row) return null;

  let stripeId: string | null = null;
  try {
    const params = (customer: string) => ({
      customer,
      currency: ctx.currency,
      collection_method: "send_invoice",
      auto_advance: false,
      pending_invoice_items_behavior: "exclude",
      // Stripe wants a due date in the future; one that has passed shows as due now.
      due_date: Math.max(invoice.due_on ? Math.floor(Date.parse(`${invoice.due_on}T23:00:00Z`) / 1000) : 0, Math.floor(Date.now() / 1000) + 3600),
      description: invoice.notes?.slice(0, 1500) || undefined,
      custom_fields: [{ name: "Invoice", value: `#${invoice.number}` }],
      metadata: { crewtavo_company_id: ctx.companyId, crewtavo_invoice_id: invoice.id, crewtavo_row: row.id, tip_cents: String(tipCents) },
    });
    let customer = await customerFor(ctx, invoice.client_id);
    let draft: StripeInvoice;
    try {
      draft = await stripeApi<StripeInvoice>(ctx.key, "POST", "/v1/invoices", params(customer), { idempotencyKey: `crewtavo-invoice-${row.id}` });
    } catch (error) {
      if (!(error instanceof StripeError && error.code === "resource_missing" && error.param === "customer")) throw error;
      // The customer was deleted in Stripe: make a new one.
      customer = await customerFor(ctx, invoice.client_id, true);
      draft = await stripeApi<StripeInvoice>(ctx.key, "POST", "/v1/invoices", params(customer), { idempotencyKey: `crewtavo-invoice-${row.id}-again` });
    }
    stripeId = draft.id;
    fail((await ctx.admin.from("stripe_invoices").update({ stripe_id: draft.id, livemode: draft.livemode }).eq("id", row.id)).error);
    for (const [i, item] of stripeLineItems(invoice, tipCents, ctx.currency.toUpperCase()).entries()) {
      await stripeApi(ctx.key, "POST", "/v1/invoiceitems", { customer, invoice: draft.id, currency: ctx.currency, amount: item.amount, description: item.description }, { idempotencyKey: `crewtavo-item-${row.id}-${i}` });
    }
    const final = await stripeApi<StripeInvoice>(ctx.key, "POST", `/v1/invoices/${draft.id}/finalize`, { auto_advance: false }, { idempotencyKey: `crewtavo-finalize-${row.id}` });
    const done = { status: "open", number: final.number, hosted_url: final.hosted_invoice_url };
    fail((await ctx.admin.from("stripe_invoices").update(done).eq("id", row.id)).error);
    return { ...row, ...done, stripe_id: final.id };
  } catch (error) {
    // Leave nothing half made. Drafts can be deleted outright.
    if (stripeId) await stripeApi(ctx.key, "DELETE", `/v1/invoices/${stripeId}`).catch(() => undefined);
    await ctx.admin.from("stripe_invoices").delete().eq("id", row.id);
    throw error;
  }
}

const fetchInvoice = (key: string, id: string) => stripeApi<StripeInvoice>(key, "GET", `/v1/invoices/${id}`, { expand: ["charge.balance_transaction"] });

/** Void an open Stripe invoice. False when it turns out to be paid (and that's recorded instead). */
async function voidStripeInvoice(ctx: Ctx, row: Linked): Promise<boolean> {
  if (!row.stripe_id) return false;
  try {
    await stripeApi(ctx.key, "POST", `/v1/invoices/${row.stripe_id}/void_invoice`);
  } catch (error) {
    const current = await fetchInvoice(ctx.key, row.stripe_id).catch(() => null);
    if (current?.status === "paid") {
      await applyInvoice(ctx, current);
      return false;
    }
    if (current?.status !== "void") throw error;
  }
  fail((await ctx.admin.from("stripe_invoices").update({ status: "void" }).eq("id", row.id)).error);
  return true;
}

/**
 * Bring an invoice's Stripe invoice in step with it (the outbox's stripe.invoice job). Ours are
 * replaced when the balance changes and voided once nothing is owed; ones made in Stripe are
 * voided there once they're paid or voided here.
 */
export async function syncStripeInvoice(env: Env, admin: Db, companyId: string, invoiceId: string): Promise<string> {
  const ctx = await context(env, admin, companyId);
  if (!ctx) return "Stripe isn't connected";
  const invoice = await billable(ctx, invoiceId);
  if (!invoice) return "invoice deleted";
  const { linked, live } = await linkedTo(ctx, invoiceId);
  const imported = linked.some((row) => row.origin === "stripe");
  const owed = OWED.includes(invoice.status) && cents(invoice.balance_due) > 0;

  // A bank payment on its way, or another request making the Stripe invoice: leave it be.
  if (live && live.status !== "open") return "busy";
  const stale = !owed || (!imported && cents(live?.amount_due) - cents(live?.tip_amount) !== cents(invoice.balance_due));
  if (live && !stale) return "in step";
  if (live && !(await voidStripeInvoice(ctx, live))) return "paid in Stripe";
  // Ones made in Stripe stay Stripe's. Ours go to Stripe when sent, for companies with their own key.
  if (imported || !owed || !ctx.own) return live ? "voided" : "nothing to do";
  await createStripeInvoice(ctx, invoice, 0);
  return "created";
}

/** The Stripe page where the client pays this invoice (plus an optional tip), made if needed. */
export async function stripeCheckout(env: Env, admin: Db, companyId: string, invoiceId: string, tipCents: number): Promise<string> {
  const ctx = await context(env, admin, companyId);
  if (!ctx) throw new HttpError(501, "Online payments aren't set up.");
  for (let attempt = 0; attempt < 6; attempt++) {
    const invoice = await billable(ctx, invoiceId);
    if (!invoice) throw new HttpError(404, "Invoice not found.");
    if (invoice.status === "void") throw new HttpError(409, "This invoice was cancelled, so it can't be paid.");
    if (invoice.status === "draft") throw new HttpError(409, "This invoice isn't ready yet.");
    if (cents(invoice.balance_due) <= 0) throw new HttpError(409, "This invoice is already paid.");
    const { linked, live } = await linkedTo(ctx, invoiceId);
    if (live?.status === "processing") throw new HttpError(409, PROCESSING_MESSAGE);
    if (live?.status === "creating") {
      await sleep(1500);
      continue;
    }
    // Made in Stripe: pay it there, as long as it still asks for what's owed.
    if (linked.some((row) => row.origin === "stripe")) {
      if (live?.hosted_url && cents(live.amount_due) === cents(invoice.balance_due)) return live.hosted_url;
      throw new HttpError(409, "This invoice can't be paid online right now. Contact us to pay it.");
    }
    if (live?.hosted_url && cents(live.amount_due) === cents(invoice.balance_due) + tipCents) return live.hosted_url;
    if (live && !(await voidStripeInvoice(ctx, live))) throw new HttpError(409, "This invoice is already paid.");
    const made = await createStripeInvoice(ctx, invoice, tipCents);
    if (made?.hosted_url) return made.hosted_url;
    await sleep(1500);
  }
  throw new HttpError(503, "Online payments are busy. Try again in a minute.");
}

/** For the Client Hub: can this invoice be paid online, and is a bank payment already on its way? */
export async function hubPayment(env: Env, admin: Db, companyId: string, invoiceId: string) {
  const [access, { data: linked }] = await Promise.all([
    stripeAccess(env, admin, companyId),
    admin.from("stripe_invoices").select("origin, status").eq("company_id", companyId).eq("invoice_id", invoiceId),
  ]);
  return {
    enabled: Boolean(access),
    processing: (linked ?? []).some((row) => row.status === "processing"),
    imported: (linked ?? []).some((row) => row.origin === "stripe"),
  };
}

// ---------------------------------------------------------------------------------------------
// Invoices paid, voided or made in Stripe
// ---------------------------------------------------------------------------------------------

async function applyInvoice(ctx: Ctx, invoice: StripeInvoice) {
  if (invoice.metadata?.crewtavo_invoice_id) return settleOwnInvoice(ctx, invoice);
  await importInvoice(ctx, invoice, false);
}

/** One of ours changed in Stripe: record the payment, or that it was voided or written off. */
async function settleOwnInvoice(ctx: Ctx, invoice: StripeInvoice) {
  const meta = invoice.metadata ?? {};
  if (meta.crewtavo_company_id !== ctx.companyId) return;
  let { data: row } = await ctx.admin.from("stripe_invoices").select("id, status, stripe_id").eq("stripe_id", invoice.id).maybeSingle();
  if (!row && meta.crewtavo_row) {
    row = (await ctx.admin.from("stripe_invoices").select("id, status, stripe_id").eq("company_id", ctx.companyId).eq("id", meta.crewtavo_row).maybeSingle()).data;
    if (row && !row.stripe_id) await ctx.admin.from("stripe_invoices").update({ stripe_id: invoice.id }).eq("id", row.id);
  }

  if (invoice.status === "paid") await recordPayment(ctx, invoice);
  const status = invoice.status === "paid" || invoice.status === "void" || invoice.status === "uncollectible" ? invoice.status : null;
  if (row && status && row.status !== status) await ctx.admin.from("stripe_invoices").update({ status }).eq("id", row.id);
}

/** A payment on one of our Stripe invoices, as a Crewtavo payment (with its tip and fee). */
async function recordPayment(ctx: Ctx, invoice: StripeInvoice) {
  const meta = invoice.metadata ?? {};
  const { data: target } = await ctx.admin.from("invoices").select("id, number, client_id, status").eq("company_id", ctx.companyId).eq("id", meta.crewtavo_invoice_id!).maybeSingle();
  if (!target) return;
  const tip = Math.max(0, Number(meta.tip_cents) || 0);
  const payments: Array<{ amount: number; tip_amount?: number; method: string; processor: string | null; processor_ref: string; fee_amount?: number; notes?: string }> = [];
  if (invoice.paid_out_of_band) {
    // Marked paid in the Stripe dashboard: money that came some other way, so it stays editable.
    payments.push({ amount: (invoice.amount_due - tip) / 100, method: "other", processor: null, processor_ref: `${invoice.id}:paid`, notes: "Marked paid in Stripe" });
  } else {
    const { charge, fee } = chargeOf(invoice);
    if (invoice.amount_paid - tip > 0) {
      payments.push({
        amount: (invoice.amount_paid - tip) / 100, tip_amount: tip / 100, method: paymentMethod(charge), processor: "stripe",
        processor_ref: invoice.payment_intent ?? charge?.id ?? `${invoice.id}:paid`, fee_amount: fee / 100,
      });
    }
    // Credit the customer had in Stripe covered part of it.
    const credit = invoice.total - invoice.amount_due;
    if (credit > 0) payments.push({ amount: credit / 100, method: "other", processor: null, processor_ref: `${invoice.id}:credit`, notes: "Account credit in Stripe" });
  }
  if (!payments.length) return;
  // Paid after it was voided here (a bank payment that was already on its way): a void invoice
  // stays void, so the money is the client's, with a note saying which invoice it was for.
  const voided = target.status === "void";
  for (const payment of payments) {
    // processor_ref is unique, so Stripe repeating an event can't record a payment twice.
    const { error } = await ctx.admin.from("payments").insert({
      company_id: ctx.companyId, invoice_id: voided ? null : target.id, client_id: target.client_id, received_at: isoAt(invoice.status_transitions.paid_at), recorded_by: null, ...payment,
      ...(voided ? { notes: [payment.notes, `For invoice #${target.number}, which is void`].filter(Boolean).join(". ") } : {}),
    });
    if (error && error.code !== "23505") fail(error);
  }
}

/** A bank payment bounced (card declines don't count): it's owed again, and the office hears about it. */
async function bankPaymentFailed(ctx: Ctx, invoice: StripeInvoice) {
  const { data: row } = await ctx.admin
    .from("stripe_invoices")
    .select("id, status, invoice:invoices(id, number, client_id)")
    .eq("company_id", ctx.companyId)
    .eq("stripe_id", invoice.id)
    .maybeSingle();
  if (row?.status !== "processing") return;
  await ctx.admin.from("stripe_invoices").update({ status: "open" }).eq("id", row.id);
  const target = row.invoice as unknown as { id: string; number: number; client_id: string } | null;
  if (!target) return;
  await noteOnClient(ctx.admin, {
    company_id: ctx.companyId, client_id: target.client_id, invoice_id: target.id, key: `${invoice.id}:failed:${invoice.payment_intent ?? ""}`,
    subject: "Bank payment failed", body: `The bank payment for invoice #${target.number} didn't go through. The invoice is still owed.`,
  });
}

/** An invoice made in Stripe, brought in or brought up to date. History comes in quietly. */
async function importInvoice(ctx: Ctx, invoice: StripeInvoice, quiet: boolean) {
  if (invoice.status === "draft" || (!invoice.total && !invoice.amount_due)) return;
  const lines = invoice.lines.has_more ? await allLines(ctx.key, invoice.id) : invoice.lines.data;
  const { charge, fee } = chargeOf(invoice);
  const paidAt = isoAt(invoice.status_transitions.paid_at);
  const payment =
    invoice.status !== "paid" ? null
    : invoice.paid_out_of_band ? { amount: invoice.amount_due / 100, method: "other", processor_ref: `${invoice.id}:paid`, received_at: paidAt, out_of_band: true }
    : {
        amount: invoice.amount_paid / 100, method: paymentMethod(charge), processor_ref: invoice.payment_intent ?? charge?.id ?? `${invoice.id}:paid`,
        received_at: paidAt, fee: fee / 100, refunded: (charge?.amount_refunded ?? 0) / 100,
      };
  const sent = invoice.status_transitions.finalized_at ?? invoice.created;
  const { error } = await ctx.admin.rpc("stripe_import_invoice", {
    p_company: ctx.companyId,
    p_quiet: quiet,
    p_data: asJson({
      stripe_id: invoice.id,
      number: invoice.number,
      status: invoice.status,
      livemode: invoice.livemode,
      hosted_url: invoice.hosted_invoice_url,
      amount_due: invoice.amount_due / 100,
      issued_on: stripeDay(sent, ctx.timezone),
      due_on: invoice.due_date ? stripeDay(invoice.due_date, ctx.timezone) : null,
      sent_at: isoAt(sent),
      subject: invoice.description?.split("\n")[0]?.trim().slice(0, 200) || `Stripe invoice ${invoice.number ?? ""}`.trim(),
      customer: { id: invoice.customer, name: invoice.customer_name, email: invoice.customer_email, phone: invoice.customer_phone, address: invoice.customer_address },
      lines: importedLines(invoice, lines),
      payment,
    }),
  });
  fail(error);
}

async function allLines(key: string, invoiceId: string): Promise<StripeInvoiceLine[]> {
  const lines: StripeInvoiceLine[] = [];
  for await (const line of stripeList<StripeInvoiceLine>(key, `/v1/invoices/${invoiceId}/lines`)) lines.push(line);
  return lines;
}

// ---------------------------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------------------------

/** Where an event came in: a company's own webhook, or the deployment's (STRIPE_WEBHOOK_SECRET). */
export type WebhookRoute = { companyId?: string };

/**
 * Handle one verified event. Objects are read back from Stripe at our pinned API version (the
 * event may be old, or rendered at another version). Returns the company it touched, if any.
 */
export async function handleStripeEvent(env: Env, admin: Db, route: WebhookRoute, event: StripeEvent): Promise<string | null> {
  const object = event.data.object;
  const key = route.companyId ? ((await stripeAccess(env, admin, route.companyId))?.key ?? null) : (env.STRIPE_SECRET_KEY ?? null);
  if (event.type.startsWith("checkout.session.")) return checkoutSession(admin, route, event.type, object);
  if (event.type === "payment_intent.processing") return bankPaymentStarted(admin, route, object.invoice as string | null);
  if (event.type === "charge.refunded") return refunded(admin, route, object as StripeCharge);
  if (event.type === "charge.dispute.created" || event.type === "charge.dispute.closed") return disputed(admin, route, event.type, object as Dispute);
  if (!key) return null;

  if (event.type.startsWith("invoice.")) {
    const invoice = await fetchInvoice(key, object.id as string);
    const companyId = await companyFor(env, admin, route, invoice.metadata?.crewtavo_company_id);
    const ctx = companyId ? await context(env, admin, companyId, { key, own: Boolean(route.companyId) }) : null;
    if (!ctx) return null;
    if (event.type === "invoice.payment_failed") await bankPaymentFailed(ctx, invoice);
    else await applyInvoice(ctx, invoice);
    return ctx.companyId;
  }
  if (event.type.startsWith("payout.")) {
    const companyId = await companyFor(env, admin, route);
    const ctx = companyId ? await context(env, admin, companyId, { key, own: Boolean(route.companyId) }) : null;
    if (!ctx) return null;
    await savePayout(ctx, await stripeApi<StripePayout>(key, "GET", `/v1/payouts/${object.id}`));
    return ctx.companyId;
  }
  return null;
}

/**
 * The company an event belongs to. A company's own webhook is only ever about that company. On the
 * deployment's, our metadata says, or (for invoices made in Stripe and deposits) the instance's
 * only company, as long as it hasn't connected a Stripe account of its own.
 */
async function companyFor(env: Env, admin: Db, route: WebhookRoute, fromMetadata?: string | null): Promise<string | null> {
  if (route.companyId) return !fromMetadata || fromMetadata === route.companyId ? route.companyId : null;
  if (fromMetadata) return fromMetadata;
  const { data } = await admin.from("companies").select("id").limit(2);
  if (data?.length !== 1) return null;
  const own = await loadSecret(env, admin, data[0]!.id, "stripe").catch(() => null);
  return own?.api_key ? null : data[0]!.id;
}

async function noteOnClient(admin: Db, note: { company_id: string; client_id: string; invoice_id: string | null; key: string; subject: string; body: string }) {
  const { data: noted } = await admin.from("messages").select("id").eq("company_id", note.company_id).eq("external_id", note.key).limit(1);
  if (noted?.length) return;
  await admin.from("messages").insert({
    company_id: note.company_id, client_id: note.client_id, channel: "note", direction: "internal", status: "received", subject: note.subject, body: note.body,
    related_type: note.invoice_id ? "invoice" : null, related_id: note.invoice_id, sent_by: null, external_id: note.key,
  });
}

/** A bank (ACH) payment started on a Stripe invoice: it takes a few days, so say so instead of asking again. */
async function bankPaymentStarted(admin: Db, route: WebhookRoute, stripeInvoiceId: string | null) {
  if (!stripeInvoiceId) return null;
  const { data: row } = await admin.from("stripe_invoices").select("id, company_id").eq("stripe_id", stripeInvoiceId).maybeSingle();
  if (!row || (route.companyId && row.company_id !== route.companyId)) return null;
  await admin.from("stripe_invoices").update({ status: "processing" }).eq("id", row.id).eq("status", "open");
  return row.company_id;
}

/** Checkout pages from before invoices went through Stripe: card payments, and bank payments days later. */
async function checkoutSession(admin: Db, route: WebhookRoute, type: string, object: Record<string, any>) {
  const { company_id, invoice_id, tip_cents } = (object.metadata ?? {}) as Record<string, string>;
  if (!company_id || !invoice_id || (route.companyId && company_id !== route.companyId)) return null;
  const { data: invoice } = await admin.from("invoices").select("client_id, number").eq("company_id", company_id).eq("id", invoice_id).maybeSingle();
  if (!invoice) return null;

  if ((type === "checkout.session.completed" && object.payment_status === "paid") || type === "checkout.session.async_payment_succeeded") {
    const tip = Math.max(0, Number(tip_cents ?? 0));
    const { error } = await admin.from("payments").insert({
      company_id, invoice_id, client_id: invoice.client_id,
      amount: (Number(object.amount_total) - tip) / 100, tip_amount: tip / 100,
      method: type === "checkout.session.async_payment_succeeded" ? "ach" : "card",
      processor: "stripe", processor_ref: object.payment_intent ?? object.id, recorded_by: null,
    });
    if (error && error.code !== "23505") fail(error);
  }
  if (type === "checkout.session.async_payment_failed") {
    await noteOnClient(admin, {
      company_id, client_id: invoice.client_id, invoice_id, key: `${object.id}:failed`,
      subject: "Bank payment failed", body: `The bank payment for invoice #${invoice.number} didn't go through. The invoice is still owed.`,
    });
  }
  return company_id;
}

/** Refunds made in Stripe show up as negative payments. Each refunded total is recorded once. */
async function refunded(admin: Db, route: WebhookRoute, charge: StripeCharge) {
  if (!charge.payment_intent) return null;
  const { data: paid } = await admin.from("payments").select("company_id, client_id, invoice_id, method, amount, tip_amount").eq("processor_ref", charge.payment_intent).maybeSingle();
  if (!paid || (route.companyId && paid.company_id !== route.companyId)) return null;
  const { amount: paidAmount, tip_amount: paidTip, ...original } = paid;
  const prefix = `${charge.payment_intent}:refund:`;
  const { data: earlier } = await admin.from("payments").select("amount, tip_amount").like("processor_ref", `${prefix}%`);
  const refundedAmount = -(earlier ?? []).reduce((sum, p) => sum + cents(p.amount), 0);
  const refundedTip = -(earlier ?? []).reduce((sum, p) => sum + cents(p.tip_amount), 0);
  // Stripe's total includes the tip, which the payment keeps apart from what the invoice was
  // paid: a refund comes off the invoice first, then the tip.
  const newly = Number(charge.amount_refunded ?? 0) - refundedAmount - refundedTip;
  const amount = Math.min(newly, cents(paidAmount) - refundedAmount);
  const tip = Math.max(0, Math.min(newly - amount, cents(paidTip) - refundedTip));
  // (A refund of only the tip, once the invoice part was all refunded, has no invoice amount to
  // record; payments can't be zero.)
  if (amount > 0) {
    const { error } = await admin.from("payments").insert({
      ...original, amount: -amount / 100, tip_amount: -tip / 100, processor: "stripe", processor_ref: `${prefix}${charge.amount_refunded}`, notes: "Refunded in Stripe", recorded_by: null,
    });
    if (error && error.code !== "23505") fail(error);
  }
  return paid.company_id;
}

interface Dispute {
  id: string;
  amount: number;
  charge: string;
  payment_intent: string | null;
  status: string;
  reason: string;
  evidence_details?: { due_by: number | null } | null;
}

/** A client disputed a card payment with their bank: tell the office, and take it back if it's lost. */
async function disputed(admin: Db, route: WebhookRoute, type: string, dispute: Dispute) {
  const ref = dispute.payment_intent ?? dispute.charge;
  const { data: original } = await admin.from("payments").select("company_id, client_id, invoice_id, method, invoice:invoices(number)").eq("processor_ref", ref).maybeSingle();
  if (!original || (route.companyId && original.company_id !== route.companyId)) return null;
  const number = (original.invoice as unknown as { number: number } | null)?.number;
  const amount = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(dispute.amount / 100);
  const on = number ? ` on invoice #${number}` : "";
  const note = (suffix: string, subject: string, body: string) =>
    noteOnClient(admin, { company_id: original.company_id, client_id: original.client_id, invoice_id: original.invoice_id, key: `${dispute.id}:${suffix}`, subject, body });

  if (type === "charge.dispute.created") {
    const due = dispute.evidence_details?.due_by ? ` by ${new Date(dispute.evidence_details.due_by * 1000).toLocaleDateString("en-US", { month: "long", day: "numeric" })}` : "";
    await note("opened", "Payment disputed", `The client disputed the ${amount} payment${on} with their bank (${dispute.reason.replace(/_/g, " ")}). Stripe holds the money until it's settled. Respond in Stripe${due} to keep it.`);
  } else if (dispute.status === "lost") {
    const { error } = await admin.from("payments").insert({
      company_id: original.company_id, client_id: original.client_id, invoice_id: original.invoice_id, method: original.method,
      amount: -dispute.amount / 100, processor: "stripe", processor_ref: `${ref}:dispute:${dispute.id}`, notes: "Dispute lost in Stripe", recorded_by: null,
    });
    if (error && error.code !== "23505") fail(error);
    await note("lost", "Dispute lost", `The bank sided with the client on the ${amount} payment${on}, so that money went back to them. The invoice is owed again.`);
  } else if (dispute.status === "won") {
    await note("won", "Dispute won", `The bank sided with you on the ${amount} payment${on}. The money stays with you.`);
  }
  return original.company_id;
}

// ---------------------------------------------------------------------------------------------
// Deposits (payouts)
// ---------------------------------------------------------------------------------------------

/** Record a deposit (and match it to payments once it's paid). True when it's new here. */
async function savePayout(ctx: Ctx, payout: StripePayout): Promise<boolean> {
  const { data: existing } = await ctx.admin.from("payouts").select("id, company_id, itemized_at").eq("processor_ref", payout.id).maybeSingle();
  if (existing && existing.company_id !== ctx.companyId) return false;
  const values = {
    company_id: ctx.companyId, processor: "stripe", processor_ref: payout.id, amount: payout.amount / 100, currency: payout.currency,
    // Stripe gives the arrival day as midnight UTC.
    status: payout.status, arrival_on: new Date(payout.arrival_date * 1000).toISOString().slice(0, 10), failure_message: payout.failure_message,
  };
  const { data: row, error } = existing
    ? await ctx.admin.from("payouts").update(values).eq("id", existing.id).select("id, itemized_at").single()
    : await ctx.admin.from("payouts").insert(values).select("id, itemized_at").single();
  fail(error);
  // Only automatic payouts can be broken down into the payments in them.
  if (row && payout.status === "paid" && payout.automatic && !row.itemized_at) await itemizePayout(ctx, row.id, payout.id);
  return !existing;
}

/** Match a deposit's transactions to payments: each gets its fee and the deposit it arrived in. */
async function itemizePayout(ctx: Ctx, payoutRowId: string, payoutId: string) {
  let gross = 0;
  let fees = 0;
  const charges = new Map<string, number>();
  const refunds = new Set<string>();
  for await (const bt of stripeList<StripeBalanceTransaction>(ctx.key, "/v1/balance_transactions", { payout: payoutId, expand: ["data.source"] })) {
    if (bt.type === "payout") continue;
    fees += bt.fee;
    const source = bt.source && typeof bt.source === "object" ? bt.source : null;
    if (bt.type === "charge" || bt.type === "payment") {
      gross += bt.amount;
      const ref = source?.payment_intent ?? source?.id;
      if (ref) charges.set(ref, (charges.get(ref) ?? 0) + bt.fee);
    } else if ((bt.type === "refund" || bt.type === "payment_refund") && source?.payment_intent) {
      refunds.add(source.payment_intent);
    }
  }
  for (const [ref, fee] of charges) {
    await ctx.admin.from("payments").update({ fee_amount: fee / 100, payout_id: payoutRowId }).eq("company_id", ctx.companyId).eq("processor_ref", ref);
  }
  for (const intent of refunds) {
    await ctx.admin.from("payments").update({ payout_id: payoutRowId }).eq("company_id", ctx.companyId).like("processor_ref", `${intent}:refund:%`);
  }
  fail((await ctx.admin.from("payouts").update({ gross_amount: gross / 100, fee_amount: fees / 100, itemized_at: new Date().toISOString() }).eq("id", payoutRowId)).error);
}

// ---------------------------------------------------------------------------------------------
// Importing history
// ---------------------------------------------------------------------------------------------

export interface ImportState {
  status: "running" | "done" | "failed";
  since: string | null;
  started_at: string;
  finished_at?: string;
  error?: string;
  counts: { invoices: number; payments: number; clients: number; payouts: number };
}

async function saveImportState(admin: Db, companyId: string, state: ImportState) {
  const { data } = await admin.from("integrations").select("settings").match({ company_id: companyId, provider: "stripe" }).maybeSingle();
  await admin.from("integrations").update({ settings: asJson({ ...((data?.settings ?? {}) as Record<string, unknown>), import: state }) }).match({ company_id: companyId, provider: "stripe" });
}

/** An import that hasn't reported in this long died with its server. */
export const IMPORT_STALE_MS = 30 * 60_000;

/** Mark an import as started before it runs in the background, so a second click is refused. */
export async function beginStripeImport(admin: Db, companyId: string, since: string | null): Promise<ImportState> {
  const state: ImportState = { status: "running", since, started_at: new Date().toISOString(), counts: { invoices: 0, payments: 0, clients: 0, payouts: 0 } };
  await saveImportState(admin, companyId, state);
  return state;
}

/**
 * Bring in invoices made in Stripe since a date (all of them without one), their customers and
 * payments, and the deposits since then. Safe to run again: anything already here is updated.
 * Progress is saved in the integration's settings for the Apps page.
 */
export async function importFromStripe(env: Env, admin: Db, companyId: string, state: ImportState) {
  const since = state.since;
  try {
    const ctx = await context(env, admin, companyId);
    if (!ctx) throw new IntegrationError("Stripe isn't connected");
    const created = since ? { gte: Math.floor(Date.parse(`${since}T00:00:00Z`) / 1000) } : undefined;
    const invoices: StripeInvoice[] = [];
    for await (const invoice of stripeList<StripeInvoice>(ctx.key, "/v1/invoices", { created, expand: ["data.charge.balance_transaction"] })) {
      if (invoice.status !== "draft") invoices.push(invoice);
    }
    // Oldest first, so Crewtavo's invoice numbers follow the order they were sent.
    for (const invoice of invoices.reverse()) {
      if (invoice.metadata?.crewtavo_invoice_id) {
        // One of ours; catch up on a payment whose webhook never arrived.
        if (invoice.status === "paid") await settleOwnInvoice(ctx, invoice);
        continue;
      }
      if (!invoice.total && !invoice.amount_due) continue;
      // Count what's new: an invoice already brought in (by a webhook or an earlier import) is just updated.
      const { data: known } = await admin.from("stripe_invoices").select("status").eq("company_id", companyId).eq("stripe_id", invoice.id).maybeSingle();
      await importInvoice(ctx, invoice, true);
      if (!known) state.counts.invoices++;
      if (invoice.status === "paid" && known?.status !== "paid") state.counts.payments++;
      if (state.counts.invoices % 25 === 0) await saveImportState(admin, companyId, state);
    }
    for await (const payout of stripeList<StripePayout>(ctx.key, "/v1/payouts", { created })) {
      if (await savePayout(ctx, payout)) state.counts.payouts++;
    }
    const { count } = await admin.from("clients").select("id", { count: "exact", head: true }).eq("company_id", companyId).eq("lead_source", "Stripe").gte("created_at", state.started_at);
    state.counts.clients = count ?? 0;
    await saveImportState(admin, companyId, { ...state, status: "done", finished_at: new Date().toISOString() });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await saveImportState(admin, companyId, { ...state, status: "failed", finished_at: new Date().toISOString(), error: message.slice(0, 300) });
    throw error;
  }
}
