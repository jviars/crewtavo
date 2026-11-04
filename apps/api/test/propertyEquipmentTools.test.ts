/**
 * The assistant's tools for equipment at a property (assistant-tools/propertyEquipment.ts): each
 * item comes with the visits that serviced it, newest first; saving sends only what changes.
 */
import { createClient } from "@supabase/supabase-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { propertyEquipmentTools } from "../src/assistant-tools/propertyEquipment";
import type { ToolContext } from "../src/assistant-tools/tool";

const HOUSE = "11111111-1111-4111-8111-111111111111";
const FURNACE = "22222222-2222-4222-8222-222222222222";

/** The Data API, answering `rows` and keeping what was sent. */
function database(rows: unknown) {
  const sent: Array<{ method: string; path: string; body: unknown }> = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = init?.method ?? "GET";
    sent.push({ method, path: decodeURIComponent(`${url.pathname}${url.search}`), body: typeof init?.body === "string" ? JSON.parse(init.body) : null });
    return Response.json(method === "POST" ? { id: FURNACE } : rows, { status: method === "POST" ? 201 : 200 });
  });
  const ctx = { db: createClient("http://127.0.0.1:8080", "sb_publishable_test"), companyId: "company-1", timezone: "America/New_York" } as unknown as ToolContext;
  return { sent, ctx };
}

afterEach(() => vi.unstubAllGlobals());

describe("the assistant's property equipment", () => {
  it("lists what's in use, each with the visits that serviced it, newest first", async () => {
    const { ctx, sent } = database([
      {
        id: FURNACE, name: "Furnace", status: "active",
        serviced: [
          { visit: { id: "v1", title: "Spring tune-up", scheduled_on: "2026-04-01", completed_at: "2026-04-02T15:00:00Z", crew: { name: "Heat" } } },
          { visit: null },
          { visit: { id: "v2", title: "Fall tune-up", scheduled_on: "2026-10-01", completed_at: null, crew: null } },
        ],
      },
    ]);
    const list = propertyEquipmentTools.list_property_equipment;
    expect(await list.run(ctx, list.input.parse({ property_id: HOUSE }))).toEqual([
      {
        id: FURNACE, name: "Furnace", status: "active",
        serviced: [
          { visit_id: "v2", title: "Fall tune-up", date: "2026-10-01", crew: null },
          { visit_id: "v1", title: "Spring tune-up", date: "2026-04-02", crew: "Heat" },
        ],
      },
    ]);
    expect(sent[0]!.path).toContain(`property_id=eq.${HOUSE}`);
    expect(sent[0]!.path).toContain("status=eq.active");
  });

  it("adds an item with a name, and changes only what's sent", async () => {
    const save = propertyEquipmentTools.save_property_equipment;
    const added = database([]);
    expect(await save.run(added.ctx, save.input.parse({ property_id: HOUSE, name: "Water heater", make: "Rheem", model: "" }))).toEqual({ equipment_id: FURNACE, saved: true });
    expect(added.sent.at(-1)?.body).toEqual({ name: "Water heater", make: "Rheem", model: null, company_id: "company-1", property_id: HOUSE });

    const changedOne = database([{ id: FURNACE }]);
    await save.run(changedOne.ctx, save.input.parse({ equipment_id: FURNACE, status: "retired" }));
    expect(changedOne.sent.at(-1)).toMatchObject({ method: "PATCH", body: { status: "retired" } });

    await expect(save.run(database([]).ctx, save.input.parse({ property_id: HOUSE }))).rejects.toThrow("needs the property_id and a name");
  });
});
