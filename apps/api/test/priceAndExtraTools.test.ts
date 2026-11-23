/**
 * The assistant's tools for extra work on a visit and for changing prices across repeating jobs
 * (assistant-tools/jobs.ts). Extra work is written to visit_extras, where the database's rules say
 * which visits take it and when it's billed (20261113000900_visit_extras.sql). A price change goes
 * the Jobs page's way: the database's preview, then apply_price_change with exactly the lines
 * previewed, a group of jobs a call under one id (20261113000950_price_changes.sql).
 */
import { createClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jobTools } from "../src/assistant-tools/jobs";
import type { ToolContext } from "../src/assistant-tools/tool";

const VISIT = "11111111-1111-4111-8111-111111111111";
const JOB = "22222222-2222-4222-8222-222222222222";
const SERVICE = "33333333-3333-4333-8333-333333333333";
const EXTRA = "44444444-4444-4444-8444-444444444444";

/** The Data API: `rpc` answers the database's functions by name, `tables` the reads; what's sent is kept. */
function database(rpc: Record<string, (body: any) => Response> = {}, tables: Record<string, unknown[]> = {}) {
  const sent: Array<{ method: string; path: string; body: any }> = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = init?.method ?? "GET";
    const table = url.pathname.replace("/rest/v1/", "");
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    sent.push({ method, path: table, body });
    const single = String(new Headers(init?.headers).get("accept")).includes("vnd.pgrst.object");
    if (table.startsWith("rpc/")) return rpc[table.slice(4)]?.(body) ?? Response.json(null);
    const rows = method === "GET" ? tables[table] ?? [] : [{ id: EXTRA }];
    return Response.json(single ? rows[0] ?? null : rows);
  });
  const ctx = { db: createClient("http://127.0.0.1:8080", "sb_publishable_test"), companyId: "company-1", timezone: "America/Chicago" } as unknown as ToolContext;
  return { sent, ctx };
}
const refusal = (message: string, code = "22023") => () => Response.json({ code, message, details: null, hint: null }, { status: 400 });
const writes = (sent: Array<{ method: string; path: string }>) => sent.filter((s) => s.method !== "GET" && !s.path.startsWith("rpc/price_change_preview")).map((s) => `${s.method} ${s.path}`);

afterEach(() => vi.unstubAllGlobals());

