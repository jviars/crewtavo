/** Apps page: catalog with status, OAuth connect/callback/disconnect, API keys, and AI helpers. */
import { ADMINS } from "@crewtavo/core";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import type { AppEnv, Env } from "../env";
import { requireCompany, requireUser } from "../lib/auth";
import { randomId, signToken, verifyToken } from "../lib/crypto";
import { appUrl, dbError, HttpError, must, readJson } from "../lib/http";
import { adminClient, type Db } from "../lib/supabase";
import { complete } from "../services/ai";
import { describeAccount } from "../integrations/accounting";
import { CATALOG, catalogEntry, OAUTH, UntrustedServerError, type Provider } from "../integrations/registry";
import { exchangeCode, loadSecret, revoke, saveSecret } from "../integrations/tokens";

export const apps = new Hono<AppEnv>();

const STATE_COOKIE = "crewtavo_oauth_nonce";
const callbackUrl = (base: string, provider: string) => `${base}/api/apps/${provider}/callback`;

apps.get("/apps", requireUser, requireCompany(ADMINS, "apps"), async (c) => {
  const rows = must(
    await c.var.db
      .from("integrations")
      .select("provider, status, account_label, connected_at, last_sync_at, last_error")
      .eq("company_id", c.var.companyId),
  );
  const byProvider = new Map(rows.map((r) => [r.provider, r]));
  return c.json({
    mcp_url: `${appUrl(c)}/mcp`,
    apps: CATALOG.map(({ available, ...entry }) => ({
      ...entry,
      available: available(c.env),
      redirect_uri: OAUTH[entry.provider] ? callbackUrl(appUrl(c), entry.provider) : null,
      ...(byProvider.get(entry.provider) ?? { status: "disconnected" }),
    })),
  });
});

/** Step 1: returns the provider's sign-in URL. The signed state is also bound to an httpOnly cookie. */
apps.post("/apps/:provider/connect", requireUser, requireCompany(ADMINS, "apps"), async (c) => {
  const provider = c.req.param("provider") as Provider;
  const entry = catalogEntry(provider);
  const config = OAUTH[provider];
  if (!entry || !config || !entry.available(c.env)) throw new HttpError(400, "That app isn't available yet.");

  const nonce = randomId();
  const state = await signToken(c.env, {
    company: c.var.companyId,
    user: c.var.userId,
    provider,
    nonce,
    exp: Math.floor(Date.now() / 1000) + 600,
  });
  setCookie(c, STATE_COOKIE, nonce, { httpOnly: true, secure: true, sameSite: "Lax", path: "/api/apps", maxAge: 600 });

  const params = new URLSearchParams({
    client_id: config.clientId(c.env)!,
    response_type: "code",
    scope: config.scope,
    redirect_uri: callbackUrl(appUrl(c), provider),
    state,
    ...config.extraParams,
  });
  return c.json({ authorization_url: `${config.authorizeUrl(c.env)}?${params}` });
});

/** Step 2: the provider redirects the browser here. No bearer token; identity comes from the signed state. */
apps.get("/apps/:provider/callback", async (c) => {
  const provider = c.req.param("provider") as Provider;
  const query = c.req.query();
  const done = (status: "connected" | "error", message?: string) =>
    c.redirect(`${appUrl(c)}/apps?${new URLSearchParams({ app: provider, status, ...(message ? { message } : {}) })}`);

  const state = query.state ? await verifyToken<{ company: string; user: string; provider: string; nonce: string; exp: number }>(c.env, query.state) : null;
  const nonce = getCookie(c, STATE_COOKIE);
  deleteCookie(c, STATE_COOKIE, { path: "/api/apps" });
  if (!state || state.provider !== provider || !nonce || nonce !== state.nonce) return done("error", "The sign-in link expired. Try connecting again.");
  if (query.error || !query.code) return done("error", query.error_description ?? query.error ?? "Sign-in was cancelled.");

  const admin = adminClient(c.env);
  try {
    const secret = await exchangeCode(c.env, provider, query.code, callbackUrl(appUrl(c), provider), { query });
    const account = await describeAccount(c.env, provider, secret.access_token!, query, secret.extra);
    // The integrations row must exist before its secret (foreign key).
    const { error } = await admin.from("integrations").upsert({
      company_id: state.company,
      provider,
      status: "connected",
      account_label: account.account_label,
      external_account_id: account.external_account_id,
      connected_by: state.user,
      connected_at: new Date().toISOString(),
      last_error: null,
    });
    if (error) throw new Error(error.message);
    await saveSecret(c.env, admin, state.company, provider, secret);
    return done("connected");
  } catch (error) {
    console.error("OAuth callback failed", provider, error);
    // Refusing a server that isn't the provider's says so; other failures stay general.
    return done("error", error instanceof UntrustedServerError ? error.message : "Couldn't finish connecting. Check the app's settings and try again.");
  }
});

