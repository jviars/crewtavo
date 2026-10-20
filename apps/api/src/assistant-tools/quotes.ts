/**
 * Quotes: made, changed, sent and turned into jobs the way the quote screens do it
 * (apps/web/src/features/quotes), with the totals worked out by the database (quote_totals) and
 * sending through services/sales.ts. Quotes are money: "Full access, no money" doesn't change them.
 */
import { addDays, localDate, taxRateFromPercent } from "@crewtavo/core";
import { z } from "zod";
import { quoteFromRequest, sendQuote, sendSchema } from "../services/sales";
import { changed, companyArg, friendly, one, rows, tool, type ToolContext } from "./tool";

const quoteLine = z.object({
  service_id: z.uuid().optional().describe("A price list item (list_services): its name, unit, price and tax come with it."),
  name: z.string().trim().min(1).max(200).optional().describe("For a line that isn't on the price list."),
  description: z.string().trim().max(2000).nullable().optional(),
  quantity: z.number().min(0).max(1e6).default(1),
  unit_price: z.number().min(-1e7).max(1e7).optional().describe("Overrides the price list's price."),
  unit: z.string().trim().min(1).max(20).optional(),
  taxable: z.boolean().optional(),
  optional: z.boolean().default(false).describe("An add-on the client can choose."),
  option_group: z.string().trim().max(40).nullable().optional().describe('"Good", "Better", "Best": the client picks one line in the group.'),
});

async function quoteLines(ctx: ToolContext, quoteId: string, lines: ReadonlyArray<z.infer<typeof quoteLine>>) {
  const ids = [...new Set(lines.flatMap((l) => (l.service_id ? [l.service_id] : [])))];
  const services = ids.length ? await rows(ctx.db.from("services").select("id, name, description, unit, unit_price, unit_cost, taxable").in("id", ids).eq("company_id", ctx.companyId)) : [];
  const byId = new Map(services.map((s) => [s.id, s]));
  return lines.map((l, i) => {
    const s = l.service_id ? byId.get(l.service_id) : undefined;
    if (l.service_id && !s) throw new Error(`Line ${i + 1}: that price list item isn't in this company's price list.`);
    if (!s && (!l.name || l.unit_price === undefined)) throw new Error(`Line ${i + 1}: give a service_id from the price list, or a name and unit_price.`);
    return {
      company_id: ctx.companyId,
      quote_id: quoteId,
      service_id: s?.id ?? null,
      name: l.name ?? s!.name,
      description: l.description !== undefined ? l.description : (s?.description ?? null),
      quantity: l.quantity,
      unit: l.unit ?? s?.unit ?? "ea",
      unit_price: l.unit_price ?? Number(s!.unit_price),
      unit_cost: s?.unit_cost ?? null,
      taxable: l.taxable ?? s?.taxable ?? true,
      optional: l.optional,
      // An option the client picks starts out not chosen, except the first of its group.
      selected: !l.optional && !(l.option_group && lines.findIndex((x) => x.option_group === l.option_group) !== i),
      option_group: l.option_group ?? null,
      sort: i + 1,
    };
  });
}

async function replaceLines(ctx: ToolContext, quoteId: string, lines: ReadonlyArray<z.infer<typeof quoteLine>>) {
  const made = await quoteLines(ctx, quoteId, lines);
  const { error } = await ctx.db.from("quote_line_items").delete().eq("quote_id", quoteId);
  if (error) throw new Error(friendly(error.message));
  if (made.length) {
    const { error: insertError } = await ctx.db.from("quote_line_items").insert(made);
    if (insertError) throw new Error(friendly(insertError.message));
  }
}

const salesScope = (ctx: ToolContext) => ({ db: ctx.db, env: ctx.env, companyId: ctx.companyId, baseUrl: (ctx.env.APP_URL ?? ctx.origin).replace(/\/$/, "") });

