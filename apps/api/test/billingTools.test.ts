/**
 * The assistant's time and materials tools (assistant-tools/invoices.ts): what a job's draft
 * invoice can still bill (logged_work), and the lines bill_logged_work puts on it, priced from the
 * price list, never twice. And batch invoicing's "Add logged hours and materials" (services/sales.ts
 * invoiceJobs), which puts on what Add logged work starts out ticked.
 */
import { createClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { invoiceTools } from "../src/assistant-tools/invoices";
import type { ToolContext } from "../src/assistant-tools/tool";
import type { Env } from "../src/env";
import { invoiceJobs } from "../src/services/sales";

const INVOICE = "11111111-1111-4111-8111-111111111111";
const JOB = "22222222-2222-4222-8222-222222222222";
const A = "33333333-3333-4333-8333-333333333331";
const B = "33333333-3333-4333-8333-333333333332";
const BILLED = "33333333-3333-4333-8333-333333333333";

const at = (day: number, hour: number) => new Date(Date.UTC(2026, 9, day, hour)).toISOString();
const TABLES: Record<string, unknown[]> = {
  time_entries: [
    { id: A, user_id: "u1", started_at: at(5, 13), ended_at: at(5, 16), category: "visit", approved_at: at(5, 17) },
    { id: B, user_id: "u2", started_at: at(6, 13), ended_at: at(6, 15), category: "visit", approved_at: null },
    { id: "lunch", user_id: "u1", started_at: at(5, 16), ended_at: at(5, 17), category: "break", approved_at: null },
    { id: BILLED, user_id: "u1", started_at: at(4, 13), ended_at: at(4, 14), category: "visit", approved_at: null },
  ],
  job_materials: [
    { id: "m1", name: "Copper pipe", quantity: 20, unit: "ft", service_id: "pipe", logged_at: at(5, 9) },
    { id: "m2", name: "Copper pipe", quantity: 12.5, unit: "ft", service_id: "pipe", logged_at: at(6, 9) },
    { id: "m3", name: "Gasket kit", quantity: 1, unit: "ea", service_id: null, logged_at: at(6, 10) },
  ],
  services: [
    { id: "labor", name: "Labor", unit: "hr", unit_price: 85, taxable: false, active: true },
    { id: "pipe", name: "Copper pipe", unit: "ft", unit_price: 4, taxable: true, active: true },
  ],
  // For batch invoicing: the job, the company's time zone and the new invoice's lines.
  jobs: [{ id: JOB, number: 7, title: "Repipe", kind: "one_off", billing_mode: "on_completion", pricing: null }],
  companies: [{ timezone: "America/New_York" }],
  invoice_line_items: [{ sort: 4 }],
};

/** The Data API: the draft invoice, the job's logged work and what its invoices bill, keeping what's sent. */
function database() {
  const sent: Array<{ method: string; path: string; body: unknown }> = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = init?.method ?? "GET";
    const table = url.pathname.replace("/rest/v1/", "");
    sent.push({ method, path: `${table}?${decodeURIComponent(url.search)}`, body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
    const single = String(new Headers(init?.headers).get("accept")).includes("vnd.pgrst.object");
    const select = url.searchParams.get("select") ?? "";
    let rows: unknown[] = TABLES[table] ?? [];
    if (table === "invoices") {
      rows = select.startsWith("lines:")
        ? [{ lines: [{ time_entry_ids: [BILLED], material_ids: null }, { time_entry_ids: null, material_ids: null }] }]
        : [{ id: INVOICE, job_id: JOB, status: "draft", kind: "standard", number: 1042, subtotal: 0, total: 0, balance_due: 0, lines: [{ sort: 4 }] }];
    }
    if (table === "rpc/create_invoice_for_job") return Response.json(INVOICE);
    if (method === "POST") return Response.json([{ id: "new" }], { status: 201 });
    return Response.json(single ? rows[0] ?? null : rows);
  });
  const ctx = { db: createClient("http://127.0.0.1:8080", "sb_publishable_test"), companyId: "company-1", timezone: "America/New_York" } as unknown as ToolContext;
  return { sent, ctx };
}

afterEach(() => vi.unstubAllGlobals());

describe("the assistant's time and materials", () => {
  it("offers the job's finished hours, approved or not, but not breaks or hours billed already", async () => {
    const { ctx } = database();
    const work = (await invoiceTools.logged_work.run(ctx, { job_id: JOB })) as { hours: Array<{ time_entry_id: string; hours: number; approved: boolean }>; materials: unknown[]; rates: unknown[] };
    expect(work.hours).toEqual([
      { time_entry_id: A, user_id: "u1", started_at: at(5, 13), hours: 3, approved: true },
      { time_entry_id: B, user_id: "u2", started_at: at(6, 13), hours: 2, approved: false },
    ]);
    expect(work.materials).toEqual([
      { key: "pipe|ft", name: "Copper pipe", unit: "ft", quantity: 32.5, service_id: "pipe", unit_price: 4, taxable: true, entries: 2 },
      { key: "name:gasket kit|ea", name: "Gasket kit", unit: "ea", quantity: 1, service_id: null, unit_price: null, taxable: true, entries: 1 },
    ]);
    expect(work.rates).toEqual([{ service_id: "labor", name: "Labor", unit: "hr", unit_price: 85 }]);
  });

  it("bills the hours at Labor's price and the materials at theirs, after the draft's lines", async () => {
    const { ctx, sent } = database();
    const result = await invoiceTools.bill_logged_work.run(ctx, invoiceTools.bill_logged_work.input.parse({ invoice_id: INVOICE, material_prices: { "name:gasket kit|ea": 12 } }));
    expect(result).toMatchObject({ added: 3, invoice: { id: INVOICE } });
    const insert = sent.find((s) => s.method === "POST" && s.path.startsWith("invoice_line_items"));
    expect(insert?.body).toEqual([
      { service_id: "labor", name: "Labor", description: "Logged hours: Oct 5, Oct 6", quantity: 5, unit: "hr", unit_price: 85, taxable: false, time_entry_ids: [A, B], company_id: "company-1", invoice_id: INVOICE, sort: 5 },
      { service_id: "pipe", name: "Copper pipe", description: null, quantity: 32.5, unit: "ft", unit_price: 4, taxable: true, material_ids: ["m1", "m2"], company_id: "company-1", invoice_id: INVOICE, sort: 6 },
      { service_id: null, name: "Gasket kit", description: null, quantity: 1, unit: "ea", unit_price: 12, taxable: true, material_ids: ["m3"], company_id: "company-1", invoice_id: INVOICE, sort: 7 },
    ]);
  });

  it("leaves a material with no price list item until it's priced, and says so", async () => {
    const { ctx } = database();
    const result = await invoiceTools.bill_logged_work.run(ctx, invoiceTools.bill_logged_work.input.parse({ invoice_id: INVOICE, time_entry_ids: [] }));
    expect(result).toMatchObject({ added: 1, still_to_price: [{ key: "name:gasket kit|ea", name: "Gasket kit" }] });
    await expect(invoiceTools.bill_logged_work.run(ctx, invoiceTools.bill_logged_work.input.parse({ invoice_id: INVOICE, material_keys: ["name:gasket kit|ea"] }))).rejects.toThrow(/give its price in material_prices/);
    await expect(invoiceTools.bill_logged_work.run(ctx, invoiceTools.bill_logged_work.input.parse({ invoice_id: INVOICE, time_entry_ids: [BILLED] }))).rejects.toThrow(/aren't waiting to be billed/);
  });
});

describe("batch invoicing's logged work", () => {
  const scope = (ctx: ToolContext) => ({ db: ctx.db, env: {} as Env, companyId: "company-1", baseUrl: "https://ops.example.com" });

  it("puts each job's hours at the hourly item and its priced materials on its new invoice", async () => {
    const { ctx, sent } = database();
    expect(await invoiceJobs(scope(ctx), [JOB], false, {})).toEqual({ results: [{ job_id: JOB, number: 7, ok: true, invoice_id: INVOICE, sent: false, error: undefined }] });
    const insert = sent.find((s) => s.method === "POST" && s.path.startsWith("invoice_line_items"));
    // Not the gasket kit, which has no price yet: that's added from the invoice.
    expect(insert?.body).toEqual([
      { service_id: "labor", name: "Labor", description: "Logged hours: Oct 5, Oct 6", quantity: 5, unit: "hr", unit_price: 85, taxable: false, time_entry_ids: [A, B], company_id: "company-1", invoice_id: INVOICE, sort: 5 },
      { service_id: "pipe", name: "Copper pipe", description: null, quantity: 32.5, unit: "ft", unit_price: 4, taxable: true, material_ids: ["m1", "m2"], company_id: "company-1", invoice_id: INVOICE, sort: 6 },
    ]);
  });

  it("adds none unless asked", async () => {
    const { ctx, sent } = database();
    await invoiceJobs(scope(ctx), [JOB], false);
    expect(sent.some((s) => s.path.startsWith("time_entries") || s.path.startsWith("invoice_line_items"))).toBe(false);
  });
});
