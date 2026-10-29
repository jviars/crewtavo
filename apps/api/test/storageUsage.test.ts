/**
 * Settings → Storage from the server (services/storageUsage.ts, routes/storage.ts): the default
 * company limit kept current from what Railway says (the volume's size, or the plan's bucket), the
 * warnings at 80% and 95% of the limit, and GET /api/storage. Railway's GraphQL API, Supabase Auth
 * and PostgREST are stubbed through fetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { app } from "../src/app";
import type { Env } from "../src/env";
import type { RailwayAccess } from "../src/integrations/railway";
import { encryptJson } from "../src/lib/crypto";
import { adminClient } from "../src/lib/supabase";
import { forgetHosting, hostingOverview } from "../src/services/hosting";
import { checkStorage, forgetStorageFacts, keepStorageDefault, storageWarning } from "../src/services/storageUsage";

const env: Env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test",
  SUPABASE_SECRET_KEY: "sb_secret_test",
  ENCRYPTION_KEY: btoa(String.fromCharCode(...new Uint8Array(32).map((_, i) => i * 7))),
  APP_URL: "https://app.greenlawn.com",
  RAILWAY_PUBLIC_DOMAIN: "crewtavo-production.up.railway.app",
  RAILWAY_PROJECT_ID: "proj-1",
  RAILWAY_ENVIRONMENT_ID: "env-1",
  RAILWAY_SERVICE_ID: "svc-crewtavo",
  CREWTAVO_SINGLE_COMPANY: "1",
};
const offRailway: Env = { ...env, RAILWAY_PUBLIC_DOMAIN: undefined, RAILWAY_PROJECT_ID: undefined };
const token: RailwayAccess = { method: "token", token: "project-token" };
const CO = "0b0a0000-0000-4000-8000-000000000001";
const OWNER = "00000000-0000-4000-8000-0000000000aa";
const ADMIN = "00000000-0000-4000-8000-0000000000bb";
const NOW = new Date("2026-10-28T12:00:00Z");
const GB = 1e9;

interface Call {
  method: string;
  url: URL;
  path: string;
  body: any;
  /** The server's key sent it (the admin client), rather than a person's session. */
  admin: boolean;
}

/** Railway's answers: the storage service on a volume of `volumeMb`, or on a bucket, in a project on `plan`. */
interface Project {
  plan?: string | null;
  backend?: "volume" | "bucket";
  volumeMb?: number;
  refuse?: boolean;
}

function railway(call: Call, project: Project): Response {
  if (project.refuse) return Response.json({ errors: [{ message: "Not Authorized" }] });
  const query: string = call.body?.query ?? "";
  const data = (value: unknown) => Response.json({ data: value });
  if (query.includes("project(id")) {
    return data({
      project: {
        name: "Crewtavo",
        subscriptionType: project.plan === undefined ? "hobby" : project.plan,
        createdAt: "2026-09-01T00:00:00Z",
        services: { edges: [{ node: { id: "svc-crewtavo", name: "crewtavo" } }, { node: { id: "svc-storage", name: "storage" } }] },
      },
    });
  }
  if (query.includes("variables(")) return data({ variables: { STORAGE_BACKEND: project.backend === "bucket" ? "s3" : "file", TENANT_ID: "crewtavo" } });
  if (query.includes("environment(id")) {
    return data({ environment: { volumeInstances: { edges: [{ node: { serviceId: "svc-storage", currentSizeMB: 1200, sizeMB: project.volumeMb ?? 50_000 } }] } } });
  }
  return Response.json({ errors: [{ message: `unexpected ${query.slice(0, 40)}` }] });
}

function serve(answer: (call: Call) => Response | unknown) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const headers = new Headers(init?.headers);
    const text = typeof init?.body === "string" ? init.body : "";
    const call: Call = {
      method: (init?.method ?? "GET").toUpperCase(),
      url,
      path: url.pathname.replace(/^\/rest\/v1\//, ""),
      body: text ? JSON.parse(text) : undefined,
      admin: headers.get("apikey") === "sb_secret_test",
    };
    calls.push(call);
    const out = answer(call);
    return out instanceof Response ? out : Response.json(out ?? []);
  });
  return calls;
}

