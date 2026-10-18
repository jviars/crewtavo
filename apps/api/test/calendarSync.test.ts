/**
 * Keeping other calendars' events, and visits on Google Calendar, against an in-memory database
 * and a stand-in for Google Calendar's API.
 */
import { addDays, localDate } from "@crewtavo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import type { Env } from "../src/env";
import { googleEventId, pushUpcomingVisits, syncSource } from "../src/integrations/calendars";
import { encryptJson } from "../src/lib/crypto";
import type { Db } from "../src/lib/supabase";

// The routes make their own clients; they get the test's database instead.
const current = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../src/lib/supabase", async (original) => ({
  ...(await original<typeof import("../src/lib/supabase")>()),
  adminClient: () => current.db,
  userClient: () => current.db,
}));

const env: Env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7))),
  APP_URL: "https://ops.example.com",
};
const COMPANY = "00000000-0000-4000-8000-000000000001";
const USER = "00000000-0000-4000-8000-0000000000aa";
const SOURCE = "00000000-0000-4000-8000-0000000000c1";
const today = localDate(new Date(), "UTC");

type Row = Record<string, any>;

// Half an emoji. PostgREST turns down a request with one anywhere in it (22P02), saving nothing.
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
const halfEmoji = (value: unknown): boolean =>
  typeof value === "string" ? LONE_SURROGATE.test(value) : value !== null && typeof value === "object" && Object.values(value).some(halfEmoji);

const DEFAULTS: Record<string, Row> = {
  calendar_sources: { enabled: true, event_count: 0, last_synced_at: null, last_error: null },
  outbox: { attempts: 0, done_at: null, dead_at: null },
};

/**
 * Stands in for supabase-js over a few tables: the filters these routes use, embeds through a
 * `<name>_id` column, and hooks to fail a read or to change something while a write happens.
 */
