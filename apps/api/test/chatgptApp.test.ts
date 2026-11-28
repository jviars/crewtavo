/**
 * Apps → ChatGPT with the company's own OpenAI key (routes/apps.ts and routes/chatgpt.ts): the key
 * is checked with OpenAI before it's saved, the model is one OpenAI lists for it, and a company
 * with a Claude key too chooses which one Crewtavo's AI uses. Apps → Claude checks its key with
 * Anthropic the same way. OpenAI and Anthropic are a stubbed fetch and the database is kept in
 * memory: nothing reaches either.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { decryptJson, encryptJson } from "../src/lib/crypto";
import { memoryDb, type MemoryDb, type Row } from "./fixtures/memoryDb";

const world = vi.hoisted(() => ({ db: null as unknown as MemoryDb }));
vi.mock("../src/lib/supabase", async () => {
  const { memoryClient } = await import("./fixtures/memoryDb");
  return { adminClient: () => memoryClient(() => world.db), userClient: () => memoryClient(() => world.db), publishableKey: () => "key" };
});
const { app } = await import("../src/app");

const env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7))),
  APP_URL: "https://ops.example.com",
} as Env;
const CO = "00000000-0000-4000-8000-0000000000c1";
const KEY = "sk-proj-walnut-paving-openai-key";

const request = (method: string, path: string, body?: unknown, e: Env = env) =>
  app.request(`/api${path}`, { method, headers: { Authorization: "Bearer token", "X-Company-Id": CO, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, e);
const answer = async (res: Response | Promise<Response>) => [(await res).status, await (await res).json()] as [number, Row];

/** OpenAI's list of models for the key (or its refusal); the requests it got come back. */
function openai(models: Row | { status: number; error: Row }) {
  const calls: Array<{ url: string; key: string }> = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), key: new Headers(init?.headers).get("authorization") ?? "" });
    return "status" in models ? Response.json({ error: models.error }, { status: models.status as number }) : Response.json(models);
  });
  return calls;
}
const LISTED = { object: "list", data: [{ id: "gpt-6-luna", created: 2 }, { id: "gpt-6.1-sol", created: 4 }, { id: "gpt-6-astra", created: 3 }, { id: "text-embedding-9-large", created: 9 }, { id: "gpt-image-3", created: 8 }] };
const MODELS = ["gpt-6.1-sol", "gpt-6-astra", "gpt-6-luna"].map((slug) => ({ slug, display_name: slug }));

beforeEach(() => {
  world.db = memoryDb(
    {
      memberships: [{ company_id: CO, user_id: "viewer", active: true, role: "owner", role_id: null, subcontractor_id: null }],
      companies: [{ id: CO, name: "Walnut Paving", settings: {} }],
      integrations: [],
      integration_secrets: [],
      calendar_sources: [],
    },
    { integrations: ["company_id", "provider"], integration_secrets: ["company_id", "provider"] },
  );
  world.db.rpc.merge_company_settings = (args, db) => {
    const company = db.tables.companies!.find((c) => c.id === args.p_company)!;
    for (const [key, value] of Object.entries(args.p_settings as Row)) company.settings[key] = value && typeof value === "object" ? { ...(company.settings[key] ?? {}), ...(value as Row) } : value;
    return null;
  };
});
afterEach(() => vi.unstubAllGlobals());

const row = () => world.db.tables.integrations!.find((r) => r.provider === "chatgpt");
const saved = async () => {
  const secret = world.db.tables.integration_secrets!.find((r) => r.provider === "chatgpt");
  return secret ? decryptJson<{ api_key: string }>(env, secret.ciphertext) : null;
};

