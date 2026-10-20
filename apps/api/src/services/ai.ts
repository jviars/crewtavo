/**
 * Claude for in-app AI: rewriting messages, drafting quote text, answering from SOPs.
 * A company can bring its own Anthropic key (Apps page); otherwise the deployment's key is used.
 */
import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "../env";
import { loadSecret } from "../integrations/tokens";
import { HttpError } from "../lib/http";
import type { Db } from "../lib/supabase";

export interface CompleteOptions {
  system: string;
  prompt: string;
  effort?: "low" | "medium" | "high";
  maxTokens?: number;
  apiKey?: string | null;
}

/** The key a company added under Apps → Claude, if any. */
export async function companyAnthropicKey(env: Env, admin: Db, companyId: string): Promise<string | null> {
  const secret = await loadSecret(env, admin, companyId, "anthropic").catch(() => null);
  return secret?.api_key ?? null;
}

export async function complete(env: Env, options: CompleteOptions): Promise<string> {
  const apiKey = options.apiKey || env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new HttpError(501, "AI isn't turned on yet. An admin can add a Claude key on the Apps page.");
  const client = new Anthropic({ apiKey });

  try {
    const response = await client.beta.messages.create({
      model: env.AI_MODEL || "claude-opus-5-5",
      max_tokens: options.maxTokens ?? 2000,
      system: options.system,
      messages: [{ role: "user", content: options.prompt }],
      output_config: { effort: options.effort ?? "low" },
      // If a request is declined, the API retries it on Anthropic's recommended fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    if (response.stop_reason === "refusal") {
      throw new HttpError(422, "The AI declined that request. Try rephrasing it.");
    }
    const text = response.content
      .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === "text")
      .map((block) => block.text)
      .join("")
      .trim();
    if (!text) throw new HttpError(502, "The AI returned an empty answer. Try again.");
    return text;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    if (error instanceof Anthropic.AuthenticationError) throw new HttpError(502, "The Claude key on the Apps page didn't work. Check that it was copied correctly.");
    if (error instanceof Anthropic.RateLimitError) throw new HttpError(429, "The AI is busy right now. Try again in a minute.");
    if (error instanceof Anthropic.APIError) throw new HttpError(502, "The AI service had a problem. Try again.");
    throw error;
  }
}
