/**
 * The business's figures, as the Finance page and the home dashboard show them: the same rows and
 * the same sums (packages/core/src/reports.ts), for the same people. The database hides money from
 * roles without it; who sees reports at all (owners, admins and office staff with "Finance and
 * metrics") and job costs is checked here, as the Finance page checks it.
 */
import { breakPay, jobProfit, localDate, moneyFigures, previousRange, REPORT_PRESETS, resolveRange, salesFigures, teamHours, type ReportPreset } from "@crewtavo/core";
import { z } from "zod";
import { adminClient } from "../lib/supabase";
import { timeRates } from "../services/payRates";
import { companyArg, friendly, requireRole, roleAllows, rows, tool, type ToolContext } from "./tool";

const OFFICE = ["owner", "admin", "office"] as const;
const rangeInput = {
  range: z.enum(REPORT_PRESETS.map((p) => p.key) as [ReportPreset, ...ReportPreset[]]).default("month").describe("month, last_month, 30d, 90d, quarter, year, last_year, or custom with from and to."),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
};

function rangeOf(ctx: ToolContext, a: { range: ReportPreset; from?: string; to?: string }) {
  const custom = a.from || a.to ? "custom" : a.range;
  return resolveRange(custom, localDate(new Date(), ctx.timezone), ctx.timezone, { from: a.from, to: a.to });
}

/** Up to 25,000 rows, a page at a time, as the Finance page reads them. */
async function all<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < 25; i++) {
    const batch = await rows(page(i * 1000, i * 1000 + 999));
    out.push(...batch);
    if (batch.length < 1000) break;
  }
  return out;
}

async function teamNames(ctx: ToolContext) {
  const members = await rows(ctx.db.from("memberships").select("user_id").eq("company_id", ctx.companyId));
  const profiles = members.length ? await rows(ctx.db.from("profiles").select("user_id, full_name").in("user_id", members.map((m) => m.user_id))) : [];
  const names = new Map(profiles.map((p) => [p.user_id, p.full_name]));
  return (id: string | null) => (id ? (names.get(id) ?? "Former team member") : "Unassigned");
}

