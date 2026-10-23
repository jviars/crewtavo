import { templateSettings } from "@crewtavo/core/documents";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { clientLink } from "../src/lib/links";

// A stand-in for the service-role client the Client Hub uses: tables of rows that the usual filters
// narrow down, and selects that return only the columns asked for (json paths like settings->branding
// included), so a test sees what a client's browser would. Database functions answer from `rpcs`.
type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  rpcs: {} as Record<string, (args: Record<string, unknown>) => { data: unknown; error: { message: string } | null }>,
  calls: [] as Array<{ name: string; args: Record<string, unknown> }>,
}));
vi.mock("../src/lib/supabase", () => {
  /** Top-level parts of a select, leaving embedded ones (client:clients(...)) whole. */
  const parts = (select: string) => {
    const out: string[] = [];
    let depth = 0;
    let current = "";
    for (const ch of select) {
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (ch === "," && depth === 0) {
        out.push(current.trim());
        current = "";
      } else current += ch;
    }
    if (current.trim()) out.push(current.trim());
    return out;
  };
  const project = (row: Row, select: string | null) => {
    if (!select || select === "*") return { ...row };
    const out: Row = {};
    for (const part of parts(select)) {
      const embedded = /^(\w+):\w+\(/.exec(part);
      const path = /^(\w+)->(\w+)$/.exec(part);
      if (embedded) out[embedded[1]!] = row[embedded[1]!] ?? null;
      else if (path) out[path[2]!] = ((row[path[1]!] ?? {}) as Row)[path[2]!] ?? null;
      else out[part] = row[part] ?? null;
    }
    return out;
  };
  const client = () => ({
    auth: { getClaims: async () => ({ data: null, error: { message: "no session" } }) },
    rpc: async (name: string, args: Record<string, unknown>) => {
      state.calls.push({ name, args });
      const handler = state.rpcs[name];
      if (handler) return handler(args);
      if (name === "rate_limit_hit") return { data: true, error: null };
      if (name === "claim_automation_runs") return { data: [], error: null };
      return { data: null, error: null };
    },
    from: (table: string) => {
      const filters: Array<(row: Row) => boolean> = [];
      let select: string | null = null;
      let change: { kind: "update"; values: Row } | null = null;
      const rows = () => (state.tables[table] ?? []).filter((row) => filters.every((keep) => keep(row)));
      const run = () => {
        if (change) {
          for (const row of rows()) Object.assign(row, change.values);
          return { data: null, error: null };
        }
        return { data: rows().map((row) => project(row, select)), error: null };
      };
      const builder: Record<string, unknown> = {
        select: (columns: string) => ((select = columns), builder),
        order: () => builder,
        limit: () => builder,
        eq: (column: string, value: unknown) => (filters.push((row) => row[column] === value), builder),
        neq: (column: string, value: unknown) => (filters.push((row) => row[column] !== value), builder),
        gt: (column: string, value: number) => (filters.push((row) => Number(row[column]) > value), builder),
        gte: (column: string, value: string) => (filters.push((row) => String(row[column]) >= value), builder),
        is: (column: string, value: unknown) => (filters.push((row) => (row[column] ?? null) === value), builder),
        not: (column: string, op: string, value: unknown) => (filters.push((row) => (op === "is" ? (row[column] ?? null) !== value : true)), builder),
        in: (column: string, values: unknown[]) => (filters.push((row) => values.includes(row[column])), builder),
        insert: (list: Row | Row[]) => {
          state.tables[table] = [...(state.tables[table] ?? []), ...[list].flat().map((row) => ({ id: crypto.randomUUID(), ...row }))];
          return Promise.resolve({ data: null, error: null });
        },
        update: (values: Row) => ((change = { kind: "update", values }), builder),
        maybeSingle: () => Promise.resolve({ data: rows().map((row) => project(row, select))[0] ?? null, error: null }),
        then: (resolve: (r: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(run()).then(resolve, reject),
      };
      return builder;
    },
  });
  const admin = client();
  return { userClient: () => admin, adminClient: () => admin, publishableKey: () => "key" };
});
const { app } = await import("../src/app");
const { addressLines, publicApproval, rangeDetails } = await import("../src/routes/public");
const { loadContext } = await import("../src/services/automations");
const { adminClient } = await import("../src/lib/supabase");

const env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7))),
  APP_URL: "https://ops.example.com",
} as Env;

