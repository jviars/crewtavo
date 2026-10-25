/**
 * Signatures: a person's saved signature, signing a quote in person, signing for the business and
 * sending the signed copy. The steps themselves are in services/signing.ts.
 */
import { SALES } from "@crewtavo/core";
import { Hono, type Context } from "hono";
import type { AppEnv } from "../env";
import { requireCompany, requireUser } from "../lib/auth";
import { kickAutomations } from "../lib/background";
import { appUrl, HttpError, param, readJson } from "../lib/http";
import { allow } from "../lib/limit";
import {
  copySchema,
  countersignQuote,
  countersignSchema,
  removeSignature,
  saveSignature,
  savedSignature,
  saveSignatureSchema,
  sendSignedCopy,
  signQuote,
  signSchema,
  type SigningScope,
} from "../services/signing";

export const signing = new Hono<AppEnv>();

const scope = (c: Context<AppEnv>): SigningScope => ({ db: c.var.db, env: c.env, companyId: c.var.companyId, userId: c.var.userId, baseUrl: appUrl(c) });

// ---------------------------------------------------------------------------------------------
// My saved signature (one per business)
// ---------------------------------------------------------------------------------------------

signing.get("/me/signature", requireUser, requireCompany(), async (c) => {
  return c.json({ image: await savedSignature(c.var.db, c.var.companyId, c.var.userId) });
});

signing.put("/me/signature", requireUser, requireCompany(), async (c) => {
  const { image } = await readJson(c, saveSignatureSchema);
  if (!(await allow(c.env, `signature:${c.var.userId}`, 30, 3600))) throw new HttpError(429, "Too many signature changes. Wait a while and try again.");
  await saveSignature(c.var.db, c.var.companyId, c.var.userId, image);
  return c.json({ image });
});

signing.delete("/me/signature", requireUser, requireCompany(), async (c) => {
  await removeSignature(c.var.db, c.var.companyId, c.var.userId);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------------------------
// Signed estimates
// ---------------------------------------------------------------------------------------------

/**
 * The homeowner signs on the salesperson's iPad, for the option they chose and the contract on the
 * paper; the quote is approved with both signatures.
 */
signing.post("/quotes/:id/sign", requireUser, requireCompany(SALES, "sales"), async (c) => {
  const id = param(c, "id");
  const result = await signQuote(scope(c), id, await readJson(c, signSchema));
  kickAutomations(c, c.var.companyId);
  return c.json(result);
});

/** Signs for the business on a quote the client already signed. */
signing.post("/quotes/:id/countersign", requireUser, requireCompany(SALES, "sales"), async (c) => {
  return c.json(await countersignQuote(scope(c), param(c, "id"), await readJson(c, countersignSchema)));
});

/** Emails or texts the client their signed estimate again. */
signing.post("/quotes/:id/send-copy", requireUser, requireCompany(SALES, "sales"), async (c) => {
  const id = param(c, "id");
  const body = await readJson(c, copySchema);
  if (!(await allow(c.env, `signed-copy:${id}`, 20, 3600))) throw new HttpError(429, "That's a lot of copies of this estimate. Wait a while and try again.");
  return c.json(await sendSignedCopy(scope(c), id, body));
});
