/**
 * Crewtavo's own AI, where it's set up (Apps → Claude and Apps → ChatGPT; services/ai.ts decides
 * which service answers each ask):
 *
 *   PUT  /ai/service            a company with both a Claude key and an OpenAI key chooses which
 *                               one Crewtavo's AI uses.
 *   PUT  /apps/chatgpt/model    the model the company's OpenAI key uses, among the ones OpenAI
 *                               lists for it.
 *   POST /apps/chatgpt/models   asks OpenAI for that list again.
 *
 * The OpenAI key itself is saved, checked first, by PUT /apps/chatgpt/key (routes/apps.ts).
 *
 * And each person's own ChatGPT plan (integrations/chatgptPlan.ts), which answers only what that
 * person asks for themselves:
 *
 *   GET  /ai/chatgpt                  my connection: connected or not, the account, the model,
 *                                     what's in its way. Never a token.
 *   POST /ai/chatgpt/sign-in          step one: OpenAI's sign-in page to open.
 *   POST /ai/chatgpt/sign-in/finish   step two: the address the browser landed on, pasted in.
 *   POST /ai/chatgpt/disconnect       signed out at OpenAI, then forgotten here.
 *   PUT  /ai/chatgpt/model            the model my plan uses, among the ones OpenAI lists for it.
 *   POST /ai/chatgpt/models           asks OpenAI for that list again.
 *   POST /ai/chatgpt/retry            try my plan again now, after its usage limit or "not eligible".
 *   POST /ai/chatgpt/notice           "You're using your ChatGPT plan" was read.
 *   PUT  /ai/team-plans               owners and admins let everyone on the team connect theirs, or not.
 *
 * Owners and admins who manage apps can always connect their own plan; everyone else on the team
 * can once the company allows it (settings.ai.team_plans), since what they ask then goes to OpenAI
 * on their own account. Never a subcontractor.
 */
import { ADMINS } from "@crewtavo/core";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { choosePlanModel, disconnectPlan, endTeamPlans, finishSignIn, loadPlan, markNoticeSeen, notePlanProblem, planStatus, PlanTrouble, REDIRECT_URI, refreshPlanModels, startSignIn, USAGE_URL, type Person } from "../integrations/chatgptPlan";
import { checkOpenAiKey, OpenAiProblem, pickModel } from "../integrations/openai";
import { loadSecret } from "../integrations/tokens";
import { requireCompany, requireUser } from "../lib/auth";
import { asJson, dbError, HttpError, readJson } from "../lib/http";
import { allow } from "../lib/limit";
import { adminClient } from "../lib/supabase";
import { companyAi, teamPlans, type OpenAiSettings } from "../services/ai";

export const chatgpt = new Hono<AppEnv>();

/**
 * Which of the company's two keys Crewtavo's AI uses. Only a choice between keys that are there:
 * with one key, that one is used whatever was chosen before.
 */
chatgpt.put("/ai/service", requireUser, requireCompany(ADMINS, "apps"), async (c) => {
  const body = await readJson(c, z.object({ service: z.enum(["claude", "chatgpt"]) }));
  const admin = adminClient(c.env);
  const [claude, openai] = await Promise.all([loadSecret(c.env, admin, c.var.companyId, "anthropic").catch(() => null), loadSecret(c.env, admin, c.var.companyId, "chatgpt").catch(() => null)]);
  if (!(body.service === "claude" ? claude : openai)?.api_key) {
    throw new HttpError(400, body.service === "claude" ? "Add a Claude key under Apps → Claude first." : "Add an OpenAI key under Apps → ChatGPT first.");
  }
  // As the owner or admin, so the database checks who may change the company's settings.
  const { error } = await c.var.db.rpc("merge_company_settings", { p_company: c.var.companyId, p_settings: { ai: { service: body.service } } });
  if (error) throw dbError(error);
  return c.json({ service: (await companyAi(c.env, admin, c.var.companyId))?.service ?? null });
});

