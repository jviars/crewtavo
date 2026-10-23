import { getPreset, savedRoofingQuantities, type Section } from "@crewtavo/core";
import { followPrice, SITE_ADJUSTMENT_NAME } from "@crewtavo/core/estimates";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { encryptJson } from "../src/lib/crypto";
import { packageLines, type PackageService } from "../src/services/roofPackages";

// Stand-ins for the signed-in person's Supabase client and the service-role client: tables of rows
// that eq, in and order filter, with insert (and insert().select().single()), update and delete.
// A quote row comes back with its lines and client, the way the routes embed them. accept_hub_range
// is the database's step as the migration writes it (only for the service role), and every call is
// kept in `rpcs`.
type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({ tables: {} as Record<string, Row[]>, rpcs: [] as Array<{ by: string; name: string; args: Record<string, unknown> }> }));
vi.mock("../src/lib/supabase", () => {
  const embed = (table: string, row: Row): Row =>
    table === "quotes"
      ? { ...row, lines: (state.tables.quote_line_items ?? []).filter((l) => l.quote_id === row.id), client: (state.tables.clients ?? []).find((c) => c.id === row.client_id) ?? null }
      : row;
  const acceptHubRange = (args: Record<string, unknown>) => {
    const q = (state.tables.quotes ?? []).find(
      (row) =>
        row.company_id === args.p_company && row.id === args.p_quote && ["sent", "changes_requested"].includes(String(row.status)) &&
        row.range_low != null && row.range_accepted_at == null && row.priced_on_site_at == null && row.exact_sent_at == null,
    );
    if (!q) return null;
    q.range_accepted_at = "2026-10-23T15:00:00.000Z";
    return q.range_accepted_at;
  };
  const client = (by: string) => ({
    auth: { getClaims: async () => ({ data: { claims: { sub: "viewer" } }, error: null }) },
    rpc: async (name: string, args: Record<string, unknown> = {}) => {
      state.rpcs.push({ by, name, args });
      if (name === "accept_hub_range") return by === "admin" ? { data: acceptHubRange(args), error: null } : { data: null, error: { message: "permission denied for function accept_hub_range", code: "42501" } };
      return { data: true, error: null };
    },
    from: (table: string) => {
      const filters: Array<(row: Row) => boolean> = [];
      const orders: Array<[string, boolean]> = [];
      let cap: number | null = null;
      let change: { kind: "update"; values: Row } | { kind: "delete" } | null = null;
      let inserted: Row[] | null = null;
      const matching = () => (state.tables[table] ?? []).filter((row) => filters.every((keep) => keep(row)));
      const run = () => {
        if (inserted) return { data: inserted, error: null };
        if (change?.kind === "update") {
          for (const row of matching()) Object.assign(row, change.values);
          return { data: null, error: null };
        }
        if (change?.kind === "delete") {
          state.tables[table] = (state.tables[table] ?? []).filter((row) => !filters.every((keep) => keep(row)));
          return { data: null, error: null };
        }
        let list = matching().map((row) => embed(table, row));
        for (const [column, ascending] of [...orders].reverse()) {
          list = [...list].sort((a, b) => (String(a[column]) < String(b[column]) ? -1 : String(a[column]) > String(b[column]) ? 1 : 0) * (ascending ? 1 : -1));
        }
        if (cap !== null) list = list.slice(0, cap);
        return { data: list, error: null };
      };
      const one = () => {
        const { data } = run();
        return Promise.resolve({ data: Array.isArray(data) ? (data[0] ?? null) : data, error: null });
      };
      const builder: Record<string, unknown> = {
        select: () => builder,
        order: (column: string, options?: { ascending?: boolean }) => (orders.push([column, options?.ascending !== false]), builder),
        limit: (n: number) => ((cap = n), builder),
        eq: (column: string, value: unknown) => (filters.push((row) => row[column] === value), builder),
        is: (column: string, value: unknown) => (filters.push((row) => (row[column] ?? null) === value), builder),
        in: (column: string, values: unknown[]) => (filters.push((row) => values.includes(row[column])), builder),
        match: (values: Row) => (filters.push((row) => Object.entries(values).every(([k, v]) => row[k] === v)), builder),
        insert: (values: Row | Row[]) => {
          inserted = [values].flat().map((row) => ({ id: crypto.randomUUID(), ...row }));
          state.tables[table] = [...(state.tables[table] ?? []), ...inserted];
          return builder;
        },
        // Secrets are keyed by company and provider: a new one replaces the old.
        upsert: (values: Row) => {
          state.tables[table] = [...(state.tables[table] ?? []).filter((row) => !(row.company_id === values.company_id && row.provider === values.provider)), values];
          inserted = [values];
          return builder;
        },
        update: (values: Row) => ((change = { kind: "update", values }), builder),
        delete: () => ((change = { kind: "delete" }), builder),
        maybeSingle: one,
        single: one,
        then: (resolve: (r: unknown) => unknown, reject: (e: unknown) => unknown) => Promise.resolve(run()).then(resolve, reject),
      };
      return builder;
    },
  });
  const user = client("user");
  const admin = client("admin");
  return { userClient: () => user, adminClient: () => admin, publishableKey: () => "key" };
});
const { app } = await import("../src/app");

