/**
 * Crewtavo's own AI (services/ai.ts): which service answers each kind of ask, what comes back as an
 * answer, and what is said instead when there isn't a whole one. Anthropic's and OpenAI's APIs are
 * stand-ins here: fetch is stubbed, and each test answers the requests it expects. The database is
 * kept in memory (fixtures/memoryDb.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { encryptJson } from "../src/lib/crypto";
import { HttpError } from "../src/lib/http";
import { memoryDb, type MemoryDb, type Row } from "./fixtures/memoryDb";

const world = vi.hoisted(() => ({ db: null as unknown as MemoryDb }));
vi.mock("../src/lib/supabase", async () => {
  const { memoryClient } = await import("./fixtures/memoryDb");
  return { adminClient: () => memoryClient(() => world.db), userClient: () => memoryClient(() => world.db), publishableKey: () => "key" };
});
const { aiAvailable, checkCompanyAi, companyAi, complete, readDocument } = await import("../src/services/ai");
const { adminClient } = await import("../src/lib/supabase");

const env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7))),
  ANTHROPIC_API_KEY: "sk-ant-server",
} as Env;
const noServerKey = { ...env, ANTHROPIC_API_KEY: undefined } as Env;
const CO = "00000000-0000-4000-8000-0000000000c1";
const PAT = "00000000-0000-4000-8000-0000000000e1";

interface Call {
  url: string;
  key: string;
  body: Row;
}
type Answer = Row | { status: number; body: Row };
/** What the two services answer with; every request they got comes back. */
function serve(answers: { claude?: Answer; openai?: Answer | ((call: Call, n: number) => Answer); models?: Answer }) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
    const call = { url, key: headers.get("x-api-key") ?? headers.get("authorization")?.replace(/^Bearer /, "") ?? "", body: JSON.parse(String(init?.body ?? "{}")) as Row };
    calls.push(call);
    const pick = url.includes("anthropic.com") ? answers.claude : url.endsWith("/v1/models") ? answers.models : answers.openai;
    const answer = typeof pick === "function" ? pick(call, calls.filter((c) => c.url === url).length) : pick;
    if (!answer) return Response.json({ error: { message: "unexpected request" } }, { status: 500 });
    return "status" in answer && typeof answer.status === "number" && "body" in answer ? Response.json(answer.body, { status: answer.status }) : Response.json(answer);
  });
  return calls;
}
const claudeSays = (text: string | undefined, stop_reason = "end_turn") => ({
  id: "msg_test", type: "message", role: "assistant", model: "claude-opus-5-5",
  content: text === undefined ? [] : [{ type: "text", text }],
  stop_reason, stop_sequence: null, usage: { input_tokens: 40, output_tokens: 12 },
});
const openaiSays = (text: string, more: Row = {}) => ({ id: "resp_test", object: "response", status: "completed", output: [{ type: "reasoning", summary: [] }, { type: "message", role: "assistant", content: [{ type: "output_text", text }] }], ...more });
const openaiError = (status: number, error: Row) => ({ status, body: { error } });

/** The company's keys as Apps saves them: the sealed key, and for OpenAI the model picked beside it. */
async function keys(which: { claude?: string; openai?: string; choice?: "claude" | "chatgpt"; settings?: Row }) {
  world.db = memoryDb({ companies: [{ id: CO, settings: which.choice ? { ai: { service: which.choice } } : {} }], integrations: [], integration_secrets: [] });
  if (which.claude) {
    world.db.tables.integrations!.push({ company_id: CO, provider: "anthropic", status: "connected", settings: {} });
    world.db.tables.integration_secrets!.push({ company_id: CO, provider: "anthropic", ciphertext: await encryptJson(env, { api_key: which.claude }) });
  }
  if (which.openai) {
    world.db.tables.integrations!.push({ company_id: CO, provider: "chatgpt", status: "connected", settings: which.settings ?? { model: "gpt-6.1-sol", models: [{ slug: "gpt-6.1-sol", display_name: "gpt-6.1-sol" }, { slug: "gpt-6-luna", display_name: "gpt-6-luna" }] } });
    world.db.tables.integration_secrets!.push({ company_id: CO, provider: "chatgpt", ciphertext: await encryptJson(env, { api_key: which.openai }) });
  }
}