describe("the assistant putting extra work on a visit", () => {
  const tables = {
    visits: [{ id: VISIT, job_id: JOB }],
    services: [{ id: SERVICE, name: "Mulch", description: "Brown hardwood", unit: "yd", unit_price: 60, taxable: true }],
    visit_extras: [{ id: EXTRA, job_id: JOB, visit_id: VISIT, service_id: SERVICE, name: "Mulch", description: null, quantity: 2, unit: "yd", unit_price: 60, taxable: true, invoice_id: null, visit_was_on: null, added_in_field_at: null, visit: { id: VISIT, status: "scheduled", scheduled_on: "2026-11-20", invoice_id: null }, invoice: null }],
  };

  it("writes it to the visit's extras from the price list, never to the job's lines", async () => {
    const { ctx, sent } = database({}, tables);
    const result = await jobTools.add_extra_work.run(ctx, jobTools.add_extra_work.input.parse({ visit_id: VISIT, service_id: SERVICE, quantity: 2 }));
    expect(sent.find((s) => s.method === "POST" && s.path === "visit_extras")?.body).toEqual({
      company_id: "company-1", job_id: JOB, visit_id: VISIT, service_id: SERVICE, name: "Mulch", description: "Brown hardwood", quantity: 2, unit: "yd", unit_price: 60, taxable: true,
    });
    expect(writes(sent)).toEqual(["POST visit_extras"]);
    expect(result).toMatchObject({ added: true, id: EXTRA, extra_work: [{ name: "Mulch", visit_date: "2026-11-20", added_by_crew: false, state: "Billed when the visit is done" }] });
    // What a visit bills is a price: "Full access, no money" doesn't add it.
    expect(jobTools.add_extra_work.area).toBe("prices");
  });

  it("takes a typed line with its price, and says what's missing from one without", async () => {
    const { ctx, sent } = database({}, tables);
    await jobTools.add_extra_work.run(ctx, jobTools.add_extra_work.input.parse({ visit_id: VISIT, name: "Storm cleanup", unit_price: 85 }));
    expect(sent.find((s) => s.method === "POST" && s.path === "visit_extras")?.body).toMatchObject({ service_id: null, name: "Storm cleanup", quantity: 1, unit: "ea", unit_price: 85, taxable: true });
    await expect(jobTools.add_extra_work.run(ctx, jobTools.add_extra_work.input.parse({ visit_id: VISIT, name: "No price" }))).rejects.toThrow("give a service_id from the price list, or a name and unit_price");
    expect(() => jobTools.add_extra_work.input.parse({ visit_id: VISIT, service_id: SERVICE, quantity: 0 })).toThrow();
  });

  it("moves one to another visit, and removing one is a delete", async () => {
    const { ctx, sent } = database({}, tables);
    expect(await jobTools.add_extra_work.run(ctx, jobTools.add_extra_work.input.parse({ visit_id: VISIT, extra_id: EXTRA }))).toMatchObject({ moved: true });
    expect(sent.find((s) => s.method === "PATCH")).toMatchObject({ path: "visit_extras", body: { visit_id: VISIT } });
    expect(await jobTools.delete_extra_work.run(ctx, jobTools.delete_extra_work.input.parse({ extra_id: EXTRA }))).toEqual({ deleted: true });
    expect(jobTools.delete_extra_work.destructive).toBe(true);
    expect(jobTools.delete_extra_work.area).toBe("prices");
  });

  it("reads a job's or a visit's, each with where it stands", async () => {
    const { ctx } = database({}, tables);
    expect(await jobTools.list_extra_work.run(ctx, jobTools.list_extra_work.input.parse({ job_id: JOB }))).toMatchObject({ extra_work: [{ id: EXTRA, state: "Billed when the visit is done" }] });
    await expect(jobTools.list_extra_work.run(ctx, jobTools.list_extra_work.input.parse({}))).rejects.toThrow("Give a job_id or a visit_id.");
    expect(jobTools.list_extra_work.area).toBeUndefined();
  });
});