const ROOFER = "00000000-0000-4000-8000-0000000000d1";
const QUOTE = "00000000-0000-4000-8000-0000000000d2";
const CLIENT = "00000000-0000-4000-8000-0000000000d3";
const PACKAGE = "00000000-0000-4000-8000-0000000000d4";
const SALES = "00000000-0000-4000-8000-0000000000d5";
const TEMPLATE = "00000000-0000-4000-8000-0000000000d6";
const PNG = "data:image/png;base64,iVBORw0KGgo=";
const S = { roof: "s-roof", tear: "s-tear", edge: "s-edge", deck: "s-deck", chimney: "s-chimney", cricket: "s-cricket", vent: "s-vent", boot: "s-boot" };

const tokenFor = async (link: { t: "quote" | "client"; id: string; pv?: 1 }) => (await clientLink(env, "https://ops.example.com", { c: ROOFER, ...link })).split("/hub/")[1]!;
const hub = async (link: { t: "quote" | "client"; id: string; pv?: 1 }, path = "", body?: unknown) =>
  app.request(`/api/hub/${await tokenFor(link)}${path}`, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.7" }, body: JSON.stringify(body) }, env);

const line = (id: string, service_id: string | null, name: string, values: Row = {}) => ({
  id, company_id: ROOFER, quote_id: QUOTE, service_id, name, description: null, quantity: 1, unit: "ea", unit_price: 0, unit_cost: 0, taxable: true,
  optional: false, selected: true, option_group: null, sort: 0, formula: null, materials: null, material_cost: null, ...values,
});

function roofer(quote: Row = {}) {
  state.tables = {
    companies: [{
      id: ROOFER, name: "Summit Roofing", phone: "555-0100", email: "office@summit.example", website: "summit.example", timezone: "America/Chicago", currency: "USD",
      address: { line1: "200 Main St", line2: "Suite 4", city: "Springfield", region: "IL", postal_code: "62704" },
      settings: { branding: { color: "#1f4e79" }, hub_tips: false, roofing: { range_pct: 15, range_round: 50 } },
    }],
    quotes: [{
      id: QUOTE, company_id: ROOFER, number: 1042, status: "sent", title: "New roof", message: null, subtotal: 18304, discount_amount: 0, tax_rate: 0, tax_amount: 0,
      total: 18304, deposit_amount: 1000, valid_until: "2026-11-21", sent_at: "2026-10-22T15:00:00Z", approved_at: null, approval: null, client_id: CLIENT,
      change_order_for: null, template_id: TEMPLATE, roof_package_id: PACKAGE, salesperson_id: SALES,
      range_low: 18300, range_high: 21050, range_sent_at: "2026-10-22T15:00:00Z", range_accepted_at: null, priced_on_site_at: null, promo_code_id: null,
      promo: null, client: { display_name: "Dana Whitfield" }, property: { line1: "1482 Ridgeview Dr", city: "Springfield", region: "IL", postal_code: "62704" },
      ...quote,
    }],
    quote_line_items: [
      line("l1", S.roof, "Architectural shingle roof", { quantity: 22.4, unit: "square", unit_price: 560, unit_cost: 330, formula: "squares", sort: 1 }),
      line("l2", S.tear, "Tear-off and disposal", { quantity: 20.4, unit: "square", unit_price: 85, unit_cost: 45, formula: "roof_squares", sort: 2 }),
      line("l3", S.edge, "Drip edge", { quantity: 210, unit: "ft", unit_price: 3.5, unit_cost: 1.6, formula: "eave_ft + rake_ft", sort: 3 }),
      line("l4", S.boot, "Pipe boot", { quantity: 3, unit_price: 45, unit_cost: 15, sort: 4 }),
      line("l5", S.chimney, "Chimney flashing", { unit_price: 650, unit_cost: 336, sort: 5 }),
      line("l6", null, "Gutter guards", { optional: true, selected: false, quantity: 120, unit: "ft", unit_price: 7, sort: 6 }),
    ],
    roof_packages: [{ id: PACKAGE, company_id: ROOFER, name: "Architectural shingle" }],
    roof_package_items: [
      { company_id: ROOFER, package_id: PACKAGE, service_id: S.vent, kind: "quick", sort: 1 },
      { company_id: ROOFER, package_id: PACKAGE, service_id: S.chimney, kind: "quick", sort: 2 },
      { company_id: ROOFER, package_id: PACKAGE, service_id: S.deck, kind: "quick", sort: 3 },
      { company_id: ROOFER, package_id: PACKAGE, service_id: S.cricket, kind: "quick", sort: 4 },
      { company_id: ROOFER, package_id: PACKAGE, service_id: S.edge, kind: "included", sort: 1 },
    ],
    services: [
      { id: S.vent, company_id: ROOFER, name: "Ridge vent", unit: "ft", unit_price: 9, active: true },
      { id: S.chimney, company_id: ROOFER, name: "Chimney flashing", unit: "ea", unit_price: 650, active: true },
      { id: S.deck, company_id: ROOFER, name: "Rotten decking", unit: "sheet", unit_price: 95, active: true },
      { id: S.cricket, company_id: ROOFER, name: "Chimney cricket", unit: "ea", unit_price: 450, active: true },
    ],
    document_templates: [
      { id: "t-default", company_id: ROOFER, is_default: true, settings: { header: "banner", license: "RC-1" } },
      { id: TEMPLATE, company_id: ROOFER, is_default: false, settings: { header: "centered", license: "RC-104882", company_signs: true } },
    ],
    measurements: [],
    clients: [{ id: CLIENT, company_id: ROOFER, display_name: "Dana Whitfield", properties: [] }],
    profiles: [{ user_id: SALES, full_name: "Mike Torres" }],
    user_signatures: [{ company_id: ROOFER, user_id: SALES, image: PNG }],
    memberships: [{ company_id: ROOFER, user_id: SALES, active: true, role: "estimator" }],
  };
}

beforeEach(() => roofer());
afterEach(() => {
  state.tables = {};
  state.rpcs = {};
  state.calls = [];
});

describe("a price range in the Client Hub", () => {
  it("shows the range, what's included and what could change it, and never the exact price", async () => {
    const res = await hub({ t: "quote", id: QUOTE });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.quote.range).toEqual({
      low: 18300, high: 21050, sent_at: "2026-10-22T15:00:00Z", accepted_at: null,
      included: ["Architectural shingle roof", "Tear-off and disposal", "Drip edge", "Pipe boot", "Chimney flashing"],
      // Chimney flashing is on the estimate already, so the chimney that could change it is the cricket.
      maybe: [
        { name: "Rotten decking", price: 95, per: "sheet" },
        { name: "Another layer of old shingles", price: 85, per: "square" },
        { name: "Chimney cricket", price: 450, per: null },
      ],
    });
    expect(body.quote.lines).toEqual([]);
    for (const field of ["subtotal", "discount_amount", "tax_amount", "total", "deposit_amount"]) expect(body.quote[field]).toBeNull();
    const text = JSON.stringify(body);
    expect(text).not.toContain("18304");
    expect(text).not.toContain("unit_cost");
    expect(text).not.toContain("formula");
    expect(text).not.toContain("range_pct");
    expect(body.quote.package).toEqual({ name: "Architectural shingle" });
    expect(body.company.address).toEqual(["200 Main St", "Suite 4", "Springfield, IL 62704"]);
    // The quote's own template, with the defaults filled in.
    expect(body.template).toMatchObject({ header: "centered", license: "RC-104882", company_signs: true, customer_signs: true });
  });

  it("shows the office's preview of a package estimate the range it would get", async () => {
    roofer({ status: "draft", range_low: null, range_high: null, range_sent_at: null });
    const preview = await (await hub({ t: "quote", id: QUOTE, pv: 1 })).json();
    expect(preview.quote.range).toMatchObject({ low: 18300, high: 21050, sent_at: null, accepted_at: null });
    expect(preview.quote.total).toBeNull();
    // Sent the usual way (no range), the client gets the exact estimate.
    roofer({ range_low: null, range_high: null, range_sent_at: null });
    const sent = await (await hub({ t: "quote", id: QUOTE })).json();
    expect(sent.quote.range).toBeNull();
    expect(sent.quote.total).toBe(18304);
    expect(sent.quote.lines.map((l: { id: string }) => l.id)).toEqual(["l1", "l2", "l3", "l4", "l5", "l6"]);
    expect(Object.keys(sent.quote.lines[0]).sort()).toEqual(["description", "id", "name", "option_group", "optional", "quantity", "selected", "sort", "taxable", "unit", "unit_price"]);
    // And the office's preview of it shows the same, not a range the client never got.
    const sentPreview = await (await hub({ t: "quote", id: QUOTE, pv: 1 })).json();
    expect(sentPreview.quote.range).toBeNull();
    expect(sentPreview.quote.total).toBe(18304);
    expect(sentPreview.quote.lines).toHaveLength(6);
  });

  it("keeps the exact price hidden on a range marked lost or archived", async () => {
    for (const status of ["lost", "archived"]) {
      roofer({ status });
      const body = await (await hub({ t: "quote", id: QUOTE })).json();
      expect(body.quote.range, status).toBeNull();
      expect(body.quote.lines, status).toEqual([]);
      for (const field of ["subtotal", "discount_amount", "tax_amount", "total", "deposit_amount"]) expect(body.quote[field], `${status} ${field}`).toBeNull();
      expect(JSON.stringify(body), status).not.toContain("18304");
    }
  });

  it("shows the exact price once the office sends it instead of the range, and it can be signed", async () => {
    roofer({ exact_sent_at: "2026-10-24T15:00:00Z" });
    const body = await (await hub({ t: "quote", id: QUOTE })).json();
    expect(body.quote.range).toBeNull();
    expect(body.quote.total).toBe(18304);
    expect(body.quote.lines).toHaveLength(6);

    const home = await (await hub({ t: "client", id: CLIENT })).json();
    expect(home.quotes.find((q: { id: string }) => q.id === QUOTE)).toMatchObject({ total: 18304, range: null });

    state.rpcs.approve_hub_quote = () => ({ data: true, error: null });
    const approve = await hub({ t: "quote", id: QUOTE }, "/approve", { name: "Dana Whitfield", signature: PNG });
    expect(approve.status).toBe(200);
    expect(state.calls.some((c) => c.name === "approve_hub_quote")).toBe(true);
  });

  it("shows the exact price once it's priced on site", async () => {
    roofer({ priced_on_site_at: "2026-10-25T18:00:00Z", total: 19950 });
    const body = await (await hub({ t: "quote", id: QUOTE })).json();
    expect(body.quote.range).toBeNull();
    expect(body.quote.total).toBe(19950);
  });

  it("takes a yes once, and tells the office", async () => {
    state.rpcs.accept_hub_range = () => ({ data: "2026-10-23T14:00:00Z", error: null });
    const res = await hub({ t: "quote", id: QUOTE }, "/accept-range", {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted_at: "2026-10-23T14:00:00Z" });
    expect(state.calls.find((c) => c.name === "accept_hub_range")?.args).toEqual({ p_company: ROOFER, p_quote: QUOTE });

    state.rpcs.accept_hub_range = () => ({ data: null, error: null });
    const again = await hub({ t: "quote", id: QUOTE }, "/accept-range", {});
    expect(again.status).toBe(409);
    expect((await again.json()).error).toBe("This price range isn't waiting for an answer.");
  });

  it("sends nothing from a preview", async () => {
    const res = await hub({ t: "quote", id: QUOTE, pv: 1 }, "/accept-range", {});
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("This is a preview, so nothing was sent.");
    expect(state.calls.some((c) => c.name === "accept_hub_range")).toBe(false);
  });

  it("can't be signed or given a promo code before the exact price", async () => {
    const approve = await hub({ t: "quote", id: QUOTE }, "/approve", { name: "Dana Whitfield", signature: PNG });
    expect(approve.status).toBe(409);
    const promo = await hub({ t: "quote", id: QUOTE }, "/promo", { code: "SPRING" });
    expect(promo.status).toBe(409);
    expect(state.calls.some((c) => c.name === "approve_hub_quote" || c.name === "apply_promo_code")).toBe(false);
  });

  it("shows the range on the client's home page instead of the total", async () => {
    state.tables.quotes!.push({ ...state.tables.quotes![0], id: "q-exact", number: 1043, range_low: null, range_high: null, total: 950 });
    const res = await hub({ t: "client", id: CLIENT });
    expect(res.status).toBe(200);
    const body = await res.json();
    const ranged = body.quotes.find((q: { id: string }) => q.id === QUOTE);
    expect(ranged).toMatchObject({ total: null, range: { low: 18300, high: 21050, accepted_at: null } });
    expect(body.quotes.find((q: { id: string }) => q.id === "q-exact")).toMatchObject({ total: 950, range: null });
    expect(JSON.stringify(body)).not.toContain("18304");
  });
});

