/**
 * Team chat for people in the field, beside routes/chat.ts (and, like it, as the signed-in person's
 * own database client, so row-level security decides):
 *
 *   GET  /chat/settings/voice-words     whether voice notes are written out with the OpenAI key (owners, admins)
 *   PUT  /chat/settings/voice-words     turn it on (once OpenAI accepts the key) or off
 */
import { ADMINS } from "@crewtavo/core";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../env";
import { checkOpenAiKey } from "../integrations/openai";
import { loadSecret } from "../integrations/tokens";
import { requireCompany, requireUser } from "../lib/auth";
import { dbError, HttpError, readJson } from "../lib/http";
import { adminClient } from "../lib/supabase";
import { voiceWordsOn } from "../services/chatVoice";

export const chatField = new Hono<AppEnv>();

// ---------------------------------------------------------------------------------------------
// Voice notes written out (Chat settings)
// ---------------------------------------------------------------------------------------------

chatField.get("/chat/settings/voice-words", requireUser, requireCompany(ADMINS), async (c) => {
  const admin = adminClient(c.env);
  const [company, key] = await Promise.all([
    admin.from("companies").select("settings").eq("id", c.var.companyId).maybeSingle(),
    loadSecret(c.env, admin, c.var.companyId, "chatgpt").catch(() => null),
  ]);
  if (company.error) throw dbError(company.error);
  return c.json({ on: voiceWordsOn(company.data?.settings), openai: Boolean(key?.api_key) });
});

chatField.put("/chat/settings/voice-words", requireUser, requireCompany(ADMINS), async (c) => {
  const body = await readJson(c, z.object({ on: z.boolean() }));
  if (body.on) {
    // It spends the business's own OpenAI key, so the key is asked about first.
    const key = (await loadSecret(c.env, adminClient(c.env), c.var.companyId, "chatgpt").catch(() => null))?.api_key;
    if (!key) throw new HttpError(400, "Add an OpenAI key under Apps → ChatGPT first, then turn this on.");
    const checked = await checkOpenAiKey(c.env, key);
    if ("problem" in checked) throw new HttpError(400, `${checked.problem} The key is under Apps → ChatGPT.`);
  }
  // As the owner or admin, so the database checks who may change the company's settings.
  const { error } = await c.var.db.rpc("merge_company_settings", { p_company: c.var.companyId, p_settings: { chat_voice_words: body.on } });
  if (error) throw dbError(error);
  return c.json({ on: body.on });
});
