/**
 * Connecting, switching and disconnecting Stripe, history imports on the server's key, and Hub
 * Pay, against an in-memory database and a fake Stripe that keeps accounts (and test and live
 * mode) apart the way Stripe does: one account's invoice is "No such invoice" to another's key.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import type { Env } from "../src/env";
import { connectStripe, hubPayment, importFromStripe, beginStripeImport, PROCESSING_MESSAGE, SHARED_STRIPE_IMPORT, stripeCheckout, syncStripeInvoice } from "../src/integrations/stripe";
import { loadSecret } from "../src/integrations/tokens";
import { clientLink } from "../src/lib/links";
import type { Db } from "../src/lib/supabase";

const current = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../src/lib/supabase", async (original) => ({
  ...(await original<typeof import("../src/lib/supabase")>()),
  adminClient: () => current.db,
  userClient: () => current.db,
}));

type Row = Record<string, any>;
const LIVE = ["creating", "open", "processing"];

// ---------------------------------------------------------------------------------------------
// The database: rows in memory, with the unique keys the code relies on
// ---------------------------------------------------------------------------------------------

const UPSERT_KEYS: Record<string, string[]> = {
  integrations: ["company_id", "provider"],
  integration_secrets: ["company_id", "provider"],
  sync_links: ["company_id", "provider", "entity", "local_id"],
};
const DEFAULTS: Record<string, Row> = {
  stripe_invoices: { stripe_id: null, status: "creating", hosted_url: null, number: null, tip_amount: 0, livemode: true, stripe_account: null, detached_at: null },
  payments: { tip_amount: 0, fee_amount: 0, payout_id: null },
  payouts: { itemized_at: null },
};

function conflicts(table: string, rows: Row[], row: Row, self?: Row) {
  const others = rows.filter((r) => r !== self);
  if (table === "stripe_invoices") {
    if (row.stripe_id && others.some((r) => r.stripe_id === row.stripe_id)) return true;
    // stripe_invoices_live_idx: one live Stripe invoice per invoice among the ones still followed.
    const live = (r: Row) => r.invoice_id && LIVE.includes(r.status) && !r.detached_at;
    if (live(row) && others.some((r) => live(r) && r.invoice_id === row.invoice_id)) return true;
  }
  if ((table === "payments" || table === "payouts") && row.processor_ref) return others.some((r) => r.processor_ref === row.processor_ref);
  return false;
}

function fakeDb(tables: Record<string, Row[]>) {
  let seq = 0;
  const rpcs: Array<{ fn: string; args: Row }> = [];
  const hits = new Map<string, number>();
  const from = (table: string) => {
    const filters: Array<(r: Row) => boolean> = [];
    let op = "select";
    let payload: any;
    let cols = "*";
    let head = false;
    let one: "single" | "maybe" | null = null;
    let order: [string, boolean] | null = null;
    let limit: number | null = null;
    const duplicate = { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
    const run = () => {
      const all = (tables[table] ??= []);
      let out: Row[];
      if (op === "insert") {
        out = [];
        for (const p of [payload].flat()) {
          const row = { id: crypto.randomUUID(), created_at: new Date(Date.now() + seq++).toISOString(), ...DEFAULTS[table], ...p };
          if (conflicts(table, all, row)) return duplicate;
          all.push(row);
          out.push(row);
        }
      } else if (op === "upsert") {
        const keys = UPSERT_KEYS[table]!;
        const found = all.find((r) => keys.every((k) => r[k] === payload[k]));
        if (found) Object.assign(found, payload);
        else all.push({ ...payload });
        out = [found ?? all.at(-1)!];
      } else {
        const matched = all.filter((r) => filters.every((f) => f(r)));
        if (op === "update") {
          if (matched.some((r) => conflicts(table, all, { ...r, ...payload }, r))) return duplicate;
          for (const r of matched) Object.assign(r, payload);
        } else if (op === "delete") tables[table] = all.filter((r) => !matched.includes(r));
        out = matched;
      }
      out = out.map((r) => {
        const copy = { ...r };
        // settings->hub_tips and the like.
        for (const part of cols.split(",").map((c) => c.trim()).filter((c) => c.includes("->"))) copy[part.split("->")[1]!] = r[part.split("->")[0]!]?.[part.split("->")[1]!];
        return copy;
      });
      if (order) {
        const [k, asc] = order;
        out.sort((a, b) => (a[k] < b[k] ? -1 : a[k] > b[k] ? 1 : 0) * (asc ? 1 : -1));
      }
      if (limit !== null) out = out.slice(0, limit);
      if (head) return { data: null, error: null, count: out.length };
      if (one) return one === "single" && out.length !== 1 ? { data: null, error: { message: "not one row" } } : { data: out[0] ?? null, error: null };
      return { data: out, error: null };
    };
    const q: any = {
      select: (c = "*", opts?: { head?: boolean }) => {
        if (op === "select") cols = c;
        head = Boolean(opts?.head);
        return q;
      },
      eq: (k: string, v: unknown) => (filters.push((r) => r[k] === v), q),
      is: (k: string, v: unknown) => (filters.push((r) => (r[k] ?? null) === v), q),
      not: (k: string, _op: string, v: unknown) => (filters.push((r) => (r[k] ?? null) !== v), q),
      in: (k: string, vs: unknown[]) => (filters.push((r) => vs.includes(r[k])), q),
      gte: (k: string, v: any) => (filters.push((r) => r[k] >= v), q),
      like: (k: string, p: string) => (filters.push((r) => new RegExp(`^${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*")}$`).test(String(r[k] ?? ""))), q),
      match: (m: Row) => {
        for (const [k, v] of Object.entries(m)) q.eq(k, v);
        return q;
      },
      order: (k: string, o?: { ascending?: boolean }) => ((order = [k, o?.ascending !== false]), q),
      limit: (n: number) => ((limit = n), q),
      maybeSingle: () => ((one = "maybe"), q),
      single: () => ((one = "single"), q),
      insert: (p: unknown) => ((op = "insert"), (payload = p), q),
      update: (p: unknown) => ((op = "update"), (payload = p), q),
      upsert: (p: unknown) => ((op = "upsert"), (payload = p), q),
      delete: () => ((op = "delete"), q),
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve().then(run).then(resolve, reject),
    };
    return q;
  };
  const db = {
    from,
    rpc: async (fn: string, args: Row) => {
      rpcs.push({ fn, args });
      if (fn === "rate_limit_hit") {
        const n = (hits.get(args.p_key) ?? 0) + 1;
        hits.set(args.p_key, n);
        return { data: n <= args.p_max, error: null };
      }
      return { data: null, error: null };
    },
    auth: { getClaims: async () => ({ data: { claims: { sub: USER } }, error: null }) },
  };
  current.db = db;
  return { db: db as unknown as Db, tables, rpcs };
}

// ---------------------------------------------------------------------------------------------
// Stripe: accounts with a test side and a live side, and keys that reach one of them
// ---------------------------------------------------------------------------------------------

interface Side {
  invoices: Map<string, Row>;
  webhooks: Map<string, Row>;
  customers: Row[];
  payouts: Row[];
}
interface Key {
  account: string;
  live: boolean;
  webhooks: boolean;
}
const stripe = { sides: new Map<string, Side>(), keys: new Map<string, Key>(), calls: [] as string[], n: 0 };

/** A key for `account` (live or test by its prefix). `webhooks: false` is a restricted key without that permission. */
function stripeKey(key: string, account: string, options: { webhooks?: boolean } = {}) {
  stripe.keys.set(key, { account, live: key.includes("_live_"), webhooks: options.webhooks ?? true });
  return key;
}
function side(key: string): Side {
  const k = stripe.keys.get(key)!;
  const name = `${k.account}:${k.live ? "live" : "test"}`;
  if (!stripe.sides.has(name)) stripe.sides.set(name, { invoices: new Map(), webhooks: new Map(), customers: [], payouts: [] });
  return stripe.sides.get(name)!;
}
/** The client pays a Stripe invoice (in whichever account it's in). */
function payInStripe(id: string) {
  for (const s of stripe.sides.values()) {
    const invoice = s.invoices.get(id);
    if (invoice) Object.assign(invoice, { status: "paid", amount_paid: invoice.amount_due, payment_intent: `pi_${id}`, status_transitions: { ...invoice.status_transitions, paid_at: 1_760_000_500 } });
  }
}
const stripeInvoice = (id: string) => [...stripe.sides.values()].find((s) => s.invoices.has(id))?.invoices.get(id);