describe("signing online", () => {
  beforeEach(() => roofer({ range_low: null, range_high: null, range_sent_at: null }));

  it("puts the salesperson's saved signature on for the business", async () => {
    state.rpcs.approve_hub_quote = () => ({ data: true, error: null });
    const res = await hub({ t: "quote", id: QUOTE }, "/approve", { name: "Dana Whitfield", signature: PNG });
    expect(res.status).toBe(200);
    const approval = state.calls.find((c) => c.name === "approve_hub_quote")!.args.p_approval as Row;
    expect(approval).toMatchObject({ name: "Dana Whitfield", signature: PNG, company: { name: "Mike Torres", user_id: SALES, signature: PNG } });
    expect(typeof (approval.company as Row).signed_at).toBe("string");
  });

  it("keeps the quote's template with the approval, as it is when the client signs", async () => {
    state.rpcs.approve_hub_quote = () => ({ data: true, error: null });
    await hub({ t: "quote", id: QUOTE }, "/approve", { name: "Dana Whitfield", signature: PNG });
    const approval = state.calls.find((c) => c.name === "approve_hub_quote")!.args.p_approval as Row;
    expect(approval.template).toEqual(templateSettings({ header: "centered", license: "RC-104882", company_signs: true }));

    // A quote on the default template keeps the default as it is now.
    state.calls = [];
    state.tables.quotes![0]!.template_id = null;
    await hub({ t: "quote", id: QUOTE }, "/approve", { name: "Dana Whitfield", signature: PNG });
    expect((state.calls.find((c) => c.name === "approve_hub_quote")!.args.p_approval as Row).template).toEqual(templateSettings({ header: "banner", license: "RC-1" }));
  });

  it("shows a signed quote with the template it was signed with, not today's", async () => {
    const signedWith = templateSettings({ header: "classic", terms: "Payment in full when the roof is done.", license: "RC-99" });
    roofer({
      status: "approved", approved_at: "2026-10-25T18:00:00Z", range_low: null, range_high: null,
      approval: { name: "Dana Whitfield", signature: PNG, signed_at: "2026-10-25T18:00:00Z", template: signedWith, total: 18304 },
    });
    const body = await (await hub({ t: "quote", id: QUOTE })).json();
    expect(body.template).toEqual(signedWith);
    expect(body.quote.approval).not.toHaveProperty("template");

    // Signed before the template was kept with it: the quote's template as it is now.
    state.tables.quotes![0]!.approval = { name: "Dana Whitfield", signature: PNG, signed_at: "2026-10-25T18:00:00Z" };
    expect((await (await hub({ t: "quote", id: QUOTE })).json()).template).toMatchObject({ header: "centered", license: "RC-104882" });

    // Opened again and not signed any more: today's template, whatever the old approval kept.
    state.tables.quotes![0]!.status = "sent";
    state.tables.quotes![0]!.approval = { name: "Dana Whitfield", template: signedWith };
    expect((await (await hub({ t: "quote", id: QUOTE })).json()).template).toMatchObject({ header: "centered", license: "RC-104882" });
  });

  it("leaves the business's line for later when the template has none, or the salesperson left", async () => {
    state.rpcs.approve_hub_quote = () => ({ data: true, error: null });
    state.tables.document_templates![1]!.settings = { company_signs: false };
    await hub({ t: "quote", id: QUOTE }, "/approve", { name: "Dana Whitfield", signature: PNG });
    expect(state.calls.find((c) => c.name === "approve_hub_quote")!.args.p_approval).not.toHaveProperty("company");

    state.calls = [];
    state.tables.document_templates![1]!.settings = { company_signs: true };
    state.tables.memberships![0]!.active = false;
    await hub({ t: "quote", id: QUOTE }, "/approve", { name: "Dana Whitfield", signature: PNG });
    expect(state.calls.find((c) => c.name === "approve_hub_quote")!.args.p_approval).not.toHaveProperty("company");
  });

  it("shows a signed quote with both signatures and never where it was signed from", async () => {
    roofer({
      status: "approved", approved_at: "2026-10-25T18:00:00Z", range_low: null, range_high: null,
      approval: { name: "Dana Whitfield", signature: PNG, signed_at: "2026-10-25T18:00:00Z", ip: "198.51.100.4", method: "in_person", company: { name: "Mike Torres", user_id: SALES, signature: PNG, signed_at: "2026-10-25T18:01:00Z" }, total: 18304 },
    });
    const body = await (await hub({ t: "quote", id: QUOTE })).json();
    expect(body.quote.approval).toEqual({
      name: "Dana Whitfield", signature: PNG, signed_at: "2026-10-25T18:00:00Z", method: "in_person",
      company: { name: "Mike Torres", signature: PNG, signed_at: "2026-10-25T18:01:00Z" },
    });
    expect(JSON.stringify(body)).not.toContain("198.51.100.4");
    expect(body.quote.total).toBe(18304);
    expect(body.quote.lines).toHaveLength(6);
  });

  it("sends no approval for a quote that isn't signed", async () => {
    roofer({ status: "sent", range_low: null, range_high: null, approval: { name: "Old", ip: "198.51.100.4" } });
    const body = await (await hub({ t: "quote", id: QUOTE })).json();
    expect(body.quote.approval).toBeNull();
    expect(JSON.stringify(body)).not.toContain("198.51.100.4");
  });
});

