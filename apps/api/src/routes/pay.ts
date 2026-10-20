/**
 * Timesheets → Pay: each person's approved hours and pay for a period, and marking them paid once
 * the business has paid them through its own payroll or bank. The work is in services/pay.ts,
 * which AI assistants' pay tools use too.
 */
import { OFFICE } from "@crewtavo/core";
import type { Context } from "hono";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { requireCompany, requireUser } from "../lib/auth";
import { HttpError, isoDate, readJson, uuid } from "../lib/http";
import { markPaid, PAY_METHODS, payHistory, payPeriodSummary, unmarkPaid, type PayScope } from "../services/pay";

export const pay = new Hono<AppEnv>();

const scope = (c: Context<AppEnv>): PayScope => ({ db: c.var.db, env: c.env, companyId: c.var.companyId, userId: c.var.userId, role: c.var.role, permissions: c.var.permissions });
const office = requireCompany(OFFICE, "job_costs");

pay.get("/pay/summary", requireUser, office, async (c) => {
  const from = c.req.query("from");
  const to = c.req.query("to");
  if (!isoDate.safeParse(from).success || !isoDate.safeParse(to).success) throw new HttpError(400, "from and to must be YYYY-MM-DD");
  return c.json(await payPeriodSummary(scope(c), from!, to!));
});

pay.post("/pay/mark-paid", requireUser, office, async (c) => {
  const body = await readJson(
    c,
    z.object({
      from: isoDate,
      to: isoDate,
      user_ids: z.array(uuid).min(1).max(500).optional(),
      method: z.enum(PAY_METHODS),
      reference: z.string().trim().max(200).nullable().optional(),
      paid_on: isoDate.optional(),
      amounts: z.record(uuid, z.number().min(0).max(1e7)).optional(),
      notes: z.string().trim().max(2000).nullable().optional(),
    }),
  );
  return c.json(await markPaid(scope(c), body));
});

pay.post("/pay/unmark-paid", requireUser, office, async (c) => {
  const body = await readJson(c, z.object({ from: isoDate, to: isoDate, user_ids: z.array(uuid).min(1).max(500).optional() }));
  return c.json(await unmarkPaid(scope(c), body));
});

pay.get("/pay/periods", requireUser, office, async (c) => c.json(await payHistory(scope(c))));
