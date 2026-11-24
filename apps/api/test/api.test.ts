import { createHmac } from "node:crypto";
import { CURRENCIES, getPreset, greetingName, LEVEL_PERMISSIONS, memberPermissions, TERMS_VERSION } from "@crewtavo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import type { Env } from "../src/env";
import { decryptJson, encryptJson, hmacSha256Hex, signToken, verifyToken } from "../src/lib/crypto";
import { z } from "zod";
import { isEmail, renderEmail } from "../src/lib/email";
import { friendlyIssue } from "../src/lib/http";
import { cronMatches } from "../src/lib/cron";
import { buildCalendar } from "../src/lib/ics";
import { allow, allowStrict } from "../src/lib/limit";
import { clientLink, clientLinks, KEPT_LINK, readClientLink, sentToClient } from "../src/lib/links";
import { buildMime } from "../src/lib/smtp";
import { twilioSignature } from "../src/routes/messages";
import { TOOLS } from "../src/assistant-tools";
import { BATCH_JOBS, TOO_MANY_JOBS } from "../src/services/sales";
import { verifyStripeSignature } from "../src/services/stripe";
import { CRON_TASKS, runTask, TASKS } from "../src/tasks";

const env: Env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7))),
  CRON_SECRET: "cron-secret-value",
  APP_URL: "https://ops.example.com",
  GOOGLE_MAPS_BROWSER_KEY: "maps-browser-key",
};

const request = (path: string, init?: RequestInit) => app.request(path, init, env);

/** Change one character in the middle of the last segment (the final base64url char can be padding bits). */
function flipMiddle(token: string): string {
  const i = token.lastIndexOf(".") + Math.floor((token.length - token.lastIndexOf(".")) / 2);
  return token.slice(0, i) + (token[i] === "A" ? "B" : "A") + token.slice(i + 1);
}

describe("crypto", () => {
  it("round-trips encrypted JSON and rejects tampering", async () => {
    const sealed = await encryptJson(env, { access_token: "abc", refresh_token: "def" });
    expect(sealed).toMatch(/^v1\./);
    expect(sealed).not.toContain("abc");
    expect(await decryptJson(env, sealed)).toEqual({ access_token: "abc", refresh_token: "def" });
    await expect(decryptJson(env, flipMiddle(sealed))).rejects.toThrow();
  });

  it("signs tokens, rejects forgeries and expired ones", async () => {
    const token = await signToken(env, { id: "x", exp: Date.now() / 1000 + 60 });
    expect(await verifyToken(env, token)).toMatchObject({ id: "x" });
    expect(await verifyToken(env, flipMiddle(token))).toBeNull();
    expect(await verifyToken(env, await signToken(env, { id: "x", exp: Date.now() / 1000 - 1 }))).toBeNull();
    expect(await verifyToken({ ...env, ENCRYPTION_KEY: btoa("y".repeat(32)) }, token)).toBeNull();
  });

  it("refuses request bodies too large to be real before reading them", async () => {
    const res = await request("/api/public/forms/acme/quote", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ answers: { notes: "x".repeat(3 * 1024 * 1024) } }) });
    expect(res.status).toBe(413);
  });

  it("treats a mangled link as expired rather than failing", async () => {
    for (const token of ["a.b", "abc.!!!", "abc.a", "x.%%"]) expect(await verifyToken(env, token)).toBeNull();
    expect((await request("/api/hub/abc.!!!")).status).toBe(404);
  });

  it("reads only the two parts a token is made of, so one token can't be spelled many ways", async () => {
    const token = await signToken(env, { id: "x", exp: Date.now() / 1000 + 60 });
    expect(token.split(".")).toHaveLength(2);
    for (const spelled of [`${token}.1`, `${token}..`, `${token}..2`, `${token}.1.`, `x.${token}`]) expect(await verifyToken(env, spelled), spelled).toBeNull();
    expect(await verifyToken(env, token)).toMatchObject({ id: "x" });
    // The full stop of the sentence a link ends (a text app takes it in) is the sentence's, not the token's.
    expect(await verifyToken(env, `${token}.`)).toMatchObject({ id: "x" });
    // Every link and token the server makes is two parts.
    const url = await clientLink(env, "https://ops.example.com", { c: "company-1", t: "client", id: "client-1" });
    expect(url.split("/hub/")[1]!.split(".")).toHaveLength(2);
    expect((await request(`/api/hub/${url.split("/hub/")[1]}.1`)).status).toBe(404);
  });

  it("opens a referral, paperwork or unsubscribe link that a text app took the sentence's full stop into", async () => {
    const refer = await clientLink(env, "https://ops.example.com", { c: "company-1", t: "refer", id: "client-1" });
    const token = refer.split("/refer/")[1]!;
    expect(await readClientLink(env, `${token}.`)).toMatchObject({ t: "refer", id: "client-1" });
    expect(await readClientLink(env, `${token}.x`)).toBeNull();
  });

  it("builds client links that decode to the same record", async () => {
    const url = await clientLink(env, "https://ops.example.com", { c: "company-1", t: "quote", id: "quote-1" });
    expect(url.startsWith("https://ops.example.com/hub/")).toBe(true);
    expect(await readClientLink(env, url.split("/hub/")[1])).toMatchObject({ c: "company-1", t: "quote", id: "quote-1" });
  });

  it("never lets a link minted from another outlive it", async () => {
    const soon = Math.floor(Date.now() / 1000) + 3600;
    const minted = await readClientLink(env, (await clientLink(env, "https://ops.example.com", { c: "company-1", t: "quote", id: "quote-1", exp: soon })).split("/hub/")[1]!);
    expect(minted?.exp).toBe(soon);
    // Its own lifetime when that's shorter, and without one, its kind's.
    const later = Math.floor(Date.now() / 1000) + 400 * 86_400;
    const capped = await readClientLink(env, (await clientLink(env, "https://ops.example.com", { c: "company-1", t: "quote", id: "quote-1", exp: later })).split("/hub/")[1]!);
    expect(capped!.exp - Date.now() / 1000).toBeLessThanOrEqual(60 * 86_400);
    const fresh = await readClientLink(env, (await clientLink(env, "https://ops.example.com", { c: "company-1", t: "client", id: "client-1" })).split("/hub/")[1]!);
    expect(fresh!.exp - Date.now() / 1000).toBeGreaterThan(119 * 86_400);
  });
});

describe("stripe webhook signatures", () => {
  it("accepts a valid signature and rejects others", async () => {
    const payload = JSON.stringify({ type: "checkout.session.completed" });
    const t = Math.floor(Date.now() / 1000);
    const sig = await hmacSha256Hex("whsec_test", `${t}.${payload}`);
    expect(await verifyStripeSignature(payload, `t=${t},v1=${sig}`, "whsec_test")).toBe(true);
    expect(await verifyStripeSignature(payload, `t=${t},v1=${sig}`, "whsec_other")).toBe(false);
    expect(await verifyStripeSignature(payload, `t=${t - 3600},v1=${sig}`, "whsec_test")).toBe(false);
    expect(await verifyStripeSignature(payload, undefined, "whsec_test")).toBe(false);
  });
});

