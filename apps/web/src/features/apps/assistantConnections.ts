/**
 * The AI assistants a person has connected to Crewtavo (their grants on Supabase Auth's OAuth
 * server), and whether each may change things (public.assistant_connections). A connection with
 * no row only reads: that includes every one made before "Allow changes" existed.
 */
import type { Database } from "@crewtavo/core/database";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ApiError, unwrap } from "@/lib/api";

type Db = SupabaseClient<Database>;

export interface AssistantConnection {
  clientId: string;
  name: string;
  logo: string | null;
  connectedAt: string;
  allowChanges: boolean;
}

/** This person's connected assistants, newest first. */
export async function loadConnections(db: Db): Promise<AssistantConnection[]> {
  const { data: grants, error } = await db.auth.oauth.listGrants();
  // Auth's OAuth server is off (a Supabase project can have it off): nothing can be connected.
  if (error?.code === "feature_disabled") return [];
  if (error) throw new ApiError("Your connected assistants couldn't be loaded. Try again in a moment.", error.status ?? 500);
  const rows = unwrap(await db.from("assistant_connections").select("client_id, allow_changes"));
  const allowed = new Set(rows.filter((r) => r.allow_changes).map((r) => r.client_id));
  return grants
    .map((g) => ({
      clientId: g.client.id,
      name: g.client.name?.trim() || "AI assistant",
      logo: g.client.logo_uri || null,
      connectedAt: g.granted_at,
      allowChanges: allowed.has(g.client.id),
    }))
    .sort((a, b) => b.connectedAt.localeCompare(a.connectedAt));
}

export async function setAllowChanges(db: Db, userId: string, clientId: string, allow: boolean): Promise<void> {
  unwrap(await db.from("assistant_connections").upsert({ user_id: userId, client_id: clientId, allow_changes: allow }, { onConflict: "user_id,client_id" }));
}

/**
 * Takes away "Allow changes" first, then the connection itself: if that second step doesn't get
 * through, the assistant can still only read. Connected again later, it starts out reading only.
 */
export async function disconnect(db: Db, clientId: string): Promise<void> {
  unwrap(await db.from("assistant_connections").delete().eq("client_id", clientId));
  const { error } = await db.auth.oauth.revokeGrant({ clientId });
  if (error) throw new ApiError("It couldn't be disconnected. It can only read now; try again in a moment.", error.status ?? 500);
}
