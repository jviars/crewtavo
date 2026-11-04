/** Checklists crews fill in on a visit (Settings → Checklists): inspections, safety steps, sign-offs. */
import { CHECKLIST_ITEM_TYPES, checklistAnswers, MAX_CHECKLIST_ITEMS, normalizeChecklist } from "@crewtavo/core";
import { z } from "zod";
import { changed, companyArg, friendly, one, rows, tool } from "./tool";

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
    description:
      "The company's checklists, with their items and service_ids: the price list items (ids from list_services) each goes with. A visit whose job has one of those items brings the checklist up for the crew; one with none is offered on any job. show_to_client: its finished answers show on the client's past visits and print on the job's invoice.",
    input: z.object({ ...companyArg }),
    run: async (ctx) => {
      const lists = await rows(ctx.db.from("checklist_templates").select("id, name, items, active, show_to_client, services:checklist_template_services(service_id)").eq("company_id", ctx.companyId).order("name"));
      return lists.map(({ services, ...list }) => ({ ...list, service_ids: services.map((s) => s.service_id) }));
    },
  }),
  save_checklist: tool({
    description: `Make a checklist (no checklist_id), or change one (with checklist_id; send its whole item list, from list_checklists). Up to ${MAX_CHECKLIST_ITEMS} items.`,
    input: z.object({
      checklist_id: z.uuid().optional(),
      name: z.string().max(120),
      items: z.array(item).max(MAX_CHECKLIST_ITEMS),
      service_ids: z
        .array(z.uuid())
        .max(200)
        .optional()
        .describe("The price list items it goes with (ids from list_services), replacing the ones it had. [] for any job. Left out, they stay as they are (a new checklist: any job)."),
      active: z.boolean().optional().describe("A checklist that's turned off isn't offered on visits."),
      show_to_client: z.boolean().optional().describe("Its finished answers show on the client's past visits and print on the job's invoice (photos never do). New checklists: off."),
      ...companyArg,
    }),
    area: "checklists",
    run: async (ctx, a) => {
      const clean = normalizeChecklist(a);
      const row = { ...clean, items: clean.items as never, ...(a.active !== undefined && { active: a.active }), ...(a.show_to_client !== undefined && { show_to_client: a.show_to_client }) };
      let id = a.checklist_id;
      if (id) await changed(ctx.db.from("checklist_templates").update(row).eq("id", id).eq("company_id", ctx.companyId).select("id"), "That checklist");
      else id = (await one(ctx.db.from("checklist_templates").insert({ ...row, company_id: ctx.companyId }).select("id").single(), "The checklist")).id;
      if (a.service_ids) {
        const { error } = await ctx.db.rpc("set_checklist_services", { p_template: id, p_services: a.service_ids });
        if (error) throw new Error(friendly(error.message));
      }
      return { checklist_id: id, saved: true };
    },
  }),
  filled_checklists: tool({
    description:
      "The checklists crews filled in on a job's visits (job_id) or on one visit (visit_id): each with its visit, whether it's done, who filled it in, whether the client sees it (show_to_client), and its answers in its items' order. A check answers Yes or No; a photo item has no answer (its photos are the visit's); missing marks a required item not answered yet.",
    input: z.object({ job_id: z.uuid().optional(), visit_id: z.uuid().optional(), ...companyArg }),
    run: async (ctx, a) => {
      if (!a.job_id && !a.visit_id) throw new Error("Give a job_id or a visit_id.");
      const query = ctx.db
        .from("checklist_responses")
        .select("visit_id, answers, completed_at, completed_by, template:checklist_templates(id, name, items, show_to_client), visit:visits!inner(title, scheduled_on, job_id)")
        .eq("company_id", ctx.companyId)
        .order("created_at");
      const filled = await rows(a.visit_id ? query.eq("visit_id", a.visit_id) : query.eq("visit.job_id", a.job_id!));
      const people = [...new Set(filled.map((r) => r.completed_by).filter((id): id is string => Boolean(id)))];
      const names = new Map(people.length ? (await rows(ctx.db.from("profiles").select("user_id, full_name").in("user_id", people))).map((p) => [p.user_id, p.full_name]) : []);
      return filled.map((r) => ({
        checklist_id: r.template?.id ?? null,
        checklist: r.template?.name ?? "Deleted checklist",
        visit_id: r.visit_id,
        visit: r.visit?.title ?? null,
        visit_on: r.visit?.scheduled_on ?? null,
        done: Boolean(r.completed_at),
        filled_in_by: r.completed_by ? names.get(r.completed_by) ?? "Former team member" : null,
        show_to_client: r.template?.show_to_client ?? false,
        // A signature's drawing stays out: its printed name is the answer.
        answers: checklistAnswers(r.template?.items ?? null, r.answers).map(({ label, type, text, missing }) => ({ label, type, answer: text, ...(missing && { missing }) })),
      }));
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
