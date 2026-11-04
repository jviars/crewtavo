/**
 * The business's own fields on clients, properties, jobs, quotes and invoices (Settings → Custom
 * fields). Assistants list them here, read their values in each record's tools (custom_fields, by
 * key) and set them through those tools' custom_fields, checked the way the screens check them
 * (packages/core/src/customFields.ts). The fields themselves are made in Crewtavo.
 */
import { CUSTOM_FIELD_RECORDS, customValues, mergeCustomValues, type CustomFieldRecord, type CustomValue } from "@crewtavo/core";
import { z } from "zod";
import { companyArg, one, rows, tool, type ToolContext } from "./tool";

const TABLES = { client: "clients", property: "properties", job: "jobs", quote: "quotes", invoice: "invoices" } as const;

/** The custom_fields input of a tool that makes or changes a record. */
export const customFieldsArg = {
  custom_fields: z
    .record(z.string().max(60), z.union([z.string().max(1000), z.number(), z.boolean(), z.null()]))
    .optional()
    .describe("Its custom fields (list_custom_fields), by key: a value for each to set (a date as YYYY-MM-DD, yes/no as true or false), null to clear one. Fields left out stay as they are."),
};

/** A record's values for an answer, by key: never the import's source_id (the tools give it on its own). */
export function fieldValues(raw: unknown): Record<string, unknown> {
  const { source_id: _, ...values } = customValues(raw);
  return values;
}

/**
 * The record's custom_fields with `changes` made, checked against the business's fields; nothing
 * when there are none. `from` is its values now (a new record's), or its id to read them.
 */
export async function customFieldsPatch(ctx: ToolContext, record: CustomFieldRecord, from: { id: string } | { values: unknown }, changes: Record<string, unknown> | undefined): Promise<{ custom_fields?: Record<string, CustomValue> }> {
  if (!changes || !Object.keys(changes).length) return {};
  let values = "values" in from ? from.values : null;
  if ("id" in from) {
    // Every one of these tables has custom_fields; the client's shape stands in for them all.
    const table = TABLES[record] as "clients";
    values = (await one(ctx.db.from(table).select("custom_fields").eq("id", from.id).eq("company_id", ctx.companyId).maybeSingle(), "That record")).custom_fields;
  }
  const fields = await rows(ctx.db.from("custom_field_definitions").select("key, label, type, choices, archived_at").eq("company_id", ctx.companyId).eq("record_type", record));
  const merged = mergeCustomValues(fields, values, changes);
  if (merged.errors.length) throw new Error(merged.errors.join(" "));
  return { custom_fields: merged.values };
}

export const customFieldTools = {
  list_custom_fields: tool({
    description:
      "The business's own fields on clients, properties, jobs, quotes and invoices, like a gate code or a permit number: each one's key, name, type (text, number, date, choice or yes_no), choices, and whether it prints on the PDF or shows on the Client Hub. Read and set values with each record's tools, by key (custom_fields). An archived field keeps its values out of sight and can't be set.",
    input: z.object({ record_type: z.enum(CUSTOM_FIELD_RECORDS).optional(), include_archived: z.boolean().default(false), ...companyArg }),
    run: async (ctx, a) => {
      let q = ctx.db.from("custom_field_definitions").select("key, record_type, label, type, choices, show_on_pdf, show_in_portal, archived_at").eq("company_id", ctx.companyId);
      if (a.record_type) q = q.eq("record_type", a.record_type);
      if (!a.include_archived) q = q.is("archived_at", null);
      return rows(q.order("record_type").order("sort"));
    },
  }),
};