describe("routes", () => {
  // The config asks the database whether any company has its own mailbox (features.emailCodes): none.
  beforeEach(() => vi.stubGlobal("fetch", async () => Response.json([])));
  afterEach(() => vi.unstubAllGlobals());

  it("serves public config without secrets", async () => {
    const res = await request("/api/config");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ supabaseUrl: env.SUPABASE_URL, supabaseKey: "sb_publishable_test", mapsBrowserKey: "maps-browser-key" });
    expect(JSON.stringify(body)).not.toContain("sb_secret_test");
    expect(body.sentry).toBeNull();
    expect(body.termsVersion).toBe(TERMS_VERSION);
  });

  it("gives the web app Google Drive's file picker only when it's set up", async () => {
    expect((await (await request("/api/config")).json()).googlePicker).toBeNull();
    const google: Env = { ...env, GOOGLE_CLIENT_ID: "123456789012-abc123.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "google-secret-value", GOOGLE_PICKER_API_KEY: "picker-browser-key" };
    const body = await (await app.request("/api/config", {}, google)).json();
    // The Cloud project's number is how the picker lets Crewtavo read the files picked: the client ID starts with it.
    expect(body.googlePicker).toEqual({ clientId: google.GOOGLE_CLIENT_ID, apiKey: "picker-browser-key", appId: "123456789012" });
    expect(JSON.stringify(body)).not.toContain("google-secret-value");
    expect((await (await app.request("/api/config", {}, { ...google, GOOGLE_PICKER_API_KEY: undefined })).json()).googlePicker).toBeNull();
    expect((await (await app.request("/api/config", {}, { ...google, GOOGLE_CLIENT_ID: "not-a-google-client" })).json()).googlePicker).toBeNull();
  });

  it("gives the web app its error reporting DSN only when one is set", async () => {
    const dsn = "https://public@errors.example.com/2";
    const both = await (await app.request("/api/config", {}, { ...env, CREWTAVO_SENTRY_DSN: dsn })).json();
    expect(both.sentry).toEqual({ dsn, environment: "production" });
    const web = await (await app.request("/api/config", {}, { ...env, CREWTAVO_SENTRY_DSN: dsn, CREWTAVO_SENTRY_WEB_DSN: "https://web@errors.example.com/3" })).json();
    expect(web.sentry.dsn).toBe("https://web@errors.example.com/3");
  });

  it("requires a session for user routes", async () => {
    const res = await request("/api/me");
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Sign in to continue." });
  });

  it("guards cron tasks with the shared secret", async () => {
    expect((await request("/api/cron/outbox")).status).toBe(401);
    expect((await request("/api/cron/outbox", { headers: { Authorization: "Bearer wrong" } })).status).toBe(401);
    expect((await request("/api/cron/nope", { headers: { Authorization: `Bearer ${env.CRON_SECRET}` } })).status).toBe(404);
  });

  it("maps every scheduled cron to a known task", () => {
    for (const tasks of Object.values(CRON_TASKS)) for (const task of tasks) expect(TASKS).toContain(task);
  });

  it("runs autopay every 5 minutes, with the outbox that sends its receipts", () => {
    expect(TASKS).toContain("autopay");
    expect(CRON_TASKS["*/5 * * * *"]).toEqual(["outbox", "reviews", "autopay", "installments"]);
  });

  it("rejects expired client links", async () => {
    const res = await request("/api/hub/not-a-real-token");
    expect(res.status).toBe(404);
  });
});

