/**
 * AI assistants (Claude, ChatGPT and other MCP clients) connect through Supabase Auth's OAuth
 * server, and the access token an assistant gets is the person's own Supabase JWT with one more
 * claim: client_id, the OAuth client the person approved. An ordinary sign-in has none.
 *
 * Each connection only reads until the person who made it turns on "Allow changes" for it
 * (public.assistant_connections, shown in Settings → Apps → AI assistants). That's checked for the
 * MCP tools (mcp.ts), for our own API (requireUser in lib/auth.ts) and, in an instance, at the
 * gateway to Auth, the Data API and Storage (guardAssistant, from server.ts). The database checks
 * it again for the Data API and Storage (the assistant_access migration), so it holds on a
 * Supabase project without the gateway too.
 */
import type { Env } from "../env";
import { bearerToken } from "./auth";
import { userClient, type Db } from "./supabase";

export const ASSISTANT_READ_ONLY =
  'This assistant can only read. To let it make changes, turn on "Allow changes" for it in Crewtavo, under Settings → Apps → AI assistants.';

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
 * Whether the person turned on "Allow changes" for this assistant, asked with the assistant's own
 * token. Null when the token isn't accepted (expired, say).
 */
export async function allowsChanges(db: Db, client: string): Promise<boolean | null> {
  const { data, error, status } = await db.from("assistant_connections").select("allow_changes").eq("client_id", client).maybeSingle();
  if (status === 401) return null;
  return !error && data?.allow_changes === true;
}

/** Where an OAuth client signs in and refreshes its token: it never acts on the person's account. */
const OAUTH_CLIENT_PATHS = ["/token", "/oauth/token", "/oauth/revoke", "/oauth/userinfo", "/oauth/clients/register"];

/**
 * The gateway's part (server.ts): an assistant that only reads can't write through the Data API or
 * Storage, and no assistant changes the person's sign-in (their password or email, their other
 * sessions, or which apps they've connected). Reads, and everyone else, go through as they are.
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
  if ((await allowsChanges(userClient(env, token), client)) === false) {
    return Response.json({ code: "assistant_read_only", message: ASSISTANT_READ_ONLY }, { status: 403 });
  }
  return send(request);
}