const ask = (e: Env = env, userId: string | null = PAT) => complete(e, { asker: { companyId: CO, userId }, system: "You edit short messages.", prompt: "Message:\nwe r coming tmrw", maxTokens: 1500 });
/** What the app says when there's no answer: its status and words. */
const refused = async (run: () => Promise<unknown> = ask) => {
  const error = await run().then(() => null, (e: unknown) => e);
  return error instanceof HttpError ? [error.status, error.message] : error;
};

beforeEach(() => keys({}));
afterEach(() => vi.unstubAllGlobals());

describe("an answer from Claude", () => {
  it("comes back as its text when Claude finished it", async () => {
    const asked = serve({ claude: claudeSays(" We'll be there tomorrow. ") });
    expect(await ask()).toBe("We'll be there tomorrow.");
    expect(asked.map((a) => a.url)).toEqual(["https://api.anthropic.com/v1/messages?beta=true"]);
    expect(asked[0]!.body).toMatchObject({ max_tokens: 1500, messages: [{ role: "user", content: "Message:\nwe r coming tmrw" }] });
  });

  it("isn't passed off as whole when it was cut off for length", async () => {
    serve({ claude: claudeSays("We'll be there tomorrow between 9 and", "max_tokens") });
    expect(await refused()).toEqual([502, "The AI's answer was cut off before it finished. Try again, or ask for something shorter."]);
  });

  it("says so when Claude declined, or answered with nothing", async () => {
    serve({ claude: claudeSays("I can't help with that.", "refusal") });
    expect(await refused()).toEqual([422, "The AI declined that request. Try rephrasing it."]);
    serve({ claude: claudeSays(undefined) });
    expect(await refused()).toEqual([502, "The AI returned an empty answer. Try again."]);
  });
});

describe("a model the Claude key can't use", () => {
  const noSuchModel = (model: string) => ({ status: 404, body: { type: "error", error: { type: "not_found_error", message: `model: ${model}` } } });
  const read = (e: Env) => readDocument(e, { asker: { companyId: CO, userId: PAT }, system: "Copy what is printed.", prompt: "Fill in the form.", file: { data: "AAAA", mediaType: "image/jpeg" }, schema: { type: "object" } });

  it("is named when someone asks, as it is when receipt reading is turned on, instead of a problem to try again", async () => {
    serve({ claude: noSuchModel("claude-opus-5-5") });
    const said = [502, "The Claude key can't use claude-opus-5-5. Check the key's workspace in the Claude Console."];
    expect(await refused()).toEqual(said);
    expect(await refused(() => read(env))).toEqual(said);
    serve({ claude: { status: 403, body: { type: "error", error: { type: "permission_error", message: "no" } } } });
    expect(await refused()).toEqual(said);
  });

  it("points at AI_MODEL when the server sets the model", async () => {
    const bogus = { ...env, AI_MODEL: "claude-bogus-9-9" } as Env;
    serve({ claude: noSuchModel("claude-bogus-9-9") });
    const said = "The Claude key can't use claude-bogus-9-9. Check the key's workspace in the Claude Console, or the model this server is set to (AI_MODEL).";
    expect(await refused(() => ask(bogus))).toEqual([502, said]);
    expect(await refused(() => read(bogus))).toEqual([502, said]);
    // The switch for reading receipts says the same.
    await keys({ claude: "sk-ant-company" });
    expect(await checkCompanyAi(bogus, adminClient(env), CO)).toBe(said);
  });
});