async function fakeStripe(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const url = new URL(String(input));
  const method = init.method ?? "GET";
  const path = url.pathname;
  const key = (init.headers as Record<string, string>).Authorization!.slice(7);
  stripe.calls.push(`${key} ${method} ${path}`);
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const k = stripe.keys.get(key);
  if (!k) return json({ error: { message: "Invalid API Key provided" } }, 401);
  const s = side(key);
  const body = new URLSearchParams(typeof init.body === "string" ? init.body : "");
  const noInvoice = (id: string) => json({ error: { message: `No such invoice: '${id}'`, code: "resource_missing", param: "id" } }, 404);
  let m: RegExpMatchArray | null;

  if (path === "/v1/account") return json({ id: k.account, settings: { dashboard: { display_name: `Business ${k.account}` } } });
  if (path.startsWith("/v1/webhook_endpoints")) {
    if (!k.webhooks) return json({ error: { type: "permission_error", message: "The provided key does not have the required permissions for this endpoint" } }, 403);
    if (method === "GET") return json({ data: [...s.webhooks.values()].map(({ id, url }) => ({ id, url })), has_more: false });
    if (method === "POST") {
      const id = `we_${++stripe.n}`;
      const endpoint = { id, url: body.get("url"), secret: `whsec_${id}` };
      s.webhooks.set(id, endpoint);
      return json(endpoint);
    }
    const id = path.split("/").pop()!;
    return s.webhooks.delete(id) ? json({ id, deleted: true }) : json({ error: { message: "No such webhook endpoint", code: "resource_missing" } }, 404);
  }
  if (path === "/v1/customers" && method === "GET") return json({ data: s.customers.filter((c) => c.email === url.searchParams.get("email")), has_more: false });
  if (path === "/v1/customers") {
    const customer = { id: `cus_${++stripe.n}`, email: body.get("email") };
    s.customers.push(customer);
    return json(customer);
  }
  if (path === "/v1/invoices" && method === "POST") {
    if (!s.customers.some((c) => c.id === body.get("customer"))) return json({ error: { message: "No such customer", code: "resource_missing", param: "customer" } }, 400);
    const id = `in_${++stripe.n}`;
    const metadata = Object.fromEntries([...body].filter(([name]) => name.startsWith("metadata[")).map(([name, value]) => [name.slice(9, -1), value]));
    s.invoices.set(id, {
      id, status: "draft", livemode: k.live, customer: body.get("customer"), metadata, number: null, hosted_invoice_url: null, amount_due: 0, amount_paid: 0, total: 0,
      paid_out_of_band: false, payment_intent: null, charge: null, status_transitions: { finalized_at: null, paid_at: null }, lines: { data: [], has_more: false },
    });
    return json(s.invoices.get(id));
  }
  if (path === "/v1/invoiceitems") {
    const invoice = s.invoices.get(body.get("invoice")!);
    if (!invoice) return noInvoice(body.get("invoice")!);
    invoice.amount_due += Number(body.get("amount"));
    invoice.total += Number(body.get("amount"));
    return json({ id: `ii_${++stripe.n}` });
  }
  if ((m = path.match(/^\/v1\/invoices\/([^/]+)\/finalize$/))) {
    const invoice = s.invoices.get(m[1]!);
    if (!invoice) return noInvoice(m[1]!);
    Object.assign(invoice, { status: "open", number: `N-${m[1]}`, hosted_invoice_url: `https://invoice.stripe.com/i/${k.account}_${k.live ? "live" : "test"}_${m[1]}` });
    return json(invoice);
  }
  if ((m = path.match(/^\/v1\/invoices\/([^/]+)\/void_invoice$/))) {
    const invoice = s.invoices.get(m[1]!);
    if (!invoice) return noInvoice(m[1]!);
    if (invoice.status !== "open") return json({ error: { message: `You can only void open invoices. This one is ${invoice.status}.` } }, 400);
    invoice.status = "void";
    return json(invoice);
  }
  if ((m = path.match(/^\/v1\/invoices\/([^/]+)$/))) {
    const invoice = s.invoices.get(m[1]!);
    if (!invoice) return noInvoice(m[1]!);
    if (method === "DELETE") s.invoices.delete(m[1]!);
    return json(invoice);
  }
  if (path === "/v1/invoices") return json({ data: [...s.invoices.values()], has_more: false });
  if (path === "/v1/payouts") return json({ data: s.payouts, has_more: false });
  throw new Error(`The fake Stripe doesn't know ${method} ${path}`);
}

