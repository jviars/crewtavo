/**
 * AI assistants only read until the person who connected them turns on "Allow changes": the MCP
 * tools that write refuse, and so do our API and the instance's gateway to the Data API and
 * Storage. Ordinary sign-ins are unaffected (lib/assistants.ts).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import type { Env } from "../src/env";
import { ASSISTANT_READ_ONLY, assistantClient, guardAssistant } from "../src/lib/assistants";

const env: Env = {
  SUPABASE_URL: "http://127.0.0.1:8080",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  APP_URL: "https://ops.example.com",
};

// Tokens Supabase Auth vouches for (getClaims asks /auth/v1/user about HS256 ones). Its OAuth
// server adds the approved client's id as client_id; an ordinary sign-in has none.
const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const token = (claims: object = {}) =>
  `${part({ alg: "HS256", typ: "JWT" })}.${part({ sub: "user-1", role: "authenticated", exp: Math.floor(Date.now() / 1000) + 600, ...claims })}.c2ln`;
const signedIn = token();
const reading = token({ client_id: "client-reads" });
const allowed = token({ client_id: "client-changes" });
const expired = token({ client_id: "client-expired" });

interface Call {
  method: string;
  path: string;
  search: URLSearchParams;
  body: unknown;
}

/** Supabase in memory: client-changes has "Allow changes" on, the others don't, and client-expired's token is refused. */
function supabase() {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ method, path: url.pathname, search: url.searchParams, body });
    if (url.pathname === "/auth/v1/user") return Response.json({ id: "user-1", aud: "authenticated", role: "authenticated" });
    if (url.pathname === "/rest/v1/rpc/rate_limit_hit") return Response.json(true);
    if (url.pathname === "/rest/v1/assistant_connections") {
      const client = url.searchParams.get("client_id")?.replace(/^eq\./, "");
      if (client === "client-expired") return Response.json({ code: "PGRST303", message: "JWT expired" }, { status: 401 });
      return Response.json(client === "client-changes" ? [{ allow_changes: true }] : client === "client-reads" ? [{ allow_changes: false }] : []);
    }
    if (url.pathname === "/rest/v1/memberships") return Response.json([{ company_id: "company-1", company: { timezone: "America/New_York", settings: {} } }]);
    if (url.pathname === "/rest/v1/messages") return Response.json({ id: "message-1", created_at: "2026-10-18T12:00:00Z" }, { status: 201 });
    if (url.pathname === "/rest/v1/assistant_calls") return new Response(null, { status: 201 });
    if (url.pathname === "/rest/v1/profiles") return new Response(null, { status: 204 });
    return Response.json([]);
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("assistant tokens", () => {
  it("are told apart from ordinary sign-ins by their client_id claim", () => {
    expect(assistantClient(reading)).toBe("client-reads");
    expect(assistantClient(signedIn)).toBeNull();
    expect(assistantClient(token({ client_id: "" }))).toBeNull();
    for (const junk of ["", "abc", "a.!!!.c", `${part({})}.${Buffer.from("not json").toString("base64url")}.x`]) expect(assistantClient(junk)).toBeNull();
  });
});

