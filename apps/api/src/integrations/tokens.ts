import type { Db } from "../lib/supabase";
/**
 * OAuth code exchange, refresh and revocation, plus encrypted storage of the results.
 * Everything here uses the admin client: integration_secrets is unreadable to users by design.
 */
import type { Env } from "../env";
import { decryptJson, encryptJson } from "../lib/crypto";
import { IntegrationError, OAUTH, providerTimeout, zohoAccountsServer, zohoApiDomain, type CallbackContext, type Provider } from "./registry";

export { IntegrationError };

export interface StoredSecret {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number; // ms since epoch
  api_key?: string;
  /** Provider details needed later, e.g. Zoho's accounts server and API domain. */
  extra?: Record<string, string>;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  api_domain?: string;
  error?: string;
}

async function tokenRequest(env: Env, provider: Provider, form: Record<string, string>, ctx?: CallbackContext, saved?: Record<string, string>) {
  const config = OAUTH[provider];
  if (!config) throw new IntegrationError(`${provider} doesn't use OAuth`);
  const clientId = config.clientId(env);
  const clientSecret = config.clientSecret(env);
  if (!clientId || !clientSecret) throw new IntegrationError(`${provider} isn't configured on this server`);

  const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
  const body = new URLSearchParams(form);
  if (config.clientAuth === "basic") headers.Authorization = `Basic ${btoa(`${clientId}:${clientSecret}`)}`;
  else {
    body.set("client_id", clientId);
    body.set("client_secret", clientSecret);
  }
  const response = await fetch(config.tokenUrl(env, ctx, saved), { method: "POST", headers, body, signal: providerTimeout() });
  const json = (await response.json().catch(() => ({}))) as TokenResponse;
  if (!response.ok || !json.access_token) {
    throw new IntegrationError(`${provider} token request failed (${response.status}${json.error ? `: ${json.error}` : ""})`);
  }
  return json;
}

export async function exchangeCode(env: Env, provider: Provider, code: string, redirectUri: string, ctx: CallbackContext): Promise<StoredSecret> {
  const json = await tokenRequest(env, provider, { grant_type: "authorization_code", code, redirect_uri: redirectUri }, ctx);
  const extra: Record<string, string> = {};
  if (provider === "zoho_books") {
    // Both come from outside (the callback URL and the token response): only Zoho's servers are kept.
    if (ctx.query["accounts-server"]) extra.accounts_server = zohoAccountsServer(ctx.query["accounts-server"]);
    extra.api_domain = zohoApiDomain(json.api_domain);
  }
  return {
    access_token: json.access_token,
    refresh_token: json.refresh_token,
    expires_at: Date.now() + (json.expires_in ?? 3600) * 1000,
    extra,
  };
}

export async function saveSecret(env: Env, admin: Db, companyId: string, provider: Provider, secret: StoredSecret) {
  const { error } = await admin.from("integration_secrets").upsert({
    company_id: companyId,
    provider,
    ciphertext: await encryptJson(env, secret),
    expires_at: secret.expires_at ? new Date(secret.expires_at).toISOString() : null,
    updated_at: new Date().toISOString(),
  });
  if (error) throw new IntegrationError(`Couldn't store ${provider} credentials: ${error.message}`);
}

export async function loadSecret(env: Env, admin: Db, companyId: string, provider: Provider): Promise<StoredSecret | null> {
  const { data, error } = await admin
    .from("integration_secrets")
    .select("ciphertext")
    .eq("company_id", companyId)
    .eq("provider", provider)
    .maybeSingle();
  if (error) throw new IntegrationError(error.message);
  return data ? decryptJson<StoredSecret>(env, data.ciphertext) : null;
}

/** A valid access token, refreshed (and re-saved) when it's within two minutes of expiring. */
export async function accessToken(env: Env, admin: Db, companyId: string, provider: Provider): Promise<{ token: string; secret: StoredSecret }> {
  const secret = await loadSecret(env, admin, companyId, provider);
  if (!secret?.access_token) throw new IntegrationError(`${provider} isn't connected`);
  if (!secret.expires_at || secret.expires_at - Date.now() > 120_000) return { token: secret.access_token, secret };
  if (!secret.refresh_token) throw new IntegrationError(`${provider} needs to be reconnected`);

  try {
    const json = await tokenRequest(env, provider, { grant_type: "refresh_token", refresh_token: secret.refresh_token }, undefined, secret.extra);
    const refreshed: StoredSecret = {
      ...secret,
      access_token: json.access_token,
      refresh_token: json.refresh_token ?? secret.refresh_token, // Zoho keeps the old one
      expires_at: Date.now() + (json.expires_in ?? 3600) * 1000,
    };
    await saveSecret(env, admin, companyId, provider, refreshed);
    return { token: refreshed.access_token!, secret: refreshed };
  } catch (error) {
    await admin
      .from("integrations")
      .update({ status: "error", last_error: "Sign-in expired. Reconnect on the Apps page." })
      .eq("company_id", companyId)
      .eq("provider", provider);
    throw error;
  }
}

/** Best-effort revocation at the provider before we forget the tokens. */
export async function revoke(env: Env, provider: Provider, secret: StoredSecret): Promise<void> {
  const config = OAUTH[provider];
  const token = secret.refresh_token ?? secret.access_token;
  if (!config?.revokeUrl || !token) return;
  try {
    const url = config.revokeUrl(env, secret.extra);
    if (provider === "quickbooks") {
      await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Basic ${btoa(`${config.clientId(env)}:${config.clientSecret(env)}`)}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ token }),
        signal: providerTimeout(),
      });
    } else {
      await fetch(`${url}?${new URLSearchParams({ token })}`, { method: "POST", signal: providerTimeout() });
    }
  } catch {
    // Revocation is a courtesy; the local tokens are deleted either way.
  }
}
