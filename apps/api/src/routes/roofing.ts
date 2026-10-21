/**
 * Roofing: the standard roofing services for a price list that doesn't have them yet (Roofing →
 * Price book). The roof itself is a measurement; its estimate is a quote.
 */
import { ADMINS } from "@crewtavo/core";
import { Hono } from "hono";
import type { AppEnv } from "../env";
import { requireCompany, requireUser } from "../lib/auth";
import { addMissingServices } from "../services/presetServices";

export const roofing = new Hono<AppEnv>();

/** The roofing services a price list is missing (matched by name), added from the roofing preset. */
roofing.post("/roofing/services", requireUser, requireCompany(ADMINS, "settings"), async (c) => {
  return c.json({ added: await addMissingServices(c.var.db, c.var.companyId, "roofing_exteriors") });
});