describe("hub helpers", () => {
  it("splits the business's address into letterhead lines", () => {
    expect(addressLines({ line1: "200 Main St", city: "Springfield", region: "IL", postal_code: "62704" })).toEqual(["200 Main St", "Springfield, IL 62704"]);
    expect(addressLines({ city: "Springfield" })).toEqual(["Springfield"]);
    expect(addressLines(null)).toEqual([]);
    expect(addressLines("200 Main St")).toEqual([]);
  });

  it("keeps only real signatures from an approval", () => {
    expect(publicApproval({ name: "Office", method: "manual" }, "2026-10-25T18:00:00Z")).toEqual({ name: "Office", signature: null, signed_at: "2026-10-25T18:00:00Z", method: "manual", company: null });
    expect(publicApproval({ name: "Dana", signature: "javascript:alert(1)", company: { name: "Mike", signature: "not-a-png" } }, null)).toMatchObject({ signature: null, company: null });
    expect(publicApproval(null, null)).toEqual({ name: "", signature: null, signed_at: null, method: null, company: null });
  });

  it("leaves a price set on site out of what's included", () => {
    const details = rangeDetails(
      [
        { service_id: S.roof, name: "Metal roof", unit: "square", unit_price: 1285, formula: "squares", optional: false, selected: true },
        { service_id: null, name: "Price adjustment", unit: "ea", unit_price: 400, formula: null, optional: false, selected: true },
      ],
      [],
    );
    expect(details).toEqual({ included: ["Metal roof"], maybe: [] });
  });
});

