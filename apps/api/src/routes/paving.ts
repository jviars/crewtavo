/**
 * Paving: finding pavement and stalls on the aerial with the business's own fal.ai key (Find paving
 * on the measuring map), and the standard paving services for a price list that doesn't have them
 * yet (Paving → Price book). The takeoff itself is a measurement; its quote is a quote.
 */
import { ADMINS, SALES } from "@crewtavo/core";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { DETECT_TARGETS, detect, type DetectTarget } from "../integrations/fal";
import { loadSecret } from "../integrations/tokens";
import { requireCompany, requireUser } from "../lib/auth";
import { HttpError, readJson } from "../lib/http";
import { allow } from "../lib/limit";
import { adminClient } from "../lib/supabase";
import { addMissingServices } from "../services/presetServices";

export const paving = new Hono<AppEnv>();

/** About 1.5 MB of JPEG, plenty for the 1024 px square the map sends. */
const MAX_IMAGE = 2_000_000;

paving.post("/paving/detect", requireUser, requireCompany([...SALES, "crew_lead"]), async (c) => {
  const body = await readJson(
    c,
    z.object({
      image: z.string().max(MAX_IMAGE).regex(/^data:image\/(jpeg|png);base64,[A-Za-z0-9+/=]+$/, "Send the map picture as a JPEG."),
      targets: z.array(z.enum(Object.keys(DETECT_TARGETS) as [DetectTarget, ...DetectTarget[]])).min(1).max(3),
    }),
  );
  // Each run costs the business money at fal, so a stuck button can't run up a bill.
  if (!(await allow(c.env, `paving-detect:${c.var.companyId}`, 30, 10 * 60))) throw new HttpError(429, "That's a lot of searches in a few minutes. Wait a little and try again.");
  const secret = await loadSecret(c.env, adminClient(c.env), c.var.companyId, "fal").catch(() => null);
  if (!secret?.api_key) throw new HttpError(400, "Find paving needs fal.ai. An owner or admin can install it on the Apps page.");
  const results = await detect(secret.api_key, body.image, [...new Set(body.targets)]);
  return c.json({ results });
});

/** The paving services a price list is missing (matched by name), added from the paving preset. */
paving.post("/paving/services", requireUser, requireCompany(ADMINS, "settings"), async (c) => {
  return c.json({ added: await addMissingServices(c.var.db, c.var.companyId, "paving") });
});
