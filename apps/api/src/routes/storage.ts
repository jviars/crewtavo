/**
 * Storage limits (Settings → Storage, and the total on the Drive page; packages/core/src/storage.ts):
 *   GET /api/storage   how much is stored and the limits, as this person may see them (the team, not
 *                      subs): the company's total and the Trash's share, its limit and the default,
 *                      and their own use and limit; owners and admins also see each person's, each
 *                      area's and the limits set for roles. On Railway, owners and admins also get
 *                      `railway`: where files live and what a GB costs a month there (null
 *                      otherwise), with the default limit read again from Railway first
 *                      (?fresh=1 to ask Railway now).
 * Limits are changed from the browser itself, through the database's own functions
 * (storage_set_limit, storage_set_allowance), which decide who may.
 */
import { ADMINS, STAFF } from "@crewtavo/core";
import { Hono } from "hono";
import type { AppEnv } from "../env";
import { requireCompany, requireUser } from "../lib/auth";
import { adminClient } from "../lib/supabase";
import { storageOverviewFor } from "../services/storageUsage";

export const storage = new Hono<AppEnv>();

storage.get("/storage", requireUser, requireCompany(STAFF), async (c) => {
  const owners = ADMINS.includes(c.var.role);
  return c.json(await storageOverviewFor(c.env, c.var.db, adminClient(c.env), c.var.companyId, { owners, fresh: c.req.query("fresh") === "1" }));
});
