/**
 * AI assistants only read until the person who connected them chooses what they can change, or
 * gives them full access: the MCP tools that change things refuse outside those areas, and only full
 * access deletes. Our API takes no changes from an assistant, and the instance's gateway takes none
 * from one that only reads. Ordinary sign-ins are unaffected (lib/assistants.ts).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ASSISTANT_AREAS, ASSISTANT_TOOL_LABELS, assistantRefusal } from "@crewtavo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import { TOOLS } from "../src/assistant-tools";
import type { Env } from "../src/env";
import { ASSISTANT_NO_API, ASSISTANT_READ_ONLY, assistantClient, guardAssistant } from "../src/lib/assistants";
import { gateway } from "../src/lib/gateway";
import { reportError } from "../src/lib/monitoring";

// What's reported to us is kept, so a test can see that a failure was.
vi.mock("../src/lib/monitoring", async (importOriginal) => ({ ...(await importOriginal<typeof import("../src/lib/monitoring")>()), reportError: vi.fn() }));

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
const records = token({ client_id: "client-records" });
const prices = token({ client_id: "client-prices" });
const full = token({ client_id: "client-full" });
const expired = token({ client_id: "client-expired" });

/** What each connection was given (public.assistant_connections); others have no row. */
const CONNECTIONS: Record<string, { level: string; areas: string[] }> = {
  "client-reads": { level: "read", areas: [] },
  // What "Allow changes" became.
  "client-records": { level: "areas", areas: ["records"] },
  "client-prices": { level: "areas", areas: ["prices"] },
  "client-full": { level: "full", areas: [] },
};

interface Call {
  method: string;
  path: string;
  search: URLSearchParams;
  body: any;
}

/** What the owner sees of the team's connections (company_assistant_connections). */
const TEAM = [
  { user_id: "7c1d2e3f-4a5b-4c6d-8e7f-000000000001", full_name: "Ola Office", client_id: "client-full", name: "Claude", logo: null, connected_at: "2026-11-10T15:00:00Z", level: "full", areas: [] },
  { user_id: "7c1d2e3f-4a5b-4c6d-8e7f-000000000002", full_name: "Cal Crew", client_id: "client-reads", name: " ", logo: "https://example.com/logo.png", connected_at: "2026-11-01T09:00:00Z", level: "read", areas: [] },
];

/**
 * Supabase in memory, with the connections above; client-expired's token is refused. `held` is the
 * company's switch as the database answers an assistant's token (public.assistant_switch), and
 * `role` the person's.
 */
function supabase(company: { settings?: object; held?: object; role?: string; logFails?: boolean } = {}) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ method, path: url.pathname, search: url.searchParams, body });
    const settings = { assistants: { enabled: true, read_only: false }, default_tax_rate: 0.05, branding: { color: "#0f2a35", logo: "logo.png" }, ...company.settings };
    switch (url.pathname) {
      case "/auth/v1/user":
        return Response.json({ id: "user-1", aud: "authenticated", role: "authenticated" });
      case "/rest/v1/rpc/rate_limit_hit":
        return Response.json(true);
      case "/rest/v1/assistant_connections": {
        const client = url.searchParams.get("client_id")?.replace(/^eq\./, "");
        if (client === "client-expired") return Response.json({ code: "PGRST303", message: "JWT expired" }, { status: 401 });
        return Response.json(client && CONNECTIONS[client] ? [CONNECTIONS[client]] : []);
      }
      case "/rest/v1/rpc/assistant_switch":
        return Response.json(company.held ?? { state: "on" });
      case "/rest/v1/rpc/company_assistant_connections":
        return Response.json(TEAM);
      case "/rest/v1/rpc/end_assistant_connection":
        return Response.json(true);
      case "/rest/v1/activity":
        return new Response(null, { status: 201 });
      case "/rest/v1/memberships":
        return Response.json([{ company_id: "company-1", role: company.role ?? "owner", role_id: null, company: { timezone: "America/New_York", settings } }]);
      case "/rest/v1/companies":
        if (method === "PATCH") return Response.json([{ id: "company-1" }]);
        return Response.json([{ name: "Kilo Gardens", slug: "kilo", phone: null, email: null, website: null, address: { line1: "1 Main St", city: "Radford" }, timezone: "America/New_York", settings }]);
      case "/rest/v1/messages":
        return Response.json({ id: "message-1", created_at: "2026-10-18T12:00:00Z" }, { status: 201 });
      case "/rest/v1/services":
        if (method === "POST") return Response.json((body as Array<{ name: string }>).map((s, i) => ({ id: `service-${i}`, name: s.name })), { status: 201 });
        if (method === "DELETE") return Response.json([{ id: "service-1" }]);
        return Response.json([]);
      case "/rest/v1/intake_forms":
        if (method === "POST") return Response.json({ id: "form-1" }, { status: 201 });
        return Response.json([{ id: "form-0", slug: "quote" }]);
      // As the database tidies them (20261105000200_weather_rules.sql).
      case "/rest/v1/rpc/set_weather_rules":
        return Response.json(body.p_rules);
      case "/rest/v1/assistant_calls":
        if (company.logFails) return Response.json({ code: "23514", message: "new row violates a check on assistant_calls" }, { status: 400 });
        return new Response(null, { status: 201 });
      case "/rest/v1/profiles":
        return new Response(null, { status: 204 });
    }
    return Response.json([]);
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