apps.post("/apps/:provider/disconnect", requireUser, requireCompany(ADMINS, "apps"), async (c) => {
  const provider = c.req.param("provider") as Provider;
  const admin = adminClient(c.env);
  const secret = await loadSecret(c.env, admin, c.var.companyId, provider).catch(() => null);
  if (secret) await revoke(c.env, provider, secret);
  await admin.from("integration_secrets").delete().match({ company_id: c.var.companyId, provider });
  const { error } = await admin
    .from("integrations")
    .update({ status: "disconnected", account_label: null, last_error: null })
    .match({ company_id: c.var.companyId, provider });
  if (error) throw dbError(error);
  return c.json({ provider, status: "disconnected" });
});

/** API-key apps (a company's own Anthropic key, for example). The key is encrypted and never returned. */
apps.put("/apps/:provider/key", requireUser, requireCompany(ADMINS, "apps"), async (c) => {
  const provider = c.req.param("provider") as Provider;
  const entry = catalogEntry(provider);
  if (!entry || entry.auth !== "api_key") throw new HttpError(400, "That app doesn't use a key.");
  const body = await readJson(c, z.object({ api_key: z.string().trim().min(10).max(500) }));
  const admin = adminClient(c.env);
  const { error } = await admin.from("integrations").upsert({
    company_id: c.var.companyId,
    provider,
    status: "connected",
    account_label: `Key ending ${body.api_key.slice(-4)}`,
    connected_by: c.var.userId,
    connected_at: new Date().toISOString(),
  });
  if (error) throw dbError(error);
  await saveSecret(c.env, admin, c.var.companyId, provider, { api_key: body.api_key });
  return c.json({ provider, status: "connected" });
});

// ---------------------------------------------------------------------------------------------
// AI helpers (use the company's own Anthropic key when it has one)
// ---------------------------------------------------------------------------------------------

export async function companyAnthropicKey(env: Env, admin: Db, companyId: string): Promise<string | null> {
  const secret = await loadSecret(env, admin, companyId, "anthropic").catch(() => null);
  return secret?.api_key ?? null;
}

apps.post("/ai/rewrite", requireUser, requireCompany(), async (c) => {
  const body = await readJson(
    c,
    z.object({
      text: z.string().trim().min(1).max(4000),
      instruction: z.string().max(300).default("Make this clear, friendly and professional. Keep it about the same length."),
    }),
  );
  const text = await complete(c.env, {
    apiKey: await companyAnthropicKey(c.env, adminClient(c.env), c.var.companyId),
    system:
      "You edit short messages a home-services business sends to its customers. Return only the rewritten message, " +
      "with no preamble. Never add prices, dates or promises that aren't in the original.",
    prompt: `Instruction: ${body.instruction}\n\nMessage:\n${body.text}`,
    effort: "low",
    maxTokens: 1500,
  });
  return c.json({ text });
});

/** Answer a question using only the company's SOPs, with numbered citations. */
apps.post("/kb/ask", requireUser, requireCompany(), async (c) => {
  const body = await readJson(c, z.object({ question: z.string().trim().min(3).max(500) }));
  const { data, error } = await c.var.db.rpc("search_sops", { p_company: c.var.companyId, p_query: body.question, p_limit: 4 });
  if (error) throw dbError(error);
  const hits = (data ?? []) as Array<{ id: string; title: string; body_text: string }>;
  if (!hits.length) return c.json({ answer: "I couldn't find a guide that covers that. Try different words, or ask the office.", sources: [] });

  const excerpts = hits.map((h, i) => `[${i + 1}] ${h.title}\n${h.body_text.slice(0, 6000)}`).join("\n\n");
  const answer = await complete(c.env, {
    apiKey: await companyAnthropicKey(c.env, adminClient(c.env), c.var.companyId),
    system:
      "You answer questions for a field-service crew using only the SOP excerpts provided. Cite sources inline as [1], [2]. " +
      "If the excerpts don't answer the question, say so plainly. Keep answers short and practical; safety steps come first.",
    prompt: `SOP excerpts:\n${excerpts}\n\nQuestion: ${body.question}`,
    effort: "low",
    maxTokens: 1500,
  });
  return c.json({ answer, sources: hits.map((h) => ({ id: h.id, title: h.title })) });
});