/** Anthropic's answer to reading the model's details, which is how a Claude key is checked; the requests it got come back. */
function anthropic(status: number | "down", errorType = "authentication_error") {
  const calls: Array<{ url: string; key: string }> = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const asked = input instanceof Request ? input : new Request(input, init);
    calls.push({ url: asked.url, key: asked.headers.get("x-api-key") ?? "" });
    if (status === "down") throw new TypeError("fetch failed");
    return status === 200 ? Response.json({ id: "claude-opus-5-5", type: "model" }) : Response.json({ type: "error", error: { type: errorType, message: "no" } }, { status });
  });
  return calls;
}
const CLAUDE_KEY = "sk-ant-api03-walnut-paving-key";
const claudeRow = () => world.db.tables.integrations!.find((r) => r.provider === "anthropic");

describe("saving the company's Claude key", () => {
  it("checks it with Anthropic first, for free, and only then shows it as installed", async () => {
    const calls = anthropic(200);
    expect(await answer(request("PUT", "/apps/anthropic/key", { api_key: CLAUDE_KEY }))).toEqual([200, { provider: "anthropic", status: "connected" }]);
    // Reading the model's details is all that's asked: nothing that costs.
    expect(calls).toEqual([{ url: "https://api.anthropic.com/v1/models/claude-opus-5-5", key: CLAUDE_KEY }]);
    expect(claudeRow()).toMatchObject({ status: "connected", account_label: "Key ending -key" });
    expect(JSON.stringify(world.db.tables)).not.toContain(CLAUDE_KEY);
  });

  it("isn't saved when Anthropic turns it down, and says what to fix", async () => {
    anthropic(401);
    expect(await answer(request("PUT", "/apps/anthropic/key", { api_key: CLAUDE_KEY }))).toEqual([400, { error: "Anthropic turned the Claude key down. Check that it was copied correctly on the Apps page, or make a new one in the Claude Console." }]);
    anthropic(403, "permission_error");
    expect((await answer(request("PUT", "/apps/anthropic/key", { api_key: CLAUDE_KEY })))[1].error).toMatch(/The Claude key can't use claude-opus-5-5/);
    expect(claudeRow()).toBeUndefined();
    expect(world.db.tables.integration_secrets).toEqual([]);
  });

  it("isn't saved unchecked when Anthropic can't be reached or is busy: it says to try again", async () => {
    anthropic("down");
    expect(await answer(request("PUT", "/apps/anthropic/key", { api_key: CLAUDE_KEY }))).toEqual([400, { error: "Crewtavo couldn't reach Anthropic to check the Claude key. Try again in a minute." }]);
    anthropic(529, "overloaded_error");
    expect(await answer(request("PUT", "/apps/anthropic/key", { api_key: CLAUDE_KEY }))).toEqual([400, { error: "Crewtavo couldn't reach Anthropic to check the Claude key. Try again in a minute." }]);
    anthropic(429, "rate_limit_error");
    expect(await answer(request("PUT", "/apps/anthropic/key", { api_key: CLAUDE_KEY }))).toEqual([400, { error: "Anthropic is busy right now. Try again in a minute." }]);
    expect(claudeRow()).toBeUndefined();
    expect(world.db.tables.integration_secrets).toEqual([]);
  }, 30_000);
});

describe("saving the company's OpenAI key", () => {
  it("checks it with OpenAI first, for free, and keeps it sealed with a model picked from the ones OpenAI lists", async () => {
    const calls = openai(LISTED);
    const [status, body] = await answer(request("PUT", "/apps/chatgpt/key", { api_key: KEY }));
    expect([status, body]).toEqual([200, { provider: "chatgpt", status: "connected", openai: { model: "gpt-6.1-sol", models: MODELS, model_locked: false } }]);
    // Listing models is all that's asked: nothing that costs.
    expect(calls).toEqual([{ url: "https://api.openai.com/v1/models", key: `Bearer ${KEY}` }]);
    expect(row()).toMatchObject({ status: "connected", account_label: "Key ending -key", settings: { model: "gpt-6.1-sol", models: MODELS } });
    expect(await saved()).toEqual({ api_key: KEY });
    // The key is sealed where it's kept and never comes back.
    expect(JSON.stringify(world.db.tables)).not.toContain(KEY);
    expect(JSON.stringify(body)).not.toContain(KEY);
  });

  it("isn't saved when OpenAI turns it down, and says what to fix", async () => {
    openai({ status: 401, error: { code: "invalid_api_key", message: `Incorrect API key provided: ${KEY}` } });
    expect(await answer(request("PUT", "/apps/chatgpt/key", { api_key: KEY }))).toEqual([400, { error: "OpenAI turned the key down. Check that it was copied correctly, or make a new one at platform.openai.com/api-keys." }]);
    openai({ status: 403, error: { message: "Missing scopes: api.model.read" } });
    expect(await answer(request("PUT", "/apps/chatgpt/key", { api_key: KEY }))).toEqual([400, { error: "That OpenAI key isn't allowed to list models. Give it All permissions, or Read on Models, at platform.openai.com/api-keys." }]);
    openai({ status: 503, error: {} });
    expect(await answer(request("PUT", "/apps/chatgpt/key", { api_key: KEY }))).toEqual([400, { error: "Crewtavo couldn't reach OpenAI to check the key. Try again in a minute." }]);
    openai({ object: "list", data: [{ id: "text-embedding-9-large" }] });
    expect((await answer(request("PUT", "/apps/chatgpt/key", { api_key: KEY })))[1].error).toMatch(/can't use any of OpenAI's text models/);
    expect(row()).toBeUndefined();
    expect(await saved()).toBeNull();
  });

  it("is only an owner's or admin's to save", async () => {
    world.db.tables.memberships![0]!.role = "office";
    openai(LISTED);
    expect((await request("PUT", "/apps/chatgpt/key", { api_key: KEY })).status).toBe(403);
    expect((await request("PUT", "/ai/service", { service: "chatgpt" })).status).toBe(403);
    expect((await request("PUT", "/apps/chatgpt/model", { model: "gpt-6-luna" })).status).toBe(403);
  });
});

describe("the model the key uses", () => {
  beforeEach(async () => {
    openai(LISTED);
    await request("PUT", "/apps/chatgpt/key", { api_key: KEY });
  });

  it("is one of the models OpenAI lists for the key", async () => {
    expect(await answer(request("PUT", "/apps/chatgpt/model", { model: "gpt-6-luna" }))).toEqual([200, { model: "gpt-6-luna" }]);
    expect(row()!.settings.model).toBe("gpt-6-luna");
    expect(await answer(request("PUT", "/apps/chatgpt/model", { model: "gpt-9-made-up" }))).toEqual([400, { error: "OpenAI doesn't list that model for your key. Check for new models, then pick one." }]);
    // A new key keeps the model picked before while OpenAI still lists it.
    await request("PUT", "/apps/chatgpt/key", { api_key: `${KEY}-2` });
    expect(row()!.settings.model).toBe("gpt-6-luna");
  });

  it("is read again from OpenAI on Check for new models, and moves on when the one picked is gone", async () => {
    await request("PUT", "/apps/chatgpt/model", { model: "gpt-6-astra" });
    openai({ object: "list", data: [{ id: "gpt-7-nova", created: 9 }, { id: "gpt-6-luna", created: 2 }] });
    const listed = [{ slug: "gpt-6-luna", display_name: "gpt-6-luna" }, { slug: "gpt-7-nova", display_name: "gpt-7-nova" }];
    expect(await answer(request("POST", "/apps/chatgpt/models"))).toEqual([200, { model: "gpt-6-luna", models: listed, model_locked: false }]);
    expect(row()!.settings).toMatchObject({ model: "gpt-6-luna", models: listed });
  });

  it("is the server's when OPENAI_MODEL is set, and then isn't picked on the page", async () => {
    const locked = { ...env, OPENAI_MODEL: "gpt-6-terra-2026-10" } as Env;
    const [, apps] = await answer(request("GET", "/apps", undefined, locked));
    expect((apps.apps as Row[]).find((a) => a.id === "chatgpt")?.openai).toEqual({ model: "gpt-6-terra-2026-10", models: MODELS, model_locked: true });
    expect((await request("PUT", "/apps/chatgpt/model", { model: "gpt-6-luna" }, locked)).status).toBe(409);
  });
});

describe("choosing between the company's Claude key and its OpenAI key", () => {
  const ai = async () => (await answer(request("GET", "/apps")))[1].ai;

  it("has nothing to choose with one key, and uses Claude with both until the company chooses", async () => {
    expect(await ai()).toEqual({ claude: false, chatgpt: false, choice: null, server: false, service: null });
    openai(LISTED);
    await request("PUT", "/apps/chatgpt/key", { api_key: KEY });
    expect(await ai()).toMatchObject({ claude: false, chatgpt: true, service: "chatgpt" });
    expect(await answer(request("PUT", "/ai/service", { service: "claude" }))).toEqual([400, { error: "Add a Claude key under Apps → Claude first." }]);

    world.db.tables.integrations!.push({ company_id: CO, provider: "anthropic", status: "connected", settings: {} });
    world.db.tables.integration_secrets!.push({ company_id: CO, provider: "anthropic", ciphertext: await encryptJson(env, { api_key: "sk-ant-walnut" }) });
    expect(await ai()).toMatchObject({ claude: true, chatgpt: true, choice: null, service: "claude" });

    expect(await answer(request("PUT", "/ai/service", { service: "chatgpt" }))).toEqual([200, { service: "chatgpt" }]);
    expect(world.db.tables.companies![0]!.settings).toEqual({ ai: { service: "chatgpt" } });
    expect(await ai()).toMatchObject({ choice: "chatgpt", service: "chatgpt" });
  });

  it("goes back to the key that's left when ChatGPT is uninstalled", async () => {
    openai(LISTED);
    await request("PUT", "/apps/chatgpt/key", { api_key: KEY });
    world.db.tables.integrations!.push({ company_id: CO, provider: "anthropic", status: "connected", settings: {} });
    world.db.tables.integration_secrets!.push({ company_id: CO, provider: "anthropic", ciphertext: await encryptJson(env, { api_key: "sk-ant-walnut" }) });
    await request("PUT", "/ai/service", { service: "chatgpt" });
    expect((await request("POST", "/apps/chatgpt/disconnect", {})).status).toBe(200);
    expect(await saved()).toBeNull();
    expect(await ai()).toMatchObject({ claude: true, chatgpt: false, service: "claude" });
  });
});

describe("Reading receipts, when the company's AI is its OpenAI key", () => {
  it("turns on only once OpenAI says the key works, and says what to fix in the ChatGPT app's words", async () => {
    openai(LISTED);
    await request("PUT", "/apps/chatgpt/key", { api_key: KEY });
    openai({ status: 401, error: { code: "invalid_api_key" } });
    expect(await answer(request("PUT", "/receipts/reading", { on: true }))).toEqual([400, { error: "OpenAI turned the key down. Check that it was copied correctly, or make a new one at platform.openai.com/api-keys. The key is under Apps → ChatGPT." }]);
    expect(world.db.tables.companies![0]!.settings.receipt_reading).toBeUndefined();
    const calls = openai(LISTED);
    expect(await answer(request("PUT", "/receipts/reading", { on: true }))).toEqual([200, { on: true }]);
    expect(calls.map((c) => c.url)).toEqual(["https://api.openai.com/v1/models"]);
    expect(world.db.rpcs.find((r) => r.fn === "merge_company_settings")?.args).toEqual({ p_company: CO, p_settings: { receipt_reading: true } });
  });

  it("can't be turned on with no key at all", async () => {
    openai(LISTED);
    expect(await answer(request("PUT", "/receipts/reading", { on: true }))).toEqual([400, { error: "Add a Claude or OpenAI key on the Apps page first, then turn this on." }]);
  });
});
