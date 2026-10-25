/**
 * Roofing: the standard roofing services and roof packages for a business that doesn't have them
 * yet, a package's lines on a roof estimate, the price range the homeowner is sent first (and their
 * yes, when they give it on the phone or in person), the exact price set on site, and the packages' materials at today's ABC Supply prices. The roof itself is a
 * measurement; its estimate is a quote (services/roofPackages.ts). An estimate that offers two or
 * three options gets them from routes/packages.ts.
 */
import { ADMINS, OFFICE, SALES } from "@crewtavo/core";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { requireCompany, requireUser } from "../lib/auth";
import { kickAutomations } from "../lib/background";
import { appUrl, HttpError, param, readJson, uuid } from "../lib/http";
import { allow } from "../lib/limit";
import { postedId } from "../services/contracts";
import { addMissingServices } from "../services/presetServices";
import { applyPackage, markRangeAccepted, pricePackages, sendRange, setSitePrice, setupRoofing } from "../services/roofPackages";
import { sendSchema, type SalesScope } from "../services/sales";

export const roofing = new Hono<AppEnv>();

const scope = (c: Context<AppEnv>): SalesScope => ({ db: c.var.db, env: c.env, companyId: c.var.companyId, baseUrl: appUrl(c) });

/** The roofing services a price list is missing (matched by name), added from the roofing preset. */
roofing.post("/roofing/services", requireUser, requireCompany(ADMINS, "settings"), async (c) => {
  return c.json({ added: await addMissingServices(c.var.db, c.var.companyId, "roofing_exteriors") });
});

/** The standard roofing services, and the standard roof packages for a business with none yet. */
roofing.post("/roofing/setup", requireUser, requireCompany(OFFICE, "settings"), async (c) => {
  return c.json(await setupRoofing(c.var.db, c.var.companyId));
});

/** The packages' ABC Supply materials priced again at the branch today (Roofing → Packages). */
roofing.post("/roofing/prices", requireUser, requireCompany(SALES, "settings"), async (c) => {
  if (!(await allow(c.env, `roofing-prices:${c.var.companyId}`, 20, 10 * 60))) throw new HttpError(429, "Those prices were just updated. Wait a few minutes and try again.");
  return c.json(await pricePackages(c.env, c.var.db, c.var.companyId));
});

/**
 * A roof package on an estimate: its lines from the roof's measurements (or kept, when it has some).
 * Not on an estimate that offers options (409): those change from the options bar. The app prices
 * estimates from packages through POST /quotes/:id/options now (one package there is this same
 * step, put_quote_package); this route stays for API callers that use it.
 */
roofing.post("/roofing/:id/package", requireUser, requireCompany(SALES, "sales"), async (c) => {
  const id = param(c, "id");
  const body = await readJson(c, z.object({ package_id: uuid, replace: z.boolean().optional() }));
  return c.json(await applyPackage(c.var.db, c.var.companyId, id, body.package_id, body.replace ?? false));
});

/** Send the homeowner the estimate as a price range, by email or text (or just make the link). */
roofing.post("/roofing/:id/send-range", requireUser, requireCompany(SALES, "sales"), async (c) => {
  const id = param(c, "id");
  const body = await readJson(c, sendSchema);
  const result = await sendRange(scope(c), id, body);
  kickAutomations(c, c.var.companyId);
  return c.json(result);
});

/**
 * The homeowner said yes to the range another way (on the phone, by text, in person), so the office
 * marks it for them: the same as their Yes on the link, with the option they're leaning toward and a
 * note saying who marked it. A range that hasn't gone out yet is saved as they were told it.
 */
roofing.post("/roofing/:id/range-accepted", requireUser, requireCompany(SALES, "sales"), async (c) => {
  const id = param(c, "id");
  const body = await readJson(c, z.object({ note: z.string().max(500).optional(), option_id: postedId.optional() }));
  const result = await markRangeAccepted(c.env, c.var.db, c.var.companyId, c.var.userId, id, body);
  kickAutomations(c, c.var.companyId);
  return c.json(result);
});

/**
 * The exact price, set with the homeowner on site (before tax), or back to the estimate with null.
 * With options, it's the price of the option shown.
 */
roofing.put("/roofing/:id/site-price", requireUser, requireCompany(SALES, "sales"), async (c) => {
  const id = param(c, "id");
  const body = await readJson(c, z.object({ price: z.number().min(0).max(10_000_000).nullable(), note: z.string().max(2000).optional() }));
  return c.json(await setSitePrice(c.var.db, c.var.companyId, id, body));
});
