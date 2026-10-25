/**
 * Packages on estimates, for every trade: the two or three options an estimate offers, each from a
 * package (services/quoteOptions.ts), a quote copied with its options, a package's picture and a
 * price list item's picture for the iPad's site visit (services/packagePictures.ts). Editing a
 * package, renaming an option and showing another option first are plain writes from the browser;
 * a roof estimate's single package is routes/roofing.ts.
 */
import { SALES } from "@crewtavo/core";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { requireCompany, requireUser } from "../lib/auth";
import { HttpError, param, readJson, uuid } from "../lib/http";
import { allow } from "../lib/limit";
import { adminClient } from "../lib/supabase";
import { removePackagePicture, removeServicePicture, setPackagePicture, setServicePicture } from "../services/packagePictures";
import { addOptions, duplicateQuote, fillOptions, removeOption } from "../services/quoteOptions";

export const packages = new Hono<AppEnv>();

/**
 * Offer packages on an estimate: one package on an empty estimate prices it as before; otherwise
 * each becomes an option (the estimate as it is becoming option 1). `mode: "replace"` starts over
 * from the packages. Lines listed in `shared_line_ids` stay on every option.
 */
packages.post("/quotes/:id/options", requireUser, requireCompany(SALES, "sales"), async (c) => {
  const id = param(c, "id");
  const body = await readJson(c, z.object({ package_ids: z.array(uuid).max(10), mode: z.enum(["add", "replace"]).optional(), shared_line_ids: z.array(uuid).max(500).optional() }));
  return c.json(await addOptions(c.var.db, c.var.companyId, id, { package_ids: body.package_ids, replace: body.mode === "replace", shared_line_ids: body.shared_line_ids ?? [] }));
});

/**
 * After measuring: the options offered before get their lines, cheapest first as Good, Better and
 * Best; an estimate without options gets the lines of the package it remembers.
 */
packages.post("/quotes/:id/options/fill", requireUser, requireCompany(SALES, "sales"), async (c) => {
  return c.json(await fillOptions(c.var.db, c.var.companyId, param(c, "id")));
});

/** Take an option off an estimate; with one left, it's a single estimate again. */
packages.delete("/quotes/:id/options/:optionId", requireUser, requireCompany(SALES, "sales"), async (c) => {
  return c.json(await removeOption(c.var.db, c.var.companyId, param(c, "id"), param(c, "optionId")));
});

/** "Copy as new draft": the quote with its lines and options, as a new draft. */
packages.post("/quotes/:id/duplicate", requireUser, requireCompany(SALES, "sales"), async (c) => {
  return c.json(await duplicateQuote(c.var.db, c.var.companyId, param(c, "id")), 201);
});

/**
 * A package's picture, as a JPEG, base64. Those who set up the packages (the Settings area) add it;
 * a new one is a new file, so options already offered keep theirs. Its length is capped with the
 * request (app.ts), so one too large for a picture gets the picture's own 413.
 */
packages.put("/packages/:id/picture", requireUser, requireCompany(SALES, "settings"), async (c) => {
  const id = param(c, "id");
  const body = await readJson(c, z.object({ picture: z.string().min(100).regex(/^[A-Za-z0-9+/]+={0,2}$/) }));
  if (!(await allow(c.env, `package-picture:${c.var.companyId}`, 60, 3600))) throw new HttpError(429, "Too many picture changes. Wait a while and try again.");
  return c.json(await setPackagePicture(c.var.db, adminClient(c.env), c.var.companyId, id, body.picture));
});

/** Back to the package's drawing. */
packages.delete("/packages/:id/picture", requireUser, requireCompany(SALES, "settings"), async (c) => {
  await removePackagePicture(c.var.db, c.var.companyId, param(c, "id"));
  return c.json({ ok: true });
});

/**
 * A price list item's picture, as a JPEG, base64, for the iPad's site visit (Settings → Price list,
 * by those who keep the price list). Sent and kept as a package's is, and slowed down with them.
 */
packages.put("/services/:id/picture", requireUser, requireCompany(SALES, "settings"), async (c) => {
  const id = param(c, "id");
  const body = await readJson(c, z.object({ picture: z.string().min(100).regex(/^[A-Za-z0-9+/]+={0,2}$/) }));
  if (!(await allow(c.env, `package-picture:${c.var.companyId}`, 60, 3600))) throw new HttpError(429, "Too many picture changes. Wait a while and try again.");
  return c.json(await setServicePicture(c.var.db, adminClient(c.env), c.var.companyId, id, body.picture));
});

/** Back to the item's drawing. */
packages.delete("/services/:id/picture", requireUser, requireCompany(SALES, "settings"), async (c) => {
  await removeServicePicture(c.var.db, c.var.companyId, param(c, "id"));
  return c.json({ ok: true });
});