describe("the assistant changing prices across repeating jobs", () => {
  const job = (n: number) => ({
    job_id: `job-${n}`, number: n, title: "Mow", client_id: `c${n}`, client: `Client ${n}`, pricing: "per_visit", schedule: "after_visit", old_price: 45, new_price: 47, autopay: false, over_limit: false, was_over_limit: false,
    lines: [{ line_id: `line-${n}`, name: "Mowing", quantity: 1, unit: "visit", old_price: 45, new_price: 47 }],
  });
  const preview = (count: number) => ({ summary: "Up 5%, rounded to the dollar", jobs: Array.from({ length: count }, (_, i) => job(i + 1)), totals: { jobs: count, lines: count, old_price: 45 * count, new_price: 47 * count }, autopay: null });
  const change = { kind: "percent", value: 5, round: "dollar" } as const;

  it("previews with the database's own figures, and changes nothing", async () => {
    const { ctx, sent } = database({ price_change_preview: () => Response.json(preview(3)) });
    const result = await jobTools.preview_price_change.run(ctx, jobTools.preview_price_change.input.parse({ ...change, client_tag: "Commercial", limit: 2 }));
    expect(sent[0]).toMatchObject({ path: "rpc/price_change_preview", body: { p_company: "company-1", p_change: { kind: "percent", value: 5, round: "dollar", jobs: { client_tag: "Commercial" } } } });
    expect(result).toMatchObject({ summary: "Up 5%, rounded to the dollar", totals: { jobs: 3, new_price: 141 }, jobs_not_listed: 1 });
    expect((result as { jobs: unknown[] }).jobs).toHaveLength(2);
    expect(writes(sent)).toEqual([]);
    expect(jobTools.preview_price_change.area).toBeUndefined();
  });

  it("applies exactly what the preview shows now, a group of jobs a call, all under one id", async () => {
    const applied: any[] = [];
    const { ctx } = database({ price_change_preview: () => Response.json(preview(150)), apply_price_change: (body) => (applied.push(body), Response.json({ jobs: 1, lines: 1 })) });
    const result = await jobTools.change_prices.run(ctx, jobTools.change_prices.input.parse({ ...change, expect: { jobs: 150, lines: 150, new_price: 7050 } }));
    expect(applied.map((b) => b.p_lines.length)).toEqual([100, 50]);
    expect(new Set(applied.map((b) => b.p_id)).size).toBe(1);
    expect(applied[0].p_lines[0]).toEqual({ line_id: "line-1", old_price: 45, new_price: 47 });
    expect(applied[0].p_change).toEqual({ kind: "percent", value: 5, round: "dollar" });
    expect(result).toMatchObject({ changed: true, jobs: 150, lines: 150, old_price: 6750, new_price: 7050, price_change_id: applied[0].p_id });
    expect(jobTools.change_prices.area).toBe("prices");
    expect(jobTools.undo_price_change.area).toBe("prices");
  });

  it("changes nothing when the preview has moved on from what the person agreed to", async () => {
    const { ctx, sent } = database({ price_change_preview: () => Response.json(preview(3)), apply_price_change: () => Response.json({}) });
    await expect(jobTools.change_prices.run(ctx, jobTools.change_prices.input.parse({ ...change, expect: { jobs: 2, lines: 2, new_price: 94 } }))).rejects.toThrow(
      "That isn't what the change would do now (3 jobs, 3 lines, new prices come to 141.00). Preview it again and show the person before changing anything.",
    );
    expect(writes(sent)).toEqual([]);
  });

  it("passes on the database's refusal, and says how far it got when a later group is turned down", async () => {
    const first = database({ price_change_preview: () => Response.json(preview(3)), apply_price_change: refusal("Something changed since the preview (job #2). Preview again, then apply") });
    await expect(jobTools.change_prices.run(first.ctx, jobTools.change_prices.input.parse({ ...change, expect: { jobs: 3, lines: 3, new_price: 141 } }))).rejects.toThrow("Something changed since the preview (job #2). Preview again, then apply");
    let calls = 0;
    const later = database({ price_change_preview: () => Response.json(preview(150)), apply_price_change: () => (++calls === 1 ? Response.json({}) : refusal("Something changed since the preview (job #120). Preview again, then apply")()) });
    await expect(jobTools.change_prices.run(later.ctx, jobTools.change_prices.input.parse({ ...change, expect: { jobs: 150, lines: 150, new_price: 7050 } }))).rejects.toThrow(
      "Prices changed on 100 of 150 jobs. The rest weren't changed: Something changed since the preview (job #120). Preview again, then apply",
    );
  });

  it("undoes a whole change through the database, or lists the changes that can be", async () => {
    const { ctx, sent } = database({ undo_price_change: () => Response.json({ restored: 148, left: 2 }), price_change_history: () => Response.json([{ id: "pc-1", summary: "Up 5%", invoice: null }]) });
    expect(await jobTools.undo_price_change.run(ctx, jobTools.undo_price_change.input.parse({ price_change_id: EXTRA }))).toEqual({ undone: true, restored: 148, left: 2 });
    expect(sent[0]).toMatchObject({ path: "rpc/undo_price_change", body: { p_company: "company-1", p_id: EXTRA } });
    expect(await jobTools.undo_price_change.run(ctx, jobTools.undo_price_change.input.parse({}))).toEqual({ price_changes: [{ id: "pc-1", summary: "Up 5%", invoice: null }] });
    const refused = database({ undo_price_change: refusal("Invoice #12 was made at the new prices, so this change can't be undone. Change prices again to move them back") });
    await expect(jobTools.undo_price_change.run(refused.ctx, jobTools.undo_price_change.input.parse({ price_change_id: EXTRA }))).rejects.toThrow("Invoice #12 was made at the new prices");
  });
});
