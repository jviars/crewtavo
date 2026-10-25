/**
 * Job offers to subs (services/subOffers.ts).
 *
 * The office (owners, admins and office staff with the subs area) sends a sub their price on a job,
 * changes an agreed price, which goes back to them as a new offer, and takes an offer back. The web
 * app reads offers on a job itself, from job_pay under row-level security.
 *
 * A sub reads their own offers and takes one or turns it down: these routes are open to subs
 * (WITH_SUBS), and only to subs. Each runs as the person signed in, so the database checks again.
 */
import { OFFICE, WITH_SUBS } from "@crewtavo/core";
import type { Context } from "hono";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import type { AppEnv } from "../env";
import { requireCompany, requireUser } from "../lib/auth";
import { HttpError, param, readJson, uuid } from "../lib/http";
import { allow } from "../lib/limit";
import type { JobPayScope } from "../services/jobPay";
import { answerOffer, changeOffer, myOffers, myPayTotals, offerCompany, sendOffer, withdrawOffer } from "../services/subOffers";

export const subOffers = new Hono<AppEnv>();

const scope = (c: Context<AppEnv>): JobPayScope => ({ db: c.var.db, companyId: c.var.companyId, role: c.var.role, permissions: c.var.permissions });
const subsOffice = requireCompany(OFFICE, "subs");

/** A sub's own: open to the Subcontractor level (WITH_SUBS), and to nobody else. */
const subOnly = createMiddleware<AppEnv>(async (c, next) => {
  if (c.var.role !== "subcontractor") throw new HttpError(403, "These are a sub's own job offers. Open the job to see the offers you've sent.");
  await next();
});
const asSub = requireCompany(WITH_SUBS);

const respondBy = z.iso.datetime({ offset: true }).nullable().optional();
const line = z.object({
  description: z.string().trim().min(1).max(200),
  basis: z.enum(["per_unit", "per_job", "per_day"]).default("per_job"),
  unit: z.string().trim().max(20).nullable().optional(),
  quantity: z.number().min(0).max(1_000_000).default(1),
  rate: z.number().min(0).max(1_000_000),
  service_id: uuid.nullable().optional(),
  pay_rate_id: uuid.nullable().optional(),
});

/** Each offer that goes out tells the sub (by text too), so an office person sends at most 60 an hour. */
async function offerLimit(c: Context<AppEnv>) {
  if (!(await allow(c.env, `sub-offer:${c.var.userId}`, 60, 3600))) throw new HttpError(429, "That's a lot of offers in an hour. Wait a while and try again.");
}

// ---------------------------------------------------------------------------------------------
// The office
// ---------------------------------------------------------------------------------------------

// A draft goes to the sub as an offer, to answer by respond_by if given.
subOffers.post("/job-pay/:id/offer", requireUser, subsOffice, async (c) => {
  const body = await readJson(c, z.object({ respond_by: respondBy }));
  await offerLimit(c);
  return c.json(await sendOffer(scope(c), param(c, "id"), body.respond_by));
});

// A new price for agreed pay goes to the sub as an offer. The agreed price stands until they take it.
subOffers.post("/job-pay/:id/offer/change", requireUser, subsOffice, async (c) => {
  const body = await readJson(c, z.object({ lines: z.array(line).min(1, "Add what you'll pay them.").max(50), respond_by: respondBy }));
  await offerLimit(c);
  return c.json(await changeOffer(scope(c), param(c, "id"), body));
});

// An offer the sub hasn't answered, taken back.
subOffers.post("/job-pay/:id/offer/withdraw", requireUser, subsOffice, async (c) => c.json(await withdrawOffer(scope(c), param(c, "id"))));

// ---------------------------------------------------------------------------------------------
// The sub
// ---------------------------------------------------------------------------------------------

// Their offers here: waiting for an answer, then those that ended lately; ?all=1 for all their pay.
subOffers.get("/sub/offers", requireUser, asSub, subOnly, async (c) => {
  const all = c.req.query("all");
  return c.json(await myOffers(c.var.db, c.var.companyId, all === "1" || all === "true"));
});

// What they've been paid here this year, and what they're owed now.
subOffers.get("/sub/offers/totals", requireUser, asSub, subOnly, async (c) => c.json(await myPayTotals(c.var.db, c.var.companyId)));

// Which company an offer of theirs is from: a link to one from another company they work for opens
// My jobs here, which then offers to switch.
subOffers.get("/sub/offers/:id/company", requireUser, asSub, subOnly, async (c) => {
  const companyId = await offerCompany(c.var.db, param(c, "id"));
  if (!companyId) throw new HttpError(404, "We can't find that job offer.");
  return c.json({ company_id: companyId });
});

// Take it (accept: true) or turn it down, with a reason if they like; round is the offer they saw.
subOffers.post("/sub/offers/:id/answer", requireUser, asSub, subOnly, async (c) => {
  const body = await readJson(
    c,
    z.object({
      accept: z.boolean(),
      reason: z.string().trim().max(500).nullable().optional(),
      round: z.number().int().min(0).nullable().optional(),
    }),
  );
  return c.json(await answerOffer(c.var.db, c.var.companyId, param(c, "id"), body));
});
