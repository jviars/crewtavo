/**
 * Signing in with a code, for a sub on a new phone (services/signInCodes.ts). No sign-in needed, so
 * they answer anyone, and limit everyone:
 *   POST /api/auth/text-code           { phone }        texts a code to a sub's sign-in; { sent: true } either way,
 *                                                        { sent: false, reason: "sms_off" } when the instance can't text
 *   POST /api/auth/text-code/verify    { phone, code }  the right code: { token_hash, type: "magiclink" } to sign in with
 *   POST /api/auth/email-code          { email }        emails a code to a sub's sign-in; always { sent: true }
 *   POST /api/auth/email-code/verify   { email, code }  the right code: { token_hash, type: "magiclink" } to sign in with
 */
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { runInBackground } from "../lib/background";
import { appUrl, readJson } from "../lib/http";
import { clientIp } from "../lib/visitor";
import { askForCode, askForEmailCode, signInWithCode, signInWithEmailCode } from "../services/signInCodes";

export const signInCodes = new Hono<AppEnv>();

const phone = z.string().trim().min(1).max(40);
const email = z.string().trim().min(1).max(254);
const code = z.string().trim().min(1).max(20);

signInCodes.post("/auth/text-code", async (c) => {
  const body = await readJson(c, z.object({ phone }));
  return c.json(await askForCode(c.env, body.phone, clientIp(c), (work) => runInBackground(c, work)));
});

signInCodes.post("/auth/text-code/verify", async (c) => {
  const body = await readJson(c, z.object({ phone, code }));
  return c.json(await signInWithCode(c.env, appUrl(c), body.phone, body.code, clientIp(c)));
});

signInCodes.post("/auth/email-code", async (c) => {
  const body = await readJson(c, z.object({ email }));
  return c.json(await askForEmailCode(c.env, appUrl(c), body.email, clientIp(c), (work) => runInBackground(c, work)));
});

signInCodes.post("/auth/email-code/verify", async (c) => {
  const body = await readJson(c, z.object({ email, code }));
  return c.json(await signInWithEmailCode(c.env, appUrl(c), body.email, body.code, clientIp(c)));
});