describe("MCP tools", () => {
  const call = (bearer: string, name: string, args: object) =>
    app.request(
      "/mcp",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      },
      env,
    );
  const note = { client_id: "6f4cc1b2-7e43-4c1d-9a8e-3c2f1d0b9a87", text: "Gate code is 4410" };
  const wrote = (calls: Call[]) => calls.some((c) => c.method === "POST" && c.path === "/rest/v1/messages");

  it("that write refuse for an assistant that only reads, and say where to allow it", async () => {
    for (const bearer of [reading, token({ client_id: "connected-before-the-switch" })]) {
      const calls = supabase();
      const res = await (await call(bearer, "add_note", note)).json();
      expect(res.result).toMatchObject({ isError: true, content: [{ type: "text", text: ASSISTANT_READ_ONLY }] });
      expect(ASSISTANT_READ_ONLY).toBe('This assistant can only read. To let it make changes, turn on "Allow changes" for it in Crewtavo, under Settings → Apps → AI assistants.');
      expect(wrote(calls)).toBe(false);
      // The refusal is in the activity log the owner sees.
      expect(calls.find((c) => c.path === "/rest/v1/assistant_calls")?.body).toMatchObject({ tool: "add_note", ok: false });
    }
  });

  it("that write work for an assistant allowed to change things, and for an ordinary sign-in", async () => {
    for (const bearer of [allowed, signedIn]) {
      const calls = supabase();
      const res = await (await call(bearer, "add_note", note)).json();
      expect(res.result.isError).toBeUndefined();
      expect(res.result.structuredContent).toEqual({ result: { id: "message-1", created_at: "2026-10-18T12:00:00Z" } });
      expect(wrote(calls)).toBe(true);
    }
    // Nothing to look up for a sign-in that isn't an assistant's.
    const calls = supabase();
    await call(signedIn, "add_note", note);
    expect(calls.some((c) => c.path === "/rest/v1/assistant_connections")).toBe(false);
  });

  it("that read work as before for an assistant that only reads, with GET requests only", async () => {
    const calls = supabase();
    expect((await (await call(reading, "search_clients", { query: "Ana" })).json()).result.isError).toBeUndefined();
    expect((await (await call(reading, "search_sops", { query: "gate codes" })).json()).result.isError).toBeUndefined();
    const db = calls.filter((c) => c.path.startsWith("/rest/v1/") && !["/rest/v1/assistant_calls", "/rest/v1/rpc/rate_limit_hit"].includes(c.path));
    expect(db.map((c) => c.path)).toEqual(expect.arrayContaining(["/rest/v1/clients", "/rest/v1/rpc/search_sops"]));
    // The instance's gateway only lets an assistant that only reads send GETs (below).
    expect(db.every((c) => c.method === "GET")).toBe(true);
  });

  it("are all still listed, so a refusal can say how to allow changes", async () => {
    supabase();
    const res = await app.request(
      "/mcp",
      { method: "POST", headers: { Authorization: `Bearer ${reading}`, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) },
      env,
    );
    const names = ((await res.json()).result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["search_clients", "create_request", "add_note"]));
  });
});

describe("the API", () => {
  const rename = (bearer: string) =>
    app.request("/api/me", { method: "PATCH", headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" }, body: JSON.stringify({ full_name: "Renamed" }) }, env);

  it("refuses changes from an assistant that only reads", async () => {
    const calls = supabase();
    const res = await rename(reading);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: ASSISTANT_READ_ONLY });
    expect(calls.some((c) => c.path === "/rest/v1/profiles")).toBe(false);
  });

  it("takes them from an allowed assistant and from an ordinary sign-in", async () => {
    for (const bearer of [allowed, signedIn]) {
      const calls = supabase();
      expect((await rename(bearer)).status).toBe(200);
      expect(calls.some((c) => c.method === "PATCH" && c.path === "/rest/v1/profiles")).toBe(true);
    }
  });
});