// ---------------------------------------------------------------------------------------------
// A lawn company with one client and an invoice for $160
// ---------------------------------------------------------------------------------------------

const CO = "00000000-0000-4000-8000-000000000001";
const OTHER_CO = "00000000-0000-4000-8000-000000000002";
const CLIENT = "00000000-0000-4000-8000-0000000000c1";
const INV = "00000000-0000-4000-8000-0000000000e1";
const INV2 = "00000000-0000-4000-8000-0000000000e2";
const USER = "00000000-0000-4000-8000-0000000000aa";
const BASE = "https://crew.example.com";
const env: Env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7))),
  APP_URL: BASE,
};

const invoiceRow = (id: string, number: number) => ({
  id, company_id: CO, number, status: "sent", subject: "May mowing", notes: null, client_id: CLIENT, due_on: null,
  subtotal: 160, discount_amount: 0, tax_rate: 0, tax_amount: 0, retainage_pct: 0, retainage_amount: 0, amount_paid: 0, balance_due: 160, promo: null,
  lines: [{ name: "Weekly mowing", quantity: 4, unit: "visit", unit_price: 40, sort: 1 }],
});

let db: ReturnType<typeof fakeDb>;
beforeEach(() => {
  stripe.sides.clear();
  stripe.keys.clear();
  stripe.calls.length = 0;
  stripe.n = 0;
  db = fakeDb({
    companies: [{ id: CO, name: "Green Lawn", timezone: "America/Chicago", currency: "USD", settings: { hub_tips: true } }],
    memberships: [{ company_id: CO, user_id: USER, role: "owner", role_id: null, active: true }],
    clients: [{ id: CLIENT, company_id: CO, display_name: "Pat Client", email: "pat@example.com", phone: null }],
    invoices: [invoiceRow(INV, 42), invoiceRow(INV2, 43)],
  });
  vi.stubGlobal("fetch", vi.fn(fakeStripe));
});
afterEach(() => vi.unstubAllGlobals());

