/**
 * Equipment at a property: the client's own water heater, AC unit or pool pump (property_assets),
 * with the visits that serviced it. Not the business's fleet. Saved the way the property cards save
 * it (apps/web/src/features/clients/PropertyEquipment.tsx), in the clients and properties area.
 */
import { localDate } from "@crewtavo/core";
import { z } from "zod";
import { changed, companyArg, one, rows, tool } from "./tool";

const optional = (max: number) => z.string().trim().max(max).nullable().optional();
const day = z.iso.date().nullable().optional();

const fields = {
  name: z.string().trim().min(1).max(120).optional().describe('What it is: "Water heater", "AC unit", "Pool pump".'),
  make: optional(80),
  model: optional(80),
  serial: optional(80).describe("Serial number."),
  installed_on: day.describe("When it was installed, YYYY-MM-DD."),
  warranty_until: day.describe("When its warranty ends, YYYY-MM-DD."),
  location: optional(120).describe('Where it is: "Basement", "Attic".'),
  notes: optional(4000),
  status: z.enum(["active", "retired"]).optional().describe("retired: removed or replaced, kept for its history."),
};

export const propertyEquipmentTools = {
  list_property_equipment: tool({
    description:
      "The equipment the client has at a property (water heater, AC unit, furnace, pool pump, electrical panel), with make, model, serial, install and warranty dates, and the visits that serviced each. Not the business's own trucks and tools.",
    input: z.object({ property_id: z.uuid(), include_retired: z.boolean().default(false), ...companyArg }),
    run: async (ctx, a) => {
      let q = ctx.db
        .from("property_assets")
        .select("id, name, make, model, serial, installed_on, warranty_until, location, notes, status, serviced:visit_assets(visit:visits(id, title, scheduled_on, completed_at, crew:crews(name)))")
        .eq("company_id", ctx.companyId)
        .eq("property_id", a.property_id);
      if (!a.include_retired) q = q.eq("status", "active");
      return (await rows(q.order("name"))).map(({ serviced, ...item }) => ({
        ...item,
        serviced: serviced
          .flatMap((s) => (s.visit ? [{ visit_id: s.visit.id, title: s.visit.title, date: s.visit.completed_at ? localDate(new Date(s.visit.completed_at), ctx.timezone) : s.visit.scheduled_on, crew: s.visit.crew?.name ?? null }] : []))
          .sort((x, y) => (y.date ?? "").localeCompare(x.date ?? "")),
      }));
    },
  }),
  save_property_equipment: tool({
    description: "Add equipment at a property (property_id and name), or change an item (equipment_id). Send only what changes; retire an item with status retired rather than deleting it.",
    input: z.object({ equipment_id: z.uuid().optional(), property_id: z.uuid().optional(), ...fields, ...companyArg }),
    area: "clients",
    run: async (ctx, { equipment_id, property_id, company_id: _, ...a }) => {
      const row = {
        ...(a.name !== undefined && { name: a.name }),
        ...(a.make !== undefined && { make: a.make || null }),
        ...(a.model !== undefined && { model: a.model || null }),
        ...(a.serial !== undefined && { serial: a.serial || null }),
        ...(a.installed_on !== undefined && { installed_on: a.installed_on }),
        ...(a.warranty_until !== undefined && { warranty_until: a.warranty_until }),
        ...(a.location !== undefined && { location: a.location || null }),
        ...(a.notes !== undefined && { notes: a.notes || null }),
        ...(a.status !== undefined && { status: a.status }),
      };
      if (equipment_id) {
        if (!Object.keys(row).length) throw new Error("Nothing to change: send at least one field.");
        await changed(ctx.db.from("property_assets").update(row).eq("id", equipment_id).eq("company_id", ctx.companyId).select("id"), "That equipment");
        return { equipment_id, saved: true };
      }
      if (!property_id || !a.name) throw new Error("New equipment needs the property_id and a name.");
      const made = await one(ctx.db.from("property_assets").insert({ ...row, company_id: ctx.companyId, property_id, name: a.name }).select("id").single(), "The equipment");
      return { equipment_id: made.id, saved: true };
    },
  }),
};
