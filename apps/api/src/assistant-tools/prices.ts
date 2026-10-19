/** The price list (Settings → Price list): services and products with their prices, costs and formulas. */
import { FORMULA_VARIABLES, validateFormula } from "@crewtavo/core";
import { z } from "zod";
import { changed, companyArg, rows, tool } from "./tool";

const COLUMNS = "id, name, category, description, unit, unit_price, unit_cost, taxable, formula, formula_target, active";

const fields = {
  name: z.string().trim().min(1).max(200),
  category: z.string().trim().max(100).nullable().optional(),
  description: z.string().trim().max(2000).nullable().optional(),
  unit: z.string().trim().min(1).max(20).describe('How it\'s sold: "ea", "hr", "sqft", "yd", "ton"...'),
  unit_price: z.number().min(0).max(10_000_000),
  unit_cost: z.number().min(0).max(10_000_000).nullable().optional().describe("What it costs the company, for job profit."),
  taxable: z.boolean(),
  formula: z
    .string()
    .trim()
    .max(500)
    .nullable()
    .optional()
    .describe(`Works out the quantity (or price) from a measurement, e.g. "area_sqyd * depth_in * 110 / 2000". It can use ${FORMULA_VARIABLES.join(", ")}.`),
  formula_target: z.enum(["quantity", "unit_price"]).describe("What the formula sets."),
  active: z.boolean().describe("Turned off, it's kept but not offered on new quotes."),
};

/** A formula that won't work, said plainly; empty means none. */
function checkFormula(name: string, formula: string | null | undefined) {
  if (!formula) return;
  try {
    validateFormula(formula);
  } catch (error) {
    throw new Error(`${name}: that formula doesn't work (${error instanceof Error ? error.message : "it doesn't parse"}). It can use ${FORMULA_VARIABLES.join(", ")}.`);
  }
}

export const priceTools = {
  list_services: tool({
    description: "The price list: services and products with unit, price, cost, tax and formula. Turned-off ones only with include_inactive.",
    input: z.object({ include_inactive: z.boolean().default(false), ...companyArg }),
    run: (ctx, a) => {
      let q = ctx.db.from("services").select(COLUMNS).eq("company_id", ctx.companyId);
      if (!a.include_inactive) q = q.eq("active", true);
      return rows(q.order("sort").order("name"));
    },
  }),
  add_services: tool({
    description: "Add services or products to the price list, up to 200 at once. Check list_services first so nothing is added twice.",
    input: z.object({
      items: z
        .array(
          z.object({
            ...fields,
            unit: fields.unit.default("ea"),
            unit_price: fields.unit_price.default(0),
            taxable: fields.taxable.default(true),
            formula_target: fields.formula_target.default("quantity"),
            active: fields.active.default(true),
          }),
        )
        .min(1)
        .max(200),
      ...companyArg,
    }),
    area: "prices",
    run: async (ctx, a) => {
      a.items.forEach((item) => checkFormula(item.name, item.formula));
      const { count } = await ctx.db.from("services").select("id", { count: "exact", head: true }).eq("company_id", ctx.companyId);
      const added = await rows(
        ctx.db
          .from("services")
          .insert(a.items.map((item, i) => ({ ...item, formula: item.formula || null, company_id: ctx.companyId, sort: (count ?? 0) + i + 1 })))
          .select("id, name"),
      );
      return { added };
    },
  }),
  update_service: tool({
    description: "Change a price list item: its name, price, cost, unit, tax, formula, category or description, or turn it off. Send only what changes.",
    input: z.object({
      service_id: z.uuid(),
      name: fields.name.optional(),
      category: fields.category,
      description: fields.description,
      unit: fields.unit.optional(),
      unit_price: fields.unit_price.optional(),
      unit_cost: fields.unit_cost,
      taxable: fields.taxable.optional(),
      formula: fields.formula,
      formula_target: fields.formula_target.optional(),
      active: fields.active.optional(),
      ...companyArg,
    }),
    area: "prices",
    run: async (ctx, { service_id, company_id: _, ...patch }) => {
      checkFormula(patch.name ?? "This item", patch.formula);
      if (patch.formula === "") patch.formula = null;
      await changed(ctx.db.from("services").update(patch).eq("id", service_id).eq("company_id", ctx.companyId).select("id"), "That price list item");
      return { saved: true };
    },
  }),
  delete_service: tool({
    description: "Delete a price list item. Quotes and invoices that used it keep their lines. To stop offering it but keep it, turn it off with update_service instead.",
    input: z.object({ service_id: z.uuid(), ...companyArg }),
    area: "prices",
    destructive: true,
    run: async (ctx, a) => {
      await changed(ctx.db.from("services").delete().eq("id", a.service_id).eq("company_id", ctx.companyId).select("id"), "That price list item");
      return { deleted: true };
    },
  }),
};
