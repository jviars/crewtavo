/**
 * The sign-in server's discovery document, as AI assistants' connectors read it (lib/authMetadata.ts):
 * an instance's Supabase Auth has no issuer, so its own has an empty one and bare-path endpoints, and
 * lists openid though it can't sign ID tokens with an HS256 key. Crewtavo serves it fixed, at every
 * address connectors look, and a sign-in that asks for openid anyway goes ahead without it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import type { Env } from "../src/env";
import { fixAuthMetadata, withoutOpenId } from "../src/lib/authMetadata";
import { gateway } from "../src/lib/gateway";

/** What an instance's Auth (GOTRUE_JWT_ISSUER unset) serves at /.well-known/oauth-authorization-server. */
const INSTANCE_AUTH = {
  issuer: "",
  authorization_endpoint: "/oauth/authorize",
  token_endpoint: "/oauth/token",
  jwks_uri: "/.well-known/jwks.json",
  userinfo_endpoint: "/oauth/userinfo",
  registration_endpoint: "/oauth/clients/register",
  scopes_supported: ["openid", "profile", "email", "phone", "offline_access"],
  code_challenge_methods_supported: ["S256", "plain"],
};

const env: Env = {
  SUPABASE_URL: "http://127.0.0.1:8080",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  APP_URL: "https://ops.example.com",
  CREWTAVO_GATEWAY: "1",
};

/** Auth at `auth`, with an HS256 key only (an empty JWKS) unless `keys` says otherwise. */
function auth(base: string, keys: object[] = []) {
  const sent: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    sent.push(url.pathname + url.search);
    if (!url.href.startsWith(base)) return new Response("not here", { status: 404 });
    const path = url.href.slice(base.length);
    if (path === "/.well-known/oauth-authorization-server" || path === "/.well-known/openid-configuration") return Response.json(INSTANCE_AUTH);
    if (path === "/.well-known/jwks.json") return Response.json({ keys });
    return Response.json({ ok: true });
  });
  return sent;
}

afterEach(() => vi.unstubAllGlobals());

describe("fixing the document", () => {
  it("fills in an instance's issuer and endpoints, and drops openid when ID tokens can't be signed", () => {
    expect(fixAuthMetadata(INSTANCE_AUTH, "https://ops.example.com/auth/v1/", false)).toEqual({
      issuer: "https://ops.example.com/auth/v1",
      authorization_endpoint: "https://ops.example.com/auth/v1/oauth/authorize",
      token_endpoint: "https://ops.example.com/auth/v1/oauth/token",
      jwks_uri: "https://ops.example.com/auth/v1/.well-known/jwks.json",
      userinfo_endpoint: "https://ops.example.com/auth/v1/oauth/userinfo",
      registration_endpoint: "https://ops.example.com/auth/v1/oauth/clients/register",
      scopes_supported: ["profile", "email", "phone", "offline_access"],
      code_challenge_methods_supported: ["S256", "plain"],
    });
    expect(fixAuthMetadata(INSTANCE_AUTH, "https://ops.example.com/auth/v1", true).scopes_supported).toContain("openid");
  });

  it("leaves a Supabase project's own document as it was", () => {
    const hosted = { ...INSTANCE_AUTH, issuer: "https://abc.supabase.co/auth/v1", authorization_endpoint: "https://abc.supabase.co/auth/v1/oauth/authorize" };
    expect(fixAuthMetadata(hosted, "https://elsewhere.example/auth/v1", true)).toEqual({ ...hosted, jwks_uri: "https://abc.supabase.co/auth/v1/.well-known/jwks.json", token_endpoint: "https://abc.supabase.co/auth/v1/oauth/token", userinfo_endpoint: "https://abc.supabase.co/auth/v1/oauth/userinfo", registration_endpoint: "https://abc.supabase.co/auth/v1/oauth/clients/register" });
  });

  it("takes openid out of a sign-in that asks for it", () => {
    const authorize = (scope?: string) => new URL(`https://ops.example.com/auth/v1/oauth/authorize?client_id=c${scope === undefined ? "" : `&scope=${encodeURIComponent(scope)}`}`);
    expect(withoutOpenId(authorize("openid offline_access email"))?.searchParams.get("scope")).toBe("offline_access email");
    expect(withoutOpenId(authorize("openid"))?.searchParams.has("scope")).toBe(false);
    expect(withoutOpenId(authorize("offline_access"))).toBeNull();
    expect(withoutOpenId(authorize())).toBeNull();
  });
});

describe("an instance", () => {
  const ask = (path: string) => new Request(`http://localhost:8080${path}`);

  it("serves Auth's document fixed at Auth's own addresses", async () => {
    auth("http://auth.one:9999");
    const routes = gateway(env, { auth: "http://auth.one:9999", rest: "http://rest.internal:3000", storage: "http://storage.internal:5000" });
    for (const doc of ["oauth-authorization-server", "openid-configuration"]) {
      const metadata = await (await routes.fetch(ask(`/auth/v1/.well-known/${doc}`), {})).json();
      expect(metadata).toMatchObject({ issuer: "https://ops.example.com/auth/v1", registration_endpoint: "https://ops.example.com/auth/v1/oauth/clients/register" });
      expect(metadata.scopes_supported).not.toContain("openid");
    }
  });

  it("serves it at the RFC 8414 and OpenID addresses on its own origin too, with the issuer the connector was given", async () => {
    // In an instance, SUPABASE_URL is this server itself: the gateway's answer, as above.
    auth("http://127.0.0.1:8080/auth/v1");
    const resource = await (await app.request("/.well-known/oauth-protected-resource/mcp", undefined, env)).json();
    for (const path of ["/.well-known/oauth-authorization-server/auth/v1", "/.well-known/openid-configuration/auth/v1", "/.well-known/oauth-authorization-server"]) {
      const res = await app.request(path, undefined, env);
      expect(res.status, path).toBe(200);
      const metadata = await res.json();
      // ChatGPT compares these as exact strings.
      expect(metadata.issuer, path).toBe(resource.authorization_servers[0]);
      expect(metadata.authorization_endpoint, path).toBe("https://ops.example.com/auth/v1/oauth/authorize");
      expect(metadata.scopes_supported, path).toEqual(["profile", "email", "phone", "offline_access"]);
    }
  });

  it("signs a connector in without an ID token Auth can't make", async () => {
    const sent = auth("http://auth.two:9999");
    const routes = gateway(env, { auth: "http://auth.two:9999", rest: "http://rest.internal:3000", storage: "http://storage.internal:5000" });
    await routes.fetch(ask("/auth/v1/oauth/authorize?client_id=c&scope=openid%20offline_access&code_challenge=x"), {});
    expect(sent.at(-1)).toBe("/oauth/authorize?client_id=c&scope=offline_access&code_challenge=x");
  });

  it("keeps openid once Auth has a key to sign ID tokens with", async () => {
    const sent = auth("http://auth.three:9999", [{ kty: "EC", crv: "P-256", x: "x", y: "y" }]);
    const routes = gateway(env, { auth: "http://auth.three:9999", rest: "http://rest.internal:3000", storage: "http://storage.internal:5000" });
    await routes.fetch(ask("/auth/v1/oauth/authorize?client_id=c&scope=openid%20offline_access"), {});
    expect(sent.at(-1)).toBe("/oauth/authorize?client_id=c&scope=openid%20offline_access");
    expect((await (await routes.fetch(ask("/auth/v1/.well-known/openid-configuration"), {})).json()).scopes_supported).toContain("openid");
  });
});