/** The company's OpenAI key and what's kept beside it, or a refusal when there's no key. */
async function openAiKey(c: { env: AppEnv["Bindings"]; var: { companyId: string } }) {
  const admin = adminClient(c.env);
  const secret = await loadSecret(c.env, admin, c.var.companyId, "chatgpt").catch(() => null);
  if (!secret?.api_key) throw new HttpError(409, "Add an OpenAI key first.");
  const { data, error } = await admin.from("integrations").select("settings").eq("company_id", c.var.companyId).eq("provider", "chatgpt").maybeSingle();
  if (error) throw dbError(error);
  return { admin, apiKey: secret.api_key, settings: (data?.settings ?? {}) as OpenAiSettings };
}

chatgpt.put("/apps/chatgpt/model", requireUser, requireCompany(ADMINS, "apps"), async (c) => {
  const body = await readJson(c, z.object({ model: z.string().trim().min(1).max(200) }));
  if (c.env.OPENAI_MODEL) throw new HttpError(409, `This server is set to use ${c.env.OPENAI_MODEL} (OPENAI_MODEL), so the model can't be changed here.`);
  const { admin, settings } = await openAiKey(c);
  if (!(settings.models ?? []).some((m) => m.slug === body.model)) throw new HttpError(400, "OpenAI doesn't list that model for your key. Check for new models, then pick one.");
  const { error } = await admin.from("integrations").update({ settings: asJson({ ...settings, model: body.model }) }).eq("company_id", c.var.companyId).eq("provider", "chatgpt");
  if (error) throw dbError(error);
  return c.json({ model: body.model });
});

/** Check for new models: the list is OpenAI's own for the key, read again (which costs nothing). */
chatgpt.post("/apps/chatgpt/models", requireUser, requireCompany(ADMINS, "apps"), async (c) => {
  const { admin, apiKey, settings } = await openAiKey(c);
  const checked = await checkOpenAiKey(c.env, apiKey);
  if ("problem" in checked) throw new HttpError(502, checked.problem);
  const model = pickModel(c.env, checked.models, settings.model);
  const { error } = await admin.from("integrations").update({ settings: asJson({ ...settings, model: c.env.OPENAI_MODEL ? (settings.model ?? null) : model, models: checked.models }) }).eq("company_id", c.var.companyId).eq("provider", "chatgpt");
  if (error) throw dbError(error);
  return c.json({ model, models: checked.models, model_locked: Boolean(c.env.OPENAI_MODEL) });
});

// ---------------------------------------------------------------------------------------------
// A person's own ChatGPT plan
// ---------------------------------------------------------------------------------------------

type Ctx = Context<AppEnv>;
const person = (c: Ctx): Person => ({ userId: c.var.userId, companyId: c.var.companyId });

async function companySettings(c: Ctx): Promise<unknown> {
  const { data, error } = await adminClient(c.env).from("companies").select("settings").eq("id", c.var.companyId).maybeSingle();
  if (error) throw dbError(error);
  return data?.settings ?? {};
}

/** Owners and admins who manage apps can connect their plan; so can the rest of the team once the company allows it. */
const mayConnect = (c: Ctx, settings: unknown) => (ADMINS.includes(c.var.role) && c.var.permissions.includes("apps")) || teamPlans(settings);
const NOT_ALLOWED = "Your company hasn't turned on using your own ChatGPT plan. An owner or admin can, under Apps → ChatGPT.";
const SLOW_DOWN = "That's a lot of sign-ins in an hour. Wait a while and try again.";

chatgpt.get("/ai/chatgpt", requireUser, requireCompany(), async (c) => {
  const admin = adminClient(c.env);
  const [settings, row, company] = await Promise.all([companySettings(c), loadPlan(admin, person(c)), companyAi(c.env, admin, c.var.companyId)]);
  return c.json({
    allowed: mayConnect(c, settings),
    team_plans: teamPlans(settings),
    plan: planStatus(c.env, row),
    // Whether the company (or the server) has a key that answers when the plan can't.
    fallback: Boolean(company),
    redirect_uri: REDIRECT_URI,
    usage_url: USAGE_URL,
  });
});

/** Step one. What comes back is OpenAI's page to open and nothing secret: the sign-in's one-time values stay here, sealed. */
chatgpt.post("/ai/chatgpt/sign-in", requireUser, requireCompany(), async (c) => {
  const body = await readJson(c, z.object({ fresh: z.boolean().default(false) }));
  if (!mayConnect(c, await companySettings(c))) throw new HttpError(403, NOT_ALLOWED);
  if (!(await allow(c.env, `chatgpt-sign-in:${c.var.userId}`, 20, 3600))) throw new HttpError(429, SLOW_DOWN);
  return c.json(await startSignIn(c.env, adminClient(c.env), person(c), { fresh: body.fresh }));
});