const SERVICE = "6f4cc1b2-7e43-4c1d-9a8e-3c2f1d0b9a87";
const note = { client_id: SERVICE, text: "Gate code is 4410" };
const service = { items: [{ name: "Mulch install", unit: "yd", unit_price: 85 }] };

describe("assistant tokens", () => {
  it("are told apart from ordinary sign-ins by their client_id claim", () => {
    expect(assistantClient(reading)).toBe("client-reads");
    expect(assistantClient(signedIn)).toBeNull();
    expect(assistantClient(token({ client_id: "" }))).toBeNull();
    for (const junk of ["", "abc", "a.!!!.c", `${part({})}.${Buffer.from("not json").toString("base64url")}.x`]) expect(assistantClient(junk)).toBeNull();
  });
});

describe("MCP tools", () => {
  const rpc = (bearer: string, method: string, params?: object) =>
    app.request(
      "/mcp",
      { method: "POST", headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) },
      env,
    );
  const call = async (bearer: string, name: string, args: object) => (await (await rpc(bearer, "tools/call", { name, arguments: args })).json()).result;
  const wrote = (calls: Call[], path: string) => calls.some((c) => c.method !== "GET" && c.method !== "HEAD" && c.path === path);

  it("that change things refuse for an assistant that only reads, and say where to allow it", async () => {
    for (const bearer of [reading, token({ client_id: "connected-before-any-of-this" })]) {
      const calls = supabase();
      expect(await call(bearer, "add_note", note)).toMatchObject({ isError: true, content: [{ type: "text", text: assistantRefusal("records") }] });
      expect(await call(bearer, "add_services", service)).toMatchObject({ isError: true, content: [{ text: assistantRefusal("prices") }] });
      expect(assistantRefusal("prices")).toBe("This assistant can't change the price list. To let it, choose what it can change in Crewtavo, under Settings → AI assistants.");
      expect(wrote(calls, "/rest/v1/messages") || wrote(calls, "/rest/v1/services")).toBe(false);
      // The refusal is in the activity log the owner sees.
      expect(calls.find((c) => c.path === "/rest/v1/assistant_calls")?.body).toMatchObject({ tool: "add_note", ok: false });
    }
  });

  it("change only the areas an assistant was given, and don't delete", async () => {
    let calls = supabase();
    expect((await call(prices, "add_services", service)).structuredContent).toEqual({ result: { added: [{ id: "service-0", name: "Mulch install" }] } });
    expect(calls.find((c) => c.method === "POST" && c.path === "/rest/v1/services")?.body).toMatchObject([{ name: "Mulch install", unit: "yd", unit_price: 85, taxable: true, company_id: "company-1" }]);
    expect((await call(prices, "add_note", note)).content[0].text).toBe(assistantRefusal("records"));
    expect((await call(prices, "delete_service", { service_id: SERVICE })).content[0].text).toBe(assistantRefusal("prices", true, { level: "areas", areas: ["prices"] }));
    expect(assistantRefusal("prices", true, { level: "areas", areas: ["prices"] })).toMatch(/^This assistant can't delete things\./);
    expect(wrote(calls, "/rest/v1/messages")).toBe(false);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);

    // A connection that had "Allow changes" still logs requests and adds notes, and nothing more.
    calls = supabase();
    expect((await call(records, "add_note", note)).structuredContent).toEqual({ result: { id: "message-1", created_at: "2026-10-18T12:00:00Z" } });
    expect((await call(records, "add_services", service)).content[0].text).toBe(assistantRefusal("prices"));
    expect(wrote(calls, "/rest/v1/messages")).toBe(true);
    expect(wrote(calls, "/rest/v1/services")).toBe(false);
  });

  it("delete with full access, and work for an ordinary sign-in without looking anything up", async () => {
    for (const bearer of [full, signedIn]) {
      const calls = supabase();
      expect((await call(bearer, "delete_service", { service_id: SERVICE })).structuredContent).toEqual({ result: { deleted: true } });
      expect(calls.some((c) => c.method === "DELETE" && c.path === "/rest/v1/services")).toBe(true);
      expect(calls.some((c) => c.path === "/rest/v1/assistant_connections")).toBe(bearer === full);
    }
  });

  it("refuse the way the database does", () => {
    // The newest hooks.before_request, the Data API's pre-request (the assistant_areas migration).
    const dir = fileURLToPath(new URL("../../../supabase/migrations", import.meta.url));
    const sql = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort().map((f) => readFileSync(join(dir, f), "utf8")).filter((s) => s.includes("function hooks.before_request()")).at(-1)!;
    const hook = sql.slice(sql.lastIndexOf("create or replace function hooks.before_request()"));
    const unquote = (s: string) => s.replaceAll("''", "'");
    const template = unquote(/format\('((?:[^']|'')*%s(?:[^']|'')*)'/.exec(hook)![1]);
    const nouns = Object.fromEntries([...hook.matchAll(/when '([a-z]+)' then '([^']+)'/g)].map((m) => [m[1], m[2]]));
    nouns.automations = /else '([^']+)' end\)/.exec(hook)![1];
    for (const { key } of ASSISTANT_AREAS) expect(template.replace("%s", nouns[key])).toBe(assistantRefusal(key));
    expect(unquote(/when v_delete and v_level = 'areas' then\s*'((?:[^']|'')*)'/.exec(hook)![1])).toBe(assistantRefusal("prices", true, { level: "areas", areas: [] }));
    expect(unquote(/when v_level = 'full_no_money' and private\.assistant_money_area\(v_area\) then\s*'((?:[^']|'')*)'/.exec(hook)![1])).toBe(assistantRefusal("invoices", false, { level: "full_no_money", areas: [] }));
  });

  it("still won't change anything when the company only lets assistants look things up", async () => {
    const calls = supabase({ settings: { assistants: { enabled: true, read_only: true } } });
    expect((await call(full, "add_services", service)).content[0].text).toMatch(/^Assistants can only look things up for this company/);
    expect(wrote(calls, "/rest/v1/services")).toBe(false);
    const names = ((await (await rpc(full, "tools/list")).json()).result.tools as Array<{ name: string }>).map((t) => t.name);
    expect(names).toContain("list_services");
    expect(names).not.toContain("add_services");
  });

  it("that read work for an assistant that only reads, with GET requests only", async () => {
    const calls = supabase();
    expect((await call(reading, "search_clients", { query: "Ana" })).isError).toBeUndefined();
    expect((await call(reading, "search_sops", { query: "gate codes" })).isError).toBeUndefined();
    expect((await call(reading, "list_services", {})).isError).toBeUndefined();
    const db = calls.filter((c) => c.path.startsWith("/rest/v1/") && !["/rest/v1/assistant_calls", "/rest/v1/rpc/rate_limit_hit"].includes(c.path));
    expect(db.map((c) => c.path)).toEqual(expect.arrayContaining(["/rest/v1/clients", "/rest/v1/rpc/search_sops", "/rest/v1/services"]));
    // The instance's gateway only lets an assistant that only reads send GETs (below).
    expect(db.every((c) => c.method === "GET")).toBe(true);
  });

  it("are all listed, so a refusal can say how to allow it, and say which delete", async () => {
    supabase();
    const tools = (await (await rpc(reading, "tools/list")).json()).result.tools as Array<{ name: string; annotations: { readOnlyHint: boolean; destructiveHint: boolean } }>;
    expect(tools.map((t) => t.name)).toEqual(Object.keys(TOOLS));
    const hints = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    expect(hints.list_services).toMatchObject({ readOnlyHint: true, destructiveHint: false });
    expect(hints.add_services).toMatchObject({ readOnlyHint: false, destructiveHint: false });
    expect(hints.delete_service).toMatchObject({ readOnlyHint: false, destructiveHint: true });
    // Every delete is marked, so the assistant asks first; so are merging clients (one is deleted), voiding and writing off an invoice, and taking down a public reply.
    const destructive = tools.filter((t) => t.annotations.destructiveHint).map((t) => t.name);
    expect(destructive.filter((n) => !n.startsWith("delete_"))).toEqual(["merge_clients", "void_invoice", "write_off_invoice", "remove_review_reply"]);
    expect(tools.filter((t) => t.name.startsWith("delete_")).every((t) => t.annotations.destructiveHint)).toBe(true);
  });

  it("each have a label for the activity log", () => {
    expect(Object.keys(TOOLS).filter((name) => !ASSISTANT_TOOL_LABELS[name])).toEqual([]);
  });

  it("check a price list formula before saving anything", async () => {
    const calls = supabase();
    const res = await call(full, "add_services", { items: [{ name: "Gravel", formula: "area_sqft * depth_cm" }] });
    expect(res.content[0].text).toMatch(/^Gravel: that formula doesn't work \(Unknown value "depth_cm"\)/);
    expect(wrote(calls, "/rest/v1/services")).toBe(false);
  });

  it("read and set weather rules through the function that checks them, as a change to the price list", async () => {
    supabase({ settings: { weather_rules: [{ applies_to: "Paver patio", max_rain_pct: 50, requires_dry_hours: 24 }, "not a rule"] } });
    expect((await call(full, "list_weather_rules", {})).structuredContent.result).toEqual([
      { applies_to: "Paver patio", max_rain_pct: 50, requires_dry_hours: 24, summary: "Paver patio: at most 50% rain, 24 dry hours after" },
    ]);
    const rules = [{ applies_to: "Sealcoat", min_temp_f: 50, requires_dry_hours: 24 }, { max_wind_mph: 15 }];
    for (const bearer of [full, prices]) {
      const calls = supabase();
      expect((await call(bearer, "set_weather_rules", { rules })).structuredContent.result).toEqual({ saved: ["Sealcoat: at least 50°F, 24 dry hours after", "Every job: wind at most 15 mph"] });
      expect(calls.find((c) => c.path === "/rest/v1/rpc/set_weather_rules")?.body).toEqual({ p_company: "company-1", p_rules: rules });
      expect(wrote(calls, "/rest/v1/companies")).toBe(false);
    }
    const calls = supabase();
    expect((await call(records, "set_weather_rules", { rules })).content[0].text).toBe(assistantRefusal("prices"));
    expect(wrote(calls, "/rest/v1/rpc/set_weather_rules")).toBe(false);
  });

  it("change company settings without touching the owner's limits on assistants", async () => {
    const calls = supabase();
    const res = await call(full, "update_company_settings", { sales_tax_percent: 8.875, brand_color: "#3b7d23", website: "kilogardens.com" });
    expect(res.isError).toBeUndefined();
    expect(calls.find((c) => c.method === "PATCH" && c.path === "/rest/v1/companies")!.body).toEqual({ website: "https://kilogardens.com" });
    // Only what changes, merged into the settings as they are when saved: the logo, the limits on
    // assistants and anything changed meanwhile stay as the database has them.
    expect(calls.find((c) => c.path === "/rest/v1/rpc/merge_company_settings")?.body).toEqual({ p_company: "company-1", p_settings: { default_tax_rate: 0.08875, branding: { color: "#3b7d23" } } });
  });

  it("read and set the days the business works, by name", async () => {
    let calls = supabase();
    // Every day until the business picks (core slots.ts workdays()).
    expect((await call(full, "get_company_settings", {})).structuredContent.result.workdays).toEqual(["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"]);
    expect((await call(full, "update_company_settings", { workdays: ["saturday", "monday", "monday"] })).isError).toBeUndefined();
    expect(calls.find((c) => c.path === "/rest/v1/rpc/merge_company_settings")?.body.p_settings).toEqual({ working_hours: { days: [1, 6] } });
    expect(wrote(calls, "/rest/v1/companies")).toBe(false);

    calls = supabase({ settings: { working_hours: { start: "08:00", end: "16:00", days: [2, 4] } } });
    expect((await call(full, "get_company_settings", {})).structuredContent.result).toMatchObject({ working_hours: { start: "08:00", end: "16:00" }, workdays: ["tuesday", "thursday"] });
    await call(full, "update_company_settings", { working_hours: { start: "07:00", end: "15:00" }, workdays: ["friday"] });
    expect(calls.find((c) => c.path === "/rest/v1/rpc/merge_company_settings")?.body.p_settings).toEqual({ working_hours: { start: "07:00", end: "15:00", days: [5] } });
  });

  it("turn clients' tips for the crew on and off by a name that says so, the switch Settings → Company has", async () => {
    let calls = supabase({ settings: { hub_tips: true } });
    expect((await call(full, "get_company_settings", {})).structuredContent.result).toMatchObject({ client_tips: true });
    expect((await call(full, "update_company_settings", { client_tips: false })).isError).toBeUndefined();
    // The setting keeps its name in the database, and the rest of the settings aren't sent.
    expect(calls.find((c) => c.path === "/rest/v1/rpc/merge_company_settings")?.body.p_settings).toEqual({ hub_tips: false });

    calls = supabase({ settings: { hub_tips: false } });
    const read = (await call(full, "get_company_settings", {})).structuredContent.result;
    expect(read.client_tips).toBe(false);
    expect(read).not.toHaveProperty("show_hub_tips");

    // What the assistant reads about it is about the Client Hub, not hints for the team.
    const tools = (await (await rpc(full, "tools/list")).json()).result.tools as Array<{ name: string; description: string; inputSchema: { properties: Record<string, { description?: string }> } }>;
    const get = tools.find((t) => t.name === "get_company_settings")!;
    const update = tools.find((t) => t.name === "update_company_settings")!;
    expect(get.description).toContain("client_tips: whether clients can add a tip for the crew when they pay an invoice online in the Client Hub, or from an autopay receipt.");
    expect(Object.keys(update.inputSchema.properties)).toContain("client_tips");
    expect(Object.keys(update.inputSchema.properties)).not.toContain("show_hub_tips");
    expect(update.inputSchema.properties.client_tips!.description).toMatch(/^Let clients add a tip for the crew .* This is not about tips or hints shown to the team\.$/);
  });

  it("save booking forms the way the booking screen does, and give their link", async () => {
    const calls = supabase();
    const res = await call(full, "save_booking_form", { name: "Spring cleanup", service_area_zips: ["24141"], questions: [{ label: "Yard size", type: "choice", options: ["Small", "Large"] }] });
    expect(res.structuredContent).toEqual({ result: { form_id: "form-1", link: "https://ops.example.com/book/kilo/spring-cleanup" } });
    expect(calls.find((c) => c.method === "POST" && c.path === "/rest/v1/intake_forms")?.body).toMatchObject({ slug: "spring-cleanup", kind: "request", questions: [{ key: "yard_size", required: false }] });
    expect((await call(full, "save_booking_form", { name: "Quote", questions: [] })).content[0].text).toBe("Another form already uses that link.");
  });
});