const env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 5))),
  APP_URL: "https://ops.example.com",
} as Env;
const ROOFER = "00000000-0000-4000-8000-0000000000d1";
const QUOTE = "00000000-0000-4000-8000-0000000000d2";
const PKG = "00000000-0000-4000-8000-0000000000d3";
const ROOF = "00000000-0000-4000-8000-0000000000e1";
const TEAR = "00000000-0000-4000-8000-0000000000e2";
const EDGE = "00000000-0000-4000-8000-0000000000e3";
const STEEP = "00000000-0000-4000-8000-0000000000e4";
const BOOT = "00000000-0000-4000-8000-0000000000e5";
const OFF = "00000000-0000-4000-8000-0000000000e6";
const CLIENT = "00000000-0000-4000-8000-0000000000f1";

const send = (path: string, body?: unknown, method = body === undefined ? "GET" : "POST") =>
  app.request(`/api${path}`, { method, headers: { Authorization: "Bearer token", "X-Company-Id": ROOFER, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
const rows = (table: string) => state.tables[table] ?? [];
const quote = () => rows("quotes").find((q) => q.id === QUOTE)!;

// A 6/12 roof, 2,000 sq ft from above, with 100 ft of eaves and 50 ft of rakes, at 10% waste.
const SECTIONS = [
  { kind: "Area", value: 2000, pitch: "6/12" },
  { kind: "Length", value: 100, edge: "eave" },
  { kind: "Length", value: 50, edge: "rake" },
] as unknown as Section[];
const ROOFING = savedRoofingQuantities(SECTIONS, "6/12", 10);

const service = (id: string, name: string, unit: string, unit_price: number, formula: string | null, extra: Row = {}): Row => ({
  id, company_id: ROOFER, name, unit, unit_price, unit_cost: Math.round(unit_price * 60) / 100, labor_cost: null, taxable: true, formula, formula_target: "quantity", active: true, sort: 0, ...extra,
});

function roofer({ role = "owner", lines = [] as Row[], status = "draft", measured = true } = {}) {
  state.tables = {
    memberships: [{ company_id: ROOFER, user_id: "viewer", active: true, role, role_id: null }],
    companies: [{ id: ROOFER, name: "Peak Roofing", email: "office@peak.example", phone: "555-0100", address: {}, currency: "USD", settings: {} }],
    clients: [{ id: CLIENT, company_id: ROOFER, display_name: "Dana Whitfield", email: "dana@example.com", phone: "555-0142" }],
    quotes: [{ id: QUOTE, company_id: ROOFER, number: 1042, status, total: 18304, client_id: CLIENT, promo_code_id: null, roof_package_id: null, discount_amount: 0, subtotal: 18304, tax_amount: 0 }],
    quote_line_items: lines.map((l) => ({ quote_id: QUOTE, company_id: ROOFER, ...l })),
    services: [
      service(ROOF, "Architectural shingle roof", "square", 560, "squares"),
      service(TEAR, "Tear-off and disposal", "square", 85, "roof_squares"),
      service(EDGE, "Drip edge", "ft", 3.5, "eave_ft + rake_ft"),
      service(STEEP, "Steep roof charge", "square", 65, "steep_squares"),
      service(BOOT, "Pipe boot", "ea", 45, null),
      service(OFF, "Old service", "ea", 10, null, { active: false }),
    ],
    service_materials: [],
    roof_packages: [{ id: PKG, company_id: ROOFER, name: "Architectural shingle", style: "shingle", roof_service_id: ROOF, price_mode: "manual", markup_pct: 70, is_default: true, sort: 0 }],
    roof_package_items: [
      { id: "i1", company_id: ROOFER, package_id: PKG, service_id: TEAR, kind: "included", quantity: null, sort: 0 },
      { id: "i2", company_id: ROOFER, package_id: PKG, service_id: EDGE, kind: "included", quantity: null, sort: 1 },
      { id: "i3", company_id: ROOFER, package_id: PKG, service_id: STEEP, kind: "included", quantity: null, sort: 2 },
      { id: "i4", company_id: ROOFER, package_id: PKG, service_id: BOOT, kind: "included", quantity: 3, sort: 3 },
      { id: "i5", company_id: ROOFER, package_id: PKG, service_id: OFF, kind: "included", quantity: null, sort: 4 },
      { id: "i6", company_id: ROOFER, package_id: PKG, service_id: EDGE, kind: "quick", quantity: null, sort: 0 },
    ],
    measurements: measured
      ? [
          { id: "m-old", company_id: ROOFER, quote_id: QUOTE, total_area_sqft: 10, total_area_sqyd: 1, total_length_ft: 0, sections: [], roof_pitch: "6/12", waste_pct: 10, show_on_quote: false, updated_at: "2026-10-01T00:00:00Z" },
          { id: "m-new", company_id: ROOFER, quote_id: QUOTE, total_area_sqft: 2000, total_area_sqyd: 222.22, total_length_ft: 150, sections: SECTIONS, roof_pitch: "6/12", waste_pct: 10, show_on_quote: false, updated_at: "2026-10-20T00:00:00Z" },
        ]
      : [],
    messages: [],
    integrations: [],
    integration_secrets: [],
  };
}

const fetcher = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
beforeEach(() => {
  fetcher.mockReset();
  fetcher.mockImplementation(async () => Response.json({ ID: "mail-1" }));
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => {
  vi.unstubAllGlobals();
  state.tables = {};
  state.rpcs = [];
});

describe("setting up roofing", () => {
  it("adds the standard services and packages, once", async () => {
    state.tables = { memberships: [{ company_id: ROOFER, user_id: "viewer", active: true, role: "office", role_id: null }], services: [], roof_packages: [], roof_package_items: [] };
    const res = await send("/roofing/setup", {});
    expect(res.status).toBe(200);
    const body = await res.json();
    const preset = getPreset("roofing_exteriors");
    expect(body.services_added).toEqual(preset.services.map((s) => s.name));
    expect(body.packages_created).toBe(3);

    const packages = rows("roof_packages");
    expect(packages.map((p) => [p.name, p.style, p.is_default])).toEqual([
      ["Architectural shingle", "shingle", true],
      ["Designer shingle", "designer", false],
      ["Standing-seam metal", "metal", false],
    ]);
    const nameOf = (id: unknown) => rows("services").find((s) => s.id === id)?.name;
    expect(nameOf(packages[0]!.roof_service_id)).toBe("Architectural shingle roof");
    const items = (kind: string) => rows("roof_package_items").filter((i) => i.package_id === packages[0]!.id && i.kind === kind).sort((a, b) => Number(a.sort) - Number(b.sort));
    expect(items("included").map((i) => nameOf(i.service_id))).toEqual(preset.packages![0]!.included.map((i) => i.service));
    expect(items("included").find((i) => nameOf(i.service_id) === "Pipe boot")?.quantity).toBe(3);
    expect(items("quick").map((i) => nameOf(i.service_id))).toEqual(preset.packages![0]!.quick);

    const again = await (await send("/roofing/setup", {})).json();
    expect(again).toEqual({ services_added: [], packages_created: 0 });
    expect(rows("roof_packages")).toHaveLength(3);
  });

  it("is for the office", async () => {
    roofer({ role: "estimator" });
    expect((await send("/roofing/setup", {})).status).toBe(403);
  });
});

describe("a package on an estimate", () => {
  it("puts the roof first, then what's always on it, measured from the newest drawing", async () => {
    roofer();
    const res = await send(`/roofing/${QUOTE}/package`, { package_id: PKG });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ applied: true, lines: 4 });
    expect(body.skipped).toEqual([{ name: "Steep roof charge", reason: "None on this roof" }]);
    const lines = rows("quote_line_items").sort((a, b) => Number(a.sort) - Number(b.sort));
    expect(lines.map((l) => [l.name, l.quantity, l.unit_price])).toEqual([
      ["Architectural shingle roof", ROOFING.squares, 560],
      ["Tear-off and disposal", ROOFING.roof_squares, 85],
      ["Drip edge", 150, 3.5],
      ["Pipe boot", 3, 45],
    ]);
    expect(lines[0]).toMatchObject({ company_id: ROOFER, quote_id: QUOTE, service_id: ROOF, unit: "square", unit_cost: 336, taxable: true, formula: "squares" });
    expect(quote().roof_package_id).toBe(PKG);
    expect(rows("measurements").find((m) => m.id === "m-new")).toMatchObject({ show_on_quote: true, quote_id: QUOTE });
    expect(rows("measurements").find((m) => m.id === "m-old")?.show_on_quote).toBe(false);
  });

  it("keeps an estimate's own lines unless asked to start over", async () => {
    roofer({ lines: [{ id: "keep", name: "Roof repair", quantity: 1, unit_price: 650, sort: 0 }] });
    const kept = await (await send(`/roofing/${QUOTE}/package`, { package_id: PKG })).json();
    expect(kept).toEqual({ applied: false });
    expect(quote().roof_package_id).toBe(PKG);
    expect(rows("quote_line_items").map((l) => l.id)).toEqual(["keep"]);

    const replaced = await (await send(`/roofing/${QUOTE}/package`, { package_id: PKG, replace: true })).json();
    expect(replaced).toMatchObject({ applied: true, lines: 4 });
    expect(rows("quote_line_items").some((l) => l.id === "keep")).toBe(false);
  });

  it("starts the price over too when it starts over from a package", async () => {
    const repair = [{ id: "keep", name: "Roof repair", quantity: 1, unit_price: 650, sort: 0 }];
    // A price set on site (a discount) and an exact price sent instead of the range were for the old lines.
    roofer({ lines: repair });
    Object.assign(quote(), { priced_on_site_at: "2026-10-20T15:00:00Z", exact_sent_at: "2026-10-21T15:00:00Z", discount_amount: 804 });
    await send(`/roofing/${QUOTE}/package`, { package_id: PKG, replace: true });
    expect(quote()).toMatchObject({ priced_on_site_at: null, exact_sent_at: null, discount_amount: 0 });

    // A promo code keeps its discount.
    roofer({ lines: repair });
    Object.assign(quote(), { promo_code_id: "00000000-0000-4000-8000-0000000000a9", priced_on_site_at: "2026-10-20T15:00:00Z", discount_amount: 250 });
    await send(`/roofing/${QUOTE}/package`, { package_id: PKG, replace: true });
    expect(quote()).toMatchObject({ priced_on_site_at: null, discount_amount: 250 });

    // Keeping the lines keeps the price.
    roofer({ lines: repair });
    Object.assign(quote(), { priced_on_site_at: "2026-10-20T15:00:00Z", discount_amount: 804 });
    await send(`/roofing/${QUOTE}/package`, { package_id: PKG });
    expect(quote()).toMatchObject({ priced_on_site_at: "2026-10-20T15:00:00Z", discount_amount: 804 });
  });

  it("needs the roof measured, and an estimate that isn't signed", async () => {
    roofer({ measured: false });
    const unmeasured = await send(`/roofing/${QUOTE}/package`, { package_id: PKG });
    expect(unmeasured.status).toBe(409);
    expect((await unmeasured.json()).error).toBe("Measure the roof first.");
    expect(rows("quote_line_items")).toEqual([]);

    roofer({ status: "approved" });
    const signed = await send(`/roofing/${QUOTE}/package`, { package_id: PKG });
    expect(signed.status).toBe(409);
    expect((await signed.json()).error).toBe("This estimate was already signed, so it can't change.");
  });

  it("prices a package that follows ABC at today's materials, and the price list follows", async () => {
    roofer();
    rows("roof_packages")[0]!.price_mode = "follow";
    rows("roof_packages")[0]!.markup_pct = 70;
    rows("services").find((s) => s.id === ROOF)!.labor_cost = 182;
    state.tables.service_materials = [
      { id: "sm1", company_id: ROOFER, service_id: ROOF, per_unit: 3, unit_price: 40 },
      { id: "sm2", company_id: ROOFER, service_id: ROOF, per_unit: 0.1, unit_price: 73.7 },
    ];
    await send(`/roofing/${QUOTE}/package`, { package_id: PKG });
    const price = followPrice(3 * 40 + 0.1 * 73.7, 182, 70);
    expect(rows("quote_line_items").find((l) => l.service_id === ROOF)?.unit_price).toBe(price);
    expect(rows("services").find((s) => s.id === ROOF)?.unit_price).toBe(price);
  });

  it("starts counted services at the package's count, and leaves off what isn't on this roof", () => {
    const svc = (id: string, formula: string | null, extra: Partial<PackageService> = {}): PackageService => ({ id, name: id, unit: "ea", unit_price: 10, unit_cost: null, taxable: true, formula, formula_target: "quantity", active: true, ...extra });
    const vars = { squares: 22, steep_squares: 0, eave_ft: 80, waste: 0.1 } as never;
    const built = packageLines(svc("roof", "squares"), [
      { service: svc("boots", null), quantity: 3 },
      { service: svc("dumpster", null), quantity: null },
      { service: svc("steep", "steep_squares"), quantity: null },
      { service: svc("roof", "squares"), quantity: null },
      { service: svc("permit", "eave_ft * 0 + 250", { formula_target: "unit_price" }), quantity: null },
      { service: svc("broken", "nonsense_ft"), quantity: null },
    ], vars);
    expect(built.lines.map((l) => [l.service_id, l.quantity, l.unit_price, l.sort])).toEqual([
      ["roof", 22, 10, 0],
      ["boots", 3, 10, 1],
      ["dumpster", 1, 10, 2],
      ["permit", 1, 250, 3],
    ]);
    expect(built.skipped.map((s) => s.name)).toEqual(["steep", "broken"]);
    expect(built.roofProblem).toBeNull();
  });
});

describe("the price range", () => {
  const lines = [
    { id: "l1", service_id: ROOF, name: "Architectural shingle roof", quantity: 30, unit: "square", unit_price: 560, unit_cost: 330, taxable: true, formula: "squares", optional: false, selected: true, sort: 0 },
    { id: "l2", service_id: BOOT, name: "Pipe boot", quantity: 3, unit: "ea", unit_price: 45, unit_cost: 15, taxable: true, formula: null, optional: false, selected: true, sort: 1 },
  ];

  it("saves the range and the lines it came from, and takes the link to share", async () => {
    roofer({ lines });
    quote().range_accepted_at = "2026-10-10T00:00:00Z";
    quote().priced_on_site_at = "2026-10-11T00:00:00Z";
    quote().exact_sent_at = "2026-10-12T00:00:00Z";
    const res = await send(`/roofing/${QUOTE}/send-range`, { channel: "link" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ sent: false, range: { low: 18300, high: 21050 } });
    expect(body.link).toMatch(/^https:\/\/ops\.example\.com\//);
    expect(quote()).toMatchObject({ range_low: 18300, range_high: 21050, range_accepted_at: null, priced_on_site_at: null, exact_sent_at: null, status: "sent" });
    expect(quote().range_sent_at).toEqual(expect.any(String));
    expect(quote().range_lines).toEqual([
      { id: "l1", service_id: ROOF, name: "Architectural shingle roof", quantity: 30, unit: "square", unit_price: 560, unit_cost: 330, taxable: true, formula: "squares", total: 16800 },
      { id: "l2", service_id: BOOT, name: "Pipe boot", quantity: 3, unit: "ea", unit_price: 45, unit_cost: 15, taxable: true, formula: null, total: 135 },
    ]);
  });

  it("emails the range in its own words, with the business's room on top and rounding", async () => {
    roofer({ lines });
    rows("companies")[0]!.settings = { roofing: { range_pct: 10, range_round: 100 } };
    env.MAILPIT_URL = "http://mailpit.local";
    try {
      const body = await (await send(`/roofing/${QUOTE}/send-range`, { channel: "email" })).json();
      expect(body).toMatchObject({ sent: true, range: { low: 18300, high: 20200 } });
    } finally {
      delete env.MAILPIT_URL;
    }
    const mail = JSON.parse(String(fetcher.mock.calls.find(([url]) => String(url).includes("mailpit"))![1]!.body));
    expect(mail.Subject).toBe("Your roof estimate from Peak Roofing");
    expect(mail.To).toEqual([{ Email: "dana@example.com" }]);
    expect(mail.Text).toContain("Hi Dana,");
    expect(mail.Text).toContain("your new roof will cost between $18,300 and $20,200.");
    expect(rows("messages")[0]).toMatchObject({ channel: "email", subject: "Your roof estimate from Peak Roofing", related_type: "quote", related_id: QUOTE });
    expect(quote().status).toBe("sent");
  });

  it("checks where it's going before changing anything", async () => {
    roofer({ lines });
    rows("clients")[0]!.email = null;
    const res = await send(`/roofing/${QUOTE}/send-range`, { channel: "email" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Add a valid email address for this client first.");
    expect(quote().range_low).toBeUndefined();
    expect(quote().status).toBe("draft");

    roofer();
    const empty = await send(`/roofing/${QUOTE}/send-range`, { channel: "link" });
    expect(empty.status).toBe(400);
  });
});

describe("a yes to the range, marked by the office", () => {
  const lines = [{ id: "l1", service_id: ROOF, name: "Architectural shingle roof", quantity: 30, unit: "square", unit_price: 560, sort: 0, selected: true }];
  const waiting = (patch: Row = {}, role = "office") => {
    roofer({ lines, status: "sent", role });
    Object.assign(quote(), { range_low: 18300, range_high: 21050, range_sent_at: "2026-10-22T13:20:00Z", range_accepted_at: null, priced_on_site_at: null, exact_sent_at: null }, patch);
    state.tables.profiles = [{ user_id: "viewer", full_name: "Sarah Lopez" }];
  };
  const mark = (body: unknown = {}) => send(`/roofing/${QUOTE}/range-accepted`, body);
  const accepts = () => state.rpcs.filter((r) => r.name === "accept_hub_range");

  it("says yes for them through the database's own step, and notes who marked it", async () => {
    waiting();
    const res = await mark({ note: "  Called the office Tuesday " });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted_at: "2026-10-23T15:00:00.000Z" });
    expect(accepts()).toEqual([{ by: "admin", name: "accept_hub_range", args: { p_company: ROOFER, p_quote: QUOTE } }]);
    expect(quote().range_accepted_at).toBe("2026-10-23T15:00:00.000Z");
    expect(rows("messages")).toEqual([
      expect.objectContaining({
        company_id: ROOFER,
        client_id: CLIENT,
        channel: "note",
        direction: "internal",
        related_type: "quote",
        related_id: QUOTE,
        sent_by: "viewer",
        body: "Dana Whitfield said yes to the range ($18,300 to $21,050), marked by Sarah Lopez.\nCalled the office Tuesday",
      }),
    ]);
  });

  it("works without a note, and for a client who asked a question first", async () => {
    waiting({ status: "changes_requested" }, "estimator");
    state.tables.profiles = [];
    expect((await mark()).status).toBe(200);
    expect(rows("messages")[0]!.body).toBe("Dana Whitfield said yes to the range ($18,300 to $21,050), marked by the office.");
  });

  it("only while the range is out and waiting for an answer", async () => {
    const cases: Array<[string, Row]> = [
      ["no range", { range_low: null, range_high: null, range_sent_at: null }],
      ["the exact price went out instead", { exact_sent_at: "2026-10-23T14:00:00Z" }],
      ["priced on site", { priced_on_site_at: "2026-10-24T18:00:00Z" }],
      ["they already said yes", { range_accepted_at: "2026-10-23T12:00:00Z" }],
      ["signed", { status: "approved" }],
      ["lost", { status: "lost" }],
    ];
    for (const [why, patch] of cases) {
      waiting(patch);
      const res = await mark({ note: "Called" });
      expect(res.status, why).toBe(409);
      expect((await res.json()).error, why).toBe("This price range isn't waiting for an answer.");
      expect(rows("messages"), why).toEqual([]);
    }
    expect(accepts()).toEqual([]);
  });

  it("takes no for an answer from the database too", async () => {
    // A range saved on a draft (its email didn't go): the homeowner was never sent it, so the step refuses.
    waiting({ status: "draft" });
    const res = await mark();
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("This price range isn't waiting for an answer.");
    expect(accepts()).toHaveLength(1);
    expect(quote().range_accepted_at).toBeNull();
    expect(rows("messages")).toEqual([]);
  });

  it("is for people who sell, in their own business", async () => {
    for (const role of ["crew_lead", "field_crew"]) {
      waiting({}, role);
      expect((await mark()).status, role).toBe(403);
    }
    waiting();
    quote().company_id = "00000000-0000-4000-8000-0000000000d9";
    const other = await mark();
    expect(other.status).toBe(404);
    expect((await other.json()).error).toBe("That estimate wasn't found.");

    waiting();
    expect((await mark({ note: "x".repeat(501) })).status).toBe(400);
    expect(accepts()).toEqual([]);
    expect(quote().range_accepted_at).toBeNull();
  });
});

describe("sending a roof estimate the usual way", () => {
  const lines = [{ id: "l1", service_id: ROOF, name: "Architectural shingle roof", quantity: 30, unit: "square", unit_price: 560, sort: 0, selected: true }];
  const emailed = async () => {
    env.MAILPIT_URL = "http://mailpit.local";
    try {
      const res = await send(`/quotes/${QUOTE}/send`, { channel: "email" });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ sent: true });
    } finally {
      delete env.MAILPIT_URL;
    }
    return JSON.parse(String(fetcher.mock.calls.find(([url]) => String(url).includes("mailpit"))![1]!.body));
  };

  it("says the range, never the exact total, while it's out as a range", async () => {
    roofer({ lines, status: "sent" });
    Object.assign(quote(), { range_low: 18300, range_high: 21050, priced_on_site_at: null, exact_sent_at: null, total: 19768.32 });
    const mail = await emailed();
    expect(mail.Subject).toBe("Your roof estimate from Peak Roofing");
    expect(mail.Text).toContain("your new roof will cost between $18,300 and $21,050.");
    expect(mail.Text).not.toContain("19,768");
    expect(rows("messages")[0]).toMatchObject({ subject: "Your roof estimate from Peak Roofing", related_type: "quote", related_id: QUOTE });
    expect(String(rows("messages")[0]!.body)).not.toContain("19,768");
  });

  it("gives the exact total once it's priced on site or sent at the exact price", async () => {
    for (const exact of [{ priced_on_site_at: "2026-10-24T15:00:00Z" }, { exact_sent_at: "2026-10-24T15:00:00Z" }]) {
      fetcher.mockClear();
      roofer({ lines, status: "sent" });
      Object.assign(quote(), { range_low: 18300, range_high: 21050, priced_on_site_at: null, exact_sent_at: null, total: 19768.32 }, exact);
      const mail = await emailed();
      expect(mail.Subject).toBe("Quote #1042 from Peak Roofing");
      expect(mail.Text).toContain("Here's your quote ($19,768.32).");
    }
  });
});

describe("the price set on site", () => {
  const lines = [
    { id: "l1", service_id: ROOF, name: "Architectural shingle roof", formula: "squares", quantity: 30, unit_price: 560, selected: true, sort: 0 },
    { id: "l2", service_id: null, name: "Gutter guards", formula: null, quantity: 1, unit_price: 500, selected: false, optional: true, sort: 1 },
    { id: "adj", service_id: null, name: SITE_ADJUSTMENT_NAME, formula: null, quantity: 1, unit_price: 400, selected: true, sort: 2 },
  ];

  it("takes a lower price off as a discount, and drops the old adjustment", async () => {
    roofer({ lines });
    const res = await send(`/roofing/${QUOTE}/site-price`, { price: 16000 }, "PUT");
    expect(res.status).toBe(200);
    expect(quote().discount_amount).toBe(800);
    expect(quote().priced_on_site_at).toEqual(expect.any(String));
    expect(rows("quote_line_items").map((l) => l.id)).toEqual(["l1", "l2"]);
    expect(Object.keys(await res.json()).sort()).toEqual(["discount_amount", "subtotal", "tax_amount", "total"]);
  });

  it("puts a higher price on as an adjustment line, with the note for the office", async () => {
    roofer({ lines });
    quote().discount_amount = 300;
    await send(`/roofing/${QUOTE}/site-price`, { price: 17250.5, note: "Two layers under the porch" }, "PUT");
    expect(quote().discount_amount).toBe(0);
    const adjustment = rows("quote_line_items").filter((l) => l.name === SITE_ADJUSTMENT_NAME);
    expect(adjustment).toHaveLength(1);
    expect(adjustment[0]).toMatchObject({ service_id: null, formula: null, quantity: 1, unit: "ea", unit_price: 450.5, taxable: true, description: "Two layers under the porch", sort: 3 });
    expect(rows("messages")).toEqual([expect.objectContaining({ channel: "note", direction: "internal", body: "Two layers under the porch", related_type: "quote", related_id: QUOTE, client_id: CLIENT })]);
  });

  it("goes back to the estimate as it is", async () => {
    roofer({ lines });
    quote().discount_amount = 300;
    await send(`/roofing/${QUOTE}/site-price`, { price: null }, "PUT");
    expect(quote().discount_amount).toBe(0);
    expect(rows("quote_line_items").some((l) => l.name === SITE_ADJUSTMENT_NAME)).toBe(false);
  });

  it("won't fight a promo code or change a signed estimate", async () => {
    roofer({ lines });
    quote().promo_code_id = "00000000-0000-4000-8000-0000000000a9";
    const promo = await send(`/roofing/${QUOTE}/site-price`, { price: 16000 }, "PUT");
    expect(promo.status).toBe(409);
    expect((await promo.json()).error).toBe("Take the promo code off first.");
    expect(rows("quote_line_items")).toHaveLength(3);

    roofer({ lines, status: "converted" });
    expect((await send(`/roofing/${QUOTE}/site-price`, { price: 16000 }, "PUT")).status).toBe(409);
    expect((await send(`/roofing/${QUOTE}/site-price`, { price: -1 }, "PUT")).status).toBe(400);
  });
});

describe("the packages' ABC prices", () => {
  it("prices their materials at the branch today, and moves a following package's roof price", async () => {
    roofer();
    rows("roof_packages")[0]!.price_mode = "follow";
    rows("services").find((s) => s.id === ROOF)!.labor_cost = 182;
    state.tables.service_materials = [{ id: "sm1", company_id: ROOFER, service_id: ROOF, item_number: "02GASTZ3WW", name: "Timberline HDZ", uom: "BD", length_ft: null, per_unit: 3, unit_price: 40, priced_at: null }];
    state.tables.integrations = [{ company_id: ROOFER, provider: "abc_supply", status: "connected", settings: { environment: "sandbox", ship_to: "1163698", ship_to_name: "PEAK", branch: "18", branch_name: "ABC Supply - Madison, WI", accounts: [] } }];
    state.tables.integration_secrets = [{ company_id: ROOFER, provider: "abc_supply", ciphertext: await encryptJson(env, { extra: { client_id: "id", client_secret: "secret", environment: "sandbox" } }) }];
    fetcher.mockImplementation(async (url, init) => {
      const u = String(url);
      if (u.includes("/oauth2/")) return Response.json({ access_token: "token-1", expires_in: 1800, token_type: "Bearer" });
      if (u.includes("/pricing/v2/prices")) {
        const asked = JSON.parse(String(init?.body));
        return Response.json({ lines: asked.lines.map((l: { id: string }) => ({ id: l.id, unitPrice: 42.5, status: { code: "OK" } })) });
      }
      return new Response("{}", { status: 404 });
    });
    const res = await send("/roofing/prices", {});
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ branch_name: "ABC Supply - Madison, WI", services: 1 });
    expect(rows("service_materials")[0]).toMatchObject({ unit_price: 42.5, priced_at: expect.any(String) });
    const roof = rows("services").find((s) => s.id === ROOF)!;
    expect(roof.unit_cost).toBe(127.5 + 182);
    expect(roof.unit_price).toBe(followPrice(127.5, 182, 70));
  });
});
