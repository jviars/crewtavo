/**
 * The public demo (CREWTAVO_DEMO=1): off everywhere else, what it refuses, that nothing it sends
 * leaves the server, its limits at the gateway, and that each trade's sample business only names
 * what its trade's price list has (the database itself is checked by the demo instance; docs/demo.md).
 */
import { DEMO_TRADES, demoTradeFromLink, getPreset, presetSummaries } from "@crewtavo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import type { Env } from "../src/env";
import { DEMO_FILE_BYTES, DEMO_STORAGE_BYTES, demoBlocks, demoSnapshots, gatewayRefusal, isDemo } from "../src/lib/demoMode";
import { emailConfigured, sendEmail, sendSms, smsConfigured } from "../src/lib/notify";
import { FEATURED_STORIES, quantityFor, storyFor, storyItems } from "../src/services/demoStories";
import { runTask } from "../src/tasks";

const limits = vi.hoisted(() => ({ allowed: true, keys: [] as string[] }));
vi.mock("../src/lib/limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/limit")>()),
  allow: async (_env: unknown, key: string) => (limits.keys.push(key), limits.allowed),
  allowStrict: async (_env: unknown, key: string) => (limits.keys.push(key), limits.allowed),
}));
/** How many businesses the person asking the gateway is in already. */
const members = vi.hoisted(() => ({ count: 0 }));
vi.mock("../src/lib/supabase", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/lib/supabase")>();
  // Any query: itself for every step, and when awaited, no rows and the count above.
  const chain: object = new Proxy(() => undefined, {
    get: (_target, name) => (name === "then" ? (done: (v: unknown) => void) => done({ data: [], count: members.count, error: null }) : () => chain),
  });
  return { ...real, adminClient: () => chain };
});

const env: Env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  APP_URL: "https://ops.example.com",
};
const demoEnv: Env = { ...env, CREWTAVO_DEMO: "1", CREWTAVO_SINGLE_COMPANY: "0" };
const json = (body: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => {
  limits.allowed = true;
  limits.keys.length = 0;
  members.count = 0;
});
afterEach(() => vi.restoreAllMocks());

describe("the demo switch", () => {
  it("takes both settings, so CREWTAVO_DEMO set by mistake on a business's own Crewtavo does nothing", async () => {
    expect(isDemo(env)).toBe(false);
    expect(isDemo(demoEnv)).toBe(true);
    expect(isDemo({ CREWTAVO_DEMO: "1" })).toBe(false);
    expect(isDemo({ CREWTAVO_DEMO: "1", CREWTAVO_SINGLE_COMPANY: "1" })).toBe(false);
    expect(isDemo({ CREWTAVO_SINGLE_COMPANY: "0" })).toBe(false);
    expect((await (await app.request("/api/config", {}, { ...env, CREWTAVO_DEMO: "1" })).json()).demo).toBe(false);
    expect((await (await app.request("/api/config", {}, env)).json()).demo).toBe(false);
    expect((await (await app.request("/api/config", {}, demoEnv)).json()).demo).toBe(true);
  });

  it("has no demo routes when it's off", async () => {
    expect((await app.request("/api/demo/start", json({ trade: "paving" }), env)).status).toBe(404);
    expect((await app.request("/api/demo/switch", json({ as: "crew" }), env)).status).toBe(404);
    expect((await app.request("/api/demo/end", json({}), env)).status).toBe(404);
  });

  it("turns off AI and payments in the config, whatever keys the server has", async () => {
    const keys = { ANTHROPIC_API_KEY: "sk-ant-test", STRIPE_SECRET_KEY: "sk_test_1" };
    expect((await (await app.request("/api/config", {}, { ...env, ...keys })).json()).features).toMatchObject({ ai: true, payments: true });
    expect((await (await app.request("/api/config", {}, { ...demoEnv, ...keys })).json()).features).toMatchObject({ ai: false, payments: false, email: true, sms: true });
  });
});

