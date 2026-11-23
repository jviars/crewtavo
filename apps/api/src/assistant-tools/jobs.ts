/**
 * Jobs and recurring services: made and changed the way the job screens make them
 * (apps/web/src/features/jobs/JobDialogs.tsx), with services from the price list as their lines,
 * and a recurring job's upcoming visits made right away (services/schedule.ts generateVisits).
 * Also importing a whole schedule from another system: repeating series, one-time jobs and tasks;
 * extra work on one visit of a repeating job (visit_extras: billed once with that visit, by the
 * database's rules); and changing prices across repeating jobs, previewed first and applied only as
 * previewed (price_change_preview, apply_price_change), the way the Jobs page does it.
 *
 * What a job charges is money, as the price list is: its lines, how it's priced and billed, extra
 * work and price changes need the Prices area ("Full access, no money" leaves them out), whatever
 * else the assistant may change about jobs. Lines and extra work feed invoices and autopay charges.
 */
import {
  billingText, buildSimpleRule, describeRule, extraState, extraStateText, localDate, normalizeKey, occurrenceDates, parseRule, priceChangeGroups, priceChangeTotals, ruleDay, sameStreet,
  VISIT_HORIZON_DAYS, zonedTimeToUtc, type PriceChange, type PriceChangePreview,
} from "@crewtavo/core";
import { z } from "zod";
import { createVisits, generateVisits } from "../services/schedule";
import { customFieldsArg, customFieldsPatch } from "./customFields";
import { areaAllows, changed, companyArg, friendly, one, requireArea, rows, scopeOf, tool, type ToolContext } from "./tool";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");
const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use 24-hour HH:MM.");
const WEEKDAYS = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;

const WEEKS = { first: 1, second: 2, third: 3, fourth: 4, last: -1 } as const;

export const repeatInput = z
  .object({
    every_days: z.number().int().min(1).max(52).optional().describe("Every N days instead."),
    every_weeks: z.number().int().min(1).max(52).optional().describe("Weekly every N weeks (2 = every other week)."),
    on_days: z.array(z.enum(WEEKDAYS)).max(7).optional().describe("For weekly: the days, default the first date's weekday."),
    every_months: z.number().int().min(1).max(12).optional().describe("Monthly every N months instead."),
    on_day_of_month: z.number().int().min(1).max(28).optional().describe("For monthly: the day, default the first date's (up to 28)."),
    on_weekday: z
      .object({ week: z.enum(["first", "second", "third", "fourth", "last"]), day: z.enum(WEEKDAYS) })
      .optional()
      .describe("For monthly: a weekday in the month instead of a date, e.g. {week: \"last\", day: \"FR\"} for the last Friday."),
    times: z.number().int().min(1).max(500).optional().describe("Ends after this many visits, counted from the first date (ones already done count too), instead of ends_on. Not with rule."),
    rule: z.string().max(300).optional().describe("Or an RRULE without DTSTART, e.g. FREQ=WEEKLY;INTERVAL=2;BYDAY=TU;UNTIL=20261031."),
  })
  .describe("How often it repeats. Give every_days, every_weeks (with on_days), every_months (with on_day_of_month or on_weekday), or a rule.");

/** The job's RRULE from the repeat given and its first date. */
export function repeatRule(r: z.infer<typeof repeatInput>, firstDate: string): string {
  if (r.rule) return parseRule(r.rule);
  const count = r.times ?? null;
  if (r.every_days) return buildSimpleRule({ freq: "DAILY", interval: r.every_days, days: [], monthDay: 1, count });
  if (r.every_months) {
    const weekday = r.on_weekday ? { week: WEEKS[r.on_weekday.week], day: r.on_weekday.day } : null;
    return buildSimpleRule({ freq: "MONTHLY", interval: r.every_months, days: [], monthDay: r.on_day_of_month ?? Math.min(28, Number(firstDate.slice(8, 10))), weekday, count });
  }
  return buildSimpleRule({ freq: "WEEKLY", interval: r.every_weeks ?? 1, days: r.on_days?.length ? [...r.on_days] : [ruleDay(firstDate)], monthDay: 1, count });
}

const lineInput = z.object({
  service_id: z.uuid().optional().describe("A price list item (list_services): its name, unit, price and tax come with it."),
  name: z.string().trim().min(1).max(200).optional().describe("For a line that isn't on the price list."),
  description: z.string().trim().max(2000).nullable().optional(),
  quantity: z.number().min(0).max(1e6).default(1),
  unit_price: z.number().min(0).max(1e7).optional().describe("Overrides the price list's price."),
  unit: z.string().trim().min(1).max(20).optional(),
  taxable: z.boolean().optional(),
});

/** A change of prices across repeating jobs, as the tools take it (core PriceChange is what the database is asked). */
const priceChangeInput = {
  kind: z.enum(["percent", "amount"]).describe("percent: by a percentage. amount: by an amount added to (or taken off) each line's price."),
  value: z.number().min(-100000).max(100000).refine((v) => v !== 0, "Give a change that isn't zero.").describe("Above 0 raises prices, below lowers them: 5 with percent is up 5%, -2 with amount is $2 off each line."),
  round: z.enum(["cent", "half", "dollar"]).default("cent").describe("Round each new price to the cent, to 50 cents or to the dollar."),
  line_service_id: z.uuid().optional().describe("Only this price list item's lines (list_services). Without it, every priced line."),
  with_service_id: z.uuid().optional().describe("Only jobs that have a line for this price list item."),
  client_tag: z.string().trim().min(1).max(100).optional().describe("Only jobs of clients with this tag."),
  crew_id: z.uuid().optional().describe("Only jobs whose usual crew is this one."),
  job_ids: z.array(z.uuid()).max(2000).optional().describe("Only these jobs."),
};
const priceChangeOfArgs = (a: { kind: "percent" | "amount"; value: number; round: "cent" | "half" | "dollar"; line_service_id?: string; with_service_id?: string; client_tag?: string; crew_id?: string; job_ids?: string[] }): PriceChange => ({
  kind: a.kind,
  value: a.value,
  round: a.round,
  ...(a.line_service_id && { line_service_id: a.line_service_id }),
  ...((a.with_service_id || a.client_tag || a.crew_id || a.job_ids) && {
    jobs: { ...(a.with_service_id && { service_id: a.with_service_id }), ...(a.client_tag && { client_tag: a.client_tag }), ...(a.crew_id && { crew_id: a.crew_id }), ...(a.job_ids && { job_ids: a.job_ids }) },
  }),
});

