/** Checklists crews fill in on a visit (Settings → Checklists): inspections, safety steps, sign-offs. */
import { CHECKLIST_ITEM_TYPES, MAX_CHECKLIST_ITEMS, normalizeChecklist } from "@crewtavo/core";
import { z } from "zod";
import { changed, companyArg, one, rows, tool } from "./tool";

const item = z.object({
  key: z.string().max(60).optional().describe("Keep an existing item's key when changing it; new items get one from their label."),
  label: z.string().max(200),
  type: z.enum(CHECKLIST_ITEM_TYPES).describe("check (a tick box), number, text, choice (pick one of options), photo or signature."),
  required: z.boolean().default(false),
  options: z.array(z.string().max(100)).max(20).optional().describe("For choice items."),
  sop_page_id: z.uuid().optional().describe("A guide the item links to (from search_sops)."),
});

export const checklistTools = {
  list_checklists: tool({
    description: "The company's checklists, with their items. job_type is the kind of job a checklist is for, if any.",
    input: z.object({ ...companyArg }),
    run: (ctx) => rows(ctx.db.from("checklist_templates").select("id, name, job_type, items, active").eq("company_id", ctx.companyId).order("name")),
  }),
  save_checklist: tool({
    description: `Make a checklist (no checklist_id), or change one (with checklist_id; send its whole item list, from list_checklists). Up to ${MAX_CHECKLIST_ITEMS} items.`,
    input: z.object({
      checklist_id: z.uuid().optional(),
      name: z.string().max(120),
      job_type: z.string().max(80).nullable().optional(),
      items: z.array(item).max(MAX_CHECKLIST_ITEMS),
      active: z.boolean().optional().describe("A checklist that's turned off isn't offered on visits."),
      ...companyArg,
    }),
    area: "checklists",
    run: async (ctx, a) => {
      const clean = normalizeChecklist(a);
      const row = { ...clean, items: clean.items as never, ...(a.active !== undefined && { active: a.active }) };
      if (a.checklist_id) {
        await changed(ctx.db.from("checklist_templates").update(row).eq("id", a.checklist_id).eq("company_id", ctx.companyId).select("id"), "That checklist");
        return { checklist_id: a.checklist_id, saved: true };
      }
      const made = await one(ctx.db.from("checklist_templates").insert({ ...row, company_id: ctx.companyId }).select("id").single(), "The checklist");
      return { checklist_id: made.id, saved: true };
    },
  }),
  delete_checklist: tool({
    description: "Delete a checklist. Ones already filled in on visits are kept. To stop using it but keep it, save it with active false instead.",
    input: z.object({ checklist_id: z.uuid(), ...companyArg }),
    area: "checklists",
    destructive: true,
    run: async (ctx, a) => {
      await changed(ctx.db.from("checklist_templates").delete().eq("id", a.checklist_id).eq("company_id", ctx.companyId).select("id"), "That checklist");
      return { deleted: true };
    },
  }),
};
