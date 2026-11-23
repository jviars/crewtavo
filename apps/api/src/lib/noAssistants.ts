/**
 * Routes that hand out something that opens Crewtavo on its own: a client's Hub link, a quote's or
 * invoice's link, a referral link, a calendar feed's address, a sub's paperwork or sign-in link. A
 * link like that works without anyone signing in, and keeps working after an AI assistant is
 * disconnected or set to look only, so an assistant's token never gets one, even where it may read
 * everything else (requireUser lets an assistant's token read). Its tools do what it's allowed to.
 * Put it after requireUser.
 */
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "../env";
import { assistantClient } from "./assistants";
import { HttpError } from "./http";

export const NO_LINKS_FOR_ASSISTANTS =
  "An AI assistant can't get links or addresses that open Crewtavo by themselves. Someone on the team can copy the link in Crewtavo.";

/** Whether this request's token is an AI assistant's (an OAuth client's), not a person's own sign-in. */
export const byAssistant = (token: string | undefined) => Boolean(token && assistantClient(token));

/** Refuses an AI assistant's token: only a person signed in to Crewtavo gets these links. */
export const noAssistants = createMiddleware<AppEnv>(async (c, next) => {
  if (byAssistant(c.var.token ?? c.req.header("authorization")?.replace(/^Bearer\s+/i, ""))) throw new HttpError(403, NO_LINKS_FOR_ASSISTANTS);
  await next();
});