/** What a change would do, from the database (nothing is changed). */
async function previewPrices(ctx: ToolContext, change: PriceChange): Promise<PriceChangePreview> {
  const { data, error } = await ctx.db.rpc("price_change_preview", { p_company: ctx.companyId, p_change: change as never });
  if (error) throw new Error(friendly(error.message));
  return data as unknown as PriceChangePreview;
}

/**
 * Refuses a job's lines, or how it's priced and billed, to an assistant that may not change prices.
 * `replacing`: lines given replace the job's (update_job), so even none is a change.
 */
function requirePrices(ctx: ToolContext, a: { lines?: readonly unknown[]; billing_mode?: unknown; pricing?: unknown; invoice_schedule?: unknown; invoice_day?: unknown }, replacing = false) {
  const lines = replacing ? a.lines !== undefined : Boolean(a.lines?.length);
  if (lines || [a.billing_mode, a.pricing, a.invoice_schedule, a.invoice_day].some((v) => v !== undefined)) requireArea(ctx, "prices");
}

/** A job's extra work on single visits, each with its visit's day and where it stands (core extraState). */
async function extraWork(ctx: ToolContext, filter: { job_id?: string; visit_id?: string }) {
  let q = ctx.db
    .from("visit_extras")
    .select("id, job_id, visit_id, service_id, name, description, quantity, unit, unit_price, taxable, invoice_id, visit_was_on, added_in_field_at, visit:visits(id, status, scheduled_on, invoice_id), invoice:invoices(number, status)")
    .eq("company_id", ctx.companyId);
  if (filter.visit_id) q = q.eq("visit_id", filter.visit_id);
  if (filter.job_id) q = q.eq("job_id", filter.job_id);
  const { data, error } = await q.order("created_at").limit(500);
  if (error) return null;
  return (data ?? []).map(({ visit, invoice, ...e }) => ({
    ...e,
    visit_date: visit?.scheduled_on ?? e.visit_was_on,
    added_by_crew: Boolean(e.added_in_field_at),
    state: extraStateText(extraState(e, visit), invoice?.number),
  }));
}

/** Price lines for a job, from the price list where they name an item. */
async function jobLines(ctx: ToolContext, jobId: string, lines: ReadonlyArray<z.infer<typeof lineInput>>) {
  const ids = [...new Set(lines.flatMap((l) => (l.service_id ? [l.service_id] : [])))];
  const services = ids.length ? await rows(ctx.db.from("services").select("id, name, description, unit, unit_price, taxable").in("id", ids).eq("company_id", ctx.companyId)) : [];
  const byId = new Map(services.map((s) => [s.id, s]));
  return lines.map((l, i) => {
    const s = l.service_id ? byId.get(l.service_id) : undefined;
    if (l.service_id && !s) throw new Error(`Line ${i + 1}: that price list item isn't in this company's price list.`);
    if (!s && (!l.name || l.unit_price === undefined)) throw new Error(`Line ${i + 1}: give a service_id from the price list, or a name and unit_price.`);
    return {
      company_id: ctx.companyId,
      job_id: jobId,
      service_id: s?.id ?? null,
      name: l.name ?? s!.name,
      description: l.description !== undefined ? l.description : (s?.description ?? null),
      quantity: l.quantity,
      unit: l.unit ?? s?.unit ?? "ea",
      unit_price: l.unit_price ?? Number(s!.unit_price),
      taxable: l.taxable ?? s?.taxable ?? true,
      sort: i + 1,
    };
  });
}

/** The client's property: the one given, or their only one. */
async function propertyFor(ctx: ToolContext, clientId: string, propertyId?: string | null): Promise<string | null> {
  if (propertyId) return propertyId;
  const props = await rows(ctx.db.from("properties").select("id").eq("client_id", clientId).eq("company_id", ctx.companyId).limit(2));
  return props.length === 1 ? props[0].id : null;
}

/** After a recurring job is saved: its upcoming visits, when this assistant may change the schedule and the person's role schedules the whole team. */
async function scheduleJob(ctx: ToolContext, jobId: string, upcoming = false): Promise<{ visits_created: number; visits_changed?: number; note?: string }> {
  if (!areaAllows(ctx, "schedule")) return { visits_created: 0, note: "Its visits weren't scheduled: this assistant can't change the schedule. Allow Schedule in Settings → AI assistants, then save the job again." };
  try {
    const result = await generateVisits(scopeOf(ctx), ctx.env, jobId, upcoming);
    return { visits_created: result.created, ...(upcoming && { visits_changed: result.updated }) };
  } catch (error) {
    return { visits_created: 0, note: `Its visits weren't scheduled: ${error instanceof Error ? error.message : "it didn't work"}` };
  }
}

