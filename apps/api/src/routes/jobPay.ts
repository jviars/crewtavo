/**
 * Job pay: a sub's price on a job and a team member's piece pay (services/jobPay.ts), and what subs
 * were paid, for the 1099 and the workers' comp audit. The web app reads and changes rate cards, a
 * pay's lines, its visits and notes itself, under row-level security; these are the steps where that
 * isn't enough: suggesting lines, starting, agreeing, marking done, cancelling and marking paid.
 *
 * All for the office: a sub's pay with the subs area, a team member's with job costs. A team member's
 * piece pay is paid with their pay period (routes/pay.ts), not here.
 */
import { OFFICE, SUB_PAY_METHODS } from "@crewtavo/core";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { requireCompany, requireUser } from "../lib/auth";
import { HttpError, isoDate, param, readJson, uuid } from "../lib/http";
import {
  acceptPay,
  cancelPay,
  markPayDone,
  markPayPaid,
  payById,
  startPay,
  subYearTotals,
  subYearTotalsCsv,
  suggestPay,
  unmarkPayPaid,
  wcAudit,
  wcAuditCsvFile,
  type JobPayScope,
} from "../services/jobPay";

export const jobPay = new Hono<AppEnv>();

const scope = (c: Context<AppEnv>): JobPayScope => ({ db: c.var.db, companyId: c.var.companyId, role: c.var.role, permissions: c.var.permissions });
// The office; which area it needs depends on whose pay it is (services/jobPay.ts mayHandlePay).
const office = requireCompany(OFFICE);
const subsOffice = requireCompany(OFFICE, "subs");

const payee = {
  job_id: uuid,
  subcontractor_id: uuid.nullable().optional(),
  user_id: uuid.nullable().optional(),
  visit_ids: z.array(uuid).max(200).nullable().optional(),
};
const ids = z.array(uuid).min(1, "Choose what to mark.").max(200);

// The lines a payee's rates come to on a job, each with a note of where its quantity came from.
jobPay.post("/job-pay/suggest", requireUser, office, async (c) => c.json(await suggestPay(scope(c), await readJson(c, z.object(payee)))));

// New pay for a sub or someone on the team: a draft with the suggested lines and the visits it covers.
jobPay.post("/job-pay", requireUser, office, async (c) => c.json(await startPay(scope(c), await readJson(c, z.object(payee))), 201));

// One pay, with its lines and visits.
jobPay.get("/job-pay/:id", requireUser, office, async (c) => c.json(await payById(scope(c), param(c, "id"))));

// Agreed (for a sub, a price agreed by phone): a sub goes on the visits it covers.
jobPay.post("/job-pay/:id/accept", requireUser, office, async (c) => {
  const body = await readJson(c, z.object({ visit_ids: z.array(uuid).max(200).nullable().optional() }));
  return c.json(await acceptPay(scope(c), param(c, "id"), body.visit_ids));
});

// Mark work done (for pay with no visits, or finished without them).
jobPay.post("/job-pay/:id/done", requireUser, office, async (c) => {
  const body = await readJson(c, z.object({ earned_on: isoDate.nullable().optional() }));
  return c.json(await markPayDone(scope(c), param(c, "id"), body.earned_on));
});

// Called off.
jobPay.post("/job-pay/:id/cancel", requireUser, office, async (c) => c.json(await cancelPay(scope(c), param(c, "id"))));

// Subs' pay marked paid, one or several at once.
jobPay.post("/job-pay/mark-paid", requireUser, subsOffice, async (c) => {
  const body = await readJson(
    c,
    z.object({
      ids,
      method: z.enum(SUB_PAY_METHODS),
      paid_on: isoDate.nullable().optional(),
      reference: z.string().trim().max(200).nullable().optional(),
      amount: z.number().min(0).max(10_000_000).nullable().optional(),
    }),
  );
  return c.json(await markPayPaid(scope(c), body));
});

// Paid marks taken back: done and owed again.
jobPay.post("/job-pay/unmark-paid", requireUser, subsOffice, async (c) => {
  const body = await readJson(c, z.object({ ids }));
  return c.json(await unmarkPayPaid(scope(c), body.ids));
});

// ---------------------------------------------------------------------------------------------
// What subs were paid
// ---------------------------------------------------------------------------------------------

const yearOf = (c: Context<AppEnv>) => {
  const year = Number(c.req.query("year"));
  if (!Number.isInteger(year) || year < 2000 || year > 2200) throw new HttpError(400, "Choose a year.");
  return year;
};
const rangeOf = (c: Context<AppEnv>) => {
  const from = c.req.query("from");
  const to = c.req.query("to");
  if (!isoDate.safeParse(from).success || !isoDate.safeParse(to).success) throw new HttpError(400, "from and to must be YYYY-MM-DD");
  return { from: from!, to: to! };
};

// Each sub's total for a calendar year, and who needs a 1099.
jobPay.get("/subs/1099", requireUser, subsOffice, async (c) => c.json(await subYearTotals(scope(c), yearOf(c))));
jobPay.get("/subs/1099/csv", requireUser, subsOffice, async (c) => c.json(await subYearTotalsCsv(scope(c), yearOf(c))));

// The workers' comp audit for a stretch of dates (usually the policy year).
jobPay.get("/subs/workers-comp", requireUser, subsOffice, async (c) => {
  const { from, to } = rangeOf(c);
  return c.json(await wcAudit(scope(c), from, to));
});
jobPay.get("/subs/workers-comp/csv", requireUser, subsOffice, async (c) => {
  const { from, to } = rangeOf(c);
  return c.json(await wcAuditCsvFile(scope(c), from, to));
});