function fakeDb(tables: Record<string, Row[]>, hooks: { failRead?: (table: string, fields: string) => boolean; afterWrite?: (table: string) => void } = {}) {
  let made = 0;
  class Query {
    private op: "select" | "insert" | "upsert" | "update" | "delete" = "select";
    private payload: any;
    private conflict = ["id"];
    private fields = "*";
    private filters: Array<(row: Row) => boolean> = [];
    private one: "" | "single" | "maybe" = "";
    private max = Infinity;
    constructor(private table: string) {}
    select(fields = "*") {
      this.fields = fields;
      return this;
    }
    insert(payload: unknown) {
      return this.write("insert", payload);
    }
    upsert(payload: unknown, options?: { onConflict?: string }) {
      this.conflict = (options?.onConflict ?? "id").split(",");
      return this.write("upsert", payload);
    }
    update(payload: unknown) {
      return this.write("update", payload);
    }
    delete() {
      return this.write("delete", null);
    }
    eq(column: string, value: unknown) {
      return this.where((r) => r[column] === value);
    }
    match(values: Row) {
      for (const [column, value] of Object.entries(values)) this.eq(column, value);
      return this;
    }
    is(column: string, value: null) {
      return this.where((r) => (r[column] ?? null) === value);
    }
    not(column: string, _op: "in", list: string) {
      const values = list.replace(/[()]/g, "").split(",");
      return this.where((r) => !values.includes(r[column]));
    }
    lt(column: string, value: string) {
      return this.where((r) => r[column] < value);
    }
    gte(column: string, value: string) {
      return this.where((r) => r[column] != null && r[column] >= value);
    }
    lte(column: string, value: string) {
      return this.where((r) => r[column] != null && r[column] <= value);
    }
    or() {
      return this;
    }
    order() {
      return this;
    }
    limit(n: number) {
      this.max = n;
      return this;
    }
    single() {
      this.one = "single";
      return this;
    }
    maybeSingle() {
      this.one = "maybe";
      return this;
    }
    then<A, B>(resolve: (value: { data: any; error: any }) => A, reject?: (reason: unknown) => B) {
      return Promise.resolve().then(() => this.run()).then(resolve, reject);
    }
    private write(op: Query["op"], payload: unknown) {
      this.op = op;
      this.payload = payload;
      return this;
    }
    private where(test: (row: Row) => boolean) {
      this.filters.push(test);
      return this;
    }
    private project(row: Row) {
      const out = { ...row };
      for (const [, name, table] of this.fields.matchAll(/(\w+):(\w+)\(/g)) out[name!] = tables[table!]?.find((r) => r.id === row[`${name}_id`]) ?? null;
      return out;
    }
    private run() {
      const rows = (tables[this.table] ??= []);
      const matching = () => rows.filter((r) => this.filters.every((test) => test(r)));
      if (this.op === "select" && hooks.failRead?.(this.table, this.fields)) return { data: null, error: { message: "connection reset" } };
      if (halfEmoji(this.payload)) return { data: null, error: { code: "22P02", message: "invalid input syntax for type json" } };
      let data: Row[] = [];
      if (this.op === "select") data = matching().slice(0, this.max);
      else if (this.op === "insert") {
        for (const p of [this.payload].flat() as Row[]) data.push({ id: `00000000-0000-4000-8000-${String(++made).padStart(12, "0")}`, ...DEFAULTS[this.table], ...p });
        rows.push(...data);
      } else if (this.op === "upsert") {
        for (const p of this.payload as Row[]) {
          const found = rows.find((r) => this.conflict.every((key) => r[key] === p[key]));
          if (found) Object.assign(found, p);
          else rows.push({ id: `00000000-0000-4000-8000-${String(++made).padStart(12, "0")}`, ...p });
        }
      } else if (this.op === "update") {
        data = matching();
        for (const r of data) Object.assign(r, this.payload);
      } else {
        data = matching();
        tables[this.table] = rows.filter((r) => !data.includes(r));
      }
      if (this.op !== "select") hooks.afterWrite?.(this.table);
      const out = data.map((r) => this.project(r));
      if (this.one === "single") return out.length === 1 ? { data: out[0], error: null } : { data: null, error: { code: "PGRST116", message: "Not one row" } };
      if (this.one === "maybe") return { data: out[0] ?? null, error: null };
      return { data: out, error: null };
    }
  }
  const db = {
    from: (table: string) => new Query(table),
    auth: { getClaims: async () => ({ data: { claims: { sub: USER } }, error: null }) },
  };
  current.db = db;
  return db as unknown as Db;
}

/** A company with Google Calendar connected, and (optionally) one of its calendars on the schedule. */
async function world(options: { source?: Row; visitsCalendar?: boolean } = {}) {
  return {
    companies: [{ id: COMPANY, name: "Acme Lawn", timezone: "UTC" }],
    memberships: [{ company_id: COMPANY, user_id: USER, role: "owner", role_id: null, active: true }],
    integrations: [{ company_id: COMPANY, provider: "google_calendar", status: "connected", settings: options.visitsCalendar ? { push_calendar_id: "visits-cal" } : {}, last_sync_at: null, last_error: null }],
    integration_secrets: [{ company_id: COMPANY, provider: "google_calendar", ciphertext: await encryptJson(env, { access_token: "token", expires_at: Date.now() + 3_600_000 }) }],
    calendar_sources: options.source
      ? [{ id: SOURCE, company_id: COMPANY, kind: "google", app: "google_calendar", name: "Team", color: null, crew_id: null, show_details: true, blocks_time: true, enabled: true, url_sealed: null, host: null, external_id: "team-cal", event_count: 0, last_synced_at: null, last_error: null, ...options.source }]
      : [],
    calendar_events: [] as Row[],
    visits: [] as Row[],
    outbox: [] as Row[],
  } as Record<string, Row[]>;
}

/** Google Calendar's API, as far as these tests need it: calendars, and events by ID in each. */
function fakeGoogle() {
  const calendars = new Map<string, Map<string, Row>>([["visits-cal", new Map()], ["team-cal", new Map()]]);
  const state = {
    calendars,
    list: [] as Row[],
    calls: [] as string[],
    /** A status to answer with instead, by method and path (and event ID, for a new event). */
    fail: (_method: string, _path: string, _body: Row | null): number | null => null,
    /** Hold a request until this settles. */
    hold: (_method: string, _path: string): Promise<void> | null => null,
  };
  const error = (status: number, message: string) => Response.json({ error: { message } }, { status });
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const path = decodeURIComponent(url.pathname.replace(/^\/calendar\/v3/, ""));
    const body = init?.body ? (JSON.parse(String(init.body)) as Row) : null;
    state.calls.push(`${method} ${path}`);
    await state.hold(method, path);
    const failed = state.fail(method, path, body);
    if (failed === 403) return error(403, "Request had insufficient authentication scopes.");
    if (failed) return error(failed, "Backend Error");
    if (path === "/users/me/calendarList") return Response.json({ items: state.list });
    if (method === "POST" && path === "/calendars") {
      const id = `made-${calendars.size}`;
      calendars.set(id, new Map());
      return Response.json({ id, summary: body?.summary });
    }
    const [, calendarId, eventId] = /^\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(path) ?? [];
    const events = calendarId ? calendars.get(calendarId) : undefined;
    if (!events) return error(404, "Not Found");
    if (method === "GET") return Response.json({ items: [...events.values()] });
    if (method === "DELETE") return events.delete(eventId!) ? new Response(null, { status: 204 }) : error(410, "Resource has been deleted");
    if (method === "PUT") {
      if (!events.has(eventId!)) return error(404, "Not Found");
      events.set(eventId!, { ...body, id: eventId });
      return Response.json(events.get(eventId!));
    }
    if (events.has(body!.id)) return error(409, "The requested identifier already exists.");
    events.set(body!.id, body!);
    return Response.json(body);
  }));
  return state;
}