describe("which service answers", () => {
  it("is the server's Claude key for a company with no key of its own, as before", async () => {
    const asked = serve({ claude: claudeSays("OK") });
    await ask();
    expect(asked.map((a) => [new URL(a.url).host, a.key])).toEqual([["api.anthropic.com", "sk-ant-server"]]);
    expect(await companyAi(env, adminClient(env), CO)).toEqual({ service: "claude", apiKey: "sk-ant-server", own: false });
  });

  it("is the company's Claude key for a company that only ever added one, as before", async () => {
    await keys({ claude: "sk-ant-company" });
    const asked = serve({ claude: claudeSays("OK") });
    await ask();
    await ask(env, null);
    expect(asked.map((a) => [new URL(a.url).host, a.key])).toEqual([["api.anthropic.com", "sk-ant-company"], ["api.anthropic.com", "sk-ant-company"]]);
  });

  it("is the company's OpenAI key when that's the only key it added, whoever asks and for what Crewtavo does by itself", async () => {
    await keys({ openai: "sk-openai-company" });
    const asked = serve({ openai: openaiSays("OK") });
    await ask();
    await ask(env, null);
    expect(asked.map((a) => [a.url, a.key])).toEqual([["https://api.openai.com/v1/responses", "sk-openai-company"], ["https://api.openai.com/v1/responses", "sk-openai-company"]]);
  });

  it("stays Claude for a company with both keys until it chooses, then is the one it chose", async () => {
    await keys({ claude: "sk-ant-company", openai: "sk-openai-company" });
    let asked = serve({ claude: claudeSays("OK"), openai: openaiSays("OK") });
    await ask();
    expect(asked.map((a) => a.key)).toEqual(["sk-ant-company"]);

    await keys({ claude: "sk-ant-company", openai: "sk-openai-company", choice: "chatgpt" });
    asked = serve({ claude: claudeSays("OK"), openai: openaiSays("OK") });
    await ask();
    expect(asked.map((a) => a.key)).toEqual(["sk-openai-company"]);

    await keys({ claude: "sk-ant-company", openai: "sk-openai-company", choice: "claude" });
    asked = serve({ claude: claudeSays("OK"), openai: openaiSays("OK") });
    await ask();
    expect(asked.map((a) => a.key)).toEqual(["sk-ant-company"]);
  });

  it("is whichever key is left once the chosen one is removed", async () => {
    await keys({ claude: "sk-ant-company", choice: "chatgpt" });
    const asked = serve({ claude: claudeSays("OK") });
    await ask();
    expect(asked.map((a) => a.key)).toEqual(["sk-ant-company"]);
  });

  it("is nothing without a key anywhere, and says where to add one", async () => {
    const asked = serve({});
    expect(await refused(() => ask(noServerKey))).toEqual([501, "AI isn't turned on yet. An admin can add a Claude or OpenAI key on the Apps page."]);
    expect(asked).toEqual([]);
    expect(await aiAvailable(noServerKey, adminClient(env), { companyId: CO, userId: PAT })).toBe(false);
    expect(await aiAvailable(env, adminClient(env), { companyId: CO, userId: PAT })).toBe(true);
  });
});