async function connect(key: string, e: Env = env) {
  const done = await connectStripe(e, db.db, { companyId: CO, userId: USER, key, baseUrl: BASE });
  await done.settled;
  return done;
}
const rowsFor = (invoiceId: string) => db.tables.stripe_invoices!.filter((r) => r.invoice_id === invoiceId);
const owe = (invoiceId: string, balance: number) => Object.assign(db.tables.invoices!.find((i) => i.id === invoiceId)!, { balance_due: balance, amount_paid: 160 - balance, status: "partially_paid" });
const headers = { Authorization: "Bearer token", "X-Company-Id": CO, "Content-Type": "application/json" };

// ---------------------------------------------------------------------------------------------

describe("replacing the Stripe key", () => {
  it("keeps the working webhook when the new key can't add one", async () => {
    const old = stripeKey("sk_live_OLD", "acct_A");
    stripeKey("rk_live_NEW", "acct_A", { webhooks: false });
    await connect(old);
    const [working] = side(old).webhooks.keys();
    stripe.calls.length = 0;

    const res = await app.request("/api/apps/stripe/key", { method: "PUT", headers, body: JSON.stringify({ api_key: "rk_live_NEW" }) }, env);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(
      "That key can't add a webhook. Use your standard secret key, or a restricted key that can write webhook endpoints, customers, invoices and invoice items. Stripe stays connected as it was.",
    );
    // Nothing was taken out, and the old key and its webhook are still the ones in use.
    expect(stripe.calls.filter((c) => c.includes("DELETE"))).toEqual([]);
    expect([...side(old).webhooks.keys()]).toEqual([working]);
    expect(await loadSecret(env, db.db, CO, "stripe")).toMatchObject({ api_key: old, extra: { webhook_id: working, webhook_secret: `whsec_${working}` } });
    expect(db.tables.integrations![0]).toMatchObject({ status: "connected", external_account_id: "acct_A", settings: { webhook: true } });
  });

  it("takes the old webhook out only once the new one is in and saved", async () => {
    const a = stripeKey("sk_live_A", "acct_A");
    const b = stripeKey("sk_live_B", "acct_B");
    await connect(a);
    const [old] = side(a).webhooks.keys();
    stripe.calls.length = 0;
    await connect(b);
    const added = stripe.calls.indexOf("sk_live_B POST /v1/webhook_endpoints");
    const removed = stripe.calls.indexOf(`sk_live_A DELETE /v1/webhook_endpoints/${old}`);
    expect(added).toBeGreaterThanOrEqual(0);
    expect(removed).toBeGreaterThan(added);
    expect(side(a).webhooks.size).toBe(0);
    const [now] = side(b).webhooks.keys();
    expect(await loadSecret(env, db.db, CO, "stripe")).toMatchObject({ api_key: b, extra: { webhook_id: now, account_id: "acct_B" } });
  });
});

