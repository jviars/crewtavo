/**
 * The tools that run the business (assistant-tools/): importing clients and a schedule with a
 * preview first and no duplicates on a second run, money refused to "Full access, no money",
 * reports for the roles that see them, argument errors that name the field, invites that never
 * hand their link to the assistant, and a crew's route organized (or only shown) from a chat.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";

const invites = vi.hoisted(() => ({ calls: [] as unknown[] }));
vi.mock("../src/services/team", async (original) => ({
  ...(await original<typeof import("../src/services/team")>()),
  invitePerson: async (_scope: unknown, body: unknown) => {
    invites.calls.push(body);
    return { user_id: "user-9", invited: true, emailed: true, reason: null, link: "https://ops.example.com/auth/confirm?token=SECRET" };
  },
}));
const { app } = await import("../src/app");

const env: Env = { SUPABASE_URL: "http://127.0.0.1:8080", SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test", SUPABASE_SECRET_KEY: "sb_secret_test", APP_URL: "https://ops.example.com" };
const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
const token = (client: string) => `${part({ alg: "HS256", typ: "JWT" })}.${part({ sub: "user-1", role: "authenticated", exp: Math.floor(Date.now() / 1000) + 600, client_id: client })}.c2ln`;
const CONNECTIONS: Record<string, { level: string; areas: string[] }> = {
  full: { level: "full", areas: [] },
  nomoney: { level: "full_no_money", areas: [] },
  jobsonly: { level: "areas", areas: ["jobs", "clients"] },
};

type Row = Record<string, any>;
/** Supabase in memory: tables of rows, inserts that keep what they're given, and the person's role. */
function supabase(role = "owner") {
  const db: Record<string, Row[]> = { clients: [], properties: [], jobs: [], visits: [], assistant_calls: [] };
  const sent: Array<{ method: string; table: string; body: any }> = [];
  let id = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    const table = url.pathname.replace("/rest/v1/", "");
    if (url.pathname === "/auth/v1/user") return Response.json({ id: "user-1", aud: "authenticated", role: "authenticated" });
    if (table === "rpc/rate_limit_hit") return Response.json(true);
    if (table === "assistant_connections") {
      const client = url.searchParams.get("client_id")?.replace(/^eq\./, "") ?? "";
      return Response.json(CONNECTIONS[client] ? [CONNECTIONS[client]] : []);
    }
    if (table === "memberships") return Response.json([{ company_id: "company-1", role, role_id: null, company: { timezone: "America/New_York", settings: {} } }]);
    if (!url.pathname.startsWith("/rest/v1/")) return Response.json([]);
    sent.push({ method, table, body });
    const rows = (db[table] ??= []);
    if (method === "POST") {
      const made = (Array.isArray(body) ? body : [body]).map((r: Row) => ({ id: r.id ?? `${table}-${++id}`, ...r }));
      rows.push(...made);
      const single = (init?.headers as Record<string, string> | undefined)?.Accept?.includes("vnd.pgrst.object");
      return Response.json(single ? made[0] : made, { status: 201 });
    }
    if (method === "PATCH") {
      const ids = url.searchParams.get("id")?.replace(/^in\.\(|\)$|^eq\./g, "").split(",") ?? [];
      const hit = rows.filter((r) => ids.includes(r.id));
      for (const r of hit) Object.assign(r, body);
      return Response.json(hit);
    }
    return Response.json(rows);
  });
  return { db, sent };
}

afterEach(() => {
  vi.unstubAllGlobals();
  invites.calls = [];
});