export const quoteTools = {
  list_quotes: tool({
    description: "Quotes, newest first, with client, total and status. Filter by status (draft, sent, changes_requested, approved, converted, lost, archived, or open: sent and changes requested) and client.",
    input: z.object({
      status: z.enum(["all", "open", "draft", "sent", "changes_requested", "approved", "converted", "lost", "archived"]).default("all"),
      client_id: z.uuid().optional(),
      limit: z.number().int().min(1).max(200).default(50),
      offset: z.number().int().min(0).default(0),
      ...companyArg,
    }),
    run: async (ctx, a) => {
      let q = ctx.db.from("quotes").select("id, number, title, status, total, sent_at, valid_until, client:clients(id, display_name)", { count: "exact" }).eq("company_id", ctx.companyId);
      if (a.status === "open") q = q.in("status", ["sent", "changes_requested"]);
      else if (a.status !== "all") q = q.eq("status", a.status);
      if (a.client_id) q = q.eq("client_id", a.client_id);
      const { data, error, count } = await q.order("created_at", { ascending: false }).range(a.offset, a.offset + a.limit - 1);
      if (error) throw new Error(friendly(error.message));
      const next = a.offset + (data?.length ?? 0);
      return { total: count ?? data?.length ?? 0, quotes: data ?? [], next_offset: count !== null && next < count ? next : null };
    },
  }),
  get_quote: tool({
    description: "A quote in full: client, property, its lines and options, totals, tax, discount and deposit, and status.",
    input: z.object({ quote_id: z.uuid(), ...companyArg }),
    run: async (ctx, a) => {
      const quote = await one(
        ctx.db
          .from("quotes")
          .select("id, number, title, message, status, subtotal, discount_amount, tax_rate, tax_amount, total, deposit_amount, valid_until, sent_at, approved_at, lost_reason, client:clients(id, display_name, email), property:properties(id, line1, city), lines:quote_line_items(id, service_id, name, description, quantity, unit, unit_price, taxable, optional, selected, option_group, sort)")
          .eq("id", a.quote_id)
          .eq("company_id", ctx.companyId)
          .maybeSingle(),
        "That quote",
      );
      return { ...quote, lines: [...(quote.lines as Array<{ sort: number }>)].sort((x, y) => x.sort - y.sort) };
    },
  }),
  create_quote: tool({
    description:
      "Start a quote: from a request (request_id: its client, property and measurement come along, and the request becomes quoted), or for a client (client_id, title). It's a draft with the company's sales tax and valid-for days until sent. Add lines from the price list or custom ones, with options the client chooses.",
    input: z.object({
      request_id: z.uuid().optional(),
      client_id: z.uuid().optional(),
      property_id: z.uuid().optional(),
      title: z.string().trim().min(1).max(200).optional(),
      message: z.string().trim().max(4000).optional().describe("A note to the client on the quote."),
      lines: z.array(quoteLine).max(100).default([]),
      ...companyArg,
    }),
    area: "quotes",
    run: async (ctx, a) => {
      let quote: { id: string; number: number | null };
      if (a.request_id) {
        quote = await quoteFromRequest(salesScope(ctx), a.request_id);
        if (a.title || a.message) await ctx.db.from("quotes").update({ ...(a.title && { title: a.title }), ...(a.message && { message: a.message }) }).eq("id", quote.id);
      } else {
        if (!a.client_id || !a.title) throw new Error("Give a request_id, or a client_id and a title.");
        const company = await one(ctx.db.from("companies").select("settings").eq("id", ctx.companyId).maybeSingle(), "The company");
        const settings = (company.settings ?? {}) as { default_tax_rate?: number; quote_valid_days?: number };
        quote = await one(
          ctx.db
            .from("quotes")
            .insert({
              company_id: ctx.companyId,
              client_id: a.client_id,
              property_id: a.property_id ?? null,
              title: a.title,
              message: a.message ?? null,
              tax_rate: Number(settings.default_tax_rate ?? 0),
              valid_until: addDays(localDate(new Date(), ctx.timezone), Number(settings.quote_valid_days ?? 30)),
            })
            .select("id, number")
            .single(),
          "The quote",
        );
      }
      if (a.lines.length) await replaceLines(ctx, quote.id, a.lines);
      const totals = await one(ctx.db.from("quotes").select("subtotal, tax_amount, total").eq("id", quote.id).maybeSingle(), "The quote");
      return { quote_id: quote.id, number: quote.number, ...totals };
    },
  }),
  update_quote: tool({
    description: "Change a quote: title, message, how long it's valid, sales tax, discount, deposit asked for, or its lines (lines replaces them all). Send only what changes.",
    input: z.object({
      quote_id: z.uuid(),
      title: z.string().trim().min(1).max(200).optional(),
      message: z.string().trim().max(4000).nullable().optional(),
      valid_until: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
      sales_tax_percent: z.number().min(0).lt(100).optional(),
      discount_amount: z.number().min(0).max(1e7).optional(),
      deposit_amount: z.number().min(0).max(1e7).optional(),
      lines: z.array(quoteLine).max(100).optional(),
      ...companyArg,
    }),
    area: "quotes",
    run: async (ctx, a) => {
      const patch = {
        ...(a.title !== undefined && { title: a.title }),
        ...(a.message !== undefined && { message: a.message }),
        ...(a.valid_until !== undefined && { valid_until: a.valid_until }),
        ...(a.sales_tax_percent !== undefined && { tax_rate: taxRateFromPercent(a.sales_tax_percent) }),
        ...(a.discount_amount !== undefined && { discount_amount: a.discount_amount }),
        ...(a.deposit_amount !== undefined && { deposit_amount: a.deposit_amount }),
      };
      if (Object.keys(patch).length) await changed(ctx.db.from("quotes").update(patch).eq("id", a.quote_id).eq("company_id", ctx.companyId).select("id"), "That quote");
      if (a.lines) await replaceLines(ctx, a.quote_id, a.lines);
      return one(ctx.db.from("quotes").select("id, number, status, subtotal, discount_amount, tax_amount, total").eq("id", a.quote_id).maybeSingle(), "That quote");
    },
  }),
  send_quote: tool({
    description: "Send a quote to the client by email (default) or text, with their link to review, choose options and approve it; or just make the link (channel link) to share another way. It's then marked sent.",
    input: z.object({ quote_id: z.uuid(), ...sendSchema.shape, ...companyArg }),
    area: "quotes",
    run: async (ctx, { quote_id, company_id: _, ...body }) => sendQuote(salesScope(ctx), quote_id, body),
  }),
  convert_quote_to_job: tool({
    description: "Turn an approved (or sent) quote into a job with its chosen lines and any discount; the client becomes active. To make it a recurring service or schedule it, follow with update_job or create_visit.",
    input: z.object({ quote_id: z.uuid(), ...companyArg }),
    area: "quotes",
    run: async (ctx, a) => {
      const { data, error } = await ctx.db.rpc("convert_quote_to_job", { p_quote: a.quote_id });
      if (error) throw new Error(friendly(error.message));
      return { job_id: data };
    },
  }),
  mark_quote: tool({
    description: "Mark a quote approved (the client said yes another way), lost (with the reason), archived, or back to draft.",
    input: z.object({ quote_id: z.uuid(), status: z.enum(["approved", "lost", "archived", "draft"]), lost_reason: z.string().trim().max(200).optional(), ...companyArg }),
    area: "quotes",
    run: async (ctx, a) => {
      await changed(
        ctx.db
          .from("quotes")
          .update({ status: a.status, ...(a.status === "approved" && { approved_at: new Date().toISOString() }), ...(a.status === "lost" && { lost_reason: a.lost_reason ?? null }) })
          .eq("id", a.quote_id)
          .eq("company_id", ctx.companyId)
          .select("id"),
        "That quote",
      );
      return { saved: true };
    },
  }),
};
