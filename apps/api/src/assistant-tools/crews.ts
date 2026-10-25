/** Crews (Settings → Crews): who's on which crew. The team itself is in team.ts. */
import { ROLE_LABELS, type Role } from "@crewtavo/core";
import { z } from "zod";
import { changed, companyArg, friendly, one, rows, tool, type ToolContext } from "./tool";

// The crew screen's colors, given in turn to new crews.
const PALETTE = ["#3b7d23", "#3474d4", "#c9852a", "#d2445c", "#8b5cf6", "#0e7490", "#57534e", "#b45309"];

async function team(ctx: ToolContext) {
  // The team: a sub is never on a crew.
  const members = await rows(ctx.db.from("memberships").select("user_id, role").eq("company_id", ctx.companyId).eq("active", true).neq("role", "subcontractor"));
  const profiles = members.length ? await rows(ctx.db.from("profiles").select("user_id, full_name, email").in("user_id", members.map((m) => m.user_id))) : [];
  const byId = new Map(profiles.map((p) => [p.user_id, p]));
  return members.map((m) => ({ user_id: m.user_id, name: byId.get(m.user_id)?.full_name ?? null, email: byId.get(m.user_id)?.email ?? null, role: ROLE_LABELS[m.role as Role] ?? m.role }));
}

export const crewTools = {
  list_crews: tool({
    description: "The company's crews, with their color, whether they're in use, and who's on each.",
    input: z.object({ ...companyArg }),
    run: async (ctx) => {
      const [crews, people] = await Promise.all([
        rows(ctx.db.from("crews").select("id, name, color, active, crew_members(user_id)").eq("company_id", ctx.companyId).order("name")),
        team(ctx),
      ]);
      const names = new Map(people.map((p) => [p.user_id, p.name]));
      return crews.map(({ crew_members, ...crew }) => ({ ...crew, members: (crew_members as Array<{ user_id: string }>).map((m) => ({ user_id: m.user_id, name: names.get(m.user_id) ?? null })) }));
    },
  }),
  save_crew: tool({
    description: "Add a crew (no crew_id), or rename one, change its color, or turn it off (with crew_id). Put people on it with set_crew_members.",
    input: z.object({
      crew_id: z.uuid().optional(),
      name: z.string().trim().min(1).max(80).optional(),
      color: z.string().regex(/^#[0-9a-f]{6}$/i, "Use a hex color like #3b7d23.").optional(),
      active: z.boolean().optional().describe("A crew that's turned off isn't offered on the schedule."),
      ...companyArg,
    }),
    area: "crews",
    run: async (ctx, { crew_id, company_id: _, ...patch }) => {
      if (crew_id) {
        await changed(ctx.db.from("crews").update(patch).eq("id", crew_id).eq("company_id", ctx.companyId).select("id"), "That crew");
        return { crew_id, saved: true };
      }
      if (!patch.name) throw new Error("Name the crew.");
      const { count } = await ctx.db.from("crews").select("id", { count: "exact", head: true }).eq("company_id", ctx.companyId);
      const crew = await one(
        ctx.db
          .from("crews")
          .insert({ company_id: ctx.companyId, name: patch.name, color: patch.color ?? PALETTE[(count ?? 0) % PALETTE.length], active: patch.active ?? true })
          .select("id")
          .single(),
        "The crew",
      );
      return { crew_id: crew.id, saved: true };
    },
  }),
  set_crew_members: tool({
    description: "Set who's on a crew: give everyone who should be on it (user_ids from list_team). Anyone left out comes off it.",
    input: z.object({ crew_id: z.uuid(), user_ids: z.array(z.uuid()).max(100), ...companyArg }),
    area: "crews",
    run: async (ctx, a) => {
      const people = new Set((await team(ctx)).map((p) => p.user_id));
      const strangers = a.user_ids.filter((id) => !people.has(id));
      if (strangers.length) throw new Error(`Not on the team: ${strangers.join(", ")}. Use user_ids from list_team.`);
      const crew = await one(ctx.db.from("crews").select("id, crew_members(user_id)").eq("id", a.crew_id).eq("company_id", ctx.companyId).maybeSingle(), "That crew");
      const now = new Set((crew.crew_members as Array<{ user_id: string }>).map((m) => m.user_id));
      const wanted = new Set(a.user_ids);
      const adding = [...wanted].filter((id) => !now.has(id));
      const removing = [...now].filter((id) => !wanted.has(id));
      if (adding.length) {
        const { error } = await ctx.db.from("crew_members").insert(adding.map((user_id) => ({ company_id: ctx.companyId, crew_id: a.crew_id, user_id })));
        if (error) throw new Error(friendly(error.message));
      }
      if (removing.length) {
        const { error } = await ctx.db.from("crew_members").delete().eq("crew_id", a.crew_id).in("user_id", removing);
        if (error) throw new Error(friendly(error.message));
      }
      return { added: adding.length, removed: removing.length };
    },
  }),
  delete_crew: tool({
    description: "Delete a crew. Its visits stay on the schedule without a crew. To stop using it but keep it, turn it off with save_crew instead.",
    input: z.object({ crew_id: z.uuid(), ...companyArg }),
    area: "crews",
    destructive: true,
    run: async (ctx, a) => {
      await changed(ctx.db.from("crews").delete().eq("id", a.crew_id).eq("company_id", ctx.companyId).select("id"), "That crew");
      return { deleted: true };
    },
  }),
};