describe("setting up a business", () => {
  afterEach(() => vi.unstubAllGlobals());

  // A session Supabase Auth vouches for: getClaims asks /auth/v1/user about HS256 tokens.
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const token = `${part({ alg: "HS256", typ: "JWT" })}.${part({ sub: "user-1", role: "authenticated", exp: Math.floor(Date.now() / 1000) + 600 })}.c2ln`;

  const create = (timezone: string, on: Env = env) => {
    const rpcs: Array<{ name: string; body: unknown }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/auth/v1/user") return Response.json({ id: "user-1", aud: "authenticated", role: "authenticated" });
      if (url.pathname.startsWith("/rest/v1/rpc/")) rpcs.push({ name: url.pathname.slice("/rest/v1/rpc/".length), body: JSON.parse(String(init?.body)) });
      return Response.json(url.pathname === "/rest/v1/rpc/create_company" ? "company-1" : []);
    });
    const body = { name: "Acme Lawn", trade_preset: "lawn_exterior", timezone, terms_version: TERMS_VERSION };
    const res = app.request("/api/companies", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }, on);
    return { rpcs, res };
  };

  it("takes a time zone name", async () => {
    const { rpcs, res } = create("America/Chicago");
    expect((await res).status).toBe(201);
    expect(rpcs[0]).toEqual({ name: "create_company", body: { p_name: "Acme Lawn", p_trade_preset: "lawn_exterior", p_timezone: "America/Chicago" } });
    // No texting on this server: the starter rules stay as every company's start, emails only.
    expect(rpcs.map((r) => r.name)).not.toContain("texting_starters");
  });

  it("adds texts to the starters that tell clients about their visits where the server can text", async () => {
    const { rpcs, res } = create("America/Chicago", { ...env, TWILIO_ACCOUNT_SID: "AC123", TWILIO_AUTH_TOKEN: "twilio-token", TWILIO_FROM_NUMBER: "+15405550000" });
    expect((await res).status).toBe(201);
    expect(rpcs.filter((r) => r.name === "texting_starters")).toEqual([{ name: "texting_starters", body: { p_company: "company-1" } }]);
  });

  it("loads the preset into the settings the company started with, so Marketing stays installed", async () => {
    const writes: Array<{ path: string; body: any }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/auth/v1/user") return Response.json({ id: "user-1", aud: "authenticated", role: "authenticated" });
      if ((init?.method ?? "GET") === "PATCH") writes.push({ path: url.pathname, body: JSON.parse(String(init?.body)) });
      if (url.pathname === "/rest/v1/companies" && (init?.method ?? "GET") === "GET") return Response.json([{ settings: { marketing: { enabled: true } } }]);
      return Response.json(url.pathname === "/rest/v1/rpc/create_company" ? "company-1" : []);
    });
    const body = { name: "Acme Lawn", trade_preset: "lawn_exterior", timezone: "America/Chicago", terms_version: TERMS_VERSION };
    const res = await request("/api/companies", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    expect(res.status).toBe(201);
    const settings = writes.find((w) => w.path === "/rest/v1/companies")!.body.settings;
    expect(settings.marketing).toEqual({ enabled: true });
    expect(settings.payment_terms_days).toBe(30);
    expect(settings).not.toHaveProperty("job_types");
  });

  it("installs Paving or Roofing for a business signing up in that trade, and neither for others", async () => {
    const signUp = async (trade_preset: string) => {
      let settings: any = null;
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname === "/auth/v1/user") return Response.json({ id: "user-1", aud: "authenticated", role: "authenticated" });
        if (url.pathname === "/rest/v1/companies" && init?.method === "PATCH") settings = JSON.parse(String(init.body)).settings;
        if (url.pathname === "/rest/v1/companies" && (init?.method ?? "GET") === "GET") return Response.json([{ settings: { marketing: { enabled: true } } }]);
        return Response.json(url.pathname === "/rest/v1/rpc/create_company" ? "company-1" : []);
      });
      const body = { name: "Summit Exteriors", trade_preset, timezone: "America/Chicago", terms_version: TERMS_VERSION };
      const res = await request("/api/companies", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
      expect(res.status).toBe(201);
      return settings;
    };
    expect(await signUp("paving")).toMatchObject({ paving_app: { enabled: true }, marketing: { enabled: true } });
    const roofer = await signUp("roofing_exteriors");
    expect(roofer).toMatchObject({ roofing_app: { enabled: true } });
    expect(roofer).not.toHaveProperty("paving_app");
    const lawn = await signUp("lawn_exterior");
    expect(lawn).not.toHaveProperty("paving_app");
    expect(lawn).not.toHaveProperty("roofing_app");
  });

  it("sets the currency picked at sign-up (and the country, guessed from the time zone), and refuses one that isn't a code", async () => {
    const writes: Array<{ path: string; body: unknown }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/auth/v1/user") return Response.json({ id: "user-1", aud: "authenticated", role: "authenticated" });
      if (init?.method === "PATCH") writes.push({ path: url.pathname + url.search, body: JSON.parse(String(init.body)) });
      return Response.json(url.pathname === "/rest/v1/rpc/create_company" ? "company-1" : []);
    });
    const make = (currency: string) =>
      request("/api/companies", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ name: "Maple Lawn", timezone: "America/Toronto", currency, terms_version: TERMS_VERSION }) });
    expect((await make("cad")).status).toBe(201);
    // With the country guessed from the time zone, as none was sent.
    expect(writes[0]).toEqual({ path: "/rest/v1/companies?id=eq.company-1", body: { currency: "CAD", country: "CA" } });
    const bad = await make("dollars");
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "Pick a currency from the list, like USD." });
  });

  it("sets the country picked at sign-up, and refuses one it doesn't know", async () => {
    const writes: Array<{ path: string; body: unknown }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/auth/v1/user") return Response.json({ id: "user-1", aud: "authenticated", role: "authenticated" });
      if (init?.method === "PATCH") writes.push({ path: url.pathname + url.search, body: JSON.parse(String(init.body)) });
      return Response.json(url.pathname === "/rest/v1/rpc/create_company" ? "company-1" : []);
    });
    const make = (country: string | undefined, timezone = "America/New_York", currency = "USD") =>
      request("/api/companies", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ name: "Thames Gardens", timezone, currency, country, terms_version: TERMS_VERSION }) });
    expect((await make("gb", "Europe/London", "GBP")).status).toBe(201);
    expect(writes[0]).toEqual({ path: "/rest/v1/companies?id=eq.company-1", body: { currency: "GBP", country: "GB" } });
    // In the US, in dollars: no country or currency to change after create_company.
    writes.length = 0;
    expect((await make("US")).status).toBe(201);
    expect((await make(undefined)).status).toBe(201);
    expect(writes.filter((w) => w.body && typeof w.body === "object" && ("country" in w.body || "currency" in w.body))).toEqual([]);
    const bad = await make("UK");
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: "Pick a country from the list." });
  });

  it("refuses a currency the app doesn't offer, before anything is made", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      calls.push(url.pathname);
      if (url.pathname === "/auth/v1/user") return Response.json({ id: "user-1", aud: "authenticated", role: "authenticated" });
      return Response.json(url.pathname === "/rest/v1/rpc/create_company" ? "company-1" : []);
    });
    const make = (currency: string) =>
      request("/api/companies", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ name: "Maple Lawn", timezone: "Asia/Tokyo", currency, terms_version: TERMS_VERSION }) });
    // Yen has no cents, and Stripe is sent every amount in cents.
    for (const code of ["JPY", "jpy", "KWD", "XXX"]) {
      const res = await make(code);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "Pick a currency from the list, like USD." });
    }
    expect(calls).not.toContain("/rest/v1/rpc/create_company");
    // Each one Settings → Company and sign-up offer is taken.
    for (const { code } of CURRENCIES) expect((await make(code)).status).toBe(201);
  });

  it("puts each preset checklist with the price list items it names, by their new ids", async () => {
    const links: unknown[] = [];
    const sent: Record<string, any[]> = {};
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const table = url.pathname.replace("/rest/v1/", "");
      if (url.pathname === "/auth/v1/user") return Response.json({ id: "user-1", aud: "authenticated", role: "authenticated" });
      if (table === "rpc/create_company") return Response.json("company-1");
      if (init?.method === "PATCH") (sent[table] ??= []).push(JSON.parse(String(init.body)));
      if (init?.method !== "POST") return Response.json([]);
      const body = JSON.parse(String(init.body));
      if (table === "services") sent.services = body;
      if (table === "checklist_template_services") links.push(...body);
      // What was made, each with an id from its name.
      return Response.json(table === "services" || table === "checklist_templates" ? body.map((r: { name: string }) => ({ id: `${table}:${r.name}`, name: r.name })) : [], { status: 201 });
    });
    const body = { name: "Acme Lawn", trade_preset: "lawn_exterior", timezone: "America/Chicago", terms_version: TERMS_VERSION };
    const res = await request("/api/companies", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    expect(res.status).toBe(201);
    expect(links).toContainEqual({ company_id: "company-1", template_id: "checklist_templates:Snow and salt route stop", service_id: "services:Snow plowing" });
    expect(links).toContainEqual({ company_id: "company-1", template_id: "checklist_templates:Weekly mow standard", service_id: "services:Weekly mow" });
    expect(links).toHaveLength(getPreset("lawn_exterior").checklists.reduce((n, cl) => n + (cl.services?.length ?? 0), 0));
    // The weather rules name their items by the ids they're made with, so renaming one keeps its rule.
    const made = new Map((sent.services ?? []).map((r: { id: string; name: string }) => [r.name, r.id]));
    const rules = sent.companies?.[0]?.settings.weather_rules as Array<{ applies_to?: string; service_id?: string }>;
    expect(rules.some((r) => r.service_id)).toBe(true);
    for (const r of rules) expect(r.service_id).toBe(r.applies_to ? made.get(r.applies_to) : undefined);
  });

  it("refuses offsets, which Postgres reads with the sign reversed, and made-up zones", async () => {
    for (const timezone of ["+05:00", "-0500", "Not/AZone"]) {
      const { rpcs, res } = create(timezone);
      const response = await res;
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Unknown time zone. Pick one from the list, like America/New_York." });
      expect(rpcs).toEqual([]);
    }
  });
});

