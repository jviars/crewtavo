/**
 * The public demo (services/demo.ts), only when CREWTAVO_DEMO=1:
 *   POST /api/demo/start   a new copy of the sample company, signed in as its owner
 *   POST /api/demo/switch  { as: "owner" | "crew" } be someone else in your copy
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { requireUser } from "../lib/auth";
import { HttpError, readJson } from "../lib/http";
import { allow } from "../lib/limit";
import { reportError } from "../lib/monitoring";
import { clientIp } from "../lib/visitor";
import { demoEnabled, startDemo, switchDemoPerson } from "../services/demo";

export const demo = new Hono<AppEnv>();

demo.use("/demo/*", async (c, next) => {
  if (!demoEnabled(c.env)) throw new HttpError(404, "Not found");
  await next();
});

demo.post("/demo/start", async (c) => {
  // Each copy is a few hundred rows and four accounts: plenty for anyone trying it, not for a script.
  if (!(await allow(c.env, `demo-start:${clientIp(c)}`, 6, 3600))) throw new HttpError(429, "You've started a lot of demos. Wait a little and try again.");
  if (!(await allow(c.env, "demo-start:all", 300, 3600))) throw new HttpError(429, "The demo is very busy right now. Try again in a few minutes.");
  try {
    return c.json(await startDemo(c.env), 201);
  } catch (error) {
    console.error("Demo start failed", error);
    reportError(error, { route: "demo/start" });
    throw new HttpError(503, "Couldn't set up the demo company. Try again in a moment.");
  }
});

demo.post("/demo/switch", requireUser, async (c) => {
  const body = await readJson(c, z.object({ as: z.enum(["owner", "crew"]) }));
  return c.json(await switchDemoPerson(c.env, c.var.userId, body.as));
});
