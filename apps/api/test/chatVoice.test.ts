/**
 * Voice notes written out with a company's OpenAI key (integrations/openai.ts transcribeWithKey,
 * services/chatVoice.ts): what's sent, and the switch it waits for. OpenAI is a stubbed fetch, built
 * to its published documentation for POST /v1/audio/transcriptions: nothing here has run against the
 * real service.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAiProblem, TRANSCRIBE_MODELS, transcribeWithKey } from "../src/integrations/openai";
import { voiceWordsOn } from "../src/services/chatVoice";

afterEach(() => vi.unstubAllGlobals());

describe("writing out a voice note", () => {
  it("sends the recording as a form with the model and asks for JSON, with the key and nothing else", async () => {
    let sent: { url: string; init: RequestInit } | null = null;
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      sent = { url, init };
      return new Response(JSON.stringify({ text: "  The gate is open.  " }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const words = await transcribeWithKey({}, "sk-test", { body: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm" }), fileName: "note.webm" }, { model: TRANSCRIBE_MODELS[0], timeoutMs: 5000 });
    expect(words).toBe("The gate is open.");
    expect(sent!.url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect((sent!.init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
    const form = sent!.init.body as FormData;
    expect(form.get("model")).toBe("gpt-4o-mini-transcribe");
    expect(form.get("response_format")).toBe("json");
    expect((form.get("file") as File).name).toBe("note.webm");
    expect(form.get("language")).toBeNull();
  });

  it("says when the key can't use the model, so the next one is tried, and finds no words in silence", async () => {
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ error: { code: "model_not_found", message: "no" } }), { status: 404 }));
    const error = await transcribeWithKey({}, "sk", { body: new Blob([]), fileName: "a.m4a" }, { model: "gpt-4o-mini-transcribe", timeoutMs: 5000 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpenAiProblem);
    expect((error as OpenAiProblem).kind).toBe("model");
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ text: "" }), { status: 200 }));
    expect(await transcribeWithKey({}, "sk", { body: new Blob([]), fileName: "a.m4a" }, { model: "whisper-1", timeoutMs: 5000 })).toBe("");
  });

  it("is off until an owner or admin turns it on", () => {
    expect(voiceWordsOn({})).toBe(false);
    expect(voiceWordsOn(null)).toBe(false);
    expect(voiceWordsOn({ chat_voice_words: "yes" })).toBe(false);
    expect(voiceWordsOn({ chat_voice_words: true })).toBe(true);
  });
});