describe("MCP discovery", () => {
  // The instance's earlier addresses (none here).
  beforeEach(() => vi.stubGlobal("fetch", async () => Response.json([])));
  afterEach(() => vi.unstubAllGlobals());

  it("publishes protected resource metadata pointing at Supabase Auth", async () => {
    const res = await request("/.well-known/oauth-protected-resource/mcp");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      resource: "https://ops.example.com/mcp",
      authorization_servers: ["https://example.supabase.co/auth/v1"],
    });
  });

  it("points assistants at the instance's public sign-in, not its loopback address", async () => {
    const res = await app.request("/.well-known/oauth-protected-resource/mcp", undefined, { ...env, SUPABASE_URL: "http://127.0.0.1:8080", CREWTAVO_GATEWAY: "1" });
    expect(await res.json()).toMatchObject({ authorization_servers: ["https://ops.example.com/auth/v1"] });
  });

  it("challenges unauthenticated MCP calls with the metadata URL", async () => {
    const res = await request("/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toBe(
      'Bearer resource_metadata="https://ops.example.com/.well-known/oauth-protected-resource/mcp"',
    );
  });

  it("answers CORS preflight for browser-based MCP clients", async () => {
    const res = await request("/mcp", {
      method: "OPTIONS",
      headers: { Origin: "https://inspector.example", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization" },
    });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

describe("client links by kind", () => {
  it("routes each kind to its page and keeps the preview flag", async () => {
    const unsub = await clientLink(env, "https://ops.example.com/", { c: "co", t: "unsub", id: "client-1" });
    expect(unsub.startsWith("https://ops.example.com/u/")).toBe(true);
    const review = await clientLink(env, "https://ops.example.com", { c: "co", t: "review", id: "rr-1" });
    expect(review.startsWith("https://ops.example.com/api/public/r/")).toBe(true);
    const refer = await clientLink(env, "https://ops.example.com", { c: "co", t: "refer", id: "client-1" });
    expect(refer.startsWith("https://ops.example.com/refer/")).toBe(true);
    const preview = await clientLink(env, "https://ops.example.com", { c: "co", t: "quote", id: "q-1", pv: 1 });
    expect(await readClientLink(env, preview.split("/hub/")[1])).toMatchObject({ t: "quote", pv: 1 });
  });

  it("keeps whether the office copied a link, and leaves the client's own links without it", async () => {
    const copied = await clientLink(env, "https://ops.example.com", { c: "co", t: "client", id: "client-1", via: "office" });
    expect(await readClientLink(env, copied.split("/hub/")[1])).toMatchObject({ t: "client", id: "client-1", via: "office" });
    const own = await clientLink(env, "https://ops.example.com", { c: "co", t: "client", id: "client-1" });
    expect((await readClientLink(env, own.split("/hub/")[1]))?.via).toBeUndefined();
  });

  it("marks only the client's own of a pair as theirs (own: 1), never the office's copy", async () => {
    const links = await clientLinks(env, "https://ops.example.com", { c: "co", t: "invoice", id: "invoice-1" });
    const own = await readClientLink(env, links.own.split("/hub/")[1]!);
    expect(own).toMatchObject({ c: "co", t: "invoice", id: "invoice-1", own: 1 });
    expect(own).not.toHaveProperty("via");
    const office = await readClientLink(env, links.office.split("/hub/")[1]!);
    expect(office).toMatchObject({ t: "invoice", id: "invoice-1", via: "office" });
    expect(office).not.toHaveProperty("own");
    expect(office).not.toHaveProperty("nm");
  });

  it("marks the office's copy made for someone who doesn't see the money (nm), never the client's own", async () => {
    const links = await clientLinks(env, "https://ops.example.com", { c: "co", t: "quote", id: "quote-1", nm: 1 });
    expect(await readClientLink(env, links.office.split("/hub/")[1]!)).toMatchObject({ t: "quote", via: "office", nm: 1 });
    expect(await readClientLink(env, links.own.split("/hub/")[1]!)).not.toHaveProperty("nm");
  });

  it("keeps no working link in the copy kept on the timeline, which crews and connected assistants read", async () => {
    const links = await clientLinks(env, "https://ops.example.com", { c: "co", t: "quote", id: "quote-1" });
    expect(links.kept).toBe(KEPT_LINK);
    expect(links.kept).not.toMatch(/https?:|\/hub\//);
    expect(await readClientLink(env, links.office.split("/hub/")[1]!)).toMatchObject({ t: "quote", via: "office" });
    expect(await readClientLink(env, links.office.split("/hub/")[1]!)).not.toHaveProperty("nm");
  });

  it("knows a send to the client's own email or phone from one typed to anyone else", () => {
    const client = { email: " Dana@Example.com ", phone: "(540) 555-0142" };
    expect(sentToClient("email", "dana@example.com", client)).toBe(true);
    expect(sentToClient("email", "  DANA@EXAMPLE.COM", client)).toBe(true);
    expect(sentToClient("email", "dana.work@example.com", client)).toBe(false);
    expect(sentToClient("email", "estimator@peak.example", client)).toBe(false);
    expect(sentToClient("sms", "540-555-0142", client)).toBe(true);
    expect(sentToClient("sms", "+1 540 555 0142", client)).toBe(true);
    expect(sentToClient("sms", "15405550142", client)).toBe(true);
    expect(sentToClient("sms", "540-555-0199", client)).toBe(false);
    // An email isn't a phone, nothing on file matches nothing, and there's no client to match.
    expect(sentToClient("sms", "dana@example.com", client)).toBe(false);
    expect(sentToClient("email", "", { email: null, phone: null })).toBe(false);
    expect(sentToClient("sms", "", { email: null, phone: "" })).toBe(false);
    expect(sentToClient("email", "dana@example.com", null)).toBe(false);
  });

  it("won't accept one kind of link where another is expected", async () => {
    const quote = await clientLink(env, "https://ops.example.com", { c: "co", t: "quote", id: "client-1" });
    const token = quote.split("/hub/")[1];
    const res = await request(`/api/public/unsubscribe/${token}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    expect(res.status).toBe(404);
    expect((await request("/api/public/unsubscribe/garbage", { method: "POST" })).status).toBe(404);
  });
});

describe("texting", () => {
  beforeEach(() => vi.stubGlobal("fetch", async () => Response.json([])));
  afterEach(() => vi.unstubAllGlobals());

  it("signs webhook requests the way Twilio does", async () => {
    const url = "https://ops.example.com/api/webhooks/twilio";
    const params = { To: "+15405550100", From: "+15405550163", Body: "Running late?", MessageSid: "SM123", AccountSid: "AC1" };
    const data = url + Object.keys(params).sort().map((k) => k + params[k as keyof typeof params]).join("");
    const expected = createHmac("sha1", "twilio-token").update(data).digest("base64");
    expect(await twilioSignature("twilio-token", url, params)).toBe(expected);
    expect(await twilioSignature("other-token", url, params)).not.toBe(expected);
  });

  it("rejects replies when texting isn't set up or the signature is wrong", async () => {
    const form = () => new URLSearchParams({ From: "+15405550163", Body: "Yes please" });
    expect((await request("/api/webhooks/twilio", { method: "POST", body: form() })).status).toBe(501);
    const withTwilio = { ...env, TWILIO_AUTH_TOKEN: "twilio-token" };
    const bad = await app.request("/api/webhooks/twilio", { method: "POST", headers: { "x-twilio-signature": "bm9wZQ==" }, body: form() }, withTwilio);
    expect(bad.status).toBe(403);
    const missing = await app.request("/api/webhooks/twilio", { method: "POST", body: form() }, withTwilio);
    expect(missing.status).toBe(403);
  });

  describe("STOP and START", () => {
    const withTwilio = { ...env, TWILIO_AUTH_TOKEN: "twilio-token" };
    const url = "https://ops.example.com/api/webhooks/twilio";
    /** The contacts with a number like the sender's, for the tests that have some. */
    let contacts: Array<{ company_id: string; client_id: string; name: string; phone: string }> = [];
    afterEach(() => {
      contacts = [];
    });
    /** A text from +1 540-555-0163, who's a client in two companies; `changes` is whether the client's texts setting changes. */
    async function text(body: string, extra: Record<string, string> = {}, changes = true) {
      const calls: Array<{ method: string; path: string; params: URLSearchParams; body: any }> = [];
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const u = new URL(String(input));
        const path = u.pathname.replace(/^\/rest\/v1\//, "");
        const method = (init?.method ?? "GET").toUpperCase();
        calls.push({ method, path, params: u.searchParams, body: typeof init?.body === "string" && init.body ? JSON.parse(init.body) : undefined });
        if (method === "GET" && path === "clients") {
          return Response.json([
            { id: "client-1", company_id: "co-1", phone: "(540) 555-0163", display_name: "Ana Smith" },
            { id: "client-2", company_id: "co-2", phone: "+1 540 555 0163", display_name: "Ana S." },
            { id: "client-3", company_id: "co-1", phone: "(540) 555-0199", display_name: "Bo Other" },
          ]);
        }
        if (method === "GET" && path === "client_contacts") return Response.json(contacts);
        // The number wasn't stopped before a STOP, and was before a START, when `changes`.
        if ((method === "POST" || method === "DELETE") && path === "sms_stops") return Response.json(changes ? [{ phone_key: "5405550163" }] : []);
        if (method === "PATCH" && path === "clients") return Response.json(changes ? [{ id: u.searchParams.get("id")!.slice(3) }] : []);
        if (method === "GET" && path === "memberships") return Response.json([{ user_id: "owner-1" }]);
        return Response.json([]);
      });
      const params = { From: "+15405550163", Body: body, MessageSid: "SM1", ...extra };
      const signature = await twilioSignature("twilio-token", url, params);
      const res = await app.request("/api/webhooks/twilio", { method: "POST", headers: { "x-twilio-signature": signature }, body: new URLSearchParams(params) }, withTwilio);
      expect(res.status).toBe(200);
      const optOuts = calls.filter((c) => c.method === "PATCH" && c.path === "clients");
      return {
        optOuts: optOuts.map((c) => ({ id: c.params.get("id"), when: c.params.get("sms_opt_out_at"), set: c.body.sms_opt_out_at === null ? null : typeof c.body.sms_opt_out_at })),
        messages: calls.filter((c) => c.method === "POST" && c.path === "messages").map((c) => [c.body.client_id, c.body.body]),
        notices: calls.filter((c) => c.method === "POST" && c.path === "notifications").flatMap((c) => c.body.map((n: { title: string }) => n.title)),
        // The number itself, by company: remembered on a STOP (sms_stops), forgotten on a START.
        stops: calls.filter((c) => c.method === "POST" && c.path === "sms_stops").map((c) => [c.body.company_id, c.body.phone_key, c.body.phone]),
        starts: calls.filter((c) => c.method === "DELETE" && c.path === "sms_stops").map((c) => [c.params.get("company_id"), c.params.get("phone_key")]),
        // How each stop is kept: the keyword's, or the words that asked for it.
        kept: calls.filter((c) => c.method === "POST" && c.path === "sms_stops").map((c) => [c.body.source, c.body.note]),
        told: calls.filter((c) => c.method === "POST" && c.path === "notifications").flatMap((c) => c.body.map((n: { body: string }) => n.body)),
      };
    }

    it.each(["Please stop texting me", "stop texting me!!", "please stop", "Unsubscribe me", "No more texts"])("turns texts off on words that plainly ask for it (%j), keeps what was texted and tells the office", async (body) => {
      const { optOuts, messages, notices, kept, told } = await text(body);
      expect(optOuts).toEqual([
        { id: "eq.client-1", when: "is.null", set: "string" },
        { id: "eq.client-2", when: "is.null", set: "string" },
      ]);
      // Kept as a phrase, not the keyword: Twilio didn't stop the number, so the office can lift it if they ask.
      expect(kept).toEqual([["phrase", body], ["phrase", body]]);
      // The text is on their timeline like any other, and the office reads what they wrote.
      expect(messages).toEqual([["client-1", body], ["client-2", body]]);
      expect(notices).toEqual(["Ana Smith asked to stop texts", "Ana S. asked to stop texts"]);
      expect(told[0]).toBe(`They texted “${body}”, so Crewtavo won't text them. If that isn't what they meant, you can turn texts back on from their page, only if they ask.`);
    });

    it("keeps the keyword as the keyword's, and what Twilio acted on as Twilio's", async () => {
      expect((await text("STOP")).kept).toEqual([["keyword", null], ["keyword", null]]);
      // Twilio says it stopped the number (Advanced Opt-Out), whatever the words.
      expect((await text("please stop texting me", { OptOutType: "STOP" })).kept).toEqual([["keyword", null], ["keyword", null]]);
      // And says a text was only its HELP: words in it that ask to stop aren't read.
      expect((await text("stop texting me", { OptOutType: "HELP" })).kept).toEqual([]);
    });

    it("stops the number itself too, for each company that keeps it as a client's or a contact's", async () => {
      // A property manager in a third company's contacts has the number too, and someone else there doesn't.
      const others = [
        { company_id: "co-3", client_id: "client-9", name: "Ana at Oak HOA", phone: "540.555.0163" },
        { company_id: "co-3", client_id: "client-8", name: "Someone else", phone: "540-555-0199" },
        // In co-1 the number is a client's own, so the text is filed under that client alone.
        { company_id: "co-1", client_id: "client-3", name: "Ana, Bo's neighbour", phone: "5405550163" },
      ];
      contacts = others;
      const stopped = await text("STOP");
      expect(stopped.stops).toEqual([["co-1", "5405550163", "+15405550163"], ["co-2", "5405550163", "+15405550163"], ["co-3", "5405550163", "+15405550163"]]);
      expect(stopped.starts).toEqual([]);
      // On the contact's client's timeline, and the office hears who it was.
      expect(stopped.messages).toEqual([["client-1", "STOP"], ["client-2", "STOP"], ["client-9", "STOP"]]);
      expect(stopped.notices).toEqual(["Ana Smith turned off texts", "Ana S. turned off texts", "Ana at Oak HOA turned off texts"]);
      const started = await text("START");
      expect(started.starts).toEqual([["eq.co-1", "eq.5405550163"], ["eq.co-2", "eq.5405550163"], ["eq.co-3", "eq.5405550163"]]);
      expect(started.stops).toEqual([]);
      expect(started.notices).toEqual(["Ana Smith turned texts back on", "Ana S. turned texts back on", "Ana at Oak HOA turned texts back on"]);
      // An ordinary text changes nothing about who can be texted.
      const plain = await text("See you Tuesday");
      expect([plain.stops, plain.starts]).toEqual([[], []]);
      expect(plain.notices).toEqual(["New text from a client", "New text from a client", "New text from Ana at Oak HOA"]);
    });

    it.each(["STOP", "stop ", "Stop.", "STOPALL", "unsubscribe", "opt out", "Revoke"])("turns texts off for every client with the number on %j", async (body) => {
      const { optOuts, messages, notices } = await text(body);
      expect(optOuts).toEqual([
        { id: "eq.client-1", when: "is.null", set: "string" },
        { id: "eq.client-2", when: "is.null", set: "string" },
      ]);
      expect(messages).toEqual([["client-1", body], ["client-2", body]]);
      expect(notices).toEqual(["Ana Smith turned off texts", "Ana S. turned off texts"]);
    });

    it("files an ordinary text as one", async () => {
      const { optOuts, messages, notices } = await text("Please stop by Tuesday");
      expect(optOuts).toEqual([]);
      expect(messages).toHaveLength(2);
      expect(notices).toEqual(["New text from a client", "New text from a client"]);
    });

    it.each(["START", "yes", "Unstop!"])("turns texts back on with %j", async (body) => {
      const { optOuts, notices } = await text(body);
      expect(optOuts).toEqual([
        { id: "eq.client-1", when: "not.is.null", set: null },
        { id: "eq.client-2", when: "not.is.null", set: null },
      ]);
      expect(notices).toEqual(["Ana Smith turned texts back on", "Ana S. turned texts back on"]);
    });

    it("says nothing new when YES is an ordinary reply from someone with texts on", async () => {
      const { notices } = await text("Yes", {}, false);
      expect(notices).toEqual(["New text from a client", "New text from a client"]);
    });

    it("goes by what Twilio acted on when it says, whatever the words", async () => {
      expect((await text("Arrêtez", { OptOutType: "STOP" })).optOuts.map((o) => o.set)).toEqual(["string", "string"]);
      expect((await text("Recommencer", { OptOutType: "START" })).optOuts.map((o) => o.set)).toEqual([null, null]);
      // HELP is Twilio's too: a STOP-looking word with it changes nothing.
      expect((await text("STOP", { OptOutType: "HELP" })).optOuts).toEqual([]);
    });
  });

  it("requires sign-in to send messages", async () => {
    const res = await request("/api/messages/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_id: crypto.randomUUID(), channel: "sms", body: "hi" }) });
    expect(res.status).toBe(401);
  });
});

describe("email rendering", () => {
  it("escapes content, links URLs and turns a link on its own line into a button", () => {
    const { html, text } = renderEmail({
      companyName: "Smith & Sons <LLC>",
      text: "Hi <b>Ana</b>,\n\nhttps://ops.example.com/hub/abc\n\nDetails at https://example.com/x.",
      footer: "1 Main St, Radford, VA",
      unsubscribeUrl: "https://ops.example.com/u/t?a=1&b=2",
    });
    expect(html).toContain("Smith &amp; Sons &lt;LLC&gt;");
    expect(html).not.toContain("<b>Ana</b>");
    expect(html).toContain(">View online</a>");
    expect(html).toContain('href="https://example.com/x"');
    expect(html).toContain('href="https://ops.example.com/u/t?a=1&amp;b=2"');
    expect(text).toContain("Unsubscribe: https://ops.example.com/u/t?a=1&b=2");
    expect(text).toContain("1 Main St, Radford, VA");
  });

  it("sends a campaign's links through tracked ones, showing each as written, and never tracks unsubscribing", () => {
    const tracked = (url: string) => `https://ops.example.com/api/public/c/tok/${url.includes("review") ? 1 : 0}`;
    const { html, text } = renderEmail({
      companyName: "Acme Lawn",
      text: "Book at https://acme.example/book?a=1&b=2.\n\nhttps://ops.example.com/api/public/r/review\n\nOr write to mailto:office@acme.example",
      unsubscribeUrl: "https://ops.example.com/u/unsub",
      href: tracked,
      pixel: "https://ops.example.com/api/public/o/tok",
    });
    expect(html).toContain('<a href="https://ops.example.com/api/public/c/tok/0" style="color:#2c611a;font-weight:600;word-break:break-all">https://acme.example/book?a=1&amp;b=2</a>.');
    // The button keeps the label its real link gives it.
    expect(html).toContain('href="https://ops.example.com/api/public/c/tok/1" style="display:inline-block');
    expect(html).toContain(">Leave a review</a>");
    expect(html).toContain('href="https://ops.example.com/u/unsub"');
    expect(html).toContain("mailto:office@acme.example");
    expect(html).not.toContain('href="mailto:');
    expect(html).toMatch(/Unsubscribe<\/a><\/p>\n<img src="https:\/\/ops\.example\.com\/api\/public\/o\/tok" width="1" height="1" alt=""/);
    expect(text).toBe("Book at https://ops.example.com/api/public/c/tok/0.\n\nhttps://ops.example.com/api/public/c/tok/1\n\nOr write to mailto:office@acme.example\n\nUnsubscribe: https://ops.example.com/u/unsub");
    // Without them, links go as they are and there's no image.
    const plain = renderEmail({ companyName: "Acme Lawn", text: "Book at https://acme.example/book." });
    expect(plain.html).toContain('href="https://acme.example/book"');
    expect(plain.html).not.toContain("<img");
    expect(plain.text).toBe("Book at https://acme.example/book.");
  });

  it("names autopay's buttons for what they do: a tip on the invoice, or the client's autopay page", () => {
    const { html } = renderEmail({
      companyName: "Radford Lawn Care",
      text: "Add a tip for the crew?\n\nhttps://ops.example.com/hub/inv?tip=1\n\nChange your card:\n\nhttps://ops.example.com/hub/home?view=autopay\n\nhttps://ops.example.com/hub/inv?tip=10",
    });
    expect(html).toContain('href="https://ops.example.com/hub/inv?tip=1" style="display:inline-block;background:#3b7d23;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:8px">Add a tip</a>');
    expect(html).toContain(">Manage autopay</a>");
    // Only exactly tip=1.
    expect(html).toContain('href="https://ops.example.com/hub/inv?tip=10" style="display:inline-block;background:#3b7d23;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 22px;border-radius:8px">View online</a>');
    expect(renderEmail({ companyName: "Radford Lawn Care", text: "https://ops.example.com/hub/home?session=1&view=autopay" }).html).toContain(">Manage autopay</a>");
  });

  it("makes only links to this Crewtavo into buttons when told its address (an email carrying an outsider's words)", () => {
    const request = "https://ops.example.com/requests/00000000-0000-4000-8000-000000000001";
    const lookalike = "https://ops.example.com.evil.example/requests/00000000-0000-4000-8000-000000000002";
    const { html } = renderEmail({ companyName: "Acme Lawn", text: `Message:\nhi\n\n${lookalike}\n\nhttps://evil.example/login\n\n${request}`, base: "https://ops.example.com" });
    expect(html.match(/display:inline-block/g)).toHaveLength(1);
    expect(html).toContain(`href="${request}" style="display:inline-block`);
    expect(html).toContain(">Open the request</a>");
    // The others are plain links in the text, written out as they are.
    expect(html).toContain(`<a href="${lookalike}" style="color:#2c611a;font-weight:600;word-break:break-all">${lookalike}</a>`);
    expect(html).toContain('<a href="https://evil.example/login" style="color:#2c611a;font-weight:600;word-break:break-all">https://evil.example/login</a>');
    // Without the address, as before: any link on its own line is a button.
    expect(renderEmail({ companyName: "Acme Lawn", text: "https://acme.example/spring" }).html).toContain('href="https://acme.example/spring" style="display:inline-block');
    // With the address unknown (null: no APP_URL), none is.
    expect(renderEmail({ companyName: "Acme Lawn", text: `Message:\nhi\n\n${request}`, base: null }).html).not.toContain("display:inline-block");
  });

  it("shows a one-time code large, on its own, and leaves the plain text as it is", () => {
    const { html, text } = renderEmail({ companyName: "Oscar Roofing", text: "Your code:\n\n042517\n\nNot 042517 here.", code: "042517" });
    expect(html.match(/font-size:32px[^>]*>042517<\/p>/g)).toHaveLength(1);
    expect(html).toContain("Not 042517 here.");
    expect(text).toBe("Your code:\n\n042517\n\nNot 042517 here.");
    expect(renderEmail({ companyName: "Oscar Roofing", text: "042517" }).html).not.toContain("font-size:32px");
  });

  it("greets people by first name and organizations in full", () => {
    expect(greetingName("Jane Smith")).toBe("Jane");
    expect(greetingName("  Priya   Shah ")).toBe("Priya");
    expect(greetingName("Town of Rocky Mount")).toBe("Town of Rocky Mount");
    expect(greetingName("Summit Ridge Builders")).toBe("Summit Ridge Builders");
    expect(greetingName("Meadowbrook HOA")).toBe("Meadowbrook HOA");
    expect(greetingName("")).toBe("there");
    expect(greetingName(null)).toBe("there");
  });

  it("recognizes usable email addresses", () => {
    expect(isEmail("ana@example.com")).toBe(true);
    expect(isEmail(" ana@example.com ")).toBe(true);
    expect(isEmail("ana@example")).toBe(false);
    expect(isEmail("not an email")).toBe(false);
    expect(isEmail(null)).toBe(false);
  });
});

describe("email From header", () => {
  const fromLine = (name: string | null) =>
    buildMime({ from: { name, email: "office@acme.example" }, to: "ana@example.com", subject: "Hi", text: "Hello" }).mime.split("\r\n").find((l) => l.startsWith("From: "))!;
  const decode = (words: string) => words.split(" ").map((w) => new TextDecoder().decode(Uint8Array.from(atob(w.slice(10, -2)), (ch) => ch.charCodeAt(0)))).join("");

  it("quotes the company name, so a comma keeps it one sender", () => {
    expect(fromLine("Acme Lawn Care, LLC")).toBe('From: "Acme Lawn Care, LLC" <office@acme.example>');
    expect(fromLine('Bob "The Mower" \\ Sons')).toBe('From: "Bob \\"The Mower\\" \\\\ Sons" <office@acme.example>');
    expect(fromLine(null)).toBe("From: office@acme.example");
    expect(fromLine("Acme\r\nBcc: someone@example.com")).toBe('From: "Acme Bcc: someone@example.com" <office@acme.example>');
  });

  it("encodes non-ASCII names (RFC 2047) in words of 75 characters or fewer", () => {
    const line = fromLine("Jardinería García, S.A.");
    const words = line.match(/^From: (.+) <office@acme\.example>$/)![1]!;
    expect(words).toMatch(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/);
    expect(decode(words)).toBe("Jardinería García, S.A.");
    const long = "Servicios de Jardinería y Paisajismo García e Hijos, S.A. de C.V.";
    const longWords = fromLine(long).match(/^From: (.+) <office@acme\.example>$/)![1]!;
    expect(longWords.split(" ").every((w) => w.length <= 75 && /^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?=$/.test(w))).toBe(true);
    expect(decode(longWords)).toBe(long);
  });
});

describe("roles", () => {
  it("gives built-in roles everything their level allows", () => {
    expect(memberPermissions("admin", null)).toContain("apps");
    expect(memberPermissions("office", null)).not.toContain("team");
    expect(memberPermissions("field_crew", null)).toEqual([]);
  });

  it("limits custom roles to their list, within the level", () => {
    expect(memberPermissions("office", ["reports", "schedule"])).toEqual(["reports", "schedule"]);
    // An area the level can't have is ignored even if it's on the list.
    expect(memberPermissions("crew_lead", ["schedule", "invoices"])).toEqual(["schedule"]);
    expect(memberPermissions("estimator", [])).toEqual([]);
  });

  it("never lets a lower level reach more than a higher one", () => {
    // Estimators (sales) and crew leads (the field) sit side by side under the office.
    const chains = [
      ["owner", "admin", "office", "estimator"],
      ["owner", "admin", "office", "crew_lead", "field_crew"],
    ] as const;
    for (const order of chains) for (let i = 1; i < order.length; i++) for (const p of LEVEL_PERMISSIONS[order[i]!]) expect(LEVEL_PERMISSIONS[order[i - 1]!]).toContain(p);
  });
});

describe("validation messages", () => {
  const issue = (schema: z.ZodType, value: unknown) => {
    const r = schema.safeParse(value);
    if (r.success) throw new Error("expected a problem");
    return friendlyIssue(r.error.issues[0]!);
  };
  it("names the field in plain words", () => {
    expect(issue(z.object({ email: z.email() }), { email: "nope" })).toBe("Enter a valid email address.");
    expect(issue(z.object({ client_id: z.string() }), {})).toBe("Client is required.");
    expect(issue(z.object({ body: z.string().min(1) }), { body: "" })).toBe("Message is required.");
    expect(issue(z.object({ subject: z.string().max(3) }), { subject: "toolong" })).toBe("Subject is too long.");
    expect(issue(z.object({ amount: z.number().min(1) }), { amount: 0 })).toBe("Amount is too low.");
  });
  it("never shows code-style paths", () => {
    expect(issue(z.object({ lines: z.array(z.object({ qty: z.number() })) }), { lines: [{ qty: "x" }] })).toBe("Qty doesn't look right.");
    expect(issue(z.array(z.string()), [1])).toBe("Something in the form isn't right. Check it and try again.");
  });
  it("uses a refine's own words, and the field's name when it has none", () => {
    const days = z.object({ days: z.array(z.number()) });
    expect(issue(days.refine((b) => b.days[1]! > b.days[0]!, { message: "The second reminder comes after the first.", path: ["days"] }), { days: [5, 3] }))
      .toBe("The second reminder comes after the first.");
    expect(issue(z.object({ kind: z.string().refine((k) => k === "a") }), { kind: "b" })).toBe("Check the kind and try again.");
  });
  it("uses a check's own words when they're a sentence, and the field's name otherwise", () => {
    expect(issue(z.object({ config_id: z.string().regex(/^\d+$/, "A Configuration ID is all digits.") }), { config_id: "abc-config" })).toBe("A Configuration ID is all digits.");
    expect(issue(z.object({ secret: z.string().min(8, "That looks too short. Copy the whole thing.") }), { secret: "abc" })).toBe("That looks too short. Copy the whole thing.");
    expect(issue(z.object({ config_id: z.string().regex(/^\d+$/) }), { config_id: "abc" })).toBe("Configuration ID doesn't look right.");
    expect(issue(z.object({ due_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD") }), { due_on: "soon" })).toBe("Due date doesn't look right.");
  });
});

describe("batch invoicing", () => {
  it("takes 50 jobs a call and says how to send more, to a person and to an assistant", () => {
    const ids = (n: number) => Array.from({ length: n }, () => crypto.randomUUID());
    const first = (schema: z.ZodType, value: unknown) => {
      const r = schema.safeParse(value);
      return r.success ? null : friendlyIssue(r.error.issues[0]!);
    };
    const body = z.object({ job_ids: z.array(z.uuid()).min(1).max(BATCH_JOBS, TOO_MANY_JOBS) });
    expect(BATCH_JOBS).toBe(50);
    expect(first(body, { job_ids: ids(50) })).toBeNull();
    expect(first(body, { job_ids: ids(51) })).toBe("Invoice at most 50 jobs at a time: send the first 50, then the next.");
    const tool = TOOLS.invoice_jobs!;
    expect(tool.description).toContain("at most 50 job_ids a call");
    expect(first(tool.input, { job_ids: ids(50) })).toBeNull();
    expect(first(tool.input, { job_ids: ids(51) })).toBe(TOO_MANY_JOBS);
  });
});

describe("built-in scheduler", () => {
  const at = (iso: string) => new Date(iso);
  it("matches the schedules the tasks use", () => {
    expect(cronMatches("* * * * *", at("2026-10-16T13:07:00Z"))).toBe(true);
    expect(cronMatches("*/5 * * * *", at("2026-10-16T13:10:00Z"))).toBe(true);
    expect(cronMatches("*/5 * * * *", at("2026-10-16T13:11:00Z"))).toBe(false);
    expect(cronMatches("0 * * * *", at("2026-10-16T13:00:00Z"))).toBe(true);
    expect(cronMatches("0 * * * *", at("2026-10-16T13:01:00Z"))).toBe(false);
    expect(cronMatches("0 */6 * * *", at("2026-10-16T18:00:00Z"))).toBe(true);
    expect(cronMatches("0 */6 * * *", at("2026-10-16T19:00:00Z"))).toBe(false);
    expect(cronMatches("15 6 * * *", at("2026-10-16T06:15:00Z"))).toBe(true);
    expect(cronMatches("15 6 * * *", at("2026-10-16T07:15:00Z"))).toBe(false);
  });
  it("handles lists, ranges and weekdays, and rejects nonsense", () => {
    expect(cronMatches("0 9-17 * * 1-5", at("2026-10-16T12:00:00Z"))).toBe(true); // a Friday
    expect(cronMatches("0 9-17 * * 1-5", at("2026-10-17T12:00:00Z"))).toBe(false); // Saturday
    expect(cronMatches("0 0 * * 7", at("2026-10-18T00:00:00Z"))).toBe(true); // Sunday as 7
    expect(cronMatches("0,30 * * * *", at("2026-10-16T13:30:00Z"))).toBe(true);
    expect(cronMatches("not a cron", at("2026-10-16T13:30:00Z"))).toBe(false);
  });
  it("covers every task's schedule", () => {
    for (const expression of Object.keys(CRON_TASKS)) expect(expression.split(" ")).toHaveLength(5);
  });
  it("sends review reminders every five minutes", () => {
    expect(TASKS).toContain("reviews");
    expect(CRON_TASKS["*/5 * * * *"]).toContain("reviews");
  });
});

describe("recurring visits", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("skips a job whose rule can't be used and still schedules the others", async () => {
    const job = (id: string, recurrence_rule: string) => ({
      id, company_id: "co", title: "Mowing", property_id: null, starts_on: "2026-01-05", ends_on: null, recurrence_rule, active_months: null,
      visit_start_time: null, visit_duration_min: 60, default_crew_id: null, company: { timezone: "UTC" },
    });
    const posted: Array<{ job_id: string; recurrence_key: string }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const { pathname } = new URL(String(input));
      if (pathname === "/rest/v1/jobs") return Response.json([job("bad", "FREQ=HOURLY"), job("good", "FREQ=WEEKLY;BYDAY=MO")]);
      if (pathname === "/rest/v1/recurrence_skips") return Response.json([]); // nothing deleted by hand
      if (pathname === "/rest/v1/integrations") return Response.json([]); // nobody puts visits on Google Calendar
      if (pathname === "/rest/v1/visits" && init?.method === "POST") {
        const rows = JSON.parse(String(init.body)) as typeof posted;
        posted.push(...rows);
        return Response.json(rows.map((_, i) => ({ id: `visit-${i}` })), { status: 201 });
      }
      return Response.json({ message: `unexpected ${pathname}` }, { status: 500 });
    });
    const result = await runTask("recurrence", env);
    expect(result).toMatchObject({ jobs: 2, problems: ["bad: Jobs repeat daily, weekly, monthly or yearly"] });
    expect(posted.length).toBeGreaterThanOrEqual(8); // Mondays in the next 60 days
    expect(posted.every((visit) => visit.job_id === "good")).toBe(true);
    expect(new Set(posted.map((visit) => visit.recurrence_key)).size).toBe(posted.length);
    expect(result.created).toBe(posted.length);
  });
});

describe("calendar feeds", () => {
  const ics = buildCalendar("Acme Paving, schedule", [
    { uid: "a@crewtavo", title: "Sealcoat; driveway, front", start: new Date("2026-10-16T13:00:00Z"), end: new Date("2026-10-16T15:30:00Z"), description: "Line one\nLine two", location: "12 Main St, Rocky Mount" },
    { uid: "b@crewtavo", title: "Anytime visit", date: "2026-10-31" },
    { uid: "c@crewtavo", title: "x".repeat(200), date: "2026-11-01", cancelled: true },
  ]);
  it("writes timed and all-day events", () => {
    expect(ics).toContain("DTSTART:20261016T130000Z\r\nDTEND:20261016T153000Z");
    expect(ics).toContain("DTSTART;VALUE=DATE:20261031\r\nDTEND;VALUE=DATE:20261101");
    expect(ics).toContain("STATUS:CANCELLED");
  });
  it("escapes text and folds long lines", () => {
    expect(ics).toContain("SUMMARY:Sealcoat\\; driveway\\, front");
    expect(ics).toContain("DESCRIPTION:Line one\\nLine two");
    expect(ics.split("\r\n").every((line) => new TextEncoder().encode(line).length <= 75)).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
  });
  it("never lets typed-in text start a new line or carry control characters", () => {
    // Addresses come from the public booking form, so a lone \r must not end the line.
    const out = buildCalendar("Feed", [
      { uid: "d@crewtavo", title: "Walkthrough\rBEGIN:VEVENT", date: "2026-11-02", location: "12 Main St\r\nApt 4\nRear\rSide", description: "Ring\x07 the bell\x00\tthen wait\x7f" },
    ]);
    expect(out).toContain("SUMMARY:Walkthrough\\nBEGIN:VEVENT\r\n");
    expect(out).toContain("LOCATION:12 Main St\\nApt 4\\nRear\\nSide\r\n");
    expect(out).toContain("DESCRIPTION:Ring the bell\tthen wait\r\n");
    expect(out.replace(/\r\n/g, "")).not.toMatch(/[\x00-\x08\x0a-\x1f\x7f]/);
    expect(out.split("\r\n").filter((line) => line === "BEGIN:VEVENT")).toHaveLength(1);
  });
  it("rejects made-up tokens without touching the database", async () => {
    const res = await app.request("/api/calendar/not-a-token.ics", {}, env);
    expect(res.status).toBe(404);
  });
});

describe("rate limits", () => {
  afterEach(() => vi.unstubAllGlobals());

  // Counting is tested in supabase/tests/rate_limit_test.sql; here, what the API does with it.
  const rpc = (response: () => Response) => {
    const calls: Array<{ url: string; body: unknown; auth: string | null }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      calls.push({ url: String(input), body: JSON.parse(String(init?.body)), auth: headers.get("apikey") });
      return response();
    });
    return calls;
  };

  it("counts each try in Postgres with the service key", async () => {
    const calls = rpc(() => Response.json(true));
    expect(await allow(env, "promo:203.0.113.9", 10, 600)).toBe(true);
    expect(calls).toEqual([
      { url: "https://example.supabase.co/rest/v1/rpc/rate_limit_hit", body: { p_key: "promo:203.0.113.9", p_max: 10, p_window_seconds: 600 }, auth: "sb_secret_test" },
    ]);
  });

  it("refuses once Postgres says the limit is reached", async () => {
    rpc(() => Response.json(false));
    expect(await allow(env, "promo:203.0.113.9", 10, 600)).toBe(false);
  });

  it("lets the request through if the check itself fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    rpc(() => Response.json({ message: "connection refused" }, { status: 503 }));
    expect(await allow(env, "promo:203.0.113.9", 10, 600)).toBe(true);
  });

  it("refuses instead, where letting a flood through costs money (allowStrict)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const calls = rpc(() => Response.json(true));
    expect(await allowStrict(env, "text-code:all", 200, 3600)).toBe(true);
    expect(calls).toEqual([{ url: "https://example.supabase.co/rest/v1/rpc/rate_limit_hit", body: { p_key: "text-code:all", p_max: 200, p_window_seconds: 3600 }, auth: "sb_secret_test" }]);
    rpc(() => Response.json(false));
    expect(await allowStrict(env, "text-code:all", 200, 3600)).toBe(false);
    rpc(() => Response.json({ message: "connection refused" }, { status: 503 }));
    expect(await allowStrict(env, "text-code:all", 200, 3600)).toBe(false);
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("fetch failed");
    });
    expect(await allowStrict(env, "text-code:all", 200, 3600)).toBe(false);
    expect(await allow(env, "promo:203.0.113.9", 10, 600)).toBe(true);
  });

  it("counts an IPv6 visitor by their /64, whichever limit it is", async () => {
    const calls = rpc(() => Response.json(true));
    const counted = async (key: string, count = allow) => {
      calls.length = 0;
      await count(env, key, 10, 600);
      return (calls[0]!.body as { p_key: string }).p_key;
    };
    // One visitor has every address in their /64, so each of them counts as the same visitor.
    expect(await counted("promo:2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe("promo:2001:db8:1:2::/64");
    expect(await counted("promo:2001:db8:1:2::9")).toBe("promo:2001:db8:1:2::/64");
    expect(await counted("pay:ip:2001:db8:1:2:ffff::1")).toBe("pay:ip:2001:db8:1:2::/64");
    expect(await counted("paperwork-upload:ip:2001:db8::1")).toBe("paperwork-upload:ip:2001:db8:0:0::/64");
    expect(await counted("document-pdf:::1")).toBe("document-pdf:0:0:0:0::/64");
    expect(await counted("text-code:ip:2001:db8:1:2::7", allowStrict)).toBe("text-code:ip:2001:db8:1:2::/64");
    // The /64 next door is someone else.
    expect(await counted("promo:2001:db8:1:3::9")).toBe("promo:2001:db8:1:3::/64");
    // A key that already has the /64 (sign-in codes), an IPv4 visitor and every other kind of key stay as they are.
    for (const key of [
      "text-code:ip:2001:db8:1:2::/64", "promo:203.0.113.9", "form:ip:unknown", "recover:all", "recover:email:ana@example.com",
      "pay:invoice:6f1c2a9e-8f0b-4c1d-9a57-3f2b6c1d0e4a", "password:6f1c2a9e-8f0b-4c1d-9a57-3f2b6c1d0e4a:0b7e5d2c-1a3f-4e6b-8c9d-2f4a6b8c0d1e",
    ]) {
      expect(await counted(key)).toBe(key);
    }
  });
});
