/**
 * Estimates that offer two or three options (routes/packages.ts, services/quoteOptions.ts): the
 * lines each package puts on its option, worked out and checked before anything is written, the
 * order and the Good, Better and Best they're offered in, the estimate as it is becoming option 1,
 * options offered before the roof is measured and filled in after, the deposit kept within the
 * cheapest option's price, taking one off, and copying a quote. What the database functions
 * themselves do is tested in supabase/tests.
 */
import { savedRoofingQuantities, type Section } from "@crewtavo/core";
import { optionBaseTotal } from "@crewtavo/core/money";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";

// Stand-ins for the signed-in person's Supabase client: tables of rows that eq, in and order filter,
// with insert, update and delete. A quote comes back with its lines, options and promo code, the way
// the routes embed them. The options functions do what the migration's do, simply, and every call
// is kept in `rpcs`; `meanwhile` runs before the next one.
type Row = Record<string, any>;
const state = vi.hoisted(() => ({
  tables: {} as Record<string, Row[]>,
  rpcs: [] as Array<{ name: string; args: Record<string, any> }>,
  writes: [] as string[],
  /** Runs once, before the next database function: something that happens meanwhile on another screen. */
  meanwhile: null as (() => void) | null,
}));
vi.mock("../src/lib/supabase", () => {
  const t = (name: string) => (state.tables[name] ??= []);
  const optionsOf = (quoteId: string) => t("quote_options").filter((o) => o.quote_id === quoteId).sort((a, b) => a.sort - b.sort);
  const embed = (table: string, row: Row): Row =>
    table === "quotes"
      ? { ...row, lines: t("quote_line_items").filter((l) => l.quote_id === row.id), options: optionsOf(row.id), promo: null }
      : row;
  const show = (q: Row) => {
    if (!optionsOf(q.id).some((o) => o.id === q.option_id)) q.option_id = optionsOf(q.id)[0]?.id ?? null;
  };
  const addLines = (q: Row, optionId: string, lines: Row[]) =>
    t("quote_line_items").push(...lines.map((l) => ({ id: crypto.randomUUID(), company_id: q.company_id, quote_id: q.id, option_id: optionId, optional: false, selected: q.option_id === optionId, ...l })));
  const rpcs: Record<string, (args: Row) => unknown> = {
    apply_quote_options: (args) => {
      const q = t("quotes").find((row) => row.id === args.p_quote)!;
      if (args.p_mode === "replace") {
        state.tables.quote_line_items = t("quote_line_items").filter((l) => l.quote_id !== q.id);
        state.tables.quote_options = t("quote_options").filter((o) => o.quote_id !== q.id);
      }
      if (args.p_mode === "fill") {
        for (const o of args.p_options) if (!t("quote_line_items").some((l) => l.option_id === o.id)) addLines(q, o.id, o.lines);
        return optionsOf(q.id);
      }
      if (args.p_mode === "add" && !optionsOf(q.id).length && t("quote_line_items").some((l) => l.quote_id === q.id)) {
        const pkg = t("roof_packages").find((p) => p.id === q.roof_package_id);
        const current = args.p_current ?? {};
        const id = crypto.randomUUID();
        t("quote_options").push({ id, company_id: q.company_id, quote_id: q.id, package_id: pkg?.id ?? null, name: current.name ?? pkg?.name ?? "Option 1", tier: "tier" in current ? current.tier : (pkg?.tier ?? null), sort: current.sort ?? -1 });
        for (const l of t("quote_line_items")) if (l.quote_id === q.id && !l.option_id && !(args.p_shared ?? []).includes(l.id)) l.option_id = id;
      }
      for (const { lines, ...o } of args.p_options) {
        const id = crypto.randomUUID();
        t("quote_options").push({ id, company_id: q.company_id, quote_id: q.id, ...o });
        addLines(q, id, lines);
      }
      show(q);
      return optionsOf(q.id);
    },
    remove_quote_option: (args) => {
      const q = t("quotes").find((row) => row.id === args.p_quote)!;
      state.tables.quote_options = t("quote_options").filter((o) => o.id !== args.p_option);
      state.tables.quote_line_items = t("quote_line_items").filter((l) => l.option_id !== args.p_option);
      const left = optionsOf(q.id);
      if (left.length === 1) {
        for (const l of t("quote_line_items")) if (l.option_id === left[0]!.id) l.option_id = null;
        state.tables.quote_options = t("quote_options").filter((o) => o.id !== left[0]!.id);
      }
      show(q);
      return optionsOf(q.id);
    },
    put_quote_package: (args) => {
      const q = t("quotes").find((row) => row.id === args.p_quote)!;
      const had = t("quote_options").some((o) => o.quote_id === q.id);
      if (args.p_replace) {
        state.tables.quote_line_items = t("quote_line_items").filter((l) => l.quote_id !== q.id);
        state.tables.quote_options = t("quote_options").filter((o) => o.quote_id !== q.id);
        Object.assign(q, { option_id: null, priced_on_site_at: null, exact_sent_at: null, ...(q.promo_code_id ? {} : { discount_amount: 0 }) });
      }
      // The package's contract sections, as the database swaps them: the old package's come off
      // (unless this one brings them too; nothing comes off a quote that had options), this one's go on.
      const sectionsOf = (id: unknown) => (t("roof_packages").find((p) => p.id === id && p.company_id === q.company_id)?.section_ids as string[] | undefined) ?? [];
      const before = had ? [] : sectionsOf(q.roof_package_id);
      const after = sectionsOf(args.p_package);
      const kept = ((q.section_ids as string[] | undefined) ?? []).filter((id) => after.includes(id) || !before.includes(id));
      Object.assign(q, { roof_package_id: args.p_package, section_ids: [...new Set([...kept, ...after])].slice(0, 50) });
      if (t("quote_line_items").some((l) => l.quote_id === q.id)) return false;
      t("quote_line_items").push(...args.p_lines.map((l: Row) => ({ id: crypto.randomUUID(), company_id: q.company_id, quote_id: q.id, option_id: null, optional: false, selected: true, ...l })));
      return true;
    },
    duplicate_quote: () => COPY,
  };
  const client = () => ({
    auth: { getClaims: async () => ({ data: { claims: { sub: "viewer" } }, error: null }) },
    rpc: async (name: string, args: Row = {}) => {
      const meanwhile = state.meanwhile;
      state.meanwhile = null;
      meanwhile?.();
      if (rpcs[name]) state.rpcs.push({ name, args: structuredClone(args) });
      return { data: rpcs[name] ? rpcs[name](args) : true, error: null };
    },
    from: (table: string) => {
      const filters: Array<(row: Row) => boolean> = [];
      const orders: Array<[string, boolean]> = [];
      let cap: number | null = null;
      let change: { kind: "update"; values: Row } | { kind: "delete" } | null = null;
      let inserted: Row[] | null = null;
      const matching = () => t(table).filter((row) => filters.every((keep) => keep(row)));
      const run = () => {
        if (inserted) return { data: inserted, error: null };
        if (change?.kind === "update") {
          state.writes.push(`update ${table}`);
          const hit = matching();
          for (const row of hit) Object.assign(row, change.values);
          return { data: hit, error: null };
        }
        if (change?.kind === "delete") {
          state.writes.push(`delete ${table}`);
          state.tables[table] = t(table).filter((row) => !filters.every((keep) => keep(row)));
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
      const builder: Row = {
        select: () => builder,
        order: (column: string, options?: { ascending?: boolean }) => (orders.push([column, options?.ascending !== false]), builder),
        limit: (n: number) => ((cap = n), builder),
        eq: (column: string, value: unknown) => (filters.push((row) => row[column] === value), builder),
        in: (column: string, values: unknown[]) => (filters.push((row) => values.includes(row[column])), builder),
        insert: (values: Row | Row[]) => {
          state.writes.push(`insert ${table}`);
          inserted = [values].flat().map((row) => ({ id: crypto.randomUUID(), ...row }));
          t(table).push(...inserted);
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
  const user = client();
  return { userClient: () => user, adminClient: () => user, publishableKey: () => "key" };
});
const { app } = await import("../src/app");

const env = { SUPABASE_URL: "https://example.supabase.co", SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test", SUPABASE_SECRET_KEY: "sb_secret_test" } as Env;
const CO = "00000000-0000-4000-8000-0000000000d1";
const OTHER = "00000000-0000-4000-8000-0000000000d9";
const QUOTE = "00000000-0000-4000-8000-0000000000d2";
const COPY = "00000000-0000-4000-8000-0000000000d3";
const SHINGLE = "00000000-0000-4000-8000-0000000000a1";
const DESIGNER = "00000000-0000-4000-8000-0000000000a2";
const METAL = "00000000-0000-4000-8000-0000000000a3";
const ROOF = "00000000-0000-4000-8000-0000000000e1";
const SLATE = "00000000-0000-4000-8000-0000000000e2";
const PANELS = "00000000-0000-4000-8000-0000000000e3";
const TEAR = "00000000-0000-4000-8000-0000000000e4";
const BOOT = "00000000-0000-4000-8000-0000000000e5";
const SECTION = "00000000-0000-4000-8000-0000000000f1";
const GOOD = "00000000-0000-4000-8000-0000000000b1";
const BETTER = "00000000-0000-4000-8000-0000000000b2";
const PICTURE = `${CO}/packages/11111111-1111-4111-8111-111111111111.jpg`;
const L1 = "00000000-0000-4000-8000-000000000101";
const L2 = "00000000-0000-4000-8000-000000000102";

const send = (path: string, body?: unknown, method = "POST") =>
  app.request(`/api${path}`, { method, headers: { Authorization: "Bearer token", "X-Company-Id": CO, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, env);
const offer = (body: Row) => send(`/quotes/${QUOTE}/options`, body);
const rows = (table: string) => state.tables[table] ?? [];
const quote = () => rows("quotes").find((q) => q.id === QUOTE)!;
const applied = () => state.rpcs.filter((r) => r.name === "apply_quote_options");

// A 6/12 roof, 2,000 sq ft from above, at 10% waste.
const SECTIONS = [{ kind: "Area", value: 2000, pitch: "6/12" }] as unknown as Section[];
const ROOFING = savedRoofingQuantities(SECTIONS, "6/12", 10);
const MEASUREMENT = { id: "m1", company_id: CO, quote_id: QUOTE, total_area_sqft: 2000, total_area_sqyd: 222.22, total_length_ft: 0, sections: SECTIONS, roof_pitch: "6/12", roofing_squares: ROOFING.squares, waste_pct: 10, show_on_quote: false, updated_at: "2026-10-20T00:00:00Z" };

const service = (id: string, name: string, unit: string, unit_price: number, formula: string | null): Row => ({
  id, company_id: CO, name, unit, unit_price, unit_cost: Math.round(unit_price * 60) / 100, labor_cost: null, taxable: true, formula, formula_target: "quantity", active: true,
});
const pkg = (id: string, name: string, roof: string | null, extra: Row = {}): Row => ({
  id, company_id: CO, name, tier: null, style: "shingle", picture: null, picture_width: null, picture_height: null, highlights: [], warranty: "", section_ids: [], roof_service_id: roof, price_mode: "manual", markup_pct: 70, ...extra,
});
const line = (id: string, name: string, quantity: number, unit_price: number, extra: Row = {}): Row => ({
  id, company_id: CO, quote_id: QUOTE, option_id: null, service_id: null, name, quantity, unit_price, taxable: true, optional: false, selected: true, sort: 0, ...extra,
});

function roofer({ role = "estimator", trade = "roofing_exteriors", measured = true, status = "draft", lines = [] as Row[], options = [] as Row[] } = {}) {
  state.rpcs = [];
  state.writes = [];
  state.tables = {
    memberships: [{ company_id: CO, user_id: "viewer", active: true, role, role_id: null }],
    companies: [{ id: CO, name: "Peak Roofing", trade_preset: trade }],
    quotes: [{ id: QUOTE, company_id: CO, number: 1042, status, roof_package_id: null, option_id: options[0]?.id ?? null, promo_code_id: null, tax_rate: 0, discount_amount: 0, priced_on_site_at: null }],
    quote_line_items: lines,
    quote_options: options.map((o) => ({ company_id: CO, quote_id: QUOTE, package_id: null, tier: null, ...o })),
    services: [
      service(ROOF, "Architectural shingle roof", "square", 560, "squares"),
      service(SLATE, "Designer shingle roof", "square", 700, "squares"),
      service(PANELS, "Standing-seam metal roof", "square", 1285, "squares"),
      service(TEAR, "Tear-off and disposal", "square", 85, "roof_squares"),
      service(BOOT, "Pipe boot", "ea", 45, null),
    ],
    service_materials: [],
    roof_packages: [
      pkg(SHINGLE, "Architectural shingle", ROOF, { picture: PICTURE, picture_width: 1600, picture_height: 1000, highlights: ["Shingles in the color you pick"], warranty: "30 years on the shingles.", section_ids: [SECTION] }),
      pkg(DESIGNER, "Designer shingle", SLATE, { style: "designer" }),
      pkg(METAL, "Standing-seam metal", PANELS, { style: "metal" }),
    ],
    roof_package_items: [
      { company_id: CO, package_id: SHINGLE, service_id: TEAR, kind: "included", quantity: null, sort: 0 },
      { company_id: CO, package_id: SHINGLE, service_id: BOOT, kind: "included", quantity: 3, sort: 1 },
      { company_id: CO, package_id: DESIGNER, service_id: TEAR, kind: "included", quantity: null, sort: 0 },
      { company_id: CO, package_id: METAL, service_id: TEAR, kind: "included", quantity: null, sort: 0 },
      { company_id: CO, package_id: METAL, service_id: BOOT, kind: "quick", quantity: null, sort: 0 },
    ],
    measurements: measured ? [{ ...MEASUREMENT }] : [],
  };
}

afterEach(() => {
  state.tables = {};
  state.rpcs = [];
  state.meanwhile = null;
});

const roofLines = (roof: string, name: string, price: number, after = 0) => [
  { service_id: roof, name, quantity: ROOFING.squares, unit: "square", unit_price: price, unit_cost: Math.round(price * 60) / 100, taxable: true, formula: "squares", sort: after },
  { service_id: TEAR, name: "Tear-off and disposal", quantity: ROOFING.roof_squares, unit: "square", unit_price: 85, unit_cost: 51, taxable: true, formula: "roof_squares", sort: after + 1 },
];

describe("offering packages as options", () => {
  it("makes each package an option with its own lines, cheapest first, as Good, Better and Best", async () => {
    roofer();
    const res = await offer({ package_ids: [METAL, SHINGLE, DESIGNER] });
    expect(res.status).toBe(200);
    const [call] = applied();
    expect(call!.args).toMatchObject({ p_quote: QUOTE, p_mode: "add", p_shared: [] });
    expect(call!.args).not.toHaveProperty("p_current");
    // In order, so the cheapest is the one shown first.
    expect(call!.args.p_options.map((o: Row) => [o.name, o.tier, o.sort])).toEqual([
      ["Architectural shingle", "Good", 0],
      ["Designer shingle", "Better", 1],
      ["Standing-seam metal", "Best", 2],
    ]);
    // A copy of the package as it's offered, and its lines from the roof.
    expect(call!.args.p_options[0]).toEqual({
      package_id: SHINGLE, name: "Architectural shingle", tier: "Good", picture: PICTURE, picture_width: 1600, picture_height: 1000, style: "shingle",
      highlights: ["Shingles in the color you pick"], warranty: "30 years on the shingles.", section_ids: [SECTION], sort: 0,
      lines: [...roofLines(ROOF, "Architectural shingle roof", 560), { service_id: BOOT, name: "Pipe boot", quantity: 3, unit: "ea", unit_price: 45, unit_cost: 27, taxable: true, formula: null, sort: 2 }],
    });
    expect(call!.args.p_options[2].lines).toEqual(roofLines(PANELS, "Standing-seam metal roof", 1285));

    const body = await res.json();
    expect(body.skipped).toEqual([]);
    expect(body.options.map((o: Row) => [o.name, o.tier, o.sort])).toEqual([["Architectural shingle", "Good", 0], ["Designer shingle", "Better", 1], ["Standing-seam metal", "Best", 2]]);
    expect(Object.keys(body.options[0]).sort()).toEqual(["highlights", "id", "name", "package_id", "picture", "picture_height", "picture_width", "section_ids", "sort", "style", "tier", "warranty"]);
    expect(rows("measurements")[0]).toMatchObject({ show_on_quote: true });
  });

  it("keeps a package's own tier, and then names no others", async () => {
    roofer();
    rows("roof_packages").find((p) => p.id === METAL)!.tier = "Premium";
    await offer({ package_ids: [SHINGLE, METAL] });
    expect(applied()[0]!.args.p_options.map((o: Row) => [o.name, o.tier])).toEqual([["Architectural shingle", null], ["Standing-seam metal", "Premium"]]);
  });

  it("makes the estimate as it is option 1 before adding to it, keeping the lines asked for on every option", async () => {
    roofer({ lines: [line(L1, "Architectural shingle roof", 30, 560, { service_id: ROOF, sort: 0 }), line(L2, "Dumpster", 1, 500, { sort: 4 })] });
    quote().roof_package_id = SHINGLE;
    const res = await offer({ package_ids: [SHINGLE, METAL], shared_line_ids: [L2, "00000000-0000-4000-8000-000000000999"] });
    expect(res.status).toBe(200);
    // The estimate's own package is already option 1, so only metal is added, after the estimate's lines.
    const [call] = applied();
    expect(call!.args).toMatchObject({ p_mode: "add", p_shared: [L2], p_current: { tier: "Good", sort: 0 } });
    expect(call!.args.p_options.map((o: Row) => [o.name, o.tier, o.sort])).toEqual([["Standing-seam metal", "Better", 1]]);
    expect(call!.args.p_options[0].lines).toEqual(roofLines(PANELS, "Standing-seam metal roof", 1285, 5));
    const body = await res.json();
    expect(body.options.map((o: Row) => [o.name, o.tier])).toEqual([["Architectural shingle", "Good"], ["Standing-seam metal", "Better"]]);
    expect(rows("quote_line_items").filter((l) => l.option_id === null).map((l) => l.id)).toEqual([L2]);

    // Asking only for the package it already has adds nothing.
    roofer({ lines: [line("l1", "Architectural shingle roof", 30, 560, { service_id: ROOF })] });
    quote().roof_package_id = SHINGLE;
    const again = await offer({ package_ids: [SHINGLE] });
    expect(again.status).toBe(400);
    expect((await again.json()).error).toBe("That package is already on this estimate. Pick another one to offer.");
    expect(applied()).toEqual([]);
  });

  it("prices the estimate as it is with the price set on site, which stays with it as option 1", async () => {
    // $20,000 priced on site at $18,000. The database turns that discount into a line on option 1
    // (private.quote_option_added), so it comes off option 1 alone: the Designer shingle package
    // (about $19,100) is dearer than the estimate, not $2,000 cheaper.
    roofer({ lines: [line(L1, "Slate roof", 1, 20000), line(L2, "Price adjustment", 1, 0, { sort: 1 })] });
    Object.assign(quote(), { priced_on_site_at: "2026-10-24T15:00:00Z", discount_amount: 2000 });
    expect((await offer({ package_ids: [DESIGNER], shared_line_ids: [L2] })).status).toBe(200);
    const [call] = applied();
    expect(call!.args.p_current).toEqual({ tier: "Good", sort: 0 });
    expect(call!.args.p_options.map((o: Row) => [o.name, o.tier, o.sort])).toEqual([["Designer shingle", "Better", 1]]);
    // The price's adjustment line goes onto option 1 whatever's asked, as the database moves it.
    expect(call!.args.p_shared).toEqual([]);

    // A promo code's discount is the code's own and comes off every option.
    roofer({ lines: [line("l1", "Slate roof", 1, 20000)] });
    Object.assign(quote(), { priced_on_site_at: "2026-10-24T15:00:00Z", discount_amount: 2000, promo_code_id: "00000000-0000-4000-8000-0000000000c9" });
    await offer({ package_ids: [DESIGNER] });
    expect(applied()[0]!.args.p_current).toEqual({ tier: "Better", sort: 1 });
  });

  it("keeps something on the estimate as it is when it becomes option 1", async () => {
    roofer({ lines: [line(L1, "Dumpster", 1, 500), line(L2, "Permit", 1, 150, { sort: 1 })] });
    const res = await offer({ package_ids: [SHINGLE, METAL], shared_line_ids: [L1, L2] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Leave at least one line on the estimate as it is, or start over from the packages.");
    expect(applied()).toEqual([]);
    expect(state.writes).toEqual([]);

    // Starting over from the packages is fine: nothing is kept.
    roofer({ lines: [line(L1, "Dumpster", 1, 500)] });
    expect((await offer({ package_ids: [SHINGLE, METAL], mode: "replace", shared_line_ids: [L1] })).status).toBe(200);
  });

  it("orders the estimate as it is among the new options by price", async () => {
    // A hand-priced estimate dearer than the shingle package: the shingles are Good, the estimate Better.
    roofer({ lines: [line("l1", "Slate roof", 1, 40000)] });
    await offer({ package_ids: [SHINGLE] });
    const [call] = applied();
    expect(call!.args.p_current).toEqual({ tier: "Better", sort: 1 });
    expect(call!.args.p_options.map((o: Row) => [o.name, o.tier, o.sort])).toEqual([["Architectural shingle", "Good", 0]]);
  });

  it("adds an option after the ones offered, named Best only when the others are Good and Better by price", async () => {
    const options = [{ id: GOOD, name: "Architectural shingle", tier: "Good", sort: 0, package_id: SHINGLE }, { id: BETTER, name: "Designer shingle", tier: "Better", sort: 1, package_id: DESIGNER }];
    const lines = [line("g1", "Architectural shingle roof", 30, 560, { option_id: GOOD }), line("b1", "Designer shingle roof", 30, 700, { option_id: BETTER, selected: false })];
    roofer({ options, lines });
    await offer({ package_ids: [METAL] });
    expect(applied()[0]!.args).toMatchObject({ p_mode: "add", p_shared: [] });
    expect(applied()[0]!.args.p_options.map((o: Row) => [o.name, o.tier, o.sort])).toEqual([["Standing-seam metal", "Best", 2]]);

    // The business's own words stay theirs: the new one gets none.
    roofer({ options: options.map((o, i) => ({ ...o, tier: ["Basic", "Plus"][i] })), lines });
    await offer({ package_ids: [METAL] });
    expect(applied()[0]!.args.p_options[0].tier).toBeNull();

    // A package that's already an option isn't offered twice, and a quote offers 3 at most.
    roofer({ options, lines });
    expect((await offer({ package_ids: [SHINGLE] })).status).toBe(400);
    roofer({ options: [...options, { id: "00000000-0000-4000-8000-0000000000b3", name: "Metal", sort: 2 }], lines });
    const fourth = await offer({ package_ids: [METAL] });
    expect(fourth.status).toBe(400);
    expect((await fourth.json()).error).toBe("A quote offers up to 3 options.");
    expect(applied()).toEqual([]);
  });

  it("prices one package on an empty estimate the classic way, on every option there is", async () => {
    roofer();
    const res = await offer({ package_ids: [SHINGLE] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ options: [], skipped: [] });
    expect(applied()).toEqual([]);
    expect(quote().roof_package_id).toBe(SHINGLE);
    expect(rows("quote_line_items").map((l) => [l.name, l.option_id ?? null, l.sort])).toEqual([
      ["Architectural shingle roof", null, 0],
      ["Tear-off and disposal", null, 1],
      ["Pipe boot", null, 2],
    ]);
  });

  it("starts over from the packages when asked", async () => {
    const options = [{ id: GOOD, name: "Architectural shingle", sort: 0, package_id: SHINGLE }, { id: BETTER, name: "Designer shingle", sort: 1, package_id: DESIGNER }];
    roofer({ options, lines: [line("g1", "Architectural shingle roof", 30, 560, { option_id: GOOD })] });
    Object.assign(quote(), { priced_on_site_at: "2026-10-24T15:00:00Z", discount_amount: 400 });
    await offer({ package_ids: [METAL, SHINGLE], mode: "replace" });
    const [call] = applied();
    expect(call!.args.p_mode).toBe("replace");
    // Every option and line goes, so the earlier options don't count against 3 or the order.
    expect(call!.args.p_options.map((o: Row) => [o.name, o.tier, o.sort])).toEqual([["Architectural shingle", "Good", 0], ["Standing-seam metal", "Better", 1]]);

    // One package to start over with: a single estimate again.
    roofer({ options, lines: [line("g1", "Architectural shingle roof", 30, 560, { option_id: GOOD })] });
    Object.assign(quote(), { priced_on_site_at: "2026-10-24T15:00:00Z", exact_sent_at: "2026-10-24T16:00:00Z", discount_amount: 400 });
    state.rpcs = [];
    const res = await offer({ package_ids: [METAL], mode: "replace" });
    expect(res.status).toBe(200);
    expect(applied()).toEqual([]);
    // In one locked step.
    expect(state.rpcs.filter((r) => r.name === "put_quote_package").map((r) => r.args.p_replace)).toEqual([true]);
    expect(rows("quote_options")).toEqual([]);
    expect(rows("quote_line_items").map((l) => [l.name, l.option_id ?? null])).toEqual([["Standing-seam metal roof", null], ["Tear-off and disposal", null]]);
    expect(quote()).toMatchObject({ roof_package_id: METAL, priced_on_site_at: null, exact_sent_at: null, discount_amount: 0 });
  });

  it("doesn't put a package's lines on an estimate that got lines meanwhile", async () => {
    roofer();
    state.meanwhile = () => rows("quote_line_items").push(line("x1", "Chimney flashing", 1, 650));
    const res = await offer({ package_ids: [SHINGLE] });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("Lines were added to this estimate meanwhile. Look it over, then add the package again.");
    expect(rows("quote_line_items").map((l) => l.name)).toEqual(["Chimney flashing"]);
  });

  it("offers a roof's options before it's measured, and fills them in once it is", async () => {
    roofer({ measured: false });
    const res = await offer({ package_ids: [METAL, SHINGLE] });
    expect(res.status).toBe(200);
    // Nothing to price them by yet: they keep the order they were picked in, without tier words.
    expect(applied()[0]!.args.p_options.map((o: Row) => [o.name, o.tier, o.sort, o.lines])).toEqual([["Standing-seam metal", null, 0, []], ["Architectural shingle", null, 1, []]]);
    const notYet = await send(`/quotes/${QUOTE}/options/fill`);
    expect(notYet.status).toBe(409);
    expect((await notYet.json()).error).toBe("Measure the roof first.");

    state.tables.measurements = [{ ...MEASUREMENT }];
    state.rpcs = [];
    const [metal, shingle] = rows("quote_options").sort((a, b) => a.sort - b.sort);
    const filled = await send(`/quotes/${QUOTE}/options/fill`);
    expect(filled.status).toBe(200);
    const [call] = applied();
    expect(call!.args.p_mode).toBe("fill");
    expect(call!.args.p_options).toEqual([
      { id: metal!.id, lines: roofLines(PANELS, "Standing-seam metal roof", 1285) },
      { id: shingle!.id, lines: [...roofLines(ROOF, "Architectural shingle roof", 560), { service_id: BOOT, name: "Pipe boot", quantity: 3, unit: "ea", unit_price: 45, unit_cost: 27, taxable: true, formula: null, sort: 2 }] },
    ]);
    // Priced now: cheapest first, as Good and Better, and the cheapest is the one shown first.
    expect((await filled.json()).options.map((o: Row) => [o.name, o.tier, o.sort])).toEqual([["Architectural shingle", "Good", 0], ["Standing-seam metal", "Better", 1]]);
    expect(rows("quote_options").map((o) => [o.name, o.tier, o.sort])).toEqual([["Standing-seam metal", "Better", 1], ["Architectural shingle", "Good", 0]]);
    expect(quote().option_id).toBe(shingle!.id);
    expect(rows("measurements")[0]).toMatchObject({ show_on_quote: true });

    // Filled once: again, there's nothing to fill. An option whose package went is left for the office.
    state.rpcs = [];
    rows("quote_options").push({ id: "00000000-0000-4000-8000-0000000000b3", company_id: CO, quote_id: QUOTE, package_id: null, name: "Cedar shakes", tier: null, sort: 2 });
    const again = await (await send(`/quotes/${QUOTE}/options/fill`)).json();
    expect(applied()[0]!.args.p_options).toEqual([]);
    expect(again.skipped).toEqual([{ package: "Cedar shakes", name: "Cedar shakes", reason: "Its package was deleted, so add its lines by hand." }]);
  });

  it("leaves the option shown alone once someone chose it, when filling them in", async () => {
    for (const chosen of [{ range_accepted_at: "2026-10-24T15:00:00Z" }, { priced_on_site_at: "2026-10-24T15:00:00Z" }]) {
      roofer({ measured: false });
      await offer({ package_ids: [METAL, SHINGLE] });
      const metal = rows("quote_options").find((o) => o.name === "Standing-seam metal")!;
      Object.assign(quote(), chosen);
      state.tables.measurements = [{ ...MEASUREMENT }];
      expect((await send(`/quotes/${QUOTE}/options/fill`)).status).toBe(200);
      expect(rows("quote_options").map((o) => [o.name, o.sort])).toEqual([["Standing-seam metal", 1], ["Architectural shingle", 0]]);
      expect(quote().option_id).toBe(metal.id);
    }
  });

  it("fills in the package an estimate without options remembers, once it's measured", async () => {
    roofer({ measured: false });
    await offer({ package_ids: [SHINGLE] });
    expect(rows("quote_line_items")).toEqual([]);
    const notYet = await send(`/quotes/${QUOTE}/options/fill`);
    expect(notYet.status).toBe(409);
    expect((await notYet.json()).error).toBe("Measure the roof first.");

    state.tables.measurements = [{ ...MEASUREMENT }];
    const res = await send(`/quotes/${QUOTE}/options/fill`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ options: [], skipped: [] });
    expect(applied()).toEqual([]);
    expect(rows("quote_line_items").map((l) => [l.name, l.option_id ?? null])).toEqual([["Architectural shingle roof", null], ["Tear-off and disposal", null], ["Pipe boot", null]]);
    expect(rows("measurements")[0]).toMatchObject({ show_on_quote: true });

    // Lines already on it stay as they are.
    state.writes = [];
    expect(await (await send(`/quotes/${QUOTE}/options/fill`)).json()).toEqual({ options: [], skipped: [] });
    expect(state.writes).toEqual([]);
  });

  it("needs the job measured first outside roofing, and lets a package go without a main service", async () => {
    roofer({ trade: "paving", measured: false });
    const res = await offer({ package_ids: [SHINGLE, METAL] });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("Measure the job first.");
    expect(applied()).toEqual([]);

    roofer({ trade: "paving", measured: false });
    state.tables.roof_packages = [pkg(SHINGLE, "Crack fill", null), pkg(METAL, "Crack fill and sealcoat", null)];
    state.tables.roof_package_items = [
      { company_id: CO, package_id: SHINGLE, service_id: BOOT, kind: "included", quantity: 2, sort: 0 },
      { company_id: CO, package_id: METAL, service_id: BOOT, kind: "included", quantity: 5, sort: 0 },
    ];
    expect((await offer({ package_ids: [SHINGLE, METAL] })).status).toBe(200);
    expect(applied()[0]!.args.p_options.map((o: Row) => [o.name, o.tier, o.lines.map((l: Row) => l.quantity)])).toEqual([["Crack fill", "Good", [2]], ["Crack fill and sealcoat", "Better", [5]]]);
  });

  it("says what each package left off this roof", async () => {
    roofer();
    rows("services").push(service("00000000-0000-4000-8000-0000000000e6", "Steep roof charge", "square", 65, "steep_squares"));
    rows("roof_package_items").push({ company_id: CO, package_id: METAL, service_id: "00000000-0000-4000-8000-0000000000e6", kind: "included", quantity: null, sort: 1 });
    const body = await (await offer({ package_ids: [SHINGLE, METAL] })).json();
    expect(body.skipped).toEqual([{ package: "Standing-seam metal", name: "Steep roof charge", reason: "None on this roof" }]);
  });

  it("checks everything before writing anything", async () => {
    const tries: Array<[string, () => void, Row, number, string]> = [
      ["a roof package without its roof", () => (rows("roof_packages").find((p) => p.id === METAL)!.roof_service_id = null), { package_ids: [SHINGLE, METAL] }, 409, "Pick the roof for the Standing-seam metal package first, in Roofing → Packages."],
      ["another business's package", () => (rows("roof_packages").find((p) => p.id === METAL)!.company_id = OTHER), { package_ids: [SHINGLE, METAL] }, 404, "That package wasn't found. It may have been deleted."],
      ["a signed estimate", () => (quote().status = "approved"), { package_ids: [SHINGLE, METAL] }, 409, "This estimate was already signed, so it can't change."],
      ["another business's estimate", () => (quote().company_id = OTHER), { package_ids: [SHINGLE, METAL] }, 404, "That estimate wasn't found."],
      ["no packages", () => {}, { package_ids: [] }, 400, "Pick at least one package to offer."],
      ["a pitch that doesn't read", () => Object.assign(rows("measurements")[0]!, { roof_pitch: "steep", sections: [{ kind: "Area", value: 2000 }] }), { package_ids: [SHINGLE, METAL] }, 409, "The roof's pitch doesn't read. Set it again on the map, so its squares can be worked out."],
    ];
    for (const [why, setUp, body, status, error] of tries) {
      roofer();
      setUp();
      const res = await offer(body);
      expect(res.status, why).toBe(status);
      expect((await res.json()).error, why).toBe(error);
      expect(applied(), why).toEqual([]);
      expect(state.writes, why).toEqual([]);
    }
    roofer();
    expect((await offer({ package_ids: ["not-a-package"] })).status).toBe(400);
    expect((await offer({ package_ids: [SHINGLE, METAL], mode: "merge" })).status).toBe(400);
  });

  it("are for people who sell", async () => {
    for (const role of ["crew_lead", "field_crew"]) {
      roofer({ role });
      expect((await offer({ package_ids: [SHINGLE, METAL] })).status, role).toBe(403);
      expect((await send(`/quotes/${QUOTE}/options/fill`)).status, role).toBe(403);
      expect((await send(`/quotes/${QUOTE}/options/${GOOD}`, undefined, "DELETE")).status, role).toBe(403);
      expect((await send(`/quotes/${QUOTE}/duplicate`)).status, role).toBe(403);
    }
    for (const role of ["owner", "office"]) {
      roofer({ role });
      expect((await offer({ package_ids: [SHINGLE, METAL] })).status, role).toBe(200);
    }
  });
});

describe("the deposit, when a cheaper option is offered", () => {
  /** An option's price before its add-ons, as the deposit is held to. */
  const base = (name: string) => optionBaseTotal(rows("quote_line_items") as never, rows("quote_options").find((o) => o.name === name)!.id, { taxRate: 0, discountAmount: 0 });

  it("comes down to the cheapest option's price, and the answer says so", async () => {
    // A $20,000 deposit on a hand-priced $40,000 roof, and then the shingle package offered beside it.
    roofer({ lines: [line(L1, "Slate roof", 1, 40000)] });
    Object.assign(quote(), { total: 40000, deposit_amount: 20000 });
    const res = await offer({ package_ids: [SHINGLE] });
    expect(res.status).toBe(200);
    const shingle = base("Architectural shingle")!;
    expect(shingle).toBeLessThan(20000);
    expect((await res.json()).deposit_amount).toBe(shingle);
    expect(quote().deposit_amount).toBe(shingle);
  });

  it("stays as it is within every option's price, and while none of them has a price yet", async () => {
    roofer({ lines: [line(L1, "Slate roof", 1, 40000)] });
    Object.assign(quote(), { total: 40000, deposit_amount: 1000 });
    const res = await offer({ package_ids: [SHINGLE] });
    expect(await res.json()).not.toHaveProperty("deposit_amount");
    expect(quote().deposit_amount).toBe(1000);
    expect(state.writes).not.toContain("update quotes");

    // Offered before the roof is measured, nothing has a price to hold it to: it isn't wiped out.
    roofer({ measured: false });
    quote().deposit_amount = 50000;
    expect(await (await offer({ package_ids: [METAL, SHINGLE] })).json()).not.toHaveProperty("deposit_amount");
    expect(quote().deposit_amount).toBe(50000);

    // Once they're filled in, it comes down to the cheaper one.
    state.tables.measurements = [{ ...MEASUREMENT }];
    const filled = await (await send(`/quotes/${QUOTE}/options/fill`)).json();
    expect(filled.deposit_amount).toBe(base("Architectural shingle"));
    expect(quote().deposit_amount).toBe(base("Architectural shingle"));
  });

  it("comes down to the total when one cheaper package replaces the estimate", async () => {
    roofer({ lines: [line(L1, "Slate roof", 1, 40000)] });
    Object.assign(quote(), { total: 40000, deposit_amount: 50000 });
    // The database works the new total out as the package's lines go on.
    state.meanwhile = () => (quote().total = 13000);
    const res = await offer({ package_ids: [SHINGLE], mode: "replace" });
    expect((await res.json()).deposit_amount).toBe(13000);
    expect(quote().deposit_amount).toBe(13000);
  });
});

describe("taking an option off", () => {
  const options = [{ id: GOOD, name: "Architectural shingle", sort: 0 }, { id: BETTER, name: "Designer shingle", sort: 1 }, { id: "00000000-0000-4000-8000-0000000000b3", name: "Standing-seam metal", sort: 2 }];
  const lines = [line("s1", "Dumpster", 1, 500), line("g1", "Architectural shingle roof", 30, 560, { option_id: GOOD }), line("b1", "Designer shingle roof", 30, 700, { option_id: BETTER })];

  it("takes it off with its lines, and with one left goes back to a single estimate", async () => {
    roofer({ options, lines });
    const res = await send(`/quotes/${QUOTE}/options/${options[2]!.id}`, undefined, "DELETE");
    expect(res.status).toBe(200);
    expect(state.rpcs).toEqual([{ name: "remove_quote_option", args: { p_quote: QUOTE, p_option: options[2]!.id } }]);
    expect((await res.json()).options.map((o: Row) => o.name)).toEqual(["Architectural shingle", "Designer shingle"]);

    const single = await (await send(`/quotes/${QUOTE}/options/${BETTER}`, undefined, "DELETE")).json();
    expect(single).toEqual({ options: [] });
    expect(rows("quote_line_items").map((l) => [l.id, l.option_id])).toEqual([["s1", null], ["g1", null]]);
  });

  it("only while the estimate can change, in the business's own estimates", async () => {
    roofer({ options, lines, status: "converted" });
    const signed = await send(`/quotes/${QUOTE}/options/${GOOD}`, undefined, "DELETE");
    expect(signed.status).toBe(409);
    expect((await signed.json()).error).toBe("This estimate was already signed, so it can't change.");
    roofer({ options, lines });
    quote().company_id = OTHER;
    expect((await send(`/quotes/${QUOTE}/options/${GOOD}`, undefined, "DELETE")).status).toBe(404);
    expect((await send(`/quotes/${QUOTE}/options/not-an-option`, undefined, "DELETE")).status).toBe(404);
    expect(state.rpcs).toEqual([]);
  });
});

describe("copying a quote", () => {
  it("copies it with its options as a new draft, and says the copy's id", async () => {
    roofer({ status: "approved" });
    const res = await send(`/quotes/${QUOTE}/duplicate`);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: COPY });
    expect(state.rpcs).toEqual([{ name: "duplicate_quote", args: { p_quote: QUOTE } }]);

    roofer();
    quote().company_id = OTHER;
    expect((await send(`/quotes/${QUOTE}/duplicate`)).status).toBe(404);
    expect(state.rpcs).toEqual([]);
  });
});
