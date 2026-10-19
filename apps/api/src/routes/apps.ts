/** Apps page: catalog with status, OAuth connect/callback/disconnect, API keys, and AI helpers. */
import { ADMINS } from "@crewtavo/core";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import type { AppEnv, Env } from "../env";
import { requireCompany, requireUser } from "../lib/auth";
import { runInBackground } from "../lib/background";
import { randomId, signToken, verifyToken } from "../lib/crypto";
import { appUrl, dbError, HttpError, isoDate, must, readJson } from "../lib/http";
import { adminClient, type Db } from "../lib/supabase";
import { complete } from "../services/ai";
import { describeAccount } from "../integrations/accounting";
import { deleteVisitsCalendar, describeGoogleAccount, pushUpcomingVisits } from "../integrations/calendars";
import { CATALOG, catalogEntry, isCalendarApp, OAUTH, UntrustedServerError, type Provider } from "../integrations/registry";
import { beginStripeImport, canImportStripe, connectStripe, disconnectStripe, IMPORT_STALE_MS, importFromStripe, SHARED_STRIPE_IMPORT, stripeAccess, type ImportState } from "../integrations/stripe";
import { exchangeCode, loadSecret, revoke, saveSecret } from "../integrations/tokens";

export const apps = new Hono<AppEnv>();

const STATE_COOKIE = "crewtavo_oauth_nonce";
const callbackUrl = (base: string, provider: string) => `${base}/api/apps/${provider}/callback`;

apps.get("/apps", requireUser, requireCompany(ADMINS, "apps"), async (c) => {
  const [rows, calendars, stripeKey, company] = await Promise.all([
    c.var.db.from("integrations").select("provider, status, account_label, connected_at, last_sync_at, last_error, settings").eq("company_id", c.var.companyId),
    c.var.db.from("calendar_sources").select("app, last_error").eq("company_id", c.var.companyId),
    adminClient(c.env).from("integration_secrets").select("provider", { count: "exact", head: true }).match({ company_id: c.var.companyId, provider: "stripe" }),
    c.var.db.from("companies").select("settings").eq("id", c.var.companyId).maybeSingle(),
  ]);
  const integrations = must(rows);
  // Built-in apps are on or off in the company's settings (team chat: routes/chat.ts).
  const builtinOn: Record<string, boolean> = { team_chat: (company.data?.settings as { team_chat?: { enabled?: boolean } } | null)?.team_chat?.enabled === true };
  const byProvider = new Map(integrations.map(({ settings, ...r }) => [r.provider, r]));
  const calendarRows = must(calendars);
  const ownKey = Boolean(stripeKey.count);
  const stripeSettings = (integrations.find((r) => r.provider === "stripe")?.settings ?? {}) as { webhook?: boolean; livemode?: boolean; import?: ImportState };
  // The deployment's own Stripe account, for companies that haven't added theirs.
  const serverStripe = !ownKey && Boolean(c.env.STRIPE_SECRET_KEY);
  if (serverStripe) byProvider.set("stripe", { provider: "stripe", status: "connected", account_label: "Set up for this server", connected_at: null, last_sync_at: null, last_error: null });
  const stripe = ownKey || serverStripe
    ? {
        own: ownKey,
        webhook: ownKey ? stripeSettings.webhook !== false : true,
        livemode: ownKey ? stripeSettings.livemode !== false : !c.env.STRIPE_SECRET_KEY?.includes("_test_"),
        import: stripeSettings.import ?? null,
      }
    : null;
  return c.json({
    mcp_url: `${appUrl(c)}/mcp`,
    apps: CATALOG.map(({ available, ...entry }) => {
      const own = calendarRows.filter((s) => s.app === entry.id);
      const linked = isCalendarApp(entry.id) ? { calendars: own.length, calendar_errors: own.filter((s) => s.last_error).length } : {};
      const row = byProvider.get(entry.id);
      return {
        ...entry,
        available: available(c.env),
        redirect_uri: OAUTH[entry.id as Provider] ? callbackUrl(appUrl(c), entry.id) : null,
        ...(row ?? { status: (entry.auth === "link" && own.length) || builtinOn[entry.id] ? "connected" : "disconnected" }),
        ...linked,
        ...(entry.id === "stripe" && stripe ? { stripe } : {}),
      };
    }),
  });
});

