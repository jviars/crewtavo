import type { Db } from "../lib/supabase";
/**
 * Accounting sync: push clients, invoices and payments to QuickBooks Online or Zoho Books.
 * Called from the outbox task with the admin client; every query filters by company_id.
 *
 * QuickBooks item mapping lives in integrations.settings:
 *   { "environment": "production" | "sandbox", "item_map": { "<service uuid>": "<QBO Item Id>" }, "default_item_id": "1" }
 */
import type { Env } from "../env";
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

async function one<R extends { data: unknown; error: { message: string } | null }>(query: PromiseLike<R>, what: string): Promise<NonNullable<R["data"]>> {
  const { data, error } = await query;
  if (error) throw new IntegrationError(error.message);
  if (!data) throw new IntegrationError(`${what} not found`);
  return data as NonNullable<R["data"]>;
}

async function linked(ctx: Ctx, entity: Entity, localId: string): Promise<string | null> {
  const { data } = await ctx.admin
    .from("sync_links")
    .select("external_id")
    .match({ company_id: ctx.companyId, provider: ctx.provider, entity, local_id: localId })
    .maybeSingle();
  return data?.external_id ?? null;
}

async function remember(ctx: Ctx, entity: Entity, localId: string, externalId: string, syncToken?: string) {
  await ctx.admin.from("sync_links").upsert({
    company_id: ctx.companyId,
    provider: ctx.provider,
    entity,
    local_id: localId,
    external_id: externalId,
    sync_token: syncToken ?? null,
    synced_at: new Date().toISOString(),
  });
}

// ---------------------------------------------------------------------------------------------
// Provider HTTP
// ---------------------------------------------------------------------------------------------

async function qbo(ctx: Ctx, method: "GET" | "POST", path: string, body?: unknown) {
  const realm = ctx.integration.external_account_id;
  if (!realm) throw new IntegrationError("QuickBooks company (realm) ID is missing; reconnect QuickBooks.");
  const env = ctx.integration.settings.environment === "sandbox" ? "sandbox" : (ctx.env.QUICKBOOKS_ENVIRONMENT ?? "production");
  const { token } = await accessToken(ctx.env, ctx.admin, ctx.companyId, "quickbooks");
  const url = `${QBO_BASE[env]}/v3/company/${realm}/${path}${path.includes("?") ? "&" : "?"}minorversion=${QBO_MINOR_VERSION}`;
  const response = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: providerTimeout(),
  });
  const json = (await response.json().catch(() => ({}))) as Record<string, any>;
  if (!response.ok) {
    const detail = json.Fault?.Error?.[0];
    throw new IntegrationError(`QuickBooks ${path}: ${response.status} ${detail?.Message ?? ""} ${detail?.Detail ?? ""}`.trim());
  }
  return json;
}