describe("switching to another Stripe account", () => {
  it("from a test key to a live one: the test invoices are voided with the test key, and clients get live pages", async () => {
    const test = stripeKey("sk_test_A", "acct_A");
    const live = stripeKey("sk_live_A", "acct_A");
    await connect(test);
    expect(await syncStripeInvoice(env, db.db, CO, INV)).toBe("created");
    const [made] = rowsFor(INV);
    expect(made).toMatchObject({ status: "open", livemode: false, stripe_account: "acct_A" });

    stripe.calls.length = 0;
    await connect(live);
    expect(stripe.calls).toContain(`sk_test_A POST /v1/invoices/${made!.stripe_id}/void_invoice`);
    expect(stripeInvoice(made!.stripe_id)!.status).toBe("void");
    expect(rowsFor(INV)[0]).toMatchObject({ status: "void", detached_at: expect.any(String) });

    const url = await stripeCheckout(env, db.db, CO, INV, 0);
    expect(url).toContain("acct_A_live_");
    // A check comes in: the live Stripe invoice is replaced, nothing tries the test one.
    owe(INV, 120);
    expect(await syncStripeInvoice(env, db.db, CO, INV)).toBe("created");
    expect(stripe.calls.filter((c) => c.startsWith("sk_live_A") && c.includes(made!.stripe_id))).toEqual([]);
  });

  it("leaves a bank payment that's still clearing alone, tells the office, and records one that was paid", async () => {
    const a = stripeKey("sk_live_A", "acct_A");
    const b = stripeKey("sk_live_B", "acct_B");
    await connect(a);
    await syncStripeInvoice(env, db.db, CO, INV);
    await syncStripeInvoice(env, db.db, CO, INV2);
    const [clearing] = rowsFor(INV);
    const [paid] = rowsFor(INV2);
    clearing!.status = "processing";
    payInStripe(paid!.stripe_id);

    await connect(b);
    expect(stripeInvoice(clearing!.stripe_id)!.status).toBe("open");
    expect(db.tables.messages).toEqual([
      expect.objectContaining({ client_id: CLIENT, related_id: INV, subject: "Bank payment still clearing", body: expect.stringContaining("record the payment here once it clears") }),
    ]);
    // The client isn't asked to pay again while it might still clear.
    expect((await hubPayment(env, db.db, CO, INV)).processing).toBe(true);
    await expect(stripeCheckout(env, db.db, CO, INV, 0)).rejects.toMatchObject({ status: 409, message: PROCESSING_MESSAGE });
    // The one paid in the old account meanwhile is recorded.
    expect(db.tables.payments).toEqual([expect.objectContaining({ invoice_id: INV2, amount: 160, processor_ref: `pi_${paid!.stripe_id}` })]);
  });

  it("checks Stripe invoices from before accounts were noted, and doesn't fail on one this key can't find", async () => {
    const b = stripeKey("sk_live_B", "acct_B");
    const c = stripeKey("sk_live_C", "acct_C");
    // Made with account C's key before this change, and connected to B since.
    const old = { stripe_id: "in_c1", status: "open", amount_due: 160, hosted_url: "https://invoice.stripe.com/i/acct_C_live_in_c1", livemode: true, stripe_account: null };
    side(c).invoices.set("in_c1", { id: "in_c1", status: "open" });
    side(c).invoices.set("in_c2", { id: "in_c2", status: "open" });
    db.tables.stripe_invoices = [
      { id: crypto.randomUUID(), company_id: CO, invoice_id: INV, origin: "crewtavo", tip_amount: 0, detached_at: null, created_at: new Date(0).toISOString(), ...old },
      { id: crypto.randomUUID(), company_id: CO, invoice_id: INV2, origin: "crewtavo", tip_amount: 0, detached_at: null, created_at: new Date(0).toISOString(), ...old, stripe_id: "in_c2" },
    ];
    await connect(b);

    // The Hub doesn't hand out account C's page.
    const url = await stripeCheckout(env, db.db, CO, INV, 0);
    expect(url).toContain("acct_B_live_");
    expect(rowsFor(INV).find((r) => r.stripe_id === "in_c1")).toMatchObject({ detached_at: expect.any(String) });
    // The outbox job for a balance change goes through instead of failing on "No such invoice".
    owe(INV2, 120);
    expect(await syncStripeInvoice(env, db.db, CO, INV2)).toBe("created");
    expect(rowsFor(INV2).find((r) => r.stripe_id === "in_c2")).toMatchObject({ detached_at: expect.any(String) });
    expect(rowsFor(INV2).find((r) => r.status === "open" && !r.detached_at)).toMatchObject({ stripe_account: "acct_B", amount_due: 120 });
  });

  it("keeps the invoices when the new key is for the same account", async () => {
    const a = stripeKey("sk_live_A", "acct_A");
    const rolled = stripeKey("sk_live_A2", "acct_A");
    await connect(a);
    await syncStripeInvoice(env, db.db, CO, INV);
    const url = await stripeCheckout(env, db.db, CO, INV, 0);
    stripe.calls.length = 0;
    await connect(rolled);
    expect(stripe.calls.filter((c) => c.includes("/v1/invoices"))).toEqual([]);
    expect(await stripeCheckout(env, db.db, CO, INV, 0)).toBe(url);
    // One webhook at Crewtavo's address: the new one.
    expect([...side(a).webhooks.values()]).toEqual([expect.objectContaining({ id: (await loadSecret(env, db.db, CO, "stripe"))!.extra!.webhook_id })]);
  });

  it("disconnecting voids the open invoices with the company's key, and the server's account takes over", async () => {
    const own = stripeKey("sk_live_A", "acct_A");
    const server = stripeKey("sk_live_SERVER", "acct_S");
    const e = { ...env, STRIPE_SECRET_KEY: server };
    await connect(own, e);
    await syncStripeInvoice(e, db.db, CO, INV);
    const [made] = rowsFor(INV);

    const res = await app.request("/api/apps/stripe/disconnect", { method: "POST", headers }, e);
    expect(res.status).toBe(200);
    await vi.waitFor(() => expect(stripeInvoice(made!.stripe_id)!.status).toBe("void"));
    expect(side(own).webhooks.size).toBe(0);
    expect(await stripeCheckout(e, db.db, CO, INV, 0)).toContain("acct_S_live_");
  });
});