const jobFields = {
  title: z.string().trim().min(1).max(200),
  instructions: z.string().trim().max(5000).nullable().optional().describe("Notes for the crew on every visit. Plain text shown with light formatting: start a line with \"- \" for a list item or \"# \" for a heading, and **bold** what matters. Short lines, not one long paragraph."),
  repeat: repeatInput.optional().describe("Makes it a recurring job: how often it repeats."),
  first_date: date.optional().describe("A recurring job's first visit date (default today)."),
  ends_on: date.nullable().optional().describe("Last date it repeats; leave out to keep going."),
  season_months: z.array(z.number().int().min(1).max(12)).max(12).nullable().optional().describe("Only these months, e.g. [4,5,6,7,8,9,10] for April to October."),
  start_time: time.nullable().optional().describe("Each visit's start time, in the company's time zone; leave out for anytime visits."),
  duration_min: z.number().int().min(1).max(1440).optional().describe("How long each visit takes (default 60)."),
  crew_id: z.uuid().nullable().optional().describe("The crew it's usually done by (list_crews)."),
  billing_mode: z.enum(["per_visit", "on_completion", "progress"]).optional().describe("A one-off job: on_completion (the default) or progress. A recurring job is per_visit unless pricing and invoice_schedule say otherwise."),
  pricing: z.enum(["per_visit", "fixed"]).optional().describe("A recurring job: how it's priced. per_visit, or fixed: its lines are the price of each invoice, however many visits."),
  invoice_schedule: z
    .enum(["after_visit", "monthly", "as_needed"])
    .optional()
    .describe("A recurring job: when it's invoiced. after_visit; monthly (on invoice_day the office is reminded to invoice the month, and a fixed-price plan on autopay is charged); as_needed (no reminders). A fixed price is monthly or as_needed."),
  invoice_day: z.number().int().min(1).max(28).nullable().optional().describe("For monthly: the day of the month it's invoiced, 1 to 28; null for the last day of the month (the default)."),
  lines: z.array(lineInput).max(50).optional().describe("What it includes, with prices: price list items or custom lines."),
  ...customFieldsArg,
};

/** A recurring job's visits are made this far ahead (the same year the nightly task keeps). */
const VISIT_DATES_AHEAD = VISIT_HORIZON_DAYS;

