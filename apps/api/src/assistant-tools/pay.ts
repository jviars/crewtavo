/**
 * Pay: each person's approved hours and pay for a period, their pay rates, and marking them paid
 * once the business has paid them through its own payroll or bank (services/pay.ts; Crewtavo moves
 * no money). Office and up with job costs; pay rates and paid marks are money, so "Full access, no
 * money" doesn't change them.
 */
import { ADMINS, addDays, localDate, mondayOf } from "@crewtavo/core";
import { z } from "zod";
import { markPaid, PAY_METHODS, payHistory, payPeriodSummary, unmarkPaid, type PayScope } from "../services/pay";
import { companyArg, friendly, requireRole, tool, type ToolContext } from "./tool";

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD.");
const scope = (ctx: ToolContext): PayScope => ({ db: ctx.db, env: ctx.env, companyId: ctx.companyId, userId: ctx.userId, role: ctx.role, permissions: ctx.permissions });

/** Last week (Monday to Sunday) when no dates are given. */
function period(ctx: ToolContext, a: { from?: string; to?: string }) {
  const lastMonday = addDays(mondayOf(localDate(new Date(), ctx.timezone)), -7);
  const from = a.from ?? lastMonday;
  return { from, to: a.to ?? (a.from ? addDays(a.from, 6) : addDays(lastMonday, 6)) };
}

export const payTools = {
  pay_summary: tool({
    description:
      "A pay period's pay for each person (default last week, Monday to Sunday): approved hours at their rates (breaks aren't paid), hours over 40 in a week (overtime, for your payroll service; amounts are at straight time), time not approved yet or clocks still running, and who's been marked paid.",
    input: z.object({ from: date.optional(), to: date.optional(), ...companyArg }),
    run: async (ctx, a) => {
      const p = period(ctx, a);
      return payPeriodSummary(scope(ctx), p.from, p.to);
    },
  }),
  set_pay_rate: tool({
    description: "Set someone's hourly pay rate (null clears it). Time approved from now on is costed and paid at it; time already approved keeps its rate.",
    input: z.object({ user_id: z.uuid(), rate: z.number().min(0).max(10_000).nullable(), ...companyArg }),
    area: "pay",
    run: async (ctx, a) => {
      requireRole(ctx, ADMINS, "team");
      const { data, error } = await ctx.db.from("memberships").update({ labor_rate: a.rate }).eq("company_id", ctx.companyId).eq("user_id", a.user_id).select("user_id");
      if (error) throw new Error(friendly(error.message));
      if (!data?.length) throw new Error("That person not found (or you can't change them).");
      return { saved: true };
    },
  }),
  mark_paid: tool({
    description:
      "Record that people were paid for a pay period (everyone with approved hours, or these user_ids): how (direct_deposit, check, cash, payroll_service, other), a reference (check number, payroll run), the date, and amounts if they differ from what their hours come to. Their time in it is then locked. Everyone's time has to be approved first. Confirm with the person before marking.",
    input: z.object({
      from: date,
      to: date,
      user_ids: z.array(z.uuid()).min(1).max(500).optional(),
      method: z.enum(PAY_METHODS),
      reference: z.string().trim().max(200).optional(),
      paid_on: date.optional(),
      amounts: z.record(z.uuid(), z.number().min(0).max(1e7)).optional().describe("Paid amount by user_id, where it isn't hours × rate."),
      notes: z.string().trim().max(2000).optional(),
      ...companyArg,
    }),
    area: "pay",
    run: (ctx, a) => markPaid(scope(ctx), a),
  }),
  unmark_paid: tool({
    description: "Take back a paid mark for a pay period (everyone, or these user_ids), so their time in it can be changed again.",
    input: z.object({ from: date, to: date, user_ids: z.array(z.uuid()).min(1).max(500).optional(), ...companyArg }),
    area: "pay",
    run: (ctx, a) => unmarkPaid(scope(ctx), a),
  }),
  pay_history: tool({
    description: "Pay periods marked paid (or partly), newest first: each person's hours, overtime, amount, what was paid, how and the reference.",
    input: z.object({ limit: z.number().int().min(1).max(100).default(20), ...companyArg }),
    run: (ctx, a) => payHistory(scope(ctx), a.limit),
  }),
};
