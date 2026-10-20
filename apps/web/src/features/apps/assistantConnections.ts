/**
 * The AI assistants a person has connected to Crewtavo (their grants on Supabase Auth's OAuth
 * server), and what each may change (public.assistant_connections; the rules are in
 * packages/core/src/assistants.ts). A connection with no row only reads: that includes every one
 * made before access could be chosen.
 */
import { toAssistantAccess, type AssistantAccess } from "@crewtavo/core/assistants";
import type { Database } from "@crewtavo/core/database";
import type { SupabaseClient } from "@supabase/supabase-js";
import chatgptLogo from "@/assets/apps/chatgpt.svg";
import claudeLogo from "@/assets/apps/claude.svg";
import codexLogo from "@/assets/apps/codex.svg";
import { ApiError, unwrap } from "@/lib/api";

type Db = SupabaseClient<Database>;

/**
 * The real logo for the assistants we know, by the name each signs up with ("Codex", "Claude",
 * "Claude Code", "ChatGPT"): most don't send one, and then the card showed just a letter.
 */
export function assistantLogo(name: string): string | null {
  if (/\bcodex\b/i.test(name)) return codexLogo;
  if (/\bclaude\b/i.test(name)) return claudeLogo;
  if (/\b(chatgpt|openai)\b/i.test(name)) return chatgptLogo;
  return null;
}

/** Where each assistant keeps its connector settings, after copying the link. */
export const CONNECTOR_STEPS: Record<string, string[]> = {
  anthropic: ["In Claude, open Settings, then Connectors.", "Choose Add custom connector and paste the link above.", "Sign in with your Crewtavo account when Claude asks."],
  chatgpt: ["In ChatGPT, open Settings, then Apps and connectors.", "With developer mode on, add a connector and paste the link above.", "Sign in with your Crewtavo account when ChatGPT asks."],
};

export interface AssistantConnection {
  clientId: string;
  name: string;
  logo: string | null;
  connectedAt: string;
  access: AssistantAccess;
}

/** This person's connected assistants, newest first. */
export async function loadConnections(db: Db): Promise<AssistantConnection[]> {
  const { data: grants, error } = await db.auth.oauth.listGrants();
  // Auth's OAuth server is off (a Supabase project can have it off): nothing can be connected.
  if (error?.code === "feature_disabled") return [];
  if (error) throw new ApiError("Your connected assistants couldn't be loaded. Try again in a moment.", error.status ?? 500);
  const rows = unwrap(await db.from("assistant_connections").select("client_id, level, areas"));
  const access = new Map(rows.map((r) => [r.client_id, toAssistantAccess(r)]));
  return grants
    .map((g) => {
      const name = g.client.name?.trim() || "AI assistant";
      return {
        clientId: g.client.id,
        name,
        logo: assistantLogo(name) ?? (g.client.logo_uri || null),
        connectedAt: g.granted_at,
        access: access.get(g.client.id) ?? toAssistantAccess(null),
      };
    })
    .sort((a, b) => b.connectedAt.localeCompare(a.connectedAt));
}

export async function setAccess(db: Db, userId: string, clientId: string, access: AssistantAccess): Promise<void> {
  const areas = access.level === "areas" ? access.areas : [];
  unwrap(await db.from("assistant_connections").upsert({ user_id: userId, client_id: clientId, level: access.level, areas }, { onConflict: "user_id,client_id" }));
}

/**
 * Takes away its access first, then the connection itself: if that second step doesn't get
 * through, the assistant can still only read. Connected again later, it starts out reading only.
 */
export async function disconnect(db: Db, clientId: string): Promise<void> {
  unwrap(await db.from("assistant_connections").delete().eq("client_id", clientId));
  const { error } = await db.auth.oauth.revokeGrant({ clientId });
  if (error) throw new ApiError("It couldn't be disconnected. It can only read now; try again in a moment.", error.status ?? 500);
}