async function zoho(ctx: Ctx, method: "GET" | "POST", path: string, body?: unknown) {
  const { token, secret } = await accessToken(ctx.env, ctx.admin, ctx.companyId, "zoho_books");
  const org = ctx.integration.external_account_id;
  if (!org) throw new IntegrationError("Zoho Books organization ID is missing; reconnect Zoho Books.");
  // Checked here too: tokens saved before only Zoho's servers were accepted may name another.
  const apiDomain = zohoApiDomain(secret.extra?.api_domain);
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

async function pushInvoice(ctx: Ctx, invoiceId: string): Promise<string> {
  const existing = await linked(ctx, "invoice", invoiceId);
  if (existing) return existing;
  const invoice = await one(
    ctx.admin
      .from("invoices")
      .select("id, number, client_id, issued_on, due_on, subject, tax_rate, tax_amount, discount_amount, invoice_line_items(name, description, quantity, unit_price, taxable, service_id, sort)")
      .eq("company_id", ctx.companyId)
      .eq("id", invoiceId)
      .maybeSingle(),
    "Invoice",
  );
  const customerId = await pushClient(ctx, invoice.client_id);
  const lines = [...(invoice.invoice_line_items ?? [])].sort((a: any, b: any) => a.sort - b.sort);
  const discount = Number(invoice.discount_amount ?? 0);

  if (ctx.provider === "quickbooks") {
    const itemMap = (ctx.integration.settings.item_map ?? {}) as Record<string, string>;
    const defaultItem = String(ctx.integration.settings.default_item_id ?? "1");
    const created = (await qbo(ctx, "POST", "invoice", {
      CustomerRef: { value: customerId },
      DocNumber: String(invoice.number),
      TxnDate: invoice.issued_on,
      DueDate: invoice.due_on ?? undefined,
      Line: [
        ...lines.map((line: any) => ({
          DetailType: "SalesItemLineDetail",
          Amount: Math.round(Number(line.quantity) * Number(line.unit_price) * 100) / 100,
          Description: line.description || line.name,
          SalesItemLineDetail: {
            ItemRef: { value: (line.service_id && itemMap[line.service_id]) || defaultItem },
            Qty: Number(line.quantity),
            UnitPrice: Number(line.unit_price),
            TaxCodeRef: { value: line.taxable ? "TAX" : "NON" },
          },
        })),
        // Discounts (promo codes) come off before tax, as they do here.
        ...(discount > 0 ? [{ DetailType: "DiscountLineDetail", Amount: discount, DiscountLineDetail: { PercentBased: false } }] : []),
      ],
      ApplyTaxAfterDiscount: true,
      ...(Number(invoice.tax_amount) > 0 ? { TxnTaxDetail: { TotalTax: Number(invoice.tax_amount) } } : {}),
    })).Invoice;
    await remember(ctx, "invoice", invoiceId, created.Id, created.SyncToken);
    return created.Id;
  }

  const created = (await zoho(ctx, "POST", "invoices", {
    customer_id: customerId,
    reference_number: String(invoice.number),
    date: invoice.issued_on,
    due_date: invoice.due_on ?? undefined,
    line_items: lines.map((line: any) => ({
      name: line.name,
      description: line.description ?? undefined,
      rate: Number(line.unit_price),
      quantity: Number(line.quantity),
    })),
    ...(discount > 0 ? { discount, discount_type: "entity_level", is_discount_before_tax: true } : {}),
  })).invoice;
  await remember(ctx, "invoice", invoiceId, created.invoice_id);
  return created.invoice_id;
}

async function pushPayment(ctx: Ctx, paymentId: string): Promise<string | null> {
  const existing = await linked(ctx, "payment", paymentId);
  if (existing) return existing;
  const payment = await one(
    ctx.admin.from("payments").select("id, client_id, invoice_id, amount, method, received_at").eq("company_id", ctx.companyId).eq("id", paymentId).maybeSingle(),
    "Payment",
  );
  if (Number(payment.amount) <= 0) return null; // refunds are recorded in the books by hand for now
  const customerId = await pushClient(ctx, payment.client_id);
  const invoiceExternal = payment.invoice_id ? await pushInvoice(ctx, payment.invoice_id) : null;
  const date = String(payment.received_at).slice(0, 10);

  if (ctx.provider === "quickbooks") {
    const created = (await qbo(ctx, "POST", "payment", {
      CustomerRef: { value: customerId },
      TotalAmt: Number(payment.amount),
      TxnDate: date,
      Line: invoiceExternal ? [{ Amount: Number(payment.amount), LinkedTxn: [{ TxnId: invoiceExternal, TxnType: "Invoice" }] }] : [],
    })).Payment;
    await remember(ctx, "payment", paymentId, created.Id, created.SyncToken);
    return created.Id;
  }

  const created = (await zoho(ctx, "POST", "customerpayments", {
    customer_id: customerId,
    payment_mode: payment.method === "ach" ? "Bank Transfer" : payment.method === "card" ? "Credit Card" : payment.method,
    amount: Number(payment.amount),
    date,
    invoices: invoiceExternal ? [{ invoice_id: invoiceExternal, amount_applied: Number(payment.amount) }] : [],
  })).payment;
  await remember(ctx, "payment", paymentId, created.payment_id);
  return created.payment_id;
}

/** Run one outbox row. Throws on failure so the caller can schedule a retry. */
export async function runAccountingJob(env: Env, admin: Db, row: { company_id: string; topic: string; payload: Record<string, string> }) {
  const { data: integration } = await admin
    .from("integrations")
    .select("provider, external_account_id, settings")
    .eq("company_id", row.company_id)
    .in("provider", ["quickbooks", "zoho_books"])
    .eq("status", "connected")
    .limit(1)
    .maybeSingle();
  if (!integration) return; // disconnected since it was queued; nothing to do

  const ctx: Ctx = {
    env,
    admin,
    companyId: row.company_id,
    provider: integration.provider as Accounting,
    integration: { external_account_id: integration.external_account_id, settings: (integration.settings ?? {}) as Record<string, unknown> },
  };
  if (row.topic === "accounting.invoice") await pushInvoice(ctx, row.payload.invoice_id);
  else if (row.topic === "accounting.payment") await pushPayment(ctx, row.payload.payment_id);
  else throw new IntegrationError(`Unknown topic ${row.topic}`);

  await admin
    .from("integrations")
    .update({ last_sync_at: new Date().toISOString(), last_error: null, status: "connected" })
    .match({ company_id: row.company_id, provider: integration.provider });
}

/** After connecting: find the QuickBooks company name or the Zoho organization. */
export async function describeAccount(env: Env, provider: Provider, token: string, query: Record<string, string>, extra?: Record<string, string>) {
  if (provider === "quickbooks") {
    const realm = query.realmId;
    if (!realm) throw new IntegrationError("QuickBooks didn't return a company ID.");
    const base = QBO_BASE[env.QUICKBOOKS_ENVIRONMENT ?? "production"];
    const response = await fetch(`${base}/v3/company/${realm}/companyinfo/${realm}?minorversion=${QBO_MINOR_VERSION}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      signal: providerTimeout(),
    });
    const json = (await response.json().catch(() => ({}))) as Record<string, any>;
    return { external_account_id: realm, account_label: json.CompanyInfo?.CompanyName ?? `QuickBooks ${realm}` };
  }
  if (provider === "zoho_books") {
    const apiDomain = zohoApiDomain(extra?.api_domain);
    const response = await fetch(`${apiDomain}/books/v3/organizations`, { headers: { Authorization: `Zoho-oauthtoken ${token}` }, signal: providerTimeout() });
    const json = (await response.json().catch(() => ({}))) as Record<string, any>;
    const org = json.organizations?.find((o: any) => o.is_default_org) ?? json.organizations?.[0];
    if (!org) throw new IntegrationError("No Zoho Books organization found for that account.");
    return { external_account_id: String(org.organization_id), account_label: org.name as string };
  }
  return { external_account_id: null, account_label: null };
}