export const jobTools = {
  list_jobs: tool({
    description:
      "Jobs, newest first, with client, property, how they repeat, their usual crew and job_state (an active job's late, today, upcoming or unscheduled, from its visits, paused while a recurring job is paused, or requires_invoicing while a monthly job's month waits for its invoice; another job's status), and how it's billed. Filter by status (default active, which includes paused jobs) or one of those states, kind and client.",
    input: z.object({
      status: z.enum(["all", "active", "late", "today", "upcoming", "unscheduled", "paused", "requires_invoicing", "completed", "archived"]).default("active"),
      kind: z.enum(["all", "one_off", "recurring"]).default("all"),
      client_id: z.uuid().optional(),
      limit: z.number().int().min(1).max(200).default(50),
      offset: z.number().int().min(0).default(0),
      ...companyArg,
    }),
    run: async (ctx, a) => {
      let q = ctx.db
        .from("jobs")
        .select("id, number, title, kind, status, job_state, recurrence_rule, starts_on, ends_on, active_months, paused_at, resume_on, visit_start_time, visit_duration_min, billing_mode, pricing, invoice_schedule, invoice_day, client:clients(id, display_name), property:properties(id, line1, city), crew:crews(id, name)", { count: "exact" })
        .eq("company_id", ctx.companyId);
      // job_state is the status for any job that isn't active, so every filter but active can use it.
      if (a.status === "active") q = q.eq("status", "active");
      else if (a.status !== "all") q = q.eq("job_state", a.status);
      if (a.kind !== "all") q = q.eq("kind", a.kind);
      if (a.client_id) q = q.eq("client_id", a.client_id);
      const { data, error, count } = await q.order("created_at", { ascending: false }).range(a.offset, a.offset + a.limit - 1);
      if (error) throw new Error(friendly(error.message));
      const jobs = (data ?? []).map((j) => ({ ...j, repeats: j.recurrence_rule ? describeRule(j.recurrence_rule) : null, billing: billingText(j) }));
      const next = a.offset + jobs.length;
      return { total: count ?? jobs.length, jobs, next_offset: count !== null && next < count ? next : null };
    },
  }),
  get_job: tool({
    description: "A job in full: client, property, how it repeats, job_state (as in list_jobs) and when a paused one resumes (resume_on), its custom_fields (by key, list_custom_fields), its lines and prices (if your role sees them), and its next visits.",
    input: z.object({ job_id: z.uuid(), ...companyArg }),
    run: async (ctx, a) => {
      const job = await one(
        ctx.db
          .from("jobs")
          .select("id, number, title, kind, status, job_state, instructions, recurrence_rule, starts_on, ends_on, active_months, paused_at, resume_on, visit_start_time, visit_duration_min, billing_mode, pricing, invoice_schedule, invoice_day, default_crew_id, custom_fields, client:clients(id, display_name), property:properties(id, line1, city, region, postal_code)")
          .eq("id", a.job_id)
          .eq("company_id", ctx.companyId)
          .maybeSingle(),
        "That job",
      );
      const [lines, visits, due] = await Promise.all([
        ctx.db.from("job_line_items").select("id, service_id, name, description, quantity, unit, unit_price, taxable").eq("job_id", a.job_id).order("sort"),
        rows(ctx.db.from("visits").select("id, title, status, scheduled_on, starts_at, ends_at, crew_id").eq("job_id", a.job_id).gte("scheduled_on", localDate(new Date(), ctx.timezone)).order("scheduled_on").limit(10)),
        // The months a monthly job still has to invoice (only for a role that sees invoices).
        ctx.db.from("due_invoices").select("month, period_start, period_end").eq("job_id", a.job_id).order("month"),
      ]);
      return {
        job: { ...job, repeats: job.recurrence_rule ? describeRule(job.recurrence_rule) : null, billing: billingText(job), months_to_invoice: due.data ?? [] },
        lines: lines.error ? "Your role doesn't see prices." : lines.data,
        // Extra work on single visits of a repeating job: billed once with its visit, never part of the job's price.
        ...(job.kind === "recurring" && { extra_work: (await extraWork(ctx, { job_id: a.job_id })) ?? [] }),
        next_visits: visits,
      };
    },
  }),
  list_extra_work: tool({
    description:
      "Extra work on single visits of a repeating job (mulch, an aeration, a storm cleanup): what, how many, its price, the visit's date, whether the crew added it on site, and where it stands (billed when the visit is done, ready to invoice, on an invoice, or not billed because its visit was cancelled or removed). It's billed once, on the invoice that bills its visit, and doesn't change the job's price. Give a job or one visit. Only for a role that sees prices.",
    input: z.object({ job_id: z.uuid().optional(), visit_id: z.uuid().optional(), ...companyArg }),
    run: async (ctx, a) => {
      if (!a.job_id && !a.visit_id) throw new Error("Give a job_id or a visit_id.");
      const extras = await extraWork(ctx, a);
      if (!extras) throw new Error("Your role doesn't see prices.");
      return { extra_work: extras };
    },
  }),
  add_extra_work: tool({
    description:
      "Put extra work on one visit of a repeating job: an item from the price list (service_id) or a typed line (name and unit_price), and how many. It's billed once, on the invoice that bills that visit, once the visit is done, and doesn't change the job's price or repeat on other visits. On an autopay job its invoice waits for the office's OK before the card is charged. Not on a one-off job (add a line with update_job), a cancelled visit, or a visit already on an invoice. To move one to another visit of the same job, give extra_id and the new visit_id. It's a price, so it needs the Prices area.",
    input: z.object({
      visit_id: z.uuid().describe("The visit it's done on (get_job's next_visits, or get_schedule)."),
      extra_id: z.uuid().optional().describe("An extra already there, to move it to this visit instead of adding one."),
      service_id: z.uuid().optional().describe("A price list item (list_services): its name, unit, price and tax come with it."),
      name: z.string().trim().min(1).max(200).optional().describe("For work that isn't on the price list."),
      description: z.string().trim().max(2000).nullable().optional(),
      quantity: z.number().gt(0).max(100000).default(1),
      unit_price: z.number().min(0).max(1e7).optional().describe("Overrides the price list's price."),
      unit: z.string().trim().min(1).max(20).optional(),
      taxable: z.boolean().optional(),
      ...companyArg,
    }),
    area: "prices",
    run: async (ctx, a) => {
      if (a.extra_id) {
        await changed(ctx.db.from("visit_extras").update({ visit_id: a.visit_id }).eq("id", a.extra_id).eq("company_id", ctx.companyId).select("id"), "That extra work");
        return { moved: true, extra_work: await extraWork(ctx, { visit_id: a.visit_id }) };
      }
      const visit = await one(ctx.db.from("visits").select("id, job_id").eq("id", a.visit_id).eq("company_id", ctx.companyId).maybeSingle(), "That visit");
      if (!visit.job_id) throw new Error("Extra work goes on a visit for a job.");
      const [line] = await jobLines(ctx, visit.job_id, [a]);
      const { sort: _sort, ...row } = line!;
      const added = await one(ctx.db.from("visit_extras").insert({ ...row, visit_id: a.visit_id }).select("id").single(), "That visit");
      return { added: true, id: added.id, extra_work: await extraWork(ctx, { visit_id: a.visit_id }) };
    },
  }),
  delete_extra_work: tool({
    description: "Remove extra work from a visit. Not once it's on an invoice: change the invoice instead (edit_invoice), or void it.",
    input: z.object({ extra_id: z.uuid(), ...companyArg }),
    area: "prices",
    destructive: true,
    run: async (ctx, a) => {
      await changed(ctx.db.from("visit_extras").delete().eq("id", a.extra_id).eq("company_id", ctx.companyId).select("id"), "That extra work");
      return { deleted: true };
    },
  }),
  preview_price_change: tool({
    description:
      "What changing prices across repeating jobs would do, with nothing changed: each active repeating job it reaches, each line's old and new price, the job's old and new price for a visit (or a month, for a fixed price), totals, and for jobs on autopay whether the new price is over the company's autopay limit (those charges would wait for the office's OK; clients aren't asked to agree again). Lines at $0, discounts, one-off jobs and extra work on single visits are never changed. Always show the person this before change_prices. For owners, admins and the office with Quotes and sales.",
    input: z.object({ ...priceChangeInput, limit: z.number().int().min(1).max(500).default(100).describe("How many jobs to list; the totals count them all."), ...companyArg }),
    run: async (ctx, a) => {
      const preview = await previewPrices(ctx, priceChangeOfArgs(a));
      return { ...preview, jobs: preview.jobs.slice(0, a.limit), jobs_not_listed: Math.max(0, preview.jobs.length - a.limit) };
    },
  }),
  change_prices: tool({
    description:
      "Change prices across repeating jobs, exactly as preview_price_change showed. Give the same change, and expect: the jobs, lines and new_price from that preview's totals. If the preview would come out differently now, nothing is changed and you're told to preview again. It changes the jobs' lines from now on: invoices already made keep their prices, and nothing is sent to clients. Each job's activity records its old and new prices. It can be undone with undo_price_change until one of the jobs is invoiced. Only after the person has seen the preview and said yes.",
    input: z.object({
      ...priceChangeInput,
      expect: z.object({ jobs: z.number().int().min(1), lines: z.number().int().min(1), new_price: z.number() }).describe("The totals of the preview the person agreed to: jobs, lines and new_price."),
      ...companyArg,
    }),
    area: "prices",
    run: async (ctx, a) => {
      const change = priceChangeOfArgs(a);
      const preview = await previewPrices(ctx, change);
      const totals = priceChangeTotals(preview.jobs);
      if (totals.jobs !== a.expect.jobs || totals.lines !== a.expect.lines || Math.abs(totals.new_price - a.expect.new_price) > 0.005) {
        throw new Error(`That isn't what the change would do now (${totals.jobs} jobs, ${totals.lines} lines, new prices come to ${totals.new_price.toFixed(2)}). Preview it again and show the person before changing anything.`);
      }
      // A group of whole jobs a call, each one transaction, all under one id so the change is one to undo.
      const id = crypto.randomUUID();
      let jobs = 0;
      for (const group of priceChangeGroups(preview.jobs)) {
        const { error } = await ctx.db.rpc("apply_price_change", { p_company: ctx.companyId, p_id: id, p_change: change as never, p_lines: group.lines as never });
        if (error) throw new Error(jobs ? `Prices changed on ${jobs} of ${totals.jobs} jobs. The rest weren't changed: ${friendly(error.message)}` : friendly(error.message));
        jobs += group.jobs;
      }
      return { changed: true, price_change_id: id, summary: preview.summary, jobs, lines: totals.lines, old_price: totals.old_price, new_price: totals.new_price };
    },
  }),
  undo_price_change: tool({
    description:
      "Undo a whole price change (change_prices, or Change prices on the Jobs page): every line it changed goes back to its old price, except lines someone has changed since. Refused once an invoice has been made for one of its jobs since. Without price_change_id it lists the latest changes, with which can still be undone.",
    input: z.object({ price_change_id: z.uuid().optional(), ...companyArg }),
    area: "prices",
    run: async (ctx, a) => {
      if (!a.price_change_id) {
        const { data, error } = await ctx.db.rpc("price_change_history", { p_company: ctx.companyId });
        if (error) throw new Error(friendly(error.message));
        return { price_changes: data };
      }
      const { data, error } = await ctx.db.rpc("undo_price_change", { p_company: ctx.companyId, p_id: a.price_change_id });
      if (error) throw new Error(friendly(error.message));
      return { undone: true, ...(data as { restored: number; left: number }) };
    },
  }),
  create_job: tool({
    description:
      "Make a job for a client: one-off work, or a recurring service (give repeat). Its lines come from the price list or are custom. A recurring job's visits for the next year are scheduled right away (needs the Schedule area); a one-off job's visit can be scheduled with visit. Lines and billing are prices: they need the Prices area too. A lead becomes an active client.",
    input: z.object({
      client_id: z.uuid(),
      property_id: z.uuid().optional().describe("Default: the client's only property."),
      ...jobFields,
      visit: z
        .object({ date, start_time: time.optional(), duration_min: z.number().int().min(1).max(1440).optional(), crew_id: z.uuid().optional() })
        .optional()
        .describe("For a one-off job: schedule its visit."),
      ...companyArg,
    }),
    area: "jobs",
    run: (ctx, a) => createJob(ctx, a),
  }),
  update_job: tool({
    description:
      "Change a job: its title, instructions, crew, visit time and length, billing (a recurring job's pricing and invoice_schedule), how it repeats, first or last date, season, custom fields, or its lines (lines replaces them all, apart from a promo code's discount, which stays). Set ends_on (or repeat.times) to stop a recurring job, status archived to put it away: archiving or closing (completed) a recurring job takes the upcoming visits its schedule made off the schedule, unless work is logged on them, and setting it active again makes them again. A one-off job moves to requires_invoicing by itself when its last visit is finished. paused pauses a recurring job (a vacation, the off season) until resume_on, or until paused is set false: its upcoming visits that haven't started come off, and no new visits, monthly invoices or plan charges are made while it's paused; resuming makes its visits again from today. Work you mark done (requires_invoicing) on a job charged automatically (autopay) waits for the office to approve its charge. A recurring job's new visits follow the change; the ones already on the schedule change too (title, crew, time) only with upcoming_visits, so ask the person whether they want that. Lines and billing are prices: they need the Prices area too.",
    input: z.object({
      job_id: z.uuid(),
      ...jobFields,
      title: z.string().trim().min(1).max(200).optional(),
      status: z.enum(["active", "requires_invoicing", "completed", "archived"]).optional(),
      upcoming_visits: z.boolean().optional().describe("A recurring job: also give the visits already on the schedule the new title, crew and time. Done or started visits stay as they were."),
      paused: z.boolean().optional().describe("A recurring job: true pauses it, false resumes it."),
      resume_on: date.nullable().optional().describe("With paused true (or for a job already paused): the day it resumes by itself; null until it's resumed."),
      ...companyArg,
    }),
    area: "jobs",
    run: async (ctx, a) => {
      requirePrices(ctx, a, true);
      const job = await one(ctx.db.from("jobs").select("id, kind, starts_on, recurrence_rule").eq("id", a.job_id).eq("company_id", ctx.companyId).maybeSingle(), "That job");
      const recurring = a.repeat ? true : job.kind === "recurring";
      if ((a.paused || a.resume_on) && !recurring) throw new Error("Only a recurring job can be paused.");
      const first = a.first_date ?? job.starts_on ?? localDate(new Date(), ctx.timezone);
      const patch = {
        ...(a.title !== undefined && { title: a.title }),
        ...(a.instructions !== undefined && { instructions: a.instructions || null }),
        ...(a.repeat && { kind: "recurring" as const, recurrence_rule: repeatRule(a.repeat, first), starts_on: first }),
        ...(a.first_date !== undefined && recurring && { starts_on: a.first_date }),
        ...(a.ends_on !== undefined && { ends_on: a.ends_on }),
        ...(a.season_months !== undefined && { active_months: a.season_months?.length ? a.season_months : null }),
        ...(a.start_time !== undefined && { visit_start_time: a.start_time }),
        ...(a.duration_min !== undefined && { visit_duration_min: a.duration_min }),
        ...(a.crew_id !== undefined && { default_crew_id: a.crew_id }),
        ...(a.billing_mode !== undefined && { billing_mode: a.billing_mode }),
        // The database keeps billing_mode in step with these (20261104000800_recurring_billing.sql).
        ...(a.pricing !== undefined && { pricing: a.pricing }),
        ...(a.invoice_schedule !== undefined && { invoice_schedule: a.invoice_schedule }),
        ...(a.invoice_day !== undefined && { invoice_day: a.invoice_day }),
        ...(a.status !== undefined && { status: a.status }),
        // When it was paused is the database's own time (20261105000500_job_pause.sql).
        ...(a.paused !== undefined && { paused_at: a.paused ? new Date().toISOString() : null }),
        ...(a.resume_on !== undefined && { resume_on: a.resume_on }),
        ...(await customFieldsPatch(ctx, "job", { id: a.job_id }, a.custom_fields)),
      };
      if (Object.keys(patch).length) await changed(ctx.db.from("jobs").update(patch).eq("id", a.job_id).eq("company_id", ctx.companyId).select("id"), "That job");
      if (a.lines) {
        // A promo code's discount stays as it is: put back as a plain line, it would come off every visit again.
        const { error } = await ctx.db.from("job_line_items").delete().eq("job_id", a.job_id).is("discount_key", null);
        if (error) throw new Error(friendly(error.message));
        const lines = await jobLines(ctx, a.job_id, a.lines);
        if (lines.length) {
          const { error: insertError } = await ctx.db.from("job_line_items").insert(lines);
          if (insertError) throw new Error(friendly(insertError.message));
        }
      }
      const reschedules = recurring && ["recurrence_rule", "starts_on", "ends_on", "active_months", "visit_start_time", "visit_duration_min", "default_crew_id", "status", "paused_at", "resume_on"].some((k) => k in patch);
      return { saved: true, ...(reschedules || (recurring && a.upcoming_visits) ? await scheduleJob(ctx, a.job_id, a.upcoming_visits) : {}) };
    },
  }),
  delete_job: tool({
    description: "Delete a job with its visits and lines. A job that's been invoiced can't be: archive it with update_job instead.",
    input: z.object({ job_id: z.uuid(), ...companyArg }),
    area: "jobs",
    destructive: true,
    run: async (ctx, a) => {
      await changed(ctx.db.from("jobs").delete().eq("id", a.job_id).eq("company_id", ctx.companyId).select("id"), "That job");
      return { deleted: true };
    },
  }),
  import_schedule: tool({
    description:
      "Bring a schedule in from another system, up to 500 items: repeating series (recurring jobs), one-time jobs with their visit, and tasks or events with no client. Each is placed by client_id or property_id, or found by the address (a property's street) or the client's name. Run it with mode \"preview\" first: it says where each item goes and what it can't place, without changing anything. Then the same items with mode \"commit\". Items already here (same client, title and schedule) are skipped, so running it again adds nothing twice. Recurring jobs get their visits for the next year. Items with a price or service_id are prices: committing them needs the Prices area too.",
    input: z.object({
      mode: z.enum(["preview", "commit"]),
      items: z
        .array(
          z.object({
            ref: z.string().max(100).optional().describe("Your own label for the item, echoed back."),
            kind: z.enum(["recurring", "one_off", "task", "event"]).optional().describe("Default recurring when repeat is given, otherwise one_off."),
            title: z.string().trim().min(1).max(200),
            client_id: z.uuid().optional(),
            property_id: z.uuid().optional(),
            client_name: z.string().trim().max(200).optional(),
            address: z.object({ line1: z.string().trim().min(1).max(200), city: z.string().trim().max(100).optional() }).optional(),
            first_date: date.describe("The (first) visit's date."),
            start_time: time.optional(),
            duration_min: z.number().int().min(1).max(1440).optional(),
            repeat: repeatInput.optional(),
            ends_on: date.optional(),
            season_months: z.array(z.number().int().min(1).max(12)).max(12).optional(),
            crew_id: z.uuid().optional(),
            notes: z.string().trim().max(5000).optional(),
            price: z.number().min(0).max(1e7).optional().describe("The price per visit (recurring) or for the job (one-off), as a line named after the title."),
            service_id: z.uuid().optional().describe("Or a price list item for its line."),
          }),
        )
        .min(1)
        .max(500),
      ...companyArg,
    }),
    area: "jobs",
    run: async (ctx, a) => {
      // Every client and property, to place the items by address or name.
      const clients: Array<{ id: string; display_name: string; company_name: string | null }> = [];
      const properties: Array<{ id: string; client_id: string; line1: string; city: string | null }> = [];
      for (let from = 0; ; from += 1000) {
        const page = await rows(ctx.db.from("clients").select("id, display_name, company_name").eq("company_id", ctx.companyId).order("id").range(from, from + 999));
        clients.push(...page);
        if (page.length < 1000) break;
      }
      for (let from = 0; ; from += 1000) {
        const page = await rows(ctx.db.from("properties").select("id, client_id, line1, city").eq("company_id", ctx.companyId).order("id").range(from, from + 999));
        properties.push(...page);
        if (page.length < 1000) break;
      }
      const propertyById = new Map(properties.map((p) => [p.id, p]));
      const plan = a.items.map((item, index) => {
        const kind = item.kind ?? (item.repeat ? "recurring" : "one_off");
        let rule: string | null = null;
        let problem: string | null = null;
        if (kind === "recurring") {
          try {
            rule = repeatRule(item.repeat ?? {}, item.first_date);
          } catch (error) {
            problem = `Repeat: ${error instanceof Error ? error.message : "it isn't a schedule jobs can use"}`;
          }
        }
        let clientId = item.client_id ?? null;
        let propertyId = item.property_id ?? null;
        let foundBy: string | null = clientId || propertyId ? "id" : null;
        if (propertyId && !clientId) clientId = propertyById.get(propertyId)?.client_id ?? null;
        if (!clientId && item.address) {
          const hits = properties.filter((p) => sameStreet(p.line1, item.address!.line1) && (!item.address!.city || !p.city || normalizeKey(p.city) === normalizeKey(item.address!.city)));
          if (hits.length === 1) [clientId, propertyId, foundBy] = [hits[0].client_id, hits[0].id, "address"];
          else if (hits.length > 1) problem ??= `More than one property at ${item.address.line1}: give the client_id or property_id.`;
        }
        if (!clientId && item.client_name) {
          const hits = clients.filter((c) => normalizeKey(c.display_name) === normalizeKey(item.client_name!) || (c.company_name && normalizeKey(c.company_name) === normalizeKey(item.client_name!)));
          if (hits.length === 1) [clientId, foundBy] = [hits[0].id, "name"];
          else if (hits.length > 1) problem ??= `More than one client named ${item.client_name}: give the client_id.`;
        }
        if (clientId && !propertyId) {
          const theirs = properties.filter((p) => p.client_id === clientId);
          const atAddress = item.address ? theirs.filter((p) => sameStreet(p.line1, item.address!.line1)) : [];
          propertyId = atAddress[0]?.id ?? (theirs.length === 1 ? theirs[0].id : null);
        }
        if (!clientId && kind !== "task" && kind !== "event") problem ??= "No client found by that address or name. Add the client first (create_client or import_clients), or give the client_id.";
        return { index, item, kind, rule, clientId, propertyId, foundBy, problem };
      });

      // Already here: a job for the same client with the same title and schedule, or a task with the same title and time.
      const clientIds = [...new Set(plan.flatMap((p) => (p.clientId ? [p.clientId] : [])))];
      const existingJobs: Array<{ id: string; client_id: string; title: string; recurrence_rule: string | null; starts_on: string | null }> = [];
      for (let i = 0; i < clientIds.length; i += 200) {
        existingJobs.push(...(await rows(ctx.db.from("jobs").select("id, client_id, title, recurrence_rule, starts_on").in("client_id", clientIds.slice(i, i + 200)))));
      }
      const firstDates = [...new Set(a.items.map((i) => i.first_date))];
      const existingVisits = firstDates.length
        ? await rows(ctx.db.from("visits").select("id, title, scheduled_on, kind").eq("company_id", ctx.companyId).in("scheduled_on", firstDates))
        : [];
      const decided = plan.map((p) => {
        const sameTitle = (t: string) => normalizeKey(t) === normalizeKey(p.item.title);
        const duplicate =
          p.kind === "recurring"
            ? existingJobs.find((j) => j.client_id === p.clientId && sameTitle(j.title) && j.recurrence_rule === p.rule && j.starts_on === p.item.first_date)
            : existingVisits.find((v) => sameTitle(v.title) && v.scheduled_on === p.item.first_date);
        return { ...p, duplicate: duplicate?.id ?? null };
      });
      const describe = (p: (typeof decided)[number]) => ({
        ...(p.item.ref && { ref: p.item.ref }),
        title: p.item.title,
        kind: p.kind,
        ...(p.rule && { repeats: describeRule(p.rule), next_dates: occurrenceDates({ starts_on: p.item.first_date, ends_on: p.item.ends_on ?? null, recurrence_rule: p.rule, active_months: p.item.season_months ?? null }, p.item.first_date, `${Number(p.item.first_date.slice(0, 4)) + 1}${p.item.first_date.slice(4)}`).slice(0, 3) }),
        client_id: p.clientId,
        property_id: p.propertyId,
        found_by: p.foundBy,
        ...(p.problem ? { problem: p.problem } : p.duplicate ? { already_here: p.duplicate } : {}),
      });
      const totals = {
        items: decided.length,
        ready: decided.filter((p) => !p.problem && !p.duplicate).length,
        already_here: decided.filter((p) => !p.problem && p.duplicate).length,
        problems: decided.filter((p) => p.problem).length,
      };
      if (a.mode === "preview") return { mode: "preview", totals, items: decided.map(describe) };

      requireArea(ctx, "schedule");
      // A job's price, or its price list item, is a line: what the client pays. Tasks and events have none.
      const priced = (p: (typeof decided)[number]) => p.kind !== "task" && p.kind !== "event" && (p.item.price !== undefined || Boolean(p.item.service_id));
      if (decided.some((p) => !p.problem && !p.duplicate && priced(p))) requireArea(ctx, "prices");
      const results: Array<ReturnType<typeof describe> & { job_id?: string; visit_ids?: string[]; visits_created?: number; note?: string; error?: string }> = [];
      for (const p of decided) {
        if (p.problem || p.duplicate) {
          results.push(describe(p));
          continue;
        }
        try {
          const i = p.item;
          const lines = i.service_id ? [{ service_id: i.service_id, quantity: 1, ...(i.price !== undefined && { unit_price: i.price }) }] : i.price !== undefined ? [{ name: i.title, quantity: 1, unit_price: i.price }] : [];
          if (p.kind === "task" || p.kind === "event") {
            const start = i.start_time ? zonedTimeToUtc(i.first_date, i.start_time, ctx.timezone) : null;
            const made = await createVisits(scopeOf(ctx), {
              title: i.title, kind: p.kind, property_id: p.propertyId, crew_id: i.crew_id ?? null, notes: i.notes ?? null, status: "scheduled",
              scheduled_on: i.first_date, starts_at: start?.toISOString() ?? null, ends_at: start ? new Date(start.getTime() + (i.duration_min ?? 60) * 60_000).toISOString() : null,
              days: 1, skip_weekends: true, assignee_ids: [], equipment_ids: [],
            });
            results.push({ ...describe(p), visit_ids: made.ids });
            continue;
          }
          const made = await createJob(ctx, {
            client_id: p.clientId!, property_id: p.propertyId ?? undefined, title: i.title, instructions: i.notes ?? null,
            ...(p.kind === "recurring" ? { repeat: { rule: p.rule! }, first_date: i.first_date, ends_on: i.ends_on ?? null, season_months: i.season_months ?? null } : {}),
            start_time: i.start_time ?? null, duration_min: i.duration_min, crew_id: i.crew_id ?? null, lines,
            ...(p.kind === "one_off" ? { visit: { date: i.first_date, start_time: i.start_time, duration_min: i.duration_min, crew_id: i.crew_id } } : {}),
          });
          results.push({ ...describe(p), job_id: made.job_id, visits_created: made.visits_created, ...(made.note && { note: made.note }) });
        } catch (error) {
          results.push({ ...describe(p), error: error instanceof Error ? error.message : "It didn't work." });
        }
      }
      return { mode: "commit", totals: { ...totals, done: results.filter((r) => r.job_id || r.visit_ids).length, failed: results.filter((r) => r.error).length }, items: results };
    },
  }),
};