describe("the instance's gateway", () => {
  const upstream = () => {
    const sent: Request[] = [];
    return { sent, send: async (request: Request) => (sent.push(request), Response.json({ ok: true })) };
  };
  const ask = (method: string, path: string, bearer: string) =>
    new Request(`http://localhost:8080${path}`, { method, headers: { Authorization: `Bearer ${bearer}`, apikey: "sb_publishable_test", "Content-Type": "application/json" }, body: method === "GET" || method === "HEAD" ? undefined : "{}" });

  it("won't let an assistant that only reads change anything in the Data API or Storage", async () => {
    supabase();
    const { sent, send } = upstream();
    for (const [method, path, prefix] of [
      ["POST", "/rest/v1/clients", "/rest/v1"],
      ["PATCH", "/rest/v1/clients?id=eq.1", "/rest/v1"],
      ["DELETE", "/rest/v1/clients?id=eq.1", "/rest/v1"],
      ["POST", "/rest/v1/rpc/create_company", "/rest/v1"],
      ["POST", "/storage/v1/object/files/company-1/photo.jpg", "/storage/v1"],
      ["DELETE", "/storage/v1/object/files/company-1/photo.jpg", "/storage/v1"],
    ]) {
      const res = await guardAssistant(env, ask(method, path, reading), prefix, send);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ code: "assistant_read_only", message: ASSISTANT_READ_ONLY });
    }
    expect(sent).toHaveLength(0);
  });

  it("lets its reads through", async () => {
    const calls = supabase();
    const { sent, send } = upstream();
    for (const path of ["/rest/v1/clients?select=*", "/rest/v1/rpc/search_sops?p_query=gate", "/storage/v1/object/authenticated/files/company-1/photo.jpg"]) {
      expect((await guardAssistant(env, ask("GET", path, reading), path.startsWith("/rest") ? "/rest/v1" : "/storage/v1", send)).status).toBe(200);
    }
    expect(sent).toHaveLength(3);
    expect(calls.some((c) => c.path === "/rest/v1/assistant_connections")).toBe(false);
  });

  it("lets changes through from an allowed assistant and an ordinary sign-in", async () => {
    const calls = supabase();
    const { sent, send } = upstream();
    expect((await guardAssistant(env, ask("POST", "/rest/v1/clients", allowed), "/rest/v1", send)).status).toBe(200);
    expect((await guardAssistant(env, ask("DELETE", "/storage/v1/object/files/company-1/photo.jpg", allowed), "/storage/v1", send)).status).toBe(200);
    expect(calls.filter((c) => c.path === "/rest/v1/assistant_connections")).toHaveLength(2);
    expect((await guardAssistant(env, ask("PATCH", "/rest/v1/clients?id=eq.1", signedIn), "/rest/v1", send)).status).toBe(200);
    expect(calls.filter((c) => c.path === "/rest/v1/assistant_connections")).toHaveLength(2);
    expect(sent.map((r) => r.method)).toEqual(["POST", "DELETE", "PATCH"]);
  });

  it("leaves a token the services won't take for them to answer, so the assistant refreshes it", async () => {
    supabase();
    const { sent, send } = upstream();
    await guardAssistant(env, ask("POST", "/rest/v1/clients", expired), "/rest/v1", send);
    expect(sent).toHaveLength(1);
  });

  it("never lets an assistant change the person's sign-in, but lets it refresh its own token", async () => {
    supabase();
    const { sent, send } = upstream();
    for (const bearer of [reading, allowed]) {
      for (const [method, path] of [["PUT", "/auth/v1/user"], ["POST", "/auth/v1/logout?scope=global"], ["POST", "/auth/v1/factors"], ["DELETE", "/auth/v1/user/oauth/grants?client_id=x"], ["POST", "/auth/v1/oauth/authorizations/abc/consent"]]) {
        const res = await guardAssistant(env, ask(method, path, bearer), "/auth/v1", send);
        expect(res.status).toBe(403);
        expect((await res.json()).msg).toBe("An AI assistant can't change your sign-in. Do that in Crewtavo itself.");
      }
    }
    expect(sent).toHaveLength(0);
    expect((await guardAssistant(env, ask("POST", "/auth/v1/oauth/token", reading), "/auth/v1", send)).status).toBe(200);
    expect((await guardAssistant(env, ask("GET", "/auth/v1/user", reading), "/auth/v1", send)).status).toBe(200);
    expect((await guardAssistant(env, ask("PUT", "/auth/v1/user", signedIn), "/auth/v1", send)).status).toBe(200);
    expect(sent).toHaveLength(3);
  });
});