describe("starting a demo", () => {
  it("needs the visitor to agree to this version of the terms", async () => {
    expect((await app.request("/api/demo/start", json({ trade: "paving" }), demoEnv)).status).toBe(400);
    expect((await app.request("/api/demo/start", json({ trade: "paving", terms_version: "1900-01-01" }), demoEnv)).status).toBe(409);
  });

  it("takes the start screen's language, only one Crewtavo speaks", async () => {
    const { TERMS_VERSION } = await import("@crewtavo/core");
    expect((await app.request("/api/demo/start", json({ trade: "paving", terms_version: TERMS_VERSION, locale: "fr" }), demoEnv)).status).toBe(400);
  });

  it("is limited per address and overall, refusing when it can't count", async () => {
    limits.allowed = false;
    const { TERMS_VERSION } = await import("@crewtavo/core");
    const res = await app.request("/api/demo/start", { ...json({ trade: "paving", terms_version: TERMS_VERSION }), headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.9" } }, demoEnv);
    expect(res.status).toBe(429);
    expect(limits.keys[0]).toMatch(/^demo-start:hour:/);
  });

  it("needs a sign-in to switch people or start over", async () => {
    expect((await app.request("/api/demo/switch", json({ as: "crew" }), demoEnv)).status).toBe(401);
    expect((await app.request("/api/demo/end", json({}), demoEnv)).status).toBe(401);
  });
});

describe("what the demo refuses", () => {
  it.each([
    ["PUT", "/api/apps/stripe/key"],
    ["PUT", "/api/apps/twilio/account"],
    ["POST", "/api/apps/quickbooks/connect"],
    ["PUT", "/api/apps/quickbooks/app-keys"],
    ["POST", "/api/ai/chatgpt/sign-in"],
    ["POST", "/api/ai/rewrite"],
    ["POST", "/api/kb/ask"],
    ["PUT", "/api/email"],
    ["POST", "/api/email/test"],
    ["POST", "/api/calendars"],
    ["POST", "/api/calendars/google"],
    ["PUT", "/api/website-forms/turnstile"],
    ["POST", "/api/drive/import"],
    ["POST", "/api/analytics/check"],
    ["POST", "/api/postcards/123/send"],
    ["POST", "/api/receipts/read"],
    ["POST", "/api/paving/detect"],
    ["POST", "/api/push/subscriptions"],
    ["POST", "/api/push/test"],
    ["POST", "/api/companies"],
    ["POST", "/api/team/invite"],
    ["POST", "/api/team/abc/invite-link"],
    ["POST", "/api/team/abc/password-link"],
    ["POST", "/api/subs/abc/access"],
    ["POST", "/api/subs/abc/sign-in-link"],
    ["POST", "/api/auth/email-link"],
    ["POST", "/api/auth/text-code"],
    ["GET", "/mcp"],
    ["POST", "/MCP/"],
    ["POST", "/api//team/invite/"],
  ])("refuses %s %s", (method, path) => {
    expect(demoBlocks(method, path)).toBe(true);
  });

  it.each([
    ["GET", "/api/apps"],
    ["GET", "/api/email"],
    ["POST", "/api/quotes/abc/send"],
    ["POST", "/api/messages"],
    ["POST", "/api/measurements"],
    ["PATCH", "/api/team/abc/access"],
    ["GET", "/api/config"],
  ])("lets %s %s through", (method, path) => {
    expect(demoBlocks(method, path)).toBe(false);
  });

  it("counts a visitor's changes in the app too, and holds a website form's post to a size", async () => {
    const on = await app.request("/api/team/abc/access", { method: "PATCH", headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.9" }, body: "{}" }, demoEnv);
    expect(on.status).toBe(401); // counted, then on to the route, which wants a sign-in
    expect(limits.keys.some((k) => k.startsWith("demo-write:"))).toBe(true);
    limits.allowed = false;
    expect((await app.request("/api/team/abc/access", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: "{}" }, demoEnv)).status).toBe(429);
    limits.allowed = true;
    const big = await app.request("/f/abcdefgh12", { method: "POST", headers: { "content-length": String(3 * 1024 * 1024) }, body: "x" }, demoEnv);
    expect(big.status).toBe(413);
  });

  it("says so in the demo, and does nothing anywhere else", async () => {
    const off = await app.request("/api/team/invite", json({ email: "a@example.com" }), env);
    expect(off.status).toBe(401);
    const on = await app.request("/api/team/invite", json({ email: "a@example.com" }), demoEnv);
    expect(on.status).toBe(403);
    expect(await on.json()).toMatchObject({ code: "demo" });
  });
});

describe("sending in the demo", () => {
  it("looks sent and goes nowhere, whatever keys the server has", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const keys = { RESEND_API_KEY: "re_test", EMAIL_FROM: "a@b.test", TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "t", TWILIO_FROM_NUMBER: "+15405550100" };
    expect(await sendEmail({ ...demoEnv, ...keys }, { to: "client@example.com", subject: "Your quote", text: "Hi" }, "company-1")).toEqual({ sent: true, id: "demo" });
    expect(await sendSms({ ...demoEnv, ...keys }, { to: "+15405550187", body: "On my way" }, "company-1")).toEqual({ sent: true, id: "demo" });
    expect(fetch).not.toHaveBeenCalled();
    expect(emailConfigured(demoEnv)).toBe(true);
    expect(smsConfigured(demoEnv)).toBe(true);
    expect(emailConfigured(env)).toBe(false);
  });
});

describe("background tasks in the demo", () => {
  it("skips the ones that reach outside", async () => {
    for (const task of ["calendars", "website", "social", "postcards", "review_sync", "backups", "hosting", "railway"] as const) {
      expect(await runTask(task, demoEnv)).toEqual({ skipped: "demo" });
    }
  });

  it("leaves a normal instance's businesses alone", async () => {
    // Without CREWTAVO_DEMO the task returns before touching the database.
    expect(await runTask("demo", env)).toEqual({ removed: 0, accounts: 0, failed: 0 });
    expect(await runTask("demo", { ...env, CREWTAVO_DEMO: "1", CREWTAVO_SINGLE_COMPANY: "1" })).toEqual({ removed: 0, accounts: 0, failed: 0 });
    expect(await runTask("demo", { ...env, CREWTAVO_DEMO: "1" })).toEqual({ removed: 0, accounts: 0, failed: 0 });
  });
});

describe("the gateway in the demo", () => {
  const nobody = () => ({ user: null, server: false });
  const visitor = () => ({ user: "user-1", server: false });
  const outside = "10.0.0.7"; // Railway's edge, or the web server in front
  const req = (method: string, path: string, headers: Record<string, string> = {}) => new Request(`http://127.0.0.1${path}`, { method, headers });
  const write = (path: string, length = "120") => req("POST", path, { "content-length": length });

  it("does nothing anywhere else", async () => {
    expect(await gatewayRefusal(env, req("POST", "/rest/v1/rpc/graphql"), "203.0.113.9", visitor, outside)).toBeNull();
  });

  it("refuses the database's GraphQL", async () => {
    expect((await gatewayRefusal(demoEnv, write("/rest/v1/rpc/graphql"), "203.0.113.9", visitor, outside))?.status).toBe(403);
    expect((await gatewayRefusal(demoEnv, write("/rest/v1/rpc/%67raphql"), "203.0.113.9", visitor, outside))?.status).toBe(403);
  });

  it("lets the server set up a visitor's business, and nobody a second one", async () => {
    expect(await gatewayRefusal(demoEnv, write("/rest/v1/rpc/create_company"), "127.0.0.1", visitor, "127.0.0.1")).toBeNull();
    members.count = 1;
    expect((await gatewayRefusal(demoEnv, write("/rest/v1/rpc/Create_Company"), "203.0.113.9", visitor, outside))?.status).toBe(403);
    members.count = 0;
    expect((await gatewayRefusal(demoEnv, write("/rest/v1/rpc/create_company"), "203.0.113.9", nobody, outside))?.status).toBe(403);
  });

  it("holds a change to its size, which it has to say", async () => {
    expect((await gatewayRefusal(demoEnv, write("/rest/v1/clients", String(3 * 1024 * 1024)), "203.0.113.9", visitor, outside))?.status).toBe(413);
    expect((await gatewayRefusal(demoEnv, req("POST", "/rest/v1/clients"), "203.0.113.9", visitor, outside))?.status).toBe(411);
    expect(await gatewayRefusal(demoEnv, req("DELETE", "/rest/v1/clients?id=eq.1"), "203.0.113.9", visitor, outside)).toBeNull();
  });

  it("refuses a file bigger than the demo takes, and too many files", async () => {
    const big = String(DEMO_FILE_BYTES + 1024 * 1024);
    expect((await gatewayRefusal(demoEnv, write("/storage/v1/object/files/a/b.jpg", big), "203.0.113.9", visitor, outside))?.status).toBe(413);
    expect((await gatewayRefusal(demoEnv, req("POST", "/storage/v1/upload/resumable", { "upload-length": big }), "203.0.113.9", visitor, outside))?.status).toBe(413);
    expect(await gatewayRefusal(demoEnv, write("/storage/v1/object/files/a/b.jpg", "200000"), "203.0.113.9", visitor, outside)).toBeNull();
    expect(limits.keys).toContain("demo-upload:203.0.113.9");
    limits.allowed = false;
    expect((await gatewayRefusal(demoEnv, write("/storage/v1/object/files/a/c.jpg", "200000"), "203.0.113.9", visitor, outside))?.status).toBe(429);
  });

  it("counts a visitor's changes, not reads and not the server's own", async () => {
    expect(await gatewayRefusal(demoEnv, req("GET", "/rest/v1/clients"), "203.0.113.9", visitor, outside)).toBeNull();
    expect(limits.keys).toEqual([]);
    await gatewayRefusal(demoEnv, write("/rest/v1/clients"), "127.0.0.1", visitor, "127.0.0.1");
    await gatewayRefusal(demoEnv, write("/rest/v1/clients"), "203.0.113.9", () => ({ user: null, server: true }), outside);
    expect(limits.keys).toEqual([]);
    limits.allowed = false;
    expect((await gatewayRefusal(demoEnv, req("PATCH", "/rest/v1/clients", { "content-length": "40" }), "203.0.113.9", visitor, outside))?.status).toBe(429);
    expect(limits.keys).toEqual(["demo-write:203.0.113.9"]);
  });

  it("never takes a visitor for the server by an address a header gave", async () => {
    limits.allowed = false;
    // A forged CF-Connecting-IP of 127.0.0.1 makes the visitor's address look like this machine's; the connection doesn't.
    expect((await gatewayRefusal(demoEnv, write("/rest/v1/clients"), "127.0.0.1", visitor, outside))?.status).toBe(429);
  });

  it("holds every business to the demo's storage, whatever its owner set", async () => {
    const source = demoSnapshots(async () => ({ companyUsed: 0, companyLimit: null, userUsed: 0, userLimit: null, owner: true, member: true }));
    expect((await source("c", "u")).companyLimit).toBe(DEMO_STORAGE_BYTES);
    const set = demoSnapshots(async () => ({ companyUsed: 0, companyLimit: 1_000_000, userUsed: 0, userLimit: null, owner: true, member: true }));
    expect((await set("c", "u")).companyLimit).toBe(1_000_000);
    expect((await set("c", "u")).files?.videoMaxBytes).toBe(DEMO_FILE_BYTES);
  });
});

describe("the sample businesses", () => {
  it("has one written for each trade the start screen asks about", () => {
    for (const trade of DEMO_TRADES) expect(FEATURED_STORIES[trade.preset]?.preset).toBe(trade.preset);
  });

  it.each(Object.values(FEATURED_STORIES).map((s) => [s.preset, s] as const))("names only items on %s's price list", (preset, story) => {
    const names = new Set(getPreset(preset).services.map((s) => s.name));
    expect(story.uses?.length).toBeGreaterThan(5);
    for (const name of story.uses ?? []) expect(names, name).toContain(name);
  });

  it.each(presetSummaries().map((p) => [p.id] as const))("has a business for %s", (id) => {
    const preset = getPreset(id);
    const story = storyFor(preset);
    expect(story.business).not.toBe("");
    expect(story.team.map((p) => p.role)).toContain("crew_lead");
    if (FEATURED_STORIES[id]) return;
    // The general story quotes from the price list: items that read as work, each with a sensible amount.
    const items = storyItems(preset.services);
    for (const item of [items.a, items.b, items.c, items.d, items.labor, items.call]) {
      expect(preset.services.map((s) => s.name)).toContain(item.name);
      expect(quantityFor(item.unit)).toBeGreaterThan(0);
    }
    expect(/trip|service call|minimum/i.test(items.a.name)).toBe(false);
  });

  it("reads a trade from the website's links", () => {
    const ids = presetSummaries().map((p) => p.id);
    expect(demoTradeFromLink("lawn", ids)).toBe("lawn_exterior");
    expect(demoTradeFromLink("Roofing", ids)).toBe("roofing_exteriors");
    expect(demoTradeFromLink("paving", ids)).toBe("paving");
    expect(demoTradeFromLink("pool-service", ids)).toBe("pool_service");
    expect(demoTradeFromLink("nonsense", ids)).toBeNull();
    expect(demoTradeFromLink(null, ids)).toBeNull();
  });
});