/** Step two: the address pasted in. Only this person's own sign-in, started here, finishes (integrations/chatgptPlan.ts finishSignIn). */
chatgpt.post("/ai/chatgpt/sign-in/finish", requireUser, requireCompany(), async (c) => {
  const body = await readJson(c, z.object({ address: z.string().trim().min(1, "Paste the address from your browser's address bar.").max(6000, "That's too long to be the address. Copy it from the address bar again.") }));
  if (!mayConnect(c, await companySettings(c))) throw new HttpError(403, NOT_ALLOWED);
  if (!(await allow(c.env, `chatgpt-sign-in-finish:${c.var.userId}`, 30, 3600))) throw new HttpError(429, SLOW_DOWN);
  return c.json({ plan: planStatus(c.env, await finishSignIn(c.env, adminClient(c.env), person(c), body.address)) });
});

/** Always the person's own to do, whatever the company allows now. */
chatgpt.post("/ai/chatgpt/disconnect", requireUser, requireCompany(), async (c) => {
  const admin = adminClient(c.env);
  const { revoked } = await disconnectPlan(c.env, admin, person(c));
  return c.json({ plan: planStatus(c.env, await loadPlan(admin, person(c))), revoked });
});

chatgpt.put("/ai/chatgpt/model", requireUser, requireCompany(), async (c) => {
  const body = await readJson(c, z.object({ model: z.string().trim().min(1).max(200) }));
  const admin = adminClient(c.env);
  await choosePlanModel(c.env, admin, person(c), body.model);
  return c.json({ plan: planStatus(c.env, await loadPlan(admin, person(c))) });
});

chatgpt.post("/ai/chatgpt/models", requireUser, requireCompany(), async (c) => {
  const admin = adminClient(c.env);
  try {
    return c.json({ plan: planStatus(c.env, await refreshPlanModels(c.env, admin, person(c))) });
  } catch (error) {
    if (error instanceof PlanTrouble && error.kind === "sign_in") throw new HttpError(409, "Your ChatGPT sign-in has ended. Sign in again.");
    if (error instanceof PlanTrouble || error instanceof OpenAiProblem) throw new HttpError(502, "ChatGPT didn't list your plan's models. Try again in a minute.");
    throw error;
  }
});

/** Try again: the pause after the usage limit or "not eligible" ends now, so the next ask goes to the plan. */
chatgpt.post("/ai/chatgpt/retry", requireUser, requireCompany(), async (c) => {
  const admin = adminClient(c.env);
  const row = await loadPlan(admin, person(c));
  if (row?.status === "connected" && (row.problem === "usage_limit" || row.problem === "not_eligible")) await notePlanProblem(admin, person(c), null);
  return c.json({ plan: planStatus(c.env, await loadPlan(admin, person(c))) });
});

chatgpt.post("/ai/chatgpt/notice", requireUser, requireCompany(), async (c) => {
  await markNoticeSeen(adminClient(c.env), person(c));
  return c.json({ notice_seen: true });
});

/**
 * Let everyone on the team connect their own ChatGPT plan, or only owners and admins. Turning it
 * off disconnects the plans of everyone but the owners and admins right away.
 */
chatgpt.put("/ai/team-plans", requireUser, requireCompany(ADMINS, "apps"), async (c) => {
  const body = await readJson(c, z.object({ on: z.boolean() }));
  // As the owner or admin, so the database checks who may change the company's settings.
  const { error } = await c.var.db.rpc("merge_company_settings", { p_company: c.var.companyId, p_settings: { ai: { team_plans: body.on } } });
  if (error) throw dbError(error);
  if (!body.on) {
    const admin = adminClient(c.env);
    const { data: keep, error: readError } = await admin.from("memberships").select("user_id").eq("company_id", c.var.companyId).eq("active", true).in("role", ["owner", "admin"]);
    if (readError) throw dbError(readError);
    await endTeamPlans(admin, c.var.companyId, (keep ?? []).map((m) => m.user_id));
  }
  return c.json({ team_plans: body.on });
});