const request = (method: string, path: string, body?: unknown) =>
  app.request(`/api${path}`, { method, headers: { Authorization: "Bearer token", "X-Company-Id": COMPANY, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, env);

const tomorrow = addDays(today, 1);
const appointment = (extra: Row = {}) => ({
  id: "evt1",
  status: "confirmed",
  summary: "Therapy - Dr. Smith",
  location: "12 Clinic Rd",
  description: "Bring the referral",
  htmlLink: "https://calendar.google.com/event?eid=1",
  start: { dateTime: `${tomorrow}T15:00:00Z` },
  end: { dateTime: `${tomorrow}T16:00:00Z` },
  ...extra,
});
const details = (tables: Record<string, Row[]>) => tables.calendar_events!.map(({ title, location, description, url }) => ({ title, location, description, url }));
const BUSY = { title: "Busy", location: null, description: null, url: null };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("text from Google Calendar", () => {
  it("keeps events whose text is cut through an emoji", async () => {
    const tables = await world({ source: {} });
    const db = fakeDb(tables);
    const google = fakeGoogle();
    google.calendars.get("team-cal")!.set("evt1", appointment({ summary: `${"s".repeat(199)}🎉 party`, location: `${"l".repeat(299)}📍 here`, description: `${"d".repeat(1999)}🙂 more` }));
    expect(await syncSource(env, db, SOURCE)).toBe(1);
    expect(details(tables)).toEqual([{ title: `${"s".repeat(199)}🎉`, location: `${"l".repeat(299)}📍`, description: `${"d".repeat(1999)}🙂`, url: "https://calendar.google.com/event?eid=1" }]);
    expect(tables.calendar_sources![0]!.last_error).toBeNull();
  });

  it("names a calendar cut through an emoji", async () => {
    const tables = await world();
    fakeDb(tables);
    const google = fakeGoogle();
    google.list = [{ id: "team-cal", summary: `${"n".repeat(79)}📅 and more` }];
    const res = await request("POST", "/calendars/google", { calendar_id: "team-cal" });
    expect(res.status).toBe(201);
    expect((await res.json()).name).toBe(`${"n".repeat(79)}📅`);
  });

  it("names the visits calendar after a long company name with an emoji", async () => {
    const tables = await world();
    tables.companies![0]!.name = `${"c".repeat(79)}🌳 Landscaping`;
    fakeDb(tables);
    fakeGoogle();
    const res = await request("PUT", "/calendars/google/visits", { enabled: true });
    expect(res.status).toBe(200);
    expect(tables.integrations![0]!.settings.push_calendar_name).toBe(`${"c".repeat(79)}🌳`);
    // Its first push runs in the background.
    await vi.waitFor(() => expect(tables.integrations![0]!.last_sync_at).not.toBeNull());
  });
});

describe("turning a calendar's details off", () => {
  it("hides what's kept at once, even when the calendar can't be read just then", async () => {
    for (const status of [503, 404]) {
      const tables = await world({ source: {} });
      const db = fakeDb(tables);
      const google = fakeGoogle();
      google.calendars.get("team-cal")!.set("evt1", appointment());
      await syncSource(env, db, SOURCE);
      expect(details(tables)[0]!.title).toBe("Therapy - Dr. Smith");

      google.fail = (method, path) => (method === "GET" && path.startsWith("/calendars/team-cal/events") ? status : null);
      const res = await request("PATCH", `/calendars/${SOURCE}`, { show_details: false });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ show_details: false, last_error: expect.any(String) });
      expect(details(tables), String(status)).toEqual([BUSY]);
    }
  });

  it("doesn't let a read that started before keep the details", async () => {
    const tables = await world({ source: {} });
    const db = fakeDb(tables);
    const google = fakeGoogle();
    google.calendars.get("team-cal")!.set("evt1", appointment());
    let release!: () => void;
    const slow = new Promise<void>((resolve) => (release = resolve));
    let first = true;
    google.hold = (method, path) => (method === "GET" && path.startsWith("/calendars/team-cal/events") && first ? ((first = false), slow) : null);

    const background = syncSource(env, db, SOURCE); // the 15-minute task, still reading
    await vi.waitFor(() => expect(first).toBe(false));
    expect((await request("PATCH", `/calendars/${SOURCE}`, { show_details: false })).status).toBe(200);
    release();
    await background;
    expect(details(tables)).toEqual([BUSY]);
  });

  it("doesn't let a save that was under way keep the details", async () => {
    const tables = await world({ source: {} });
    // Turned off (and what was kept hidden) just as this read's events are saved.
    const db = fakeDb(tables, { afterWrite: (table) => table === "calendar_events" && (tables.calendar_sources![0]!.show_details = false) });
    fakeGoogle().calendars.get("team-cal")!.set("evt1", appointment());
    await syncSource(env, db, SOURCE);
    expect(details(tables)).toEqual([BUSY]);
  });
});

