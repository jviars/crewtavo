/**
 * Guides (the knowledge base's SOPs). An assistant writes them in Markdown, which becomes the HTML
 * the guide editor makes (markdownToGuide in packages/core). Every saved change is kept as a
 * revision, as when someone edits one in Crewtavo.
 */
import { markdownToGuide, ROLES } from "@crewtavo/core";
import { z } from "zod";
import { changed, companyArg, one, rows, tool, type ToolContext } from "./tool";

/** The category with this name (any case), made if there's none yet. */
async function categoryId(ctx: ToolContext, name: string): Promise<string> {
  const categories = await rows(ctx.db.from("sop_categories").select("id, name, sort").eq("company_id", ctx.companyId).order("sort"));
  const found = categories.find((c) => c.name.trim().toLowerCase() === name.trim().toLowerCase());
  if (found) return found.id;
  const made = await one(
    ctx.db.from("sop_categories").insert({ company_id: ctx.companyId, name: name.trim(), sort: (categories.at(-1)?.sort ?? 0) + 1 }).select("id").single(),
    "The category",
  );
  return made.id;
}

export const guideTools = {
  list_guide_categories: tool({
    description: "The categories guides are filed under.",
    input: z.object({ ...companyArg }),
    run: (ctx) => rows(ctx.db.from("sop_categories").select("id, name").eq("company_id", ctx.companyId).order("sort").order("name")),
  }),
  get_guide: tool({
    description: "A guide in full (find it with search_sops): its text and HTML, category, whether it's published or required reading, and updated_at, which save_guide needs to change it.",
    input: z.object({ guide_id: z.uuid(), ...companyArg }),
    run: async (ctx, a) => {
      const guide = await one(
        ctx.db
          .from("sop_pages")
          .select("id, title, status, required, audience, tags, body_text, body_html, updated_at, revision, category:sop_categories(name)")
          .eq("id", a.guide_id)
          .eq("company_id", ctx.companyId)
          .maybeSingle(),
        "That guide",
      );
      return guide;
    },
  }),
  save_guide: tool({
    description:
      "Write a new guide (no guide_id) or replace one (with guide_id and the updated_at get_guide gave, so a newer save by someone else isn't lost). The body is Markdown: headings, numbered steps, lists, checklists (- [ ] Step), bold, italics, links, quotes, callouts (a quote whose first line is [!TIP], [!IMPORTANT] or [!WARNING]) and code; a YouTube or Vimeo link alone on its own line shows as the video. New guides are drafts unless status is published.",
    input: z.object({
      guide_id: z.uuid().optional(),
      updated_at: z.string().optional().describe("From get_guide; needed with guide_id."),
      title: z.string().trim().min(1).max(200),
      body_markdown: z.string().max(100_000),
      category: z.string().trim().max(80).nullable().optional().describe("A category's name; made if it doesn't exist yet."),
      status: z.enum(["draft", "published"]).optional(),
      required: z.boolean().optional().describe("Required reading: people are asked to read and acknowledge it."),
      audience: z.array(z.enum(ROLES)).optional().describe("Who must read it when it's required; everyone when left out."),
      tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
      ...companyArg,
    }),
    area: "guides",
    run: async (ctx, a) => {
      if (a.guide_id && !a.updated_at) throw new Error("Read the guide with get_guide first, and send its updated_at.");
      const { html, text } = markdownToGuide(a.body_markdown);
      const status = a.status ?? (a.guide_id ? undefined : "draft");
      if (a.required && status === "published" && !text.trim() && !html.includes("<iframe")) throw new Error("Add some content before making this required reading.");
      const row = {
        title: a.title,
        body: { type: "html", html },
        body_html: html,
        body_text: text,
        ...(a.category !== undefined && { category_id: a.category ? await categoryId(ctx, a.category) : null }),
        ...(status && { status }),
        ...(a.required !== undefined && { required: a.required, audience: a.required && a.audience?.length ? a.audience : null }),
        ...(a.tags && { tags: a.tags }),
      };
      if (a.guide_id) {
        // Don't overwrite someone else's save made since it was read.
        const saved = await rows(ctx.db.from("sop_pages").update(row).eq("id", a.guide_id).eq("company_id", ctx.companyId).eq("updated_at", a.updated_at!).select("id, updated_at"));
        if (!saved.length) throw new Error("Someone else saved this guide since you read it (or it's gone). Read it again with get_guide and make the change on that.");
        return { guide_id: a.guide_id, updated_at: saved[0].updated_at };
      }
      const made = await one(ctx.db.from("sop_pages").insert({ ...row, company_id: ctx.companyId }).select("id, status").single(), "The guide");
      return { guide_id: made.id, status: made.status };
    },
  }),
  delete_guide: tool({
    description: "Delete a guide and its history. To take it down but keep it, save it as a draft instead.",
    input: z.object({ guide_id: z.uuid(), ...companyArg }),
    area: "guides",
    destructive: true,
    run: async (ctx, a) => {
      await changed(ctx.db.from("sop_pages").delete().eq("id", a.guide_id).eq("company_id", ctx.companyId).select("id"), "That guide");
      return { deleted: true };
    },
  }),
};
