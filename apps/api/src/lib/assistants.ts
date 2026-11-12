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
 *
 * Above each person's choice is the company's own switch (off, or look things up only: Settings →
 * AI assistants, for owners and admins). The database holds every assistant's token to it before
 * each Data API request (the assistants_off_everywhere migration), and so do the MCP tools, the
 * gateway and our API (companySwitch below). An owner can also see and end anyone's connection
 * (teamConnections, endConnection).
 */
import { isStaff, toAssistantAccess, type AssistantAccess } from "@crewtavo/core";
import type { Env } from "../env";
import { bearerToken } from "./auth";
import { dbError } from "./http";
import { userClient, type Db } from "./supabase";

export const ASSISTANT_READ_ONLY = "This assistant can only read. To let it make changes, choose what it can change in Crewtavo, under Settings → AI assistants.";
export const ASSISTANT_NO_API = "An AI assistant can't make changes through Crewtavo's API. It changes things with its Crewtavo tools, as far as it's been allowed in Settings → AI assistants.";
/** Assistants work for a business's own team: never with a sub's sign-in (mcp.ts, guardConsent). */
export const NO_ASSISTANTS_FOR_SUBS = "AI assistants are for a business's own team. A subcontractor's sign-in can't use one.";

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

/**
 * The company's own switch (Settings → AI assistants, companies.settings.assistants), as the
 * database reads it for the person an assistant's token belongs to (public.assistant_switch, the
 * assistants_off_everywhere migration): off, read only, or on. A token is the person's, not a
 * company's, so for someone on the team of several businesses the strictest setting holds, and
 * `company` names the business that set it.
 */
export interface CompanySwitch {
  state: "on" | "read_only" | "off";
  company: string | null;
  companyId: string | null;
}

/** What an assistant is told while its business has assistants turned off. */
export const assistantsOff = (company: string | null) =>
  `AI assistants are turned off for ${company || "this business"}. An owner or admin can turn them on in Crewtavo, under Settings → AI assistants.`;
/** And while the business only lets them look things up. */
export const assistantsLookOnly = (company: string | null) =>
  `Assistants can only look things up for ${company || "this business"}, not make changes. An owner or admin can change this in Crewtavo, under Settings → AI assistants.`;

/**
 * The switch for the person whose token `db` carries. On when it can't be asked (the token isn't
 * accepted, or the database isn't answering): whoever answers the request checks the token, and the
 * database holds an assistant to the switch itself before every Data API request.
 */
export async function companySwitch(db: Db): Promise<CompanySwitch> {
  const on: CompanySwitch = { state: "on", company: null, companyId: null };
  try {
    // A GET, as everything an assistant that only reads may send.
    const { data, error } = await db.rpc("assistant_switch", {}, { get: true });
    const answer = !error && data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
    if (answer?.state !== "off" && answer?.state !== "read_only") return on;
    return { state: answer.state, company: typeof answer.company === "string" ? answer.company : null, companyId: typeof answer.company_id === "string" ? answer.company_id : null };
  } catch {
    return on;
  }
}

/** One assistant someone on the team connected, as the owner sees it (Settings → AI assistants). */
export interface TeamConnection {
  user_id: string;
  full_name: string;
  client_id: string;
  /** What the app called itself when it signed up with Auth's OAuth server: anyone can pick any name. */
  name: string;
  logo: string | null;
  connected_at: string;
  access: AssistantAccess;
}

/**
 * Every assistant the company's team has connected, newest first. `admin` is the server's own
 * client: the database gives this to no one signed in, so the route checks the owner asked first.
 */
export async function teamConnections(admin: Db, companyId: string): Promise<TeamConnection[]> {
  const { data, error } = await admin.rpc("company_assistant_connections", { p_company: companyId });
  if (error) throw dbError(error);
  return (data ?? []).map((r) => ({
    user_id: r.user_id,
    full_name: r.full_name?.trim() || "Someone",
    client_id: r.client_id,
    name: r.name?.trim() || "AI assistant",
    logo: r.logo || null,
    connected_at: r.connected_at,
    access: toAssistantAccess({ level: r.level, areas: r.areas }),
  }));
}

