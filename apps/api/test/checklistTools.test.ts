/**
 * The assistant's checklist tools (assistant-tools/checklists.ts) read and set which price list
 * items a checklist goes with, by service id, all at once through set_checklist_services.
 */
import { createClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checklistTools } from "../src/assistant-tools/checklists";
import type { ToolContext } from "../src/assistant-tools/tool";

const MOW = "11111111-1111-4111-8111-111111111111";
const EDGE = "22222222-2222-4222-8222-222222222222";
const LIST = "33333333-3333-4333-8333-333333333333";

/** The Data API, answering `rows` and keeping what was sent. */
function database(rows: unknown) {
  const sent: Array<{ method: string; path: string; body: unknown }> = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = init?.method ?? "GET";
    sent.push({ method, path: `${url.pathname}${url.search}`, body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
    if (url.pathname.startsWith("/rest/v1/rpc/")) return new Response(null, { status: 204 });
    return Response.json(method === "POST" ? { id: LIST } : rows, { status: method === "POST" ? 201 : 200 });
  });
  const ctx = { db: createClient("http://127.0.0.1:8080", "sb_publishable_test"), companyId: "company-1" } as unknown as ToolContext;
  return { sent, ctx };
}

afterEach(() => vi.unstubAllGlobals());

describe("the assistant's checklists", () => {
  it("are listed with the price list items each goes with", async () => {
    const { ctx, sent } = database([{ id: LIST, name: "Mow check", items: [], active: true, services: [{ service_id: MOW }, { service_id: EDGE }] }]);
    expect(await checklistTools.list_checklists.run(ctx, {})).toEqual([{ id: LIST, name: "Mow check", items: [], active: true, service_ids: [MOW, EDGE] }]);
    expect(decodeURIComponent(sent[0]!.path)).toContain("services:checklist_template_services(service_id)");
  });

  it("set their items all at once, by service id", async () => {
    const { ctx, sent } = database([{ id: LIST }]);
    const args = { checklist_id: LIST, name: "Mow check", items: [{ label: "Edges done", type: "check" as const, required: true }], service_ids: [MOW] };
    expect(await checklistTools.save_checklist.run(ctx, checklistTools.save_checklist.input.parse(args))).toEqual({ checklist_id: LIST, saved: true });
    expect(sent.at(-1)).toEqual({ method: "POST", path: "/rest/v1/rpc/set_checklist_services", body: { p_template: LIST, p_services: [MOW] } });
  });

  it("keep their items when service_ids is left out, and a new one goes with what it's given", async () => {
    const kept = database([{ id: LIST }]);
    await checklistTools.save_checklist.run(kept.ctx, checklistTools.save_checklist.input.parse({ checklist_id: LIST, name: "Mow check", items: [{ label: "Edges done", type: "check" }] }));
    expect(kept.sent.some((s) => s.path.includes("/rpc/"))).toBe(false);

    const made = database([]);
    await checklistTools.save_checklist.run(made.ctx, checklistTools.save_checklist.input.parse({ name: "Snow stop", items: [{ label: "Walks clear", type: "check" }], service_ids: [EDGE] }));
    expect(made.sent.at(-1)?.body).toEqual({ p_template: LIST, p_services: [EDGE] });
  });
  it("read a job's filled-in checklists, worded as the office sees them, and say who filled each in", async () => {
    const { ctx, sent } = database([]);
    const answers = { edges: true, sign: { name: "Dana Whitfield", image: "data:image/png;base64,iVBORw0KGgo=" } };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      sent.push({ method: init?.method ?? "GET", path: `${url.pathname}${url.search}`, body: null });
      if (url.pathname.endsWith("/profiles")) return Response.json([{ user_id: "u-cal", full_name: "Cal Crew" }]);
      return Response.json([{
        visit_id: "v1", answers, completed_at: null, completed_by: "u-cal", visit: { title: "Mow", scheduled_on: "2026-10-03" },
        template: { id: LIST, name: "Mow check", show_to_client: true, items: [
          { key: "edges", label: "Edges done", type: "check", required: true },
          { key: "gate", label: "Gate closed", type: "check", required: true },
          { key: "sign", label: "Signature", type: "signature", required: false },
        ] },
      }]);
    });
    const job = "44444444-4444-4444-8444-444444444444";
    expect(await checklistTools.filled_checklists.run(ctx, checklistTools.filled_checklists.input.parse({ job_id: job }))).toEqual([{
      checklist_id: LIST, checklist: "Mow check", visit_id: "v1", visit: "Mow", visit_on: "2026-10-03", done: false, filled_in_by: "Cal Crew", show_to_client: true,
      answers: [
        { label: "Edges done", type: "check", answer: "Yes" },
        { label: "Gate closed", type: "check", answer: "No", missing: true },
        { label: "Signature", type: "signature", answer: "Dana Whitfield" },
      ],
    }]);
    expect(decodeURIComponent(sent[0]!.path)).toContain(`visit.job_id=eq.${job}`);
    await expect(checklistTools.filled_checklists.run(ctx, {})).rejects.toThrow(/job_id or a visit_id/);
  });
});