/** Bring in past invoices, payments and deposits from Stripe. Runs in the background; GET /apps shows progress. */
apps.post("/apps/stripe/import", requireUser, requireCompany(ADMINS, "apps"), async (c) => {
  const body = await readJson(c, z.object({ since: isoDate.nullable().default(null) }));
  const admin = adminClient(c.env);
  const access = await stripeAccess(c.env, admin, c.var.companyId);
  if (!access) throw new HttpError(400, "Connect Stripe first.");
  if (!(await canImportStripe(c.env, admin, c.var.companyId, access))) throw new HttpError(400, SHARED_STRIPE_IMPORT);
  const { data: row } = await admin.from("integrations").select("settings").match({ company_id: c.var.companyId, provider: "stripe" }).maybeSingle();
  const running = (row?.settings as { import?: ImportState } | undefined)?.import;
  if (running?.status === "running" && Date.now() - Date.parse(running.started_at) < IMPORT_STALE_MS) throw new HttpError(409, "An import is already running.");
  if (!row) {
    // Using the deployment's Stripe account: the import's progress needs somewhere to live.
    await admin.from("integrations").upsert({ company_id: c.var.companyId, provider: "stripe", status: "disconnected", account_label: "Set up for this server" });
  }
  const state = await beginStripeImport(admin, c.var.companyId, body.since);
  runInBackground(c, importFromStripe(c.env, admin, c.var.companyId, state));
  return c.json({ status: "running" }, 202);
});

/** Step 1: returns the provider's sign-in URL. The signed state is also bound to an httpOnly cookie. */
apps.post("/apps/:provider/connect", requireUser, requireCompany(ADMINS, "apps"), async (c) => {
  const provider = c.req.param("provider") as Provider;
  const entry = catalogEntry(provider);
  const config = OAUTH[provider];
  if (!entry || !config || entry.auth !== "oauth" || !entry.available(c.env)) throw new HttpError(400, "That app isn't available yet.");

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
  // Back to the app's own page, which says how it went.
  const done = (status: "connected" | "error", message?: string) =>
    c.redirect(`${appUrl(c)}/apps/${catalogEntry(provider) ? provider : ""}?${new URLSearchParams({ status, ...(message ? { message } : {}) })}`);

  const state = query.state ? await verifyToken<{ company: string; user: string; provider: string; nonce: string; exp: number }>(c.env, query.state) : null;
  const nonce = getCookie(c, STATE_COOKIE);
  deleteCookie(c, STATE_COOKIE, { path: "/api/apps" });
  if (!state || state.provider !== provider || !nonce || nonce !== state.nonce) return done("error", "The sign-in link expired. Try connecting again.");
  if (query.error || !query.code) return done("error", query.error_description ?? query.error ?? "Sign-in was cancelled.");

  const admin = adminClient(c.env);
  try {
    const secret = await exchangeCode(c.env, provider, query.code, callbackUrl(appUrl(c), provider), { query });
    const account = provider === "google_calendar"
      ? await describeGoogleAccount(secret.access_token!)
      : await describeAccount(c.env, provider, secret.access_token!, query, secret.extra);
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
    // Reconnected while visits go to Google: changes made while it needed reconnecting weren't
    // queued, so bring the visits calendar in line again (visits cancelled or deleted meanwhile
    // come off it too).
    if (provider === "google_calendar") runInBackground(c, pushUpcomingVisits(c.env, admin, state.company));
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
  if (provider === "google_calendar") {
    // Take the visits calendar out of the Google account while we still can, and stop showing
    // its calendars on the schedule. Calendars added by link stay.
    const { data } = await admin.from("integrations").select("settings").eq("company_id", c.var.companyId).eq("provider", provider).maybeSingle();
    const pushId = (data?.settings as { push_calendar_id?: string } | null)?.push_calendar_id;
    if (pushId) await deleteVisitsCalendar(c.env, admin, c.var.companyId, pushId).catch((error) => console.error("Couldn't remove the visits calendar", error));
    await admin.from("calendar_sources").delete().match({ company_id: c.var.companyId, kind: "google" });
    await admin.from("outbox").update({ done_at: new Date().toISOString() }).match({ company_id: c.var.companyId, topic: "calendar.visit" }).is("done_at", null);
  }
  const secret = await loadSecret(c.env, admin, c.var.companyId, provider).catch(() => null);
  // Stripe's open invoices are voided with the old key, which can finish after the response.
  if (secret && provider === "stripe") runInBackground(c, (await disconnectStripe(c.env, admin, c.var.companyId, secret)).settled);
  else if (secret) await revoke(c.env, provider, secret);
  await admin.from("integration_secrets").delete().match({ company_id: c.var.companyId, provider });
  const { error } = await admin
    .from("integrations")
    .update({ status: "disconnected", account_label: null, last_error: null, ...(provider === "google_calendar" ? { settings: {} } : {}) })
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
  if (provider === "stripe") {
    const { settled, ...connected } = await connectStripe(c.env, admin, { companyId: c.var.companyId, userId: c.var.userId, key: body.api_key, baseUrl: appUrl(c) });
    runInBackground(c, settled);
    return c.json({ provider, status: "connected", ...connected });
  }
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