export const reportTools = {
  business_summary: tool({
    description: "Today at a glance, as the home screen shows it: requests, quotes and jobs waiting, today's visits, what's owed (and by whom), this month's collected, invoiced and quotes won, and what needs attention. Money only if your role sees it.",
    input: z.object({ ...companyArg }),
    run: async (ctx) => {
      const { data, error } = await ctx.db.rpc("dashboard", { p_company: ctx.companyId }, { get: true });
      if (error) throw new Error(friendly(error.message));
      return data;
    },
  }),
  money_report: tool({
    description: "Money for a period (default this month): invoiced, collected (and vs the period before), tips, card fees, sales tax billed, what's owed and past due now, unpaid invoices by age, payments by method, and each client's balance.",
    input: z.object({ ...rangeInput, ...companyArg }),
    run: async (ctx, a) => {
      requireRole(ctx, OFFICE, "reports");
      requireRole(ctx, undefined, "invoices");
      const range = rangeOf(ctx, a);
      const before = previousRange(range);
      const today = localDate(new Date(), ctx.timezone);
      const [invoices, payments, open, paidBefore, invoicedBefore] = await Promise.all([
        all((f, t) => ctx.db.from("invoices").select("total, tax_amount, issued_on").eq("company_id", ctx.companyId).not("status", "in", "(draft,void)").gte("issued_on", range.from).lte("issued_on", range.to).range(f, t)),
        all((f, t) => ctx.db.from("payments").select("amount, tip_amount, fee_amount, method, received_at").eq("company_id", ctx.companyId).gte("received_at", range.start).lt("received_at", range.end).range(f, t)),
        all((f, t) => ctx.db.from("invoices").select("balance_due, due_on, client:clients(id, display_name)").eq("company_id", ctx.companyId).in("status", ["sent", "partially_paid", "overdue"]).range(f, t)),
        all((f, t) => ctx.db.from("payments").select("amount").eq("company_id", ctx.companyId).gte("received_at", before.start).lt("received_at", before.end).range(f, t)),
        all((f, t) => ctx.db.from("invoices").select("total").eq("company_id", ctx.companyId).not("status", "in", "(draft,void)").gte("issued_on", before.from).lte("issued_on", before.to).range(f, t)),
      ]);
      const figures = moneyFigures({ invoices, payments, open: open as never }, today);
      const total = (r: Array<{ amount?: unknown; total?: unknown }>) => Math.round(r.reduce((s, x) => s + Number(x.amount ?? x.total ?? 0), 0) * 100) / 100;
      return { period: range, ...figures, collected_previous_period: total(paidBefore), invoiced_previous_period: total(invoicedBefore), client_balances: figures.client_balances.slice(0, 50) };
    },
  }),
  sales_report: tool({
    description: "Quotes sent in a period (default this month): won, lost and still waiting, conversion, average quote, days to approval, by salesperson and lead source, and why quotes were lost.",
    input: z.object({ ...rangeInput, ...companyArg }),
    run: async (ctx, a) => {
      requireRole(ctx, OFFICE, "reports");
      const range = rangeOf(ctx, a);
      const [quotes, clients, nameOf] = await Promise.all([
        all((f, t) => ctx.db.from("quotes").select("id, status, total, sent_at, approved_at, salesperson_id, created_by, lost_reason, client:clients(lead_source)").eq("company_id", ctx.companyId).gte("sent_at", range.start).lt("sent_at", range.end).range(f, t)),
        all((f, t) => ctx.db.from("clients").select("id, lead_source").eq("company_id", ctx.companyId).gte("created_at", range.start).lt("created_at", range.end).range(f, t)),
        teamNames(ctx),
      ]);
      return { period: range, ...salesFigures({ quotes: quotes as never, clients }, nameOf) };
    },
  }),
  job_profit: tool({
    description: "Profit on jobs finished in a period (default this month): each job's revenue, labor (approved time at its rate, the rest at the person's current rate), expenses and materials at cost, profit and margin, and which are below the company's target margin.",
    input: z.object({ ...rangeInput, limit: z.number().int().min(1).max(300).default(100), ...companyArg }),
    run: async (ctx, a) => {
      requireRole(ctx, OFFICE, "reports");
      requireRole(ctx, undefined, "job_costs");
      const range = rangeOf(ctx, a);
      const jobs = await all((f, t) =>
        ctx.db
          .from("jobs")
          .select("id, number, title, status, financials:job_financials(contract_total), client:clients(display_name), lines:job_line_items(quantity, unit_cost)")
          .eq("company_id", ctx.companyId)
          .in("status", ["requires_invoicing", "completed"])
          .gte("updated_at", range.start)
          .lt("updated_at", range.end)
          .range(f, t),
      );
      const ids = jobs.slice(0, a.limit).map((j) => j.id);
      const [time, expenses, rates, company] = ids.length
        ? await Promise.all([
            all((f, t) => ctx.db.from("time_entries").select("id, job_id, user_id, started_at, ended_at, approved_at").in("job_id", ids).range(f, t)),
            all((f, t) => ctx.db.from("expenses").select("job_id, amount").in("job_id", ids).range(f, t)),
            timeRates(adminClient(ctx.env), ctx.companyId, { job_ids: ids }),
            rows(ctx.db.from("companies").select("settings").eq("id", ctx.companyId)),
          ])
        : [[], [], {} as Record<string, number>, []];
      const target = Number(((company[0]?.settings ?? {}) as Record<string, unknown>).margin_target ?? 0) || null;
      const result = jobProfit(jobs.slice(0, a.limit) as never, time, expenses, (e) => rates[e.id] ?? 0, target);
      return { period: range, ...result, jobs: result.jobs.sort((x, y) => (x.margin_percent ?? 0) - (y.margin_percent ?? 0)) };
    },
  }),
  team_hours_report: tool({
    description: "Time tracked in a period (default this month): paid hours by person and category (breaks count as the company pays them; unpaid break time is listed apart), share on visits, hours waiting for approval, and labor cost (if your role sees job costs).",
    input: z.object({ ...rangeInput, ...companyArg }),
    run: async (ctx, a) => {
      requireRole(ctx, OFFICE, "reports");
      const range = rangeOf(ctx, a);
      const costs = roleAllows(ctx, OFFICE, "job_costs");
      const [entries, nameOf, rates, company] = await Promise.all([
        all((f, t) => ctx.db.from("time_entries").select("id, user_id, job_id, started_at, ended_at, category, approved_at").eq("company_id", ctx.companyId).gte("started_at", range.start).lt("started_at", range.end).range(f, t)),
        teamNames(ctx),
        costs ? timeRates(adminClient(ctx.env), ctx.companyId, { from: range.start, to: range.end }) : Promise.resolve({} as Record<string, number>),
        rows(ctx.db.from("companies").select("settings").eq("id", ctx.companyId)),
      ]);
      const now = new Date().toISOString();
      const result = teamHours(
        entries.map((e) => ({ ...e, running: !e.ended_at, ended_at: e.ended_at ?? now })),
        (id) => nameOf(id),
        (e) => rates[e.id] ?? 0,
        breakPay(company[0]?.settings),
      );
      return costs ? { period: range, ...result } : { period: range, ...result, labor_cost: undefined, by_person: result.by_person.map(({ cost: _, ...p }) => p) };
    },
  }),
};