const call = async (client: string, name: string, args: object) => {
  const res = await app.request("/mcp", { method: "POST", headers: { Authorization: `Bearer ${token(client)}`, "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }, env);
  const result = (await res.json()).result;
  return result.isError ? { error: result.content[0].text as string } : result.structuredContent.result;
};

const SPREADSHEET = [
  { source_id: "J-1", name: "Ana Diaz", email: "ana@example.com", status: "active", properties: [{ line1: "12 Oak St", city: "Radford" }] },
  { source_id: "J-2", name: "Bo Kent", status: "inactive", properties: [{ line1: "9 Main Street", city: "Radford" }, { line1: "9 Main St", city: "Radford" }] },
];

describe("importing clients", () => {
  it("previews without changing anything, then commits, and a second run adds nothing", async () => {
    const { db, sent } = supabase();
    const preview = await call("full", "import_clients", { mode: "preview", clients: SPREADSHEET });
    expect(preview.totals).toEqual({ clients: 2, create: 2, match: 0, status_changes: 0, properties: 2, kept_properties: 0 });
    expect(sent.filter((s) => s.method !== "GET" && s.table !== "assistant_calls")).toEqual([]);

    const commit = await call("full", "import_clients", { mode: "commit", clients: SPREADSHEET });
    expect(commit.clients.map((c: Row) => [c.name, c.status, c.property_ids.length])).toEqual([["Ana Diaz", "active", 1], ["Bo Kent", "archived", 1]]);
    expect(db.clients.map((c) => [c.display_name, c.status, c.custom_fields.source_id])).toEqual([["Ana Diaz", "active", "J-1"], ["Bo Kent", "archived", "J-2"]]);
    expect(db.properties).toHaveLength(2);

    const again = await call("full", "import_clients", { mode: "commit", clients: SPREADSHEET });
    expect(again.totals).toMatchObject({ create: 0, match: 2, properties: 0, kept_properties: 2 });
    expect(again.clients.map((c: Row) => c.action)).toEqual(["already here (by source_id)", "already here (by source_id)"]);
    expect(db.clients).toHaveLength(2);
    expect(db.properties).toHaveLength(2);
  });
});

describe("importing a schedule", () => {
  it("places items by address or name, says what it can't place, and needs the schedule to commit", async () => {
    const { db } = supabase();
    db.clients.push({ id: "c-ana", display_name: "Ana Diaz", company_name: null }, { id: "c-bo", display_name: "Bo Kent", company_name: null });
    db.properties.push({ id: "p-ana", client_id: "c-ana", line1: "12 Oak St", city: "Radford" }, { id: "p-bo", client_id: "c-bo", line1: "9 Main St", city: "Radford" });
    const items = [
      { title: "Mowing", address: { line1: "12 Oak Street" }, first_date: "2026-04-07", start_time: "09:00", duration_min: 45, repeat: { every_weeks: 2 }, price: 45 },
      { title: "Mowing", client_name: "bo kent", first_date: "2026-04-08", repeat: { rule: "FREQ=WEEKLY;INTERVAL=2;BYDAY=WE" } },
      { title: "Mowing", client_name: "Cy Lane", first_date: "2026-04-09", repeat: { every_weeks: 2 } },
      { title: "Sharpen blades", kind: "task", first_date: "2026-04-06" },
    ];
    const preview = await call("full", "import_schedule", { mode: "preview", items });
    expect(preview.totals).toEqual({ items: 4, ready: 3, already_here: 0, problems: 1 });
    expect(preview.items.map((i: Row) => [i.client_id, i.property_id, i.found_by, i.repeats ?? null])).toEqual([
      ["c-ana", "p-ana", "address", "every 2 weeks on Tuesday"],
      ["c-bo", "p-bo", "name", "every 2 weeks on Wednesday"],
      [null, null, null, "every 2 weeks on Thursday"],
      [null, null, null, null],
    ]);
    expect(preview.items[0].next_dates).toEqual(["2026-04-07", "2026-04-21", "2026-05-05"]);
    expect(preview.items[2].problem).toMatch(/^No client found/);
    expect((await call("jobsonly", "import_schedule", { mode: "commit", items })).error).toBe(
      "This assistant can't change the schedule. To let it, choose what it can change in Crewtavo, under Settings → AI assistants.",
    );
    expect(db.jobs).toHaveLength(0);
  });
});

describe("money", () => {
  it("is out of reach for full access without money, and says how to allow it", async () => {
    const { sent } = supabase();
    for (const [name, args] of [
      ["record_payment", { invoice_id: "6f4cc1b2-7e43-4c1d-9a8e-3c2f1d0b9a87", amount: 50, method: "check" }],
      ["create_quote", { client_id: "6f4cc1b2-7e43-4c1d-9a8e-3c2f1d0b9a87", title: "Sealcoat" }],
      ["mark_paid", { from: "2026-10-12", to: "2026-10-18", method: "check" }],
    ] as const) {
      expect((await call("nomoney", name, args)).error, name).toMatch(/^This assistant can't change money: quotes, invoices, payments or pay\./);
    }
    expect(sent.filter((s) => ["payments", "quotes", "pay_periods"].includes(s.table))).toEqual([]);
  });

  it("figures are for the roles that see them", async () => {
    supabase("estimator");
    expect((await call("full", "money_report", {})).error).toBe("Your role in Crewtavo doesn't allow that. An owner or admin can change your role.");
    expect((await call("full", "pay_summary", {})).error).toMatch(/^Pay is for the office/);
  });
});

describe("tools", () => {
  it("name every field that's wrong", async () => {
    supabase();
    const res = await call("full", "add_services", { items: [{ unit_price: "a lot" }, { name: "" }] });
    expect(res.error).toMatch(/^Invalid arguments\. /);
    expect(res.error).toContain("items.0.name");
    expect(res.error).toContain("items.0.unit_price");
    expect(res.error).toContain("items.1.name");
  });

  it("invite people without handing the assistant their link", async () => {
    supabase();
    const result = await call("full", "invite_person", { email: "new@example.com", role: "office" });
    expect(result).toEqual({ user_id: "user-9", invited: true, emailed: true, reason: null });
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(invites.calls).toEqual([{ email: "new@example.com", full_name: undefined, role: "office", role_id: undefined }]);
  });
});

describe("routes", () => {
  const lawns = () =>
    [0, 1, 2].map((i) => ({
      id: `visit-${i}`,
      title: `Mow ${i}`,
      kind: "job",
      status: "scheduled",
      starts_at: null,
      ends_at: null,
      route_order: null,
      time_fixed: false,
      property: { id: `property-${i}`, line1: `${i} Oak St`, city: "Radford", lat: 37.13 + (3 - i) / 100, lng: -80.57 },
      job: { number: i, visit_duration_min: 20, client: null },
    }));
  const company = { timezone: "America/New_York", settings: { depot: { lat: 37.13, lng: -80.57 }, working_hours: { start: "08:00", end: "17:00" } } };

  it("shows a crew's organized day without saving it", async () => {
    const { db, sent } = supabase();
    db.companies = [company];
    db.visits = lawns();
    const result = await call("full", "organize_route", { date: "2099-06-03", crew_id: null, save: false });
    expect(result.saved).toBe(false);
    expect(result.stops.map((s: { visit_id: string }) => s.visit_id)).toEqual(["visit-2", "visit-1", "visit-0"]);
    // 20-minute lawns, any length, one after another in local time.
    expect(result.stops[0]).toMatchObject({ order: 1, start_time: "08:05", end_time: "08:25" });
    expect(sent.filter((r) => r.method === "PATCH")).toEqual([]);
  });

  it("saves the route and remembers the day", async () => {
    const { db, sent } = supabase();
    db.companies = [company];
    db.visits = lawns();
    const result = await call("full", "organize_route", { date: "2099-06-03", crew_id: null });
    expect(result).toMatchObject({ saved: true, changed: 3 });
    expect(sent.filter((r) => r.method === "PATCH" && r.table === "visits").map((r) => r.body.route_order)).toEqual([1, 2, 3]);
    expect(sent.find((r) => r.method === "POST" && r.table === "routes")?.body).toMatchObject({ route_date: "2099-06-03", by_hand: false, organized_by: "user-1" });
  });

  it("books a visit of any length", async () => {
    const { db, sent } = supabase();
    db.companies = [company];
    await call("full", "create_visit", { title: "Mow 4 Elm St", kind: "task", date: "2099-06-03", start_time: "09:03", duration_min: 50, time_fixed: true });
    const visit = sent.find((r) => r.method === "POST" && r.table === "visits")!.body[0];
    expect([visit.starts_at, visit.ends_at, visit.time_fixed]).toEqual(["2099-06-03T13:03:00.000Z", "2099-06-03T13:53:00.000Z", true]);
  });
});
