/** Online booking (Settings → Online booking): the public forms clients fill in to ask for work. */
import { INTAKE_FORM_KINDS, INTAKE_QUESTION_TYPES, normalizeIntakeForm } from "@crewtavo/core";
import { z } from "zod";
import { changed, companyArg, one, rows, tool, type ToolContext } from "./tool";

const question = z.object({
  key: z.string().max(60).optional().describe("Keep an existing question's key when changing it; new questions get one from their label."),
  label: z.string().max(200),
  type: z.enum(INTAKE_QUESTION_TYPES).describe("text, long_text (a paragraph), number, yes_no, choice (pick one), multi_choice (pick any), files (plans, PDFs) or photos."),
  required: z.boolean().default(false),
  options: z.array(z.string().max(100)).max(30).optional().describe("For choice and multi_choice."),
});

async function companySlug(ctx: ToolContext) {
  return (await one(ctx.db.from("companies").select("slug").eq("id", ctx.companyId).maybeSingle(), "The company")).slug;
}

export const bookingTools = {
  list_booking_forms: tool({
    description: "The company's online booking forms: name, kind, questions, service-area ZIP codes, whether it's live, and its public link.",
    input: z.object({ ...companyArg }),
    run: async (ctx) => {
      const [forms, slug] = await Promise.all([
        rows(ctx.db.from("intake_forms").select("id, slug, name, kind, active, questions, service_area_zips").eq("company_id", ctx.companyId).order("name")),
        companySlug(ctx),
      ]);
      return forms.map((f) => ({ ...f, link: `${ctx.origin}/book/${slug}/${f.slug}` }));
    },
  }),
  save_booking_form: tool({
    description:
      "Make a booking form (no form_id), or change one (with form_id; send its whole question list, from list_booking_forms). Name, email, phone and address are always asked, so don't add them as questions. Kinds: request (ask for a quote), assessment (book an estimate), booking (book a service).",
    input: z.object({
      form_id: z.uuid().optional(),
      name: z.string().max(120),
      slug: z.string().max(50).optional().describe("The end of its link; made from the name when left out."),
      kind: z.enum(INTAKE_FORM_KINDS).default("request"),
      service_area_zips: z.array(z.string().max(10)).max(500).default([]).describe("5-digit ZIP codes it takes requests from; empty takes any."),
      questions: z.array(question).max(30),
      active: z.boolean().optional().describe("A form that's turned off stops taking requests."),
      ...companyArg,
    }),
    area: "booking",
    run: async (ctx, a) => {
      const others = await rows(ctx.db.from("intake_forms").select("id, slug").eq("company_id", ctx.companyId));
      const existing = a.form_id ? others.find((f) => f.id === a.form_id) : undefined;
      if (a.form_id && !existing) throw new Error("That booking form not found (or you can't see it).");
      const clean = normalizeIntakeForm(
        { name: a.name, slug: a.slug ?? existing?.slug, zips: a.service_area_zips, questions: a.questions },
        others.filter((f) => f.id !== a.form_id).map((f) => f.slug),
      );
      const row = { ...clean, questions: clean.questions as never, kind: a.kind, ...(a.active !== undefined && { active: a.active }) };
      const id = a.form_id
        ? (await changed(ctx.db.from("intake_forms").update(row).eq("id", a.form_id).eq("company_id", ctx.companyId).select("id"), "That booking form"))[0].id
        : (await one(ctx.db.from("intake_forms").insert({ ...row, company_id: ctx.companyId }).select("id").single(), "The booking form")).id;
      return { form_id: id, link: `${ctx.origin}/book/${await companySlug(ctx)}/${clean.slug}` };
    },
  }),
  delete_booking_form: tool({
    description: "Delete a booking form. Its link stops working; requests it brought in are kept. To pause it instead, save it with active false.",
    input: z.object({ form_id: z.uuid(), ...companyArg }),
    area: "booking",
    destructive: true,
    run: async (ctx, a) => {
      await changed(ctx.db.from("intake_forms").delete().eq("id", a.form_id).eq("company_id", ctx.companyId).select("id"), "That booking form");
      return { deleted: true };
    },
  }),
};