const railwayCalls = (calls: Call[]) => calls.filter((c) => c.url.host === "backboard.railway.com").map((c) => c.body.query.match(/\{\s*(\w+)/)?.[1]);
const defaults = (calls: Call[]) => calls.filter((c) => c.path === "rpc/storage_set_default").map((c) => c.body);

beforeEach(() => forgetStorageFacts());
afterEach(() => {
  vi.unstubAllGlobals();
  forgetHosting();
});

describe("the default company limit, from Railway", () => {
  it("is 90% of the storage service's volume", async () => {
    const calls = serve((call) => (call.url.host === "backboard.railway.com" ? railway(call, { backend: "volume", volumeMb: 50_000 }) : []));
    const read = await keepStorageDefault(env, adminClient(env), CO, { access: token });
    expect(read).toEqual({ backend: "volume", plan: "hobby", volumeBytes: 50 * GB, pricePerGbMonth: 0.15 });
    expect(defaults(calls)).toEqual([{ p_company: CO, p_bytes: 45 * GB, p_basis: "90% of your 50 GB volume" }]);
    expect(calls.find((c) => c.path === "rpc/storage_set_default")?.admin).toBe(true);
  });

  it("follows the plan for a bucket: 900 GB on Hobby, 1 TB on Pro", async () => {
    let calls = serve((call) => (call.url.host === "backboard.railway.com" ? railway(call, { backend: "bucket", plan: "hobby" }) : []));
    expect(await keepStorageDefault(env, adminClient(env), CO, { access: token })).toMatchObject({ backend: "bucket", plan: "hobby", pricePerGbMonth: 0.015 });
    expect(defaults(calls)).toEqual([{ p_company: CO, p_bytes: 900 * GB, p_basis: "Railway Hobby bucket" }]);
    // The volume isn't asked about: a bucket's default doesn't depend on it.
    expect(railwayCalls(calls)).not.toContain("environment");

    calls = serve((call) => (call.url.host === "backboard.railway.com" ? railway(call, { backend: "bucket", plan: "pro" }) : []));
    await keepStorageDefault(env, adminClient(env), CO, { access: token, force: true });
    expect(defaults(calls)).toEqual([{ p_company: CO, p_bytes: 1000 * GB, p_basis: "Railway Pro bucket" }]);
  });

  it("follows the volume when it's made bigger", async () => {
    let calls = serve((call) => (call.url.host === "backboard.railway.com" ? railway(call, { volumeMb: 5_000 }) : []));
    await keepStorageDefault(env, adminClient(env), CO, { access: token });
    expect(defaults(calls)).toEqual([{ p_company: CO, p_bytes: 4.5 * GB, p_basis: "90% of your 5 GB volume" }]);
    calls = serve((call) => (call.url.host === "backboard.railway.com" ? railway(call, { volumeMb: 50_000 }) : []));
    await keepStorageDefault(env, adminClient(env), CO, { access: token, force: true });
    expect(defaults(calls)).toEqual([{ p_company: CO, p_bytes: 45 * GB, p_basis: "90% of your 50 GB volume" }]);
  });

  it("asks Railway only what the caller didn't already read", async () => {
    const calls = serve((call) => (call.url.host === "backboard.railway.com" ? railway(call, {}) : []));
    expect(await keepStorageDefault(env, adminClient(env), CO, { access: token, hint: { backend: "volume", volumeBytes: 5 * GB, plan: "pro" } })).toEqual({
      backend: "volume",
      plan: "pro",
      volumeBytes: 5 * GB,
      pricePerGbMonth: 0.15,
    });
    expect(railwayCalls(calls)).toEqual([]);
    expect(defaults(calls)).toEqual([{ p_company: CO, p_bytes: 4.5 * GB, p_basis: "90% of your 5 GB volume" }]);
  });

  it("reads Railway again only every few minutes, unless asked to", async () => {
    let calls = serve((call) => (call.url.host === "backboard.railway.com" ? railway(call, {}) : []));
    await keepStorageDefault(env, adminClient(env), CO, { access: token });
    calls = serve((call) => (call.url.host === "backboard.railway.com" ? railway(call, {}) : []));
    expect(await keepStorageDefault(env, adminClient(env), CO, { access: token })).toMatchObject({ backend: "volume" });
    expect(calls).toEqual([]);
    await keepStorageDefault(env, adminClient(env), CO, { access: token, force: true });
    expect(railwayCalls(calls).length).toBeGreaterThan(0);
  });

  it("keeps the last default while Railway can't be reached", async () => {
    let calls = serve((call) => (call.url.host === "backboard.railway.com" ? railway(call, { refuse: true }) : []));
    expect(await keepStorageDefault(env, adminClient(env), CO, { access: token })).toEqual({ backend: null, plan: null, volumeBytes: null, pricePerGbMonth: null });
    expect(defaults(calls)).toEqual([]);
    // Nor when the caller's own read of Railway didn't get the part that matters.
    calls = serve((call) => (call.url.host === "backboard.railway.com" ? railway(call, {}) : []));
    await keepStorageDefault(env, adminClient(env), CO, { access: token, force: true, hint: { backend: "bucket", plan: null } });
    expect(defaults(calls)).toEqual([]);
    // Nor when Railway doesn't answer at all.
    const secret = await encryptJson(env, { api_key: "project-token", extra: { method: "token" } });
    calls = serve((call) => {
      if (call.url.host === "backboard.railway.com") throw new TypeError("fetch failed");
      if (call.path === "integrations") return [{ status: "connected" }];
      if (call.path === "integration_secrets") return [{ ciphertext: secret }];
      return [];
    });
    expect(await keepStorageDefault(env, adminClient(env), CO, { force: true })).toEqual({ backend: null, plan: null, volumeBytes: null, pricePerGbMonth: null });
    expect(defaults(calls)).toEqual([]);
    // Nor when whether Railway is connected can't be read just now.
    calls = serve((call) => (call.path === "integrations" ? Response.json({ message: "connection reset" }, { status: 500 }) : []));
    expect(await keepStorageDefault(env, adminClient(env), CO, { force: true })).toBeNull();
    expect(defaults(calls)).toEqual([]);
  });

  it("is nothing off Railway, or once Railway isn't connected, and a default from before goes", async () => {
    const cleared = [{ p_company: CO, p_bytes: null, p_basis: null }];
    let calls = serve(() => []);
    expect(await keepStorageDefault(offRailway, adminClient(offRailway), CO)).toBeNull();
    expect(defaults(calls)).toEqual(cleared);
    expect(calls.find((c) => c.path === "rpc/storage_set_default")?.admin).toBe(true);
    expect(railwayCalls(calls)).toEqual([]);
    // Disconnected by an owner, or Railway stopped taking Crewtavo's sign-in.
    for (const status of ["disconnected", "error"]) {
      calls = serve((call) => (call.path === "integrations" ? [{ status }] : []));
      expect(await keepStorageDefault(env, adminClient(env), CO)).toBeNull();
      expect(defaults(calls), status).toEqual(cleared);
    }
  });

  it("goes when Railway answers but what it says gives no default", async () => {
    const calls = serve((call) => (call.url.host === "backboard.railway.com" ? railway(call, { backend: "bucket", plan: "enterprise" }) : []));
    expect(await keepStorageDefault(env, adminClient(env), CO, { access: token })).toMatchObject({ backend: "bucket", plan: null });
    expect(defaults(calls)).toEqual([{ p_company: CO, p_bytes: null, p_basis: null }]);
  });

  it("goes along with Settings → Hosting's read of Railway", async () => {
    const secret = await encryptJson(env, { api_key: "project-token", extra: { method: "token" } });
    const calls = serve((call) => {
      if (call.url.host === "backboard.railway.com") return railway(call, { volumeMb: 50_000 });
      if (call.path === "integrations") return [{ status: "connected" }];
      if (call.path === "integration_secrets") return [{ ciphertext: secret }];
      return [];
    });
    const overview = await hostingOverview(env, adminClient(env), CO, { fresh: true, now: NOW });
    expect(overview.disks).toContainEqual({ service: "storage", kind: "volume", usedGb: 1.2, sizeGb: 50 });
    expect(defaults(calls)).toEqual([{ p_company: CO, p_bytes: 45 * GB, p_basis: "90% of your 50 GB volume" }]);
    // The plan and the volume came with Hosting's own reads; only where files are was asked for.
    expect(railwayCalls(calls).filter((f) => f === "variables")).toHaveLength(1);
  });
});

describe("warnings as storage fills", () => {
  /** A company using `used` of `limit` bytes, which was already warned about `warned`. */
  function company(numbers: { used: number; limit: number | null }, warned: Record<string, string> = {}, extra: Record<string, unknown> = {}) {
    let settings: Record<string, unknown> = { payment_terms_days: 30, storage: { limit_bytes: numbers.limit, warned, ...extra } };
    const calls = serve((call) => {
      if (call.path === "companies" && call.method === "GET") return call.url.searchParams.get("select") === "id" ? [{ id: CO }] : [{ settings }];
      if (call.path === "companies" && call.method === "PATCH") {
        settings = call.body.settings;
        return [];
      }
      if (call.path === "rpc/storage_snapshot") return [{ company_used: numbers.used, company_limit: numbers.limit, user_used: 0, user_limit: null, user_is_owner: false }];
      if (call.path === "memberships") return [{ user_id: OWNER }, { user_id: ADMIN }];
      return [];
    });
    return { calls, settings: () => settings, sent: () => calls.filter((c) => c.path === "notifications").flatMap((c) => c.body) };
  }

  it("tells owners and admins at 80%, once", async () => {
    const co = company({ used: 38.3 * GB, limit: 45 * GB });
    expect(await checkStorage(offRailway, adminClient(offRailway), NOW)).toEqual({ companies: 1, sent: 1, cleared: 0 });
    // Under the "hosting" topic everywhere (emailed unless turned off; "Storage" in Settings → Profile off Railway).
    expect(co.sent()).toEqual([
      { company_id: CO, user_id: OWNER, kind: "hosting", title: "Crewtavo's storage is 85% full", body: expect.stringContaining("38.3 GB of the 45 GB limit is used"), link: "/settings?tab=storage" },
      expect.objectContaining({ user_id: ADMIN, title: "Crewtavo's storage is 85% full" }),
    ]);
    // Asked about the company alone: its numbers don't depend on a person.
    expect(co.calls.find((c) => c.path === "rpc/storage_snapshot")?.body).toEqual({ p_company: CO, p_user: "00000000-0000-0000-0000-000000000000" });
    expect(co.settings()).toEqual({ payment_terms_days: 30, storage: { limit_bytes: 45 * GB, warned: { "80": NOW.toISOString() } } });

    co.calls.length = 0;
    expect(await checkStorage(offRailway, adminClient(offRailway), NOW)).toMatchObject({ sent: 0 });
    expect(co.calls.some((c) => c.method === "PATCH")).toBe(false);
  });

  it("tells them again at 95%", async () => {
    const co = company({ used: 43 * GB, limit: 45 * GB }, { "80": "2026-10-20T00:00:00.000Z" });
    await checkStorage(offRailway, adminClient(offRailway), NOW);
    expect(co.sent().map((n: { title: string }) => n.title)).toEqual(["Crewtavo's storage is almost full (95%)", "Crewtavo's storage is almost full (95%)"]);
    expect((co.settings().storage as { warned: unknown }).warned).toEqual({ "80": "2026-10-20T00:00:00.000Z", "95": NOW.toISOString() });
  });

  it("sends just the one that matters when use goes straight past both", async () => {
    const co = company({ used: 44 * GB, limit: 45 * GB });
    expect(await checkStorage(offRailway, adminClient(offRailway), NOW)).toMatchObject({ sent: 1 });
    expect(co.sent()).toHaveLength(2);
    expect(co.sent()[0].title).toBe("Crewtavo's storage is almost full (97%)");
    expect((co.settings().storage as { warned: unknown }).warned).toEqual({ "80": NOW.toISOString(), "95": NOW.toISOString() });
  });

  it("forgets a warning once use drops back under it, so the next crossing is told", async () => {
    const co = company({ used: 40 * GB, limit: 45 * GB }, { "80": "2026-10-20T00:00:00.000Z", "95": "2026-10-21T00:00:00.000Z" }, { default_bytes: 45 * GB });
    expect(await checkStorage(offRailway, adminClient(offRailway), NOW)).toEqual({ companies: 1, sent: 0, cleared: 1 });
    // Everything else in settings stays as it was.
    expect(co.settings()).toEqual({ payment_terms_days: 30, storage: { limit_bytes: 45 * GB, default_bytes: 45 * GB, warned: { "80": "2026-10-20T00:00:00.000Z" } } });
  });

  it("forgets them all when there's no limit", async () => {
    const co = company({ used: 40 * GB, limit: null }, { "80": "2026-10-20T00:00:00.000Z" });
    expect(await checkStorage(offRailway, adminClient(offRailway), NOW)).toMatchObject({ sent: 0, cleared: 1 });
    expect((co.settings().storage as { warned: unknown }).warned).toEqual({});
  });

  it("goes under the Railway topic on Railway", async () => {
    const co = company({ used: 38.3 * GB, limit: 45 * GB });
    expect(await checkStorage(env, adminClient(env), NOW)).toMatchObject({ sent: 1 });
    expect(co.sent().map((n: { kind: string }) => n.kind)).toEqual(["hosting", "hosting"]);
  });

  it("says it's full, not almost, once it's at the limit or over it", async () => {
    const co = company({ used: 42 * GB, limit: 40 * GB });
    await checkStorage(offRailway, adminClient(offRailway), NOW);
    expect(co.sent()[0]).toMatchObject({ title: "Crewtavo's storage is full", body: expect.stringContaining("42 GB of the 40 GB limit is used, counting the Trash. New files in Drive, plans, guides and chat are being turned away until there's room.") });
    expect(storageWarning(0.95, 40 * GB, 40 * GB).title).toBe("Crewtavo's storage is full");
    expect(storageWarning(0.95, 39 * GB, 40 * GB)).toMatchObject({ title: "Crewtavo's storage is almost full (97%)", body: expect.stringContaining("When it's full, nobody can add files") });
  });

  it("says what to do, and that crews can keep working", () => {
    const { body } = storageWarning(0.8, 36 * GB, 45 * GB);
    expect(body).toContain("Settings → Storage");
    expect(body).toContain("Visit photos, quote photos, receipts and sub paperwork still go in");
  });

  it("runs every 6 hours, on Railway or not", async () => {
    const { CRON_TASKS } = await import("../src/tasks");
    expect(Object.entries(CRON_TASKS).filter(([, tasks]) => tasks.includes("storage")).map(([cron]) => cron)).toEqual(["50 */6 * * *"]);
  });
});

describe("GET /api/storage", () => {
  const part = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const session = (sub: string) => `${part({ alg: "HS256", typ: "JWT" })}.${part({ sub, role: "authenticated", exp: Math.floor(Date.now() / 1000) + 600 })}.c2ln`;
  const OVERVIEW = { used_bytes: 12.4 * GB, trash_bytes: 1 * GB, files: 812, limit_bytes: 45 * GB, limit_mode: "default", default_bytes: 45 * GB, default_basis: "90% of your 50 GB volume", me: { used_bytes: 3.1 * GB, limit_bytes: null, limit_source: null } };

  async function as(role: string, e: Env) {
    const secret = await encryptJson(env, { api_key: "project-token", extra: { method: "token" } });
    const order: string[] = [];
    const calls = serve((call) => {
      if (call.url.pathname === "/auth/v1/user") return Response.json({ id: OWNER, aud: "authenticated", role: "authenticated" });
      if (call.url.host === "backboard.railway.com") {
        order.push("railway");
        return railway(call, { volumeMb: 50_000 });
      }
      if (call.path === "memberships") return [{ role, role_id: null, subcontractor_id: null }];
      if (call.path === "integrations") return [{ status: "connected" }];
      if (call.path === "integration_secrets") return [{ ciphertext: secret }];
      if (call.path.startsWith("rpc/")) order.push(call.path);
      if (call.path === "rpc/storage_overview") return OVERVIEW;
      return [];
    });
    const res = await app.request("/api/storage", { headers: { Authorization: `Bearer ${session(OWNER)}`, "X-Company-Id": CO } }, e);
    return { res, calls, order };
  }

  it("gives owners and admins on Railway where files live and what a GB costs, with the default read first", async () => {
    const { res, calls, order } = await as("owner", env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ...OVERVIEW, railway: { backend: "volume", plan: "hobby", volumeBytes: 50 * GB, pricePerGbMonth: 0.15 } });
    expect(order.indexOf("rpc/storage_set_default")).toBeLessThan(order.indexOf("rpc/storage_overview"));
    // The overview is read as the person, so the database decides what they see.
    expect(calls.find((c) => c.path === "rpc/storage_overview")).toMatchObject({ admin: false, body: { p_company: CO } });
  });

  it("gives the rest of the team the overview alone, without asking Railway", async () => {
    const { res, order } = await as("field_crew", env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ...OVERVIEW, railway: null });
    expect(order).toEqual(["rpc/storage_overview"]);
  });

  it("has no Railway part off Railway, and no default limit", async () => {
    const { res, calls, order } = await as("admin", offRailway);
    expect(await res.json()).toMatchObject({ railway: null });
    expect(order).toEqual(["rpc/storage_set_default", "rpc/storage_overview"]);
    expect(defaults(calls)).toEqual([{ p_company: CO, p_bytes: null, p_basis: null }]);
  });

  it("isn't for subs", async () => {
    const { res } = await as("subcontractor", env);
    expect(res.status).toBe(403);
  });
});