describe("the API", () => {
  const rename = (bearer: string) =>
    app.request("/api/me", { method: "PATCH", headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" }, body: JSON.stringify({ full_name: "Renamed" }) }, env);

  it("takes no changes from an assistant, whatever it's been given: its tools are how it changes things", async () => {
    for (const bearer of [reading, full]) {
      const calls = supabase();
      const res = await rename(bearer);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: ASSISTANT_NO_API });
      expect(calls.some((c) => c.path === "/rest/v1/profiles")).toBe(false);
    }
  });

  it("takes them from an ordinary sign-in", async () => {
    const calls = supabase();
    expect((await rename(signedIn)).status).toBe(200);
    expect(calls.some((c) => c.method === "PATCH" && c.path === "/rest/v1/profiles")).toBe(true);
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

  it("is what the instance's gateway runs for the Data API, Storage and Auth", async () => {
    const calls = supabase();
    const routes = gateway(env, { auth: "http://auth.internal:9999", rest: "http://rest.internal:3000", storage: "http://storage.internal:5000" });
    const through = (method: string, path: string, bearer: string) => routes.fetch(ask(method, path, bearer), {});
    // The services' own paths, which only a forwarded request reaches.
    const forwarded = () => calls.filter((c) => !c.path.startsWith("/rest/v1/") && !c.path.startsWith("/auth/v1/")).map((c) => `${c.method} ${c.path}`);
    for (const [method, path] of [["POST", "/rest/v1/services"], ["DELETE", "/storage/v1/object/files/company-1/photo.jpg"], ["PUT", "/auth/v1/user"]]) {
      expect((await through(method, path, reading)).status, path).toBe(403);
    }
    expect(forwarded()).toEqual([]);
    expect((await through("GET", "/rest/v1/clients?select=*", reading)).status).toBe(200);
    expect((await through("POST", "/rest/v1/services", prices)).status).toBe(200);
    expect((await through("PATCH", "/rest/v1/clients?id=eq.1", signedIn)).status).toBe(200);
    expect(forwarded()).toEqual(["GET /clients", "POST /services", "PATCH /clients"]);
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

  it("leaves what an assistant that may change things can change to the database, and lets ordinary sign-ins through", async () => {
    const calls = supabase();
    const { sent, send } = upstream();
    expect((await guardAssistant(env, ask("POST", "/rest/v1/services", prices), "/rest/v1", send)).status).toBe(200);
    expect((await guardAssistant(env, ask("DELETE", "/storage/v1/object/files/company-1/photo.jpg", full), "/storage/v1", send)).status).toBe(200);
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
    for (const bearer of [reading, full]) {
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

describe("the company's own switch, wherever an assistant's token is taken", () => {
  const OFF = { state: "off", company: "Kilo Gardens", company_id: "company-1" };
  const LOOK_ONLY = { state: "read_only", company: "Kilo Gardens", company_id: "company-1" };
  const upstream = () => {
    const sent: Request[] = [];
    return { sent, send: async (request: Request) => (sent.push(request), Response.json({ ok: true })) };
  };
  const ask = (method: string, path: string, bearer: string) =>
    new Request(`http://localhost:8080${path}`, { method, headers: { Authorization: `Bearer ${bearer}`, apikey: "sb_publishable_test", "Content-Type": "application/json" }, body: method === "GET" || method === "HEAD" ? undefined : "{}" });
  const prefixOf = (path: string) => (path.startsWith("/rest") ? "/rest/v1" : path.startsWith("/storage") ? "/storage/v1" : "/auth/v1");
  const call = async (bearer: string, name: string, args: object) =>
    (await (await app.request("/mcp", { method: "POST", headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }, env)).json()).result;
  const me = (bearer: string) => app.request("/api/me", { headers: { Authorization: `Bearer ${bearer}` } }, env);

  it("off: the gateway gives an assistant nothing from the Data API or Storage, not even to read, whatever it was given", async () => {
    supabase({ held: OFF });
    const { sent, send } = upstream();
    for (const bearer of [reading, full]) {
      for (const [method, path] of [
        ["GET", "/rest/v1/clients?select=*"],
        ["GET", "/rest/v1/rpc/search_sops?p_query=gate"],
        ["POST", "/rest/v1/services"],
        ["GET", "/storage/v1/object/authenticated/files/company-1/photo.jpg"],
        ["DELETE", "/storage/v1/object/files/company-1/photo.jpg"],
      ]) {
        const res = await guardAssistant(env, ask(method!, path!, bearer), prefixOf(path!), send);
        expect(res.status, `${method} ${path}`).toBe(403);
        expect(await res.json()).toEqual({
          code: "assistants_off",
          message: "AI assistants are turned off for Kilo Gardens. An owner or admin can turn them on in Crewtavo, under Settings → AI assistants.",
        });
      }
    }
    expect(sent).toHaveLength(0);
  });

  it("off: people signed in themselves aren't asked about, and an assistant can still ask who it is and refresh its token", async () => {
    const calls = supabase({ held: OFF });
    const { sent, send } = upstream();
    expect((await guardAssistant(env, ask("GET", "/rest/v1/clients?select=*", signedIn), "/rest/v1", send)).status).toBe(200);
    expect((await guardAssistant(env, ask("POST", "/storage/v1/object/files/company-1/photo.jpg", signedIn), "/storage/v1", send)).status).toBe(200);
    expect(calls.some((c) => c.path === "/rest/v1/rpc/assistant_switch")).toBe(false);
    expect((await guardAssistant(env, ask("GET", "/auth/v1/user", full), "/auth/v1", send)).status).toBe(200);
    expect((await guardAssistant(env, ask("POST", "/auth/v1/oauth/token", full), "/auth/v1", send)).status).toBe(200);
    // The question itself goes through: in an instance the server asks it through this gateway.
    expect((await guardAssistant(env, ask("GET", "/rest/v1/rpc/assistant_switch", full), "/rest/v1", send)).status).toBe(200);
    expect(sent).toHaveLength(5);
  });

  it("look things up only: the gateway lets an assistant read and refuses every change, full access or not", async () => {
    const calls = supabase({ held: LOOK_ONLY });
    const { sent, send } = upstream();
    for (const [method, path] of [["POST", "/rest/v1/services"], ["PATCH", "/rest/v1/clients?id=eq.1"], ["POST", "/rest/v1/rpc/merge_clients"], ["DELETE", "/storage/v1/object/files/company-1/photo.jpg"]]) {
      const res = await guardAssistant(env, ask(method!, path!, full), prefixOf(path!), send);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(await res.json()).toEqual({
        code: "assistants_read_only",
        message: "Assistants can only look things up for Kilo Gardens, not make changes. An owner or admin can change this in Crewtavo, under Settings → AI assistants.",
      });
    }
    expect(sent).toHaveLength(0);
    expect(calls.some((c) => c.path === "/rest/v1/assistant_connections")).toBe(false);
    expect((await guardAssistant(env, ask("GET", "/rest/v1/clients?select=*", full), "/rest/v1", send)).status).toBe(200);
    expect((await guardAssistant(env, ask("GET", "/storage/v1/object/authenticated/files/company-1/photo.jpg", full), "/storage/v1", send)).status).toBe(200);
    expect(sent).toHaveLength(2);
  });

  it("on, or when the database can't be asked: the gateway goes by what each person gave their assistant, as before", async () => {
    for (const held of [{ state: "on" }, [], { code: "PGRST202", message: "Could not find the function" }]) {
      supabase({ held });
      const { sent, send } = upstream();
      expect((await guardAssistant(env, ask("GET", "/rest/v1/clients?select=*", reading), "/rest/v1", send)).status).toBe(200);
      expect((await guardAssistant(env, ask("POST", "/rest/v1/services", prices), "/rest/v1", send)).status).toBe(200);
      expect((await guardAssistant(env, ask("POST", "/rest/v1/services", reading), "/rest/v1", send)).status).toBe(403);
      expect(sent).toHaveLength(2);
    }
  });

  it("off: the API doesn't answer an assistant either, and still answers the person", async () => {
    supabase({ held: OFF });
    const res = await me(full);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "AI assistants are turned off for Kilo Gardens. An owner or admin can turn them on in Crewtavo, under Settings → AI assistants." });
    // Past the door (this pretend database has no profile to give, so the route itself says 404).
    const calls = supabase({ held: OFF });
    expect((await me(signedIn)).status).toBe(404);
    expect(calls.some((c) => c.path === "/rest/v1/rpc/assistant_switch")).toBe(false);
    // Look things up only: it reads here as it did (it never could change anything here).
    supabase({ held: LOOK_ONLY });
    expect((await me(full)).status).toBe(404);
  });

  it("off: an MCP tool says so, runs nothing, and the refusal is in the log the owner sees", async () => {
    // The person's other business has them off, though this one's own setting is on.
    const calls = supabase({ held: { state: "off", company: "Lima Lawns", company_id: "company-2" } });
    const res = await call(full, "list_clients", {});
    expect(res).toMatchObject({ isError: true, content: [{ type: "text", text: "AI assistants are turned off for Lima Lawns. An owner or admin can turn them on in Crewtavo, under Settings → AI assistants." }] });
    expect(calls.some((c) => c.path === "/rest/v1/clients" || c.path === "/rest/v1/memberships")).toBe(false);
    expect(calls.find((c) => c.path === "/rest/v1/assistant_calls")?.body).toMatchObject({ company_id: "company-2", tool: "list_clients", ok: false, oauth_client: "client-full" });
  });

  it("look things up only: an MCP tool that reads works, and one that changes things says who set it", async () => {
    const calls = supabase({ held: { state: "read_only", company: "Lima Lawns", company_id: "company-2" } });
    expect((await call(full, "get_company_settings", {})).isError).toBeUndefined();
    expect((await call(full, "add_note", note)).content[0].text).toBe(
      "Assistants can only look things up for Lima Lawns, not make changes. An owner or admin can change this in Crewtavo, under Settings → AI assistants.",
    );
    expect(calls.some((c) => c.method !== "GET" && c.path === "/rest/v1/messages")).toBe(false);
  });
});

describe("the log of what assistants did", () => {
  const call = async (bearer: string, name: string, args: object) =>
    (await (await app.request("/mcp", { method: "POST", headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }, env)).json()).result;

  it("tells us when a call couldn't be written to it, and still gives the assistant what the tool answered", async () => {
    vi.mocked(reportError).mockClear();
    const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const calls = supabase({ logFails: true });
    // The note is added; only its line in the log is refused.
    const res = await call(records, "add_note", note);
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent).toEqual({ result: { id: "message-1", created_at: "2026-10-18T12:00:00Z" } });
    expect(calls.some((c) => c.method === "POST" && c.path === "/rest/v1/assistant_calls")).toBe(true);
    expect(reportError).toHaveBeenCalledTimes(1);
    const [error, context] = vi.mocked(reportError).mock.calls[0]!;
    expect((error as Error).message).toBe("Couldn't log an assistant call: new row violates a check on assistant_calls");
    // Which tool and business, never what the call carried.
    expect(context).toEqual({ feature: "assistants", tool: "add_note", company_id: "company-1" });
    expect(JSON.stringify(context)).not.toContain("Gate code");
    expect(quiet).toHaveBeenCalled();
    quiet.mockRestore();
  });

  it("says nothing to us when the log takes the call", async () => {
    vi.mocked(reportError).mockClear();
    supabase();
    await call(records, "add_note", note);
    expect(reportError).not.toHaveBeenCalled();
  });
});

describe("the functions the assistant's tools call with the person's token", () => {
  const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
  const dir = fileURLToPath(new URL("../src/assistant-tools", import.meta.url));
  // Called by the tools themselves, and by the two services they share with the office's screens.
  const sources = [...readdirSync(dir).filter((f) => f.endsWith(".ts")).map((f) => readFileSync(join(dir, f), "utf8")), read("../src/services/sales.ts")];
  const called = [...new Set(sources.flatMap((source) => [...source.matchAll(/\b(?:ctx|s)\.db\s*\.rpc\(\s*"(\w+)"/g)].map((m) => m[1]!)))].sort();
  const test = read("../../../supabase/tests/assistants_off_everywhere_test.sql");
  const list = (name: string) => new RegExp(`^\\\\set ${name} '\\{([a-z_,]+)\\}'$`, "m").exec(test)![1]!.split(",");

  it("are all in the database's test, which holds each to writing for its area or only reading", () => {
    expect(called).toContain("duplicate_quote");
    expect(called).toContain("quote_exact_sent");
    expect([...list("writes"), ...list("reads")].sort()).toEqual(called);
  });

  it("that write are the ones the database lets an assistant write with", () => {
    const migrations = fileURLToPath(new URL("../../../supabase/migrations", import.meta.url));
    const sql = readdirSync(migrations).filter((f) => f.endsWith(".sql")).sort().map((f) => readFileSync(join(migrations, f), "utf8")).filter((s) => s.includes("function private.assistant_rpc_area(")).at(-1)!;
    const body = sql.slice(sql.lastIndexOf("function private.assistant_rpc_area("));
    const listed = [...body.slice(0, body.indexOf("$$;")).matchAll(/when '(\w+)' then '\w+'/g)].map((m) => m[1]!).sort();
    expect(listed).toEqual(list("writes").sort());
  });
});

describe("the team's connected assistants, for the owner", () => {
  const headers = (bearer: string) => ({ Authorization: `Bearer ${bearer}`, "X-Company-Id": "0d0c0b0a-0000-4000-8000-000000000001", "Content-Type": "application/json" });
  const list = (bearer = signedIn) => app.request("/api/assistants/connections", { headers: headers(bearer) }, env);
  const end = (body: object, bearer = signedIn) => app.request("/api/assistants/connections/end", { method: "POST", headers: headers(bearer), body: JSON.stringify(body) }, env);

  it("lists everyone's, with who connected it and what they let it change, asked with the server's key", async () => {
    const calls = supabase();
    const res = await list();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      connections: [
        { user_id: TEAM[0]!.user_id, full_name: "Ola Office", client_id: "client-full", name: "Claude", logo: null, connected_at: "2026-11-10T15:00:00Z", access: { level: "full", areas: [] } },
        // An app that registered without a name.
        { user_id: TEAM[1]!.user_id, full_name: "Cal Crew", client_id: "client-reads", name: "AI assistant", logo: "https://example.com/logo.png", connected_at: "2026-11-01T09:00:00Z", access: { level: "read", areas: [] } },
      ],
    });
    expect(calls.find((c) => c.path === "/rest/v1/rpc/company_assistant_connections")?.body).toEqual({ p_company: "0d0c0b0a-0000-4000-8000-000000000001" });
  });

  it("is the owner's alone: an admin, the office and the crew are refused before anything is read or ended", async () => {
    for (const role of ["admin", "office", "field_crew"]) {
      const calls = supabase({ role });
      expect((await list()).status, role).toBe(403);
      expect((await end({ user_id: TEAM[0]!.user_id, client_id: "client-full" })).status, role).toBe(403);
      expect(calls.some((c) => c.path.startsWith("/rest/v1/rpc/company_assistant") || c.path.startsWith("/rest/v1/rpc/end_assistant"))).toBe(false);
    }
  });

  it("ends one of them, and puts it on record", async () => {
    const calls = supabase();
    const res = await end({ user_id: TEAM[0]!.user_id, client_id: "client-full" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ended: true });
    expect(calls.find((c) => c.path === "/rest/v1/rpc/end_assistant_connection")?.body).toEqual({ p_company: "0d0c0b0a-0000-4000-8000-000000000001", p_user: TEAM[0]!.user_id, p_client: "client-full" });
    expect(calls.find((c) => c.method === "POST" && c.path === "/rest/v1/activity")?.body).toMatchObject({
      verb: "member.assistant_ended", subject_type: "member", subject_id: TEAM[0]!.user_id, summary: expect.stringMatching(/ disconnected Claude from Ola Office's sign-in$/),
    });
  });

  it("ends nothing that isn't one of the team's connections, and takes nothing from an assistant", async () => {
    let calls = supabase();
    expect((await end({ user_id: TEAM[0]!.user_id, client_id: "client-someone-elses" })).status).toBe(404);
    expect((await end({ user_id: "7c1d2e3f-4a5b-4c6d-8e7f-0000000000ff", client_id: "client-full" })).status).toBe(404);
    expect(calls.some((c) => c.path === "/rest/v1/rpc/end_assistant_connection")).toBe(false);
    calls = supabase();
    const res = await end({ user_id: TEAM[0]!.user_id, client_id: "client-full" }, full);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: ASSISTANT_NO_API });
    expect(calls.some((c) => c.path === "/rest/v1/rpc/end_assistant_connection")).toBe(false);
  });
});
