/**
 * Claude for in-app AI (services/ai.ts): what comes back from it as an answer, and what is said
 * instead when there isn't a whole one. Anthropic's API is a stand-in here: fetch is stubbed, and
 * each test answers the one request it expects.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { HttpError } from "../src/lib/http";
import { complete } from "../src/services/ai";

const env = { SUPABASE_URL: "https://example.supabase.co", ANTHROPIC_API_KEY: "sk-ant-test" } as Env;

/** Anthropic answers with this message; the requests it got come back. */
function claude(message: { text?: string; stop_reason: string }) {
  const asked: Array<{ url: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    asked.push({ url: String(input instanceof Request ? input.url : input), body: JSON.parse(String(init?.body ?? "{}")) });
    return Response.json({
      id: "msg_test", type: "message", role: "assistant", model: "claude-opus-5-5",
      content: message.text === undefined ? [] : [{ type: "text", text: message.text }],
      stop_reason: message.stop_reason, stop_sequence: null, usage: { input_tokens: 40, output_tokens: 12 },
    });
  });
  return asked;
}

const ask = () => complete(env, { system: "You edit short messages.", prompt: "Message:\nwe r coming tmrw", maxTokens: 1500 });
/** What the app says when there's no answer: its status and words. */
const refused = async () => {
  const error = await ask().then(() => null, (e: unknown) => e);
  return error instanceof HttpError ? [error.status, error.message] : error;
};

afterEach(() => vi.unstubAllGlobals());

describe("an answer from Claude", () => {
  it("comes back as its text when Claude finished it", async () => {
    const asked = claude({ text: " We'll be there tomorrow. ", stop_reason: "end_turn" });
    expect(await ask()).toBe("We'll be there tomorrow.");
    expect(asked.map((a) => a.url)).toEqual(["https://api.anthropic.com/v1/messages?beta=true"]);
    expect(asked[0]!.body).toMatchObject({ max_tokens: 1500, messages: [{ role: "user", content: "Message:\nwe r coming tmrw" }] });
  });

  it("isn't passed off as whole when it was cut off for length", async () => {
    claude({ text: "We'll be there tomorrow between 9 and", stop_reason: "max_tokens" });
    expect(await refused()).toEqual([502, "The AI's answer was cut off before it finished. Try again, or ask for something shorter."]);
  });

  it("says so when Claude declined, or answered with nothing", async () => {
    claude({ text: "I can't help with that.", stop_reason: "refusal" });
    expect(await refused()).toEqual([422, "The AI declined that request. Try rephrasing it."]);
    claude({ stop_reason: "end_turn" });
    expect(await refused()).toEqual([502, "The AI returned an empty answer. Try again."]);
  });
});