type JobInput = { client_id: string; property_id?: string } & Partial<{ [K in keyof typeof jobFields]: z.infer<(typeof jobFields)[K]> }> & {
  title: string;
  visit?: { date: string; start_time?: string; duration_min?: number; crew_id?: string };
};

/** A new job as the New job screen makes it, then its visits, then a lead becomes an active client. */
async function createJob(ctx: ToolContext, a: JobInput) {
  const recurring = Boolean(a.repeat);
  const first = a.first_date ?? localDate(new Date(), ctx.timezone);
  const rule = recurring ? repeatRule(a.repeat!, first) : null;
  if (a.visit) requireArea(ctx, "schedule");
  requirePrices(ctx, a);
  const propertyId = await propertyFor(ctx, a.client_id, a.property_id);
  const job = await one(
    ctx.db
      .from("jobs")
      .insert({
        company_id: ctx.companyId,
        client_id: a.client_id,
        property_id: propertyId,
        title: a.title,
        kind: recurring ? "recurring" : "one_off",
        instructions: a.instructions ?? null,
        default_crew_id: a.crew_id ?? null,
        visit_start_time: a.start_time ?? null,
        ...(a.duration_min && { visit_duration_min: a.duration_min }),
        billing_mode: a.billing_mode ?? (recurring ? "per_visit" : "on_completion"),
        // Given, these win and the database sets billing_mode from them.
        ...(recurring && a.pricing && { pricing: a.pricing }),
        ...(recurring && a.invoice_schedule && { invoice_schedule: a.invoice_schedule }),
        ...(recurring && a.invoice_day !== undefined && { invoice_day: a.invoice_day }),
        ...(recurring && { recurrence_rule: rule, starts_on: first, ends_on: a.ends_on ?? null, active_months: a.season_months?.length ? a.season_months : null }),
        ...(await customFieldsPatch(ctx, "job", { values: {} }, a.custom_fields)),
      })
      .select("id, number")
      .single(),
    "The job",
  );
  if (a.lines?.length) {
    const { error } = await ctx.db.from("job_line_items").insert(await jobLines(ctx, job.id, a.lines));
    if (error) throw new Error(`The job was made (number ${job.number}), but its lines weren't: ${friendly(error.message)}`);
  }
  let scheduled: { visits_created: number; note?: string } = { visits_created: 0 };
  if (recurring) scheduled = await scheduleJob(ctx, job.id);
  else if (a.visit) {
    const start = a.visit.start_time ? zonedTimeToUtc(a.visit.date, a.visit.start_time, ctx.timezone) : null;
    const made = await createVisits(scopeOf(ctx), {
      title: a.title, kind: "job", job_id: job.id, property_id: propertyId, crew_id: a.visit.crew_id ?? a.crew_id ?? null, status: "scheduled", notes: null,
      scheduled_on: a.visit.date, starts_at: start?.toISOString() ?? null, ends_at: start ? new Date(start.getTime() + (a.visit.duration_min ?? a.duration_min ?? 60) * 60_000).toISOString() : null,
      days: 1, skip_weekends: true, assignee_ids: [], equipment_ids: [],
    });
    scheduled = { visits_created: made.ids.length };
  }
  await ctx.db.from("clients").update({ status: "active" }).eq("id", a.client_id).eq("status", "lead");
  return {
    job_id: job.id,
    number: job.number,
    property_id: propertyId,
    ...(rule && { repeats: describeRule(rule), next_dates: occurrenceDates({ starts_on: first, ends_on: a.ends_on ?? null, recurrence_rule: rule, active_months: a.season_months ?? null }, first, addYear(first)).slice(0, 4) }),
    ...scheduled,
    ...(!propertyId && { note: "No property: the client has none or several. Set it in Crewtavo, or give property_id." }),
    visits_ahead_days: recurring ? VISIT_DATES_AHEAD : undefined,
  };
}

const addYear = (d: string) => `${Number(d.slice(0, 4)) + 1}${d.slice(4)}`;