/** Ends one of them for good, as the person's own Disconnect does (the server's client, as above). */
export async function endConnection(admin: Db, companyId: string, userId: string, clientId: string): Promise<void> {
  const { error } = await admin.rpc("end_assistant_connection", { p_company: companyId, p_user: userId, p_client: clientId });
  if (error) throw dbError(error);
}

/** Where an OAuth client signs in and refreshes its token: it never acts on the person's account. */
const OAUTH_CLIENT_PATHS = ["/token", "/oauth/token", "/oauth/revoke", "/oauth/userinfo", "/oauth/clients/register"];

/**
 * The gateway's part (server.ts): while the business has assistants turned off, an assistant gets
 * nothing from the Data API or Storage, not even to read; one that only reads, or whose business
 * only lets assistants look things up, can't write through them; and no assistant changes the
 * person's sign-in (their password or email, their other sessions, or which apps they've
 * connected). Which areas one that may change things can write to, and whether it may delete, the
 * database decides. Everyone else goes through as they are. Auth keeps answering an assistant
 * while they're off (who it is, a fresh token), so it works again when they're turned back on.
 */
export async function guardAssistant(env: Env, request: Request, prefix: string, send: (request: Request) => Promise<Response>): Promise<Response> {
  const token = bearerToken(request.headers.get("authorization") ?? undefined);
  const client = token ? assistantClient(token) : null;
  if (!token || !client) return send(request);
  const path = new URL(request.url).pathname.slice(prefix.length);
  if (prefix === "/auth/v1") {
    if (isRead(request.method) || OAUTH_CLIENT_PATHS.includes(path)) return send(request);
    return Response.json(
      { code: 403, error_code: "assistant_not_allowed", msg: "An AI assistant can't change your sign-in. Do that in Crewtavo itself." },
      { status: 403 },
    );
  }
  // The question itself: in an instance the server asks through this gateway.
  if (prefix === "/rest/v1" && path === "/rpc/assistant_switch") return send(request);
  const db = userClient(env, token);
  const held = await companySwitch(db);
  if (held.state === "off") return Response.json({ code: "assistants_off", message: assistantsOff(held.company) }, { status: 403 });
  if (isRead(request.method)) return send(request);
  if (held.state === "read_only") return Response.json({ code: "assistants_read_only", message: assistantsLookOnly(held.company) }, { status: 403 });
  // A token the service won't accept gets its own answer from it (so the assistant knows to refresh).
  if ((await connectionAccess(db, client))?.level === "read") {
    return Response.json({ code: "assistant_read_only", message: ASSISTANT_READ_ONLY }, { status: 403 });
  }
  return send(request);
}

/**
 * The gateway's part in connecting an assistant (server.ts): Allow on the consent screen
 * (/oauth/consent, Supabase Auth's OAuth server) is refused for someone whose only sign-ins are a
 * sub's. Asked with their own token, so row-level security answers. The MCP tools refuse a sub's
 * sign-in too (mcp.ts), and the database gives an assistant nothing through one (private.my_subs),
 * which holds on a Supabase project without the gateway.
 */
export async function guardConsent(env: Env, request: Request, prefix: string, send: (request: Request) => Promise<Response>): Promise<Response> {
  const path = new URL(request.url).pathname.slice(prefix.length);
  if (request.method !== "POST" || !/^\/oauth\/authorizations\/[^/]+\/consent$/.test(path)) return send(request);
  const text = await request.text();
  const replay = new Request(request.url, { method: request.method, headers: request.headers, body: text });
  let action: unknown = null;
  try {
    action = (JSON.parse(text) as { action?: unknown } | null)?.action;
  } catch {
    // Auth answers a body it can't read itself.
  }
  const token = bearerToken(request.headers.get("authorization") ?? undefined);
  if (action !== "approve" || !token) return send(replay);
  const { data } = await userClient(env, token).from("memberships").select("role").eq("active", true);
  if (data?.length && !data.some((m) => isStaff(m.role))) {
    return Response.json({ code: 403, error_code: "assistant_not_allowed", msg: NO_ASSISTANTS_FOR_SUBS }, { status: 403 });
  }
  return send(replay);
}