describe("visits on Google Calendar after reconnecting", () => {
  const visit = (key: string, extra: Row = {}) => ({
    id: `00000000-0000-4000-8000-${key.padStart(12, "0")}`, company_id: COMPANY, title: `Visit ${key}`, kind: "job", status: "scheduled",
    scheduled_on: addDays(today, 3), starts_at: null, ends_at: null, notes: null, crew_id: null, job_id: null, property_id: null, ...extra,
  });
  const onGoogle = (google: ReturnType<typeof fakeGoogle>) => [...google.calendars.get("visits-cal")!.keys()].sort();
  const eventFor = (key: string) => googleEventId(visit(key).id);
  beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => undefined));

  it("takes visits cancelled, deleted, unscheduled or moved meanwhile off their old days", async () => {
    const tables = await world({ visitsCalendar: true });
    tables.visits = ["1", "2", "3", "4", "5"].map((key) => visit(key));
    const db = fakeDb(tables);
    const google = fakeGoogle();
    await pushUpcomingVisits(env, db, COMPANY);
    expect(onGoogle(google)).toEqual(["1", "2", "3", "4", "5"].map(eventFor).sort());
    // Something someone put on that calendar themselves.
    google.calendars.get("visits-cal")!.set("lunch", { id: "lunch", summary: "Lunch" });

    // While Google needed reconnecting, these changes weren't queued.
    const find = (key: string) => tables.visits!.find((v) => v.id === visit(key).id)!;
    find("1").status = "cancelled";
    tables.visits = tables.visits!.filter((v) => v.id !== visit("2").id);
    Object.assign(find("3"), { status: "unscheduled", scheduled_on: null });
    find("4").scheduled_on = addDays(today, 200);

    expect(await pushUpcomingVisits(env, db, COMPANY)).toEqual({ pushed: 5, queued: 0 });
    expect(onGoogle(google)).toEqual([eventFor("4"), eventFor("5"), "lunch"].sort());
    expect(google.calendars.get("visits-cal")!.get(eventFor("4"))!.start).toEqual({ date: addDays(today, 200) });
  });

  it("leaves a visit Google turns down to the outbox, and sends the rest", async () => {
    const tables = await world({ visitsCalendar: true });
    tables.visits = ["1", "2", "3", "4", "5"].map((key) => visit(key));
    const db = fakeDb(tables);
    const google = fakeGoogle();
    google.fail = (method, path) => (method === "PUT" && path.endsWith(eventFor("2")) ? 503 : null);
    expect(await pushUpcomingVisits(env, db, COMPANY)).toEqual({ pushed: 4, queued: 1 });
    expect(onGoogle(google)).toEqual(["1", "3", "4", "5"].map(eventFor).sort());
    expect(tables.outbox).toMatchObject([{ company_id: COMPANY, topic: "calendar.visit", payload: { visit_id: visit("2").id }, done_at: null }]);
    expect(tables.integrations![0]).toMatchObject({ last_sync_at: expect.any(String), last_error: null });
  });

  it("leaves the rest to the outbox while Google keeps failing", async () => {
    const tables = await world({ visitsCalendar: true });
    tables.visits = Array.from({ length: 12 }, (_, i) => visit(String(i + 1)));
    const db = fakeDb(tables);
    const google = fakeGoogle();
    google.fail = (method, path) => (method === "PUT" && path.includes("/events/") ? 503 : null);
    expect(await pushUpcomingVisits(env, db, COMPANY)).toEqual({ pushed: 0, queued: 12 });
    expect(google.calls.filter((c) => c.startsWith("PUT"))).toHaveLength(5);
    expect(tables.outbox!.map((r) => r.payload.visit_id).sort()).toEqual(tables.visits!.map((v) => v.id).sort());
  });

  it("doesn't take a visit off Google because it couldn't be read", async () => {
    const tables = await world({ visitsCalendar: true });
    tables.visits = [visit("1")];
    const google = fakeGoogle();
    await pushUpcomingVisits(env, fakeDb(tables), COMPANY);
    const db = fakeDb(tables, { failRead: (table, fields) => table === "visits" && fields.includes("crew:crews") });
    expect(await pushUpcomingVisits(env, db, COMPANY)).toEqual({ pushed: 0, queued: 1 });
    expect(onGoogle(google)).toEqual([eventFor("1")]);
  });

  it("stops when Google says it needs reconnecting again", async () => {
    const tables = await world({ visitsCalendar: true });
    tables.visits = ["1", "2", "3"].map((key) => visit(key));
    const db = fakeDb(tables);
    const google = fakeGoogle();
    google.fail = (method) => (method === "PUT" ? 403 : null);
    expect(await pushUpcomingVisits(env, db, COMPANY)).toEqual({ pushed: 0, queued: 0 });
    expect(google.calls.filter((c) => c.startsWith("PUT"))).toHaveLength(1);
    expect(tables.integrations![0]!.status).toBe("error");
    expect(tables.outbox).toEqual([]);
  });

  it("still sends the visits when it can't see what's on Google, and says so", async () => {
    const tables = await world({ visitsCalendar: true });
    tables.visits = [visit("1")];
    const db = fakeDb(tables);
    const google = fakeGoogle();
    google.fail = (method, path) => (method === "GET" && path === "/calendars/visits-cal/events" ? 503 : null);
    expect(await pushUpcomingVisits(env, db, COMPANY)).toEqual({ pushed: 1, queued: 0 });
    expect(onGoogle(google)).toEqual([eventFor("1")]);
    expect(tables.integrations![0]!.last_error).toMatch(/Turn visits off and on again/);
  });
});