describe("importing Stripe history", () => {
  it("on the server's shared key, only for the instance's only company", async () => {
    const shared = stripeKey("sk_live_SHARED", "acct_S");
    side(shared).payouts.push({ id: "po_1", amount: 485, currency: "usd", arrival_date: 1_760_400_000, status: "paid", automatic: false, failure_message: null });
    const e = { ...env, STRIPE_SECRET_KEY: shared };
    db.tables.companies!.push({ id: OTHER_CO, name: "Other Co", timezone: "UTC", currency: "USD", settings: {} });

    const res = await app.request("/api/apps/stripe/import", { method: "POST", headers, body: JSON.stringify({ since: null }) }, e);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe(SHARED_STRIPE_IMPORT);
    // Run anyway (an import started before this), it stops before reading anything.
    db.tables.integrations = [{ company_id: CO, provider: "stripe", status: "disconnected", settings: {} }];
    await expect(importFromStripe(e, db.db, CO, await beginStripeImport(db.db, CO, null))).rejects.toThrow(SHARED_STRIPE_IMPORT);
    expect(db.tables.payouts ?? []).toEqual([]);
    expect(stripe.calls).toEqual([]);

    // With one company, the server's account is that company's.
    db.tables.companies = db.tables.companies!.filter((c) => c.id === CO);
    await importFromStripe(e, db.db, CO, await beginStripeImport(db.db, CO, null));
    expect(db.tables.payouts).toEqual([expect.objectContaining({ company_id: CO, processor_ref: "po_1" })]);
  });
});