describe("an answer from OpenAI with the company's key", () => {
  beforeEach(() => keys({ openai: "sk-openai-company" }));

  it("asks the Responses API with the system text as instructions, nothing kept, and the model picked on the Apps page", async () => {
    const asked = serve({ openai: openaiSays(" We'll be there tomorrow. ") });
    expect(await ask()).toBe("We'll be there tomorrow.");
    expect(asked[0]!.body).toEqual({
      model: "gpt-6.1-sol",
      instructions: "You edit short messages.",
      input: [{ role: "user", content: "Message:\nwe r coming tmrw" }],
      store: false,
      reasoning: { effort: "low" },
      // Room to think as well as to answer: OpenAI counts both.
      max_output_tokens: 3500,
    });
  });

  it("uses OPENAI_MODEL instead when the server sets it", async () => {
    const asked = serve({ openai: openaiSays("OK") });
    await ask({ ...env, OPENAI_MODEL: "gpt-6-luna" } as Env);
    expect(asked[0]!.body.model).toBe("gpt-6-luna");
  });

  it("reads a photo as an image and a PDF as a file, and asks for the answer in the schema", async () => {
    const asked = serve({ openai: openaiSays('{"total": 12}') });
    const schema = { type: "object", additionalProperties: false, required: ["total"], properties: { total: { type: "number" } } };
    const read = (mediaType: string) => readDocument(env, { asker: { companyId: CO, userId: PAT }, system: "Copy what is printed.", prompt: "Fill in the form.", file: { data: "AAAA", mediaType }, schema });
    expect(await read("image/jpeg")).toBe('{"total": 12}');
    await read("application/pdf");
    expect(asked[0]!.body.input).toEqual([{ role: "user", content: [{ type: "input_image", image_url: "data:image/jpeg;base64,AAAA" }, { type: "input_text", text: "Fill in the form." }] }]);
    expect(asked[1]!.body.input[0].content[0]).toEqual({ type: "input_file", filename: "document.pdf", file_data: "data:application/pdf;base64,AAAA" });
    expect(asked[0]!.body.text).toEqual({ format: { type: "json_schema", name: "answer", schema, strict: true } });
    expect(asked[0]!.body.instructions).toBe("Copy what is printed.");
  });

  it("says the same as with Claude when the answer was cut off, declined or empty", async () => {
    serve({ openai: { id: "r", status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] } });
    expect(await refused()).toEqual([502, "The AI's answer was cut off before it finished. Try again, or ask for something shorter."]);
    serve({ openai: { id: "r", status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "I can't help with that." }] }] } });
    expect(await refused()).toEqual([422, "The AI declined that request. Try rephrasing it."]);
    serve({ openai: { id: "r", status: "completed", output: [] } });
    expect(await refused()).toEqual([502, "The AI returned an empty answer. Try again."]);
  });

  it("says what to fix when the key is turned down, out of credit or busy, naming the right app", async () => {
    serve({ openai: openaiError(401, { code: "invalid_api_key", message: "Incorrect API key provided: sk-openai-company" }) });
    expect(await refused()).toEqual([502, "The OpenAI key on the Apps page didn't work. Check that it was copied correctly."]);
    serve({ openai: openaiError(429, { type: "insufficient_quota", code: "insufficient_quota" }) });
    expect(await refused()).toEqual([502, "The OpenAI key on the Apps page is out of credit or at its spending limit. Add credit at platform.openai.com, then try again."]);
    serve({ openai: openaiError(429, { code: "rate_limit_exceeded" }) });
    expect(await refused()).toEqual([429, "The AI is busy right now. Try again in a minute."]);
    serve({ openai: openaiError(500, { message: "The server had an error" }) });
    expect(await refused()).toEqual([502, "The AI service had a problem. Try again."]);
  });

  it("asks again without reasoning effort for a model that doesn't take it, and remembers", async () => {
    let asked = serve({ openai: (call) => (call.body.reasoning ? openaiError(400, { code: "unsupported_parameter", param: "reasoning.effort" }) : openaiSays("OK")) });
    expect(await ask()).toBe("OK");
    expect(asked.map((a) => Boolean(a.body.reasoning))).toEqual([true, false]);
    // Without thinking to leave room for, the answer's own allowance is all that's asked for.
    expect(asked[1]!.body.max_output_tokens).toBe(1500);
    expect(world.db.tables.integrations![0]!.settings.no_effort).toEqual(["gpt-6.1-sol"]);
    asked = serve({ openai: openaiSays("OK") });
    await ask();
    expect(asked.map((a) => Boolean(a.body.reasoning))).toEqual([false]);
  });

  it("moves to a model OpenAI still lists when the one picked is gone", async () => {
    const asked = serve({
      openai: (call) => (call.body.model === "gpt-6.1-sol" ? openaiError(404, { code: "model_not_found", param: "model" }) : openaiSays("OK")),
      models: { object: "list", data: [{ id: "gpt-7-nova", created: 5 }, { id: "gpt-6-luna", created: 3 }, { id: "text-embedding-9", created: 9 }] },
    });
    expect(await ask()).toBe("OK");
    expect(asked.filter((a) => a.url.endsWith("/responses")).map((a) => a.body.model)).toEqual(["gpt-6.1-sol", "gpt-6-luna"]);
    expect(world.db.tables.integrations![0]!.settings).toMatchObject({ model: "gpt-6-luna", models: [{ slug: "gpt-6-luna", display_name: "gpt-6-luna" }, { slug: "gpt-7-nova", display_name: "gpt-7-nova" }] });
  });

  it("never puts the key in what it says went wrong", async () => {
    serve({ openai: openaiError(401, { code: "invalid_api_key", message: "Incorrect API key provided: sk-openai-company" }) });
    expect(JSON.stringify(await refused())).not.toContain("sk-openai-company");
  });
});

describe("checking the company's key before a feature that spends it is turned on", () => {
  it("asks the service the key is for, and says what to fix in that app's words", async () => {
    await keys({ openai: "sk-openai-company" });
    serve({ models: { status: 401, body: { error: { code: "invalid_api_key" } } } });
    expect(await checkCompanyAi(env, adminClient(env), CO)).toBe("OpenAI turned the key down. Check that it was copied correctly, or make a new one at platform.openai.com/api-keys. The key is under Apps → ChatGPT.");
    serve({ models: { object: "list", data: [{ id: "gpt-6.1-sol" }] } });
    expect(await checkCompanyAi(env, adminClient(env), CO)).toBeNull();

    await keys({ claude: "sk-ant-company" });
    serve({ claude: { status: 401, body: { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } } } });
    expect(await checkCompanyAi(env, adminClient(env), CO)).toBe("Anthropic turned the Claude key down. Check that it was copied correctly on the Apps page, or make a new one in the Claude Console.");

    await keys({});
    expect(await checkCompanyAi(noServerKey, adminClient(env), CO)).toBe("Add a Claude or OpenAI key on the Apps page first, then turn this on.");
  });
});