describe("automations on a price range", () => {
  it("say the range, not the exact price, and link to the roofing project", async () => {
    state.tables.quotes![0]!.lines = [{ name: "Architectural shingle roof" }];
    const ctx = await loadContext(adminClient(env), ROOFER, "quote", QUOTE);
    expect(ctx?.vars.total).toBe("$18,300 to $21,050");
    expect(ctx?.appPath).toBe(`/roofing/${QUOTE}`);
    expect(ctx?.facts.amount).toBe(18304);

    state.tables.quotes![0]!.priced_on_site_at = "2026-10-25T18:00:00Z";
    state.tables.quotes![0]!.roof_package_id = null;
    const exact = await loadContext(adminClient(env), ROOFER, "quote", QUOTE);
    expect(exact?.vars.total).toBe("$18,304.00");
    expect(exact?.appPath).toBe(`/quotes/${QUOTE}`);
  });

  it("keep the range on one marked lost, and say the exact price once the office sent it instead", async () => {
    const q = state.tables.quotes![0]!;
    q.lines = [];
    q.status = "lost";
    expect((await loadContext(adminClient(env), ROOFER, "quote", QUOTE))?.vars.total).toBe("$18,300 to $21,050");

    q.status = "sent";
    q.exact_sent_at = "2026-10-24T15:00:00Z";
    expect((await loadContext(adminClient(env), ROOFER, "quote", QUOTE))?.vars.total).toBe("$18,304.00");
  });
});