describe("Hub Pay", () => {
  const pay = async (token: string, tip: number, ip = "203.0.113.7") =>
    app.request(`/api/hub/${token}/pay`, { method: "POST", headers: { "Content-Type": "application/json", "X-Real-IP": ip }, body: JSON.stringify({ tip }) }, env);
  const token = async () => (await clientLink(env, BASE, { c: CO, t: "invoice", id: INV })).split("/hub/")[1]!;

  it("is limited per link and per visitor", async () => {
    await connect(stripeKey("sk_live_A", "acct_A"));
    const t = await token();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await pay(t, 0)).status);
    expect(statuses).toEqual([...Array(10).fill(200), 429]);
    expect(db.rpcs.filter((r) => r.fn === "rate_limit_hit").map((r) => r.args.p_key)).toEqual(expect.arrayContaining(["pay:ip:203.0.113.7", `pay:invoice:${INV}`]));
  });

  it("makes a new Stripe invoice for a new tip only a few times an hour", async () => {
    const key = stripeKey("sk_live_A", "acct_A");
    await connect(key);
    const t = await token();
    // A client trying a few tips is fine.
    for (const tip of [0, 5, 10, 15, 20]) expect((await pay(t, tip)).status).toBe(200);
    const res = await pay(t, 25);
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: string }).error).toBe("You've changed the tip a few times already. Pay with the tip you chose before, or try another in an hour.");
    // The last one still works, and nothing more was made in Stripe.
    const last = (await (await pay(t, 20)).json()) as { url: string };
    expect(last.url).toBe(rowsFor(INV).find((r) => r.status === "open")!.hosted_url);
    expect(side(key).invoices.size).toBe(5);
  });
});
