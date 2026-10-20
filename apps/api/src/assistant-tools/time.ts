/**
 * Clocks and timesheets: time as the Timesheets screen and the crew app record it
 * (apps/web/src/features/timesheets, field/fieldData.ts), checked the same way
 * (packages/core/src/pay.ts). The database decides whose time the person can see and change (their
 * own; the office everyone's; a crew lead their crew's) and who may approve it ("Approve
 * timesheets", never your own as a crew lead). Time in a period marked paid is locked.
 */
import { addDays, entrySpan, localDate, localTime, mondayOf, timeEntryProblem, zonedTimeToUtc } from "@crewtavo/core";
import { z } from "zod";
import { changed, companyArg, friendly, one, rows, tool, type ToolContext } from "./tool";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use 24-hour HH:MM.");
const CATEGORIES = ["visit", "assessment", "drive", "shop", "break", "other"] as const;

/** When something happened: now, or a date and time in the company's zone. */
function momentOf(ctx: ToolContext, at?: { date?: string; time?: string }) {
  if (!at?.time) return new Date();
  return zonedTimeToUtc(at.date ?? localDate(new Date(), ctx.timezone), at.time, ctx.timezone);
}

/** Stop the person's running clocks at `at` (one started after it is left running). */
async function stopClocks(ctx: ToolContext, userId: string, at: Date) {
  const open = await rows(ctx.db.from("time_entries").select("id, started_at").eq("user_id", userId).eq("company_id", ctx.companyId).is("ended_at", null));
  let stopped = 0;
  for (const entry of open) {
    if (Date.parse(entry.started_at) >= at.getTime()) continue;
    const { error } = await ctx.db.from("time_entries").update({ ended_at: at.toISOString() }).eq("id", entry.id);
    if (error) throw new Error(friendly(error.message));
    stopped++;
  }
  return stopped;
}

