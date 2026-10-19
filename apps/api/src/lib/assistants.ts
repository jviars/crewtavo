/**
 * AI assistants (Claude, ChatGPT and other MCP clients) connect through Supabase Auth's OAuth
 * server, and the access token an assistant gets is the person's own Supabase JWT with one more
 * claim: client_id, the OAuth client the person approved. An ordinary sign-in has none.
 *
 * Each connection only reads until the person who made it chooses what it can change, or gives it
 * full access (public.assistant_connections, in Settings → AI assistants, which every role has; the
 * rules are in packages/core/src/assistants.ts). That's checked for the MCP tools (mcp.ts) and, in
 * an instance, at the gateway to Auth, the Data API and Storage (guardAssistant, from server.ts).
 * Our own API never takes changes from an assistant (requireUser in lib/auth.ts): its tools are how
 * it changes things. The database checks every Data API write and file again (the assistant_access
 * and assistant_areas migrations), so it all holds on a Supabase project without the gateway too.
 */
import { toAssistantAccess, type AssistantAccess } from "@crewtavo/core";
import type { Env } from "../env";
import { bearerToken } from "./auth";
import { userClient, type Db } from "./supabase";

export const ASSISTANT_READ_ONLY = "This assistant can only read. To let it make changes, choose what it can change in Crewtavo, under Settings → AI assistants.";
export const ASSISTANT_NO_API = "An AI assistant can't make changes through Crewtavo's API. It changes things with its Crewtavo tools, as far as it's been allowed in Settings → AI assistants.";

/** Requests that only read. */
export const isRead = (method: string) => method === "GET" || method === "HEAD" || method === "OPTIONS";

/**
 * The OAuth client an access token was issued to, or null for an ordinary sign-in. It reads the
 * token without checking it: that's for refusing things, and whoever answers checks the token.
 */
export function assistantClient(token: string): string | null {
  const payload = token.split(".")[1];
  if (!payload) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { client_id?: unknown } | null;
    return typeof claims?.client_id === "string" && claims.client_id ? claims.client_id : null;
  } catch {
    return null;
  }
}

/**
 * What the person let this assistant change, asked with the assistant's own token (it sees only its
 * own connection). Read only when there's no row. Null when the token isn't accepted (expired, say).
 */
export async function connectionAccess(db: Db, client: string): Promise<AssistantAccess | null> {
  const { data, error, status } = await db.from("assistant_connections").select("level, areas").eq("client_id", client).maybeSingle();
  if (status === 401) return null;
  return toAssistantAccess(error ? null : data);
}

/** Where an OAuth client signs in and refreshes its token: it never acts on the person's account. */
const OAUTH_CLIENT_PATHS = ["/token", "/oauth/token", "/oauth/revoke", "/oauth/userinfo", "/oauth/clients/register"];

/**
 * The gateway's part (server.ts): an assistant that only reads can't write through the Data API or
 * Storage, and no assistant changes the person's sign-in (their password or email, their other
 * sessions, or which apps they've connected). Which areas one that may change things can write to,
 * and whether it may delete, the database decides. Reads, and everyone else, go through as they are.
 */
export async function guardAssistant(env: Env, request: Request, prefix: string, send: (request: Request) => Promise<Response>): Promise<Response> {
  if (isRead(request.method)) return send(request);
  const token = bearerToken(request.headers.get("authorization") ?? undefined);
  const client = token ? assistantClient(token) : null;
  if (!token || !client) return send(request);
  if (prefix === "/auth/v1") {
    if (OAUTH_CLIENT_PATHS.includes(new URL(request.url).pathname.slice(prefix.length))) return send(request);
    return Response.json(
      { code: 403, error_code: "assistant_not_allowed", msg: "An AI assistant can't change your sign-in. Do that in Crewtavo itself." },
      { status: 403 },
    );
  }
  // A token the service won't accept gets its own answer from it (so the assistant knows to refresh).
  if ((await connectionAccess(userClient(env, token), client))?.level === "read") {
    return Response.json({ code: "assistant_read_only", message: ASSISTANT_READ_ONLY }, { status: 403 });
  }
  return send(request);
}