export const timeTools = {
  list_time: tool({
    description: "Time entries from one date to another (default this week, Monday on), for everyone you can see or one person: who, when, how long, what it was (visit, drive, shop, break...), the visit or job, whether it's approved, and clocks still running.",
    input: z.object({ from: date.optional(), to: date.optional(), user_id: z.uuid().optional(), ...companyArg }),
    run: async (ctx, a) => {
      const today = localDate(new Date(), ctx.timezone);
      const from = a.from ?? mondayOf(today);
      const to = a.to ?? addDays(from, 6);
      let q = ctx.db
        .from("time_entries")
        .select("id, user_id, category, started_at, ended_at, notes, approved_at, auto_stopped_at, visit:visits(id, title), job:jobs(id, number, title)")
        .eq("company_id", ctx.companyId)
        .gte("started_at", zonedTimeToUtc(from, "00:00", ctx.timezone).toISOString())
        .lt("started_at", zonedTimeToUtc(addDays(to, 1), "00:00", ctx.timezone).toISOString());
      if (a.user_id) q = q.eq("user_id", a.user_id);
      const entries = await rows(q.order("started_at").limit(2000));
      const ids = [...new Set(entries.map((e) => e.user_id))];
      const profiles = ids.length ? await rows(ctx.db.from("profiles").select("user_id, full_name").in("user_id", ids)) : [];
      const names = new Map(profiles.map((p) => [p.user_id, p.full_name]));
      return {
        from,
        to,
        timezone: ctx.timezone,
        entries: entries.map((e) => ({
          ...e,
          name: names.get(e.user_id) ?? null,
          date: localDate(new Date(e.started_at), ctx.timezone),
          start_time: localTime(new Date(e.started_at), ctx.timezone),
          end_time: e.ended_at ? localTime(new Date(e.ended_at), ctx.timezone) : null,
          hours: e.ended_at ? Math.round(((Date.parse(e.ended_at) - Date.parse(e.started_at)) / 3_600_000) * 100) / 100 : null,
          running: !e.ended_at,
        })),
      };
    },
  }),
  clock_in: tool({
    description: "Start someone's clock (default yours) for a visit, an estimate visit, driving, shop time, a break or other work, now or at a time today. Whatever clock they had running stops then: only one runs at a time.",
    input: z.object({
      user_id: z.uuid().optional(),
      category: z.enum(CATEGORIES).default("visit"),
      visit_id: z.uuid().optional(),
      job_id: z.uuid().optional(),
      at: time.optional().describe("When they started, today (default now)."),
      notes: z.string().trim().max(500).optional(),
      ...companyArg,
    }),
    area: "time",
    run: async (ctx, a) => {
      const userId = a.user_id ?? ctx.userId;
      const at = momentOf(ctx, { time: a.at });
      if (at.getTime() > Date.now() + 60_000) throw new Error("You can't clock in for later. Add the time once it's worked.");
      const visit = a.visit_id ? await one(ctx.db.from("visits").select("id, job_id").eq("id", a.visit_id).eq("company_id", ctx.companyId).maybeSingle(), "That visit") : null;
      const stopped = await stopClocks(ctx, userId, at);
      const made = await one(
        ctx.db
          .from("time_entries")
          .insert({ company_id: ctx.companyId, user_id: userId, category: a.category, visit_id: visit?.id ?? null, job_id: visit?.job_id ?? a.job_id ?? null, started_at: at.toISOString(), notes: a.notes ?? null })
          .select("id")
          .single(),
        "The time entry",
      );
      return { entry_id: made.id, started_at: at.toISOString(), stopped_clocks: stopped };
    },
  }),
  clock_out: tool({
    description: "Stop someone's running clock (default yours), now or at a time today.",
    input: z.object({ user_id: z.uuid().optional(), at: time.optional().describe("When they stopped, today (default now)."), ...companyArg }),
    area: "time",
    run: async (ctx, a) => {
      const stopped = await stopClocks(ctx, a.user_id ?? ctx.userId, momentOf(ctx, { time: a.at }));
      return stopped ? { stopped_clocks: stopped } : { stopped_clocks: 0, note: "No clock was running." };
    },
  }),
  save_time_entry: tool({
    description: "Add time someone worked (no entry_id), or fix an entry (entry_id): the date, start and end times (an end before the start means past midnight), what it was, and the visit or job. Between a minute and 16 hours, not in the future, not over another of their entries. Time that's been approved or paid can only be changed by those allowed to.",
    input: z.object({
      entry_id: z.uuid().optional(),
      user_id: z.uuid().optional().describe("Default you (for a new entry)."),
      date,
      start_time: time,
      end_time: time,
      category: z.enum(CATEGORIES).default("other"),
      visit_id: z.uuid().nullable().optional(),
      job_id: z.uuid().nullable().optional(),
      notes: z.string().trim().max(500).nullable().optional(),
      ...companyArg,
    }),
    area: "time",
    run: async (ctx, a) => {
      const span = entrySpan(a.date, a.start_time, a.end_time, ctx.timezone);
      if (!span) throw new Error("Give the date and the start and end times.");
      const current = a.entry_id ? await one(ctx.db.from("time_entries").select("user_id").eq("id", a.entry_id).eq("company_id", ctx.companyId).maybeSingle(), "That time entry") : null;
      const userId = current?.user_id ?? a.user_id ?? ctx.userId;
      const nearby = await rows(
        ctx.db
          .from("time_entries")
          .select("id, started_at, ended_at")
          .eq("company_id", ctx.companyId)
          .eq("user_id", userId)
          .gte("started_at", new Date(span.startAt.getTime() - 24 * 3_600_000).toISOString())
          .lt("started_at", span.endAt.toISOString()),
      );
      const problem = timeEntryProblem(span, nearby.filter((e) => e.id !== a.entry_id));
      if (problem) throw new Error(problem);
      const visit = a.visit_id ? await one(ctx.db.from("visits").select("id, job_id").eq("id", a.visit_id).eq("company_id", ctx.companyId).maybeSingle(), "That visit") : null;
      const row = {
        started_at: span.startAt.toISOString(),
        ended_at: span.endAt.toISOString(),
        category: a.category,
        ...(a.visit_id !== undefined && { visit_id: visit?.id ?? null, job_id: visit?.job_id ?? a.job_id ?? null }),
        ...(a.visit_id === undefined && a.job_id !== undefined && { job_id: a.job_id }),
        ...(a.notes !== undefined && { notes: a.notes || null }),
      };
      if (a.entry_id) {
        // A fixed entry is no longer a guess.
        await changed(ctx.db.from("time_entries").update({ ...row, auto_stopped_at: null }).eq("id", a.entry_id).select("id"), "That time entry");
        return { entry_id: a.entry_id, saved: true };
      }
      const made = await one(ctx.db.from("time_entries").insert({ ...row, company_id: ctx.companyId, user_id: userId }).select("id").single(), "The time entry");
      return { entry_id: made.id, saved: true };
    },
  }),
  delete_time_entry: tool({
    description: "Delete a time entry. Approved time can only be deleted by the office; paid time not at all until its paid mark is taken back.",
    input: z.object({ entry_id: z.uuid(), ...companyArg }),
    area: "time",
    destructive: true,
    run: async (ctx, a) => {
      await changed(ctx.db.from("time_entries").delete().eq("id", a.entry_id).eq("company_id", ctx.companyId).select("id"), "That time entry");
      return { deleted: true };
    },
  }),
  approve_time: tool({
    description: "Approve finished time: these entries, or everyone's (or these people's) from one date to another. Running clocks are left. Needs \"Approve timesheets\"; a crew lead can't approve their own time. Approved time is costed at the person's pay rate then.",
    input: z.object({ entry_ids: z.array(z.uuid()).max(2000).optional(), user_ids: z.array(z.uuid()).max(200).optional(), from: date.optional(), to: date.optional(), ...companyArg }),
    area: "time",
    run: async (ctx, a) => {
      let q = ctx.db.from("time_entries").update({ approved_at: new Date().toISOString(), approved_by: ctx.userId }).eq("company_id", ctx.companyId).is("approved_at", null).not("ended_at", "is", null);
      if (a.entry_ids) q = q.in("id", a.entry_ids);
      else {
        if (!a.from || !a.to) throw new Error("Give entry_ids, or from and to dates.");
        q = q.gte("started_at", zonedTimeToUtc(a.from, "00:00", ctx.timezone).toISOString()).lt("started_at", zonedTimeToUtc(addDays(a.to, 1), "00:00", ctx.timezone).toISOString());
        if (a.user_ids) q = q.in("user_id", a.user_ids);
      }
      const { data, error } = await q.select("id");
      if (error) throw new Error(friendly(error.message));
      return { approved: data?.length ?? 0 };
    },
  }),
  unapprove_time: tool({
    description: "Take back the approval on these entries, so they can be changed. Not for time in a period marked paid.",
    input: z.object({ entry_ids: z.array(z.uuid()).min(1).max(2000), ...companyArg }),
    area: "time",
    run: async (ctx, a) => {
      const { data, error } = await ctx.db.from("time_entries").update({ approved_at: null, approved_by: null }).in("id", a.entry_ids).eq("company_id", ctx.companyId).select("id");
      if (error) throw new Error(friendly(error.message));
      return { unapproved: data?.length ?? 0 };
    },
  }),
};
